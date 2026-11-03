// ================================================================
// 26. INICIALIZAÇÃO
// ================================================================
document.addEventListener("DOMContentLoaded", async function () {
  if (window.authReady) await window.authReady;
  if (!window.authUsuario) return;
  if (sistemaInicializado) return;
  sistemaInicializado = true;

  atualizarRelogio();
  _observarMudancaDPR();

  document
    .querySelectorAll('input[type="checkbox"][data-multi-group]')
    .forEach((c) => {
      c.autocomplete = "off";
      c.checked = false;
    });

  const selLoja = $("loja");
  if (selLoja) {
    selLoja.innerHTML = '<option value="">Selecione</option>';
    Object.keys(lojasRotas).forEach((l) => {
      selLoja.innerHTML += `<option value="${l}">${formatarNomeLoja(l)}</option>`;
    });
  }

  popularSelectAvisoRota();

  const campoData = $("dataOcorrencia");
  if (campoData) campoData.value = new Date().toISOString().split("T")[0];

  const cdData = $("dataOcorrencia");
  const cdPlaca = $("placa");
  if (cdData) cdData.addEventListener("change", atualizarBlocoStatusChecklist);
  if (cdPlaca)
    cdPlaca.addEventListener("change", atualizarBlocoStatusChecklist);

  const escalaDataEl = $("escalaData");
  if (escalaDataEl && !escalaDataEl.value)
    escalaDataEl.value = new Date().toISOString().split("T")[0];
  const escalaFiltroEl = $("escalaFiltroData");
  if (escalaFiltroEl && !escalaFiltroEl.value)
    escalaFiltroEl.value = new Date().toISOString().split("T")[0];
  renderizarListaEscalas();

  inicializarTodosMultiChecks();
  inicializarLinkSaidaFabricaOcorrencia();

  ["retiradaCxPrevista", "retiradaCxRealizada"].forEach((id) =>
    $(id)?.addEventListener("input", atualizarDivergenciaCx),
  );
  ["retiradaRtPrevista", "retiradaRtRealizada"].forEach((id) =>
    $(id)?.addEventListener("input", atualizarDivergenciaRt),
  );
  ["volumeGerencial", "volumeFisico"].forEach((id) =>
    $(id)?.addEventListener("input", atualizarDivergenciaVolume),
  );
  $("transferenciaProblema")?.addEventListener(
    "change",
    toggleTransferenciaRelato,
  );
  $("sacolaStatus")?.addEventListener("change", toggleSacolaRelato);
  $("almoxerifadoStatus")?.addEventListener("change", toggleAlmoxerifadoRelato);
  $("materialEnvioStatus")?.addEventListener("change", toggleMaterialEnvioRelato);
  atualizarDivergenciaCx();
  atualizarDivergenciaRt();
  atualizarDivergenciaVolume();
  toggleTransferenciaRelato();
  toggleSacolaRelato();
  toggleAlmoxerifadoRelato();
  toggleMaterialEnvioRelato();
  if (typeof toggleMaterialRetiradaRelato === "function") toggleMaterialRetiradaRelato();

  if (estaNaTorreControle()) inicializarFiltrosTorre();

  if (authTemPermissao("visualizar_dados")) {
    await carregarHistorico();
  } else {
    SERVER_CACHE[LS.checklist] = await apiStorageGet(LS.checklist).catch(
      () => [],
    );
    SERVER_CACHE.entregasDia = await apiStorageGet("entregasDia").catch(
      () => [],
    );
    renderizarListaChecklistDiario();
    renderizarListaEscalas();
  }

  // A atualização automática periódica é centralizada em admin.js
  // (iniciarAutoRefresh), num único ciclo de 1 minuto para toda a aplicação.
});

// ══ TACÓGRAFO + DIÁRIO DE BORDO (formulário unificado) ═══════════

function abrirFormTacDiario() {
  document.getElementById("formTacDiario").classList.remove("hidden");
  const hoje = new Date().toISOString().split("T")[0];
  if (!document.getElementById("tacdiarioData").value)
    document.getElementById("tacdiarioData").value = hoje;
}
function fecharFormTacDiario() {
  document.getElementById("formTacDiario").classList.add("hidden");
}
function limparFormTacDiario() {
  document.getElementById("tacdiarioData").value = "";
  document.getElementById("tacdiarioMotorista").value = "";
  document.getElementById("tacdiarioPlaca").value = "";
  document
    .querySelectorAll('input[name="tacografoStatus"], input[name="diarioStatus"]')
    .forEach((r) => (r.checked = false));
  document.getElementById("tacografoObs").value = "";
  document.getElementById("diarioObs").value = "";
  document.getElementById("campoTacografoObs").classList.add("hidden");
  document.getElementById("campoDiarioObs").classList.add("hidden");
}
function toggleTacografoObs() {
  const val = document.querySelector(
    'input[name="tacografoStatus"]:checked',
  )?.value;
  const campo = document.getElementById("campoTacografoObs");
  val === "Não devolveu"
    ? campo.classList.remove("hidden")
    : campo.classList.add("hidden");
}
function toggleDiarioObs() {
  const val = document.querySelector(
    'input[name="diarioStatus"]:checked',
  )?.value;
  const campo = document.getElementById("campoDiarioObs");
  val === "Não preencheu"
    ? campo.classList.remove("hidden")
    : campo.classList.add("hidden");
}
async function salvarTacDiario() {
  const data = document.getElementById("tacdiarioData").value;
  const motorista = document.getElementById("tacdiarioMotorista").value;
  const placa = document.getElementById("tacdiarioPlaca").value;
  const statusTac = document.querySelector(
    'input[name="tacografoStatus"]:checked',
  )?.value;
  const statusDia = document.querySelector(
    'input[name="diarioStatus"]:checked',
  )?.value;
  const obsTac = document.getElementById("tacografoObs").value.trim();
  const obsDia = document.getElementById("diarioObs").value.trim();

  if (!data || !motorista || !placa || !statusTac || !statusDia) {
    alertar(
      "Preencha Data, Motorista, Placa e os dois status (Tacógrafo e Diário).",
    );
    return;
  }

  const idBase = Date.now();
  const tacografos = lerStorage(LS.tacografos);
  tacografos.unshift({
    id: idBase,
    data,
    motorista,
    placa,
    status: statusTac,
    obs: obsTac,
  });
  if (!(await salvarStorage(LS.tacografos, tacografos))) return;

  const diarios = lerStorage(LS.diarios);
  diarios.unshift({
    id: idBase + 1,
    data,
    motorista,
    placa,
    status: statusDia,
    obs: obsDia,
  });
  if (!(await salvarStorage(LS.diarios, diarios))) return;

  fecharFormTacDiario();
  limparFormTacDiario();
  renderTacDiario();
}

function renderTacDiario() {
  renderTacografos();
  renderDiarios();
}
function renderTacografos() {
  renderizarTacografosComFiltro(
    getVal("tacdiarioFiltroData") || getVal("veiculosFiltroData"),
  );
}
function renderDiarios() {
  renderizarDiariosComFiltro(
    getVal("tacdiarioFiltroData") || getVal("veiculosFiltroData"),
  );
}
function limparFiltroTacDiario() {
  setVal("tacdiarioFiltroData", "");
  renderTacDiario();
}
async function excluirTacografo(id) {
  if (!(await confirmarBonito("Excluir este registro?", { okLabel: "Excluir", cancelLabel: "Cancelar" }))) return;
  let registros = lerStorage(LS.tacografos);
  registros = registros.filter((r) => r.id !== id);
  if (!(await salvarStorage(LS.tacografos, registros))) return;
  renderTacografos();
}
async function excluirDiario(id) {
  if (!(await confirmarBonito("Excluir este registro?", { okLabel: "Excluir", cancelLabel: "Cancelar" }))) return;
  let registros = lerStorage(LS.diarios);
  registros = registros.filter((r) => r.id !== id);
  if (!(await salvarStorage(LS.diarios, registros))) return;
  renderDiarios();
}

renderTacDiario();

// ================================================================
// SISTEMA DE PONTUAÇÃO — RANKING DE MOTORISTAS
// ================================================================

const MOTORISTAS_LISTA = [
  "RENATO MORAES",
  "SILVIO RAMOS",
  "FABIO NUNES",
  "MAURO DIAS",
  "NELSON PRADO",
  "HUGO TAVARES",
  "TIAGO DE MELO",
  "GILSON REIS",
  "SAMUEL COSTA",
  "CELSO BRITO",
  "EDSON",
  "OTAVIO CRUZ",
  "ANTONIO LUZ",
  "NILTON",
];

function rankingFiltrarPorData(lista, campoFn, dI, dF) {
  return lista.filter((item) => {
    const d = String(campoFn(item) || "").split("T")[0];
    if (dI && d < dI) return false;
    if (dF && d > dF) return false;
    return true;
  });
}

