// ================================================================
// 7. FILTROS DA TORRE DE CONTROLE
// ================================================================
const FILTROS_ENTREGA_IDS = [
  "filtroDataInicial",
  "filtroDataFinal",
  "filtroMotorista",
  "filtroAjudante",
  "filtroLoja",
  "filtroRota",
  "filtroStatus",
  "filtroTipoOcorrencia",
  "filtroTipoProblemaOperacional",
];

// Filtros que NÃO mexem nas entregas: alimentam só a seção "Atrasos na
// Saída da Fábrica" (ver torre-complementos.js). São limpos junto com os
// demais e disparam apenas o re-render dos complementos. Os filtros de
// "ocorrência individual" entram aqui só para serem limpos — o painel
// que eles filtrariam não faz parte deste escopo.
const FILTROS_TORRE_EXTRA_IDS = [
  "filtroAtrasoSaida",
  "filtroPlacaAtrasoSaida",
  "filtroOcorrenciaIndividual",
  "filtroResponsavelIndividual",
  "filtroEnvolvidoIndividual",
  "filtroTipoOcorrenciaIndividual",
];

// IDs que, ao mudar, re-renderizam só os complementos da Torre.
const FILTROS_TORRE_COMPLEMENTOS_IDS = ["filtroAtrasoSaida", "filtroPlacaAtrasoSaida"];

function _rerenderComplementosTorre() {
  if (typeof window.atualizarComplementosTorre === "function") {
    window.atualizarComplementosTorre();
  }
}

function temFiltrosEntregaTorreAtivos() {
  return FILTROS_ENTREGA_IDS.some((id) => {
    const el = $(id);
    return el && String(el.value || "").trim() !== "";
  });
}
function temFiltrosTorreAtivos() {
  return temFiltrosEntregaTorreAtivos();
}

function preencherSelectComValores(id, valores, textoPadrao) {
  const select = $(id);
  if (!select) return;
  const atual = select.value;
  select.innerHTML = `<option value="">${textoPadrao}</option>`;
  valores.forEach((v) => {
    select.innerHTML += `<option value="${escapar(v)}">${escapar(v)}</option>`;
  });
  select.value = valores.includes(atual) ? atual : "";
}

function popularFiltrosTorre() {
  if (!estaNaTorreControle()) return;
  preencherSelectComValores(
    "filtroMotorista",
    [...new Set(ocorrencias.map((o) => o.motorista).filter(Boolean))].sort(),
    "Todos",
  );
  preencherSelectComValores(
    "filtroAjudante",
    [
      ...new Set(ocorrencias.flatMap((o) => extrairAjudantes(o.ajudantes))),
    ].sort(),
    "Todos",
  );
  preencherSelectComValores(
    "filtroLoja",
    [
      ...new Set(
        ocorrencias.map((o) => rotuloLoja(o.loja)).filter(Boolean),
      ),
    ].sort(),
    "Todas",
  );
  preencherSelectComValores(
    "filtroRota",
    [
      ...new Set(
        ocorrencias.map((o) => obterRotaDaOcorrencia(o)).filter(Boolean),
      ),
    ].sort(),
    "Todas",
  );
  preencherSelectComValores(
    "filtroTipoOcorrencia",
    [
      ...new Set(ocorrencias.map((o) => o.tipo_problema).filter(Boolean)),
    ].sort(),
    "Todos",
  );
  preencherSelectComValores(
    "filtroTipoProblemaOperacional",
    [
      ...new Set(
        ocorrencias.map((o) => o.problema_operacional_tipo).filter(Boolean),
      ),
    ].sort(),
    "Todos",
  );

  // Placas que aparecem nos registros de atraso na saída (filtro próprio
  // da seção "Atrasos na Saída da Fábrica").
  const atrasos =
    typeof lerStorage === "function" && typeof LS !== "undefined"
      ? lerStorage(LS.atrasos)
      : [];
  preencherSelectComValores(
    "filtroPlacaAtrasoSaida",
    [...new Set((atrasos || []).map((a) => a.placa).filter(Boolean))].sort(),
    "Todas",
  );

  if (typeof window.popularMultiSelectsTorre === "function") {
    window.popularMultiSelectsTorre(ocorrencias);
  }
}

function lerFiltroTorreMultiplo(id) {
  if (typeof window.lerFiltroMultiplo === "function") {
    return window.lerFiltroMultiplo(id);
  }

  const valor = getVal(id);
  if (!valor) return [];

  try {
    const parsed = JSON.parse(valor);
    return Array.isArray(parsed) ? parsed : [valor];
  } catch {
    return [valor];
  }
}

