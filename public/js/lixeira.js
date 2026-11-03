// ================================================================
// lixeira.js
// ----------------------------------------------------------------
// LIXEIRA das ocorrências. O botão "Excluir" do app NÃO apaga mais do
// banco: ele apenas marca a ocorrência como excluída (coluna excluida_em
// no back). Aqui o usuário vê tudo que está na lixeira e pode:
//   - RESTAURAR (volta a ocorrência para as listas e gráficos);
//   - EXCLUIR DEFINITIVAMENTE (aí sim remove fisicamente do banco).
//
// Diferente dos sinos de setores/tipos, este modal NÃO usa o array global
// `ocorrencias` (os itens da lixeira não estão lá) — busca os próprios dados
// em GET /ocorrencias-lixeira. Arquivo autocontido (escopo global), incluído
// depois dos script-*. Reaproveita: API_URL, escapar, formatarDataBR,
// formatarNomeLoja, carregarHistorico.
// ================================================================

let _lixeiraItens = [];
let _lixeiraHouveRestauracao = false;

function _lixEsc(v) {
  return typeof escapar === "function"
    ? escapar(v)
    : String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
      );
}
function _lixData(o) {
  const iso = String(o.data_ocorrencia || o.data || "").split("T")[0];
  return typeof formatarDataBR === "function" ? formatarDataBR(iso) : iso || "—";
}
function _lixLoja(o) {
  const l = typeof formatarNomeLoja === "function" ? formatarNomeLoja(o.loja) : o.loja;
  return l || "—";
}
function _lixDescricao(o) {
  const t = String(o.descricao || o.relato || o.problema_operacional_relato || "").trim();
  return t || "Sem detalhe informado";
}
// Quando foi para a lixeira (data + hora).
function _lixExcluidaEm(o) {
  const raw = String(o.excluida_em || "").replace("T", " ").split(".")[0];
  if (!raw) return "";
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ ]?(\d{2}:\d{2})?/);
  if (!m) return raw;
  return `${m[3]}/${m[2]}/${m[1]}${m[4] ? " " + m[4] : ""}`;
}

