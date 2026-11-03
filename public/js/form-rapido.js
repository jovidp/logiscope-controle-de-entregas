// ================================================================
// FORMULÁRIO DE OCORRÊNCIA — MODO RÁPIDO
// ----------------------------------------------------------------
// Só front, sem mexer no que é salvo. Quatro coisas:
//
// 1. Grupos de checkbox longos (ajudantes, tipo da ocorrência, setor
//    responsável) ganham um seletor compacto: os marcados viram chips
//    (× desmarca) e uma busca filtra a grade — digitar "ped" + Enter
//    marca o primeiro PEDRO. Os nomes dos AJUDANTES começam ocultos:
//    a grade só aparece enquanto se digita ou com "Mostrar nomes".
//    A escolha (mostrar/ocultar) fica lembrada no navegador.
//    Os checkboxes continuam sendo a fonte da verdade: o seletor só
//    marca/desmarca e dispara "change", que o script-4 já sincroniza.
//
// 2. Cada seção abre/fecha clicando no título (lembrado no navegador).
//    Seção fechada mostra "N preenchidos" para nada ficar esquecido.
//
// 3. Barra de seções fixa no topo do formulário: pula direto para a
//    seção e marca ✓ nas que já têm algo preenchido.
//
// 4. Ctrl+Enter salva o registro de qualquer campo do formulário.
// ================================================================
(function () {
  "use strict";

  const LS = "controleEntregaFormRapido:";
  const GRUPOS = {
    ajudantes: { ocultoPadrao: true, item: "nomes", placeholder: "Digite o nome do ajudante… (Enter marca)" },
    tipoOcorrencia: { ocultoPadrao: false, item: "lista", placeholder: "Filtrar tipo… (Enter marca)" },
    ocorrenciaResponsavel: { ocultoPadrao: false, item: "lista", placeholder: "Filtrar setor… (Enter marca)" },
  };

  const ler = (k, padrao) => {
    try {
      const v = localStorage.getItem(LS + k);
      return v === null ? padrao : v === "1";
    } catch (_) {
      return padrao;
    }
  };
  const gravar = (k, v) => {
    try {
      localStorage.setItem(LS + k, v ? "1" : "0");
    } catch (_) {}
  };
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const normalizar = (s) =>
    String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

  const form = () => document.getElementById("form");

  // ---------------------------------------------------------------
  // 1. Seletor compacto dos grupos de checkbox
  // ---------------------------------------------------------------
  function checks(grupo) {
    const f = form();
    return f ? Array.from(f.querySelectorAll(`input[type="checkbox"][data-multi-group="${grupo}"]`)) : [];
  }

  function gradeDo(grupo) {
    const c = checks(grupo)[0];
    return c ? c.closest(".multi-check-grid") : null;
  }

  function montarSeletor(grupo) {
    const grade = gradeDo(grupo);
    if (!grade || grade.dataset.frSeletor) return;
    grade.dataset.frSeletor = grupo;
    const cfg = GRUPOS[grupo];

    const caixa = document.createElement("div");
    caixa.className = "fr-seletor";
    caixa.dataset.frGrupo = grupo;
    caixa.setAttribute("data-sem-pulo", "");
    caixa.innerHTML = `
      <div class="fr-chips" aria-live="polite"></div>
      <div class="fr-seletor-linha">
        <input type="text" class="fr-busca" id="frBusca_${grupo}" autocomplete="off" placeholder="🔎 ${esc(cfg.placeholder)}" />
        <button type="button" class="fr-mostrar"></button>
      </div>`;
    grade.parentNode.insertBefore(caixa, grade);

    const contador = document.querySelector(`[data-multi-count="${grupo}"]`);
    if (contador) contador.classList.add("fr-contador-oculto");

    const busca = caixa.querySelector(".fr-busca");
    busca.addEventListener("input", () => filtrar(grupo));
    busca.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const alvo = visiveis(grupo).find((c) => !c.checked) || null;
        if (alvo) marcar(alvo, true);
        busca.value = "";
        filtrar(grupo);
      } else if (e.key === "Escape") {
        busca.value = "";
        filtrar(grupo);
      }
    });
    caixa.querySelector(".fr-mostrar").addEventListener("click", () => {
      gravar("oculto:" + grupo, !estaOculto(grupo));
      filtrar(grupo);
    });
    caixa.querySelector(".fr-chips").addEventListener("click", (e) => {
      const x = e.target.closest("[data-fr-desmarcar]");
      if (!x) return;
      const c = checks(grupo).find((el) => el.value === x.dataset.frDesmarcar);
      if (c) marcar(c, false);
    });

    filtrar(grupo);
    renderChips(grupo);
  }

  function estaOculto(grupo) {
    return ler("oculto:" + grupo, GRUPOS[grupo].ocultoPadrao);
  }

  function visiveis(grupo) {
    return checks(grupo).filter((c) => {
      const card = c.closest("label");
      return card && card.style.display !== "none";
    });
  }

  function marcar(checkbox, valor) {
    if (checkbox.checked === valor) return;
    checkbox.checked = valor;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function filtrar(grupo) {
    const grade = gradeDo(grupo);
    const caixa = form()?.querySelector(`.fr-seletor[data-fr-grupo="${grupo}"]`);
    if (!grade || !caixa) return;
    const termo = normalizar(caixa.querySelector(".fr-busca").value);
    const oculto = estaOculto(grupo);
    let achados = 0;
    checks(grupo).forEach((c) => {
      const card = c.closest("label");
      if (!card) return;
      const bate = !termo || normalizar(card.textContent).includes(termo);
      card.style.display = bate ? "" : "none";
      if (bate) achados++;
    });
    // Ajudantes ocultos: a grade só aparece enquanto há busca.
    grade.style.display = oculto && !termo ? "none" : "";
    grade.classList.toggle("fr-grade-vazia", achados === 0);
    const btn = caixa.querySelector(".fr-mostrar");
    const item = GRUPOS[grupo].item;
    btn.textContent = oculto ? `👁 Mostrar ${item}` : `🙈 Ocultar ${item}`;
    btn.title = oculto ? "Mostrar a lista completa" : "Esconder a lista (busque pelo nome)";
  }

  function renderChips(grupo) {
    const caixa = form()?.querySelector(`.fr-seletor[data-fr-grupo="${grupo}"]`);
    if (!caixa) return;
    const marcados = checks(grupo).filter((c) => c.checked);
    caixa.querySelector(".fr-chips").innerHTML = marcados.length
      ? marcados
          .map(
            (c) =>
              `<span class="fr-chip">${esc(c.closest("label")?.textContent.trim() || c.value)}` +
              `<button type="button" data-fr-desmarcar="${esc(c.value)}" title="Desmarcar" aria-label="Desmarcar ${esc(c.value)}">×</button></span>`,
          )
          .join("")
      : `<span class="fr-chips-vazio">Nenhum selecionado</span>`;
  }

  // O script-4 centraliza tudo em sincronizarGrupoMulti (clique, edição,
  // escala automática, cadastros.js). Embrulhar ali mantém os chips em dia
  // sem depender de onde a marcação veio.
  function embrulharSincronizacao() {
    if (typeof window.sincronizarGrupoMulti !== "function" || window.sincronizarGrupoMulti._fr) return;
    const original = window.sincronizarGrupoMulti;
    const embrulhada = function (grupo) {
      const r = original.apply(this, arguments);
      if (GRUPOS[grupo]) {
        try {
          if (!gradeDo(grupo)?.dataset.frSeletor) montarSeletor(grupo);
          renderChips(grupo);
          filtrar(grupo); // cadastros.js pode ter criado cartões novos
        } catch (_) {}
      }
      agendarResumo();
      return r;
    };
    embrulhada._fr = true;
    window.sincronizarGrupoMulti = embrulhada;
  }

  // ---------------------------------------------------------------
  // 2 + 3. Seções recolhíveis e barra de navegação
  // ---------------------------------------------------------------
  function secoes() {
    const corpo = form()?.querySelector("[data-pular-campos]");
    if (!corpo) return [];
    return Array.from(corpo.children).filter(
      (s) =>
        s.tagName === "DIV" &&
        s.id !== "secaoWmsForm" && // já tem o próprio Expandir
        !s.dataset.moduloFuturo &&
        s.style.display !== "none" &&
        s.firstElementChild &&
        /border-bottom/.test(s.firstElementChild.getAttribute("style") || ""),
    );
  }

  function tituloDe(secao) {
    const t = secao.firstElementChild.querySelector('div[style*="uppercase"]');
    return t ? t.textContent.trim() : "Seção";
  }

  function chaveDe(secao) {
    return "secao:" + normalizar(tituloDe(secao)).replace(/[^a-z0-9]+/g, "-");
  }

  function contarPreenchidos(secao) {
    let n = 0;
    Array.from(secao.children).slice(1).forEach((bloco) => {
      bloco.querySelectorAll("input, select, textarea").forEach((el) => {
        if (el.closest(".fr-seletor")) return;
        if (el.classList.contains("select-search-input")) return; // espelho do select
        if (el.classList.contains("hidden-native-select")) return; // espelho dos checkboxes
        if (el.tagName === "SELECT") {
          if (el.selectedIndex > 0) n++;
        } else if (el.type === "checkbox" || el.type === "radio") {
          if (el.checked) n++;
        } else if (el.type === "file") {
          if (el.files && el.files.length) n++;
        } else if (el.type !== "hidden" && String(el.value || "").trim()) {
          n++;
        }
      });
    });
    return n;
  }

  function aplicarRecolhida(secao, recolhida) {
    secao.classList.toggle("fr-recolhida", recolhida);
    const cab = secao.firstElementChild;
    cab.setAttribute("aria-expanded", String(!recolhida));
    const seta = cab.querySelector(".fr-seta");
    if (seta) seta.textContent = recolhida ? "▸" : "▾";
  }

  function montarSecoes() {
    const lista = secoes();
    lista.forEach((secao, i) => {
      if (secao.dataset.frSecao) return;
      secao.dataset.frSecao = String(i);
      const cab = secao.firstElementChild;
      cab.classList.add("fr-cabecalho");
      cab.setAttribute("role", "button");
      cab.setAttribute("tabindex", "0");
      cab.title = "Clique para recolher/expandir";
      cab.insertAdjacentHTML("beforeend", `<span class="fr-preenchidos"></span><span class="fr-seta" aria-hidden="true">▾</span>`);
      const alternar = () => {
        const recolher = !secao.classList.contains("fr-recolhida");
        aplicarRecolhida(secao, recolher);
        gravar(chaveDe(secao), recolher);
        agendarResumo();
      };
      cab.addEventListener("click", (e) => {
        if (e.target.closest("button, input, select, a")) return;
        alternar();
      });
      cab.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          alternar();
        }
      });
      aplicarRecolhida(secao, ler(chaveDe(secao), false));
    });

    // "6 seções" estava fixo no HTML e já não batia.
    const selo = form()?.querySelector('span[style*="letter-spacing: 1px"]');
    if (selo && /se[cç][oõ]es/i.test(selo.textContent)) selo.textContent = `${lista.length} seções`;

    montarBarra(lista);
  }

  function montarBarra(lista) {
    const corpo = form()?.querySelector("[data-pular-campos]");
    if (!corpo || corpo.querySelector(".fr-barra")) return;
    const barra = document.createElement("nav");
    barra.className = "fr-barra";
    barra.setAttribute("data-sem-pulo", "");
    barra.setAttribute("aria-label", "Seções do formulário");
    barra.innerHTML =
      lista
        .map((s, i) => {
          const num = s.firstElementChild.firstElementChild?.textContent.trim() || String(i + 1);
          return `<button type="button" class="fr-barra-item" data-fr-ir="${i}" title="${esc(tituloDe(s))}"><b>${esc(num)}</b> ${esc(tituloDe(s))}</button>`;
        })
        .join("") +
      `<span class="fr-barra-acoes">
         <button type="button" class="fr-barra-acao" data-fr-todas="abrir" title="Expandir todas">▾ todas</button>
         <button type="button" class="fr-barra-acao" data-fr-todas="vazias" title="Recolher as seções ainda vazias">▸ vazias</button>
       </span>`;
    corpo.insertBefore(barra, corpo.firstChild);

    barra.addEventListener("click", (e) => {
      const ir = e.target.closest("[data-fr-ir]");
      if (ir) {
        const secao = secoes()[Number(ir.dataset.frIr)];
        if (!secao) return;
        aplicarRecolhida(secao, false);
        gravar(chaveDe(secao), false);
        const topo = secao.getBoundingClientRect().top + window.scrollY - alturaFixa() - barra.offsetHeight - 8;
        window.scrollTo({ top: topo, behavior: "smooth" });
        const primeiro = secao.querySelector(
          "input:not([type=hidden]):not(.select-search-native), select:not(.select-search-native):not(.hidden-native-select), textarea",
        );
        setTimeout(() => primeiro && primeiro.offsetParent && primeiro.focus({ preventScroll: true }), 350);
        agendarResumo();
        return;
      }
      const todas = e.target.closest("[data-fr-todas]");
      if (todas) {
        secoes().forEach((s) => {
          const recolher = todas.dataset.frTodas === "vazias" ? contarPreenchidos(s) === 0 : false;
          aplicarRecolhida(s, recolher);
          gravar(chaveDe(s), recolher);
        });
        agendarResumo();
      }
    });
  }

  function alturaFixa() {
    const h = document.querySelector(".app-header");
    return h ? h.getBoundingClientRect().height : 0;
  }

  let _timerResumo = null;
  function agendarResumo() {
    clearTimeout(_timerResumo);
    _timerResumo = setTimeout(atualizarResumo, 120);
  }

  function atualizarResumo() {
    const f = form();
    if (!f || f.classList.contains("hidden")) return;
    f.style.setProperty("--fr-topo", alturaFixa() + "px");
    const barra = f.querySelector(".fr-barra");
    secoes().forEach((s, i) => {
      const n = contarPreenchidos(s);
      const rotulo = s.firstElementChild.querySelector(".fr-preenchidos");
      if (rotulo) rotulo.textContent = s.classList.contains("fr-recolhida") && n ? `${n} preenchido${n > 1 ? "s" : ""}` : "";
      const item = barra && barra.querySelector(`[data-fr-ir="${i}"]`);
      if (item) {
        item.classList.toggle("fr-ok", n > 0);
        item.classList.toggle("fr-fechada", s.classList.contains("fr-recolhida"));
      }
    });
  }

  // ---------------------------------------------------------------
  // Liga tudo
  // ---------------------------------------------------------------
  function iniciar() {
    const f = form();
    if (!f) return;
    embrulharSincronizacao();
    Object.keys(GRUPOS).forEach(montarSeletor);
    montarSecoes();

    f.addEventListener("input", agendarResumo);
    f.addEventListener("change", agendarResumo);

    // 4. Ctrl+Enter salva
    f.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && typeof window.salvar === "function") {
        e.preventDefault();
        window.salvar();
      }
    });

    // Abrir/limpar/editar trocam valores por código (sem evento): reavalia
    // quando o form aparece e depois de cada clique nos botões do rodapé.
    new MutationObserver(agendarResumo).observe(f, { attributes: true, attributeFilter: ["class"] });
    document.addEventListener("click", () => {
      if (!f.classList.contains("hidden")) setTimeout(agendarResumo, 300);
    });
    agendarResumo();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(iniciar, 0));
  } else {
    setTimeout(iniciar, 0);
  }
})();
