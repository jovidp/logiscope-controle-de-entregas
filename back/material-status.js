// ================================================================
// material-status.js — "este material FOI, NAO FOI ou ficou PENDENTE"
// ----------------------------------------------------------------
// Marcacao item a item dos materiais da planilha "RETIRADA E ENVIO DE
// MATERIAL" (formulario de ocorrencia e relatorio de material), tabela
// material_item_status. Inclui as retiradas descritas na propria ocorrencia,
// mesmo quando nao existe item correspondente na planilha da expedicao.
// E daqui sai, sozinha, a planilha
// "STATUS DO MATERIAL - <MES> <ANO>.xlsx" na sala Expedicao do OnlyOffice:
// todos os itens do mes com a situacao, quem marcou e quando. A planilha da
// EQUIPE nunca e alterada (decisao do usuario em 02/10/2026: ela fica aberta
// em edicao e regravar por cima arriscaria apagar o trabalho de alguem).
//
// Sincronia: 2 min depois da ultima marcacao do mes + de hora em hora
// (mes atual; nos 7 primeiros dias, o anterior tambem). So sobe se o
// conteudo mudou. DESLIGADO por padrao (decisao do usuario em 05/10/2026:
// nada e criado no OnlyOffice sem permissao dele); so liga com
// MATERIAL_STATUS_ONLYOFFICE=1 no .env.
// ================================================================

const crypto = require("crypto");
const XLSX = require("xlsx");
const materiaisRota = require("./materiais-rota");
const materialFormulario = require("./material-formulario");
const onlyoffice = require("./onlyoffice");

const MESES = ["JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO", "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO"];
const STATUS_VALIDOS = ["ok", "nao", "pendente"];
const ROTULO_GRUPO = { ok: "✅", falha: "❌", parcial: "⚠️", pendente: "⏳", aberto: "❔" };

let deps = null; // { db, lojasPes, chaveLoja }
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const br = (s) => String(s || "").replace(/^(\d{4})-(\d{2})-(\d{2}).*/, "$3/$2/$1");

function configurar(d) { deps = d; }

async function contexto() {
  const idx = await deps.lojasPes.carregarIndice(deps.db);
  const codigoLoja = (nome) => { const l = idx ? idx.resolver(nome) : null; return l ? `PES:${l.codigo}` : deps.chaveLoja(nome); };
  const nomeLoja = (nome) => (idx && idx.resolver(nome)?.nome) || nome;
  return { idx, codigoLoja, nomeLoja };
}

// Marcacoes de um periodo (e opcionalmente de uma loja) -> { mapa, linhas }.
async function carregarMarcados(de, ate, lojaCodigo = null, incluirAnteriores = false, incluirFormulario = false) {
  const params = [de, ate];
  let filtro = "";
  if (lojaCodigo) { params.push(lojaCodigo); filtro = "AND loja_codigo = $3"; }
  const r = await deps.db.query(`
    SELECT chave, to_char(data,'YYYY-MM-DD') AS data, tipo, loja_codigo, loja, loja_planilha, material,
           quantidade, transacao, status, observacao, to_char(resolvido_em_data,'YYYY-MM-DD') AS resolvido_em_data,
           ocorrencia_id, usuario_nome, manual, to_char(atualizado_em,'DD/MM/YYYY HH24:MI') AS atualizado_em
      FROM material_item_status
     WHERE (data BETWEEN $1 AND $2 ${incluirAnteriores ? "OR (manual = TRUE AND data < $1 AND status IN ('nao','pendente'))" : ""}
       ${incluirFormulario ? "OR chave LIKE 'ocorrencia|%'" : ""}) ${filtro}`, params);
  return { mapa: new Map(r.rows.map((x) => [x.chave, x])), linhas: r.rows };
}