// Cria (uma vez) a casca do modal.
function _lixGarantirModal() {
  let overlay = document.getElementById("modalLixeiraOverlay");
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "modalLixeiraOverlay";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:10000;display:none;" +
    "align-items:flex-start;justify-content:center;padding:36px 14px;overflow:auto;";
  overlay.innerHTML = `
    <style>
      @keyframes lixSpin { to { transform: rotate(360deg); } }
      .lix-spinner {
        display:inline-block;width:16px;height:16px;border:2px solid rgba(255,255,255,.25);
        border-top-color:var(--verde,#34d399);border-radius:50%;
        animation:lixSpin .7s linear infinite;vertical-align:middle;
      }
    </style>
    <div style="background:var(--bg-elevated,#1b1f27);border:1px solid var(--border,#333);
                border-radius:12px;max-width:1040px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.55);">
      <div style="position:sticky;top:0;background:var(--bg-elevated,#1b1f27);border-bottom:1px solid var(--border,#333);
                  border-radius:12px 12px 0 0;padding:16px 20px;display:flex;align-items:center;gap:12px;z-index:1;">
        <div style="flex:1;">
          <div style="font-size:15px;font-weight:800;color:var(--text-heading,#fff);">🗑️ Lixeira de ocorrências</div>
          <div id="modalLixeiraContador" style="font-size:12px;color:var(--text-muted,#9aa);margin-top:2px;"></div>
        </div>
        <button type="button" onclick="fecharModalLixeira()"
          style="background:transparent;border:1px solid var(--border,#444);color:var(--text-secondary,#ccc);
                 border-radius:8px;padding:6px 12px;font-size:13px;font-weight:700;cursor:pointer;">Fechar ✕</button>
      </div>
      <div id="modalLixeiraLista" style="padding:14px 16px 20px;"></div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) fecharModalLixeira();
  });
  return overlay;
}

function _lixLinhaHtml(o) {
  const desc = _lixDescricao(o);
  const tipo = o.tipo_problema || o.problema_operacional_tipo || "";
  const setor = o.ocorrencia_responsavel || "";
  const quando = _lixExcluidaEm(o);
  return `
    <div id="lixRow_${o.id}" data-id="${o.id}"
         style="border:1px solid var(--border,#333);border-radius:10px;padding:12px 14px;margin-bottom:10px;
                background:var(--bg-base,rgba(255,255,255,.02));transition:opacity .25s;">
      <div style="display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;font-size:12px;margin-bottom:8px;">
        <span style="font-weight:800;white-space:nowrap;">${_lixEsc(_lixData(o))}</span>
        <span style="color:var(--azul,#4ea1ff);white-space:nowrap;">🏬 ${_lixEsc(_lixLoja(o))}</span>
        <span style="color:var(--text-muted,#9aa);white-space:nowrap;">🚚 ${_lixEsc(o.motorista || "—")}</span>
        ${tipo ? `<span style="background:rgba(248,113,113,.12);color:var(--vermelho,#f87171);border:1px solid rgba(248,113,113,.3);
                   padding:2px 8px;border-radius:6px;font-weight:700;">${_lixEsc(tipo)}</span>` : ""}
        ${setor ? `<span style="color:var(--text-muted,#9aa);white-space:nowrap;">🏷️ ${_lixEsc(setor)}</span>` : ""}
      </div>
      <div title="${_lixEsc(desc)}"
           style="font-size:13px;color:var(--text-secondary,#cfd3da);margin-bottom:10px;line-height:1.4;">
        ${_lixEsc(desc.length > 220 ? desc.slice(0, 220) + "…" : desc)}
      </div>
      ${quando ? `<div style="font-size:11px;color:var(--text-muted,#9aa);margin-bottom:8px;">
        🗑️ Na lixeira desde ${_lixEsc(quando)}</div>` : ""}
      <div id="lixAcoes_${o.id}" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
        <button type="button" onclick="lixeiraRestaurar(${o.id})"
          style="background:var(--verde,#34d399);color:#06281d;border:none;border-radius:8px;padding:8px 14px;
                 font-size:13px;font-weight:800;cursor:pointer;white-space:nowrap;">Restaurar ↩</button>
        <button type="button" onclick="lixeiraExcluirDefinitivo(${o.id})"
          style="background:transparent;color:var(--vermelho,#f87171);border:1px solid var(--vermelho,#f87171);border-radius:8px;
                 padding:8px 12px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;">Excluir definitivamente 🗑</button>
      </div>
      <div id="lixMsg_${o.id}" style="font-size:12px;margin-top:6px;min-height:0;"></div>
    </div>`;
}

function _lixMsg(id, texto, cor) {
  const el = document.getElementById(`lixMsg_${id}`);
  if (!el) return;
  el.textContent = texto || "";
  el.style.color = cor || "var(--text-muted,#9aa)";
}

function _lixAtualizarContador() {
  const restantes = document.querySelectorAll("#modalLixeiraLista [data-id]").length;
  const cont = document.getElementById("modalLixeiraContador");
  if (cont) {
    cont.textContent = restantes
      ? `${restantes} ocorrência${restantes === 1 ? "" : "s"} na lixeira — restaure ou exclua de vez.`
      : "Lixeira vazia.";
  }
  if (!restantes) {
    const box = document.getElementById("modalLixeiraLista");
    if (box) {
      box.innerHTML = `<p style="color:var(--text-muted,#9aa);text-align:center;padding:28px 0;font-size:14px;">
          🧹 A lixeira está vazia.</p>`;
    }
  }
}

function _lixRenderizar() {
  const box = document.getElementById("modalLixeiraLista");
  const cont = document.getElementById("modalLixeiraContador");
  if (cont) {
    cont.textContent = _lixeiraItens.length
      ? `${_lixeiraItens.length} ocorrência${_lixeiraItens.length === 1 ? "" : "s"} na lixeira — restaure ou exclua de vez.`
      : "Lixeira vazia.";
  }
  if (!box) return;
  if (!_lixeiraItens.length) {
    box.innerHTML = `<p style="color:var(--text-muted,#9aa);text-align:center;padding:28px 0;font-size:14px;">
        🧹 A lixeira está vazia.</p>`;
    return;
  }
  box.innerHTML = _lixeiraItens.map(_lixLinhaHtml).join("");
}

function _lixRemoverLinha(id) {
  const row = document.getElementById(`lixRow_${id}`);
  if (!row) {
    _lixAtualizarContador();
    return;
  }
  row.style.opacity = "0";
  setTimeout(() => {
    row.remove();
    _lixeiraItens = _lixeiraItens.filter((o) => String(o.id) !== String(id));
    _lixAtualizarContador();
    atualizarSinoLixeira();
  }, 220);
}

async function abrirModalLixeira() {
  const overlay = _lixGarantirModal();
  const box = document.getElementById("modalLixeiraLista");
  if (box) {
    box.innerHTML = `<p style="color:var(--text-muted,#9aa);text-align:center;padding:28px 0;font-size:14px;">
        <span class="lix-spinner"></span> Carregando a lixeira…</p>`;
  }
  overlay.style.display = "flex";
  try {
    const res = await fetch(`${API_URL}/ocorrencias-lixeira`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _lixeiraItens = await res.json();
    if (!Array.isArray(_lixeiraItens)) _lixeiraItens = [];
  } catch (err) {
    console.error("Erro ao carregar a lixeira:", err);
    if (box) {
      box.innerHTML = `<p style="color:var(--vermelho,#f87171);text-align:center;padding:28px 0;font-size:14px;">
          ❌ Não foi possível carregar a lixeira.</p>`;
    }
    return;
  }
  _lixRenderizar();
}

function fecharModalLixeira() {
  const overlay = document.getElementById("modalLixeiraOverlay");
  if (overlay) overlay.style.display = "none";
  // Se algo foi restaurado, recarrega para os gráficos/listas refletirem.
  if (_lixeiraHouveRestauracao && typeof carregarHistorico === "function") {
    _lixeiraHouveRestauracao = false;
    carregarHistorico();
  }
}

async function lixeiraRestaurar(id) {
  const area = document.getElementById(`lixAcoes_${id}`);
  if (area) {
    area.innerHTML = `<span class="lix-spinner"></span>
      <span style="color:var(--text-muted,#9aa);font-weight:700;font-size:13px;">Restaurando…</span>`;
  }
  try {
    const res = await fetch(`${API_URL}/ocorrencias/${id}/restaurar`, { method: "POST" });
    if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
    _lixeiraHouveRestauracao = true;
    _lixRemoverLinha(id);
  } catch (err) {
    console.error(err);
    _lixMsg(id, "❌ Não foi possível restaurar.", "var(--vermelho,#f87171)");
  }
}

// Confirmação INLINE (o diálogo global fica atrás deste modal por z-index).
function lixeiraExcluirDefinitivo(id) {
  const area = document.getElementById(`lixAcoes_${id}`);
  if (!area) return;
  if (area.dataset.htmlOriginal === undefined) area.dataset.htmlOriginal = area.innerHTML;
  area.innerHTML = `
    <span style="color:var(--vermelho,#f87171);font-weight:800;font-size:13px;">Apagar de vez? Não dá pra recuperar.</span>
    <button type="button" onclick="lixeiraConfirmarDefinitivo(${id})"
      style="background:var(--vermelho,#f87171);color:#2b0a0a;border:none;border-radius:8px;padding:8px 14px;
             font-size:13px;font-weight:800;cursor:pointer;">Sim, apagar de vez</button>
    <button type="button" onclick="lixeiraCancelarDefinitivo(${id})"
      style="background:transparent;color:var(--text-secondary,#ccc);border:1px solid var(--border,#444);
             border-radius:8px;padding:8px 12px;font-size:13px;font-weight:700;cursor:pointer;">Cancelar</button>`;
}

