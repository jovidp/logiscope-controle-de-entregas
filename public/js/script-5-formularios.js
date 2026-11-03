// ================================================================
// 12. FORMULÁRIOS — ENTREGA
// ================================================================
function abrirForm() {
  editandoIndex = null;
  window.tmsOcorrenciaContexto = null;

  const formEl = $("form");
  if (!formEl) return;

  formEl.classList.remove("hidden");
  limparForm();

  inicializarLinkSaidaFabricaOcorrencia();

  const btnS = document.querySelector("#form button.btn-green");
  if (btnS) btnS.textContent = "Salvar";

  setTimeout(() => {
    atualizarDadosOcorrenciaPeloDia();
    formEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 200);
}
function fecharForm() {
  $("form")?.classList.add("hidden");
}
function limparForm() {
  const f = $("form");
  if (!f) return;
  f.querySelectorAll("input, textarea").forEach((el) => {
    if (el.type !== "hidden" && el.type !== "checkbox") el.value = "";
  });
  f.querySelectorAll("select").forEach((el) => {
    if (el.multiple)
      Array.from(el.options).forEach((opt) => (opt.selected = false));
    else el.selectedIndex = 0;
  });
  const campoData = $("dataOcorrencia");
  if (campoData) campoData.value = new Date().toISOString().split("T")[0];
  const fezCk = $("fezChecklist");
  if (fezCk) fezCk.value = "nao";
  limparGrupoMulti("ajudantes");
  // O select de loja acima foi zerado por selectedIndex (nao dispara change):
  // sem isto o chip "Ramal" continuaria mostrando o numero da loja anterior.
  if (typeof atualizarRamalLoja === "function") atualizarRamalLoja();
  // Checkbox nao e zerado acima: a marca de pernoite volta ao neutro aqui.
  if (typeof pernoiteFormReset === "function") pernoiteFormReset();
  if (typeof vinculoViagemReset === "function") vinculoViagemReset();
  // As fotos vivem num array do modulo, nao no valor do input — zerar
  // o campo acima nao as apaga. Sem isso, as fotos de um registro
  // vazariam para o proximo.
  if (typeof ocorrenciaFotosLimpar === "function") ocorrenciaFotosLimpar();
  limparGrupoMulti("tipoOcorrencia");
  limparGrupoMulti("ocorrenciaResponsavel");
  $("campoOcorrencia")?.classList.add("hidden");
  $("campoRelato")?.classList.add("hidden");
  $("campoProblemaExtra")?.classList.add("hidden");
  $("campoTransferenciaRelato")?.classList.add("hidden");
  $("campoSacolaRelato")?.classList.add("hidden");
  const expedicaoPanel = $("ocExpedicaoPanel");
  if (expedicaoPanel) {
    expedicaoPanel.classList.add("hidden");
    const corpo = $("ocExpedicaoRemessas");
    if (corpo) corpo.innerHTML = "";
  }
  [
    "podFotoAtual",
    "podCanhotoAtual",
    "podAssinaturaAtual",
    "gpsLatitude",
    "gpsLongitude",
    "podConfirmadoEm",
  ].forEach((id) => setVal(id, ""));
  ["podFotoPreview", "podCanhotoPreview", "podAssinaturaPreview"].forEach(
    (id) => {
      if ($(id)) $(id).innerHTML = "";
    },
  );
  if ($("gpsStatusPOD"))
    $("gpsStatusPOD").textContent = "Nenhuma localização capturada.";
  atualizarDivergenciaCx();
  atualizarDivergenciaRt();
  atualizarDivergenciaVolume();
  atualizarCustoTotal();
  atualizarPreviewOtif();
  atualizarCampoJustificativaPermanencia();
  if (typeof atualizarBlocoStatusChecklist === "function")
    atualizarBlocoStatusChecklist();
}

function toggleOcorrencia() {
  const val = getVal("teveOcorrencia");
  const mostrar = val === "sim";
  $("campoOcorrencia")?.classList.toggle("hidden", !mostrar);
  $("campoRelato")?.classList.toggle("hidden", !mostrar);
  if (!mostrar) {
    limparGrupoMulti("tipoOcorrencia");
    limparGrupoMulti("ocorrenciaResponsavel");
    const r = $("relato");
    if (r) r.value = "";
  }
  if (typeof atualizarPainelKpisOcorrencia === "function")
    atualizarPainelKpisOcorrencia();
}
function toggleRelato() {
  $("campoRelato")?.classList.toggle("hidden", !getVal("tipoOcorrencia"));
}
function toggleProblemaExtra() {
  const tipo = getVal("tipoProblemaExtra");
  $("campoProblemaExtra")?.classList.toggle("hidden", !tipo);
  if (!tipo) {
    const r = $("relatoProblemaExtra");
    if (r) r.value = "";
  }
}

function toggleTransferenciaRelato() {
  const houveProblema = getVal("transferenciaProblema") === "sim";
  $("campoTransferenciaRelato")?.classList.toggle("hidden", !houveProblema);
  if (!houveProblema) setVal("transferenciaRelato", "");
}

function toggleSacolaRelato() {
  const precisaRelato = ["parcial", "incorreta"].includes(
    getVal("sacolaStatus"),
  );
  $("campoSacolaRelato")?.classList.toggle("hidden", !precisaRelato);
  if (!precisaRelato) setVal("sacolaRelato", "");
  if (typeof atualizarPainelKpisOcorrencia === "function")
    atualizarPainelKpisOcorrencia();
}

// Sacolas por caixa (padrão). 1 caixa rende: P=250, M=200, G=150.
const SACOLAS_POR_CAIXA = { P: 250, M: 200, G: 150 };

// Multiplica a quantidade de caixas digitada em P/M/G pelo fator de cada
// tamanho e mostra o total de sacolas na tela (não altera o que é salvo).
function calcularSacolas() {
  const caixasP = Math.max(0, parseInt(getVal("sacolaP"), 10) || 0);
  const caixasM = Math.max(0, parseInt(getVal("sacolaM"), 10) || 0);
  const caixasG = Math.max(0, parseInt(getVal("sacolaG"), 10) || 0);

  const box = $("sacolaCalculo");
  if (!box) return;

  if (caixasP + caixasM + caixasG === 0) {
    box.classList.add("hidden");
    return;
  }

  const totalP = caixasP * SACOLAS_POR_CAIXA.P;
  const totalM = caixasM * SACOLAS_POR_CAIXA.M;
  const totalG = caixasG * SACOLAS_POR_CAIXA.G;
  const total = totalP + totalM + totalG;

  const linhas = [];
  if (caixasP)
    linhas.push(`P: ${caixasP} cx × ${SACOLAS_POR_CAIXA.P} = <strong>${totalP.toLocaleString("pt-BR")}</strong>`);
  if (caixasM)
    linhas.push(`M: ${caixasM} cx × ${SACOLAS_POR_CAIXA.M} = <strong>${totalM.toLocaleString("pt-BR")}</strong>`);
  if (caixasG)
    linhas.push(`G: ${caixasG} cx × ${SACOLAS_POR_CAIXA.G} = <strong>${totalG.toLocaleString("pt-BR")}</strong>`);

  const detalhe = $("sacolaCalculoDetalhe");
  if (detalhe) detalhe.innerHTML = linhas.join("<br>");
  const totalEl = $("sacolaCalculoTotal");
  if (totalEl) totalEl.textContent = total.toLocaleString("pt-BR");
  box.classList.remove("hidden");
}

function toggleAlmoxerifadoRelato() {
  const precisaRelato = ["parcial", "incorreta"].includes(
    getVal("almoxerifadoStatus"),
  );
  $("campoAlmoxerifadoRelato")?.classList.toggle("hidden", !precisaRelato);
  if (!precisaRelato) setVal("almoxerifadoRelato", "");
  if (typeof atualizarPainelKpisOcorrencia === "function")
    atualizarPainelKpisOcorrencia();
}

function toggleMaterialEnvioRelato() {
  const precisaRelato = ["parcial", "incorreta"].includes(
    getVal("materialEnvioStatus"),
  );
  $("campoMaterialEnvioRelato")?.classList.toggle("hidden", !precisaRelato);
  if (!precisaRelato) setVal("materialEnvioRelato", "");
  if (typeof atualizarPainelKpisOcorrencia === "function")
    atualizarPainelKpisOcorrencia();
}

// Retirada de material (planilha da expedicao): par do Material de Envio.
// Nao entra no KPI da entrega (In Full e sobre o que a loja RECEBEU).
function toggleMaterialRetiradaRelato() {
  const precisaRelato = ["parcial", "incorreta"].includes(
    getVal("materialRetiradaStatus"),
  );
  $("campoMaterialRetiradaRelato")?.classList.toggle("hidden", !precisaRelato);
  if (!precisaRelato) setVal("materialRetiradaRelato", "");
}

function atualizarInfoDivergencia(idInfo, previsto, realizado, rotulo) {
  const el = $(idInfo);
  if (!el) return;

  const p = numeroOuNulo(previsto);
  const r = numeroOuNulo(realizado);

  if (p === null && r === null) {
    el.innerHTML = "";
    return;
  }

  if (p === null || r === null) {
    el.style.color = "var(--text-muted)";
    el.innerHTML =
      "ℹ️ Preencha previsto e realizado para calcular a divergência.";
    return;
  }

  const dif = r - p;
  if (dif === 0) {
    el.style.color = "var(--verde)";
    el.innerHTML = `✅ ${rotulo}: sem divergência.`;
    return;
  }

  el.style.color = "var(--vermelho)";
  el.innerHTML =
    dif > 0
      ? `⚠️ ${rotulo}: ${dif} a mais que o previsto.`
      : `⚠️ ${rotulo}: ${Math.abs(dif)} a menos que o previsto.`;
}

function atualizarDivergenciaCx() {
  atualizarInfoDivergencia(
    "divCxInfo",
    getVal("retiradaCxPrevista"),
    getVal("retiradaCxRealizada"),
    "Retirada CX",
  );
}

function atualizarDivergenciaRt() {
  atualizarInfoDivergencia(
    "divRtInfo",
    getVal("retiradaRtPrevista"),
    getVal("retiradaRtRealizada"),
    "Retirada RT",
  );
}

function atualizarDivergenciaVolume() {
  atualizarInfoDivergencia(
    "divVolumeInfo",
    getVal("volumeGerencial"),
    getVal("volumeFisico"),
    "Volume da carga",
  );
  // Volume fisico MENOR que o gerencial ja e' falta: muda o In Full derivado.
  if (typeof atualizarPainelKpisOcorrencia === "function")
    atualizarPainelKpisOcorrencia();
}

function preencherCampo(id, valor) {
  const el = $(id);
  if (!el) return;
  el.value = valor ?? "";
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function editarOcorrencia(id) {
  const o = ocorrencias.find((item) => String(item.id) === String(id));
  if (!o) {
    alertar("❌ Ocorrência não encontrada.");
    return;
  }
  editandoIndex = o.id;
  const formEl = $("form");
  if (!formEl) return;
  formEl.classList.remove("hidden");

  // As fotos nao vem na listagem (a listagem traz so fotos_qtd), entao
  // aqui elas precisam ser buscadas. Sem isso, salvar uma edicao
  // mandaria a lista vazia e APAGARIA as fotos ja anexadas.
  if (typeof ocorrenciaFotosCarregar === "function") ocorrenciaFotosCarregar(o.id);

  preencherCampo(
    "dataOcorrencia",
    (o.data_ocorrencia || o.data || "").split("T")[0],
  );
  preencherCampo("loja", o.loja || "");
  preencherCampo("protocolo", o.protocolo_imprevisto || o.protocolo || "");
  preencherCampo("motorista", o.motorista || "");
  preencherCampo("placa", o.placa || "");
  marcarGrupoMulti("ajudantes", o.ajudantes || "");
  preencherCampo("recebedor", o.recebedor || "");
  preencherCampo("cargo", o.cargo || "");
  preencherCampo("horaRecebedor", o.hora_recebedor || "");
  preencherCampo("horaMarcadaSaida", o.hora_marcada_saida || "");
  preencherCampo("horaSaidaFabrica", o.hora_saida_fabrica || "");
  preencherCampo("horaAgendadaLoja", o.hora_agendada_loja || "");
  preencherCampo("hora_chegada", o.hora_chegada || "");
  preencherCampo("inicioDescarga", o.inicio_descarga || "");
  preencherCampo("terminoDescarga", o.termino_descarga || "");
  preencherCampo("saidaLoja", o.fim_descarga || "");
  const temJustificativa = !!String(o.permanencia_justificativa || "").trim();
  const cbJustificativa = $("permanenciaTeveJustificativa");
  if (cbJustificativa) cbJustificativa.checked = temJustificativa;
  preencherCampo("permanenciaJustificativa", o.permanencia_justificativa || "");
  atualizarCampoJustificativaPermanencia();
  const ck =
    o.fez_checklist === true ||
    o.fez_checklist === "true" ||
    o.fez_checklist === "sim";
  setVal("fezChecklist", ck ? "sim" : "nao");
  preencherCampo("tipoProblemaExtra", o.problema_operacional_tipo || "");
  preencherCampo("relatoProblemaExtra", o.problema_operacional_relato || "");
  $("campoProblemaExtra")?.classList.toggle(
    "hidden",
    !o.problema_operacional_tipo,
  );
  const temOco = o.teve_ocorrencia === true || !!o.tipo_problema;
  setVal("teveOcorrencia", temOco ? "sim" : "nao");
  $("campoOcorrencia")?.classList.toggle("hidden", !temOco);
  marcarGrupoMulti("tipoOcorrencia", o.tipo_problema || "");
  marcarGrupoMulti("ocorrenciaResponsavel", obterResponsavelOcorrencia(o));
  $("campoRelato")?.classList.toggle("hidden", !temOco);
  preencherCampo("relato", o.descricao || o.relato || "");

  preencherCampo("retiradaCxPrevista", o.retirada_cx_prevista ?? "");
  preencherCampo("retiradaCxRealizada", o.retirada_cx_realizada ?? "");
  preencherCampo("retiradaRtPrevista", o.retirada_rt_prevista ?? "");
  preencherCampo("retiradaRtRealizada", o.retirada_rt_realizada ?? "");
  preencherCampo("volumeGerencial", o.volume_gerencial ?? "");
  preencherCampo("volumeFisico", o.volume_fisico ?? "");
  preencherCampo("transferenciaProblema", o.transferencia_problema || "");
  preencherCampo("transferenciaRelato", o.transferencia_relato || "");
  preencherCampo("sacolaStatus", o.sacola_status || "");
  preencherCampo("sacolaRelato", o.sacola_relato || "");
  preencherCampo("almoxerifadoStatus", o.almoxerifado_status || "");
  preencherCampo("almoxerifadoRelato", o.almoxerifado_relato || "");
  preencherCampo("materialEnvioStatus", o.material_envio_status || "");
  preencherCampo("materialEnvioRelato", o.material_envio_relato || "");
  preencherCampo("materialRetiradaStatus", o.material_retirada_status || "");
  preencherCampo("materialRetiradaRelato", o.material_retirada_relato || "");
  preencherCampo("maloteStatus", o.malote_status || "");
  preencherCampo("maloteObservacao", o.malote_observacao || "");
  preencherCampo("observacaoGeral", o.observacao || "");
  if (typeof pernoiteFormPreencher === "function") pernoiteFormPreencher(o.dia_seguinte === true);
  preencherCampo("materialCampanhaQtd", o.material_campanha_qtd ?? "");
  preencherCampo("campanhaBannerQtd", o.campanha_banner_qtd ?? "");
  preencherCampo("campanhaBannerCampanha", o.campanha_banner_campanha || "");
  preencherCampo("campanhaFolderQtd", o.campanha_folder_qtd ?? "");
  preencherCampo("campanhaFolderCampanha", o.campanha_folder_campanha || "");
  preencherCampo("campanhaAdesivoQtd", o.campanha_adesivo_qtd ?? "");
  preencherCampo("campanhaAdesivoCampanha", o.campanha_adesivo_campanha || "");
  preencherCampo("campanhaQuadroQtd", o.campanha_quadro_qtd ?? "");
  preencherCampo("campanhaQuadroCampanha", o.campanha_quadro_campanha || "");
  preencherCampo("sacolaP", o.sacola_p ?? "");
  preencherCampo("sacolaM", o.sacola_m ?? "");
  preencherCampo("sacolaG", o.sacola_g ?? "");
  if (typeof calcularSacolas === "function") calcularSacolas();
  preencherCampo("pedidoNumero", o.pedido_numero || "");
  preencherCampo("notaFiscal", o.nota_fiscal || "");
  preencherCampo("romaneioNumero", o.romaneio_numero || "");
  preencherCampo("valorCarga", o.valor_carga ?? "");
  preencherCampo("entregaCompleta", o.entrega_completa ? "sim" : "nao");
  preencherCampo("ocorrenciaSeveridade", o.ocorrencia_severidade || "");
  preencherCampo("ocorrenciaStatus", o.ocorrencia_status || "");
  preencherCampo("causaRaiz", o.causa_raiz || "");
  preencherCampo("acaoCorretiva", o.acao_corretiva || "");
  preencherCampo("prazoSolucao", String(o.prazo_solucao || "").split("T")[0]);
  preencherCampo("kmPrevisto", o.km_previsto ?? "");
  preencherCampo("kmReal", o.km_real ?? "");
  preencherCampo("custoKm", o.custo_km ?? "");
  preencherCampo("pedagio", o.pedagio ?? "");
  preencherCampo("custoReentrega", o.custo_reentrega ?? "");
  preencherCampo("custoOcorrencia", o.custo_ocorrencia ?? "");
  preencherCampo("podStatus", o.pod_status || "Pendente");
  preencherCampo("podDocumentoRecebedor", o.pod_documento_recebedor || "");
  setVal("podFotoAtual", o.pod_foto || "");
  setVal("podCanhotoAtual", o.pod_canhoto || "");
  setVal("podAssinaturaAtual", o.pod_assinatura || "");
  setVal("gpsLatitude", o.gps_latitude || "");
  setVal("gpsLongitude", o.gps_longitude || "");
  setVal("podConfirmadoEm", o.pod_confirmado_em || "");
  [
    ["podFotoPreview", o.pod_foto, "Foto"],
    ["podCanhotoPreview", o.pod_canhoto, "Canhoto"],
    ["podAssinaturaPreview", o.pod_assinatura, "Assinatura"],
  ].forEach(([idPreview, imagem, titulo]) => {
    const preview = $(idPreview);
    if (preview)
      preview.innerHTML = imagem
        ? `<img src="${escapar(imagem)}" alt="${titulo}" style="height:72px;max-width:100%;object-fit:cover;border-radius:7px;border:1px solid var(--border);">`
        : "";
  });
  if ($("gpsStatusPOD"))
    $("gpsStatusPOD").textContent =
      o.gps_latitude && o.gps_longitude
        ? `Localização capturada: ${o.gps_latitude}, ${o.gps_longitude}`
        : "Nenhuma localização capturada.";
  toggleTransferenciaRelato();
  toggleSacolaRelato();
  toggleAlmoxerifadoRelato();
  toggleMaterialEnvioRelato();
  toggleMaterialRetiradaRelato();
  atualizarDivergenciaCx();
  atualizarDivergenciaRt();
  atualizarDivergenciaVolume();
  atualizarCustoTotal();
  atualizarPreviewOtif();

  const btnS = document.querySelector("#form button.btn-green");
  if (btnS) btnS.textContent = "Atualizar";
  if (typeof atualizarBlocoStatusChecklist === "function")
    atualizarBlocoStatusChecklist();
  setTimeout(
    () => formEl.scrollIntoView({ behavior: "smooth", block: "start" }),
    50,
  );
}

// ================================================================
// 13. ABAS
// ================================================================
function irParaAba(nome) {
  const abasOperador = [
    "tms",
    "ctes",
    "ssw",
    "frota",
    "dashboard",
    "monitoramento",
    "entregas",
    "docas",
    "veiculos",
    "atrasos",
    "saida-fabrica",
    "tendencias",
    "ocorrencias-avulsas",
    "ocorrencias-entrega",
    "docs-motoristas",
    "escalas",
  ];
  if (
    window.authUsuario?.perfil === "OPERADOR" &&
    !abasOperador.includes(nome)
  ) {
    nome = "dashboard";
  }
  // Abas de GESTAO (auditoria/usuarios) so o master abre. erros-loja saiu daqui:
  // virou modulo concedivel, entao quem manda e' a permissao (aplicarPerfil).
  if (
    ["auditoria", "usuarios"].includes(nome) &&
    window.authUsuario?.super_adm !== true
  ) {
    nome = "entregas";
  }
  document.querySelectorAll(".aba").forEach((el) => {
    el.classList.add("aba-hidden");
    el.classList.remove("aba-fade");
  });
  const alvo = $(`aba-${nome}`);
  if (alvo) {
    alvo.classList.remove("aba-hidden");
    alvo.classList.add("aba-fade");
  }
  document
    .querySelectorAll(".nav-tab")
    .forEach((el) => el.classList.toggle("ativa", el.dataset.aba === nome));
  if (nome === "monitoramento") renderizarAvisosMonitoramento();
  if (nome === "veiculos") {
    const filtroInput = document.getElementById("veiculosFiltroData");
    if (filtroInput && !filtroInput.value) {
      filtroInput.value = hojeISO();
    }
    aplicarFiltroVeiculos();
  }
  if (nome === "entregas") {
    popularFiltroRotaHistorico();
    filtrarHistorico();
  }
  if (nome === "historico-rotas" && typeof historicoRotasInit === "function") {
    historicoRotasInit();
  }
  // Carrega a planilha do WMS aqui (e nao so no onclick da aba) para que
  // Ctrl+K / palette e o auto-clique do aplicarPerfil tambem cheguem com a
  // grade preenchida — pelo onclick, esses caminhos abriam a aba vazia.
  if (nome === "wms" && typeof wmsInit === "function") {
    wmsInit();
  }
  // Aba Frota: monta/atualiza mapa e lista (frota.js) — vale tambem para Ctrl+K.
  if (nome === "frota" && typeof frtInit === "function") {
    frtInit();
  }
  if (nome === "dashboard" || nome === "torre") atualizarTodasAsViews();
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (nome === "ranking") {
    calcularRanking();
  }
  if (nome === "equipes") {
    calcularEquipes();
  }
  if (nome === "tendencias") {
    renderizarTendencias();
  }
}

// ================================================================
// 14. MODAIS
// ================================================================
function fecharModal() {
  document
    .querySelectorAll("#overlay, #modalAlert, #modalConfirm")
    .forEach((m) => m.classList.add("hidden"));
}
function mostrarAlerta(msg) {
  const t = $("alertTexto");
  if (t) t.innerText = msg;
  $("overlay")?.classList.remove("hidden");
  $("modalAlert")?.classList.remove("hidden");
}
let cbConfirm = null;
function confirmar(msg, cb) {
  const t = $("confirmTexto");
  if (t) t.innerText = msg;
  cbConfirm = cb;
  $("overlay")?.classList.remove("hidden");
  $("modalConfirm")?.classList.remove("hidden");
}
function confirmarAcao() {
  if (cbConfirm) cbConfirm();
  fecharModal();
}
// Confirmação ESTILIZADA que devolve Promise<boolean> — troca o confirm() nativo
// (aquele "192.0.2.11 diz…") pelo modal do próprio app. Reaproveita o
// #modalConfirm; religa os DOIS botões (o Cancelar nativo não resolvia nada) e
// restaura os handlers/labels originais ao fechar, p/ não quebrar o confirmar()
// legado. Fallback pro confirm() nativo se o modal não existir na página.
function confirmarBonito(msg, opts) {
  const o = opts || {};
  const overlay = $("overlay");
  const modal = $("modalConfirm");
  const texto = $("confirmTexto");
  const box = modal ? modal.querySelector("div") : null;
  const botoes = box ? box.querySelectorAll("button") : [];
  const btnOk = botoes[0];
  const btnCancel = botoes[1];
  if (!overlay || !modal || !texto || !btnOk || !btnCancel) {
    return Promise.resolve(window.confirm(msg));
  }
  return new Promise((resolve) => {
    const okOld = btnOk.onclick;
    const cancelOld = btnCancel.onclick;
    const okTxt = btnOk.textContent;
    const cancelTxt = btnCancel.textContent;
    texto.innerText = msg;
    texto.style.whiteSpace = "pre-line"; // respeita as quebras \n da mensagem
    texto.style.textAlign = "left";
    btnOk.textContent = o.okLabel || "Sim";
    btnCancel.textContent = o.cancelLabel || "Cancelar";
    const finalizar = (v) => {
      overlay.classList.add("hidden");
      modal.classList.add("hidden");
      btnOk.onclick = okOld;
      btnCancel.onclick = cancelOld;
      btnOk.textContent = okTxt;
      btnCancel.textContent = cancelTxt;
      texto.style.whiteSpace = "";
      texto.style.textAlign = "";
      resolve(v);
    };
    btnOk.onclick = () => finalizar(true);
    btnCancel.onclick = () => finalizar(false);
    overlay.classList.remove("hidden");
    modal.classList.remove("hidden");
  });
}
window.confirmarBonito = confirmarBonito;
function fecharModalIA() {
  $("modalIA")?.classList.add("hidden");
  $("overlay")?.classList.add("hidden");
}

function fecharModalOcorrencias() {
  $("modalOcorrencias")?.classList.add("hidden");
  _restaurarAncoraModalOco();
}

// --- Enviar a lista do modal no WhatsApp ------------------------------
// Caminho "link wa.me": abre o WhatsApp já com o texto pronto; o usuário
// escolhe o grupo/contato e envia na mão. Sem API, sem custo, sem risco.
let _modalOcoTexto = null; // { titulo, colunas, linhas } em texto limpo

// Tira as tags/entidades HTML de uma célula e normaliza espaços.
function _stripHtml(html) {
  const d = document.createElement("div");
  d.innerHTML = String(html ?? "");
  return (d.textContent || "").replace(/\s+/g, " ").trim();
}

// Monta a mensagem de texto a partir do que está no modal.
// Cabeçalho em negrito + uma linha por registro; se a última coluna for
// "Detalhe"/"Erro", ela vai numa sub-linha (↳) e some quando é "sem detalhe".
const _MODAL_OCO_MAX_LINHAS = 60; // trava p/ não estourar o tamanho da URL
function _montarTextoWhatsApp() {
  const d = _modalOcoTexto;
  if (!d || !d.linhas.length) return "";
  const nCols = d.colunas.length;
  const ultLabel = String(d.colunas[nCols - 1] || "").toLowerCase();
  const ultEhDetalhe = ultLabel === "detalhe" || ultLabel === "erro";
  const usadas = d.linhas.slice(0, _MODAL_OCO_MAX_LINHAS);
  const linhas = usadas.map((cells) => {
    if (ultEhDetalhe && cells.length === nCols) {
      const cabeca = cells.slice(0, nCols - 1).filter(Boolean).join(" · ");
      const det = cells[nCols - 1];
      const semDet = !det || /^sem detalhe/i.test(det);
      return `• ${cabeca}` + (semDet ? "" : `\n   ↳ ${det}`);
    }
    return `• ${cells.filter(Boolean).join(" · ")}`;
  });
  const sobra = d.linhas.length - usadas.length;
  const rodape = sobra > 0 ? `\n\n… e mais ${sobra} registro(s).` : "";
  return `*${d.titulo}*\n\n${linhas.join("\n")}${rodape}`;
}

function enviarModalOcorrenciasWhatsApp() {
  const texto = _montarTextoWhatsApp();
  if (!texto) {
    alertar("Não há registros para enviar.");
    return;
  }
  // web.whatsapp.com/send força o WhatsApp WEB (no navegador), em vez de
  // abrir o app pelo wa.me. Depois de aberto, você escolhe o grupo/contato.
  const url = "https://web.whatsapp.com/send?text=" + encodeURIComponent(texto);
  const win = window.open(url, "_blank");
  // Alguns navegadores bloqueiam window.open; cai p/ navegação por âncora.
  if (!win) {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.click();
  }
}

// --- Modal de detalhes × Tela cheia dos gráficos ----------------------
// Quando um gráfico da aba Tendências está em tela cheia (Fullscreen API),
// o navegador só desenha o elemento em tela cheia e seus descendentes. O
// #modalOcorrencias fica lá no fim do <body>, fora do card — então clicar
// numa fatia até "abria" o modal, mas ele ficava invisível atrás da tela
// cheia. Solução: enquanto houver tela cheia, movemos o modal p/ DENTRO do
// elemento em tela cheia (aí ele entra na camada de cima e aparece por cima
// do gráfico) e o devolvemos ao lugar original ao fechar / sair da tela cheia.
let _modalOcoAncora = null; // { pai, proximo } p/ recolocar no lugar exato

function _reancorarModalNaTelaCheia() {
  const modal = $("modalOcorrencias");
  const fs = document.fullscreenElement;
  if (!modal || !fs || fs === modal || fs.contains(modal)) return;
  if (!_modalOcoAncora)
    _modalOcoAncora = { pai: modal.parentNode, proximo: modal.nextSibling };
  fs.appendChild(modal);
}

function _restaurarAncoraModalOco() {
  const modal = $("modalOcorrencias");
  if (modal && _modalOcoAncora)
    _modalOcoAncora.pai.insertBefore(modal, _modalOcoAncora.proximo);
  _modalOcoAncora = null;
}

// Saiu da tela cheia (Esc/F11). O navegador consome esse 1º Esc pra sair da
// tela cheia (nem chega keydown na página). Se o modal estava aberto POR CIMA
// do gráfico (relocado), fecha ele junto — assim um único Esc encerra gráfico
// + modal de uma vez. Sem modal relocado, só garante o modal de volta no body.
document.addEventListener("fullscreenchange", () => {
  if (document.fullscreenElement) return;
  if (_modalOcoAncora) fecharModalOcorrencias();
  else _restaurarAncoraModalOco();
});

// Esc fecha o modal de detalhes aberto no clique de uma fatia (caso o gráfico
// NÃO esteja em tela cheia — nesse caso o keydown chega normalmente à página).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const modal = $("modalOcorrencias");
  if (modal && !modal.classList.contains("hidden")) fecharModalOcorrencias();
});

