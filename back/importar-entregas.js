// ================================================================
// importar-entregas.js  —  USO ÚNICO / repetível
// ----------------------------------------------------------------
// Importa o CSV de ENTREGAS (uma linha por loja visitada) para a tabela
// `ocorrencias`, alimentando TODOS os dashboards — inclusive os que os
// importadores de ocorrência NÃO alimentavam, porque agora temos
// loja + horários: SLA, OTIF, atraso na loja, tempo de permanência por
// loja e "rotas que mais atrasam".
//
// >>> NÃO ABRE "ID" / TRATATIVA <<<  (igual ao importar-ocorrencias-estruturadas)
// Linhas com problema entram com ocorrencia_status = 'Encerrada' (já fechado):
// aparecem nos gráficos, mas NÃO contam em "Ocorrências Abertas" nem viram
// tratativa pendente. Linhas sem problema entram como 'Nao se aplica'.
//
// Colunas do CSV (separador ";", cabeçalho na 1ª linha — mapeadas por NOME):
//   data_rota ; rota ; motorista ; placa ; ajudantes ; loja ;
//   hora_marcada ; hora_chegada ; hora_saida ; tempo_permanencia ;
//   situacao_entrega ; campo_relato ; cargo ; responsavel ;
//   mercadoria_434_contagem ; mercadoria_434_contagem_loja ; tipo_registro
//
// Mapeamento -> ocorrencias:
//   data_rota                    -> data_ocorrencia (aceita YYYY-MM-DD ou dd/mm/aaaa)
//   loja                         -> loja
//   rota                         -> rota
//   motorista (normalizado)      -> motorista
//   placa / ajudantes            -> placa / ajudantes
//   responsavel / cargo          -> recebedor / cargo
//   hora_marcada                 -> hora_agendada_loja   (base do SLA)
//   hora_chegada                 -> hora_chegada E inicio_descarga
//   hora_saida                   -> fim_descarga
//   (fim - inicio)               -> permanencia_minutos
//   mercadoria_434_contagem      -> volume_gerencial
//   mercadoria_434_contagem_loja -> volume_fisico
//   campo_relato                 -> descricao
//   situacao_entrega + relato    -> teve_ocorrencia / tipo_problema / entrega_completa
//   sla_status / otif_status     -> calculados (mesma lógica do server.js)
//   ocorrencia_status            -> 'Encerrada' (problema) | 'Nao se aplica'
//
// Idempotente: pula linha que já existe (mesma data + rota + loja + hora_chegada).
// Corrige encoding "mojibake" (UTF-8 lido como cp1252) quando possível.
//
// FAÇA BACKUP DO BANCO ANTES DE RODAR.
//
// Como rodar (na pasta do projeto, NA MÁQUINA DO SERVIDOR):
//     node back/importar-entregas.js --dry-run     -> só simula/mostra
//     node back/importar-entregas.js               -> grava (pula o que já existe)
//     node back/importar-entregas.js --substituir  -> regrava o que já existe (CORRIGE import anterior)
//     node back/importar-entregas.js "C:\caminho\arq.csv"
//
// Por padrão procura: analise/dados/entregas_consolidado.csv
// ================================================================

const fs = require("fs");
const path = require("path");
const db = require("./db");
const { canonizarRota } = require("./normalizar-rota");
const { canonizarLoja } = require("./normalizar-loja");
const { calcularMinutos, classificarSla } = require("./tempo");

// ---------------- CONFIG ----------------
const MOTORISTAS_CANONICOS = [
  "RENATO MORAES", "SILVIO RAMOS", "FABIO NUNES", "MAURO DIAS",
  "NELSON PRADO", "HUGO TAVARES", "TIAGO DE MELO", "GILSON REIS",
  "SAMUEL COSTA", "CELSO BRITO", "EDSON",
];

// Apelidos/typos/variações de rota -> nome canônico (chave sem acento/maiúscula).
// Inclui as formas "mojibake" (ex.: JOSÃ -> chave JOSA) que aparecem neste CSV.
const MAP_MOTORISTA = {
  "RENATO": "RENATO MORAES",
  "RENATO M": "RENATO MORAES",
  "RENATOL II": "RENATO MORAES",   // 2ª rota do Renato no dia
  "FABO NUNES": "FABIO NUNES",
  "FABIO N": "FABIO NUNES",
  "FABIO II": "FABIO NUNES",       // 2ª rota do Fabio no dia
  "SILVIO RAMOS": "SILVIO RAMOS",
  "SILVIO RAMOS": "SILVIO RAMOS",      // mojibake de JOSÉ
  "SILVO RAMOS": "SILVIO RAMOS",
  "SAMUEL": "SAMUEL COSTA",
  "SAMUEL COSTA": "SAMUEL COSTA",
  "NELSON": "NELSON PRADO",
  "HUGO T": "HUGO TAVARES",
  "HUGA TAVARES": "HUGO TAVARES",        // mojibake de HUGO
  "HUGO TAVARES": "HUGO TAVARES",
  "GILSON": "GILSON REIS",
  "GILSON LEAL": "EDSON",
  "EDDSON LEAL": "EDSON",
  "EDSON LEAL": "EDSON",
  "EDSON": "EDSON",
};

