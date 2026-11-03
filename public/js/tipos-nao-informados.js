// ================================================================
// tipos-nao-informados.js
// ----------------------------------------------------------------
// Modal para TRIAGEM das ocorrências REAIS sem TIPO de ocorrência
// apontado (tipo_problema vazio = aparece como "NÃO INFORMADO" nos
// gráficos de tipos). Gêmeo de setores-nao-informados.js, mas atua
// no campo tipo_problema em vez de ocorrencia_responsavel.
// Permite, linha a linha:
//   - APONTAR o(s) tipo(s) (chips com a lista canônica do formulário);
//   - CORRIGIR (abre o formulário completo de edição);
//   - EXCLUIR.
//
// Arquivo autocontido (script clássico, escopo global). Reaproveita os
// globais já carregados: ocorrencias, API_URL, carregarHistorico,
// editarOcorrencia, irParaAba, escapar, formatarDataBR, formatarNomeLoja,
// obterRotaDaOcorrencia, obterResponsavelOcorrencia, alertar. Por isso é
// incluído DEPOIS dos script-*.
//
// PUT /ocorrencias/:id é merge parcial no server (campo ausente mantém o
// valor atual e teve_ocorrencia é recalculado a partir de tipo_problema),
// então mandamos só { tipo_problema }.
// ================================================================

let _tiposHouveMudanca = false;

// Lista canônica de tipos: lida do próprio formulário (checkboxes do
// multi-grupo "tipoOcorrencia") para nunca sair de sincronia; cai no
// fallback abaixo se o formulário ainda não estiver no DOM.
const TIPOS_OCORRENCIA_FALLBACK = [
  "Atraso",
  "Atraso do responsável",
  "Caixa não bipada",
  "Mercadoria a mais",
  "Mercadoria a menos",
  "Divergência de peça",
  "Divergência com volume",
  "Nota fiscal não enviada",
  "Nota fiscal incorreta",
  "Nota fiscal divergente do físico",
  "Romaneio não enviado",
  "Romaneio divergente do físico",
  "Espelho não enviado",
  "Espelho divergente do físico",
  "Loja fechada",
  "Responsável ausente",
  "Conferência não realizada pela loja",
  "Demora na conferência",
  "Dificuldade de acesso à loja",
  "Erro de separação",
  "Erro de expedição",
  "Erro de conferência no almoxarifado",
  "Material não localizado",
  "Material enviado sem conferência",
  "Divergência com almoxarifado",
  "Problema com o motorista",
  "Problema com ajudante",
  "Problema com sacola",
  "Problema com folder",
  "Problema de comunicação",
  "Almoxerifado",
  "Outros",
];

function _tiposCanonicos() {
  const doForm = Array.from(
    document.querySelectorAll('input[type="checkbox"][data-multi-group="tipoOcorrencia"]'),
  )
    .map((c) => String(c.value || "").trim())
    .filter(Boolean);
  return doForm.length ? doForm : TIPOS_OCORRENCIA_FALLBACK;
}

// Tipo já apontado da ocorrência (string crua, multivalor com vírgula).
function _tiposDe(o) {
  return String(o.tipo_problema ?? o.tipoOcorrencia ?? "").trim();
}

// Ocorrências REAIS (teve_ocorrencia) e SEM tipo apontado.
function _tiposLista() {
  const base = Array.isArray(ocorrencias) ? ocorrencias : [];
  return base.filter((o) => o.teve_ocorrencia === true && !_tiposDe(o));
}