function calcularPontuacaoMotorista(
  motorista,
  dataInicio,
  dataFim,
  rotaFiltro = "",
) {
  const pts = {
    entregaSemOco: {
      label: "Entregas sem ocorrência (informativo, não pontua)",
      valor: 0,
      pontos: 0,
      cor: "var(--text-muted)",
    },
    checklistFeito: {
      label: "Checklists realizados (1/dia)",
      valor: 0,
      pontos: 0,
      cor: "var(--verde)",
    },
    almocoPrazo: {
      label: "Almoços dentro do prazo",
      valor: 0,
      pontos: 0,
      cor: "var(--verde)",
    },
    tacografoDevolveu: {
      label: "Tacógrafos devolvidos",
      valor: 0,
      pontos: 0,
      cor: "var(--verde)",
    },
    diarioPreencheu: {
      label: "Diários de bordo preenchidos",
      valor: 0,
      pontos: 0,
      cor: "var(--verde)",
    },
    saidaNoPrazo: {
      label: "Saídas no horário",
      valor: 0,
      pontos: 0,
      cor: "var(--verde)",
    },
    entregaComOco: {
      label: "Ocorrencias da equipe de entrega",
      valor: 0,
      pontos: 0,
      cor: "var(--vermelho)",
    },
    entregaOcoOutraArea: {
      label: "Ocorrencias de outras areas",
      valor: 0,
      pontos: 0,
      cor: "var(--amarelo)",
    },
    checklistNaoFeito: {
      label: "Dias sem checklist",
      valor: 0,
      pontos: 0,
      cor: "var(--vermelho)",
    },
    almocoExcedido: {
      label: "Almoços excedidos",
      valor: 0,
      pontos: 0,
      cor: "var(--vermelho)",
    },
    tacografoNao: {
      label: "Tacógrafos não devolvidos",
      valor: 0,
      pontos: 0,
      cor: "var(--vermelho)",
    },
    diarioNao: {
      label: "Diários não preenchidos",
      valor: 0,
      pontos: 0,
      cor: "var(--vermelho)",
    },
    saidaAtrasada: {
      label: "Saídas com atraso",
      valor: 0,
      pontos: 0,
      cor: "var(--vermelho)",
    },
    permanenciaExcedida: {
      label: `Descarga acima do limite da loja sem justificativa`,
      valor: 0,
      pontos: 0,
      cor: "var(--vermelho)",
    },
    permanenciaJustificada: {
      label: `Descarga acima do limite da loja justificada (informativo, não pontua)`,
      valor: 0,
      pontos: 0,
      cor: "var(--text-muted)",
    },
  };

  let entregasMot = rankingFiltrarPorData(
    ocorrencias.filter((o) => o.motorista === motorista),
    (o) => o.data_ocorrencia || o.data,
    dataInicio,
    dataFim,
  );
  if (rotaFiltro) {
    entregasMot = entregasMot.filter(
      (o) => obterRotaDaOcorrencia(o) === rotaFiltro,
    );
  }

  entregasMot.forEach((o) => {
    const temOco = !!(o.teve_ocorrencia || o.tipo_problema);
    if (temOco && responsavelEquipeEntrega(obterResponsavelOcorrencia(o))) {
      pts.entregaComOco.valor++;
      pts.entregaComOco.pontos -= 1;
    } else if (temOco) {
      pts.entregaOcoOutraArea.valor++;
    } else {
      // Entrega sem ocorrencia e o comportamento esperado: contamos para
      // exibir o numero, mas nao pontuamos (fora do criterio de ranking).
      pts.entregaSemOco.valor++;
    }

    // Tempo de DESCARGA (inicio -> termino): passou do limite DA LOJA?
    // Usa a mesma tolerancia por loja do alerta (limiteDescargaLoja), nao mais
    // o 40 fixo. Com justificativa preenchida nao despontua (so informativo);
    // sem justificativa, perde 1 ponto. Antes usava a permanencia total.
    if (descargaDaOcorrencia(o) > limiteDescargaLoja(o.loja)) {
      const justificativa = String(o.permanencia_justificativa || "").trim();
      if (justificativa) {
        pts.permanenciaJustificada.valor++;
      } else {
        pts.permanenciaExcedida.valor++;
        pts.permanenciaExcedida.pontos -= 1;
      }
    }
  });

  const checklistsStorage = rankingFiltrarPorData(
    lerStorage(LS.checklist).filter((c) => c.motorista === motorista),
    (c) => c.data,
    dataInicio,
    dataFim,
  );
  const diasComChecklist = new Set(
    checklistsStorage.map((c) => String(c.data || "").split("T")[0]),
  );
  const diasTrabalhados = new Set(
    entregasMot
      .map((o) => String(o.data_ocorrencia || o.data || "").split("T")[0])
      .filter(Boolean),
  );
  diasTrabalhados.forEach((dia) => {
    if (diasComChecklist.has(dia)) {
      pts.checklistFeito.valor++;
      pts.checklistFeito.pontos += 1;
    } else {
      pts.checklistNaoFeito.valor++;
      pts.checklistNaoFeito.pontos -= 1;
    }
  });

  const almocosMot = rankingFiltrarPorData(
    lerStorage(LS.almocos).filter((a) => a.motorista === motorista),
    (a) => a.data,
    dataInicio,
    dataFim,
  );
  almocosMot.forEach((a) => {
    if (a.status === "ok") {
      pts.almocoPrazo.valor++;
      pts.almocoPrazo.pontos += 1;
    } else {
      pts.almocoExcedido.valor++;
      pts.almocoExcedido.pontos -= 1;
    }
  });

  const tacMot = rankingFiltrarPorData(
    lerStorage(LS.tacografos).filter((t) => t.motorista === motorista),
    (t) => t.data,
    dataInicio,
    dataFim,
  );
  tacMot.forEach((t) => {
    if (t.status === "Devolveu") {
      pts.tacografoDevolveu.valor++;
      pts.tacografoDevolveu.pontos += 1;
    } else if (t.status === "Não devolveu") {
      pts.tacografoNao.valor++;
      pts.tacografoNao.pontos -= 1;
    }
  });

  const diarioMot = rankingFiltrarPorData(
    lerStorage(LS.diarios).filter((d) => d.motorista === motorista),
    (d) => d.data,
    dataInicio,
    dataFim,
  );
  diarioMot.forEach((d) => {
    if (d.status === "Preencheu") {
      pts.diarioPreencheu.valor++;
      pts.diarioPreencheu.pontos += 1;
    } else if (d.status === "Não preencheu") {
      pts.diarioNao.valor++;
      pts.diarioNao.pontos -= 1;
    }
  });

  const atrasosMot = rankingFiltrarPorData(
    lerStorage(LS.atrasos).filter((a) => a.motorista === motorista),
    (a) => a.data,
    dataInicio,
    dataFim,
  );
  atrasosMot.forEach((a) => {
    if (Number(a.atrasoMin || 0) > 0) {
      pts.saidaAtrasada.valor++;
      pts.saidaAtrasada.pontos -= 1;
    } else {
      pts.saidaNoPrazo.valor++;
      pts.saidaNoPrazo.pontos += 1;
    }
  });

  const total = Object.values(pts).reduce((s, p) => s + p.pontos, 0);
  const positivos = Object.values(pts)
    .filter((p) => p.pontos > 0)
    .reduce((s, p) => s + p.pontos, 0);
  const negativos = Object.values(pts)
    .filter((p) => p.pontos < 0)
    .reduce((s, p) => s + p.pontos, 0);
  const totalEntregas = entregasMot.length;
  const mediaPorEntrega =
    totalEntregas > 0 ? Math.round((total / totalEntregas) * 100) / 100 : 0;
  const totalRegistros =
    totalEntregas +
    almocosMot.length +
    tacMot.length +
    diarioMot.length +
    atrasosMot.length;

  return {
    motorista,
    pts,
    total,
    positivos,
    negativos,
    totalEntregas,
    totalRegistros,
    mediaPorEntrega,
    rotaFiltro,
  };
}

function popularSelectRotasRanking() {
  const select = document.getElementById("rankingFiltroRota");
  if (!select) return;
  const atual = select.value;
  const rotasUnicas = [
    ...new Set(
      ocorrencias.map((o) => obterRotaDaOcorrencia(o)).filter(Boolean),
    ),
  ].sort();
  select.innerHTML = '<option value="">Todas as rotas</option>';
  rotasUnicas.forEach((r) => {
    select.innerHTML += `<option value="${escapar(r)}"${atual === r ? " selected" : ""}>${escapar(r)}</option>`;
  });
}

function calcularRanking() {
  const dI = document.getElementById("rankingDataInicio")?.value || "";
  const dF = document.getElementById("rankingDataFim")?.value || "";
  const rotaFiltro = document.getElementById("rankingFiltroRota")?.value || "";
  renderizarRanking(dI, dF, rotaFiltro);
}

function limparFiltroRanking() {
  const dI = document.getElementById("rankingDataInicio");
  const dF = document.getElementById("rankingDataFim");
  const rot = document.getElementById("rankingFiltroRota");
  if (dI) dI.value = "";
  if (dF) dF.value = "";
  if (rot) rot.value = "";
  renderizarRanking("", "", "");
}

function renderizarRanking(dI = "", dF = "", rotaFiltro = "") {
  popularSelectRotasRanking();
  const dados = MOTORISTAS_LISTA.map((m) =>
    calcularPontuacaoMotorista(m, dI, dF, rotaFiltro),
  )
    .filter((d) => d.totalEntregas > 0)
    .sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      return b.totalEntregas - a.totalEntregas;
    });
  renderizarPodio(dados);
  renderizarRankingResponsaveis(dI, dF, rotaFiltro);
  renderizarRankingProblemasOperacionais(dI, dF, rotaFiltro);
  renderizarRankingAjudantes(dI, dF, rotaFiltro);
  renderizarGraficosRanking(dados, dI, dF, rotaFiltro);
  renderizarTabelaRanking(dados);
}

