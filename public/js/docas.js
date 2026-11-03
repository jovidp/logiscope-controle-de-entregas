// ================================================================
// docas.js - Aba "Horario Docas"
// ================================================================

(function iniciarDocas() {
  let dados = [];
  let carregando = false;

  const camposModal = {
    filial: "docasModalFilial",
    loja: "docasModalLoja",
    supervisor: "docasModalSupervisor",
    carrinho_4_rodas: "docasModalCarrinho4",
    carrinho_2_rodas: "docasModalCarrinho2",
    sem_carrinho_apos_horario: "docasModalSemCarrinho",
    horario: "docasModalHorario",
    autorizacao_previa: "docasModalAutorizacao",
    observacao: "docasModalObservacao",
  };

  function el(id) {
    return document.getElementById(id);
  }

  function esc(valor) {
    if (typeof escapar === "function") return escapar(valor);
    return String(valor == null ? "" : valor).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]);
  }

  function apiDocas(path = "") {
    return `${API_URL}/docas${path}`;
  }

  function podeEditarDocas() {
    return window.authUsuario?.perfil === "ADM";
  }

  function avisar(mensagem, tipo = "ok") {
    if (typeof alertar === "function") {
      alertar(mensagem, tipo);
    } else {
      console[tipo === "erro" ? "error" : "log"](mensagem);
    }
  }

  function itemPorId(id) {
    const idNum = Number(id);
    return dados.find((item) => Number(item.id) === idNum) || null;
  }

  function preencherCampo(id, valor) {
    const campo = el(id);
    if (campo) campo.value = valor || "";
  }

  function lerPayloadModal() {
    return Object.fromEntries(
      Object.entries(camposModal).map(([campo, id]) => [campo, el(id)?.value?.trim() || ""]),
    );
  }

  function preencherSelect() {
    const select = el("docasSelectLoja");
    if (!select) return;

    const opcoes = dados
      .map((item) => `<option value="${item.id}">${esc(item.filial)} - ${esc(item.loja)}</option>`)
      .join("");

    select.innerHTML = `<option value="">Selecione uma loja...</option>${opcoes}`;
  }

  function renderDetalhe(item) {
    const detalhe = el("docasDetalhe");
    if (!detalhe) return;

    if (!item) {
      detalhe.innerHTML = "";
      return;
    }

    detalhe.innerHTML = `
      <div style="border:1px solid var(--border);background:var(--bg-elevated);border-radius:10px;padding:14px;display:grid;gap:10px;">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;">
          <div>
            <strong style="color:var(--text-heading);">${esc(item.filial)} - ${esc(item.loja)}</strong>
            <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">Supervisor: ${esc(item.supervisor || "-")}</div>
          </div>
          ${podeEditarDocas() ? `<button type="button" class="btn-ghost btn-sm" onclick="docasAbrirModal(${item.id})">Editar</button>` : ""}
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;font-size:13px;">
          <div><strong>4 rodas:</strong> ${esc(item.carrinho_4_rodas || "-")}</div>
          <div><strong>2 rodas:</strong> ${esc(item.carrinho_2_rodas || "-")}</div>
          <div><strong>Sem carrinho:</strong> ${esc(item.sem_carrinho_apos_horario || "-")}</div>
          <div><strong>Docas:</strong> ${esc(item.horario || "-")}</div>
          <div><strong>Autorizacao:</strong> ${esc(item.autorizacao_previa || "-")}</div>
        </div>
        ${item.observacao ? `<div style="font-size:13px;color:var(--text-body);">${esc(item.observacao)}</div>` : ""}
      </div>
    `;
  }

  function renderTabela() {
    const container = el("docasTabela");
    if (!container) return;

    const contador = el("docasContador");
    if (contador) contador.textContent = `${dados.length} filiais`;

    if (!dados.length) {
      container.innerHTML = `
        <div style="padding:24px;text-align:center;color:var(--text-muted);">
          Nenhuma filial cadastrada.
          ${podeEditarDocas() ? `<a href="#" onclick="docasAbrirModal(null);return false;" style="color:var(--azul);font-weight:700;">Criar nova</a>` : ""}
        </div>
      `;
      preencherSelect();
      renderDetalhe(null);
      return;
    }

    container.innerHTML = `
      <table data-ordenavel style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="border-bottom:1px solid var(--border);background:var(--bg-elevated);">
            <th style="padding:10px;text-align:left;color:var(--text-muted);">Filial</th>
            <th style="padding:10px;text-align:left;color:var(--text-muted);">Loja</th>
            <th style="padding:10px;text-align:left;color:var(--text-muted);">Supervisor</th>
            <th style="padding:10px;text-align:left;color:var(--text-muted);">Horario</th>
            ${podeEditarDocas() ? `<th style="padding:10px;text-align:center;color:var(--text-muted);">Acoes</th>` : ""}
          </tr>
        </thead>
        <tbody>
          ${dados.map((item) => `
            <tr data-doca-id="${item.id}" onclick="docasSelecionar(${item.id})" style="border-bottom:1px solid var(--border);cursor:pointer;">
              <td style="padding:10px;">${esc(item.filial || "-")}</td>
              <td style="padding:10px;">${esc(item.loja || "-")}</td>
              <td style="padding:10px;">${esc(item.supervisor || "-")}</td>
              <td style="padding:10px;">${esc(item.horario || "-")}</td>
              ${podeEditarDocas() ? `
                <td style="padding:10px;text-align:center;white-space:nowrap;">
                  <button type="button" onclick="event.stopPropagation();docasAbrirModal(${item.id})" class="btn-ghost btn-sm" style="font-size:11px;padding:4px 8px;">Editar</button>
                  <button type="button" onclick="event.stopPropagation();docasExcluir(${item.id})" class="btn-ghost btn-sm" style="font-size:11px;padding:4px 8px;color:var(--vermelho);">Excluir</button>
                </td>
              ` : ""}
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;

    preencherSelect();
  }

  async function docasCarregarDados() {
    if (carregando) return;
    carregando = true;

    try {
      const resp = await fetch(apiDocas(`?_=${Date.now()}`));
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      dados = await resp.json();
    } catch (err) {
      console.error("[Docas] Erro ao carregar:", err);
      dados = [];
      avisar("Nao foi possivel carregar os horarios das docas.", "erro");
    } finally {
      carregando = false;
      renderTabela();
    }
  }

  function docasInit() {
    docasCarregarDados();
  }

  function docasFiltrar() {
    const termo = (el("docasBusca")?.value || "").toLowerCase();
    document.querySelectorAll("#docasTabela tbody tr").forEach((linha) => {
      linha.style.display = linha.textContent.toLowerCase().includes(termo) ? "" : "none";
    });
  }

  function docasSelecionar(valor) {
    const item = itemPorId(valor);
    renderDetalhe(item);
    const select = el("docasSelectLoja");
    if (select && String(select.value) !== String(valor || "")) select.value = valor || "";
  }

  function docasAbrirModal(id) {
    const modal = el("docasModal");
    const titulo = el("docasModalTitulo");
    const inputId = el("docasModalId");
    const excluirBtn = el("docasModalExcluirBtn");
    if (!modal || !titulo || !inputId) return;

    const item = id == null ? null : itemPorId(id);
    titulo.textContent = item ? "Editar filial" : "Nova filial";
    inputId.value = item?.id || "";

    Object.entries(camposModal).forEach(([campo, input]) => {
      preencherCampo(input, item?.[campo] || "");
    });

    if (excluirBtn) {
      excluirBtn.style.display = item ? "" : "none";
      excluirBtn.onclick = () => docasExcluir(item?.id);
    }

    modal.style.display = "flex";
  }

  function docasFecharModal() {
    const modal = el("docasModal");
    if (modal) modal.style.display = "none";
  }

  async function docasSalvar() {
    const inputId = el("docasModalId");
    if (!inputId) return;

    const id = inputId.value;
    const payload = lerPayloadModal();
    if (!payload.filial || !payload.loja) {
      avisar("Informe filial e loja.", "erro");
      return;
    }

    try {
      const resp = await fetch(apiDocas(id ? `/${encodeURIComponent(id)}` : ""), {
        method: id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(body.error || `HTTP ${resp.status}`);

      docasFecharModal();
      await docasCarregarDados();
      if (body.id) docasSelecionar(body.id);
      avisar("Horario da doca salvo com sucesso.", "ok");
    } catch (err) {
      console.error("[Docas] Erro ao salvar:", err);
      avisar(err.message || "Erro ao salvar horario da doca.", "erro");
    }
  }

  async function docasExcluir(id) {
    const alvoId = id || el("docasModalId")?.value;
    if (!alvoId) return;
    if (!(await confirmarBonito("Deseja realmente excluir esta filial?", { okLabel: "Excluir", cancelLabel: "Cancelar" }))) return;

    try {
      const resp = await fetch(apiDocas(`/${encodeURIComponent(alvoId)}`), { method: "DELETE" });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(body.error || `HTTP ${resp.status}`);

      docasFecharModal();
      await docasCarregarDados();
      avisar("Filial excluida com sucesso.", "ok");
    } catch (err) {
      console.error("[Docas] Erro ao excluir:", err);
      avisar(err.message || "Erro ao excluir filial.", "erro");
    }
  }

  window.docasInit = docasInit;
  window.docasFiltrar = docasFiltrar;
  window.docasSelecionar = docasSelecionar;
  window.docasAbrirModal = docasAbrirModal;
  window.docasFecharModal = docasFecharModal;
  window.docasSalvar = docasSalvar;
  window.docasExcluir = docasExcluir;
})();