function aplicarFiltrosTorre() {
  if (!estaNaTorreControle()) return;

  const v = (id) => getVal(id);
  const dI = v("filtroDataInicial");
  const dF = v("filtroDataFinal");
  const mot = v("filtroMotorista");
  const aju = v("filtroAjudante");
  const lojaFmt = v("filtroLoja");
  const rota = v("filtroRota");
  const status = v("filtroStatus");
  const tiposOco = lerFiltroTorreMultiplo("filtroTipoOcorrencia");
  const tiposProb = lerFiltroTorreMultiplo("filtroTipoProblemaOperacional");

  ocorrenciasFiltradasTorre = ocorrencias.filter((o) => {
    const data = (o.data_ocorrencia || "").split("T")[0];
    const ajLista = extrairAjudantes(o.ajudantes);
    const temOco = !!o.teve_ocorrencia;
    const temProb = !!o.problema_operacional_tipo;

    if (dI && data < dI) return false;
    if (dF && data > dF) return false;
    if (mot && o.motorista !== mot) return false;
    if (aju && !ajLista.includes(aju)) return false;
    if (lojaFmt && rotuloLoja(o.loja) !== lojaFmt) return false;
    if (rota && obterRotaDaOcorrencia(o) !== rota) return false;
    if (tiposOco.length && !tiposOco.includes(o.tipo_problema)) return false;
    if (tiposProb.length && !tiposProb.includes(o.problema_operacional_tipo))
      return false;
    if (status === "sem_ocorrencia" && (temOco || temProb)) return false;
    if (status === "com_ocorrencia" && !temOco) return false;
    if (status === "com_problema_operacional" && !temProb) return false;
    if (status === "com_ambos" && !(temOco && temProb)) return false;

    return true;
  });

  atualizarTodasAsViews();
}

function limparFiltrosTorre() {
  if (!estaNaTorreControle()) return;
  FILTROS_ENTREGA_IDS.concat(FILTROS_TORRE_EXTRA_IDS).forEach((id) => {
    const el = $(id);
    if (el) el.value = "";
  });
  if (typeof window.multiSelectLimparTudo === "function") {
    window.multiSelectLimparTudo();
  }

  ocorrenciasFiltradasTorre = [];
  atualizarTodasAsViews(); // já re-renderiza os complementos da Torre
}

function inicializarFiltrosTorre() {
  if (!estaNaTorreControle() || filtrosTorreInicializados) return;
  const btnA = $("btnAplicarFiltrosTorre"),
    btnL = $("btnLimparFiltrosTorre");
  if (btnA) btnA.onclick = aplicarFiltrosTorre;
  if (btnL) btnL.onclick = limparFiltrosTorre;
  FILTROS_ENTREGA_IDS.forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener("change", aplicarFiltrosTorre);
  });
  // Filtros próprios da seção de Atrasos na Saída: não filtram entregas,
  // só re-renderizam os complementos da Torre.
  FILTROS_TORRE_COMPLEMENTOS_IDS.forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener("change", _rerenderComplementosTorre);
  });
  filtrosTorreInicializados = true;
}

async function carregarTorre() {
  await carregarHistorico();
}

// ================================================================
// 8. DASHBOARD
// ================================================================
function setDashPeriodo(p) {
  _dashPeriodo = p;
  document.querySelectorAll(".dash-periodo-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.periodo === p);
  });
  atualizarDashboard();
}

function _filtrarDashPeriodo(lista) {
  if (_dashPeriodo === "tudo") return lista;
  const hoje = hojeISO();
  if (_dashPeriodo === "hoje") {
    return lista.filter((o) => {
      const d = String(o.data_ocorrencia || o.data || "").split("T")[0];
      return d === hoje;
    });
  }
  if (_dashPeriodo === "semana") {
    const d7 = new Date();
    d7.setDate(d7.getDate() - 6);
    const ini = d7.toISOString().split("T")[0];
    return lista.filter((o) => {
      const d = String(o.data_ocorrencia || o.data || "").split("T")[0];
      return d >= ini && d <= hoje;
    });
  }
  if (_dashPeriodo === "mes") {
    const ini = hoje.slice(0, 7) + "-01";
    return lista.filter((o) => {
      const d = String(o.data_ocorrencia || o.data || "").split("T")[0];
      return d >= ini && d <= hoje;
    });
  }
  return lista;
}

