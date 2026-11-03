// ================================================================
// rastreador-t4s.js — posicao dos caminhoes pela plataforma T4S
// ----------------------------------------------------------------
// A API oficial (t4s-api.js) e usada quando ClientKey/ClientSecret estao
// configurados. Sem essas credenciais, continua usando a sessao do site.
// https://rastreamento.t4stecnologia.com.br (ASP.NET): o login tem reCAPTCHA,
// entao a sessao e criada por uma PESSOA (login assistido) e o
// servidor reaproveita o cookie de autenticacao enquanto ele valer:
//   POST /Home/List  -> a mesma tabela que a tela "veiculos rastreados" usa.
// Cada linha traz num checkbox "aparelho|tecnologia|lat|lng|data -03:00|placa|id"
// e, nas colunas, ignicao e velocidade. SO LEITURA: nada aqui altera a T4S.
//
// Por que existe: em 05/10/2026 o T4S tinha sinal AO VIVO em caminhoes mudos
// no SRF (FKA0C10 sem sinal no SRF desde 15/09; FKG6J16 desde a vespera).
//
// Credencial (.env cifrado): T4S_COOKIE = ".ASPXAUTH=...; u_token=..." (o
// cf_clearance do Cloudflare NAO e necessario — testado). Quando o login
// expira a T4S responde 412 / tela de login: listarAparelhos() lanca um erro
// com `sessaoExpirada = true` para quem coleta avisar "reconectar o T4S".
//
// Saida no MESMO formato do GPSWOX (rastreador.js), combinado com quem mantem
// aquele modulo: { device_id, nome, placa, lat, lng, velocidade, rumo,
// posicao_em (Date), online, motor, parado_seg, fonte: 't4s', endereco }.
// ================================================================

const crypto = require("crypto");
const apiOficial = require('./t4s-api').padrao;

// ---------------------------------------------------------------- sessao
// O T4S (ASP.NET) renova o login de tempos em tempos devolvendo um .ASPXAUTH
// novo no Set-Cookie. Antes isso era ignorado: o servidor seguia com o cookie
// do .env ate ele vencer e alguem refazer o login. Agora o cookie em uso
// absorve a renovacao e fica guardado em sistema_config (cifrado — o dump do
// banco vai pro file server), entao sobrevive a restart sem tocar no .env.
// O botao "Reconectar T4S" (POST /tms/rastreador/t4s-reconectar) troca o
// cookie na hora, sem terminal e sem restart.
// Se alguem trocar o T4S_COOKIE do .env na mao, o .env volta a mandar: a
// sessao salva guarda o hash do .env da epoca e e descartada se ele mudar.
const CHAVE_CFG = "t4s_sessao";
let sessao = null; // { cookie, origem, atualizado_em }
let banco = null;

const cookieEnv = () => String(process.env.T4S_COOKIE || "").trim();
const hashEnv = () => crypto.createHash("sha256").update(cookieEnv()).digest("hex").slice(0, 16);
const chaveCifra = () => crypto.createHash("sha256")
  .update(`t4s-sessao|${process.env.DB_PASSWORD || ""}|${process.env.SRF_SENHA || ""}`).digest();

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
  url: String(process.env.T4S_URL || "https://rastreamento.t4stecnologia.com.br").replace(/\/+$/, ""),
  cookie: (sessao && sessao.cookie) || cookieEnv(),
});
const historicoConfigurado = () => !!config().cookie;
const configurado = () => apiOficial.configurado() || historicoConfigurado();
const modoConexao = () => apiOficial.configurado() ? 'api' : historicoConfigurado() ? 'navegador' : 'desconectado';

