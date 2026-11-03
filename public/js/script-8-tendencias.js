// ================================================================
// 18. ANÁLISE VISUAL E TENDÊNCIAS
// ================================================================
const TEND_CORES = {
  azul: "#38bdf8",
  vermelho: "#f87171",
  verde: "#34d399",
  amarelo: "#f59e0b",
  roxo: "#a78bfa",
  laranja: "#fb923c",
  rosa: "#f472b6",
  ciano: "#22d3ee",
};
const TEND_PALETA = Object.values(TEND_CORES);

let _tendRotaPopulada = false;

function popularFiltroRotaTendencias(force = false) {
  const select = $("tendFiltroRota");
  if (!select || (_tendRotaPopulada && !force)) return;
  const atual = select.value;
  const rotas = [
    ...new Set(
      obterOcorrenciasAtivas()
        .map((o) => obterRotaDaOcorrencia(o))
        .filter(Boolean),
    ),
  ].sort();
  select.innerHTML =
    `<option value="">Todas as rotas</option>` +
    rotas
      .map((r) => `<option value="${escapar(r)}">${escapar(r)}</option>`)
      .join("");
  if (atual && rotas.includes(atual)) select.value = atual;
  _tendRotaPopulada = true;
}

function setTendenciaPeriodo(p) {
  // Filtro único de período da aba Tendências: controla a granularidade dos
  // gráficos E a janela do comparativo (atual × anterior), que segue esta var.
  tendenciaPeriodo = p;
  document.querySelectorAll(".tend-periodo-btn[data-periodo]").forEach((b) => {
    b.classList.toggle("ativa", b.dataset.periodo === p);
  });
  renderizarTendencias();
}

function limparFiltroTendencias() {
  setVal("tendDataInicio", "");
  setVal("tendDataFim", "");
  const r = $("tendFiltroRota");
  if (r) r.value = "";
  renderizarTendencias();
}

// Retorna a chave/rótulo do balde de agrupamento de uma data conforme o período
function _tendBalde(dataISO, periodo) {
  const s = String(dataISO || "").split("T")[0];
  const partes = s.split("-").map(Number);
  if (partes.length !== 3 || partes.some(isNaN)) return null;
  const [ano, mes, dia] = partes;
  if (periodo === "mes") {
    const mm = String(mes).padStart(2, "0");
    return { key: `${ano}-${mm}`, label: `${mm}/${ano}` };
  }
  if (periodo === "semana") {
    const d = new Date(Date.UTC(ano, mes - 1, dia));
    // segunda-feira como início da semana
    const diaSemana = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - diaSemana);
    const key = d.toISOString().split("T")[0];
    const [, m2, d2] = key.split("-");
    return { key, label: `${d2}/${m2}` };
  }
  // dia
  const mm = String(mes).padStart(2, "0");
  const dd = String(dia).padStart(2, "0");
  return { key: s, label: `${dd}/${mm}` };
}

// Coloração por direção. inverso=false: sobe=verde, cai=vermelho.
// inverso=true (ex.: ocorrências): sobe=vermelho (ruim), cai=verde (bom).
function _tendSegmentoSubidaQueda(inverso = false) {
  const subiu = inverso ? TEND_CORES.vermelho : TEND_CORES.verde;
  const caiu = inverso ? TEND_CORES.verde : TEND_CORES.vermelho;
  return {
    borderColor: (ctx) => {
      const a = ctx.p0.parsed.y;
      const b = ctx.p1.parsed.y;
      if (b > a) return subiu;
      if (b < a) return caiu;
      return "#64748b";
    },
  };
}

// Cor de cada ponto conforme variação em relação ao ponto anterior.
function _tendCoresPontos(valores, inverso = false) {
  const subiu = inverso ? TEND_CORES.vermelho : TEND_CORES.verde;
  const caiu = inverso ? TEND_CORES.verde : TEND_CORES.vermelho;
  return valores.map((v, i) => {
    if (i === 0) return "#94a3b8";
    if (v > valores[i - 1]) return subiu;
    if (v < valores[i - 1]) return caiu;
    return "#64748b";
  });
}

// Linha de tendência (regressão linear por mínimos quadrados).
// Recebe a série de valores e devolve os valores ajustados sobre a reta.
function _tendRegressaoLinear(valores) {
  const n = valores.length;
  if (n < 2) return valores.slice();
  let sx = 0,
    sy = 0,
    sxy = 0,
    sxx = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += valores[i];
    sxy += i * valores[i];
    sxx += i * i;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return valores.slice();
  const m = (n * sxy - sx * sy) / denom;
  const b = (sy - m * sx) / n;
  return valores.map((_, i) => +Math.max(0, m * i + b).toFixed(2));
}

function _tendOpcoesBase() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { intersect: false, mode: "index" },
    plugins: {
      legend: {
        labels: { color: "#94a3b8", font: { size: 11 }, boxWidth: 12 },
      },
    },
    scales: {
      x: {
        ticks: { color: "#64748b", font: { size: 10 } },
        grid: { color: "rgba(255,255,255,0.05)" },
      },
      y: {
        beginAtZero: true,
        ticks: { color: "#64748b", font: { size: 10 } },
        grid: { color: "rgba(255,255,255,0.05)" },
      },
    },
  };
}

