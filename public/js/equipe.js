// ================================================================
// PATCH — ABA "EQUIPES" — Ranking com mais e menos problemas
// Inclua APÓS o script.js principal
// ================================================================

// ----------------------------------------------------------------
// 1. INJEÇÃO DA ABA NO NAV E NO DOM
// ----------------------------------------------------------------
function injetarAbaEquipes() {
  if (document.getElementById("aba-equipes")) return;

  // Botão na nav
  const navExistente = document.querySelector(".nav-tab[data-aba='ranking']");
  if (navExistente) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nav-tab";
    btn.dataset.aba = "equipes";
    btn.textContent = "👥 Equipes";
    btn.onclick = () => irParaAba("equipes");
    navExistente.parentElement?.insertBefore(btn, navExistente.nextSibling);
  }

  // Conteúdo da aba
  const nav = document.querySelector(".nav-tab")?.closest("nav, .nav, header");
  const destino =
    document.querySelector(".aba")?.parentElement || document.body;

  const aba = document.createElement("section");
  aba.id = "aba-equipes";
  aba.className = "aba aba-hidden";
  aba.innerHTML = `
    <div style="max-width:900px;margin:0 auto;padding:24px 16px;">

      <!-- Filtros -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:20px;">
        <div>
          <label style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);display:block;margin-bottom:5px;">De</label>
          <input type="date" id="equipesFiltroInicio"
            style="width:100%;padding:9px 12px;border-radius:10px;border:1px solid var(--border);background:var(--bg-base);color:var(--text-heading);font-size:13px;" />
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);display:block;margin-bottom:5px;">Até</label>
          <input type="date" id="equipesFiltroFim"
            style="width:100%;padding:9px 12px;border-radius:10px;border:1px solid var(--border);background:var(--bg-base);color:var(--text-heading);font-size:13px;" />
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);display:block;margin-bottom:5px;">Rota</label>
          <select id="equipesFiltroRota"
            style="width:100%;padding:9px 12px;border-radius:10px;border:1px solid var(--border);background:var(--bg-base);color:var(--text-heading);font-size:13px;">
            <option value="">Todas as rotas</option>
          </select>
        </div>
        <div style="display:flex;gap:8px;align-items:flex-end;">
          <button type="button" onclick="calcularEquipes()"
            style="flex:1;padding:9px;border-radius:10px;background:rgba(56,189,248,0.12);border:1px solid rgba(56,189,248,0.3);color:var(--azul);font-weight:700;font-size:13px;cursor:pointer;">
            Filtrar
          </button>
          <button type="button" onclick="limparFiltrosEquipes()"
            style="flex:1;padding:9px;border-radius:10px;background:var(--bg-overlay);border:1px solid var(--border);color:var(--text-muted);font-size:13px;cursor:pointer;">
            Limpar
          </button>
        </div>
      </div>

      <!-- KPIs resumo -->
      <div id="equipesKpis" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:24px;"></div>

      <!-- Pódio — top 3 melhores e top 3 piores -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px;">
        <div>
          <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:var(--verde);margin-bottom:10px;">🏆 Melhores equipes</div>
          <div id="equipesMelhores"></div>
        </div>
        <div>
          <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:var(--vermelho);margin-bottom:10px;">⚠️ Mais problemáticas</div>
          <div id="equipesPiores"></div>
        </div>
      </div>

      <!-- Tabela completa -->
      <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:var(--text-muted);margin-bottom:10px;">Todas as equipes</div>
      <div id="equipesTabela"></div>

      <!-- Gráfico de barras -->
      <div style="margin-top:28px;">
        <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:var(--text-muted);margin-bottom:10px;">Ocorrências por equipe</div>
        <div style="position:relative;width:100%;" id="equipesChartWrap">
          <canvas id="equipesChart" role="img" aria-label="Gráfico de ocorrências por equipe"></canvas>
        </div>
      </div>

    </div>`;

  destino.appendChild(aba);
}

