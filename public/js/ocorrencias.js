// ================================================================
// OCORRENCIAS AVULSAS - ocorrencias internas nao ligadas a entrega
// Texto livre + setor culpado, com ranking proprio de culpa.
// Namespace "oavul" para nao colidir com window.ocorrencias (entregas).
// ================================================================

const OAVUL_API = typeof API_URL !== "undefined" ? API_URL : window.location.origin;

// Mesma lista de setores usada nas ocorrencias de entrega (campo "culpa").
const OAVUL_SETORES = [
  "EXPEDICAO", "TRANSPORTE", "ESTOQUE", "4 ANDAR", "COMERCIAL",
  "CONTROLE DE ESTOQUE", "VM", "GRAFICA", "LOJA", "SUPERVISAO INTERNA",
  "ALMOXERIFADO", "EQUIPE DA ENTREGA", "SEGURANCA DO TRABALHO", "PLANEJAMENTO",
  "T.I",
];

const OAVUL_STATUS = ["Aberta", "Em análise", "Resolvida"];
const OAVUL_STATUS_CORES = {
  "Aberta": "#ef4444",
  "Em análise": "#f59e0b",
  "Resolvida": "#22c55e",
};

const OAVUL_MAX_FOTOS = 4;
const OAVUL_MAX_FOTO_MB = 2;

const oavulState = { lista: [], listaRaw: [], editandoId: null, _chart: null, fotos: [] };

function oavulStatusCanonico(status) {
  const normalizar = (valor) =>
    String(valor || "")
      .trim()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  const normalizado = normalizar(status);
  return OAVUL_STATUS.find((item) => normalizar(item) === normalizado) || "Aberta";
}

async function oavulRequest(path, options = {}) {
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {}),
  };
  const resposta = await fetch(`${OAVUL_API}${path}`, { ...options, headers });
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw new Error(dados.error || "Erro ao processar solicitacao.");
  return dados;
}

function oavulOption(value, label, selecionado = false) {
  return `<option value="${value}" ${selecionado ? "selected" : ""}>${escapar(label)}</option>`;
}

function oavulFotosNormalizar(valor) {
  if (Array.isArray(valor)) return valor.filter((foto) => foto && foto.url);
  if (!valor) return [];
  try {
    const fotos = JSON.parse(valor);
    return Array.isArray(fotos) ? fotos.filter((foto) => foto && foto.url) : [];
  } catch (_) {
    return [];
  }
}

