// ================================================================
// importar-rotas-registradas.js  —  USO ÚNICO / repetível
// ----------------------------------------------------------------
// Importa os CSV de "CONTROLE DE HORA" (saída/retorno por rota) para a
// tabela `rotas_registradas` — a mesma que a aba Veículos já usa. Assim
// os registros aparecem lá e o Deslocamento consegue linkar motorista +
// saída/retorno por dia (cruza por rota + data).
//
// Aceita os DOIS formatos de planilha (separador ";"):
//
//   A) "PLANO/PRISCILA" (uma linha por registro, cabeçalho na 1ª linha):
//        DATA DA ROTA ; ROTA ; MOTORISTA ; PLACA ; HORÁRIO ; HORÁRIO DE RETORNO ; ...
//
//   B) "AGRUPADO POR DATA" (linha só com a data inicia o bloco):
//        15/04/2026 ; ; ; DIA 01 ; ; DIA 03 ; ; DIA 02 ;
//        MOTORISTA ; PLACA ; ROTA ; HORÁRIO ; RETORNO ; ...
//
// VIAGENS (vários dias): depois dos campos fixos vêm PARES (saída, retorno),
// um par por dia. Ex.: ...;04:00;19:00;07:48;13:54  =>  dia 1 (04:00→19:00)
// e dia 2 (07:48→13:54). Cada par vira UMA linha em rotas_registradas, com
// a data somando +1 dia a cada par (dias consecutivos) e obs "Viagem dia X/Y".
//
// Idempotente: pula linha que já existe (mesma data + rota_feita + saida +
// retorno + motorista). Corrige encoding (UTF-8 lido como cp1252).
//
// FAÇA BACKUP DO BANCO ANTES DE RODAR.
//
// Como rodar (NA MÁQUINA DO SERVIDOR, na pasta do projeto):
//   node back/importar-rotas-registradas.js --dry-run        -> só simula
//   node back/importar-rotas-registradas.js                  -> grava (pula repetidos)
//   node back/importar-rotas-registradas.js "C:\a.csv" "C:\b.csv"
//
// Sem argumentos, procura na raiz do projeto:
//   "CONTROLE DE HORA.CSV"  e  "CONTROLE DE HORA PRISCILA.CSV"
// ================================================================

const fs = require("fs");
const path = require("path");
const db = require("./db");
const { canonizarRota } = require("./normalizar-rota");

const DRY_RUN = process.argv.includes("--dry-run");
const ARQS_CLI = process.argv.slice(2).filter((a) => !a.startsWith("--"));

const RAIZ = path.join(__dirname, "..");
const ARQS_PADRAO = ["CONTROLE DE HORA.CSV", "CONTROLE DE HORA PRISCILA.CSV"];

// ---------------- HELPERS ----------------
function lerArquivoTexto(caminho) {
  const buf = fs.readFileSync(caminho);
  let txt;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    txt = buf.slice(3).toString("utf8"); // BOM UTF-8
  } else {
    txt = buf.toString("utf8");
    if (txt.includes("�")) txt = buf.toString("latin1"); // provavelmente ANSI/cp1252
  }
  return txt;
}

