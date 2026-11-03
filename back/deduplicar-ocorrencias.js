// ================================================================
// deduplicar-ocorrencias.js  —  remove duplicatas da tabela `ocorrencias`
// ----------------------------------------------------------------
// Em cada grupo de duplicatas (mesma chave de negócio — ver dup-chaves.js)
// MANTÉM a linha mais completa (maior pontuação; empate -> menor id = mais
// antiga) e APAGA as demais. Antes de apagar, religa os vínculos do TMS
// (tms_paradas.ocorrencia_id) para a linha que fica, igual ao renumerar.
//
// >>> SEGURO POR PADRÃO <<<
//   - Roda em --dry-run (só mostra) a menos que receba --executar.
//   - Grupo onde uma das linhas A APAGAR tem conteúdo digitado por humano
//     (causa_raiz / ação_corretiva / responsável / fotos / POD) é PULADO e
//     mandado para REVISÃO MANUAL — nunca apagado automaticamente
//     (a menos que você passe --forcar, assumindo o risco).
//   - Tudo numa transação: se algo falhar, faz ROLLBACK (nada muda).
//
// FAÇA BACKUP DO BANCO ANTES DE RODAR COM --executar.
//
// Como rodar (na MÁQUINA DO SERVIDOR 192.0.2.10, Node + banco juntos):
//     node back/deduplicar-ocorrencias.js                 -> DRY-RUN (padrão)
//     node back/deduplicar-ocorrencias.js --dry-run        -> idem, explícito
//     node back/deduplicar-ocorrencias.js --executar       -> APAGA de verdade
//     node back/deduplicar-ocorrencias.js --chave=ocorrencia|entrega|ambas
//     node back/deduplicar-ocorrencias.js --executar --forcar  -> apaga até grupos com conteúdo humano
// ================================================================

const db = require("./db");
const K = require("./dup-chaves");

const EXECUTAR = process.argv.includes("--executar");
const DRY = !EXECUTAR; // padrão = dry-run
const FORCAR = process.argv.includes("--forcar");
const argChave = (process.argv.find((a) => a.startsWith("--chave=")) || "--chave=ambas").split("=")[1];
const USAR_OCO = argChave === "ambas" || argChave === "ocorrencia";
const USAR_ENT = argChave === "ambas" || argChave === "entrega";

function agrupar(rows, fnChave, etiqueta) {
  const mapa = new Map();
  for (const r of rows) {
    const k = fnChave(r);
    if (!k) continue;
    if (!mapa.has(k)) mapa.set(k, []);
    mapa.get(k).push(r);
  }
  return [...mapa.entries()]
    .filter(([, g]) => g.length > 1)
    .map(([chave, g]) => ({ chave, etiqueta, linhas: g }));
}

// Escolhe a sobrevivente: maior pontuação; empate -> menor id.
function escolherSobrevivente(linhas) {
  return linhas.slice().sort((a, b) => {
    const d = K.pontuacao(b) - K.pontuacao(a);
    return d !== 0 ? d : a.id - b.id;
  })[0];
}

