// ================================================================
// relatorio-semanal.js — pacote da semana pronto na segunda de manha
// ----------------------------------------------------------------
// Toda segunda (a partir das 07:00) o servidor gera uma planilha da semana
// ANTERIOR (segunda a domingo) com:
//   Resumo (com a semana de antes ao lado), Por motorista, Por loja,
//   Problemas da semana, Material que nao foi, Paradas sem registro.
// Salva em relatorios/semanal (sempre) e copia para a pasta do file server
// (RELATORIO_SEMANAL_PASTA, padrao: expedicao\{ANO}\RELATORIO SEMANAL -
// CONTROLE DE ENTREGA). Com Telegram configurado, manda o arquivo tambem.
// Se o servidor estava fora na segunda, gera assim que voltar (checa de hora
// em hora se o arquivo da semana passada existe). Nada e apagado.
// ================================================================

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

const PASTA_LOCAL = path.join(__dirname, "..", "relatorios", "semanal");
const PASTA_REDE_PADRAO = "\\\\empresa.local\\fileserver\\expedicao\\{ANO}\\RELATORIO SEMANAL - CONTROLE DE ENTREGA";
const HORA_GERAR = 7;
const NOME_RE = /^relatorio-semanal_(\d{4}-\d{2}-\d{2})_a_(\d{4}-\d{2}-\d{2})\.xlsx$/;

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const br = (s) => String(s || "").replace(/^(\d{4})-(\d{2})-(\d{2}).*/, "$3/$2/$1");
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const nomeArquivo = (de, ate) => `relatorio-semanal_${de}_a_${ate}.xlsx`;

// Segunda a domingo da semana anterior a `hoje`.
function semanaAnterior(hoje = new Date()) {
  const d = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  const diaSemana = (d.getDay() + 6) % 7; // 0 = segunda
  const segundaAtual = new Date(d); segundaAtual.setDate(d.getDate() - diaSemana);
  const de = new Date(segundaAtual); de.setDate(segundaAtual.getDate() - 7);
  const ate = new Date(segundaAtual); ate.setDate(segundaAtual.getDate() - 1);
  return { de: iso(de), ate: iso(ate) };
}
function deslocar(dataIso, dias) {
  const [a, m, d] = dataIso.split("-").map(Number);
  return iso(new Date(a, m - 1, d + dias));
}

async function indicadores(db, de, ate) {
  const r = await db.query(`
    SELECT COUNT(*)::int AS entregas,
           COUNT(*) FILTER (WHERE teve_ocorrencia)::int AS com_problema,
           COUNT(*) FILTER (WHERE sla_status = 'No prazo')::int AS no_prazo,
           COUNT(*) FILTER (WHERE sla_status = 'Atrasada')::int AS atrasadas,
           COUNT(*) FILTER (WHERE otif_status = 'Conforme')::int AS otif_ok,
           COUNT(*) FILTER (WHERE otif_status = 'Nao conforme')::int AS otif_nok,
           COUNT(*) FILTER (WHERE entrega_completa)::int AS completas,
           COUNT(*) FILTER (WHERE teve_ocorrencia AND NULLIF(TRIM(COALESCE(ocorrencia_responsavel,'')),'') IS NULL)::int AS sem_resp,
           COALESCE(SUM(custo_total), 0)::numeric AS custo
      FROM ocorrencias
     WHERE excluida_em IS NULL AND data_ocorrencia BETWEEN $1 AND $2`, [de, ate]);
  const p = await db.query(`
    SELECT COUNT(*)::int AS paradas,
           COUNT(*) FILTER (WHERE p.ocorrencia_id IS NULL
             AND COALESCE(p.status,'') NOT IN ('Entregue','Entregue com ocorrencia','Recusada','Ocorrencia'))::int AS sem_registro
      FROM tms_paradas p JOIN tms_viagens v ON v.id = p.viagem_id
     WHERE v.data_viagem BETWEEN $1 AND $2 AND COALESCE(v.status,'') <> 'Cancelada'`, [de, ate]);
  return { ...r.rows[0], ...p.rows[0] };
}

