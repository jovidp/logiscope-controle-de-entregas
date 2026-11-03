// ================================================================
// PATCH — TEMPO DE DESCARGA COM TOLERÂNCIA POR LOJA
// Adicione este bloco ao seu script.js (ou inclua como arquivo separado
// carregado APÓS o script.js principal)
// ================================================================

// ----------------------------------------------------------------
// 1. DADOS DE TOLERÂNCIA
//    Chave = valor do <select id="loja"> (ex: "NOVA_AMERICA")
//    Valor = minutos permitidos de descarga
//    Lojas sem entrada usam o padrão global de 40 min
// ----------------------------------------------------------------
// Padrão global (pode ser sobrescrito pela config do servidor)
let TOLERANCIA_PADRAO_MIN = 40;

// Chave da config no servidor (tabela sistema_config) e base da API
const CONFIG_TOLERANCIA_KEY = "toleranciaDescarga";
const TOLERANCIA_API_BASE = window.location.origin;

// Mapa de exceções — agora carregado do servidor (antes ficava em localStorage).
// Ex: { NOVA_AMERICA: 60, NORTE: 70 }
let toleranciasPorLoja = {};

// Carrega tolerâncias do servidor (compartilhado entre todos os computadores).
// Migra automaticamente o que ainda estiver no localStorage antigo.
async function carregarTolerancias() {
  let servidorTemConfig = false;
  try {
    const res = await fetch(
      `${TOLERANCIA_API_BASE}/config/${CONFIG_TOLERANCIA_KEY}`,
    );
    if (res.ok) {
      const cfg = await res.json();
      const valor = cfg && cfg.valor;
      if (valor && typeof valor === "object") {
        servidorTemConfig = true;
        if (valor.porLoja && typeof valor.porLoja === "object") {
          toleranciasPorLoja = valor.porLoja;
        }
        if (Number.isFinite(Number(valor.padraoMin))) {
          TOLERANCIA_PADRAO_MIN = Number(valor.padraoMin);
        }
      }
    }
  } catch (err) {
    console.error("[tolerancias] Erro ao carregar do servidor:", err);
  }

  // Migração única: se o servidor ainda não tem config mas há dado antigo local.
  if (!servidorTemConfig) {
    let antigo = {};
    try {
      antigo = JSON.parse(localStorage.getItem(CONFIG_TOLERANCIA_KEY) || "{}");
    } catch (_) {
      antigo = {};
    }
    if (antigo && typeof antigo === "object" && Object.keys(antigo).length) {
      toleranciasPorLoja = antigo;
      await salvarTolerancias();
    }
  }

  window.toleranciasPorLoja = toleranciasPorLoja;
  window.TOLERANCIA_PADRAO_MIN = TOLERANCIA_PADRAO_MIN;
}