// Ranking de ajudantes: cada ajudante que estava numa entrega COM ocorrencia
// soma 1 ponto (conta automatica, nao depende de apontar culpado especifico).
function renderizarRankingAjudantes(dI = "", dF = "", rotaFiltro = "") {
  const el = document.getElementById("rankingAjudantes");
  if (!el) return;

  const mapa = new Map(); // nome -> { nome, com, total }
  ocorrencias.forEach((o) => {
    const data = String(o.data_ocorrencia || o.data || "").split("T")[0];
    if (dI && data < dI) return;
    if (dF && data > dF) return;
    if (rotaFiltro && obterRotaDaOcorrencia(o) !== rotaFiltro) return;
    const ajudantes = extrairAjudantes(o.ajudantes);
    if (ajudantes.length === 0) return;
    const temOco = !!(o.teve_ocorrencia || o.tipo_problema);
    ajudantes.forEach((nome) => {
      const atual = mapa.get(nome) || { nome, com: 0, total: 0 };
      atual.total++;
      if (temOco) atual.com++;
      mapa.set(nome, atual);
    });
  });

  const dados = [...mapa.values()]
    .filter((d) => d.com > 0)
    .sort((a, b) => b.com - a.com || b.total - a.total);
  const maximo = dados.length ? dados[0].com : 0;

  el.innerHTML = `
    <div class="ranking-panel">
      <div class="ranking-panel-head">
        <div>
          <div class="ranking-panel-title">Ranking de ajudantes</div>
          <div class="ranking-panel-subtitle">Ajudantes em entregas com ocorrencia.</div>
        </div>
        <span class="ranking-panel-total">${dados.length} nome(s)</span>
      </div>
      ${
        dados.length === 0
          ? `<p class="ranking-empty">Nenhuma entrega com ocorrencia e ajudante informado no filtro.</p>`
          : `<div class="ranking-mini-list">
              ${dados
                .map((item, index) => {
                  const pct = maximo ? Math.round((item.com / maximo) * 100) : 0;
                  const taxa = item.total
                    ? Math.round((item.com / item.total) * 100)
                    : 0;
                  const cor =
                    index === 0
                      ? "var(--vermelho)"
                      : index === 1
                        ? "#f97316"
                        : index === 2
                          ? "#f59e0b"
                          : "var(--azul)";
                  return `
                    <div class="ranking-mini-card">
                      <div class="ranking-mini-top">
                        <strong>${index + 1}. ${escapar(item.nome)}</strong>
                        <span style="color:${cor};">${item.com}</span>
                      </div>
                      <div class="ranking-bar">
                        <div style="width:${pct}%;background:${cor};"></div>
                      </div>
                      <div class="ranking-mini-meta">${item.com} de ${item.total} entregas (${taxa}%)</div>
                    </div>`;
                })
                .join("")}
            </div>`
      }
    </div>`;
}

// Conta os problemas operacionais (transito, chuva, etc.) aplicando os filtros do ranking.
function contarProblemasOperacionais(dI = "", dF = "", rotaFiltro = "") {
  const mapa = new Map();
  ocorrencias.forEach((o) => {
    const tipo = String(o.problema_operacional_tipo || "").trim();
    if (!tipo) return;

    const data = String(o.data_ocorrencia || o.data || "").split("T")[0];
    if (dI && data < dI) return;
    if (dF && data > dF) return;
    if (rotaFiltro && obterRotaDaOcorrencia(o) !== rotaFiltro) return;

    const chave = tipo.toUpperCase();
    const atual = mapa.get(chave) || { tipo: tipo.toUpperCase(), total: 0 };
    atual.total++;
    mapa.set(chave, atual);
  });
  return [...mapa.values()].sort((a, b) => b.total - a.total);
}

function renderizarRankingProblemasOperacionais(
  dI = "",
  dF = "",
  rotaFiltro = "",
) {
  const el = document.getElementById("rankingProblemasOperacionais");
  if (!el) return;

  const dados = contarProblemasOperacionais(dI, dF, rotaFiltro);
  const total = dados.reduce((s, item) => s + item.total, 0);

  el.innerHTML = `
    <div class="ranking-panel">
      <div class="ranking-panel-head">
        <div>
          <div class="ranking-panel-title">Problemas operacionais</div>
          <div class="ranking-panel-subtitle">Transito, chuva, mecanica e outros. Nao afetam pontos.</div>
        </div>
        <span class="ranking-panel-total">${total} registro(s)</span>
      </div>
      ${
        dados.length === 0
          ? `<p class="ranking-empty">Nenhum problema operacional no filtro.</p>`
          : `<div class="ranking-mini-list">
              ${dados
                .map((item, index) => {
                  const pct = total
                    ? Math.round((item.total / total) * 100)
                    : 0;
                  const cor = "var(--amarelo)";
                  return `
                    <div class="ranking-mini-card">
                      <div class="ranking-mini-top">
                        <strong>${index + 1}. ${escapar(item.tipo)}</strong>
                        <span style="color:${cor};">${item.total}</span>
                      </div>
                      <div class="ranking-bar">
                        <div style="width:${pct}%;background:${cor};"></div>
                      </div>
                      <div class="ranking-mini-meta">${pct}% do total</div>
                    </div>`;
                })
                .join("")}
            </div>`
      }
    </div>`;
}

function renderizarGraficosRanking(dados, dI = "", dF = "", rotaFiltro = "") {
  if (typeof Chart === "undefined") return;

  const eixoCor = "#64748b";
  const gridCor = "rgba(255,255,255,0.05)";
  const optBarras = {
    responsive: true,
    maintainAspectRatio: false,
    indexAxis: "y",
    plugins: {
      legend: {
        labels: { color: "#94a3b8", font: { size: 11 }, boxWidth: 12 },
      },
    },
    scales: {
      x: {
        ticks: { color: eixoCor, font: { size: 10 } },
        grid: { color: gridCor },
      },
      y: {
        ticks: { color: eixoCor, font: { size: 10 } },
        grid: { color: gridCor },
      },
    },
  };
  const PALETA = [
    "#38bdf8",
    "#f87171",
    "#34d399",
    "#f59e0b",
    "#a78bfa",
    "#fb923c",
    "#f472b6",
    "#2dd4bf",
    "#facc15",
    "#60a5fa",
    "#c084fc",
    "#4ade80",
  ];

  // --- Gráfico 1: Pontos ganhos x perdidos (barras empilhadas, top 12) ---
  const canvasPN = document.getElementById("graficoRankingPosNeg");
  if (canvasPN) {
    const topPN = [...dados]
      .sort((a, b) => b.totalRegistros - a.totalRegistros)
      .slice(0, 12);
    if (_chartRkPosNeg) _chartRkPosNeg.destroy();
    _chartRkPosNeg = new Chart(canvasPN, {
      type: "bar",
      data: {
        labels: topPN.map((d) => d.motorista),
        datasets: [
          {
            label: "Pontos ganhos",
            data: topPN.map((d) => d.positivos),
            backgroundColor: "rgba(52,211,153,0.55)",
            borderColor: "#34d399",
            borderWidth: 1,
            borderRadius: 4,
            stack: "pts",
          },
          {
            label: "Pontos perdidos",
            data: topPN.map((d) => Math.abs(d.negativos)),
            backgroundColor: "rgba(248,113,113,0.55)",
            borderColor: "#f87171",
            borderWidth: 1,
            borderRadius: 4,
            stack: "pts",
          },
        ],
      },
      options: {
        ...optBarras,
        scales: {
          x: { ...optBarras.scales.x, stacked: true, beginAtZero: true },
          y: { ...optBarras.scales.y, stacked: true },
        },
      },
    });
  }

  // --- Gráfico 2: Responsáveis pelas ocorrências (rosca, exclui NÃO INFORMADO) ---
  const canvasResp = document.getElementById("graficoRankingResponsaveis");
  if (canvasResp) {
    const mapaResp = new Map();
    ocorrencias.forEach((o) => {
      const temOco = !!(o.teve_ocorrencia || o.tipo_problema);
      if (!temOco) return;
      const data = String(o.data_ocorrencia || o.data || "").split("T")[0];
      if (dI && data < dI) return;
      if (dF && data > dF) return;
      if (rotaFiltro && obterRotaDaOcorrencia(o) !== rotaFiltro) return;
      const r =
        normalizarResponsavelOcorrencia(obterResponsavelOcorrencia(o)) ||
        "NAO INFORMADO";
      if (r === "NAO INFORMADO") return;
      mapaResp.set(r, (mapaResp.get(r) || 0) + 1);
    });
    const respOrd = [...mapaResp.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);

    if (_chartRkResp) _chartRkResp.destroy();
    _chartRkResp = new Chart(canvasResp, {
      type: "doughnut",
      data: {
        labels: respOrd.map(([r]) => r),
        datasets: [
          {
            data: respOrd.map(([, v]) => v),
            backgroundColor: respOrd.map((_, i) => PALETA[i % PALETA.length]),
            borderColor: "rgba(15,23,42,0.6)",
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: "right",
            labels: {
              color: "#94a3b8",
              font: { size: 10 },
              boxWidth: 12,
              padding: 8,
            },
          },
        },
      },
    });
  }

  // --- Gráfico 3: Média de pontos por entrega (barras, cor por sinal) ---
  const canvasMedia = document.getElementById("graficoRankingMedia");
  if (canvasMedia) {
    const topMedia = [...dados]
      .sort((a, b) => b.mediaPorEntrega - a.mediaPorEntrega)
      .slice(0, 12);
    if (_chartRkMedia) _chartRkMedia.destroy();
    _chartRkMedia = new Chart(canvasMedia, {
      type: "bar",
      data: {
        labels: topMedia.map((d) => d.motorista),
        datasets: [
          {
            label: "Média de pontos / entrega",
            data: topMedia.map((d) => d.mediaPorEntrega),
            backgroundColor: topMedia.map((d) =>
              d.mediaPorEntrega < 0
                ? "rgba(248,113,113,0.55)"
                : "rgba(52,211,153,0.55)",
            ),
            borderColor: topMedia.map((d) =>
              d.mediaPorEntrega < 0 ? "#f87171" : "#34d399",
            ),
            borderWidth: 1,
            borderRadius: 4,
          },
        ],
      },
      options: {
        ...optBarras,
        plugins: { ...optBarras.plugins, legend: { display: false } },
      },
    });
  }

  // --- Gráfico 4: Problemas operacionais (rosca) ---
  const canvasProb = document.getElementById("graficoRankingProblemas");
  if (canvasProb) {
    const probOrd = contarProblemasOperacionais(dI, dF, rotaFiltro).slice(
      0,
      12,
    );
    if (_chartRkProblemas) _chartRkProblemas.destroy();
    _chartRkProblemas = new Chart(canvasProb, {
      type: "doughnut",
      data: {
        labels: probOrd.map((p) => p.tipo),
        datasets: [
          {
            data: probOrd.map((p) => p.total),
            backgroundColor: probOrd.map((_, i) => PALETA[i % PALETA.length]),
            borderColor: "rgba(15,23,42,0.6)",
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: "right",
            labels: {
              color: "#94a3b8",
              font: { size: 10 },
              boxWidth: 12,
              padding: 8,
            },
          },
        },
      },
    });
  }
}