// Relatorio do periodo ja com as marcacoes item a item.
async function relatorioPeriodo(de, ate, { incluirAnteriores = false } = {}) {
  const [ctx, periodo, oc, marc] = await Promise.all([
    contexto(),
    materiaisRota.itensDoPeriodo(de, ate).catch(() => ({ itens: [], pendentes: [],
      aviso: 'Não foi possível ler a planilha da expedição. Os lançamentos manuais continuam disponíveis.' })),
    deps.db.query(`
      SELECT id, to_char(data_ocorrencia,'YYYY-MM-DD') AS data, loja, rota, motorista,
             material_envio_status, material_envio_relato, material_retirada_status, material_retirada_relato
        FROM ocorrencias
       WHERE excluida_em IS NULL AND loja IS NOT NULL
         AND (data_ocorrencia BETWEEN $1 AND $2
           OR ($3::boolean AND data_ocorrencia < $1 AND material_retirada_status IN ('incorreta','parcial')))`, [de, ate, incluirAnteriores]),
    carregarMarcados(de, ate, null, incluirAnteriores, true),
  ]);
  const itens = [...periodo.itens];
  const chaves = new Set(itens.map(i => materiaisRota.chaveItem(i.data, i.tipo, ctx.codigoLoja(i.loja), i.material, i.transacao)));
  for (const m of marc.linhas) {
    if (!m.manual || chaves.has(m.chave)) continue;
    itens.push({ data: m.data, tipo: m.tipo, loja: m.loja_planilha || m.loja, material: m.material,
      quantidade: m.quantidade, transacao: m.transacao });
    chaves.add(m.chave);
  }
  const r = materiaisRota.montarRelatorio({ ...periodo, itens }, oc.rows, ctx.codigoLoja, ctx.nomeLoja, marc.mapa);
  r.linhas = r.linhas.map(l => ({ ...l, manual: !!marc.mapa.get(l.chave)?.manual,
    resolvido_em_data: marc.mapa.get(l.chave)?.resolvido_em_data || null }));
  r.linhas.push(...materialFormulario.montarLinhas(oc.rows, marc.mapa, {de,ate,codigoLoja:ctx.codigoLoja,nomeLoja:ctx.nomeLoja}));
  r.linhas.sort((a,b)=>a.data.localeCompare(b.data) || a.loja.localeCompare(b.loja));
  r.resumo = {total:r.linhas.length,ok:0,falha:0,parcial:0,pendente:0,aberto:0,envio:0,retirada:0};
  for (const l of r.linhas) {r.resumo[l.grupo]++;r.resumo[l.tipo]++;}
  return { ...r, manual_disponivel: true, arquivo_pendentes: periodo.arquivoPendentes, aviso_planilha: periodo.aviso || null };
}

// Anota chave + marcacao em itens de um dia de UMA loja (formulario).
async function anotarItens(data, itens, lojaCodigo) {
  if (!itens.length) return itens;
  const ctx = await contexto();
  const { mapa } = await carregarMarcados(data, data, lojaCodigo).catch(() => ({ mapa: new Map() }));
  return itens.map((i) => {
    const chave = materiaisRota.chaveItem(data, i.tipo, ctx.codigoLoja(i.loja), i.material, i.transacao);
    const m = mapa.get(chave);
    return { ...i, data, chave, status_item: m?.status || null, manual: !!m?.manual, obs_item: m?.observacao || null, marcado_por: m?.usuario_nome || null, marcado_em: m?.atualizado_em || null };
  });
}

