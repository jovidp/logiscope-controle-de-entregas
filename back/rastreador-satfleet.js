// ================================================================
// rastreador-satfleet.js — posicao dos veiculos pela plataforma Satfleet
// (SatCompany), 3a fonte do rastreador (SRF + T4S + Sat).
// ----------------------------------------------------------------
// https://satfleet.satcompany.app (Rails/Devise). Sem API publica e com
// reCAPTCHA no login: a sessao e criada por uma PESSOA (login assistido, como
// o T4S) e o servidor reaproveita o cookie enquanto ele valer.
//   GET /vehicles/index_with_state -> JSON com TODOS os veiculos e o ultimo
//   estado de cada um (lat/lng, velocidade, ignicao, rumo, endereco, horario).
// Uma chamada por coleta. SO LEITURA: nada aqui altera a Satfleet.
//
// Por que existe: em 06/10/2026 a Sat tinha sinal AO VIVO nos Scudo
// FKS4U24/TUN1G35 (que so tinham T4S, com o login vencido) e em veiculos que
// nao estao no SRF nem no T4S (6 onibus de rota, Onix, Ranger, Siena).
//
// Sessao: cookie "remember_user_token=...; _session_id=..." (o "lembrar de
// mim" do Devise dura semanas). Vem do .env cifrado (SAT_COOKIE) ou do botao
// "Reconectar Sat" (POST /tms/rastreador/sat-reconectar), e fica guardado em
// sistema_config cifrado; renovacao no Set-Cookie e absorvida sozinha.
// Saida no formato do GPSWOX (rastreador.js) com fonte 'sat'.
// ================================================================
const crypto = require("crypto");

const CHAVE_CFG = "sat_sessao";
const COOKIES_SESSAO = ["remember_user_token", "_session_id"];
let sessao = null; // { cookie, origem, atualizado_em }
let banco = null;

const cookieEnv = () => String(process.env.SAT_COOKIE || "").trim();
const hashEnv = () => crypto.createHash("sha256").update(cookieEnv()).digest("hex").slice(0, 16);
const chaveCifra = () => crypto.createHash("sha256")
  .update(`sat-sessao|${process.env.DB_PASSWORD || ""}|${process.env.SRF_SENHA || ""}`).digest();

