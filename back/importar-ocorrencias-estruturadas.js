// ================================================================
// importar-ocorrencias-estruturadas.js  —  USO ÚNICO / repetível
// ----------------------------------------------------------------
// Importa o CSV "ocorrencias_estruturadas.csv" para a tabela
// `ocorrencias`, SÓ para alimentar os gráficos/ranking.
//
// >>> NÃO ABRE "ID" / TRATATIVA <<<
// Diferente do importador de entregas, aqui NENHUMA linha entra como
// "Aberta". Toda ocorrência real entra com ocorrencia_status = 'Encerrada'
// (status já fechado). Resultado:
//   - APARECE nos gráficos (contam teve_ocorrencia + tipo_problema);
//   - NÃO conta em "Ocorrências Abertas";
//   - NÃO vira tratativa pendente nem dispara alerta de monitoramento.
//
// Colunas do CSV (separador ";"):
//   DATA ; ROTA ; MOTORISTA ; AJUDANTES ; CARRO_PLACA ; OCORRÊNCIA
//
// Mapeamento:
//   DATA        -> data_ocorrencia (YYYY-MM-DD)
//   ROTA        -> rota            (gráficos por rota usam esta coluna)
//   MOTORISTA   -> motorista       (normalizado p/ nomes canônicos)
//   AJUDANTES   -> ajudantes       ("/" e quebras viram ",", p/ ranking)
//   CARRO_PLACA -> placa
//   OCORRÊNCIA  -> descricao
//
//   teve_ocorrencia : TRUE, exceto linhas claramente "sem problema"
//                     ("sem atraso", "checklist feito", "não houve ocorrência"...).
//   tipo_problema   : classificação automática leve (Atraso/Trânsito/Veículo/...).
//   ocorrencia_status: 'Encerrada' (com problema) | 'Nao se aplica' (sem problema).
//   sla_status/otif : "Sem prazo"/"Sem SLA" (o CSV não tem horários).
//
// Sem loja e sem horários: gráficos por loja, SLA/OTIF, permanência e
// atraso calculado NÃO são alimentados por estes registros (faltam dados).
//
// É idempotente: pula linhas que já existem (mesma data + motorista + texto),
// então pode rodar de novo sem duplicar.
//
// FAÇA BACKUP DO BANCO ANTES DE RODAR.
//
// Como rodar (na pasta do projeto, NA MÁQUINA DO SERVIDOR):
//     node back/importar-ocorrencias-estruturadas.js --dry-run            -> só simula
//     node back/importar-ocorrencias-estruturadas.js                      -> grava
//     node back/importar-ocorrencias-estruturadas.js "C:\caminho\arq.csv" -> outro caminho
//     node back/importar-ocorrencias-estruturadas.js --latin1             -> força latin1
//
// Por padrão procura o CSV em back/ocorrencias_estruturadas.csv.
// ================================================================

const fs = require("fs");
const path = require("path");
const db = require("./db");
const { canonizarRota } = require("./normalizar-rota");

// ---------------------------------------------------------------
// CONFIG — pode editar à vontade
// ---------------------------------------------------------------

// Nomes canônicos de motoristas (iguais aos do sistema).
const MOTORISTAS_CANONICOS = [
  "RENATO MORAES", "SILVIO RAMOS", "FABIO NUNES", "MAURO DIAS",
  "NELSON PRADO", "HUGO TAVARES", "TIAGO DE MELO", "GILSON REIS",
  "SAMUEL COSTA", "CELSO BRITO", "EDSON",
];

// Apelidos/erros de digitação -> nome canônico (chave já sem acento/maiúscula
// e sem ponto final, ver chaveNome()).
const MAP_MOTORISTA = {
  "RENATO": "RENATO MORAES",
  "RENATO M": "RENATO MORAES",
  "WALACE A": "RENATO MORAES", // typo: 1 L só
  "WALACE": "RENATO MORAES",
  "FABO NUNES": "FABIO NUNES",
  "FABIO N": "FABIO NUNES",
  "SILVIO RAMOS": "SILVIO RAMOS",
  "SILVO RAMOS": "SILVIO RAMOS",
  "SAMUEL": "SAMUEL COSTA",
  "NELSON": "NELSON PRADO",
  "HUGO T": "HUGO TAVARES",
  "HUGO TAVARES": "HUGO TAVARES",
  "GILSON LEAL": "EDSON",
  "EDDSON LEAL": "EDSON",
  "EDSON LEAL": "EDSON",
  "EDSON": "EDSON",
};

// Frases que indicam que NÃO houve problema (não pontuam como ocorrência).
const PADROES_SEM_PROBLEMA = [
  /SEM ATRASO/,
  /CHECKLIST FEITO/,
  /FOI FEITO (O )?CHECKLIST/,
  /NAO FOI FEITO (O )?CHECKLIST/, // checklist é informativo, não é "problema da rota"
  /NAO HOUVE (NENHUMA )?OCORR/,
  /NAO FOI INFORMADO (NENHUMA )?OCORR/,
  /NAO HOUVE RELATADO (NENHUMA )?OCORR/,
  /NAO HOUVE RELATO/,
  /SEM OCORR/,
  /CONCLU[I]+D[OA]?\s+SEM\s+DIVERG/,
  /ENTREGUE\s+SEM\s+DIVERG/,
];