// Tudo de material de UMA loja num dia: itens do dia (com marcacao) +
// pendencias de visitas anteriores (30 dias). Usado pelo formulario de
// ocorrencia, pela capa da frente e pelo card do TMS.
async function materialDaLoja(data, loja) {
  const ctx = await contexto();
  const lojaCodigo = ctx.codigoLoja(loja);
  const mesmaLoja = (nome) => ctx.codigoLoja(nome) === lojaCodigo;
  const r = await materiaisRota.materiaisDaLoja(data, mesmaLoja).catch(() => ({ envio: [], retirada: [], pendentes: [] }));
  try {
    const { linhas } = await carregarMarcados(data, data, lojaCodigo);
    const itens = [...r.envio, ...r.retirada];
    const chaves = new Set(itens.map(i => materiaisRota.chaveItem(data, i.tipo, lojaCodigo, i.material, i.transacao)));
    for (const m of linhas) if (m.manual && !chaves.has(m.chave)) {
      itens.push({ tipo: m.tipo, loja: m.loja_planilha || m.loja, material: m.material, quantidade: m.quantidade, transacao: m.transacao });
      chaves.add(m.chave);
    }
    const anotados = await anotarItens(data, itens, lojaCodigo);
    r.envio = anotados.filter((i) => i.tipo === "envio");
    r.retirada = anotados.filter((i) => i.tipo === "retirada");
  } catch (e) { console.error("[material-status marcacoes]", e.message); }
  let anteriores = [];
  try {
    const d0 = new Date(`${data}T12:00:00Z`);
    const inicio = new Date(d0.getTime() - 30 * 86400000).toISOString().slice(0, 10);
    const vespera = new Date(d0.getTime() - 86400000).toISOString().slice(0, 10);
    const marc = await carregarMarcados(inicio, vespera, lojaCodigo, true).catch(() => ({ mapa: new Map(), linhas: [] }));
    const chaveDe = (i, d) => materiaisRota.chaveItem(d, i.tipo, ctx.codigoLoja(i.loja), i.material, i.transacao);
    const oc = await deps.db.query(`
      SELECT id, to_char(data_ocorrencia, 'YYYY-MM-DD') AS data, loja,
             material_envio_status, material_envio_relato, material_retirada_status, material_retirada_relato
        FROM ocorrencias
       WHERE excluida_em IS NULL AND loja IS NOT NULL
         AND data_ocorrencia BETWEEN $1::date - 30 AND $1::date
         AND (material_envio_status IN ('correta','parcial','incorreta')
              OR material_retirada_status IN ('correta','parcial','incorreta'))`, [data]);
    anteriores = await materiaisRota.pendenciasAnteriores(data, oc.rows.filter((o) => mesmaLoja(o.loja)), mesmaLoja,
      { chaveDe, marcados: marc.mapa, marcadosDaLoja: marc.linhas });
  } catch (e) { console.error("[material-status anteriores]", e.message); }
  return { data, loja: ctx.nomeLoja(loja), loja_codigo: lojaCodigo, ...r, anteriores };
}

// Resumo curto (contagens) para card/alerta.
function resumir(m) {
  const pend = (m.anteriores || []).reduce((s, g) => s + Math.max(1, (g.itens || []).length), 0);
  return {
    entregar: m.envio.length, retirar: m.retirada.length, pendentes_anteriores: pend,
    marcados_ok: [...m.envio, ...m.retirada].filter((i) => i.status_item === "ok").length,
  };
}

// Alerta "material sem rota": a planilha manda entregar/retirar numa loja que
// NENHUMA viagem daquele dia visita (sem isso o material fica para tras e
// ninguem percebe ate a loja reclamar). Avalia hoje + 3 dias, so os dias que
// ja tem viagem no TMS (programacao importada). Itens ja marcados "foi" nao
// contam. Devolve candidatos no formato do motor de alertas + datas avaliadas
// (para o motor resolver sozinho quando a loja entrar numa viagem).
const normLoja = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase()
  .replace(/[_\-.]/g, " ").replace(/\s+/g, " ").trim();
// "MADUREIRA II" / "Madureira 2" -> "MADUREIRA"
const semNumeroLoja = (s) => normLoja(s).replace(/\s+(I{1,3}|IV|V|VI{1,3}|IX|X|\d{1,2})$/, "").trim();

