// ================================================================
// agendamento-engine.js — Assistente de Agendamento Inteligente
// ----------------------------------------------------------------
// Camada de RECOMENDAÇÃO que faltava: a partir do histórico de
// entregas (tabela `ocorrencias`), sugere o MELHOR horário de
// agendamento por loja para que o caminhão chegue no prazo.
//
// Objetivo: "chegar no horário" (menos atraso / melhor OTIF).
//   • recomendado = percentil-alvo (default p80) das chegadas reais
//     → horário que o caminhão historicamente cumpre em `alvo`% das vezes.
//   • flag `irrealista`: agendamento atual é mais cedo do que o caminhão
//     consegue chegar → atraso crônico.
//
// Definições (alinhadas com o usuário):
//   • espera   = inicio_descarga − hora_chegada  (loja começar a receber)
//   • descarga = fim_descarga    − inicio_descarga (descarregamento)
//   • saída da loja = fim_descarga (usada na cadeia de deslocamento)
//
// Módulo de funções PURAS — testável sem servidor nem banco
// (ver back/teste-agendamento.js). Reaproveita os normalizadores
// canônicos do resto do sistema.
// ================================================================

const { canonizarLoja } = require("./normalizar-loja");
const { canonizarRota } = require("./normalizar-rota");

// ── helpers de tempo ─────────────────────────────────────────────

// "HH:MM" ou "HH:MM:SS" (TIME do Postgres) → minutos do dia, ou null.
function minutosDoDia(t) {
  if (t == null) return null;
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = +m[1];
  const min = +m[2];
  if (h > 47 || min > 59) return null;
  return h * 60 + min;
}