function atualizarDashboard() {
  const entregas = _filtrarDashPeriodo(obterOcorrenciasAtivas());
  const totalEntregas = entregas.length;
  const comOco = entregas.filter((o) => o.teve_ocorrencia).length;
  const semOco = totalEntregas - comOco;
  const taxa =
    totalEntregas === 0 ? 0 : Math.round((semOco / totalEntregas) * 100);
  const pctCom =
    totalEntregas === 0 ? 0 : Math.round((comOco / totalEntregas) * 100);

  const set = (id, v) => {
    const el = $(id);
    if (el) el.innerText = v;
  };
  set("totalEntregas", totalEntregas);
  set("entregasSem", semOco);
  set("entregasCom", comOco);
  set("taxaSucesso", taxa + "%");

  const entregasComSla = entregas.filter((o) =>
    ["Conforme", "Nao conforme"].includes(o.otif_status),
  );
  const conformesOtif = entregasComSla.filter(
    (o) => o.otif_status === "Conforme",
  ).length;
  const pctOtif =
    entregasComSla.length > 0
      ? Math.round((conformesOtif / entregasComSla.length) * 100)
      : 0;
  const podConfirmados = entregas.filter(
    (o) => o.pod_status === "Confirmado",
  ).length;
  const pctPod =
    totalEntregas > 0 ? Math.round((podConfirmados / totalEntregas) * 100) : 0;
  const custoTotal = entregas.reduce(
    (soma, o) => soma + (Number(o.custo_total) || 0),
    0,
  );
  const tratativasAbertas = entregas.filter((o) =>
    ["Aberta", "Em analise"].includes(o.ocorrencia_status),
  ).length;
  set("kpiOtif", pctOtif + "%");
  set("kpiPodConfirmado", pctPod + "%");
  set("kpiCustoTotal", formatarMoeda(custoTotal));
  set("kpiOcorrenciasAbertas", tratativasAbertas);
  const subOtif = $("subOtif");
  const subPod = $("subPodConfirmado");
  if (subOtif)
    subOtif.textContent =
      entregasComSla.length > 0
        ? `${conformesOtif} de ${entregasComSla.length} avaliadas`
        : "sem entregas avaliadas";
  if (subPod)
    subPod.textContent = `${podConfirmados} de ${totalEntregas} entregas`;

  const subTotal = $("subTotal"),
    subSem = $("subSem"),
    subCom = $("subCom"),
    subTaxa = $("subTaxa");
  if (subTotal) subTotal.textContent = `${totalEntregas} entregas`;
  if (subSem)
    subSem.textContent = totalEntregas > 0 ? `${taxa}% das entregas` : "— %";
  if (subCom)
    subCom.textContent = totalEntregas > 0 ? `${pctCom}% das entregas` : "— %";
  if (subTaxa) {
    subTaxa.textContent = taxa >= 90 ? "✓ meta atingida" : "meta: 90%";
    subTaxa.style.color = taxa >= 90 ? "var(--verde)" : "var(--roxo)";
  }

  const CIRC = 226.2;
  const animRing = (id, pct) => {
    const el = $(id);
    if (el)
      el.style.strokeDashoffset = CIRC - (CIRC * Math.min(pct, 100)) / 100;
  };
  requestAnimationFrame(() => {
    animRing("ringTotal", totalEntregas > 0 ? 100 : 0);
    animRing("ringSem", taxa);
    animRing("ringCom", pctCom);
    animRing("ringTaxa", taxa);
  });

  const comTempo = entregas.filter((o) => Number(o.permanencia_minutos) > 0);
  const media =
    comTempo.length > 0
      ? Math.round(
          comTempo.reduce((a, o) => a + Number(o.permanencia_minutos), 0) /
            comTempo.length,
        )
      : 0;
  const elMedia = $("tempoMedioGlobal");
  if (elMedia) elMedia.innerText = media + "min";
}

// ================================================================
// Análise Visual comparativa (período atual × anterior) — vive na
// aba Tendências. Segue o filtro único de período (tendenciaPeriodo):
// Dia/Semana/Mês definem o período atual e o equivalente anterior.
// ================================================================

// Calcula o intervalo atual e o anterior equivalente conforme a granularidade.
// baseISO ancora o "período atual" (default = hoje).
function _avPeriodos(gran, baseISO) {
  const base = baseISO || hojeISO();
  const msDia = 86400000;
  const mk = (iso) => new Date(iso + "T00:00:00Z");
  const fmt = (d) => d.toISOString().split("T")[0];
  const dmy = (iso) => {
    const [, m, d] = iso.split("-");
    return `${d}/${m}`;
  };
  const MESES = [
    "jan", "fev", "mar", "abr", "mai", "jun",
    "jul", "ago", "set", "out", "nov", "dez",
  ];

  if (gran === "dia") {
    const ontem = fmt(new Date(mk(base).getTime() - msDia));
    return {
      atualIni: base, atualFim: base,
      antIni: ontem, antFim: ontem,
      rotuloAtual: dmy(base), rotuloAnt: dmy(ontem),
    };
  }
  if (gran === "semana") {
    const hoje = mk(base);
    const dow = (hoje.getUTCDay() + 6) % 7; // 0 = segunda-feira
    const seg = new Date(hoje.getTime() - dow * msDia);
    const dom = new Date(seg.getTime() + 6 * msDia);
    const segAnt = new Date(seg.getTime() - 7 * msDia);
    const domAnt = new Date(seg.getTime() - msDia);
    return {
      atualIni: fmt(seg), atualFim: fmt(dom),
      antIni: fmt(segAnt), antFim: fmt(domAnt),
      rotuloAtual: `${dmy(fmt(seg))}–${dmy(fmt(dom))}`,
      rotuloAnt: `${dmy(fmt(segAnt))}–${dmy(fmt(domAnt))}`,
    };
  }
  // mês
  const [ay, am] = base.split("-").map(Number);
  const fmtU = (d) => d.toISOString().split("T")[0];
  const primAtual = new Date(Date.UTC(ay, am - 1, 1));
  const ultAtual = new Date(Date.UTC(ay, am, 0));
  const primAnt = new Date(Date.UTC(ay, am - 2, 1));
  const ultAnt = new Date(Date.UTC(ay, am - 1, 0));
  const anoAnt = am - 1 < 1 ? ay - 1 : ay;
  return {
    atualIni: fmtU(primAtual), atualFim: fmtU(ultAtual),
    antIni: fmtU(primAnt), antFim: fmtU(ultAnt),
    rotuloAtual: `${MESES[am - 1]}/${ay}`,
    rotuloAnt: `${MESES[(am - 2 + 12) % 12]}/${anoAnt}`,
  };
}