// --- Infra genérica do modal de detalhes das Tendências ---------------
// Renderiza uma tabela qualquer (cabeçalhos + linhas) dentro do modal.
// As células de `linhas` já vêm como HTML pronto (o chamador escapa).
function abrirModalTend(tituloHtml, colunas, linhas) {
  // Guarda uma versão em TEXTO LIMPO do que está no modal, p/ o botão
  // "Enviar no WhatsApp" montar a mensagem (as células vêm como HTML).
  _modalOcoTexto = {
    titulo: _stripHtml(tituloHtml),
    colunas: colunas.slice(),
    linhas: linhas.map((cells) => cells.map(_stripHtml)),
  };

  const titulo = $("modalOcoTitulo");
  if (titulo) titulo.innerHTML = tituloHtml;

  const conteudo = $("modalOcoConteudo");
  if (conteudo) {
    if (!linhas.length) {
      conteudo.innerHTML = `<p style="color:var(--text-muted);">Nenhum registro encontrado para este item no período filtrado.</p>`;
    } else {
      const ths = colunas
        .map(
          (c) =>
            `<th style="padding:8px 10px;">${escapar(c)}</th>`,
        )
        .join("");
      const trs = linhas
        .map(
          (cells) =>
            `<tr style="border-bottom:1px solid var(--border);">${cells
              .map(
                (cel) =>
                  `<td style="padding:9px 10px;color:var(--text-secondary);vertical-align:top;">${cel}</td>`,
              )
              .join("")}</tr>`,
        )
        .join("");
      conteudo.innerHTML = `
        <table data-ordenavel style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="text-align:left;color:var(--text-muted);text-transform:uppercase;font-size:11px;letter-spacing:0.5px;">${ths}</tr>
          </thead>
          <tbody>${trs}</tbody>
        </table>`;
    }
  }

  _reancorarModalNaTelaCheia();
  $("modalOcorrencias")?.classList.remove("hidden");
}

