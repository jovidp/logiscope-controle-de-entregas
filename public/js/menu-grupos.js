// ================================================================
// AGRUPAMENTO DO MENU LATERAL
// ----------------------------------------------------------------
// Sao 25 abas numa lista plana: para achar uma, o olho percorre a lista
// inteira. Aqui elas sao agrupadas por area, com um rotulo discreto em cada
// grupo — o alvo passa a ser "5 grupos" em vez de "25 itens".
//
// O agrupamento acontece no DOM, MOVENDO os botoes que ja existem no HTML (nao
// recriando). Assim onclick, badges e o gating de perfil continuam valendo, e
// desfazer e so remover este script do index.html.
//
// Aba que nao esteja em nenhum grupo cai em "Outros", entao aba nova nunca
// some do menu por esquecimento aqui.
// ================================================================
(function () {
  "use strict";

  const GRUPOS = [
    { rotulo: "Operação",  abas: ["tms", "ctes", "entregas", "monitoramento", "agendamento", "docas"] },
    { rotulo: "Ocorrências", abas: ["ocorrencias-entrega", "ocorrencias-avulsas", "ocorrencias-motorista", "erros-loja"] },
    { rotulo: "Análise",   abas: ["dashboard", "ranking", "tendencias", "atrasos", "deslocamento", "historico-rotas"] },
    { rotulo: "Equipe",    abas: ["equipes", "escalas", "docs-motoristas", "saida-fabrica", "controle-uber"] },
    { rotulo: "Cadastros", abas: ["veiculos", "responsaveis-loja", "usuarios", "auditoria"] },
  ];

  function agrupar() {
    const nav = document.querySelector(".sidebar-nav");
    if (!nav || nav.dataset.agrupado === "1") return;

    const botoes = new Map();
    nav.querySelectorAll(".nav-tab[data-aba]").forEach((b) => botoes.set(b.dataset.aba, b));
    if (!botoes.size) return;

    const usados = new Set();
    const fragmento = document.createDocumentFragment();

    for (const grupo of GRUPOS) {
      const doGrupo = grupo.abas.map((a) => botoes.get(a)).filter(Boolean);
      if (!doGrupo.length) continue;

      const rotulo = document.createElement("div");
      rotulo.className = "nav-grupo-rotulo";
      rotulo.textContent = grupo.rotulo;
      // Guarda quais abas moram aqui: usado para esconder o rotulo quando o
      // perfil do usuario nao enxerga nenhuma delas.
      rotulo.dataset.abas = grupo.abas.join(",");
      fragmento.appendChild(rotulo);

      doGrupo.forEach((b) => { fragmento.appendChild(b); usados.add(b.dataset.aba); });
    }

    // Sobras: aba nova que ninguem classificou ainda.
    const sobras = [...botoes.entries()].filter(([a]) => !usados.has(a)).map(([, b]) => b);
    if (sobras.length) {
      const rotulo = document.createElement("div");
      rotulo.className = "nav-grupo-rotulo";
      rotulo.textContent = "Outros";
      rotulo.dataset.abas = sobras.map((b) => b.dataset.aba).join(",");
      fragmento.appendChild(rotulo);
      sobras.forEach((b) => fragmento.appendChild(b));
    }

    nav.appendChild(fragmento);
    nav.dataset.agrupado = "1";
    ajustarRotulos();
  }

  // Grupo cujas abas estao todas ocultas (perfil sem permissao) nao deve
  // deixar um rotulo solto no menu.
  function ajustarRotulos() {
    document.querySelectorAll(".nav-grupo-rotulo").forEach((rot) => {
      const abas = String(rot.dataset.abas || "").split(",").filter(Boolean);
      const algumaVisivel = abas.some((a) => {
        const b = document.querySelector(`.nav-tab[data-aba="${a}"]`);
        return b && b.offsetParent !== null;
      });
      rot.hidden = !algumaVisivel;
    });
  }

  window.menuAjustarRotulos = ajustarRotulos;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", agrupar);
  } else {
    agrupar();
  }

  // O gating por perfil roda depois do login e pode esconder abas; reavalia os
  // rotulos quando isso acontecer.
  if (window.authReady && typeof window.authReady.then === "function") {
    window.authReady.then(() => setTimeout(ajustarRotulos, 0));
  }
})();