function linhasResumo(a, b, material) {
  const linha = (nome, atual, antes, fmt = (x) => x) => ({
    Indicador: nome, "Semana": atual == null ? "—" : fmt(atual), "Semana anterior": antes == null ? "—" : fmt(antes),
  });
  const p100 = (x) => `${String(x).replace(".", ",")}%`;
  const comPrazo = (i) => i.no_prazo + i.atrasadas;
  const out = [
    linha("Entregas registradas", a.entregas, b.entregas),
    linha("Entregas com problema", a.com_problema, b.com_problema),
    linha("% com problema", pct(a.com_problema, a.entregas), pct(b.com_problema, b.entregas), p100),
    linha("No prazo (SLA)", a.no_prazo, b.no_prazo),
    linha("Atrasadas (SLA)", a.atrasadas, b.atrasadas),
    linha("% no prazo (entre as que têm horário)", pct(a.no_prazo, comPrazo(a)), pct(b.no_prazo, comPrazo(b)), p100),
    linha("% OTIF conforme", pct(a.otif_ok, a.otif_ok + a.otif_nok), pct(b.otif_ok, b.otif_ok + b.otif_nok), p100),
    linha("% In Full (entrega completa)", pct(a.completas, a.entregas), pct(b.completas, b.entregas), p100),
    linha("Problemas sem responsável", a.sem_resp, b.sem_resp),
    linha("Paradas do TMS", a.paradas, b.paradas),
    linha("Paradas sem registro", a.sem_registro, b.sem_registro),
    linha("Custo apurado (R$)", Number(a.custo), Number(b.custo), (x) => x.toFixed(2)),
  ];
  if (material) {
    out.push(linha("Material: itens na planilha", material.total, null));
    out.push(linha("Material: foi", material.ok, null));
    out.push(linha("Material: NÃO foi", material.falha, null));
    out.push(linha("Material: pendente (vai na próxima)", material.pendente || 0, null));
    out.push(linha("Material: parcial", material.parcial, null));
    out.push(linha("Material: sem confirmação", material.aberto, null));
  }
  return out;
}

async function porMotorista(db, de, ate) {
  const r = await db.query(`
    SELECT COALESCE(NULLIF(TRIM(motorista),''),'(sem motorista)') AS motorista,
           COUNT(*)::int AS entregas,
           COUNT(*) FILTER (WHERE sla_status = 'No prazo')::int AS no_prazo,
           COUNT(*) FILTER (WHERE sla_status = 'Atrasada')::int AS atrasadas,
           COUNT(*) FILTER (WHERE teve_ocorrencia)::int AS com_problema
      FROM ocorrencias WHERE excluida_em IS NULL AND data_ocorrencia BETWEEN $1 AND $2
     GROUP BY 1 ORDER BY atrasadas DESC, entregas DESC`, [de, ate]);
  return r.rows.map((x) => ({
    Motorista: x.motorista, Entregas: x.entregas, "No prazo": x.no_prazo, Atrasadas: x.atrasadas,
    "% no prazo": pct(x.no_prazo, x.no_prazo + x.atrasadas) ?? "", "Com problema": x.com_problema,
  }));
}

async function porLoja(db, de, ate) {
  const r = await db.query(`
    SELECT COALESCE(NULLIF(TRIM(loja),''),'(sem loja)') AS loja,
           COUNT(*)::int AS entregas,
           COUNT(*) FILTER (WHERE sla_status = 'No prazo')::int AS no_prazo,
           COUNT(*) FILTER (WHERE sla_status = 'Atrasada')::int AS atrasadas,
           COUNT(*) FILTER (WHERE teve_ocorrencia)::int AS com_problema,
           STRING_AGG(DISTINCT NULLIF(TRIM(tipo_problema),''), ' | ') AS tipos
      FROM ocorrencias WHERE excluida_em IS NULL AND data_ocorrencia BETWEEN $1 AND $2
     GROUP BY 1 ORDER BY com_problema DESC, atrasadas DESC, entregas DESC`, [de, ate]);
  return r.rows.map((x) => ({
    Loja: String(x.loja).replace(/_/g, " "), Entregas: x.entregas, "No prazo": x.no_prazo, Atrasadas: x.atrasadas,
    "% no prazo": pct(x.no_prazo, x.no_prazo + x.atrasadas) ?? "", "Com problema": x.com_problema, "Tipos de problema": x.tipos || "",
  }));
}

async function problemas(db, de, ate) {
  const r = await db.query(`
    SELECT id, to_char(data_ocorrencia,'YYYY-MM-DD') AS data, loja, rota, motorista, tipo_problema,
           ocorrencia_responsavel, ocorrencia_status, sla_status, descricao
      FROM ocorrencias
     WHERE excluida_em IS NULL AND teve_ocorrencia AND data_ocorrencia BETWEEN $1 AND $2
     ORDER BY data_ocorrencia, id`, [de, ate]);
  return r.rows.map((x) => ({
    Data: br(x.data), "Ocorrência": x.id, Loja: String(x.loja || "").replace(/_/g, " "), Rota: x.rota || "",
    Motorista: x.motorista || "", Tipo: x.tipo_problema || "", "Responsável": x.ocorrencia_responsavel || "(sem responsável)",
    Status: x.ocorrencia_status || "", SLA: x.sla_status || "", Relato: String(x.descricao || "").slice(0, 500),
  }));
}

