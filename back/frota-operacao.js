'use strict';
const q = require('./gps-precisao');
const PADRAO = {loja_min:90, loja_margem_min:30, loja_fator:1.5, desvio_m:2000, desvio_min:10};
const CAMPOS_CUSTO = ['custo_frete','custo_combustivel','pedagio','outros_custos'];
const ROTULOS_CUSTO = ['frete','combustível','pedágio','outros'];
const arred = n => Math.round(n*100)/100;
function validarConfig(b) {
  const limites={loja_min:[20,600],loja_margem_min:[10,180],loja_fator:[1.1,3],desvio_m:[300,10000],desvio_min:[3,60]};
  const out={};
  for(const [k,[min,max]] of Object.entries(limites)) {
    if(!q.numero(b[k]) || Number(b[k])<min || Number(b[k])>max) throw Object.assign(new Error(`Ajuste inválido: ${k} (${min} a ${max}).`),{status:400});
    out[k]=Number(b[k]);
  }
  return out;
}
function historicoLojas(resumos) {
  const porLoja=new Map();
  for(const r of resumos) {
    if(r.tipo && !['caminhao','utilitario'].includes(r.tipo))continue;
    for(const v of r.visitas || []) {
      if(!v.codigo || v.fabrica || v.ambigua || v.confirmacao_necessaria || v.sem_registro || !v.chegada_vista || !v.saiu || !q.numero(v.min) || v.min<1 || v.min>600)continue;
      const lista=porLoja.get(v.codigo) || [];lista.push(Number(v.min));porLoja.set(v.codigo,lista);
    }
  }
  return new Map([...porLoja].map(([codigo,lista])=>{lista.sort((a,b)=>a-b);const m=Math.floor(lista.length/2);return [codigo,{amostras:lista.length,mediana_min:lista.length%2?lista[m]:(lista[m-1]+lista[m])/2}];}));
}
function limiteLoja(base,config=PADRAO) {
  const historico=!!base && base.amostras>=5;
  return {limite_min:Math.round(historico?Math.max(base.mediana_min*config.loja_fator,base.mediana_min+config.loja_margem_min):config.loja_min),
    referencia:historico?'historico':'limite_padrao',amostras:base?.amostras || 0,mediana_min:historico?base.mediana_min:null};
}
function demoraLoja({placa,visita,atual,lugares,historico,config=PADRAO,agora=Date.now(),aoVivo=true}) {
  if(!visita || visita.fabrica || visita.sem_registro || visita.ambigua || visita.confirmacao_necessaria || !visita.chegada_vista)return null;
  const inicio=Date.parse(visita.chegou);if(!Number.isFinite(inicio))return null;
  let fim=Date.parse(visita.saiu);
  if(!visita.saiu) {
    if(!aoVivo || !atual || atual.confiavel_eventos===false || q.motivoInvalido(atual,{agora,maxIdadeMs:q.RECENTE_MS}))return null;
    const dentro=lugares.filter(l=>q.dentroLugar(atual,l));
    if(dentro.length!==1 || dentro[0].codigo!==visita.codigo)return null;
    fim=Date.parse(atual.posicao_em);
  }
  if(!Number.isFinite(fim)||fim<inicio)return null;
  const ref=limiteLoja(historico.get(visita.codigo),config),min=Math.round((fim-inicio)/60000);
  return {placa,codigo:visita.codigo,loja:visita.nome,chegou:visita.chegou,saiu:visita.saiu || null,min,em_andamento:!visita.saiu,excedeu:min>=ref.limite_min,...ref,lat:visita.lat,lng:visita.lng};
}
function custoViagem(v) {
  const valores=CAMPOS_CUSTO.map(k=>q.numero(v[k]) && Number(v[k])>=0 ? Number(v[k]):null);
  const preenchidos=valores.filter(n=>n!==null).length;
  const total=preenchidos?arred(valores.reduce((s,n)=>s+(n ?? 0),0)):null;
  const paradas=v.paradas || [];
  // Passagem GPS, recusa ou ocorrência sem entrega não aumentam o denominador.
  const entregas=paradas.filter(p=>['Entregue','Entregue com ocorrencia'].includes(p.status) || p.ocorrencia_id && p.ocorrencia_status==='Entregue').length;
  const km=q.numero(v.km_real) && Number(v.km_real)>0?Number(v.km_real):null;
  return {id:v.id,codigo:v.codigo || String(v.id),data:v.data_viagem,placa:v.placa,rota:v.rota_nome,motorista:v.motorista_nome,status:v.status,
    entregas_confirmadas:entregas,paradas_previstas:paradas.length,km_real:km,total_cadastrado:total,
    custo_por_entrega:total!==null && entregas?arred(total/entregas):null,custo_por_km:total!==null && km?arred(total/km):null,
    custos_faltando:ROTULOS_CUSTO.filter((_,i)=>valores[i]===null),custos_completos:preenchidos===4,
    provisorio:v.status!=='Finalizada' || preenchidos!==4,frete_previsto:q.numero(v.frete_calc_total)?Number(v.frete_calc_total):null};
}
function percursoPlanejado(viagem,lugares,consultar) {
  const coords=new Map(lugares.map(l=>[l.codigo,l]));
  const paradas=[...(viagem.paradas || [])].sort((a,b)=>(a.ordem||0)-(b.ordem||0)||(a.id||0)-(b.id||0));
  const codigos=['FABRICA',...paradas.map(p=>p.loja_codigo_pes),'FABRICA'];
  const faltando=codigos.filter(c=>!c || !q.coordenadaValida(coords.get(c)));
  if(!paradas.length || faltando.length)return {status:'sem_coordenadas',faltando:[...(!q.coordenadaValida(coords.get('FABRICA'))?['Fábrica']:[]),...paradas.filter(p=>!q.coordenadaValida(coords.get(p.loja_codigo_pes))).map(p=>p.loja_nome || p.loja_codigo_pes || 'Loja')],pontos:[]};
  const pontos=[];let pendente=false;
  const chave=codigos.map(c=>{const l=coords.get(c);return `${c}:${l.lat},${l.lng}`;}).join('|');
  for(let i=1;i<codigos.length;i++) {
    const a=coords.get(codigos[i-1]),b=coords.get(codigos[i]);
    if(q.distanciaM(a,b)<20){pontos.push([a.lat,a.lng],[b.lat,b.lng]);continue;}
    const trecho=consultar(a,b);
    if(!trecho || trecho.length<2)pendente=true;else pontos.push(...trecho);
  }
  return {status:pendente?'calculando':'pronto',pontos:pendente?[]:pontos,chave};
}
function criarMonitorDesvio() {
  const estados=new Map();
  function avaliar(placa,atual,percurso,viagemId,config=PADRAO,{agora=Date.now(),emLoja=false}={}) {
    const limpar=status=>{estados.delete(placa);return {placa,status,confirmado:false};};
    if(!atual || atual.confiavel_eventos===false || q.motivoInvalido(atual,{agora,maxIdadeMs:q.RECENTE_MS}))return limpar('sem_sinal_confiavel');
    if(emLoja)return limpar('na_loja');
    if(percurso.status!=='pronto')return limpar(percurso.status);
    const distancia=q.distanciaBorda(atual,percurso.pontos),t=Date.parse(atual.posicao_em);
    let s=estados.get(placa);
    if(distancia<=config.desvio_m)return {...limpar('no_percurso'),distancia_m:Math.round(distancia)};
    if(s && (t<s.ultimo || q.salto(s.pos,atual)))return limpar('sem_sinal_confiavel');
    if(s && (s.viagemId!==viagemId || s.chave!==percurso.chave || t-s.ultimo>q.RECENTE_MS))s=null;
    if(!s && Number(atual.velocidade)<3)return {...limpar('parado_fora'),distancia_m:Math.round(distancia)};
    if(!s)s={viagemId,chave:percurso.chave,inicio:t,ultimo:t,leituras:1,pos:{...atual}};
    else if(t>s.ultimo){s.ultimo=t;s.leituras++;s.pos={...atual};}
    estados.set(placa,s);
    const min=Math.floor((s.ultimo-s.inicio)/60000),confirmado=s.leituras>=3 && min>=config.desvio_min;
    return {placa,status:confirmado?'desvio':'confirmando',confirmado,inicio:new Date(s.inicio).toISOString(),min,leituras:s.leituras,distancia_m:Math.round(distancia),lat:atual.lat,lng:atual.lng};
  }
  return {avaliar,limpar:placa=>estados.delete(placa),manter:placas=>{for(const p of estados.keys())if(!placas.has(p))estados.delete(p);}};
}
function criar({db,diario,buscarViagensTms,agoraSP,registrarAuditoria,roteador=require('./frota-rotas'),rastreador=require('./rastreador')}) {
  const hoje=()=>agoraSP().data,monitor=criarMonitorDesvio();
  let configCache=null;const cache=new Map(),historicos=new Map();
  async function config() {
    if(configCache && Date.now()-configCache.em<60000)return configCache.valor;
    const r=await db.query("SELECT valor FROM sistema_config WHERE chave='frota_operacao_config'");
    const valor=r.rows[0]?validarConfig({...PADRAO,...r.rows[0].valor}):{...PADRAO};configCache={em:Date.now(),valor};return valor;
  }
  async function historia(data) {
    const c=historicos.get(data);if(c && Date.now()-c.em<300000)return c.valor;
    const r=await db.query("SELECT resumo FROM frota_resumo_dia WHERE data >= $1::date - 60 AND data < $1::date",[data]);
    const valor=historicoLojas(r.rows.map(x=>x.resumo));historicos.set(data,{em:Date.now(),valor});if(historicos.size>6)historicos.delete(historicos.keys().next().value);return valor;
  }
  async function calcular(data) {
    await diario.garantir();
    const vivo=data===hoje();
    const [cfg,resumos,viagens,mapa,hist,atuais]=await Promise.all([config(),diario.resumoDoDia(data),buscarViagensTms(data,{pernoite:true}),rastreador.coordenadas(db),historia(data),vivo?rastreador.posicoesAtuais(db):[]]);
    const lugares=[...mapa.values()],porAtual=new Map(atuais.map(a=>[a.placa,a]));
    const demoras=[],desvios=[],alertas=[],ativas=new Set();
    for(const [placa,r] of Object.entries(resumos)) {
      if(r.tipo && !['caminhao','utilitario'].includes(r.tipo))continue;
      for(const visita of r.visitas || []) {
        const item=demoraLoja({placa,visita,atual:porAtual.get(placa),lugares,historico:hist,config:cfg,aoVivo:vivo});
        if(!item)continue;demoras.push(item);
        if(vivo && item.em_andamento && item.excedeu && r.viagem && !['Finalizada','Cancelada'].includes(r.viagem.status))alertas.push({chave:`frota-loja-demora-${placa}-${item.codigo}-${item.chegou}`,tipo:'frota_loja_demora',severidade:'media',titulo:`${placa}: ${item.min} min em ${item.loja}`,detalhe:`Referência ${item.limite_min} min${item.referencia==='historico'?` · mediana ${item.mediana_min} min (${item.amostras} visitas)`:' · limite padrão, sem histórico suficiente'}`,aba:'frota',evento_em:item.chegou,semTelegram:true});
      }
    }
    if(vivo) {
      await roteador.iniciar(db);
      const porPlaca=new Map();
      for(const v of viagens)if(!v.retorno_real && !['Finalizada','Cancelada'].includes(v.status) && (v.saida_real || v.gps_saida_fabrica_em || ['Em rota','Retorno'].includes(v.status))) {
        const placa=rastreador.placaMercosul(v.placa);if(placa)(porPlaca.get(placa)||porPlaca.set(placa,[]).get(placa)).push(v);
      }
      for(const [placa,vs] of porPlaca) {
        ativas.add(placa);
        if(vs.length!==1){monitor.limpar(placa);desvios.push({placa,status:'viagens_sobrepostas',confirmado:false});continue;}
        const v=vs[0],a=porAtual.get(placa),percurso=percursoPlanejado(v,lugares,roteador.planejado);
        const emLoja=!!a && lugares.some(l=>q.dentroLugar(a,l,true));
        const item={...monitor.avaliar(placa,a,percurso,v.id,cfg,{emLoja}),viagem_id:v.id,rota:v.rota_nome,faltando:percurso.faltando || []};desvios.push(item);
        if(item.confirmado)alertas.push({chave:`frota-desvio-${v.id}-${item.inicio}`,tipo:'frota_desvio',severidade:'media',titulo:`${placa}: fora do percurso de referência`,detalhe:`${Math.round(item.distancia_m)} m do percurso por ${item.min} min · ${v.rota_nome || 'viagem '+v.id} · conferir desvio autorizado`,aba:'frota',evento_em:item.inicio,semTelegram:true});
      }
      monitor.manter(ativas);
    }
    const custos=viagens.filter(v=>v.status!=='Cancelada').map(custoViagem);
    return {data,ao_vivo:vivo,gerado_em:new Date().toISOString(),config:cfg,demoras:demoras.sort((a,b)=>Number(b.em_andamento)-Number(a.em_andamento)||b.min-a.min),desvios,custos,alertas};
  }
  async function painel(data=hoje()) {
    let c=cache.get(data);
    if(!c || Date.now()-c.em>50000) {
      c={em:Date.now(),p:calcular(data)};cache.set(data,c);c.p.catch(()=>cache.delete(data));if(cache.size>6)cache.delete(cache.keys().next().value);
    }
    return c.p;
  }
  const rotas={
    painel:async(req,res)=>{try{
      const data=String(req.query.data || hoje());
      if(!/^\d{4}-\d{2}-\d{2}$/.test(data) || !Number.isFinite(Date.parse(data+'T12:00:00Z')) || new Date(data+'T12:00:00Z').toISOString().slice(0,10)!==data || data>hoje() || Date.parse(hoje())-Date.parse(data)>62*86400000)return res.status(400).json({error:'Escolha uma data válida dos últimos 62 dias.'});
      const dados=await painel(data),custosPermitidos=req.usuarioLogado?.super_adm===true || req.usuarioLogado?.perfil==='ADM';
      res.json({...dados,alertas:undefined,custos:custosPermitidos?dados.custos:undefined,custos_permitidos:custosPermitidos});
    }catch(e){res.status(500).json({error:e.message});}},
    salvarConfig:async(req,res)=>{try{
      const valor=validarConfig(req.body || {});
      await db.query("INSERT INTO sistema_config(chave,valor,atualizado_em) VALUES('frota_operacao_config',$1::jsonb,NOW()) ON CONFLICT(chave) DO UPDATE SET valor=EXCLUDED.valor,atualizado_em=NOW()",[JSON.stringify(valor)]);
      configCache=null;cache.clear();monitor.manter(new Set());
      await registrarAuditoria(req,'AJUSTAR_OPERACAO_FROTA','sistema_config',null,valor);res.json({ok:true});
    }catch(e){res.status(e.status||500).json({error:e.message});}}
  };
  return {painel,rotas,candidatos:async()=> (await painel()).alertas};
}
module.exports={PADRAO,validarConfig,historicoLojas,limiteLoja,demoraLoja,custoViagem,percursoPlanejado,criarMonitorDesvio,criar};