// ----------------------------------------------------------------
// 2. LÓGICA DE CÁLCULO
// ----------------------------------------------------------------
function calcularDadosEquipes(dI, dF, rotaFiltro) {
  const toMin = (h) => {
    if (!h) return 0;
    const [hh, mm] = String(h).split(":").map(Number);
    return hh * 60 + (mm || 0);
  };

  let base = (window.ocorrencias || []).filter((o) => {
    const d = String(o.data_ocorrencia || o.data || "").split("T")[0];
    if (dI && d < dI) return false;
    if (dF && d > dF) return false;
    if (
      rotaFiltro &&
      typeof obterRotaDaOcorrencia === "function" &&
      obterRotaDaOcorrencia(o) !== rotaFiltro
    )
      return false;
    return true;
  });

  const equipesMap = {};

  base.forEach((o) => {
    const motorista = o.motorista || "Sem motorista";
    const ajudantes =
      String(o.ajudantes || "Sem ajudante")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .sort()
        .join(" + ") || "Sem ajudante";

    const chave = `${motorista} | ${ajudantes}`;

    if (!equipesMap[chave]) {
      equipesMap[chave] = {
        motorista,
        ajudantes,
        chave,
        total: 0,
        ocorrencias: 0,
        ocorrenciasOutrasAreas: 0,
        problemasOp: 0,
        semOco: 0,
        descargaExcedida: 0,
        checklistNaoFeito: 0,
        checklist: 0,
        rotas: new Set(),
      };
    }

    const eq = equipesMap[chave];
    eq.total++;
    eq.rotas.add(
      typeof obterRotaDaOcorrencia === "function"
        ? obterRotaDaOcorrencia(o)
        : "-",
    );

    const temOco = !!(o.teve_ocorrencia || o.tipo_problema);
    const culpaEquipeEntrega =
      typeof responsavelEquipeEntrega === "function" &&
      responsavelEquipeEntrega(
        typeof obterResponsavelOcorrencia === "function"
          ? obterResponsavelOcorrencia(o)
          : o.ocorrencia_responsavel,
      );
    const temProb = !!o.problema_operacional_tipo;
    const fezCk =
      o.fez_checklist === true ||
      o.fez_checklist === "true" ||
      o.fez_checklist === "sim";

    if (temOco && culpaEquipeEntrega) eq.ocorrencias++;
    else if (temOco) eq.ocorrenciasOutrasAreas++;
    if (temProb) eq.problemasOp++;
    if ((!temOco || !culpaEquipeEntrega) && !temProb) eq.semOco++;
    if (fezCk) eq.checklist++;
    else eq.checklistNaoFeito++;

    // Descarga excedida
    const inicio = o.inicio_descarga;
    const saida = o.termino_descarga;
    if (inicio && saida) {
      const dur = toMin(saida) - toMin(inicio);
      const limite =
        typeof toleranciaDaLoja === "function" ? toleranciaDaLoja(o.loja) : 40;
      if (dur > 0 && dur > limite) eq.descargaExcedida++;
    }
  });

  return Object.values(equipesMap)
    .filter((e) => e.total > 0)
    .map((e) => {
      const taxaSucesso =
        e.total > 0 ? Math.round((e.semOco / e.total) * 100) : 0;
      const totalProblemas = e.ocorrencias + e.problemasOp + e.descargaExcedida;
      const score = Math.round(
        taxaSucesso - totalProblemas * 2 + e.checklist * 0.5,
      );
      return { ...e, taxaSucesso, totalProblemas, score };
    })
    .sort((a, b) => b.score - a.score || b.total - a.total);
}

// ----------------------------------------------------------------
// 3. RENDERIZAÇÃO
// ----------------------------------------------------------------
let _equipesChartInstance = null;

