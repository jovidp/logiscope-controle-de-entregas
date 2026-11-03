// ================================================================
// setores-nao-informados.js
// ----------------------------------------------------------------
// Modal para TRIAGEM das ocorrências sem setor responsável apontado
// (ocorrencia_responsavel vazio = aparece como "NÃO INFORMADO" nos
// gráficos). Permite, linha a linha:
//   - APONTAR de quem foi (dropdown com a lista canônica de setores);
//   - CORRIGIR (abre o formulário completo de edição);
//   - EXCLUIR.
//
// Arquivo autocontido (script clássico, escopo global). Reaproveita os
// globais já carregados: ocorrencias, RESPONSAVEIS_OCORRENCIA,
// obterResponsavelOcorrencia, API_URL, carregarHistorico, editarOcorrencia,
// escapar, formatarDataBR, formatarNomeLoja, obterRotaDaOcorrencia,
// alertar/confirmarSimples. Por isso é incluído DEPOIS dos script-*.
//
// PUT /ocorrencias/:id é merge parcial no server (campo ausente mantém o
// valor atual), então mandamos só { ocorrencia_responsavel }.
// ================================================================

let _setoresHouveMudanca = false;

// Ocorrências REAIS (teve_ocorrencia) e SEM responsável apontado.
function _setoresLista() {
  const base = Array.isArray(ocorrencias) ? ocorrencias : [];
  return base.filter((o) => {
    const real = o.teve_ocorrencia === true || !!o.tipo_problema;
    const semSetor = !obterResponsavelOcorrencia(o); // "" => sem setor
    return real && semSetor;
  });
}

function _setoresEsc(v) {
  return typeof escapar === "function"
    ? escapar(v)
    : String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
      );
}
function _setoresData(o) {
  const iso = String(o.data_ocorrencia || o.data || "").split("T")[0];
  return typeof formatarDataBR === "function" ? formatarDataBR(iso) : iso || "—";
}
function _setoresLoja(o) {
  const l = typeof formatarNomeLoja === "function" ? formatarNomeLoja(o.loja) : o.loja;
  return l || "—";
}
function _setoresRota(o) {
  if (typeof obterRotaDaOcorrencia === "function") return obterRotaDaOcorrencia(o) || "—";
  return o.rota || "—";
}
function _setoresDescricao(o) {
  const t = String(o.descricao || o.relato || o.problema_operacional_relato || "").trim();
  return t || "Sem detalhe informado";
}

// Cria (uma vez) a casca do modal e devolve os elementos.
function _setoresGarantirModal() {
  let overlay = document.getElementById("modalSetoresOverlay");
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "modalSetoresOverlay";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:10000;display:none;" +
    "align-items:flex-start;justify-content:center;padding:36px 14px;overflow:auto;";
  overlay.innerHTML = `
    <style>
      @keyframes setoresSpin { to { transform: rotate(360deg); } }
      .setor-spinner {
        display:inline-block;width:16px;height:16px;border:2px solid rgba(255,255,255,.25);
        border-top-color:var(--vermelho,#f87171);border-radius:50%;
        animation:setoresSpin .7s linear infinite;vertical-align:middle;
      }
      .setor-chip {
        background:transparent;color:var(--text-secondary,#cfd3da);border:1px solid var(--border,#444);
        border-radius:999px;padding:5px 11px;font-size:12px;font-weight:700;cursor:pointer;
        font-family:inherit;transition:background .12s,border-color .12s,color .12s;
      }
      .setor-chip:hover { border-color:var(--azul,#4ea1ff); }
      .setor-chip.on {
        background:var(--azul,#4ea1ff);color:#04243f;border-color:var(--azul,#4ea1ff);
      }
    </style>
    <div style="background:var(--bg-elevated,#1b1f27);border:1px solid var(--border,#333);
                border-radius:12px;max-width:1040px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.55);">
      <div style="position:sticky;top:0;background:var(--bg-elevated,#1b1f27);border-bottom:1px solid var(--border,#333);
                  border-radius:12px 12px 0 0;padding:16px 20px;display:flex;align-items:center;gap:12px;z-index:1;">
        <div style="flex:1;">
          <div style="font-size:15px;font-weight:800;color:var(--text-heading,#fff);">🏷️ Apontar setores não informados</div>
          <div id="modalSetoresContador" style="font-size:12px;color:var(--text-muted,#9aa);margin-top:2px;"></div>
        </div>
        <button type="button" onclick="fecharModalSetores()"
          style="background:transparent;border:1px solid var(--border,#444);color:var(--text-secondary,#ccc);
                 border-radius:8px;padding:6px 12px;font-size:13px;font-weight:700;cursor:pointer;">Fechar ✕</button>
      </div>
      <div id="modalSetoresLista" style="padding:14px 16px 20px;"></div>
    </div>`;
  document.body.appendChild(overlay);

  // Fecha clicando fora.
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) fecharModalSetores();
  });
  return overlay;
}

