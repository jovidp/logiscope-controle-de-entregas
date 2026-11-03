// Historico do GPS por veiculo, de 00:00 a 23:59:59 em Sao Paulo, ate 5 dias.
// Apenas leitura: nao busca dados nas plataformas nem altera viagens/eventos.
'use strict';
const frota = require('./frota');
const rastreador = require('./rastreador');
const escolha = require('./rastreador-escolha');
const MAX_DIAS = 5, DIA_MS = 86400000;
function erro(texto, status = 400) { return Object.assign(new Error(texto), {status}); }
function dataValida(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === s;
}
function validarPeriodo(inicio, fim, hoje) {
  if (!dataValida(inicio) || !dataValida(fim)) throw erro('Informe datas válidas de início e fim.');
  const dias = Math.round((Date.parse(fim) - Date.parse(inicio)) / DIA_MS) + 1;
  if (dias < 1) throw erro('A data final precisa ser igual ou posterior à inicial.');
  if (dias > MAX_DIAS) throw erro('O período máximo é de 5 dias, contando o primeiro e o último.');
  if (fim > hoje) throw erro('Escolha um período até hoje.');
  return {inicio, fim, dias, inicio_ms: frota.inicioDoDia(inicio), fim_ms: frota.inicioDoDia(fim) + DIA_MS};
}
function diaSP(em) { return new Date(new Date(em).getTime() - 3*3600000).toISOString().slice(0,10); }
function pontosParaMapa(lista, inicioMs) {
  const {limpos, tAnt} = frota.semTremor(lista);
  return limpos.map((p,i)=>{
    const lig = frota.ligacao(limpos, tAnt, i);
    return [p.lat, p.lng, p.velocidade, Math.round((p.t-inicioMs)/1000), lig];
  });
}
function montarHistorico(pontos, periodo, lugares, preferencias = {}, ignoradas = [], placa) {
  const porDia = new Map();
  for (const p of pontos) {
    if (!Number.isFinite(p.t) || p.t < periodo.inicio_ms || p.t >= periodo.fim_ms) continue;
    const dia = diaSP(p.t);
    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia).push(p);
  }
  const dias = [], mapa = [], fontes = new Set();
  const total = {km:0,movendo_min:0,parado_min:0,vel_max:0,excessos:0,pontos_brutos:pontos.length,pontos_validos:0};
  let primeira = null, ultima = null;
  for (let n=0; n<periodo.dias; n++) {
    const data = new Date(Date.parse(periodo.inicio) + n*DIA_MS).toISOString().slice(0,10);
    const brutos = (porDia.get(data) || []).sort((a,b)=>a.t-b.t);
    const traj = frota.escolherTrajeto(brutos, preferencias[placa], ignoradas);
    const an = frota.analisar(traj.lista,lugares);
    const pts = pontosParaMapa(traj.lista,periodo.inicio_ms);
    // A analise e a escolha de fonte sao diarias. Nao liga automaticamente
    // o ultimo ponto de um dia ao primeiro do outro (pode haver horas sem GPS).
    mapa.push(...pts);
    if (traj.fonte) for (const f of traj.fonte.split('+')) fontes.add(f);
    if (an.primeira && !primeira) primeira=an.primeira;
    if (an.ultima) ultima=an.ultima;
    dias.push({data,fonte:traj.fonte,pontos_brutos:brutos.length,pontos_validos:traj.lista.length,
      km:an.km,movendo_min:an.movendo_min,parado_min:an.parado_min,vel_max:an.vel_max,
      primeira:an.primeira,ultima:an.ultima,sem_dados:!traj.lista.length});
    total.km+=an.km;total.movendo_min+=an.movendo_min;total.parado_min+=an.parado_min;
    total.vel_max=Math.max(total.vel_max,an.vel_max);total.excessos+=an.excessos;total.pontos_validos+=traj.lista.length;
  }
  total.km=Math.round(total.km*10)/10;
  return {placa,inicio:periodo.inicio,fim:periodo.fim,total_dias:periodo.dias,
    dia_inicio:new Date(periodo.inicio_ms).toISOString(),fim_exclusivo:new Date(periodo.fim_ms).toISOString(),
    primeira,ultima,fonte:[...fontes].join('+') || null,vel_excesso:frota.VEL_EXCESSO,
    resumo:total,dias,pontos:mapa,sem_dados:dias.filter(d=>d.sem_dados).map(d=>d.data),
    gerado_em:new Date().toISOString()};
}
function criar({db,agoraSP, obterLugares=()=>rastreador.coordenadas(db), obterPreferencias=()=>escolha.preferencias(db), obterIgnoradas=escolha.ignoradas}) {
  const cache = new Map();let base=null;
  async function consultar(placa, periodo) {
    const [r,coordenadas,prefs,eventos] = await Promise.all([
      db.query(`SELECT fonte, device_id, placa, lat, lng, velocidade, posicao_em
        FROM rastreador_posicoes WHERE placa=$1
        AND posicao_em >= ($2::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'
        AND posicao_em < ($3::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo'
        ORDER BY posicao_em LIMIT 150001`,[placa,periodo.inicio,periodo.fim]),
      obterLugares(),obterPreferencias(),
      db.query(`SELECT tipo, lugar_codigo, lugar_nome, em, lat, lng, fonte, permanencia_min, detalhe
        FROM rastreador_eventos_loja WHERE placa=$1
        AND em >= ($2::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'
        AND em < ($3::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo'
        ORDER BY em LIMIT 2001`,[placa,periodo.inicio,periodo.fim]),
    ]);
    if (r.rows.length>150000) throw erro('Há muitas leituras nesse período. Consulte menos dias.',422);
    const pontos = r.rows.map(p=>({...p,lat:Number(p.lat),lng:Number(p.lng),velocidade:Number(p.velocidade)||0,t:new Date(p.posicao_em).getTime()}));
    const resultado=montarHistorico(pontos,periodo,[...coordenadas.values()],prefs,obterIgnoradas(placa),placa);
    return {...resultado,eventos:eventos.rows.slice(0,2000),eventos_truncados:eventos.rows.length>2000};
  }
  async function historico(req,res) {
    try {
      const placa=rastreador.placaMercosul(req.query.placa);
      if (!placa) throw erro('Escolha um veículo válido.');
      const periodo=validarPeriodo(req.query.inicio,req.query.fim,agoraSP().data);
      const k=[placa,periodo.inicio,periodo.fim].join('|');
      let c=cache.get(k);const ttl=periodo.fim===agoraSP().data?15000:600000;
      if(!c || Date.now()-c.em>ttl){c={em:Date.now(),p:consultar(placa,periodo)};cache.set(k,c);c.p.catch(()=>{if(cache.get(k)===c)cache.delete(k);});if(cache.size>8)cache.delete(cache.keys().next().value);}
      res.set?.('Cache-Control','no-store');res.json(await c.p);
    } catch(e) {res.status(e.status || 500).json({error:e.message});}
  }
  async function catalogo(req,res) {
    try {
      if(!base || Date.now()-base.em>60000){
        const atual={em:Date.now(),p:(async()=>{
          const [pos,aparelhos]=await Promise.all([
            db.query(`SELECT placa, MIN(posicao_em) AS primeira, MAX(posicao_em) AS ultima
              FROM rastreador_posicoes WHERE placa IS NOT NULL GROUP BY placa ORDER BY placa`),
            db.query('SELECT placa, nome, fonte FROM rastreador_aparelhos WHERE placa IS NOT NULL'),
          ]);
          return {veiculos:pos.rows.filter(p=>rastreador.placaMercosul(p.placa)).map(p=>{
            const nomes=aparelhos.rows.filter(a=>a.placa===p.placa).sort((a,b)=>(b.fonte==='t4s')-(a.fonte==='t4s'));
            return {...p,modelo:frota.modeloDoNome(nomes[0]?.nome)};
          }),max_dias:MAX_DIAS,hoje:agoraSP().data};
        })()};base=atual;atual.p.catch(()=>{if(base===atual)base=null;});
      }
      res.set?.('Cache-Control','no-store');res.json(await base.p);
    } catch(e){res.status(500).json({error:e.message});}
  }
  return {historico,catalogo};
}
module.exports={criar,validarPeriodo,pontosParaMapa,montarHistorico,MAX_DIAS};