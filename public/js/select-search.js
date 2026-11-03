(function () {
  const INSTANCIAS = new WeakMap();

  function normalizar(valor) {
    return String(valor || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  function textoSelecionado(select) {
    const option = select.options[select.selectedIndex];
    return option ? option.textContent.trim() : "";
  }

  function fechar(instancia) {
    instancia.wrapper.classList.remove("aberto");
    instancia.input.setAttribute("aria-expanded", "false");
    instancia.input.value = textoSelecionado(instancia.select);
  }

  function escolher(instancia, option) {
    const alterou = instancia.select.value !== option.value;
    instancia.select.value = option.value;
    instancia.input.value = option.textContent.trim();
    fechar(instancia);

    if (alterou) {
      instancia.select.dispatchEvent(new Event("input", { bubbles: true }));
      instancia.select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function renderizarOpcoes(instancia, termo) {
    const busca = normalizar(termo);
    instancia.lista.replaceChildren();
    let total = 0;

    Array.from(instancia.select.options).forEach(function (option) {
      if (
        busca &&
        !normalizar(option.textContent).includes(busca) &&
        !normalizar(option.value).includes(busca)
      ) {
        return;
      }

      const item = document.createElement("button");
      item.type = "button";
      item.className = "select-search-option";
      item.textContent = option.textContent;
      item.disabled = option.disabled;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(option.selected));
      item.addEventListener("click", function () {
        escolher(instancia, option);
      });
      instancia.lista.append(item);
      total += 1;
    });

    if (!total) {
      const vazio = document.createElement("div");
      vazio.className = "select-search-empty";
      vazio.textContent = "Nenhuma opção encontrada";
      instancia.lista.append(vazio);
    }
  }

  function abrir(instancia, limparBusca) {
    if (instancia.select.disabled) return;
    if (limparBusca) instancia.input.value = "";
    renderizarOpcoes(instancia, instancia.input.value);
    instancia.wrapper.classList.add("aberto");
    instancia.input.setAttribute("aria-expanded", "true");
  }

  function sincronizar(instancia) {
    instancia.input.disabled = instancia.select.disabled;
    if (!instancia.wrapper.classList.contains("aberto")) {
      instancia.input.value = textoSelecionado(instancia.select);
    } else {
      renderizarOpcoes(instancia, instancia.input.value);
    }
  }

  function habilitarPesquisa(select) {
    if (
      !select ||
      select.dataset.pesquisaAtiva === "true" ||
      select.multiple ||
      select.classList.contains("hidden-native-select") ||
      select.hasAttribute("data-sem-pesquisa")
    ) {
      return;
    }

    select.dataset.pesquisaAtiva = "true";
    select.classList.add("select-search-native");

    const wrapper = document.createElement("div");
    wrapper.className = "select-search-wrap";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "select-search-input";
    select.classList.forEach(function (classe) {
      if (classe !== "select-search-native") input.classList.add(classe);
    });
    input.style.cssText = select.style.cssText;
    input.autocomplete = "off";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-haspopup", "listbox");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-label", select.getAttribute("aria-label") || "Pesquisar e selecionar opção");

    const seta = document.createElement("span");
    seta.className = "select-search-arrow";
    seta.setAttribute("aria-hidden", "true");

    const lista = document.createElement("div");
    lista.className = "select-search-options";
    lista.setAttribute("role", "listbox");

    select.before(wrapper);
    wrapper.append(input, seta, lista, select);

    const instancia = { select: select, wrapper: wrapper, input: input, lista: lista };
    INSTANCIAS.set(select, instancia);
    sincronizar(instancia);

    input.addEventListener("focus", function () {
      input.select();
      abrir(instancia, true);
    });

    input.addEventListener("click", function () {
      if (!wrapper.classList.contains("aberto")) abrir(instancia, true);
    });

    input.addEventListener("input", function () {
      abrir(instancia, false);
    });

    seta.addEventListener("mousedown", function (event) {
      event.preventDefault();
      input.focus();
    });

    select.addEventListener("focus", function () {
      input.focus();
    });
    select.addEventListener("change", function () {
      sincronizar(instancia);
    });
  }

  function habilitarNoContainer(container) {
    if (container.matches && container.matches("select")) habilitarPesquisa(container);
    if (container.querySelectorAll) container.querySelectorAll("select").forEach(habilitarPesquisa);
  }

  function iniciar() {
    habilitarNoContainer(document);

    document.addEventListener("mousedown", function (event) {
      document.querySelectorAll(".select-search-wrap.aberto").forEach(function (wrapper) {
        if (!wrapper.contains(event.target)) {
          const select = wrapper.querySelector("select");
          fechar(INSTANCIAS.get(select));
        }
      });
    });

    const observer = new MutationObserver(function (mudancas) {
      mudancas.forEach(function (mudanca) {
        mudanca.addedNodes.forEach(function (node) {
          if (node.nodeType === Node.ELEMENT_NODE) habilitarNoContainer(node);
        });

        const select = mudanca.target.closest ? mudanca.target.closest("select") : null;
        if (select && INSTANCIAS.has(select)) sincronizar(INSTANCIAS.get(select));
      });
    });

    observer.observe(document.body, { childList: true, subtree: true });

    window.setInterval(function () {
      document.querySelectorAll("select[data-pesquisa-ativa='true']").forEach(function (select) {
        const instancia = INSTANCIAS.get(select);
        if (instancia && !instancia.wrapper.classList.contains("aberto")) {
          sincronizar(instancia);
        }
      });
    }, 300);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", iniciar);
  } else {
    iniciar();
  }
})();