function renderizarRankingResponsaveis(dI = "", dF = "", rotaFiltro = "") {
  const el = document.getElementById("rankingResponsaveis");
  if (!el) return;

  const mapa = new Map();
  const acumular = (o, responsavelBruto) => {
    const data = String(o.data_ocorrencia || o.data || "").split("T")[0];
    if (dI && data < dI) return;
    if (dF && data > dF) return;
    if (rotaFiltro && obterRotaDaOcorrencia(o) !== rotaFiltro) return;

    const responsavel =
      normalizarResponsavelOcorrencia(responsavelBruto) || "NAO INFORMADO";
    const atual = mapa.get(responsavel) || {
      responsavel,
      total: 0,
      equipeEntrega: responsavelEquipeEntrega(responsavel),
    };
    atual.total++;
    mapa.set(responsavel, atual);
  };

  ocorrencias.forEach((o) => {
    const temOco = !!(o.teve_ocorrencia || o.tipo_problema);
    if (!temOco) return;
    acumular(o, obterResponsavelOcorrencia(o));
  });

  // Avulsas (escopo GERAL e ENTREGA) tambem alimentam o ranking de culpa.
  obterAvulsasParaGraficos(false).forEach((o) => {
    acumular(o, o.ocorrencia_responsavel);
  });

  // Separa as ocorrencias sem responsavel para um bloco a parte (nao entram no ranking).
  const naoInformado = mapa.get("NAO INFORMADO");
  mapa.delete("NAO INFORMADO");
  const semResponsavel = naoInformado ? naoInformado.total : 0;

  const dados = [...mapa.values()].sort((a, b) => b.total - a.total);
  const totalClassificado = dados.reduce((s, item) => s + item.total, 0);
  const totalGeral = totalClassificado + semResponsavel;

  const blocoSemResponsavel = semResponsavel
    ? `<div class="ranking-alert">
         <div>
           <div class="ranking-alert-title">${semResponsavel} ocorrencia(s) sem responsavel informado</div>
           <div class="ranking-alert-text">Nao entram no ranking. Edite e informe o responsavel para classificar.</div>
         </div>
         <span>${totalGeral ? Math.round((semResponsavel / totalGeral) * 100) : 0}%</span>
       </div>`
    : "";

  el.innerHTML = `
    <div class="ranking-panel">
      <div class="ranking-panel-head">
        <div>
          <div class="ranking-panel-title">Responsaveis pelas ocorrencias</div>
          <div class="ranking-panel-subtitle">So EQUIPE DA ENTREGA desconta ponto do motorista.</div>
        </div>
        <span class="ranking-panel-total">${totalClassificado} de ${totalGeral}</span>
      </div>
      ${blocoSemResponsavel}
      ${
        dados.length === 0
          ? `<p class="ranking-empty">Nenhuma ocorrencia classificada no filtro.</p>`
          : `<div class="ranking-mini-list">
              ${dados
                .map((item, index) => {
                  const pct = totalClassificado
                    ? Math.round((item.total / totalClassificado) * 100)
                    : 0;
                  const cor = item.equipeEntrega
                    ? "var(--vermelho)"
                    : "var(--azul)";
                  return `
                    <div class="ranking-mini-card">
                      <div class="ranking-mini-top">
                        <strong>${index + 1}. ${escapar(item.responsavel)}</strong>
                        <span style="color:${cor};">${item.total}</span>
                      </div>
                      <div class="ranking-bar">
                        <div style="width:${pct}%;background:${cor};"></div>
                      </div>
                      <div class="ranking-mini-meta">${pct}% do total</div>
                    </div>`;
                })
                .join("")}
            </div>`
      }
    </div>`;
}

function corPontuacao(total) {
  if (total > 5)
    return {
      cor: "var(--verde)",
      bg: "rgba(52,211,153,0.12)",
      borda: "rgba(52,211,153,0.3)",
    };
  if (total >= 0)
    return {
      cor: "var(--amarelo)",
      bg: "rgba(251,191,36,0.10)",
      borda: "rgba(251,191,36,0.3)",
    };
  return {
    cor: "var(--vermelho)",
    bg: "rgba(248,113,113,0.10)",
    borda: "rgba(248,113,113,0.3)",
  };
}

function medalha(pos) {
  return String(pos + 1);
}

function renderizarPodio(dados) {
  const podio = document.getElementById("rankingPodio");
  if (!podio) return;
  const rotaFiltro = document.getElementById("rankingFiltroRota")?.value || "";
  const modoRota = !!rotaFiltro;
  if (dados.length === 0) {
    podio.innerHTML = `<p class="ranking-empty ranking-empty-large">Nenhum dado encontrado no periodo/rota selecionados.</p>`;
    return;
  }
  const avisoModo = modoRota
    ? `<div class="ranking-mode ranking-mode-route">Rota: <b>${escapar(rotaFiltro)}</b> | ordenado por pontuacao total</div>`
    : `<div class="ranking-mode">Ordenado por <b>pontuacao total</b></div>`;
  const top3 = dados.slice(0, 3);
  const totais = dados.reduce(
    (acc, d) => {
      acc.entregas += d.totalEntregas;
      acc.positivos += d.positivos;
      acc.negativos += Math.abs(d.negativos);
      acc.registros += d.totalRegistros;
      return acc;
    },
    { entregas: 0, positivos: 0, negativos: 0, registros: 0 },
  );
  podio.innerHTML =
    avisoModo +
    `
    <div class="ranking-kpis">
      <div><strong>${dados.length}</strong><span>motorista(s)</span></div>
      <div><strong>${totais.entregas}</strong><span>entregas</span></div>
      <div><strong>+${totais.positivos}</strong><span>pontos ganhos</span></div>
      <div><strong>-${totais.negativos}</strong><span>pontos perdidos</span></div>
    </div>
    <div class="ranking-podium">
      ${top3
        .map((d, i) => {
          const { cor, bg, borda } = corPontuacao(d.total);
          const totalStr = `${d.total > 0 ? "+" : ""}${d.total}`;
          return `
        <div class="ranking-podium-card" style="--rk-cor:${cor};--rk-bg:${bg};--rk-borda:${borda};"
          onclick="abrirDetalheRanking('${d.motorista}')">
          <div class="ranking-podium-pos">${medalha(i)}</div>
          <div class="ranking-podium-name">${escapar(d.motorista)}</div>
          <div class="ranking-podium-score">${totalStr}</div>
          <div class="ranking-podium-label">pontos</div>
          <div class="ranking-podium-meta">${d.totalEntregas} entregas</div>
          <div class="ranking-podium-split">
            <span>+${d.positivos}</span>
            <span>${d.negativos}</span>
          </div>
        </div>`;
        })
        .join("")}
    </div>`;
}

