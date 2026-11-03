// Corrige registros importados como ocorrencia quando o texto indica entrega normal.
//
// Uso:
//   node back/corrigir-sem-divergencia.js
//   node back/corrigir-sem-divergencia.js --aplicar

const db = require("./db");

const APLICAR = process.argv.includes("--aplicar");
const DATAS_CONFERENCIA = ["2026-05-05", "2026-05-15"];

const WHERE_SEM_DIVERGENCIA = `
  (
    UPPER(COALESCE(tipo_problema, '') || ' ' || COALESCE(descricao, '')) LIKE '%SEM DIVERG%'
    OR UPPER(COALESCE(tipo_problema, '') || ' ' || COALESCE(descricao, '')) LIKE '%CONCLUI%D%SEM%DIVERG%'
    OR UPPER(COALESCE(tipo_problema, '') || ' ' || COALESCE(descricao, '')) LIKE '%ENTREGUE%SEM%DIVERG%'
  )
  AND (
    COALESCE(teve_ocorrencia, false) = true
    OR tipo_problema IS NOT NULL
    OR COALESCE(ocorrencia_status, '') <> 'Nao se aplica'
    OR COALESCE(entrega_completa, false) = false
  )
`;

async function main() {
  const client = await db.connect();
  try {
    const preview = await client.query(
      `
        SELECT
          id,
          data_ocorrencia::text AS data,
          COALESCE(loja, '') AS loja,
          COALESCE(rota, '') AS rota,
          COALESCE(tipo_problema, '') AS tipo_problema,
          COALESCE(descricao, '') AS descricao
        FROM ocorrencias
        WHERE ${WHERE_SEM_DIVERGENCIA}
        ORDER BY data_ocorrencia, id
      `,
    );

    console.log(`Registros encontrados: ${preview.rowCount}`);
    console.table(
      preview.rows.slice(0, 30).map((r) => ({
        id: r.id,
        data: r.data,
        loja: r.loja,
        rota: r.rota,
        tipo: r.tipo_problema,
        descricao: r.descricao.slice(0, 80),
      })),
    );

    const duplicadas = await client.query(
      `
        SELECT
          data_ocorrencia::text AS data,
          COALESCE(rota, '') AS rota,
          COALESCE(loja, '') AS loja,
          COALESCE(hora_chegada::text, '') AS hora_chegada,
          COUNT(*)::int AS total,
          ARRAY_AGG(id ORDER BY id) AS ids
        FROM ocorrencias
        WHERE data_ocorrencia = ANY($1::date[])
        GROUP BY data_ocorrencia, COALESCE(rota, ''), COALESCE(loja, ''), COALESCE(hora_chegada::text, '')
        HAVING COUNT(*) > 1
        ORDER BY data_ocorrencia, total DESC, rota, loja
      `,
      [DATAS_CONFERENCIA],
    );

    console.log("\nPossiveis duplicidades em 05/05 e 15/05:");
    console.table(
      duplicadas.rows.slice(0, 50).map((r) => ({
        data: r.data,
        rota: r.rota,
        loja: r.loja,
        hora: r.hora_chegada,
        total: r.total,
        ids: r.ids.join(","),
      })),
    );

    if (!APLICAR) {
      console.log("\nPrevia apenas. Rode com --aplicar para corrigir o banco.");
      return;
    }

    await client.query("BEGIN");
    const update = await client.query(
      `
        UPDATE ocorrencias
        SET
          teve_ocorrencia = false,
          tipo_problema = NULL,
          ocorrencia_status = 'Nao se aplica',
          entrega_completa = true
        WHERE ${WHERE_SEM_DIVERGENCIA}
        RETURNING id, data_ocorrencia::text AS data, loja, rota
      `,
    );
    await client.query("COMMIT");

    console.log(`\nCorrigidos: ${update.rowCount}`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Falha ao corrigir registros:", err.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

main().finally(() => process.exit());
