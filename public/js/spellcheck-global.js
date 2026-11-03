// ================================================================
// CORRETOR ORTOGRÁFICO GLOBAL
// Liga o corretor nativo do navegador nos campos de TEXTO LIVRE
// (relato, observação, justificativa, causa raiz) e DESLIGA nos
// campos de código (placa, CTe, loja, nome, telefone, busca), onde
// cada valor sairia sublinhado de vermelho sem motivo.
// O idioma vem do <html lang="pt-BR">; o dicionário em si é o do
// navegador, então cada máquina precisa ter Português (Brasil)
// marcado em chrome://settings/languages.
// Override por campo: data-spellcheck="on" | data-spellcheck="off".
// ================================================================
(function () {
  "use strict";

  // Campos de código/identificação nunca são corrigidos, mesmo que
  // o nome bata com a regra de texto livre abaixo.
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
    search: 1,
  };

  // <input> de texto só entra no corretor se o nome indicar texto
  // livre. Segue a convenção já usada no sistema: rotaObs, ckObs,
  // diarioObs, tmsViagemObs, almocoObs, tacografoObs...
  var TEXTO_LIVRE =
    /obs|observa|relato|justificativa|descri|motivo|causa|acaoCorretiva|titulo/i;

  // Campos que o nome sugere texto livre mas guardam código, hora ou
  // busca. Vale também para textarea (docasModalHorario guarda
  // "07:00H ÀS 23:00H"). Tem prioridade sobre TEXTO_LIVRE.
  var NAO_CORRIGIR = /busca|filtro|pesquis|horario|carrinho|telefone|placa/i;

  function deveCorrigir(el) {
    if (!el || el.dataset == null) return null;

    // Override explícito no HTML sempre vence.
    var manual = el.getAttribute("data-spellcheck");
    if (manual === "on") return true;
    if (manual === "off") return false;

    var tag = el.tagName;
    if (tag !== "TEXTAREA" && tag !== "INPUT") return null;

    var nome = (el.id || "") + " " + (el.name || "");
    if (NAO_CORRIGIR.test(nome)) return false;

    // Textarea é campo de relato/observação por definição no sistema.
    if (tag === "TEXTAREA") return true;

    var tipo = (el.getAttribute("type") || "text").toLowerCase();
    if (TIPOS_IGNORADOS[tipo]) return false;
    return TEXTO_LIVRE.test(nome);
  }

  function aplicar(el) {
    var alvo = deveCorrigir(el);
    if (alvo === null) return;
    // spellcheck reflete no atributo; só escreve se mudou de fato.
    if (el.spellcheck === alvo) return;
    el.spellcheck = alvo;
  }

  function varrer(raiz) {
    var campos = (raiz || document).querySelectorAll("input, textarea");
    for (var i = 0; i < campos.length; i++) aplicar(campos[i]);
  }

  // Campos criados dinamicamente (modais do TMS, cadastros, docas)
  // são tratados no foco, que é exatamente quando o corretor passa
  // a importar — evita observar o DOM inteiro.
  document.addEventListener(
    "focusin",
    function (e) {
      aplicar(e.target);
    },
    true,
  );

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      varrer(document);
    });
  } else {
    varrer(document);
  }

  // Exposto para telas que injetam formulários inteiros de uma vez.
  window.aplicarCorretor = varrer;
})();
