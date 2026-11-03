(function iniciarTema() {
  "use strict";

  // Roda no <head>, antes do CSS: grava data-tema/data-paleta no <html> cedo
  // para a pagina ja nascer no tema certo (sem piscar o claro primeiro).
  //
  // data-tema   = modo base (claro | escuro). As regras antigas dependem dele.
  // data-paleta = paleta por cima do modo base (ver css/temas.css). Os temas
  //               "claro" e "escuro" de sempre nao tem paleta.

  const CHAVE_TEMA = "controleEntregaTema";
  const TEMA_CLARO = "claro";
  const TEMA_ESCURO = "escuro";
  const TEMA_AUTO = "auto";

  // id = valor gravado e nome da paleta no temas.css; base = modo por baixo.
  const TEMAS = [
    { id: TEMA_AUTO, nome: "Automático", grupo: "Padrão", dica: "Segue o claro/escuro do Windows" },
    { id: TEMA_CLARO, nome: "Claro", base: TEMA_CLARO, grupo: "Padrão" },
    { id: TEMA_ESCURO, nome: "Escuro", base: TEMA_ESCURO, grupo: "Padrão" },
    { id: "github-claro", nome: "GitHub Claro", base: TEMA_CLARO, grupo: "Claros", paleta: true },
    { id: "solarized-claro", nome: "Solarized", base: TEMA_CLARO, grupo: "Claros", paleta: true },
    { id: "catppuccin-latte", nome: "Catppuccin Latte", base: TEMA_CLARO, grupo: "Claros", paleta: true },
    { id: "floresta", nome: "Floresta", base: TEMA_CLARO, grupo: "Claros", paleta: true },
    { id: "papel", nome: "Papel", base: TEMA_CLARO, grupo: "Claros", paleta: true, dica: "Tom sépia, cansa menos a vista" },
    { id: "github-escuro", nome: "GitHub Escuro", base: TEMA_ESCURO, grupo: "Escuros", paleta: true },
    { id: "dracula", nome: "Dracula", base: TEMA_ESCURO, grupo: "Escuros", paleta: true },
    { id: "nord", nome: "Nord", base: TEMA_ESCURO, grupo: "Escuros", paleta: true },
    { id: "tokyo-night", nome: "Tokyo Night", base: TEMA_ESCURO, grupo: "Escuros", paleta: true },
    { id: "catppuccin-mocha", nome: "Catppuccin Mocha", base: TEMA_ESCURO, grupo: "Escuros", paleta: true },
    { id: "gruvbox", nome: "Gruvbox", base: TEMA_ESCURO, grupo: "Escuros", paleta: true },
    { id: "solarized-escuro", nome: "Solarized Escuro", base: TEMA_ESCURO, grupo: "Escuros", paleta: true },
    { id: "oceano", nome: "Oceano", base: TEMA_ESCURO, grupo: "Escuros", paleta: true },
    { id: "grafite", nome: "Grafite", base: TEMA_ESCURO, grupo: "Escuros", paleta: true },
    { id: "alto-contraste", nome: "Alto contraste", base: TEMA_ESCURO, grupo: "Acessibilidade", paleta: true, dica: "Para baixa visão ou tela no sol" },
  ];
  const POR_ID = {};
  TEMAS.forEach((t) => { POR_ID[t.id] = t; });

  const midiaEscura = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  let temaEscolhido = TEMA_CLARO;

  function temaSalvo() {
    try {
      const salvo = localStorage.getItem(CHAVE_TEMA);
      return POR_ID[salvo] ? salvo : TEMA_CLARO;
    } catch (_) {
      return TEMA_CLARO;
    }
  }

  function baseDe(id) {
    if (id === TEMA_AUTO) return midiaEscura && midiaEscura.matches ? TEMA_ESCURO : TEMA_CLARO;
    return (POR_ID[id] && POR_ID[id].base) || TEMA_CLARO;
  }

  function atualizarBotoes() {
    const tema = POR_ID[temaEscolhido] || POR_ID[TEMA_CLARO];
    const conteudo = '<span aria-hidden="true">&#127912;</span> Tema';
    document.querySelectorAll("[data-theme-toggle]").forEach((botao) => {
      if (botao.innerHTML !== conteudo) botao.innerHTML = conteudo;
      botao.title = `Tema: ${tema.nome} (clique para trocar)`;
      botao.setAttribute("aria-label", botao.title);
      botao.setAttribute("aria-haspopup", "dialog");
    });
    marcarOpcoes();
  }

  // Barra do navegador no celular na cor do fundo do tema.
  function atualizarCorNavegador() {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta || !document.body) return;
    const fundo = getComputedStyle(document.body).backgroundColor;
    if (fundo && fundo !== "rgba(0, 0, 0, 0)") meta.setAttribute("content", fundo);
  }

  function aplicarTema(id, salvar) {
    if (!POR_ID[id]) id = TEMA_CLARO;
    temaEscolhido = id;
    const raiz = document.documentElement;
    raiz.dataset.tema = baseDe(id);
    if (POR_ID[id].paleta) raiz.dataset.paleta = id;
    else delete raiz.dataset.paleta;
    if (salvar) {
      try {
        localStorage.setItem(CHAVE_TEMA, id);
      } catch (_) {
        // O tema continua ativo nesta pagina mesmo sem persistencia local.
      }
    }
    atualizarBotoes();
    if (document.readyState !== "loading") requestAnimationFrame(atualizarCorNavegador);
    try {
      window.dispatchEvent(new CustomEvent("tema-mudou", { detail: { id, base: raiz.dataset.tema } }));
    } catch (_) {}
  }

  // Mantido por compatibilidade (atalhos antigos chamam): alterna entre os
  // dois temas padrao.
  function alternarTema() {
    const atual = document.documentElement.dataset.tema;
    aplicarTema(atual === TEMA_CLARO ? TEMA_ESCURO : TEMA_CLARO, true);
  }

  // ---------- seletor (janelinha com as miniaturas) ----------
  let seletor = null;
  let ancora = null;

  function amostra(id) {
    return `<span class="tema-amostra" data-paleta="${id}" aria-hidden="true">` +
      '<i class="ta-lado"></i><i class="ta-cartao"><i class="ta-linha"></i>' +
      '<i class="ta-linha ta-fraca"></i><i class="ta-botao"></i></i></span>';
  }

  function montarSeletor() {
    const el = document.createElement("div");
    el.id = "temaSeletor";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Escolher tema");
    el.hidden = true;
    let html = '<div class="tema-topo"><span class="tema-titulo">Tema</span>' +
      '<span class="tema-dica">Esc fecha</span></div>';
    let grupo = null;
    TEMAS.forEach((t) => {
      if (t.grupo !== grupo) {
        if (grupo !== null) html += "</div>";
        grupo = t.grupo;
        html += `<div class="tema-grupo">${grupo}</div><div class="tema-grade" role="radiogroup" aria-label="${grupo}">`;
      }
      html += `<button type="button" class="tema-opcao" role="radio" aria-checked="false" data-tema-id="${t.id}"` +
        (t.dica ? ` title="${t.dica}"` : "") + ">" + amostra(t.id) +
        `<span class="tema-nome">${t.nome}</span><span class="tema-check" aria-hidden="true">&#10003;</span></button>`;
    });
    html += "</div>";
    html += '<div class="tema-rodape">A escolha fica salva neste computador. ' +
      "Tema só muda as cores: nada do sistema muda de lugar.</div>";
    el.innerHTML = html;

    el.addEventListener("click", (ev) => {
      const op = ev.target.closest(".tema-opcao");
      if (op) aplicarTema(op.dataset.temaId, true);
    });
    el.addEventListener("keydown", navegarTeclado);
    return el;
  }

  function marcarOpcoes() {
    if (!seletor) return;
    seletor.querySelectorAll(".tema-opcao").forEach((op) => {
      const ativo = op.dataset.temaId === temaEscolhido;
      op.setAttribute("aria-checked", ativo ? "true" : "false");
      op.tabIndex = ativo ? 0 : -1;
    });
  }

  // Setas andam pela grade (3 por linha); Enter/Espaco aplicam (botao nativo).
  function navegarTeclado(ev) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      fecharSeletor(true);
      return;
    }
    const passos = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 3, ArrowUp: -3 };
    if (!(ev.key in passos)) return;
    const ops = Array.from(seletor.querySelectorAll(".tema-opcao"));
    const atual = ops.indexOf(document.activeElement);
    if (atual < 0) return;
    ev.preventDefault();
    const prox = Math.max(0, Math.min(ops.length - 1, atual + passos[ev.key]));
    ops.forEach((op, i) => { op.tabIndex = i === prox ? 0 : -1; });
    ops[prox].focus();
  }

  function posicionar() {
    if (!seletor || seletor.hidden || !ancora) return;
    if (window.innerWidth <= 560) {
      seletor.style.top = seletor.style.left = "";
      return;
    }
    const r = ancora.getBoundingClientRect();
    const largura = seletor.offsetWidth;
    const altura = seletor.offsetHeight;
    let left = Math.min(r.right - largura, window.innerWidth - largura - 12);
    left = Math.max(12, left);
    // Prefere abrir embaixo do botao; sem espaco, em cima; sem espaco nenhum,
    // encosta no rodape da janela (cobre o botao, mas fica inteira na tela).
    let top = r.bottom + 6;
    if (top + altura > window.innerHeight - 12) {
      top = r.top - altura - 6 >= 12 ? r.top - altura - 6 : Math.max(12, window.innerHeight - altura - 12);
    }
    seletor.style.left = `${Math.round(left)}px`;
    seletor.style.top = `${Math.round(top)}px`;
  }

  function cliqueFora(ev) {
    if (!seletor || seletor.hidden) return;
    if (seletor.contains(ev.target) || (ancora && ancora.contains(ev.target))) return;
    fecharSeletor(false);
  }

  function abrirSeletor(botao) {
    if (!seletor) seletor = montarSeletor();
    ancora = botao || document.querySelector("[data-theme-toggle]");
    // Na tela de login o resto do body fica invisivel (auth-pendente):
    // a janelinha precisa morar dentro da propria tela de login.
    const casa = (ancora && ancora.closest("#authTela")) || document.body;
    if (seletor.parentNode !== casa) casa.appendChild(seletor);
    marcarOpcoes();
    seletor.hidden = false;
    if (ancora) ancora.setAttribute("aria-expanded", "true");
    posicionar();
    const marcado = seletor.querySelector('.tema-opcao[aria-checked="true"]');
    if (marcado) marcado.focus();
    document.addEventListener("mousedown", cliqueFora, true);
    window.addEventListener("resize", posicionar);
    window.addEventListener("scroll", posicionar, true);
  }

  function fecharSeletor(devolverFoco) {
    if (!seletor || seletor.hidden) return;
    seletor.hidden = true;
    if (ancora) {
      ancora.setAttribute("aria-expanded", "false");
      if (devolverFoco) ancora.focus();
    }
    document.removeEventListener("mousedown", cliqueFora, true);
    window.removeEventListener("resize", posicionar);
    window.removeEventListener("scroll", posicionar, true);
  }

  function alternarSeletor(ev) {
    const botao = ev && ev.currentTarget;
    if (seletor && !seletor.hidden && ancora === botao) fecharSeletor(false);
    else abrirSeletor(botao);
  }

  function adicionarBotao(container) {
    if (!container || container.querySelector("[data-theme-toggle]")) return;
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "theme-toggle btn-ghost btn-sm";
    botao.dataset.themeToggle = "";
    botao.setAttribute("aria-expanded", "false");
    botao.addEventListener("click", alternarSeletor);

    if (container.classList.contains("auth-card")) {
      botao.classList.add("auth-theme-toggle");
      container.appendChild(botao);
    } else if (container.classList.contains("header-painel")) {
      botao.classList.add("torre-theme-toggle");
      container.appendChild(botao);
    } else {
      container.prepend(botao);
    }
  }

  function instalarBotoes() {
    document
      .querySelectorAll(".app-header-actions, .header-painel, .auth-card")
      .forEach(adicionarBotao);
    atualizarBotoes();
    atualizarCorNavegador();
  }

  // "Automatico" acompanha a troca do Windows sem recarregar.
  if (midiaEscura) {
    const aoMudarSistema = () => { if (temaEscolhido === TEMA_AUTO) aplicarTema(TEMA_AUTO, false); };
    if (midiaEscura.addEventListener) midiaEscura.addEventListener("change", aoMudarSistema);
    else if (midiaEscura.addListener) midiaEscura.addListener(aoMudarSistema);
  }

  aplicarTema(temaSalvo(), false);
  window.alternarTema = alternarTema;
  window.temaAplicar = (id) => aplicarTema(id, true);
  window.temaAbrirSeletor = abrirSeletor;
  window.temaInstalarBotoes = instalarBotoes;
  window.TEMAS_LISTA = TEMAS.map((t) => ({ id: t.id, nome: t.nome, grupo: t.grupo }));

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", instalarBotoes);
  } else {
    instalarBotoes();
  }
})();
