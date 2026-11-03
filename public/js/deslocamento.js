// ================================================================
// deslocamento.js
// ----------------------------------------------------------------
// Aba "Deslocamento" — Análise de tempo de deslocamento do roteiro.
//
// Replica a planilha do roteiro: para cada rota você monta a sequência
// FÁBRICA → 1ª loja → demais lojas com Km, Hora de Chegada e Hora de
// Saída. O sistema CALCULA automaticamente:
//   • Tempo de Deslocamento = chegada(atual) − saída(ponto anterior)
//       (no 1º ponto: chegada(1ª loja) − saída da fábrica)
//   • Tempo de Descarga     = saída(loja) − chegada(loja)
//   • Totais (km, deslocamento, descarga, jornada)
//
// O roteiro PLANEJADO é salvo no banco (CRUD /roteiros). O comparativo
// PLANEJADO × REAL é feito aqui no front, cruzando por nome de loja com
// o array global `ocorrencias` (que já traz data_ocorrencia, hora_chegada,
// fim_descarga = saída da loja e hora_saida_fabrica).
//
// Arquivo autocontido (script clássico, escopo global). Reaproveita os
// globais já carregados: escapar, formatarNomeLoja, obterRotaDaOcorrencia,
// hojeISO, lojasRotas, ocorrencias, alertar, confirmarSimples. Por isso é
// incluído DEPOIS dos script-*.
// ================================================================

let _deslRoteiros = []; // cabeçalhos (GET /roteiros)
let _deslAtual = null; // { id?, rota_nome, dia_semana, hora_saida_fabrica, descricao, paradas:[] }
let _deslRegistros = []; // /rotas-registradas (saída/retorno por rota+dia) — usado no link "Por dia"
let _deslDistIndex = null;

// ── helpers ──────────────────────────────────────────────────────
function _deslEsc(v) {
  return typeof escapar === "function"
    ? escapar(v)
    : String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
      );
}

// "HH:MM" ou "HH:MM:SS" → minutos do dia (ou null)
function _deslMin(t) {
  if (t == null) return null;
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h > 47 || min > 59) return null;
  return h * 60 + min;
}

// minutos de duração → "HH:MM" (negativo mantém sinal)
function _deslDur(min) {
  if (min == null || isNaN(min)) return "—";
  const neg = min < 0;
  min = Math.abs(Math.round(min));
  const h = Math.floor(min / 60);
  const m = min % 60;
  return (neg ? "-" : "") + String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

// diferença para − de, tratando virada de meia-noite
function _deslDiff(de, para) {
  const a = _deslMin(de), b = _deslMin(para);
  if (a == null || b == null) return null;
  let d = b - a;
  if (d < 0) d += 1440;
  return d;
}

// No roteiro planejado, horário menor que o anterior é erro de digitação,
// não virada de dia. Evita deslocamentos absurdos como 23:32.
function _deslDiffMesmoDia(de, para) {
  const a = _deslMin(de), b = _deslMin(para);
  if (a == null || b == null) return null;
  const d = b - a;
  return d < 0 ? null : d;
}

function _deslDiffPlanejado(de, para, diaSeguinte) {
  return diaSeguinte ? _deslDiff(de, para) : _deslDiffMesmoDia(de, para);
}

function _deslKm(n) {
  const v = Number(n);
  if (!isFinite(v) || v === 0) return "—";
  return v.toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " km";
}

function _deslKmValor(n) {
  const v = Number(n);
  if (!isFinite(v)) return "";
  return String(Math.round(v * 10) / 10).replace(".", ",");
}

// chave de comparação de loja: passa pelo polimento canônico (canonizarLoja:
// unifica romano/arábico, acentos e typos) e reduz a A-Z0-9 — assim CAXIAS I e
// CAXIAS 1, MAGE II e MAGÉ 2 caem na MESMA chave e deixam de duplicar.
let _deslMapaBaseLoja = null;
let _deslMapaBaseLojaRota = null;
const DESL_LOJAS_AMBIGUAS = new Set([
  "MADUREIRA",
  "BANGU",
  "SAOGONCALO",
  "NITEROI",
  "CABOFRIO",
  "MARICA",
  "MACAE",
  "CAMPOS",
  "ITABORAI",
  "NIGUACU",
  "SANTACRUZ",
  "CENTRO",
  "COPACABANA",
]);

function _deslBaseLojaKey(chave) {
  return String(chave || "").replace(/(?:IV|III|II|I|[0-9]+)$/i, "");
}

function _deslMapaBaseLojasConhecidas() {
  if (_deslMapaBaseLoja) return _deslMapaBaseLoja;
  const mapa = {};
  if (typeof lojasRotas === "object" && lojasRotas) {
    Object.keys(lojasRotas).forEach((loja) => {
      const chave = _deslNormLojaBasica(loja);
      const base = _deslBaseLojaKey(chave);
      if (!base) return;
      const arr = (mapa[base] = mapa[base] || []);
      if (!arr.includes(chave)) arr.push(chave);
    });
  }
  _deslMapaBaseLoja = mapa;
  return mapa;
}

function _deslMapaBaseLojasPorRota() {
  if (_deslMapaBaseLojaRota) return _deslMapaBaseLojaRota;
  const mapa = {};
  if (typeof lojasRotas === "object" && lojasRotas) {
    Object.entries(lojasRotas).forEach(([loja, rota]) => {
      const chave = _deslNormLojaBasica(loja);
      const base = _deslBaseLojaKey(chave);
      if (!base) return;
      _deslPartesRota(rota).forEach((rotaParte) => {
        const id = `${rotaParte}|${base}`;
        const arr = (mapa[id] = mapa[id] || []);
        if (!arr.includes(chave)) arr.push(chave);
      });
    });
  }
  _deslMapaBaseLojaRota = mapa;
  return mapa;
}

function _deslNormLojaBasica(nome) {
  const chave =
    typeof chaveLoja === "function"
      ? chaveLoja(nome)
      : String(nome || "")
          .normalize("NFD")
          .toUpperCase()
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\bIII\b/g, "3")
          .replace(/\bII\b/g, "2")
          .replace(/\bI\b/g, "1")
          .replace(/[^A-Z0-9]/g, "");
  const aliases = {
    SAOPEDRO: "SAOPALDEIA",
    SAOPEDROALDEIA: "SAOPALDEIA",
    SAOPEDRODAALDEIA: "SAOPALDEIA",
    SPDAALDEIA: "SAOPALDEIA",
    SPALDEIA: "SAOPALDEIA",
    NOVAIGUACU: "NIGUACU",
    NOVAIGUACU1: "NIGUACU1",
    NOVAIGUACU2: "NIGUACU2",
    NOVAIGUACU3: "NIGUACU3",
    ZONACENTRAL: "CENTRO",
  };
  return aliases[chave] || chave;
}

function _deslNormLoja(nome, rota) {
  const chave = _deslNormLojaBasica(nome);
  const base = _deslBaseLojaKey(chave);
  const temFilial = chave !== base;
  if (DESL_LOJAS_AMBIGUAS.has(base) && !temFilial) return chave;
  if (rota) {
    const porRota = _deslMapaBaseLojasPorRota();
    for (const rotaParte of _deslPartesRota(rota)) {
      const conhecidasRota = porRota[`${rotaParte}|${base}`] || [];
      if (conhecidasRota.length === 1) return conhecidasRota[0];
    }
  }
  const conhecidas = _deslMapaBaseLojasConhecidas()[base] || [];
  return conhecidas.length === 1 ? conhecidas[0] : chave;
}

function _deslNormPontoDist(nome, rota) {
  const s = String(nome || "").trim();
  if (!s) return "";
  const semAcento = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  if (semAcento === "FABRICA" || semAcento === "FÁBRICA") return "FABRICA";
  return _deslNormLoja(s, rota);
}

function _deslDistanciasIndex() {
  if (_deslDistIndex) return _deslDistIndex;
  _deslDistIndex = {};
  const dados = Array.isArray(window.DESL_DISTANCIAS_KM) ? window.DESL_DISTANCIAS_KM : [];
  dados.forEach((d) => {
    const origem = _deslNormPontoDist(d.origem);
    const destino = _deslNormPontoDist(d.destino);
    if (!origem || !destino) return;
    const key = `${origem}|${destino}`;
    if (!_deslDistIndex[key]) _deslDistIndex[key] = d;
  });
  return _deslDistIndex;
}

function _deslBuscarDistancia(origem, destino, rota) {
  const o = _deslNormPontoDist(origem, rota);
  const d = _deslNormPontoDist(destino, rota);
  if (!o || !d) return null;
  return _deslDistanciasIndex()[`${o}|${d}`] || null;
}

function _deslHojeMenos(dias) {
  const d = new Date();
  d.setDate(d.getDate() - dias);
  return d.toISOString().split("T")[0];
}

