// ================================================================
// teste-agendamento.js — testes do agendamento-engine (sem banco)
// Rodar:  node back/teste-agendamento.js
// Saída esperada: "TODOS OS TESTES PASSARAM" e exit 0.
// ================================================================

const eng = require("./agendamento-engine");

let falhas = 0;
function ok(cond, msg) {
  if (cond) {
    console.log("  ✓ " + msg);
  } else {
    falhas += 1;
    console.error("  ✗ FALHOU: " + msg);
  }
}
function eq(a, b, msg) {
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (obtido=${JSON.stringify(a)}, esperado=${JSON.stringify(b)})`);
}

console.log("\n[1] helpers de tempo");
eq(eng.minutosDoDia("09:30"), 570, "minutosDoDia 09:30");
eq(eng.minutosDoDia("09:30:00"), 570, "minutosDoDia com segundos");
eq(eng.minutosDoDia("xx"), null, "minutosDoDia inválido");
eq(eng.hhmm(570), "09:30", "hhmm 570");
eq(eng.difMin("09:00", "09:43"), 43, "difMin 43");
eq(eng.difMin("09:43", "09:00"), null, "difMin negativo → null");
eq(eng.arredondarCima5(571), 575, "arredondarCima5 571 → 575");
eq(eng.arredondarCima5(570), 570, "arredondarCima5 múltiplo de 5");
eq(eng.mediana([1, 2, 3]), 2, "mediana ímpar");
eq(eng.mediana([1, 2, 3, 4]), 2.5, "mediana par");
eq(eng.percentil([0, 10, 20, 30, 40], 0.5), 20, "percentil p50");
eq(eng.percentil([0, 10, 20, 30, 40], 0.8), 32, "percentil p80 (interp)");
eq(eng.moda(["08:00", "08:00", "09:00"]), "08:00", "moda");

console.log("\n[2] extrairAtrasosTexto (casos reais do CSV)");
const c1 = eng.extrairAtrasosTexto("ATRASSO DE 40 MIN SEM JUSTIFICATIVA\nHORARIO MARCADO: 9:00\nCHEGADA: 9:43");
ok(c1.some((a) => a.minutos === 40), "captura '40 MIN'");
ok(c1.some((a) => a.minutos === 43 && a.origem === "chegada"), "captura bloco marcado/chegada = 43min");

const c2 = eng.extrairAtrasosTexto("HORA MARCADA PARA SAIR:04:00\nHORA DE SAÍDA:4:15\n15 MINUTOS DE ATRASO");
ok(c2.some((a) => a.minutos === 15 && a.origem === "saida"), "bloco saída = 15min");

const c3 = eng.extrairAtrasosTexto("BUZIOS - Responsável atrasou cerca de 30 minutos");
ok(c3.some((a) => a.minutos === 30 && a.origem === "loja"), "responsável 30min → origem loja");

const c4 = eng.extrairAtrasosTexto("Atraso de 1 hora do respponsável da loja");
ok(c4.some((a) => a.minutos === 60 && a.origem === "loja"), "1 hora do responsável = 60min loja");

const c5 = eng.extrairAtrasosTexto("CAIXA COM FEZES DE POMBO");
eq(c5.length, 0, "relato sem atraso → vazio");

const c6 = eng.extrairAtrasosTexto("ATRASO DE 42 MINUTOS DE ATRASO NA LOJA:BANGU I");
ok(c6.some((a) => a.minutos === 42), "42 minutos");

console.log("\n[3] recomendacoesPorRota — cenário sintético");
// Loja CABO FRIO 1 na rota R. DOS LAGOS: chega tipicamente ~08:40, mas
// está agendada 08:00 → agendamento irrealista, deve recomendar mais tarde.
function reg(data, loja, rota, sf, cheg, ini, fim, agendado, desc) {
  return {
    data_ocorrencia: data,
    loja,
    rota,
    hora_saida_fabrica: sf,
    hora_chegada: cheg,
    inicio_descarga: ini,
    fim_descarga: fim,
    hora_agendada_loja: agendado,
    descricao: desc || "",
  };
}
const dados = [
  reg("2026-06-01", "Cabo Frio 1", "R. DOS LAGOS", "04:00", "08:30", "08:45", "09:30", "08:00"),
  reg("2026-06-02", "Cabo Frio 1", "R. DOS LAGOS", "04:00", "08:40", "08:50", "09:35", "08:00", "Responsável atrasou 20 minutos"),
  reg("2026-06-03", "Cabo Frio 1", "R. DOS LAGOS", "04:00", "08:55", "09:00", "09:50", "08:00"),
  reg("2026-06-04", "Cabo Frio 1", "R. DOS LAGOS", "04:00", "09:10", "09:15", "10:00", "08:00"),
  // 2ª loja, mais tarde
  reg("2026-06-01", "Búzios", "R. DOS LAGOS", "04:00", "10:00", "10:10", "10:50", "10:00"),
  reg("2026-06-02", "Búzios", "R. DOS LAGOS", "04:00", "10:05", "10:15", "10:55", "10:00"),
  reg("2026-06-03", "Búzios", "R. DOS LAGOS", "04:00", "09:55", "10:00", "10:40", "10:00"),
];
const out = eng.recomendacoesPorRota(dados, { alvo: 0.8, minAmostra: 2 });
eq(out.rotas.length, 1, "uma rota");
const rota = out.rotas[0];
eq(rota.rota, "REGIÃO DOS LAGOS", "rota canonizada");
eq(rota.lojas.length, 2, "duas lojas");
eq(rota.lojas[0].loja, "CABO FRIO 1", "1ª loja por ordem de chegada = Cabo Frio 1");
eq(rota.lojas[1].loja, "BÚZIOS", "2ª loja = Búzios");

const cf = rota.lojas[0];
console.log("    Cabo Frio 1:", JSON.stringify({
  agendado: cf.agendado_atual, chegada_med: eng.hhmm(cf.chegada_med),
  recomendado: cf.recomendado, irrealista: cf.irrealista,
  pont_atual: cf.pontualidade_atual, pont_proj: cf.pontualidade_projetada,
  espera_med: cf.espera_med, descarga_med: cf.descarga_med,
}));
ok(cf.irrealista === true, "Cabo Frio 1 marcada como agendamento irrealista");
ok(eng.minutosDoDia(cf.recomendado) > eng.minutosDoDia(cf.agendado_atual), "recomendado é mais tarde que o agendado atual");
ok(cf.pontualidade_projetada > (cf.pontualidade_atual || 0), "pontualidade projetada melhora");
ok(cf.atrasos_texto.some((a) => a.origem === "loja"), "captou atraso de loja no texto");
ok(cf.espera_med != null && cf.espera_med >= 0, "espera_med calculada");
ok(cf.deslocamento_med != null, "deslocamento_med (cadeia) calculado");

const bz = rota.lojas[1];
ok(bz.irrealista === false, "Búzios não é irrealista (agendado coerente)");

console.log("\n[4] rota faltante herdada da loja + amostra mínima 1");
// Niterói 2 tem rota só num dos dias; no outro a coluna `rota` vem vazia.
// A rota ALTERNATIVA não pode sumir nem cair em '(sem rota)'.
const dados2 = [
  reg("2026-06-01", "Niterói 2", "ALTERNATIVA I", "05:00", "07:00", "07:10", "07:40", "07:00"),
  reg("2026-06-08", "Niterói 2", "", "05:00", "07:10", "07:20", "07:55", "07:00"),
  reg("2026-06-15", "Itaboraí 4", "ALTERNATIVA I", "05:00", "08:30", "08:40", "09:20", "08:30"),
];
const out2 = eng.recomendacoesPorRota(dados2, { alvo: 0.8 }); // minAmostra default = 1
const rAlt = out2.rotas.find((r) => r.rota === "ALTERNATIVA");
ok(!!rAlt, "rota ALTERNATIVA presente (não sumiu)");
ok(!out2.rotas.some((r) => r.rota === "(sem rota)"), "nenhuma entrega caiu em '(sem rota)'");
const nit = rAlt && rAlt.lojas.find((l) => l.loja === "NITERÓI 2");
ok(nit && nit.n === 2, "Niterói 2 juntou os 2 dias (rota vazia herdada da loja)");
ok(rAlt && rAlt.lojas.length === 2, "ALTERNATIVA mostra as 2 lojas mesmo com 1 entrega cada (minAmostra=1)");

console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM ✅" : `${falhas} TESTE(S) FALHARAM ❌`));
process.exit(falhas === 0 ? 0 : 1);
