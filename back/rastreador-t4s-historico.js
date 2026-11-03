'use strict';
const t4sPadrao = require('./rastreador-t4s');
const q = require('./gps-precisao');
const escolha = require('./rastreador-escolha');
const ao = require('./rastreador-ao-vivo');

function selecionarHistorico(pontos, placa, preferida, ignoradas) {
  const filtro=q.criarFiltro();
  const validos=pontos.filter(p=>t4sPadrao.placaMercosul(p.placa)===placa)
    .map(p=>({...p,t:+new Date(p.posicao_em),velocidade:Number(p.velocidade)}))
    .sort((a,b)=>a.t-b.t).filter(p=>filtro.avaliar(p).ok);
  return require('./frota').escolherTrajeto(validos,preferida,ignoradas).lista;
}

function validarPontos(pontos, placa, deviceId, desde, ate) {
  const filtro = q.criarFiltro(), ini = +new Date(desde), fim = +new Date(ate);
  return pontos.slice().sort((a,b)=>new Date(a.posicao_em)-new Date(b.posicao_em)).filter(p =>
    p.fonte === 't4s' && t4sPadrao.placaMercosul(p.placa) === placa && Number(p.device_id) === Number(deviceId)
    && +new Date(p.posicao_em) >= ini && +new Date(p.posicao_em) <= fim && filtro.avaliar(p).ok);
}

// Só completa eventos ausentes; não altera horários de registros ou marcos da viagem.
function eventosAusentes(pontos, lugares, viagem, existentes) {
  const det = ao.criarDetector(), codigos = new Set((viagem.paradas || []).map(p=>p.loja_codigo_pes).filter(Boolean));
  const vistos = new Set(existentes.map(e=>e.tipo+'|'+e.lugar_codigo));
  return pontos.flatMap(p=>det.processar(p,lugares,{historico:true,preferidos:[...codigos]}))
    .filter(e => ['chegou_loja','saiu_loja'].includes(e.tipo) && e.lugar && !e.lugar.ambigua && codigos.has(e.lugar.codigo))
    .filter(e => {
      const k=e.tipo+'|'+e.lugar.codigo;
      if(vistos.has(k)) return false;
      if(e.tipo==='chegou_loja' && existentes.some(x=>x.tipo==='saiu_loja' && x.lugar_codigo===e.lugar.codigo && new Date(x.em)<e.em)) return false;
      if(e.tipo==='saiu_loja' && existentes.some(x=>x.tipo==='chegou_loja' && x.lugar_codigo===e.lugar.codigo && new Date(x.em)>e.em)) return false;
      vistos.add(k); return true;
    });
}