function oavulRenderFotosPreview() {
  const el = document.getElementById("oavulFotosPreview");
  if (!el) return;
  const fotos = oavulState.fotos || [];
  if (!fotos.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = fotos.map((foto, index) => `
    <div style="width:92px;">
      <a href="${foto.url}" onclick="oavulAbrirFotoLink(event, this)" title="${escapar(foto.nome || "Foto")}">
        <img src="${foto.url}" alt="${escapar(foto.nome || "Foto")}" style="width:92px;height:72px;object-fit:cover;border-radius:8px;border:1px solid var(--border);" />
      </a>
      <button type="button" class="btn-ghost btn-sm" onclick="oavulRemoverFoto(${index})" style="width:100%;margin-top:4px;padding:3px 6px;font-size:10px;">Remover</button>
    </div>
  `).join("");
}

function oavulRenderFotosLista(valor) {
  const fotos = oavulFotosNormalizar(valor);
  if (!fotos.length) return "";
  return `<div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:9px;">
    ${fotos.map((foto) => `
      <a href="${foto.url}" onclick="oavulAbrirFotoLink(event, this)" title="${escapar(foto.nome || "Foto")}">
        <img src="${foto.url}" alt="${escapar(foto.nome || "Foto")}" style="width:66px;height:52px;object-fit:cover;border-radius:7px;border:1px solid var(--border);" />
      </a>
    `).join("")}
  </div>`;
}

function oavulAbrirFotoLink(event, link) {
  event.preventDefault();
  oavulAbrirFoto(link.getAttribute("href"), link.getAttribute("title") || "Foto");
}

function oavulAbrirFoto(url, titulo = "Foto") {
  let modal = document.getElementById("oavulFotoModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "oavulFotoModal";
    modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:3000;display:none;align-items:center;justify-content:center;padding:24px;";
    modal.innerHTML = `
      <div style="width:min(980px,96vw);max-height:92vh;display:flex;flex-direction:column;gap:10px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;color:#fff;">
          <strong id="oavulFotoTitulo" style="font-size:14px;"></strong>
          <button type="button" class="btn-ghost btn-sm" onclick="oavulFecharFoto()" style="background:rgba(255,255,255,.12);color:#fff;border-color:rgba(255,255,255,.25);">Fechar</button>
        </div>
        <img id="oavulFotoImagem" alt="Foto da ocorrencia" style="max-width:100%;max-height:84vh;object-fit:contain;border-radius:10px;background:#111;border:1px solid rgba(255,255,255,.18);" />
      </div>`;
    modal.addEventListener("click", (e) => {
      if (e.target === modal) oavulFecharFoto();
    });
    document.body.appendChild(modal);
  }
  document.getElementById("oavulFotoTitulo").textContent = titulo;
  document.getElementById("oavulFotoImagem").src = url;
  modal.style.display = "flex";
}

function oavulFecharFoto() {
  const modal = document.getElementById("oavulFotoModal");
  if (modal) modal.style.display = "none";
}

function oavulArquivoParaDataUrl(arquivo) {
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

async function oavulAtualizarFotos() {
  const input = document.getElementById("oavulFotos");
  const arquivos = Array.from(input?.files || []);
  const imagens = arquivos.filter((arquivo) => arquivo.type.startsWith("image/")).slice(0, OAVUL_MAX_FOTOS);
  if (arquivos.length > OAVUL_MAX_FOTOS) alertar(`Limite de ${OAVUL_MAX_FOTOS} fotos por ocorrencia.`);
  const grande = imagens.find((arquivo) => arquivo.size > OAVUL_MAX_FOTO_MB * 1024 * 1024);
  if (grande) {
    alertar(`Cada foto deve ter no maximo ${OAVUL_MAX_FOTO_MB}MB.`);
    if (input) input.value = "";
    return;
  }
  oavulState.fotos = await Promise.all(imagens.map(oavulArquivoParaDataUrl));
  oavulRenderFotosPreview();
}

function oavulRemoverFoto(index) {
  oavulState.fotos.splice(index, 1);
  const input = document.getElementById("oavulFotos");
  if (input) input.value = "";
  oavulRenderFotosPreview();
}

// Popula os selects de formulario e de filtro (preservando selecao atual).
function oavulPopularSelects() {
  const selCulpa = document.getElementById("oavulCulpa");
  if (selCulpa) {
    const atual = selCulpa.value;
    selCulpa.innerHTML = `<option value="">Selecione o setor</option>${OAVUL_SETORES.map((s) => oavulOption(s, s, s === atual)).join("")}`;
  }
  const selStatus = document.getElementById("oavulStatus");
  if (selStatus && !selStatus.options.length) {
    selStatus.innerHTML = OAVUL_STATUS.map((s) => oavulOption(s, s)).join("");
  }
  const fill = (id, rotulo, itens) => {
    const el = document.getElementById(id);
    if (!el) return;
    const atual = el.value;
    el.innerHTML = `<option value="">${rotulo}</option>${itens.map((s) => oavulOption(s, s, s === atual)).join("")}`;
  };
  fill("oavulFiltroCulpa", "Todos os setores", OAVUL_SETORES);
  fill("oavulFiltroStatus", "Todos os status", OAVUL_STATUS);
}

function oavulAbrirForm() {
  const form = document.getElementById("oavulForm");
  if (!form) return;
  oavulState.editandoId = null;
  form.classList.remove("hidden");
  document.getElementById("oavulFormTitulo").textContent = "Nova ocorrência";
  document.getElementById("oavulSalvarBtn").textContent = "Salvar ocorrência";
  oavulPopularSelects();
  document.getElementById("oavulData").value = hojeISO();
  document.getElementById("oavulHora").value = "";
  document.getElementById("oavulTitulo").value = "";
  document.getElementById("oavulDescricao").value = "";
  document.getElementById("oavulCulpa").value = "";
  document.getElementById("oavulStatus").value = "Aberta";
  oavulState.fotos = [];
  const fotosInput = document.getElementById("oavulFotos");
  if (fotosInput) fotosInput.value = "";
  oavulRenderFotosPreview();
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function oavulFecharForm() {
  oavulState.editandoId = null;
  document.getElementById("oavulForm")?.classList.add("hidden");
}

async function oavulSalvar(event) {
  event.preventDefault();
  const body = {
    data_ocorrencia: document.getElementById("oavulData").value,
    hora_ocorrencia: document.getElementById("oavulHora").value || null,
    titulo: document.getElementById("oavulTitulo").value.trim(),
    descricao: document.getElementById("oavulDescricao").value.trim(),
    culpa: document.getElementById("oavulCulpa").value,
    status: document.getElementById("oavulStatus").value,
    fotos: oavulState.fotos,
  };
  if (!body.data_ocorrencia || !body.descricao) {
    alertar("Informe a data e a descricao da ocorrencia.");
    return;
  }
  try {
    const editando = oavulState.editandoId;
    const path = editando ? `/ocorrencias-avulsas/${editando}` : "/ocorrencias-avulsas";
    await oavulRequest(path, { method: editando ? "PUT" : "POST", body: JSON.stringify(body) });
    oavulFecharForm();
    await oavulCarregar();
    if (typeof window.dispararMudou === "function") window.dispararMudou("avulsa");
    alertar(editando ? "Ocorrência atualizada com sucesso." : "Ocorrência registrada com sucesso.");
  } catch (err) {
    alertar(`Nao foi possivel salvar a ocorrência: ${err.message}`);
  }
}

function oavulEditar(id) {
  const oco = oavulState.listaRaw.find((item) => item.id === id);
  const form = document.getElementById("oavulForm");
  if (!oco || !form) return;
  oavulState.editandoId = id;
  form.classList.remove("hidden");
  oavulPopularSelects();
  document.getElementById("oavulFormTitulo").textContent = `Editar ocorrência #${id}`;
  document.getElementById("oavulSalvarBtn").textContent = "Atualizar ocorrência";
  document.getElementById("oavulData").value = String(oco.data_ocorrencia || "").split("T")[0];
  document.getElementById("oavulHora").value = String(oco.hora_ocorrencia || "").slice(0, 5);
  document.getElementById("oavulTitulo").value = oco.titulo || "";
  document.getElementById("oavulDescricao").value = oco.descricao || "";
  document.getElementById("oavulCulpa").value = oco.culpa || "";
  document.getElementById("oavulStatus").value = oco.status || "Aberta";
  oavulState.fotos = oavulFotosNormalizar(oco.fotos);
  const fotosInput = document.getElementById("oavulFotos");
  if (fotosInput) fotosInput.value = "";
  oavulRenderFotosPreview();
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function oavulExcluir(id) {
  confirmarSimples(`Deseja excluir a ocorrência #${id}?`, async () => {
    try {
      await oavulRequest(`/ocorrencias-avulsas/${id}`, { method: "DELETE" });
      await oavulCarregar();
      if (typeof window.dispararMudou === "function") window.dispararMudou("avulsa");
      alertar("Ocorrência excluida com sucesso.");
    } catch (err) {
      alertar(`Nao foi possivel excluir: ${err.message}`);
    }
  });
}

async function oavulAlterarStatus(id, status) {
  try {
    await oavulRequest(`/ocorrencias-avulsas/${id}/status`, { method: "PUT", body: JSON.stringify({ status }) });
    await oavulCarregar();
    if (typeof window.dispararMudou === "function") window.dispararMudou("avulsa");
  } catch (err) {
    alertar(err.message);
  }
}

async function oavulCarregar() {
  const inicio = document.getElementById("oavulFiltroInicio")?.value || "";
  const fim = document.getElementById("oavulFiltroFim")?.value || "";
  const params = [];
  if (inicio) params.push(`inicio=${encodeURIComponent(inicio)}`);
  if (fim) params.push(`fim=${encodeURIComponent(fim)}`);
  try {
    const lista = await oavulRequest(`/ocorrencias-avulsas${params.length ? `?${params.join("&")}` : ""}`);
    oavulState.listaRaw = lista.map((item) => ({ ...item, status: oavulStatusCanonico(item.status) }));
    oavulPopularSelects();
    oavulAplicarFiltros();
  } catch (err) {
    alertar(`Nao foi possivel carregar ocorrências: ${err.message}`);
  }
}

// Aplica os filtros do cliente (setor/status/busca) sobre o conjunto carregado.
function oavulAplicarFiltros() {
  const culpa = document.getElementById("oavulFiltroCulpa")?.value || "";
  const status = document.getElementById("oavulFiltroStatus")?.value || "";
  const busca = (document.getElementById("oavulFiltroBusca")?.value || "").trim().toLowerCase();

  oavulState.lista = (oavulState.listaRaw || []).filter((o) => {
    if (culpa && o.culpa !== culpa) return false;
    if (status && o.status !== status) return false;
    if (busca) {
      const alvo = [o.titulo, o.descricao, o.culpa].filter(Boolean).join(" ").toLowerCase();
      if (!alvo.includes(busca)) return false;
    }
    return true;
  });
  oavulRender();
}

function oavulLimparFiltro() {
  ["oavulFiltroInicio", "oavulFiltroFim", "oavulFiltroCulpa", "oavulFiltroStatus", "oavulFiltroBusca"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  oavulCarregar();
}

function oavulRender() {
  oavulRenderKpis();
  oavulRenderRanking();
  oavulRenderLista();
}

function oavulRenderKpis() {
  const el = document.getElementById("oavulKpis");
  if (!el) return;
  const lista = oavulState.lista;
  const abertas = lista.filter((o) => o.status === "Aberta").length;
  const emAnalise = lista.filter((o) => o.status === "Em análise").length;
  const resolvidas = lista.filter((o) => o.status === "Resolvida").length;
  // Setor que mais aparece como culpado.
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
  el.innerHTML = cards
    .map(
      ([label, valor, cor, sub]) =>
        `<div class="tms-kpi" style="border-left:3px solid ${cor};">
          <strong style="color:${cor};font-size:${typeof valor === "string" && valor.length > 6 ? "16px" : "25px"};">${escapar(String(valor))}</strong>
          <span>${label}</span>
          ${sub ? `<small class="tms-kpi-sub">${sub}</small>` : ""}
        </div>`
    )
    .join("");
}

function oavulRenderRanking() {
  const el = document.getElementById("oavulRanking");
  if (!el) return;
  const lista = oavulState.lista;
  const contagem = {};
  lista.forEach((o) => { if (o.culpa) contagem[o.culpa] = (contagem[o.culpa] || 0) + 1; });
  const ranking = Object.entries(contagem).sort((a, b) => b[1] - a[1]);
  const semCulpa = lista.filter((o) => !o.culpa).length;

  if (!ranking.length) {
    el.innerHTML = `<p style="color:var(--text-muted);padding:14px 0;">Nenhuma ocorrência com setor responsável no filtro${semCulpa ? ` (${semCulpa} sem setor)` : ""}.</p>`;
    return;
  }

  const maximo = ranking[0][1];
  const medalha = (i) => (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}º`);

  el.innerHTML = ranking
    .map(([setor, qtd], i) => {
      const pct = maximo > 0 ? Math.round((qtd / maximo) * 100) : 0;
      const cor = i === 0 ? "#ef4444" : i === 1 ? "#f97316" : i === 2 ? "#f59e0b" : "#94a3b8";
      return `
      <div style="display:flex;align-items:center;gap:12px;padding:9px 0;border-top:${i === 0 ? "0" : "1px solid var(--border)"};">
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
    })
    .join("") +
    (semCulpa ? `<p style="color:var(--text-muted);font-size:11px;margin-top:10px;">+ ${semCulpa} ocorrência(s) sem setor informado.</p>` : "");
}

function oavulRenderLista() {
  const container = document.getElementById("oavulLista");
  if (!container) return;
  const lista = oavulState.lista;
  if (!lista.length) {
    container.innerHTML = '<p style="color:var(--text-muted);padding:18px 0;">Nenhuma ocorrência cadastrada para o filtro.</p>';
    return;
  }
  container.innerHTML = lista
    .map((o) => {
      const cor = OAVUL_STATUS_CORES[o.status] || "#94a3b8";
      return `<article class="tms-viagem">
        <div class="tms-viagem-head">
          <div style="flex:1;min-width:0;">
            <div class="tms-viagem-title">#${o.id}${o.titulo ? ` · ${escapar(o.titulo)}` : ""}</div>
            <div class="tms-meta">${formatarDataBR(o.data_ocorrencia)}${o.hora_ocorrencia ? ` às ${escapar(String(o.hora_ocorrencia).slice(0, 5))}` : ""}${o.culpa ? ` | Culpa: <strong style="color:var(--text-heading);">${escapar(o.culpa)}</strong>` : " | Sem setor"}</div>
            <div style="margin-top:8px;white-space:pre-wrap;color:var(--text-primary);font-size:13px;">${escapar(o.descricao)}</div>
            ${oavulRenderFotosLista(o.fotos)}
          </div>
          <div class="tms-viagem-acoes">
            <span style="font-size:11px;font-weight:800;color:${cor};background:${cor}22;border:1px solid ${cor}55;border-radius:7px;padding:3px 9px;white-space:nowrap;">${escapar(o.status)}</span>
            <select class="tms-status" onchange="oavulAlterarStatus(${o.id}, this.value)">
              ${OAVUL_STATUS.map((s) => oavulOption(s, s, s === o.status)).join("")}
            </select>
            <button type="button" class="btn-blue btn-sm" onclick="oavulEditar(${o.id})">Editar</button>
            <button type="button" class="btn-red btn-sm admin-only-action" onclick="oavulExcluir(${o.id})">Excluir</button>
          </div>
        </div>
      </article>`;
    })
    .join("");
}

async function oavulInit() {
  oavulPopularSelects();
  await oavulCarregar();
}

window.oavulAbrirForm = oavulAbrirForm;
window.oavulFecharForm = oavulFecharForm;
window.oavulSalvar = oavulSalvar;
window.oavulEditar = oavulEditar;
window.oavulExcluir = oavulExcluir;
window.oavulAlterarStatus = oavulAlterarStatus;
window.oavulAtualizarFotos = oavulAtualizarFotos;
window.oavulRemoverFoto = oavulRemoverFoto;
window.oavulAbrirFotoLink = oavulAbrirFotoLink;
window.oavulFecharFoto = oavulFecharFoto;
window.oavulCarregar = oavulCarregar;
window.oavulAplicarFiltros = oavulAplicarFiltros;
window.oavulLimparFiltro = oavulLimparFiltro;
window.oavulInit = oavulInit;