function _setoresLinhaHtml(o) {
  const chips = (typeof RESPONSAVEIS_OCORRENCIA !== "undefined" ? RESPONSAVEIS_OCORRENCIA : [])
    .map((s) => `<button type="button" class="setor-chip" data-setor="${_setoresEsc(s)}" onclick="setoresToggleChip(this)">${_setoresEsc(s)}</button>`)
    .join("");
  const desc = _setoresDescricao(o);
  const tipo = o.tipo_problema || o.problema_operacional_tipo || "";
  return `
    <div id="setorRow_${o.id}" data-id="${o.id}"
         style="border:1px solid var(--border,#333);border-radius:10px;padding:12px 14px;margin-bottom:10px;
                background:var(--bg-base,rgba(255,255,255,.02));transition:opacity .25s;">
      <div style="display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;font-size:12px;margin-bottom:8px;">
        <span style="font-weight:800;white-space:nowrap;">${_setoresEsc(_setoresData(o))}</span>
        <span style="color:var(--azul,#4ea1ff);white-space:nowrap;">🏬 ${_setoresEsc(_setoresLoja(o))}</span>
        <span style="color:var(--text-muted,#9aa);white-space:nowrap;">🛣️ ${_setoresEsc(_setoresRota(o))}</span>
        <span style="color:var(--text-muted,#9aa);white-space:nowrap;">🚚 ${_setoresEsc(o.motorista || "—")}</span>
        ${tipo ? `<span style="background:rgba(248,113,113,.12);color:var(--vermelho,#f87171);border:1px solid rgba(248,113,113,.3);
                   padding:2px 8px;border-radius:6px;font-weight:700;">${_setoresEsc(tipo)}</span>` : ""}
      </div>
      <div title="${_setoresEsc(desc)}"
           style="font-size:13px;color:var(--text-secondary,#cfd3da);margin-bottom:10px;line-height:1.4;">
        ${_setoresEsc(desc.length > 220 ? desc.slice(0, 220) + "…" : desc)}
      </div>
      <div style="font-size:11px;color:var(--text-muted,#9aa);margin-bottom:5px;text-transform:uppercase;letter-spacing:.5px;">
        De quem foi a culpa? (pode marcar mais de um setor)
      </div>
      <div id="setorChips_${o.id}" class="setor-chips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">
        ${chips}
      </div>
      <div id="setorAcoes_${o.id}" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
        <button type="button" onclick="setoresApontar(${o.id})"
          style="background:var(--verde,#34d399);color:#06281d;border:none;border-radius:8px;padding:8px 14px;
                 font-size:13px;font-weight:800;cursor:pointer;white-space:nowrap;">Apontar ✓</button>
        <button type="button" onclick="setoresEditar(${o.id})"
          style="background:transparent;color:var(--azul,#4ea1ff);border:1px solid var(--azul,#4ea1ff);border-radius:8px;
                 padding:8px 12px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;">Corrigir ✎</button>
        <button type="button" onclick="setoresExcluir(${o.id})"
          style="background:transparent;color:var(--vermelho,#f87171);border:1px solid var(--vermelho,#f87171);border-radius:8px;
                 padding:8px 12px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;">Mover p/ lixeira 🗑</button>
      </div>
      <div id="setorMsg_${o.id}" style="font-size:12px;margin-top:6px;min-height:0;"></div>
    </div>`;
}

function _setoresMsg(id, texto, cor) {
  const el = document.getElementById(`setorMsg_${id}`);
  if (!el) return;
  el.textContent = texto || "";
  el.style.color = cor || "var(--text-muted,#9aa)";
}

function _setoresRenderizar() {
  const lista = _setoresLista();
  const cont = document.getElementById("modalSetoresContador");
  const box = document.getElementById("modalSetoresLista");
  if (cont) {
    cont.textContent = lista.length
      ? `${lista.length} ocorrência${lista.length === 1 ? "" : "s"} sem setor — aponte, corrija ou exclua.`
      : "Tudo apontado.";
  }
  if (!box) return;
  if (!lista.length) {
    box.innerHTML = `<p style="color:var(--text-muted,#9aa);text-align:center;padding:28px 0;font-size:14px;">
        🎉 Nenhuma ocorrência sem setor. Tudo apontado!</p>`;
    return;
  }
  // Mais recentes primeiro.
  lista.sort((a, b) =>
    String(b.data_ocorrencia || b.data || "").localeCompare(String(a.data_ocorrencia || a.data || "")),
  );
  box.innerHTML = lista.map(_setoresLinhaHtml).join("");
}

function abrirModalSetoresNaoInformados() {
  if (typeof ocorrencias === "undefined" || !Array.isArray(ocorrencias)) {
    if (typeof alertar === "function") alertar("Os dados ainda estão carregando. Tente de novo em instantes.");
    return;
  }
  _setoresHouveMudanca = false;
  const overlay = _setoresGarantirModal();
  _setoresRenderizar();
  overlay.style.display = "flex";
}

function fecharModalSetores() {
  const overlay = document.getElementById("modalSetoresOverlay");
  if (overlay) overlay.style.display = "none";
  // Se algo mudou, recarrega para os gráficos/rankings refletirem.
  if (_setoresHouveMudanca && typeof carregarHistorico === "function") {
    _setoresHouveMudanca = false;
    carregarHistorico();
  }
  atualizarSinoSetores();
}

function _setoresRemoverLinha(id) {
  const row = document.getElementById(`setorRow_${id}`);
  if (!row) return;
  row.style.opacity = "0";
  setTimeout(() => {
    row.remove();
    // Atualiza só o contador; não re-renderiza tudo para não perder seleções em curso.
    const restantes = document.querySelectorAll("#modalSetoresLista [data-id]").length;
    const cont = document.getElementById("modalSetoresContador");
    if (cont) {
      cont.textContent = restantes
        ? `${restantes} ocorrência${restantes === 1 ? "" : "s"} sem setor — aponte, corrija ou exclua.`
        : "Tudo apontado.";
    }
    if (!restantes) {
      const box = document.getElementById("modalSetoresLista");
      if (box) {
        box.innerHTML = `<p style="color:var(--text-muted,#9aa);text-align:center;padding:28px 0;font-size:14px;">
            🎉 Tudo apontado! Feche para atualizar os gráficos.</p>`;
      }
    }
    atualizarSinoSetores();
  }, 220);
}

// Liga/desliga um chip de setor (permite escolher vários).
function setoresToggleChip(btn) {
  btn.classList.toggle("on");
  const row = btn.closest("[data-id]");
  if (row) _setoresMsg(row.getAttribute("data-id"), "", "");
}

async function setoresApontar(id) {
  const marcados = document.querySelectorAll(`#setorChips_${id} .setor-chip.on`);
  const setores = Array.from(marcados).map((c) => c.dataset.setor).filter(Boolean);
  if (!setores.length) {
    _setoresMsg(id, "Marque pelo menos um setor antes de apontar.", "var(--vermelho,#f87171)");
    return;
  }
  // Multivalor no mesmo formato do formulário: "SETOR A, SETOR B".
  const valor = setores.join(", ");
  _setoresMsg(id, "Salvando…", "var(--text-muted,#9aa)");
  try {
    const res = await fetch(`${API_URL}/ocorrencias/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ocorrencia_responsavel: valor }),
    });
    if (!res.ok) {
      let m = `Erro HTTP ${res.status}`;
      try { const e = await res.json(); m = e.detalhe || e.error || m; } catch (_) {}
      _setoresMsg(id, "❌ Erro ao apontar: " + m, "var(--vermelho,#f87171)");
      return;
    }
    // Atualiza a cópia em memória para os gráficos baterem ao fechar.
    const o = ocorrencias.find((x) => String(x.id) === String(id));
    if (o) { o.ocorrencia_responsavel = valor; o.ocorrenciaResponsavel = valor; }
    _setoresHouveMudanca = true;
    _setoresRemoverLinha(id);
  } catch (err) {
    console.error(err);
    _setoresMsg(id, "❌ Não foi possível conectar ao servidor.", "var(--vermelho,#f87171)");
  }
}

function setoresEditar(id) {
  // "Corrigir" abre o modal enxuto (tipo + responsável + relato) POR CIMA do
  // sino, em vez de jogar o usuário no formulário completo da aba "entregas".
  // O sino fica aberto atrás; corrSalvar() avisa via setoresNotificarCorrecao().
  if (typeof abrirModalCorrigir === "function") {
    abrirModalCorrigir(id);
  } else if (typeof editarOcorrencia === "function") {
    // Fallback: comportamento antigo (form completo na aba entregas).
    fecharModalSetores();
    if (typeof irParaAba === "function") irParaAba("entregas");
    editarOcorrencia(id);
    setTimeout(() => document.getElementById("form")?.scrollIntoView({ behavior: "smooth", block: "start" }), 120);
  } else if (typeof alertar === "function") {
    alertar("Edição indisponível nesta tela.");
  }
}

// Chamado pelo modal de correção após salvar: marca mudança (recarrega os
// gráficos ao fechar o sino), re-renderiza a lista se estiver aberta e
// atualiza o badge.
function setoresNotificarCorrecao() {
  _setoresHouveMudanca = true;
  const overlay = document.getElementById("modalSetoresOverlay");
  if (overlay && overlay.style.display !== "none") _setoresRenderizar();
  atualizarSinoSetores();
}

// Confirmação INLINE dentro do próprio modal (o diálogo global #modalConfirm
// fica em z-index 1001, atrás deste modal — por isso não dá para usá-lo aqui).
function setoresExcluir(id) {
  const area = document.getElementById(`setorAcoes_${id}`);
  if (!area) return;
  if (area.dataset.htmlOriginal === undefined) area.dataset.htmlOriginal = area.innerHTML;
  area.innerHTML = `
    <span style="color:var(--vermelho,#f87171);font-weight:800;font-size:13px;">Mover para a lixeira? (dá pra recuperar depois)</span>
    <button type="button" onclick="setoresConfirmarExclusao(${id})"
      style="background:var(--vermelho,#f87171);color:#2b0a0a;border:none;border-radius:8px;padding:8px 14px;
             font-size:13px;font-weight:800;cursor:pointer;">Sim, mover</button>
    <button type="button" onclick="setoresCancelarExclusao(${id})"
      style="background:transparent;color:var(--text-secondary,#ccc);border:1px solid var(--border,#444);
             border-radius:8px;padding:8px 12px;font-size:13px;font-weight:700;cursor:pointer;">Cancelar</button>`;
}

function setoresCancelarExclusao(id) {
  const area = document.getElementById(`setorAcoes_${id}`);
  if (area && area.dataset.htmlOriginal !== undefined) {
    area.innerHTML = area.dataset.htmlOriginal;
    delete area.dataset.htmlOriginal;
  }
}

async function setoresConfirmarExclusao(id) {
  const area = document.getElementById(`setorAcoes_${id}`);
  if (area) {
    area.innerHTML = `<span class="setor-spinner"></span>
      <span style="color:var(--text-muted,#9aa);font-weight:700;font-size:13px;">Movendo para a lixeira…</span>`;
  }
  // Loading de no mínimo 3s: espera o fetch E o timer (o que demorar mais).
  const espera = new Promise((r) => setTimeout(r, 3000));
  try {
    const [res] = await Promise.all([
      fetch(`${API_URL}/ocorrencias/${id}`, { method: "DELETE" }),
      espera,
    ]);
    if (!res.ok && res.status !== 404) {
      if (area && area.dataset.htmlOriginal !== undefined) {
        area.innerHTML = area.dataset.htmlOriginal;
        delete area.dataset.htmlOriginal;
      }
      _setoresMsg(id, "❌ Erro ao excluir o registro.", "var(--vermelho,#f87171)");
      return;
    }
    const i = ocorrencias.findIndex((x) => String(x.id) === String(id));
    if (i >= 0) ocorrencias.splice(i, 1);
    _setoresHouveMudanca = true;
    _setoresRemoverLinha(id);
  } catch (err) {
    console.error(err);
    await espera;
    if (area && area.dataset.htmlOriginal !== undefined) {
      area.innerHTML = area.dataset.htmlOriginal;
      delete area.dataset.htmlOriginal;
    }
    _setoresMsg(id, "❌ Não foi possível conectar ao servidor.", "var(--vermelho,#f87171)");
  }
}

// ----------------------------------------------------------------
// SINO (🔔) no topo: badge com a contagem de ocorrências sem setor.
// ----------------------------------------------------------------
function atualizarSinoSetores() {
  const badge = document.getElementById("sinoSetoresBadge");
  if (!badge) return;
  let n = 0;
  try { n = _setoresLista().length; } catch (_) { n = 0; }
  if (n > 0) {
    badge.textContent = n > 99 ? "99+" : String(n);
    badge.style.display = "inline-flex";
  } else {
    badge.style.display = "none";
  }
}

// Recalcula o badge sozinho: já no load e a cada 5s (os dados chegam de forma
// assíncrona via carregarHistorico; assim o sino reflete sem precisar acoplar).
document.addEventListener("DOMContentLoaded", () => setTimeout(atualizarSinoSetores, 800));
setInterval(() => { if (!document.hidden) atualizarSinoSetores(); }, 30000);

// Expõe no escopo global (chamadas via onclick inline).
window.abrirModalSetoresNaoInformados = abrirModalSetoresNaoInformados;
window.fecharModalSetores = fecharModalSetores;
window.setoresApontar = setoresApontar;
window.setoresToggleChip = setoresToggleChip;
window.setoresEditar = setoresEditar;
window.setoresExcluir = setoresExcluir;
window.setoresConfirmarExclusao = setoresConfirmarExclusao;
window.setoresCancelarExclusao = setoresCancelarExclusao;
window.setoresNotificarCorrecao = setoresNotificarCorrecao;
window.atualizarSinoSetores = atualizarSinoSetores;