// Cartão de KPI com comparação período atual x anterior
function _tendKpiCard(titulo, valorAtual, valorAnterior, opts = {}) {
  const { sufixo = "", inverso = false, casas = 0 } = opts;
  const fmt = (v) =>
    Number(v).toLocaleString("pt-BR", {
      minimumFractionDigits: casas,
      maximumFractionDigits: casas,
    });
  let deltaHtml = "";
  if (valorAnterior > 0) {
    const variacao = ((valorAtual - valorAnterior) / valorAnterior) * 100;
    const subiu = variacao > 0;
    const neutro = Math.abs(variacao) < 0.05;
    // inverso=true -> aumento é ruim (ex.: ocorrências, tempos)
    const bom = neutro ? null : inverso ? !subiu : subiu;
    const cor = neutro
      ? "#64748b"
      : bom
        ? TEND_CORES.verde
        : TEND_CORES.vermelho;
    const seta = neutro ? "→" : subiu ? "▲" : "▼";
    deltaHtml = `<span style="color:${cor};font-size:11px;font-weight:800;">${seta} ${Math.abs(variacao).toFixed(1)}%</span>`;
  } else if (valorAtual > 0) {
    deltaHtml = `<span style="color:#64748b;font-size:11px;font-weight:700;">novo</span>`;
  }
  return `
    <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:10px;padding:14px 16px;">
      <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.6px;margin-bottom:6px;">${titulo}</div>
      <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">
        <span style="font-size:24px;font-weight:800;color:var(--text-heading);">${fmt(valorAtual)}${sufixo}</span>
        ${deltaHtml}
      </div>
      <div style="font-size:10px;color:var(--text-muted);margin-top:4px;">ant.: ${fmt(valorAnterior)}${sufixo}</div>
    </div>`;
}

