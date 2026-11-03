// ================================================================
// OCORRENCIAS DA ENTREGA - vinculadas a uma viagem TMS (nao a uma loja)
// Usa o mesmo endpoint /ocorrencias-avulsas com escopo='ENTREGA'.
// Alimenta os graficos do dashboard (tipos, ranking culpa, rota/dia).
// ================================================================

const OENT_API = typeof API_URL !== "undefined" ? API_URL : window.location.origin;

const OENT_SETORES = [
  "EXPEDICAO", "TRANSPORTE", "ESTOQUE", "4 ANDAR", "COMERCIAL",
  "CONTROLE DE ESTOQUE", "VM", "GRAFICA", "LOJA", "SUPERVISAO INTERNA",
  "ALMOXERIFADO", "EQUIPE DA ENTREGA", "SEGURANCA DO TRABALHO", "PLANEJAMENTO",
  "T.I", "MOTORISTA", "AJUDANTES",
];

// Valor do campo "culpa" que habilita a escolha do ajudante responsavel.
const OENT_CULPA_AJUDANTES = "AJUDANTES";
// Valor do campo "culpa" atribuido ao motorista da viagem (ponto negativo).
const OENT_CULPA_MOTORISTA = "MOTORISTA";

// Lista de ajudantes (reaproveita a do TMS; fallback caso tms.js nao tenha carregado).
const OENT_AJUDANTES = (typeof TMS_AJUDANTES !== "undefined" && Array.isArray(TMS_AJUDANTES))
  ? TMS_AJUDANTES
  : [];

const OENT_TIPOS = [
  "Atraso geral da viagem",
  "Quebra de veiculo",
  "Pneu furado",
  "Falta de combustivel",
  "Acidente",
  "Furto/Roubo na rota",
  "Avaria de carga",
  "Erro de carregamento",
  "Equipe incompleta",
  "Problema de comunicação",
  "Rota alterada",
  "Documentação pendente",
  "Outros",
];

const OENT_STATUS = ["Aberta", "Em análise", "Resolvida"];
const OENT_STATUS_CORES = {
  "Aberta": "#ef4444",
  "Em análise": "#f59e0b",
  "Resolvida": "#22c55e",
};

const OENT_MAX_FOTOS = 4;
const OENT_MAX_FOTO_MB = 2;

const oentState = { lista: [], listaRaw: [], viagens: [], editandoId: null, fotos: [] };

function oentStatusCanonico(status) {
  const normalizar = (v) => String(v || "").trim().normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const n = normalizar(status);
  return OENT_STATUS.find((s) => normalizar(s) === n) || "Aberta";
}

async function oentRequest(path, options = {}) {
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {}),
  };
  const r = await fetch(`${OENT_API}${path}`, { ...options, headers });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(dados.error || "Erro ao processar solicitacao.");
  return dados;
}

function oentOpt(value, label, selecionado = false) {
  return `<option value="${value}" ${selecionado ? "selected" : ""}>${escapar(label)}</option>`;
}

function oentFotosNormalizar(valor) {
  if (Array.isArray(valor)) return valor.filter((foto) => foto && foto.url);
  if (!valor) return [];
  try {
    const fotos = JSON.parse(valor);
    return Array.isArray(fotos) ? fotos.filter((foto) => foto && foto.url) : [];
  } catch (_) {
    return [];
  }
}

