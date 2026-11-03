// ================================================================
// rastreador.js — posicao dos caminhoes (plataforma SRF / GPSWOX)
// ----------------------------------------------------------------
// A plataforma http://srf.exemplo.com.br (GPSWOX white-label) tem API:
//   POST /api/login {email,password}       -> user_api_hash
//   GET  /api/get_devices?user_api_hash=   -> aparelhos + ultima posicao
//   GET  /api/get_history?device_id=&from_date=&from_time=&to_date=&to_time=
//        -> trajeto do periodo em blocos (1 andando, 2 parado, 3 inicio, 4 fim)
// Credenciais no .env cifrado: SRF_URL, SRF_EMAIL, SRF_SENHA. SO LEITURA:
// nada aqui altera a plataforma. A UNICA escrita e a das cercas
// (back/frota-cercas-srf.js, por apiEnviar), sempre por clique de um ADM.
//
// Os aparelhos sao FIXOS nos caminhoes e o nome comeca pela placa
// ("FKO1015 - ACCELO"). A placa e normalizada para Mercosul dos dois lados
// (FKO1015 = FKF5H15: o 2o digito vira letra, 8 -> I).
//
// Coleta a cada RASTREADOR_INTERVALO_MS (5 s; 0 desliga): atualiza
// rastreador_aparelhos (ultima posicao) e guarda o ponto em
// rastreador_posicoes (RASTREADOR_RETENCAO_DIAS, 60). Sem credencial fica
// dormente — o sistema segue so com os botoes do TMS.
//
// SEGUNDA FONTE — T4S (rastreador-t4s.js, sessao de login assistido em
// T4S_COOKIE): coletada junto, com try/catch proprio (T4S fora ou sessao
// expirada nao derruba o SRF). As tabelas guardam a coluna `fonte`
// ('srf' | 't4s'), e posicoesAtuais() devolve UM item por placa: o de sinal
// mais recente (empate fica com o SRF). Historico (paradasDoDia, lojas,
// completar dias) continua so do SRF.
// ================================================================

const t4s = require("./rastreador-t4s");
// TERCEIRA FONTE — Satfleet (rastreador-satfleet.js, login assistido como o
// T4S). Em 06/10/2026 era a unica com sinal ao vivo do FKC2E12 e dos Scudo
// FKS4U24/TUN1G35. posicoesAtuais() continua: vale o sinal MAIS RECENTE da placa.
const sat = require("./rastreador-satfleet");
// Qual fonte vale por placa (preferencia da tela > maioria quando discordam > mais recente).
const escolha = require("./rastreador-escolha");
const qualidade = require("./gps-precisao");
const ajustes = require("./rastreador-ajustes");
const filtroGps = qualidade.criarFiltro();
const sinaisGps = require('./rastreador-sinais').padrao;

const INTERVALO = Number(process.env.RASTREADOR_INTERVALO_MS ?? 5000);
const RETENCAO_DIAS = Number(process.env.RASTREADOR_RETENCAO_DIAS || 60);
const SEM_SINAL_MIN = Number(process.env.RASTREADOR_SEM_SINAL_MIN || 15);
const PARADO_KMH = 3;

const config = () => ({
  url: String(process.env.SRF_URL || "").replace(/\/+$/, ""),
  email: process.env.SRF_EMAIL || "",
  senha: process.env.SRF_SENHA || "",
});
const configurado = () => { const c = config(); return !!(c.url && c.email && c.senha); };

// ---------------------------------------------------------------- placa
const LETRA_MERCOSUL = "ABCDEFGHIJ";
function placaMercosul(placa) {
  const p = String(placa || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/^[A-Z]{3}\d{4}$/.test(p)) return p.slice(0, 4) + LETRA_MERCOSUL[Number(p[4])] + p.slice(5);
  return p;
}
function placaDoNome(nome) {
  const m = String(nome || "").toUpperCase().match(/[A-Z]{3}-?[0-9][A-Z0-9][0-9]{2}/);
  return m ? placaMercosul(m[0]) : "";
}

