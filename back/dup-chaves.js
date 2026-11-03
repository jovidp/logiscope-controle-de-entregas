// ================================================================
// dup-chaves.js  —  módulo compartilhado
// ----------------------------------------------------------------
// Lógica de normalização e de "chaves de negócio" usada por
// detectar-duplicatas.js e deduplicar-ocorrencias.js, para que os
// dois SEMPRE concordem sobre o que é duplicata.
//
// Duas chaves, espelhando os dois jeitos que a tabela `ocorrencias`
// é alimentada:
//   - chaveOcorrencia: data + motorista + texto(descrição)
//       (importar-ocorrencias-estruturadas.js / importar-ocorrencias-rota.js)
//   - chaveEntrega   : data + rota + loja + hora_chegada
//       (importar-entregas.js e o formulário do sistema)
// ================================================================

function notEmpty(v) {
  return v !== null && v !== undefined && String(v).trim() !== "";
}

// Colapsa espaços, tira pontas e baixa caixa — para comparar TEXTO de relato
// independente de diferenças de formatação (o motivo nº 1 das duplicatas:
// o mesmo relato gravado com espaçamento/quebra diferente por dois importadores).
function normTexto(s) {
  return String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

// Nome/rota/loja: sem acento, caixa alta, espaço único.
function normNome(s) {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/\s+/g, " ").trim();
}

// DATE do pg chega como Date (meia-noite local) — formata por componentes
// locais para não escorregar um dia via fuso (toISOString faria isso).
function normData(d) {
  if (d instanceof Date) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dia = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dia}`;
  }
  return String(d || "").slice(0, 10);
}

// TIME do pg chega como "HH:MM:SS" — reduz a "HH:MM"; null/vazio -> "".
function normHora(h) {
  if (!notEmpty(h)) return "";
  return String(h).slice(0, 5);
}

// Chave dos importadores de OCORRÊNCIA. Sem texto de relato não dá para
// deduplicar com segurança por aqui -> retorna null (linha não entra nesta chave).
function chaveOcorrencia(r) {
  if (!notEmpty(r.descricao)) return null;
  return `${normData(r.data_ocorrencia)}|${normNome(r.motorista)}|${normTexto(r.descricao)}`;
}

// Chave do importador de ENTREGAS. Sem loja não há entrega identificável -> null.
function chaveEntrega(r) {
  if (!notEmpty(r.loja)) return null;
  return `${normData(r.data_ocorrencia)}|${normNome(r.rota)}|${normNome(r.loja)}|${normHora(r.hora_chegada)}`;
}

// "Riqueza" da linha: quanto mais dados úteis, maior a nota. Usada para
// escolher QUAL linha do grupo duplicado sobrevive (mantém a mais completa).
function pontuacao(r) {
  let s = 0;
  if (notEmpty(r.loja)) s += 3;                                  // veio do import rico (loja+horário)
  if (notEmpty(r.hora_chegada) && normHora(r.hora_chegada) !== "00:00") s += 2;
  if (notEmpty(r.hora_agendada_loja)) s += 2;
  if (Number(r.permanencia_minutos) > 0) s += 1;
  if (notEmpty(r.volume_gerencial) || notEmpty(r.volume_fisico)) s += 1;
  if (notEmpty(r.sla_status) && r.sla_status !== "Sem prazo" && r.sla_status !== "Sem SLA") s += 1;
  if (notEmpty(r.descricao)) s += 1;
  // 'Aberta' costuma ser o fantasma do importar-ocorrencias-rota; preferimos
  // a versão já tratada/encerrada quando o resto empata.
  if (notEmpty(r.ocorrencia_status) && r.ocorrencia_status !== "Aberta") s += 1;
  return s;
}

// A linha tem conteúdo digitado por humano (tratativa real)? Se SIM, ela NÃO
// deve ser apagada automaticamente — o grupo vai para revisão manual.
function temConteudoHumano(r) {
  return (
    notEmpty(r.causa_raiz) ||
    notEmpty(r.acao_corretiva) ||
    notEmpty(r.ocorrencia_responsavel) ||
    notEmpty(r.ocorrencia_fotos) ||
    (notEmpty(r.pod_status) && r.pod_status !== "Pendente")
  );
}

module.exports = {
  notEmpty, normTexto, normNome, normData, normHora,
  chaveOcorrencia, chaveEntrega, pontuacao, temConteudoHumano,
};