function renderizarTabelaRanking(dados) {
  const container = document.getElementById("rankingTabela");
  if (!container) return;
  if (dados.length === 0) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = `
    <div style="overflow-x:auto;">
      <table data-ordenavel style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:var(--bg-elevated);border-bottom:2px solid var(--border);">
            <th style="padding:12px 14px;text-align:left;font-size:11px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">#</th>
            <th style="padding:12px 14px;text-align:left;font-size:11px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Motorista</th>
            <th style="padding:12px 14px;text-align:center;font-size:11px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Entregas</th>
            <th style="padding:12px 14px;text-align:center;font-size:11px;font-weight:800;text-transform:uppercase;color:var(--verde);">Sem Oco</th>
            <th style="padding:12px 14px;text-align:center;font-size:11px;font-weight:800;text-transform:uppercase;color:var(--vermelho);">Oco Equipe</th>
            <th style="padding:12px 14px;text-align:center;font-size:11px;font-weight:800;text-transform:uppercase;color:var(--amarelo);">Oco Outras</th>
            <th style="padding:12px 14px;text-align:center;font-size:11px;font-weight:800;text-transform:uppercase;color:var(--verde);">CK ✅</th>
            <th style="padding:12px 14px;text-align:center;font-size:11px;font-weight:800;text-transform:uppercase;color:var(--vermelho);">CK ❌</th>
            <th style="padding:12px 14px;text-align:center;font-size:11px;font-weight:800;text-transform:uppercase;color:var(--verde);">Almoço ✅</th>
            <th style="padding:12px 14px;text-align:center;font-size:11px;font-weight:800;text-transform:uppercase;color:var(--vermelho);">Almoço ❌</th>
            <th style="padding:12px 14px;text-align:center;font-size:11px;font-weight:800;text-transform:uppercase;color:var(--azul);">Tacógrafo</th>
            <th style="padding:12px 14px;text-align:center;font-size:11px;font-weight:800;text-transform:uppercase;color:var(--azul);">Diário</th>
            <th style="padding:12px 14px;text-align:center;font-size:11px;font-weight:800;text-transform:uppercase;color:var(--amarelo);">Saída</th>
            <th style="padding:12px 14px;text-align:center;font-size:11px;font-weight:800;text-transform:uppercase;color:var(--verde);">+Pts</th>
            <th style="padding:12px 14px;text-align:center;font-size:11px;font-weight:800;text-transform:uppercase;color:var(--vermelho);">-Pts</th>
            <th style="padding:12px 14px;text-align:center;font-size:11px;font-weight:800;text-transform:uppercase;color:var(--text-heading);">Total</th>
            <th style="padding:12px 14px;text-align:center;"></th>
          </tr>
        </thead>
        <tbody>
          ${dados
            .map((d, i) => {
              const { cor, bg, borda } = corPontuacao(d.total);
              const p = d.pts;
              const zebra =
                i % 2 === 0
                  ? "rgba(255,255,255,0.01)"
                  : "rgba(255,255,255,0.025)";
              const tacStr = `✅${p.tacografoDevolveu.valor} ❌${p.tacografoNao.valor}`;
              const diaStr = `✅${p.diarioPreencheu.valor} ❌${p.diarioNao.valor}`;
              const saidaStr = `✅${p.saidaNoPrazo.valor} ❌${p.saidaAtrasada.valor}`;
              return `
            <tr style="background:${zebra};border-bottom:1px solid var(--border);cursor:pointer;"
              onclick="abrirDetalheRanking('${d.motorista}')">
              <td style="padding:12px 14px;font-weight:800;color:var(--text-muted);">${medalha(i)}</td>
              <td style="padding:12px 14px;font-weight:700;color:var(--text-heading);">${d.motorista}</td>
              <td style="padding:12px 14px;text-align:center;color:var(--text-muted);font-weight:700;">${d.totalEntregas}</td>
              <td style="padding:12px 14px;text-align:center;color:var(--verde);font-weight:700;">${p.entregaSemOco.valor}</td>
              <td style="padding:12px 14px;text-align:center;color:var(--vermelho);font-weight:700;">${p.entregaComOco.valor}</td>
              <td style="padding:12px 14px;text-align:center;color:var(--amarelo);font-weight:700;">${p.entregaOcoOutraArea.valor}</td>
              <td style="padding:12px 14px;text-align:center;color:var(--verde);font-weight:700;">${p.checklistFeito.valor}</td>
              <td style="padding:12px 14px;text-align:center;color:var(--vermelho);font-weight:700;">${p.checklistNaoFeito.valor}</td>
              <td style="padding:12px 14px;text-align:center;color:var(--verde);font-weight:700;">${p.almocoPrazo.valor}</td>
              <td style="padding:12px 14px;text-align:center;color:var(--vermelho);font-weight:700;">${p.almocoExcedido.valor}</td>
              <td style="padding:12px 14px;text-align:center;color:var(--azul);font-weight:700;font-size:11px;">${tacStr}</td>
              <td style="padding:12px 14px;text-align:center;color:var(--azul);font-weight:700;font-size:11px;">${diaStr}</td>
              <td style="padding:12px 14px;text-align:center;color:var(--amarelo);font-weight:700;font-size:11px;">${saidaStr}</td>
              <td style="padding:12px 14px;text-align:center;color:var(--verde);font-weight:800;">+${d.positivos}</td>
              <td style="padding:12px 14px;text-align:center;color:var(--vermelho);font-weight:800;">${d.negativos}</td>
              <td style="padding:12px 14px;text-align:center;">
                <span style="background:${bg};border:1px solid ${borda};color:${cor};font-weight:800;font-size:0.95rem;padding:3px 12px;border-radius:10px;display:inline-block;">
                  ${d.total > 0 ? "+" : ""}${d.total}
                </span>
              </td>
              <td style="padding:12px 14px;text-align:center;">
                <button type="button" onclick="event.stopPropagation();abrirDetalheRanking('${d.motorista}')"
                  style="background:rgba(56,189,248,0.1);border:1px solid rgba(56,189,248,0.25);border-radius:7px;padding:4px 10px;color:var(--azul);font-size:11px;cursor:pointer;font-weight:700;font-family:inherit;">
                  Ver
                </button>
              </td>
            </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </div>`;
}

function abrirDetalheRanking(motorista) {
  const dI = document.getElementById("rankingDataInicio")?.value || "";
  const dF = document.getElementById("rankingDataFim")?.value || "";
  const rotaFiltro = document.getElementById("rankingFiltroRota")?.value || "";
  const d = calcularPontuacaoMotorista(motorista, dI, dF, rotaFiltro);
  const shell = document.getElementById("rankingDetalheShell");
  const titulo = document.getElementById("rankingDetalheTitulo");
  const conteudo = document.getElementById("rankingDetalheConteudo");
  if (!shell || !titulo || !conteudo) return;
  titulo.textContent = rotaFiltro
    ? `Detalhamento - ${motorista} | ${rotaFiltro}`
    : `Detalhamento - ${motorista}`;
  shell.style.display = "block";
  const { cor, bg, borda } = corPontuacao(d.total);
  const linhas = Object.entries(d.pts)
    .map(([, p]) => {
      if (p.valor === 0) return "";
      const sinal =
        p.pontos > 0
          ? `<span style="color:var(--verde);font-weight:800;">+${p.pontos}</span>`
          : p.pontos < 0
            ? `<span style="color:var(--vermelho);font-weight:800;">${p.pontos}</span>`
            : `<span style="color:var(--text-muted);font-weight:800;">0</span>`;
      const icone = p.pontos > 0 ? "✅" : p.pontos < 0 ? "❌" : "➖";
      return `
    <tr style="border-bottom:1px solid var(--border);">
      <td style="padding:10px 14px;">${icone}</td>
      <td style="padding:10px 14px;color:var(--text-secondary);font-weight:600;">${p.label}</td>
      <td style="padding:10px 14px;text-align:center;color:var(--text-heading);font-weight:700;">${p.valor}x</td>
      <td style="padding:10px 14px;text-align:center;">${sinal}</td>
    </tr>`;
    })
    .join("");
  conteudo.innerHTML = `
    <div style="display:flex;align-items:center;gap:20px;margin-bottom:20px;padding:16px 20px;background:${bg};border:1px solid ${borda};border-radius:8px;">
      <div style="font-size:3rem;font-weight:800;color:${cor};letter-spacing:0;">${d.total > 0 ? "+" : ""}${d.total}</div>
      <div>
        <div style="font-size:0.85rem;font-weight:700;color:var(--text-heading);">Pontuação Total</div>
        <div style="font-size:0.72rem;color:var(--text-muted);margin-top:3px;">
          <span style="color:var(--verde);">+${d.positivos} positivos</span> · <span style="color:var(--vermelho);">${d.negativos} negativos</span> · ${d.totalRegistros} registros analisados
        </div>
      </div>
    </div>
    <table data-ordenavel style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:var(--bg-elevated);border-bottom:1px solid var(--border);">
          <th style="padding:10px 14px;text-align:left;font-size:11px;color:var(--text-muted);text-transform:uppercase;"></th>
          <th style="padding:10px 14px;text-align:left;font-size:11px;color:var(--text-muted);text-transform:uppercase;">Critério</th>
          <th style="padding:10px 14px;text-align:center;font-size:11px;color:var(--text-muted);text-transform:uppercase;">Qtd.</th>
          <th style="padding:10px 14px;text-align:center;font-size:11px;color:var(--text-muted);text-transform:uppercase;">Pontos</th>
        </tr>
      </thead>
      <tbody>${linhas || '<tr><td colspan="4" style="padding:20px;text-align:center;color:var(--text-muted);">Sem registros no período.</td></tr>'}</tbody>
    </table>`;
  setTimeout(
    () => shell.scrollIntoView({ behavior: "smooth", block: "start" }),
    50,
  );
}

function fecharDetalheRanking() {
  const shell = document.getElementById("rankingDetalheShell");
  if (shell) shell.style.display = "none";
}

// ================================================================
// FILTRO GLOBAL DE DATA — ABA VEÍCULOS
// ================================================================

function aplicarFiltroVeiculos() {
  const data = document.getElementById("veiculosFiltroData")?.value || "";
  renderizarListaAlmocosComFiltro(data);
  renderizarListaAtrasosSaidaComFiltro(data);
  renderizarListaRotasComFiltro(data);
  // Seções com filtro próprio: o wrapper já considera o filtro da seção e,
  // se vazio, cai no filtro global da aba.
  renderizarListaChecklistDiario();
  renderTacografos();
  renderDiarios();
  atualizarInfoFiltroVeiculos(data);
}

function limparFiltroVeiculos() {
  const input = document.getElementById("veiculosFiltroData");
  if (input) input.value = "";
  aplicarFiltroVeiculos();
}

function atualizarInfoFiltroVeiculos(data) {
  const el = document.getElementById("veiculosFiltroInfo");
  if (!el) return;
  el.textContent = data
    ? `Exibindo: ${formatarDataBR(data)}`
    : "Todos os registros";
}

function filtrarListaPorData(lista, campoFn, data) {
  if (!data) return lista;
  return lista.filter(
    (item) => String(campoFn(item) || "").split("T")[0] === data,
  );
}

function renderizarListaAlmocosComFiltro(data) {
  const todas = lerStorage(LS.almocos);
  // ordenarCartoes vem do script-5-formularios.js, que carrega antes.
  const lista = ordenarCartoes("almoco", filtrarListaPorData(todas, (a) => a.data, data));
  const container = document.getElementById("listaAlmocos");
  if (!container) return;
  const totalInfo = data
    ? `<div style="font-size:11px;color:var(--text-muted);font-weight:700;margin-bottom:8px;">${lista.length} registro(s) em ${formatarDataBR(data)}</div>`
    : "";
  container.innerHTML =
    totalInfo +
    (lista.length === 0
      ? barraOrdenacaoCartoes("almoco") +
        `<p style="color:var(--text-muted);font-size:13px;padding:12px 0;">${data ? "Nenhum almoço nesta data." : "Nenhum almoço registrado ainda."}</p>`
      : barraOrdenacaoCartoes("almoco") +
        lista
          .map((r, i) => {
            // indexOf pela REFERENCIA do objeto: ordenar uma copia
            // (slice) preserva a identidade, entao o indice sai certo.
            const idx = todas.indexOf(r);
            return `
        <div class="item" style="border-left:4px solid ${r.status === "ok" ? "var(--verde)" : "var(--vermelho)"};padding:16px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div>
              <strong style="color:var(--text-heading);">${escapar(r.motorista)}</strong>
              <span style="color:var(--text-muted);font-size:13px;margin-left:8px;">— ${escapar(formatarDataBR(r.data))}</span><br>
              <span style="font-size:13px;color:var(--text-secondary);">🕐 Previsto: ${r.prevInicio}–${r.prevFim} | Real: ${r.realInicio}–${r.realFim}</span><br>
              ${r.status === "ok" ? `<span style="color:var(--verde);font-weight:600;">✅ Dentro do prazo</span>` : `<span style="color:var(--vermelho);font-weight:600;">⚠️ Excedeu em ${formatarTempo(r.diferenca)}</span>`}
              ${r.obs ? `<br><small style="color:var(--text-muted);">📝 ${escapar(r.obs)}</small>` : ""}
            </div>
            <button type="button" onclick="excluirAlmoco(${r.id})" class="btn-red btn-sm">🗑️</button>
          </div>
        </div>`;
          })
          .join(""));
}

function renderizarListaChecklistComFiltro(data) {
  const todas = lerStorage(LS.checklist);
  const lista = filtrarListaPorData(todas, (c) => c.data, data);
  const container = document.getElementById("listaChecklistDiario");
  if (!container) return;
  const hoje = hojeISO();
  // Conta MOTORISTA distinto, nao linha: a tela promete "1x por dia" mas nada
  // impede lancar duas vezes, e o badge passava a anunciar mais checklists do
  // que motoristas que de fato entregaram. Sem motorista, a propria linha vale
  // como unidade (nao some do contador).
  const qtdHoje = new Set(
    todas.filter((c) => c.data === hoje).map((c, i) => (c.motorista || "").trim().toUpperCase() || `#${i}`),
  ).size;
  ["badgeChecklistDiario", "badgeNavVeiculos"].forEach((id) => {
    const b = document.getElementById(id);
    if (!b) return;
    b.style.display = qtdHoje ? "inline-flex" : "none";
    b.textContent = String(qtdHoje);
  });
  const totalInfo = data
    ? `<div style="font-size:11px;color:var(--text-muted);font-weight:700;margin-bottom:8px;">${lista.length} registro(s) em ${formatarDataBR(data)}</div>`
    : "";
  container.innerHTML =
    totalInfo +
    (lista.length === 0
      ? `<p style="color:var(--text-muted);font-size:13px;padding:12px 0;">${data ? "Nenhum checklist nesta data." : "Nenhum checklist registrado."}</p>`
      : lista
          .map(
            (c) => `
        <div class="item" style="border-left:4px solid var(--verde);padding:16px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;">
            <div>
              <strong style="color:var(--text-heading);">🔧 ${escapar(c.motorista)}</strong>
              <span style="color:var(--text-muted);font-size:12px;margin-left:8px;">${escapar(c.placa)}</span>
              ${c.rota ? `<span style="color:var(--azul);font-size:12px;margin-left:8px;font-weight:600;">📍 ${escapar(c.rota)}</span>` : ""}<br>
              <span style="color:var(--text-secondary);font-size:13px;">${c.origem === "whatsapp" ? "✅ Checklist realizado via grupo de WhatsApp" : escapar((c.itens || []).join(", "))}</span><br>
              <small style="color:var(--text-muted);">${escapar(formatarDataBR(c.data))} • ${c.origem === "whatsapp" ? "Registro pelo envio no grupo" : (c.totalItens || (c.itens || []).length) + " item(ns)"}</small>
              ${c.obs ? `<br><small style="color:var(--text-muted);">📝 ${escapar(c.obs)}</small>` : ""}
            </div>
            <button type="button" onclick="excluirChecklistDiario(${c.id})" class="btn-red btn-sm">🗑️</button>
          </div>
        </div>`,
          )
          .join(""));
}

