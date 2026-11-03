// @ts-check
// ================================================================
// Helpers de tempo compartilhados (fonte unica de verdade).
// Usado por server.js e pelos scripts de importacao/manutencao, que
// antes tinham cada um sua propria copia de calcularMinutos.
// ================================================================

// Minutos entre dois horarios "HH:MM". Regras (identicas as copias antigas):
//   - qualquer horario vazio/falsy   -> 0
//   - qualquer parte NaN (formato invalido) -> 0
//   - diferenca negativa (virada indevida)  -> 0
/**
 * @param {string|null|undefined} horaInicio
 * @param {string|null|undefined} horaFim
 * @returns {number}
 */
function calcularMinutos(horaInicio, horaFim) {
  if (!horaInicio || !horaFim) return 0;
  const [h1, m1] = String(horaInicio).split(":").map(Number);
  const [h2, m2] = String(horaFim).split(":").map(Number);
  if (Number.isNaN(h1) || Number.isNaN(m1) || Number.isNaN(h2) || Number.isNaN(m2)) {
    return 0;
  }
  const resultado = (h2 * 60 + m2) - (h1 * 60 + m1);
  return resultado < 0 ? 0 : resultado;
}

// Tolerancia de atraso na chegada a loja, em minutos. Chegar ate TOLERANCIA
// minutos depois do horario agendado NAO conta como atraso — nem no
// sla_status/otif_status gravados, nem na marcacao automatica de ocorrencia
// no formulario. Acima disso, "Atrasada".
//
// Fonte unica: server.js, os importadores e os scripts de manutencao usam
// classificarSla() daqui. O front tem a sua propria copia do numero em
// public/js/script-1-core.js (TOLERANCIA_ATRASO_MIN) — se mudar aqui, mude la.
const TOLERANCIA_ATRASO_MIN = 20;

// "Atrasada" | "No prazo" | "Sem prazo" a partir dos dois horarios "HH:MM".
// Sem horario agendado ou sem chegada -> "Sem prazo" (fica fora do indicador).
//
// O typedef abaixo e o valor gravado em ocorrencias.sla_status. Num arquivo
// com // @ts-check, escrever "Atrasado" (masculino) vira erro no editor em
// vez de virar uma linha que nenhum filtro encontra depois.
/** @typedef {"Atrasada" | "No prazo" | "Sem prazo"} StatusSla */
/**
 * @param {string|null|undefined} agendada horario agendado da loja, "HH:MM"
 * @param {string|null|undefined} chegada  chegada registrada, "HH:MM"
 * @returns {StatusSla}
 */
function classificarSla(agendada, chegada) {
  if (!agendada || !chegada) return "Sem prazo";
  return calcularMinutos(agendada, chegada) > TOLERANCIA_ATRASO_MIN
    ? "Atrasada"
    : "No prazo";
}

module.exports = { calcularMinutos, classificarSla, TOLERANCIA_ATRASO_MIN };