function renderizarTendencias() {
  if (typeof Chart === "undefined") return;
  popularFiltroRotaTendencias();

  // Análise Visual comparativa (atual × anterior). Usa períodos próprios
  // (Dia/Semana/Mês), por isso roda antes de qualquer early-return por filtro.
  renderizarAnaliseVisualComparativa();

  const base = obterOcorrenciasAtivas();
  const fIni = getVal("tendDataInicio");
  const fFim = getVal("tendDataFim");
  const fRota = getVal("tendFiltroRota");

  const dataDe = (o) => String(o.data_ocorrencia || o.data || "").split("T")[0];

  // Filtro principal (intervalo + rota)
  let entregas = base.filter((o) => {
    const d = dataDe(o);
    if (!d) return false;
    if (fIni && d < fIni) return false;
    if (fFim && d > fFim) return false;
    if (fRota && obterRotaDaOcorrencia(o) !== fRota) return false;
    return true;
  });

  const vazio = $("tendVazio");
  if (!entregas.length) {
    if (vazio) vazio.style.display = "block";
    [
      _chartTendVolume,
      _chartTendTaxa,
      _chartTendOco,
      _chartTendTempos,
      _chartTendProbOp,
      _chartTendTransfSacola,
      _chartTendDeslocamento,
      _chartTendVolDiv,
      _chartTendLojas,
      _chartTendRotasAtraso,
    ].forEach((c) => c && c.destroy());
    _chartTendVolume = _chartTendTaxa = _chartTendOco = null;
    _chartTendTempos = _chartTendProbOp = _chartTendTransfSacola = null;
    _chartTendDeslocamento = _chartTendVolDiv = _chartTendLojas = null;
    _chartTendRotasAtraso = null;
    const elMediaAtrasoVazio = $("tendMediaAtraso");
    if (elMediaAtrasoVazio) elMediaAtrasoVazio.textContent = "";
    const kp = $("tendKpis");
    if (kp) kp.innerHTML = "";
    return;
  }
  if (vazio) vazio.style.display = "none";

  // Determina intervalo efetivo para a comparação período atual x anterior
  const datasOrd = entregas.map(dataDe).sort();
  const efIni = fIni || datasOrd[0];
  const efFim = fFim || datasOrd[datasOrd.length - 1];
  const msDia = 86400000;
  const dIni = new Date(efIni + "T00:00:00Z");
  const dFim = new Date(efFim + "T00:00:00Z");
  const diasJanela = Math.round((dFim - dIni) / msDia) + 1;
  const antFim = new Date(dIni.getTime() - msDia);
  const antIni = new Date(antFim.getTime() - (diasJanela - 1) * msDia);
  const antFimISO = antFim.toISOString().split("T")[0];
  const antIniISO = antIni.toISOString().split("T")[0];

  const entregasAnt = base.filter((o) => {
    const d = dataDe(o);
    if (!d) return false;
    if (d < antIniISO || d > antFimISO) return false;
    if (fRota && obterRotaDaOcorrencia(o) !== fRota) return false;
    return true;
  });

  // ---- Métricas agregadas (para KPIs) ----
  const metricas = (lista) => {
    let total = lista.length;
    let comOco = 0;
    let probOp = 0;
    let somaPerm = 0;
    let nPerm = 0;
    lista.forEach((o) => {
      if (o.teve_ocorrencia) comOco++;
      if (o.problema_operacional_tipo) probOp++;
      const p = Number(o.permanencia_minutos) || 0;
      if (p > 0) {
        somaPerm += p;
        nPerm++;
      }
    });
    return {
      total,
      comOco,
      taxa: total ? (comOco / total) * 100 : 0,
      probOp,
      permMedia: nPerm ? somaPerm / nPerm : 0,
    };
  };
  const mAtual = metricas(entregas);
  const mAnt = metricas(entregasAnt);

  const kp = $("tendKpis");
  if (kp) {
    kp.innerHTML = [
      _tendKpiCard("Entregas", mAtual.total, mAnt.total),
      _tendKpiCard("Com ocorrência", mAtual.comOco, mAnt.comOco, {
        inverso: true,
      }),
      _tendKpiCard("Taxa de ocorrência", mAtual.taxa, mAnt.taxa, {
        sufixo: "%",
        inverso: true,
        casas: 1,
      }),
      _tendKpiCard("Problemas operac.", mAtual.probOp, mAnt.probOp, {
        inverso: true,
      }),
      _tendKpiCard("Permanência média", mAtual.permMedia, mAnt.permMedia, {
        sufixo: " min",
        inverso: true,
        casas: 0,
      }),
    ].join("");
  }

  // ---- Agrupamento por período (dia/semana/mês) ----
  const baldes = {};
  entregas.forEach((o) => {
    const b = _tendBalde(dataDe(o), tendenciaPeriodo);
    if (!b) return;
    if (!baldes[b.key]) {
      baldes[b.key] = {
        label: b.label,
        itens: [],
        total: 0,
        comOco: 0,
        probOp: 0,
        transf: 0,
        sacola: 0,
        somaEspera: 0,
        nEspera: 0,
        somaDescarga: 0,
        nDescarga: 0,
        somaPerm: 0,
        nPerm: 0,
      };
    }
    const bk = baldes[b.key];
    bk.itens.push(o);
    bk.total++;
    if (o.teve_ocorrencia) bk.comOco++;
    if (o.problema_operacional_tipo) bk.probOp++;
    if (String(o.transferencia_problema).toLowerCase() === "sim") bk.transf++;
    const ss = String(o.sacola_status).toLowerCase();
    if (ss === "parcial" || ss === "incorreta") bk.sacola++;
    const espera = calcularPermanencia(o.hora_chegada, o.inicio_descarga);
    if (espera > 0) {
      bk.somaEspera += espera;
      bk.nEspera++;
    }
    const descarga = calcularPermanencia(o.inicio_descarga, o.termino_descarga);
    if (descarga > 0) {
      bk.somaDescarga += descarga;
      bk.nDescarga++;
    }
    const perm = Number(o.permanencia_minutos) || 0;
    if (perm > 0) {
      bk.somaPerm += perm;
      bk.nPerm++;
    }
  });

  const chaves = Object.keys(baldes).sort();
  const labels = chaves.map((k) => baldes[k].label);
  const volumes = chaves.map((k) => baldes[k].total);
  const ocorrenciasSerie = chaves.map((k) => baldes[k].comOco);
  const media = (soma, n) => (n ? +(soma / n).toFixed(1) : 0);
  const tEspera = chaves.map((k) =>
    media(baldes[k].somaEspera, baldes[k].nEspera),
  );
  const tDescarga = chaves.map((k) =>
    media(baldes[k].somaDescarga, baldes[k].nDescarga),
  );
  const tPerm = chaves.map((k) => media(baldes[k].somaPerm, baldes[k].nPerm));
  const probOpSerie = chaves.map((k) => baldes[k].probOp);
  const transfSerie = chaves.map((k) => baldes[k].transf);
  const sacolaSerie = chaves.map((k) => baldes[k].sacola);

  // ---- 1. Volume de entregas + linha de subidas e quedas ----
  if (_chartTendVolume) _chartTendVolume.destroy();
  _chartTendVolume = new Chart($("graficoTendVolume"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Entregas",
          data: volumes,
          backgroundColor: "rgba(56,189,248,0.25)",
          borderColor: TEND_CORES.azul,
          borderWidth: 1.5,
          borderRadius: 4,
          order: 2,
        },
        {
          type: "line",
          label: "Subidas e quedas",
          data: volumes,
          borderColor: TEND_CORES.verde,
          borderWidth: 2.5,
          pointRadius: 3,
          pointBackgroundColor: _tendCoresPontos(volumes),
          pointBorderColor: _tendCoresPontos(volumes),
          tension: 0,
          fill: false,
          order: 1,
          segment: _tendSegmentoSubidaQueda(),
        },
        {
          type: "line",
          label: "Linha de tendência",
          data: _tendRegressaoLinear(volumes),
          borderColor: TEND_CORES.amarelo,
          borderWidth: 2,
          borderDash: [6, 4],
          pointRadius: 0,
          pointHitRadius: 0,
          tension: 0,
          fill: false,
          order: 0,
        },
      ],
    },
    options: (() => {
      const opt = _tendOpcoesBase();
      opt.onHover = _tendCursorHover;
      opt.onClick = (evt, els) => {
        if (!els.length) return;
        const idx = els[0].index;
        abrirModalEntregasLista(labels[idx], baldes[chaves[idx]]?.itens || []);
      };
      return opt;
    })(),
  });

  // ---- 2. Entregas realizadas x ocorrências + taxa de conformidade vs meta ----
  // Taxa de conformidade = % de entregas SEM ocorrência. Meta da operação = 90%.
  const META_CONFORMIDADE = 90;
  const conformidadeSerie = chaves.map((k) => {
    const t = baldes[k].total;
    return t > 0 ? +(((t - baldes[k].comOco) / t) * 100).toFixed(1) : 0;
  });
  const metaSerie = chaves.map(() => META_CONFORMIDADE);
  // Conformidade geral do período exibido e quanto está acima/abaixo da meta.
  const totGeral = volumes.reduce((a, b) => a + b, 0);
  const ocoGeral = ocorrenciasSerie.reduce((a, b) => a + b, 0);
  const conformidadeGeral =
    totGeral > 0 ? +(((totGeral - ocoGeral) / totGeral) * 100).toFixed(1) : 0;
  const deltaMeta = +(conformidadeGeral - META_CONFORMIDADE).toFixed(1);

  const badgeMeta = $("tendMetaBadge");
  if (badgeMeta) {
    if (totGeral === 0) {
      badgeMeta.textContent = `Meta ${META_CONFORMIDADE}%`;
      badgeMeta.style.color = "var(--text-muted)";
      badgeMeta.style.borderColor = "var(--border)";
      badgeMeta.style.background = "rgba(255,255,255,0.04)";
    } else {
      const atingiu = conformidadeGeral >= META_CONFORMIDADE;
      const absd = Math.abs(deltaMeta);
      badgeMeta.textContent = atingiu
        ? `✓ ${conformidadeGeral}% · ▲ ${absd} p.p. acima da meta de ${META_CONFORMIDADE}%`
        : `⚠ ${conformidadeGeral}% · ▼ ${absd} p.p. abaixo da meta de ${META_CONFORMIDADE}%`;
      const cor = atingiu ? "var(--verde)" : "var(--vermelho)";
      badgeMeta.style.color = cor;
      badgeMeta.style.borderColor = cor;
      badgeMeta.style.background = atingiu
        ? "rgba(52,211,153,0.12)"
        : "rgba(248,113,113,0.12)";
    }
  }

  if (_chartTendTaxa) _chartTendTaxa.destroy();
  const optOco = _tendOpcoesBase();
  optOco.scales.y.ticks.precision = 0;
  optOco.scales.y.title = {
    display: true,
    text: "Entregas / ocorrências",
    color: "#94a3b8",
    font: { size: 10 },
  };
  // Eixo secundário (direita): taxa de conformidade em %, escala fixa 0–100.
  optOco.scales.y1 = {
    position: "right",
    beginAtZero: true,
    min: 0,
    max: 100,
    ticks: {
      color: "#64748b",
      font: { size: 10 },
      callback: (v) => v + "%",
    },
    grid: { drawOnChartArea: false },
    title: {
      display: true,
      text: "Conformidade (%)",
      color: "#94a3b8",
      font: { size: 10 },
    },
  };
  optOco.plugins.tooltip = {
    callbacks: {
      label: (ctx) => {
        if (ctx.dataset.label === `Meta ${META_CONFORMIDADE}%`)
          return `Meta: ${META_CONFORMIDADE}%`;
        if (ctx.dataset.label === "Taxa de conformidade") {
          const v = ctx.parsed.y;
          const d = +(v - META_CONFORMIDADE).toFixed(1);
          const txt =
            d >= 0
              ? `${Math.abs(d)} p.p. acima da meta`
              : `${Math.abs(d)} p.p. abaixo da meta`;
          return `Conformidade: ${v}% (${txt})`;
        }
        return `${ctx.dataset.label}: ${ctx.parsed.y}`;
      },
    },
  };
  optOco.onHover = _tendCursorHover;
  optOco.onClick = (evt, els) => {
    if (!els.length) return;
    const { index: idx, datasetIndex: ds } = els[0];
    const itens = baldes[chaves[idx]]?.itens || [];
    // Dataset 0 = entregas realizadas; 1 = nº de ocorrências.
    if (ds === 0) abrirModalEntregasLista(labels[idx], itens);
    else abrirModalOcorrenciasLista(labels[idx], itens);
  };
  _chartTendTaxa = new Chart($("graficoTendTaxa"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Entregas realizadas",
          data: volumes,
          backgroundColor: "rgba(56,189,248,0.20)",
          borderColor: TEND_CORES.azul,
          borderWidth: 1.5,
          borderRadius: 4,
          order: 4,
        },
        {
          label: "Nº de ocorrências",
          data: ocorrenciasSerie,
          backgroundColor: "rgba(248,113,113,0.35)",
          borderColor: TEND_CORES.vermelho,
          borderWidth: 1.5,
          borderRadius: 4,
          order: 3,
        },
        {
          type: "line",
          label: `Meta ${META_CONFORMIDADE}%`,
          data: metaSerie,
          yAxisID: "y1",
          borderColor: TEND_CORES.amarelo,
          backgroundColor: "transparent",
          borderWidth: 2,
          borderDash: [6, 4],
          pointRadius: 0,
          pointHitRadius: 0,
          tension: 0,
          fill: false,
          order: 1,
        },
        {
          type: "line",
          label: "Taxa de conformidade",
          data: conformidadeSerie,
          yAxisID: "y1",
          borderColor: TEND_CORES.verde,
          backgroundColor: "transparent",
          borderWidth: 3,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: _tendCoresPontos(conformidadeSerie),
          pointBorderColor: _tendCoresPontos(conformidadeSerie),
          tension: 0,
          fill: false,
          order: 0,
          segment: _tendSegmentoSubidaQueda(),
        },
      ],
    },
    options: optOco,
  });

  // ---- 3. Ocorrências por origem (responsável) ----
  const origens = {};
  entregas.forEach((o) => {
    if (!o.teve_ocorrencia) return;
    const resp = obterResponsavelOcorrencia(o) || "NÃO INFORMADO";
    resp
      .split(/,|;|\|/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((r) => {
        origens[r] = (origens[r] || 0) + 1;
      });
  });
  const origensOrd = Object.entries(origens).sort((a, b) => b[1] - a[1]);
  if (_chartTendOco) _chartTendOco.destroy();
  if (origensOrd.length) {
    _chartTendOco = new Chart($("graficoTendOco"), {
      type: "doughnut",
      data: {
        labels: origensOrd.map(([r]) => r),
        datasets: [
          {
            data: origensOrd.map(([, v]) => v),
            backgroundColor: origensOrd.map(
              (_, i) => TEND_PALETA[i % TEND_PALETA.length],
            ),
            borderColor: "rgba(0,0,0,0.2)",
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        onClick: (evt, els) => {
          if (!els.length) return;
          const origem = origensOrd[els[0].index][0];
          abrirModalOcorrenciasOrigem(origem, entregas);
        },
        onHover: (evt, els) => {
          const alvo = evt?.native?.target;
          if (alvo) alvo.style.cursor = els.length ? "pointer" : "default";
        },
        plugins: {
          legend: {
            position: "right",
            labels: { color: "#94a3b8", font: { size: 11 }, boxWidth: 12 },
          },
        },
      },
    });
  } else {
    _chartTendOco = null;
  }

  // ---- 4. Tempos médios (minutos) ----
  if (_chartTendTempos) _chartTendTempos.destroy();
  _chartTendTempos = new Chart($("graficoTendTempos"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Espera (chegada→descarga)",
          data: tEspera,
          borderColor: TEND_CORES.amarelo,
          backgroundColor: "transparent",
          borderWidth: 2,
          tension: 0.3,
          pointRadius: 2,
        },
        {
          label: "Descarga",
          data: tDescarga,
          borderColor: TEND_CORES.ciano,
          backgroundColor: "transparent",
          borderWidth: 2,
          tension: 0.3,
          pointRadius: 2,
        },
        {
          label: "Permanência total",
          data: tPerm,
          borderColor: TEND_CORES.roxo,
          backgroundColor: "transparent",
          borderWidth: 2,
          tension: 0.3,
          pointRadius: 2,
        },
      ],
    },
    options: (() => {
      const opt = _tendOpcoesBase();
      opt.onHover = _tendCursorHover;
      opt.onClick = (evt, els) => {
        if (!els.length) return;
        const idx = els[0].index;
        const itens = baldes[chaves[idx]]?.itens || [];
        const linhas = _tendOrdenarPorDataDesc(itens).map((o) => {
          const esp = calcularPermanencia(o.hora_chegada, o.inicio_descarga);
          const des = calcularPermanencia(o.inicio_descarga, o.termino_descarga);
          const per = Number(o.permanencia_minutos) || 0;
          return [
            _tendCelData(o),
            _tendCelLoja(o),
            escapar(formatarTempo(esp)),
            escapar(formatarTempo(des)),
            escapar(formatarTempo(per)),
          ];
        });
        abrirModalTend(
          _tendTitulo("⏱️", `Tempos · ${labels[idx]}`, itens.length, "entrega", "entregas"),
          ["Dia", "Loja", "Espera", "Descarga", "Permanência"],
          linhas,
        );
      };
      return opt;
    })(),
  });

  // ---- 5. Problemas operacionais (por tipo) ----
  const probTipos = {};
  entregas.forEach((o) => {
    const t = o.problema_operacional_tipo;
    if (!t) return;
    probTipos[t] = (probTipos[t] || 0) + 1;
  });
  const probOrd = Object.entries(probTipos).sort((a, b) => b[1] - a[1]);
  if (_chartTendProbOp) _chartTendProbOp.destroy();
  if (probOrd.length) {
    const optProb = _tendOpcoesBase();
    optProb.indexAxis = "y";
    optProb.plugins.legend.display = false;
    optProb.scales.x.ticks.precision = 0;
    optProb.onHover = _tendCursorHover;
    optProb.onClick = (evt, els) => {
      if (!els.length) return;
      const tipo = probOrd[els[0].index][0];
      const regs = entregas.filter((o) => o.problema_operacional_tipo === tipo);
      const linhas = _tendOrdenarPorDataDesc(regs).map((o) => [
        _tendCelData(o),
        _tendCelLoja(o),
        escapar(o.problema_operacional_relato || o.descricao || "—"),
      ]);
      abrirModalTend(
        _tendTitulo("🚧", tipo, regs.length, "ocorrência", "ocorrências"),
        ["Dia", "Loja", "Relato"],
        linhas,
      );
    };
    _chartTendProbOp = new Chart($("graficoTendProbOp"), {
      type: "bar",
      data: {
        labels: probOrd.map(([t]) => t),
        datasets: [
          {
            label: "Ocorrências",
            data: probOrd.map(([, v]) => v),
            backgroundColor: "rgba(251,146,60,0.3)",
            borderColor: TEND_CORES.laranja,
            borderWidth: 1.5,
            borderRadius: 4,
          },
        ],
      },
      options: optProb,
    });
  } else {
    _chartTendProbOp = null;
  }

  // ---- 6. Transferência & Sacola com problema (por período) ----
  if (_chartTendTransfSacola) _chartTendTransfSacola.destroy();
  const optTS = _tendOpcoesBase();
  optTS.scales.y.ticks.precision = 0;
  optTS.onHover = _tendCursorHover;
  optTS.onClick = (evt, els) => {
    if (!els.length) return;
    const { index: idx, datasetIndex: ds } = els[0];
    const itens = baldes[chaves[idx]]?.itens || [];
    if (ds === 0) {
      const regs = itens.filter(
        (o) => String(o.transferencia_problema).toLowerCase() === "sim",
      );
      const linhas = _tendOrdenarPorDataDesc(regs).map((o) => [
        _tendCelData(o),
        _tendCelLoja(o),
        escapar(o.transferencia_relato || "—"),
      ]);
      abrirModalTend(
        _tendTitulo("🔄", `Transferência c/ problema · ${labels[idx]}`, regs.length, "caso", "casos"),
        ["Dia", "Loja", "Relato"],
        linhas,
      );
    } else {
      const regs = itens.filter((o) =>
        ["parcial", "incorreta"].includes(String(o.sacola_status).toLowerCase()),
      );
      const linhas = _tendOrdenarPorDataDesc(regs).map((o) => [
        _tendCelData(o),
        _tendCelLoja(o),
        escapar(o.sacola_status || "—"),
      ]);
      abrirModalTend(
        _tendTitulo("🛍️", `Sacola c/ problema · ${labels[idx]}`, regs.length, "caso", "casos"),
        ["Dia", "Loja", "Status"],
        linhas,
      );
    }
  };
  _chartTendTransfSacola = new Chart($("graficoTendTransfSacola"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Transferência c/ problema",
          data: transfSerie,
          backgroundColor: "rgba(245,158,11,0.3)",
          borderColor: TEND_CORES.amarelo,
          borderWidth: 1.5,
          borderRadius: 4,
        },
        {
          label: "Sacola c/ problema",
          data: sacolaSerie,
          backgroundColor: "rgba(52,211,153,0.3)",
          borderColor: TEND_CORES.verde,
          borderWidth: 1.5,
          borderRadius: 4,
        },
      ],
    },
    options: optTS,
  });

  // ---- 7. Tempo médio de deslocamento entre lojas (Loja A → Loja B) ----
  // Para cada rota/dia, ordena as entregas pela hora de chegada e mede o
  // intervalo entre sair de uma loja (fim_descarga) e chegar na próxima.
  if (_chartTendDeslocamento) _chartTendDeslocamento.destroy();
  const gruposRotaDia = {};
  entregas.forEach((o) => {
    const chave = `${obterRotaDaOcorrencia(o)}|${dataDe(o)}`;
    (gruposRotaDia[chave] = gruposRotaDia[chave] || []).push(o);
  });
  const trechos = {}; // "A → B" -> { soma, n }
  Object.values(gruposRotaDia).forEach((lista) => {
    const ordenadas = lista
      .filter((o) => o.hora_chegada)
      .sort((a, b) => minutos(a.hora_chegada) - minutos(b.hora_chegada));
    for (let i = 1; i < ordenadas.length; i++) {
      const ant = ordenadas[i - 1];
      const cur = ordenadas[i];
      if (!ant.fim_descarga || !cur.hora_chegada) continue;
      const desloc = minutos(cur.hora_chegada) - minutos(ant.fim_descarga);
      // Ignora valores negativos e saltos irreais (> 5h) que indicam falha de dado.
      if (desloc < 0 || desloc > 300) continue;
      const chave = `${formatarNomeLoja(ant.loja)} → ${formatarNomeLoja(cur.loja)}`;
      if (!trechos[chave]) trechos[chave] = { soma: 0, n: 0, viagens: [] };
      trechos[chave].soma += desloc;
      trechos[chave].n++;
      trechos[chave].viagens.push({ data: dataDe(cur), desloc });
    }
  });
  const trechosOrd = Object.entries(trechos)
    .map(([k, v]) => ({ trecho: k, media: v.soma / v.n, n: v.n, viagens: v.viagens }))
    .sort((a, b) => b.media - a.media)
    .slice(0, 12);

  if (trechosOrd.length) {
    const optDesloc = _tendOpcoesBase();
    optDesloc.indexAxis = "y";
    optDesloc.plugins.legend.display = false;
    optDesloc.scales.x.ticks.callback = (v) => formatarTempo(v);
    optDesloc.plugins.tooltip = {
      callbacks: {
        label: (ctx) => {
          const d = trechosOrd[ctx.dataIndex];
          return ` ${formatarTempo(d.media)} (média de ${d.n} viagem${d.n > 1 ? "s" : ""})`;
        },
      },
    };
    optDesloc.onHover = _tendCursorHover;
    optDesloc.onClick = (evt, els) => {
      if (!els.length) return;
      const d = trechosOrd[els[0].index];
      const linhas = d.viagens
        .slice()
        .sort((a, b) => String(b.data).localeCompare(String(a.data)))
        .map((v) => [
          `<span style="white-space:nowrap;font-weight:700;">${escapar(formatarDataBR(v.data))}</span>`,
          `<span style="color:var(--azul);">${escapar(d.trecho)}</span>`,
          escapar(formatarTempo(v.desloc)),
        ]);
      abrirModalTend(
        _tendTitulo("🛣️", d.trecho, d.viagens.length, "viagem", "viagens"),
        ["Dia", "Trecho", "Tempo"],
        linhas,
      );
    };
    _chartTendDeslocamento = new Chart($("graficoTendDeslocamento"), {
      type: "bar",
      data: {
        labels: trechosOrd.map((d) => d.trecho),
        datasets: [
          {
            label: "Tempo médio",
            data: trechosOrd.map((d) => +d.media.toFixed(1)),
            backgroundColor: "rgba(167,139,250,0.30)",
            borderColor: TEND_CORES.roxo,
            borderWidth: 1.5,
            borderRadius: 4,
          },
        ],
      },
      options: optDesloc,
    });
  } else {
    _chartTendDeslocamento = null;
  }

  // ---- 8. Volume gerencial × físico (conferência) por período ----
  if (_chartTendVolDiv) _chartTendVolDiv.destroy();
  const volGerSerie = chaves.map((k) =>
    baldes[k].itens.reduce((s, o) => s + (Number(o.volume_gerencial) || 0), 0),
  );
  const volFisSerie = chaves.map((k) =>
    baldes[k].itens.reduce((s, o) => s + (Number(o.volume_fisico) || 0), 0),
  );
  const temVolume = volGerSerie.some((v) => v > 0) || volFisSerie.some((v) => v > 0);
  if (temVolume) {
    const optVD = _tendOpcoesBase();
    optVD.scales.y.ticks.precision = 0;
    optVD.onHover = _tendCursorHover;
    optVD.onClick = (evt, els) => {
      if (!els.length) return;
      const idx = els[0].index;
      const itens = (baldes[chaves[idx]]?.itens || []).filter(
        (o) => Number(o.volume_gerencial) || Number(o.volume_fisico),
      );
      const linhas = _tendOrdenarPorDataDesc(itens).map((o) => {
        const ger = Number(o.volume_gerencial) || 0;
        const fis = Number(o.volume_fisico) || 0;
        const dif = fis - ger;
        const cor =
          dif === 0 ? "var(--text-muted)" : dif > 0 ? TEND_CORES.verde : TEND_CORES.vermelho;
        return [
          _tendCelData(o),
          _tendCelLoja(o),
          escapar(String(ger)),
          escapar(String(fis)),
          `<span style="color:${cor};font-weight:700;">${dif > 0 ? "+" : ""}${escapar(String(dif))}</span>`,
        ];
      });
      abrirModalTend(
        _tendTitulo("📦", `Conferência · ${labels[idx]}`, itens.length, "entrega", "entregas"),
        ["Dia", "Loja", "Gerencial", "Físico", "Diferença"],
        linhas,
      );
    };
    _chartTendVolDiv = new Chart($("graficoTendVolDiv"), {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Volume gerencial",
            data: volGerSerie,
            backgroundColor: "rgba(34,211,238,0.30)",
            borderColor: TEND_CORES.ciano,
            borderWidth: 1.5,
            borderRadius: 4,
          },
          {
            label: "Volume físico",
            data: volFisSerie,
            backgroundColor: "rgba(52,211,153,0.30)",
            borderColor: TEND_CORES.verde,
            borderWidth: 1.5,
            borderRadius: 4,
          },
        ],
      },
      options: optVD,
    });
  } else {
    _chartTendVolDiv = null;
  }

  // ---- 9. Lojas com mais ocorrências ----
  if (_chartTendLojas) _chartTendLojas.destroy();
  const lojasOco = {};
  entregas.forEach((o) => {
    if (!o.teve_ocorrencia) return;
    const loja = rotuloLoja(o.loja, "NÃO INFORMADA");
    lojasOco[loja] = (lojasOco[loja] || 0) + 1;
  });
  const lojasOrd = Object.entries(lojasOco)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);
  if (lojasOrd.length) {
    const optLojas = _tendOpcoesBase();
    optLojas.indexAxis = "y";
    optLojas.plugins.legend.display = false;
    optLojas.scales.x.ticks.precision = 0;
    optLojas.onHover = _tendCursorHover;
    optLojas.onClick = (evt, els) => {
      if (!els.length) return;
      const loja = lojasOrd[els[0].index][0];
      const regs = entregas.filter(
        (o) => o.teve_ocorrencia && rotuloLoja(o.loja, "NÃO INFORMADA") === loja,
      );
      const linhas = _tendOrdenarPorDataDesc(regs).map((o) => [
        _tendCelData(o),
        `<span style="color:var(--text-muted);">${escapar(obterResponsavelOcorrencia(o) || "—")}</span>`,
        escapar(_tendErroDe(o)),
      ]);
      abrirModalTend(
        _tendTitulo("🏬", loja, regs.length, "ocorrência", "ocorrências"),
        ["Dia", "Origem", "Erro"],
        linhas,
      );
    };
    _chartTendLojas = new Chart($("graficoTendLojas"), {
      type: "bar",
      data: {
        labels: lojasOrd.map(([l]) => l),
        datasets: [
          {
            label: "Ocorrências",
            data: lojasOrd.map(([, v]) => v),
            backgroundColor: "rgba(244,114,182,0.30)",
            borderColor: TEND_CORES.rosa,
            borderWidth: 1.5,
            borderRadius: 4,
          },
        ],
      },
      options: optLojas,
    });
  } else {
    _chartTendLojas = null;
  }

  // ---- 10. Rotas com mais atraso ----
  // "Atraso" vem do TIPO de ocorrencia (tipo_problema), nao do sla_status.
  // Cobre variantes como "Atraso do responsavel". A media de atraso (minutos)
  // usa hora_agendada_loja -> hora_chegada dos registros marcados como atraso.
  if (_chartTendRotasAtraso) _chartTendRotasAtraso.destroy();
  const temAtraso = (o) => /atraso/i.test(String(o.tipo_problema || ""));
  const rotasAtraso = {};
  entregas.forEach((o) => {
    if (!temAtraso(o)) return;
    const r = obterRotaDaOcorrencia(o) || "Externa";
    if (!rotasAtraso[r]) rotasAtraso[r] = { qtd: 0, somaMin: 0, nMin: 0 };
    rotasAtraso[r].qtd++;
    const min = calcularPermanencia(o.hora_agendada_loja, o.hora_chegada);
    if (min > 0) {
      rotasAtraso[r].somaMin += min;
      rotasAtraso[r].nMin++;
    }
  });
  // Todas as rotas com pelo menos 1 atraso, da maior para a menor quantidade.
  const rotasAtrasoOrd = Object.entries(rotasAtraso).sort(
    (a, b) => b[1].qtd - a[1].qtd,
  );
  const mediaRota = (v) => (v.nMin > 0 ? Math.round(v.somaMin / v.nMin) : 0);

  // Media geral de atraso (minutos) no periodo, sobre todos os registros de atraso.
  const totSomaMin = rotasAtrasoOrd.reduce((a, [, v]) => a + v.somaMin, 0);
  const totNMin = rotasAtrasoOrd.reduce((a, [, v]) => a + v.nMin, 0);
  const totQtd = rotasAtrasoOrd.reduce((a, [, v]) => a + v.qtd, 0);
  const mediaGeralAtraso = totNMin > 0 ? Math.round(totSomaMin / totNMin) : 0;
  const elMediaAtraso = $("tendMediaAtraso");
  if (elMediaAtraso) {
    elMediaAtraso.textContent = totQtd
      ? `${totQtd} atraso(s) · média ${mediaGeralAtraso} min`
      : "";
  }

  if (rotasAtrasoOrd.length) {
    const optAtraso = _tendOpcoesBase();
    optAtraso.indexAxis = "y";
    optAtraso.plugins.legend.display = false;
    optAtraso.scales.x.ticks.precision = 0;
    optAtraso.plugins.tooltip = {
      callbacks: {
        // Alem da quantidade, mostra a media de atraso (min) da rota.
        afterLabel: (ctx) => {
          const v = rotasAtrasoOrd[ctx.dataIndex]?.[1];
          if (!v) return "";
          return v.nMin > 0
            ? `Média de atraso: ${mediaRota(v)} min`
            : "Sem horários para calcular a média";
        },
      },
    };
    optAtraso.onHover = _tendCursorHover;
    optAtraso.onClick = (evt, els) => {
      if (!els.length) return;
      const rota = rotasAtrasoOrd[els[0].index][0];
      const regs = entregas.filter(
        (o) => temAtraso(o) && (obterRotaDaOcorrencia(o) || "Externa") === rota,
      );
      const linhas = _tendOrdenarPorDataDesc(regs).map((o) => {
        const min = calcularPermanencia(o.hora_agendada_loja, o.hora_chegada);
        return [
          _tendCelData(o),
          `<span style="color:var(--azul);">${escapar(formatarNomeLoja(o.loja) || "—")}</span>`,
          `<span style="white-space:nowrap;font-weight:700;color:${min > 0 ? "var(--laranja,#fb923c)" : "var(--text-muted)"};">${min > 0 ? `${min} min` : "—"}</span>`,
          escapar(_tendErroDe(o)),
        ];
      });
      const v = rotasAtraso[rota];
      const sub = v && v.nMin > 0 ? ` · média ${mediaRota(v)} min` : "";
      abrirModalTend(
        _tendTitulo("⏰", rota + sub, regs.length, "atraso", "atrasos"),
        ["Dia", "Loja", "Atraso", "Detalhe"],
        linhas,
      );
    };
    _chartTendRotasAtraso = new Chart($("graficoTendRotasAtraso"), {
      type: "bar",
      data: {
        labels: rotasAtrasoOrd.map(([r]) => r),
        datasets: [
          {
            label: "Atrasos",
            data: rotasAtrasoOrd.map(([, v]) => v.qtd),
            backgroundColor: "rgba(251,146,60,0.30)",
            borderColor: TEND_CORES.laranja,
            borderWidth: 1.5,
            borderRadius: 4,
          },
        ],
      },
      options: optAtraso,
    });
  } else {
    _chartTendRotasAtraso = null;
  }

  // A aba nasce display:none e é renderizada no mesmo instante em que aparece
  // (animação abaIn + barra de rolagem que pode surgir e mudar a largura).
  // Isso faz o Chart.js medir o canvas antes do layout final → o desenho fica
  // num tamanho e a detecção de clique/hover noutro (mãozinha/destaque
  // deslocados). Recalibramos depois que o layout assenta.
  _tendRecalibrarGraficos();
}