async function paradasSemRegistro(db, de, ate) {
  const r = await db.query(`
    SELECT to_char(v.data_viagem,'YYYY-MM-DD') AS data, v.rota_nome, v.motorista_nome, v.placa, p.loja_nome, p.status
      FROM tms_paradas p JOIN tms_viagens v ON v.id = p.viagem_id
     WHERE v.data_viagem BETWEEN $1 AND $2 AND COALESCE(v.status,'') <> 'Cancelada'
       AND p.ocorrencia_id IS NULL
       AND COALESCE(p.status,'') NOT IN ('Entregue','Entregue com ocorrencia','Recusada','Ocorrencia')
     ORDER BY v.data_viagem, v.rota_nome, p.ordem`, [de, ate]);
  return r.rows.map((x) => ({
    Data: br(x.data), Rota: x.rota_nome || "", Motorista: x.motorista_nome || "", Placa: x.placa || "",
    Loja: x.loja_nome || "", "Status da parada": x.status || "",
  }));
}

// Material da semana (planilha x conferencia), via materiais-rota.js.
// Inclui a marcacao item a item (foi/nao foi/pendente) de material-status.js.
async function material(deps, de, ate) {
  const r = await require("./material-status").relatorioPeriodo(de, ate);
  const ordem = { falha: 0, pendente: 1, parcial: 2, aberto: 3 };
  const linhas = r.linhas.filter((l) => l.grupo !== "ok")
    .sort((a, b) => ordem[a.grupo] - ordem[b.grupo] || (a.data < b.data ? -1 : 1))
    .map((l) => ({
      Data: br(l.data), Tipo: l.tipo === "envio" ? "Envio" : "Retirada", Loja: l.loja, Material: l.material,
      Quantidade: l.quantidade || "", "Situação": l.situacao, "Relato": l.relato_loja || "", "Ocorrência": l.ocorrencia_id || "",
    }));
  return { resumo: r.resumo, linhas };
}

function folha(wb, nome, linhas, larguras) {
  const ws = XLSX.utils.json_to_sheet(linhas.length ? linhas : [{ Aviso: "Nada nesta semana" }]);
  if (larguras) ws["!cols"] = larguras.map((w) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, nome.slice(0, 31));
}

async function montarPlanilha(deps, de, ate) {
  const { db } = deps;
  const antesDe = deslocar(de, -7), antesAte = deslocar(ate, -7);
  const [a, b, mot, loja, prob, semReg] = await Promise.all([
    indicadores(db, de, ate), indicadores(db, antesDe, antesAte),
    porMotorista(db, de, ate), porLoja(db, de, ate), problemas(db, de, ate), paradasSemRegistro(db, de, ate),
  ]);
  let mat = null;
  try { mat = await material(deps, de, ate); } catch (e) { console.error("[relatorio-semanal] material:", e.message); }
  const wb = XLSX.utils.book_new();
  folha(wb, "Resumo", [
    { Indicador: `Semana de ${br(de)} a ${br(ate)}`, "Semana": "", "Semana anterior": `${br(antesDe)} a ${br(antesAte)}` },
    ...linhasResumo(a, b, mat && mat.resumo),
  ], [42, 14, 22]);
  folha(wb, "Por motorista", mot, [30, 10, 10, 10, 12, 13]);
  folha(wb, "Por loja", loja, [26, 10, 10, 10, 12, 13, 50]);
  folha(wb, "Problemas", prob, [11, 11, 22, 18, 24, 34, 28, 12, 11, 60]);
  folha(wb, "Material pendente", mat ? mat.linhas : [], [11, 9, 22, 40, 11, 22, 40, 11]);
  folha(wb, "Paradas sem registro", semReg, [11, 18, 24, 10, 26, 16]);
  const texto = [
    `📊 Relatório semanal — ${br(de)} a ${br(ate)}`,
    `• Entregas: ${a.entregas} (semana anterior ${b.entregas})`,
    `• No prazo: ${pct(a.no_prazo, a.no_prazo + a.atrasadas) ?? "—"}% (antes ${pct(b.no_prazo, b.no_prazo + b.atrasadas) ?? "—"}%)`,
    `• Com problema: ${a.com_problema} · sem responsável: ${a.sem_resp}`,
    `• Paradas sem registro: ${a.sem_registro} de ${a.paradas}`,
    mat ? `• Material que não foi: ${mat.resumo.falha} · parcial ${mat.resumo.parcial} · sem confirmação ${mat.resumo.aberto}` : null,
  ].filter(Boolean).join("\n");
  return { buffer: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }), texto };
}