// ---------------------------------------------------------------- distancia
function distanciaM(a, b) {
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------------------------------------------------------------- API
let sessao = { hash: null, em: 0 };
async function login(tentou = false) {
  const c = config();
  let r;
  try {
    r = await fetch(`${c.url}/api/login`, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email: c.email, password: c.senha }), signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    if (tentou) throw err; // 2a falha seguida: a plataforma esta fora
    await new Promise((ok) => setTimeout(ok, 3000));
    return login(true);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.user_api_hash) throw new Error(`login na plataforma recusado (HTTP ${r.status})`);
  sessao = { hash: j.user_api_hash, em: Date.now() };
  return sessao.hash;
}
async function api(caminho, params = {}, timeoutMs = 30000, tentou = false) {
  if (!configurado()) throw new Error("rastreador nao configurado (SRF_URL/SRF_EMAIL/SRF_SENHA)");
  const hash = sessao.hash && Date.now() - sessao.em < 6 * 3600 * 1000 ? sessao.hash : await login();
  const q = new URLSearchParams({ user_api_hash: hash, lang: "pt", ...params });
  let r;
  try {
    r = await fetch(`${config().url}/api/${caminho}?${q}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    // A plataforma tem solucos (tempo esgotado/rede): 1 nova tentativa apos 3 s.
    if (tentou) throw err;
    await new Promise((ok) => setTimeout(ok, 3000));
    return api(caminho, params, timeoutMs, true);
  }
  if ((r.status === 401 || r.status === 403) && !tentou) { sessao.hash = null; return api(caminho, params, timeoutMs, true); }
  if (!r.ok) throw new Error(`${caminho}: HTTP ${r.status}`);
  return r.json();
}

// POST com corpo JSON (cercas: add_geofence, edit_geofence, destroy_geofence).
// SEM nova tentativa em erro de rede: repetir um "criar" poderia duplicar a
// cerca. So refaz quando a sessao expirou (a plataforma recusou e nao gravou).
async function apiEnviar(caminho, corpo = {}, timeoutMs = 30000, tentou = false) {
  if (!configurado()) throw new Error("rastreador nao configurado (SRF_URL/SRF_EMAIL/SRF_SENHA)");
  const hash = sessao.hash && Date.now() - sessao.em < 6 * 3600 * 1000 ? sessao.hash : await login();
  const q = new URLSearchParams({ user_api_hash: hash, lang: "pt" });
  const r = await fetch(`${config().url}/api/${caminho}?${q}`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(corpo), signal: AbortSignal.timeout(timeoutMs),
  });
  if ((r.status === 401 || r.status === 403) && !tentou) { sessao.hash = null; return apiEnviar(caminho, corpo, timeoutMs, true); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status === 0) {
    const erros = j.errors ? Object.values(j.errors).flat().join(" ") : "";
    throw new Error(`${caminho}: ${erros || j.message || `HTTP ${r.status}`}`);
  }
  return j;
}

async function listarAparelhos(timeoutMs = 30000) {
  const grupos = await api("get_devices", {}, timeoutMs);
  return (Array.isArray(grupos) ? grupos : []).flatMap((g) => g.items || []).map((d) => ({
    device_id: Number(d.id),
    nome: String(d.name || ""),
    placa: placaDoNome(d.name) || placaMercosul(d.device_data && d.device_data.plate_number),
    lat: Number(d.lat), lng: Number(d.lng),
    velocidade: Number(d.speed) || 0,
    rumo: Number(d.course) || 0,
    posicao_em: d.timestamp ? new Date(Number(d.timestamp) * 1000) : null,
    online: String(d.online || ""),
    motor: d.engine_status === true ? "ligado" : d.engine_status === false ? "desligado" : null,
    parado_seg: Number(d.stop_duration_sec) || 0,
  }));
}

// "dd-mm-aaaa hh:mm:ss" ou "aaaa-mm-dd hh:mm:ss" (hora local da plataforma) -> minutos do dia + data
function lerHora(txt) {
  const s = String(txt || "");
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (m) return { data: `${m[1]}-${m[2]}-${m[3]}`, min: Number(m[4]) * 60 + Number(m[5]) };
  m = s.match(/^(\d{2})-(\d{2})-(\d{4})[ T](\d{2}):(\d{2})/);
  if (m) return { data: `${m[3]}-${m[2]}-${m[1]}`, min: Number(m[4]) * 60 + Number(m[5]) };
  return null;
}

// Paradas de um aparelho num dia: [{ini, fim (min do dia), lat, lng, dur_min}]
async function paradasDoDia(deviceId, dataISO) {
  const j = await api("get_history", {
    device_id: deviceId, from_date: dataISO, from_time: "00:00", to_date: dataISO, to_time: "23:59", snap_to_road: "false",
  }, 90000);
  const paradas = [];
  for (const bloco of j.items || []) {
    const pts = (bloco.items || []).filter((p) => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)));
    if (!pts.length) continue;
    const vel = pts.map((p) => Number(p.speed) || 0).sort((a, b) => a - b);
    // 3 e 4 sao MARCADORES do periodo pedido (inicio 00:00 / fim 23:59), nao
    // paradas: contados como parada viravam "voltou 23:58" e "saiu 00:01".
    const st = Number(bloco.status);
    if (st === 3 || st === 4) continue;
    const parado = st === 2 || (st !== 1 && vel[Math.floor(vel.length / 2)] < PARADO_KMH);
    if (!parado) continue;
    const ini = lerHora(pts[0].raw_time || pts[0].time), fim = lerHora(pts[pts.length - 1].raw_time || pts[pts.length - 1].time);
    if (!ini || !fim) continue;
    const lat = pts.reduce((s, p) => s + Number(p.lat), 0) / pts.length;
    const lng = pts.reduce((s, p) => s + Number(p.lng), 0) / pts.length;
    paradas.push({ ini: ini.min, fim: fim.data === ini.data ? fim.min : 1440, lat, lng, dur_min: Math.max(0, (fim.data === ini.data ? fim.min : 1440) - ini.min) });
  }
  return paradas;
}

// ---------------------------------------------------------------- banco
async function garantirTabelas(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS rastreador_aparelhos (
      fonte TEXT NOT NULL DEFAULT 'srf',
      device_id INTEGER NOT NULL,
      nome TEXT, placa TEXT,
      lat DOUBLE PRECISION, lng DOUBLE PRECISION, velocidade NUMERIC(6,1), rumo INTEGER,
      posicao_em TIMESTAMPTZ, online TEXT, motor TEXT, parado_seg INTEGER,
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (fonte, device_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rastreador_aparelhos_placa ON rastreador_aparelhos (placa);
    CREATE TABLE IF NOT EXISTS rastreador_posicoes (
      id BIGSERIAL PRIMARY KEY,
      fonte TEXT NOT NULL DEFAULT 'srf',
      device_id INTEGER NOT NULL, placa TEXT,
      lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL,
      velocidade NUMERIC(6,1), rumo INTEGER, motor TEXT,
      posicao_em TIMESTAMPTZ NOT NULL,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Migracao das tabelas criadas antes da 2a fonte (so device_id na chave).
    -- Idempotente: roda em todo boot e so mexe no que ainda esta no formato velho.
    ALTER TABLE rastreador_aparelhos ADD COLUMN IF NOT EXISTS fonte TEXT NOT NULL DEFAULT 'srf';
    ALTER TABLE rastreador_posicoes ADD COLUMN IF NOT EXISTS fonte TEXT NOT NULL DEFAULT 'srf';
    DO $$
    DECLARE pk RECORD;
    BEGIN
      SELECT c.conname, array_length(c.conkey, 1) AS n INTO pk
        FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = 'rastreador_aparelhos' AND c.contype = 'p';
      IF pk.conname IS NOT NULL AND pk.n = 1 THEN
        EXECUTE format('ALTER TABLE rastreador_aparelhos DROP CONSTRAINT %I', pk.conname);
        ALTER TABLE rastreador_aparelhos ADD PRIMARY KEY (fonte, device_id);
      END IF;
    END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rastreador_posicoes_fonte_ponto ON rastreador_posicoes (fonte, device_id, posicao_em);
    DROP INDEX IF EXISTS idx_rastreador_posicoes_ponto;
    CREATE INDEX IF NOT EXISTS idx_rastreador_posicoes_placa ON rastreador_posicoes (placa, posicao_em);
    -- Onde cada loja (e a fabrica) fica de verdade: aprendido das paradas do
    -- rastreador cruzadas com os registros de entrega (rastreador-lojas.js).
    -- origem 'manual' nunca e sobrescrita pelo aprendizado.
    CREATE TABLE IF NOT EXISTS loja_coordenadas (
      codigo TEXT PRIMARY KEY,
      nome TEXT,
      lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL,
      amostras INTEGER NOT NULL DEFAULT 0,
      dispersao_m INTEGER,
      origem TEXT NOT NULL DEFAULT 'rastreador',
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

const estado = {
  ultima_coleta: null, erro: null, aparelhos: 0, falhas_seguidas: 0, // SRF
  t4s: { configurado: false, ultima_coleta: null, erro: null, sessao_expirada: false, aparelhos: 0 },
  sat: { configurado: false, ultima_coleta: null, erro: null, sessao_expirada: false, aparelhos: 0 },
};

async function gravarAparelhos(db, fonte, lista, {sinais=sinaisGps}={}) {
  const validas=lista.filter(a=>filtroGps.avaliar({...a,fonte},
    {maxIdadeMs:24*3600000,confirmar:false}).ok);
  // Grava o lote completo no disco e no historico antes de atualizar os
  // aparelhos. Uma falha no banco conserva o arquivo para o proximo ciclo.
  await sinais.guardar(db,validas.map(a=>({...a,fonte})));
  for (const a of validas) {
    await db.query(`
      INSERT INTO rastreador_aparelhos (fonte, device_id, nome, placa, lat, lng, velocidade, rumo, posicao_em, online, motor, parado_seg, atualizado_em)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
      ON CONFLICT (fonte, device_id) DO UPDATE SET nome=$3, placa=$4, lat=$5, lng=$6, velocidade=$7, rumo=$8, posicao_em=$9,
             online=$10, motor=$11, parado_seg=$12, atualizado_em=NOW()
      WHERE rastreador_aparelhos.posicao_em IS NULL OR EXCLUDED.posicao_em >= rastreador_aparelhos.posicao_em`,
      [fonte, a.device_id, a.nome, a.placa, a.lat, a.lng, a.velocidade, a.rumo, a.posicao_em, a.online, a.motor, a.parado_seg]);
    // So confirma depois da persistencia: uma falha no banco precisa permitir
    // repetir a mesma leitura no proximo ciclo, sem perde-la como duplicada.
    filtroGps.confirmar({...a, fonte});
  }
}

// T4S: try/catch proprio — fora do ar ou sessao expirada nao afeta o SRF.
async function coletarT4s(db) {
  estado.t4s.configurado = t4s.configurado();
  estado.t4s.modo = t4s.modoConexao();
  if (!estado.t4s.configurado) return;
  try {
    const lista = await t4s.listarAparelhos(15000);
    await gravarAparelhos(db, "t4s", lista);
    estado.t4s.ultima_coleta = new Date(); estado.t4s.erro = null; estado.t4s.sessao_expirada = false;
    estado.t4s.aparelhos = lista.length;
  } catch (err) {
    if (!estado.t4s.erro) console.error(`[rastreador] ${new Date().toLocaleString("pt-BR")} T4S falhou:`, err.message);
    estado.t4s.erro = err.message;
    estado.t4s.sessao_expirada = !!err.sessaoExpirada;
  }
}

// Sat: try/catch proprio — fora do ar ou sessao expirada nao afeta as outras.
async function coletarSat(db) {
  estado.sat.configurado = sat.configurado();
  if (!estado.sat.configurado) return;
  try {
    const lista = await sat.listarAparelhos(15000);
    await gravarAparelhos(db, "sat", lista);
    estado.sat.ultima_coleta = new Date(); estado.sat.erro = null; estado.sat.sessao_expirada = false;
    estado.sat.aparelhos = lista.length;
  } catch (err) {
    if (!estado.sat.erro) console.error(`[rastreador] ${new Date().toLocaleString("pt-BR")} Sat falhou:`, err.message);
    estado.sat.erro = err.message;
    estado.sat.sessao_expirada = !!err.sessaoExpirada;
  }
}

// Resposta lenta de uma plataforma não bloqueia a coleta das outras.
// Cada fonte compartilha sua consulta em andamento, sem criar fila de pedidos.
const coletas=require('./rastreador-coleta').criarColetaFontes();
async function coletar(db) {
  await sinaisGps.drenar(db).catch(e=>console.error('[rastreador] sinais pendentes:',e.message));
  const srf=configurado()?coletas.executar('srf',async()=>{
    try {
      const lista=await listarAparelhos(12000);
      await gravarAparelhos(db,'srf',lista);
      if(estado.falhas_seguidas)console.log(`[rastreador] coleta voltou depois de ${estado.falhas_seguidas} falha(s)`);
      estado.ultima_coleta=new Date();estado.erro=null;estado.aparelhos=lista.length;estado.falhas_seguidas=0;
    } catch(err) {
      estado.erro=err.message;estado.falhas_seguidas++;
      console.error(`[rastreador] ${new Date().toLocaleString('pt-BR')} coleta falhou (${estado.falhas_seguidas}a seguida):`,err.message);
    }
  }):Promise.resolve();
  await Promise.all([srf,coletas.executar('t4s',()=>coletarT4s(db)),coletas.executar('sat',()=>coletarSat(db))]);
}

// ---------------------------------------------------------------- leitura
let _coords = null;
async function coordenadas(db) {
  if (_coords && Date.now() - _coords.em < 10 * 60 * 1000) return _coords.mapa;
  const r = await db.query("SELECT c.codigo,c.nome,c.lat,c.lng,c.amostras,c.dispersao_m,c.origem,p.tipo_ponto,(p.codigo IS NOT NULL) AS loja_cadastrada FROM loja_coordenadas c LEFT JOIN lojas_pes p ON p.codigo=c.codigo");
  const areas = await ajustes.lerAreas(db);
  const locais = r.rows.map(x => ({...x,lat:Number(x.lat),lng:Number(x.lng),...qualidade.perfilPonto(x.tipo_ponto),...(areas[x.codigo] || {})}));
  const mapa = new Map(qualidade.ajustarAreasProximas(locais).map(l => [l.codigo,l]));
  _coords = { em: Date.now(), mapa };
  return mapa;
}
const esquecerCoordenadas = () => { _coords = null; };

// Lugar conhecido mais perto (loja ou fabrica), ate 1,5 km.
function pertoDe(pos, coords) {
  const perto = [...coords.values()].map(l => ({l, d: distanciaM(pos,l)}))
    .filter(x => Number.isFinite(x.d) && x.d <= 1500).sort((a,b) => a.d-b.d);
  if (!perto.length) return null;
  const dentro = perto.filter(x => qualidade.dentroLugar(pos,x.l));
  const grupo = dentro.length ? dentro : [perto[0]];
  return {codigo:grupo[0].l.codigo,nome:grupo.map(x=>x.l.nome || x.l.codigo).join(' / '),
    m:Math.round(grupo[0].d),dentro:dentro.length>0,
    ...(dentro.length>1 ? {ambigua:grupo.map(x=>x.l.codigo),confirmacao_necessaria:true} : {})};
}

function situacao(a, agora = Date.now()) {
  const idadeMin = a.posicao_em ? Math.round((agora - new Date(a.posicao_em).getTime()) / 60000) : null;
  const semSinal = idadeMin == null || idadeMin > SEM_SINAL_MIN;
  const vel = Number(a.velocidade) || 0;
  return {
    estado: semSinal ? "sem_sinal" : vel >= PARADO_KMH ? "movendo" : "parado",
    idade_min: idadeMin,
    parado_min: !semSinal && vel < PARADO_KMH ? Math.round((Number(a.parado_seg) || 0) / 60) : null,
  };
}

async function posicoesAtuais(db) {
  const [r, coords, prefs] = await Promise.all([
    db.query("SELECT * FROM rastreador_aparelhos ORDER BY placa"),
    coordenadas(db).catch(() => new Map()),
    escolha.preferencias(db),
  ]);
  // Um item por placa (rastreador-escolha.js): fonte preferida na tela; se as
  // fontes discordam de lugar, a maioria (em 06/10 o SRF do FKC2E12 estava
  // parado na fabrica e T4S/Sat em Buzios); senao o sinal mais recente.
  const grupos = new Map();
  for (const a of r.rows) {
    const chave = a.placa || `${a.fonte}:${a.device_id}`;
    (grupos.get(chave) || grupos.set(chave, []).get(chave)).push(a);
  }
  const porPlaca = new Map();
  for (const [chave, cands] of grupos) {
    const e = escolha.escolherAtual(cands, prefs[chave], Date.now(), escolha.ignoradas(chave), escolha.vinculados(chave));
    if (!e.escolhida) continue;
    porPlaca.set(chave, { ...e.escolhida, _motivo:e.motivo, _discordantes:e.discordantes || null,
      _confiavel:e.confiavel_eventos !== false && !qualidade.motivoInvalido(e.escolhida,{maxIdadeMs:qualidade.RECENTE_MS}),
      _defasadas:e.defasadas || [], _rejeitadas:e.rejeitadas || [] });
  }
  return [...porPlaca.values()].map((a) => {
    const pos = { lat: Number(a.lat), lng: Number(a.lng) };
    return {
      device_id: a.device_id, nome: a.nome, placa: a.placa, lat: pos.lat, lng: pos.lng,
      velocidade: Number(a.velocidade) || 0, rumo: a.rumo, motor: a.motor,
      posicao_em: a.posicao_em, ...situacao(a),
      perto_de: Number.isFinite(pos.lat) ? pertoDe(pos, coords) : null,
      fonte: a.fonte || "srf",
      fonte_motivo: a._motivo, fontes_discordantes: a._discordantes, confiavel_eventos:a._confiavel, fontes_defasadas:a._defasadas, fontes_rejeitadas:a._rejeitadas,
    };
  });
}

// Pendura a posicao em cada viagem (pela placa) — usado pelo GET /tms/viagens.
async function anexarEmViagens(db, viagens) {
  if (!viagens.length) return;
  const lista = await posicoesAtuais(db);
  const porPlaca = new Map(lista.map((a) => [a.placa, a]));
  for (const v of viagens) {
    const a = porPlaca.get(placaMercosul(v.placa));
    if (a) v.rastreador = a;
  }
}

// ---------------------------------------------------------------- rotas
function criarRotas({ db }) {
  const posicoes = async (req, res) => {
    try {
      const algum = configurado() || t4s.configurado() || sat.configurado();
      res.json({
        configurado: algum, intervalo_s: Math.round(INTERVALO / 1000),
        ultima_coleta: estado.ultima_coleta, erro: estado.erro, falhas_seguidas: estado.falhas_seguidas,
        t4s: { ...estado.t4s, configurado: t4s.configurado(), modo: t4s.modoConexao() },
        sat: { ...estado.sat, configurado: sat.configurado() },
        aparelhos: algum ? await posicoesAtuais(db) : [],
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  };
  const lojas = async (req, res) => {
    try {
      const r = await db.query("SELECT * FROM loja_coordenadas ORDER BY codigo");
      res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  };
  return { posicoes, lojas };
}

// ---------------------------------------------------------------- ciclo
let timer = null, limpezaEm = 0;
function iniciar({ db }) {
  require('./rastreador-nuvem').iniciar({db,rastreador:module.exports});
  sinaisGps.drenar(db).catch(e=>console.error('[rastreador] recuperacao dos sinais:',e.message));
  if (!configurado() && !t4s.configurado() && !sat.configurado()) { console.log("[rastreador] sem SRF_URL/SRF_EMAIL/SRF_SENHA nem T4S_COOKIE no .env — dormente"); return; }
  if (!configurado()) console.log("[rastreador] SRF sem credencial — coletando so o T4S");
  if (t4s.configurado()) console.log("[rastreador] T4S configurado — 2a fonte de posicao");
  if (sat.configurado()) console.log("[rastreador] Sat configurada — 3a fonte de posicao");
  if (!INTERVALO) { console.log("[rastreador] RASTREADOR_INTERVALO_MS=0 — coleta desligada"); return; }
  const rodar = async () => {
    await coletar(db);
    if (Date.now() - limpezaEm > 24 * 3600 * 1000) {
      limpezaEm = Date.now();
      db.query(`DELETE FROM rastreador_posicoes WHERE posicao_em < NOW() - ($1 || ' days')::interval`, [String(RETENCAO_DIAS)])
        .catch((e) => console.error("[rastreador] limpeza:", e.message));
    }
  };
  setTimeout(rodar, 5000);
  if (timer) clearInterval(timer);
  timer = setInterval(rodar, INTERVALO);
  console.log(`[rastreador] coleta ativa a cada ${Math.round(INTERVALO / 1000)}s`);
}

module.exports = {
  garantirTabelas, iniciar, criarRotas, coletar, gravarAparelhos, listarAparelhos, paradasDoDia, posicoesAtuais,
  anexarEmViagens, coordenadas, esquecerCoordenadas, pertoDe, placaMercosul, placaDoNome, distanciaM,
  lerHora, configurado, estado, srfApi: api, srfEnviar: apiEnviar, intervaloColetaMs: () => INTERVALO, diagnosticoGps: () => filtroGps.diagnostico(),
};