// minutos do dia → "HH:MM" (00:00–23:59; acima de 24h volta ao ciclo).
function hhmm(min) {
  if (min == null || !Number.isFinite(min)) return null;
  let v = Math.round(min) % 1440;
  if (v < 0) v += 1440;
  const h = Math.floor(v / 60);
  const m = v % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

// duração em minutos → "Hh MMmin" amigável (ou "MMmin").
function duracaoHumana(min) {
  if (min == null || !Number.isFinite(min)) return "—";
  const v = Math.round(min);
  const h = Math.floor(v / 60);
  const m = v % 60;
  if (h <= 0) return `${m}min`;
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}

// diferença simples (mesmo dia). Negativo → null (erro de digitação,
// não virada de meia-noite — horários de loja são todos diurnos).
function difMin(de, para) {
  const a = minutosDoDia(de);
  const b = minutosDoDia(para);
  if (a == null || b == null) return null;
  const d = b - a;
  return d < 0 ? null : d;
}

function mediana(arr) {
  const a = (arr || []).filter((v) => v != null && Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const meio = Math.floor(a.length / 2);
  return a.length % 2 ? a[meio] : (a[meio - 1] + a[meio]) / 2;
}

// percentil com interpolação linear. p em [0,1].
function percentil(arr, p) {
  const a = (arr || []).filter((v) => v != null && Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  if (a.length === 1) return a[0];
  const idx = Math.min(Math.max(p, 0), 1) * (a.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

// arredonda minutos para cima ao múltiplo de 5 (mantém folga p/ pontualidade).
function arredondarCima5(min) {
  if (min == null || !Number.isFinite(min)) return null;
  return Math.ceil(min / 5) * 5;
}

// moda (valor mais frequente) de um array de strings "HH:MM".
function moda(arr) {
  const cont = {};
  let melhor = null;
  let melhorN = 0;
  (arr || []).forEach((v) => {
    if (v == null) return;
    cont[v] = (cont[v] || 0) + 1;
    if (cont[v] > melhorN) {
      melhorN = cont[v];
      melhor = v;
    }
  });
  return melhor;
}

function semAcentoUpper(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();
}

function dataISO(v) {
  if (!v) return "";
  if (v instanceof Date) return v.toISOString().split("T")[0];
  return String(v).split("T")[0];
}

// ── parsing de atrasos nos relatos em texto livre ────────────────
// Extrai minutos de atraso e a origem provável (loja / saída / chegada
// / trânsito) das descrições. Tolerante a typos (ATRASO/ATRASSO/ATRASONA)
// e a "HORA MARCADA: 9:00 ... CHEGADA: 9:43".
function extrairAtrasosTexto(descricao) {
  const txt = semAcentoUpper(descricao).replace(/\s+/g, " ").trim();
  if (!txt) return [];

  // especificidade da origem (maior vence no dedupe): bloco/loja > genérico.
  const ESP = { saida: 3, chegada: 3, loja: 2, geral: 1 };
  const cands = [];
  const add = (minutos, origem, trecho) => {
    if (!Number.isFinite(minutos) || minutos <= 0 || minutos > 600) return;
    cands.push({ minutos, origem, trecho: String(trecho || "").trim().slice(0, 120) });
  };
  // minutos a partir de número + unidade ("MIN" → min, "HORA" → ×60).
  const valor = (num, unidade) => (/HORA/.test(unidade) ? num * 60 : num);

  let m;

  // 1) Bloco "HORA/HORÁRIO MARCAD... HH:MM ... (CHEGAD|SAID) HH:MM" → delta.
  //    Cobre "HORARIO MARCADO: 9:00 ... CHEGADA: 9:43" e
  //    "HORA MARCADA PARA SAIR:04:00 HORA DE SAÍDA:4:15".
  const blocoRe =
    /HOR\w*\s+MARCAD\w*[^0-9]{0,20}(\d{1,2})[:H.\s](\d{2})[\s\S]{0,80}?(CHEGAD\w*|SAID\w*)[^0-9]{0,20}(\d{1,2})[:H.\s](\d{2})/g;
  while ((m = blocoRe.exec(txt)) !== null) {
    const delta = (+m[4] * 60 + +m[5]) - (+m[1] * 60 + +m[2]);
    if (delta > 0) add(delta, /SA/.test(m[3]) ? "saida" : "chegada", m[0]);
  }

  // 2) Atribuído à LOJA / responsável (origem 'loja'): responsável antes OU
  //    depois do número, e "X hora ... da loja".
  let re = /RESPONS\w*[\s\S]{0,45}?(\d{1,3})\s*(MIN\w*|HORA\w*)/g;
  while ((m = re.exec(txt)) !== null) add(valor(+m[1], m[2]), "loja", m[0]);
  re = /(\d{1,3})\s*(MIN\w*|HORA\w*)[\s\S]{0,45}?(?:DO\s+RESPONS\w*|DA\s+LOJA)/g;
  while ((m = re.exec(txt)) !== null) add(valor(+m[1], m[2]), "loja", m[0]);

  // 3) Atraso genérico em minutos/horas (origem 'geral').
  re = /ATRAS\w*\s*(?:DE\s+|NA\s+SAID\w*\s+(?:DE\s+)?|:\s*)?(\d{1,3})\s*(MIN\w*|HORA\w*)/g;
  while ((m = re.exec(txt)) !== null) add(valor(+m[1], m[2]), "geral", m[0]);
  re = /(\d{1,3})\s*(MIN\w*|HORA\w*)\s+(?:DE\s+)?ATRAS\w*/g;
  while ((m = re.exec(txt)) !== null) add(valor(+m[1], m[2]), "geral", m[0]);

  // dedupe por quantidade de minutos, mantendo a origem mais específica.
  const porMin = new Map();
  cands.forEach((c) => {
    const ex = porMin.get(c.minutos);
    if (!ex || (ESP[c.origem] || 0) > (ESP[ex.origem] || 0)) porMin.set(c.minutos, c);
  });
  return [...porMin.values()];
}

// classifica a origem predominante dos atrasos de texto de uma loja.
function origemPredominante(atrasos) {
  const soma = {};
  (atrasos || []).forEach((a) => {
    soma[a.origem] = (soma[a.origem] || 0) + a.minutos;
  });
  let melhor = null;
  let melhorN = -1;
  Object.entries(soma).forEach(([k, v]) => {
    if (v > melhorN) {
      melhorN = v;
      melhor = k;
    }
  });
  return melhor;
}

// ── agregação por rota → loja ────────────────────────────────────

function obterRota(o) {
  const r = o.rota || o.rota_nome || "";
  const canon = canonizarRota(r);
  return (canon || "").trim();
}

function obterLojaCanon(o) {
  return (canonizarLoja(o.loja) || "").trim();
}

// Agrupa as entregas por rota canônica e, dentro dela, por loja canônica.
// Só entram registros com hora_chegada (base da recomendação).
function agruparPorRotaLoja(ocorrencias) {
  const lista = (ocorrencias || []).filter((o) => minutosDoDia(o.hora_chegada) != null);

  // Pré-passo: rota predominante de cada loja. Muitas linhas vêm com a coluna
  // `rota` vazia (ex.: ALTERNATIVA), e sem isso a rota inteira sumiria em
  // "(sem rota)". Inferimos a rota da loja pelos dias em que ela veio
  // preenchida — espelha o obterRotaDaOcorrencia do front (loja → rota).
  const rotaPorLoja = {};
  lista.forEach((o) => {
    const loja = obterLojaCanon(o);
    const rota = obterRota(o);
    if (!loja || !rota) return;
    const cont = (rotaPorLoja[loja] = rotaPorLoja[loja] || {});
    cont[rota] = (cont[rota] || 0) + 1;
  });
  const lojaParaRota = {};
  Object.entries(rotaPorLoja).forEach(([loja, cont]) => {
    let best = null;
    let bestN = 0;
    Object.entries(cont).forEach(([r, n]) => {
      if (n > bestN) { bestN = n; best = r; }
    });
    if (best) lojaParaRota[loja] = best;
  });

  const rotas = {};
  lista.forEach((o) => {
    const loja = obterLojaCanon(o);
    if (!loja) return;
    const rota = obterRota(o) || lojaParaRota[loja] || "(sem rota)";
    const r = (rotas[rota] = rotas[rota] || { rota, lojas: {}, saidasFabrica: [], datas: new Set() });
    r.datas.add(dataISO(o.data_ocorrencia));
    const sf = minutosDoDia(o.hora_saida_fabrica);
    if (sf != null) r.saidasFabrica.push(sf);
    const reg = (r.lojas[loja] = r.lojas[loja] || {
      loja,
      registros: [],
    });
    reg.registros.push(o);
  });
  return rotas;
}

// Métricas por loja a partir dos registros agrupados.
function metricasLoja(loja, registros) {
  const chegadas = [];
  const esperas = [];
  const descargas = [];
  const saidas = []; // fim_descarga (saída da loja)
  const agendados = [];
  const datas = new Set();
  let pontual = 0;
  let comAgendado = 0;
  const atrasosTexto = [];

  registros.forEach((o) => {
    const ch = minutosDoDia(o.hora_chegada);
    if (ch != null) chegadas.push(ch);
    datas.add(dataISO(o.data_ocorrencia));

    const esp = difMin(o.hora_chegada, o.inicio_descarga);
    if (esp != null) esperas.push(esp);

    const desc = difMin(o.inicio_descarga, o.fim_descarga);
    if (desc != null) descargas.push(desc);

    const saida = minutosDoDia(o.fim_descarga);
    if (saida != null) saidas.push(saida);

    const ag = minutosDoDia(o.hora_agendada_loja);
    if (ag != null) {
      agendados.push(hhmm(ag));
      comAgendado += 1;
      if (ch != null && ch <= ag) pontual += 1; // chegada ≤ agendado = no prazo
    }

    extrairAtrasosTexto(o.descricao).forEach((a) => atrasosTexto.push(a));
  });

  const agendadoModa = moda(agendados);
  return {
    loja,
    n: chegadas.length,
    datas: [...datas].filter(Boolean).sort(),
    chegada_med: mediana(chegadas),
    saida_med: mediana(saidas),
    espera_med: mediana(esperas),
    descarga_med: mediana(descargas),
    agendado_atual: agendadoModa, // "HH:MM" ou null
    com_agendado: comAgendado,
    pontualidade_atual: comAgendado ? pontual / comAgendado : null,
    atrasos_texto: atrasosTexto,
    _chegadas: chegadas,
  };
}

// Núcleo: dado o conjunto de chegadas e o agendamento atual, recomenda
// o horário-alvo para "chegar no horário".
function recomendarHorario(metricas, alvoPontualidade) {
  const alvo = alvoPontualidade == null ? 0.8 : alvoPontualidade;
  const chegadas = metricas._chegadas || [];
  if (!chegadas.length) {
    return {
      recomendado: null,
      recomendado_min: null,
      pontualidade_projetada: null,
      irrealista: false,
      alvo,
    };
  }
  const alvoMin = percentil(chegadas, alvo);
  const pisoMin = metricas.chegada_med; // nunca antes da mediana de chegada
  const baseMin = Math.max(alvoMin, pisoMin == null ? alvoMin : pisoMin);
  const recMin = arredondarCima5(baseMin);

  const projetada = chegadas.filter((c) => c <= recMin).length / chegadas.length;

  // irrealista: existe agendado atual mais cedo do que o caminhão chega no
  // alvo, com folga ≥ 5min e amostra mínima → atraso crônico.
  const agMin = minutosDoDia(metricas.agendado_atual);
  const irrealista =
    agMin != null && metricas.n >= 3 && agMin < alvoMin - 5;

  return {
    recomendado: hhmm(recMin),
    recomendado_min: recMin,
    pontualidade_projetada: projetada,
    irrealista,
    alvo,
  };
}

// Orquestra tudo: por rota, lista de lojas ORDENADA pela mediana de chegada
// (ordem real da rota), com resumo da rota e cadeia de deslocamento.
function recomendacoesPorRota(ocorrencias, opts = {}) {
  const alvo = opts.alvo == null ? 0.8 : Number(opts.alvo);
  // mínimo 1: rotas esparsas (ex.: ALTERNATIVA) precisam aparecer mesmo com
  // uma única entrega registrada por loja no período.
  const minAmostra = opts.minAmostra == null ? 1 : opts.minAmostra;
  const rotasAgrup = agruparPorRotaLoja(ocorrencias);

  const rotas = Object.values(rotasAgrup)
    .map((r) => {
      let lojas = Object.values(r.lojas)
        .map((g) => {
          const met = metricasLoja(g.loja, g.registros);
          const rec = recomendarHorario(met, alvo);
          return { ...met, ...rec };
        })
        .filter((l) => l.n >= minAmostra)
        .sort((a, b) => {
          const ca = a.chegada_med == null ? Infinity : a.chegada_med;
          const cb = b.chegada_med == null ? Infinity : b.chegada_med;
          return ca - cb;
        });

      // Cadeia de deslocamento (aproximada, baseada nas medianas):
      // deslocamento da loja = chegada(med) − saída(med) da loja anterior.
      let anteriorSaida = mediana(r.saidasFabrica); // parte da fábrica
      lojas = lojas.map((l, i) => {
        const desloc = anteriorSaida != null && l.chegada_med != null ? l.chegada_med - anteriorSaida : null;
        const out = {
          ...l,
          ordem: i + 1,
          deslocamento_med: desloc != null && desloc >= 0 ? desloc : null,
          origem_atraso_texto: origemPredominante(l.atrasos_texto),
          // limpa campo interno antes de serializar
          _chegadas: undefined,
        };
        if (l.saida_med != null) anteriorSaida = l.saida_med;
        return out;
      });

      const jornadas = [];
      // jornada mediana aproximada por rota: última saída − saída da fábrica
      const saidaFabricaMed = mediana(r.saidasFabrica);
      const ultimaSaida = lojas.length ? lojas[lojas.length - 1].saida_med : null;
      const jornadaMed =
        saidaFabricaMed != null && ultimaSaida != null && ultimaSaida >= saidaFabricaMed
          ? ultimaSaida - saidaFabricaMed
          : null;

      return {
        rota: r.rota,
        dias: [...r.datas].filter(Boolean).sort(),
        qtd_dias: [...r.datas].filter(Boolean).length,
        saida_fabrica: hhmm(saidaFabricaMed),
        jornada_med: jornadaMed,
        jornada_med_humana: duracaoHumana(jornadaMed),
        lojas,
      };
    })
    .filter((r) => r.lojas.length > 0)
    .sort((a, b) => a.rota.localeCompare(b.rota, "pt-BR"));

  return { alvo, rotas };
}

module.exports = {
  // helpers (exportados p/ teste)
  minutosDoDia,
  hhmm,
  duracaoHumana,
  difMin,
  mediana,
  percentil,
  arredondarCima5,
  moda,
  extrairAtrasosTexto,
  // agregação / recomendação
  agruparPorRotaLoja,
  metricasLoja,
  recomendarHorario,
  recomendacoesPorRota,
};
