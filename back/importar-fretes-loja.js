// ================================================================
// importar-fretes-loja.js — tabela de FRETE (ida/retorno) por LOJA
// ----------------------------------------------------------------
// Fonte: planilha "ROTAS / FRETE ENVIO / FRETE RETORNO" da operacao.
// Alimenta tms_fretes_loja, que a aba "CTEs do dia" usa para mostrar o
// valor do frete de ida e de retorno em cada loja.
//
// A chave e o nome CANONICO da loja (chaveLoja) e NAO o loja_id:
// as paradas do TMS chegam do Checklist Expedicao com loja_id nulo e
// apenas o nome, que na base aparece com e sem acento (MARICA/MARICÁ,
// N IGUAÇU/N.IGUAÇU I, NILOPOLIS/NILÓPOLIS).
//
// Idempotente: apaga o que nao esta mais na lista e regrava o resto.
// Rode sempre que a planilha de frete mudar:
//     node back/importar-fretes-loja.js
// Use --dry para so conferir o de-para sem gravar nada.
// ================================================================

const db = require("./db");
const { chaveLoja } = require("./normalizar-loja");

// [rota, PES, EMP, loja, frete_envio, frete_retorno]
const FRETES = [
  // ── Z. NORTE I (saida 05:00) ──────────────────────────────────
  ["Z. NORTE I", "237", "211", "MADUREIRA II", 426.60, 458.10],
  ["Z. NORTE I", "552", "326", "MADUREIRA IV", 428.40, 455.40],
  ["Z. NORTE I", "402", "225", "MADUREIRA I", 377.10, 452.70],
  ["Z. NORTE I", "546", "320", "TAQUARA PLAZA", 324.00, 311.40],
  ["Z. NORTE I", "543", "317", "TAQUARA", 341.00, 335.70],
  ["Z. NORTE I", "523", "299", "CENTER", 359.10, 347.40],
  ["Z. NORTE I", "483", "278", "FREGUESIA", 340.20, 332.10],
  ["Z. NORTE I", "507", "290", "RIO DAS PEDRAS", 357.30, 363.60],
  ["Z. NORTE I", "532", "306", "METROPOLITANO", 295.20, 227.20],

  // ── Z. NORTE II (saida 05:00) ─────────────────────────────────
  ["Z. NORTE II", "365", "247", "NOVA AMERICA", 443.70, 431.10],
  ["Z. NORTE II", "349", "229", "NORTE", 435.60, 422.10],
  ["Z. NORTE II", "229", "206", "MEIER", 422.10, 424.80],
  ["Z. NORTE II", "247", "207", "IGUATEMI", 490.50, 486.00],
  ["Z. NORTE II", "239", "212", "TIJUCA II", 561.60, 504.00],
  ["Z. NORTE II", "524", "301", "DOWNTOWN", 314.10, 321.30],
  ["Z. NORTE II", "387", "215", "AMÉRICAS", 186.30, 180.90],
  ["Z. NORTE II", "331", "218", "RECREIO", 150.30, 156.60],
  ["Z. NORTE II", "550", "324", "PONTAL", 173.70, 181.80],

  // ── Z. OESTE I (saida 07:20) ──────────────────────────────────
  ["Z. OESTE I", "345", "227", "SANTA CRUZ III", 91.80, 105.30],
  ["Z. OESTE I", "249", "213", "SANTA CRUZ I", 91.80, 105.30],
  ["Z. OESTE I", "335", "221", "SANTA CRUZ II", 93.60, 103.50],
  ["Z. OESTE I", "235", "210", "ITAGUAÍ I", 226.80, 214.20],
  ["Z. OESTE I", "467", "271", "ITAGUAÍ II", 254.80, 236.70],
  ["Z. OESTE I", "511", "294", "ANGRA DOS REIS", 1008.00, 990.00],

  // ── Z. OESTE II (saida 07:20) ─────────────────────────────────
  ["Z. OESTE II", "418", "240", "CAMPO GRANDE III", 111.60, 102.60],
  ["Z. OESTE II", "553", "327", "PASSEIO", 106.20, 100.80],
  ["Z. OESTE II", "341", "224", "BANGU I", 198.90, 194.40],
  ["Z. OESTE II", "549", "323", "BANGU V", 204.30, 195.30],
  ["Z. OESTE II", "538", "312", "BANGU IV", 244.80, 194.40],
  ["Z. OESTE II", "499", "282", "SULACAP", 363.60, 343.80],

  // ── Z. OESTE IV (saida 08:00) ─────────────────────────────────
  ["Z. OESTE IV", "455", "265", "PARK", 78.30, 69.30],
  ["Z. OESTE IV", "395", "258", "OLINDA ELLIS", 99.00, 94.50],
  ["Z. OESTE IV", "351", "230", "WEST III", 132.30, 117.00],
  ["Z. OESTE IV", "528", "303", "MAX SHOPPING", 220.50, 159.30],

  // ── ALTERNATIVA I (saida 05:00) ───────────────────────────────
  ["ALTERNATIVA I", "551", "325", "NITERÓI IV", 625.50, 633.60],
  ["ALTERNATIVA I", "471", "273", "NITERÓI II", 631.80, 631.80],
  ["ALTERNATIVA I", "243", "204", "SÃO GONÇALO I", 694.80, 700.20],
  ["ALTERNATIVA I", "367", "251", "SÃO GONÇALO II", 725.40, 728.10],
  ["ALTERNATIVA I", "254", "300", "SÃO GONÇALO IV", 727.20, 711.90],
  ["ALTERNATIVA I", "477", "272", "ALCÂNTARA", 749.70, 756.90],
  ["ALTERNATIVA I", "541", "315", "ITABORAÍ IV", 852.30, 892.80],
  ["ALTERNATIVA I", "554", "328", "NOVA FRIBURGO", 1647.00, 1629.00],
  // DJOFFER fica DE FORA de proposito. Esta na planilha (1.692,00 / 1.674,00),
  // mas e a unica linha sem PES e sem EMP e a operacao definiu que nao entra na
  // conta do CTE. Se um dia voltar a contar, basta descomentar:
  // ["ALTERNATIVA I", null, null, "DJOFFER", 1692.00, 1674.00],
  ["ALTERNATIVA I", "544", "318", "TERESÓPOLIS", 1116.00, 1098.00],

  // ── CENTRO E Z. SUL (saida 05:00) ─────────────────────────────
  ["CENTRO E Z. SUL", "389", "237", "COPACABANA I", 451.80, 448.20],
  ["CENTRO E Z. SUL", "420", "239", "COPACABANA II", 453.60, 457.20],
  ["CENTRO E Z. SUL", "375", "253", "CENTRO I", 562.50, 566.10],
  ["CENTRO E Z. SUL", "359", "244", "CENTRO II", 565.20, 566.10],
  ["CENTRO E Z. SUL", "4147", "219", "ILHA", 566.10, 556.20],
  ["CENTRO E Z. SUL", "414", "250", "BONSUCESSO II", 471.60, 457.20],
  ["CENTRO E Z. SUL", "500", "292", "PENHA", 492.30, 491.40],

  // ── BAIXADA II (saida 05:40) ──────────────────────────────────
  ["BAIXADA II", "505", "291", "CAXIAS CENTRO", 430.20, 421.20],
  ["BAIXADA II", "337", "222", "CAXIAS I", 455.40, 432.90],
  ["BAIXADA II", "428", "261", "OUTLET", 573.30, 540.00],
  ["BAIXADA II", "535", "309", "MAGÉ II", 804.60, 790.20],
  ["BAIXADA II", "437", "262", "PIABETÁ", 719.10, 687.60],
  ["BAIXADA II", "422", "234", "STA. CRUZ DA SERRA", 587.70, 583.20],
  ["BAIXADA II", "545", "319", "LOTE XV", 512.10, 541.80],

  // ── BAIXADA III (saida 06:00) ─────────────────────────────────
  ["BAIXADA III", "424", "260", "GUADALUPE", 327.60, 332.10],
  ["BAIXADA III", "400", "248", "CARIOCA", 489.60, 495.00],
  ["BAIXADA III", "347", "228", "GRANDE RIO", 424.80, 414.00],
  ["BAIXADA III", "539", "313", "VILAR DOS TELES II", 452.70, 432.90],
  ["BAIXADA III", "392", "257", "SÃO JOÃO I", 380.70, 371.70],
  ["BAIXADA III", "377", "252", "VIA BRASIL", 378.00, 391.50],

  // ── BAIXADA I + R. SERRANA (saida 06:00) ──────────────────────
  ["BAIXADA I + R. SERRANA", "537", "311", "NILÓPOLIS II", 357.30, 351.90],
  ["BAIXADA I + R. SERRANA", "481", "279", "MESQUITA", 387.90, 370.80],
  ["BAIXADA I + R. SERRANA", "416", "216", "N IGUAÇU I", 441.00, 427.50],
  ["BAIXADA I + R. SERRANA", "353", "232", "N IGUAÇU III", 465.30, 444.60],
  ["BAIXADA I + R. SERRANA", "339", "223", "TOP", 455.40, 522.00],
  ["BAIXADA I + R. SERRANA", "457", "268", "N IGUAÇU II", 563.40, 560.70],
  ["BAIXADA I + R. SERRANA", "508", "293", "QUEIMADOS", 690.30, 711.90],
  ["BAIXADA I + R. SERRANA", "503", "289", "BARRA MANSA", 1143.00, 1125.00],
  ["BAIXADA I + R. SERRANA", "343", "226", "BARRA DO PIRAI", 1035.00, 1035.00],
  ["BAIXADA I + R. SERRANA", "355", "235", "VALENÇA", 1350.00, 1350.00],
  ["BAIXADA I + R. SERRANA", "461", "275", "TRÊS RIOS", 1422.00, 1386.00],

  // ── R. LAGOS (saida 04:00) ────────────────────────────────────
  ["R. LAGOS", "493", "281", "MARICÁ II", 972.00, 990.00],
  ["R. LAGOS", "445", "264", "MARICÁ I", 981.00, 981.00],
  ["R. LAGOS", "547", "321", "SAQUAREMA II", 1449.00, 1467.00],
  ["R. LAGOS", "432", "217", "ARARUAMA", 1512.00, 1521.00],
  ["R. LAGOS", "473", "277", "IGUABA", 1611.00, 1602.00],
  ["R. LAGOS", "441", "241", "S.P. ALDEIA", 1719.00, 1719.00],
  ["R. LAGOS", "491", "285", "ARRAIAL DO CABO", 1917.00, 1917.00],
  ["R. LAGOS", "540", "314", "CABO FRIO III", 1818.00, 1809.00],
  ["R. LAGOS", "469", "276", "CABO FRIO I", 1827.00, 1827.00],
  ["R. LAGOS", "459", "269", "BÚZIOS", 2034.00, 2025.00],

  // ── N. FLUMINENSE (saida 05:00) ───────────────────────────────
  ["N. FLUMINENSE", "542", "316", "RIO BONITO II", 1152.00, 1161.00],
  ["N. FLUMINENSE", "231", "208", "RIO DAS OSTRAS", 1953.00, 1971.00],
  ["N. FLUMINENSE", "408", "214", "MACAÉ I", 2142.00, 2151.00],
  ["N. FLUMINENSE", "555", "329", "MACAÉ III", 2142.00, 2142.00],
  ["N. FLUMINENSE", "225", "255", "CAMPOS I", 2934.00, 2934.00],
  ["N. FLUMINENSE", "548", "322", "CAMPOS III", 2943.00, 2952.00],
  ["N. FLUMINENSE", "536", "310", "ITAPERUNA II", 3096.00, 3087.00],
];

