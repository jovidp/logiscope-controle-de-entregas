// ================================================================
// materiais-rota.js — planilha "RETIRADA E ENVIO DE MATERIAL" da expedicao
// ----------------------------------------------------------------
// Pasta: \\empresa.local\fileserver\expedicao\{ANO}\RETIRADA E ENVIO MATERIAL_ROTA
// (MATERIAIS_ROTA_PASTA no .env troca). Um arquivo por MES
// ("RETIRADA E ENVIO DE MATERIAL - OUTUBRO_ 2026.xlsx"), uma ABA por dia de
// rota ("01.10"). Em cada aba:
//   "RETIRADA - MATERIAL" + cabecalho ROTA|EMP|LOJA|SETOR|MATERIAL|QUANTIDADE|TRANSAÇÃO|DATA DA TR
//   "ENVIO - MATERIAL"    + o mesmo cabecalho
//   quadros de FOLDER entre lojas (LOJA [RETIRADA] | FOLDER x | FOLDER y | ... | [LOJA] DESTINO)
// e a aba PENDENTES (itens ainda sem dia). As colunas sao achadas pelo NOME
// (o layout varia entre abas). Texto solto depois das colunas ("ok",
// "entregue") vira status/observacao.
//
// Le so quando o arquivo muda (data/tamanho) e guarda em memoria; o file
// server nunca segura a requisicao por mais que o prazo.
//
// ORIGEM (desde 02/10/2026): a planilha do mes passou a ser salva na sala
// "Expedição" do OnlyOffice DocSpace (back/onlyoffice.js, mesma conta da
// programacao diaria). O OnlyOffice e lido primeiro; a pasta de rede continua
// valendo para os meses que nao estao la (marco-setembro/2026) e como
// reserva se o OnlyOffice cair.
// ================================================================

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const onlyoffice = require("./onlyoffice");

const PASTA_PADRAO = "\\\\empresa.local\\fileserver\\expedicao\\{ANO}\\RETIRADA E ENVIO MATERIAL_ROTA";
const MESES = ["JANEIRO", "FEVEREIRO", "MARCO", "ABRIL", "MAIO", "JUNHO", "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO"];
const PRAZO_MS = 15000;

