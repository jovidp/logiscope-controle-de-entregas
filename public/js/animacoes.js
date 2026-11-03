// ================================================================
// ANIMAÇÕES DE ENTRADA
// ----------------------------------------------------------------
// Revela cartões, seções e linhas conforme entram na tela.
//
// Usa IntersectionObserver, e nao evento de scroll: o navegador avisa quando o
// elemento aparece, em vez de a pagina calcular posicao a cada pixel rolado.
// Num dashboard com dezenas de cartoes e atualizacao automatica, listener de
// scroll travaria a rolagem.
//
// Tres cuidados que definem o comportamento:
//  1. Anima UMA vez. Este sistema redesenha lista sozinho (SSE + poll); animar
//     de novo a cada atualizacao faria a tela piscar sem parar.
//  2. Quem ja esta visivel no primeiro quadro aparece sem animacao — abrir uma
//     aba nao deve custar meio segundo de espera para ler o que ja estava la.
//  3. prefers-reduced-motion desliga tudo. Nao e detalhe: movimento involuntario
//     passa mal quem tem sensibilidade vestibular.
// ================================================================
(function () {
  "use strict";

  const SEM_MOVIMENTO = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (SEM_MOVIMENTO) return;

  const ALVOS = [
    ".section-shell",
    ".card",
    ".tms-kpi",
    ".tms-card",
    ".tms-viagem",
    ".tms-chart-card",
    ".backlog-cartao",
    ".fr-item",
    ".atraso-card",
    ".historico-bloco",
  ].join(",");

  const ESCALONAMENTO_MS = 40;   // atraso entre itens do mesmo grupo
  const MAX_ESCALONAMENTO = 6;   // alem disso o ultimo demora demais para aparecer

  let observador = null;
  let primeiraPintura = true;

  function preparar(el, indice) {
    if (el.dataset.anim) return;              // ja tratado
    el.dataset.anim = "1";

    // Regra central: o que ESTA NA TELA aparece direto, sem animacao. Vale
    // sempre, nao so na primeira pintura.
    //
    // O motivo: este sistema recria lista sozinho (SSE + poll a cada minuto).
    // Animando tudo que e recriado, um cartao no meio da tela sumia e voltava a
    // cada atualizacao — a tela piscava sozinha enquanto a pessoa lia. Medido:
    // 159 blocos voltavam para o estado invisivel depois de uma atualizacao.
    // Animacao aqui e para conteudo que CHEGA rolando, nao para o que ja esta
    // sob os olhos.
    const r = el.getBoundingClientRect();
    if (r.top < window.innerHeight && r.bottom > 0) {
      el.classList.add("anim-pronto");
      return;
    }

    el.classList.add("anim-entrada");
    el.style.transitionDelay = Math.min(indice, MAX_ESCALONAMENTO) * ESCALONAMENTO_MS + "ms";
    observador.observe(el);
  }

  function varrer() {
    if (!observador) return;
    const novos = [...document.querySelectorAll(ALVOS)].filter((e) => !e.dataset.anim);
    novos.forEach(preparar);
  }

  function iniciar() {
    observador = new IntersectionObserver((entradas) => {
      for (const entrada of entradas) {
        if (!entrada.isIntersecting) continue;
        const el = entrada.target;
        el.classList.add("anim-pronto");
        el.classList.remove("anim-entrada");
        el.style.transitionDelay = "";
        observador.unobserve(el);           // anima uma vez so
      }
    }, {
      // Comeca a revelar um pouco antes de encostar na borda: o elemento chega
      // ja aparecendo, em vez de "pipocar" depois de visivel.
      rootMargin: "0px 0px -8% 0px",
      threshold: 0.02,
    });

    varrer();
    requestAnimationFrame(() => { primeiraPintura = false; });

    // O sistema troca de aba e redesenha listas sozinho; pega o que for criado
    // depois. Sem isso, so a primeira tela teria animacao.
    const mo = new MutationObserver(() => {
      clearTimeout(mo._t);
      mo._t = setTimeout(varrer, 120);      // agrupa rajadas de insercao
    });
    mo.observe(document.body, { childList: true, subtree: true });

    // Trocar de aba mostra conteudo que estava oculto: revela sem animar, senao
    // a aba abriria "vazia" por um instante.
    const _orig = window.irParaAba;
    window.irParaAba = function (nome, ...resto) {
      if (typeof _orig === "function") _orig(nome, ...resto);
      requestAnimationFrame(() => {
        document.querySelectorAll(".anim-entrada").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.top < window.innerHeight && r.bottom > 0) {
            el.classList.add("anim-pronto");
            el.classList.remove("anim-entrada");
            el.style.transitionDelay = "";
          }
        });
        varrer();
      });
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", iniciar);
  } else {
    iniciar();
  }
})();
