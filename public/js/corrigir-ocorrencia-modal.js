// ================================================================
// corrigir-ocorrencia-modal.js
// ----------------------------------------------------------------
// Modal ENXUTO de correção, usado pelo botão "Corrigir ✎" dos dois
// sinos (setores-nao-informados.js e tipos-nao-informados.js). Antes,
// "Corrigir" fechava o sino e jogava o usuário no formulário completo
// da aba "entregas"; agora abre só o essencial, por cima do sino:
//   - TIPO de ocorrência (chips, lista canônica, multivalor);
//   - RESPONSÁVEL / setor (chips, lista canônica, multivalor);
//   - RELATO (textarea) já PREENCHIDO com o que está escrito.
//
// Os valores atuais já vêm marcados. Valores fora da lista canônica
// (texto livre antigo) viram um chip extra, também pré-marcado, para
// não se perderem ao salvar.
//
// Salva via PUT /ocorrencias/:id (merge parcial no server; teve_ocorrencia
// é recalculado a partir de tipo_problema), mandando só
// { tipo_problema, ocorrencia_responsavel, descricao }.
//
// Arquivo autocontido (script clássico, escopo global). Reaproveita os
// globais já carregados: ocorrencias, API_URL, _tiposCanonicos,
// RESPONSAVEIS_OCORRENCIA, obterResponsavelOcorrencia, escapar,
// formatarDataBR, formatarNomeLoja, obterRotaDaOcorrencia. Por isso é
// incluído DEPOIS de setores/tipos-nao-informados.js.
// ================================================================

function _corrEsc(v) {
  return typeof escapar === "function"
    ? escapar(v)
    : String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
      );
}
function _corrData(o) {
  const iso = String(o.data_ocorrencia || o.data || "").split("T")[0];
  return typeof formatarDataBR === "function" ? formatarDataBR(iso) : iso || "—";
}
function _corrLoja(o) {
  const l = typeof formatarNomeLoja === "function" ? formatarNomeLoja(o.loja) : o.loja;
  return l || "—";
}
function _corrRota(o) {
  if (typeof obterRotaDaOcorrencia === "function") return obterRotaDaOcorrencia(o) || "—";
  return o.rota || "—";
}
function _corrRelatoAtual(o) {
  return String(o.descricao || o.relato || o.problema_operacional_relato || "").trim();
}

// Lista canônica de tipos (mesma fonte do sino de tipos).
function _corrTiposCanonicos() {
  if (typeof _tiposCanonicos === "function") return _tiposCanonicos();
  const doForm = Array.from(
    document.querySelectorAll('input[type="checkbox"][data-multi-group="tipoOcorrencia"]'),
  )
    .map((c) => String(c.value || "").trim())
    .filter(Boolean);
  return doForm;
}

// Lista canônica de setores/responsáveis (mesma fonte do sino de setores).
function _corrSetoresCanonicos() {
  return typeof RESPONSAVEIS_OCORRENCIA !== "undefined" && Array.isArray(RESPONSAVEIS_OCORRENCIA)
    ? RESPONSAVEIS_OCORRENCIA
    : [];
}

