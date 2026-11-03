// ================================================================
// CAPS LOCK GLOBAL
// Força MAIÚSCULAS em todos os campos de texto do sistema, sem
// possibilidade de desativar pelo usuário. Aplica no valor (dado
// salvo) e visualmente via CSS. Não atua em campos de senha,
// e-mail, número, data/hora nem em campos marcados com
// [data-no-upper] (ex.: usuário de login).
// ================================================================
(function () {
  "use strict";

  // Tipos de <input> que NÃO devem virar maiúsculas.
  var TIPOS_IGNORADOS = {
    password: 1,
    email: 1,
    number: 1,
    date: 1,
    "datetime-local": 1,
    time: 1,
    month: 1,
    week: 1,
    color: 1,
    range: 1,
    file: 1,
    checkbox: 1,
    radio: 1,
    url: 1,
    tel: 1,
    hidden: 1,
    submit: 1,
    button: 1,
    reset: 1,
    image: 1,
  };

  function deveForcar(el) {
    if (!el || el.dataset == null) return false;
    if (el.hasAttribute("data-no-upper")) return false;
    var tag = el.tagName;
    if (tag === "TEXTAREA") return true;
    if (tag !== "INPUT") return false;
    var tipo = (el.getAttribute("type") || "text").toLowerCase();
    return !TIPOS_IGNORADOS[tipo];
  }

  function forcarMaiuscula(el) {
    var maiusculo = el.value.toUpperCase();
    if (el.value === maiusculo) return;
    // Preserva a posição do cursor ao reescrever o valor.
    var ini = el.selectionStart;
    var fim = el.selectionEnd;
    el.value = maiusculo;
    try {
      el.setSelectionRange(ini, fim);
    } catch (_) {
      /* alguns navegadores não permitem em certos campos */
    }
  }

  // Captura no nível do documento: funciona para campos criados
  // dinamicamente, sem precisar registrar listener em cada um.
  document.addEventListener(
    "input",
    function (e) {
      var el = e.target;
      if (deveForcar(el)) forcarMaiuscula(el);
    },
    true,
  );
})();