function _tendDataISO(o) {
  return String(o.data_ocorrencia || o.data || "").split("T")[0];
}
function _tendOrdenarPorDataDesc(lista) {
  return lista
    .slice()
    .sort((a, b) => String(_tendDataISO(b)).localeCompare(String(_tendDataISO(a))));
}
function _tendCelData(o) {
  return `<span style="white-space:nowrap;font-weight:700;">${escapar(formatarDataBR(_tendDataISO(o)))}</span>`;
}
function _tendCelLoja(o) {
  return `<span style="white-space:nowrap;color:var(--azul);">${escapar(formatarNomeLoja(o.loja) || "—")}</span>`;
}
function _tendErroDe(o) {
  const tipo = o.tipo_problema || o.problema_operacional_tipo || "";
  const desc = o.descricao || o.problema_operacional_relato || "";
  return [tipo, desc].filter(Boolean).join(" — ") || "Sem detalhe informado";
}
function _tendTitulo(emoji, texto, n, singular, plural) {
  const u = n === 1 ? singular : plural || `${singular}s`;
  return `${emoji} ${escapar(texto)} <span style="color:var(--text-muted);font-weight:600;font-size:13px;">· ${n} ${u}</span>`;
}
function _tendCursorHover(evt, els) {
  const alvo = evt?.native?.target;
  if (alvo) alvo.style.cursor = els.length ? "pointer" : "default";
}