function ehData(s) {
  return /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(String(s).trim());
}
function ehHora(s) {
  return /^\d{1,2}:\d{2}$/.test(String(s).trim());
}
// "05/05/2026" -> "2026-05-05"
function dataISO(br) {
  const [d, m, y] = String(br).trim().split("/");
  const ano = y.length === 2 ? "20" + y : y;
  return `${ano}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}
// soma `n` dias a um ISO "YYYY-MM-DD" (meio-dia + getters locais p/ não sofrer com fuso)
function somarDias(iso, n) {
  if (!n) return iso;
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function minutos(hhmm) {
  if (!ehHora(hhmm)) return null;
  const [h, m] = String(hhmm).trim().split(":").map(Number);
  return h * 60 + m;
}
function limpar(s) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
}

// Jornada do dia — réplica de calcularDadosRota() do front (limite 8h / +2h extra).
function dadosJornada(saida, retorno) {
  const ms = minutos(saida);
  const mr = minutos(retorno);
  if (ms == null || mr == null) {
    return { total_min: null, horas: null, minutos: null, minutos_normais: null, minutos_extras_permitidos: null, minutos_excedentes: null, valor_extra_aprox: null };
  }
  let total = mr - ms;
  if (total < 0) total += 24 * 60;
  // 12h de trabalho (8h normais + ate 4h extra) + 1h de almoco que nao conta,
  // descontada em dia acima de 6h (mesma regra do formulario Tempo de Rota).
  const trabalhado = total > 360 ? total - 60 : total;
  const normais = Math.min(trabalhado, 480);
  const extras = Math.min(Math.max(trabalhado - 480, 0), 240);
  const excedentes = Math.max(trabalhado - 720, 0);
  return {
    total_min: total,
    horas: Math.floor(total / 60),
    minutos: total % 60,
    minutos_normais: normais,
    minutos_extras_permitidos: extras,
    minutos_excedentes: excedentes,
    valor_extra_aprox: Number(((extras / 60) * 15).toFixed(2)),
  };
}

// ---------------- PARSE ----------------
// Devolve [{ data, rota, motorista, placa, tempos:[...] }] (1 por LINHA do CSV;
// "tempos" já só com as horas válidas, em ordem).
function parseCSV(texto) {
  const linhas = texto.split(/\r?\n/);
  const semVazias = linhas.filter((l) => l.trim() !== "" && l.replace(/;/g, "").trim() !== "");
  if (!semVazias.length) return [];

  const primeira = semVazias[0].toUpperCase();
  const formatoA = primeira.includes("DATA DA ROTA");
  const registros = [];

  if (formatoA) {
    semVazias.slice(1).forEach((linha) => {
      const c = linha.split(";").map(limpar);
      if (!ehData(c[0])) return; // pula cabeçalhos/lixo
      const tempos = c.slice(4).filter(ehHora);
      if (!tempos.length) return;
      registros.push({ data: dataISO(c[0]), rota: c[1], motorista: c[2], placa: c[3], tempos });
    });
  } else {
    // Formato B — a data vem em linhas-cabeçalho de bloco
    let dataAtual = null;
    semVazias.forEach((linha) => {
      const c = linha.split(";").map(limpar);
      if (ehData(c[0]) && !c[1] && !c[2]) {
        dataAtual = dataISO(c[0]);
        return;
      }
      if (!dataAtual || !c[0]) return;
      const tempos = c.slice(3).filter(ehHora);
      if (!tempos.length) return;
      registros.push({ data: dataAtual, rota: c[2], motorista: c[0], placa: c[1], tempos });
    });
  }
  return registros;
}

// Quebra um registro em linhas-dia (1 por par saída/retorno).
function expandirDias(reg) {
  const pares = [];
  for (let i = 0; i < reg.tempos.length; i += 2) {
    pares.push([reg.tempos[i], reg.tempos[i + 1] || null]);
  }
  const totalDias = pares.length;
  return pares.map(([saida, retorno], i) => {
    const j = dadosJornada(saida, retorno);
    return {
      data: somarDias(reg.data, i),
      motorista: limpar(reg.motorista),
      placa: limpar(reg.placa).toUpperCase(),
      rota_feita: limpar(reg.rota),
      saida,
      retorno,
      ...j,
      obs: totalDias > 1 ? `Viagem ${i + 1}/${totalDias} (${limpar(reg.rota)})` : "",
    };
  });
}

// ---------------- MAIN ----------------
async function main() {
  const arquivos = (ARQS_CLI.length ? ARQS_CLI : ARQS_PADRAO.map((n) => path.join(RAIZ, n)))
    .filter((p) => {
      if (fs.existsSync(p)) return true;
      console.warn(`⚠️  Arquivo não encontrado, ignorando: ${p}`);
      return false;
    });

  if (!arquivos.length) {
    console.error("Nenhum CSV encontrado. Passe os caminhos como argumento ou coloque os arquivos na raiz do projeto.");
    process.exit(1);
  }

  // monta todas as linhas-dia
  let linhasDia = [];
  for (const arq of arquivos) {
    const regs = parseCSV(lerArquivoTexto(arq));
    const expand = regs.flatMap(expandirDias).filter((l) => l.rota_feita && l.saida);
    console.log(`📄 ${path.basename(arq)} -> ${regs.length} registros / ${expand.length} linhas-dia`);
    linhasDia = linhasDia.concat(expand);
  }

  console.log(`\nTotal de linhas-dia a processar: ${linhasDia.length}`);
  if (DRY_RUN) {
    console.log("\n--- DRY-RUN (nada será gravado) — amostra das 15 primeiras: ---");
    linhasDia.slice(0, 15).forEach((l) =>
      console.log(`  ${l.data} | ${l.rota_feita} | ${l.motorista} | ${l.placa} | ${l.saida}→${l.retorno || "—"} | ${l.horas ?? "?"}h${l.minutos ?? ""} | ${l.obs}`),
    );
  }

  // próximo id (a tabela usa id inteiro explícito, estilo Date.now)
  const maxRes = await db.query("SELECT COALESCE(MAX(id),0)::bigint AS m FROM rotas_registradas");
  let proximoId = Number(maxRes.rows[0].m) + 1;

  let inseridos = 0, pulados = 0;
  for (const l of linhasDia) {
    // idempotência
    const existe = await db.query(
      `SELECT 1 FROM rotas_registradas
       WHERE data = $1 AND rota_feita = $2 AND saida = $3
         AND retorno IS NOT DISTINCT FROM $4 AND motorista = $5
       LIMIT 1`,
      [l.data, l.rota_feita, l.saida, l.retorno, l.motorista],
    );
    if (existe.rowCount > 0) {
      pulados += 1;
      continue;
    }
    if (DRY_RUN) {
      inseridos += 1;
      continue;
    }
    await db.query(
      `INSERT INTO rotas_registradas
        (id, data, motorista, placa, rota_feita, saida, retorno,
         total_min, horas, minutos, minutos_normais,
         minutos_extras_permitidos, minutos_excedentes, valor_extra_aprox, obs)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        proximoId++, l.data, l.motorista, l.placa, l.rota_feita, l.saida, l.retorno,
        l.total_min, l.horas, l.minutos, l.minutos_normais,
        l.minutos_extras_permitidos, l.minutos_excedentes, l.valor_extra_aprox, l.obs || null,
      ],
    );
    inseridos += 1;
  }

  console.log(`\n✅ ${DRY_RUN ? "[DRY] " : ""}${inseridos} inserido(s), ${pulados} já existia(m).`);
  // mostra rotas distintas (úteis pra conferir o link com o Deslocamento)
  const rotas = [...new Set(linhasDia.map((l) => `${l.rota_feita}  ->  ${canonizarRota(l.rota_feita)}`))].sort();
  console.log(`\nRotas vistas (texto -> canônico que o Deslocamento usa):`);
  rotas.forEach((r) => console.log("  " + r));
}

main()
  .catch((err) => {
    console.error("❌ Erro na importação:", err);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode || 0));