// ── CSS (injetado uma vez) ───────────────────────────────────────
function _deslGarantirEstilos() {
  if (document.getElementById("deslEstilos")) return;
  const st = document.createElement("style");
  st.id = "deslEstilos";
  st.textContent = `
    .desl-lista { display:grid; gap:12px; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); }
    .desl-card { background:var(--bg-base); border:1px solid var(--border); border-radius:12px; padding:14px 16px; }
    .desl-card h3 { margin:0 0 4px; font-size:15px; color:var(--text-heading,#f0f6ff); }
    .desl-card .desl-card-meta { font-size:12px; color:var(--text-muted); margin-bottom:10px; }
    .desl-card .desl-card-chips { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:12px; }
    .desl-chip { background:var(--azul-light,rgba(56,189,248,.1)); color:var(--azul,#38bdf8);
      border-radius:999px; padding:3px 10px; font-size:11px; font-weight:700; }
    .desl-card-acoes { display:flex; gap:8px; }
    .desl-vazio { color:var(--text-muted); padding:24px 4px; text-align:center; }

    .desl-form-grid { display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); margin-bottom:16px; }
    .desl-form-grid .desl-full { grid-column:1/-1; }
    .desl-form-grid label { display:block; font-size:11px; font-weight:700; color:var(--text-secondary); margin-bottom:4px; }

    .desl-tabela-wrap { overflow-x:auto; border:1px solid var(--border); border-radius:10px; }
    .desl-tabela { width:100%; border-collapse:collapse; font-size:12.5px; min-width:760px; }
    .desl-tabela th { background:var(--bg-overlay,#1e293b); color:var(--text-secondary); font-size:10px;
      text-transform:uppercase; letter-spacing:.5px; padding:9px 8px; text-align:left; white-space:nowrap;
      border-bottom:1px solid var(--border-md); }
    .desl-tabela td { padding:5px 8px; border-bottom:1px solid var(--border); vertical-align:middle; }
    .desl-tabela tbody tr:hover { background:var(--azul-light,rgba(56,189,248,.06)); }
    .desl-tabela input { width:100%; min-width:64px; }
    .desl-tabela .desl-km { max-width:84px; }
    .desl-tabela .desl-ordem { font-weight:700; color:var(--text-muted); text-align:center; width:34px; }
    .desl-cel-desloc, .desl-cel-descarga { font-weight:700; font-variant-numeric:tabular-nums; white-space:nowrap; }
    .desl-cel-desloc { color:var(--azul,#38bdf8); }
    .desl-cel-descarga { color:var(--roxo,#a78bfa); }
    .desl-rm { background:transparent; border:1px solid var(--border); color:var(--vermelho,#f87171);
      border-radius:8px; cursor:pointer; padding:3px 8px; font-weight:700; }
    .desl-rm:hover { border-color:var(--vermelho,#f87171); }
    .desl-fabrica-row td { background:var(--verde-light,rgba(52,211,153,.08)); font-weight:700; color:var(--verde,#34d399); }

    .desl-add { margin:12px 0; }
    .desl-totais { display:flex; gap:10px; flex-wrap:wrap; margin:14px 0; }
    .desl-tot { background:var(--bg-base); border:1px solid var(--border); border-radius:10px; padding:10px 14px; min-width:130px; }
    .desl-tot span { display:block; font-size:11px; color:var(--text-muted); }
    .desl-tot strong { font-size:18px; color:var(--text-heading,#f0f6ff); font-variant-numeric:tabular-nums; }
    .desl-acoes { display:flex; gap:10px; align-items:center; margin-top:6px; }
    .desl-origem { margin:0 0 12px; border:1px solid var(--border); border-radius:10px; padding:10px 12px;
      background:var(--azul-light,rgba(56,189,248,.08)); color:var(--text-secondary); font-size:12px; line-height:1.45; }
    .desl-origem strong { color:var(--text-heading,#f0f6ff); }
    .desl-origem small { color:var(--text-muted); }

    .desl-comp { margin-top:22px; border-top:1px solid var(--border-md); padding-top:18px; }
    .desl-comp h3 { margin:0 0 12px; font-size:15px; color:var(--text-heading,#f0f6ff); }
    .desl-comp-filtros { display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end; margin-bottom:14px; }
    .desl-comp-filtros label { display:block; font-size:11px; font-weight:700; color:var(--text-secondary); margin-bottom:4px; }
    .desl-comp-dias { border:1px solid var(--border); border-radius:10px; background:var(--bg-base); padding:10px 12px; margin:0 0 14px; }
    .desl-comp-dias-topo { display:flex; gap:10px; justify-content:space-between; align-items:center; flex-wrap:wrap; margin-bottom:8px; color:var(--text-secondary); font-size:12px; }
    .desl-comp-dias-acoes { display:flex; gap:6px; flex-wrap:wrap; }
    .desl-comp-dias-lista { display:flex; gap:8px; flex-wrap:wrap; max-height:142px; overflow:auto; padding-right:4px; }
    .desl-dia-item { display:flex; align-items:center; gap:7px; border:1px solid var(--border); border-radius:999px; padding:5px 9px; color:var(--text-primary,#e5edf7); font-size:12px; cursor:pointer; background:var(--bg-elevated,#141e2e); }
    .desl-dia-item:has(.desl-dia-chk:checked) { border-color:var(--azul,#38bdf8); background:var(--azul-light,rgba(56,189,248,.1)); }
    .desl-dia-chk { width:16px; min-width:16px; height:16px; min-height:16px; margin:0; padding:0; cursor:pointer; }
    .desl-cmp-cols { display:grid; gap:12px; grid-template-columns:repeat(2,minmax(0,1fr)); align-items:start; }
    .desl-cmp-col h4 { margin:0 0 8px; color:var(--text-heading,#f0f6ff); font-size:13px; }
    @media (max-width: 900px) { .desl-cmp-cols { grid-template-columns:1fr; } }
    .desl-detalhe-viagens { margin:10px 0 14px; }
    .desl-detalhe-viagens h4 { margin:0 0 8px; color:var(--text-heading,#f0f6ff); font-size:13px; }
    .desl-detalhe-viagens .desl-tabela { min-width:980px; }
    .desl-delta-pos { color:var(--vermelho,#f87171); font-weight:700; }
    .desl-delta-neg { color:var(--verde,#34d399); font-weight:700; }
    .desl-delta-zero { color:var(--text-muted); font-weight:700; }
    .desl-comp-resumo { color:var(--text-secondary); font-size:12.5px; margin-bottom:10px; }

    .desl-imp-overlay { position:fixed; inset:0; background:rgba(0,0,0,.62); z-index:10000; display:none;
      align-items:flex-start; justify-content:center; padding:36px 14px; overflow:auto; }
    .desl-imp-box { background:var(--bg-elevated,#141e2e); border:1px solid var(--border-md); border-radius:14px;
      width:100%; max-width:640px; box-shadow:0 25px 60px rgba(0,0,0,.45); overflow:hidden; }
    .desl-imp-topo { display:flex; justify-content:space-between; align-items:flex-start; gap:12px;
      padding:16px 18px; border-bottom:1px solid var(--border); }
    .desl-imp-titulo { font-size:16px; font-weight:800; color:var(--text-heading,#f0f6ff); }
    .desl-imp-sub { font-size:12px; color:var(--text-muted); }
    .desl-imp-lista { max-height:60vh; overflow:auto; padding:8px 18px; }
    .desl-imp-item { border:1px solid var(--border); border-radius:10px; padding:10px 12px; margin:8px 0; background:var(--bg-base); transition:border-color .12s, background .12s; }
    .desl-imp-item:has(.desl-imp-chk:checked) { border-color:var(--verde,#34d399); background:var(--verde-light,rgba(52,211,153,.08)); }
    .desl-imp-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; cursor:pointer; font-size:14px; color:var(--text-primary,#e5edf7); }
    /* checkbox custom — o input global é appearance:none/46px, então desenhamos o X */
    .desl-imp-chk {
      appearance:none; -webkit-appearance:none;
      width:24px; min-width:24px; height:24px; min-height:24px; padding:0; margin:0; flex:0 0 auto;
      border:2px solid var(--text-muted,#4d6480); border-radius:6px; background:var(--bg-base);
      cursor:pointer; display:inline-grid; place-content:center; box-sizing:border-box;
    }
    .desl-imp-chk:hover { border-color:var(--azul,#38bdf8); }
    .desl-imp-chk:checked { background:var(--verde,#34d399); border-color:var(--verde,#34d399); }
    .desl-imp-chk:checked::after { content:"✕"; color:#06281d; font-size:15px; font-weight:900; line-height:1; }
    .desl-imp-tag { background:var(--azul-light,rgba(56,189,248,.1)); color:var(--azul,#38bdf8);
      border-radius:999px; padding:2px 9px; font-size:11px; font-weight:700; }
    .desl-imp-tag-aviso { background:rgba(251,191,36,.14); color:var(--amarelo,#fbbf24); }
    .desl-imp-det { margin-top:8px; }
    .desl-imp-det summary { cursor:pointer; font-size:12px; color:var(--text-secondary); }
    .desl-imp-rodape { display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;
      padding:14px 18px; border-top:1px solid var(--border); }
  `;
  document.head.appendChild(st);
}

// ── carregamento / lista ─────────────────────────────────────────
async function deslocamentoInit() {
  _deslGarantirEstilos();
  await Promise.all([deslCarregarLista(), deslCarregarRegistros()]);
}

// Registros de saída/retorno (aba Veículos) — para o link "Por dia".
async function deslCarregarRegistros() {
  try {
    const r = await fetch(`${API_URL}/rotas-registradas`);
    _deslRegistros = r.ok ? await r.json() : [];
  } catch (err) {
    console.warn("[deslCarregarRegistros]", err);
    _deslRegistros = [];
  }
}

