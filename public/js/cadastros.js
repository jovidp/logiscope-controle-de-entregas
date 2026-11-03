// ================================================================
// CADASTROS — motoristas, ajudantes e placas gerenciados pela UI.
//
// Objetivo: permitir cadastrar/remover motoristas, ajudantes e placas
// pelo botao "Cadastrar" (menu lateral), sem editar o codigo. Os nomes
// novos passam a aparecer em TODOS os selects/formularios, e nomes
// antigos (ex.: quem saiu da empresa) podem ser ocultados.
//
// Como funciona:
//   - Ao carregar, tira um "retrato" das listas-base ja existentes
//     (opcoes dos selects estaticos + checkboxes de ajudante + os arrays
//     MOTORISTAS_LISTA / _MOTORISTAS_PLANILHA / TMS_PLACAS / TMS_AJUDANTES).
//   - Busca em /cadastros as personalizacoes salvas (adicionados/ocultos).
//   - Lista efetiva = (base + adicionados) - ocultos, aplicada em todo lugar.
//
// Persistencia: tabela `cadastros` no Postgres (ver server.js).
// ================================================================
(function () {
  "use strict";

  const API =
    typeof API_URL !== "undefined" && API_URL
      ? API_URL
      : window.location.origin;

  // Configuracao de cada tipo: onde a lista aparece.
  //   selects -> ids de <select> estaticos (opcoes escritas no index.html)
  //   grupos  -> grupos de checkbox (ajudantes), via data-multi-group
  //   arrays  -> arrays globais usados por telas que montam selects via JS
  const TIPOS = [
    {
      tipo: "motorista",
      rotulo: "Motoristas",
      emoji: "🚚",
      selects: [
        "motorista",
        "avisoMotorista",
        "filtroMotoristaHistorico",
        "tacdiarioMotorista",
        "motoristaAlmoco",
        "ckMotorista",
        "motoristaAtrasoSaida",
        "motoristaRota",
        "escalaMotorista",
      ],
      grupos: [],
      arrays: () =>
        [
          typeof MOTORISTAS_LISTA !== "undefined" ? MOTORISTAS_LISTA : null,
          typeof _MOTORISTAS_PLANILHA !== "undefined"
            ? _MOTORISTAS_PLANILHA
            : null,
        ].filter(Boolean),
    },
    {
      tipo: "placa",
      rotulo: "Placas",
      emoji: "🚛",
      selects: [
        "placa",
        "avisoPlaca",
        "tacdiarioPlaca",
        "ckPlaca",
        "placaAtrasoSaida",
        "placaRota",
        "escalaPlaca",
      ],
      grupos: [],
      arrays: () =>
        [typeof TMS_PLACAS !== "undefined" ? TMS_PLACAS : null].filter(Boolean),
    },
    {
      tipo: "ajudante",
      rotulo: "Ajudantes",
      emoji: "🧑‍🔧",
      selects: ["ajudantes"], // <select multiple> nativo (oculto)
      grupos: ["ajudantes", "escalaAjudantes"], // checkboxes visiveis
      arrays: () =>
        [typeof TMS_AJUDANTES !== "undefined" ? TMS_AJUDANTES : null].filter(
          Boolean,
        ),
    },
    {
      tipo: "rota",
      rotulo: "Rotas",
      emoji: "🛣️",
      // Apenas os selects de rota em grafia ANTIGA (a mesma de lojasRotas).
      // NAO inclui _ROTAS_PLANILHA (grafia canonica) nem avisoRota (canonico,
      // populado a parte): misturar as duas grafias duplicaria rotas.
      // "rotaFeita" era campo de texto livre e virou select. O texto livre tinha
      // produzido 57 grafias distintas para ~16 rotas reais, com 34 delas usadas
      // uma unica vez ("N. FLUMINENSE" x "NORTE FLUMINENSE",
      // "R. DOS LAGOS" x "R.LAGOS", "BAIXADA I + R. SERRANA" x
      // "BAIXADA I+R.SERRENA"): relatorio por rota saia picado em varias linhas
      // para a mesma rota.
      selects: ["ckRota", "rotaAtrasoSaida", "escalaRota", "rotaFeita"],
      grupos: [],
      arrays: () => [],
    },
    {
      tipo: "loja",
      rotulo: "Lojas",
      emoji: "🏬",
      // Entidade chave->rota (mapa lojasRotas), NAO lista plana: tratada a
      // parte (aplicarMapaLojas / renderLista / cadastrosAdicionar).
      mapa: true,
      selects: [],
      grupos: [],
      arrays: () => [],
    },
  ];

  let _linhas = []; // linhas vindas de /cadastros
  const _base = {}; // tipo -> array com a lista-base (retrato inicial)
  let _snapshotFeito = false;
  let _abaAtiva = "motorista";

  // ---------- loja: mapa chave->rota ----------
  // Pseudo-lojas: nomes de ROTA usados como chave em lojasRotas para classificar
  // extra-entregas (rota "EXTRA-ENTREGA"). NAO sao lojas reais -> ficam FORA da
  // UI de cadastro de loja e nunca sao editaveis/ocultaveis.
  const PSEUDO_LOJAS = new Set([
    "NORTE_FLUMINENSE", "ZONA_NORTE_I", "ZONA_NORTE_II", "ZONA_OESTE_I",
    "ZONA_OESTE_II", "ZONA_OESTE_IV", "ALTERNATIVA_I", "CENTRO_E_ZONA_SUL",
    "BAIXADA_II", "BAIXADA_III", "BAIXADA_I_REGIAO_SERRANA", "REGIAO_DOS_LAGOS",
  ]);

  // ---------- loja: ramal telefonico ----------
  // Espelho de cadastros.extra.ramal (o banco e a fonte). Global, do mesmo
  // jeito que lojasRotas, para qualquer tela poder consultar o ramal da loja.
  if (!window.lojasRamais) window.lojasRamais = {};
  const ramalDe = (chave) =>
    String((window.lojasRamais && window.lojasRamais[chave]) || "").trim();

  // Chip "Ramal" ao lado do campo Loja do formulario de ocorrencia: quem lanca
  // a ocorrencia quase sempre precisa ligar para a loja, e ate agora o numero
  // so existia no portal de telefonia da TI.
  function atualizarRamalLoja() {
    const box = document.getElementById("lojaRamalInfo");
    if (!box) return;
    const sel = document.getElementById("loja");
    const ramal = ramalDe(sel ? sel.value : "");
    const num = document.getElementById("lojaRamalNumero");
    if (num) num.textContent = ramal;
    box.style.display = ramal ? "flex" : "none";
  }
  window.atualizarRamalLoja = atualizarRamalLoja;

  const temMapaLojas = () =>
    typeof lojasRotas !== "undefined" && lojasRotas && typeof lojasRotas === "object";
  const fmtLoja = (k) =>
    typeof formatarNomeLoja === "function"
      ? formatarNomeLoja(k)
      : String(k).replaceAll("_", " ");
  // Texto digitado -> chave UPPER_SNAKE (padrao das chaves de lojasRotas).
  const lojaKey = (txt) =>
    String(txt || "").trim().toUpperCase().replace(/\s+/g, "_");

  // Rotas que uma loja pode receber = lista efetiva do tipo "rota".
  function rotasDisponiveis() {
    const r = efetivos("rota");
    if (r.length) return r;
    return temMapaLojas() ? [...new Set(Object.values(lojasRotas))] : [];
  }

  // Reconstroi <select id="loja"> a partir de lojasRotas (espelha script-7),
  // preservando a selecao atual. Chamado sempre que lojasRotas muda.
  function repopularSelectLoja() {
    const el = document.getElementById("loja");
    if (!el || !temMapaLojas()) return;
    const sel = el.value;
    el.innerHTML = '<option value="">Selecione a loja</option>';
    Object.keys(lojasRotas).forEach((l) => {
      const opt = document.createElement("option");
      opt.value = l;
      opt.textContent = fmtLoja(l);
      el.appendChild(opt);
    });
    if (sel && lojasRotas[sel] !== undefined) el.value = sel;
  }

  // Mescla as lojas cadastradas no banco DENTRO de lojasRotas (in-place) e
  // re-popula o #loja. So ADICIONA/atualiza (nunca remove loja-base do codigo):
  // o mapa continua sendo a fonte da classificacao loja->rota em ~15 telas.
  function aplicarMapaLojas() {
    // O ramal nao depende do mapa lojasRotas -> preenche sempre, antes do return.
    _linhas
      .filter((l) => l.tipo === "loja" && !l.oculto)
      .forEach((l) => {
        const ramal =
          l.extra && l.extra.ramal ? String(l.extra.ramal).trim() : "";
        if (ramal) window.lojasRamais[l.valor] = ramal;
        else delete window.lojasRamais[l.valor];
      });
    atualizarRamalLoja();
    if (!temMapaLojas()) return;
    _linhas
      .filter((l) => l.tipo === "loja" && !l.oculto)
      .forEach((l) => {
        const rota = l.extra && l.extra.rota ? l.extra.rota : lojasRotas[l.valor];
        if (rota) lojasRotas[l.valor] = rota;
      });
    repopularSelectLoja();
  }

  // ---------- helpers ----------
  const cfgDe = (tipo) => TIPOS.find((t) => t.tipo === tipo);

  // escapar() (script-1-core) cobre texto e atributo (& < > " ').
  function escHtml(v) {
    return escapar(v);
  }
  function escAttr(v) {
    return escapar(v);
  }

  function opcoesSelect(id) {
    const el = document.getElementById(id);
    if (!el) return [];
    return Array.from(el.options)
      .map((o) => o.value)
      .filter((v) => v && v.trim());
  }
  function valoresGrupo(grupo) {
    return Array.from(
      document.querySelectorAll(
        `input[type="checkbox"][data-multi-group="${grupo}"]`,
      ),
    )
      .map((c) => c.value)
      .filter(Boolean);
  }

  // Retrato das listas-base — feito UMA vez, antes de qualquer alteracao.
  function snapshotBase() {
    if (_snapshotFeito) return;
    TIPOS.forEach((cfg) => {
      const seen = new Set();
      const ordenada = [];
      const add = (v) => {
        v = String(v || "").trim();
        if (v && !seen.has(v)) {
          seen.add(v);
          ordenada.push(v);
        }
      };
      if (cfg.mapa) {
        // loja: base = chaves de lojasRotas (literal), menos as pseudo-lojas.
        if (temMapaLojas())
          Object.keys(lojasRotas).forEach((k) => {
            if (!PSEUDO_LOJAS.has(k)) add(k);
          });
      } else {
        (cfg.selects || []).forEach((id) => opcoesSelect(id).forEach(add));
        (cfg.grupos || []).forEach((g) => valoresGrupo(g).forEach(add));
        cfg.arrays().forEach((arr) => arr.forEach(add));
      }
      _base[cfg.tipo] = ordenada;
    });
    _snapshotFeito = true;
  }

  // Linha salva para um (tipo, valor), se existir.
  function linhaDe(tipo, valor) {
    return _linhas.find((l) => l.tipo === tipo && l.valor === valor);
  }

  // Lista efetiva de um tipo, preservando a ordem da base + adicionados no fim.
  function efetivos(tipo) {
    const adicionados = _linhas
      .filter((l) => l.tipo === tipo && !l.oculto)
      .map((l) => l.valor);
    const ocultos = new Set(
      _linhas.filter((l) => l.tipo === tipo && l.oculto).map((l) => l.valor),
    );
    const seen = new Set();
    const out = [];
    [...(_base[tipo] || []), ...adicionados].forEach((v) => {
      if (v && !ocultos.has(v) && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    });
    return out;
  }

  // ---------- aplicar nas telas ----------
  function aplicarSelect(id, valores) {
    const el = document.getElementById(id);
    if (!el) return;
    const alvo = new Set(valores);
    const existentes = new Map();
    Array.from(el.options).forEach((o) => {
      if (o.value) existentes.set(o.value, o);
    });
    // remove ocultos (nunca mexe no placeholder value="")
    existentes.forEach((opt, v) => {
      if (!alvo.has(v)) opt.remove();
    });
    // acrescenta novos no fim
    valores.forEach((v) => {
      if (!existentes.has(v)) {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = v;
        el.appendChild(opt);
      }
    });
  }

  function aplicarGrupoCheckbox(grupo, valores) {
    const checks = document.querySelectorAll(
      `input[type="checkbox"][data-multi-group="${grupo}"]`,
    );
    if (!checks.length) return;
    const primeiro = checks[0].closest("label");
    const container = primeiro && primeiro.parentNode;
    if (!container) return;
    const alvo = new Set(valores);
    const porValor = new Map();
    checks.forEach((c) => porValor.set(c.value, c.closest("label")));
    // remove ocultos
    porValor.forEach((label, v) => {
      if (!alvo.has(v) && label) label.remove();
    });
    // acrescenta novos
    valores.forEach((v) => {
      if (!porValor.has(v)) {
        const label = document.createElement("label");
        label.className = "multi-check-card";
        label.innerHTML =
          `<input type="checkbox" data-multi-group="${escAttr(grupo)}" value="${escAttr(v)}" /> ` +
          escHtml(v);
        container.appendChild(label);
      }
    });
    if (typeof sincronizarGrupoMulti === "function")
      sincronizarGrupoMulti(grupo);
  }

  function aplicarArray(arr, valores) {
    // substitui o conteudo mantendo a MESMA referencia (const arr.push/splice ok)
    arr.splice(0, arr.length, ...valores);
  }

  function aplicarCadastros() {
    snapshotBase();
    TIPOS.forEach((cfg) => {
      if (cfg.mapa) {
        aplicarMapaLojas();
        return;
      }
      const valores = efetivos(cfg.tipo);
      (cfg.selects || []).forEach((id) => aplicarSelect(id, valores));
      (cfg.grupos || []).forEach((g) => aplicarGrupoCheckbox(g, valores));
      cfg.arrays().forEach((arr) => aplicarArray(arr, valores));
    });
    // O TMS monta os selects de rota via JS a partir de lojasRotas, entao uma
    // rota nova (ainda sem loja) so aparece la se pedirmos a reconstrucao.
    try {
      if (typeof tmsAtualizarSelectsRota === "function")
        tmsAtualizarSelectsRota();
    } catch (e) {
      /* silencioso */
    }
    // Atualiza telas que montam selects via JS (ranking, TMS abre sozinho).
    try {
      if (typeof atualizarTodasAsViews === "function") atualizarTodasAsViews();
    } catch (e) {
      /* silencioso */
    }
  }

  // ---------- API ----------
  async function carregarCadastros() {
    try {
      const res = await fetch(`${API}/cadastros`, {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      });
      if (!res.ok) return false;
      const dados = await res.json();
      _linhas = Array.isArray(dados) ? dados : [];
      return true;
    } catch (err) {
      console.warn("[cadastros] falha ao carregar:", err);
      return false;
    }
  }

  async function salvarCadastro(tipo, valor, oculto, extra) {
    const corpo = { tipo, valor, oculto: !!oculto };
    if (extra && typeof extra === "object") corpo.extra = extra;
    const res = await fetch(`${API}/cadastros`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(corpo),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || "Erro ao salvar cadastro.");
    }
    const linha = await res.json();
    const i = _linhas.findIndex(
      (l) => l.tipo === linha.tipo && l.valor === linha.valor,
    );
    if (i >= 0) _linhas[i] = linha;
    else _linhas.push(linha);
    return linha;
  }

  async function removerCadastro(id) {
    const res = await fetch(`${API}/cadastros/${id}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    if (!res.ok && res.status !== 404) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || "Erro ao remover cadastro.");
    }
    _linhas = _linhas.filter((l) => String(l.id) !== String(id));
  }

  function avisar(msg, tipo) {
    if (typeof alertar === "function") return alertar(msg);
    if (typeof toast === "function") return toast(msg, tipo);
    console.log(msg);
  }

  // ---------- modal ----------
  function garantirModal() {
    if (document.getElementById("cadastrosModal")) return;
    const div = document.createElement("div");
    div.id = "cadastrosModal";
    div.style.cssText =
      "display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:1200;align-items:center;justify-content:center;padding:16px;";
    div.innerHTML = `
      <div style="background:var(--bg-card,#0f172a);border:1px solid var(--border,#334155);border-radius:16px;width:100%;max-width:560px;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,.5);">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 20px;border-bottom:1px solid var(--border,#334155);">
          <h3 style="margin:0;font-size:1rem;color:var(--text-heading,#f1f5f9);">👥 Cadastros — motoristas, placas, ajudantes, rotas e lojas</h3>
          <button type="button" onclick="fecharCadastrosModal()" aria-label="Fechar" style="background:none;border:none;color:var(--text-muted,#94a3b8);font-size:1.4rem;line-height:1;cursor:pointer;">×</button>
        </div>
        <div id="cadastrosTabs" style="display:flex;gap:6px;padding:14px 20px 0;flex-wrap:wrap;"></div>
        <div style="padding:14px 20px;display:flex;gap:8px;flex-wrap:wrap;">
          <input id="cadastrosInput" placeholder="Digite e clique em Adicionar" autocomplete="off"
            style="flex:1;min-width:120px;padding:10px 12px;border-radius:10px;border:1px solid var(--border,#334155);background:var(--bg-base,#0b1220);color:var(--text-heading,#f1f5f9);font-size:13px;text-transform:uppercase;" />
          <select id="cadastrosRotaLoja" title="Rota da loja"
            style="display:none;min-width:150px;padding:10px 12px;border-radius:10px;border:1px solid var(--border,#334155);background:var(--bg-base,#0b1220);color:var(--text-heading,#f1f5f9);font-size:13px;"></select>
          <input id="cadastrosRamalLoja" placeholder="Ramal" inputmode="numeric" autocomplete="off" title="Ramal telefonico da loja (opcional)"
            style="display:none;width:84px;padding:10px 12px;border-radius:10px;border:1px solid var(--border,#334155);background:var(--bg-base,#0b1220);color:var(--text-heading,#f1f5f9);font-size:13px;text-align:center;" />
          <button type="button" onclick="cadastrosAdicionar()" class="btn-blue"
            style="padding:8px 18px;border-radius:10px;white-space:nowrap;">➕ Adicionar</button>
        </div>
        <div id="cadastrosLista" style="padding:0 20px 20px;overflow:auto;"></div>
      </div>`;
    document.body.appendChild(div);
    // fecha ao clicar no fundo
    div.addEventListener("click", (e) => {
      if (e.target === div) fecharCadastrosModal();
    });
    // Enter no input adiciona
    div.querySelector("#cadastrosInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        cadastrosAdicionar();
      }
    });
    // Ramal por loja + filtro da aba Loja (delegacao no container fixo).
    const lista = div.querySelector("#cadastrosLista");
    lista.addEventListener("change", (e) => {
      const inp = e.target.closest("input[data-ramal-loja]");
      if (inp) acaoSalvarRamal(inp.dataset.ramalLoja, inp.value);
    });
    lista.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const inp = e.target.closest("input[data-ramal-loja]");
      if (inp) {
        e.preventDefault();
        inp.blur(); // dispara o change -> salva
      }
    });
    lista.addEventListener("input", (e) => {
      if (e.target.id === "cadastrosFiltroLoja")
        filtrarListaLoja(e.target.value);
    });
    // Acoes dos itens via delegacao (evita escaping em onclick com o valor).
    div.querySelector("#cadastrosLista").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-acao]");
      if (!btn) return;
      const acao = btn.dataset.acao;
      if (acao === "ocultar") acaoOcultar(btn.dataset.valor);
      else if (acao === "mostrar") acaoRemoverLinha(btn.dataset.id);
      else if (acao === "remover") acaoRemoverLinha(btn.dataset.id);
      else if (acao === "remover-loja")
        acaoRemoverLoja(btn.dataset.id, btn.dataset.valor);
    });
  }

  function renderTabs() {
    const tabs = document.getElementById("cadastrosTabs");
    tabs.innerHTML = TIPOS.map((cfg) => {
      const ativo = cfg.tipo === _abaAtiva;
      return `<button type="button" onclick="cadastrosTrocarAba('${cfg.tipo}')"
        style="flex:1;min-width:110px;padding:9px 10px;border-radius:10px;cursor:pointer;font-size:12px;font-weight:700;
        border:1px solid ${ativo ? "var(--azul,#38bdf8)" : "var(--border,#334155)"};
        background:${ativo ? "rgba(56,189,248,.14)" : "transparent"};
        color:${ativo ? "var(--azul,#38bdf8)" : "var(--text-secondary,#cbd5e1)"};">
        ${cfg.emoji} ${cfg.rotulo}</button>`;
    }).join("");
  }

  function renderLista() {
    const cfg = cfgDe(_abaAtiva);
    const box = document.getElementById("cadastrosLista");
    if (cfg && cfg.mapa) return renderListaLoja(box);
    const base = new Set(_base[_abaAtiva] || []);
    const ocultosSet = new Set(
      _linhas
        .filter((l) => l.tipo === _abaAtiva && l.oculto)
        .map((l) => l.valor),
    );
    // itens visiveis = efetivos; ocultos = os base escondidos
    const visiveis = efetivos(_abaAtiva);
    const ocultos = [...ocultosSet];

    const linhaItem = (valor, oculto) => {
      const custom = !base.has(valor); // adicionado pela UI
      const linha = linhaDe(_abaAtiva, valor);
      let btn;
      if (oculto) {
        // esta escondido -> botao mostrar (apaga a linha de ocultacao)
        btn = `<button type="button" data-acao="mostrar" data-id="${escAttr(linha ? linha.id : "")}" class="btn-sm"
          style="border:1px solid var(--verde,#22c55e);color:var(--verde,#22c55e);background:transparent;border-radius:8px;padding:4px 12px;cursor:pointer;font-size:11px;font-weight:700;">Mostrar</button>`;
      } else if (custom) {
        // adicionado -> remover de vez
        btn = `<button type="button" data-acao="remover" data-id="${escAttr(linha ? linha.id : "")}" class="btn-sm"
          style="border:1px solid var(--vermelho,#ef4444);color:var(--vermelho,#ef4444);background:transparent;border-radius:8px;padding:4px 12px;cursor:pointer;font-size:11px;font-weight:700;">Remover</button>`;
      } else {
        // base visivel -> ocultar
        btn = `<button type="button" data-acao="ocultar" data-valor="${escAttr(valor)}" class="btn-sm"
          style="border:1px solid var(--border,#334155);color:var(--text-muted,#94a3b8);background:transparent;border-radius:8px;padding:4px 12px;cursor:pointer;font-size:11px;font-weight:700;">Ocultar</button>`;
      }
      const tag = custom
        ? `<span style="font-size:9px;font-weight:800;letter-spacing:.5px;color:var(--azul,#38bdf8);background:rgba(56,189,248,.12);padding:2px 6px;border-radius:5px;margin-left:8px;">NOVO</span>`
        : "";
      return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 12px;border:1px solid var(--border,#334155);border-radius:10px;margin-bottom:6px;${oculto ? "opacity:.55;" : ""}">
        <span style="font-size:13px;color:var(--text-heading,#f1f5f9);font-weight:600;">${escHtml(valor)}${tag}${oculto ? ' <span style="font-size:10px;color:var(--text-muted,#94a3b8);">(oculto)</span>' : ""}</span>
        ${btn}</div>`;
    };

    const partes = [];
    partes.push(
      `<div style="font-size:11px;color:var(--text-muted,#94a3b8);text-transform:uppercase;letter-spacing:.6px;font-weight:700;margin:2px 0 8px;">${visiveis.length} ${cfg.rotulo.toLowerCase()} ativo(s)</div>`,
    );
    partes.push(visiveis.map((v) => linhaItem(v, false)).join(""));
    if (ocultos.length) {
      partes.push(
        `<div style="font-size:11px;color:var(--text-muted,#94a3b8);text-transform:uppercase;letter-spacing:.6px;font-weight:700;margin:14px 0 8px;">Ocultos</div>`,
      );
      partes.push(ocultos.map((v) => linhaItem(v, true)).join(""));
    }
    box.innerHTML = partes.join("");
  }

  // Render da aba Loja: cada loja com sua rota e o ramal (editavel ali mesmo).
  // Base do codigo = somente leitura (nunca ocultar/remover, para nao
  // reclassificar historico); lojas adicionadas pela UI podem ser removidas.
  // O filtro esconde/mostra linhas ja renderizadas (nao re-renderiza) para nao
  // perder o foco/cursor do campo de busca a cada tecla.
  function renderListaLoja(box) {
    const base = new Set(_base["loja"] || []);
    const lojas = efetivos("loja");
    const rotaDe = (v) => (temMapaLojas() ? lojasRotas[v] || "" : "");
    const semRamal = lojas.filter((v) => !ramalDe(v)).length;
    const item = (v) => {
      const custom = !base.has(v);
      const linha = linhaDe("loja", v);
      const btn = custom
        ? `<button type="button" data-acao="remover-loja" data-id="${escAttr(linha ? linha.id : "")}" data-valor="${escAttr(v)}" class="btn-sm"
            style="border:1px solid var(--vermelho,#ef4444);color:var(--vermelho,#ef4444);background:transparent;border-radius:8px;padding:4px 12px;cursor:pointer;font-size:11px;font-weight:700;">Remover</button>`
        : `<span style="font-size:10px;color:var(--text-muted,#94a3b8);">base</span>`;
      const tag = custom
        ? `<span style="font-size:9px;font-weight:800;letter-spacing:.5px;color:var(--azul,#38bdf8);background:rgba(56,189,248,.12);padding:2px 6px;border-radius:5px;margin-left:8px;">NOVA</span>`
        : "";
      const ramal = ramalDe(v);
      const busca = `${fmtLoja(v)} ${v} ${rotaDe(v)} ${ramal}`.toUpperCase();
      return `<div data-linha-loja="${escAttr(v)}" data-busca="${escAttr(busca)}"
        style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 12px;border:1px solid var(--border,#334155);border-radius:10px;margin-bottom:6px;">
        <span style="font-size:13px;color:var(--text-heading,#f1f5f9);font-weight:600;">${escHtml(fmtLoja(v))}${tag}
          <span style="font-size:10px;color:var(--text-muted,#94a3b8);font-weight:500;">— ${escHtml(rotaDe(v) || "?")}</span></span>
        <span style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
          <span style="font-size:11px;color:var(--text-muted,#94a3b8);" title="Ramal">&#9742;</span>
          <input type="text" inputmode="numeric" data-ramal-loja="${escAttr(v)}" value="${escAttr(ramal)}"
            placeholder="ramal" title="Ramal telefonico da loja — salva ao sair do campo"
            style="width:70px;padding:5px 8px;border-radius:8px;border:1px solid var(--border,#334155);background:var(--bg-base,#0b1220);color:var(--text-heading,#f1f5f9);font-size:12px;font-weight:700;text-align:center;" />
          ${btn}
        </span></div>`;
    };
    box.innerHTML =
      `<input id="cadastrosFiltroLoja" type="search" placeholder="Filtrar por loja, rota ou ramal" autocomplete="off"
        style="width:100%;box-sizing:border-box;padding:9px 12px;border-radius:10px;border:1px solid var(--border,#334155);background:var(--bg-base,#0b1220);color:var(--text-heading,#f1f5f9);font-size:13px;margin:2px 0 8px;" />` +
      `<div style="font-size:11px;color:var(--text-muted,#94a3b8);text-transform:uppercase;letter-spacing:.6px;font-weight:700;margin:2px 0 8px;">
        <span id="cadastrosContaLoja">${lojas.length}</span> lojas • ${semRamal} sem ramal • ramal salva ao sair do campo</div>` +
      lojas.map(item).join("");
  }

  // Filtro da aba Loja: so liga/desliga as linhas ja no DOM.
  function filtrarListaLoja(termo) {
    const box = document.getElementById("cadastrosLista");
    if (!box) return;
    const t = String(termo || "").trim().toUpperCase();
    let n = 0;
    box.querySelectorAll("[data-linha-loja]").forEach((el) => {
      const ok = !t || (el.dataset.busca || "").includes(t);
      el.style.display = ok ? "" : "none";
      if (ok) n++;
    });
    const conta = document.getElementById("cadastrosContaLoja");
    if (conta) conta.textContent = String(n);
  }

  // Salva o ramal de UMA loja. Reenvia a ROTA junto de proposito: o servidor
  // novo mescla o extra, mas o antigo o SUBSTITUI — mandar so { ramal } apagaria
  // a rota da loja enquanto o servidor nao for reiniciado. Ramal vazio limpa o
  // campo. Nao re-renderiza a lista (nao perde o filtro digitado).
  async function acaoSalvarRamal(chave, valor) {
    const ramal = String(valor || "").trim();
    if (ramalDe(chave) === ramal) return; // nada mudou
    const rotaAtual = temMapaLojas() ? lojasRotas[chave] || "" : "";
    const extra = rotaAtual ? { rota: rotaAtual, ramal } : { ramal };
    try {
      await salvarCadastro("loja", chave, false, extra);
      if (ramal) window.lojasRamais[chave] = ramal;
      else delete window.lojasRamais[chave];
      atualizarRamalLoja();
      const linha = document.querySelector(
        `[data-linha-loja="${CSS.escape(chave)}"]`,
      );
      if (linha) {
        const rota = temMapaLojas() ? lojasRotas[chave] || "" : "";
        linha.dataset.busca =
          `${fmtLoja(chave)} ${chave} ${rota} ${ramal}`.toUpperCase();
      }
      avisar(
        ramal
          ? `✅ Ramal ${ramal} salvo para ${fmtLoja(chave)}.`
          : `✅ Ramal de ${fmtLoja(chave)} apagado.`,
        "success",
      );
    } catch (err) {
      avisar("❌ " + err.message, "error");
    }
  }

  // Ajusta input/seletor conforme a aba: loja mostra o seletor de rota e pede
  // o nome da loja; os demais escondem o seletor.
  function atualizarControlesAba() {
    const inp = document.getElementById("cadastrosInput");
    const selRota = document.getElementById("cadastrosRotaLoja");
    const inpRamal = document.getElementById("cadastrosRamalLoja");
    const ehLoja = _abaAtiva === "loja";
    if (inpRamal) inpRamal.style.display = ehLoja ? "" : "none";
    if (selRota) {
      selRota.style.display = ehLoja ? "" : "none";
      if (ehLoja) {
        const atual = selRota.value;
        const rotas = rotasDisponiveis();
        selRota.innerHTML =
          '<option value="">Rota…</option>' +
          rotas
            .map((r) => `<option value="${escAttr(r)}">${escHtml(r)}</option>`)
            .join("");
        if (atual && rotas.includes(atual)) selRota.value = atual;
      }
    }
    if (inp)
      inp.placeholder = ehLoja
        ? "Nome da loja + rota (ramal opcional)"
        : "Digite e clique em Adicionar";
  }

  function renderModal() {
    renderTabs();
    renderLista();
    atualizarControlesAba();
  }

  // ---------- acoes (globais p/ onclick) ----------
  window.abrirCadastrosModal = function () {
    garantirModal();
    document.getElementById("cadastrosModal").style.display = "flex";
    const inp = document.getElementById("cadastrosInput");
    renderModal();
    // recarrega do servidor pra refletir mudancas de outros usuarios
    carregarCadastros().then(() => renderModal());
    setTimeout(() => inp && inp.focus(), 50);
  };

  window.fecharCadastrosModal = function () {
    const m = document.getElementById("cadastrosModal");
    if (m) m.style.display = "none";
  };

  window.cadastrosTrocarAba = function (tipo) {
    _abaAtiva = tipo;
    renderModal();
    const inp = document.getElementById("cadastrosInput");
    if (inp) inp.focus();
  };

  window.cadastrosAdicionar = async function () {
    if (_abaAtiva === "loja") return cadastrosAdicionarLoja();
    const inp = document.getElementById("cadastrosInput");
    const valor = String(inp.value || "").trim().toUpperCase();
    if (!valor) return;
    if (efetivos(_abaAtiva).includes(valor)) {
      avisar("⚠️ Esse item já está na lista.", "info");
      inp.value = "";
      return;
    }
    try {
      await salvarCadastro(_abaAtiva, valor, false);
      inp.value = "";
      aplicarCadastros();
      renderModal();
      avisar(`✅ "${valor}" cadastrado.`, "success");
    } catch (err) {
      avisar("❌ " + err.message, "error");
    }
  };

  // Adicionar loja = nome (vira chave UPPER_SNAKE) + rota escolhida. Grava no
  // banco (extra.rota), atualiza lojasRotas e re-popula os selects de loja.
  async function cadastrosAdicionarLoja() {
    const inp = document.getElementById("cadastrosInput");
    const selRota = document.getElementById("cadastrosRotaLoja");
    const inpRamal = document.getElementById("cadastrosRamalLoja");
    const chave = lojaKey(inp && inp.value);
    const rota = selRota ? String(selRota.value || "").trim() : "";
    const ramal = inpRamal ? String(inpRamal.value || "").trim() : "";
    if (!chave) return avisar("⚠️ Digite o nome da loja.", "info");
    if (!rota) return avisar("⚠️ Escolha a rota da loja.", "info");
    if (PSEUDO_LOJAS.has(chave))
      return avisar("⚠️ Esse nome é reservado para classificação de rota.", "info");
    if (
      efetivos("loja").includes(chave) ||
      (temMapaLojas() && lojasRotas[chave] !== undefined)
    )
      return avisar("⚠️ Essa loja já existe.", "info");
    try {
      await salvarCadastro(
        "loja",
        chave,
        false,
        ramal ? { rota, ramal } : { rota },
      );
      if (temMapaLojas()) lojasRotas[chave] = rota;
      if (ramal) window.lojasRamais[chave] = ramal;
      if (inp) inp.value = "";
      if (inpRamal) inpRamal.value = "";
      aplicarCadastros();
      renderModal();
      avisar(`✅ Loja "${fmtLoja(chave)}" (${rota}) cadastrada.`, "success");
    } catch (err) {
      avisar("❌ " + err.message, "error");
    }
  }

  async function acaoOcultar(valor) {
    if (!valor) return;
    try {
      await salvarCadastro(_abaAtiva, valor, true);
      aplicarCadastros();
      renderModal();
    } catch (err) {
      avisar("❌ " + err.message, "error");
    }
  }

  // Usada tanto para "Mostrar" (desfaz ocultacao) quanto "Remover" (apaga
  // valor adicionado): ambas apenas apagam a linha por id.
  async function acaoRemoverLinha(id) {
    if (!id) return;
    try {
      await removerCadastro(id);
      aplicarCadastros();
      renderModal();
    } catch (err) {
      avisar("❌ " + err.message, "error");
    }
  }

  // Remove uma loja ADICIONADA pela UI: apaga a linha do banco e a chave do
  // mapa lojasRotas (nunca remove loja-base do codigo). Re-popula os selects.
  async function acaoRemoverLoja(id, valor) {
    try {
      if (id) await removerCadastro(id);
      if (valor && temMapaLojas() && !(_base["loja"] || []).includes(valor))
        delete lojasRotas[valor];
      aplicarCadastros();
      renderModal();
    } catch (err) {
      avisar("❌ " + err.message, "error");
    }
  }

  // Exposto para uso interno/depuracao.
  window.aplicarCadastros = aplicarCadastros;

  // Lista efetiva de um tipo (base + adicionados - ocultos), para as telas que
  // montam os proprios selects via JS e nao aparecem em TIPOS[].selects
  // (ex.: TMS, que precisa das rotas cadastradas).
  window.cadastrosLista = function (tipo) {
    // Nunca tira o retrato da base com o DOM incompleto: o snapshot e unico e
    // ficaria faltando as opcoes dos selects que ainda nao foram parseados.
    if (document.readyState !== "loading") snapshotBase();
    return efetivos(tipo);
  };

  // ---------- inicializacao ----------
  document.addEventListener("DOMContentLoaded", () => {
    // Retrato da base assim que o DOM esta pronto (antes de qualquer edicao).
    snapshotBase();

    // Chip do ramal: o "change" cobre tanto a escolha manual quanto o
    // preencherCampo() da edicao (ele dispara change de proposito).
    const selLoja = document.getElementById("loja");
    if (selLoja) selLoja.addEventListener("change", atualizarRamalLoja);
    const chip = document.getElementById("lojaRamalInfo");
    if (chip)
      chip.addEventListener("click", () => {
        const n = document.getElementById("lojaRamalNumero");
        const txt = n ? n.textContent.trim() : "";
        if (!txt || !navigator.clipboard) return;
        navigator.clipboard
          .writeText(txt)
          .then(() => avisar(`📋 Ramal ${txt} copiado.`, "success"))
          .catch(() => {});
      });

    // Tenta carregar do servidor. Antes do login o GET responde 401 (ok=false):
    // nesse caso re-tenta a cada 4s ate a sessao existir, aplica uma vez e para.
    // As listas-base ja funcionam desde o inicio (estao no HTML/arrays).
    let tentativas = 0;
    const tentarCarregar = () => {
      carregarCadastros().then((ok) => {
        if (ok) {
          aplicarCadastros();
          return;
        }
        if (++tentativas < 30) setTimeout(tentarCarregar, 4000);
      });
    };
    tentarCarregar();
  });
})();