async function alertasForaDaRota({ datas: datasFixas } = {}) {
  // datasFixas: so para teste/diagnostico (avaliar um dia especifico).
  const dias = datasFixas ? { rows: datasFixas.map((d) => ({ d })) } : await deps.db.query(`
    SELECT DISTINCT to_char(data_viagem,'YYYY-MM-DD') AS d FROM tms_viagens
     WHERE data_viagem BETWEEN CURRENT_DATE AND CURRENT_DATE + 3 AND COALESCE(status,'') <> 'Cancelada'
     ORDER BY 1`);
  const ctx = await contexto();
  const candidatos = [], datas = [];
  for (const { d } of dias.rows) {
    let itens;
    try { itens = (await materiaisRota.itensDoDia(d)).itens; } catch (_) { continue; } // planilha fora do ar: nao avalia o dia
    datas.push(d);
    if (!itens.length) continue;
    const paradas = await deps.db.query(`
      SELECT DISTINCT p.loja_nome FROM tms_paradas p JOIN tms_viagens v ON v.id = p.viagem_id
       WHERE v.data_viagem = $1 AND COALESCE(v.status,'') <> 'Cancelada' AND p.loja_nome IS NOT NULL`, [d]);
    const naRota = new Set(paradas.rows.map((x) => ctx.codigoLoja(x.loja_nome)));
    // Planilha sem o numero da loja ("madureira") + rota com Madureira I/II/IV:
    // ambiguo, conta como na rota (30/09/2026 gerava alerta falso assim).
    const baseRota = new Set(paradas.rows.map((x) => semNumeroLoja(x.loja_nome)));
    const { mapa } = await carregarMarcados(d, d).catch(() => ({ mapa: new Map() }));
    const fora = new Map(); // codigo -> { nome, itens }
    for (const i of itens) {
      const cod = ctx.codigoLoja(i.loja);
      if (naRota.has(cod)) continue;
      const base = semNumeroLoja(i.loja);
      if (base === normLoja(i.loja) && baseRota.has(base)) continue; // sem numero e o nome-base esta na rota
      if (mapa.get(materiaisRota.chaveItem(d, i.tipo, cod, i.material, i.transacao))?.status === "ok") continue;
      if (!fora.has(cod)) fora.set(cod, { nome: ctx.nomeLoja(i.loja), itens: [] });
      fora.get(cod).itens.push(i);
    }
    const dm = d.slice(8, 10) + "/" + d.slice(5, 7);
    for (const [cod, f] of fora) {
      const amostra = f.itens.slice(0, 2).map((i) => `${i.tipo === "retirada" ? "retirar" : "entregar"} ${i.material}`).join("; ");
      candidatos.push({
        chave: `mat-fora-rota-${d}-${cod}`, tipo: "material_fora_rota", severidade: "media",
        titulo: `Material sem rota: ${String(f.nome).replace(/_/g, " ")} em ${dm}`,
        detalhe: `${f.itens.length} item(ns) na planilha (${amostra.slice(0, 120)}${f.itens.length > 2 ? "…" : ""}), mas a loja não está em nenhuma viagem do dia`,
        aba: "tms", ocorrencia_id: null, evento_em: d,
      });
    }
  }
  return { candidatos, datas };
}