function oentRenderFotosPreview() {
  const el = document.getElementById("oentFotosPreview");
  if (!el) return;
  const fotos = oentState.fotos || [];
  if (!fotos.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = fotos.map((foto, index) => `
    <div style="width:92px;">
      <a href="${foto.url}" onclick="oentAbrirFotoLink(event, this)" title="${escapar(foto.nome || "Foto")}">
        <img src="${foto.url}" alt="${escapar(foto.nome || "Foto")}" style="width:92px;height:72px;object-fit:cover;border-radius:8px;border:1px solid var(--border);" />
      </a>
      <button type="button" class="btn-ghost btn-sm" onclick="oentRemoverFoto(${index})" style="width:100%;margin-top:4px;padding:3px 6px;font-size:10px;">Remover</button>
    </div>
  `).join("");
}

function oentRenderFotosLista(valor) {
  const fotos = oentFotosNormalizar(valor);
  if (!fotos.length) return "";
  return `<div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:9px;">
    ${fotos.map((foto) => `
      <a href="${foto.url}" onclick="oentAbrirFotoLink(event, this)" title="${escapar(foto.nome || "Foto")}">
        <img src="${foto.url}" alt="${escapar(foto.nome || "Foto")}" style="width:66px;height:52px;object-fit:cover;border-radius:7px;border:1px solid var(--border);" />
      </a>
    `).join("")}
  </div>`;
}

function oentAbrirFotoLink(event, link) {
  event.preventDefault();
  oentAbrirFoto(link.getAttribute("href"), link.getAttribute("title") || "Foto");
}

function oentAbrirFoto(url, titulo = "Foto") {
  let modal = document.getElementById("oentFotoModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "oentFotoModal";
    modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:3000;display:none;align-items:center;justify-content:center;padding:24px;";
    modal.innerHTML = `
      <div style="width:min(980px,96vw);max-height:92vh;display:flex;flex-direction:column;gap:10px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;color:#fff;">
          <strong id="oentFotoTitulo" style="font-size:14px;"></strong>
          <button type="button" class="btn-ghost btn-sm" onclick="oentFecharFoto()" style="background:rgba(255,255,255,.12);color:#fff;border-color:rgba(255,255,255,.25);">Fechar</button>
        </div>
        <img id="oentFotoImagem" alt="Foto da ocorrencia" style="max-width:100%;max-height:84vh;object-fit:contain;border-radius:10px;background:#111;border:1px solid rgba(255,255,255,.18);" />
      </div>`;
    modal.addEventListener("click", (e) => {
      if (e.target === modal) oentFecharFoto();
    });
    document.body.appendChild(modal);
  }
  document.getElementById("oentFotoTitulo").textContent = titulo;
  document.getElementById("oentFotoImagem").src = url;
  modal.style.display = "flex";
}

function oentFecharFoto() {
  const modal = document.getElementById("oentFotoModal");
  if (modal) modal.style.display = "none";
}

function oentArquivoParaDataUrl(arquivo) {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve({
      nome: arquivo.name,
      tipo: arquivo.type,
      tamanho: arquivo.size,
      url: leitor.result,
    });
    leitor.onerror = () => reject(new Error("Falha ao ler a foto."));
    leitor.readAsDataURL(arquivo);
  });
}

async function oentAtualizarFotos() {
  const input = document.getElementById("oentFotos");
  const arquivos = Array.from(input?.files || []);
  const imagens = arquivos.filter((arquivo) => arquivo.type.startsWith("image/")).slice(0, OENT_MAX_FOTOS);
  if (arquivos.length > OENT_MAX_FOTOS) alertar(`Limite de ${OENT_MAX_FOTOS} fotos por ocorrencia.`);
  const grande = imagens.find((arquivo) => arquivo.size > OENT_MAX_FOTO_MB * 1024 * 1024);
  if (grande) {
    alertar(`Cada foto deve ter no maximo ${OENT_MAX_FOTO_MB}MB.`);
    if (input) input.value = "";
    return;
  }
  oentState.fotos = await Promise.all(imagens.map(oentArquivoParaDataUrl));
  oentRenderFotosPreview();
}

function oentRemoverFoto(index) {
  oentState.fotos.splice(index, 1);
  const input = document.getElementById("oentFotos");
  if (input) input.value = "";
  oentRenderFotosPreview();
}