function _tiposEsc(v) {
  return typeof escapar === "function"
    ? escapar(v)
    : String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
      );
}
function _tiposData(o) {
  const iso = String(o.data_ocorrencia || o.data || "").split("T")[0];
  return typeof formatarDataBR === "function" ? formatarDataBR(iso) : iso || "—";
}
function _tiposLoja(o) {
  const l = typeof formatarNomeLoja === "function" ? formatarNomeLoja(o.loja) : o.loja;
  return l || "—";
}
function _tiposRota(o) {
  if (typeof obterRotaDaOcorrencia === "function") return obterRotaDaOcorrencia(o) || "—";
  return o.rota || "—";
}
function _tiposDescricao(o) {
  const t = String(o.descricao || o.relato || o.problema_operacional_relato || "").trim();
  return t || "Sem detalhe informado";
}
function _tiposResponsavel(o) {
  if (typeof obterResponsavelOcorrencia === "function") {
    return obterResponsavelOcorrencia(o) || "";
  }
  return String(o.ocorrencia_responsavel || "").trim();
}

// Cria (uma vez) a casca do modal e devolve os elementos.
function _tiposGarantirModal() {
  let overlay = document.getElementById("modalTiposOverlay");
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "modalTiposOverlay";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:10000;display:none;" +
    "align-items:flex-start;justify-content:center;padding:36px 14px;overflow:auto;";
  overlay.innerHTML = `
    <style>
      @keyframes tiposSpin { to { transform: rotate(360deg); } }
      .tipo-spinner {
        display:inline-block;width:16px;height:16px;border:2px solid rgba(255,255,255,.25);
        border-top-color:var(--vermelho,#f87171);border-radius:50%;
        animation:tiposSpin .7s linear infinite;vertical-align:middle;
      }
      .tipo-chip {
        background:transparent;color:var(--text-secondary,#cfd3da);border:1px solid var(--border,#444);
        border-radius:999px;padding:5px 11px;font-size:12px;font-weight:700;cursor:pointer;
        font-family:inherit;transition:background .12s,border-color .12s,color .12s;
      }
      .tipo-chip:hover { border-color:var(--roxo,#a78bfa); }
      .tipo-chip.on {
        background:var(--roxo,#a78bfa);color:#1c1033;border-color:var(--roxo,#a78bfa);
      }
    </style>
    <div style="background:var(--bg-elevated,#1b1f27);border:1px solid var(--border,#333);
                border-radius:12px;max-width:1040px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.55);">
      <div style="position:sticky;top:0;background:var(--bg-elevated,#1b1f27);border-bottom:1px solid var(--border,#333);
                  border-radius:12px 12px 0 0;padding:16px 20px;display:flex;align-items:center;gap:12px;z-index:1;">
        <div style="flex:1;">
          <div style="font-size:15px;font-weight:800;color:var(--text-heading,#fff);">🏷️ Apontar tipo de ocorrência não informado</div>
          <div id="modalTiposContador" style="font-size:12px;color:var(--text-muted,#9aa);margin-top:2px;"></div>
        </div>
        <button type="button" onclick="fecharModalTipos()"
          style="background:transparent;border:1px solid var(--border,#444);color:var(--text-secondary,#ccc);
                 border-radius:8px;padding:6px 12px;font-size:13px;font-weight:700;cursor:pointer;">Fechar ✕</button>
      </div>
      <div id="modalTiposLista" style="padding:14px 16px 20px;"></div>
    </div>`;
  document.body.appendChild(overlay);

  // Fecha clicando fora.
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) fecharModalTipos();
  });
  return overlay;
}

