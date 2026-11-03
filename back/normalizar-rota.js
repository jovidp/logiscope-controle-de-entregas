// @ts-check
// ================================================================
// normalizar-rota.js  —  padronização canônica de nomes de ROTA
// ----------------------------------------------------------------
// As planilhas escrevem a mesma rota de várias formas ("Z. OESTE I",
// "Z.OESTE 1", "R. LAGOS", "R. DOS LAGOS"...), o que gera DUPLICATAS nos
// gráficos. Esta função reduz tudo a um nome canônico único.
//
// Regra algorítmica (aguenta variações novas), componente a componente
// (rotas combinadas "A + B" são padronizadas em cada parte):
//   - ZONA OESTE / ZONA NORTE + número (romano I–IV vira arábico 1–4)
//   - BAIXADA n, REGIÃO DOS LAGOS, NORTE FLUMINENSE, CENTRO Z.SUL,
//     R. SERRANA, MISSÃO (e Madureira/Copacabana/Jacaré), ALTERNATIVA, TIJUCA
//
// Usado pelos importadores e pelo normalizar-rotas-banco.js.
// ================================================================

/** @type {Record<string, string>} */
const ROM = { I: "1", II: "2", III: "3", IV: "4", 1: "1", 2: "2", 3: "3", 4: "4" };

/**
 * @param {unknown} s
 * @returns {string}
 */
function semAcento(s) {
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Padroniza UM componente da rota (o que vem entre os "+" de uma rota combinada).
 * @param {string} c
 * @returns {string} o canonico, ou o proprio texto em maiuscula quando nao reconhece
 */
function componente(c) {
  let u = semAcento(c).toUpperCase().replace(/\s+/g, " ").trim().replace(/\.+$/, "");
  u = u.replace(/\s*\(.*?\)/g, "").trim(); // remove anotações "(A)", "(MISSAO)"

  let m =
    u.match(/^Z\.?\s*OESTE\s*(IV|III|II|I|\d)$/) ||
    u.match(/^ZONA OESTE\s*(IV|III|II|I|\d)$/);
  if (m) return `ZONA OESTE ${ROM[m[1]]}`;

  m = u.match(/^(?:Z\.?\s*[NM]ORTE|ZONA NORTE|NORTE)\s*(II|I|\d)$/);
  if (m) return `ZONA NORTE ${ROM[m[1]]}`;

  m = u.match(/^BAIXADA\s*(III|II|I|\d)$/);
  if (m) return `BAIXADA ${ROM[m[1]]}`;

  if (/^R\.?\s*SERRANA$/.test(u) || u === "SERRANA") return "R. SERRANA";
  if (/\bLAGOS\b/.test(u)) return "REGIÃO DOS LAGOS";
  if (u.includes("FLUMINENSE")) return "NORTE FLUMINENSE";
  if (u.startsWith("CENTRO") && u.includes("SUL")) return "CENTRO Z.SUL";
  if (u.startsWith("MISSAO")) {
    if (u.includes("MADUREIRA")) return "MISSÃO MADUREIRA";
    if (u.includes("COPACA")) return "MISSÃO COPACABANA";
    if (u.includes("JACARE")) return "MISSÃO JACARÉ";
    return "MISSÃO";
  }
  if (u.startsWith("ALTERNATIVA")) {
    return /^ALTERNATIVA\s*(II|2)$/.test(u) ? "ALTERNATIVA 2" : "ALTERNATIVA";
  }
  if (u === "TIJUCA") return "TIJUCA";

  return String(c).replace(/\s+/g, " ").trim().toUpperCase(); // desconhecido: mantém
}

/**
 * @param {string|null|undefined} s
 * @returns {string|null|undefined} devolve o PROPRIO null/undefined que recebeu;
 *   string vazia quando so havia separador.
 */
function canonizarRota(s) {
  if (s === null || s === undefined) return s;
  const partes = String(s).split(/\s*\+\s*/).filter((p) => p.trim());
  return partes.length ? partes.map(componente).join(" + ") : "";
}

module.exports = { canonizarRota };