// Plugin local: escreve a variação % acima da barra do período atual (dataset 0).
function _avPluginDelta(atualVals, antVals, inverso) {
  return {
    id: "avDelta",
    afterDatasetsDraw(chart) {
      const meta = chart.getDatasetMeta(0);
      if (!meta || meta.hidden) return;
      const ctx = chart.ctx;
      ctx.save();
      ctx.font = "800 10px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      meta.data.forEach((bar, i) => {
        const a = Number(atualVals[i]) || 0;
        const b = Number(antVals[i]) || 0;
        let txt = "";
        let cor = "#64748b";
        if (b <= 0) {
          txt = a > 0 ? "novo" : "";
        } else {
          const v = ((a - b) / b) * 100;
          const subiu = v > 0;
          const neutro = Math.abs(v) < 0.05;
          const bom = neutro ? null : inverso ? !subiu : subiu;
          cor = neutro
            ? "#64748b"
            : bom
              ? TEND_CORES.verde
              : TEND_CORES.vermelho;
          txt = `${neutro ? "→" : subiu ? "▲" : "▼"} ${Math.abs(v).toFixed(0)}%`;
        }
        if (txt) {
          ctx.fillStyle = cor;
          ctx.fillText(txt, bar.x, bar.y - 4);
        }
      });
      ctx.restore();
    },
  };
}