function _deslCanonRota(s) {
  return typeof canonizarRota === "function"
    ? canonizarRota(s)
    : String(s || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase()
        .replace(/\bIII\b/g, "3")
        .replace(/\bII\b/g, "2")
        .replace(/\bI\b/g, "1")
        .replace(/\s+/g, " ")
        .trim();
}

function _deslPartesRota(s) {
  const raw = String(s || "")
    .split(/\s*\+\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!raw.length) return [];

  let prefixo = "";
  return raw
    .map((parte) => {
      const semAcento = parte
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase()
        .trim();
      if (/^BAIXADA\b/.test(semAcento)) prefixo = "BAIXADA";
      if (/^(?:Z\.?\s*NORTE|ZONA NORTE|NORTE)\b/.test(semAcento)) prefixo = "ZONA NORTE";
      if (/^(?:Z\.?\s*OESTE|ZONA OESTE)\b/.test(semAcento)) prefixo = "ZONA OESTE";
      if (prefixo && /^(?:IV|III|II|I|\d)$/.test(semAcento)) return _deslCanonRota(`${prefixo} ${parte}`);
      return _deslCanonRota(parte);
    })
    .map((p) => p.trim())
    .filter(Boolean);
}

function _deslRotaCasa(origem, alvo) {
  if (!alvo) return true;
  const origemCanon = _deslCanonRota(origem);
  const alvoCanon = _deslCanonRota(alvo);
  if (origemCanon === alvoCanon) return true;

  const origemPartes = _deslPartesRota(origem);
  const alvoPartes = _deslPartesRota(alvo);
  if (!origemPartes.length || !alvoPartes.length) return false;
  return alvoPartes.every((p) => origemPartes.includes(p));
}

// registros de rotas_registradas que casam com (rotaReal canônica) + data
function _deslRegistrosDoDia(rotaReal, dataISO) {
  return (_deslRegistros || []).filter((r) => {
    const d = String(r.data || "").split("T")[0];
    if (d !== dataISO) return false;
    return _deslRotaCasa(r.rota_feita || r.rotaFeita, rotaReal);
  });
}

async function deslCarregarLista() {
  const alvo = document.getElementById("deslListaRoteiros");
  if (!alvo) return;
  alvo.innerHTML = `<div class="desl-vazio">Carregando roteiros…</div>`;
  try {
    const r = await fetch(`${API_URL}/roteiros`);
    _deslRoteiros = r.ok ? await r.json() : [];
  } catch (err) {
    console.error("[deslCarregarLista]", err);
    _deslRoteiros = [];
  }
  deslRenderLista();
}

function deslRenderLista() {
  const alvo = document.getElementById("deslListaRoteiros");
  if (!alvo) return;
  if (!_deslRoteiros.length) {
    alvo.innerHTML = `<div class="desl-vazio">Nenhum roteiro cadastrado ainda.<br>Clique em <strong>“+ Novo roteiro”</strong> para montar o primeiro (igual à planilha).</div>`;
    return;
  }
  alvo.innerHTML = _deslRoteiros
    .map((rt) => {
      const dia = rt.dia_semana ? `<div class="desl-card-meta">${_deslEsc(rt.dia_semana)}</div>` : "";
      const saida = rt.hora_saida_fabrica ? String(rt.hora_saida_fabrica).slice(0, 5) : "—";
      return `
        <div class="desl-card">
          <h3>${_deslEsc(rt.rota_nome)}</h3>
          ${dia}
          <div class="desl-card-chips">
            <span class="desl-chip">${rt.qtd_paradas || 0} lojas</span>
            <span class="desl-chip">${_deslKm(rt.total_km)}</span>
            <span class="desl-chip">Saída fábrica ${saida}</span>
          </div>
          <div class="desl-card-acoes">
            <button class="btn-blue btn-sm" onclick="deslEditarRoteiro(${rt.id})">Abrir</button>
            <button class="btn-ghost btn-sm" onclick="deslExcluirRoteiro(${rt.id})">Excluir</button>
          </div>
        </div>`;
    })
    .join("");
}

// ── editor ───────────────────────────────────────────────────────
function deslNovoRoteiro() {
  _deslAtual = { rota_nome: "", dia_semana: "", hora_saida_fabrica: "", descricao: "", paradas: [] };
  deslRenderEditor();
}

async function deslEditarRoteiro(id) {
  try {
    const r = await fetch(`${API_URL}/roteiros/${id}`);
    if (!r.ok) throw new Error("Falha ao abrir roteiro.");
    _deslAtual = await r.json();
  } catch (err) {
    alertar("Não consegui abrir o roteiro. " + err.message);
    return;
  }
  deslRenderEditor();
}

function deslFecharEditor() {
  const wrap = document.getElementById("deslEditorWrap");
  if (wrap) {
    wrap.classList.add("hidden");
    wrap.innerHTML = "";
  }
  _deslAtual = null;
}

function _deslOrigemHorariosHtml(r) {
  const desc = String(r?.descricao || "").trim();
  const m = desc.match(/dias:\s*(.+)$/i);
  const obsDatas = [];
  (r?.paradas || []).forEach((p) => {
    const obs = String(p?.observacao || "").trim();
    const mo = obs.match(/(?:datas?|base):\s*(.+)$/i);
    if (mo) obsDatas.push(mo[1]);
  });

  const origem = m ? m[1].trim() : [...new Set(obsDatas)].filter(Boolean).join(" · ");
  if (!origem) return "";

  const resumo = desc && /^Tempos medianos/i.test(desc) ? desc.replace(/\s+—\s+dias:\s*.+$/i, "") : "Horários importados do histórico";
  return `
    <div class="desl-origem">
      <strong>Origem dos horários:</strong> ${_deslEsc(resumo)}.
      <br><small>Datas usadas: ${_deslEsc(origem)}</small>
    </div>`;
}

function deslRenderEditor() {
  _deslGarantirEstilos();
  const wrap = document.getElementById("deslEditorWrap");
  if (!wrap || !_deslAtual) return;
  const r = _deslAtual;
  const ehNovo = !r.id;
  const origemHtml = _deslOrigemHorariosHtml(r);

  wrap.innerHTML = `
    <div class="section-head">
      <div>
        <h2 id="deslEditorTitulo">${ehNovo ? "Novo roteiro" : "Editar roteiro"}</h2>
        <p class="tms-subtitle">Informe a saída da fábrica e os horários de cada loja. O deslocamento e a descarga são calculados sozinhos.</p>
      </div>
      <button type="button" class="btn-ghost btn-sm" onclick="deslFecharEditor()">Fechar</button>
    </div>

    <div class="desl-form-grid">
      <div>
        <label>Rota *</label>
        <select id="deslRota" data-sem-pesquisa onchange="deslRotaSelecaoMudou()">${_deslOpcoesRota(r.rota_nome)}</select>
        <input id="deslRotaOutra" placeholder="Digite o nome da nova rota" style="margin-top:6px;display:none;" />
      </div>
      <div><label>Dia(s) da semana</label><input id="deslDia" placeholder="Ex.: Quarta e Sexta" value="${_deslEsc(r.dia_semana)}" /></div>
      <div><label>Saída da fábrica</label><input id="deslHoraFabrica" type="time" value="${_deslEsc((r.hora_saida_fabrica || "").slice(0, 5))}" oninput="deslRecalcular()" /></div>
      <div class="desl-full"><label>Descrição (opcional)</label><input id="deslDescricao" value="${_deslEsc(r.descricao)}" /></div>
      <datalist id="deslLojasConhecidas"></datalist>
    </div>

    ${origemHtml}

    <div class="desl-tabela-wrap">
      <table data-ordenavel class="desl-tabela">
        <thead>
          <tr>
            <th>#</th><th>Loja</th><th>Km</th><th>Chegada</th><th>Saída</th>
            <th title="Tempo do ponto anterior (ou fábrica) até aqui">Deslocamento</th>
            <th title="Tempo parado na loja (saída − chegada)">Descarga</th>
            <th title="Marque quando esta parada acontece no dia seguinte">D+1</th>
            <th>Obs</th><th></th>
          </tr>
        </thead>
        <tbody id="deslParadasBody"></tbody>
      </table>
    </div>
    <div class="desl-add"><button type="button" class="btn-ghost btn-sm" onclick="deslAddParada()">+ Adicionar loja</button></div>

    <div id="deslTotais" class="desl-totais"></div>

    <div class="desl-acoes">
      <button type="button" class="btn-green" onclick="deslSalvar()">💾 Salvar roteiro</button>
      <button type="button" id="deslBtnExcluir" class="btn-ghost btn-sm" onclick="deslExcluirAtual()" style="${ehNovo ? "display:none;" : ""}">🗑️ Excluir</button>
    </div>

    <div class="desl-comp">
      <h3>Comparar com o tempo real das entregas</h3>
      <div class="desl-comp-filtros">
        <div><label>De (opcional)</label><input id="deslCompIni" type="date" value="" onchange="deslAtualizarDiasComparativo()" /></div>
        <div><label>Até (opcional)</label><input id="deslCompFim" type="date" value="" onchange="deslAtualizarDiasComparativo()" /></div>
        <div><label>Rota nas entregas</label><select id="deslCompRota" style="min-width:200px;" onchange="deslAtualizarDiasComparativo()"></select></div>
        <button type="button" class="btn-ghost btn-sm" onclick="deslAtualizarDiasComparativo()">Mostrar dias</button>
        <button type="button" class="btn-green btn-sm" onclick="deslUsarDiaSelecionadoNoRoteiro()">Usar dias no roteiro</button>
        <button type="button" class="btn-blue btn-sm" onclick="deslComparar()">Média selecionada</button>
        <button type="button" class="btn-ghost btn-sm" onclick="deslCompararPorDia()">📅 Por dia</button>
      </div>
      <div id="deslCompDias" class="desl-comp-dias"></div>
      <div id="deslCompResultado"></div>
    </div>
  `;

  wrap.classList.remove("hidden");
  deslPreencherDatalists();
  deslPreencherRotasReais(r.rota_nome);
  deslAtualizarDiasComparativo();

  // popular linhas (pelo menos uma)
  const paradas = Array.isArray(r.paradas) && r.paradas.length ? r.paradas : [null];
  paradas.forEach((p) => deslAddParada(p, true));
  deslRecalcular();

  wrap.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Rotas que o sistema já conhece, para o select de Rota (sem digitação).
function _deslRotasDisponiveis(atual) {
  const set = new Set();
  const add = (v) => {
    const s = String(v == null ? "" : v).trim();
    if (s && !/^externa$/i.test(s)) set.add(s);
  };
  // rotas reais das entregas (canônicas) + registros importados + roteiros salvos
  (Array.isArray(ocorrencias) ? ocorrencias : []).forEach((o) =>
    add(typeof obterRotaDaOcorrencia === "function" ? obterRotaDaOcorrencia(o) : o.rota),
  );
  (_deslRegistros || []).forEach((r) => add(_deslCanonRota(r.rota_feita || r.rotaFeita)));
  (_deslRoteiros || []).forEach((r) => add(r.rota_nome));
  add(atual);
  return [...set].sort((a, b) => a.localeCompare(b, "pt-BR"));
}

// <option>s do select de Rota (com a atual selecionada + escape "Outra").
function _deslOpcoesRota(atual) {
  const opts = _deslRotasDisponiveis(atual)
    .map((r) => `<option value="${_deslEsc(r)}" ${r === atual ? "selected" : ""}>${_deslEsc(r)}</option>`)
    .join("");
  return `<option value="">Selecione a rota…</option>${opts}<option value="__outra__">Outra (digitar)…</option>`;
}

// Mostra/esconde o campo de digitação quando escolhe "Outra".
function deslRotaSelecaoMudou() {
  const sel = document.getElementById("deslRota");
  const outra = document.getElementById("deslRotaOutra");
  if (!sel || !outra) return;
  const mostrar = sel.value === "__outra__";
  outra.style.display = mostrar ? "" : "none";
  if (mostrar) outra.focus();
}

function deslPreencherDatalists() {
  // lojas conhecidas (mapa lojasRotas + ocorrências)
  const lojas = new Set();
  if (typeof lojasRotas === "object" && lojasRotas) {
    Object.keys(lojasRotas).forEach((k) => lojas.add(_deslNomeLoja(k)));
  }
  (Array.isArray(ocorrencias) ? ocorrencias : []).forEach((o) => {
    if (o && o.loja) lojas.add(_deslNomeLoja(o.loja));
  });
  const dlLojas = document.getElementById("deslLojasConhecidas");
  if (dlLojas)
    dlLojas.innerHTML = [...lojas].filter(Boolean).sort().map((n) => `<option value="${_deslEsc(n)}">`).join("");
}

// Nome de exibição JÁ POLIDO (canônico): mostra sempre a mesma grafia para a
// loja, mesmo que no banco esteja "CAXIAS I" num dia e "CAXIAS 1" noutro.
function _deslNomeLoja(loja) {
  if (typeof canonizarLoja === "function") return canonizarLoja(loja) || "";
  return typeof formatarNomeLoja === "function" ? formatarNomeLoja(loja) : String(loja || "");
}

function deslPreencherRotasReais(preferida) {
  const sel = document.getElementById("deslCompRota");
  if (!sel) return;
  const base = Array.isArray(ocorrencias) ? ocorrencias : [];
  const contagem = {};
  base.forEach((o) => {
    const r = typeof obterRotaDaOcorrencia === "function" ? obterRotaDaOcorrencia(o) : o.rota;
    if (r) contagem[r] = (contagem[r] || 0) + 1;
  });
  const rotas = Object.keys(contagem).sort();
  if (!rotas.length) {
    sel.innerHTML = `<option value="">(sem entregas registradas)</option>`;
    return;
  }
  // tenta adivinhar a melhor rota real pela sobreposição de lojas planejadas
  const lojasPlanejadas = new Set(
    (_deslAtual?.paradas || []).map((p) => _deslNormLoja(p.loja_nome || p.loja, preferida)),
  );
  let melhor = "";
  let melhorScore = -1;
  rotas.forEach((r) => {
    let score = 0;
    base.forEach((o) => {
      const ro = typeof obterRotaDaOcorrencia === "function" ? obterRotaDaOcorrencia(o) : o.rota;
      if (_deslRotaCasa(ro, r) && lojasPlanejadas.has(_deslNormLoja(o.loja, r))) score += 1;
    });
    if (score > melhorScore) {
      melhorScore = score;
      melhor = r;
    }
  });
  const escolhida = melhorScore > 0 ? melhor : "";
  sel.innerHTML = rotas
    .map((r) => `<option value="${_deslEsc(r)}" ${r === escolhida ? "selected" : ""}>${_deslEsc(r)}</option>`)
    .join("");
}

function deslAddParada(dados, semRecalc) {
  const tbody = document.getElementById("deslParadasBody");
  if (!tbody) return;
  const d = dados || {};
  const obs = String(d.observacao || "");
  const diaSeguinte = /\bD\+1\b/i.test(obs);
  const obsLimpa = obs.replace(/\s*\[?D\+1\]?\s*/gi, " ").replace(/\s+/g, " ").trim();
  const tr = document.createElement("tr");
  tr.className = "desl-parada";
  tr.innerHTML = `
    <td class="desl-ordem"></td>
    <td><input class="desl-loja" list="deslLojasConhecidas" value="${_deslEsc(d.loja_nome || d.loja || "")}" placeholder="Nome da loja" oninput="deslRecalcular()" /></td>
    <td><input class="desl-km" type="number" step="0.1" min="0" value="${d.km != null && d.km !== "" ? _deslEsc(d.km) : ""}" oninput="this.dataset.autoKm='0';deslRecalcular()" /></td>
    <td><input class="desl-chegada" type="time" value="${_deslEsc((d.hora_chegada || "").slice ? (d.hora_chegada || "").slice(0, 5) : "")}" oninput="deslRecalcular()" /></td>
    <td><input class="desl-saida" type="time" value="${_deslEsc((d.hora_saida || "").slice ? (d.hora_saida || "").slice(0, 5) : "")}" oninput="deslRecalcular()" /></td>
    <td class="desl-cel-desloc">—</td>
    <td class="desl-cel-descarga">—</td>
    <td style="text-align:center;"><input class="desl-d1" type="checkbox" ${diaSeguinte ? "checked" : ""} onchange="deslRecalcular()" title="Parada no dia seguinte" /></td>
    <td><input class="desl-obs" value="${_deslEsc(obsLimpa)}" placeholder="—" /></td>
    <td><button type="button" class="desl-rm" onclick="deslRemoverParada(this)" title="Remover loja">✕</button></td>
  `;
  tbody.appendChild(tr);
  if (!semRecalc) deslRecalcular();
}

function deslRemoverParada(btn) {
  const tr = btn.closest("tr");
  if (tr) tr.remove();
  deslRecalcular();
}

// Lê os campos do editor e calcula deslocamento/descarga por linha + totais.
function deslCalcularPlanejado() {
  const fabrica = document.getElementById("deslHoraFabrica")?.value || "";
  const rotaCtx = document.getElementById("deslRota")?.value || _deslAtual?.rota_nome || "";
  const linhas = [];
  let prevSaida = fabrica;
  let prevDiaOffset = 0;
  let prevPonto = "FÁBRICA";
  let totalKm = 0, totalDesloc = 0, totalDescarga = 0, ultimaSaida = "", ultimaSaidaOffset = 0;

  document.querySelectorAll("#deslParadasBody tr.desl-parada").forEach((tr, i) => {
    const loja = tr.querySelector(".desl-loja")?.value || "";
    const kmInput = tr.querySelector(".desl-km");
    let kmRaw = kmInput?.value || "";
    const chegada = tr.querySelector(".desl-chegada")?.value || "";
    const saida = tr.querySelector(".desl-saida")?.value || "";
    const diaSeguinte = !!tr.querySelector(".desl-d1")?.checked;
    const diaOffset = diaSeguinte ? 1 : 0;
    const obs = tr.querySelector(".desl-obs")?.value || "";

    const dist = loja ? _deslBuscarDistancia(prevPonto, loja, rotaCtx) : null;
    const podeAutoKm = kmInput && (!String(kmRaw).trim() || kmInput.dataset.autoKm === "1");
    if (podeAutoKm && dist?.km != null) {
      kmRaw = _deslKmValor(dist.km);
      kmInput.value = kmRaw.replace(",", ".");
      kmInput.dataset.autoKm = "1";
      kmInput.title = `${dist.origem} → ${dist.destino} | ${_deslKm(dist.km)}${dist.custo != null ? ` | custo ${Number(dist.custo).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}` : ""}`;
    } else if (kmInput && dist?.km != null && !kmInput.title) {
      kmInput.title = `${dist.origem} → ${dist.destino} | ${_deslKm(dist.km)}${dist.custo != null ? ` | custo ${Number(dist.custo).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}` : ""}`;
    }

    const prevAbs = _deslMin(prevSaida) != null ? _deslMin(prevSaida) + prevDiaOffset * 1440 : null;
    const chegadaAbs = _deslMin(chegada) != null ? _deslMin(chegada) + diaOffset * 1440 : null;
    let saidaOffset = diaOffset;
    const saidaMinTmp = _deslMin(saida);
    if (saidaMinTmp != null && chegadaAbs != null && saidaMinTmp + saidaOffset * 1440 < chegadaAbs) saidaOffset += 1;
    const saidaAbs = saidaMinTmp != null ? saidaMinTmp + saidaOffset * 1440 : null;
    const desloc = prevAbs != null && chegadaAbs != null ? chegadaAbs - prevAbs : null;
    const descarga = chegadaAbs != null && saidaAbs != null ? saidaAbs - chegadaAbs : null;
    const km = parseFloat(String(kmRaw).replace(",", "."));

    // Validações de ordem (mesmo dia): a chegada de uma loja não pode ser ANTES
    // da saída da loja anterior, e a saída não pode ser antes da própria chegada.
    const chegadaForaDeOrdem = prevAbs != null && chegadaAbs != null && chegadaAbs < prevAbs;
    const descargaInvalida = chegadaAbs != null && saidaAbs != null && saidaAbs < chegadaAbs;

    if (isFinite(km)) totalKm += km;
    if (desloc != null) totalDesloc += desloc;
    if (descarga != null) totalDescarga += descarga;
    if (saida) {
      ultimaSaida = saida;
      ultimaSaidaOffset = saidaOffset;
    }

    linhas.push({
      ordem: i + 1, loja_nome: loja, km: isFinite(km) ? km : null,
      hora_chegada: chegada, hora_saida: saida, observacao: obs, desloc, descarga,
      chegadaForaDeOrdem, descargaInvalida, refAnterior: prevSaida, diaSeguinte, saidaOffset,
    });
    prevSaida = saida || chegada || prevSaida;
    prevDiaOffset = saida ? saidaOffset : diaOffset;
    prevPonto = loja || prevPonto;
  });

  const fabMin = _deslMin(fabrica);
  const ultMin = _deslMin(ultimaSaida);
  const jornada = fabMin != null && ultMin != null ? ultMin + ultimaSaidaOffset * 1440 - fabMin : null;
  return { fabrica, linhas, totais: { km: totalKm, desloc: totalDesloc, descarga: totalDescarga, jornada } };
}

// Realça (vermelho) um input de horário fora de ordem e explica no title.
function _deslMarcarErroInput(input, msg) {
  if (!input) return;
  input.style.borderColor = "var(--vermelho,#f87171)";
  input.style.boxShadow = "0 0 0 1px var(--vermelho,#f87171)";
  input.title = msg || "";
}
function _deslLimparErroInput(input) {
  if (!input) return;
  input.style.borderColor = "";
  input.style.boxShadow = "";
  input.title = "";
}

function deslRecalcular() {
  const { linhas, totais } = deslCalcularPlanejado();
  const rows = document.querySelectorAll("#deslParadasBody tr.desl-parada");
  rows.forEach((tr, i) => {
    const l = linhas[i];
    tr.querySelector(".desl-ordem").textContent = `${i + 1}ª`;

    const inpCheg = tr.querySelector(".desl-chegada");
    const inpSaida = tr.querySelector(".desl-saida");
    const celDesloc = tr.querySelector(".desl-cel-desloc");
    const celDescarga = tr.querySelector(".desl-cel-descarga");

    // Chegada antes da saída da loja anterior → marca em vermelho e avisa.
    if (l.chegadaForaDeOrdem) {
      _deslMarcarErroInput(inpCheg, `A chegada (${l.hora_chegada}) não pode ser menor que a saída da loja anterior (${l.refAnterior}).`);
      celDesloc.innerHTML = `<span style="color:var(--vermelho,#f87171);font-weight:800;cursor:help;"
        title="Chegada ${_deslEsc(l.hora_chegada)} é antes da saída anterior ${_deslEsc(l.refAnterior)}">⚠ ordem</span>`;
    } else {
      _deslLimparErroInput(inpCheg);
      celDesloc.innerHTML = `${_deslDur(l.desloc)}${l.diaSeguinte ? ` <small style="color:var(--text-muted)">+1d</small>` : ""}`;
    }

    // Saída antes da própria chegada → marca em vermelho.
    if (l.descargaInvalida) {
      _deslMarcarErroInput(inpSaida, `A saída (${l.hora_saida}) não pode ser menor que a chegada (${l.hora_chegada}).`);
      celDescarga.innerHTML = `<span style="color:var(--vermelho,#f87171);font-weight:800;cursor:help;"
        title="Saída ${_deslEsc(l.hora_saida)} é antes da chegada ${_deslEsc(l.hora_chegada)}">⚠</span>`;
    } else {
      _deslLimparErroInput(inpSaida);
      celDescarga.innerHTML = `${_deslDur(l.descarga)}${l.saidaOffset > (l.diaSeguinte ? 1 : 0) ? ` <small style="color:var(--text-muted)">+1d</small>` : ""}`;
    }
  });
  const tot = document.getElementById("deslTotais");
  if (tot) {
    tot.innerHTML = `
      <div class="desl-tot"><span>Total Km</span><strong>${totais.km ? totais.km.toLocaleString("pt-BR", { maximumFractionDigits: 1 }) : "—"}</strong></div>
      <div class="desl-tot"><span>Deslocamento total</span><strong>${_deslDur(totais.desloc)}</strong></div>
      <div class="desl-tot"><span>Descarga total</span><strong>${_deslDur(totais.descarga)}</strong></div>
      <div class="desl-tot"><span>Jornada (fábrica → última saída)</span><strong>${_deslDur(totais.jornada)}</strong></div>`;
  }
}

// ── salvar / excluir ─────────────────────────────────────────────
function deslColetarForm() {
  const { linhas } = deslCalcularPlanejado();
  let rotaNome = document.getElementById("deslRota")?.value || "";
  if (rotaNome === "__outra__") rotaNome = document.getElementById("deslRotaOutra")?.value || "";
  return {
    rota_nome: rotaNome.trim(),
    dia_semana: (document.getElementById("deslDia")?.value || "").trim(),
    hora_saida_fabrica: document.getElementById("deslHoraFabrica")?.value || "",
    descricao: (document.getElementById("deslDescricao")?.value || "").trim(),
    ativo: true,
    paradas: linhas
      .filter((l) => (l.loja_nome || "").trim())
      .map((l) => ({
        loja_nome: l.loja_nome.trim(),
        km: l.km,
        hora_chegada: l.hora_chegada || null,
        hora_saida: l.hora_saida || null,
        observacao: `${l.diaSeguinte ? "[D+1] " : ""}${(l.observacao || "").trim()}`.trim() || null,
      })),
  };
}

async function deslSalvar() {
  const dados = deslColetarForm();
  if (!dados.rota_nome) {
    alertar("Informe o nome da rota.");
    return;
  }
  if (!dados.paradas.length) {
    alertar("Adicione ao menos uma loja ao roteiro.");
    return;
  }
  // Bloqueia horários fora de ordem (chegada antes da saída anterior, ou saída
  // antes da própria chegada) — os mesmos já realçados em vermelho na tabela.
  const problemas = deslCalcularPlanejado()
    .linhas.filter((l) => (l.loja_nome || "").trim() && (l.chegadaForaDeOrdem || l.descargaInvalida));
  if (problemas.length) {
    const lista = problemas
      .map((l) =>
        l.chegadaForaDeOrdem
          ? `• ${l.ordem}ª ${l.loja_nome || "(sem nome)"}: chegada ${l.hora_chegada} é antes da saída anterior (${l.refAnterior}).`
          : `• ${l.ordem}ª ${l.loja_nome || "(sem nome)"}: saída ${l.hora_saida} é antes da chegada ${l.hora_chegada}.`,
      )
      .join("\n");
    alertar(`Corrija os horários fora de ordem antes de salvar:\n\n${lista}`);
    return;
  }
  const id = _deslAtual?.id;
  try {
    const r = await fetch(`${API_URL}/roteiros${id ? "/" + id : ""}`, {
      method: id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dados),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || "Erro ao salvar.");
    }
    _deslAtual = await r.json();
    await deslCarregarLista();
    deslPreencherRotasReais(_deslAtual.rota_nome);
    const btn = document.getElementById("deslBtnExcluir");
    const tit = document.getElementById("deslEditorTitulo");
    if (btn) btn.style.display = "";
    if (tit) tit.textContent = "Editar roteiro";
    alertar("Roteiro salvo com sucesso.");
  } catch (err) {
    alertar("Não consegui salvar. " + err.message);
  }
}

function deslExcluirAtual() {
  if (_deslAtual?.id) deslExcluirRoteiro(_deslAtual.id, true);
}

function deslExcluirRoteiro(id, fecharApos) {
  confirmarSimples("Excluir este roteiro? Esta ação não pode ser desfeita.", async () => {
    try {
      const r = await fetch(`${API_URL}/roteiros/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error("Falha ao excluir.");
      if (fecharApos) deslFecharEditor();
      await deslCarregarLista();
    } catch (err) {
      alertar("Não consegui excluir. " + err.message);
    }
  });
}

// ── comparativo PLANEJADO × REAL ─────────────────────────────────
function _deslDataOcorrencia(o) {
  return String(o?.data_ocorrencia || o?.data || "").split("T")[0];
}

function _deslRotaOcorrencia(o) {
  return typeof obterRotaDaOcorrencia === "function" ? obterRotaDaOcorrencia(o) : o?.rota;
}

function _deslOcorrenciaBateRota(o, rotaReal) {
  const r = _deslRotaOcorrencia(o);
  return _deslRotaCasa(r, rotaReal);
}

function _deslNomeMotoristaOcorrencia(o) {
  return (
    o?.motorista ||
    o?.nome_motorista ||
    o?.motorista_nome ||
    o?.nomeMotorista ||
    o?.driver ||
    ""
  );
}

function _deslDiasSelecionadosComparativo() {
  const checks = [...document.querySelectorAll("#deslCompDias .desl-dia-chk")];
  if (!checks.length) return null;
  return checks.filter((c) => c.checked).map((c) => c.value).sort();
}

function _deslFiltroDiasSelecionados() {
  const dias = _deslDiasSelecionadosComparativo();
  if (dias && !dias.length) {
    alertar("Selecione ao menos um dia para comparar.");
    return false;
  }
  return dias;
}

function deslSelecionarDiasComparativo(marcar) {
  document.querySelectorAll("#deslCompDias .desl-dia-chk").forEach((c) => {
    c.checked = !!marcar;
  });
}

function _deslAtualizarOrigemVisivel(texto) {
  const tabela = document.querySelector(".desl-tabela-wrap");
  if (!tabela) return;
  let box = document.querySelector("#deslEditorWrap .desl-origem");
  if (!box) {
    box = document.createElement("div");
    box.className = "desl-origem";
    tabela.parentNode.insertBefore(box, tabela);
  }
  box.innerHTML = texto;
}

function deslUsarDiaSelecionadoNoRoteiro() {
  const rotaReal = document.getElementById("deslCompRota")?.value || "";
  const dias = _deslDiasSelecionadosComparativo();
  if (!dias) {
    deslAtualizarDiasComparativo();
    alertar("Marque os dias na lista para usar no roteiro.");
    return;
  }
  if (!dias.length) {
    alertar("Marque ao menos um dia para usar no roteiro.");
    return;
  }

  const diasSet = new Set(dias);
  const stops = (Array.isArray(ocorrencias) ? ocorrencias : [])
    .filter((o) => _deslOcorrenciaBateRota(o, rotaReal) && diasSet.has(_deslDataOcorrencia(o)) && _deslMin(o.hora_chegada) != null);

  if (!stops.length) {
    alertar("Não encontrei entregas com horário para os dias selecionados.");
    return;
  }

  const porDia = {};
  stops.forEach((o) => {
    const d = _deslDataOcorrencia(o);
    (porDia[d] = porDia[d] || []).push(o);
  });

  const saidasFabrica = [];
  Object.values(porDia).forEach((lista) => {
    const fab = lista.map((s) => _deslMin(s.hora_saida_fabrica)).filter((v) => v != null);
    if (fab.length) saidasFabrica.push(Math.min(...fab));
  });

  const porLoja = {};
  stops.forEach((o) => {
    const ch = _deslMin(o.hora_chegada);
    if (ch == null) return;
    const key = _deslNormLoja(o.loja, rotaReal);
    const reg = (porLoja[key] = porLoja[key] || {
      nome: _deslNomeLoja(o.loja),
      chegadas: [],
      permanencias: [],
      datas: new Set(),
    });
    reg.chegadas.push(ch);
    reg.datas.add(_deslDataOcorrencia(o));
    const perm = _deslDiff(o.hora_chegada, o.fim_descarga);
    if (perm != null) reg.permanencias.push(perm);
  });

  const lojas = Object.values(porLoja)
    .map((r) => {
      const chegadaMed = _deslMediana(r.chegadas);
      const permMed = r.permanencias.length ? _deslMediana(r.permanencias) : null;
      return {
        nome: r.nome,
        n: r.chegadas.length,
        datas: [...r.datas].sort(),
        hora_chegada: _deslMinParaHHMM(chegadaMed),
        hora_saida: permMed != null ? _deslMinParaHHMM(chegadaMed + permMed) : "",
        _ord: chegadaMed,
      };
    })
    .sort((a, b) => a._ord - b._ord);

  const aplicar = () => {
    const saidaFabrica = saidasFabrica.length ? _deslMinParaHHMM(_deslMediana(saidasFabrica)) : "";
    const datasBR = dias.map(_deslDataBR).join(", ");
    const origemTitulo = dias.length === 1 ? "Dia real selecionado" : "Dias selecionados";
    const motorista = [...new Set(stops.map(_deslNomeMotoristaOcorrencia).filter(Boolean))].join(" / ");

    const inpFab = document.getElementById("deslHoraFabrica");
    if (inpFab && saidaFabrica) inpFab.value = saidaFabrica;

    const inpDesc = document.getElementById("deslDescricao");
    if (inpDesc) inpDesc.value = `Horários calculados dos dias selecionados — dias: ${datasBR}${motorista ? ` — motorista(s): ${motorista}` : ""}`;

    const tbody = document.getElementById("deslParadasBody");
    if (tbody) tbody.innerHTML = "";
    lojas.forEach((l) => {
      const datasLoja = l.datas.map(_deslDataBR).join(", ");
      deslAddParada(
        {
          loja_nome: l.nome,
          km: null,
          hora_chegada: l.hora_chegada,
          hora_saida: l.hora_saida,
          observacao: `Base: ${datasLoja} (${l.n} registro(s) desta loja)`,
        },
        true,
      );
    });
    deslRecalcular();
    _deslAtualizarOrigemVisivel(`
      <strong>Origem dos horários:</strong> ${_deslEsc(origemTitulo)}.
      <br><small>Datas usadas: ${_deslEsc(datasBR)}${motorista ? ` • Motorista(s): ${_deslEsc(motorista)}` : ""}</small>
    `);
    alertar(`Roteiro preenchido usando somente os dias selecionados: ${datasBR}. Clique em Salvar roteiro para gravar.`);
  };

  const msg = `Substituir as lojas e horários atuais pelos horários calculados dos ${dias.length} dia(s) selecionado(s)?`;
  if (typeof confirmarSimples === "function") confirmarSimples(msg, aplicar);
  else if (confirm(msg)) aplicar();
}

function deslAtualizarDiasComparativo() {
  const alvo = document.getElementById("deslCompDias");
  if (!alvo) return;

  const rotaReal = document.getElementById("deslCompRota")?.value || "";
  const ini = document.getElementById("deslCompIni")?.value || "";
  const fim = document.getElementById("deslCompFim")?.value || "";
  const selecionadosAntes = new Set(_deslDiasSelecionadosComparativo() || []);
  const mesmaRota = alvo.dataset.rota === rotaReal;
  alvo.dataset.rota = rotaReal;

  if (!rotaReal) {
    alvo.innerHTML = `<div class="desl-vazio" style="padding:8px 0;">Selecione uma rota para listar os dias encontrados.</div>`;
    return;
  }

  const porDia = {};
  (Array.isArray(ocorrencias) ? ocorrencias : []).forEach((o) => {
    if (!_deslOcorrenciaBateRota(o, rotaReal)) return;
    if (_deslMin(o.hora_chegada) == null) return;
    const d = _deslDataOcorrencia(o);
    if (!d) return;
    if (ini && d < ini) return;
    if (fim && d > fim) return;
    const reg = (porDia[d] = porDia[d] || { data: d, qtd: 0 });
    reg.qtd += 1;
  });

  const dias = Object.values(porDia).sort((a, b) => a.data.localeCompare(b.data));
  if (!dias.length) {
    alvo.innerHTML = `<div class="desl-vazio" style="padding:8px 0;">Nenhum dia encontrado para esta rota no filtro informado.</div>`;
    return;
  }

  const preservarSelecao = mesmaRota && selecionadosAntes.size > 0;
  const itens = dias
    .map((d) => {
      const regs = _deslRegistrosDoDia(rotaReal, d.data);
      const motoristas = [...new Set(regs.map((r) => r.motorista).filter(Boolean))];
      const detalhe = motoristas.length ? ` • ${motoristas.map(_deslEsc).join(" / ")}` : "";
      const checked = preservarSelecao ? selecionadosAntes.has(d.data) : true;
      return `
        <label class="desl-dia-item" title="${d.qtd} entrega(s)${detalhe}">
          <input type="checkbox" class="desl-dia-chk" value="${_deslEsc(d.data)}" ${checked ? "checked" : ""} />
          <span>${_deslEsc(_deslDataBR(d.data))}</span>
          <small style="color:var(--text-muted)">(${d.qtd})</small>
        </label>`;
    })
    .join("");

  alvo.innerHTML = `
    <div class="desl-comp-dias-topo">
      <div><strong>${dias.length}</strong> dia(s) encontrados para <strong>${_deslEsc(rotaReal)}</strong>. Marque só os dias que deseja comparar.</div>
      <div class="desl-comp-dias-acoes">
        <button type="button" class="btn-ghost btn-sm" onclick="deslSelecionarDiasComparativo(true)">Marcar todos</button>
        <button type="button" class="btn-ghost btn-sm" onclick="deslSelecionarDiasComparativo(false)">Limpar</button>
      </div>
    </div>
    <div class="desl-comp-dias-lista">${itens}</div>`;
}

// Agrupa as ocorrências por dia (= uma viagem), ordena por chegada e
// calcula o deslocamento real de cada perna. Depois agrega por loja.
function deslComputarReal(rotaReal, ini, fim, diasSelecionados) {
  const diasSet = Array.isArray(diasSelecionados) && diasSelecionados.length ? new Set(diasSelecionados) : null;
  const base = Array.isArray(ocorrencias) ? ocorrencias : [];
  const dentro = base.filter((o) => {
    if (!_deslOcorrenciaBateRota(o, rotaReal)) return false;
    const d = _deslDataOcorrencia(o);
    if (ini && d < ini) return false;
    if (fim && d > fim) return false;
    if (diasSet && !diasSet.has(d)) return false;
    return _deslMin(o.hora_chegada) != null;
  });

  const porDia = {};
  dentro.forEach((o) => {
    const d = _deslDataOcorrencia(o);
    (porDia[d] = porDia[d] || []).push(o);
  });

  const agg = {}; // lojaKey -> { nome, desloc:[], perman:[] }
  const totalDesloc = [];
  const motoristasCont = {};
  let nViagens = 0;

  Object.entries(porDia).forEach(([data, stops]) => {
    // Pernoite (rota de viagem): lojas do dia seguinte depois das do 1o dia.
    stops.sort((a, b) => (a.dia_seguinte === true) - (b.dia_seguinte === true) || _deslMin(a.hora_chegada) - _deslMin(b.hora_chegada));
    nViagens += 1;

    const motoristasDia = new Set();
    _deslRegistrosDoDia(rotaReal, data).forEach((r) => {
      if (r.motorista) motoristasDia.add(r.motorista);
    });
    stops.forEach((o) => {
      const nome = _deslNomeMotoristaOcorrencia(o);
      if (nome) motoristasDia.add(nome);
    });
    motoristasDia.forEach((nome) => {
      motoristasCont[nome] = (motoristasCont[nome] || 0) + 1;
    });

    let prevSaida = null;
    stops.forEach((o, i) => {
      // 1a loja do 2o dia vem do hotel, nao da loja anterior: nao e deslocamento.
      const virouDia = i > 0 && (o.dia_seguinte === true) !== (stops[i - 1].dia_seguinte === true);
      const ref = i === 0 ? (o.dia_seguinte === true ? null : o.hora_saida_fabrica) : virouDia ? null : prevSaida;
      const desloc = ref ? _deslDiff(ref, o.hora_chegada) : null;
      const perman = _deslDiff(o.hora_chegada, o.fim_descarga);
      const key = _deslNormLoja(o.loja, rotaReal);
      const reg = (agg[key] = agg[key] || { nome: _deslNomeLoja(o.loja), desloc: [], perman: [] });
      if (desloc != null) {
        reg.desloc.push(desloc);
        totalDesloc.push(desloc);
      }
      if (perman != null) reg.perman.push(perman);
      prevSaida = o.fim_descarga || o.hora_chegada;
    });
  });

  const motoristas = Object.entries(motoristasCont).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "pt-BR"));
  return { agg, nViagens, mediaDesloc: _deslMedia(totalDesloc), datas: Object.keys(porDia).sort(), motoristas };
}

// "2026-06-16" → "16/06/2026" (usa o formatador global se existir)
function _deslDataBR(iso) {
  if (typeof formatarDataBR === "function") return formatarDataBR(iso);
  const p = String(iso || "").split("T")[0].split("-");
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : iso;
}

function _deslMedia(arr) {
  if (!arr || !arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function _deslMediana(arr) {
  if (!arr || !arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// minutos do dia → "HH:MM"
function _deslMinParaHHMM(min) {
  if (min == null || isNaN(min)) return "";
  min = ((Math.round(min) % 1440) + 1440) % 1440;
  return String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0");
}

// ================================================================
// IMPORTAR ROTEIROS A PARTIR DO HISTÓRICO DE ENTREGAS
// ----------------------------------------------------------------
// Varre o array global `ocorrencias`, agrupa por rota e por dia (= 1
// viagem) e monta um roteiro REPRESENTATIVO de cada rota com os tempos
// MEDIANOS. Só entram rotas com "horário bonitinho": dias completos, com
// saída da fábrica e a maioria das paradas com chegada + saída.
// ================================================================

const DESL_IMP_MIN_TIMED = 0.8; // % mínima de paradas com horário no dia
let _deslImpCandidatos = [];

function deslDerivarRoteirosDasEntregas() {
  const base = Array.isArray(ocorrencias) ? ocorrencias : [];

  // rota -> dia -> [ocorrências]
  const rotas = {};
  base.forEach((o) => {
    const rota = typeof obterRotaDaOcorrencia === "function" ? obterRotaDaOcorrencia(o) : o.rota;
    if (!rota || /^externa$/i.test(rota)) return;
    const dia = String(o.data_ocorrencia || o.data || "").split("T")[0];
    if (!dia) return;
    (rotas[rota] = rotas[rota] || {});
    (rotas[rota][dia] = rotas[rota][dia] || []).push(o);
  });

  const candidatos = [];
  Object.entries(rotas).forEach(([rota, dias]) => {
    const diasArr = Object.entries(dias);

    // dia "usável" = tem saída da fábrica e ≥80% das paradas com chegada+saída
    const usaveis = diasArr.filter(([, stops]) => {
      const temFabrica = stops.some((s) => _deslMin(s.hora_saida_fabrica) != null);
      const timed = stops.filter((s) => _deslMin(s.hora_chegada) != null && _deslMin(s.fim_descarga) != null);
      return temFabrica && stops.length >= 1 && timed.length / stops.length >= DESL_IMP_MIN_TIMED;
    });
    if (!usaveis.length) return;

    const porLoja = {}; // chave -> { nome, chegadas:[], permanencias:[] }
    const saidasFabrica = [];

    usaveis.forEach(([, stops]) => {
      const fab = stops.map((s) => _deslMin(s.hora_saida_fabrica)).filter((v) => v != null);
      if (fab.length) saidasFabrica.push(Math.min(...fab));
      stops.forEach((s) => {
        const ch = _deslMin(s.hora_chegada);
        if (ch == null) return;
        const key = _deslNormLoja(s.loja, rota);
        const reg = (porLoja[key] = porLoja[key] || { nome: _deslNomeLoja(s.loja), chegadas: [], permanencias: [] });
        reg.chegadas.push(ch);
        const perm = _deslDiff(s.hora_chegada, s.fim_descarga);
        if (perm != null) reg.permanencias.push(perm);
      });
    });

    // ordena as lojas pela mediana da hora de chegada
    const lojas = Object.values(porLoja)
      .map((r) => {
        const chegadaMed = _deslMediana(r.chegadas);
        const permMed = r.permanencias.length ? _deslMediana(r.permanencias) : null;
        return {
          nome: r.nome,
          n: r.chegadas.length,
          hora_chegada: _deslMinParaHHMM(chegadaMed),
          hora_saida: permMed != null ? _deslMinParaHHMM(chegadaMed + permMed) : "",
          _ord: chegadaMed,
        };
      })
      .sort((a, b) => a._ord - b._ord);

    candidatos.push({
      rota_nome: rota,
      dias: usaveis.length,
      datas: usaveis.map(([d]) => d).sort(), // de quais dias os tempos foram tirados
      hora_saida_fabrica: saidasFabrica.length ? _deslMinParaHHMM(_deslMediana(saidasFabrica)) : "",
      paradas: lojas.map((l) => ({ loja_nome: l.nome, km: null, hora_chegada: l.hora_chegada, hora_saida: l.hora_saida, n: l.n })),
    });
  });

  candidatos.sort((a, b) => b.dias - a.dias || a.rota_nome.localeCompare(b.rota_nome));
  return candidatos;
}

function deslImportarDasEntregas() {
  _deslGarantirEstilos();
  if (!Array.isArray(ocorrencias) || !ocorrencias.length) {
    alertar("As entregas ainda não foram carregadas. Abra o Dashboard/Entregas uma vez e tente de novo.");
    return;
  }
  _deslImpCandidatos = deslDerivarRoteirosDasEntregas();
  if (!_deslImpCandidatos.length) {
    alertar("Nenhuma rota com horários completos o suficiente foi encontrada nas entregas.");
    return;
  }
  const existentes = new Set((_deslRoteiros || []).map((r) => String(r.rota_nome || "").trim().toLowerCase()));

  const linhas = _deslImpCandidatos
    .map((c, i) => {
      const jaExiste = existentes.has(String(c.rota_nome).trim().toLowerCase());
      const previa = c.paradas
        .map((p) => `<tr><td>${_deslEsc(p.loja_nome)}</td><td>${_deslEsc(p.hora_chegada || "—")}</td><td>${_deslEsc(p.hora_saida || "—")}</td></tr>`)
        .join("");
      return `
        <div class="desl-imp-item">
          <label class="desl-imp-head">
            <input type="checkbox" class="desl-imp-chk" data-idx="${i}" ${jaExiste ? "" : "checked"} />
            <strong>${_deslEsc(c.rota_nome)}</strong>
            ${jaExiste ? `<span class="desl-imp-tag desl-imp-tag-aviso">já existe</span>` : ""}
            <span class="desl-imp-tag">${c.paradas.length} lojas</span>
            <span class="desl-imp-tag">${c.dias} dia(s)</span>
            <span class="desl-imp-tag">saída fábrica ${_deslEsc(c.hora_saida_fabrica || "—")}</span>
          </label>
          <div class="desl-imp-sub" style="margin:6px 0 0;"><strong>Dias usados:</strong> ${(c.datas || []).map((d) => _deslEsc(_deslDataBR(d))).join(" · ") || "—"}</div>
          <details class="desl-imp-det">
            <summary>ver horários medianos</summary>
            <table data-ordenavel class="desl-tabela" style="min-width:auto;margin-top:6px;">
              <thead><tr><th>Loja</th><th>Chegada</th><th>Saída</th></tr></thead>
              <tbody>${previa}</tbody>
            </table>
          </details>
        </div>`;
    })
    .join("");

  let overlay = document.getElementById("deslImpOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "deslImpOverlay";
    overlay.className = "desl-imp-overlay";
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <div class="desl-imp-box">
      <div class="desl-imp-topo">
        <div>
          <div class="desl-imp-titulo">Importar das entregas</div>
          <div class="desl-imp-sub">Roteiros montados com os tempos medianos das entregas. Marque os que quiser cadastrar.</div>
        </div>
        <button type="button" class="btn-ghost btn-sm" onclick="deslImportarFechar()">Fechar</button>
      </div>
      <div class="desl-imp-lista">${linhas}</div>
      <div class="desl-imp-rodape">
        <span class="desl-imp-sub">Os horários são uma média do histórico — revise depois se precisar.</span>
        <div style="display:flex;gap:8px;">
          <button type="button" class="btn-ghost btn-sm" onclick="deslImportarFechar()">Cancelar</button>
          <button type="button" class="btn-green btn-sm" onclick="deslImportarConfirmar()">Importar selecionados</button>
        </div>
      </div>
    </div>`;
  overlay.style.display = "flex";
}

function deslImportarFechar() {
  const o = document.getElementById("deslImpOverlay");
  if (o) o.style.display = "none";
}

async function deslImportarConfirmar() {
  const sel = [...document.querySelectorAll(".desl-imp-chk:checked")].map((c) => _deslImpCandidatos[+c.dataset.idx]);
  if (!sel.length) {
    alertar("Selecione ao menos uma rota.");
    return;
  }
  let ok = 0;
  const falhas = [];
  for (const c of sel) {
    const datasOrigem = (c.datas || []).map(_deslDataBR).join(", ");
    const corpo = {
      rota_nome: c.rota_nome,
      dia_semana: "",
      hora_saida_fabrica: c.hora_saida_fabrica || null,
      descricao: `Tempos medianos de ${c.dias} viagem(ns) — dias: ${datasOrigem}`,
      ativo: true,
      paradas: c.paradas.map((p) => ({
        loja_nome: p.loja_nome,
        km: null,
        hora_chegada: p.hora_chegada || null,
        hora_saida: p.hora_saida || null,
        observacao: `Base: ${datasOrigem}${p.n ? ` (${p.n} registro(s) desta loja)` : ""}`,
      })),
    };
    try {
      const r = await fetch(`${API_URL}/roteiros`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corpo),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "erro");
      ok += 1;
    } catch (err) {
      falhas.push(`${c.rota_nome}: ${err.message}`);
    }
  }
  deslImportarFechar();
  await deslCarregarLista();
  alertar(`${ok} roteiro(s) importado(s).` + (falhas.length ? `\nFalhas:\n${falhas.join("\n")}` : ""));
}

function deslComparar() {
  const ini = document.getElementById("deslCompIni")?.value || "";
  const fim = document.getElementById("deslCompFim")?.value || "";
  const rotaReal = document.getElementById("deslCompRota")?.value || "";
  const alvo = document.getElementById("deslCompResultado");
  if (!alvo) return;
  const diasSelecionados = _deslFiltroDiasSelecionados();
  if (diasSelecionados === false) return;

  const { linhas } = deslCalcularPlanejado();
  const planejadas = linhas.filter((l) => (l.loja_nome || "").trim());
  if (!planejadas.length) {
    alvo.innerHTML = `<div class="desl-vazio">Adicione lojas ao roteiro planejado antes de comparar.</div>`;
    return;
  }

  const { agg, nViagens, mediaDesloc, datas, motoristas } = deslComputarReal(rotaReal, ini, fim, diasSelecionados);
  if (!nViagens) {
    alvo.innerHTML = `<div class="desl-vazio">Nenhuma entrega encontrada para a rota <strong>${_deslEsc(rotaReal || "—")}</strong> ${diasSelecionados ? "nos dias selecionados" : "no período"}.</div>`;
    return;
  }

  const planKeys = new Set();
  const comparacao = planejadas.map((l) => {
    const key = _deslNormLoja(l.loja_nome, rotaReal);
    planKeys.add(key);
    return { key, planejado: l, nome: l.loja_nome, extra: false };
  });
  Object.entries(agg).forEach(([key, reg]) => {
    if (!planKeys.has(key)) comparacao.push({ key, planejado: null, nome: reg.nome, extra: true });
  });

  // Tabela ESQUERDA — planejado (igual ao roteiro)
  const linhasPlan = comparacao
    .map((item, idx) => {
      const l = item.planejado;
      if (!l) {
        return `
        <tr>
          <td>${idx + 1}ª</td>
          <td>${_deslEsc(item.nome)} <small style="color:var(--text-muted)">(só no real)</small></td>
          <td>—</td>
          <td>—</td>
          <td class="desl-cel-desloc">—</td>
          <td class="desl-cel-descarga">—</td>
        </tr>`;
      }
      return `
        <tr>
          <td>${idx + 1}ª</td>
          <td>${_deslEsc(l.loja_nome)}</td>
          <td>${_deslEsc(l.hora_chegada || "—")}</td>
          <td>${_deslEsc(l.hora_saida || "—")}</td>
          <td class="desl-cel-desloc">${_deslDur(l.desloc)}</td>
          <td class="desl-cel-descarga">${_deslDur(l.descarga)}</td>
        </tr>`;
    })
    .join("");

  // Tabela DIREITA — real (média do período), alinhada loja a loja com o planejado
  const linhasReal = comparacao
    .map((item, idx) => {
      const l = item.planejado;
      const reg = agg[item.key];
      const realDesloc = reg ? _deslMedia(reg.desloc) : null;
      const realPerman = reg ? _deslMedia(reg.perman) : null;
      const n = reg ? reg.desloc.length : 0;
      let deltaHtml = "—";
      if (l && l.desloc != null && realDesloc != null) {
        const delta = Math.round(realDesloc - l.desloc);
        const cls = delta > 0 ? "desl-delta-pos" : delta < 0 ? "desl-delta-neg" : "desl-delta-zero";
        deltaHtml = `<span class="${cls}">${delta > 0 ? "+" : ""}${_deslDur(delta)}</span>`;
      }
      return `
        <tr>
          <td>${idx + 1}ª</td>
          <td>${_deslEsc(item.nome)}${item.extra ? ` <small style="color:var(--text-muted)">(só no real)</small>` : ""}</td>
          <td class="desl-cel-desloc">${realDesloc != null ? _deslDur(realDesloc) : "—"}${n ? ` <small style="color:var(--text-muted)">(${n})</small>` : ""}</td>
          <td class="desl-cel-descarga">${realPerman != null ? _deslDur(realPerman) : "—"}</td>
          <td>${deltaHtml}</td>
        </tr>`;
    })
    .join("");

  const motoristasLinha =
    (motoristas || []).map(([nome, qt]) => `${_deslEsc(nome)} <small style="color:var(--text-muted)">(${qt})</small>`).join(" · ") || "—";
  const periodoLinha = diasSelecionados
    ? `dias selecionados: ${(datas || []).map((d) => _deslEsc(_deslDataBR(d))).join(" · ") || "—"}`
    : `${ini || fim ? `${_deslEsc(ini || "início")} → ${_deslEsc(fim || "hoje")}` : "todo o histórico"}`;
  const detalhesViagens = _deslTabelaDetalheViagens(rotaReal, deslComputarRealPorDia(rotaReal, ini, fim, diasSelecionados));

  alvo.innerHTML = `
    <div class="desl-comp-resumo">
      <strong>${nViagens}</strong> viagem(ns) da rota <strong>${_deslEsc(rotaReal || "—")}</strong>
      (${periodoLinha}).
      Δ = real − planejado (<span class="desl-delta-pos">vermelho</span> = mais lento; <span class="desl-delta-neg">verde</span> = mais rápido).
      <div style="margin-top:6px;"><strong>Motoristas:</strong> ${motoristasLinha}</div>
      <div style="margin-top:4px;"><strong>Datas das viagens:</strong> ${(datas || []).map((d) => _deslEsc(_deslDataBR(d))).join(" · ") || "—"}</div>
    </div>
    ${detalhesViagens}
    <div class="desl-cmp-cols">
      <div class="desl-cmp-col">
        <h4>📋 Planejado</h4>
        <div class="desl-tabela-wrap">
          <table data-ordenavel class="desl-tabela">
            <thead><tr><th>#</th><th>Loja</th><th>Cheg.</th><th>Saída</th><th>Desloc.</th><th>Descarga</th></tr></thead>
            <tbody>${linhasPlan}</tbody>
          </table>
        </div>
      </div>
      <div class="desl-cmp-col">
        <h4>🚚 Real (média selecionada)</h4>
        <div class="desl-tabela-wrap">
          <table data-ordenavel class="desl-tabela">
            <thead><tr><th>#</th><th>Loja</th><th>Desloc.</th><th>Permanência</th><th>Δ</th></tr></thead>
            <tbody>${linhasReal}</tbody>
          </table>
        </div>
      </div>
    </div>`;
}

// "2026-06-16" → "16/06"
function _deslDataCurta(iso) {
  const p = String(iso || "").split("T")[0].split("-");
  return p.length === 3 ? `${p[2]}/${p[1]}` : iso;
}

// Mesma lógica do real, mas mantendo CADA dia separado (sem agregar).
function deslComputarRealPorDia(rotaReal, ini, fim, diasSelecionados) {
  const diasSet = Array.isArray(diasSelecionados) && diasSelecionados.length ? new Set(diasSelecionados) : null;
  const base = Array.isArray(ocorrencias) ? ocorrencias : [];
  const dentro = base.filter((o) => {
    if (!_deslOcorrenciaBateRota(o, rotaReal)) return false;
    const d = _deslDataOcorrencia(o);
    if (ini && d < ini) return false;
    if (fim && d > fim) return false;
    if (diasSet && !diasSet.has(d)) return false;
    return _deslMin(o.hora_chegada) != null;
  });

  const porDia = {};
  dentro.forEach((o) => {
    const d = _deslDataOcorrencia(o);
    (porDia[d] = porDia[d] || []).push(o);
  });

  return Object.keys(porDia)
    .sort()
    .map((data) => {
      const stops = porDia[data].slice().sort((a, b) => _deslMin(a.hora_chegada) - _deslMin(b.hora_chegada));
      const lojas = {};
      const ordem = [];
      let prevSaida = null;
      let totalDesloc = 0;
      let totalPerman = 0;
      let ultimaSaida = "";
      stops.forEach((o, i) => {
        const ref = i === 0 ? o.hora_saida_fabrica : prevSaida;
        const desloc = _deslDiff(ref, o.hora_chegada);
        const perman = _deslDiff(o.hora_chegada, o.fim_descarga);
        const key = _deslNormLoja(o.loja, rotaReal);
        lojas[key] = {
          nome: _deslNomeLoja(o.loja),
          desloc,
          perman,
          chegada: _deslMinParaHHMM(_deslMin(o.hora_chegada)),
          saida: _deslMinParaHHMM(_deslMin(o.fim_descarga)),
        };
        ordem.push(key);
        if (desloc != null) totalDesloc += desloc;
        if (perman != null) totalPerman += perman;
        if (o.fim_descarga) ultimaSaida = o.fim_descarga;
        prevSaida = o.fim_descarga || o.hora_chegada;
      });
      const fab = stops.map((s) => _deslMin(s.hora_saida_fabrica)).filter((v) => v != null);
      const saidaFabrica = fab.length ? _deslMinParaHHMM(Math.min(...fab)) : "";
      const jornada = _deslDiff(saidaFabrica, ultimaSaida);
      return { data, saidaFabrica, lojas, ordem, totalDesloc, totalPerman, jornada, nLojas: stops.length };
    });
}

// Quebra o campo "ajudantes" (texto livre) em nomes individuais.
function _deslListaAjudantes(raw) {
  return String(raw || "")
    .split(/[,;/]+|\se\s/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

// QUEM estava na rota num dia: motoristas, ajudantes e placas, cruzando as
// ocorrências do dia (motorista/ajudantes/placa) com os registros de
// saída/retorno (rotas_registradas). Devolve arrays já deduplicados.
function _deslEquipeDoDia(rotaReal, data) {
  const stops = (Array.isArray(ocorrencias) ? ocorrencias : []).filter(
    (o) => _deslOcorrenciaBateRota(o, rotaReal) && _deslDataOcorrencia(o) === data,
  );
  const regs = _deslRegistrosDoDia(rotaReal, data);
  const motoristas = [
    ...new Set([
      ...stops.map(_deslNomeMotoristaOcorrencia).filter(Boolean),
      ...regs.map((r) => r.motorista).filter(Boolean),
    ]),
  ];
  const ajudantes = [...new Set(stops.flatMap((o) => _deslListaAjudantes(o.ajudantes)))];
  const placas = [
    ...new Set([
      ...stops.map((o) => o.placa).filter(Boolean),
      ...regs.map((r) => r.placa).filter(Boolean),
    ]),
  ];
  return { motoristas, ajudantes, placas };
}

function _deslInfoViagemDia(rotaReal, data) {
  const regs = _deslRegistrosDoDia(rotaReal, data);
  const eq = _deslEquipeDoDia(rotaReal, data);
  const saidas = [...new Set(regs.map((r) => r.saida).filter(Boolean))];
  const retornos = [...new Set(regs.map((r) => r.retorno).filter(Boolean))];
  return {
    motoristas: eq.motoristas.length ? eq.motoristas.join(" / ") : "—",
    ajudantes: eq.ajudantes.length ? eq.ajudantes.join(" / ") : "—",
    placas: eq.placas.length ? eq.placas.join(" / ") : "—",
    saidaRegistro: saidas.length ? saidas.join(" / ") : "—",
    retornoRegistro: retornos.length ? retornos.join(" / ") : "—",
  };
}

function _deslTabelaDetalheViagens(rotaReal, dias) {
  if (!Array.isArray(dias) || !dias.length) return "";
  const linhas = dias
    .map((d) => {
      const info = _deslInfoViagemDia(rotaReal, d.data);
      const lojas = d.ordem
        .map((k) => d.lojas[k]?.nome)
        .filter(Boolean)
        .map(_deslEsc)
        .join(" → ");
      return `
        <tr>
          <td>${_deslEsc(_deslDataBR(d.data))}</td>
          <td><strong>${_deslEsc(info.motoristas)}</strong></td>
          <td>${_deslEsc(info.ajudantes)}</td>
          <td>${_deslEsc(info.placas)}</td>
          <td>${_deslEsc(info.saidaRegistro)} → ${_deslEsc(info.retornoRegistro)}</td>
          <td>${_deslEsc(d.saidaFabrica || "—")}</td>
          <td>${d.nLojas || 0}</td>
          <td class="desl-cel-desloc">${_deslDur(d.totalDesloc)}</td>
          <td class="desl-cel-descarga">${_deslDur(d.totalPerman)}</td>
          <td>${_deslDur(d.jornada)}</td>
          <td>${lojas || "—"}</td>
        </tr>`;
    })
    .join("");
  return `
    <div class="desl-detalhe-viagens">
      <h4>Detalhe das viagens usadas</h4>
      <div class="desl-tabela-wrap">
        <table data-ordenavel class="desl-tabela">
          <thead>
            <tr>
              <th>Data</th><th>Motorista</th><th>Ajudantes</th><th>Placa</th><th>Saída/Retorno</th>
              <th>Saída fábrica</th><th>Lojas</th><th>Desloc. total</th><th>Permanência</th><th>Jornada</th><th>Sequência de lojas</th>
            </tr>
          </thead>
          <tbody>${linhas}</tbody>
        </table>
      </div>
    </div>`;
}

function deslCompararPorDia() {
  const ini = document.getElementById("deslCompIni")?.value || "";
  const fim = document.getElementById("deslCompFim")?.value || "";
  const rotaReal = document.getElementById("deslCompRota")?.value || "";
  const alvo = document.getElementById("deslCompResultado");
  if (!alvo) return;
  const diasSelecionados = _deslFiltroDiasSelecionados();
  if (diasSelecionados === false) return;

  const dias = deslComputarRealPorDia(rotaReal, ini, fim, diasSelecionados);
  if (!dias.length) {
    alvo.innerHTML = `<div class="desl-vazio">Nenhuma entrega encontrada para a rota <strong>${_deslEsc(rotaReal || "—")}</strong> ${diasSelecionados ? "nos dias selecionados" : "no período"}.</div>`;
    return;
  }

  // ordem das linhas: primeiro as lojas do planejado, depois lojas extras vistas no real
  const calc = deslCalcularPlanejado();
  const plan = calc.linhas.filter((l) => (l.loja_nome || "").trim());
  const planMap = {};
  plan.forEach((l) => (planMap[_deslNormLoja(l.loja_nome, rotaReal)] = l));
  const ordemKeys = [];
  const vistos = new Set();
  const nomes = {};
  plan.forEach((l) => {
    const k = _deslNormLoja(l.loja_nome, rotaReal);
    if (!vistos.has(k)) {
      vistos.add(k);
      ordemKeys.push(k);
      nomes[k] = l.loja_nome;
    }
  });
  dias.forEach((d) => d.ordem.forEach((k) => {
    if (!vistos.has(k)) {
      vistos.add(k);
      ordemKeys.push(k);
      nomes[k] = d.lojas[k]?.nome || k;
    }
  }));

  const cab = dias.map((d) => `<th>${_deslDataCurta(d.data)}</th>`).join("");

  const corpo = ordemKeys
    .map((k, idx) => {
      const planL = planMap[k];
      const planDesloc = planL ? planL.desloc : null;
      const celulas = dias
        .map((d) => {
          const reg = d.lojas[k];
          if (!reg) return `<td>—</td>`;
          let cls = "";
          if (planDesloc != null && reg.desloc != null) {
            const delta = reg.desloc - planDesloc;
            cls = delta > 1 ? "desl-delta-pos" : delta < -1 ? "desl-delta-neg" : "";
          }
          // Horário real de chegada→saída na loja naquele dia (logo abaixo do tempo).
          const horario = reg.chegada || reg.saida
            ? `<br><small style="color:var(--text-muted);font-weight:600;">🕐 ${_deslEsc(reg.chegada || "—")}→${_deslEsc(reg.saida || "—")}</small>`
            : "";
          return `<td class="${cls}" title="${planDesloc != null ? "Planejado " + _deslDur(planDesloc) : ""}">${reg.desloc != null ? _deslDur(reg.desloc) : "—"}${horario}</td>`;
        })
        .join("");
      return `<tr><td>${idx + 1}ª</td><td>${_deslEsc(nomes[k])}</td><td>${_deslDur(planDesloc)}</td>${celulas}</tr>`;
    })
    .join("");

  const rodapeDesloc = dias.map((d) => `<td><strong>${_deslDur(d.totalDesloc)}</strong></td>`).join("");
  const rodapePerman = dias.map((d) => `<td>${_deslDur(d.totalPerman)}</td>`).join("");
  const rodapeJornada = dias.map((d) => `<td>${_deslDur(d.jornada)}</td>`).join("");
  const rodapeSaida = dias.map((d) => `<td>${_deslEsc(d.saidaFabrica || "—")}</td>`).join("");

  // Δ do DIA vs planejado: quanto o deslocamento total daquele dia ficou acima
  // (vermelho) ou abaixo (verde) do planejado, em tempo e em %.
  const planTotalDesloc = calc.totais.desloc;
  const rodapeDelta = dias
    .map((d) => {
      if (planTotalDesloc == null || d.totalDesloc == null) return `<td>—</td>`;
      const delta = d.totalDesloc - planTotalDesloc;
      const pct = planTotalDesloc ? Math.round((delta / planTotalDesloc) * 100) : null;
      const cls = delta > 1 ? "desl-delta-pos" : delta < -1 ? "desl-delta-neg" : "desl-delta-zero";
      const sinal = delta > 0 ? "+" : "";
      return `<td class="${cls}">${sinal}${_deslDur(delta)}${pct != null ? `<br><small>${sinal}${pct}%</small>` : ""}</td>`;
    })
    .join("");

  // QUEM estava na rota em cada dia (motorista + ajudantes + placa), cruzando
  // ocorrências e registros. Sempre visível, mesmo sem registro de saída/retorno.
  const rodapeEquipe = dias
    .map((d) => {
      const eq = _deslEquipeDoDia(rotaReal, d.data);
      const mot = eq.motoristas.length ? eq.motoristas.map(_deslEsc).join("<br>") : "—";
      const aj = eq.ajudantes.length
        ? `<br><small style="color:var(--text-muted)">+ ${eq.ajudantes.map(_deslEsc).join(", ")}</small>`
        : "";
      const pl = eq.placas.length
        ? `<br><small style="color:var(--text-muted)">🚚 ${eq.placas.map(_deslEsc).join(" / ")}</small>`
        : "";
      return `<td>${mot}${aj}${pl}</td>`;
    })
    .join("");
  const rodapeSaidaRet = dias
    .map((d) => {
      const regs = _deslRegistrosDoDia(rotaReal, d.data);
      if (!regs.length) return `<td>—</td>`;
      const r0 = regs[0];
      return `<td>${_deslEsc(r0.saida || "—")} → ${_deslEsc(r0.retorno || "—")}</td>`;
    })
    .join("");
  const temRegistro = dias.some((d) => _deslRegistrosDoDia(rotaReal, d.data).length);
  const periodoLinha = diasSelecionados
    ? `dias selecionados: ${dias.map((d) => _deslEsc(_deslDataBR(d.data))).join(" · ")}`
    : `${ini || fim ? `${_deslEsc(ini || "início")} → ${_deslEsc(fim || "hoje")}` : "todo o histórico"}`;
  const detalhesViagens = _deslTabelaDetalheViagens(rotaReal, dias);

  alvo.innerHTML = `
    <div class="desl-comp-resumo">
      <strong>${dias.length}</strong> dia(s) da rota <strong>${_deslEsc(rotaReal || "—")}</strong>
      (${periodoLinha}).
      Cada coluna é um dia — compare a mesma loja ao longo do período.
      Em cada célula: <strong>tempo de deslocamento</strong> e, abaixo, o <strong>🕐 horário real chegada→saída</strong> na loja.
      Cor: <span class="desl-delta-pos">vermelho</span> = mais lento que o planejado, <span class="desl-delta-neg">verde</span> = mais rápido.
      No rodapé: <strong>Δ vs planejado</strong> (atraso do dia, em tempo e %) e <strong>👥 quem estava na rota</strong> (motorista, ajudantes e placa) por dia.
    </div>
    ${detalhesViagens}
    <div class="desl-tabela-wrap">
      <table data-ordenavel class="desl-tabela">
        <thead>
          <tr><th>#</th><th>Loja</th><th>Planejado</th>${cab}</tr>
        </thead>
        <tbody>${corpo}</tbody>
        <tfoot>
          <tr style="border-top:2px solid var(--border-md);"><td></td><td><strong>Deslocamento total</strong></td><td><strong>${_deslDur(calc.totais.desloc)}</strong></td>${rodapeDesloc}</tr>
          <tr><td></td><td><strong>Δ vs planejado</strong></td><td>—</td>${rodapeDelta}</tr>
          <tr><td></td><td>Permanência total</td><td>${_deslDur(calc.totais.descarga)}</td>${rodapePerman}</tr>
          <tr><td></td><td>Jornada (fábrica → última saída)</td><td>${_deslDur(calc.totais.jornada)}</td>${rodapeJornada}</tr>
          <tr><td></td><td>Saída da fábrica</td><td>${_deslEsc(calc.fabrica || "—")}</td>${rodapeSaida}</tr>
          <tr style="border-top:2px solid var(--border-md);"><td></td><td><strong>👥 Quem estava na rota</strong></td><td>—</td>${rodapeEquipe}</tr>
          ${temRegistro ? `<tr><td></td><td>Saída/Retorno (registro)</td><td>—</td>${rodapeSaidaRet}</tr>` : ""}
        </tfoot>
      </table>
    </div>`;
}