// Abre o modal com as ocorrências de uma origem (responsável).
function abrirModalOcorrenciasOrigem(origem, lista) {
  const alvo = String(origem || "").trim();
  const registros = (lista || []).filter((o) => {
    if (!o.teve_ocorrencia) return false;
    const resp = obterResponsavelOcorrencia(o) || "NÃO INFORMADO";
    return resp
      .split(/,|;|\|/)
      .map((s) => s.trim())
      .includes(alvo);
  });
  const linhas = _tendOrdenarPorDataDesc(registros).map((o) => [
    _tendCelData(o),
    _tendCelLoja(o),
    escapar(_tendErroDe(o)),
  ]);
  abrirModalTend(
    _tendTitulo("⚠️", alvo, registros.length, "ocorrência", "ocorrências"),
    ["Dia", "Loja", "Erro"],
    linhas,
  );
}

// Abre o modal com as ocorrências de um tipo de problema (clique na pizza).
function abrirModalOcorrenciasTipo(tipo, lista) {
  const alvo = String(tipo || "").trim();
  const registros = (lista || []).filter((o) => {
    if (!o.teve_ocorrencia) return false;
    const t = String(o.tipo_problema || "").trim();
    if (!t) return alvo === "Não informado";
    return t
      .split(/,|;|\|/)
      .map((s) => s.trim())
      .includes(alvo);
  });
  const linhas = _tendOrdenarPorDataDesc(registros).map((o) => [
    _tendCelData(o),
    _tendCelLoja(o),
    `<span style="color:var(--text-muted);white-space:nowrap;">${escapar(obterRotaDaOcorrencia(o) || "—")}</span>`,
    escapar(o.descricao || o.problema_operacional_relato || "Sem detalhe informado"),
  ]);
  abrirModalTend(
    _tendTitulo("🚧", alvo, registros.length, "ocorrência", "ocorrências"),
    ["Dia", "Loja", "Rota", "Detalhe"],
    linhas,
  );
}

// Lista todas as entregas de um conjunto (Dia · Loja · Rota).
function abrirModalEntregasLista(titulo, lista) {
  const linhas = _tendOrdenarPorDataDesc(lista).map((o) => [
    _tendCelData(o),
    _tendCelLoja(o),
    `<span style="color:var(--text-muted);">${escapar(obterRotaDaOcorrencia(o))}</span>`,
  ]);
  abrirModalTend(
    _tendTitulo("📦", titulo, lista.length, "entrega", "entregas"),
    ["Dia", "Loja", "Rota"],
    linhas,
  );
}

// Lista só as entregas com ocorrência de um conjunto (Dia · Loja · Erro).
function abrirModalOcorrenciasLista(titulo, lista) {
  const ocos = lista.filter((o) => o.teve_ocorrencia);
  const linhas = _tendOrdenarPorDataDesc(ocos).map((o) => [
    _tendCelData(o),
    _tendCelLoja(o),
    escapar(_tendErroDe(o)),
  ]);
  abrirModalTend(
    _tendTitulo("⚠️", titulo, ocos.length, "ocorrência", "ocorrências"),
    ["Dia", "Loja", "Erro"],
    linhas,
  );
}