function renderizarAnaliseVisualComparativa() {
  if (typeof Chart === "undefined") return;
  if (!$("graficoAvRotas")) return; // markup ausente

  const fRota = getVal("tendFiltroRota");
  const dataDe = (o) => String(o.data_ocorrencia || o.data || "").split("T")[0];
  const passaRota = (o) => !fRota || obterRotaDaOcorrencia(o) === fRota;

  const ativas = obterOcorrenciasAtivas();
  const avulsas = obterAvulsasParaGraficos(false);

  // Âncora = data mais recente (não futura) presente nos dados. Evita
  // comparar contra um período vazio quando o mês corrente ainda não começou.
  const hojeStr = hojeISO();
  let maxData = "";
  ativas.concat(avulsas).forEach((o) => {
    if (!passaRota(o)) return;
    const d = dataDe(o);
    if (d && d <= hojeStr && d > maxData) maxData = d;
  });

  const per = _avPeriodos(tendenciaPeriodo, maxData || hojeStr);
  const lbl = $("avComparePeriodos");
  if (lbl) lbl.textContent = `${per.rotuloAtual}  ×  ${per.rotuloAnt}`;

  const noPeriodo = (lista, ini, fim) =>
    lista.filter((o) => {
      const d = dataDe(o);
      if (!d || d < ini || d > fim) return false;
      return passaRota(o);
    });

  const entAtual = noPeriodo(ativas, per.atualIni, per.atualFim);
  const entAnt = noPeriodo(ativas, per.antIni, per.antFim);
  const avAtual = noPeriodo(avulsas, per.atualIni, per.atualFim);
  const avAnt = noPeriodo(avulsas, per.antIni, per.antFim);

  const vazio = $("avVazio");
  if (vazio) {
    const semDados =
      !entAtual.length && !entAnt.length && !avAtual.length && !avAnt.length;
    vazio.style.display = semDados ? "block" : "none";
  }

  // ---- helpers de agregação ----
  const contar = (lista, keyFn) => {
    const m = {};
    lista.forEach((o) => {
      const k = keyFn(o);
      if (k == null || k === "") return;
      m[k] = (m[k] || 0) + 1;
    });
    return m;
  };
  // top N categorias pelo valor atual -> [labels, atualVals, antVals]
  const alinhar = (mapaAtual, mapaAnt, n) => {
    const labels = Object.keys(mapaAtual)
      .sort((a, b) => mapaAtual[b] - mapaAtual[a])
      .slice(0, n);
    return [
      labels,
      labels.map((l) => mapaAtual[l] || 0),
      labels.map((l) => mapaAnt[l] || 0),
    ];
  };

  const optBarra = () => {
    const opt = _tendOpcoesBase();
    opt.scales.y.ticks.precision = 0;
    opt.scales.y.grace = "16%";
    return opt;
  };
  const DS_ATUAL = {
    label: "Atual",
    backgroundColor: "rgba(56,189,248,0.30)",
    borderColor: "#38bdf8",
    borderWidth: 1.5,
    borderRadius: 4,
  };
  const DS_ANT = {
    label: "Anterior",
    backgroundColor: "rgba(148,163,184,0.20)",
    borderColor: "#94a3b8",
    borderWidth: 1.5,
    borderRadius: 4,
  };
  const construir = (chartAntigo, canvasId, labels, a, b, inverso, sufixo) => {
    if (chartAntigo) chartAntigo.destroy();
    const opt = optBarra();
    if (sufixo) {
      opt.plugins.tooltip = {
        callbacks: {
          label: (c) => `${c.dataset.label}: ${c.parsed.y}${sufixo}`,
        },
      };
    }
    return new Chart($(canvasId), {
      type: "bar",
      data: {
        labels,
        datasets: [
          { ...DS_ATUAL, data: a },
          { ...DS_ANT, data: b },
        ],
      },
      options: opt,
      plugins: [_avPluginDelta(a, b, inverso)],
    });
  };

  // ---- 1. Entregas por rota (mais entregas = melhor) ----
  {
    const [labels, a, b] = alinhar(
      contar(entAtual, obterRotaDaOcorrencia),
      contar(entAnt, obterRotaDaOcorrencia),
      12,
    );
    _chartRotas = construir(_chartRotas, "graficoAvRotas", labels, a, b, false);
  }

  // ---- helper: série temporal (dia a dia) alinhada ao período ----
  // Reparte duas listas nos mesmos buckets (dias da semana ou dias do mês)
  // para as linhas de evolução — atual e anterior compartilham os rótulos.
  const montarEvolucao = (listaA, listaB) => {
    if (tendenciaPeriodo === "semana") {
      const labels = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
      const serieA = new Array(7).fill(0);
      const serieB = new Array(7).fill(0);
      const idxDia = (iso) =>
        (new Date(iso + "T00:00:00Z").getUTCDay() + 6) % 7;
      listaA.forEach((o) => serieA[idxDia(dataDe(o))]++);
      listaB.forEach((o) => serieB[idxDia(dataDe(o))]++);
      return { labels, serieA, serieB };
    }
    const diasA = Number(per.atualFim.split("-")[2]);
    const diasB = Number(per.antFim.split("-")[2]);
    const nDias = Math.max(diasA, diasB);
    const labels = Array.from({ length: nDias }, (_, i) => String(i + 1));
    const serieA = new Array(nDias).fill(0);
    const serieB = new Array(nDias).fill(0);
    listaA.forEach((o) => {
      const dia = Number(dataDe(o).split("-")[2]);
      if (dia >= 1 && dia <= nDias) serieA[dia - 1]++;
    });
    listaB.forEach((o) => {
      const dia = Number(dataDe(o).split("-")[2]);
      if (dia >= 1 && dia <= nDias) serieB[dia - 1]++;
    });
    return { labels, serieA, serieB };
  };

  // ---- 2. Evolução no período (dia a dia) ----
  const cardEvol = $("avCardEvolucao");
  if (tendenciaPeriodo === "dia") {
    // um único dia não tem evolução útil -> oculta o card
    if (cardEvol) cardEvol.style.display = "none";
    if (_chartDias) {
      _chartDias.destroy();
      _chartDias = null;
    }
  } else {
    if (cardEvol) cardEvol.style.display = "";
    const { labels: labelsEvol, serieA, serieB } = montarEvolucao(
      entAtual,
      entAnt,
    );
    if (_chartDias) _chartDias.destroy();
    const optEvol = _tendOpcoesBase();
    optEvol.scales.y.ticks.precision = 0;
    _chartDias = new Chart($("graficoAvEvolucao"), {
      type: "line",
      data: {
        labels: labelsEvol,
        datasets: [
          {
            label: `Atual (${per.rotuloAtual})`,
            data: serieA,
            borderColor: "#38bdf8",
            backgroundColor: "rgba(56,189,248,0.12)",
            borderWidth: 2.5,
            tension: 0.3,
            pointRadius: 2,
            fill: true,
          },
          {
            label: `Anterior (${per.rotuloAnt})`,
            data: serieB,
            borderColor: "#94a3b8",
            backgroundColor: "transparent",
            borderWidth: 2,
            borderDash: [6, 4],
            tension: 0.3,
            pointRadius: 2,
            fill: false,
          },
        ],
      },
      options: optEvol,
    });
  }

  // ---- 2b. Evolução de acertos (entregas SEM ocorrência) ----
  // "Acerto" = entrega concluída sem nenhuma ocorrência registrada.
  // Mesma leitura da evolução geral, mas só a linha verde do que deu certo.
  const cardAcertos = $("avCardAcertos");
  {
    const semOco = (o) => !o.teve_ocorrencia && !o.tipo_problema;
    const acertosAtual = entAtual.filter(semOco);
    const acertosAnt = entAnt.filter(semOco);
    if (tendenciaPeriodo === "dia") {
      // um único dia não tem evolução útil -> mostra o total do dia
      if (cardAcertos) cardAcertos.style.display = "none";
      if (_chartAcertos) {
        _chartAcertos.destroy();
        _chartAcertos = null;
      }
    } else {
      if (cardAcertos) cardAcertos.style.display = "";
      const { labels, serieA, serieB } = montarEvolucao(
        acertosAtual,
        acertosAnt,
      );
      const totAtual = serieA.reduce((s, n) => s + n, 0);
      const totAnt = serieB.reduce((s, n) => s + n, 0);
      const elTot = $("avAcertosTotal");
      if (elTot) {
        const delta =
          totAnt > 0
            ? Math.round(((totAtual - totAnt) / totAnt) * 100)
            : totAtual > 0
              ? null
              : 0;
        const seta =
          delta == null ? "novo" : delta > 0 ? `▲ ${delta}%` : delta < 0 ? `▼ ${Math.abs(delta)}%` : "→ 0%";
        const cor = delta == null || delta > 0 ? "#34d399" : delta < 0 ? "#f87171" : "#64748b";
        elTot.innerHTML = `${totAtual} acertos <span style="color:${cor};font-weight:800;">${seta}</span> <span style="color:var(--text-muted);font-weight:600;">vs ${totAnt} ant.</span>`;
      }
      if (_chartAcertos) _chartAcertos.destroy();
      const optAcertos = _tendOpcoesBase();
      optAcertos.scales.y.ticks.precision = 0;
      _chartAcertos = new Chart($("graficoAvAcertos"), {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label: `Acertos (${per.rotuloAtual})`,
              data: serieA,
              borderColor: "#34d399",
              backgroundColor: "rgba(52,211,153,0.14)",
              borderWidth: 2.5,
              tension: 0.3,
              pointRadius: 2,
              fill: true,
            },
            {
              label: `Anterior (${per.rotuloAnt})`,
              data: serieB,
              borderColor: "#94a3b8",
              backgroundColor: "transparent",
              borderWidth: 2,
              borderDash: [6, 4],
              tension: 0.3,
              pointRadius: 2,
              fill: false,
            },
          ],
        },
        options: optAcertos,
      });
    }
  }

  // ---- 3. Tipos de problema (PIZZA clicável — distribuição GERAL) ----
  {
    // Distribuição GERAL (todas as datas), NÃO o período curto: numa semana
    // magra apareciam só 1-2 tipos. Cada fatia abre os registros por trás.
    const listaAtual = ativas.filter((o) => o.teve_ocorrencia).concat(avulsas);
    // tipo_problema é MULTIVALOR ("Atraso, Caixa não bipada"): separa por
    // vírgula/; /| e conta cada tipo individualmente, senão os tipos que
    // sempre vêm combinados nunca apareceriam como fatia própria.
    const mapaTipos = {};
    listaAtual.forEach((o) => {
      const bruto = String(o.tipo_problema || "").trim();
      if (!bruto) {
        mapaTipos["Não informado"] = (mapaTipos["Não informado"] || 0) + 1;
        return;
      }
      bruto
        .split(/,|;|\|/)
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((t) => {
          mapaTipos[t] = (mapaTipos[t] || 0) + 1;
        });
    });
    const ordCompleta = Object.entries(mapaTipos).sort((x, y) => y[1] - x[1]);
    const PALETA_TIPOS = [
      "#38bdf8", "#a78bfa", "#34d399", "#fb923c", "#f87171",
      "#facc15", "#22d3ee", "#f472b6", "#94a3b8", "#4ade80",
      "#c084fc", "#fbbf24", "#60a5fa", "#fca5a5", "#2dd4bf",
    ];
    // Mostra os 14 tipos mais frequentes; agrupa a cauda rara numa fatia
    // cinza "Tipos raros" (senão a rosca vira ~25 fatias finíssimas).
    // tiposRaros guarda os nomes agrupados p/ o clique abrir esses registros.
    const TOP_TIPOS = 14;
    const COR_RARO = "#64748b";
    let ord = ordCompleta;
    let tiposRaros = null;
    if (ordCompleta.length > TOP_TIPOS) {
      const cabeca = ordCompleta.slice(0, TOP_TIPOS);
      const cauda = ordCompleta.slice(TOP_TIPOS);
      tiposRaros = new Set(cauda.map(([t]) => t));
      const somaCauda = cauda.reduce((s, [, v]) => s + v, 0);
      ord = cabeca.concat([[`Tipos raros (${cauda.length})`, somaCauda]]);
    }
    if (_chartTipos) _chartTipos.destroy();
    if (ord.length) {
      _chartTipos = new Chart($("graficoAvTipos"), {
        type: "doughnut",
        data: {
          labels: ord.map(([t]) => t),
          datasets: [
            {
              data: ord.map(([, v]) => v),
              backgroundColor: ord.map((_, i) =>
                tiposRaros && i === ord.length - 1
                  ? COR_RARO
                  : PALETA_TIPOS[i % PALETA_TIPOS.length],
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
            const idx = els[0].index;
            // fatia agrupada: abre todos os registros dos tipos raros
            if (tiposRaros && idx === ord.length - 1) {
              const registros = listaAtual.filter((o) =>
                String(o.tipo_problema || "")
                  .split(/,|;|\|/)
                  .map((s) => s.trim())
                  .some((t) => tiposRaros.has(t)),
              );
              if (typeof abrirModalOcorrenciasLista === "function")
                abrirModalOcorrenciasLista("Tipos raros", registros);
              return;
            }
            const tipo = ord[idx][0];
            if (typeof abrirModalOcorrenciasTipo === "function")
              abrirModalOcorrenciasTipo(tipo, listaAtual);
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
            tooltip: {
              callbacks: {
                label: (c) => {
                  const tot =
                    c.dataset.data.reduce((s, n) => s + n, 0) || 1;
                  const pct = Math.round((c.parsed / tot) * 100);
                  return ` ${c.label}: ${c.parsed} (${pct}%)`;
                },
              },
            },
          },
        },
      });
    } else {
      _chartTipos = null;
    }
  }

  // ---- 4. Ocorrências por responsável (mais = pior) ----
  {
    const respKey = (o) =>
      String(o.ocorrencia_responsavel || "").trim() || "Não informado";
    const mapaA = contar(
      entAtual.filter((o) => o.teve_ocorrencia).concat(avAtual),
      respKey,
    );
    const mapaB = contar(
      entAnt.filter((o) => o.teve_ocorrencia).concat(avAnt),
      respKey,
    );
    const [labels, a, b] = alinhar(mapaA, mapaB, 10);
    _chartResponsavel = construir(
      _chartResponsavel,
      "graficoAvResp",
      labels,
      a,
      b,
      true,
    );
  }

  // ---- 5. Tempo médio de permanência por rota (mais = pior) ----
  {
    const mediaPorRota = (lista) => {
      const m = {};
      lista.forEach((o) => {
        const min = Number(o.permanencia_minutos);
        if (!min || min <= 0) return;
        const r = obterRotaDaOcorrencia(o);
        if (!m[r]) m[r] = { soma: 0, qtd: 0 };
        m[r].soma += min;
        m[r].qtd++;
      });
      const out = {};
      Object.entries(m).forEach(
        ([r, v]) => (out[r] = Math.round(v.soma / v.qtd)),
      );
      return out;
    };
    const [labels, a, b] = alinhar(
      mediaPorRota(entAtual),
      mediaPorRota(entAnt),
      12,
    );
    _chartTempoRota = construir(
      _chartTempoRota,
      "graficoAvTempo",
      labels,
      a,
      b,
      true,
      " min",
    );
  }
}

function renderizarEquipesHoje() {
  const el = $("equipesHojeContainer");
  if (!el) return;
  const hoje = hojeISO();
  const escalas = lerStorage("entregasDia").filter(
    (e) => (e.data || "").split("T")[0] === hoje,
  );
  if (escalas.length === 0) {
    el.innerHTML = `<p style="color:var(--text-muted);padding:8px 0;">Nenhuma equipe escalada para hoje.</p>`;
    return;
  }
  el.innerHTML =
    `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;">` +
    escalas
      .map((e) => {
        const missao =
          e.missao && e.missao !== "Principal"
            ? ` <span style="font-size:10px;background:rgba(167,139,250,0.15);color:#a78bfa;border-radius:8px;padding:1px 7px;">${escapar(e.missao)}</span>`
            : "";
        const aju = e.ajudantes
          ? `<div style="color:var(--text-muted);font-size:11px;margin-top:4px;">Aj: ${escapar(e.ajudantes)}</div>`
          : "";
        return `<div class="card" style="padding:12px 14px;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text-muted);">${escapar(e.rota || "")}${missao}</div>
        <div style="font-weight:700;margin-top:4px;color:var(--text-heading);">${escapar(e.motorista || "")}</div>
        ${aju}
        ${e.placa ? `<div style="color:var(--text-muted);font-size:11px;margin-top:2px;">🚗 ${escapar(e.placa)}</div>` : ""}
      </div>`;
      })
      .join("") +
    `</div>`;
}

function atualizarMonitoramento() {
  const painel = $("painelMonitoramento");
  if (!painel) return;
  const base = [...obterOcorrenciasAtivas()].sort((a, b) => {
    const dA = (a.data_ocorrencia || "") + " " + (a.hora_chegada || "00:00");
    const dB = (b.data_ocorrencia || "") + " " + (b.hora_chegada || "00:00");
    return dB.localeCompare(dA);
  });
  painel.innerHTML =
    base.length === 0
      ? `<p style="grid-column:1/-1;text-align:center;color:var(--text-muted);padding:20px;">Nenhum registro encontrado no radar.</p>`
      : base
          .slice(0, 16)
          .map(
            (o) => `
      <div class="card-monitor ${o.teve_ocorrencia ? "status-alerta" : "status-ok"}">
        <div class="badge-pulso ${o.teve_ocorrencia ? "pulso-vermelho" : "pulso-verde"}"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="font-size:10px;color:var(--text-muted);font-weight:bold;background:var(--bg-base);padding:2px 7px;border-radius:var(--r-sm);border:1px solid var(--border);">${formatarDataBR(o.data_ocorrencia)}</span>
          <span style="font-size:10px;color:var(--azul);font-weight:bold;">${o.hora_chegada || "--:--"}</span>
        </div>
        <h3 style="margin:0;font-size:0.95rem;color:var(--text-heading);">${rotuloLoja(o.loja)}</h3>
        <p style="font-size:0.83rem;margin:5px 0;color:var(--text-secondary);">🚛 <b>${o.motorista || "-"}</b></p>
        <div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border);">
          <p style="color:${o.teve_ocorrencia ? "var(--vermelho)" : "var(--verde)"};font-weight:bold;font-size:0.83rem;margin:0;">
            ${o.teve_ocorrencia ? "⚠️ " + o.tipo_problema : "✅ CONCLUÍDO"}
          </p>
          ${o.problema_operacional_tipo ? `<p style="margin-top:5px;color:var(--amarelo);font-weight:bold;font-size:0.78rem;">🚧 ${o.problema_operacional_tipo}</p>` : ""}
        </div>
        <div style="margin-top:10px;">
          <button onclick="excluirOcorrencia(${o.id})" class="btn-red btn-sm">🗑️</button>
        </div>
      </div>`,
          )
          .join("");
}

function atualizarDashboardOcorrencias() {
  const container = $("dashboardOcorrencias");
  if (!container) return;
  const tipos = {};
  const contar = (o) => {
    if (o.tipo_problema)
      tipos[o.tipo_problema] = (tipos[o.tipo_problema] || 0) + 1;
  };
  obterOcorrenciasAtivas().forEach(contar);
  obterAvulsasParaGraficos(false).forEach(contar);

  const ordenados = Object.entries(tipos).sort((a, b) => b[1] - a[1]);
  if (ordenados.length === 0) {
    container.innerHTML = `<p class="ac-empty">Nenhuma ocorrência registrada.</p>`;
    return;
  }

  const TOP = 7;
  const visiveis = ordenados.slice(0, TOP);
  const maxQ = visiveis[0][1] || 1;
  let html = visiveis
    .map(
      ([t, q]) => `
      <div class="ac-ocorr-item">
        <span class="ac-ocorr-num">${q}</span>
        <span class="ac-ocorr-tipo">${escapar(t)}</span>
        <div class="ac-ocorr-bar-wrap">
          <div class="ac-ocorr-bar-fill" style="width:${Math.round((q / maxQ) * 100)}%"></div>
        </div>
      </div>`,
    )
    .join("");

  const restoTipos = ordenados.length - visiveis.length;
  if (restoTipos > 0) {
    const restoQtd = ordenados.slice(TOP).reduce((soma, [, q]) => soma + q, 0);
    html += `<div class="ac-ocorr-mais">+ ${restoTipos} outro${restoTipos > 1 ? "s" : ""} tipo${restoTipos > 1 ? "s" : ""} · ${restoQtd} ocorrência${restoQtd > 1 ? "s" : ""}</div>`;
  }

  container.innerHTML = html;
}

function atualizarDashboardProblemasOperacionais() {
  const container = $("dashboardProblemasOperacionais");
  if (!container) return;
  const tipos = {};
  obterOcorrenciasAtivas().forEach((o) => {
    if (o.problema_operacional_tipo)
      tipos[o.problema_operacional_tipo] =
        (tipos[o.problema_operacional_tipo] || 0) + 1;
  });
  container.innerHTML =
    Object.keys(tipos).length === 0
      ? `<p style="color:var(--text-muted);">Nenhum problema operacional registrado.</p>`
      : Object.entries(tipos)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([t, q]) => `<div class="card"><h2>${q}</h2><p>${t}</p></div>`)
          .join("");
}

