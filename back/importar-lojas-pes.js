// ================================================================
// importar-lojas-pes.js — atualiza o cadastro unico de loja (PES), os km
// entre lojas, os carros (tipo de frete) e a formula do frete a partir das
// planilhas da expedicao. Detalhes em lojas-pes.js.
//
//     node back/importar-lojas-pes.js --dry     (so confere, nao grava)
//     node back/importar-lojas-pes.js           (grava)
//     node back/importar-lojas-pes.js --pasta "Y:\2026"
// ================================================================
const db = require("./db");
const { importar } = require("./lojas-pes");

async function main() {
  const dry = process.argv.includes("--dry");
  const iPasta = process.argv.indexOf("--pasta");
  const pasta = iPasta > 0 ? process.argv[iPasta + 1] : undefined;
  const client = await db.connect();
  try {
    const { relatorio } = await importar(client, { pasta, dry });
    const lista = (titulo, itens) => {
      if (!itens.length) return;
      console.log(`\n${titulo} (${itens.length}):`);
      itens.forEach((i) => console.log(`  - ${i}`));
    };
    lista("Grafias do banco sem loja correspondente", relatorio.grafias_sem_loja);
    lista("Nomes da planilha de km sem loja", relatorio.km_nomes_sem_loja);
    lista("Frete da planilha diferente da formula", relatorio.frete_formula_diverge);
    lista("Placas sem modelo na aba CARROS (frete calculado como 2 eixos, marcado estimado)", relatorio.placas_sem_modelo);
    console.log(`\nCapa da frente: ${relatorio.lojas_com_telefone} loja(s) com celular, ${relatorio.lojas_com_docas} com quadro de docas` +
      (relatorio.docas_criadas != null ? ` (${relatorio.docas_criadas} docas novas, ${relatorio.docas_atualizadas} corrigidas)` : ""));
    lista("Nomes da capa sem loja (sem PES)", relatorio.capa_nomes_sem_loja);
    lista("Avisos", relatorio.avisos);
    console.log(dry ? "\n--dry: nada gravado." : "\nOK.");
  } finally {
    client.release();
    await db.pool.end();
  }
}

main().catch((err) => { console.error("Erro:", err.message); process.exit(1); });
