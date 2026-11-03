// ================================================================
// rastreador-escolha.js — QUAL rastreador vale para cada placa.
// ----------------------------------------------------------------
// Com 3 fontes (SRF, T4S, Sat) "o sinal mais recente" nao basta: em
// 06/10/2026 o aparelho SRF cadastrado como FKC2E12 estava PARADO NA FABRICA
// (mandando sinal todo minuto) enquanto T4S e Sat mostravam o caminhao em
// Buzios. O mais recente era o SRF — e o mapa, o rastro e o registro de
// chegadas mostravam o FKC2E12 parado o dia inteiro.
// Regras (na ordem):
//   1. Preferencia escolhida na tela (sistema_config 'rastreador_fonte_preferida',
//      { "FKC2E12": "sat" }): vale se aquela fonte tem sinal recente.
//   2. Fontes com sinal recente (5 min), a no máximo 1 min entre si que DISCORDAM de lugar (> 1,5 km):
//      vale o grupo da maioria; empate -> o grupo em que o carro anda;
//      depois o mais recente.
//   3. Senao, o sinal mais recente (empate: SRF).
// Para o trajeto do dia (frota.js): a fonte que discorda das outras na maior
// parte das comparacoes e descartada (fontesDescartadas).
// Fonte IGNORADA por placa (sistema_config 'rastreador_fonte_ignorada',
// { "FKC2E12": ["srf"] }): aparelho que NAO esta naquele carro — em 06/10 o
// "FKC2E12" do SRF era o IMEI 9000000001, parado na fabrica; o do caminhao e
// o 860000000000001 (Sat). Nunca entra, nem como reserva.
// ================================================================
const CHAVE_CFG = "rastreador_fonte_preferida";
const CHAVE_IGN = "rastreador_fonte_ignorada";
const qualidade = require("./gps-precisao");
const { RECENTE_MS, SINCRONIA_MS } = qualidade;
const CHAVE_APA = "rastreador_aparelho_vinculado";
const DISCORDA_M = 1500;

