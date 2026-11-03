// ================================================================
// importar-ocorrencias-rota.js  —  USO ÚNICO
// ----------------------------------------------------------------
// Importa o CSV "controle_rota_ocorrencias.csv" (controle de rotas) para a
// tabela `ocorrencias`, alimentando os dashboards e o ranking.
//
// Colunas do CSV (separador ";"):
//   Dia_Referencia ; Data ; Numero ; Rota ; Motorista ; Ajudante ; Placa ; Ocorrencia
//
// Mapeamento:
//   Data        -> data_ocorrencia (YYYY-MM-DD)
//   Rota        -> rota            (coluna nova; gráficos por rota usam ela)
//   Motorista   -> motorista       (normalizado p/ nomes canônicos quando óbvio)
//   Ajudante    -> ajudantes       ("/" vira ",", p/ o ranking de ajudantes)
//   Placa       -> placa
//   Ocorrencia  -> descricao
//
//   teve_ocorrencia : TRUE, exceto linhas claramente "sem problema"
//                     ("sem atraso", "checklist feito", "não houve ocorrência"...).
//   tipo_problema   : classificação automática leve (Atraso/Trânsito/Veículo/...).
//   sla_status/otif : "Sem prazo"/"Sem SLA" (o CSV não tem horários).
//
// Sem loja e sem horários no CSV: gráficos por loja, SLA/OTIF, permanência e
// atraso calculado NÃO são alimentados por estes registros (faltam os dados).
//
// É idempotente: pula linhas que já existem (mesma data + motorista + texto),
// então pode rodar de novo sem duplicar.
//
// FAÇA BACKUP DO BANCO ANTES DE RODAR.
//
// Como rodar (na pasta do projeto, NA MÁQUINA DO SERVIDOR):
//     node back/importar-ocorrencias-rota.js --dry-run            -> só simula
//     node back/importar-ocorrencias-rota.js                      -> grava
//     node back/importar-ocorrencias-rota.js "C:\caminho\arq.csv" -> outro caminho
//     node back/importar-ocorrencias-rota.js --latin1             -> força latin1
//
// Por padrão procura o CSV em back/controle_rota_ocorrencias.csv.
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

// Apelidos/erros de digitação -> nome canônico (chave já sem acento/maiúscula).
const MAP_MOTORISTA = {
  "RENATO": "RENATO MORAES",
  "RENATO M": "RENATO MORAES",
  "FABO NUNES": "FABIO NUNES",
  "SILVIO RAMOS": "SILVIO RAMOS",
  "SILVO RAMOS": "SILVIO RAMOS",
  "SAMUEL": "SAMUEL COSTA",
  "GILSON LEAL": "EDSON",
  "EDDSON LEAL": "EDSON",
  "EDSON LEAL": "EDSON",
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
  /NAO HOUVE ATRASO/,
];

// Classificação leve do tipo de problema (na ordem; primeiro que casar vence).
const REGRAS_TIPO = [
  [/ATRAS|INTERJORNADA|ULTRAPASS|PERMANENC|ESPERA|ESPERANDO|DEMORA|LONGA|LONGO/, "Atraso"],
  [/TRANSITO|ENGARRAF|LENTIDAO|ACIDENTE|PISTA|PARADA|BLITZ|CONGESTION|TRANSOLIMPICA/, "Trânsito/Via"],
  [/PNEU|FUROU|MECANIC|DEFEITO|BAFOMETRO|CORREIA|ALTERNADOR|PLATAFORMA|ELEVAT|MOTOR|ARREFEC|BATERIA/, "Veículo"],
  [/DIVERG|FALT|VOLUME|CAIXA|ROMANEIO|\bNOTA\b|MALOTE|RETIRADA|PROTOCOLO/, "Carga/Divergência"],
  [/CINTO|VELOCIDADE|GARRAFA|MULTA|SEGURAN/, "Conduta/Segurança"],
];

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

// Parser de uma linha CSV com separador ";" respeitando aspas.
function parseLinhaCsv(linha) {
  const campos = [];
  let atual = "";
  let aspas = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (aspas) {
      if (c === '"') {
        if (linha[i + 1] === '"') { atual += '"'; i++; }
        else aspas = false;
      } else atual += c;
    } else if (c === '"') {
      aspas = true;
    } else if (c === ";") {
      campos.push(atual);
      atual = "";
    } else {
      atual += c;
    }
  }
  campos.push(atual);
  return campos;
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
    .split(/[\/,]/)
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(", ");
}

function normalizarRota(s) {
  return canonizarRota(s);
}

function ehSemProblema(texto) {
  const t = semAcento(texto).toUpperCase();
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
const caminhoArg = process.argv.find(
  (a, i) => i >= 2 && !a.startsWith("--"),
);
const CSV_PATH = caminhoArg
  ? path.resolve(caminhoArg)
  : path.join(__dirname, "controle_rota_ocorrencias.csv");

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`❌ CSV não encontrado: ${CSV_PATH}`);
    console.error("   Coloque o arquivo em back/ ou passe o caminho como argumento.");
    process.exitCode = 1;
    return;
  }

  const texto = lerArquivoTexto(CSV_PATH, FORCAR_LATIN1);
  const linhas = texto.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (linhas.length <= 1) {
    console.error("❌ CSV vazio ou só com cabeçalho.");
    process.exitCode = 1;
    return;
  }

  // Pula o cabeçalho.
  const corpo = linhas.slice(1);
  const registros = [];
  const naoMapeados = new Map();
  const rotasVistas = new Map();
  let ignorados = 0;

  for (const linha of corpo) {
    const campos = parseLinhaCsv(linha);
    if (campos.length < 8) { ignorados++; continue; }

    const data = parseData(campos[1]);
    const rota = normalizarRota(campos[3]);
    const motorista = normalizarMotorista(campos[4], naoMapeados);
    const ajudantes = normalizarAjudantes(campos[5]);
    const placa = String(campos[6]).replace(/\s+/g, "").trim().toUpperCase();
    // Ocorrencia é a última coluna; reúne caso tenha ";" sem aspas.
    const descricao = campos.slice(7).join(";").replace(/\s+/g, " ").trim();

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
    });
    if (rota) rotasVistas.set(rota, (rotasVistas.get(rota) || 0) + 1);
  }

  const comProblema = registros.filter((r) => r.teve_ocorrencia).length;
  const semProblema = registros.length - comProblema;

  console.log("================================================");
  console.log(`Arquivo : ${CSV_PATH}`);
  console.log(`Linhas válidas : ${registros.length}  (ignoradas: ${ignorados})`);
  console.log(`  com problema : ${comProblema}`);
  console.log(`  sem problema : ${semProblema}`);
  console.log(`Rotas distintas: ${rotasVistas.size}`);
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
    console.log("\nPrévia (5 primeiros):");
    registros.slice(0, 5).forEach((r) =>
      console.log(
        `  ${r.data_ocorrencia} | ${r.motorista} | ${r.rota} | ` +
          `${r.teve_ocorrencia ? r.tipo_problema : "sem problema"} | ${r.descricao.slice(0, 60)}...`,
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
            teve_ocorrencia, tipo_problema, ocorrencia_status, sla_status, otif_status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Sem prazo', 'Sem SLA')`,
        [
          r.data_ocorrencia,
          vazioParaNull(r.motorista),
          vazioParaNull(r.placa),
          vazioParaNull(r.ajudantes),
          vazioParaNull(r.rota),
          r.descricao,
          r.teve_ocorrencia,
          vazioParaNull(r.tipo_problema),
          r.teve_ocorrencia ? "Aberta" : "Nao se aplica",
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
