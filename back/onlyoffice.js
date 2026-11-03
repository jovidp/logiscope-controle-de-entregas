// ================================================================
// onlyoffice.js — leitura de planilhas no OnlyOffice DocSpace
// ----------------------------------------------------------------
// Desde 2026-10 a programacao diaria (DD.MM.AA.xlsx) e salva na SALA
// "Expedição" do OnlyOffice DocSpace (http://192.0.2.20), nao mais na pasta
// ROTA COMPARTILHADA do file server. Aqui: login (API /api/2.0), listagem da
// sala (raiz + subpastas, 1 nivel) e download do arquivo.
//
// .env (cifrado com dotenvx):
//   ONLYOFFICE_URL   http://192.0.2.20
//   ONLYOFFICE_USER  usuario do dominio (login LDAP)
//   ONLYOFFICE_PASS  senha
//   ONLYOFFICE_SALA  nome da sala (padrao "Expedição")
// Sem URL/usuario/senha: configurado() = false e quem chama usa a pasta de rede.
// ================================================================

const PRAZO_MS = Number(process.env.ONLYOFFICE_TIMEOUT_MS || 15000);
const cfg = () => ({
  url: String(process.env.ONLYOFFICE_URL || "").replace(/\/+$/, ""),
  user: String(process.env.ONLYOFFICE_USER || ""),
  pass: String(process.env.ONLYOFFICE_PASS || ""),
  sala: String(process.env.ONLYOFFICE_SALA || "Expedição"),
});
const configurado = () => { const c = cfg(); return !!(c.url && c.user && c.pass); };

// A API devolve nome com entidade HTML (Magalh&#227;es) e data com 7 casas.
const desentidade = (s) => String(s || "").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const isoData = (s) => { const t = Date.parse(String(s || "").replace(/(\.\d{3})\d+/, "$1")); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

async function chamar(caminho, opcoes = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PRAZO_MS);
  try {
    return await fetch(`${cfg().url}${caminho}`, { ...opcoes, signal: ctrl.signal });
  } catch (err) {
    const motivo = err.name === "AbortError" ? `sem resposta em ${PRAZO_MS / 1000}s` : err.message;
    throw new Error(`OnlyOffice indisponível (${cfg().url}): ${motivo}`);
  } finally {
    clearTimeout(t);
  }
}

let sessao = { token: null, expira: 0 };
async function token(forcar = false) {
  if (!forcar && sessao.token && Date.now() < sessao.expira) return sessao.token;
  const c = cfg();
  const r = await chamar("/api/2.0/authentication", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ userName: c.user, password: c.pass }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j?.response?.token) {
    throw new Error(`OnlyOffice recusou o login de ${c.user} (HTTP ${r.status}). Confira usuário/senha no .env.`);
  }
  const exp = Date.parse(j.response.expires || "");
  sessao = { token: j.response.token, expira: Number.isFinite(exp) ? exp - 5 * 60 * 1000 : Date.now() + 60 * 60 * 1000 };
  return sessao.token;
}

// GET autenticado; token vencido (401) renova uma vez.
async function getAuth(caminho, json = true) {
  for (const forcar of [false, true]) {
    const r = await chamar(caminho, { headers: { Authorization: await token(forcar), Accept: json ? "application/json" : "*/*" } });
    if (r.status === 401 && !forcar) continue;
    if (!r.ok) throw new Error(`OnlyOffice ${caminho}: HTTP ${r.status}`);
    return json ? r.json() : r;
  }
  throw new Error("OnlyOffice: sessão recusada.");
}

async function idDaSala() {
  const j = await getAuth("/api/2.0/files/rooms");
  const alvo = cfg().sala.toLowerCase();
  const sala = (j?.response?.folders || []).find((f) => desentidade(f.title).trim().toLowerCase() === alvo);
  if (!sala) throw new Error(`Sala "${cfg().sala}" não encontrada no OnlyOffice (ou o usuário não tem acesso a ela).`);
  return { id: sala.id, titulo: desentidade(sala.title) };
}

// Arquivos da sala: raiz + subpastas de 1 nivel (ex.: "10 - OUTUBRO").
// Formato igual ao da listagem da pasta de rede, + _ooId para baixar.
async function listarPlanilhas() {
  const sala = await idDaSala();
  const out = [];
  const lerPasta = async (id, prefixo) => {
    const j = await getAuth(`/api/2.0/files/${id}`);
    for (const f of j?.response?.files || []) {
      const nome = desentidade(f.title);
      if (!/\.xls[xm]?$/i.test(nome)) continue;
      out.push({
        caminho: `${prefixo}${nome}`,
        nome,
        tamanho: Number(f.pureContentLength) || null,
        modificado: isoData(f.updated),
        _ooId: f.id,
      });
    }
    return j?.response?.folders || [];
  };
  const subpastas = await lerPasta(sala.id, "");
  for (const p of subpastas) await lerPasta(p.id, `${desentidade(p.title)}/`).catch(() => {});
  return { pasta: `OnlyOffice › ${sala.titulo}`, arquivos: out };
}

async function baixar(fileId) {
  const r = await getAuth(`/filehandler.ashx?action=download&fileid=${encodeURIComponent(fileId)}`, false);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.slice(0, 2).toString() !== "PK" && buf.slice(0, 4).toString("hex") !== "d0cf11e0") {
    throw new Error("OnlyOffice devolveu algo que não é planilha.");
  }
  return buf;
}

// Grava um arquivo do PROPRIO sistema na raiz da sala (ex.: "STATUS DO MATERIAL
// - OUTUBRO 2026.xlsx"). Mesmo nome = nova versao do mesmo arquivo
// (createNewIfExist=false). Trava: nunca grava por cima das planilhas da equipe.
const NOMES_DA_EQUIPE = /RETIRADA E ENVIO|^\d{2}\.\d{2}\.\d{2}\.xlsx$/i;
async function salvarNaSala(nome, buffer) {
  if (!/^STATUS DO MATERIAL - /.test(nome) || NOMES_DA_EQUIPE.test(nome)) {
    throw new Error(`Nome não permitido para gravar no OnlyOffice: ${nome}`);
  }
  const sala = await idDaSala();
  for (const forcar of [false, true]) {
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), nome);
    form.append("title", nome);
    form.append("createNewIfExist", "false");
    const r = await chamar(`/api/2.0/files/${sala.id}/insert`, {
      method: "POST",
      headers: { Authorization: await token(forcar), Accept: "application/json" },
      body: form,
    });
    if (r.status === 401 && !forcar) continue;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`OnlyOffice não aceitou ${nome}: HTTP ${r.status} ${j?.error?.message || ""}`.trim());
    return { id: j?.response?.id ?? null, versao: j?.response?.version ?? null };
  }
  throw new Error("OnlyOffice: sessão recusada.");
}

module.exports = { configurado, listarPlanilhas, baixar, salvarNaSala };
