// ================================================================
// CONTROLE DE UBER — ledger das corridas solicitadas pelo Transporte.
// ----------------------------------------------------------------
// CRUD da aba "Controle Uber". Consome /controle-uber (ADM-only no backend).
// Registro de despesa: quem pediu (requisitante), quem solicitou, setor
// solicitante (sempre Transporte), data, origem, destino e valor. Prefixo: uber*.
// Reusa os globais escapar()/hojeISO()/alertar()/confirmarBonito().
// ================================================================
(function () {
  "use strict";

  const API = window.location.origin;
  const state = { lista: [], filtradas: [], editandoId: null };

  const esc = (v) => (typeof escapar === "function" ? escapar(v) : String(v == null ? "" : v));
  const hoje = () => (typeof hojeISO === "function" ? hojeISO() : new Date().toLocaleDateString("en-CA"));
  const avisar = (m) => (typeof alertar === "function" ? alertar(m) : alert(m));

  const fmtMoeda = (v) => {
    if (v == null || v === "") return "—";
    const n = Number(v);
    if (!Number.isFinite(n)) return "—";
    return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  };

  async function uberRequest(path, options = {}) {
    const headers = { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
    const resp = await fetch(`${API}${path}`, { ...options, headers });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(j.error || `HTTP ${resp.status}`);
    return j;
  }

  function uberAbrirForm() {
    const form = document.getElementById("uberForm");
    if (!form) return;
    state.editandoId = null;
    form.classList.remove("hidden");
    document.getElementById("uberFormTitulo").textContent = "Nova corrida";
    document.getElementById("uberSalvarBtn").textContent = "Salvar corrida";
    document.getElementById("uberData").value = hoje();
    document.getElementById("uberRequisitante").value = "";
    document.getElementById("uberSolicitante").value = "";
    document.getElementById("uberSetorSolicitante").value = "Transporte";
    document.getElementById("uberOrigem").value = "";
    document.getElementById("uberDestino").value = "";
    document.getElementById("uberMotivo").value = "";
    document.getElementById("uberValor").value = "";
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function uberFecharForm() {
    state.editandoId = null;
    document.getElementById("uberForm")?.classList.add("hidden");
  }

  async function uberSalvar(event) {
    event.preventDefault();
    const body = {
      data: document.getElementById("uberData").value,
      setor_pessoa_requisitante: document.getElementById("uberRequisitante").value.trim(),
      solicitante: document.getElementById("uberSolicitante").value.trim(),
      setor_solicitante: document.getElementById("uberSetorSolicitante").value.trim() || "Transporte",
      origem: document.getElementById("uberOrigem").value.trim(),
      destino: document.getElementById("uberDestino").value.trim(),
      motivo: document.getElementById("uberMotivo").value.trim(),
      valor: document.getElementById("uberValor").value,
    };
    if (!body.data || !body.setor_pessoa_requisitante || !body.solicitante || !body.origem || !body.destino) {
      avisar("Preencha data, requisitante, solicitante, origem e destino.");
      return;
    }
    try {
      const editando = state.editandoId;
      const path = editando ? `/controle-uber/${editando}` : "/controle-uber";
      await uberRequest(path, { method: editando ? "PUT" : "POST", body: JSON.stringify(body) });
      uberFecharForm();
      await uberCarregar();
      avisar(editando ? "Corrida atualizada." : "Corrida salva.");
    } catch (err) {
      avisar(`Não foi possível salvar: ${err.message}`);
    }
  }

  function uberEditar(id) {
    const o = state.lista.find((x) => x.id === id);
    if (!o) return;
    state.editandoId = id;
    const form = document.getElementById("uberForm");
    form.classList.remove("hidden");
    document.getElementById("uberFormTitulo").textContent = "Editar corrida";
    document.getElementById("uberSalvarBtn").textContent = "Atualizar corrida";
    document.getElementById("uberData").value = (o.data || "").slice(0, 10);
    document.getElementById("uberRequisitante").value = o.setor_pessoa_requisitante || "";
    document.getElementById("uberSolicitante").value = o.solicitante || "";
    document.getElementById("uberSetorSolicitante").value = o.setor_solicitante || "Transporte";
    document.getElementById("uberOrigem").value = o.origem || "";
    document.getElementById("uberDestino").value = o.destino || "";
    document.getElementById("uberMotivo").value = o.motivo || "";
    document.getElementById("uberValor").value = o.valor == null ? "" : o.valor;
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function uberExcluir(id) {
    const ok = typeof confirmarBonito === "function"
      ? await confirmarBonito("Excluir esta corrida?", { okLabel: "Excluir", cancelLabel: "Cancelar" })
      : confirm("Excluir esta corrida?");
    if (!ok) return;
    try {
      await uberRequest(`/controle-uber/${id}`, { method: "DELETE" });
      await uberCarregar();
      avisar("Corrida excluída.");
    } catch (err) {
      avisar(`Não foi possível excluir: ${err.message}`);
    }
  }

  async function uberCarregar() {
    const inicio = document.getElementById("uberFiltroInicio")?.value;
    const fim = document.getElementById("uberFiltroFim")?.value;
    const params = new URLSearchParams();
    if (inicio) params.set("inicio", inicio);
    if (fim) params.set("fim", fim);
    try {
      const j = await uberRequest(`/controle-uber?${params.toString()}`);
      state.lista = j.lista || [];
      uberAplicarFiltros();
    } catch (err) {
      const lista = document.getElementById("uberLista");
      if (lista) lista.innerHTML = `<p style="color:var(--text-muted);padding:14px 0;">Não foi possível carregar (${esc(err.message)}).</p>`;
    }
  }

  function uberAplicarFiltros() {
    const busca = (document.getElementById("uberFiltroBusca")?.value || "").toLowerCase().trim();
    state.filtradas = state.lista.filter((o) => {
      if (busca) {
        const alvo = `${o.setor_pessoa_requisitante || ""} ${o.solicitante || ""} ${o.origem || ""} ${o.destino || ""} ${o.motivo || ""}`.toLowerCase();
        if (!alvo.includes(busca)) return false;
      }
      return true;
    });
    uberRenderLista();
  }

  function uberLimparFiltro() {
    ["uberFiltroInicio", "uberFiltroFim", "uberFiltroBusca"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    uberCarregar();
  }

  // Imprime a lista atualmente filtrada numa folha limpa (janela nova), sem
  // depender do CSS global de impressao. Inclui periodo do filtro e total.
  function uberImprimir() {
    const linhas = state.filtradas;
    if (!linhas.length) {
      avisar("Nenhuma corrida para imprimir no filtro atual.");
      return;
    }
    const brData = (s) => (s || "").slice(0, 10).split("-").reverse().join("/");
    const ini = document.getElementById("uberFiltroInicio")?.value || "";
    const fim = document.getElementById("uberFiltroFim")?.value || "";
    const periodo = (ini || fim) ? `Período: ${brData(ini) || "…"} a ${brData(fim) || "…"}` : "Todas as corridas";
    const total = linhas.reduce((acc, o) => acc + (Number(o.valor) || 0), 0);
    const corpo = linhas.map((o) => `
      <tr>
        <td>${brData(o.data)}</td>
        <td>${esc(o.setor_pessoa_requisitante)}</td>
        <td>${esc(o.solicitante)}</td>
        <td>${esc(o.setor_solicitante || "Transporte")}</td>
        <td>${esc(o.origem)}</td>
        <td>${esc(o.destino)}</td>
        <td>${esc(o.motivo || "")}</td>
        <td class="num">${esc(fmtMoeda(o.valor))}</td>
      </tr>`).join("");
    const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8" />
      <title>Controle de Uber</title>
      <style>
        * { box-sizing: border-box; }
        body { font-family: Arial, Helvetica, sans-serif; color: #111; margin: 24px; }
        h1 { font-size: 18px; margin: 0 0 4px; }
        .sub { font-size: 12px; color: #555; margin: 0 0 16px; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; vertical-align: top; }
        th { background: #f0f0f0; }
        td.num, th.num { text-align: right; white-space: nowrap; }
        tfoot td { font-weight: bold; background: #f7f7f7; }
        @media print { body { margin: 0; } }
      </style></head>
      <body onload="window.focus();window.print();">
        <h1>🚕 Controle de Uber</h1>
        <p class="sub">${esc(periodo)} · ${linhas.length} corrida(s)</p>
        <table data-ordenavel>
          <thead>
            <tr>
              <th>Data</th><th>Requisitante</th><th>Solicitante</th><th>Setor</th>
              <th>Origem</th><th>Destino</th><th>Motivo</th><th class="num">Valor</th>
            </tr>
          </thead>
          <tbody>${corpo}</tbody>
          <tfoot>
            <tr><td colspan="7" class="num">Total</td><td class="num">${esc(fmtMoeda(total))}</td></tr>
          </tfoot>
        </table>
      </body></html>`;
    const w = window.open("", "_blank");
    if (!w) { avisar("Permita pop-ups para poder imprimir."); return; }
    w.document.write(html);
    w.document.close();
  }

  function uberRenderLista() {
    const box = document.getElementById("uberLista");
    if (!box) return;
    if (!state.filtradas.length) {
      box.innerHTML = `<p style="color:var(--text-muted);padding:18px 0;">Nenhuma corrida no filtro atual.</p>`;
      return;
    }
    box.innerHTML = state.filtradas.map((o) => {
      const data = (o.data || "").slice(0, 10).split("-").reverse().join("/");
      return `<div class="section-shell" style="padding:13px 15px;margin-bottom:9px;">
        <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:6px;">
          <b style="font-size:14px;color:var(--text-heading);">🚕 ${esc(o.setor_pessoa_requisitante)}</b>
          <span style="font-size:14px;font-weight:800;color:#22c55e;">${esc(fmtMoeda(o.valor))}</span>
          <span style="margin-left:auto;font-size:11.5px;color:var(--text-muted);">${data}</span>
        </div>
        <div style="font-size:13px;color:var(--text-secondary);line-height:1.5;">
          <b style="color:var(--text-heading);">${esc(o.origem)}</b> → <b style="color:var(--text-heading);">${esc(o.destino)}</b>
        </div>
        <div style="font-size:11.5px;color:var(--text-muted);margin-top:5px;">
          Solicitante: ${esc(o.solicitante)} · Setor: ${esc(o.setor_solicitante || "Transporte")}
        </div>
        ${o.motivo ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:5px;">Motivo: ${esc(o.motivo)}</div>` : ""}
        <div style="display:flex;align-items:center;gap:8px;margin-top:9px;">
          ${o.registrado_por ? `<span style="font-size:10.5px;color:var(--text-muted);">por ${esc(o.registrado_por)}</span>` : ""}
          <button type="button" class="btn-ghost btn-sm" style="margin-left:auto;" onclick="uberEditar(${o.id})">Editar</button>
          <button type="button" class="btn-ghost btn-sm" onclick="uberExcluir(${o.id})">Excluir</button>
        </div>
      </div>`;
    }).join("");
  }

  let iniciado = false;
  async function uberInit() {
    if (!iniciado) {
      iniciado = true;
      const hj = hoje();
      // Filtro padrao: ultimos 90 dias.
      const ini = new Date();
      ini.setDate(ini.getDate() - 90);
      const iEl = document.getElementById("uberFiltroInicio");
      const fEl = document.getElementById("uberFiltroFim");
      if (iEl && !iEl.value) iEl.value = ini.toLocaleDateString("en-CA");
      if (fEl && !fEl.value) fEl.value = hj;
    }
    await uberCarregar();
  }

  window.uberInit = uberInit;
  window.uberAbrirForm = uberAbrirForm;
  window.uberFecharForm = uberFecharForm;
  window.uberSalvar = uberSalvar;
  window.uberEditar = uberEditar;
  window.uberExcluir = uberExcluir;
  window.uberCarregar = uberCarregar;
  window.uberAplicarFiltros = uberAplicarFiltros;
  window.uberLimparFiltro = uberLimparFiltro;
  window.uberImprimir = uberImprimir;
})();