function oentFormatarViagem(v) {
  const partes = [
    v.codigo || `V-${v.id}`,
    String(v.data_viagem || "").slice(0, 10),
    v.rota_nome,
    v.motorista_nome,
    v.placa,
  ].filter(Boolean);
  return partes.join(" • ");
}

async function oentCarregarViagens() {
  try {
    const viagens = await oentRequest("/tms/viagens");
    oentState.viagens = Array.isArray(viagens) ? viagens : [];
  } catch (err) {
    oentState.viagens = [];
    console.warn("[oent] Falha ao carregar viagens TMS:", err.message);
  }
}

function oentPopularSelectViagem(selecionadoId = "") {
  const sel = document.getElementById("oentViagem");
  if (!sel) return;
  const opts = oentState.viagens
    .slice()
    .sort((a, b) => String(b.data_viagem || "").localeCompare(String(a.data_viagem || "")))
    .map((v) => oentOpt(v.id, oentFormatarViagem(v), Number(selecionadoId) === Number(v.id)))
    .join("");
  sel.innerHTML = `<option value="">Sem vínculo TMS</option>${opts}`;
}

function oentAtualizarPreviewViagem() {
  const sel = document.getElementById("oentViagem");
  const prev = document.getElementById("oentViagemPreview");
  if (!sel || !prev) return;
  const v = oentState.viagens.find((x) => Number(x.id) === Number(sel.value));
  // Atualiza as lojas disponiveis conforme a viagem, preservando a selecao atual.
  oentPopularSelectLoja(document.getElementById("oentLoja")?.value || "");
  if (!v) { prev.textContent = ""; return; }
  const data = String(v.data_viagem || "").slice(0, 10);
  const campoData = document.getElementById("oentData");
  if (campoData && data) campoData.value = data;
  const paradas = Array.isArray(v.paradas) ? v.paradas.length : 0;
  prev.innerHTML = `<strong>${escapar(data)}</strong> | Rota: <strong>${escapar(v.rota_nome || "-")}</strong> | Motorista: <strong>${escapar(v.motorista_nome || "-")}</strong> | Placa: <strong>${escapar(v.placa || "-")}</strong> | ${paradas} parada(s)`;
}

// Popula o select de loja com as paradas da viagem selecionada. Se a viagem
// nao tiver paradas (ou nenhuma viagem selecionada), cai para todas as lojas
// cadastradas em lojasRotas. Mantem a loja ja escolhida mesmo fora da lista.
function oentPopularSelectLoja(selecionada = "") {
  const sel = document.getElementById("oentLoja");
  if (!sel) return;
  const viagemId = document.getElementById("oentViagem")?.value;
  const v = oentState.viagens.find((x) => Number(x.id) === Number(viagemId));
  let lojas = [];
  if (v && Array.isArray(v.paradas)) {
    lojas = v.paradas.map((p) => p.loja_nome || p.loja).filter(Boolean);
  }
  if (!lojas.length && typeof lojasRotas === "object") {
    lojas = Object.keys(lojasRotas).map((k) => k.replace(/_/g, " "));
  }
  lojas = [...new Set(lojas)].sort();
  if (selecionada && !lojas.includes(selecionada)) lojas.unshift(selecionada);
  sel.innerHTML =
    `<option value="">Selecione a loja (opcional)</option>` +
    lojas.map((l) => oentOpt(l, l, l === selecionada)).join("");
}

function oentPopularSelects() {
  const fill = (id, placeholder, itens, atual) => {
    const el = document.getElementById(id);
    if (!el) return;
    const cur = atual !== undefined ? atual : el.value;
    el.innerHTML = `<option value="">${placeholder}</option>${itens.map((v) => oentOpt(v, v, v === cur)).join("")}`;
  };
  fill("oentTipoProblema", "Selecione o tipo", OENT_TIPOS);
  fill("oentCulpa", "Selecione o setor", OENT_SETORES);
  fill("oentAjudante", "Selecione o ajudante", OENT_AJUDANTES);
  const selStatus = document.getElementById("oentStatus");
  if (selStatus && !selStatus.options.length) {
    selStatus.innerHTML = OENT_STATUS.map((s) => oentOpt(s, s)).join("");
  }
  fill("oentFiltroTipo", "Todos os tipos", OENT_TIPOS);
  fill("oentFiltroCulpa", "Todos os setores", OENT_SETORES);
  fill("oentFiltroStatus", "Todos os status", OENT_STATUS);
}