// Grafias que o chaveLoja NAO unifica sozinho, mas que sao a MESMA loja.
// Conferido no banco: as duas formas nunca aparecem na mesma viagem.
//   [como vem na parada, loja correspondente na planilha]
const APELIDOS = [
  ["PARK SHOPPING", "PARK"],       // Z. OESTE IV
  ["ITAGUAI", "ITAGUAÍ I"],        // "ITAGUAI" sem numero convive com ITAGUAI II
];

// Paradas que aparecem no TMS mas NAO entram na conta de frete, por decisao da
// operacao. Vao para a tabela com na_conta = FALSE e preco nulo: a aba CTE
// precisa saber que a ausencia de valor e PROPOSITAL, senao acusaria "total
// parcial" numa rota que na verdade esta fechada.
const FORA_DA_CONTA = ["DJOFFER"];

async function main() {
  const dry = process.argv.includes("--dry");

  // chave canonica -> linha da planilha
  const linhas = new Map();
  for (const [rota, pes, emp, loja, envio, retorno] of FRETES) {
    const chave = chaveLoja(loja);
    if (linhas.has(chave)) {
      console.warn(`⚠ loja repetida na planilha: ${loja} (chave ${chave}) — mantendo a primeira`);
      continue;
    }
    linhas.set(chave, { chave, loja, pes, emp, rota, envio, retorno, naConta: true });
  }

  for (const [apelido, alvo] of APELIDOS) {
    const base = linhas.get(chaveLoja(alvo));
    if (!base) { console.warn(`⚠ apelido sem loja de destino: ${apelido} -> ${alvo}`); continue; }
    const chave = chaveLoja(apelido);
    if (linhas.has(chave)) continue;
    linhas.set(chave, { ...base, chave, loja: apelido });
  }

  for (const nome of FORA_DA_CONTA) {
    const chave = chaveLoja(nome);
    if (linhas.has(chave)) {
      console.warn(`⚠ ${nome} esta em FORA_DA_CONTA e tambem na planilha — mantendo fora da conta`);
    }
    linhas.set(chave, {
      chave, loja: nome, pes: null, emp: null, rota: null,
      envio: null, retorno: null, naConta: false,
    });
  }

  const registros = [...linhas.values()];
  console.log(`Planilha: ${FRETES.length} lojas (+ apelidos, + ${FORA_DA_CONTA.length} fora da conta) = ${registros.length} chaves.`);

  // Confere a cobertura contra o que realmente existe nas paradas do TMS.
  const paradas = await db.query(
    `SELECT DISTINCT loja_nome FROM tms_paradas WHERE loja_nome IS NOT NULL AND loja_nome <> ''`
  );
  const fora = new Set(FORA_DA_CONTA.map(chaveLoja));
  const semFrete = new Set();
  for (const { loja_nome } of paradas.rows) {
    const chave = chaveLoja(loja_nome);
    if (!linhas.has(chave) && !fora.has(chave)) semFrete.add(loja_nome);
  }
  if (semFrete.size) {
    console.warn(`\n⚠ ${semFrete.size} loja(s) do TMS sem frete na planilha (vao aparecer sem valor na aba CTE):`);
    [...semFrete].sort().forEach((n) => console.warn(`   - ${n}`));
  } else {
    console.log("✓ Toda loja que aparece nas paradas do TMS tem frete.");
  }
  if (FORA_DA_CONTA.length) {
    console.log(`  (fora da conta de proposito: ${FORA_DA_CONTA.join(", ")})`);
  }

  if (dry) {
    console.log("\n--dry: nada gravado.");
    return;
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const r of registros) {
      await client.query(
        `INSERT INTO tms_fretes_loja (chave, loja_nome, pes, emp, rota, frete_envio, frete_retorno, na_conta, atualizado_em)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (chave) DO UPDATE SET
            loja_nome = EXCLUDED.loja_nome,
            pes = EXCLUDED.pes,
            emp = EXCLUDED.emp,
            rota = EXCLUDED.rota,
            frete_envio = EXCLUDED.frete_envio,
            frete_retorno = EXCLUDED.frete_retorno,
            na_conta = EXCLUDED.na_conta,
            atualizado_em = NOW()`,
        [r.chave, r.loja, r.pes, r.emp, r.rota, r.envio, r.retorno, r.naConta]
      );
    }
    // Loja retirada da planilha nao pode continuar mostrando preco velho.
    const removidas = await client.query(
      `DELETE FROM tms_fretes_loja WHERE chave <> ALL($1::text[]) RETURNING loja_nome`,
      [registros.map((r) => r.chave)]
    );
    await client.query("COMMIT");
    console.log(`\n✓ ${registros.length} frete(s) gravado(s).`);
    if (removidas.rowCount) {
      console.log(`✓ ${removidas.rowCount} removido(s): ${removidas.rows.map((r) => r.loja_nome).join(", ")}`);
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error("Erro:", err.message); process.exit(1); });