// Chamar no boot, ANTES do rastreador.iniciar(): sem isso o 1o ciclo usaria o
// cookie (talvez vencido) do .env.
async function carregarSessao(db) {
  banco = db;
  try {
    const r = await db.query("SELECT valor FROM sistema_config WHERE chave = $1", [CHAVE_CFG]);
    const v = r.rows[0] && r.rows[0].valor;
    if (v && v.cookie && v.env === hashEnv()) {
      sessao = { cookie: decifrar(v.cookie), origem: v.origem, atualizado_em: v.atualizado_em };
      console.log(`[t4s] sessao salva carregada (${v.origem || "?"}, ${v.atualizado_em || "?"})`);
    }
  } catch (err) {
    console.error("[t4s] nao leu a sessao salva — seguindo com o .env:", err.message);
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

const COOKIES_SESSAO = [".ASPXAUTH", "u_token"];

function lerCookies(texto) {
  const mapa = new Map();
  String(texto || "").split(/;\s*/).forEach((par) => {
    const i = par.indexOf("=");
    if (i > 0) mapa.set(par.slice(0, i).trim(), par.slice(i + 1).trim());
  });
  return mapa;
}

const montarCookie = (mapa) => COOKIES_SESSAO.filter((k) => mapa.get(k)).map((k) => `${k}=${mapa.get(k)}`).join("; ");

// Set-Cookie com .ASPXAUTH/u_token NOVO = renovacao: passa a usar e guarda.
// Valor vazio ou expires no passado e o T4S apagando (logout) — ignora, para
// a coleta continuar com o que tem e acusar "sessao expirada" do jeito normal.
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
  salvarSessao(montarCookie(mapa), "renovado pelo T4S")
    .then(() => console.log("[t4s] o T4S renovou a sessao — cookie novo guardado"))
    .catch((err) => console.error("[t4s] renovou mas nao gravou:", err.message));
}

// Mesma regra do rastreador.js (FKO1015 -> FKF5H15). Copiada de proposito:
// require do rastreador.js aqui criaria dependencia circular quando ele
// passar a juntar as fontes.
const LETRA_MERCOSUL = "ABCDEFGHIJ";
function placaMercosul(placa) {
  const p = String(placa || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/^[A-Z]{3}\d{4}$/.test(p)) return p.slice(0, 4) + LETRA_MERCOSUL[Number(p[4])] + p.slice(5);
  return p;
}

const numeroBR = (s) => Number(String(s || "").trim().replace(",", "."));
const textoHtml = (s) =>
  String(s || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

// "05/10/2026 09:49:34 -03:00" -> Date
function lerDataT4s(txt) {
  const m = String(txt || "").match(/(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})\s*([+-]\d{2}:\d{2})?/);
  if (!m) return null;
  const d = new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}${m[7] || "-03:00"}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Uma <tr class="linha_grid"> -> aparelho no formato GPSWOX.
function lerLinha(tr) {
  const valor = (tr.match(/class="checkboxVehicle" value="([^"]+)"/) || [])[1];
  if (!valor) return null;
  const [aparelho, , lat, lng, quando, placa] = valor.split("|");
  const celulas = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => textoHtml(m[1]));
  // Colunas: 0 check, 1 placa, 2 rastreador, 3 blindagem, 4 trava, 5 cliente,
  // 6 endereco, 7 modelo, 8 ultima comunicacao, 9 data GPS, 10 lat/long,
  // 11 ignicao, 12 violacao, 13 bloqueio, 14 velocidade, ...
  const ignicao = celulas[11];
  const modelo = celulas[7] || "";
  return {
    device_id: Number(aparelho),
    nome: `${placa} - ${modelo}`.trim(),
    placa: placaMercosul(placa),
    lat: numeroBR(lat),
    lng: numeroBR(lng),
    velocidade: Number((celulas[14] || "").replace(/[^\d.,]/g, "").replace(",", ".")) || 0,
    rumo: 0,
    // O checkbox usa a comunicação; a coluna 9 é a hora da posição GPS.
    posicao_em: lerDataT4s(celulas[9]) || lerDataT4s(quando),
    online: "",
    motor: ignicao === "On" ? "ligado" : ignicao === "Off" ? "desligado" : null,
    parado_seg: 0,
    fonte: "t4s",
    endereco: celulas[6] || "",
  };
}

function erroSessao(msg) {
  const e = new Error(msg);
  e.sessaoExpirada = true;
  return e;
}