// Salva as tolerâncias no servidor. Retorna true/false.
async function salvarTolerancias() {
  try {
    const res = await fetch(
      `${TOLERANCIA_API_BASE}/config/${CONFIG_TOLERANCIA_KEY}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          valor: {
            padraoMin: TOLERANCIA_PADRAO_MIN,
            porLoja: toleranciasPorLoja,
          },
        }),
      },
    );
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const e = await res.json();
        msg = e.error || msg;
      } catch (_) {}
      throw new Error(msg);
    }
    window.toleranciasPorLoja = toleranciasPorLoja;
    window.TOLERANCIA_PADRAO_MIN = TOLERANCIA_PADRAO_MIN;
    return true;
  } catch (err) {
    console.error("[tolerancias] Erro ao salvar no servidor:", err);
    return false;
  }
}

function toleranciaDaLoja(lojaKey) {
  return toleranciasPorLoja[lojaKey] ?? TOLERANCIA_PADRAO_MIN;
}

// ----------------------------------------------------------------
// 2. ALERTA DE DESCARGA NO FORMULÁRIO DE OCORRÊNCIA
// ----------------------------------------------------------------

/** Cria (uma única vez) o bloco de alerta logo após o campo saidaLoja */
function garantirBlocoAlertaDescarga() {
  if (document.getElementById("blocoAlertaDescarga")) return;

  const campoSaida =
    document.getElementById("saidaLoja") ||
    document.getElementById("fim_descarga");
  if (!campoSaida) return;

  const bloco = document.createElement("div");
  bloco.id = "blocoAlertaDescarga";
  bloco.style.cssText = `
    display:none;
    margin-top:10px;
    padding:12px 16px;
    border-radius:10px;
    font-size:13px;
    font-weight:700;
    line-height:1.5;
    grid-column: 1 / -1;
    transition: background .25s, border-color .25s;
  `;

  // Insere depois do contêiner pai do campo saída
  const pai = campoSaida.closest("div") || campoSaida.parentElement;
  pai?.parentElement?.insertBefore(bloco, pai.nextSibling) ||
    campoSaida.parentElement?.appendChild(bloco);
}

/** Recalcula e exibe o alerta toda vez que inicio, saída ou loja mudar */
function avaliarTempoDescarga() {
  garantirBlocoAlertaDescarga();

  const bloco = document.getElementById("blocoAlertaDescarga");
  if (!bloco) return;

  const lojaKey = document.getElementById("loja")?.value || "";
  const inicio = document.getElementById("inicioDescarga")?.value || "";
  // Tempo de descarga = INICIO da descarga -> FIM da descarga (terminoDescarga).
  // NUNCA usa a saida da loja. Sem o fim da descarga o alerta fica oculto.
  const saida = document.getElementById("terminoDescarga")?.value || "";

  if (!inicio || !saida) {
    bloco.style.display = "none";
    return;
  }

  const toMin = (h) => {
    const [hh, mm] = String(h).split(":").map(Number);
    return hh * 60 + (mm || 0);
  };

  const duracaoMin = toMin(saida) - toMin(inicio);
  if (duracaoMin <= 0) {
    bloco.style.display = "none";
    return;
  }

  const limite = toleranciaDaLoja(lojaKey);
  const excedeu = duracaoMin > limite;
  const nomeLoja = lojaKey.replaceAll("_", " ") || "—";
  const isExcecao = toleranciasPorLoja[lojaKey] !== undefined;

  bloco.style.display = "block";

  if (excedeu) {
    const excesso = duracaoMin - limite;
    const fmtTempo = (m) => {
      const h = Math.floor(m / 60),
        min = m % 60;
      return h > 0 ? `${h}h ${min}min` : `${min}min`;
    };
    bloco.style.background = "rgba(248,113,113,0.10)";
    bloco.style.border = "1px solid rgba(248,113,113,0.35)";
    bloco.style.color = "var(--vermelho, #f87171)";
    bloco.innerHTML = `
      ⚠️ <span style="font-size:14px;">DESCARGA EXCEDIDA</span><br>
      <span style="font-weight:400;font-size:12px;">
        Loja: <b>${nomeLoja}</b>${isExcecao ? " 🔖 (tolerância especial)" : ""} |
        Limite: <b>${fmtTempo(limite)}</b> |
        Real: <b>${fmtTempo(duracaoMin)}</b> |
        Excesso: <b style="color:#f87171;">+${fmtTempo(excesso)}</b>
      </span><br>
      <span style="font-size:11px;opacity:.8;">Este registro receberá <b>−1 ponto</b> no ranking.</span>
    `;
  } else {
    const fmtTempo = (m) => {
      const h = Math.floor(m / 60),
        min = m % 60;
      return h > 0 ? `${h}h ${min}min` : `${min}min`;
    };
    bloco.style.background = "rgba(52,211,153,0.08)";
    bloco.style.border = "1px solid rgba(52,211,153,0.30)";
    bloco.style.color = "var(--verde, #34d399)";
    bloco.innerHTML = `
      ✅ <span style="font-size:14px;">DESCARGA DENTRO DO LIMITE</span><br>
      <span style="font-weight:400;font-size:12px;">
        Loja: <b>${nomeLoja}</b>${isExcecao ? " 🔖 (tolerância especial)" : ""} |
        Limite: <b>${fmtTempo(limite)}</b> |
        Real: <b>${fmtTempo(duracaoMin)}</b>
      </span>
    `;
  }

  // A mesma medicao alimenta o bloco de justificativa (mesmo limite por loja),
  // pra os dois nunca discordarem — inclusive quando so a loja muda.
  if (typeof atualizarCampoJustificativaPermanencia === "function")
    atualizarCampoJustificativaPermanencia();
}

// Conecta os listeners nos campos relevantes (idempotente)
function inicializarListenersDescarga() {
  ["inicioDescarga", "terminoDescarga", "saidaLoja", "fim_descarga", "loja"].forEach((id) => {
    const el = document.getElementById(id);
    if (el && !el._descargaListenerAtivo) {
      el.addEventListener("change", avaliarTempoDescarga);
      el.addEventListener("input", avaliarTempoDescarga);
      el._descargaListenerAtivo = true;
    }
  });
}

// ----------------------------------------------------------------
// 3. INTEGRAÇÃO COM O SISTEMA DE PONTUAÇÃO DO RANKING
// ----------------------------------------------------------------
// Estende calcularPontuacaoMotorista para incluir descarga excessiva

const _calcularPontuacaoMotoristaOriginal =
  typeof calcularPontuacaoMotorista === "function"
    ? calcularPontuacaoMotorista
    : null;

window.calcularPontuacaoMotorista = function (
  motorista,
  dataInicio,
  dataFim,
  rotaFiltro = "",
) {
  const resultado = _calcularPontuacaoMotoristaOriginal
    ? _calcularPontuacaoMotoristaOriginal(
        motorista,
        dataInicio,
        dataFim,
        rotaFiltro,
      )
    : {
        pts: {},
        total: 0,
        positivos: 0,
        negativos: 0,
        totalEntregas: 0,
        totalRegistros: 0,
        mediaPorEntrega: 0,
        motorista,
        rotaFiltro,
      };

  // Calcula descargas excedidas
  let entregasMot = (window.ocorrencias || []).filter(
    (o) => o.motorista === motorista,
  );

  const rankingFiltrar = (lista, campoFn, dI, dF) =>
    lista.filter((item) => {
      const d = String(campoFn(item) || "").split("T")[0];
      if (dI && d < dI) return false;
      if (dF && d > dF) return false;
      return true;
    });

  entregasMot = rankingFiltrar(
    entregasMot,
    (o) => o.data_ocorrencia || o.data,
    dataInicio,
    dataFim,
  );

  if (rotaFiltro) {
    entregasMot = entregasMot.filter(
      (o) =>
        (typeof obterRotaDaOcorrencia === "function"
          ? obterRotaDaOcorrencia(o)
          : "") === rotaFiltro,
    );
  }

  const toMin = (h) => {
    if (!h) return 0;
    const [hh, mm] = String(h).split(":").map(Number);
    return hh * 60 + (mm || 0);
  };

  let descargas = 0;
  entregasMot.forEach((o) => {
    const inicio = o.inicio_descarga;
    const saida = o.termino_descarga;
    if (!inicio || !saida) return;
    const dur = toMin(saida) - toMin(inicio);
    if (dur <= 0) return;
    const limite = toleranciaDaLoja(o.loja);
    if (dur > limite) descargas++;
  });

  if (descargas > 0) {
    // A descarga acima do limite (>40min / tolerância) é responsabilidade dos
    // ajudantes, não do motorista. Por isso mostramos apenas como informativo
    // no painel do motorista, SEM descontar pontos do seu ranking.
    // A penalização efetiva acontece no ranking de ajudantes.
    resultado.pts.descargaExcedida = {
      label: "Descarga acima do limite (atribuída aos ajudantes)",
      valor: descargas,
      pontos: 0,
      cor: "var(--text-muted)",
    };
  }

  return resultado;
};

// ----------------------------------------------------------------
// 4. PAINEL DE GESTÃO DE TOLERÂNCIAS (injetado na aba Entregas ou
//    onde existir o elemento com id="painelToleranciasDescarga")
// ----------------------------------------------------------------

function renderizarPainelTolerancias() {
  const container = document.getElementById("painelToleranciasDescarga");
  if (!container) return;

  const lojas = typeof lojasRotas === "object" ? Object.keys(lojasRotas) : [];
  const fmtNome = (k) => k.replaceAll("_", " ");

  const listaExcecoes = Object.entries(toleranciasPorLoja)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(
      ([key, min]) => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;
           background:rgba(56,189,248,0.06);border:1px solid rgba(56,189,248,0.2);
           border-radius:8px;margin-bottom:6px;">
        <span style="flex:1;font-size:13px;font-weight:700;color:var(--text-heading);">
          🔖 ${fmtNome(key)}
        </span>
        <span style="font-size:12px;color:var(--azul);font-weight:700;">${min} min</span>
        <button type="button" onclick="removerTolerancia('${key}')"
          style="background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.25);
                 border-radius:6px;padding:3px 9px;color:#f87171;font-size:11px;cursor:pointer;">
          ✕
        </button>
      </div>`,
    )
    .join("");

  const opcoesLojas = lojas
    .sort()
    .map((k) => `<option value="${k}">${fmtNome(k)}</option>`)
    .join("");

  container.innerHTML = `
    <div style="background:var(--bg-elevated,#1e293b);border:1px solid var(--border);
                border-radius:14px;padding:20px;margin-top:18px;">

      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
        <span style="font-size:1.2rem;">⏱️</span>
        <div>
          <h3 style="margin:0;font-size:1rem;color:var(--text-heading);">Tolerância de Descarga por Loja</h3>
          <p style="margin:4px 0 0;font-size:12px;color:var(--text-muted);">
            Padrão global: <b style="color:var(--azul);">${TOLERANCIA_PADRAO_MIN} minutos</b> —
            Lojas abaixo têm tempo maior permitido.
          </p>
        </div>
      </div>

      <!-- Formulário para adicionar exceção -->
      <div style="display:grid;grid-template-columns:1fr auto auto;gap:8px;margin-bottom:16px;">
        <select id="tolLoja"
          style="padding:8px 12px;border-radius:8px;border:1px solid var(--border);
                 background:var(--bg-base);color:var(--text-heading);font-size:13px;">
          <option value="">Selecione a loja…</option>
          ${opcoesLojas}
        </select>
        <div style="display:flex;align-items:center;gap:6px;">
          <input type="number" id="tolMinutos" min="1" max="480" placeholder="min"
            style="width:72px;padding:8px 10px;border-radius:8px;border:1px solid var(--border);
                   background:var(--bg-base);color:var(--text-heading);font-size:13px;text-align:center;" />
          <span style="font-size:12px;color:var(--text-muted);white-space:nowrap;">min</span>
        </div>
        <button type="button" onclick="adicionarTolerancia()"
          style="padding:8px 16px;border-radius:8px;background:rgba(56,189,248,0.15);
                 border:1px solid rgba(56,189,248,0.3);color:var(--azul);
                 font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;">
          + Adicionar
        </button>
      </div>

      <!-- Lista de exceções -->
      <div id="listaExcecoesTolerancias">
        ${
          listaExcecoes ||
          `<p style="color:var(--text-muted);font-size:13px;text-align:center;padding:12px 0;">
            Nenhuma exceção cadastrada — todas as lojas usam 40 min.
          </p>`
        }
      </div>

    </div>`;
}

window.adicionarTolerancia = async function () {
  const key = document.getElementById("tolLoja")?.value;
  const min = parseInt(document.getElementById("tolMinutos")?.value, 10);

  if (!key) {
    alertar("Selecione uma loja.");
    return;
  }
  if (!min || min < 1) {
    alertar("Informe um tempo válido em minutos.");
    return;
  }
  const anterior = toleranciasPorLoja[key];
  toleranciasPorLoja[key] = min;
  const ok = await salvarTolerancias();
  if (!ok) {
    // desfaz em memória se o servidor recusou
    if (anterior === undefined) delete toleranciasPorLoja[key];
    else toleranciasPorLoja[key] = anterior;
    return;
  }
  renderizarPainelTolerancias();
  alertar(`✅ Tolerância de ${min}min salva para ${key.replaceAll("_", " ")}.`);
};

window.removerTolerancia = async function (key) {
  const anterior = toleranciasPorLoja[key];
  delete toleranciasPorLoja[key];
  const ok = await salvarTolerancias();
  if (!ok) {
    if (anterior !== undefined) toleranciasPorLoja[key] = anterior;
    return;
  }
  renderizarPainelTolerancias();
};

// ----------------------------------------------------------------
// 5. INJEÇÃO AUTOMÁTICA DO PAINEL NO HTML
//    Tenta inserir depois do container do histórico de entregas
//    (id="lista"). Se preferir outro local, mova o elemento
//    <div id="painelToleranciasDescarga"></div> no seu HTML.
// ----------------------------------------------------------------
function injetarPainelNoDOM() {
  if (document.getElementById("painelToleranciasDescarga")) return; // já existe no HTML

  // Tenta achar a aba de entregas
  const abaEntregas =
    document.getElementById("aba-entregas") || document.querySelector(".aba");

  if (!abaEntregas) return;

  const div = document.createElement("div");
  div.id = "painelToleranciasDescarga";
  abaEntregas.appendChild(div);
}

// ----------------------------------------------------------------
// 6. BOOT — executa quando o DOM estiver pronto
// ----------------------------------------------------------------
async function bootDescargaPatch() {
  // Espera a autenticação (o GET /config exige sessão válida).
  if (window.authReady) {
    try {
      await window.authReady;
    } catch (_) {}
  }
  if (!window.authUsuario) return;

  injetarPainelNoDOM();
  await carregarTolerancias();
  renderizarPainelTolerancias();
  inicializarListenersDescarga();
  // Recalcula alerta e ranking caso já haja dados na tela.
  if (typeof avaliarTempoDescarga === "function") avaliarTempoDescarga();
  if (typeof calcularRanking === "function") {
    try {
      calcularRanking();
    } catch (_) {}
  }

  // Garante que o alerta apareça também quando o formulário for aberto
  const _abrirFormOriginal =
    typeof window.abrirForm === "function" ? window.abrirForm : null;
  if (_abrirFormOriginal && !window._abrirFormPatched) {
    window._abrirFormPatched = true;
    window.abrirForm = function (...args) {
      _abrirFormOriginal(...args);
      setTimeout(() => {
        garantirBlocoAlertaDescarga();
        inicializarListenersDescarga();
      }, 100);
    };
  }

  const _editarOriginal =
    typeof window.editarOcorrencia === "function"
      ? window.editarOcorrencia
      : null;
  if (_editarOriginal && !window._editarPatched) {
    window._editarPatched = true;
    window.editarOcorrencia = function (...args) {
      _editarOriginal(...args);
      setTimeout(() => {
        garantirBlocoAlertaDescarga();
        inicializarListenersDescarga();
        avaliarTempoDescarga();
      }, 150);
    };
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootDescargaPatch);
} else {
  bootDescargaPatch();
}

// Expõe para uso externo
window.avaliarTempoDescarga = avaliarTempoDescarga;
window.toleranciaDaLoja = toleranciaDaLoja;
window.toleranciasPorLoja = toleranciasPorLoja;
window.TOLERANCIA_PADRAO_MIN = TOLERANCIA_PADRAO_MIN;
window.carregarTolerancias = carregarTolerancias;
window.salvarTolerancias = salvarTolerancias;
