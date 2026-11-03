// @ts-check
// ================================================================
// normalizar-loja.js  —  padronização canônica de nomes de LOJA
// ----------------------------------------------------------------
// Corrige mojibake (MARICÃ->MARICÁ), typos (MESQUISTA->MESQUITA,
// NOVA FRUBURGO->NOVA FRIBURGO, RIOS DAS OSTRAS->RIO DAS OSTRAS) e
// unifica romano/arábico no número da loja (MADUREIRA II == MADUREIRA 2).
// Trata "_" como espaço: BANGU_I == BANGU 1, SANTA_CRUZ_III == SANTA CRUZ 3
// (a base tem duas eras de grafia — underscore+romano e espaço+arábico).
//
// Usado pelo importar-entregas.js e pelo normalizar-lojas-banco.js.
// ================================================================

/** @type {Record<string, string>} */
const ROM = { I: "1", II: "2", III: "3", IV: "4", V: "5" };

/**
 * @param {unknown} s
 * @returns {string}
 */
function semAcento(s) {
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Stem (SEM acento, MAIÚSCULO, sem o número final) -> nome canônico correto.
// Inclui as formas "mojibake" já sem acento (ex.: MACAÃ -> strip -> MACAA).
/** @type {Record<string, string>} */
const STEM = {
  BUZIOS: "BÚZIOS", BAZIOS: "BÚZIOS",
  ALCANTARA: "ALCÂNTARA",
  AMARICAS: "AMÉRICAS", AMERICAS: "AMÉRICAS",
  "NOVA AMARICA": "NOVA AMÉRICA", "NOVA AMERICA": "NOVA AMÉRICA",
  ITABORAA: "ITABORAÍ", ITABORAI: "ITABORAÍ",
  ITAGUAA: "ITAGUAÍ", ITAGUAI: "ITAGUAÍ",
  MACAA: "MACAÉ", MACAE: "MACAÉ",
  MAGA: "MAGÉ", MAGE: "MAGÉ",
  MARICA: "MARICÁ",
  "N.IGUAAU": "NOVA IGUAÇU", "N.IGUACU": "NOVA IGUAÇU", "NOVA IGUACU": "NOVA IGUAÇU",
  "N IGUACU": "NOVA IGUAÇU",
  "SAO JOAO": "SÃO JOÃO",
  NILAPOLIS: "NILÓPOLIS", NILOPOLIS: "NILÓPOLIS",
  "SAO GONAALO": "SÃO GONÇALO", "SAO GONCALO": "SÃO GONÇALO",
  TERESAPOLOS: "TERESÓPOLIS", TERESOPOLOS: "TERESÓPOLIS", TERESOPOLIS: "TERESÓPOLIS",
  "TRAS RIOS": "TRÊS RIOS", "TRES RIOS": "TRÊS RIOS",
  VALENAA: "VALENÇA", VALENCA: "VALENÇA",
  MESQUISTA: "MESQUITA", MESQUITA: "MESQUITA",
  // A loja e cadastrada como PARK; "PARK SHOPPING" e como a operacao
  // escreve. Sem esta linha as duas viram lojas diferentes no relatorio.
  "PARK SHOPPING": "PARK", PARK: "PARK",
  "NOVA FRUBURGO": "NOVA FRIBURGO", "NOVA FRIBURGO": "NOVA FRIBURGO",
  "RIOS DAS OSTRAS": "RIO DAS OSTRAS", "RIO DAS OSTRAS": "RIO DAS OSTRAS",
  "S.P ALDEIA": "S.P. DA ALDEIA", "S.P DA ALDEIA": "S.P. DA ALDEIA",
  "S.P. ALDEIA": "S.P. DA ALDEIA", "SAO P ALDEIA": "S.P. DA ALDEIA",
  "STA.CRUZ DA SERRA": "STA. CRUZ DA SERRA", "STA CRUZ DA SERRA": "STA. CRUZ DA SERRA",
};

// Recupera mojibake íntegro (UTF-8 lido como latin1); deixa os casos com perda.
/**
 * @param {string} s
 * @returns {string} o texto recuperado, ou o proprio `s` quando a recuperacao perde caractere
 */
function corrigirMojibake(s) {
  if (!s || !/[Â-Ã]/.test(s)) return s;
  const f = Buffer.from(s, "latin1").toString("utf8");
  return f.includes("�") ? s : f;
}

/**
 * @param {string|null|undefined} s
 * @returns {string|null|undefined} devolve o PROPRIO null/undefined que recebeu — quem
 *   chama e encadeia (.toUpperCase()) precisa saber disso; `chaveLoja` abaixo ja trata.
 */
function canonizarLoja(s) {
  if (s === null || s === undefined) return s;
  // "_" é separador tão comum quanto o espaço nesta base (BANGU_I, SANTA_CRUZ_III,
  // RIO_DAS_OSTRAS); tratamos os dois igual para unir as duas eras de grafia.
  const u = corrigirMojibake(String(s)).toUpperCase().replace(/[\s_]+/g, " ").trim();
  if (!u) return "";
  const m = u.match(/^(.*?)\s+(IV|V|III|II|I|\d+)$/);
  const stem = m ? m[1].trim() : u;
  const num = m ? (ROM[m[2]] || m[2]) : null;
  const canon = STEM[semAcento(stem)] || stem;
  return num ? `${canon} ${num}` : canon;
}

// Chave de COMPARACAO entre bases (nao serve para exibir): canonica e sem
// acento. Existe porque o canonizarLoja so unifica acento das lojas listadas
// no STEM — NITEROI/NITERÓI e PIABETA/PIABETÁ, por exemplo, sairiam como duas
// chaves diferentes. Usada pelo de-para de frete por loja.
/**
 * @param {string|null|undefined} s
 * @returns {string} "" quando nao ha nome — nunca null, ao contrario de canonizarLoja
 */
function chaveLoja(s) {
  const canon = canonizarLoja(s);
  if (canon === null || canon === undefined) return "";
  return semAcento(canon).toUpperCase();
}

module.exports = { canonizarLoja, chaveLoja };