// Grava (ou apaga, com status vazio) a marcacao de UM item.
async function marcar(body, usuario) {
  let data = String(body?.data || "").slice(0, 10);
  const tipo = String(body?.tipo || "");
  let loja = String(body?.loja || "").trim();
  let material = String(body?.material || "").trim();
  const status = String(body?.status || "").trim();
  const dataVisita = String(body?.data_visita || "").slice(0, 10);
  const manual = body?.manual === true;
  let formulario = null;
  if (body?.fonte_formulario === true) {
    const id = Number(body.ocorrencia_id);
    if (manual || tipo !== 'retirada' || !Number.isInteger(id) || id <= 0) {
      const e = new Error('Ocorrência de retirada inválida.'); e.status=400; throw e;
    }
    const o = await deps.db.query(`SELECT id, to_char(data_ocorrencia,'YYYY-MM-DD') AS data, loja,
      material_retirada_status, material_retirada_relato FROM ocorrencias WHERE id=$1 AND excluida_em IS NULL`,[id]);
    formulario = materialFormulario.registro(o.rows[0]);
    if (!formulario) {const e = new Error('A ocorrência não possui uma retirada pendente anotada.');e.status=400;throw e;}
    data=formulario.data;loja=formulario.loja;material=formulario.material;
  }
  const dataValida = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
  if (!dataValida(data) || !["envio", "retirada"].includes(tipo) || !loja || !material) {
    const e = new Error("Item inválido (data, tipo, loja e material são obrigatórios)."); e.status = 400; throw e;
  }
  if (status && !STATUS_VALIDOS.includes(status)) { const e = new Error("Status inválido."); e.status = 400; throw e; }
  if (manual && (tipo !== 'retirada' || status !== 'pendente' || loja.length > 200 || material.length > 200
    || String(body?.quantidade ?? '').length > 80 || String(body?.transacao || '').length > 100)) {
    const e = new Error('Dados inválidos para registrar a retirada pendente.'); e.status = 400; throw e;
  }
  if (dataVisita && !dataValida(dataVisita)) { const e = new Error('Data de retirada inválida.'); e.status = 400; throw e; }
  const ctx = await contexto();
  const lojaCodigo = ctx.codigoLoja(loja);
  const transacao = formulario ? null : String(body?.transacao || "").trim() || null;
  const chave = formulario?.chave || materiaisRota.chaveItem(data, tipo, lojaCodigo, material, transacao);
  if (!status) {
    const item = await deps.db.query('SELECT manual FROM material_item_status WHERE chave = $1', [chave]);
    if (item.rows[0]?.manual) { const e = new Error('Mantenha o item como pendente ou confirme a retirada.'); e.status = 400; throw e; }
    await deps.db.query("DELETE FROM material_item_status WHERE chave = $1 AND manual = FALSE", [chave]);
    agendarSync(data.slice(0, 7));
    return { chave, removido: true };
  }
  const resolvido = status === "ok" && dataValida(dataVisita) && dataVisita >= data ? dataVisita : null;
  const ocorrenciaId = formulario?.ocorrencia_id || (Number.isInteger(Number(body?.ocorrencia_id)) && Number(body.ocorrencia_id) > 0 ? Number(body.ocorrencia_id) : null);
  const r = await deps.db.query(`
    INSERT INTO material_item_status
      (chave, data, tipo, loja_codigo, loja, loja_planilha, material, quantidade, transacao, status, observacao,
       resolvido_em_data, ocorrencia_id, usuario_id, usuario_nome, manual, atualizado_em)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
    ON CONFLICT (chave) DO UPDATE SET
      -- observacao vazia mantem a anterior (marcar "foi" depois nao apaga o "por que nao foi")
      status = EXCLUDED.status, observacao = COALESCE(EXCLUDED.observacao, material_item_status.observacao),
      resolvido_em_data = EXCLUDED.resolvido_em_data,
      ocorrencia_id = COALESCE(EXCLUDED.ocorrencia_id, material_item_status.ocorrencia_id),
      data = EXCLUDED.data, loja_codigo = EXCLUDED.loja_codigo, loja = EXCLUDED.loja, loja_planilha = EXCLUDED.loja_planilha, material = EXCLUDED.material,
      quantidade = EXCLUDED.quantidade, usuario_id = EXCLUDED.usuario_id, usuario_nome = EXCLUDED.usuario_nome,
      atualizado_em = NOW(), manual = material_item_status.manual OR EXCLUDED.manual
    WHERE NOT $16::boolean
    RETURNING chave, status, manual, observacao, to_char(resolvido_em_data,'YYYY-MM-DD') AS resolvido_em_data, usuario_nome, to_char(atualizado_em,'DD/MM/YYYY HH24:MI') AS atualizado_em`,
    [chave, data, tipo, lojaCodigo, ctx.nomeLoja(loja), loja, material, formulario ? null : String(body?.quantidade ?? "").trim() || null,
      transacao, status, String(body?.observacao || "").trim().slice(0, 500) || null, resolvido, ocorrenciaId,
      usuario?.id || null, usuario?.nome || null, manual]);
  if (!r.rows.length) { const e = new Error('Este material já foi registrado para essa loja e data. Atualize o item existente.'); e.status = 409; throw e; }
  agendarSync(data.slice(0, 7));
  return r.rows[0];
}

// ---------------------------------------------------------------- planilha no OnlyOffice
const nomePlanilha = (ano, mes) => `STATUS DO MATERIAL - ${MESES[mes - 1]} ${ano}.xlsx`;

