// ================================================================
// RESPONSÁVEIS DE LOJA — cadastro de quem responde por cada loja.
// ----------------------------------------------------------------
// CRUD da aba "Responsáveis de Loja". Consome /loja-responsaveis.
// Cadastro simples: loja + nome + telefone. Uma loja pode ter vários.
// Prefixo: rloja*. Reusa globais escapar()/alertar()/confirmarBonito()/
// canonizarLoja()/formatarNomeLoja(). A lista de lojas vem do cadastro
// (/cadastros tipo "loja"), exibida no nome canônico (BANGU 1, ITAGUAÍ 1).
// ================================================================
(function () {
  "use strict";

  const API = window.location.origin;
  const state = { lista: [], filtradas: [], editandoId: null, lojas: [], carregouLojas: false };

  const esc = (v) => (typeof escapar === "function" ? escapar(v) : String(v == null ? "" : v));
  const avisar = (m) => (typeof alertar === "function" ? alertar(m) : alert(m));
  const canonLoja = (v) => {
    if (typeof canonizarLoja === "function") return canonizarLoja(v) || String(v || "");
    if (typeof formatarNomeLoja === "function") return formatarNomeLoja(v) || String(v || "");
    return String(v || "");
  };
  const opt = (v, sel) => `<option value="${esc(v)}" ${v === sel ? "selected" : ""}>${esc(v)}</option>`;

  async function rlojaRequest(path, options = {}) {
    const headers = { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
    const resp = await fetch(`${API}${path}`, { ...options, headers });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(j.error || `HTTP ${resp.status}`);
    return j;
  }

  // Lista canônica de lojas (mesma fonte do #loja dos formulários): o mapa
  // global lojasRotas é o autoritativo; complementamos com as lojas cadastradas
  // no banco (tipo "loja"), caso existam. Tudo exibido no nome canônico.
  async function carregarLojas() {
    if (state.carregouLojas) return;
    const nomes = new Set();
    try {
      if (typeof lojasRotas !== "undefined" && lojasRotas && typeof lojasRotas === "object") {
        Object.keys(lojasRotas).forEach((k) => {
          const n = canonLoja(k);
          if (n) nomes.add(n);
        });
      }
    } catch (_) { /* lojasRotas ainda não carregou — segue com o cadastro */ }
    try {
      const rows = await rlojaRequest("/cadastros");
      (Array.isArray(rows) ? rows : [])
        .filter((r) => String(r.tipo).toLowerCase() === "loja" && !r.oculto)
        .forEach((r) => {
          const n = canonLoja(r.valor);
          if (n) nomes.add(n);
        });
    } catch (_) { /* sem cadastro no banco — lojasRotas já cobre */ }
    state.lojas = [...nomes].sort((a, b) => String(a).localeCompare(String(b), "pt-BR"));
    state.carregouLojas = true;
  }

  function popularSelects() {
    const sel = document.getElementById("rlojaLoja");
    if (sel) {
      const atual = sel.value;
      sel.innerHTML = `<option value="">Selecione a loja</option>${state.lojas.map((l) => opt(l, atual)).join("")}`;
    }
    const filtro = document.getElementById("rlojaFiltroLoja");
    if (filtro) {
      const atual = filtro.value;
      // Une as lojas do cadastro com as que já aparecem nos registros.
      const doReg = state.lista.map((r) => r.loja);
      const todas = [...new Set([...state.lojas, ...doReg])]
        .filter(Boolean)
        .sort((a, b) => String(a).localeCompare(String(b), "pt-BR"));
      filtro.innerHTML = `<option value="">Todas as lojas</option>${todas.map((l) => opt(l, atual)).join("")}`;
    }
  }

  async function rlojaAbrirForm() {
    await carregarLojas();
    const form = document.getElementById("rlojaForm");
    if (!form) return;
    state.editandoId = null;
    form.classList.remove("hidden");
    document.getElementById("rlojaFormTitulo").textContent = "Novo responsável";
    document.getElementById("rlojaSalvarBtn").textContent = "Salvar responsável";
    popularSelects();
    document.getElementById("rlojaLoja").value = "";
    document.getElementById("rlojaNome").value = "";
    document.getElementById("rlojaTelefone").value = "";
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function rlojaFecharForm() {
    state.editandoId = null;
    document.getElementById("rlojaForm")?.classList.add("hidden");
  }

  async function rlojaSalvar(event) {
    event.preventDefault();
    const body = {
      loja: document.getElementById("rlojaLoja").value,
      nome: document.getElementById("rlojaNome").value.trim(),
      telefone: document.getElementById("rlojaTelefone").value.trim() || null,
    };
    if (!body.loja || !body.nome) {
      avisar("Informe a loja e o nome do responsável.");
      return;
    }
    try {
      const editando = state.editandoId;
      const path = editando ? `/loja-responsaveis/${editando}` : "/loja-responsaveis";
      await rlojaRequest(path, { method: editando ? "PUT" : "POST", body: JSON.stringify(body) });
      rlojaFecharForm();
      await rlojaCarregar();
      avisar(editando ? "Responsável atualizado." : "Responsável salvo.");
    } catch (err) {
      avisar(`Não foi possível salvar: ${err.message}`);
    }
  }

  async function rlojaEditar(id) {
    await carregarLojas();
    const o = state.lista.find((x) => x.id === id);
    if (!o) return;
    state.editandoId = id;
    const form = document.getElementById("rlojaForm");
    form.classList.remove("hidden");
    document.getElementById("rlojaFormTitulo").textContent = "Editar responsável";
    document.getElementById("rlojaSalvarBtn").textContent = "Atualizar responsável";
    popularSelects();
    // Garante a loja do registro na lista do select, mesmo que não esteja no cadastro.
    const selLoja = document.getElementById("rlojaLoja");
    if (selLoja && o.loja && !state.lojas.includes(o.loja)) {
      selLoja.insertAdjacentHTML("beforeend", opt(o.loja, ""));
    }
    document.getElementById("rlojaLoja").value = o.loja || "";
    document.getElementById("rlojaNome").value = o.nome || "";
    document.getElementById("rlojaTelefone").value = o.telefone || "";
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function rlojaExcluir(id) {
    const o = state.lista.find((x) => x.id === id);
    const alvo = o ? `"${o.nome}" (${o.loja})` : "selecionado";
    const ok = typeof confirmarBonito === "function"
      ? await confirmarBonito(`Excluir o responsável ${alvo}?`, { okLabel: "Excluir", cancelLabel: "Cancelar" })
      : confirm("Excluir este responsável?");
    if (!ok) return;
    try {
      await rlojaRequest(`/loja-responsaveis/${id}`, { method: "DELETE" });
      await rlojaCarregar();
      avisar("Responsável excluído.");
    } catch (err) {
      avisar(`Não foi possível excluir: ${err.message}`);
    }
  }

  async function rlojaCarregar() {
    try {
      const rows = await rlojaRequest("/loja-responsaveis");
      state.lista = Array.isArray(rows) ? rows : [];
      popularSelects();
      rlojaRenderKpis();
      rlojaAplicarFiltros();
    } catch (err) {
      const lista = document.getElementById("rlojaLista");
      if (lista) lista.innerHTML = `<p style="color:var(--text-muted);padding:14px 0;">Não foi possível carregar (${esc(err.message)}).</p>`;
    }
  }

  function rlojaAplicarFiltros() {
    const loja = document.getElementById("rlojaFiltroLoja")?.value || "";
    const busca = (document.getElementById("rlojaFiltroBusca")?.value || "").toLowerCase().trim();
    state.filtradas = state.lista.filter((o) => {
      if (loja && o.loja !== loja) return false;
      if (busca) {
        const alvo = `${o.loja || ""} ${o.nome || ""} ${o.telefone || ""}`.toLowerCase();
        if (!alvo.includes(busca)) return false;
      }
      return true;
    });
    rlojaRenderLista();
  }

  function rlojaLimparFiltro() {
    const b = document.getElementById("rlojaFiltroBusca");
    if (b) b.value = "";
    const l = document.getElementById("rlojaFiltroLoja");
    if (l) l.value = "";
    rlojaAplicarFiltros();
  }

  function rlojaRenderKpis() {
    const box = document.getElementById("rlojaKpis");
    if (!box) return;
    const total = state.lista.length;
    const lojasComResp = new Set(state.lista.map((o) => o.loja)).size;
    const semResp = Math.max(0, state.lojas.length - lojasComResp);
    const cards = [
      ["Responsáveis", total, "#6366f1"],
      ["Lojas cobertas", lojasComResp, "#22c55e"],
      ["Lojas sem responsável", semResp, "#f59e0b"],
    ];
    box.innerHTML = cards.map(([label, valor, cor]) =>
      `<div class="tms-kpi" style="border-left:3px solid ${cor};">
        <strong style="color:${cor};font-size:25px;">${esc(String(valor))}</strong>
        <span>${label}</span>
      </div>`).join("");
  }

  function rlojaRenderLista() {
    const box = document.getElementById("rlojaLista");
    if (!box) return;
    if (!state.filtradas.length) {
      box.innerHTML = `<p style="color:var(--text-muted);padding:18px 0;">Nenhum responsável no filtro atual.</p>`;
      return;
    }
    // Agrupa por loja para leitura.
    const porLoja = new Map();
    state.filtradas.forEach((o) => {
      if (!porLoja.has(o.loja)) porLoja.set(o.loja, []);
      porLoja.get(o.loja).push(o);
    });
    const lojasOrdenadas = [...porLoja.keys()].sort((a, b) => String(a).localeCompare(String(b), "pt-BR"));
    box.innerHTML = lojasOrdenadas.map((loja) => {
      const itens = porLoja.get(loja).sort((a, b) => String(a.nome).localeCompare(String(b.nome), "pt-BR"));
      const linhas = itens.map((o) => `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 0;border-top:1px solid var(--border);">
          <b style="font-size:13.5px;color:var(--text-heading);">${esc(o.nome)}</b>
          ${o.telefone
            ? `<a href="tel:${esc(String(o.telefone).replace(/[^0-9+]/g, ""))}" style="font-size:12.5px;color:var(--text-secondary);text-decoration:none;">📞 ${esc(o.telefone)}</a>`
            : `<span style="font-size:11.5px;color:var(--text-muted);">sem telefone</span>`}
          <span style="margin-left:auto;display:flex;gap:8px;">
            <button type="button" class="btn-ghost btn-sm" onclick="rlojaEditar(${o.id})">Editar</button>
            <button type="button" class="btn-ghost btn-sm" onclick="rlojaExcluir(${o.id})">Excluir</button>
          </span>
        </div>`).join("");
      return `<div class="section-shell" style="padding:13px 15px;margin-bottom:10px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:14px;">🏬</span>
          <b style="font-size:14.5px;color:var(--text-heading);">${esc(loja)}</b>
          <span style="font-size:11.5px;color:var(--text-muted);">${itens.length} responsável(is)</span>
        </div>
        ${linhas}
      </div>`;
    }).join("");
  }

  async function rlojaInit() {
    await carregarLojas();
    popularSelects();
    await rlojaCarregar();
  }

  window.rlojaInit = rlojaInit;
  window.rlojaAbrirForm = rlojaAbrirForm;
  window.rlojaFecharForm = rlojaFecharForm;
  window.rlojaSalvar = rlojaSalvar;
  window.rlojaEditar = rlojaEditar;
  window.rlojaExcluir = rlojaExcluir;
  window.rlojaCarregar = rlojaCarregar;
  window.rlojaAplicarFiltros = rlojaAplicarFiltros;
  window.rlojaLimparFiltro = rlojaLimparFiltro;
})();