// Copia para a rede SO se RELATORIO_SEMANAL_PASTA estiver no .env (decisao do
// usuario em 05/10/2026: nada e criado na rede sem permissao dele).
// PASTA_REDE_PADRAO fica so como sugestao de valor.
function pastaRede(ano) {
  const v = String(process.env.RELATORIO_SEMANAL_PASTA ?? "").trim();
  return v ? v.replace(/\{ANO\}/g, String(ano)) : null; // vazio = nao copia
}

async function enviarTelegramArquivo(buffer, nome, legenda) {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = String(process.env.TELEGRAM_CHAT_ID || "").trim();
  if (!token || !chatId) return false;
  try {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("caption", legenda.slice(0, 1000));
    form.append("document", new Blob([buffer]), nome);
    const r = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: form });
    if (!r.ok) console.error("[relatorio-semanal] telegram HTTP", r.status);
    return r.ok;
  } catch (e) { console.error("[relatorio-semanal] telegram:", e.message); return false; }
}

// Gera, salva (local + rede) e avisa. Devolve onde ficou.
async function gerar(deps, { de, ate } = semanaAnterior()) {
  const { buffer, texto } = await montarPlanilha(deps, de, ate);
  const nome = nomeArquivo(de, ate);
  await fs.promises.mkdir(PASTA_LOCAL, { recursive: true });
  await fs.promises.writeFile(path.join(PASTA_LOCAL, nome), buffer);
  const out = { nome, de, ate, local: path.join(PASTA_LOCAL, nome), rede: null, erro_rede: null, telegram: false, texto };
  const rede = pastaRede(ate.slice(0, 4));
  if (rede) {
    try {
      await fs.promises.mkdir(rede, { recursive: true });
      await fs.promises.writeFile(path.join(rede, nome), buffer);
      out.rede = path.join(rede, nome);
    } catch (e) { out.erro_rede = e.message; console.error("[relatorio-semanal] pasta de rede:", e.message); }
  }
  out.telegram = await enviarTelegramArquivo(buffer, nome, texto);
  console.log(`[relatorio-semanal] ${nome} gerado${out.rede ? " + copiado p/ rede" : ""}${out.telegram ? " + Telegram" : ""}`);
  return out;
}

async function listar() {
  let nomes = [];
  try { nomes = await fs.promises.readdir(PASTA_LOCAL); } catch (_) { return []; }
  const out = [];
  for (const nome of nomes) {
    const m = nome.match(NOME_RE);
    if (!m) continue;
    const st = await fs.promises.stat(path.join(PASTA_LOCAL, nome));
    out.push({ nome, de: m[1], ate: m[2], tamanho: st.size, gerado_em: st.mtime.toISOString() });
  }
  return out.sort((a, b) => (a.de < b.de ? 1 : -1));
}

function caminhoArquivo(nome) {
  return NOME_RE.test(String(nome || "")) ? path.join(PASTA_LOCAL, nome) : null;
}

// De hora em hora: a partir de segunda 07:00, se o da semana passada nao
// existe, gera (cobre servidor desligado na segunda). RELATORIO_SEMANAL_ATIVO=0 desliga.
function iniciar(deps) {
  if (/^(0|false|nao|off)$/i.test(String(process.env.RELATORIO_SEMANAL_ATIVO || "").trim())) return;
  let rodando = false;
  const checar = async () => {
    if (rodando) return;
    const agora = new Date();
    const segunda = (agora.getDay() + 6) % 7 === 0;
    if (segunda && agora.getHours() < HORA_GERAR) return;
    const { de, ate } = semanaAnterior(agora);
    if (fs.existsSync(path.join(PASTA_LOCAL, nomeArquivo(de, ate)))) return;
    rodando = true;
    try { await gerar(deps, { de, ate }); } catch (e) { console.error("[relatorio-semanal]", e.message); } finally { rodando = false; }
  };
  setTimeout(checar, 60 * 1000).unref?.();
  setInterval(checar, 60 * 60 * 1000).unref?.();
}

module.exports = { gerar, listar, caminhoArquivo, iniciar, semanaAnterior, montarPlanilha };