function _tiposLinhaHtml(o) {
  const chips = _tiposCanonicos()
    .map((t) => `<button type="button" class="tipo-chip" data-tipo="${_tiposEsc(t)}" onclick="tiposToggleChip(this)">${_tiposEsc(t)}</button>`)
    .join("");
  const desc = _tiposDescricao(o);
  const setor = _tiposResponsavel(o);
  return `
    <div id="tipoRow_${o.id}" data-id="${o.id}"
         style="border:1px solid var(--border,#333);border-radius:10px;padding:12px 14px;margin-bottom:10px;
                background:var(--bg-base,rgba(255,255,255,.02));transition:opacity .25s;">
      <div style="display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;font-size:12px;margin-bottom:8px;">
        <span style="font-weight:800;white-space:nowrap;">${_tiposEsc(_tiposData(o))}</span>
        <span style="color:var(--azul,#4ea1ff);white-space:nowrap;">🏬 ${_tiposEsc(_tiposLoja(o))}</span>
        <span style="color:var(--text-muted,#9aa);white-space:nowrap;">🛣️ ${_tiposEsc(_tiposRota(o))}</span>
        <span style="color:var(--text-muted,#9aa);white-space:nowrap;">🚚 ${_tiposEsc(o.motorista || "—")}</span>
        ${setor ? `<span style="background:rgba(167,139,250,.12);color:var(--roxo,#a78bfa);border:1px solid rgba(167,139,250,.3);
                   padding:2px 8px;border-radius:6px;font-weight:700;">${_tiposEsc(setor)}</span>` : ""}
      </div>
      <div title="${_tiposEsc(desc)}"
           style="font-size:13px;color:var(--text-secondary,#cfd3da);margin-bottom:10px;line-height:1.4;">
        ${_tiposEsc(desc.length > 220 ? desc.slice(0, 220) + "…" : desc)}
      </div>
      <div style="font-size:11px;color:var(--text-muted,#9aa);margin-bottom:5px;text-transform:uppercase;letter-spacing:.5px;">
        Qual o tipo da ocorrência? (pode marcar mais de um)
      </div>
      <div id="tipoChips_${o.id}" class="tipo-chips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">
        ${chips}
      </div>
      <div id="tipoAcoes_${o.id}" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
        <button type="button" onclick="tiposApontar(${o.id})"
          style="background:var(--verde,#34d399);color:#06281d;border:none;border-radius:8px;padding:8px 14px;
                 font-size:13px;font-weight:800;cursor:pointer;white-space:nowrap;">Apontar ✓</button>
        <button type="button" onclick="tiposEditar(${o.id})"
          style="background:transparent;color:var(--azul,#4ea1ff);border:1px solid var(--azul,#4ea1ff);border-radius:8px;
                 padding:8px 12px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;">Corrigir ✎</button>
        <button type="button" onclick="tiposExcluir(${o.id})"
          style="background:transparent;color:var(--vermelho,#f87171);border:1px solid var(--vermelho,#f87171);border-radius:8px;
                 padding:8px 12px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;">Mover p/ lixeira 🗑</button>
      </div>
      <div id="tipoMsg_${o.id}" style="font-size:12px;margin-top:6px;min-height:0;"></div>
    </div>`;
}

function _tiposMsg(id, texto, cor) {
  const el = document.getElementById(`tipoMsg_${id}`);
  if (!el) return;
  el.textContent = texto || "";
  el.style.color = cor || "var(--text-muted,#9aa)";
}

function _tiposRenderizar() {
  const lista = _tiposLista();
  const cont = document.getElementById("modalTiposContador");
  const box = document.getElementById("modalTiposLista");
  if (cont) {
    cont.textContent = lista.length
      ? `${lista.length} ocorrência${lista.length === 1 ? "" : "s"} sem tipo — aponte, corrija ou exclua.`
      : "Tudo classificado.";
  }
  if (!box) return;
  if (!lista.length) {
    box.innerHTML = `<p style="color:var(--text-muted,#9aa);text-align:center;padding:28px 0;font-size:14px;">
        🎉 Nenhuma ocorrência sem tipo. Tudo classificado!</p>`;
    return;
  }
  // Mais recentes primeiro.
  lista.sort((a, b) =>
    String(b.data_ocorrencia || b.data || "").localeCompare(String(a.data_ocorrencia || a.data || "")),
  );
  box.innerHTML = lista.map(_tiposLinhaHtml).join("");
}

function abrirModalTiposNaoInformados() {
  if (typeof ocorrencias === "undefined" || !Array.isArray(ocorrencias)) {
    if (typeof alertar === "function") alertar("Os dados ainda estão carregando. Tente de novo em instantes.");
    return;
  }
  _tiposHouveMudanca = false;
  const overlay = _tiposGarantirModal();
  _tiposRenderizar();
  overlay.style.display = "flex";
}

function fecharModalTipos() {
  const overlay = document.getElementById("modalTiposOverlay");
  if (overlay) overlay.style.display = "none";
  // Se algo mudou, recarrega para os gráficos/rankings refletirem.
  if (_tiposHouveMudanca && typeof carregarHistorico === "function") {
    _tiposHouveMudanca = false;
    carregarHistorico();
  }
  atualizarSinoTipos();
}

function _tiposRemoverLinha(id) {
  const row = document.getElementById(`tipoRow_${id}`);
  if (!row) return;
  row.style.opacity = "0";
  setTimeout(() => {
    row.remove();
    // Atualiza só o contador; não re-renderiza tudo para não perder seleções em curso.
    const restantes = document.querySelectorAll("#modalTiposLista [data-id]").length;
    const cont = document.getElementById("modalTiposContador");
    if (cont) {
      cont.textContent = restantes
        ? `${restantes} ocorrência${restantes === 1 ? "" : "s"} sem tipo — aponte, corrija ou exclua.`
        : "Tudo classificado.";
    }
    if (!restantes) {
      const box = document.getElementById("modalTiposLista");
      if (box) {
        box.innerHTML = `<p style="color:var(--text-muted,#9aa);text-align:center;padding:28px 0;font-size:14px;">
            🎉 Tudo classificado! Feche para atualizar os gráficos.</p>`;
      }
    }
    atualizarSinoTipos();
  }, 220);
}

// Liga/desliga um chip de tipo (permite escolher vários).
function tiposToggleChip(btn) {
  btn.classList.toggle("on");
  const row = btn.closest("[data-id]");
  if (row) _tiposMsg(row.getAttribute("data-id"), "", "");
}

async function tiposApontar(id) {
  const marcados = document.querySelectorAll(`#tipoChips_${id} .tipo-chip.on`);
  const tipos = Array.from(marcados).map((c) => c.dataset.tipo).filter(Boolean);
  if (!tipos.length) {
    _tiposMsg(id, "Marque pelo menos um tipo antes de apontar.", "var(--vermelho,#f87171)");
    return;
  }
  // Multivalor no mesmo formato do formulário: "Tipo A, Tipo B".
  const valor = tipos.join(", ");
  _tiposMsg(id, "Salvando…", "var(--text-muted,#9aa)");
  try {
    const res = await fetch(`${API_URL}/ocorrencias/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tipo_problema: valor }),
    });
    if (!res.ok) {
      let m = `Erro HTTP ${res.status}`;
      try { const e = await res.json(); m = e.detalhe || e.error || m; } catch (_) {}
      _tiposMsg(id, "❌ Erro ao apontar: " + m, "var(--vermelho,#f87171)");
      return;
    }
    // Atualiza a cópia em memória para os gráficos baterem ao fechar.
    const o = ocorrencias.find((x) => String(x.id) === String(id));
    if (o) { o.tipo_problema = valor; o.tipoOcorrencia = valor; o.teve_ocorrencia = true; }
    _tiposHouveMudanca = true;
    _tiposRemoverLinha(id);
  } catch (err) {
    console.error(err);
    _tiposMsg(id, "❌ Não foi possível conectar ao servidor.", "var(--vermelho,#f87171)");
  }
}

function tiposEditar(id) {
  // "Corrigir" abre o modal enxuto (tipo + responsável + relato) POR CIMA do
  // sino, em vez de jogar o usuário no formulário completo da aba "entregas".
  // O sino fica aberto atrás; corrSalvar() avisa via tiposNotificarCorrecao().
  if (typeof abrirModalCorrigir === "function") {
    abrirModalCorrigir(id);
  } else if (typeof editarOcorrencia === "function") {
    // Fallback: comportamento antigo (form completo na aba entregas).
    fecharModalTipos();
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
function tiposNotificarCorrecao() {
  _tiposHouveMudanca = true;
  const overlay = document.getElementById("modalTiposOverlay");
  if (overlay && overlay.style.display !== "none") _tiposRenderizar();
  atualizarSinoTipos();
}

// Confirmação INLINE dentro do próprio modal (o diálogo global #modalConfirm
// fica em z-index 1001, atrás deste modal — por isso não dá para usá-lo aqui).
function tiposExcluir(id) {
  const area = document.getElementById(`tipoAcoes_${id}`);
  if (!area) return;
  if (area.dataset.htmlOriginal === undefined) area.dataset.htmlOriginal = area.innerHTML;
  area.innerHTML = `
    <span style="color:var(--vermelho,#f87171);font-weight:800;font-size:13px;">Mover para a lixeira? (dá pra recuperar depois)</span>
    <button type="button" onclick="tiposConfirmarExclusao(${id})"
      style="background:var(--vermelho,#f87171);color:#2b0a0a;border:none;border-radius:8px;padding:8px 14px;
             font-size:13px;font-weight:800;cursor:pointer;">Sim, mover</button>
    <button type="button" onclick="tiposCancelarExclusao(${id})"
      style="background:transparent;color:var(--text-secondary,#ccc);border:1px solid var(--border,#444);
             border-radius:8px;padding:8px 12px;font-size:13px;font-weight:700;cursor:pointer;">Cancelar</button>`;
}

function tiposCancelarExclusao(id) {
  const area = document.getElementById(`tipoAcoes_${id}`);
  if (area && area.dataset.htmlOriginal !== undefined) {
    area.innerHTML = area.dataset.htmlOriginal;
    delete area.dataset.htmlOriginal;
  }
}

async function tiposConfirmarExclusao(id) {
  const area = document.getElementById(`tipoAcoes_${id}`);
  if (area) {
    area.innerHTML = `<span class="tipo-spinner"></span>
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
      _tiposMsg(id, "❌ Erro ao excluir o registro.", "var(--vermelho,#f87171)");
      return;
    }
    const i = ocorrencias.findIndex((x) => String(x.id) === String(id));
    if (i >= 0) ocorrencias.splice(i, 1);
    _tiposHouveMudanca = true;
    _tiposRemoverLinha(id);
  } catch (err) {
    console.error(err);
    await espera;
    if (area && area.dataset.htmlOriginal !== undefined) {
      area.innerHTML = area.dataset.htmlOriginal;
      delete area.dataset.htmlOriginal;
    }
    _tiposMsg(id, "❌ Não foi possível conectar ao servidor.", "var(--vermelho,#f87171)");
  }
}

// ----------------------------------------------------------------
// SINO (🏷️) no topo: badge com a contagem de ocorrências sem tipo.
// ----------------------------------------------------------------
function atualizarSinoTipos() {
  const badge = document.getElementById("sinoTiposBadge");
  if (!badge) return;
  let n = 0;
  try { n = _tiposLista().length; } catch (_) { n = 0; }
  if (n > 0) {
    badge.textContent = n > 99 ? "99+" : String(n);
    badge.style.display = "inline-flex";
  } else {
    badge.style.display = "none";
  }
}

// Recalcula o badge sozinho: já no load e a cada 5s (os dados chegam de forma
// assíncrona via carregarHistorico; assim o sino reflete sem precisar acoplar).
document.addEventListener("DOMContentLoaded", () => setTimeout(atualizarSinoTipos, 800));
setInterval(() => { if (!document.hidden) atualizarSinoTipos(); }, 30000);

// Expõe no escopo global (chamadas via onclick inline).
window.abrirModalTiposNaoInformados = abrirModalTiposNaoInformados;
window.fecharModalTipos = fecharModalTipos;
window.tiposApontar = tiposApontar;
window.tiposToggleChip = tiposToggleChip;
window.tiposEditar = tiposEditar;
window.tiposExcluir = tiposExcluir;
window.tiposConfirmarExclusao = tiposConfirmarExclusao;
window.tiposCancelarExclusao = tiposCancelarExclusao;
window.tiposNotificarCorrecao = tiposNotificarCorrecao;
window.atualizarSinoTipos = atualizarSinoTipos;