// Mostra/esconde o campo "Ajudante responsavel" conforme a culpa selecionada.
function oentToggleAjudante() {
  const wrap = document.getElementById("oentAjudanteWrap");
  if (!wrap) return;
  const culpa = document.getElementById("oentCulpa")?.value || "";
  const mostrar = culpa === OENT_CULPA_AJUDANTES;
  wrap.classList.toggle("hidden", !mostrar);
  if (!mostrar) {
    const sel = document.getElementById("oentAjudante");
    if (sel) sel.value = "";
  }
}

async function oentAbrirForm() {
  const form = document.getElementById("oentForm");
  if (!form) return;
  oentState.editandoId = null;
  form.classList.remove("hidden");
  document.getElementById("oentFormTitulo").textContent = "Nova ocorrência da entrega";
  document.getElementById("oentSalvarBtn").textContent = "Salvar ocorrência";
  await oentCarregarViagens();
  oentPopularSelectViagem();
  oentPopularSelects();
  oentPopularSelectLoja();
  document.getElementById("oentHora").value = "";
  document.getElementById("oentData").value = new Date().toISOString().slice(0, 10);
  document.getElementById("oentTipoProblema").value = "";
  document.getElementById("oentCulpa").value = "";
  const selAjud = document.getElementById("oentAjudante");
  if (selAjud) selAjud.value = "";
  oentToggleAjudante();
  document.getElementById("oentStatus").value = "Aberta";
  document.getElementById("oentDescricao").value = "";
  document.getElementById("oentObservacao").value = "";
  document.getElementById("oentViagemPreview").textContent = "";
  oentState.fotos = [];
  const fotosInput = document.getElementById("oentFotos");
  if (fotosInput) fotosInput.value = "";
  oentRenderFotosPreview();
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function oentFecharForm() {
  oentState.editandoId = null;
  document.getElementById("oentForm")?.classList.add("hidden");
}

async function oentSalvar(event) {
  event.preventDefault();
  const viagemId = Number(document.getElementById("oentViagem").value) || null;
  const data = document.getElementById("oentData").value;
  if (!data) { alertar("Informe a data da ocorrencia."); return; }
  const tipo = document.getElementById("oentTipoProblema").value;
  const culpa = document.getElementById("oentCulpa").value;
  if (!tipo && !culpa) { alertar("Informe pelo menos o tipo de problema ou o setor culpado."); return; }
  const ajudante = culpa === OENT_CULPA_AJUDANTES
    ? (document.getElementById("oentAjudante")?.value || "")
    : "";
  if (culpa === OENT_CULPA_AJUDANTES && !ajudante) {
    alertar("Selecione qual ajudante foi o responsavel.");
    return;
  }
  if (culpa === OENT_CULPA_MOTORISTA && !viagemId) {
    alertar("Selecione a viagem para identificar o motorista responsavel.");
    return;
  }
  const body = {
    escopo: "ENTREGA",
    viagem_id: viagemId,
    data_ocorrencia: data,
    tipo_problema: tipo || null,
    culpa: culpa || null,
    ajudante_culpado: ajudante || null,
    status: document.getElementById("oentStatus").value,
    hora_ocorrencia: document.getElementById("oentHora").value || null,
    descricao: document.getElementById("oentDescricao").value.trim() || null,
    observacao: document.getElementById("oentObservacao").value.trim() || null,
    titulo: tipo || null,
    loja: document.getElementById("oentLoja").value || null,
    fotos: oentState.fotos,
  };
  try {
    const editando = oentState.editandoId;
    const path = editando ? `/ocorrencias-avulsas/${editando}` : "/ocorrencias-avulsas";
    await oentRequest(path, { method: editando ? "PUT" : "POST", body: JSON.stringify(body) });
    oentFecharForm();
    await oentCarregar();
    // Reflete nos graficos do dashboard imediatamente.
    if (typeof window.atualizarTodasAsViews === "function") window.atualizarTodasAsViews();
    alertar(editando ? "Ocorrência atualizada." : "Ocorrência registrada.");
  } catch (err) {
    alertar(`Nao foi possivel salvar: ${err.message}`);
  }
}

async function oentEditar(id) {
  const oco = oentState.listaRaw.find((x) => x.id === id);
  if (!oco) return;
  oentState.editandoId = id;
  const form = document.getElementById("oentForm");
  if (!form) return;
  form.classList.remove("hidden");
  await oentCarregarViagens();
  oentPopularSelectViagem(oco.viagem_id);
  oentPopularSelects();
  oentPopularSelectLoja(oco.loja || "");
  document.getElementById("oentFormTitulo").textContent = `Editar ocorrência #${id}`;
  document.getElementById("oentSalvarBtn").textContent = "Atualizar ocorrência";
  document.getElementById("oentTipoProblema").value = oco.tipo_problema || "";
  document.getElementById("oentCulpa").value = oco.culpa || "";
  const selAjudEdit = document.getElementById("oentAjudante");
  if (selAjudEdit) selAjudEdit.value = oco.ajudante_culpado || "";
  oentToggleAjudante();
  document.getElementById("oentStatus").value = oco.status || "Aberta";
  document.getElementById("oentHora").value = String(oco.hora_ocorrencia || "").slice(0, 5);
  document.getElementById("oentData").value = String(oco.data_ocorrencia || "").slice(0, 10);
  document.getElementById("oentDescricao").value = oco.descricao || "";
  document.getElementById("oentObservacao").value = oco.observacao || "";
  oentState.fotos = oentFotosNormalizar(oco.fotos);
  const fotosInput = document.getElementById("oentFotos");
  if (fotosInput) fotosInput.value = "";
  oentRenderFotosPreview();
  oentAtualizarPreviewViagem();
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function oentExcluir(id) {
  confirmarSimples(`Deseja excluir a ocorrência #${id}?`, async () => {
    try {
      await oentRequest(`/ocorrencias-avulsas/${id}`, { method: "DELETE" });
      await oentCarregar();
      if (typeof window.atualizarTodasAsViews === "function") window.atualizarTodasAsViews();
      alertar("Ocorrência excluida.");
    } catch (err) {
      alertar(`Nao foi possivel excluir: ${err.message}`);
    }
  });
}

async function oentAlterarStatus(id, status) {
  try {
    await oentRequest(`/ocorrencias-avulsas/${id}/status`, { method: "PUT", body: JSON.stringify({ status }) });
    await oentCarregar();
    if (typeof window.atualizarTodasAsViews === "function") window.atualizarTodasAsViews();
  } catch (err) {
    alertar(err.message);
  }
}

async function oentCarregar() {
  const inicio = document.getElementById("oentFiltroInicio")?.value || "";
  const fim = document.getElementById("oentFiltroFim")?.value || "";
  const params = ["escopo=ENTREGA"];
  if (inicio) params.push(`inicio=${encodeURIComponent(inicio)}`);
  if (fim) params.push(`fim=${encodeURIComponent(fim)}`);
  try {
    const lista = await oentRequest(`/ocorrencias-avulsas?${params.join("&")}`);
    oentState.listaRaw = lista.map((item) => ({ ...item, status: oentStatusCanonico(item.status) }));
    oentPopularSelects();
    oentAplicarFiltros();
  } catch (err) {
    alertar(`Nao foi possivel carregar: ${err.message}`);
  }
}

function oentAplicarFiltros() {
  const tipo = document.getElementById("oentFiltroTipo")?.value || "";
  const culpa = document.getElementById("oentFiltroCulpa")?.value || "";
  const status = document.getElementById("oentFiltroStatus")?.value || "";
  oentState.lista = (oentState.listaRaw || []).filter((o) => {
    if (tipo && o.tipo_problema !== tipo) return false;
    if (culpa && o.culpa !== culpa) return false;
    if (status && o.status !== status) return false;
    return true;
  });
  oentRender();
}

function oentLimparFiltro() {
  ["oentFiltroInicio", "oentFiltroFim", "oentFiltroTipo", "oentFiltroCulpa", "oentFiltroStatus"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  oentCarregar();
}

function oentRender() {
  oentRenderKpis();
  oentRenderRanking();
  oentRenderRankingMotorista();
  oentRenderRankingAjudantes();
  oentRenderLista();
}

function oentRenderKpis() {
  const el = document.getElementById("oentKpis");
  if (!el) return;
  const lista = oentState.lista;
  const abertas = lista.filter((o) => o.status === "Aberta").length;
  const emAnalise = lista.filter((o) => o.status === "Em análise").length;
  const resolvidas = lista.filter((o) => o.status === "Resolvida").length;
  const contagem = {};
  lista.forEach((o) => { if (o.culpa) contagem[o.culpa] = (contagem[o.culpa] || 0) + 1; });
  const top = Object.entries(contagem).sort((a, b) => b[1] - a[1])[0];
  const cards = [
    ["Total", lista.length, "#6366f1"],
    ["Abertas", abertas, "#ef4444"],
    ["Em análise", emAnalise, "#f59e0b"],
    ["Resolvidas", resolvidas, "#22c55e"],
    ["Setor + culpado", top ? top[0] : "-", "#a78bfa", top ? `${top[1]} ocorrência(s)` : ""],
  ];
  el.innerHTML = cards.map(([label, valor, cor, sub]) =>
    `<div class="tms-kpi" style="border-left:3px solid ${cor};">
       <strong style="color:${cor};font-size:${typeof valor === "string" && valor.length > 6 ? "16px" : "25px"};">${escapar(String(valor))}</strong>
       <span>${label}</span>
       ${sub ? `<small class="tms-kpi-sub">${sub}</small>` : ""}
     </div>`).join("");
}

function oentRenderRanking() {
  const el = document.getElementById("oentRanking");
  if (!el) return;
  const lista = oentState.lista;
  const contagem = {};
  lista.forEach((o) => { if (o.culpa) contagem[o.culpa] = (contagem[o.culpa] || 0) + 1; });
  const ranking = Object.entries(contagem).sort((a, b) => b[1] - a[1]);
  if (!ranking.length) {
    el.innerHTML = `<p style="color:var(--text-muted);padding:14px 0;">Nenhuma ocorrência com setor responsavel no filtro.</p>`;
    return;
  }
  const maximo = ranking[0][1];
  const medalha = (i) => (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}º`);
  el.innerHTML = ranking.map(([setor, qtd], i) => {
    const pct = maximo > 0 ? Math.round((qtd / maximo) * 100) : 0;
    const cor = i === 0 ? "#ef4444" : i === 1 ? "#f97316" : i === 2 ? "#f59e0b" : "#94a3b8";
    return `<div style="display:flex;align-items:center;gap:12px;padding:9px 0;border-top:${i === 0 ? "0" : "1px solid var(--border)"};">
        <span style="width:34px;flex-shrink:0;font-weight:800;color:${cor};">${medalha(i)}</span>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:700;color:var(--text-heading);margin-bottom:4px;">
            <span>${escapar(setor)}</span><span>${qtd}</span>
          </div>
          <div style="height:7px;border-radius:6px;background:rgba(148,163,184,0.15);overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:${cor};border-radius:6px;"></div>
          </div>
        </div>
      </div>`;
  }).join("");
}

// Ranking dos motoristas apontados como culpados (culpa = MOTORISTA).
// Mostra o nome do motorista + a(s) rota(s) e conta como ponto(s) negativo(s).
function oentRenderRankingMotorista() {
  const el = document.getElementById("oentRankingMotorista");
  if (!el) return;
  const lista = oentState.lista;
  const dados = {}; // nome -> { qtd, rotas:Set }
  lista.forEach((o) => {
    if (o.culpa !== OENT_CULPA_MOTORISTA) return;
    const nome = String(o.motorista_nome || "").trim() || "Motorista não informado";
    if (!dados[nome]) dados[nome] = { qtd: 0, rotas: new Set() };
    dados[nome].qtd++;
    if (o.rota_nome) dados[nome].rotas.add(o.rota_nome);
  });
  const ranking = Object.entries(dados).sort((a, b) => b[1].qtd - a[1].qtd);
  if (!ranking.length) {
    el.innerHTML = `<p style="color:var(--text-muted);padding:14px 0;">Nenhuma ocorrência com culpa do motorista no filtro.</p>`;
    return;
  }
  const maximo = ranking[0][1].qtd;
  const medalha = (i) => (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}º`);
  const cor = "#ef4444"; // sempre vermelho: e ponto negativo
  el.innerHTML = ranking.map(([nome, info], i) => {
    const pct = maximo > 0 ? Math.round((info.qtd / maximo) * 100) : 0;
    const rotas = [...info.rotas].join(", ");
    return `<div style="display:flex;align-items:center;gap:12px;padding:9px 0;border-top:${i === 0 ? "0" : "1px solid var(--border)"};">
        <span style="width:34px;flex-shrink:0;font-weight:800;color:${cor};">${medalha(i)}</span>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:700;color:var(--text-heading);margin-bottom:2px;">
            <span>${escapar(nome)}</span><span style="color:${cor};">-${info.qtd} ${info.qtd === 1 ? "ponto" : "pontos"}</span>
          </div>
          ${rotas ? `<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">Rota: ${escapar(rotas)}</div>` : ""}
          <div style="height:7px;border-radius:6px;background:rgba(148,163,184,0.15);overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:${cor};border-radius:6px;"></div>
          </div>
        </div>
      </div>`;
  }).join("");
}

// Ranking dos ajudantes apontados como responsaveis (culpa = AJUDANTES).
function oentRenderRankingAjudantes() {
  const el = document.getElementById("oentRankingAjudantes");
  if (!el) return;
  const lista = oentState.lista;
  const contagem = {};
  lista.forEach((o) => {
    if (o.culpa === OENT_CULPA_AJUDANTES && o.ajudante_culpado) {
      contagem[o.ajudante_culpado] = (contagem[o.ajudante_culpado] || 0) + 1;
    }
  });
  const ranking = Object.entries(contagem).sort((a, b) => b[1] - a[1]);
  if (!ranking.length) {
    el.innerHTML = `<p style="color:var(--text-muted);padding:14px 0;">Nenhuma ocorrência atribuída a um ajudante no filtro.</p>`;
    return;
  }
  const maximo = ranking[0][1];
  const medalha = (i) => (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}º`);
  el.innerHTML = ranking.map(([ajudante, qtd], i) => {
    const pct = maximo > 0 ? Math.round((qtd / maximo) * 100) : 0;
    const cor = i === 0 ? "#ef4444" : i === 1 ? "#f97316" : i === 2 ? "#f59e0b" : "#94a3b8";
    return `<div style="display:flex;align-items:center;gap:12px;padding:9px 0;border-top:${i === 0 ? "0" : "1px solid var(--border)"};">
        <span style="width:34px;flex-shrink:0;font-weight:800;color:${cor};">${medalha(i)}</span>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:700;color:var(--text-heading);margin-bottom:4px;">
            <span>${escapar(ajudante)}</span><span>${qtd}</span>
          </div>
          <div style="height:7px;border-radius:6px;background:rgba(148,163,184,0.15);overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:${cor};border-radius:6px;"></div>
          </div>
        </div>
      </div>`;
  }).join("");
}

function oentRenderLista() {
  const container = document.getElementById("oentLista");
  if (!container) return;
  const lista = oentState.lista;
  if (!lista.length) {
    container.innerHTML = '<p style="color:var(--text-muted);padding:18px 0;">Nenhuma ocorrência cadastrada para o filtro.</p>';
    return;
  }
  container.innerHTML = lista.map((o) => {
    const cor = OENT_STATUS_CORES[o.status] || "#94a3b8";
    const viagem = o.viagem_codigo ? `Viagem <strong style="color:var(--text-heading);">${escapar(o.viagem_codigo)}</strong>` : "Viagem desconhecida";
    const rota = o.rota_nome ? ` | Rota: <strong>${escapar(o.rota_nome)}</strong>` : "";
    const motorista = o.motorista_nome ? ` | Motorista: <strong>${escapar(o.motorista_nome)}</strong>` : "";
    const loja = o.loja ? ` | Loja: <strong style="color:var(--text-heading);">${escapar(o.loja)}</strong>` : "";
    return `<article class="tms-viagem">
        <div class="tms-viagem-head">
          <div style="flex:1;min-width:0;">
            <div class="tms-viagem-title">#${o.id}${o.tipo_problema ? ` · ${escapar(o.tipo_problema)}` : ""}</div>
            <div class="tms-meta">${formatarDataBR(o.data_ocorrencia)}${o.hora_ocorrencia ? ` às ${escapar(String(o.hora_ocorrencia).slice(0, 5))}` : ""} | ${viagem}${rota}${motorista}${loja}${o.culpa ? ` | Culpa: <strong style="color:var(--text-heading);">${escapar(o.culpa)}</strong>` : ""}</div>
            ${o.descricao ? `<div style="margin-top:8px;white-space:pre-wrap;color:var(--text-primary);font-size:13px;">${escapar(o.descricao)}</div>` : ""}
            ${oentRenderFotosLista(o.fotos)}
          </div>
          <div class="tms-viagem-acoes">
            <span style="font-size:11px;font-weight:800;color:${cor};background:${cor}22;border:1px solid ${cor}55;border-radius:7px;padding:3px 9px;white-space:nowrap;">${escapar(o.status)}</span>
            <select class="tms-status" onchange="oentAlterarStatus(${o.id}, this.value)">
              ${OENT_STATUS.map((s) => oentOpt(s, s, s === o.status)).join("")}
            </select>
            <button type="button" class="btn-blue btn-sm" onclick="oentEditar(${o.id})">Editar</button>
            <button type="button" class="btn-red btn-sm admin-only-action" onclick="oentExcluir(${o.id})">Excluir</button>
          </div>
        </div>
      </article>`;
  }).join("");
}

async function oentInit() {
  oentPopularSelects();
  await oentCarregar();
}

window.oentAbrirForm = oentAbrirForm;
window.oentFecharForm = oentFecharForm;
window.oentSalvar = oentSalvar;
window.oentEditar = oentEditar;
window.oentExcluir = oentExcluir;
window.oentAlterarStatus = oentAlterarStatus;
window.oentAtualizarFotos = oentAtualizarFotos;
window.oentRemoverFoto = oentRemoverFoto;
window.oentAbrirFotoLink = oentAbrirFotoLink;
window.oentFecharFoto = oentFecharFoto;
window.oentCarregar = oentCarregar;
window.oentAplicarFiltros = oentAplicarFiltros;
window.oentLimparFiltro = oentLimparFiltro;
window.oentAtualizarPreviewViagem = oentAtualizarPreviewViagem;
window.oentToggleAjudante = oentToggleAjudante;
window.oentInit = oentInit;
