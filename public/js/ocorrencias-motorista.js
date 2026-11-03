// ================================================================
// CONDUTA DO MOTORISTA — registro disciplinar/comportamental (Transporte)
// ----------------------------------------------------------------
// CRUD da aba "Conduta Motorista". Consome /ocorrencias-motorista (ADM-only
// no backend). Nada a ver com ocorrencias de ENTREGA. Prefixo: omot*.
// Reusa os globais escapar()/hojeISO()/alertar()/confirmarBonito().
// ================================================================
(function () {
  "use strict";

  const API = window.location.origin;
  const OMOT_TIPOS = [
    "Conflito interpessoal",
    "Recusa de demanda",
    "Comportamento/postura",
    "Atraso/falta reincidente",
    "Direção perigosa",
    "Outro",
  ];
  const OMOT_GRAVIDADES = ["Leve", "Média", "Grave"];
  const OMOT_PROVIDENCIAS = [
    "Nenhuma",
    "Conversa/orientação",
    "Advertência verbal",
    "Advertência escrita",
    "Suspensão",
    "Outro",
  ];
  const OMOT_STATUS = ["Aberta", "Em análise", "Resolvida"];

  const state = { lista: [], contagem: [], filtradas: [], editandoId: null, motoristas: [], carregouMot: false };

  const esc = (v) => (typeof escapar === "function" ? escapar(v) : String(v == null ? "" : v));
  const hoje = () => (typeof hojeISO === "function" ? hojeISO() : new Date().toLocaleDateString("en-CA"));
  const avisar = (m) => (typeof alertar === "function" ? alertar(m) : alert(m));
  const opt = (v, sel) => `<option value="${esc(v)}" ${v === sel ? "selected" : ""}>${esc(v)}</option>`;

  async function omotRequest(path, options = {}) {
    const headers = { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
    const resp = await fetch(`${API}${path}`, { ...options, headers });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(j.error || `HTTP ${resp.status}`);
    return j;
  }

  // Lista de motoristas do cadastro (mesma fonte dos outros modulos).
  async function carregarMotoristas() {
    if (state.carregouMot) return;
    try {
      const rows = await omotRequest("/cadastros");
      state.motoristas = (Array.isArray(rows) ? rows : [])
        .filter((r) => String(r.tipo).toLowerCase() === "motorista" && !r.oculto)
        .map((r) => r.valor)
        .sort((a, b) => String(a).localeCompare(String(b), "pt-BR"));
      state.carregouMot = true;
    } catch (_) {
      state.motoristas = [];
    }
  }

  function popularSelects() {
    const selMot = document.getElementById("omotMotorista");
    if (selMot) {
      const atual = selMot.value;
      selMot.innerHTML = `<option value="">Selecione o motorista</option>${state.motoristas.map((m) => opt(m, atual)).join("")}`;
    }
    const fill = (id, itens, padrao) => {
      const el = document.getElementById(id);
      if (!el) return;
      const atual = el.value || padrao || "";
      el.innerHTML = itens.map((s) => opt(s, atual)).join("");
    };
    fill("omotTipo", ["", ...OMOT_TIPOS], "");
    fill("omotGravidade", OMOT_GRAVIDADES, "Leve");
    fill("omotProvidencia", ["", ...OMOT_PROVIDENCIAS], "");
    fill("omotStatus", OMOT_STATUS, "Aberta");
    const fStatus = document.getElementById("omotFiltroStatus");
    if (fStatus && fStatus.options.length <= 1) {
      fStatus.innerHTML = `<option value="">Todos os status</option>${OMOT_STATUS.map((s) => opt(s, "")).join("")}`;
    }
  }

  async function omotAbrirForm() {
    await carregarMotoristas();
    const form = document.getElementById("omotForm");
    if (!form) return;
    state.editandoId = null;
    form.classList.remove("hidden");
    document.getElementById("omotFormTitulo").textContent = "Novo registro";
    document.getElementById("omotSalvarBtn").textContent = "Salvar registro";
    popularSelects();
    document.getElementById("omotData").value = hoje();
    document.getElementById("omotHora").value = "";
    document.getElementById("omotMotorista").value = "";
    document.getElementById("omotEnvolvidos").value = "";
    document.getElementById("omotTipo").value = "";
    document.getElementById("omotGravidade").value = "Leve";
    document.getElementById("omotProvidencia").value = "";
    document.getElementById("omotStatus").value = "Aberta";
    document.getElementById("omotRelato").value = "";
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function omotFecharForm() {
    state.editandoId = null;
    document.getElementById("omotForm")?.classList.add("hidden");
  }

  async function omotSalvar(event) {
    event.preventDefault();
    const body = {
      data_ocorrencia: document.getElementById("omotData").value,
      hora: document.getElementById("omotHora").value || null,
      motorista: document.getElementById("omotMotorista").value,
      envolvidos: document.getElementById("omotEnvolvidos").value.trim(),
      tipo: document.getElementById("omotTipo").value,
      gravidade: document.getElementById("omotGravidade").value,
      providencia: document.getElementById("omotProvidencia").value,
      status: document.getElementById("omotStatus").value,
      relato: document.getElementById("omotRelato").value.trim(),
    };
    if (!body.data_ocorrencia || !body.motorista || !body.relato) {
      avisar("Informe data, motorista e relato.");
      return;
    }
    try {
      const editando = state.editandoId;
      const path = editando ? `/ocorrencias-motorista/${editando}` : "/ocorrencias-motorista";
      await omotRequest(path, { method: editando ? "PUT" : "POST", body: JSON.stringify(body) });
      omotFecharForm();
      await omotCarregar();
      avisar(editando ? "Registro atualizado." : "Registro salvo.");
    } catch (err) {
      avisar(`Não foi possível salvar: ${err.message}`);
    }
  }

  async function omotEditar(id) {
    await carregarMotoristas();
    const o = state.lista.find((x) => x.id === id);
    if (!o) return;
    state.editandoId = id;
    const form = document.getElementById("omotForm");
    form.classList.remove("hidden");
    document.getElementById("omotFormTitulo").textContent = "Editar registro";
    document.getElementById("omotSalvarBtn").textContent = "Atualizar registro";
    popularSelects();
    document.getElementById("omotData").value = (o.data_ocorrencia || "").slice(0, 10);
    document.getElementById("omotHora").value = o.hora || "";
    document.getElementById("omotMotorista").value = o.motorista || "";
    document.getElementById("omotEnvolvidos").value = o.envolvidos || "";
    document.getElementById("omotTipo").value = o.tipo || "";
    document.getElementById("omotGravidade").value = o.gravidade || "Leve";
    document.getElementById("omotProvidencia").value = o.providencia || "";
    document.getElementById("omotStatus").value = o.status || "Aberta";
    document.getElementById("omotRelato").value = o.relato || "";
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function omotExcluir(id) {
    const ok = typeof confirmarBonito === "function"
      ? await confirmarBonito("Excluir este registro de conduta?", { okLabel: "Excluir", cancelLabel: "Cancelar" })
      : confirm("Excluir este registro de conduta?");
    if (!ok) return;
    try {
      await omotRequest(`/ocorrencias-motorista/${id}`, { method: "DELETE" });
      await omotCarregar();
      avisar("Registro excluído.");
    } catch (err) {
      avisar(`Não foi possível excluir: ${err.message}`);
    }
  }

  async function omotCarregar() {
    const inicio = document.getElementById("omotFiltroInicio")?.value;
    const fim = document.getElementById("omotFiltroFim")?.value;
    const params = new URLSearchParams();
    if (inicio) params.set("inicio", inicio);
    if (fim) params.set("fim", fim);
    try {
      const j = await omotRequest(`/ocorrencias-motorista?${params.toString()}`);
      state.lista = j.lista || [];
      state.contagem = j.contagem || [];
      omotAplicarFiltros();
      omotRenderKpis();
      omotRenderContagem();
    } catch (err) {
      const lista = document.getElementById("omotLista");
      if (lista) lista.innerHTML = `<p style="color:var(--text-muted);padding:14px 0;">Não foi possível carregar (${esc(err.message)}).</p>`;
    }
  }

  function omotAplicarFiltros() {
    const status = document.getElementById("omotFiltroStatus")?.value || "";
    const busca = (document.getElementById("omotFiltroBusca")?.value || "").toLowerCase().trim();
    state.filtradas = state.lista.filter((o) => {
      if (status && o.status !== status) return false;
      if (busca) {
        const alvo = `${o.motorista || ""} ${o.relato || ""} ${o.envolvidos || ""} ${o.tipo || ""}`.toLowerCase();
        if (!alvo.includes(busca)) return false;
      }
      return true;
    });
    omotRenderLista();
  }

  function omotLimparFiltro() {
    ["omotFiltroInicio", "omotFiltroFim", "omotFiltroBusca"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    const st = document.getElementById("omotFiltroStatus");
    if (st) st.value = "";
    omotCarregar();
  }

  const CORES_GRAV = { Leve: "#22c55e", "Média": "#f59e0b", Grave: "#ef4444" };
  const CORES_STATUS = { Aberta: "#ef4444", "Em análise": "#f59e0b", Resolvida: "#22c55e" };

  function omotRenderKpis() {
    const box = document.getElementById("omotKpis");
    if (!box) return;
    const total = state.lista.length;
    const abertas = state.lista.filter((o) => o.status !== "Resolvida").length;
    const graves = state.lista.filter((o) => o.gravidade === "Grave").length;
    const motDistintos = new Set(state.lista.map((o) => o.motorista)).size;
    const cards = [
      ["Registros", total, "#6366f1"],
      ["Em aberto", abertas, "#f59e0b"],
      ["Graves", graves, "#ef4444"],
      ["Motoristas", motDistintos, "#38bdf8"],
    ];
    box.innerHTML = cards.map(([label, valor, cor]) =>
      `<div class="tms-kpi" style="border-left:3px solid ${cor};">
        <strong style="color:${cor};font-size:25px;">${esc(String(valor))}</strong>
        <span>${label}</span>
      </div>`).join("");
  }

  function omotRenderContagem() {
    const box = document.getElementById("omotContagem");
    if (!box) return;
    if (!state.contagem.length) {
      box.innerHTML = `<p style="color:var(--text-muted);padding:14px 0;">Sem registros ainda.</p>`;
      return;
    }
    const max = state.contagem.reduce((m, c) => Math.max(m, c.total), 0) || 1;
    box.innerHTML = state.contagem.map((c) => {
      const pct = Math.round((100 * c.total) / max);
      return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:7px;">
        <div style="flex:0 0 32%;min-width:0;font-size:13px;color:var(--text-heading);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(c.motorista)}</div>
        <div style="flex:1 1 auto;height:9px;border-radius:5px;background:rgba(255,255,255,.06);overflow:hidden;">
          <div style="height:100%;width:${pct}%;border-radius:5px;background:linear-gradient(90deg,#f59e0b,#ef4444);"></div>
        </div>
        <div style="flex:0 0 auto;width:180px;text-align:right;font-size:11.5px;color:var(--text-muted);">
          <b style="color:var(--text-heading);">${c.total}</b> reg.${c.abertas ? ` · ${c.abertas} aberto(s)` : ""}${c.graves ? ` · <span style="color:#fca5a5;">${c.graves} grave(s)</span>` : ""}
        </div>
      </div>`;
    }).join("");
  }

  function omotRenderLista() {
    const box = document.getElementById("omotLista");
    if (!box) return;
    if (!state.filtradas.length) {
      box.innerHTML = `<p style="color:var(--text-muted);padding:18px 0;">Nenhum registro no filtro atual.</p>`;
      return;
    }
    box.innerHTML = state.filtradas.map((o) => {
      const data = (o.data_ocorrencia || "").slice(0, 10).split("-").reverse().join("/");
      const gcor = CORES_GRAV[o.gravidade] || "#94a3b8";
      const scor = CORES_STATUS[o.status] || "#94a3b8";
      const badge = (txt, cor) => `<span style="font-size:10.5px;font-weight:800;padding:2px 8px;border-radius:20px;background:${cor}22;color:${cor};border:1px solid ${cor}55;">${esc(txt)}</span>`;
      return `<div class="section-shell" style="padding:13px 15px;margin-bottom:9px;">
        <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:6px;">
          <b style="font-size:14px;color:var(--text-heading);">${esc(o.motorista)}</b>
          ${badge(o.gravidade || "Leve", gcor)}
          ${badge(o.status || "Aberta", scor)}
          ${o.tipo ? `<span style="font-size:11.5px;color:var(--text-muted);">${esc(o.tipo)}</span>` : ""}
          <span style="margin-left:auto;font-size:11.5px;color:var(--text-muted);">${data}${o.hora ? " · " + esc(o.hora) : ""}</span>
        </div>
        <div style="font-size:13px;color:var(--text-secondary);line-height:1.5;white-space:pre-wrap;">${esc(o.relato)}</div>
        ${o.envolvidos ? `<div style="font-size:11.5px;color:var(--text-muted);margin-top:5px;">👥 Envolvidos: ${esc(o.envolvidos)}</div>` : ""}
        ${o.providencia ? `<div style="font-size:11.5px;color:var(--text-muted);margin-top:3px;">🛠️ Providência: ${esc(o.providencia)}</div>` : ""}
        <div style="display:flex;align-items:center;gap:8px;margin-top:9px;">
          ${o.registrado_por ? `<span style="font-size:10.5px;color:var(--text-muted);">por ${esc(o.registrado_por)}</span>` : ""}
          <button type="button" class="btn-ghost btn-sm" style="margin-left:auto;" onclick="omotEditar(${o.id})">Editar</button>
          <button type="button" class="btn-ghost btn-sm" onclick="omotExcluir(${o.id})">Excluir</button>
        </div>
      </div>`;
    }).join("");
  }

  let iniciado = false;
  async function omotInit() {
    popularSelects();
    if (!iniciado) {
      iniciado = true;
      const hj = hoje();
      // Filtro padrao: ultimos 90 dias.
      const ini = new Date();
      ini.setDate(ini.getDate() - 90);
      const iEl = document.getElementById("omotFiltroInicio");
      const fEl = document.getElementById("omotFiltroFim");
      if (iEl && !iEl.value) iEl.value = ini.toLocaleDateString("en-CA");
      if (fEl && !fEl.value) fEl.value = hj;
    }
    await carregarMotoristas();
    await omotCarregar();
  }

  window.omotInit = omotInit;
  window.omotAbrirForm = omotAbrirForm;
  window.omotFecharForm = omotFecharForm;
  window.omotSalvar = omotSalvar;
  window.omotEditar = omotEditar;
  window.omotExcluir = omotExcluir;
  window.omotCarregar = omotCarregar;
  window.omotAplicarFiltros = omotAplicarFiltros;
  window.omotLimparFiltro = omotLimparFiltro;
})();