// ================================================================
// Tela cheia por gráfico (botão ⛶ em cada card da aba Tendências)
// ================================================================
// Cada card segue o padrão <div card> > <p título> + <div relative> <canvas>.
// Injetamos um botão que coloca AQUELE card em tela cheia via Fullscreen API;
// o CSS (.av-chart-card:fullscreen) estica o corpo e o Chart.js redimensiona
// sozinho. Idempotente: pode ser chamado quantas vezes quiser.
function instalarFullscreenGraficos() {
  const aba = document.getElementById("aba-tendencias");
  if (!aba) return;
  aba.querySelectorAll("canvas").forEach((cv) => {
    const body = cv.parentElement; // wrapper position:relative height:XXX
    if (!body) return;
    const card = body.parentElement; // card
    if (!card || card.dataset.fsReady) return;
    card.dataset.fsReady = "1";
    card.classList.add("av-chart-card");
    body.classList.add("av-chart-body");
    if (getComputedStyle(card).position === "static")
      card.style.position = "relative";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "av-fs-btn";
    btn.title = "Tela cheia";
    btn.setAttribute("aria-label", "Tela cheia");
    btn.textContent = "⛶";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (document.fullscreenElement === card) document.exitFullscreen?.();
      else if (card.requestFullscreen) card.requestFullscreen().catch(() => {});
    });
    card.appendChild(btn);
  });
}

document.addEventListener("fullscreenchange", () => {
  const fsEl = document.fullscreenElement;
  document.querySelectorAll(".av-fs-btn").forEach((b) => {
    const ativa = fsEl && b.parentElement === fsEl;
    b.textContent = ativa ? "🗕" : "⛶";
    b.title = ativa ? "Sair da tela cheia (Esc)" : "Tela cheia";
  });
  // Redimensiona o gráfico que entrou/saiu de tela cheia (safety net).
  const cards = fsEl
    ? [fsEl]
    : Array.from(document.querySelectorAll(".av-chart-card"));
  cards.forEach((card) => {
    const cv = card.querySelector && card.querySelector("canvas");
    if (cv && typeof Chart !== "undefined" && Chart.getChart) {
      const ch = Chart.getChart(cv);
      if (ch) requestAnimationFrame(() => ch.resize());
    }
  });
});

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", instalarFullscreenGraficos);
else instalarFullscreenGraficos();