// cookieTeste: experimenta um cookie SEM adota-lo (Reconectar T4S testa antes).
async function listarAparelhos(timeoutMs = 15000, cookieTeste = null) {
  if (!cookieTeste && apiOficial.configurado()) return apiOficial.listarPosicoes(timeoutMs);
  const c = config();
  const cookie = cookieTeste || c.cookie;
  if (!cookie) throw new Error("T4S nao configurado (T4S_COOKIE)");
  const corpo = new URLSearchParams({
    SelectAll: "false", PlatesSelected: "", VehicleInstallationsSelected: "", GPRSDatetimeFrom: "",
    GPRSDatetimeTo: "", Plate: "", DeviceId: "", CompanyIdArray: "", ProductTypeId: "",
  });
  const r = await fetch(`${c.url}/Home/List`, {
    method: "POST",
    redirect: "manual",
    headers: {
      Cookie: cookie,
      Accept: "text/html, */*; q=0.01",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${c.url}/`,
    },
    body: corpo.toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!cookieTeste) absorverRenovacao(r, cookie);
  if (r.status === 412 || r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400)) {
    throw erroSessao(`sessao do T4S expirou (HTTP ${r.status}) — use o botao Reconectar T4S na tela`);
  }
  if (!r.ok) throw new Error(`T4S /Home/List: HTTP ${r.status}`);
  const html = await r.text();
  if (/Account\/Login/i.test(html) && !/linha_grid/.test(html)) {
    throw erroSessao("sessao do T4S expirou (tela de login) — use o botao Reconectar T4S na tela");
  }
  return html
    .split('<tr class="linha_grid">')
    .slice(1)
    .map(lerLinha)
    .filter((a) => a && a.placa && Number.isFinite(a.lat) && Number.isFinite(a.lng));
}

// Reconectar pela tela: aceita o que a pessoa colar — os dois valores soltos,
// "nome=valor; nome=valor", o cabecalho Cookie ou o cURL inteiro do DevTools.
// So adota depois de testar contra o T4S; o cookie nunca volta na resposta.
function extrairCookie(texto) {
  const t = String(texto || "");
  const auth = /\.ASPXAUTH[=\s:]+([0-9A-Fa-f]{64,})/.exec(t) || /\b([0-9A-Fa-f]{100,})\b/.exec(t);
  const tok = /u_token[=\s:]+([a-z0-9]{16,40})/i.exec(t) || /\b([a-z0-9]{24})\b/.exec(t.replace(auth ? auth[1] : "", ""));
  if (!auth || !tok) return null;
  return `.ASPXAUTH=${auth[1].toUpperCase()}; u_token=${tok[1]}`;
}

async function reconectar(texto, quem) {
  const cookie = extrairCookie(texto);
  if (!cookie) {
    const e = new Error("Nao achei os dois cookies (.ASPXAUTH e u_token) no texto colado.");
    e.statusCliente = 400;
    throw e;
  }
  let lista;
  try {
    lista = await listarAparelhos(15000, cookie);
  } catch (err) {
    const e = new Error(err.sessaoExpirada
      ? "O T4S recusou esses cookies (login vencido ou copiado errado). Faca o login de novo e copie outra vez."
      : `Nao consegui falar com o T4S: ${err.message}`);
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

// O relatório contém posições transmitidas com atraso que /Home/List não expõe.
function lerHistorico(html, placa, deviceId) {
  // O T4S responde só esta mensagem (sem tabela) quando não há leituras no
  // intervalo. Isso é normal de madrugada e não deve interromper o dia.
  const mensagem=textoHtml(html).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  if(mensagem==='sem posicoes')return {pontos:[],paginas:1};
  const cabecalho = [...String(html).matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)]
    .map(m => textoHtml(m[1]).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase());
  const colunas = ['placa', 'rastreador', 'data da posicao', 'lat/long', 'ignicao', 'gps/lbs', 'velocidade'];
  const idx = Object.fromEntries(colunas.map(k => [k, cabecalho.indexOf(k)]));
  if (colunas.some(k => idx[k] < 0)) throw new Error('T4S: formato do relatório de posições mudou');
  const pontos = [];
  for (const m of String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const c = [...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(x => textoHtml(x[1]));
    if (c.length !== cabecalho.length || placaMercosul(c[idx.placa]) !== placaMercosul(placa)) continue;
    const id = Number(c[idx.rastreador]);
    if (id !== Number(deviceId) || c[idx['gps/lbs']].toUpperCase() !== 'GPS') continue;
    const coord = c[idx['lat/long']].split('/');
    if (coord.length !== 2) continue;
    const motor = c[idx.ignicao];
    pontos.push({placa: placaMercosul(placa), device_id: id, fonte: 't4s',
      lat: numeroBR(coord[0]), lng: numeroBR(coord[1]), posicao_em: lerDataT4s(c[idx['data da posicao']]),
      velocidade: Number(c[idx.velocidade].replace(/[^\d.,]/g, '').replace(',', '.')),
      motor: motor === 'Off' ? 'desligado' : motor === 'On' ? 'ligado' : null, rumo: 0});
  }
  const paginas = [...String(html).matchAll(/[?&](?:amp;)?page=(\d+)/gi)].map(m => Number(m[1]));
  return {pontos, paginas: Math.max(1, ...paginas)};
}

async function listarHistorico(placa, deviceId, desde, ate, {fetcher = fetch, maxPaginas = 40, onPagina} = {}) {
  placa = placaMercosul(placa);
  const ini = new Date(desde), fim = new Date(ate);
  if (!/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(placa) || !Number.isSafeInteger(Number(deviceId)) || Number(deviceId) < 1
    || !Number.isFinite(+ini) || !Number.isFinite(+fim) || fim <= ini || fim - ini > 6 * 3600000) {
    throw new Error('T4S: placa, aparelho ou período inválido (máximo seis horas)');
  }
  const dataBR = d => new Intl.DateTimeFormat('pt-BR', {timeZone:'America/Sao_Paulo',
    year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(d).replace(',', '');
  async function ler(path, dados) {
    const c = config();
    if (!c.cookie) throw erroSessao('T4S não configurado');
    const r = await fetcher(c.url + path, {method:'POST',redirect:'manual',
      headers:{Cookie:c.cookie,'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With':'XMLHttpRequest',Referer:c.url+'/Report/PositionVehicle'},
      body:new URLSearchParams(dados).toString(),signal:AbortSignal.timeout(20000)});
    absorverRenovacao(r, c.cookie);
    if ([401,403,412].includes(r.status) || (r.status>=300 && r.status<400)) throw erroSessao('Sessão T4S expirou no histórico');
    if (!r.ok) throw new Error(`T4S histórico: HTTP ${r.status}`);
    const html = await r.text();
    if (/Account\/Login/i.test(html) && !/<th\b|<option\b/i.test(html)) throw erroSessao('Sessão T4S expirou no histórico');
    return html;
  }
  const opcoes = await ler('/Report/DetailedEventsDeviceIdAndTechnologyId', {Plate:placa,ShowPreviousInstalations:'false'});
  const aparelhos = [...opcoes.matchAll(/<option[^>]*value=["']([^"']*)["'][^>]*>/gi)].map(m=>m[1]);
  const aparelho = aparelhos.find(x => /^\d+\*\d+$/.test(x) && Number(x.split('*')[0]) === Number(deviceId));
  if (!aparelho) throw new Error('T4S: aparelho não pertence à placa no relatório');
  const unicos = new Map(), vistos = new Set();
  let paginas = 1;
  for (let page=1;page<=paginas;page++) {
    const html = await ler('/Report/ListPositionVehicle', {Plate:placa,DeviceIdAndTechnologyId:aparelho,
      GPRSDatetimeFrom:dataBR(ini),GPRSDatetimeTo:dataBR(fim),ShowPreviousInstalations:'false',Page:String(page)});
    const lidos = lerHistorico(html, placa, deviceId);
    paginas = Math.max(paginas, lidos.paginas);
    if (paginas > maxPaginas) throw new Error('T4S: histórico excedeu o limite de páginas; reduza o período');
    const assinatura = crypto.createHash('sha256').update(JSON.stringify(lidos.pontos)).digest('hex');
    if (vistos.has(assinatura) && lidos.pontos.length) throw new Error('T4S repetiu a página do histórico');
    vistos.add(assinatura);
    const pontos=lidos.pontos.filter(p=>p.posicao_em && +p.posicao_em>=+ini && +p.posicao_em<=+fim);
    // Preserva cada pagina antes de pedir a seguinte. Erros posteriores
    // interrompem a recuperacao dos eventos, mas nao apagam sinais recebidos.
    if(onPagina)await onPagina(pontos);
    for (const p of pontos) unicos.set(+p.posicao_em,p);
  }
  return [...unicos.values()].sort((a,b)=>a.posicao_em-b.posicao_em);
}

module.exports = { configurado, historicoConfigurado, modoConexao, listarAparelhos, lerLinha, lerDataT4s, placaMercosul,
  carregarSessao, reconectar, infoSessao, extrairCookie, lerHistorico, listarHistorico };
