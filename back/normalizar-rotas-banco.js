// ================================================================
// normalizar-rotas-banco.js  —  USO ÚNICO / repetível
// ----------------------------------------------------------------
// Padroniza a coluna `rota` da tabela `ocorrencias`, juntando as várias
// grafias da mesma rota num nome canônico (ver normalizar-rota.js).
// Corrige as DUPLICATAS dos gráficos (ex.: "R. LAGOS"/"R. DOS LAGOS"/
// "REGIÃO DOS LAGOS" viram um só; "Z.OESTE I"/"Z.OESTE 1" -> "ZONA OESTE 1").
//
// FAÇA BACKUP DO BANCO ANTES DE RODAR.
//
// Como rodar (NA MÁQUINA DO SERVIDOR):
//     node back/normalizar-rotas-banco.js --dry-run   -> só mostra o de/para
//     node back/normalizar-rotas-banco.js             -> grava
// ================================================================

const db = require("./db");
const { canonizarRota } = require("./normalizar-rota");

const DRY = process.argv.includes("--dry-run");

async function main() {
  const client = await db.connect();
  try {
    const { rows } = await client.query(
      "SELECT DISTINCT rota FROM ocorrencias WHERE rota IS NOT NULL AND TRIM(rota) <> ''",
    );
    const mudancas = rows
      .map((r) => [r.rota, canonizarRota(r.rota)])
      .filter(([antigo, novo]) => novo && novo !== antigo);

    console.log("================================================");
    console.log(`Rotas distintas no banco : ${rows.length}`);
    console.log(`A padronizar             : ${mudancas.length}`);
    mudancas
      .sort((a, b) => a[1].localeCompare(b[1]))
      .forEach(([a, b]) => console.log(`  "${a}"  ->  "${b}"`));
    console.log(DRY ? "MODO: DRY-RUN (nada será gravado)" : "MODO: GRAVAÇÃO");
    console.log("================================================");

    if (DRY || mudancas.length === 0) {
      if (DRY) console.log("\n(DRY-RUN) Rode sem --dry-run para gravar.");
      return;
    }

    await client.query("BEGIN");
    let atualizadas = 0;
    for (const [antigo, novo] of mudancas) {
      const r = await client.query(
        "UPDATE ocorrencias SET rota = $1 WHERE rota = $2",
        [novo, antigo],
      );
      atualizadas += r.rowCount;
    }
    await client.query("COMMIT");
    console.log(`✅ Linhas atualizadas: ${atualizadas} (em ${mudancas.length} grafias)`);
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