// Classificação leve do tipo de problema (1º que casar vence).
const REGRAS_TIPO = [
  [/ATRAS|INTERJORNADA|ULTRAPASS|PERMANENC|ESPERA|ESPERANDO|DEMORA|LONGA|LONGO|AGUARD|FILA/, "Atraso"],
  [/TRANSITO|ENGARRAF|LENTIDAO|ACIDENTE|PISTA|BLITZ|CONGESTION|TRANSOLIMPICA/, "Trânsito/Via"],
  [/PNEU|FUROU|MECANIC|DEFEITO|BAFOMETRO|CORREIA|ALTERNADOR|PLATAFORMA|ELEVAT|MOTOR|ARREFEC|BATERIA|VENTOINA|ESTABILIDADE/, "Veículo"],
  [/DIVERG|FALT|VOLUME|CAIXA|ROMANEIO|\bNOTA\b|MALOTE|RETIRADA|PROTOCOLO|SACOLA|TOMBAD|FUROS|QUEBRAD/, "Carga/Divergência"],
  [/CINTO|VELOCIDADE|GARRAFA|MULTA|SEGURAN/, "Conduta/Segurança"],
];

// Relatos neutros (não são problema, mesmo preenchidos).
const PADROES_NEUTRO = [
  /ALMO[ÇC]/, /DESCANSO/, /PERNOITE/, /PARADA PARA/, /ULTIMA LOJA/, /RETORNO/,
];

// ---------------- HELPERS ----------------
function vazioParaNull(v) {
  return v === undefined || v === null || String(v).trim() === "" ? null : v;
}
function semAcento(s) {
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "");
}
function chaveNome(s) {
  return semAcento(s).toUpperCase().replace(/\s+/g, " ").trim().replace(/\.+$/, "").trim();
}
function textoParaBoolean(v) {
  const t = String(v || "").trim().toLowerCase();
  return t === "true" || t === "sim" || t === "feito" || t === "realizou";
}
// calcularMinutos: fonte unica em ./tempo.js (require no topo).
// SLA/OTIF — réplica fiel de indicadoresEntrega() do server.js
function indicadores(agendada, chegada, completa) {
  const sla = classificarSla(agendada, chegada);
  const otif = sla === "No prazo" && completa ? "Conforme" : sla === "Sem prazo" ? "Sem SLA" : "Nao conforme";
  return { sla, otif };
}

// Corrige "mojibake" (UTF-8 lido como cp1252): recupera os casos íntegros.
function corrigirMojibake(s) {
  if (!s || !/[Â-Ã]/.test(s)) return s;
  const fixed = Buffer.from(s, "latin1").toString("utf8");
  return fixed.includes("�") ? s : fixed;
}

function lerArquivoTexto(caminho) {
  const buf = fs.readFileSync(caminho);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString("utf8");
  }
  return buf.toString("utf8");
}

// Parser CSV do arquivo inteiro (sep ";"), respeitando aspas e campos multi-linha.
function parseCsv(texto, sep) {
  const registros = [];
  let linha = [], campo = "", aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"') { if (texto[i + 1] === '"') { campo += '"'; i++; } else aspas = false; }
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === sep) { linha.push(campo); campo = ""; }
    else if (c === "\r") { /* ignora */ }
    else if (c === "\n") { linha.push(campo); registros.push(linha); linha = []; campo = ""; }
    else campo += c;
  }
  if (campo !== "" || linha.length > 0) { linha.push(campo); registros.push(linha); }
  return registros;
}

function parseData(s) {
  const t = String(s).trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}
