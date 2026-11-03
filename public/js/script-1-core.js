// ================================================================
// script.js — SEM OCORRÊNCIAS INDIVIDUAIS
// ================================================================

// ================================================================
// 1. DADOS E GLOBAIS
// ================================================================
let ocorrencias = [];
let editandoIndex = null;
let ocorrenciasFiltradasTorre = [];
let filtrosTorreInicializados = false;
let carregandoHistorico = false;
let sistemaInicializado = false;
let atualizandoDadosOcorrenciaPeloDia = false;
let _chartRotas = null;
let _chartDias = null;
let _chartAcertos = null;
let _chartTipos = null;
let _chartResponsavel = null;
let _chartTempoRota = null;
let _chartRkPosNeg = null;
let _chartRkResp = null;
let _chartRkMedia = null;
let _chartRkProblemas = null;
let _chartTendVolume = null;
let _chartTendTaxa = null;
let _chartTendOco = null;
let _chartTendTempos = null;
let _chartTendProbOp = null;
let _chartTendTransfSacola = null;
let _chartTendDeslocamento = null;
let _chartTendVolDiv = null;
let _chartTendLojas = null;
let _chartTendRotasAtraso = null;
let tendenciaPeriodo = "semana";

const API_URL = window.location.origin;

const lojasRotas = {
  GUADALUPE: "BAIXADA III",
  CARIOCA: "BAIXADA III",
  VIA_BRASIL: "BAIXADA III",
  GRANDE_RIO: "BAIXADA III",
  VILAR_DOS_TELES_II: "BAIXADA III",
  SAO_JOAO_I: "BAIXADA III",
  MADUREIRA_II: "Z.NORTE I",
  MADUREIRA_IV: "Z.NORTE I",
  MADUREIRA_I: "Z.NORTE I",
  TAQUARA_PLAZA: "Z.NORTE I",
  TAQUARA: "Z.NORTE I",
  CENTER: "Z.NORTE I",
  FREGUESIA: "Z.NORTE I",
  RIO_DAS_PEDRAS: "Z.NORTE I",
  METROPOLITANO: "Z.NORTE I",
  NOVA_AMERICA: "Z.NORTE II",
  NORTE: "Z.NORTE II",
  MEIER: "Z.NORTE II",
  IGUATEMI: "Z.NORTE II",
  TIJUCA_II: "Z.NORTE II",
  DOWNTOWN: "Z.NORTE II",
  AMERICAS: "Z.NORTE II",
  RECREIO: "Z.NORTE II",
  PONTAL: "Z.NORTE II",
  SANTA_CRUZ_III: "Z.OESTE I",
  SANTA_CRUZ_I: "Z.OESTE I",
  SANTA_CRUZ_II: "Z.OESTE I",
  ITAGUAI: "Z.OESTE I",
  ITAGUAI_II: "Z.OESTE I",
  ANGRA_DOS_REIS: "Z.OESTE I",
  CAMPO_GRANDE_III: "Z.OESTE II",
  PASSEIO: "Z.OESTE II",
  BANGU_I: "Z.OESTE II",
  BANGU_V: "Z.OESTE II",
  BANGU_IV: "Z.OESTE II",
  SULACAP: "Z.OESTE II",
  PARK: "Z.OESTE IV",
  OLINDA_ELLIS: "Z.OESTE IV",
  WEST_III: "Z.OESTE IV",
  MAX_SHOPPING: "Z.OESTE IV",
  NITEROI_IV: "ALTERNATIVA I",
  NITEROI_II: "ALTERNATIVA I",
  SAO_GONÇALO_I: "ALTERNATIVA I",
  SAO_GONÇALO_II: "ALTERNATIVA I",
  SAO_GONÇALO_IV: "ALTERNATIVA I",
  ALCANTARA: "ALTERNATIVA I",
  ITABORAI_IV: "ALTERNATIVA I",
  ITABORAI_III: "ALTERNATIVA I",
  NOVA_FRIBURGO: "ALTERNATIVA I",
  DJOFFER: "ALTERNATIVA I",
  TERESOPOLIS: "ALTERNATIVA I",
  COPACABANA_I: "CENTRO E Z.SUL",
  COPACABANA_II: "CENTRO E Z.SUL",
  CENTRO_I: "CENTRO E Z.SUL",
  CENTRO_II: "CENTRO E Z.SUL",
  ILHA: "CENTRO E Z.SUL",
  BONSUCESSO_II: "CENTRO E Z.SUL",
  PENHA: "CENTRO E Z.SUL",
  CAXIAS_CENTRO: "BAIXADA II",
  CAXIAS_I: "BAIXADA II",
  OUTLET: "BAIXADA II",
  MAGE_II: "BAIXADA II",
  PIABETA: "BAIXADA II",
  STA_CRUZ_DA_SERRA: "BAIXADA II",
  LOTE_XV: "BAIXADA II",
  NILOPOLIS_II: "BAIXADA I+R.SERRENA",
  MESQUITA: "BAIXADA I+R.SERRENA",
  N_IGUAÇU_I: "BAIXADA I+R.SERRENA",
  N_IGUAÇU_III: "BAIXADA I+R.SERRENA",
  TOP: "BAIXADA I+R.SERRENA",
  N_IGUAÇU_II: "BAIXADA I+R.SERRENA",
  QUEIMADOS: "BAIXADA I+R.SERRENA",
  BARRA_MANSA: "BAIXADA I+R.SERRENA",
  BARRA_DO_PIRAI: "BAIXADA I+R.SERRENA",
  VALENCA: "BAIXADA I+R.SERRENA",
  TRES_RIOS: "BAIXADA I+R.SERRENA",
  MARICA_I: "R.LAGOS",
  SAQUAREMA_II: "R.LAGOS",
  ARARUAMA: "R.LAGOS",
  IGUABA: "R.LAGOS",
  SAO_P_ALDEIA: "R.LAGOS",
  BUZIOS: "R.LAGOS",
  CABO_FRIO_I: "R.LAGOS",
  CABO_FRIO_III: "R.LAGOS",
  ARRAIAL_DO_CABO: "R.LAGOS",
  MARICA_II: "R.LAGOS",
  RIO_BONITO_II: "NORTE FLUMINENSE",
  RIO_DAS_OSTRAS: "NORTE FLUMINENSE",
  MACAE_I: "NORTE FLUMINENSE",
  MACAE_III: "NORTE FLUMINENSE",
  CAMPOS_I: "NORTE FLUMINENSE",
  CAMPOS_III: "NORTE FLUMINENSE",
  ITAPERUNA_II: "NORTE FLUMINENSE",
  NORTE_FLUMINENSE: "EXTRA-ENTREGA",
  ZONA_NORTE_I: "EXTRA-ENTREGA",
  ZONA_NORTE_II: "EXTRA-ENTREGA",
  ZONA_OESTE_I: "EXTRA-ENTREGA",
  ZONA_OESTE_II: "EXTRA-ENTREGA",
  ZONA_OESTE_IV: "EXTRA-ENTREGA",
  ALTERNATIVA_I: "EXTRA-ENTREGA",
  CENTRO_E_ZONA_SUL: "EXTRA-ENTREGA",
  BAIXADA_II: "EXTRA-ENTREGA",
  BAIXADA_III: "EXTRA-ENTREGA",
  BAIXADA_I_REGIAO_SERRANA: "EXTRA-ENTREGA",
  REGIAO_DOS_LAGOS: "EXTRA-ENTREGA",
};
const lojasMissoes = {};

