// ================================================================
// detectar-duplicatas.js  —  SOMENTE LEITURA (não altera nada)
// ----------------------------------------------------------------
// Vasculha a tabela `ocorrencias` e RELATA possíveis duplicatas, pelas
// duas chaves de negócio (ver dup-chaves.js):
//   (A) data + motorista + texto(descrição)   -> importadores de ocorrência
//   (B) data + rota + loja + hora_chegada      -> importador de entregas/form
// e também o caso perigoso de mesmo evento gravado com STATUS divergente
// ('Aberta' x 'Encerrada') — o ID fantasma que o importar-ocorrencias-rota
// pode ter criado.
//
// NÃO escreve nada. Pode rodar à vontade.
//
// Como rodar (na MÁQUINA DO SERVIDOR 192.0.2.10, onde estão Node + banco):
//     node back/detectar-duplicatas.js
//     node back/detectar-duplicatas.js --tudo     (lista todos os grupos, sem cortar em 20)
// ================================================================

const db = require("./db");
const K = require("./dup-chaves");

const MOSTRAR_TUDO = process.argv.includes("--tudo");
const LIMITE_LISTA = MOSTRAR_TUDO ? Infinity : 20;

function agrupar(rows, fnChave) {
  const mapa = new Map();
  for (const r of rows) {
    const k = fnChave(r);
    if (!k) continue;
    if (!mapa.has(k)) mapa.set(k, []);
    mapa.get(k).push(r);
  }
  return [...mapa.entries()].filter(([, g]) => g.length > 1);
}

function relatarGrupos(titulo, grupos) {
  console.log("\n" + "=".repeat(64));
  console.log(titulo);
  console.log("=".repeat(64));
  const linhasExtras = grupos.reduce((acc, [, g]) => acc + (g.length - 1), 0);
  console.log(`Grupos duplicados: ${grupos.length}   |   linhas em excesso (removíveis): ${linhasExtras}`);
  if (grupos.length === 0) return;
  grupos
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, LIMITE_LISTA)
    .forEach(([chave, g]) => {
      const ids = g.map((r) => r.id).sort((a, b) => a - b);
      const status = [...new Set(g.map((r) => r.ocorrencia_status || "—"))].join(" / ");
      console.log(`  ${g.length}x  ids=[${ids.join(", ")}]  status={${status}}`);
      console.log(`        ${chave.slice(0, 110)}`);
    });
  if (grupos.length > LIMITE_LISTA) {
    console.log(`  ... e mais ${grupos.length - LIMITE_LISTA} grupos (rode com --tudo para ver todos).`);
  }
}

async function main() {
  const client = await db.connect();
  try {
    await client.query("SET default_transaction_read_only = on"); // trava: nada de escrita
    const { rows } = await client.query("SELECT * FROM ocorrencias");

    console.log("================================================================");
    console.log(`Tabela ocorrencias: ${rows.length} linhas no total.`);

    const gruposOco = agrupar(rows, K.chaveOcorrencia);
    const gruposEnt = agrupar(rows, K.chaveEntrega);

    relatarGrupos(
      "CHAVE (A): data + motorista + texto da descrição  [importadores de ocorrência]",
      gruposOco,
    );
    relatarGrupos(
      "CHAVE (B): data + rota + loja + hora_chegada  [importador de entregas / formulário]",
      gruposEnt,
    );

    // Caso perigoso: mesmo evento (chave A) com status divergente — provável
    // ID 'Aberta' fantasma convivendo com a versão 'Encerrada'.
    const statusDivergente = gruposOco.filter(([, g]) => {
      const st = new Set(g.map((r) => r.ocorrencia_status));
      return st.has("Aberta") && st.size > 1;
    });
    console.log("\n" + "=".repeat(64));
    console.log("ALERTA: grupos com STATUS divergente (uma 'Aberta' + outra encerrada)");
    console.log("=".repeat(64));
    console.log(`Grupos: ${statusDivergente.length}  (IDs 'Aberta' que talvez sejam tratativa fantasma)`);
    statusDivergente.slice(0, LIMITE_LISTA).forEach(([chave, g]) => {
      const abertas = g.filter((r) => r.ocorrencia_status === "Aberta").map((r) => r.id);
      console.log(`  ids 'Aberta'=[${abertas.join(", ")}]  no grupo de ${g.length}  ::  ${chave.slice(0, 80)}`);
    });

    // Resumo final
    const excessoA = gruposOco.reduce((a, [, g]) => a + g.length - 1, 0);
    const excessoB = gruposEnt.reduce((a, [, g]) => a + g.length - 1, 0);
    console.log("\n" + "=".repeat(64));
    console.log("RESUMO");
    console.log("=".repeat(64));
    console.log(`  linhas em excesso pela chave A (ocorrência): ${excessoA}`);
    console.log(`  linhas em excesso pela chave B (entrega)   : ${excessoB}`);
    console.log("  (as duas chaves podem se sobrepor; o deduplicador trata sem contar 2x)");
    console.log("\nPróximo passo: node back/deduplicar-ocorrencias.js --dry-run");
  } catch (err) {
    console.error("❌ Erro na leitura:", err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    process.exit();
  }
}

main();