function parseHora(s) {
  const m = String(s || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}
function normalizarMotorista(bruto, naoMapeados) {
  const limpo = corrigirMojibake(String(bruto)).replace(/\s+/g, " ").trim();
  if (!limpo) return "";
  const k = chaveNome(limpo);
  if (MAP_MOTORISTA[k]) return MAP_MOTORISTA[k];
  const canon = MOTORISTAS_CANONICOS.find((c) => chaveNome(c) === k);
  if (canon) return canon;
  naoMapeados.set(limpo, (naoMapeados.get(limpo) || 0) + 1);
  return limpo;
}
function normalizarAjudantes(s) {
  return corrigirMojibake(String(s)).split(/[\/,\n\r]+/).map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean).join(", ");
}
function normalizarRota(s) {
  return canonizarRota(corrigirMojibake(String(s)));
}
function classificarTipo(texto) {
  const t = semAcento(texto).toUpperCase();
  for (const [re, tipo] of REGRAS_TIPO) if (re.test(t)) return tipo;
  return "Outros";
}
function ehNeutro(texto) {
  const t = semAcento(texto).toUpperCase();
  return PADROES_NEUTRO.some((re) => re.test(t));
}
function intOuNull(s) {
  const n = parseInt(String(s).replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

// ---------------- MAIN ----------------
const DRY = process.argv.includes("--dry-run");
// --substituir: em vez de PULAR linhas já existentes, APAGA a linha (mesma chave
// data+rota+loja+hora_chegada) e regrava com os valores corretos. Use para corrigir
// um import anterior que entrou errado, sem mexer em nada fora do CSV.
const SUBSTITUIR = process.argv.includes("--substituir");
const caminhoArg = process.argv.find((a, i) => i >= 2 && !a.startsWith("--"));
const CSV_PATH = caminhoArg
  ? path.resolve(caminhoArg)
  : path.join(__dirname, "..", "analise", "dados", "entregas_consolidado.csv");

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`❌ CSV não encontrado: ${CSV_PATH}`);
    process.exitCode = 1;
    return;
  }

  const linhas = parseCsv(lerArquivoTexto(CSV_PATH), ";");
  if (linhas.length <= 1) { console.error("❌ CSV vazio ou só cabeçalho."); process.exitCode = 1; return; }

  // Mapeia índice de cada coluna pelo NOME do cabeçalho.
  const cab = linhas[0].map((c) => c.trim().toLowerCase());
  const col = (nome) => cab.indexOf(nome);
  const idx = {
    tipo: col("tipo_registro"), data: col("data_rota"), rota: col("rota"),
    motorista: col("motorista"), placa: col("placa"), ajudantes: col("ajudantes"),
    loja: col("loja"), marcada: col("hora_marcada"), chegada: col("hora_chegada"),
    saida: col("hora_saida"), situacao: col("situacao_entrega"),
    relato: col("campo_relato"), cargo: col("cargo"), responsavel: col("responsavel"),
    volGer: col("mercadoria_434_contagem"), volFis: col("mercadoria_434_contagem_loja"),
  };

  const registros = [];
  const naoMapeados = new Map();
  let ignorados = 0;

  for (const campos of linhas.slice(1)) {
    if (idx.tipo >= 0 && (campos[idx.tipo] || "").trim() && (campos[idx.tipo] || "").trim().toUpperCase() !== "ENTREGA") {
      continue; // só linhas de ENTREGA
    }
    const data = parseData(campos[idx.data]);
    const loja = canonizarLoja(campos[idx.loja]);
    if (!data || !loja) { ignorados++; continue; }

    const situacao = corrigirMojibake(String(campos[idx.situacao] || "")).replace(/\s+/g, " ").trim();
    const relato = corrigirMojibake(String(campos[idx.relato] || "")).replace(/\s+/g, " ").trim();
    const chegada = parseHora(campos[idx.chegada]);
    const saida = parseHora(campos[idx.saida]);
    const marcada = parseHora(campos[idx.marcada]);

    const sitSemAcento = semAcento(situacao).toUpperCase();
    // Divergência (VERMELHO na planilha) = situação "COM DIVERGÊNCIA" ou "COM PROBLEMA".
    // "SEM DIVERGÊNCIA" / "OK" / "COM OBS" = VERDE (entrega correta) -> NÃO é divergência,
    // mesmo que o relato cite um atraso/observação. A cor da situação é que decide.
    const temDivergencia =
      (/DIVERG/.test(sitSemAcento) && !/SEM DIVERG/.test(sitSemAcento)) ||
      /COM PROBLEMA/.test(sitSemAcento);
    const entregaCompleta = !temDivergencia;
    const teveOcorrencia = temDivergencia;
    const tipoProblema = teveOcorrencia ? classificarTipo(relato || situacao) : null;
    const { sla, otif } = indicadores(marcada, chegada, entregaCompleta);

    registros.push({
      data_ocorrencia: data,
      loja,
      rota: normalizarRota(campos[idx.rota]) || null,
      motorista: normalizarMotorista(campos[idx.motorista], naoMapeados) || null,
      placa: String(campos[idx.placa] || "").replace(/\s+/g, "").trim().toUpperCase() || null,
      ajudantes: normalizarAjudantes(campos[idx.ajudantes]) || null,
      recebedor: corrigirMojibake(String(campos[idx.responsavel] || "")).trim() || null,
      cargo: String(campos[idx.cargo] || "").trim() || null,
      hora_agendada_loja: marcada,
      hora_chegada: chegada,
      inicio_descarga: chegada,
      fim_descarga: saida,
      permanencia_minutos: calcularMinutos(chegada, saida),
      volume_gerencial: intOuNull(campos[idx.volGer]),
      volume_fisico: intOuNull(campos[idx.volFis]),
      descricao: relato || (teveOcorrencia ? situacao : null),
      teve_ocorrencia: !!teveOcorrencia,
      tipo_problema: tipoProblema,
      entrega_completa: entregaCompleta,
      sla_status: sla,
      otif_status: otif,
      ocorrencia_status: teveOcorrencia ? "Encerrada" : "Nao se aplica",
    });
  }

  const comOcor = registros.filter((r) => r.teve_ocorrencia).length;
  const atrasadas = registros.filter((r) => r.sla_status === "Atrasada").length;
  const comPrazo = registros.filter((r) => r.sla_status !== "Sem prazo").length;

  console.log("================================================");
  console.log(`Arquivo : ${CSV_PATH}`);
  console.log(`Entregas (linhas de loja) válidas: ${registros.length}  (ignoradas: ${ignorados})`);
  console.log(`  com ocorrência (p/ gráfico): ${comOcor}`);
  console.log(`  com SLA calculável         : ${comPrazo}  (atrasadas: ${atrasadas})`);
  console.log("Status gravado : 'Encerrada' / 'Nao se aplica'  (NUNCA 'Aberta' — não abre ID)");
  if (naoMapeados.size) {
    console.log("⚠️  Motoristas fora da lista canônica (revise o MAP_MOTORISTA):");
    [...naoMapeados.entries()].sort((a, b) => b[1] - a[1]).forEach(([n, q]) => console.log(`     - "${n}" (${q}x)`));
  }
  console.log(DRY ? "MODO: DRY-RUN (nada será gravado)" : SUBSTITUIR ? "MODO: GRAVAÇÃO + SUBSTITUIR (regrava linhas já existentes)" : "MODO: GRAVAÇÃO");
  console.log("================================================");

  if (registros.length === 0) { console.log("Nada a importar."); return; }

  if (DRY) {
    console.log("\nPrévia (8 primeiras):");
    registros.slice(0, 8).forEach((r) =>
      console.log(`  ${r.data_ocorrencia} | ${r.rota} | ${r.loja} | marc ${r.hora_agendada_loja || "--:--"} cheg ${r.hora_chegada || "--:--"} | ${r.sla_status} | perm ${r.permanencia_minutos}min | ${r.teve_ocorrencia ? r.tipo_problema : "ok"}`));
    console.log("\n(DRY-RUN) Rode sem --dry-run para gravar de verdade.");
    return;
  }

  const client = await db.connect();
  let inseridos = 0, pulados = 0, substituidos = 0;
  try {
    await client.query("ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS rota TEXT");
    await client.query("BEGIN");
    for (const r of registros) {
      const filtroChave =
        `data_ocorrencia = $1 AND COALESCE(rota,'') = COALESCE($2,'')
           AND loja = $3 AND hora_chegada IS NOT DISTINCT FROM $4::time`;
      const chaveVals = [r.data_ocorrencia, r.rota, r.loja, r.hora_chegada];
      const dup = await client.query(`SELECT 1 FROM ocorrencias WHERE ${filtroChave} LIMIT 1`, chaveVals);
      if (dup.rowCount > 0) {
        if (!SUBSTITUIR) { pulados++; continue; }
        await client.query(`DELETE FROM ocorrencias WHERE ${filtroChave}`, chaveVals);
        substituidos++;
      } else {
        inseridos++;
      }

      await client.query(
        `INSERT INTO ocorrencias (
            data_ocorrencia, loja, rota, motorista, placa, ajudantes, recebedor, cargo,
            hora_agendada_loja, hora_chegada, inicio_descarga, fim_descarga, permanencia_minutos,
            volume_gerencial, volume_fisico, descricao, teve_ocorrencia, tipo_problema,
            entrega_completa, sla_status, otif_status, ocorrencia_status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [
          r.data_ocorrencia, r.loja, r.rota, vazioParaNull(r.motorista), r.placa, r.ajudantes,
          r.recebedor, r.cargo, r.hora_agendada_loja, r.hora_chegada, r.inicio_descarga,
          r.fim_descarga, r.permanencia_minutos, r.volume_gerencial, r.volume_fisico,
          r.descricao, r.teve_ocorrencia, r.tipo_problema, r.entrega_completa,
          r.sla_status, r.otif_status, r.ocorrencia_status,
        ],
      );
    }
    await client.query("COMMIT");
    console.log(`✅ Concluído. Inseridos: ${inseridos} | Substituídos: ${substituidos} | Pulados (já existiam): ${pulados}`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("❌ Falhou, nenhuma alteração foi feita:", err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    process.exit();
  }
}

main();