async function main() {
  const client = await db.connect();
  try {
    const { rows } = await client.query("SELECT * FROM ocorrencias");
    console.log("================================================================");
    console.log(`Tabela ocorrencias: ${rows.length} linhas. Chave(s): ${argChave}`);
    console.log(DRY ? "MODO: DRY-RUN (nada será apagado)" : "MODO: EXECUTAR (vai apagar)");
    if (FORCAR) console.log("⚠️  --forcar ATIVO: grupos com conteúdo humano também serão deduplicados.");
    console.log("================================================================");

    const grupos = [];
    if (USAR_OCO) grupos.push(...agrupar(rows, K.chaveOcorrencia, "A:ocorrência"));
    if (USAR_ENT) grupos.push(...agrupar(rows, K.chaveEntrega, "B:entrega"));

    const deletados = new Set();
    const sobreviventes = new Set();
    const acoes = [];      // {sobrevivente, vitimas:[ids], etiqueta, chave}
    const revisar = [];    // {motivo, ids, etiqueta, chave}

    for (const grp of grupos) {
      // Ignora linhas já marcadas para apagar em um grupo anterior.
      const linhas = grp.linhas.filter((r) => !deletados.has(r.id));
      if (linhas.length < 2) continue;

      const sob = escolherSobrevivente(linhas);
      const vitimas = linhas.filter((r) => r.id !== sob.id);

      // Conflito: alguma vítima já foi escolhida como sobrevivente noutro grupo.
      if (vitimas.some((v) => sobreviventes.has(v.id))) {
        revisar.push({ motivo: "sobreposição de grupos", ids: linhas.map((r) => r.id), etiqueta: grp.etiqueta, chave: grp.chave });
        continue;
      }

      // Proteção: vítima com conteúdo humano não é apagada automaticamente.
      const vitimasComHumano = vitimas.filter(K.temConteudoHumano);
      if (vitimasComHumano.length && !FORCAR) {
        revisar.push({
          motivo: "linha a apagar tem conteúdo humano (causa/ação/responsável/fotos/POD)",
          ids: linhas.map((r) => r.id),
          protegidas: vitimasComHumano.map((r) => r.id),
          etiqueta: grp.etiqueta,
          chave: grp.chave,
        });
        continue;
      }

      sobreviventes.add(sob.id);
      vitimas.forEach((v) => deletados.add(v.id));
      acoes.push({ sobrevivente: sob.id, vitimas: vitimas.map((v) => v.id), etiqueta: grp.etiqueta, chave: grp.chave });
    }

    // ---- Relatório ----
    console.log(`\nGrupos a deduplicar: ${acoes.length}`);
    console.log(`Linhas a apagar    : ${deletados.size}`);
    console.log(`Grupos p/ REVISÃO manual (não tocados): ${revisar.length}`);

    const PREVIA = 25;
    acoes.slice(0, PREVIA).forEach((a) =>
      console.log(`  [${a.etiqueta}] mantém id=${a.sobrevivente}  apaga=[${a.vitimas.join(", ")}]`),
    );
    if (acoes.length > PREVIA) console.log(`  ... e mais ${acoes.length - PREVIA} grupos.`);

    if (revisar.length) {
      console.log("\n--- REVISÃO MANUAL (resolva à mão; o script não mexe) ---");
      revisar.slice(0, PREVIA).forEach((r) =>
        console.log(`  [${r.etiqueta}] ids=[${r.ids.join(", ")}] :: ${r.motivo}` +
          (r.protegidas ? ` (protegidas: ${r.protegidas.join(", ")})` : "")),
      );
      if (revisar.length > PREVIA) console.log(`  ... e mais ${revisar.length - PREVIA} grupos.`);
    }

    if (DRY) {
      console.log("\n(DRY-RUN) Nada foi alterado. Rode com --executar para apagar (faça backup antes).");
      return;
    }
    if (acoes.length === 0) {
      console.log("\nNada a apagar. Encerrando.");
      return;
    }

    // ---- Execução ----
    await client.query("BEGIN");
    let religados = 0;
    let apagados = 0;
    for (const a of acoes) {
      for (const vid of a.vitimas) {
        const up = await client.query(
          "UPDATE tms_paradas SET ocorrencia_id = $1 WHERE ocorrencia_id = $2",
          [a.sobrevivente, vid],
        );
        religados += up.rowCount;
        const del = await client.query("DELETE FROM ocorrencias WHERE id = $1", [vid]);
        apagados += del.rowCount;
      }
    }
    await client.query("COMMIT");
    console.log(`\n✅ Concluído. Linhas apagadas: ${apagados} | vínculos tms_paradas religados: ${religados}`);
    console.log("Dica: rode node back/detectar-duplicatas.js de novo para confirmar que zerou.");
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
