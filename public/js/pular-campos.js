// ================================================================
// PULO AUTOMÁTICO ENTRE CAMPOS
// O preenchimento anda sozinho, na ordem da tela:
//   • <select>: ao escolher a opção o foco já vai pro próximo campo
//     — escolher é uma ação completa, dá pra pular sem risco.
//   • campo digitado: Enter vai pro próximo. De propósito NÃO pula
//     ao digitar: em "25" não dá pra saber se o valor terminou no
//     "2" ou no "5". Tab continua funcionando como sempre.
//   • textarea: Enter segue quebrando linha; sai com Tab.
//
// ONDE VALE: dentro de <form> e de qualquer bloco marcado com
// [data-pular-campos] (o formulário de ocorrência e os modais).
// Fora disso o Enter continua fazendo o que sempre fez — é o que
// impede o foco de escapar pro menu ou pro topo da tela.
// Para isentar um trecho: [data-sem-pulo].
//
// Num <form>, o Enter no ÚLTIMO campo NÃO é capturado: continua
// salvando, que é o que já se espera de um formulário.
//
// Campo escondido (.hidden) é pulado — quando o select não revela o
// relato, o foco cai direto no bloco seguinte.
//
// Detalhe: o select-search.js embrulha TODO <select> da página. O
// <select> real vira 1px fora da tela (.select-search-native) e quem
// aparece é um input de busca — é nele que o foco precisa cair.
// ================================================================
(function () {
  "use strict";

  var ESCOPO = "[data-pular-campos], form";

  // Busca e filtro não fazem parte de sequência de preenchimento:
  // nem servem de origem do pulo, nem devem receber o foco.
  var BUSCA = /busca|filtro|pesquis/i;

  // Tipos que não são "campo a preencher".
  var TIPOS_FORA = {
    hidden: 1,
    submit: 1,
    button: 1,
    reset: 1,
    image: 1,
  };

  function ehBusca(el) {
    return BUSCA.test((el.id || "") + " " + (el.name || ""));
  }

  function utilizavel(el) {
    if (el.disabled || el.readOnly) return false;
    if (el.tabIndex === -1) return false;
    if (el.tagName === "INPUT" && TIPOS_FORA[(el.getAttribute("type") || "text").toLowerCase()]) {
      return false;
    }
    // O select real do select-search não entra: o input de busca que
    // o representa já está na lista, na mesma posição.
    if (el.classList.contains("select-search-native")) return false;
    if (ehBusca(el)) return false;
    if (el.closest("[data-sem-pulo]")) return false;
    // offsetParent nulo = escondido por .hidden (display:none) ou por
    // um bloco/modal fechado.
    return el.offsetParent !== null;
  }

  function campos(escopo) {
    var todos = escopo.querySelectorAll("input, select, textarea");
    var lista = [];
    for (var i = 0; i < todos.length; i++) {
      if (utilizavel(todos[i])) lista.push(todos[i]);
    }
    return lista;
  }

  // Do <select> escondido para o input de busca que aparece no lugar.
  function representante(el) {
    if (el.tagName === "SELECT" && el.classList.contains("select-search-native")) {
      var wrap = el.closest(".select-search-wrap");
      var input = wrap && wrap.querySelector(".select-search-input");
      if (input) return input;
    }
    return el;
  }

  // Devolve o próximo campo, ou null se não houver (fim do bloco).
  function proximoDe(origem) {
    var escopo = origem.closest(ESCOPO);
    if (!escopo) return null;
    var lista = campos(escopo);
    var i = lista.indexOf(representante(origem));
    if (i === -1 || i + 1 >= lista.length) return null;
    return lista[i + 1];
  }

  function focar(campo) {
    campo.focus();
    // Campo que já tem valor entra selecionado, pra digitar por cima
    // sem precisar apagar antes.
    if (campo.tagName === "INPUT" && campo.value) {
      try {
        campo.select();
      } catch (_) {
        /* type=number nao aceita selecao em alguns navegadores */
      }
    }
  }

  // Bolha, não captura: precisa rodar DEPOIS do onchange do próprio
  // campo, que é quem revela os relatos escondidos. Se rodasse antes,
  // o relato ainda estaria .hidden e o foco pularia por cima dele.
  document.addEventListener("change", function (e) {
    var el = e.target;
    if (!el || el.tagName !== "SELECT") return;
    if (!el.value) return; // "Selecione" não avança
    if (ehBusca(el) || el.closest("[data-sem-pulo]")) return;
    var proximo = proximoDe(el);
    if (proximo) focar(proximo);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.altKey) return;
    var el = e.target;
    if (!el || el.tagName !== "INPUT") return;
    // Enter dentro da busca do select pertence ao widget.
    if (el.classList.contains("select-search-input")) return;
    if (ehBusca(el)) return;
    if (!el.closest(ESCOPO)) return;

    var proximo = proximoDe(el);
    // Último campo do formulário: não intercepta, deixa salvar.
    if (!proximo) return;
    e.preventDefault();
    focar(proximo);
  });
})();