function lixeiraCancelarDefinitivo(id) {
  const area = document.getElementById(`lixAcoes_${id}`);
  if (area && area.dataset.htmlOriginal !== undefined) {
    area.innerHTML = area.dataset.htmlOriginal;
    delete area.dataset.htmlOriginal;
  }
}

async function lixeiraConfirmarDefinitivo(id) {
  const area = document.getElementById(`lixAcoes_${id}`);
  if (area) {
    area.innerHTML = `<span class="lix-spinner"></span>
      <span style="color:var(--text-muted,#9aa);font-weight:700;font-size:13px;">Excluindo…</span>`;
  }
  try {
    const res = await fetch(`${API_URL}/ocorrencias/${id}/permanente`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
    _lixRemoverLinha(id);
  } catch (err) {
    console.error(err);
    if (area && area.dataset.htmlOriginal !== undefined) {
      area.innerHTML = area.dataset.htmlOriginal;
      delete area.dataset.htmlOriginal;
    }
    _lixMsg(id, "❌ Não foi possível excluir.", "var(--vermelho,#f87171)");
  }
}

// ----------------------------------------------------------------
// Botão (🗑️) no topo: badge com a contagem de itens na lixeira.
// Busca leve e periódica em /ocorrencias-lixeira.
// ----------------------------------------------------------------
async function atualizarSinoLixeira() {
  const badge = document.getElementById("sinoLixeiraBadge");
  if (!badge) return;
  let n = 0;
  try {
    const res = await fetch(`${API_URL}/ocorrencias-lixeira`);
    if (res.ok) {
      const arr = await res.json();
      n = Array.isArray(arr) ? arr.length : 0;
    }
  } catch (_) {
    return; // sem rede: não mexe no badge
  }
  if (n > 0) {
    badge.textContent = n > 99 ? "99+" : String(n);
    badge.style.display = "inline-flex";
  } else {
    badge.style.display = "none";
  }
}

document.addEventListener("DOMContentLoaded", () => setTimeout(atualizarSinoLixeira, 1200));
setInterval(() => { if (!document.hidden) atualizarSinoLixeira(); }, 30000);

// Expõe no escopo global (chamadas via onclick inline).
window.abrirModalLixeira = abrirModalLixeira;
window.fecharModalLixeira = fecharModalLixeira;
window.lixeiraRestaurar = lixeiraRestaurar;
window.lixeiraExcluirDefinitivo = lixeiraExcluirDefinitivo;
window.lixeiraConfirmarDefinitivo = lixeiraConfirmarDefinitivo;
window.lixeiraCancelarDefinitivo = lixeiraCancelarDefinitivo;
window.atualizarSinoLixeira = atualizarSinoLixeira;
