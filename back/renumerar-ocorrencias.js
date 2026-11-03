// ================================================================
// renumerar-ocorrencias.js  —  USO ÚNICO
// ----------------------------------------------------------------
// Renumera os ids da tabela `ocorrencias` para uma sequência limpa
// 1, 2, 3, ... N (ordenados pela ordem de criação = id atual).
//
// ATENÇÃO: as "lacunas" deixadas por registros excluídos DESAPARECEM
// (tudo fica contíguo). Os vínculos em tms_paradas.ocorrencia_id são
// atualizados junto, para os links com o TMS continuarem corretos.
// O log de auditoria NÃO é reescrito (ids antigos ficam no histórico).
//
// FAÇA BACKUP DO BANCO ANTES DE RODAR.
//
// Como rodar (na pasta do projeto):
//     node back/renumerar-ocorrencias.js
// ================================================================

const db = require("./db");

async function main() {
  const client = await db.connect();
  try {
    const { rows: antes } = await client.query(
      "SELECT COUNT(*)::int AS n, COALESCE(MAX(id), 0)::int AS maxid FROM ocorrencias",
    );
    console.log(
      `Ocorrências encontradas: ${antes[0].n} | maior id atual: ${antes[0].maxid}`,
    );

    if (antes[0].n === 0) {
      console.log("Nada para renumerar. Encerrando.");
      return;
    }

    await client.query("BEGIN");

    // Mapa old_id -> new_id (1..N na ordem de criação).
    await client.query(`
      CREATE TEMP TABLE _mapa_oco ON COMMIT DROP AS
        SELECT id AS old_id,
               ROW_NUMBER() OVER (ORDER BY id) AS new_id
        FROM ocorrencias
    `);

    // Move para o espaço negativo (evita colisão da PK durante a troca).
    await client.query(`
      UPDATE ocorrencias o
         SET id = -(m.new_id)
        FROM _mapa_oco m
       WHERE o.id = m.old_id
    `);
    await client.query(`
      UPDATE tms_paradas p
         SET ocorrencia_id = -(m.new_id)
        FROM _mapa_oco m
       WHERE p.ocorrencia_id = m.old_id
    `);

    // Vira para positivo: ficam 1..N definitivos.
    await client.query("UPDATE ocorrencias SET id = -id WHERE id < 0");
    await client.query(
      "UPDATE tms_paradas SET ocorrencia_id = -ocorrencia_id WHERE ocorrencia_id < 0",
    );

    // Acerta a sequência: o próximo id será N+1.
    await client.query(`
      SELECT setval(
        pg_get_serial_sequence('ocorrencias', 'id'),
        (SELECT COUNT(*) FROM ocorrencias),
        true
      )
    `);

    await client.query("COMMIT");

    const { rows: depois } = await client.query(
      "SELECT COUNT(*)::int AS n, COALESCE(MAX(id), 0)::int AS maxid FROM ocorrencias",
    );
    console.log(
      `✅ Concluído. Agora os ids vão de 1 a ${depois[0].maxid} (${depois[0].n} registros).`,
    );
    console.log("O próximo id criado será", depois[0].maxid + 1 + ".");
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