function distM(a, b) {
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------------------------------------------------------------- preferencias
let cache = null;
async function preferencias(db) {
  if (cache && Date.now() - cache.em < 60000) return cache.mapa;
  try {
    const r = await db.query("SELECT chave, valor FROM sistema_config WHERE chave = ANY($1)", [[CHAVE_CFG, CHAVE_IGN, CHAVE_APA]]);
    const pega = (k) => { const x = r.rows.find((y) => y.chave === k); const v = x && x.valor; return v && typeof v === "object" ? v : {}; };
    cache = { em: Date.now(), mapa: pega(CHAVE_CFG), ignorar: pega(CHAVE_IGN), aparelhos: pega(CHAVE_APA) };
  } catch (e) { if (!cache) throw e; }
  return cache.mapa;
}
// Fontes a ignorar de uma placa (usar depois de await preferencias(db)).
const ignoradas = (placa) => new Set(((cache && cache.ignorar) || {})[placa] || []);
async function salvarIgnoradas(db, placa, fontes) {
  await preferencias(db);
  const atual = { ...((cache && cache.ignorar) || {}) };
  if (fontes && fontes.length) atual[placa] = [...new Set(fontes)]; else delete atual[placa];
  await db.query(`
    INSERT INTO sistema_config (chave, valor, atualizado_em) VALUES ($1, $2, NOW())
    ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = NOW()`, [CHAVE_IGN, JSON.stringify(atual)]);
  cache = { ...cache, ignorar: atual };
  return atual;
}
async function salvarPreferencia(db, placa, fonte) {
  const atual = { ...(await preferencias(db)) };
  if (fonte) atual[placa] = fonte; else delete atual[placa];
  await db.query(`
    INSERT INTO sistema_config (chave, valor, atualizado_em) VALUES ($1, $2, NOW())
    ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = NOW()`, [CHAVE_CFG, JSON.stringify(atual)]);
  cache = { ...(cache || {}), em: Date.now(), mapa: atual };
  return atual;
}

// ---------------------------------------------------------------- posicao atual
// cands: linhas de rastreador_aparelhos da MESMA placa ({fonte, lat, lng, velocidade, posicao_em}).
const vinculados = placa => Object.fromEntries(["srf","t4s","sat"].filter(f => Object.hasOwn((cache && cache.aparelhos) || {}, placa+":"+f)).map(f => [f,cache.aparelhos[placa+":"+f]]));
async function salvarVinculo(db, placa, fonte, deviceId) {
  const chave = placa+":"+fonte;
  const r = await db.query(    "INSERT INTO sistema_config (chave, valor, atualizado_em) VALUES ($1, CASE WHEN $3::bigint IS NULL THEN '{}'::jsonb ELSE jsonb_build_object($2::text,$3::bigint) END,NOW()) " +
    "ON CONFLICT (chave) DO UPDATE SET valor = CASE WHEN $3::bigint IS NULL THEN sistema_config.valor - $2::text ELSE jsonb_set(sistema_config.valor, ARRAY[$2::text], to_jsonb($3::bigint)) END, atualizado_em=NOW() RETURNING valor",
    [CHAVE_APA,chave,deviceId]);
  cache = null;
  return r.rows[0].valor;
}
function aparelhoPermitido(a, vinculos = {}) {
  return !Object.hasOwn(vinculos,a.fonte) || String(vinculos[a.fonte]) === String(a.device_id);
}
function escolherAtual(candsTodos, pref, agora = Date.now(), ign = new Set(), vinculos = {}) {
  const rejeitadas = [];
  const validas = candsTodos.filter(a => {
    const motivo = ign.has(a.fonte) ? "fonte bloqueada" : !aparelhoPermitido(a,vinculos) ? "aparelho não vinculado" : qualidade.motivoInvalido(a,{agora});
    if (motivo) rejeitadas.push({fonte:a.fonte,device_id:a.device_id,motivo});
    return !motivo;
  });
  // Uma plataforma tem um voto: aparelhos duplicados não formam maioria.
  const tempo = a => new Date(a.posicao_em).getTime();
  const ordenadas = validas.slice().sort((a,b) => tempo(b)-tempo(a) || Number(b.fonte==="srf")-Number(a.fonte==="srf"));
  const fontes = new Set();
  const cands = ordenadas.filter(a => {if(fontes.has(a.fonte)) return false; fontes.add(a.fonte); return true;});
  if (!cands.length) return {escolhida:null,motivo:"sem_fonte_valida",rejeitadas};
  const maisRecente = l => l.slice().sort((a,b) => tempo(b)-tempo(a) || Number(b.fonte==="srf")-Number(a.fonte==="srf"))[0];
  const recentes = cands.filter(a => agora-tempo(a)<=RECENTE_MS && tempo(cands[0])-tempo(a)<=SINCRONIA_MS);
  const metadados = {rejeitadas,defasadas:cands.filter(a=>!recentes.includes(a)).map(a=>a.fonte)};
  if (!recentes.length) return {escolhida:cands[0],motivo:"ultimo_sinal_antigo",...metadados};
  if (pref) {
    const p=recentes.find(a=>a.fonte===pref);
    if(p) return {escolhida:p,motivo:"preferida",...metadados};
  }
  const grupos=[];
  for(const a of recentes) {
    const g=grupos.find(x=>x.every(b=>distM(a,b)<=DISCORDA_M));
    if(g) g.push(a); else grupos.push([a]);
  }
  if(grupos.length>1) {
    const anda=g=>g.some(a=>Number(a.velocidade)>=3);
    grupos.sort((x,y)=>y.length-x.length || Number(anda(y))-Number(anda(x)) || tempo(maisRecente(y))-tempo(maisRecente(x)));
    // Empate em locais diferentes não basta para preencher horários.
    const inconclusiva=grupos[0].length===grupos[1].length;
    return {escolhida:maisRecente(grupos[0]),motivo:inconclusiva?"discordancia_sem_consenso":"maioria",confiavel_eventos:!inconclusiva,
      discordantes:grupos.slice(1).flat().map(a=>a.fonte),...metadados};
  }
  return {escolhida:maisRecente(recentes),motivo:"mais_recente",...metadados};
}

// ---------------------------------------------------------------- trajeto do dia
// porFonte: Map(fonte -> pontos em ordem de tempo {lat,lng,t,velocidade}).
// Devolve o Set das fontes a DESCARTAR no dia (ex.: SRF parado na fabrica
// enquanto T4S e Sat rodam juntos).
function fontesDescartadas(porFonte, pref, ign = new Set()) {
  const fora = new Set([...ign].filter((f) => porFonte.has(f)));
  const fontes = [...porFonte.keys()].filter((f) => !fora.has(f));
  if (pref && !fora.has(pref) && porFonte.has(pref) && porFonte.get(pref).length >= 5) {
    for (const f of fontes) if (f !== pref && discorda(porFonte.get(f), porFonte.get(pref)) > 0.5) fora.add(f);
    return fora;
  }
  if (fontes.length < 2) return fora;
  const taxa = {};
  for (const a of fontes) for (const b of fontes) if (a !== b) taxa[`${a}|${b}`] = discorda(porFonte.get(a), porFonte.get(b));
  const km = (l) => { let s = 0; for (let i = 1; i < l.length; i++) s += distM(l[i - 1], l[i]); return s / 1000; };
  if (fontes.length >= 3) {
    for (const a of fontes) {
      const outras = fontes.filter((b) => b !== a);
      const discordaDeTodas = outras.every((b) => taxa[`${a}|${b}`] != null && taxa[`${a}|${b}`] > 0.5);
      const outrasConcordam = outras.every((b) => outras.every((c) => b === c || taxa[`${b}|${c}`] == null || taxa[`${b}|${c}`] <= 0.2));
      if (discordaDeTodas && outrasConcordam) fora.add(a);
    }
  } else {
    // 2 fontes que discordam: fica a que mostra o carro andando.
    const [a, b] = fontes;
    if (taxa[`${a}|${b}`] != null && taxa[`${a}|${b}`] > 0.5) {
      const ka = km(porFonte.get(a)), kb = km(porFonte.get(b));
      if (ka > 2 && kb < ka / 5) fora.add(b); else if (kb > 2 && ka < kb / 5) fora.add(a);
    }
  }
  return fora;
}

// % das comparacoes (pontos de A x ponto de B mais perto no tempo, ate 1 min)
// em que as duas estao a mais de 1,5 km. null = poucas comparacoes.
function discorda(la, lb) {
  if (!la || !lb || !la.length || !lb.length) return null;
  const passo = Math.max(1, Math.floor(la.length / 150));
  let j = 0, n = 0, ruim = 0;
  for (let i = 0; i < la.length; i += passo) {
    const p = la[i];
    while (j + 1 < lb.length && Math.abs(lb[j + 1].t - p.t) <= Math.abs(lb[j].t - p.t)) j++;
    if (Math.abs(lb[j].t - p.t) > SINCRONIA_MS) continue;
    n++;
    if (distM(p, lb[j]) > DISCORDA_M) ruim++;
  }
  return n >= 8 ? ruim / n : null;
}

module.exports = { preferencias, salvarPreferencia, ignoradas, salvarIgnoradas, escolherAtual, fontesDescartadas, discorda, CHAVE_CFG, CHAVE_IGN, vinculados, salvarVinculo, aparelhoPermitido };