// Classificação leve do tipo de problema (na ordem; primeiro que casar vence).
const REGRAS_TIPO = [
  [/ATRAS|INTERJORNADA|ULTRAPASS|PERMANENC|ESPERA|ESPERANDO|DEMORA|LONGA|LONGO|AGUARD|FILA|HORA (REAL|DE SAIDA)|HORARIO DO RELATO/, "Atraso"],
  [/TRANSITO|ENGARRAF|LENTIDAO|ACIDENTE|PISTA|PARADA|BLITZ|CONGESTION|TRANSOLIMPICA/, "Trânsito/Via"],
  [/PNEU|FUROU|MECANIC|DEFEITO|BAFOMETRO|CORREIA|ALTERNADOR|PLATAFORMA|ELEVAT|MOTOR|ARREFEC|BATERIA|VENTOINA|ESTABILIDADE/, "Veículo"],
  [/DIVERG|FALT|VOLUME|CAIXA|ROMANEIO|\bNOTA\b|MALOTE|RETIRADA|PROTOCOLO|SACOLA|TOMBAD|FEZES/, "Carga/Divergência"],
  [/CINTO|VELOCIDADE|GARRAFA|MULTA|SEGURAN/, "Conduta/Segurança"],
];

// Status de ocorrência "encerrada" — entra nos gráficos, mas NÃO abre ID.
const STATUS_COM_PROBLEMA = "Encerrada";
const STATUS_SEM_PROBLEMA = "Nao se aplica";

// ---------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------
function vazioParaNull(v) {
  return v === undefined || v === null || String(v).trim() === "" ? null : v;
}

function semAcento(s) {
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function chaveNome(s) {
  return semAcento(s).toUpperCase().replace(/\s+/g, " ").trim().replace(/\.+$/, "").trim();
}

// Lê o arquivo respeitando BOM UTF-8; cai para latin1 se vier "quebrado".
function lerArquivoTexto(caminho, forcarLatin1) {
  const buf = fs.readFileSync(caminho);
  if (forcarLatin1) return buf.toString("latin1");
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString("utf8");
  }
  const txt = buf.toString("utf8");
  return txt.includes("�") ? buf.toString("latin1") : txt;
}

// Parser de CSV do arquivo INTEIRO (separador ";"), respeitando aspas e
// campos que ocupam VÁRIAS linhas (vários relatos deste CSV são assim).
function parseCsv(texto, sep) {
  const registros = [];
  let linha = [];
  let campo = "";
  let aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++; }
        else aspas = false;
      } else {
        campo += c; // mantém quebras de linha dentro das aspas
      }
    } else if (c === '"') {
      aspas = true;
    } else if (c === sep) {
      linha.push(campo); campo = "";
    } else if (c === "\r") {
      // ignora; a quebra é tratada no \n
    } else if (c === "\n") {
      linha.push(campo); registros.push(linha); linha = []; campo = "";
    } else {
      campo += c;
    }
  }
  if (campo !== "" || linha.length > 0) { linha.push(campo); registros.push(linha); }
  return registros;
}