const limpar = (v) => String(v ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
const semAcento = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const norm = (v) => semAcento(limpar(v)).toUpperCase();

function comPrazo(promessa, ms, oque) {
  let t;
  return Promise.race([promessa, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${oque}: sem resposta em ${ms / 1000}s`)), ms); })])
    .finally(() => clearTimeout(t));
}

const pastaDoAno = (ano) => String(process.env.MATERIAIS_ROTA_PASTA || PASTA_PADRAO).replace(/\{ANO\}/g, String(ano));

// "RETIRADA E ENVIO DE MATERIAL - OUTUBRO_ 2026.xlsx" -> { mes: 10, ano: 2026 }
function mesDoArquivo(nome) {
  const n = norm(nome);
  const i = MESES.findIndex((m) => n.includes(m));
  const a = n.match(/(20\d{2})/);
  return i >= 0 && a ? { mes: i + 1, ano: Number(a[1]) } : null;
}

// Data do Excel (numero serial ou Date) -> 'YYYY-MM-DD'
function dataExcel(v) {
  if (typeof v === "number" && v > 30000 && v < 80000) {
    const d = XLSX.SSF.parse_date_code(v);
    return d ? `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}` : null;
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return null;
}
const texto = (v) => {
  if (v === null || v === undefined || v === "") return "";
  const d = dataExcel(v);
  if (d) return d.split("-").reverse().join("/");
  return limpar(v);
};

const STATUS_RE = /^(OK|ENTREGUE|ATENDIDO|RETIRADO|ENVIADO|PENDENTE|NAO|SIM)\b/;

// Le UMA aba -> [{tipo:'envio'|'retirada', loja, setor, material, quantidade, transacao, data_tr, status, obs, origem, destino}]
function lerAba(ws) {
  const linhas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
  const itens = [];
  let secao = null, cab = null, folder = null;
  for (const c of linhas) {
    const cel = c.map(norm);
    const cheias = cel.filter(Boolean);
    if (!cheias.length) continue;
    // Titulo de secao ("RETIRADA - MATERIAL", "ENVIO", "RETIRADA ")
    if (cheias.length <= 2 && !cel.includes("LOJA")) {
      const t = cheias.join(" ");
      if (/RETIRADA/.test(t) && !/LOJA/.test(t)) { secao = "retirada"; cab = null; folder = null; continue; }
      if (/^ENVIO/.test(t)) { secao = "envio"; cab = null; folder = null; continue; }
    }
    // Cabecalho principal: tem LOJA e MATERIAL
    const iLoja = cel.findIndex((x) => x === "LOJA" || x === "NOME DA LOJA");
    const iMaterial = cel.findIndex((x) => x === "MATERIAL");
    if (iLoja >= 0 && iMaterial >= 0) {
      const ach = (re) => cel.findIndex((x) => re.test(x));
      cab = { loja: iLoja, material: iMaterial, setor: ach(/^SETOR$/), quantidade: ach(/^QUANTIDADE$/),
        transacao: ach(/^TRANSACAO$/), data: ach(/^DATA DA TR/), rota: ach(/^ROTA$/), emp: ach(/^EMP/) };
      cab.ultima = Math.max(...Object.values(cab));
      folder = null;
      continue;
    }
    // Cabecalho de quadro de FOLDER entre lojas. A coluna DESTINO e opcional:
    // "LOJA RETIRADA | FOLDER x | FOLDER y" (sem destino) so recolhe folder.
    const iOrigem = cel.findIndex((x) => x === "LOJA RETIRADA" || x === "LOJA");
    const iDestino = cel.findIndex((x, j) => j > iOrigem && /DESTINO$/.test(x));
    if (iOrigem >= 0 && cel.some((x) => /FOLDER|FRIDAY|NATAL|FESTAS|FERIAS/.test(x))) {
      const cols = [];
      const ate = iDestino > iOrigem ? iDestino : cel.length;
      for (let j = iOrigem + 1; j < ate; j += 1) {
        if (cel[j] && cel[j] !== "ROTA") cols.push({ j, nome: limpar(c[j]) });
      }
      // Sem destino, a loja da linha e quem RETIRA (ou recebe, se o quadro
      // estiver na secao ENVIO e o cabecalho for so "LOJA").
      const tipoSemDestino = cel[iOrigem] === "LOJA" && secao === "envio" ? "envio" : "retirada";
      folder = { origem: iOrigem, destino: iDestino > iOrigem ? iDestino : -1, cols, tipoSemDestino };
      cab = null;
      continue;
    }
    if (folder) {
      const origem = limpar(c[folder.origem]), destino = folder.destino >= 0 ? limpar(c[folder.destino]) : "";
      if (!origem && !destino) continue;
      for (const f of folder.cols) {
        const qtd = Number(c[f.j]);
        if (!Number.isFinite(qtd) || qtd <= 0) continue;
        if (folder.destino < 0) {
          itens.push({ tipo: folder.tipoSemDestino, loja: origem, material: f.nome, quantidade: String(qtd), folder: true });
          continue;
        }
        if (origem) itens.push({ tipo: "retirada", loja: origem, material: f.nome, quantidade: String(qtd), destino: destino || null, folder: true });
        if (destino) itens.push({ tipo: "envio", loja: destino, material: f.nome, quantidade: String(qtd), origem: origem || null, folder: true });
      }
      continue;
    }
    if (cab && secao) {
      const loja = limpar(c[cab.loja]), material = limpar(c[cab.material]);
      if (!loja || !material) continue;
      const g = (k) => (cab[k] >= 0 ? texto(c[cab[k]]) : "");
      const extras = c.slice(cab.ultima + 1).map(texto).filter(Boolean);
      const status = extras.find((x) => STATUS_RE.test(norm(x))) || null;
      itens.push({
        tipo: secao, loja, material, setor: g("setor") || null, quantidade: g("quantidade") || null,
        transacao: g("transacao") || null, data_tr: g("data") || null, rota: g("rota") || null,
        status, obs: extras.filter((x) => x !== status).join(" · ") || null,
      });
    }
  }
  return itens;
}

// ---------------------------------------------------------------- cache por arquivo
const cacheArquivo = new Map(); // caminho -> { assinatura, abas: { 'YYYY-MM-DD': itens[] }, pendentes: itens[] }
let listagem = { em: 0, valor: null };

let erroOnlyoffice = null;

async function listarArquivos() {
  if (listagem.valor && Date.now() - listagem.em < 60000) return listagem.valor;
  const ano = new Date().getFullYear();
  const out = [];
  const chaveMes = (m) => `${m.ano}-${m.mes}`;
  // 1) OnlyOffice (fonte principal desde 10/2026)
  erroOnlyoffice = null;
  if (onlyoffice.configurado()) {
    try {
      const { arquivos } = await onlyoffice.listarPlanilhas();
      for (const a of arquivos) {
        if (!/MATERIAL/.test(norm(a.nome))) continue;
        const m = mesDoArquivo(a.nome);
        if (!m) continue;
        out.push({ nome: a.nome, completo: `onlyoffice:${a._ooId}`, ooId: a._ooId, origem: "OnlyOffice", ...m,
          mtime: Date.parse(a.modificado || "") || 0, tamanho: a.tamanho || 0 });
      }
    } catch (err) {
      erroOnlyoffice = err.message;
      console.error("[materiais-rota] OnlyOffice:", err.message);
    }
  }
  // 2) Pasta de rede: so os meses que o OnlyOffice nao tem.
  const noOnlyoffice = new Set(out.map(chaveMes));
  for (const a of [ano, ano - 1]) {
    const dir = pastaDoAno(a);
    let nomes;
    try { nomes = await comPrazo(fs.promises.readdir(dir), PRAZO_MS, "Pasta RETIRADA E ENVIO"); } catch (_) { continue; }
    for (const nome of nomes) {
      if (!/\.xlsx?$/i.test(nome) || nome.startsWith("~$")) continue;
      const m = mesDoArquivo(nome);
      if (!m || noOnlyoffice.has(chaveMes(m))) continue;
      const completo = path.join(dir, nome);
      const st = await comPrazo(fs.promises.stat(completo), PRAZO_MS, nome).catch(() => null);
      if (st) out.push({ nome, completo, origem: "pasta da rede", ...m, mtime: st.mtimeMs, tamanho: st.size });
    }
  }
  if (!out.length) {
    throw new Error(`Planilhas de RETIRADA E ENVIO DE MATERIAL não encontradas (OnlyOffice${erroOnlyoffice ? `: ${erroOnlyoffice}` : " sem o arquivo"}; pasta da expedição também vazia/inacessível).`);
  }
  listagem = { em: Date.now(), valor: out };
  return out;
}

async function lerArquivo(arq) {
  const assinatura = `${arq.mtime}:${arq.tamanho}`;
  const c = cacheArquivo.get(arq.completo);
  if (c && c.assinatura === assinatura) return c;
  const buf = arq.ooId
    ? await onlyoffice.baixar(arq.ooId)
    : await comPrazo(fs.promises.readFile(arq.completo), 30000, arq.nome);
  const wb = XLSX.read(buf, { type: "buffer", cellDates: false });
  const abas = {};
  let pendentes = [];
  for (const nomeAba of wb.SheetNames) {
    const ws = wb.Sheets[nomeAba];
    if (!ws || !ws["!ref"]) continue;
    if (/PENDENTE/i.test(nomeAba)) { pendentes = lerAba(ws); continue; }
    const m = limpar(nomeAba).match(/^(\d{1,2})[.\-/](\d{1,2})/);
    if (!m) continue;
    const dia = Number(m[1]), mes = Number(m[2]);
    // Aba "30.12" num arquivo de janeiro e do ano anterior.
    const ano = mes - arq.mes > 6 ? arq.ano - 1 : arq.ano;
    const data = `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
    abas[data] = { aba: limpar(nomeAba), itens: lerAba(ws) };
  }
  const novo = { assinatura, abas, pendentes, nome: arq.nome, mtime: arq.mtime };
  cacheArquivo.set(arq.completo, novo);
  return novo;
}

// Itens de um DIA. A mesma aba as vezes existe em 2 arquivos (o mes seguinte
// comeca copiando os ultimos dias): vale o arquivo modificado por ultimo.
async function itensDoDia(data) {
  const [ano, mes] = data.split("-").map(Number);
  const arquivos = (await listarArquivos())
    .filter((a) => (a.ano === ano && Math.abs(a.mes - mes) <= 1) || (a.ano !== ano && Math.abs(a.mes - mes) === 11))
    .sort((a, b) => b.mtime - a.mtime);
  for (const arq of arquivos) {
    const conteudo = await lerArquivo(arq);
    if (conteudo.abas[data]) return { arquivo: arq.nome, origem: arq.origem, aba: conteudo.abas[data].aba, itens: conteudo.abas[data].itens };
  }
  return { arquivo: null, origem: null, aba: null, itens: [] };
}

// Pendentes (sem dia) do arquivo mais recente.
async function pendentesAtuais() {
  const arq = (await listarArquivos()).sort((a, b) => b.mtime - a.mtime)[0];
  if (!arq) return { arquivo: null, itens: [] };
  const conteudo = await lerArquivo(arq);
  return { arquivo: arq.nome, itens: conteudo.pendentes || [] };
}

// Itens de UMA loja num dia. `mesmaLoja(nomePlanilha)` decide o casamento
// (o servidor passa o resolvedor do cadastro de lojas/PES).
async function materiaisDaLoja(data, mesmaLoja) {
  const [dia, pend] = await Promise.all([itensDoDia(data), pendentesAtuais().catch(() => ({ itens: [] }))]);
  const daLoja = dia.itens.filter((i) => mesmaLoja(i.loja));
  return {
    arquivo: dia.arquivo,
    origem: dia.origem,
    aba: dia.aba,
    envio: daLoja.filter((i) => i.tipo === "envio"),
    retirada: daLoja.filter((i) => i.tipo === "retirada"),
    pendentes: pend.itens.filter((i) => mesmaLoja(i.loja)),
  };
}

// ---------------------------------------------------------------- relatorio
// "O material foi ou nao foi?" num periodo. Cada item da planilha ganha uma
// SITUACAO cruzando duas fontes:
//   1) a conferencia no formulario de ocorrencia da MESMA loja no MESMO dia:
//      material_envio_status para ENVIO, material_retirada_status para
//      RETIRADA — manda mais que a planilha (quem esteve na loja confirmou);
//   2) o status solto que a expedicao escreve na planilha ("ok", "entregue",
//      "retirado", "pendente"...).
// A conferencia e por loja/dia, nao por item: "parcial" marca todos os itens
// daquela loja naquele dia, com o relato ao lado.
const STATUS_OK = /^(OK|ENTREGUE|ATENDIDO|RETIRADO|ENVIADO|SIM)\b/;
const STATUS_FALHA = /^(PENDENTE|NAO)\b/;
const CONFERIDO = ["correta", "parcial", "incorreta"];
const campoConferencia = (tipo) => (tipo === "envio" ? "material_envio" : "material_retirada");
const TEXTOS = {
  envio: { incorreta: "Não chegou", parcial: "Parcial / divergência", correta: "Entregue", ok: "Enviado", falha: "Não enviado" },
  retirada: { incorreta: "Não retirado", parcial: "Retirada parcial", correta: "Retirado", ok: "Retirado", falha: "Não retirado" },
};

// Identidade de UM item da planilha (ela nao tem id de linha). `lojaKey` =
// codigo do PES (ou nome canonizado) — "Bangu 4" e "BANGU IV" sao a mesma.
function chaveItem(data, tipo, lojaKey, material, transacao) {
  return [data, tipo, lojaKey, norm(material), norm(transacao)].join("|");
}

// Marcacao item a item (tabela material_item_status) — vale mais que tudo:
// e alguem dizendo "ESTE item foi / nao foi / ficou pendente".
const TEXTOS_ITEM = {
  envio: { ok: "Entregue", nao: "Não entregue", pendente: "Pendente" },
  retirada: { ok: "Retirado", nao: "Não retirado", pendente: "Pendente" },
};
const GRUPO_ITEM = { ok: "ok", nao: "falha", pendente: "pendente" };

function situacaoItem(item, ocorrencias, marcado) {
  if (marcado && GRUPO_ITEM[marcado.status]) {
    const ti = TEXTOS_ITEM[item.tipo] || TEXTOS_ITEM.envio;
    const quando = marcado.status === "ok" && marcado.resolvido_em_data
      ? ` em ${String(marcado.resolvido_em_data).slice(0, 10).split("-").reverse().slice(0, 2).join("/")}` : "";
    return { grupo: GRUPO_ITEM[marcado.status], situacao: `${ti[marcado.status]}${quando}`, fonte: "item" };
  }
  const s = norm(item.status);
  const campo = `${campoConferencia(item.tipo)}_status`;
  const t = TEXTOS[item.tipo] || TEXTOS.envio;
  const conferidas = ocorrencias.filter((o) => CONFERIDO.includes(o[campo]));
  if (conferidas.some((o) => o[campo] === "incorreta")) return { grupo: "falha", situacao: t.incorreta, fonte: "loja" };
  if (conferidas.some((o) => o[campo] === "parcial")) return { grupo: "parcial", situacao: t.parcial, fonte: "loja" };
  if (conferidas.length) return { grupo: "ok", situacao: t.correta, fonte: "loja" };
  if (STATUS_OK.test(s)) return { grupo: "ok", situacao: t.ok, fonte: "planilha" };
  if (STATUS_FALHA.test(s)) return { grupo: "falha", situacao: t.falha, fonte: "planilha" };
  // "Sem conferencia" = a ocorrencia foi lancada mas o campo ficou vazio/"nao se aplica".
  return { grupo: "aberto", situacao: ocorrencias.length ? "Sem conferência" : "Sem registro", fonte: null };
}

// Itens de todos os dias de [de, ate] (no maximo 92 dias) + PENDENTES atuais.
async function itensDoPeriodo(de, ate) {
  const dias = [];
  const d = new Date(`${de}T12:00:00Z`), fim = new Date(`${ate}T12:00:00Z`);
  while (d <= fim && dias.length < 92) { dias.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  const itens = [];
  for (const data of dias) {
    const r = await itensDoDia(data);
    for (const i of r.itens) itens.push({ data, ...i });
  }
  const pend = await pendentesAtuais().catch(() => ({ arquivo: null, itens: [] }));
  return { dias: dias.length, itens, pendentes: pend.itens, arquivoPendentes: pend.arquivo };
}

// Junta itens + ocorrencias do periodo. `codigoLoja(nome)` da a chave de
// casamento (codigo do PES ou nome canonizado); `nomeLoja(nome)` o nome oficial.
// `marcados`: Map chave -> linha de material_item_status (opcional).
function montarRelatorio({ itens, pendentes }, ocorrencias, codigoLoja, nomeLoja, marcados = new Map()) {
  const ocPorChave = new Map();
  for (const o of ocorrencias) {
    const k = `${o.data}|${codigoLoja(o.loja)}`;
    if (!ocPorChave.has(k)) ocPorChave.set(k, []);
    ocPorChave.get(k).push(o);
  }
  const linhas = itens.map((i) => {
    const lojaKey = codigoLoja(i.loja);
    const ocs = ocPorChave.get(`${i.data}|${lojaKey}`) || [];
    const chave = chaveItem(i.data, i.tipo, lojaKey, i.material, i.transacao);
    const marcado = marcados.get(chave) || null;
    const sit = situacaoItem(i, ocs, marcado);
    const campo = campoConferencia(i.tipo);
    const ref = ocs.find((o) => CONFERIDO.includes(o[`${campo}_status`])) || ocs[0] || null;
    return {
      chave, status_item: marcado?.status || null, marcado_por: marcado?.usuario_nome || null,
      marcado_em: marcado?.atualizado_em || null, obs_item: marcado?.observacao || null,
      data: i.data, tipo: i.tipo, loja: nomeLoja(i.loja), loja_planilha: i.loja,
      rota: i.rota || ref?.rota || null, material: i.material, quantidade: i.quantidade || null,
      setor: i.setor || null, transacao: i.transacao || null, origem: i.origem || null, destino: i.destino || null,
      status_planilha: i.status || null, obs_planilha: i.obs || null,
      ...sit,
      ocorrencia_id: ref?.id || null, motorista: ref?.motorista || null,
      conferencia_loja: ref?.[`${campo}_status`] || null, relato_loja: ref?.[`${campo}_relato`] || null,
    };
  });
  const resumo = { total: linhas.length, ok: 0, falha: 0, parcial: 0, pendente: 0, aberto: 0, envio: 0, retirada: 0 };
  for (const l of linhas) { resumo[l.grupo] += 1; resumo[l.tipo] += 1; }
  return {
    resumo,
    linhas,
    pendentes: pendentes.map((p) => ({
      tipo: p.tipo, loja: nomeLoja(p.loja), loja_planilha: p.loja, material: p.material,
      quantidade: p.quantidade || null, setor: p.setor || null, transacao: p.transacao || null,
      data_tr: p.data_tr || null, status_planilha: p.status || null, obs_planilha: p.obs || null,
    })),
  };
}

// ---------------------------------------------------------------- pendencias que voltam
// Material que NAO foi (retirada "nao retirado"/"parcial", envio "nao chegou"/
// "parcial") numa visita anterior a loja volta sozinho na proxima visita: o
// formulario daquela loja mostra "ficou da visita de DD/MM". Some quando uma
// ocorrencia POSTERIOR da mesma loja marca o mesmo campo como "correta" ou
// quando cada item e marcado "foi" (item a item, tabela material_item_status).
// Itens marcados "nao foi"/"pendente" um a um tambem voltam, mesmo sem a
// conferencia geral da ocorrencia.
// `ocsDaLoja`: ocorrencias da loja (ultimos ~30 dias ate `data`), ja filtradas.
// `chaveDe(item, data)`: chave do item; `marcados`: Map chave -> marcacao;
// `marcadosDaLoja`: marcacoes nao/pendente da loja (30 dias), da tabela.
async function pendenciasAnteriores(data, ocsDaLoja, mesmaLoja, { chaveDe, marcados = new Map(), marcadosDaLoja = [] } = {}) {
  const ordenadas = [...ocsDaLoja].sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : a.id - b.id));
  const saida = [];
  const vistos = new Set();
  const jaListadas = new Set();
  const anotar = (i, dataOrigem) => {
    const chave = chaveDe ? chaveDe(i, dataOrigem) : null;
    const m = chave ? marcados.get(chave) : null;
    return { ...i, data: dataOrigem, chave, status_item: m?.status || null, obs_item: m?.observacao || null };
  };
  for (const tipo of ["retirada", "envio"]) {
    const campo = campoConferencia(tipo);
    for (const f of ordenadas) {
      if (f.data >= data || !["incorreta", "parcial"].includes(f[`${campo}_status`])) continue;
      const chave = `${tipo}|${f.data}`;
      if (vistos.has(chave)) continue;
      const resolvida = ordenadas.some((o) => o.data > f.data && o.data <= data && o[`${campo}_status`] === "correta");
      if (resolvida) continue;
      vistos.add(chave);
      let itens = [];
      try {
        itens = (await itensDoDia(f.data)).itens.filter((i) => i.tipo === tipo && mesmaLoja(i.loja)).map((i) => anotar(i, f.data));
      } catch (_) { /* planilha fora do ar: mostra a pendencia sem a lista */ }
      itens.forEach((i) => i.chave && jaListadas.add(i.chave));
      const abertos = itens.filter((i) => i.status_item !== "ok");
      if (itens.length && !abertos.length) continue; // todos marcados "foi" um a um
      saida.push({
        tipo, data_origem: f.data, status: f[`${campo}_status`], relato: f[`${campo}_relato`] || null,
        ocorrencia_id: f.id, itens: abertos,
      });
    }
  }
  // Marcados um a um como "nao foi"/"pendente" numa visita anterior.
  const porGrupo = new Map();
  for (const m of marcadosDaLoja) {
    if (m.data >= data || !["nao", "pendente"].includes(m.status) || jaListadas.has(m.chave)) continue;
    const k = `${m.tipo}|${m.data}`;
    if (!porGrupo.has(k)) porGrupo.set(k, { tipo: m.tipo, data_origem: m.data, status: "item", relato: null, ocorrencia_id: m.ocorrencia_id || null, itens: [] });
    porGrupo.get(k).itens.push({
      tipo: m.tipo, loja: m.loja_planilha || m.loja, material: m.material, quantidade: m.quantidade, transacao: m.transacao,
      data: m.data, chave: m.chave, status_item: m.status, manual: !!m.manual, obs_item: m.observacao || null,
    });
  }
  saida.push(...porGrupo.values());
  return saida.sort((a, b) => (a.data_origem < b.data_origem ? -1 : 1));
}

module.exports = { itensDoDia, pendentesAtuais, materiaisDaLoja, itensDoPeriodo, montarRelatorio, situacaoItem, pendenciasAnteriores, chaveItem, lerAba, mesDoArquivo };