function renderizarEquipes(dados) {
  // KPIs
  const kpisEl = document.getElementById("equipesKpis");
  if (kpisEl) {
    const totalEquipes = dados.length;
    const totalEntregas = dados.reduce((s, e) => s + e.total, 0);
    const totalOco = dados.reduce((s, e) => s + e.ocorrencias, 0);
    const mediaSucesso =
      dados.length > 0
        ? Math.round(
            dados.reduce((s, e) => s + e.taxaSucesso, 0) / dados.length,
          )
        : 0;

    const kpi = (label, valor, cor) => `
      <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:12px;padding:14px 16px;text-align:center;">
        <div style="font-size:1.6rem;font-weight:800;color:${cor};">${valor}</div>
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-top:4px;">${label}</div>
      </div>`;

    kpisEl.innerHTML =
      kpi("Equipes ativas", totalEquipes, "var(--azul)") +
      kpi("Entregas analisadas", totalEntregas, "var(--text-heading)") +
      kpi("Total de ocorrências", totalOco, "var(--vermelho)") +
      kpi(
        "Média de sucesso",
        mediaSucesso + "%",
        mediaSucesso >= 80 ? "var(--verde)" : "var(--amarelo)",
      );
  }

  // Melhores
  const melhoresEl = document.getElementById("equipesMelhores");
  if (melhoresEl) {
    const top = dados.slice(0, 3);
    melhoresEl.innerHTML =
      top.length === 0
        ? `<p style="color:var(--text-muted);font-size:13px;">Sem dados.</p>`
        : top.map((e, i) => cartaoEquipe(e, i, "verde")).join("");
  }

  // Piores
  const pioresEl = document.getElementById("equipesPiores");
  if (pioresEl) {
    const bottom = [...dados].reverse().slice(0, 3);
    pioresEl.innerHTML =
      bottom.length === 0
        ? `<p style="color:var(--text-muted);font-size:13px;">Sem dados.</p>`
        : bottom
            .map((e, i) => cartaoEquipe(e, dados.length - 1 - i, "vermelho"))
            .join("");
  }

  // Tabela
  const tabelaEl = document.getElementById("equipesTabela");
  if (tabelaEl) {
    tabelaEl.innerHTML =
      dados.length === 0
        ? `<p style="color:var(--text-muted);font-size:13px;">Nenhuma equipe encontrada.</p>`
        : `<div style="overflow-x:auto;">
        <table data-ordenavel style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="background:var(--bg-elevated);border-bottom:2px solid var(--border);">
              ${[
                "#",
                "Motorista",
                "Ajudantes",
                "Entregas",
                "Sem oco",
                "Ocorr. equipe",
                "Prob. Op.",
                "CK ✅",
                "Desc. exc.",
                "Taxa",
                "Score",
              ]
                .map(
                  (h) =>
                    `<th style="padding:10px 12px;text-align:${h === "#" ? "center" : "left"};font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">${h}</th>`,
                )
                .join("")}
            </tr>
          </thead>
          <tbody>
            ${dados
              .map((e, i) => {
                const { cor, bg, borda } = corScore(e.score);
                const zebra =
                  i % 2 === 0
                    ? "rgba(255,255,255,0.01)"
                    : "rgba(255,255,255,0.025)";
                return `
              <tr style="background:${zebra};border-bottom:1px solid var(--border);">
                <td style="padding:10px 12px;text-align:center;font-weight:800;color:var(--text-muted);">${i + 1}</td>
                <td style="padding:10px 12px;font-weight:700;color:var(--text-heading);white-space:nowrap;">${escaparSeguro(e.motorista)}</td>
                <td style="padding:10px 12px;color:var(--text-secondary);font-size:11px;">${escaparSeguro(e.ajudantes)}</td>
                <td style="padding:10px 12px;text-align:center;font-weight:700;color:var(--text-muted);">${e.total}</td>
                <td style="padding:10px 12px;text-align:center;font-weight:700;color:var(--verde);">${e.semOco}</td>
                <td style="padding:10px 12px;text-align:center;font-weight:700;color:${e.ocorrencias > 0 ? "var(--vermelho)" : "var(--text-muted)"};">${e.ocorrencias}</td>
                <td style="padding:10px 12px;text-align:center;font-weight:700;color:${e.problemasOp > 0 ? "var(--amarelo)" : "var(--text-muted)"};">${e.problemasOp}</td>
                <td style="padding:10px 12px;text-align:center;font-weight:700;color:var(--azul);">${e.checklist}</td>
                <td style="padding:10px 12px;text-align:center;font-weight:700;color:${e.descargaExcedida > 0 ? "var(--vermelho)" : "var(--text-muted)"};">${e.descargaExcedida}</td>
                <td style="padding:10px 12px;text-align:center;">
                  <span style="font-weight:800;font-size:12px;color:${e.taxaSucesso >= 80 ? "var(--verde)" : e.taxaSucesso >= 50 ? "var(--amarelo)" : "var(--vermelho)"};">${e.taxaSucesso}%</span>
                </td>
                <td style="padding:10px 12px;text-align:center;">
                  <span style="background:${bg};border:1px solid ${borda};color:${cor};font-weight:800;font-size:12px;padding:3px 10px;border-radius:8px;display:inline-block;">${e.score > 0 ? "+" : ""}${e.score}</span>
                </td>
              </tr>`;
              })
              .join("")}
          </tbody>
        </table>
      </div>`;
  }

  // Gráfico
  renderizarGraficoEquipes(dados);
}

function cartaoEquipe(e, pos, tipo) {
  const { cor, bg, borda } = corScore(e.score);
  const icone =
    tipo === "verde" ? (pos === 0 ? "🥇" : pos === 1 ? "🥈" : "🥉") : "⚠️";

  return `
  <div style="background:${bg};border:1px solid ${borda};border-radius:12px;padding:14px 16px;margin-bottom:10px;">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
      <span style="font-size:1.3rem;">${icone}</span>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:700;color:var(--text-heading);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escaparSeguro(e.motorista)}</div>
        <div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escaparSeguro(e.ajudantes)}</div>
      </div>
      <span style="font-size:1.1rem;font-weight:800;color:${cor};">${e.score > 0 ? "+" : ""}${e.score}</span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;font-size:11px;text-align:center;">
      <div style="background:rgba(255,255,255,0.04);border-radius:7px;padding:6px 4px;">
        <div style="font-weight:800;color:var(--text-heading);">${e.total}</div>
        <div style="color:var(--text-muted);">entregas</div>
      </div>
      <div style="background:rgba(255,255,255,0.04);border-radius:7px;padding:6px 4px;">
        <div style="font-weight:800;color:${e.ocorrencias > 0 ? "var(--vermelho)" : "var(--verde)"};">${e.ocorrencias}</div>
        <div style="color:var(--text-muted);">ocorrências</div>
      </div>
      <div style="background:rgba(255,255,255,0.04);border-radius:7px;padding:6px 4px;">
        <div style="font-weight:800;color:${e.taxaSucesso >= 80 ? "var(--verde)" : "var(--amarelo)"};">${e.taxaSucesso}%</div>
        <div style="color:var(--text-muted);">sucesso</div>
      </div>
    </div>
  </div>`;
}

function corScore(score) {
  if (score > 5)
    return {
      cor: "var(--verde)",
      bg: "rgba(52,211,153,0.08)",
      borda: "rgba(52,211,153,0.25)",
    };
  if (score >= 0)
    return {
      cor: "var(--amarelo)",
      bg: "rgba(251,191,36,0.08)",
      borda: "rgba(251,191,36,0.25)",
    };
  return {
    cor: "var(--vermelho)",
    bg: "rgba(248,113,113,0.08)",
    borda: "rgba(248,113,113,0.25)",
  };
}

function escaparSeguro(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderizarGraficoEquipes(dados) {
  const wrap = document.getElementById("equipesChartWrap");
  const canvas = document.getElementById("equipesChart");
  if (!wrap || !canvas) return;

  const top = dados.slice(0, 12);
  const labels = top.map((e) => {
    const mot = e.motorista.split(" ")[0];
    const aju =
      e.ajudantes === "Sem ajudante" ? "—" : e.ajudantes.split(" ")[0];
    return `${mot} / ${aju}`;
  });
  const dataOco = top.map((e) => e.ocorrencias);
  const dataOk = top.map((e) => e.semOco);

  const alturaTotal = Math.max(top.length * 52 + 80, 200);
  wrap.style.height = alturaTotal + "px";

  if (_equipesChartInstance) {
    _equipesChartInstance.destroy();
    _equipesChartInstance = null;
  }

  const carregar = () => {
    if (!window.Chart) {
      setTimeout(carregar, 200);
      return;
    }
    _equipesChartInstance = new window.Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Sem ocorrência",
            data: dataOk,
            backgroundColor: "rgba(52,211,153,0.55)",
            borderColor: "rgba(52,211,153,0.9)",
            borderWidth: 1,
            borderRadius: 4,
          },
          {
            label: "Com ocorrência",
            data: dataOco,
            backgroundColor: "rgba(248,113,113,0.55)",
            borderColor: "rgba(248,113,113,0.9)",
            borderWidth: 1,
            borderRadius: 4,
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { mode: "index" },
        },
        scales: {
          x: {
            stacked: true,
            grid: { color: "rgba(148,163,184,0.12)" },
            ticks: { color: "#94a3b8", font: { size: 11 } },
          },
          y: {
            stacked: true,
            grid: { display: false },
            ticks: {
              color: "#94a3b8",
              font: { size: 11 },
              autoSkip: false,
            },
          },
        },
      },
    });
  };

  if (window.Chart) {
    carregar();
  } else {
    const s = document.createElement("script");
    s.src =
      "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js";
    s.onload = carregar;
    document.head.appendChild(s);
  }
}
// ----------------------------------------------------------------
// 3.1. FONTE DE DADOS — LOCALSTORAGE OU BANCO
// ----------------------------------------------------------------
const API_ENDPOINTS_EQUIPES = [
  "ocorrencias",
];

const LOCALSTORAGE_KEYS_EQUIPES = [
  "ocorrencias",
  "historicoOcorrencias",
  "historicoEntregas",
  "entregas",
  "registros",
  "dadosEntregas",
];
function extrairArrayEquipes(valor) {
  if (!valor) return [];

  if (Array.isArray(valor)) return valor;

  if (typeof valor === "object") {
    const possiveis = [
      valor.ocorrencias,
      valor.entregas,
      valor.historico,
      valor.dados,
      valor.registros,
      valor.items,
      valor.lista,
    ];

    for (const item of possiveis) {
      if (Array.isArray(item)) return item;
    }
  }

  return [];
}

function normalizarRegistroEquipe(o) {
  if (!o || typeof o !== "object") return null;

  return {
    ...o,

    data_ocorrencia:
      o.data_ocorrencia ||
      o.data ||
      o.dataEntrega ||
      o.data_entrega ||
      o.data_saida ||
      o.createdAt ||
      "",

    motorista:
      o.motorista ||
      o.nomeMotorista ||
      o.driver ||
      o.condutor ||
      "Sem motorista",

    ajudantes: Array.isArray(o.ajudantes)
      ? o.ajudantes.join(", ")
      : o.ajudantes || o.ajudante || o.nomeAjudante || "Sem ajudante",

    loja: o.loja || o.nomeLoja || o.destino || "",

    rota: o.rota || o.nomeRota || o.codigoRota || "",

    teve_ocorrencia:
      o.teve_ocorrencia ?? o.teveOcorrencia ?? o.ocorrencia ?? false,

    tipo_problema: o.tipo_problema || o.tipoProblema || o.ocorrencia_tipo || "",

    ocorrencia_responsavel:
      o.ocorrencia_responsavel ||
      o.ocorrenciaResponsavel ||
      o.responsavel_ocorrencia ||
      o.responsavelOcorrencia ||
      "",

    problema_operacional_tipo:
      o.problema_operacional_tipo ||
      o.problemaOperacionalTipo ||
      o.problema_operacional ||
      "",

    fez_checklist:
      o.fez_checklist ??
      o.fezChecklist ??
      o.checklistFeito ??
      o.checklist ??
      false,

    inicio_descarga:
      o.inicio_descarga || o.inicioDescarga || o.hora_inicio_descarga || "",

    fim_descarga: o.fim_descarga || o.fimDescarga || o.hora_fim_descarga || "",
  };
}
function ehEntregaValidaEquipe(o) {
  if (!o || typeof o !== "object") return false;

  const temData = !!(
    o.data_ocorrencia ||
    o.data ||
    o.dataEntrega ||
    o.data_entrega ||
    o.data_saida ||
    o.createdAt
  );

  const temMotorista = !!(
    o.motorista ||
    o.nomeMotorista ||
    o.driver ||
    o.condutor
  );

  const temLoja = !!(
    o.loja ||
    o.nomeLoja ||
    o.destino
  );

  return temData && temMotorista && temLoja;
}
function deduplicarEquipes(lista) {
  const mapa = new Map();

  lista.forEach((item) => {
    if (!item) return;

    const data = String(
      item.data_ocorrencia ||
      item.data ||
      item.dataEntrega ||
      item.data_entrega ||
      item.data_saida ||
      ""
    ).split("T")[0];

    const motorista = String(item.motorista || "").trim().toUpperCase();
    const loja = String(item.loja || "").trim().toUpperCase();
    const rota = String(item.rota || "").trim().toUpperCase();
    const inicio = String(item.inicio_descarga || "").trim();
    const fim = String(item.fim_descarga || "").trim();

    const chave =
      item.idEntrega ||
      item.entregaId ||
      item.id_entrega ||
      item.id ||
      item._id ||
      `${data}|${motorista}|${loja}|${rota}|${inicio}|${fim}`;

    mapa.set(String(chave), item);
  });

  return Array.from(mapa.values());
}

function lerDadosLocalStorageEquipes() {
  let dados = [];

  LOCALSTORAGE_KEYS_EQUIPES.forEach((chave) => {
    try {
      const bruto = localStorage.getItem(chave);
      if (!bruto) return;

      const json = JSON.parse(bruto);
      dados.push(...extrairArrayEquipes(json));
    } catch (e) {
      console.warn(`[Equipes] Erro ao ler localStorage: ${chave}`, e);
    }
  });

  return dados
    .map(normalizarRegistroEquipe)
    .filter(Boolean)
    .filter(ehEntregaValidaEquipe);
}
function obterBasesApiEquipes() {
  const bases = [
    window.API_BASE_URL,
    window.API_BASE,
    window.BASE_API,
    window.API_URL,
    localStorage.getItem("API_BASE_URL"),
    localStorage.getItem("apiBaseUrl"),
    localStorage.getItem("baseApi"),
  ];

  if (
    window.location &&
    window.location.origin &&
    window.location.origin.startsWith("http")
  ) {
    bases.push(window.location.origin);
  }

  return [
    ...new Set(bases.filter(Boolean).map((b) => String(b).replace(/\/$/, ""))),
  ];
}

async function buscarDadosBancoEquipes() {
  const bases = obterBasesApiEquipes();
  let dados = [];

  for (const base of bases) {
    for (const endpoint of API_ENDPOINTS_EQUIPES) {
      const url = `${base}/${endpoint}`;

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2500);

        const resp = await fetch(url, {
          method: "GET",
          headers: {
            Accept: "application/json",
          },
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!resp.ok) continue;

        const json = await resp.json();
        const array = extrairArrayEquipes(json);

        if (array.length > 0) {
          console.log(`[Equipes] Dados puxados do banco: ${url}`, array.length);
          dados.push(...array.filter(ehEntregaValidaEquipe));
        }
      } catch (e) {
        // Mantém silencioso para não quebrar o sistema se o banco estiver offline
      }
    }
  }

  return dados.map(normalizarRegistroEquipe).filter(Boolean);
}

async function carregarDadosEquipes() {
  const dadosJanela = Array.isArray(window.ocorrencias)
    ? window.ocorrencias.map(normalizarRegistroEquipe).filter(Boolean)
    : [];

  const dadosLocalStorage = lerDadosLocalStorageEquipes();

  const dadosBanco = await buscarDadosBancoEquipes();

  const todos = deduplicarEquipes([
    ...dadosJanela,
    ...dadosLocalStorage,
    ...dadosBanco,
  ]);

  window.ocorrencias = todos;

  console.log("[Equipes] Total de registros carregados:", todos.length);

  return todos;
}
// ----------------------------------------------------------------
// 4. CONTROLES PÚBLICOS
// ----------------------------------------------------------------
window.calcularEquipes = async function () {
  const tabelaEl = document.getElementById("equipesTabela");

  if (tabelaEl) {
    tabelaEl.innerHTML = `
      <p style="color:var(--text-muted);font-size:13px;">
        Carregando dados das equipes...
      </p>
    `;
  }

  await carregarDadosEquipes();

  const dI = document.getElementById("equipesFiltroInicio")?.value || "";
  const dF = document.getElementById("equipesFiltroFim")?.value || "";
  const rota = document.getElementById("equipesFiltroRota")?.value || "";

  popularSelectRotasEquipes();

  const dados = calcularDadosEquipes(dI, dF, rota);
  renderizarEquipes(dados);
};

window.limparFiltrosEquipes = function () {
  ["equipesFiltroInicio", "equipesFiltroFim"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });

  const rot = document.getElementById("equipesFiltroRota");
  if (rot) rot.value = "";

  window.calcularEquipes();
};

function popularSelectRotasEquipes() {
  const select = document.getElementById("equipesFiltroRota");
  if (!select) return;

  const atual = select.value;

  const rotas = [
    ...new Set(
      (window.ocorrencias || [])
        .map((o) => {
          if (typeof obterRotaDaOcorrencia === "function") {
            return obterRotaDaOcorrencia(o);
          }

          return o.rota || o.nomeRota || o.codigoRota || "";
        })
        .filter(Boolean),
    ),
  ].sort();

  select.innerHTML = '<option value="">Todas as rotas</option>';

  rotas.forEach((r) => {
    select.innerHTML += `
      <option value="${escaparSeguro(r)}"${atual === r ? " selected" : ""}>
        ${escaparSeguro(r)}
      </option>
    `;
  });
}

// ----------------------------------------------------------------
// 5. HOOK NA NAVEGAÇÃO — atualize ao entrar na aba
// ----------------------------------------------------------------
const _irParaAbaOriginal =
  typeof window.irParaAba === "function" ? window.irParaAba : null;

if (_irParaAbaOriginal && !window._irParaAbaEquipesPatched) {
  window._irParaAbaEquipesPatched = true;
  window.irParaAba = function (nome, ...rest) {
    _irParaAbaOriginal(nome, ...rest);
    if (nome === "equipes") {
      popularSelectRotasEquipes();
      window.calcularEquipes();
    }
  };
}

// ----------------------------------------------------------------
// 6. BOOT
// ----------------------------------------------------------------
function bootEquipes() {
  injetarAbaEquipes();

  // Atualiza dados ao carregar histórico (hook em atualizarTodasAsViews)
  const _atvOriginal =
    typeof window.atualizarTodasAsViews === "function"
      ? window.atualizarTodasAsViews
      : null;
  if (_atvOriginal && !window._atvEquipesPatched) {
    window._atvEquipesPatched = true;
    window.atualizarTodasAsViews = function (...args) {
      _atvOriginal(...args);
      const abaAtiva = document.querySelector(
        ".nav-tab.ativa[data-aba='equipes']",
      );
      if (abaAtiva) {
        popularSelectRotasEquipes();
        window.calcularEquipes();
      }
    };
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootEquipes);
} else {
  bootEquipes();
}
