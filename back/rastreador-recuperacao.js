'use strict';
// Reconstitui eventos perdidos com todas as fontes já persistidas. Não depende
// da sessão das plataformas e não altera horários manuais nem ocorrências.
const ao = require('./rastreador-ao-vivo');
const qualidade = require('./gps-precisao');
const escolha = require('./rastreador-escolha');
const lojasPes = require('./lojas-pes');
const TIPOS = new Set(['chegou_loja','saiu_loja','voltou_fabrica','saiu_fabrica']);
const ENTRADAS = new Set(['chegou_loja','voltou_fabrica']);
const MARGEM_MS = 2 * 60000;
const diaSP = data => new Intl.DateTimeFormat('en-CA', {timeZone:'America/Sao_Paulo'}).format(data);
const inicioSP = dia => Date.parse(dia + 'T00:00:00-03:00');

function reconstruir(pontos, lugares) {
  const detector = ao.criarDetector();
  const eventos = [];
  for (const p of pontos) eventos.push(...detector.processar(p, lugares, {historico:true}));
  return eventos.filter(e => TIPOS.has(e.tipo) && !e.lugar?.ambigua);
}

function janelas(eventos, desde, ate) {
  desde=+new Date(desde);ate=+new Date(ate);
  const visitas=[];
  let aberta=null;
  for(const e of eventos.slice().sort((a,b)=>+new Date(a.em)-+new Date(b.em))) {
    const codigo=e.lugar?.codigo || e.lugar_codigo, t=+new Date(e.em);
    if(ENTRADAS.has(e.tipo)) {
      if(aberta)aberta.fim=t;
      aberta={codigo,ini:t,fim:+ate,eventos:[e]};visitas.push(aberta);
    } else if(aberta?.codigo===codigo) {
      aberta.fim=t;aberta.eventos.push(e);aberta=null;
    } else {
      if(aberta){aberta.fim=t;aberta=null;}
      visitas.push({codigo,ini:Math.max(+desde,t-30*60000),fim:t,eventos:[e]});
    }
  }
  return visitas;
}

// Compara encontros sobrepostos: não duplica uma saída já captada com alguns
// minutos de diferença, mas conserva uma segunda visita à mesma loja.
function ausentes(eventos, existentes, desde, ate) {
  const visitas=janelas(eventos,desde,ate), conhecidas=janelas(existentes,desde,ate), novos=[];
  for(const visita of visitas)for(const e of visita.eventos) {
    const ini=e.visita_desde ?? visita.ini, fim=e.visita_ate ?? visita.fim;
    const mesmo=conhecidas.filter(x=>x.codigo===visita.codigo && x.ini<=fim+MARGEM_MS && x.fim>=ini-MARGEM_MS);
    if(mesmo.some(x=>x.eventos.some(y=>y.tipo===e.tipo)))continue;
    // Não completa um par invertido: chegada posterior à saída ou vice-versa.
    if(mesmo.some(x=>x.eventos.some(y=>ENTRADAS.has(e.tipo)
      ? !ENTRADAS.has(y.tipo) && +new Date(y.em)<+new Date(e.em)
      : ENTRADAS.has(y.tipo) && +new Date(y.em)>+new Date(e.em))))continue;
    novos.push({...e,visita_desde:ini,visita_ate:fim});
  }
  return novos;
}

function donoDoEvento(e, viagens) {
  const placa=aoPlaca(e.placa), dia=diaSP(new Date(e.em));
  const hoje=viagens.filter(v=>aoPlaca(v.placa)===placa && v.data_viagem===dia);
  if(hoje.length===1)return hoje[0];
  if(hoje.length>1)return null;
  const pernoite=require('./pernoite');
  const anteriores=viagens.filter(v=>aoPlaca(v.placa)===placa && pernoite.ehRotaViagem(v.rota_nome)
    && inicioSP(dia)>inicioSP(v.data_viagem)
    && inicioSP(dia)<=inicioSP(v.data_viagem)+pernoite.DIAS_CONTINUA*86400000);
  return anteriores.length===1 ? anteriores[0] : null;
}
const aoPlaca = p => require('./rastreador').placaMercosul(p);

