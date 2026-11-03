// ================================================================
// normalizar-lojas-banco.js  —  USO ÚNICO / repetível
// ----------------------------------------------------------------
// VARREDURA GERAL de nomes de LOJA no banco (ver normalizar-loja.js):
// corrige mojibake/typos, acentos e unifica romano/arábico
// (CAXIAS I == CAXIAS 1, MAGE II == MAGÉ 2), eliminando duplicatas
// nos gráficos por loja, rankings e na análise de deslocamento.
//
// Varre TODAS estas colunas:
//     ocorrencias.loja
//     ocorrencias_avulsas.loja
//
// FAÇA BACKUP DO BANCO ANTES DE RODAR (ou use POST /admin/backup-agora).
//
// Como rodar (NA MÁQUINA DO SERVIDOR):
//     node back/normalizar-lojas-banco.js --dry-run   -> só mostra o de/para
//     node back/normalizar-lojas-banco.js             -> grava
// ================================================================

const db = require("./db");
const { canonizarLoja } = require("./normalizar-loja");

const DRY = process.argv.includes("--dry-run");

// Cada alvo é uma coluna de loja a padronizar. Adicione aqui se surgir outra.
const ALVOS = [
  { tabela: "ocorrencias", coluna: "loja" },
  { tabela: "ocorrencias_avulsas", coluna: "loja" },
];

// Padroniza UMA coluna; devolve { distintas, grafias, linhas }.
async function normalizarColuna(client, tabela, coluna) {
  // Tabela/coluna podem não existir em bancos antigos — não derruba a varredura.
  const existe = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [tabela, coluna],
  );
  if (!existe.rowCount) {
    console.log(`\n• ${tabela}.${coluna}: coluna não existe — pulando.`);
    return { distintas: 0, grafias: 0, linhas: 0 };
  }

  const { rows } = await client.query(
    `SELECT DISTINCT ${coluna} AS valor FROM ${tabela} WHERE ${coluna} IS NOT NULL AND TRIM(${coluna}) <> ''`,
  );
  const mudancas = rows
    .map((r) => [r.valor, canonizarLoja(r.valor)])
    .filter(([antigo, novo]) => novo && novo !== antigo);

  console.log(`\n• ${tabela}.${coluna}`);
  console.log(`    lojas distintas : ${rows.length}`);
  console.log(`    a padronizar    : ${mudancas.length}`);
  mudancas
    .sort((a, b) => a[1].localeCompare(b[1]))
    .forEach(([a, b]) => console.log(`      "${a}"  ->  "${b}"`));

  if (DRY || mudancas.length === 0) {
    return { distintas: rows.length, grafias: mudancas.length, linhas: 0 };
  }

  let linhas = 0;
  for (const [antigo, novo] of mudancas) {
    const r = await client.query(
      `UPDATE ${tabela} SET ${coluna} = $1 WHERE ${coluna} = $2`,
      [novo, antigo],
    );
    linhas += r.rowCount;
  }
  console.log(`    linhas atualizadas: ${linhas}`);
  return { distintas: rows.length, grafias: mudancas.length, linhas };
}

async function main() {
  const client = await db.connect();
  try {
    console.log("================================================");
    console.log(DRY ? "MODO: DRY-RUN (nada será gravado)" : "MODO: GRAVAÇÃO");

    if (!DRY) await client.query("BEGIN");

    let totalGrafias = 0;
    let totalLinhas = 0;
    for (const { tabela, coluna } of ALVOS) {
      const r = await normalizarColuna(client, tabela, coluna);
      totalGrafias += r.grafias;
      totalLinhas += r.linhas;
    }

    if (!DRY) await client.query("COMMIT");

    console.log("\n================================================");
    if (DRY) {
      console.log(`Total de grafias a padronizar: ${totalGrafias}`);
      console.log("(DRY-RUN) Rode sem --dry-run para gravar.");
    } else {
      console.log(`✅ Concluído. Grafias padronizadas: ${totalGrafias} · linhas atualizadas: ${totalLinhas}`);
    }
    console.log("================================================");
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