function parseData(s) {
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

function normalizarMotorista(bruto, naoMapeados) {
  const limpo = String(bruto).replace(/\s+/g, " ").trim();
  if (!limpo) return "";
  const k = chaveNome(limpo);
  if (MAP_MOTORISTA[k]) return MAP_MOTORISTA[k];
  const canon = MOTORISTAS_CANONICOS.find((c) => chaveNome(c) === k);
  if (canon) return canon;
  naoMapeados.set(limpo, (naoMapeados.get(limpo) || 0) + 1);
  return limpo; // mantém como veio, mas registra para revisão
}

function normalizarAjudantes(s) {
  return String(s)
    .split(/[\/,\n\r]+/) // separa por "/", "," e quebras de linha
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(", ");
}

function normalizarRota(s) {
  return canonizarRota(s);
}

function ehSemProblema(texto) {
  const t = semAcento(texto).toUpperCase();
  if (/NAO HOUVE ATRASO/.test(t) && classificarTipo(t) === "Outros") return true;
  return PADROES_SEM_PROBLEMA.some((re) => re.test(t));
}

function classificarTipo(texto) {
  const t = semAcento(texto).toUpperCase();
  for (const [re, tipo] of REGRAS_TIPO) if (re.test(t)) return tipo;
  return "Outros";
}

// ---------------------------------------------------------------
const DRY = process.argv.includes("--dry-run");
const FORCAR_LATIN1 = process.argv.includes("--latin1");
const caminhoArg = process.argv.find((a, i) => i >= 2 && !a.startsWith("--"));
const CSV_PATH = caminhoArg
  ? path.resolve(caminhoArg)
  : path.join(__dirname, "ocorrencias_estruturadas.csv");

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`❌ CSV não encontrado: ${CSV_PATH}`);
    console.error("   Coloque o arquivo em back/ ou passe o caminho como argumento.");
    process.exitCode = 1;
    return;
  }

  const texto = lerArquivoTexto(CSV_PATH, FORCAR_LATIN1);
  const todos = parseCsv(texto, ";");
  if (todos.length <= 1) {
    console.error("❌ CSV vazio ou só com cabeçalho.");
    process.exitCode = 1;
    return;
  }

  // Pula o cabeçalho se a 1ª célula for "DATA".
  const cabecalho = chaveNome(todos[0][0] || "") === "DATA";
  const corpo = cabecalho ? todos.slice(1) : todos;

  const registros = [];
  const naoMapeados = new Map();
  const rotasVistas = new Map();
  let ignorados = 0;

  for (const campos of corpo) {
    if (campos.length < 6) { ignorados++; continue; }

    const data = parseData(campos[0]);
    const rota = normalizarRota(campos[1]);
    const motorista = normalizarMotorista(campos[2], naoMapeados);
    const ajudantes = normalizarAjudantes(campos[3]);
    const placa = String(campos[4]).replace(/\s+/g, "").trim().toUpperCase();
    // OCORRÊNCIA é a última coluna; reúne caso tenha ";" sem aspas.
    const descricao = campos.slice(5).join(";").replace(/\s+/g, " ").trim();

    if (!data || !descricao) { ignorados++; continue; }

    const semProblema = ehSemProblema(descricao);
    registros.push({
      data_ocorrencia: data,
      motorista,
      placa: placa || null,
      ajudantes: ajudantes || null,
      rota: rota || null,
      descricao,
      teve_ocorrencia: !semProblema,
      tipo_problema: semProblema ? null : classificarTipo(descricao),
      ocorrencia_status: semProblema ? STATUS_SEM_PROBLEMA : STATUS_COM_PROBLEMA,
    });
    if (rota) rotasVistas.set(rota, (rotasVistas.get(rota) || 0) + 1);
  }

  const comProblema = registros.filter((r) => r.teve_ocorrencia).length;
  const semProblema = registros.length - comProblema;

  console.log("================================================");
  console.log(`Arquivo : ${CSV_PATH}`);
  console.log(`Linhas válidas : ${registros.length}  (ignoradas: ${ignorados})`);
  console.log(`  com problema (vão p/ gráfico): ${comProblema}`);
  console.log(`  sem problema (não pontuam)   : ${semProblema}`);
  console.log(`Rotas distintas: ${rotasVistas.size}`);
  console.log("Status gravado : 'Encerrada' / 'Nao se aplica'  (NUNCA 'Aberta' — não abre ID)");
  if (naoMapeados.size) {
    console.log("⚠️  Motoristas FORA da lista canônica (revise o MAP_MOTORISTA):");
    [...naoMapeados.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([nome, n]) => console.log(`     - "${nome}"  (${n}x)`));
  }
  console.log(DRY ? "MODO: DRY-RUN (nada será gravado)" : "MODO: GRAVAÇÃO");
  console.log("================================================");

  if (registros.length === 0) {
    console.log("Nada a importar.");
    return;
  }

  if (DRY) {
    console.log("\nPrévia (8 primeiros):");
    registros.slice(0, 8).forEach((r) =>
      console.log(
        `  ${r.data_ocorrencia} | ${r.motorista} | ${r.rota} | ` +
          `${r.teve_ocorrencia ? r.tipo_problema : "sem problema"} | ` +
          `${r.ocorrencia_status} | ${r.descricao.slice(0, 50)}...`,
      ),
    );
    console.log("\n(DRY-RUN) Rode sem --dry-run para gravar de verdade.");
    return;
  }

  const client = await db.connect();
  let inseridos = 0;
  let pulados = 0;
  try {
    await client.query("ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS rota TEXT");
    await client.query("BEGIN");

    for (const r of registros) {
      const dup = await client.query(
        `SELECT 1 FROM ocorrencias
          WHERE data_ocorrencia = $1 AND motorista = $2 AND descricao = $3
          LIMIT 1`,
        [r.data_ocorrencia, r.motorista, r.descricao],
      );
      if (dup.rowCount > 0) { pulados++; continue; }

      await client.query(
        `INSERT INTO ocorrencias (
            data_ocorrencia, motorista, placa, ajudantes, rota, descricao,
            teve_ocorrencia, tipo_problema, ocorrencia_status, sla_status, otif_status,
            hora_chegada, inicio_descarga, fim_descarga
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Sem prazo', 'Sem SLA', '00:00', '00:00', '00:00')`,
        [
          r.data_ocorrencia,
          vazioParaNull(r.motorista),
          vazioParaNull(r.placa),
          vazioParaNull(r.ajudantes),
          vazioParaNull(r.rota),
          r.descricao,
          r.teve_ocorrencia,
          vazioParaNull(r.tipo_problema),
          r.ocorrencia_status,
        ],
      );
      inseridos++;
    }

    await client.query("COMMIT");
    console.log(`✅ Importação concluída. Inseridos: ${inseridos} | Pulados (já existiam): ${pulados}`);
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