function criar({db,rastreador,agora=()=>Date.now(),broadcastEvento=()=>{},intervaloMs=60000}) {
  let rodando=false, proximo=0;
  async function planejar({dias=3,desde,ate=new Date(agora())}={}) {
    if(!Number.isInteger(dias) || dias<1 || dias>60)throw Error('Dias inválidos (1 a 60)');
    desde=desde ? new Date(desde) : new Date(inicioSP(diaSP(new Date(ate)))-(dias-1)*86400000);
    ate=new Date(ate);
    if(!Number.isFinite(+desde) || !Number.isFinite(+ate) || +ate<=+desde || +ate-+desde>60*86400000)throw Error('Período inválido');
    const preferencias=await escolha.preferencias(db);
    const [coords,ps,es,vs]=await Promise.all([
      rastreador.coordenadas(db),
      db.query(`SELECT placa,fonte,device_id,lat,lng,velocidade,motor,posicao_em
        FROM rastreador_posicoes WHERE posicao_em BETWEEN $1 AND $2 AND placa IS NOT NULL ORDER BY posicao_em`,[desde,ate]),
      db.query(`SELECT placa,tipo,lugar_codigo,em,viagem_id,parada_id FROM rastreador_eventos_loja
        WHERE em BETWEEN $1 AND $2 AND tipo=ANY($3::text[]) ORDER BY em`,[desde,ate,[...TIPOS]]),
      db.query(`SELECT v.*,to_char(v.data_viagem,'YYYY-MM-DD') AS data_viagem FROM tms_viagens v
        WHERE v.data_viagem BETWEEN ($1::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date - 3
          AND ($2::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date AND v.status<>'Cancelada' ORDER BY v.id`,[desde,ate]),
    ]);
    const viagens=vs.rows;
    if(viagens.length) {
      const paradas=(await db.query('SELECT * FROM tms_paradas WHERE viagem_id=ANY($1::int[]) ORDER BY ordem,id',[viagens.map(v=>v.id)])).rows;
      for(const v of viagens)v.paradas=paradas.filter(p=>p.viagem_id===v.id);
      lojasPes.enriquecerViagens(viagens,await lojasPes.carregarIndice(db));
    }
    const cadastradas=new Set((await db.query('SELECT placa FROM tms_veiculos')).rows.map(v=>aoPlaca(v.placa)));
    for(const v of viagens)if(v.placa)cadastradas.add(aoPlaca(v.placa));
    const grupos=new Map();
    for(const p of ps.rows) {
      if(!cadastradas.has(p.placa))continue;
      if(!grupos.has(p.placa))grupos.set(p.placa,[]);
      grupos.get(p.placa).push({...p,t:+new Date(p.posicao_em)});
    }
    const eventos=[];
    for(const [placa,pontos] of grupos) {
      const filtro=qualidade.criarFiltro();
      const validos=pontos.filter(p=>filtro.avaliar(p).ok).map(p=>({...p,lat:Number(p.lat),lng:Number(p.lng),velocidade:Number(p.velocidade)}));
      const lista=require('./frota').escolherTrajeto(validos,preferencias[placa],escolha.ignoradas(placa)).lista;
      const detectados=reconstruir(lista,[...coords.values()]);
      for(const e of ausentes(detectados,es.rows.filter(x=>x.placa===placa),desde,ate)) {
        const v=donoDoEvento(e,viagens);
        const paradas=v ? v.paradas.filter(p=>p.loja_codigo_pes===e.lugar.codigo) : [];
        // Duas paradas da mesma loja exigem associação por horário na leitura.
        const p=paradas.length===1 ? paradas[0] : null;
        eventos.push({...e,lugar_codigo:e.lugar.codigo,lugar_nome:e.lugar.nome || e.lugar.codigo,
          viagem_id:v?.id || null,parada_id:p?.id || null,
          motorista:v?.motorista_nome,rota:v?.rota_nome,
          detalhe:[e.detalhe,'recuperado dos sinais GPS salvos'].filter(Boolean).join('; ')});
      }
    }
    return {desde:desde.toISOString(),ate:ate.toISOString(),pontos:ps.rows.length,placas:grupos.size,viagens,eventos};
  }

  async function aplicar(plano) {
    if(!plano.eventos.length)return [];
    const client=await db.connect(), gravados=[];
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(8642018)');
      // Recuperações concorrentes e o T4S usam a mesma trava por viagem.
      for(const id of [...new Set(plano.eventos.map(e=>e.viagem_id).filter(Boolean))].sort((a,b)=>a-b))
        await client.query('SELECT id FROM tms_viagens WHERE id=$1 FOR UPDATE',[id]);
      const atuais=(await client.query(`SELECT placa,tipo,lugar_codigo,em FROM rastreador_eventos_loja
        WHERE em BETWEEN $1 AND $2 AND tipo=ANY($3::text[]) ORDER BY em`,[plano.desde,plano.ate,[...TIPOS]])).rows;
      const confirmados=[];
      for(const placa of new Set(plano.eventos.map(e=>e.placa)))confirmados.push(...ausentes(
        plano.eventos.filter(e=>e.placa===placa),atuais.filter(e=>e.placa===placa),plano.desde,plano.ate));
      for(const e of confirmados) {
        if(e.viagem_id) {
          const v=(await client.query('SELECT placa,status FROM tms_viagens WHERE id=$1',[e.viagem_id])).rows[0];
          if(!v || aoPlaca(v.placa)!==e.placa || v.status==='Cancelada')continue;
          if(e.parada_id) {
            const p=(await client.query('SELECT loja_nome FROM tms_paradas WHERE id=$1 AND viagem_id=$2',[e.parada_id,e.viagem_id])).rows[0];
            const original=plano.viagens.find(v=>v.id===e.viagem_id)?.paradas.find(p=>p.id===e.parada_id);
            if(!p || p.loja_nome!==original?.loja_nome)continue;
          }
        }
        const r=await client.query(`INSERT INTO rastreador_eventos_loja
          (placa,tipo,lugar_codigo,lugar_nome,em,viagem_id,parada_id,lat,lng,fonte,permanencia_min,detalhe)
          SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
          WHERE NOT EXISTS(SELECT 1 FROM rastreador_eventos_loja
            WHERE placa=$1 AND tipo=$2 AND lugar_codigo=$3 AND em BETWEEN $5::timestamptz-INTERVAL '2 minutes' AND $5::timestamptz+INTERVAL '2 minutes')
          ON CONFLICT DO NOTHING RETURNING id`,
          [e.placa,e.tipo,e.lugar_codigo,e.lugar_nome,e.em,e.viagem_id,e.parada_id,e.lat,e.lng,e.fonte,e.permanencia_min ?? null,e.detalhe]);
        if(r.rows.length)gravados.push({...e,id:r.rows[0].id});
      }
      await client.query('COMMIT');
    } catch(e) {await client.query('ROLLBACK');throw e;} finally {client.release();}
    for(const e of gravados) {try {broadcastEvento('gps',{...e,lugar:e.lugar_nome,texto:e.placa+' '+ao.frase(e)});}catch(_) {}}
    return gravados;
  }

  async function rodar() {
    if(rodando || agora()<proximo)return [];
    rodando=true;
    try {
      const gravados=await aplicar(await planejar());
      proximo=agora()+intervaloMs;
      if(gravados.length)console.log(`[gps recuperação] ${gravados.length} horário(s) recuperado(s)`);
      return gravados;
    } finally {rodando=false;}
  }
  return {planejar,aplicar,rodar};
}
module.exports={criar,reconstruir,ausentes,donoDoEvento};