function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", chaveCifra(), iv);
  const corpo = Buffer.concat([c.update(texto, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), corpo]).toString("base64");
}
function decifrar(b64) {
  const b = Buffer.from(String(b64), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", chaveCifra(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

const config = () => ({
  url: String(process.env.SAT_URL || "https://satfleet.satcompany.app").replace(/\/+$/, ""),
  cookie: (sessao && sessao.cookie) || cookieEnv(),
});
const configurado = () => !!config().cookie;

// Chamar no boot, ANTES do rastreador.iniciar().
async function carregarSessao(db) {
  banco = db;
  try {
    const r = await db.query("SELECT valor FROM sistema_config WHERE chave = $1", [CHAVE_CFG]);
    const v = r.rows[0] && r.rows[0].valor;
    if (v && v.cookie && v.env === hashEnv()) {
      sessao = { cookie: decifrar(v.cookie), origem: v.origem, atualizado_em: v.atualizado_em };
      console.log(`[sat] sessao salva carregada (${v.origem || "?"}, ${v.atualizado_em || "?"})`);
    }
  } catch (err) {
    console.error("[sat] nao leu a sessao salva — seguindo com o .env:", err.message);
  }
}

async function salvarSessao(cookie, origem) {
  sessao = { cookie, origem, atualizado_em: new Date().toISOString() };
  if (!banco) return;
  await banco.query(`
    INSERT INTO sistema_config (chave, valor, atualizado_em) VALUES ($1, $2, NOW())
    ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = NOW()`,
  [CHAVE_CFG, JSON.stringify({ cookie: cifrar(cookie), env: hashEnv(), origem, atualizado_em: sessao.atualizado_em })]);
}

function lerCookies(texto) {
  const mapa = new Map();
  String(texto || "").split(/;\s*/).forEach((par) => {
    const i = par.indexOf("=");
    if (i > 0) mapa.set(par.slice(0, i).trim(), par.slice(i + 1).trim());
  });
  return mapa;
}
const montarCookie = (mapa) => COOKIES_SESSAO.filter((k) => mapa.get(k)).map((k) => `${k}=${mapa.get(k)}`).join("; ");

// Set-Cookie com _session_id/remember_user_token novo = renovacao: passa a usar e guarda.
function absorverRenovacao(resposta, cookieUsado) {
  const lista = typeof resposta.headers.getSetCookie === "function" ? resposta.headers.getSetCookie() : [];
  if (!lista.length) return;
  const mapa = lerCookies(cookieUsado);
  let mudou = false;
  lista.forEach((sc) => {
    const [par] = sc.split(";");
    const i = par.indexOf("=");
    const nome = par.slice(0, i).trim();
    const valor = par.slice(i + 1).trim();
    if (!COOKIES_SESSAO.includes(nome) || !valor) return;
    const exp = /expires=([^;]+)/i.exec(sc);
    if (exp && new Date(exp[1]).getTime() < Date.now()) return;
    if (mapa.get(nome) !== valor) { mapa.set(nome, valor); mudou = true; }
  });
  if (!mudou) return;
  salvarSessao(montarCookie(mapa), "renovado pela Sat")
    .catch((err) => console.error("[sat] renovou mas nao gravou:", err.message));
}

// Mesma regra do rastreador.js (FKO1015 -> FKF5H15); copiada para nao criar
// dependencia circular.
const LETRA_MERCOSUL = "ABCDEFGHIJ";
function placaMercosul(placa) {
  const p = String(placa || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/^[A-Z]{3}\d{4}$/.test(p)) return p.slice(0, 4) + LETRA_MERCOSUL[Number(p[4])] + p.slice(5);
  return p;
}

function erroSessao(msg) {
  const e = new Error(msg);
  e.sessaoExpirada = true;
  return e;
}

// Um item do JSON -> aparelho no formato GPSWOX.
function lerVeiculo(v) {
  const e = v && v.last_state;
  if (!e) return null;
  const lat = Number(e.latitude), lng = Number(e.longitude);
  const quando = e.timestamp ? new Date(e.timestamp) : null;
  return {
    device_id: Number(v.id),
    nome: `${v.registration_plate || ""} - ${v.description || ""}`.trim(),
    placa: placaMercosul(v.registration_plate),
    lat, lng,
    velocidade: Number(e.speed) || 0,
    rumo: Number(e.heading) || 0,
    posicao_em: quando && !Number.isNaN(quando.getTime()) ? quando : null,
    online: e.gprs_active ? "online" : "",
    motor: e.ignition === true ? "ligado" : e.ignition === false ? "desligado" : null,
    parado_seg: 0,
    fonte: "sat",
    endereco: e.address || "",
  };
}

// O servidor da Sat as vezes demora a aceitar a conexao (em 06/10: 2 de 3
// tentativas com UND_ERR_CONNECT_TIMEOUT, a 3a respondeu em 1 s). Falha de
// REDE tenta de novo ate 3x; sessao vencida nao (nao adianta).
async function listarAparelhos(timeoutMs = 15000, cookieTeste = null) {
  let ultimo;
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try { return await listarUmaVez(timeoutMs, cookieTeste); }
    catch (err) {
      ultimo = err;
      if (err.sessaoExpirada || !/fetch failed|timeout|ECONN|UND_ERR/i.test(`${err.message} ${err.cause && err.cause.code}`)) throw err;
      await new Promise((ok) => setTimeout(ok, 800 * tentativa));
    }
  }
  throw ultimo;
}

// cookieTeste: experimenta um cookie SEM adota-lo (o Reconectar testa antes).
async function listarUmaVez(timeoutMs, cookieTeste) {
  const c = config();
  const cookie = cookieTeste || c.cookie;
  if (!cookie) throw new Error("Sat nao configurada (SAT_COOKIE)");
  const r = await fetch(`${c.url}/vehicles/index_with_state`, {
    redirect: "manual",
    headers: {
      Cookie: cookie,
      Accept: "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${c.url}/mobile/vehicles`,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!cookieTeste) absorverRenovacao(r, cookie);
  if (r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400)) {
    throw erroSessao(`sessao da Sat expirou (HTTP ${r.status}) — use o botao Reconectar Sat na tela`);
  }
  if (!r.ok) throw new Error(`Sat /vehicles/index_with_state: HTTP ${r.status}`);
  const tipo = r.headers.get("content-type") || "";
  if (!/json/i.test(tipo)) throw erroSessao("sessao da Sat expirou (veio a tela de login) — use o botao Reconectar Sat na tela");
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error("Sat: resposta inesperada");
  return j.map(lerVeiculo).filter((a) => a && a.placa && Number.isFinite(a.lat) && Number.isFinite(a.lng) && a.posicao_em);
}

// Reconectar pela tela: aceita os valores soltos, "nome=valor; ..." ou o cURL inteiro.
function extrairCookie(texto) {
  const t = String(texto || "");
  const lembrar = /remember_user_token[=\s:]+([A-Za-z0-9%=_\-.]+--[0-9a-f]{20,})/.exec(t);
  const sessaoId = /_session_id[=\s:]+([0-9a-f]{20,})/i.exec(t);
  if (!lembrar && !sessaoId) return null;
  return [lembrar && `remember_user_token=${lembrar[1]}`, sessaoId && `_session_id=${sessaoId[1]}`].filter(Boolean).join("; ");
}

async function reconectar(texto, quem) {
  const cookie = extrairCookie(texto);
  if (!cookie) {
    const e = new Error("Nao achei o cookie da Sat (remember_user_token ou _session_id) no texto colado.");
    e.statusCliente = 400;
    throw e;
  }
  let lista;
  try {
    lista = await listarAparelhos(15000, cookie);
  } catch (err) {
    const e = new Error(err.sessaoExpirada
      ? "A Sat recusou esse cookie (login vencido ou copiado errado). Faca o login de novo, marcando \"lembrar de mim\", e copie outra vez."
      : `Nao consegui falar com a Sat: ${err.message}`);
    e.statusCliente = err.sessaoExpirada ? 400 : 502;
    throw e;
  }
  await salvarSessao(cookie, `reconectado pela tela${quem ? ` por ${quem}` : ""}`);
  return { aparelhos: lista.length };
}

const infoSessao = () => ({
  origem: sessao ? sessao.origem : (cookieEnv() ? ".env" : null),
  atualizado_em: sessao ? sessao.atualizado_em : null,
});

module.exports = { configurado, listarAparelhos, lerVeiculo, placaMercosul, carregarSessao, reconectar, infoSessao, extrairCookie };
