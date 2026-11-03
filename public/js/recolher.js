// ================================================================
// Minimizar / expandir blocos
// ----------------------------------------------------------------
// Uso no HTML: um botao com data-recolher="<id do corpo>".
//   <button type="button" data-recolher="corpoX"></button>
//   <div id="corpoX">...</div>
// O clique esconde/mostra o corpo e o navegador lembra a escolha
// (por usuario/maquina), entao o bloco volta como foi deixado.
// Opcional: data-recolher-padrao="fechado" para comecar minimizado.
// ================================================================
(function iniciarRecolher() {
  "use strict";

  const PREFIXO = "controleEntregaRecolhido:";

  function lerEstado(id, padrao) {
    try {
      const salvo = localStorage.getItem(PREFIXO + id);
      if (salvo === "1") return true;
      if (salvo === "0") return false;
    } catch (_) {}
    return padrao === "fechado";
  }

  function salvarEstado(id, recolhido) {
    try {
      localStorage.setItem(PREFIXO + id, recolhido ? "1" : "0");
    } catch (_) {}
  }

  function aplicar(botao, recolhido) {
    const corpo = document.getElementById(botao.dataset.recolher);
    if (!corpo) return;
    corpo.style.display = recolhido ? "none" : "";
    botao.setAttribute("aria-expanded", String(!recolhido));
    botao.title = recolhido ? "Expandir" : "Minimizar";
    botao.textContent = recolhido ? "▸ Expandir" : "▾ Minimizar";
  }

  document.addEventListener("click", (evento) => {
    const botao = evento.target.closest("[data-recolher]");
    if (!botao) return;
    evento.preventDefault();
    const corpo = document.getElementById(botao.dataset.recolher);
    if (!corpo) return;
    const recolher = corpo.style.display !== "none";
    aplicar(botao, recolher);
    salvarEstado(botao.dataset.recolher, recolher);
  });

  function iniciar() {
    document.querySelectorAll("[data-recolher]").forEach((botao) => {
      botao.setAttribute("aria-controls", botao.dataset.recolher);
      aplicar(botao, lerEstado(botao.dataset.recolher, botao.dataset.recolherPadrao));
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", iniciar);
  } else {
    iniciar();
  }
})();