// ================================================================
// 15. INSIGHTS IA
// ================================================================
async function gerarInsightsIA() {
  $("overlay")?.classList.remove("hidden");
  $("modalIA")?.classList.remove("hidden");
  const textoIA = $("textoIA");
  if (textoIA) textoIA.innerHTML = "⏳ Analisando seus dados...";

  try {
    carregandoHistorico = false;
    await carregarHistorico(true);
  } catch (e) {}

  const diaSel = $("iaDataAnalise")?.value || "";
  const dataDe = (o) => String(o.data_ocorrencia || o.data || "").split("T")[0];
  const base = diaSel
    ? ocorrencias.filter((o) => dataDe(o) === diaSel)
    : ocorrencias;
  if (base.length === 0) {
    if (textoIA)
      textoIA.innerHTML = diaSel
        ? `<p>Nenhuma entrega registrada em <strong>${formatarDataBR(diaSel)}</strong>.</p>`
        : "<p>Nenhum dado disponível para análise.</p>";
    return;
  }

  const total = base.length;
  const comOco = base.filter((o) => o.teve_ocorrencia).length;
  const semOco = total - comOco;
  const taxa = Math.round((semOco / total) * 100);

  const semCk = base.filter(
    (o) =>
      o.fez_checklist !== true &&
      o.fez_checklist !== "true" &&
      o.fez_checklist !== "sim",
  ).length;

  const tipos = {};
  base
    .filter((o) => o.teve_ocorrencia)
    .forEach((o) => {
      if (o.tipo_problema)
        tipos[o.tipo_problema] = (tipos[o.tipo_problema] || 0) + 1;
    });
  const topTipos = Object.entries(tipos)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  const mots = {};
  base.forEach((o) => {
    if (!o.motorista) return;
    if (!mots[o.motorista]) mots[o.motorista] = { total: 0, com: 0 };
    mots[o.motorista].total++;
    if (o.teve_ocorrencia) mots[o.motorista].com++;
  });
  const rankMot = Object.entries(mots)
    .map(([nome, d]) => ({
      nome,
      taxa: Math.round(((d.total - d.com) / d.total) * 100),
      com: d.com,
      total: d.total,
    }))
    .sort((a, b) => a.taxa - b.taxa);
  const piorMot = rankMot[0];
  const melhorMot = rankMot[rankMot.length - 1];

  const rotasMap = {};
  base.forEach((o) => {
    const r = obterRotaDaOcorrencia(o);
    if (!r || r === "Externa" || r === "AVISOS") return;
    if (!rotasMap[r]) rotasMap[r] = { total: 0, com: 0 };
    rotasMap[r].total++;
    if (o.teve_ocorrencia) rotasMap[r].com++;
  });
  const rotaCritica = Object.entries(rotasMap)
    .map(([r, d]) => ({
      r,
      pct: Math.round((d.com / d.total) * 100),
      total: d.total,
    }))
    .filter((d) => d.total >= 3)
    .sort((a, b) => b.pct - a.pct)[0];

  const d7 = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
  const rec = ocorrencias.filter((o) => dataDe(o) >= d7);
  const taxaRec = rec.length
    ? Math.round(
        ((rec.length - rec.filter((o) => o.teve_ocorrencia).length) /
          rec.length) *
          100,
      )
    : null;

  const ok = (b) => (b ? "✅" : "⚠️");
  const bloco = (cor, titulo, html) => `
    <div style="margin-bottom:14px;padding:13px 15px;background:rgba(${cor},0.07);border-radius:10px;border:1px solid rgba(${cor},0.22);">
      <div style="font-size:0.78rem;font-weight:800;text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px;color:rgba(${cor},1);">${titulo}</div>
      ${html}
    </div>`;
  const li = (t) => `<p style="margin:3px 0;font-size:13px;">${t}</p>`;

  const html = `<div style="font-family:inherit;line-height:1.7;">
    ${bloco(
      "56,189,248",
      "📊 Diagnóstico Geral",
      [
        li(
          `📅 Período: <strong>${diaSel ? formatarDataBR(diaSel) : "todos os dados"}</strong>`,
        ),
        li(`Total de entregas analisadas: <strong>${total}</strong>`),
        li(
          `${ok(taxa >= 90)} Taxa de sucesso: <strong style="color:${taxa >= 90 ? "#34d399" : "#f87171"}">${taxa}%</strong> (meta: 90%)`,
        ),
        li(
          `${ok(semCk === 0)} Sem checklist: <strong>${semCk}</strong> (${Math.round((semCk / total) * 100)}%)`,
        ),
        taxaRec !== null
          ? li(
              `📅 Últimos 7 dias: <strong>${taxaRec}%</strong> de sucesso em ${rec.length} entregas`,
            )
          : "",
      ].join(""),
    )}
    ${bloco(
      "248,113,113",
      "⚠️ Principais Riscos",
      [
        topTipos.length
          ? li("Ocorrências mais frequentes:") +
            `<ul style="margin:4px 0 0 18px;font-size:13px;">${topTipos.map(([t, n]) => `<li><strong>${t}</strong>: ${n}×</li>`).join("")}</ul>`
          : li("Nenhuma ocorrência de entrega registrada."),
        piorMot
          ? li(
              `${ok(piorMot.taxa >= 80)} Motorista com mais atenção: <strong>${piorMot.nome}</strong> — ${piorMot.taxa}% de sucesso (${piorMot.com} ocorrência(s) em ${piorMot.total} entregas)`,
            )
          : "",
        rotaCritica
          ? li(
              `🛣️ Rota crítica: <strong>${rotaCritica.r}</strong> — ${rotaCritica.pct}% das entregas com ocorrência`,
            )
          : "",
      ].join(""),
    )}
    ${bloco(
      "52,211,153",
      "💡 Recomendações",
      [
        taxa < 90
          ? li(
              "📌 Taxa abaixo da meta — reforçar briefing pré-entrega e acompanhamento durante a rota.",
            )
          : li("✅ Taxa dentro da meta. Manter o padrão operacional atual."),
        semCk > 0
          ? li(
              `📌 ${semCk} entrega(s) sem checklist — cobrar preenchimento diário antes da saída.`,
            )
          : "",
        piorMot && piorMot.taxa < 80
          ? li(
              `📌 Conversa individual recomendada com <strong>${piorMot.nome}</strong> sobre recorrência de ocorrências.`,
            )
          : "",
        rotaCritica && rotaCritica.pct > 20
          ? li(
              `📌 Revisar processo de entrega na rota <strong>${rotaCritica.r}</strong>.`,
            )
          : "",
        melhorMot && melhorMot !== piorMot
          ? li(
              `🏆 Destaque positivo: <strong>${melhorMot.nome}</strong> com ${melhorMot.taxa}% de sucesso em ${melhorMot.total} entregas.`,
            )
          : "",
      ].join(""),
    )}
  </div>`;

  if (textoIA) textoIA.innerHTML = html;
}

// Limpa o filtro de dia dos insights e reanalisa todos os dados.
function limparDataInsights() {
  const el = $("iaDataAnalise");
  if (el) el.value = "";
  gerarInsightsIA();
}

// ================================================================
// 16. RELÓGIO
// ================================================================
function atualizarRelogio() {
  const el = $("relogio");
  if (el) el.innerText = new Date().toLocaleTimeString("pt-BR");
}
atualizarRelogio(); // mostra a hora certa já no load (não espera 1s)
setInterval(atualizarRelogio, 1000);

// ================================================================
// 17. AVISOS DE MONITORAMENTO
// ================================================================
function renderizarAvisosMonitoramento() {
  const lista = lerStorage(LS.avisos);
  const container = $("listaAvisosMonitoramento");
  const hoje = hojeISO();
  const qtdHoje = lista.filter((a) => a.data === hoje).length;
  ["badgeAvisosMonitoramento", "badgeNavMonitoramento"].forEach((id) => {
    const b = $(id);
    if (!b) return;
    b.style.display = qtdHoje ? "inline-flex" : "none";
    b.textContent =
      id === "badgeNavMonitoramento" ? String(qtdHoje) : `${qtdHoje} hoje`;
  });
  if (!container) return;
  container.innerHTML =
    lista.length === 0
      ? `<p style="color:var(--text-muted);">Nenhum aviso registrado.</p>`
      : lista
          .map(
            (a) => `
        <div class="item" style="border-left:4px solid #f97316;padding:16px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;">
            <div>
              <strong style="color:var(--text-heading);">📡 ${escapar(a.motorista)}</strong>
              <span style="color:var(--text-muted);font-size:12px;margin-left:8px;">${escapar(a.placa)} • ${escapar(a.rota || "Sem rota")}</span><br>
              <span style="color:var(--text-secondary);font-size:13px;">${escapar((a.tipos || []).join(", "))}</span><br>
              <small style="color:var(--text-muted);">${escapar(formatarDataBR(a.data))} ${escapar(a.hora || "")}</small>
              ${a.justificativa ? `<br><small style="color:var(--text-muted);">📝 ${escapar(a.justificativa)}</small>` : ""}
            </div>
            <button type="button" onclick="excluirAvisoMonitoramento(${a.id})" class="btn-red btn-sm">🗑️</button>
          </div>
        </div>`,
          )
          .join("");
}

function abrirFormAviso() {
  $("formAviso")?.classList.remove("hidden");
  if (!getVal("avisoData")) setVal("avisoData", hojeISO());
  if (!getVal("avisoHora")) setVal("avisoHora", horaAgora());
  setTimeout(
    () =>
      $("formAviso")?.scrollIntoView({ behavior: "smooth", block: "start" }),
    50,
  );
}
function fecharFormAviso() {
  $("formAviso")?.classList.add("hidden");
}
function limparFormAviso() {
  [
    "avisoData",
    "avisoHora",
    "avisoMotorista",
    "avisoPlaca",
    "avisoRota",
    "avisoStatus",
    "avisoJustificativa",
  ].forEach((id) => setVal(id, ""));
  limparGrupoMulti("avisoTipo");
  popularSelectAvisoRota();
  const h = $("avisoRotaHint");
  if (h) h.style.display = "none";
}

// Popula o select de rota do formulario de avisos com a lista canonica de rotas.
function popularSelectAvisoRota() {
  const sel = $("avisoRota");
  if (!sel || typeof _ROTAS_PLANILHA === "undefined") return;
  const atual = sel.value;
  sel.innerHTML =
    '<option value="">Selecione a rota</option>' +
    _ROTAS_PLANILHA.map((r) => `<option value="${r}">${r}</option>`).join("");
  if (atual) selecionarRotaAviso(atual);
}

// Seleciona uma rota no select; se ela nao estiver na lista, adiciona como opcao extra.
function selecionarRotaAviso(valor) {
  const sel = $("avisoRota");
  if (!sel || !valor) return;
  const existe = [...sel.options].some((op) => op.value === valor);
  if (!existe) {
    const op = document.createElement("option");
    op.value = valor;
    op.textContent = valor;
    sel.appendChild(op);
  }
  sel.value = valor;
}

async function avisoPuxarRota() {
  const mot = getVal("avisoMotorista");
  const data = getVal("avisoData") || hojeISO();
  const h = $("avisoRotaHint");
  if (!mot) return;

  // Prioridade 1: escala do dia
  let escalas = lerStorage("entregasDia");
  if (!escalas.length) escalas = await carregarEntregasDiaBanco();
  const escala = escalas.find(
    (e) =>
      normTexto(e.motorista) === normTexto(mot) &&
      String(e.data || "").split("T")[0] === data,
  );
  if (escala?.rota) {
    selecionarRotaAviso(escala.rota);
    if (h) {
      h.textContent = `✓ Rota da escala do dia: ${escala.rota}${escala.missao && escala.missao !== "Principal" ? ` (${escala.missao})` : ""}`;
      h.style.display = "block";
    }
    return;
  }

  // Fallback: último registro de ocorrência
  const ult = [...ocorrencias]
    .reverse()
    .find(
      (o) => normTexto(o.motorista) === normTexto(mot) && (o.loja || o.rota),
    );
  if (ult && !getVal("avisoRota")) {
    selecionarRotaAviso(obterRotaDaOcorrencia(ult));
    if (h) {
      h.textContent = "Rota sugerida pelo último registro desse motorista.";
      h.style.display = "block";
    }
  }
}

async function salvarAviso() {
  const tipos = selecionadosGrupo("avisoTipo");
  const reg = {
    id: gerarIdCompatBanco(), // nunca Date.now() cru — ver o helper no core
    data: getVal("avisoData"),
    hora: getVal("avisoHora") || horaAgora(),
    motorista: getVal("avisoMotorista"),
    placa: getVal("avisoPlaca"),
    rota: getVal("avisoRota"),
    tipos,
    status: getVal("avisoStatus") || "Pendente",
    justificativa: getVal("avisoJustificativa"),
  };
  if (!reg.data || !reg.motorista || !reg.placa || tipos.length === 0) {
    alertar("Preencha data, motorista, placa e pelo menos um tipo de aviso.");
    return;
  }
  const lista = lerStorage(LS.avisos);
  lista.unshift(reg);
  if (!(await salvarStorage(LS.avisos, lista))) return;
  limparFormAviso();
  fecharFormAviso();
  renderizarAvisosMonitoramento();
  alertar("✅ Aviso salvo com sucesso.");
}

function excluirAvisoMonitoramento(id) {
  confirmarSimples("Deseja excluir este aviso?", async () => {
    if (
      !(await salvarStorage(
        LS.avisos,
        lerStorage(LS.avisos).filter((a) => String(a.id) !== String(id)),
      ))
    )
      return;
    renderizarAvisosMonitoramento();
  });
}

// ================================================================
// 18. CHECKLIST DIÁRIO
// ================================================================
function renderizarListaChecklistDiario() {
  renderizarListaChecklistComFiltro(
    getVal("checklistFiltroData") || getVal("veiculosFiltroData"),
  );
}
function limparFiltroChecklist() {
  setVal("checklistFiltroData", "");
  renderizarListaChecklistDiario();
}

function abrirFormChecklistDiario() {
  $("formChecklistDiario")?.classList.remove("hidden");
  if (!getVal("ckData")) setVal("ckData", hojeISO());
  setTimeout(
    () =>
      $("formChecklistDiario")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      }),
    50,
  );
}
function fecharFormChecklistDiario() {
  $("formChecklistDiario")?.classList.add("hidden");
}
function limparFormChecklistDiario() {
  ["ckData", "ckMotorista", "ckPlaca", "ckRota", "ckObs"].forEach((id) =>
    setVal(id, ""),
  );
  document.querySelectorAll(".ck-item").forEach((c) => (c.checked = false));
  $("ckAlertaDuplicata")?.classList.add("hidden");
}

async function salvarChecklistDiario() {
  const itens = Array.from(document.querySelectorAll(".ck-item:checked")).map(
    (c) => c.value,
  );
  const reg = {
    id: gerarIdCompatBanco(), // nunca Date.now() cru — ver o helper no core
    data: getVal("ckData"),
    motorista: getVal("ckMotorista"),
    placa: getVal("ckPlaca"),
    rota: getVal("ckRota"),
    itens,
    totalItens: itens.length,
    obs: getVal("ckObs"),
  };
  if (!reg.data || !reg.motorista || !reg.placa) {
    alertar("Preencha data, motorista e placa do checklist.");
    return;
  }
  if (itens.length === 0) {
    alertar("Marque pelo menos um item verificado.");
    return;
  }
  const lista = lerStorage(LS.checklist);
  if (lista.some((c) => c.data === reg.data && c.placa === reg.placa)) {
    const a = $("ckAlertaDuplicata");
    if (a) a.classList.remove("hidden");
  }
  lista.unshift(reg);
  if (!(await salvarStorage(LS.checklist, lista))) return;
  limparFormChecklistDiario();
  fecharFormChecklistDiario();
  renderizarListaChecklistDiario();
  if (typeof atualizarBlocoStatusChecklist === "function")
    atualizarBlocoStatusChecklist();
  alertar("✅ Checklist salvo com sucesso.");
}

function excluirChecklistDiario(id) {
  confirmarSimples("Deseja excluir este checklist?", async () => {
    if (
      !(await salvarStorage(
        LS.checklist,
        lerStorage(LS.checklist).filter((c) => String(c.id) !== String(id)),
      ))
    )
      return;
    renderizarListaChecklistDiario();
  });
}

// ================================================================
// 19. ATRASO SAÍDA DA FÁBRICA
// ================================================================
// Monta o card de um atraso na saída. Compartilhado pelos dois
// renderizadores (lista simples aqui e lista com filtro no script-7).
function montarCardAtrasoSaida(a) {
  const atrasado = Number(a.atrasoMin || 0) > 0;
  const cor = atrasado ? "var(--vermelho)" : "var(--verde)";
  const badge = atrasado
    ? `<span class="atraso-badge atraso-badge--late">${escapar(a.atrasoFormatado)}</span>`
    : `<span class="atraso-badge atraso-badge--ok">No horário</span>`;
  return `
    <div class="item atraso-card" style="border-left:4px solid ${cor};">
      <div class="atraso-card__head">
        <div class="atraso-card__title">
          <span class="atraso-card__name">⏰ ${escapar(a.motorista)}</span>
          <span class="atraso-card__date">${escapar(formatarDataBR(a.data))}</span>
        </div>
        <button type="button" onclick="excluirAtrasoSaida(${a.id})" class="btn-red btn-sm">🗑️</button>
      </div>
      <div class="atraso-card__meta">
        <span class="chip">🚚 ${escapar(a.placa || "-")}</span>
        <span class="chip">📍 ${escapar(a.rota || "-")}</span>
      </div>
      <div class="atraso-card__times">
        <span>Marcada <b>${escapar(a.horaMarcada || "-")}</b></span>
        <span>Real <b>${escapar(a.horaReal || "-")}</b></span>
        ${badge}
      </div>
      ${a.justificativa ? `<div class="atraso-card__obs">📝 ${escapar(a.justificativa)}</div>` : ""}
    </div>`;
}

// ================================================================
// ORDENACAO DE LISTAS DE CARTOES (aba Veiculos)
// ----------------------------------------------------------------
// Estas secoes sao listas de CARTOES, nao <table>: o tabela-ordenavel.js so
// alcanca table[data-ordenavel] e nao chega nelas. Este bloco faz o mesmo
// papel, com as mesmas setas (⇅ ▲ ▼), para nao existirem dois jeitos de
// ordenar no sistema.
//
// DATA e sempre o criterio padrao e comeca pelo mais RECENTE: e assim que se
// procura registro na operacao ("o que aconteceu no dia 20?").
//
// Para ligar uma lista nova: registre os campos aqui e chame, no renderizador
// dela, ordenarCartoes(chave, lista) e barraOrdenacaoCartoes(chave).
// ================================================================
const CARTOES_ORDENAVEIS = {};

function registrarListaOrdenavel(chave, campos) {
  // dir: 1 crescente, -1 decrescente. O PRIMEIRO campo declarado e o padrao.
  const primeiro = Object.keys(campos)[0];
  CARTOES_ORDENAVEIS[chave] = {
    campos,
    campo: primeiro,
    dir: primeiro === "data" ? -1 : 1,
  };
}

registrarListaOrdenavel("atrasoSaida", {
  data: { rotulo: "Data", valor: (a) => String(a.data || "") },
  atraso: { rotulo: "Atraso", valor: (a) => Number(a.atrasoMin || 0) },
  motorista: { rotulo: "Motorista", valor: (a) => String(a.motorista || "") },
});

// Tempo usa `totalMin`, a jornada inteira. NAO usar `minutos`: e so o resto da
// divisao (o "30" de 10h30) e ordenaria 10h30 antes de 9h45.
registrarListaOrdenavel("tempoRota", {
  data: { rotulo: "Data", valor: (r) => String(r.data || "") },
  tempo: { rotulo: "Tempo", valor: (r) => Number(r.totalMin || 0) },
  excedente: { rotulo: "Excedente", valor: (r) => Number(r.minutosExcedentes || 0) },
  motorista: { rotulo: "Motorista", valor: (r) => String(r.motorista || "") },
  rota: { rotulo: "Rota", valor: (r) => String(r.rotaFeita || "") },
});

// `diferenca` e quanto passou do previsto (negativo = voltou antes).
// `tempoReal` e a duracao do almoco em minutos.
registrarListaOrdenavel("almoco", {
  data: { rotulo: "Data", valor: (a) => String(a.data || "") },
  excedente: { rotulo: "Excedente", valor: (a) => Number(a.diferenca || 0) },
  duracao: { rotulo: "Duracao", valor: (a) => Number(a.tempoReal || 0) },
  motorista: { rotulo: "Motorista", valor: (a) => String(a.motorista || "") },
});

function ordenarCartoes(chave, lista) {
  const est = CARTOES_ORDENAVEIS[chave];
  const cfg = est && est.campos[est.campo];
  if (!cfg) return lista;
  // slice(): nao reordena o array do cache, so a copia que vai para a tela.
  return lista.slice().sort((x, y) => {
    const a = cfg.valor(x);
    const b = cfg.valor(y);
    if (typeof a === "number" && typeof b === "number") return (a - b) * est.dir;
    // Data vem em ISO (AAAA-MM-DD): comparar como texto ja ordena certo.
    return String(a).localeCompare(String(b), "pt-BR", { numeric: true }) * est.dir;
  });
}

function barraOrdenacaoCartoes(chave) {
  const est = CARTOES_ORDENAVEIS[chave];
  if (!est) return "";
  const botoes = Object.keys(est.campos)
    .map((campo) => {
      const cfg = est.campos[campo];
      const ativo = est.campo === campo;
      const seta = ativo ? (est.dir === 1 ? "\u25b2" : "\u25bc") : "\u21c5";
      const dica = ativo
        ? est.dir === 1
          ? "Inverter: maior primeiro"
          : "Inverter: menor primeiro"
        : "Ordenar por " + cfg.rotulo;
      return `<button type="button" class="btn-ghost btn-sm" title="${dica}"
        onclick="ordenarCartoesPor('${chave}','${campo}')"
        style="font-weight:${ativo ? 800 : 600};">${cfg.rotulo}
        <span style="margin-left:4px;font-size:9px;opacity:${ativo ? 1 : 0.3};">${seta}</span>
      </button>`;
    })
    .join("");
  return `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:10px;">
    <span style="font-size:11px;color:var(--text-muted);font-weight:700;letter-spacing:.5px;">ORDENAR POR</span>
    ${botoes}
  </div>`;
}

function ordenarCartoesPor(chave, campo) {
  const est = CARTOES_ORDENAVEIS[chave];
  if (!est || !est.campos[campo]) return;
  // Mesmo campo: inverte. Campo novo: data comeca no mais recente, o resto do
  // menor para o maior.
  if (est.campo === campo) {
    est.dir = -est.dir;
  } else {
    est.campo = campo;
    est.dir = campo === "data" ? -1 : 1;
  }
  // Redesenha respeitando os filtros da aba, quando existem.
  if (typeof aplicarFiltroVeiculos === "function") aplicarFiltroVeiculos();
  else if (typeof renderizarListaAtrasosSaida === "function") renderizarListaAtrasosSaida();
}

function renderizarListaAtrasosSaida() {
  const lista = ordenarCartoes("atrasoSaida", lerStorage(LS.atrasos));
  const container = $("listaAtrasosSaida");
  if (!container) return;
  container.innerHTML =
    lista.length === 0
      ? barraOrdenacaoCartoes("atrasoSaida") + `<p style="color:var(--text-muted);">Nenhum atraso registrado.</p>`
      : barraOrdenacaoCartoes("atrasoSaida") + lista.map(montarCardAtrasoSaida).join("");
}

function abrirFormAtrasoSaida() {
  $("formAtrasoSaida")?.classList.remove("hidden");
  if (!getVal("dataAtrasoSaida")) setVal("dataAtrasoSaida", hojeISO());
  setTimeout(
    () =>
      $("formAtrasoSaida")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      }),
    50,
  );
}
function fecharFormAtrasoSaida() {
  $("formAtrasoSaida")?.classList.add("hidden");
}
function limparFormAtrasoSaida() {
  [
    "dataAtrasoSaida",
    "motoristaAtrasoSaida",
    "placaAtrasoSaida",
    "rotaAtrasoSaida",
    "horaMarcadaAtrasoSaida",
    "horaRealAtrasoSaida",
    "justificativaAtrasoSaida",
  ].forEach((id) => setVal(id, ""));
  const p = $("painelAtrasoSaida");
  if (p) p.style.display = "none";
}

function calcularAtrasoSaida() {
  const marcada = getVal("horaMarcadaAtrasoSaida"),
    real = getVal("horaRealAtrasoSaida");
  if (!marcada || !real) {
    alertar("Informe a hora marcada e a hora real.");
    return 0;
  }
  if (Number.isNaN(minutos(marcada)) || Number.isNaN(minutos(real))) {
    alertar("Informe horas validas para calcular o atraso.");
    return 0;
  }
  const atraso = Math.max(0, minutos(real) - minutos(marcada));
  const painel = $("painelAtrasoSaida");
  if (painel) painel.style.display = "block";
  const tempo = $("textoTempoAtrasoSaida");
  if (tempo)
    tempo.innerHTML = `Atraso calculado: <strong>${formatarTempo(atraso)}</strong>`;
  const status = $("textoStatusAtrasoSaida");
  if (status) {
    status.style.color = atraso > 0 ? "var(--vermelho)" : "var(--verde)";
    status.textContent =
      atraso > 0
        ? `⚠️ Saiu com atraso de ${formatarTempo(atraso)}`
        : "✅ Saiu no horário";
  }
  return atraso;
}

async function salvarAtrasoSaida() {
  const reg = {
    id: gerarIdCompatBanco(),
    data: getVal("dataAtrasoSaida"),
    motorista: getVal("motoristaAtrasoSaida"),
    placa: getVal("placaAtrasoSaida"),
    rota: getVal("rotaAtrasoSaida"),
    horaMarcada: getVal("horaMarcadaAtrasoSaida"),
    horaReal: getVal("horaRealAtrasoSaida"),
    justificativa: getVal("justificativaAtrasoSaida"),
  };
  if (
    !reg.data ||
    !reg.motorista ||
    !reg.placa ||
    !reg.horaMarcada ||
    !reg.horaReal
  ) {
    alertar("Preencha data, motorista, placa, hora marcada e hora real.");
    return;
  }
  reg.atrasoMin = Math.max(0, minutos(reg.horaReal) - minutos(reg.horaMarcada));
  reg.atrasoFormatado = formatarTempo(reg.atrasoMin);
  const lista = lerStorage(LS.atrasos);
  lista.unshift(reg);
  if (!(await salvarStorage(LS.atrasos, lista))) return;
  limparFormAtrasoSaida();
  fecharFormAtrasoSaida();
  renderizarListaAtrasosSaida();
  alertar("✅ Atraso/saída salvo com sucesso.");
}

function excluirAtrasoSaida(id) {
  confirmarSimples("Deseja excluir este registro?", async () => {
    if (
      !(await salvarStorage(
        LS.atrasos,
        lerStorage(LS.atrasos).filter((a) => String(a.id) !== String(id)),
      ))
    )
      return;
    renderizarListaAtrasosSaida();
  });
}

// ================================================================
// 20. CONTROLE DE ROTAS
// ================================================================
function renderizarListaRotas() {
  if (typeof renderizarListaRotasComFiltro === "function") {
    renderizarListaRotasComFiltro();
    return;
  }
  const lista = lerStorage(LS.rotas);
  const container = $("listaRotas");
  if (!container) return;
  container.innerHTML =
    lista.length === 0
      ? `<p style="color:var(--text-muted);">Nenhuma rota registrada.</p>`
      : lista
          .map(
            (r) => `
        <div class="item" style="border-left:4px solid ${Number(r.minutosExcedentes || 0) > 0 ? "var(--vermelho)" : "var(--verde)"};padding:16px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;">
            <div><strong style="color:var(--text-heading);">🚛 ${escapar(r.motorista)}</strong>
              <span style="color:var(--text-muted);font-size:12px;margin-left:8px;">${escapar(r.placa)} • ${escapar(r.rotaFeita || "-")}</span><br>
              <span style="color:var(--text-secondary);font-size:13px;">${escapar(r.saida)} → ${escapar(r.retorno)} • ${escapar(`${r.horas || 0}h ${r.minutos || 0}min`)}</span><br>
              ${r.responsavelAnalise ? `<span style="color:var(--text-muted);font-size:12px;">🔎 Análise: ${escapar(r.responsavelAnalise)}</span><br>` : ""}
              <small style="color:var(--text-muted);">${escapar(formatarDataBR(r.data))} • Extra: R$ ${Number(
                r.valorExtraAprox || 0,
              )
                .toFixed(2)
                .replace(".", ",")}</small>
              ${r.obs ? `<br><small style="color:var(--text-muted);">📝 ${escapar(r.obs)}</small>` : ""}
            </div>
            <button type="button" onclick="excluirRota(${r.id})" class="btn-red btn-sm">🗑️</button>
          </div>
        </div>`,
          )
          .join("");
}

function abrirFormRota() {
  $("formRota")?.classList.remove("hidden");
  if (!getVal("dataRota")) setVal("dataRota", hojeISO());
  setTimeout(
    () => $("formRota")?.scrollIntoView({ behavior: "smooth", block: "start" }),
    50,
  );
}
function fecharFormRota() {
  $("formRota")?.classList.add("hidden");
}
function limparFormRota() {
  [
    "dataRota",
    "motoristaRota",
    "placaRota",
    "responsavelAnaliseRota",
    "rotaFeita",
    "rotaSaida",
    "rotaRetorno",
    "rotaParadaHotel",
    "rotaSaidaHotel",
    "rotaObs",
  ].forEach((id) => setVal(id, ""));
  const cb = $("rotaEhViagem");
  if (cb) cb.checked = false;
  toggleCamposViagemRota();
  const p = $("painelRota");
  if (p) p.style.display = "none";
}

// Viagem (pernoite): mostra/esconde os campos de hotel e ajusta os rotulos
// (saida = saida da fabrica dia 1; retorno = chegada a fabrica dia 2).
function toggleCamposViagemRota() {
  const ehViagem = !!$("rotaEhViagem")?.checked;
  const campoHotelChegada = $("campoParadaHotel");
  const campoHotelSaida = $("campoSaidaHotel");
  if (campoHotelChegada) campoHotelChegada.style.display = ehViagem ? "" : "none";
  if (campoHotelSaida) campoHotelSaida.style.display = ehViagem ? "" : "none";
  if (!ehViagem) {
    setVal("rotaParadaHotel", "");
    setVal("rotaSaidaHotel", "");
  }
  const lblSaida = $("labelRotaSaida");
  if (lblSaida)
    lblSaida.textContent = ehViagem
      ? "Hora de saída da fábrica (dia 1)"
      : "Hora de saída da fábrica";
  const lblRetorno = $("labelRotaRetorno");
  if (lblRetorno)
    lblRetorno.textContent = ehViagem
      ? "Hora de chegada à fábrica (dia 2)"
      : "Hora de retorno à fábrica";
}

function calcularDadosRota() {
  const saida = getVal("rotaSaida"),
    retorno = getVal("rotaRetorno");
  const isViagem = !!$("rotaEhViagem")?.checked;
  const paradaHotel = getVal("rotaParadaHotel");
  const saidaHotel = getVal("rotaSaidaHotel");
  // Trecho HH:MM com guarda de virada de dia (negativo => +24h).
  const trecho = (de, para) => {
    let m = minutos(para) - minutos(de);
    if (m < 0) m += 24 * 60;
    return m;
  };
  // Viagem (pernoite): jornada = trecho do dia 1 (saida -> parada no hotel) +
  // trecho do dia 2 (saida do hotel -> chegada a fabrica). Ignora o pernoite.
  const trechos = isViagem
    ? [trecho(saida, paradaHotel), trecho(saidaHotel, retorno)]
    : [trecho(saida, retorno)];
  let totalMin = trechos.reduce((a, t) => a + t, 0);
  // Jornada do motorista: 12h de TRABALHO (8h normais + ate 4h extra) + 1h de
  // almoco, que nao conta (ex.: sai 05:15, limite 18:15). O intervalo so e
  // descontado em dia acima de 6h (quando ele e obrigatorio).
  const trabalhado = trechos.reduce((a, t) => a + (t > 360 ? t - 60 : t), 0);
  const minutosNormais = Math.min(trabalhado, 480);
  const minutosExtrasPermitidos = Math.min(Math.max(trabalhado - 480, 0), 240);
  const minutosExcedentes = Math.max(trabalhado - 720, 0);
  return {
    saida,
    retorno,
    isViagem,
    paradaHotel,
    saidaHotel,
    totalMin,
    horas: Math.floor(totalMin / 60),
    minutos: totalMin % 60,
    minutosNormais,
    minutosExtrasPermitidos,
    minutosExcedentes,
    valorExtraAprox: (minutosExtrasPermitidos / 60) * 15,
  };
}

function calcularRota() {
  if (!getVal("rotaSaida") || !getVal("rotaRetorno")) {
    alertar("Informe a saída e o retorno da rota.");
    return null;
  }
  // Mesma guarda que salvarRota já fazia: sem ela, "é viagem" com hotel vazio
  // manda trecho() calcular contra horário em branco, e o painel imprime um
  // total de dois dígitos de horas ("Tempo total: 34h") como se fosse real.
  if (
    $("rotaEhViagem")?.checked &&
    (!getVal("rotaParadaHotel") || !getVal("rotaSaidaHotel"))
  ) {
    alertar("Viagem: informe a parada no hotel e a saída do hotel.");
    return null;
  }
  const d = calcularDadosRota();
  const p = $("painelRota");
  if (p) p.style.display = "block";
  const set = (id, v) => {
    const el = $(id);
    if (el) el.textContent = v;
  };
  set("textoTempoRota", `Tempo total: ${d.horas}h ${d.minutos}min`);
  set(
    "textoHorasNormaisRota",
    `Horas normais: ${formatarTempo(d.minutosNormais)}`,
  );
  set(
    "textoHorasExtrasRota",
    `Horas extras permitidas: ${formatarTempo(d.minutosExtrasPermitidos)}`,
  );
  set(
    "textoExcedenteRota",
    d.minutosExcedentes > 0
      ? `⚠️ Excedente: ${formatarTempo(d.minutosExcedentes)}`
      : "✅ Sem excedente acima de 12h",
  );
  set(
    "textoValorExtraRota",
    `Valor extra aproximado: R$ ${d.valorExtraAprox.toFixed(2).replace(".", ",")}`,
  );
  set(
    "textoStatusRota",
    d.minutosExcedentes > 0
      ? "⚠️ Verificar jornada"
      : "✅ Jornada dentro do controle",
  );
  return d;
}

async function salvarRota() {
  if (
    !getVal("dataRota") ||
    !getVal("motoristaRota") ||
    !getVal("placaRota") ||
    !getVal("rotaSaida") ||
    !getVal("rotaRetorno")
  ) {
    alertar("Preencha data, motorista, placa, saída e retorno.");
    return;
  }
  if (
    $("rotaEhViagem")?.checked &&
    (!getVal("rotaParadaHotel") || !getVal("rotaSaidaHotel"))
  ) {
    alertar("Viagem: informe a parada no hotel e a saída do hotel.");
    return;
  }
  const d = calcularDadosRota();
  const reg = {
    id: gerarIdCompatBanco(), // nunca Date.now() cru — ver o helper no core
    data: getVal("dataRota"),
    motorista: getVal("motoristaRota"),
    placa: getVal("placaRota"),
    responsavelAnalise: getVal("responsavelAnaliseRota"),
    rotaFeita: getVal("rotaFeita"),
    obs: getVal("rotaObs"),
    ...d,
  };
  const lista = lerStorage(LS.rotas);
  lista.unshift(reg);
  if (!(await salvarStorage(LS.rotas, lista))) return;
  limparFormRota();
  fecharFormRota();
  renderizarListaRotas();
  if (typeof historicoRotasInit === "function") historicoRotasInit();
  alertar("✅ Tempo de rota salvo com sucesso.");
}

function excluirRota(id) {
  confirmarSimples("Deseja excluir esta rota?", async () => {
    if (
      !(await salvarStorage(
        LS.rotas,
        lerStorage(LS.rotas).filter((r) => String(r.id) !== String(id)),
      ))
    )
      return;
    renderizarListaRotas();
    if (typeof historicoRotasInit === "function") historicoRotasInit();
  });
}

// ================================================================
// 21. CONTROLE DE ALMOÇO
// ================================================================
function renderizarListaAlmocos() {
  const lista = ordenarCartoes("almoco", lerStorage(LS.almocos));
  const container = $("listaAlmocos");
  if (!container) return;
  container.innerHTML =
    lista.length === 0
      ? barraOrdenacaoCartoes("almoco") + `<p style="color:var(--text-muted);">Nenhum almoço registrado ainda.</p>`
      : barraOrdenacaoCartoes("almoco") +
        lista
          .map(
            (r, i) => `
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
        </div>`,
          )
          .join("");
}

function abrirFormAlmoco() {
  const f = $("formAlmoco");
  f?.classList.remove("hidden");
  if (!getVal("dataAlmoco")) setVal("dataAlmoco", hojeISO());
  setTimeout(
    () => f?.scrollIntoView({ behavior: "smooth", block: "start" }),
    50,
  );
}
function fecharFormAlmoco() {
  $("formAlmoco")?.classList.add("hidden");
}
function limparFormAlmoco() {
  [
    "dataAlmoco",
    "motoristaAlmoco",
    "almocoPrevInicio",
    "almocoPrevFim",
    "almocoRealInicio",
    "almocoRealFim",
    "almocoObs",
  ].forEach((id) => setVal(id, ""));
  const p = $("painelAlmoco");
  if (p) p.style.display = "none";
}

function calcularAlmoco() {
  const pI = minutos(getVal("almocoPrevInicio")),
    pF = minutos(getVal("almocoPrevFim"));
  const rI = minutos(getVal("almocoRealInicio")),
    rF = minutos(getVal("almocoRealFim"));
  if (!pI || !pF || !rI || !rF) {
    alertar("Preencha todos os horários para calcular.");
    return;
  }
  const tPrev = pF - pI,
    tReal = rF - rI,
    diff = tReal - tPrev;
  const p = $("painelAlmoco");
  if (p) p.style.display = "block";
  const tTempo = $("textoTempoAlmoco");
  if (tTempo)
    tTempo.innerHTML = `⏳ Previsto: <strong>${formatarTempo(tPrev)}</strong><br>🕐 Real: <strong>${formatarTempo(tReal)}</strong>`;
  const tStatus = $("textoStatusAlmoco");
  if (tStatus) {
    tStatus.style.color = diff <= 0 ? "var(--verde)" : "var(--vermelho)";
    tStatus.textContent =
      diff <= 0
        ? `✅ Dentro do prazo (${formatarTempo(Math.abs(diff))} antes do limite)`
        : `⚠️ Excedeu em ${formatarTempo(diff)}`;
  }
}

async function salvarAlmoco() {
  const data = getVal("dataAlmoco"),
    motorista = getVal("motoristaAlmoco");
  const pI = getVal("almocoPrevInicio"),
    pF = getVal("almocoPrevFim");
  const rI = getVal("almocoRealInicio"),
    rF = getVal("almocoRealFim");
  const obs = getVal("almocoObs");
  if (!data || !motorista || !pI || !pF || !rI || !rF) {
    alertar("Preencha todos os campos obrigatórios.");
    return;
  }
  const tPrev = minutos(pF) - minutos(pI),
    tReal = minutos(rF) - minutos(rI),
    diff = tReal - tPrev;
  const lista = lerStorage(LS.almocos);
  lista.unshift({
    id: gerarIdCompatBanco(), // nunca Date.now() cru — ver o helper no core
    data,
    motorista,
    prevInicio: pI,
    prevFim: pF,
    realInicio: rI,
    realFim: rF,
    obs,
    tempoPrev: tPrev,
    tempoReal: tReal,
    diferenca: diff,
    status: diff <= 0 ? "ok" : "excedido",
  });
  if (!(await salvarStorage(LS.almocos, lista))) return;
  limparFormAlmoco();
  fecharFormAlmoco();
  renderizarListaAlmocos();
}

// Pede confirmação como as outras três exclusões da aba (checklist, atraso,
// rota). Esta era a única que apagava em um clique — e o DELETE é físico, sem
// lixeira: clique errado aqui não tinha volta.
function excluirAlmoco(id) {
  confirmarSimples("Deseja excluir este registro de almoço?", async () => {
    const lista = lerStorage(LS.almocos);
    if (
      !(await salvarStorage(
        LS.almocos,
        lista.filter((r) => String(r.id) !== String(id)),
      ))
    )
      return;
    renderizarListaAlmocos();
  });
}

// ================================================================
// 22. INTEGRAÇÃO CHECKLIST x OCORRÊNCIA (status visual)
// ================================================================
function lerChecklistsSalvos() {
  return ["checklistDiario", "checklistsDiarios", "checklists"].flatMap((k) =>
    lerStorage(k),
  );
}

function encontrarChecklistDaEntrega(dataEntrega, placaEntrega) {
  const dataN = String(dataEntrega || "").split("T")[0];
  const placaN = String(placaEntrega || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!dataN || !placaN) return null;
  return (
    lerChecklistsSalvos().find((item) => {
      const dI = String(item.data || item.dataChecklist || "").split("T")[0];
      const pI = String(item.placa || "")
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
      return dI === dataN && pI === placaN;
    }) || null
  );
}

function atualizarBlocoStatusChecklist() {
  const campoData = $("dataOcorrencia"),
    campoPlaca = $("placa");
  const bloco = $("blocoStatusChecklist"),
    titulo = $("ckStatusTitulo"),
    detalhe = $("ckStatusDetalhe");
  const iconWrap = $("ckStatusIconWrap"),
    btnReg = $("ckStatusBtnRegistrar");
  const fezCk = $("fezChecklist");
  if (!campoData || !campoPlaca || !bloco || !titulo || !detalhe) return;
  const data = campoData.value,
    placa = campoPlaca.value;
  if (!data || !placa) {
    if (fezCk) fezCk.value = "nao";
    bloco.style.background = "rgba(255,255,255,0.02)";
    bloco.style.borderColor = "var(--border)";
    if (iconWrap) {
      iconWrap.innerHTML = "🔎";
      iconWrap.style.background = "rgba(255,255,255,0.06)";
    }
    titulo.textContent = "Check-list do Veículo";
    titulo.style.color = "var(--text-heading)";
    detalhe.textContent =
      "Selecione a data e a placa para verificar automaticamente.";
    if (btnReg) btnReg.classList.add("hidden");
    return;
  }
  const ck = encontrarChecklistDaEntrega(data, placa);
  if (ck) {
    if (fezCk) fezCk.value = "sim";
    bloco.style.background = "rgba(52,211,153,0.08)";
    bloco.style.borderColor = "rgba(52,211,153,0.35)";
    if (iconWrap) {
      iconWrap.innerHTML = "✅";
      iconWrap.style.background = "rgba(52,211,153,0.14)";
    }
    titulo.textContent = "Check-list realizado";
    titulo.style.color = "var(--verde)";
    detalhe.textContent = `A placa ${placa} possui check-list registrado em ${formatarDataBR(data)}.`;
    if (btnReg) btnReg.classList.add("hidden");
  } else {
    if (fezCk) fezCk.value = "nao";
    bloco.style.background = "rgba(248,113,113,0.08)";
    bloco.style.borderColor = "rgba(248,113,113,0.35)";
    if (iconWrap) {
      iconWrap.innerHTML = "❌";
      iconWrap.style.background = "rgba(248,113,113,0.14)";
    }
    titulo.textContent = "Check-list não realizado";
    titulo.style.color = "var(--vermelho)";
    detalhe.textContent = `A placa ${placa} ainda não possui check-list registrado em ${formatarDataBR(data)}.`;
    if (btnReg) btnReg.classList.remove("hidden");
  }
}

// ================================================================
// 23. HISTÓRICO — minimizar (desabilitado)
// ================================================================
function toggleHistorico() {
  /* histórico sempre visível */
}

function toggleTacDiarioSecao() {
  const corpo = document.getElementById("corpoTacDiario");
  const icone = document.getElementById("iconeTacDiarioToggle");
  const texto = document.getElementById("textoTacDiarioToggle");
  const btnRegistrar = document.getElementById("btnRegistrarTacDiario");
  const minimizado = corpo.style.display === "none";
  corpo.style.display = minimizado ? "" : "none";
  icone.style.transform = minimizado ? "" : "rotate(180deg)";
  texto.textContent = minimizado ? "Minimizar" : "Expandir";
  btnRegistrar.style.display = minimizado ? "" : "none";
}