const LS = {
  avisos: "avisosMonitoramento",
  checklist: "checklistDiario",
  atrasos: "atrasosSaidaFabrica",
  rotas: "rotasRegistradas",
  almocos: "almocosRegistrados",
  tacografos: "tacografos",
  diarios: "diariosBordo",
};

const STORAGE_ENDPOINTS = {
  [LS.avisos]: "/avisos-monitoramento",
  [LS.checklist]: "/checklists-diarios",
  [LS.atrasos]: "/atrasos-saida",
  [LS.rotas]: "/rotas-registradas",
  [LS.almocos]: "/almocos",
  [LS.tacografos]: "/tacografos",
  [LS.diarios]: "/diarios-bordo",
  entregasDia: "/entregas-dia",
};

const STORAGE_MAPS = {
  [LS.checklist]: {
    totalItens: "total_itens",
  },
  [LS.atrasos]: {
    horaMarcada: "hora_marcada",
    horaReal: "hora_real",
    atrasoMin: "atraso_min",
    atrasoFormatado: "atraso_formatado",
  },
  [LS.rotas]: {
    rotaFeita: "rota_feita",
    responsavelAnalise: "responsavel_analise",
    totalMin: "total_min",
    minutosNormais: "minutos_normais",
    minutosExtrasPermitidos: "minutos_extras_permitidos",
    minutosExcedentes: "minutos_excedentes",
    valorExtraAprox: "valor_extra_aprox",
    isViagem: "is_viagem",
    paradaHotel: "parada_hotel",
    saidaHotel: "saida_hotel",
  },
  [LS.almocos]: {
    prevInicio: "prev_inicio",
    prevFim: "prev_fim",
    realInicio: "real_inicio",
    realFim: "real_fim",
    tempoPrev: "tempo_prev",
    tempoReal: "tempo_real",
  },
};

const SERVER_CACHE = Object.fromEntries(
  Object.keys(STORAGE_ENDPOINTS).map((chave) => [chave, []]),
);
let carregandoDadosServidorLocal = false;
let _dashPeriodo = "tudo";
const MODULOS_FUTUROS_ATIVOS = false;

const MOTORISTAS_ALIASES = {
  "GILSON LEAL": "EDSON",
};