function renderizarListaAtrasosSaidaComFiltro(data) {
  const todas = lerStorage(LS.atrasos);
  // ordenarCartoes vem do script-5-formularios.js, que carrega antes.
  const lista = ordenarCartoes("atrasoSaida", filtrarListaPorData(todas, (a) => a.data, data));
  const container = document.getElementById("listaAtrasosSaida");
  if (!container) return;
  const totalInfo = data
    ? `<div style="font-size:11px;color:var(--text-muted);font-weight:700;margin-bottom:8px;">${lista.length} registro(s) em ${formatarDataBR(data)}</div>`
    : "";
  container.innerHTML =
    totalInfo +
    (lista.length === 0
      ? barraOrdenacaoCartoes("atrasoSaida") +
        `<p style="color:var(--text-muted);font-size:13px;padding:12px 0;">${data ? "Nenhum atraso nesta data." : "Nenhum atraso registrado."}</p>`
      : barraOrdenacaoCartoes("atrasoSaida") + lista.map(montarCardAtrasoSaida).join(""));
}

function normalizarFiltroTempoRota(valor) {
  return String(valor || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
}

function opcoesSelectTempoRota(id) {
  const select = document.getElementById(id);
  if (!select) return [];
  return Array.from(select.options)
    .map((opt) => opt.value)
    .filter(Boolean);
}

function preencherSelectFiltroTempoRota(id, placeholder, valores) {
  const select = document.getElementById(id);
  if (!select) return;
  const atual = select.value;
  const unicos = Array.from(new Set(valores.filter(Boolean))).sort((a, b) =>
    String(a).localeCompare(String(b), "pt-BR"),
  );
  select.innerHTML =
    `<option value="">${placeholder}</option>` +
    unicos
      .map((valor) => `<option value="${escapar(valor)}">${escapar(valor)}</option>`)
      .join("");
  if (unicos.includes(atual)) select.value = atual;
}

function popularFiltrosTempoRota(todas) {
  preencherSelectFiltroTempoRota("filtroMotoristaRota", "Todos os motoristas", [
    ...opcoesSelectTempoRota("motoristaRota"),
    ...todas.map((r) => r.motorista),
  ]);
  preencherSelectFiltroTempoRota("filtroPlacaRota", "Todas as placas", [
    ...opcoesSelectTempoRota("placaRota"),
    ...todas.map((r) => r.placa),
  ]);
}

function limparFiltrosRotas() {
  ["filtroDataRota", "filtroMesRota", "filtroMotoristaRota", "filtroPlacaRota", "filtroBuscaRota"].forEach((id) =>
    setVal(id, ""),
  );
  renderizarListaRotasComFiltro();
}

// Os filtros da secao num lugar so. A lista e o botao "Excluir tudo" TEM de
// enxergar o mesmo recorte — se divergirem, o botao apaga o que a tela nao
// mostra, e o usuario nao tem como perceber antes de ser tarde.
function filtrosRotaAtivos(data) {
  const dataSecao = document.getElementById("filtroDataRota")?.value || "";
  const dataGlobal = data || document.getElementById("veiculosFiltroData")?.value || "";
  return {
    dia: dataSecao || dataGlobal,
    mes: document.getElementById("filtroMesRota")?.value || "",
    motorista: document.getElementById("filtroMotoristaRota")?.value || "",
    placa: document.getElementById("filtroPlacaRota")?.value || "",
    busca: normalizarFiltroTempoRota(document.getElementById("filtroBuscaRota")?.value),
  };
}

function rotasFiltradas(data) {
  const f = filtrosRotaAtivos(data);
  const todas = lerStorage(LS.rotas);
  // O MES so vale quando nao ha DIA escolhido: aplicar os dois juntos daria
  // lista vazia toda vez que discordassem, sem explicacao na tela.
  // A data vem em ISO (AAAA-MM-DD) e o input month da "AAAA-MM": startsWith basta.
  const base = f.dia
    ? filtrarListaPorData(todas, (r) => r.data, f.dia)
    : f.mes
      ? todas.filter((r) => String(r.data || "").startsWith(f.mes))
      : todas;
  return base.filter((r) => {
    if (f.motorista && normalizarFiltroTempoRota(r.motorista) !== normalizarFiltroTempoRota(f.motorista)) return false;
    if (f.placa && normalizarFiltroTempoRota(r.placa) !== normalizarFiltroTempoRota(f.placa)) return false;
    if (f.busca) {
      const texto = normalizarFiltroTempoRota(
        [r.rotaFeita, r.obs, r.motorista, r.placa, r.saida, r.retorno].join(" "),
      );
      if (!texto.includes(f.busca)) return false;
    }
    return true;
  });
}

// Escolher um mes limpa o dia (e vice-versa): sao recortes concorrentes, e
// deixar os dois preenchidos so confunde.
function filtrarRotasPorMes() {
  const dia = document.getElementById("filtroDataRota");
  if (dia && dia.value) dia.value = "";
  renderizarListaRotasComFiltro();
}

function filtrarRotasPorDia() {
  const mes = document.getElementById("filtroMesRota");
  if (mes && mes.value) mes.value = "";
  renderizarListaRotasComFiltro();
}

// Apaga o RECORTE VISIVEL, nao a base inteira — e o mesmo rotasFiltradas() que
// desenha a lista. Sem filtro, o recorte e tudo, e a confirmacao muda de tom.
//
// Usa confirmarBonito (Promise<boolean>), NAO confirmarSimples encadeado:
// confirmarAcao() executa o callback e so DEPOIS chama fecharModal(), entao um
// segundo modal aberto de dentro do callback era fechado no mesmo clique — o
// botao parecia nao fazer nada.
//
// E `alertar`, nao `avisar`: `avisar` nao existe neste projeto, e o guarda
// `typeof avisar === "function"` transformava a lista vazia em no-op silencioso.
async function excluirRotasFiltradas() {
  const alvo = rotasFiltradas();
  if (!alvo.length) {
    alertar("Não há registro para excluir no filtro atual.");
    return;
  }
  const todas = lerStorage(LS.rotas);
  const f = filtrosRotaAtivos();
  const tudo = alvo.length === todas.length;
  const recorte = [
    f.dia ? `data ${formatarDataBR(f.dia)}` : "",
    !f.dia && f.mes ? `mês ${f.mes}` : "",
    f.motorista ? `motorista ${f.motorista}` : "",
    f.placa ? `placa ${f.placa}` : "",
    f.busca ? "busca ativa" : "",
  ]
    .filter(Boolean)
    .join(", ");

  const perguntar = (msg, okLabel) =>
    typeof confirmarBonito === "function"
      ? confirmarBonito(msg, { okLabel, cancelLabel: "Cancelar" })
      : Promise.resolve(window.confirm(msg));

  const primeira = tudo
    ? `Excluir TODOS os ${alvo.length} registros de tempo de rota?\nNão há como desfazer.`
    : `Excluir os ${alvo.length} registro(s) do filtro atual?\n(${recorte})\nNão há como desfazer.`;
  if (!(await perguntar(primeira, "Excluir"))) return;

  // Sem filtro some a base inteira: segundo "sim" de proposito.
  if (
    tudo &&
    !(await perguntar(
      `Confirma apagar os ${alvo.length} registros?\nEsta ação não tem volta.`,
      "Apagar tudo",
    ))
  ) {
    return;
  }

  const ids = new Set(alvo.map((r) => String(r.id)));
  const restante = todas.filter((r) => !ids.has(String(r.id)));
  if (!(await salvarStorage(LS.rotas, restante))) return;
  renderizarListaRotasComFiltro();
  if (typeof historicoRotasInit === "function") historicoRotasInit();
  alertar(`${alvo.length} registro(s) excluído(s).`);
}

function renderizarListaRotasComFiltro(data) {
  const todas = lerStorage(LS.rotas);
  popularFiltrosTempoRota(todas);
  const f = filtrosRotaAtivos(data);
  const lista = rotasFiltradas(data);
  // Ordena DEPOIS dos filtros da secao.
  const listaOrdenada = ordenarCartoes("tempoRota", lista);
  const container = document.getElementById("listaRotas");
  if (!container) return;
  const filtrosAtivos = [
    f.dia ? `Data: ${formatarDataBR(f.dia)}` : "",
    !f.dia && f.mes ? `Mês: ${f.mes}` : "",
    f.motorista ? `Motorista: ${f.motorista}` : "",
    f.placa ? `Placa: ${f.placa}` : "",
    f.busca ? "Busca ativa" : "",
  ].filter(Boolean);
  const totalInfo = filtrosAtivos.length
    ? `<div style="font-size:11px;color:var(--text-muted);font-weight:700;margin-bottom:8px;">${lista.length} registro(s) - ${escapar(filtrosAtivos.join(" | "))}</div>`
    : "";
  container.innerHTML =
    totalInfo +
    (lista.length === 0
      ? barraOrdenacaoCartoes("tempoRota") +
        `<p style="color:var(--text-muted);font-size:13px;padding:12px 0;">${filtrosAtivos.length ? "Nenhuma rota encontrada para os filtros atuais." : "Nenhuma rota registrada."}</p>`
      : barraOrdenacaoCartoes("tempoRota") +
        listaOrdenada
          .map(
            (r) => `
        <div class="item" style="border-left:4px solid ${Number(r.minutosExcedentes || 0) > 0 ? "var(--vermelho)" : "var(--verde)"};padding:16px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;">
            <div>
              <strong style="color:var(--text-heading);">🚛 ${escapar(r.motorista)}</strong>
              <span style="color:var(--text-muted);font-size:12px;margin-left:8px;">${escapar(r.placa)} • ${escapar(r.rotaFeita || "-")}</span><br>
              <span style="color:var(--text-secondary);font-size:13px;">${escapar(r.saida)} → ${escapar(r.retorno)} • ${escapar(`${r.horas || 0}h ${r.minutos || 0}min`)}</span><br>
              <small style="color:var(--text-muted);">
                ${escapar(formatarDataBR(r.data))} • Extra: R$ ${Number(
                  r.valorExtraAprox || 0,
                )
                  .toFixed(2)
                  .replace(".", ",")} •
                ${
                  Number(r.minutosExcedentes || 0) > 0
                    ? `<span style="color:var(--vermelho);">⚠️ Excedente: ${formatarTempo(r.minutosExcedentes)}</span>`
                    : `<span style="color:var(--verde);">✅ Dentro do limite</span>`
                }
              </small>
              ${r.obs ? `<br><small style="color:var(--text-muted);">📝 ${escapar(r.obs)}</small>` : ""}
            </div>
            <button type="button" onclick="excluirRota(${r.id})" class="btn-red btn-sm">🗑️</button>
          </div>
        </div>`,
          )
          .join(""));
}

function renderizarTacografosComFiltro(data) {
  const todas = lerStorage(LS.tacografos);
  const lista = filtrarListaPorData(todas, (t) => t.data, data);
  const container = document.getElementById("listaTacografos");
  if (!container) return;
  const totalInfo = data
    ? `<div style="font-size:11px;color:var(--text-muted);font-weight:700;margin-bottom:8px;">${lista.length} registro(s) em ${formatarDataBR(data)}</div>`
    : "";
  container.innerHTML =
    totalInfo +
    (lista.length === 0
      ? `<p style="color:var(--text-muted);font-size:13px;padding:12px 0;">${data ? "Nenhum tacógrafo nesta data." : "Nenhum registro ainda."}</p>`
      : lista
          .map((r) => {
            const cor =
              r.status === "Devolveu"
                ? "var(--verde)"
                : r.status === "Não devolveu"
                  ? "var(--vermelho)"
                  : "var(--text-muted)";
            const icon =
              r.status === "Devolveu"
                ? "✅"
                : r.status === "Não devolveu"
                  ? "❌"
                  : "—";
            const dataFmt = r.data
              ? r.data.split("-").reverse().join("/")
              : "—";
            return `
        <div class="item" style="display:flex;align-items:center;gap:14px;padding:12px 16px;margin-bottom:8px;background:rgba(255,255,255,0.02);border:1px solid var(--border);border-radius:12px;">
          <div style="font-size:1.2rem;">${icon}</div>
          <div style="flex:1;">
            <div style="font-size:0.82rem;font-weight:700;color:var(--text-heading);">${escapar(r.motorista)} · ${escapar(r.placa)}</div>
            <div style="font-size:0.72rem;color:var(--text-muted);margin-top:2px;">${dataFmt}${r.obs ? " · " + escapar(r.obs) : ""}</div>
          </div>
          <div style="font-size:0.75rem;font-weight:700;color:${cor};">${escapar(r.status)}</div>
          <button onclick="excluirTacografo(${r.id})" style="background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.2);border-radius:7px;padding:4px 9px;color:#f87171;font-size:11px;cursor:pointer;font-family:inherit;">✕</button>
        </div>`;
          })
          .join(""));
}

function renderizarDiariosComFiltro(data) {
  const todas = lerStorage(LS.diarios);
  const lista = filtrarListaPorData(todas, (d) => d.data, data);
  const container = document.getElementById("listaDiarios");
  if (!container) return;
  const totalInfo = data
    ? `<div style="font-size:11px;color:var(--text-muted);font-weight:700;margin-bottom:8px;">${lista.length} registro(s) em ${formatarDataBR(data)}</div>`
    : "";
  container.innerHTML =
    totalInfo +
    (lista.length === 0
      ? `<p style="color:var(--text-muted);font-size:13px;padding:12px 0;">${data ? "Nenhum diário nesta data." : "Nenhum registro ainda."}</p>`
      : lista
          .map((r) => {
            const cor =
              r.status === "Preencheu"
                ? "var(--verde)"
                : r.status === "Não preencheu"
                  ? "var(--vermelho)"
                  : "var(--text-muted)";
            const icon =
              r.status === "Preencheu"
                ? "✅"
                : r.status === "Não preencheu"
                  ? "❌"
                  : "—";
            const dataFmt = r.data
              ? r.data.split("-").reverse().join("/")
              : "—";
            return `
        <div class="item" style="display:flex;align-items:center;gap:14px;padding:12px 16px;margin-bottom:8px;background:rgba(255,255,255,0.02);border:1px solid var(--border);border-radius:12px;">
          <div style="font-size:1.2rem;">${icon}</div>
          <div style="flex:1;">
            <div style="font-size:0.82rem;font-weight:700;color:var(--text-heading);">${escapar(r.motorista)} · ${escapar(r.placa)}</div>
            <div style="font-size:0.72rem;color:var(--text-muted);margin-top:2px;">${dataFmt}${r.obs ? " · " + escapar(r.obs) : ""}</div>
          </div>
          <div style="font-size:0.75rem;font-weight:700;color:${cor};">${escapar(r.status)}</div>
          <button onclick="excluirDiario(${r.id})" style="background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.2);border-radius:7px;padding:4px 9px;color:#f87171;font-size:11px;cursor:pointer;font-family:inherit;">✕</button>
        </div>`;
          })
          .join(""));
}

// ================================================================
// 26.1. FALLBACK — ABA EQUIPES (caso equipe.js não carregue)
// ================================================================
(function () {
  function montarEquipesFallback() {
    const kpis = $("equipesKpis");
    const melhores = $("equipesMelhores");
    const piores = $("equipesPiores");
    const tabela = $("equipesTabela");

    if (!kpis || !melhores || !piores || !tabela) return;

    const dataIni = getVal("equipesFiltroInicio");
    const dataFim = getVal("equipesFiltroFim");
    const rotaFiltro = getVal("equipesFiltroRota");

    const base = ocorrencias.filter((o) => {
      const data = String(o.data_ocorrencia || o.data || "").split("T")[0];
      const rota = obterRotaDaOcorrencia(o);
      if (dataIni && data < dataIni) return false;
      if (dataFim && data > dataFim) return false;
      if (rotaFiltro && rota !== rotaFiltro) return false;
      return true;
    });

    const mapa = new Map();

    base.forEach((o) => {
      const motorista = o.motorista || "SEM MOTORISTA";
      const ajudantes =
        extrairAjudantes(o.ajudantes).join(", ") || "S/ AJUDANTE";
      const chave = `${motorista} + ${ajudantes}`;
      const atual = mapa.get(chave) || {
        equipe: chave,
        motorista,
        ajudantes,
        entregas: 0,
        ocorrencias: 0,
        problemas: 0,
        semChecklist: 0,
        tempoTotal: 0,
        rota: obterRotaDaOcorrencia(o),
      };

      atual.entregas++;
      if (
        (o.teve_ocorrencia || o.tipo_problema) &&
        responsavelEquipeEntrega(obterResponsavelOcorrencia(o))
      )
        atual.ocorrencias++;
      if (o.problema_operacional_tipo) atual.problemas++;

      const ck =
        o.fez_checklist === true ||
        o.fez_checklist === "true" ||
        o.fez_checklist === "sim";
      if (!ck) atual.semChecklist++;

      atual.tempoTotal += Number(o.permanencia_minutos || 0);
      mapa.set(chave, atual);
    });

    const equipes = [...mapa.values()].map((e) => ({
      ...e,
      mediaTempo: e.entregas ? Math.round(e.tempoTotal / e.entregas) : 0,
      taxa: e.entregas
        ? Math.round(((e.entregas - e.ocorrencias) / e.entregas) * 100)
        : 0,
    }));

    const totalEntregas = base.length;
    const totalEquipes = equipes.length;
    const totalOcorrencias = base.filter(
      (o) => o.teve_ocorrencia || o.tipo_problema,
    ).length;

    kpis.innerHTML = [
      ["👥", totalEquipes, "Equipes"],
      ["🚚", totalEntregas, "Entregas"],
      ["⚠️", totalOcorrencias, "Ocorrências"],
      [
        "✅",
        totalEntregas
          ? Math.round(
              ((totalEntregas - totalOcorrencias) / totalEntregas) * 100,
            ) + "%"
          : "0%",
        "Taxa geral",
      ],
    ]
      .map(
        ([icone, valor, label]) => `
        <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:14px;padding:14px;text-align:center;">
          <div style="font-size:1.1rem;">${icone}</div>
          <div style="font-size:1.35rem;font-weight:800;color:var(--text-heading);">${valor}</div>
          <div style="font-size:11px;color:var(--text-muted);font-weight:700;text-transform:uppercase;">${label}</div>
        </div>`,
      )
      .join("");

    const cardEquipe = (e) => `
      <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:12px;padding:11px;margin-bottom:8px;">
        <div style="font-size:12px;font-weight:800;color:var(--text-heading);">${escapar(e.motorista)}</div>
        <div style="font-size:11px;color:var(--text-muted);">${escapar(e.ajudantes)}</div>
        <div style="font-size:11px;margin-top:5px;color:var(--text-secondary);">
          ${e.entregas} entrega(s) · ${e.ocorrencias} ocorrência(s) · ${e.taxa}% sucesso
        </div>
      </div>`;

    melhores.innerHTML =
      equipes.length === 0
        ? `<p style="color:var(--text-muted);font-size:12px;">Sem dados.</p>`
        : equipes
            .slice()
            .sort((a, b) => b.taxa - a.taxa || b.entregas - a.entregas)
            .slice(0, 5)
            .map(cardEquipe)
            .join("");

    piores.innerHTML =
      equipes.length === 0
        ? `<p style="color:var(--text-muted);font-size:12px;">Sem dados.</p>`
        : equipes
            .slice()
            .sort((a, b) => b.ocorrencias - a.ocorrencias || a.taxa - b.taxa)
            .slice(0, 5)
            .map(cardEquipe)
            .join("");

    tabela.innerHTML =
      equipes.length === 0
        ? `<p style="color:var(--text-muted);font-size:13px;">Nenhuma equipe encontrada no filtro.</p>`
        : `
        <div style="overflow:auto;border:1px solid var(--border);border-radius:12px;">
          <table data-ordenavel style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead>
              <tr style="background:var(--bg-elevated);color:var(--text-muted);text-align:left;">
                <th style="padding:10px;">Equipe</th>
                <th style="padding:10px;">Rota</th>
                <th style="padding:10px;">Entregas</th>
                <th style="padding:10px;">Ocorrências</th>
                <th style="padding:10px;">Problemas</th>
                <th style="padding:10px;">Sem CK</th>
                <th style="padding:10px;">Média Loja</th>
                <th style="padding:10px;">Sucesso</th>
              </tr>
            </thead>
            <tbody>
              ${equipes
                .sort((a, b) => b.entregas - a.entregas)
                .map(
                  (e) => `
                  <tr style="border-top:1px solid var(--border);color:var(--text-secondary);">
                    <td style="padding:10px;"><b style="color:var(--text-heading);">${escapar(e.motorista)}</b><br><small>${escapar(e.ajudantes)}</small></td>
                    <td style="padding:10px;">${escapar(e.rota)}</td>
                    <td style="padding:10px;">${e.entregas}</td>
                    <td style="padding:10px;">${e.ocorrencias}</td>
                    <td style="padding:10px;">${e.problemas}</td>
                    <td style="padding:10px;">${e.semChecklist}</td>
                    <td style="padding:10px;">${formatarTempo(e.mediaTempo)}</td>
                    <td style="padding:10px;font-weight:800;color:${
                      e.taxa >= 90
                        ? "var(--verde)"
                        : e.taxa >= 70
                          ? "var(--amarelo)"
                          : "var(--vermelho)"
                    };">${e.taxa}%</td>
                  </tr>`,
                )
                .join("")}
            </tbody>
          </table>
        </div>`;

    popularFiltroRotasEquipesFallback();
  }

  function popularFiltroRotasEquipesFallback() {
    const select = $("equipesFiltroRota");
    if (!select) return;
    const atual = select.value;
    const rotas = [
      ...new Set(
        ocorrencias.map((o) => obterRotaDaOcorrencia(o)).filter(Boolean),
      ),
    ].sort();
    select.innerHTML =
      `<option value="">Todas as rotas</option>` +
      rotas
        .map((r) => `<option value="${escapar(r)}">${escapar(r)}</option>`)
        .join("");
    if (rotas.includes(atual)) select.value = atual;
  }

  if (typeof window.calcularEquipes !== "function") {
    window.calcularEquipes = montarEquipesFallback;
  }

  if (typeof window.limparFiltrosEquipes !== "function") {
    window.limparFiltrosEquipes = function () {
      setVal("equipesFiltroInicio", "");
      setVal("equipesFiltroFim", "");
      setVal("equipesFiltroRota", "");
      window.calcularEquipes();
    };
  }
})();