async function montarPlanilhaMes(ano, mes) {
  const de = `${ano}-${String(mes).padStart(2, "0")}-01`;
  const ate = iso(new Date(ano, mes, 0));
  const r = await relatorioPeriodo(de, ate);
  // Uma leitura incompleta não deve substituir a planilha mensal já publicada.
  if (r.aviso_planilha) throw new Error(r.aviso_planilha);
  const cab = ["Data", "Tipo", "Loja", "Material", "Qtd", "Transação", "Situação", "Marcado por", "Em", "Observação", "Relato na ocorrência", "Ocorrência"];
  const linhas = r.linhas.map((l) => [
    br(l.data), l.tipo === "envio" ? "Envio" : "Retirada", l.loja, l.material, l.quantidade || "", l.transacao || "",
    `${ROTULO_GRUPO[l.grupo] || ""} ${l.situacao}`.trim(), l.marcado_por || (l.fonte === "loja" ? "(conferência da ocorrência)" : l.fonte === "planilha" ? "(status escrito na planilha)" : ""),
    l.marcado_em || "", l.obs_item || "", l.relato_loja || "", l.ocorrencia_id || "",
  ]);
  const conteudoHash = crypto.createHash("sha1").update(JSON.stringify([linhas, r.pendentes])).digest("hex");
  const agora = new Date();
  const aviso = `Gerada automaticamente pelo Controle de Entrega em ${agora.toLocaleString("pt-BR")} — NÃO EDITE: esta planilha é refeita a cada marcação. Para marcar foi/não foi/pendente, use o sistema (formulário de ocorrência ou 📦 Relatório de material).`;
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([[aviso], [], cab, ...linhas]);
  ws["!cols"] = [11, 9, 22, 44, 7, 12, 22, 22, 17, 30, 30, 11].map((w) => ({ wch: w }));
  ws["!autofilter"] = { ref: `A3:L${3 + linhas.length}` };
  XLSX.utils.book_append_sheet(wb, ws, "Status por item");
  const res = r.resumo;
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    [`${MESES[mes - 1]} ${ano}`, "Itens"],
    ["✅ Foi", res.ok], ["❌ Não foi", res.falha], ["⏳ Pendente", res.pendente || 0], ["⚠️ Parcial", res.parcial], ["❔ Sem confirmação", res.aberto],
    ["Total", res.total], [], ["Atualizada em", agora.toLocaleString("pt-BR")],
  ]), "Resumo");
  if (r.pendentes.length) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ["Tipo", "Loja", "Material", "Qtd", "Transação", "Data da TR", "Obs. na planilha"],
      ...r.pendentes.map((p) => [p.tipo === "envio" ? "Envio" : "Retirada", p.loja, p.material, p.quantidade || "", p.transacao || "", p.data_tr || "", p.obs_planilha || ""]),
    ]), "Aba PENDENTES (sem dia)");
  }
  return { nome: nomePlanilha(ano, mes), buffer: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }), hash: conteudoHash, itens: linhas.length };
}

const ultimoHash = new Map(); // nome -> hash do ultimo envio
let ultimaSync = null;

function ativo() {
  return onlyoffice.configurado() && /^(1|true|sim|on)$/i.test(String(process.env.MATERIAL_STATUS_ONLYOFFICE || "").trim());
}

async function sincronizarMes(ano, mes, { forcar = false } = {}) {
  const p = await montarPlanilhaMes(ano, mes);
  if (!p.itens) return { nome: p.nome, enviado: false, motivo: "mês sem itens na planilha" };
  if (!forcar && ultimoHash.get(p.nome) === p.hash) return { nome: p.nome, enviado: false, motivo: "sem mudança" };
  const r = await onlyoffice.salvarNaSala(p.nome, p.buffer);
  ultimoHash.set(p.nome, p.hash);
  ultimaSync = { em: new Date().toISOString(), nome: p.nome, itens: p.itens, ...r };
  console.log(`[material-status] ${p.nome} atualizada no OnlyOffice (${p.itens} itens, versão ${r.versao ?? "?"})`);
  return { nome: p.nome, enviado: true, itens: p.itens, ...r };
}

const sujos = new Set();
let timerSync = null, sincronizando = false;
function agendarSync(anoMes) {
  if (!ativo() || !/^\d{4}-\d{2}$/.test(anoMes)) return;
  sujos.add(anoMes);
  clearTimeout(timerSync);
  timerSync = setTimeout(sincronizarSujos, 2 * 60 * 1000);
  timerSync.unref?.();
}
async function sincronizarSujos() {
  if (sincronizando) { agendarSync([...sujos][0] || ""); return; }
  sincronizando = true;
  try {
    for (const am of [...sujos]) {
      sujos.delete(am);
      const [a, m] = am.split("-").map(Number);
      await sincronizarMes(a, m).catch((e) => console.error(`[material-status] ${am}:`, e.message));
    }
  } finally { sincronizando = false; }
}

function iniciar(d) {
  configurar(d);
  if (!ativo()) return;
  const rodada = () => {
    const hoje = new Date();
    sujos.add(iso(hoje).slice(0, 7));
    if (hoje.getDate() <= 7) sujos.add(iso(new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1)).slice(0, 7));
    sincronizarSujos().catch(() => {});
  };
  setTimeout(rodada, 3 * 60 * 1000).unref?.();
  setInterval(rodada, 60 * 60 * 1000).unref?.();
}

const estado = () => ({ ativo: ativo(), ultima_sync: ultimaSync, pendentes_de_envio: [...sujos] });

module.exports = { configurar, iniciar, marcar, anotarItens, carregarMarcados, relatorioPeriodo, montarPlanilhaMes, sincronizarMes, estado, contexto, materialDaLoja, resumir, alertasForaDaRota };
