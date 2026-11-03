// ================================================================
// frota-rotas.js — caminho PELA RUA entre dois sinais do rastreador.
// ----------------------------------------------------------------
// Entre dois sinais o rastro era uma reta: com sinal espacado (T4S de 15 em
// 15 min) o tracejado cortava quarteiroes, morro e mar ("muito fora da
// pista"). Aqui cada par de sinais distantes vira o trajeto de carro pelas
// ruas, calculado no OSRM (roteador do OpenStreetMap).
//   - Vai so o par de coordenadas (sem placa, sem nome).
//   - 1 consulta por segundo no maximo (regra do servidor publico), numa fila
//     em segundo plano: o painel nunca espera; ate o caminho chegar, o trecho
//     fica reto e no proximo refresh ja aparece pela rua.
//   - Cada trecho calculado fica guardado (tabela frota_rotas_cache) e nao
//     e perguntado de novo.
//   - Caminho muito mais longo que a reta (rua errada, GPS fora da via) e
//     descartado na hora de usar: fica a reta.
// Desligar: FROTA_ROTEAR=0. Outro servidor OSRM: FROTA_OSRM_URL.
// ================================================================
const OSRM = (process.env.FROTA_OSRM_URL || "https://router.project-osrm.org").replace(/\/+$/, "");
const ATIVO = process.env.FROTA_ROTEAR !== "0";
const MIN_M = 250;      // reta menor que isso nao precisa de rua
const MAX_M = 120000;   // nem rotear absurdos
const INTERVALO_MS = 1100;
const SIMPLIFICA_M = 8;
const FILA_MAX = 3000;

const cache = new Map(); // chave -> { pts: [[lat,lng],...], m } | { reta: true }
const fila = [];
const naFila = new Set();
const falhas = new Map();
let db = null, carregado = null, rodando = false, pausaAte = 0;

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const chave = (a, b) => `${r4(a.lat)},${r4(a.lng)}>${r4(b.lat)},${r4(b.lng)}`;

function distM(a, b) {
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Douglas-Peucker em [lat,lng] (a geometria do OSRM vem com ponto a cada poucos metros).
function simplificar(pts, tol) {
  if (pts.length <= 2) return pts;
  const k = Math.cos((pts[0][0] * Math.PI) / 180) * 111320;
  const xy = pts.map((p) => [p[1] * k, p[0] * 110540]);
  const manter = new Uint8Array(pts.length);
  manter[0] = manter[pts.length - 1] = 1;
  const pilha = [[0, pts.length - 1]];
  while (pilha.length) {
    const [i, j] = pilha.pop();
    const [x1, y1] = xy[i], [x2, y2] = xy[j];
    const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
    let maior = -1, idx = -1;
    for (let m = i + 1; m < j; m++) {
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((xy[m][0] - x1) * dx + (xy[m][1] - y1) * dy) / len2));
      const d = Math.hypot(xy[m][0] - (x1 + t * dx), xy[m][1] - (y1 + t * dy));
      if (d > maior) { maior = d; idx = m; }
    }
    if (maior > tol) { manter[idx] = 1; pilha.push([i, idx], [idx, j]); }
  }
  return pts.filter((_, m) => manter[m]);
}

async function iniciar(conexao) {
  if (!ATIVO) return;
  db = conexao;
  if (!carregado) {
    carregado = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS frota_rotas_cache (
          chave TEXT PRIMARY KEY,
          pontos JSONB,
          metros INTEGER,
          reta BOOLEAN NOT NULL DEFAULT FALSE,
          criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      const r = await db.query("SELECT chave, pontos, metros, reta FROM frota_rotas_cache");
      for (const x of r.rows) cache.set(x.chave, x.reta ? { reta: true } : { pts: x.pontos, m: x.metros });
    })().catch((err) => { carregado = null; console.warn("[frota-rotas] cache:", err.message); });
  }
  return carregado;
}

async function consultar(k, a, b) {
  const url = `${OSRM}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`;
  const r = await fetch(url, { headers: { "User-Agent": "ControleDeEntrega-Frota/1.0" }, signal: AbortSignal.timeout(10000) });
  if (r.status === 429) { pausaAte = Date.now() + 60000; throw new Error("limite do OSRM (429)"); }
  if (!r.ok) throw new Error(`OSRM HTTP ${r.status}`);
  const j = await r.json();
  const rota = j.code === "Ok" && j.routes && j.routes[0];
  const valor = rota
    ? { pts: simplificar(rota.geometry.coordinates.map(([lng, lat]) => [Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5]), SIMPLIFICA_M), m: Math.round(rota.distance) }
    : { reta: true }; // sem rota (ponto no mar, fora da malha): fica a reta para sempre
  cache.set(k, valor);
  await db.query(
    "INSERT INTO frota_rotas_cache (chave, pontos, metros, reta) VALUES ($1, $2, $3, $4) ON CONFLICT (chave) DO NOTHING",
    [k, valor.pts ? JSON.stringify(valor.pts) : null, valor.m || null, !!valor.reta]);
}

// Cadencia unica de 1 consulta/s (fila de fundo + consulta direta da
// calculadora de rota): cada chamada reserva a proxima "vez".
let proximaVez = 0;
async function esperarVez() {
  const agora = Date.now();
  const t = Math.max(agora, proximaVez, pausaAte);
  proximaVez = t + INTERVALO_MS;
  if (t > agora) await new Promise((ok) => setTimeout(ok, t - agora));
}