function chaveMotoristaCanonica(valor) {
  return String(valor || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function canonizarMotorista(valor) {
  const original = String(valor ?? "").trim();
  if (!original) return "";
  const chave = chaveMotoristaCanonica(original);
  return MOTORISTAS_ALIASES[chave] || original;
}

function campoEhMotorista(campo) {
  return [
    "motorista",
    "motorista_nome",
    "motoristaNome",
    "nome_motorista",
    "nomeMotorista",
    "motorista_envolvido",
    "motoristaEnvolvido",
  ].includes(campo);
}

function normalizarCamposMotorista(reg = {}) {
  const out = { ...(reg || {}) };
  Object.keys(out).forEach((campo) => {
    if (campoEhMotorista(campo)) out[campo] = canonizarMotorista(out[campo]);
  });
  return out;
}

window.canonizarMotorista = canonizarMotorista;

// ================================================================
// 2. UTILITÁRIOS GERAIS
// ================================================================
function formatarTempo(min) {
  const v = Math.max(0, Number(min) || 0);
  if (v <= 0) return "0min";
  const h = Math.floor(v / 60),
    m = v % 60;
  return h > 0 ? `${h}h ${m}min` : `${m}min`;
}

function minutos(hora) {
  if (!hora) return 0;
  const [h, m] = String(hora).split(":").map(Number);
  return h * 60 + m || 0;
}

// Tolerancia de atraso na chegada a loja, em minutos. Chegar ate aqui depois
// do horario agendado NAO e atraso: nao pinta de vermelho, nao marca
// ocorrencia sozinho e o backend grava "No prazo".
// ESPELHO de TOLERANCIA_ATRASO_MIN em back/tempo.js — mudou la, mude aqui.
const TOLERANCIA_ATRASO_MIN = 20;

// Chegou atrasado ALEM da tolerancia? Unica regra de atraso do front:
// usada pelo preview de SLA/OTIF e pelo historico.
function atrasouAlemDaTolerancia(agendada, chegada) {
  if (!agendada || !chegada) return false;
  return minutos(chegada) - minutos(agendada) > TOLERANCIA_ATRASO_MIN;
}

function calcularPermanencia(inicio, fim) {
  if (!inicio || !fim) return 0;
  const t = minutos(fim) - minutos(inicio);
  return t < 0 ? 0 : t;
}

// Fallback do limite de DESCARGA (em minutos) usado so quando a tolerancia por
// loja (tl.js) ainda nao carregou. A fonte real e limiteDescargaLoja() abaixo.
const PERMANENCIA_LIMITE_MIN = 40;

// Limite de descarga da loja informada — FONTE UNICA. Delega para
// toleranciaDaLoja() (tl.js), que ja respeita excecoes por loja + padrao global.
// Assim o alerta verde/vermelho, o bloco de justificativa e a pontuacao usam
// exatamente o mesmo numero (sem o "40" fixo duplicado em varios lugares).
function limiteDescargaLoja(loja) {
  return typeof toleranciaDaLoja === "function"
    ? toleranciaDaLoja(loja)
    : PERMANENCIA_LIMITE_MIN;
}

// Tempo de permanencia (inicio da descarga -> saida da loja). Mantido para
// exibicao/relatorios; NAO e mais o gatilho da justificativa/ranking.
function permanenciaDaOcorrencia(o) {
  const v = Number(o?.permanencia_minutos);
  if (Number.isFinite(v) && v > 0) return v;
  return calcularPermanencia(o?.inicio_descarga, o?.fim_descarga);
}

// Tempo de DESCARGA (inicio -> termino da descarga). NAO inclui o intervalo
// entre o fim da descarga e a saida da loja. E este valor que dispara a
// justificativa e a regra de ranking (contar so a descarga, nao a permanencia).
function descargaDaOcorrencia(o) {
  return calcularPermanencia(o?.inicio_descarga, o?.termino_descarga);
}

// Mostra/esconde o bloco de justificativa conforme o tempo de DESCARGA calculado
// no formulario (inicio da descarga -> fim da descarga). Acima do limite aparece
// o checkbox "Teve justificativa?"; abaixo, some e zera tudo.
function atualizarCampoJustificativaPermanencia() {
  const wrap = document.getElementById("campoPermanenciaJustificativa");
  if (!wrap) return;
  const min = calcularPermanencia(getVal("inicioDescarga"), getVal("terminoDescarga"));
  const limite = limiteDescargaLoja(getVal("loja"));
  const lbl = document.getElementById("permanenciaJustificativaMin");
  if (lbl) lbl.textContent = min;
  const lblLim = document.getElementById("permanenciaJustificativaLimite");
  if (lblLim) lblLim.textContent = limite;
  const passou = min > limite;
  wrap.classList.toggle("hidden", !passou);
  if (!passou) {
    const cb = document.getElementById("permanenciaTeveJustificativa");
    if (cb) cb.checked = false;
    setVal("permanenciaJustificativa", "");
  }
  togglePermanenciaJustificativa();
}

// Checkbox "Teve justificativa?": marcado abre a caixa de justificativa
// (nao despontua); desmarcado esconde, limpa o texto e avisa que despontua.
function togglePermanenciaJustificativa() {
  const teve = !!document.getElementById("permanenciaTeveJustificativa")?.checked;
  document
    .getElementById("campoPermanenciaJustificativaTexto")
    ?.classList.toggle("hidden", !teve);
  document
    .getElementById("permanenciaSemJustificativaAviso")
    ?.classList.toggle("hidden", teve);
  if (!teve) setVal("permanenciaJustificativa", "");
}

function formatarDataBR(dataISO) {
  if (!dataISO) return "-";
  const s = String(dataISO).split("T")[0];
  if (s.includes("/")) return s;
  const p = s.split("-");
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : s;
}

function formatarNomeLoja(loja) {
  return (loja || "").replaceAll("_", " ");
}

// ---- Canonização de nomes de LOJA (espelha back/normalizar-loja.js) ----
// A MESMA loja aparece escrita de várias formas e some/duplica nos cruzamentos:
//   • romano × arábico no número final  → CAXIAS I  == CAXIAS 1
//   • acentos/typos no nome             → MAGE II   == MAGÉ 2
// Reduz tudo a um nome canônico único. Mantido em sincronia com o backend
// (que já grava o canônico no import); aqui cobrimos o que já está no banco.
const _ROM_LOJA = { I: "1", II: "2", III: "3", IV: "4", V: "5" };
const _STEM_LOJA = {
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
  "NOVA FRUBURGO": "NOVA FRIBURGO", "NOVA FRIBURGO": "NOVA FRIBURGO",
  "RIOS DAS OSTRAS": "RIO DAS OSTRAS", "RIO DAS OSTRAS": "RIO DAS OSTRAS",
  "S.P ALDEIA": "S.P. DA ALDEIA", "S.P DA ALDEIA": "S.P. DA ALDEIA",
  "S.P. ALDEIA": "S.P. DA ALDEIA", "SAO P ALDEIA": "S.P. DA ALDEIA",
  "STA.CRUZ DA SERRA": "STA. CRUZ DA SERRA", "STA CRUZ DA SERRA": "STA. CRUZ DA SERRA",
};
const _cacheCanonLoja = new Map();

function _semAcentoLoja(s) {
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function canonizarLoja(s) {
  if (s === null || s === undefined) return s;
  if (_cacheCanonLoja.has(s)) return _cacheCanonLoja.get(s);
  // underscores viram espaço; colapsa espaços; MAIÚSCULO (o front recebe UTF-8
  // limpo da API, então mojibake é tratado lá no backend, não aqui).
  const u = formatarNomeLoja(String(s)).toUpperCase().replace(/\s+/g, " ").trim();
  let out = "";
  if (u) {
    const m = u.match(/^(.*?)\s+(IV|V|III|II|I|\d+)$/);
    const stem = m ? m[1].trim() : u;
    const num = m ? (_ROM_LOJA[m[2]] || m[2]) : null;
    const canon = _STEM_LOJA[_semAcentoLoja(stem)] || stem;
    out = num ? `${canon} ${num}` : canon;
  }
  _cacheCanonLoja.set(s, out);
  return out;
}

// Chave de fusão (sem acento/espaço/pontuação) para AGRUPAR lojas iguais.
// CAXIAS I / CAXIAS 1 / "caxias_1" → todas viram "CAXIAS1".
function chaveLoja(s) {
  return _semAcentoLoja(canonizarLoja(s) || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

// Rótulo de exibição JÁ POLIDO (canônico) para AGRUPAR/exibir loja sem duplicar
// grafias: "CAXIAS I" e "CAXIAS 1" caem no MESMO rótulo "CAXIAS 1". Use este no
// lugar de formatarNomeLoja em rankings, filtros e listas por loja.
function rotuloLoja(loja, fallback) {
  const c = typeof canonizarLoja === "function" ? canonizarLoja(loja) : loja;
  return (c && String(c).trim()) || fallback || "";
}

// ---- Canonização de nomes de ROTA (espelha back/normalizar-rota.js) ----
// A mesma rota é escrita de várias formas: o mapa lojasRotas usa grafias
// antigas ("Z.OESTE I", "ALTERNATIVA I", "BAIXADA II") enquanto o banco já
// guarda o nome canônico vindo dos importadores ("ZONA OESTE 1", "ALTERNATIVA",
// "BAIXADA 2"). Sem normalizar, a mesma rota aparecia DUAS VEZES nos gráficos.
// Reduz tudo a um nome canônico único. Mantido em sincronia com o backend.
const _ROM_ROTA = { I: "1", II: "2", III: "3", IV: "4", 1: "1", 2: "2", 3: "3", 4: "4" };
const _cacheCanonRota = new Map();

function _semAcentoRota(s) {
  return String(s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function _componenteRota(c) {
  let u = _semAcentoRota(c).toUpperCase().replace(/\s+/g, " ").trim().replace(/\.+$/, "");
  u = u.replace(/\s*\(.*?\)/g, "").trim(); // remove anotações "(A)", "(MISSAO)"

  let m =
    u.match(/^Z\.?\s*OESTE\s*(IV|III|II|I|\d)$/) ||
    u.match(/^ZONA OESTE\s*(IV|III|II|I|\d)$/);
  if (m) return `ZONA OESTE ${_ROM_ROTA[m[1]]}`;

  m = u.match(/^(?:Z\.?\s*[NM]ORTE|ZONA NORTE|NORTE)\s*(II|I|\d)$/);
  if (m) return `ZONA NORTE ${_ROM_ROTA[m[1]]}`;

  m = u.match(/^BAIXADA\s*(III|II|I|\d)$/);
  if (m) return `BAIXADA ${_ROM_ROTA[m[1]]}`;

  if (/^R\.?\s*SERR[AE]NA$/.test(u) || u === "SERRANA" || u === "SERRENA")
    return "R. SERRANA";
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

function canonizarRota(s) {
  if (s === null || s === undefined) return s;
  if (_cacheCanonRota.has(s)) return _cacheCanonRota.get(s);
  const partes = String(s)
    .split(/\s*\+\s*/)
    .filter((p) => p.trim());
  const out = partes.length ? partes.map(_componenteRota).join(" + ") : "";
  _cacheCanonRota.set(s, out);
  return out;
}

function obterRotaDaOcorrencia(o) {
  return canonizarRota(lojasRotas[o?.loja] || o?.rota_nome || o?.rota || "Externa");
}

function extrairAjudantes(ajudantes) {
  if (!ajudantes) return [];
  return String(ajudantes)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function escapar(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizarJsonLocal(v) {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!t || (!t.startsWith("[") && !t.startsWith("{"))) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

function mapaServidor(chave) {
  return STORAGE_MAPS[chave] || {};
}

function inverterMapa(mapa) {
  return Object.fromEntries(
    Object.entries(mapa).map(([front, back]) => [back, front]),
  );
}

function registroParaServidor(chave, reg = {}) {
  const mapa = mapaServidor(chave);
  const out = {};
  Object.entries(reg || {}).forEach(([campo, valor]) => {
    const campoServidor = mapa[campo] || campo;
    out[campoServidor] = campoEhMotorista(campoServidor)
      ? canonizarMotorista(valor)
      : valor;
  });
  return out;
}

function registroDoServidor(chave, reg = {}) {
  const mapaInvertido = inverterMapa(mapaServidor(chave));
  const out = {};
  Object.entries(reg || {}).forEach(([campo, valor]) => {
    const campoFront = mapaInvertido[campo] || campo;
    out[campoFront] = normalizarJsonLocal(valor);
  });

  if (chave === LS.avisos && !Array.isArray(out.tipos)) {
    out.tipos = normalizarJsonLocal(out.tipos) || [];
  }

  if (chave === LS.checklist && !Array.isArray(out.itens)) {
    out.itens = normalizarJsonLocal(out.itens) || [];
  }

  return normalizarCamposMotorista(out);
}

async function apiStorageGet(chave) {
  const endpoint = STORAGE_ENDPOINTS[chave];
  if (!endpoint) return [];
  const res = await fetch(`${API_URL}${endpoint}?_=${Date.now()}`, {
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`GET ${endpoint} retornou ${res.status}`);
  }

  const dados = await res.json();
  return Array.isArray(dados)
    ? dados.map((item) => registroDoServidor(chave, item))
    : [];
}

async function apiStoragePost(chave, reg) {
  const endpoint = STORAGE_ENDPOINTS[chave];
  if (!endpoint) return null;

  const res = await fetch(`${API_URL}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(registroParaServidor(chave, reg)),
  });

  if (!res.ok) {
    const erro = await res.text().catch(() => "");
    throw new Error(`POST ${endpoint} retornou ${res.status}: ${erro}`);
  }

  const salvo = await res.json();
  return registroDoServidor(chave, salvo);
}

async function apiStorageDelete(chave, id) {
  const endpoint = STORAGE_ENDPOINTS[chave];
  if (!endpoint || id === undefined || id === null || id === "") return;

  const res = await fetch(`${API_URL}${endpoint}/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

  if (!res.ok && res.status !== 404) {
    const erro = await res.text().catch(() => "");
    throw new Error(`DELETE ${endpoint}/${id} retornou ${res.status}: ${erro}`);
  }
}

async function carregarDadosServidorLocal(silencioso = false, chaves = null) {
  if (carregandoDadosServidorLocal) return;
  carregandoDadosServidorLocal = true;

  try {
    // Sem `chaves` recarrega tudo; com `chaves` busca só os caches pedidos
    // (usado pelo realtime de veículos pra nao rebaixar os 8 endpoints).
    const alvos =
      Array.isArray(chaves) && chaves.length
        ? chaves.filter((c) => c in STORAGE_ENDPOINTS)
        : Object.keys(STORAGE_ENDPOINTS);
    await Promise.all(
      alvos.map(async (chave) => {
        try {
          SERVER_CACHE[chave] = await apiStorageGet(chave);
        } catch (err) {
          if (!silencioso)
            console.warn(`[server local] Falha ao carregar ${chave}:`, err);
          SERVER_CACHE[chave] = SERVER_CACHE[chave] || [];
        }
      }),
    );
  } finally {
    carregandoDadosServidorLocal = false;
  }
}

// Recarrega apenas os caches dos modulos de Controle de Veiculos (checklist,
// tacografo, diario de bordo) — usado pelo realtime de 10s. Antes esse ciclo
// chamava o loader completo (8 endpoints); agora busca so os 3 necessarios.
async function carregarCachesVeiculos() {
  return carregarDadosServidorLocal(true, [LS.checklist, LS.tacografos, LS.diarios]);
}

function lerStorage(chave) {
  const lista = SERVER_CACHE[chave];
  return Array.isArray(lista) ? [...lista] : [];
}

async function salvarStorage(chave, lista) {
  const endpoint = STORAGE_ENDPOINTS[chave];
  const anterior = Array.isArray(SERVER_CACHE[chave])
    ? [...SERVER_CACHE[chave]]
    : [];
  const atual = Array.isArray(lista) ? [...lista] : [];

  SERVER_CACHE[chave] = atual;

  if (!endpoint) return true;

  const idTexto = (item) => String(item?.id ?? "");
  const idsAnteriores = new Set(anterior.map(idTexto));
  const idsAtuais = new Set(atual.map(idTexto));

  const criados = atual.filter(
    (item) => item?.id !== undefined && !idsAnteriores.has(idTexto(item)),
  );
  const removidos = anterior.filter(
    (item) => item?.id !== undefined && !idsAtuais.has(idTexto(item)),
  );

  try {
    await Promise.all([
      ...criados.map((item) => apiStoragePost(chave, item)),
      ...removidos.map((item) => apiStorageDelete(chave, item.id)),
    ]);
    return true;
  } catch (err) {
    console.error(`[server local] Erro ao persistir ${chave}:`, err);
    alertar("❌ Erro ao salvar no servidor local. Veja o console.");
    return false;
  }
}

window.migrarLocalStorageAntigoParaServidor =
  async function migrarLocalStorageAntigoParaServidor() {
    let total = 0;

    for (const chave of Object.keys(STORAGE_ENDPOINTS)) {
      const antigos = JSON.parse(localStorage.getItem(chave) || "[]");
      if (!Array.isArray(antigos) || antigos.length === 0) continue;

      for (const item of antigos) {
        await apiStoragePost(chave, item);
        total++;
      }
    }

    await carregarDadosServidorLocal(true);
    atualizarTodasAsViews();
    alertar(
      `✅ Migração concluída. ${total} registro(s) enviados para o servidor local.`,
    );
  };

function hojeISO() {
  return new Date().toISOString().split("T")[0];
}

// Id de registro criado no front (almoço, checklist, atraso, rota, aviso).
// Use SEMPRE isto, nunca `Date.now()` cru.
//
// O POST do CRUD genérico regrava o id como `id % 2147483647` (back/server.js,
// criarRotasCRUD) e `salvarStorage` descarta o registro que o servidor devolve.
// Com `Date.now()` cru o cache do front fica com 13 dígitos e o banco com o
// truncado — os dois deixam de falar do mesmo registro. Quem excluísse logo
// depois de salvar mandava DELETE no id errado; o back respondia 404, o front
// trata 404 como sucesso (exclusão idempotente, ver apiStorageDelete) e o card
// sumia da tela com a linha intacta no banco, reaparecendo no refresh seguinte.
function gerarIdCompatBanco() {
  return Date.now() % 2147483647;
}

function horaAgora() {
  return new Date().toTimeString().slice(0, 5);
}
function $(id) {
  return document.getElementById(id);
}
function getVal(id) {
  return $(id)?.value || "";
}
function setVal(id, v) {
  const el = $(id);
  if (el) el.value = v ?? "";
}

function numeroOuNulo(v) {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function numeroCampo(id) {
  return numeroOuNulo(getVal(id));
}

function formatarMoeda(valor) {
  return (Number(valor) || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function lerArquivoEvidencia(inputId, atualId) {
  const arquivo = $(inputId)?.files?.[0];
  if (!arquivo) return Promise.resolve(getVal(atualId) || null);
  if (arquivo.size > 1.5 * 1024 * 1024) {
    alertar("Cada evidência do POD deve ter no máximo 1,5 MB.");
    return Promise.reject(new Error("Arquivo de evidência acima do limite."));
  }
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(leitor.result);
    leitor.onerror = () => reject(new Error("Falha ao ler evidência."));
    leitor.readAsDataURL(arquivo);
  });
}

function atualizarPreviewEvidencia(inputId, previewId) {
  const arquivo = $(inputId)?.files?.[0];
  const preview = $(previewId);
  if (!preview) return;
  if (!arquivo) {
    preview.innerHTML = "";
    return;
  }
  if (arquivo.size > 1.5 * 1024 * 1024) {
    alertar("Cada evidência do POD deve ter no máximo 1,5 MB.");
    $(inputId).value = "";
    preview.innerHTML = "";
    return;
  }
  const url = URL.createObjectURL(arquivo);
  preview.innerHTML = `<img src="${url}" alt="Prévia da evidência" style="height:72px;max-width:100%;object-fit:cover;border-radius:7px;border:1px solid var(--border);">`;
}

function capturarLocalizacaoPOD() {
  const status = $("gpsStatusPOD");
  if (!navigator.geolocation) {
    if (status)
      status.textContent = "Geolocalização indisponível neste navegador.";
    return;
  }
  if (status) status.textContent = "Capturando localização...";
  navigator.geolocation.getCurrentPosition(
    (posicao) => {
      const lat = posicao.coords.latitude.toFixed(7);
      const lng = posicao.coords.longitude.toFixed(7);
      setVal("gpsLatitude", lat);
      setVal("gpsLongitude", lng);
      if (status) status.textContent = `Localização capturada: ${lat}, ${lng}`;
    },
    () => {
      if (status) status.textContent = "Não foi possível obter a localização.";
    },
    { enableHighAccuracy: true, timeout: 10000 },
  );
}

function atualizarCustoTotal() {
  const total =
    (numeroCampo("kmReal") || 0) * (numeroCampo("custoKm") || 0) +
    (numeroCampo("pedagio") || 0) +
    (numeroCampo("custoReentrega") || 0) +
    (numeroCampo("custoOcorrencia") || 0);
  const preview = $("custoTotalPreview");
  if (preview)
    preview.textContent = `Custo total calculado: ${formatarMoeda(total)}`;
  return total;
}

function atualizarPreviewOtif() {
  const preview = $("previewOtif");
  if (!preview) return;
  const previsto = getVal("horaAgendadaLoja");
  const chegada = getVal("hora_chegada");
  if (!previsto || !chegada) {
    const semHorario =
      typeof window.lojaSemHorario === "function" &&
      window.lojaSemHorario(getVal("loja"));
    preview.textContent = semHorario
      ? "Loja sem horário-meta — SLA/OTIF não se aplica a esta entrega."
      : "O SLA e o OTIF serão calculados usando o horário agendado e a chegada.";
    preview.style.color = "var(--text-muted)";
    return;
  }
  const noPrazo = !atrasouAlemDaTolerancia(previsto, chegada);
  // In Full: o campo explícito manda quando alguém o preencheu; em branco,
  // quem decide é a ocorrência lançada (kpi-ocorrencia.js) — mesma regra do
  // servidor. Em branco NÃO significa "incompleta".
  const escolhido = getVal("entregaCompleta");
  const completa = escolhido
    ? escolhido === "sim"
    : typeof relacaoKpiDoFormulario === "function"
      ? (relacaoKpiDoFormulario()?.inFull ?? true)
      : true;
  const otif = noPrazo && completa ? "Conforme" : "Não conforme";
  preview.textContent = `SLA: ${noPrazo ? "No prazo" : "Atrasada"} | OTIF: ${otif}`;
  preview.style.color =
    noPrazo && completa ? "var(--verde)" : "var(--vermelho)";

  if (!noPrazo) marcarAtrasoAutomatico();
}

function marcarAtrasoAutomatico() {
  if (getVal("teveOcorrencia") !== "sim") {
    setVal("teveOcorrencia", "sim");
    if (typeof toggleOcorrencia === "function") toggleOcorrencia();
  }
  const checks = checksGrupo("tipoOcorrencia");
  if (!checks.length) return;
  const atraso = checks.find((c) => c.value === "Atraso");
  if (atraso && !atraso.checked) {
    atraso.checked = true;
    sincronizarGrupoMulti("tipoOcorrencia");
  }
}

function calcularDivergenciaNumerica(previsto, realizado) {
  const p = numeroOuNulo(previsto);
  const r = numeroOuNulo(realizado);
  return p !== null && r !== null ? r - p : null;
}

function formatarNumeroOperacional(v) {
  const n = numeroOuNulo(v);
  return n === null ? "-" : String(n).replace(".", ",");
}

function formatarDivergenciaOperacional(v) {
  const n = numeroOuNulo(v);
  if (n === null) return "-";
  if (n === 0) return "Sem divergência";
  return `${n > 0 ? "+" : ""}${String(n).replace(".", ",")}`;
}

function textoSimNao(v) {
  return v === "sim" ? "Sim" : v === "nao" ? "Não" : "";
}

const RESPONSAVEIS_OCORRENCIA = [
  "EXPEDICAO",
  "EXPEDICAO ADM",
  "TRANSPORTE",
  "ESTOQUE",
  "4 ANDAR",
  "COMERCIAL",
  "CONTROLE DE ESTOQUE",
  "VM",
  "GRAFICA",
  "LOJA",
  "SUPERVISAO INTERNA",
  "ALMOXERIFADO",
  "EQUIPE DA ENTREGA",
  "SEGURANCA DO TRABALHO",
  "PLANEJAMENTO",
  "T.I",
];

function normalizarResponsavelOcorrencia(valor) {
  return String(valor || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function responsavelEquipeEntrega(valor) {
  const partes = String(valor || "")
    .split(/,|;|\|/)
    .map((v) => normalizarResponsavelOcorrencia(v));
  return (
    partes.includes("EQUIPE DA ENTREGA") || partes.includes("EQUIPE DE ENTREGA")
  );
}

function obterResponsavelOcorrencia(o = {}) {
  const valor =
    o.ocorrencia_responsavel ??
    o.ocorrenciaResponsavel ??
    o.responsavel_ocorrencia ??
    o.responsavelOcorrencia ??
    "";

  return normalizarResponsavelOcorrencia(valor);
}

function getResponsavelOcorrenciaForm() {
  const valores = selecionadosGrupo("ocorrenciaResponsavel");
  return valores.join(", ");
}

function alertar(msg) {
  if (typeof mostrarAlerta === "function") mostrarAlerta(msg);
  else alert(msg);
}

function confirmarSimples(msg, cb) {
  if (typeof confirmar === "function") confirmar(msg, cb);
  else if (confirm(msg)) cb();
}

// ================================================================
// 3. NORMALIZAÇÃO DE OCORRÊNCIAS
// ================================================================
function normalizarOcorrencia(o) {
  const horaChegada = o.hora_chegada ?? o.horaChegada ?? "";
  const inicioDescarga = o.inicio_descarga ?? o.inicioDescarga ?? "";
  const fimDescarga =
    o.fim_descarga ?? o.fimDescarga ?? o.saida_loja ?? o.saidaLoja ?? "";
  const tipoProblemaOriginal = o.tipo_problema ?? o.tipoOcorrencia ?? null;
  const textoRegraSemDivergencia = [
    tipoProblemaOriginal,
    o.descricao,
    o.relato,
    o.ocorrencia_status,
  ]
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
  const entregaSemDivergencia =
    /\b(CONCLU[I]+D[OA]?|ENTREGUE)\b/.test(textoRegraSemDivergencia) &&
    /\bSEM\s+DIVERG/.test(textoRegraSemDivergencia);
  const tipoProblema = entregaSemDivergencia ? null : tipoProblemaOriginal;
  const ocorrenciaResponsavel = obterResponsavelOcorrencia(o);
  const descricao = o.descricao ?? o.relato ?? "";
  const protocolo = o.protocolo_imprevisto ?? o.protocolo ?? "";
  const dataOcorrencia = o.data_ocorrencia ?? o.data ?? "";
  const teveOcorrencia =
    entregaSemDivergencia
      ? false
      : o.teve_ocorrencia ?? o.teveOcorrencia ?? !!tipoProblema;
  const permanencia =
    o.permanencia_minutos ?? calcularPermanencia(horaChegada, fimDescarga);

  const primeiroPreenchido = (...valores) =>
    valores.find(
      (v) => v !== null && v !== undefined && String(v).trim() !== "",
    );

  const retiradaCxPrevista = numeroOuNulo(
    primeiroPreenchido(
      o.retirada_cx_prevista,
      o.retiradaCxPrevista,
      o.cx_prevista,
      o.cxPrevista,
      o.caixa_prevista,
      o.caixaPrevista,
      o.qtd_caixa_prevista,
      o.qtdCaixaPrevista,
    ),
  );
  const retiradaCxRealizada = numeroOuNulo(
    primeiroPreenchido(
      o.retirada_cx_realizada,
      o.retiradaCxRealizada,
      o.cx_realizada,
      o.cxRealizada,
      o.caixa_realizada,
      o.caixaRealizada,
      o.qtd_caixa_realizada,
      o.qtdCaixaRealizada,
    ),
  );
  const retiradaRtPrevista = numeroOuNulo(
    primeiroPreenchido(
      o.retirada_rt_prevista,
      o.retiradaRtPrevista,
      o.rt_prevista,
      o.rtPrevista,
      o.qtd_rt_prevista,
      o.qtdRtPrevista,
    ),
  );
  const retiradaRtRealizada = numeroOuNulo(
    primeiroPreenchido(
      o.retirada_rt_realizada,
      o.retiradaRtRealizada,
      o.rt_realizada,
      o.rtRealizada,
      o.qtd_rt_realizada,
      o.qtdRtRealizada,
    ),
  );
  const volumeGerencial = numeroOuNulo(
    primeiroPreenchido(o.volume_gerencial, o.volumeGerencial, o.vol_gerencial),
  );
  const volumeFisico = numeroOuNulo(
    primeiroPreenchido(o.volume_fisico, o.volumeFisico, o.vol_fisico),
  );
  const materialCampanhaQtd = numeroOuNulo(
    primeiroPreenchido(o.material_campanha_qtd, o.materialCampanhaQtd),
  );
  const campanhaBannerQtd = numeroOuNulo(
    primeiroPreenchido(o.campanha_banner_qtd, o.campanhaBannerQtd),
  );
  const campanhaFolderQtd = numeroOuNulo(
    primeiroPreenchido(o.campanha_folder_qtd, o.campanhaFolderQtd),
  );
  const campanhaAdesivoQtd = numeroOuNulo(
    primeiroPreenchido(o.campanha_adesivo_qtd, o.campanhaAdesivoQtd),
  );
  const campanhaQuadroQtd = numeroOuNulo(
    primeiroPreenchido(o.campanha_quadro_qtd, o.campanhaQuadroQtd),
  );
  const campanhaBannerNome =
    primeiroPreenchido(o.campanha_banner_campanha, o.campanhaBannerCampanha) ??
    "";
  const campanhaFolderNome =
    primeiroPreenchido(o.campanha_folder_campanha, o.campanhaFolderCampanha) ??
    "";
  const campanhaAdesivoNome =
    primeiroPreenchido(
      o.campanha_adesivo_campanha,
      o.campanhaAdesivoCampanha,
    ) ?? "";
  const campanhaQuadroNome =
    primeiroPreenchido(o.campanha_quadro_campanha, o.campanhaQuadroCampanha) ??
    "";
  const sacolaP = numeroOuNulo(primeiroPreenchido(o.sacola_p, o.sacolaP));
  const sacolaM = numeroOuNulo(primeiroPreenchido(o.sacola_m, o.sacolaM));
  const sacolaG = numeroOuNulo(primeiroPreenchido(o.sacola_g, o.sacolaG));
  const sacolaQtd =
    numeroOuNulo(primeiroPreenchido(o.sacola_qtd, o.sacolaQtd)) ??
    ((sacolaP ?? 0) + (sacolaM ?? 0) + (sacolaG ?? 0) || null);

  return {
    ...o,
    tipo_registro: "entrega",
    motorista: canonizarMotorista(
      o.motorista ?? o.motorista_nome ?? o.motoristaNome ?? "",
    ),
    data_ocorrencia: dataOcorrencia,
    hora_chegada: horaChegada,
    inicio_descarga: inicioDescarga,
    fim_descarga: fimDescarga,
    tipo_problema: tipoProblema,
    ocorrencia_responsavel: ocorrenciaResponsavel,
    ocorrenciaResponsavel,
    descricao,
    protocolo_imprevisto: protocolo,
    teve_ocorrencia: teveOcorrencia,
    permanencia_minutos: permanencia,
    permanencia_justificativa:
      o.permanencia_justificativa ?? o.permanenciaJustificativa ?? "",
    fez_checklist: o.fez_checklist ?? null,
    problema_operacional_tipo:
      o.problema_operacional_tipo ?? o.problemaOperacionalTipo ?? null,
    problema_operacional_relato:
      o.problema_operacional_relato ?? o.problemaOperacionalRelato ?? "",
    retirada_cx_prevista: retiradaCxPrevista,
    retirada_cx_realizada: retiradaCxRealizada,
    retirada_cx_divergencia:
      primeiroPreenchido(o.retirada_cx_divergencia, o.retiradaCxDivergencia) ??
      calcularDivergenciaNumerica(retiradaCxPrevista, retiradaCxRealizada),
    retiradaCxPrevista,
    retiradaCxRealizada,
    retiradaCxDivergencia:
      primeiroPreenchido(o.retirada_cx_divergencia, o.retiradaCxDivergencia) ??
      calcularDivergenciaNumerica(retiradaCxPrevista, retiradaCxRealizada),
    retirada_rt_prevista: retiradaRtPrevista,
    retirada_rt_realizada: retiradaRtRealizada,
    retirada_rt_divergencia:
      primeiroPreenchido(o.retirada_rt_divergencia, o.retiradaRtDivergencia) ??
      calcularDivergenciaNumerica(retiradaRtPrevista, retiradaRtRealizada),
    retiradaRtPrevista,
    retiradaRtRealizada,
    retiradaRtDivergencia:
      primeiroPreenchido(o.retirada_rt_divergencia, o.retiradaRtDivergencia) ??
      calcularDivergenciaNumerica(retiradaRtPrevista, retiradaRtRealizada),
    volume_gerencial: volumeGerencial,
    volume_fisico: volumeFisico,
    volume_divergencia:
      primeiroPreenchido(o.volume_divergencia, o.volumeDivergencia) ??
      calcularDivergenciaNumerica(volumeGerencial, volumeFisico),
    volumeGerencial,
    volumeFisico,
    volumeDivergencia:
      primeiroPreenchido(o.volume_divergencia, o.volumeDivergencia) ??
      calcularDivergenciaNumerica(volumeGerencial, volumeFisico),
    transferencia_problema:
      primeiroPreenchido(o.transferencia_problema, o.transferenciaProblema) ??
      "",
    transferenciaProblema:
      primeiroPreenchido(o.transferencia_problema, o.transferenciaProblema) ??
      "",
    transferencia_relato:
      primeiroPreenchido(o.transferencia_relato, o.transferenciaRelato) ?? "",
    transferenciaRelato:
      primeiroPreenchido(o.transferencia_relato, o.transferenciaRelato) ?? "",
    sacola_status: primeiroPreenchido(o.sacola_status, o.sacolaStatus) ?? "",
    sacolaStatus: primeiroPreenchido(o.sacola_status, o.sacolaStatus) ?? "",
    sacola_relato: primeiroPreenchido(o.sacola_relato, o.sacolaRelato) ?? "",
    sacolaRelato: primeiroPreenchido(o.sacola_relato, o.sacolaRelato) ?? "",
    almoxerifado_status:
      primeiroPreenchido(o.almoxerifado_status, o.almoxerifadoStatus) ?? "",
    almoxerifadoStatus:
      primeiroPreenchido(o.almoxerifado_status, o.almoxerifadoStatus) ?? "",
    almoxerifado_relato:
      primeiroPreenchido(o.almoxerifado_relato, o.almoxerifadoRelato) ?? "",
    almoxerifadoRelato:
      primeiroPreenchido(o.almoxerifado_relato, o.almoxerifadoRelato) ?? "",
    material_envio_status:
      primeiroPreenchido(o.material_envio_status, o.materialEnvioStatus) ?? "",
    materialEnvioStatus:
      primeiroPreenchido(o.material_envio_status, o.materialEnvioStatus) ?? "",
    material_envio_relato:
      primeiroPreenchido(o.material_envio_relato, o.materialEnvioRelato) ?? "",
    materialEnvioRelato:
      primeiroPreenchido(o.material_envio_relato, o.materialEnvioRelato) ?? "",
    material_retirada_status: o.material_retirada_status ?? "",
    material_retirada_relato: o.material_retirada_relato ?? "",
    material_campanha_qtd: materialCampanhaQtd,
    materialCampanhaQtd,
    campanha_banner_qtd: campanhaBannerQtd,
    campanha_banner_campanha: campanhaBannerNome,
    campanhaBannerQtd,
    campanhaBannerCampanha: campanhaBannerNome,
    campanha_folder_qtd: campanhaFolderQtd,
    campanha_folder_campanha: campanhaFolderNome,
    campanhaFolderQtd,
    campanhaFolderCampanha: campanhaFolderNome,
    campanha_adesivo_qtd: campanhaAdesivoQtd,
    campanha_adesivo_campanha: campanhaAdesivoNome,
    campanhaAdesivoQtd,
    campanhaAdesivoCampanha: campanhaAdesivoNome,
    campanha_quadro_qtd: campanhaQuadroQtd,
    campanha_quadro_campanha: campanhaQuadroNome,
    campanhaQuadroQtd,
    campanhaQuadroCampanha: campanhaQuadroNome,
    sacola_qtd: sacolaQtd,
    sacolaQtd,
    sacola_p: sacolaP,
    sacolaP,
    sacola_m: sacolaM,
    sacolaM,
    sacola_g: sacolaG,
    sacolaG,
    pedido_numero: o.pedido_numero ?? "",
    nota_fiscal: o.nota_fiscal ?? "",
    romaneio_numero: o.romaneio_numero ?? "",
    valor_carga: numeroOuNulo(o.valor_carga),
    entrega_completa:
      entregaSemDivergencia ||
      o.entrega_completa === true ||
      o.entrega_completa === "true",
    sla_status: o.sla_status ?? "Sem prazo",
    otif_status: o.otif_status ?? "Sem SLA",
    ocorrencia_severidade: o.ocorrencia_severidade ?? "",
    ocorrencia_status: entregaSemDivergencia
      ? "Nao se aplica"
      : o.ocorrencia_status ?? "",
    causa_raiz: o.causa_raiz ?? "",
    acao_corretiva: o.acao_corretiva ?? "",
    prazo_solucao: o.prazo_solucao ?? "",
    km_previsto: numeroOuNulo(o.km_previsto),
    km_real: numeroOuNulo(o.km_real),
    custo_km: numeroOuNulo(o.custo_km),
    pedagio: numeroOuNulo(o.pedagio),
    custo_reentrega: numeroOuNulo(o.custo_reentrega),
    custo_ocorrencia: numeroOuNulo(o.custo_ocorrencia),
    custo_total: numeroOuNulo(o.custo_total),
    pod_status: o.pod_status ?? "Pendente",
    pod_documento_recebedor: o.pod_documento_recebedor ?? "",
    pod_foto: o.pod_foto ?? "",
    pod_canhoto: o.pod_canhoto ?? "",
    pod_assinatura: o.pod_assinatura ?? "",
    gps_latitude: o.gps_latitude ?? "",
    gps_longitude: o.gps_longitude ?? "",
    pod_confirmado_em: o.pod_confirmado_em ?? "",
  };
}

function ordenarPorId(lista = []) {
  return [...lista].sort((a, b) => {
    const nA = Number(String(a.id || "0").replace(/\D/g, "")) || 0;
    const nB = Number(String(b.id || "0").replace(/\D/g, "")) || 0;
    return nB !== nA
      ? nB - nA
      : String(b.data_ocorrencia || "").localeCompare(
          String(a.data_ocorrencia || ""),
        );
  });
}

// ================================================================
// 4. OBTENÇÃO DE DADOS ATIVOS (COM SUPORTE A FILTROS DA TORRE)
// ================================================================
function estaNaTorreControle() {
  return !!$("filtroDataInicial");
}

function obterOcorrenciasAtivas() {
  if (estaNaTorreControle() && temFiltrosEntregaTorreAtivos())
    return ocorrenciasFiltradasTorre;
  return ocorrencias;
}

// ----------------------------------------------------------------
// Ocorrencias avulsas (escopo GERAL e ENTREGA) carregadas para
// alimentar os graficos do dashboard. Sao virtualizadas como
// "ocorrencias" simples com tipo_problema/responsavel/rota.
// ----------------------------------------------------------------
window.ocorrenciasAvulsasGraficos = window.ocorrenciasAvulsasGraficos || [];

async function carregarAvulsasParaGraficos() {
  try {
    const res = await fetch(`${API_URL}/ocorrencias-avulsas?_=${Date.now()}`, {
      cache: "no-store",
    });
    if (!res.ok) return;
    const raw = await res.json();
    window.ocorrenciasAvulsasGraficos = (raw || []).map((a) => ({
      id: `av-${a.id}`,
      tipo_registro: "avulsa",
      escopo: a.escopo || "GERAL",
      data_ocorrencia: String(a.data_ocorrencia || "").split("T")[0],
      loja: null,
      rota: a.rota_nome || null,
      rota_nome: a.rota_nome || null,
      motorista: canonizarMotorista(a.motorista_nome || null),
      teve_ocorrencia: true,
      tipo_problema: a.tipo_problema || a.titulo || null,
      ocorrencia_responsavel: a.culpa || null,
      ocorrencia_status: a.status || null,
    }));
  } catch (e) {
    console.warn("[carregarAvulsasParaGraficos] falhou:", e?.message || e);
  }
}

// Retorna as avulsas virtualizadas, aplicando o mesmo filtro de
// periodo (hoje/semana/mes/tudo) do dashboard.
function obterAvulsasParaGraficos(comFiltroPeriodo = true) {
  const lista = Array.isArray(window.ocorrenciasAvulsasGraficos)
    ? window.ocorrenciasAvulsasGraficos
    : [];
  return comFiltroPeriodo ? _filtrarDashPeriodo(lista) : lista;
}

// ================================================================
// 5. API — CARREGAMENTO
// ================================================================
async function carregarHistorico(silencioso = false) {
  if (
    typeof authTemPermissao === "function" &&
    !authTemPermissao("visualizar_dados")
  ) {
    return;
  }
  if (carregandoHistorico) return;

  carregandoHistorico = true;

  try {
    const ts = Date.now();

    const res = await fetch(`${API_URL}/ocorrencias?_=${ts}`, {
      cache: "no-store",
    }).catch((err) => {
      console.warn("[carregarHistorico] Falha ao buscar /ocorrencias:", err);
      return null;
    });

    if (res && res.ok) {
      const raw = await res.json();

      ocorrencias = raw.map((o) =>
        normalizarOcorrencia({ ...o, tipo_registro: "entrega" }),
      );
      // Marca o horário da última sincronização bem-sucedida no indicador do topo.
      if (typeof _atualizarLabeUltimaAtt === "function") _atualizarLabeUltimaAtt();
    } else if (res) {
      console.warn(
        "[carregarHistorico] /ocorrencias retornou status:",
        res.status,
      );
    }

    if (!silencioso) {
      console.info(
        `[carregarHistorico] Carregado: ${ocorrencias.length} entregas`,
      );
    }

    await carregarDadosServidorLocal(true);

    // Avulsas e ocorrencias da entrega (escopo GERAL/ENTREGA) alimentam os
    // graficos do dashboard junto com as ocorrencias de loja.
    await carregarAvulsasParaGraficos();

    popularFiltroRotaHistorico(true);

    if (estaNaTorreControle()) {
      popularFiltrosTorre();
      inicializarFiltrosTorre();

      if (temFiltrosTorreAtivos()) {
        aplicarFiltrosTorre();
        return;
      }

      ocorrenciasFiltradasTorre = [];
    }

    atualizarTodasAsViews();
  } catch (err) {
    console.error("[carregarHistorico] Erro inesperado:", err);
    alertar("❌ Erro ao carregar histórico.");
  } finally {
    carregandoHistorico = false;
  }
}

// ================================================================
// 6. ATUALIZAÇÃO CENTRALIZADA
// ================================================================
function atualizarTodasAsViews() {
  const chamar = (fn) => {
    try {
      if (typeof window[fn] === "function") window[fn]();
    } catch (e) {
      console.warn(fn, e);
    }
  };
  // Fase 2: no ciclo automatico, pula os renders pesados das abas escondidas
  // (cada aba se re-renderiza sozinha ao ser aberta). Badges/avisos e o
  // dashboard continuam sempre atualizados.
  const abaVisivel = (id) => {
    const el = $(id);
    return !!el && !el.classList.contains("aba-hidden");
  };
  chamar("atualizarDashboard");
  chamar("atualizarMonitoramento");
  chamar("atualizarDashboardOcorrencias");
  chamar("atualizarDashboardProblemasOperacionais");
  if (abaVisivel("aba-entregas")) atualizarTela();

  if ($("rankMotoristas")) {
    chamar("processarRankings");
    chamar("atualizarListaCompacta");
  }

  renderizarAvisosMonitoramento();
  if (abaVisivel("aba-equipes")) chamar("calcularEquipes");

  // Tendências: re-renderiza no ciclo automático apenas quando a aba está
  // visível (trocar de aba já dispara um render próprio).
  const tendVisivel =
    $("aba-tendencias") &&
    !$("aba-tendencias").classList.contains("aba-hidden");
  if (tendVisivel) chamar("renderizarTendencias");

  const historicoRotasVisivel =
    $("aba-historico-rotas") &&
    !$("aba-historico-rotas").classList.contains("aba-hidden");
  if (historicoRotasVisivel) chamar("historicoRotasInit");

  // ✅ Sempre respeita o filtro de data ativo na aba Veículos
  if (typeof aplicarFiltroVeiculos === "function") {
    aplicarFiltroVeiculos();
  } else {
    renderizarListaChecklistDiario();
    renderizarListaAtrasosSaida();
    renderizarListaRotas();
    renderizarListaAlmocos();
  }

  try {
    if (typeof window.atualizarComplementosTorre === "function") {
      window.atualizarComplementosTorre();
    }
  } catch (e) {
    console.warn("atualizarComplementosTorre", e);
  }
}