// Reposiciona a área de hit (clique/hover) dos gráficos de tendência para que
// a "mãozinha" e o destaque caiam exatamente sobre a barra/ponto. Roda no
// próximo quadro e novamente após a animação da aba (~0.2s) terminar.
function _tendRecalibrarGraficos() {
  requestAnimationFrame(_redimensionarTodosGraficos);
  setTimeout(_redimensionarTodosGraficos, 260);
}

// Recalibra TODOS os gráficos Chart.js da página. O resize() reanda o tamanho
// real do canvas e o devicePixelRatio atual, alinhando a detecção de
// clique/hover ao desenho.
function _redimensionarTodosGraficos() {
  if (typeof Chart === "undefined") return;
  document.querySelectorAll("canvas").forEach((cv) => {
    const ch = Chart.getChart(cv);
    if (!ch) return;
    try {
      ch.resize();
    } catch (e) {
      /* gráfico destruído/recriado entre o agendamento e a execução — ignora */
    }
  });
}

// Quando o devicePixelRatio muda — mover a janela entre monitores com escalas
// diferentes no Windows, ou dar zoom no navegador — o Chart.js continua
// calibrado para o DPR antigo e a área de clique/hover fica deslocada do
// desenho (erro que cresce ao longo do eixo). Aqui detectamos a mudança via
// matchMedia e recalibramos todos os gráficos.
let _dprWatcherArmado = false;
function _observarMudancaDPR() {
  if (_dprWatcherArmado || typeof window.matchMedia !== "function") return;
  _dprWatcherArmado = true;
  const rearmar = () => {
    const dpr = window.devicePixelRatio || 1;
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => {
      mq.removeEventListener("change", onChange);
      _redimensionarTodosGraficos();
      rearmar(); // re-arma para o novo DPR
    };
    mq.addEventListener("change", onChange);
  };
  rearmar();
}