function criar({db,rastreador,t4s=t4sPadrao,broadcastEvento=()=>{},agora=()=>Date.now(),
  sinais=require('./rastreador-sinais').padrao}) {
  let rodando=false,proximo=0,indice=0;
  const cursores=new Map();
  async function recuperar(viagem, aparelho, {desde,ate,pontos,somenteSalvos=false}={}) {
    const placa=t4sPadrao.placaMercosul(viagem.placa);
    const ini=+new Date(desde),fim=+new Date(ate);
    if(aparelho.fonte!=='t4s' || !Number.isFinite(ini) || !Number.isFinite(fim) || fim<=ini
      || fim-ini>(somenteSalvos?48:6)*3600000) {
      throw new Error('Período ou fonte inválida para recuperar histórico T4S');
    }
    const preferencias=await escolha.preferencias(db);
    if(escolha.ignoradas(placa).has('t4s') || !escolha.aparelhoPermitido(aparelho,escolha.vinculados(placa))) return {ignorados:true};
    let inseridas=0;
    const preservar=async lote=>{inseridas+=await sinais.guardar(db,
      validarPontos(lote,placa,aparelho.device_id,desde,ate));};
    if(somenteSalvos)pontos=[];
    const consultar=!pontos;
    if (consultar) {
      pontos=[];
      // Divide o primeiro carregamento para respeitar os limites de páginas do relatório.
      for(let inicio=+new Date(desde);inicio<+new Date(ate);inicio+=90*60000) {
        let paginou=false;
        const lote=await t4s.listarHistorico(placa,aparelho.device_id,new Date(inicio),
          new Date(Math.min(inicio+90*60000,+new Date(ate))),{onPagina:async p=>{paginou=true;await preservar(p);}});
        if(!paginou)await preservar(lote);
        pontos.push(...lote);
      }
    }
    const lista=validarPontos(pontos,placa,aparelho.device_id,desde,ate);
    // Fora da transacao dos eventos: erros no detector, nas coordenadas ou
    // na viagem nao podem desfazer o historico GPS ja recebido.
    if(!consultar)await preservar(lista);
    const lugares=[...(await rastreador.coordenadas(db)).values()];
    const client=await db.connect();
    const novos=[];
    try {
      await client.query('BEGIN');
      const atual=(await client.query('SELECT id,placa,status FROM tms_viagens WHERE id=$1 FOR UPDATE',[viagem.id])).rows[0];
      if(!atual || t4sPadrao.placaMercosul(atual.placa)!==placa || atual.status==='Cancelada') {
        await client.query('ROLLBACK');return {alterada:true};
      }
      const paradas=(await client.query('SELECT id,loja_nome,loja_id FROM tms_paradas WHERE viagem_id=$1 FOR UPDATE',[viagem.id])).rows;
      const validas=(viagem.paradas || []).filter(p=>paradas.some(a=>a.id===p.id && a.loja_nome===p.loja_nome && a.loja_id===p.loja_id));
      // Recompõe a sequência com as leituras ao vivo entre as posições atrasadas.
      const gravadas=(await client.query(`SELECT fonte,device_id,placa,lat,lng,velocidade,motor,posicao_em
        FROM rastreador_posicoes WHERE placa=$1 AND posicao_em BETWEEN $2 AND $3
        ORDER BY posicao_em`,[placa,desde,ate])).rows;
      const existentes=(await client.query(`SELECT tipo,lugar_codigo,em FROM rastreador_eventos_loja
        WHERE viagem_id=$1 AND tipo IN ('chegou_loja','saiu_loja') ORDER BY em`,[viagem.id])).rows;
      const escolhidas=selecionarHistorico(gravadas,placa,preferencias[placa],escolha.ignoradas(placa));
      const eventos=eventosAusentes(escolhidas,lugares,{...viagem,paradas:validas},existentes).filter(e=>e.fonte==='t4s');
      for(const e of eventos) {
        const parada=validas.find(p=>p.loja_codigo_pes===e.lugar.codigo);
        // Uma chegada posterior à saída já registrada exige revisão, não complemento automático.
        if(e.tipo==='chegou_loja' && existentes.some(x=>x.tipo==='saiu_loja' && x.lugar_codigo===e.lugar.codigo && new Date(x.em)<e.em)) continue;
        if(e.tipo==='saiu_loja' && existentes.some(x=>x.tipo==='chegou_loja' && x.lugar_codigo===e.lugar.codigo && new Date(x.em)>e.em)) continue;
        const detalhe=[e.detalhe,'recuperado do histórico T4S'].filter(Boolean).join('; ');
        const r=await client.query(`INSERT INTO rastreador_eventos_loja
          (placa,tipo,lugar_codigo,lugar_nome,em,viagem_id,parada_id,lat,lng,fonte,permanencia_min,detalhe)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'t4s',$10,$11) ON CONFLICT DO NOTHING RETURNING id`,
          [placa,e.tipo,e.lugar.codigo,e.lugar.nome,e.em,viagem.id,parada.id,e.lat,e.lng,e.permanencia_min ?? null,detalhe]);
        if(r.rows.length) novos.push({tipo:e.tipo,placa,lugar:e.lugar.nome,lugar_nome:e.lugar.nome,em:e.em,
          motorista:viagem.motorista_nome,rota:viagem.rota_nome,detalhe});
      }
      await client.query('COMMIT');
    } catch(e) { await client.query('ROLLBACK');throw e; } finally {client.release();}
    for(const e of novos) {try {broadcastEvento('gps',{...e,texto:placa+' '+ao.frase(e)});}catch(_) {}}
    return {posicoes:lista.length,inseridas,eventos:novos};
  }
  async function rodar(viagens) {
    if(rodando || agora()<proximo) return;
    rodando=true;proximo=agora()+5*60000;
    try {
      const abertas=(viagens || []).filter(v=>v.placa && v.status!=='Cancelada');
      const contagem=new Map();for(const v of abertas){const p=t4sPadrao.placaMercosul(v.placa);contagem.set(p,(contagem.get(p)||0)+1);}
      const unicas=abertas.filter(v=>contagem.get(t4sPadrao.placaMercosul(v.placa))===1);
      if(!unicas.length)return;
      const aparelhos=(await db.query("SELECT fonte,device_id,placa FROM rastreador_aparelhos WHERE fonte='t4s' AND placa=ANY($1::text[])",
        [unicas.map(v=>t4sPadrao.placaMercosul(v.placa))])).rows;
      const qtd=Math.min(4,unicas.length);
      for(let i=0;i<qtd;i++) {
        const v=unicas[(indice+i)%unicas.length],placa=t4sPadrao.placaMercosul(v.placa);
        const aps=aparelhos.filter(a=>a.placa===placa);if(aps.length!==1)continue;
        const fim=agora(),iniDia=Date.parse(String(v.data_viagem).slice(0,10)+'T00:00:00-03:00');
        // Começa no início da viagem, mesmo num boot à tarde. A regra antiga
        // consultava só as últimas seis horas e perdia a saída e primeiras lojas.
        const desde=Math.max(iniDia,(cursores.get(v.id) || iniDia)-90*60000);
        const ate=Math.min(fim,desde+6*3600000);
        if(!Number.isFinite(desde)||desde>=fim)continue;
        // Reconstroi lacunas do dia inteiro com o que ja esta salvo, mesmo
        // quando a sessao T4S expirou ou a plataforma esta indisponivel.
        try {
          const r=await recuperar(v,aps[0],{desde:new Date(iniDia),ate:new Date(fim),somenteSalvos:true});
          if(r.eventos?.length)console.log(`[t4s historico salvo] ${placa}: ${r.eventos.length} eventos recuperados`);
        } catch(e) {console.error(`[t4s historico salvo] ${placa}: ${e.message}`);}
        if(!(t4s.historicoConfigurado || t4s.configurado)())continue;
        try {
          const r=await recuperar(v,aps[0],{desde:new Date(desde),ate:new Date(ate)});
          cursores.set(v.id,ate);
          if(r.inseridas || r.eventos?.length) console.log(`[t4s histórico] ${placa}: ${r.inseridas || 0} posições, ${r.eventos?.length || 0} eventos recuperados`);
        } catch(e) {console.error(`[t4s histórico] ${placa}: ${e.message}`);}
      }
      indice=(indice+qtd)%unicas.length;
      for(const id of cursores.keys())if(!unicas.some(v=>v.id===id))cursores.delete(id);
    } finally {rodando=false;}
  }
  return {recuperar,rodar};
}
module.exports={criar,validarPontos,eventosAusentes,selecionarHistorico};