// Consulta DIRETA (calculadora de rota, por clique): mesma cadencia, sem
// esperar a fila de fundo andar. caminho = "/route/v1/driving/..." ou "/trip/...".
async function osrm(caminho, timeoutMs = 20000) {
  if (!ATIVO) throw new Error("roteador desligado (FROTA_ROTEAR=0)");
  await esperarVez();
  const r = await fetch(`${OSRM}${caminho}`, { headers: { "User-Agent": "ControleDeEntrega-Frota/1.0" }, signal: AbortSignal.timeout(timeoutMs) });
  if (r.status === 429) { pausaAte = Date.now() + 60000; throw new Error("o roteador (OSRM) pediu uma pausa — tente de novo em 1 minuto"); }
  const j = await r.json().catch(() => null);
  if (!j) throw new Error(`roteador (OSRM) respondeu HTTP ${r.status}`);
  return j;
}

async function processarFila() {
  if (rodando) return;
  rodando = true;
  try {
    while (fila.length) {
      const { k, a, b, fn } = fila.shift();
      naFila.delete(k);
      if (!fn && cache.has(k)) continue;
      await esperarVez();
      try { await (fn || consultar)(k, a, b); }
      catch (err) {
        const n = (falhas.get(k) || 0) + 1;
        falhas.set(k, n);
        if (n === 1) console.warn("[frota-rotas]", err.message);
        if (n >= 3) cache.set(k, { reta: true }); // desiste so nesta execucao (nao grava)
      }
    }
  } finally { rodando = false; }
}

// Caminho pela rua de a ate b ([[lat,lng],...], sem as pontas) ou null (reta).
// lig 1 (sinal espacado) aceita desvio maior que lig 0 (sinal de minuto em minuto).
function caminho(a, b, lig) {
  if (!ATIVO || !db) return null;
  const reta = distM(a, b);
  if (reta < MIN_M || reta > MAX_M) return null;
  const k = chave(a, b);
  const c = cache.get(k);
  if (!c) {
    if (!naFila.has(k) && fila.length < FILA_MAX) { naFila.add(k); fila.push({ k, a, b }); setImmediate(processarFila); }
    return null;
  }
  if (c.reta || !c.pts || c.pts.length < 2) return null;
  const limite = lig === 1 ? Math.max(2 * reta, reta + 1500) : Math.max(1.5 * reta, reta + 500);
  if (c.m > limite) return null; // volta grande demais: provavelmente rua errada
  return c.pts;
}

// ---------------------------------------------------------------- tempo de viagem
// "Volta prevista para a fabrica": duracao de carro de a ate b pelo OSRM. So
// em memoria (a posicao muda a cada minuto), ~110 m de arredondamento e 10 min
// de validade; entra na mesma fila de 1 consulta/s.
const tempos = new Map(); // chave -> { em, s, m } | { em, falhou: true }
const r3 = (x) => Math.round(x * 1e3) / 1e3;
async function consultarTempo(k, a, b) {
  const url = `${OSRM}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`;
  const r = await fetch(url, { headers: { "User-Agent": "ControleDeEntrega-Frota/1.0" }, signal: AbortSignal.timeout(10000) });
  if (r.status === 429) { pausaAte = Date.now() + 60000; throw new Error("limite do OSRM (429)"); }
  if (!r.ok) throw new Error(`OSRM HTTP ${r.status}`);
  const j = await r.json();
  const rota = j.code === "Ok" && j.routes && j.routes[0];
  tempos.set(k, rota ? { em: Date.now(), s: Math.round(rota.duration), m: Math.round(rota.distance) } : { em: Date.now(), falhou: true });
}
function tempoAte(a, b) {
  if (!ATIVO) return null;
  // Origem arredondada em ~1 km: carro rodando muda de posicao a cada minuto e
  // a resposta (fila de 1/s) chegaria sempre atrasada; 1 km muda pouco o tempo.
  const r2 = (x) => Math.round(x * 100) / 100;
  const k = `t:${r2(a.lat)},${r2(a.lng)}>${r3(b.lat)},${r3(b.lng)}`;
  const c = tempos.get(k);
  if (c && Date.now() - c.em < 10 * 60000) return c.falhou ? null : c;
  if (!naFila.has(k) && fila.length < FILA_MAX) {
    naFila.add(k);
    fila.push({ k, a, b, fn: consultarTempo });
    setImmediate(processarFila);
  }
  if (tempos.size > 500) for (const [kk, v] of tempos) if (Date.now() - v.em > 10 * 60000) tempos.delete(kk);
  return c && !c.falhou ? c : null; // valor velho ainda serve enquanto recalcula
}

const estado = () => ({ ativo: ATIVO, servidor: OSRM, em_cache: cache.size, na_fila: fila.length });

// Percurso de referência entre pontos fixos da programação. Sem ligação ao GPS atual.
function planejado(a,b) {
  if(!ATIVO || !db)return null;
  const k=chave(a,b),c=cache.get(k);
  if(c)return !c.reta && c.pts?.length>=2?c.pts:null;
  if(!naFila.has(k) && fila.length<FILA_MAX){naFila.add(k);fila.push({k,a,b});setImmediate(processarFila);}
  return null;
}
module.exports = { iniciar, caminho, tempoAte, planejado, estado, distM, osrm, simplificar };