// Quebra um campo multivalor ("A, B") em itens limpos.
function _corrSplit(valor) {
  return String(valor || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function _corrTiposAtuais(o) {
  return _corrSplit(o.tipo_problema ?? o.tipoOcorrencia ?? "");
}
function _corrSetoresAtuais(o) {
  if (typeof obterResponsavelOcorrencia === "function") {
    return _corrSplit(obterResponsavelOcorrencia(o));
  }
  return _corrSplit(o.ocorrencia_responsavel ?? o.ocorrenciaResponsavel ?? "");
}

// Monta os chips: canônicos + quaisquer valores atuais fora da lista
// (para não perdê-los). Marca como "on" os que já estão apontados.
function _corrChipsHtml(grupo, canonicos, atuais, classe) {
  const setAtuais = new Set(atuais.map((v) => v.toLowerCase()));
  const todos = canonicos.slice();
  atuais.forEach((v) => {
    if (!canonicos.some((c) => c.toLowerCase() === v.toLowerCase())) todos.push(v);
  });
  return todos
    .map((v) => {
      const on = setAtuais.has(v.toLowerCase()) ? " on" : "";
      return `<button type="button" class="${classe}${on}" data-val="${_corrEsc(v)}"
        onclick="corrToggleChip(this)">${_corrEsc(v)}</button>`;
    })
    .join("");
}

// Cria (uma vez) a casca do modal e devolve o overlay.
function _corrGarantirModal() {
  let overlay = document.getElementById("modalCorrigirOverlay");
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "modalCorrigirOverlay";
  // z-index acima dos sinos (10000) para abrir POR CIMA deles.
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:10001;display:none;" +
    "align-items:flex-start;justify-content:center;padding:36px 14px;overflow:auto;";
  overlay.innerHTML = `
    <style>
      @keyframes corrSpin { to { transform: rotate(360deg); } }
      .corr-spinner {
        display:inline-block;width:16px;height:16px;border:2px solid rgba(255,255,255,.25);
        border-top-color:var(--verde,#34d399);border-radius:50%;
        animation:corrSpin .7s linear infinite;vertical-align:middle;
      }
      .corr-chip {
        background:transparent;color:var(--text-secondary,#cfd3da);border:1px solid var(--border,#444);
        border-radius:999px;padding:5px 11px;font-size:12px;font-weight:700;cursor:pointer;
        font-family:inherit;transition:background .12s,border-color .12s,color .12s;
      }
      .corr-chip-tipo:hover { border-color:var(--roxo,#a78bfa); }
      .corr-chip-tipo.on { background:var(--roxo,#a78bfa);color:#1c1033;border-color:var(--roxo,#a78bfa); }
      .corr-chip-setor:hover { border-color:var(--azul,#4ea1ff); }
      .corr-chip-setor.on { background:var(--azul,#4ea1ff);color:#04243f;border-color:var(--azul,#4ea1ff); }
      .corr-secao-titulo {
        font-size:11px;color:var(--text-muted,#9aa);margin:14px 0 6px;
        text-transform:uppercase;letter-spacing:.5px;font-weight:700;
      }
    </style>
    <div style="background:var(--bg-elevated,#1b1f27);border:1px solid var(--border,#333);
                border-radius:12px;max-width:680px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.55);">
      <div style="position:sticky;top:0;background:var(--bg-elevated,#1b1f27);border-bottom:1px solid var(--border,#333);
                  border-radius:12px 12px 0 0;padding:16px 20px;display:flex;align-items:center;gap:12px;z-index:1;">
        <div style="flex:1;">
          <div style="font-size:15px;font-weight:800;color:var(--text-heading,#fff);">✎ Corrigir ocorrência</div>
          <div id="modalCorrigirCabecalho" style="font-size:12px;color:var(--text-muted,#9aa);margin-top:2px;"></div>
        </div>
        <button type="button" onclick="fecharModalCorrigir()"
          style="background:transparent;border:1px solid var(--border,#444);color:var(--text-secondary,#ccc);
                 border-radius:8px;padding:6px 12px;font-size:13px;font-weight:700;cursor:pointer;">Fechar ✕</button>
      </div>
      <div style="padding:14px 20px 20px;">
        <div class="corr-secao-titulo">Tipo da ocorrência (pode marcar mais de um)</div>
        <div id="corrChipsTipo" style="display:flex;flex-wrap:wrap;gap:6px;"></div>

        <div class="corr-secao-titulo">Responsável / setor (pode marcar mais de um)</div>
        <div id="corrChipsSetor" style="display:flex;flex-wrap:wrap;gap:6px;"></div>

        <div class="corr-secao-titulo">Relato</div>
        <textarea id="corrRelato" rows="4" placeholder="Descreva o que aconteceu (opcional)…"
          style="width:100%;box-sizing:border-box;resize:vertical;background:var(--bg-base,rgba(255,255,255,.03));
                 color:var(--text-secondary,#cfd3da);border:1px solid var(--border,#444);border-radius:8px;
                 padding:10px 12px;font-size:13px;font-family:inherit;line-height:1.4;"></textarea>

        <div id="corrAcoes" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:14px;">
          <button type="button" id="corrSalvar" onclick="corrSalvar()"
            style="background:var(--verde,#34d399);color:#06281d;border:none;border-radius:8px;padding:9px 18px;
                   font-size:13px;font-weight:800;cursor:pointer;">Salvar ✓</button>
          <button type="button" onclick="fecharModalCorrigir()"
            style="background:transparent;color:var(--text-secondary,#ccc);border:1px solid var(--border,#444);
                   border-radius:8px;padding:9px 14px;font-size:13px;font-weight:700;cursor:pointer;">Cancelar</button>
        </div>
        <div id="corrMsg" style="font-size:12px;margin-top:8px;min-height:0;"></div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  // Fecha clicando fora.
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) fecharModalCorrigir();
  });
  return overlay;
}

// id da ocorrência que está sendo corrigida no momento.
let _corrIdAtual = null;

function _corrMsg(texto, cor) {
  const el = document.getElementById("corrMsg");
  if (!el) return;
  el.textContent = texto || "";
  el.style.color = cor || "var(--text-muted,#9aa)";
}

// Liga/desliga um chip (tipo ou setor).
function corrToggleChip(btn) {
  btn.classList.toggle("on");
  _corrMsg("", "");
}

// Ponto de entrada chamado pelos sinos: abre o modal já preenchido.
function abrirModalCorrigir(id) {
  if (typeof ocorrencias === "undefined" || !Array.isArray(ocorrencias)) {
    if (typeof alertar === "function") alertar("Os dados ainda estão carregando. Tente de novo em instantes.");
    return;
  }
  const o = ocorrencias.find((x) => String(x.id) === String(id));
  if (!o) {
    if (typeof alertar === "function") alertar("Ocorrência não encontrada.");
    return;
  }
  _corrIdAtual = id;
  const overlay = _corrGarantirModal();

  const cab = document.getElementById("modalCorrigirCabecalho");
  if (cab) {
    cab.innerHTML =
      `<span style="font-weight:800;">${_corrEsc(_corrData(o))}</span> · ` +
      `<span style="color:var(--azul,#4ea1ff);">🏬 ${_corrEsc(_corrLoja(o))}</span> · ` +
      `<span>🛣️ ${_corrEsc(_corrRota(o))}</span> · ` +
      `<span>🚚 ${_corrEsc(o.motorista || "—")}</span>`;
  }

  const boxTipo = document.getElementById("corrChipsTipo");
  if (boxTipo) {
    boxTipo.innerHTML = _corrChipsHtml(
      "tipo", _corrTiposCanonicos(), _corrTiposAtuais(o), "corr-chip corr-chip-tipo",
    );
  }
  const boxSetor = document.getElementById("corrChipsSetor");
  if (boxSetor) {
    boxSetor.innerHTML = _corrChipsHtml(
      "setor", _corrSetoresCanonicos(), _corrSetoresAtuais(o), "corr-chip corr-chip-setor",
    );
  }
  const ta = document.getElementById("corrRelato");
  if (ta) ta.value = _corrRelatoAtual(o); // já puxa o que está escrito

  _corrMsg("", "");
  overlay.style.display = "flex";
  if (ta) setTimeout(() => ta.focus(), 60);
}

function fecharModalCorrigir() {
  const overlay = document.getElementById("modalCorrigirOverlay");
  if (overlay) overlay.style.display = "none";
  _corrIdAtual = null;
}

async function corrSalvar() {
  const id = _corrIdAtual;
  if (id == null) return;

  const tipos = Array.from(document.querySelectorAll("#corrChipsTipo .corr-chip.on"))
    .map((c) => c.dataset.val).filter(Boolean);
  const setores = Array.from(document.querySelectorAll("#corrChipsSetor .corr-chip.on"))
    .map((c) => c.dataset.val).filter(Boolean);
  const relato = String(document.getElementById("corrRelato")?.value || "").trim();

  const tipoValor = tipos.join(", ");
  const setorValor = setores.join(", ");

  const btn = document.getElementById("corrSalvar");
  if (btn) btn.disabled = true;
  _corrMsg("Salvando…", "var(--text-muted,#9aa)");

  try {
    const res = await fetch(`${API_URL}/ocorrencias/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tipo_problema: tipoValor,
        ocorrencia_responsavel: setorValor,
        descricao: relato,
      }),
    });
    if (!res.ok) {
      let m = `Erro HTTP ${res.status}`;
      try { const e = await res.json(); m = e.detalhe || e.error || m; } catch (_) {}
      _corrMsg("❌ Erro ao salvar: " + m, "var(--vermelho,#f87171)");
      if (btn) btn.disabled = false;
      return;
    }
    // Atualiza a cópia em memória para os gráficos/sinos baterem ao fechar.
    const o = ocorrencias.find((x) => String(x.id) === String(id));
    if (o) {
      o.tipo_problema = tipoValor;
      o.tipoOcorrencia = tipoValor;
      o.ocorrencia_responsavel = setorValor;
      o.ocorrenciaResponsavel = setorValor;
      o.descricao = relato;
      o.relato = relato;
      o.teve_ocorrencia = !!tipoValor;
    }
    fecharModalCorrigir();
    // Avisa os dois sinos: marca mudança (recarrega gráficos ao fechar o sino),
    // re-renderiza a lista aberta e atualiza os badges.
    if (typeof window.tiposNotificarCorrecao === "function") window.tiposNotificarCorrecao();
    if (typeof window.setoresNotificarCorrecao === "function") window.setoresNotificarCorrecao();
  } catch (err) {
    console.error(err);
    _corrMsg("❌ Não foi possível conectar ao servidor.", "var(--vermelho,#f87171)");
    if (btn) btn.disabled = false;
  }
}

// Expõe no escopo global (chamadas via onclick inline e pelos sinos).
window.abrirModalCorrigir = abrirModalCorrigir;
window.fecharModalCorrigir = fecharModalCorrigir;
window.corrToggleChip = corrToggleChip;
window.corrSalvar = corrSalvar;
