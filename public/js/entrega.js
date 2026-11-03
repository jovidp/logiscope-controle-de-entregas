// ================================================================
// ENTREGAS DO DIA
// Cole este bloco no FINAL do script.js
// ================================================================

const LS_ED = "entregasDia";

// ── Abrir / fechar / limpar ──────────────────────────────────────
function abrirFormEntregaDia() {
  const f = document.getElementById("formEntregaDia");
  if (!f) return;
  f.classList.remove("hidden");
  const edData = document.getElementById("edData");
  if (edData && !edData.value) edData.value = hojeISO();
  setTimeout(() => f.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
}

function fecharFormEntregaDia() {
  document.getElementById("formEntregaDia")?.classList.add("hidden");
}

function limparFormEntregaDia() {
  const edData = document.getElementById("edData");
  if (edData) edData.value = hojeISO();
  ["edRota", "edMotorista", "edPlaca", "edObs"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  limparGrupoMulti("edAjudantes");
}

// ── Salvar ───────────────────────────────────────────────────────
async function salvarEntregaDia() {
  const data      = document.getElementById("edData")?.value || "";
  const rota      = document.getElementById("edRota")?.value || "";
  const motorista = document.getElementById("edMotorista")?.value || "";
  const placa     = document.getElementById("edPlaca")?.value || "";
  const obs       = document.getElementById("edObs")?.value?.trim() || "";

  if (!data || !rota || !motorista || !placa) {
    alertar("Preencha Data, Rota, Motorista e Veículo.");
    return;
  }

  const ajudantes = Array.from(
    document.querySelectorAll('input[data-multi-group="edAjudantes"]:checked')
  ).map(c => c.value).join(", ");

  const reg = { id: Date.now(), data, rota, motorista, placa, ajudantes, obs };

  const lista = lerStorage(LS_ED);
  lista.unshift(reg);
  if (!(await salvarStorage(LS_ED, lista))) return;

  limparFormEntregaDia();
  fecharFormEntregaDia();
  renderizarEntregasDia();
  alertar("✅ Entrega do dia salva!");
}

// ── Excluir ──────────────────────────────────────────────────────
function excluirEntregaDia(id) {
  confirmarSimples("Deseja excluir este registro?", async () => {
    if (!(await salvarStorage(LS_ED, lerStorage(LS_ED).filter(r => String(r.id) !== String(id))))) return;
    renderizarEntregasDia();
  });
}

// ── Link direto com o form de Nova Ocorrência ────────────────────
// Ao clicar em "Registrar Ocorrência" no card, navega para a aba
// Entregas e preenche automaticamente: data, motorista, placa e ajudantes.
function abrirOcorrenciaDeEntregaDia(id) {
  const lista = lerStorage(LS_ED);
  const reg   = lista.find(r => String(r.id) === String(id));
  if (!reg) return;

  // 1) Vai para aba Entregas e abre o formulário
  irParaAba("entregas");

  // 2) Aguarda o DOM estar visível para preencher os campos
  setTimeout(() => {
    abrirForm(); // abre o form de nova ocorrência

    setTimeout(() => {
      // Data
      preencherCampo("dataOcorrencia", reg.data);

      // Motorista
      preencherCampo("motorista", reg.motorista);

      // Placa
      preencherCampo("placa", reg.placa);

      // Ajudantes — marca os checkboxes correspondentes
      if (reg.ajudantes) {
        marcarGrupoMulti("ajudantes", reg.ajudantes);
      }

      // Dispara o check automático de checklist + link saída fábrica
      if (typeof atualizarBlocoStatusChecklist === "function")
        atualizarBlocoStatusChecklist();
      if (typeof preencherOcorrenciaComSaidaDoDia === "function")
        preencherOcorrenciaComSaidaDoDia();

      // Scroll suave até o formulário
      document.getElementById("form")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 150);
  }, 120);
}

// ── Renderizar lista de cards ────────────────────────────────────
function renderizarEntregasDia() {
  const container = document.getElementById("listaEntregasDia");
  const badge     = document.getElementById("badgeEntregasDia");
  if (!container) return;

  const filtroData = document.getElementById("entregasDiaFiltroData")?.value || hojeISO();
  const todas      = lerStorage(LS_ED);
  const lista      = filtroData
    ? todas.filter(r => String(r.data || "").split("T")[0] === filtroData)
    : todas;

  // badge
  if (badge) {
    badge.style.display = lista.length ? "inline-flex" : "none";
    badge.textContent   = String(lista.length);
  }

  if (lista.length === 0) {
    container.innerHTML = `
      <div style="
        text-align:center;padding:32px 20px;
        background:var(--bg-elevated);border:1px dashed var(--border);
        border-radius:14px;color:var(--text-muted);font-size:13px;">
        📭 Nenhuma entrega registrada para
        <b style="color:var(--text-heading);">${formatarDataBR(filtroData)}</b>
      </div>`;
    return;
  }

  container.innerHTML = lista.map(reg => {
    const ajuLista = reg.ajudantes
      ? reg.ajudantes.split(",").map(a => a.trim()).filter(Boolean)
      : [];

    const ajuHtml = ajuLista.length
      ? ajuLista.map(a => `
          <span style="
            display:inline-flex;align-items:center;gap:4px;
            background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.25);
            color:var(--verde);border-radius:6px;padding:2px 8px;
            font-size:10px;font-weight:700;">
            👤 ${escapar(a)}
          </span>`).join(" ")
      : `<span style="font-size:12px;color:var(--text-muted);">Sem ajudantes</span>`;

    return `
      <div style="
        display:grid;
        grid-template-columns:auto 1fr auto;
        gap:16px;align-items:center;
        padding:16px 20px;margin-bottom:10px;
        background:var(--bg-elevated);
        border:1px solid var(--border);border-radius:14px;
        border-left:5px solid var(--azul);
        transition:border-color .15s;">

        <!-- Ícone rota -->
        <div style="
          width:44px;height:44px;border-radius:12px;flex-shrink:0;
          background:rgba(56,189,248,.12);border:1px solid rgba(56,189,248,.25);
          display:flex;align-items:center;justify-content:center;font-size:1.3rem;">
          🚚
        </div>

        <!-- Conteúdo -->
        <div style="min-width:0;">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px;">
            <span style="
              font-size:.7rem;font-weight:800;text-transform:uppercase;letter-spacing:.8px;
              color:var(--azul);background:rgba(56,189,248,.1);
              padding:3px 9px;border-radius:6px;border:1px solid rgba(56,189,248,.2);">
              ${escapar(reg.rota)}
            </span>
            <span style="font-size:11px;color:var(--text-muted);font-weight:600;">
              📅 ${formatarDataBR(reg.data)}
            </span>
          </div>

          <div style="display:flex;gap:18px;flex-wrap:wrap;margin-bottom:8px;">
            <div>
              <div style="font-size:10px;font-weight:700;text-transform:uppercase;
                          letter-spacing:.6px;color:var(--text-muted);margin-bottom:2px;">
                Motorista
              </div>
              <div style="font-size:.85rem;font-weight:700;color:var(--text-heading);">
                🧑‍✈️ ${escapar(reg.motorista)}
              </div>
            </div>
            <div>
              <div style="font-size:10px;font-weight:700;text-transform:uppercase;
                          letter-spacing:.6px;color:var(--text-muted);margin-bottom:2px;">
                Veículo
              </div>
              <div style="font-size:.85rem;font-weight:700;color:var(--text-heading);">
                🔢 ${escapar(reg.placa)}
              </div>
            </div>
          </div>

          <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:${reg.obs ? '6px' : '0'};">
            ${ajuHtml}
          </div>

          ${reg.obs ? `
            <div style="
              font-size:11px;color:var(--text-muted);
              background:rgba(255,255,255,.03);padding:5px 10px;
              border-radius:6px;border:1px solid var(--border);margin-top:2px;">
              📝 ${escapar(reg.obs)}
            </div>` : ""}
        </div>

        <!-- Ações -->
        <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0;">
          <!-- BOTÃO PRINCIPAL: link direto para nova ocorrência -->
          <button type="button"
            onclick="abrirOcorrenciaDeEntregaDia(${reg.id})"
            style="
              display:flex;align-items:center;gap:6px;
              padding:8px 14px;border-radius:10px;
              background:rgba(52,211,153,.15);
              border:1px solid rgba(52,211,153,.35);
              color:var(--verde);font-weight:800;font-size:12px;
              cursor:pointer;white-space:nowrap;font-family:inherit;
              transition:background .15s;"
            onmouseover="this.style.background='rgba(52,211,153,.28)'"
            onmouseout="this.style.background='rgba(52,211,153,.15)'">
            ➕ Registrar Ocorrência
          </button>

          <button type="button"
            onclick="excluirEntregaDia(${reg.id})"
            style="
              display:flex;align-items:center;justify-content:center;gap:6px;
              padding:6px 12px;border-radius:9px;
              background:rgba(248,113,113,.1);
              border:1px solid rgba(248,113,113,.2);
              color:#f87171;font-size:11px;font-weight:700;
              cursor:pointer;font-family:inherit;
              transition:background .15s;"
            onmouseover="this.style.background='rgba(248,113,113,.22)'"
            onmouseout="this.style.background='rgba(248,113,113,.1)'">
            🗑️ Excluir
          </button>
        </div>
      </div>`;
  }).join("");
}

// ── Inicialização ────────────────────────────────────────────────
// Roda ao carregar a página e também atualiza quando a aba Dashboard é aberta.
document.addEventListener("DOMContentLoaded", () => {
  // preenche o filtro com hoje na primeira carga
  const filtroInput = document.getElementById("entregasDiaFiltroData");
  if (filtroInput && !filtroInput.value) filtroInput.value = hojeISO();
  renderizarEntregasDia();
});

// Patch: garante que renderizarEntregasDia é chamado ao abrir o dashboard
const _irParaAbaOriginal = window.irParaAba;
window.irParaAba = function(nome) {
  _irParaAbaOriginal(nome);
  if (nome === "dashboard") renderizarEntregasDia();
};
