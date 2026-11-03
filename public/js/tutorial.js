// ================================================================
// Tutorial / Onboarding dentro do sistema
//   - Botao "Tutorial" no topo (.app-header-actions).
//   - Modal de boas-vindas com passo a passo detalhado do TMS +
//     glossario "o que faz cada aba" (por perfil).
//   - Tour guiado com "spotlight": destaca cada aba/botao na tela.
//   - Mostra automaticamente no primeiro acesso de cada usuario.
// Depende de auth.js (window.authReady / window.authUsuario).
// ================================================================
(function iniciarTutorial() {
  "use strict";

  const PREFIXO_VISTO = "controleEntregaTutorialVisto:";
  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

  function escapar(valor) {
    return String(valor || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  // ============================================================
  // Dados das abas (usado pelo glossario do modal e pelo tour)
  // Ordem = ordem do menu lateral.
  // ============================================================
  function infoAbas() {
    return [
      {
        key: "tms", ico: "🚛", nome: "TMS &middot; Viagens", sel: '.nav-tab[data-aba="tms"]',
        curto: "Planejamento e acompanhamento das viagens (veja o passo a passo acima).",
        tour: "O <b>coracao do sistema</b>. Em <b>+ Nova viagem</b> informe data, rota, motorista, veiculo e ajudantes; monte as paradas com <b>+ Adicionar loja</b> (os volumes somam sozinhos) e clique em <b>Salvar</b> (entra como <b>Planejada</b>). Acompanhe o status ate <b>Finalizada</b>. Atalho: <b>Importar do Checklist</b> ja traz lojas e volumes prontos.",
      },
      {
        key: "dashboard", ico: "🏠", nome: "Dashboard", sel: '.nav-tab[data-aba="dashboard"]',
        curto: "Indicadores do periodo (SLA, OTIF e custos). Filtre por Hoje, Semana, Mes ou Tudo.",
        tour: "Visao geral com os indicadores do periodo: SLA, OTIF e custos. Filtre por <b>Hoje, Semana, Mes ou Tudo</b>.",
      },
      {
        key: "monitoramento", ico: "📡", nome: "Monitoramento", sel: '.nav-tab[data-aba="monitoramento"]',
        curto: "Avisos do monitoramento: registre alertas sobre rota/placa/motorista (atraso, veiculo parado, desvio...).",
        tour: "Avisos do Monitoramento. Registre aqui os alertas sobre uma rota, placa ou motorista (atraso na rota, veiculo parado, desvio, problema mecanico...), com status e relato.",
      },
      {
        key: "entregas", ico: "🚚", nome: "Entregas", sel: '.nav-tab[data-aba="entregas"]',
        curto: "Lancar a entrega do dia e registrar ocorrencias de entrega.",
        tour: "Lance a <b>entrega do dia</b> e registre ocorrencias quando houver problema na entrega.",
      },
      {
        key: "veiculos", ico: "🔧", nome: "Veiculos", sel: '.nav-tab[data-aba="veiculos"]',
        curto: "Cadastro e situacao da frota; e onde fica o checklist do veiculo.",
        tour: "Cadastro e situacao da frota. Tambem e onde se preenche o <b>checklist do veiculo</b>.",
      },
      {
        key: "ranking", ico: "🏆", nome: "Ranking", sel: '.nav-tab[data-aba="ranking"]',
        curto: "Classificacao de desempenho dos motoristas.",
        tour: "Classificacao de <b>desempenho dos motoristas</b>.",
      },
      {
        key: "tendencias", ico: "📈", nome: "Tendencias", sel: '.nav-tab[data-aba="tendencias"]',
        curto: "Graficos da evolucao dos indicadores ao longo do tempo.",
        tour: "Graficos da <b>evolucao dos indicadores</b> ao longo do tempo.",
      },
      {
        key: "equipes", ico: "👥", nome: "Equipes", sel: '.nav-tab[data-aba="equipes"]',
        curto: "Ocorrencias e indicadores agrupados por equipe.",
        tour: "Ocorrencias e indicadores <b>agrupados por equipe</b>.",
      },
      {
        key: "ocorrencias-avulsas", ico: "⚠️", nome: "Ocorrencias", sel: '.nav-tab[data-aba="ocorrencias-avulsas"]',
        curto: "Ocorrencias avulsas/gerais, nao ligadas a uma entrega especifica.",
        tour: "Ocorrencias <b>avulsas/gerais</b>, que nao estao ligadas a uma entrega especifica.",
      },
      {
        key: "ocorrencias-entrega", ico: "🚚", nome: "Ocorr. Entrega", sel: '.nav-tab[data-aba="ocorrencias-entrega"]',
        curto: "Ocorrencias ligadas diretamente a uma entrega/parada.",
        tour: "Ocorrencias <b>ligadas a uma entrega/parada</b> (atraso, divergencia de volume, transferencia...).",
      },
      {
        key: "docs-motoristas", ico: "📑", nome: "Docs Motoristas", sel: '.nav-tab[data-aba="docs-motoristas"]',
        curto: "Documentacao e ranking de documentos dos motoristas.",
        tour: "Documentacao e <b>ranking de documentos</b> dos motoristas.",
      },
      {
        key: "escalas", ico: "📋", nome: "Escalas", sel: '.nav-tab[data-aba="escalas"]',
        curto: "Escalas e turnos da equipe.",
        tour: "<b>Escalas e turnos</b> da equipe.",
      },
      {
        key: "auditoria", ico: "🛡️", nome: "Auditoria", sel: '.nav-tab[data-aba="auditoria"]',
        curto: "Tudo o que foi feito no sistema: quem, o que, quando e de qual IP. (Somente ADM)",
        tour: "Registro de <b>tudo o que foi feito</b> no sistema: quem, o que, quando e de qual IP.",
      },
      {
        key: "usuarios", ico: "👤", nome: "Usuarios", sel: '.nav-tab[data-aba="usuarios"]',
        curto: "Cadastro e gestao de usuarios, perfis e senhas. (Somente ADM)",
        tour: "Cadastre a equipe, defina <b>perfis e senhas</b> de cada usuario.",
      },
    ];
  }

  const ABAS_OPERADOR = [
    "tms",
    "dashboard",
    "monitoramento",
    "entregas",
    "docas",
    "veiculos",
    "atrasos",
    "tendencias",
    "ocorrencias-avulsas",
    "ocorrencias-entrega",
    "docs-motoristas",
    "escalas",
  ];

  // ============================================================
  // Estilos (injetados uma vez)
  // ============================================================
  function instalarEstilos() {
    if (document.getElementById("tutorialEstilos")) return;
    const style = document.createElement("style");
    style.id = "tutorialEstilos";
    style.textContent = `
      .tut-overlay {
        position: fixed; inset: 0; z-index: 9998;
        background: rgba(2, 6, 23, 0.72); backdrop-filter: blur(3px);
        display: flex; align-items: center; justify-content: center;
        padding: 20px; animation: tutFade .2s ease-out;
      }
      .tut-overlay.hidden { display: none; }
      .tut-card {
        width: 100%; max-width: 580px; max-height: 90vh; overflow-y: auto;
        background: var(--bg-elevated, #0f172a); color: var(--text-primary, #e2e8f0);
        border: 1px solid var(--border, rgba(255,255,255,0.1));
        border-radius: 18px; padding: 24px 24px 18px;
        box-shadow: 0 24px 60px rgba(0,0,0,0.5);
        animation: tutUp .25s cubic-bezier(.4,0,.2,1);
      }
      .tut-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
      .tut-title { font-size: 19px; font-weight: 800; margin: 0; }
      .tut-sub { font-size: 13px; color: var(--text-muted, #94a3b8); margin: 4px 0 0; }
      .tut-close {
        flex: none; border: none; background: transparent; cursor: pointer;
        color: var(--text-muted, #94a3b8); font-size: 22px; line-height: 1;
        padding: 2px 6px; border-radius: 8px;
      }
      .tut-close:hover { background: rgba(255,255,255,0.08); color: var(--text-primary, #e2e8f0); }
      .tut-sec-titulo { font-size: 13px; font-weight: 800; margin: 18px 0 8px; color: var(--text-primary, #e5edf7); }
      .tut-box {
        background: rgba(56,189,248,0.06);
        border: 1px solid var(--border, rgba(255,255,255,0.08));
        border-radius: 12px; padding: 14px 16px;
      }
      .tut-box ol { margin: 0; padding-left: 20px; }
      .tut-box li { margin: 5px 0; font-size: 13px; line-height: 1.5; }
      .tut-box li strong { color: var(--text-primary, #e5edf7); }
      .tut-fluxo {
        margin-top: 12px; font-size: 11.5px; line-height: 1.7; color: var(--text-secondary, #b6c4da);
        background: rgba(255,255,255,0.03); border: 1px dashed var(--border, rgba(255,255,255,0.14));
        border-radius: 8px; padding: 9px 11px;
      }
      .tut-fluxo strong { color: var(--text-primary, #e5edf7); }
      .tut-glos { display: flex; flex-direction: column; gap: 9px; }
      .tut-glos-item { display: flex; gap: 10px; align-items: flex-start; }
      .tut-glos-ico { font-size: 16px; flex: none; width: 22px; text-align: center; }
      .tut-glos-nome { font-size: 12.5px; font-weight: 700; color: var(--text-primary, #e5edf7); }
      .tut-glos-desc { font-size: 12.5px; color: var(--text-secondary, #b6c4da); line-height: 1.45; }
      .tut-foot { margin-top: 18px; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
      .tut-hint { font-size: 11.5px; color: var(--text-muted, #94a3b8); }
      .tut-btns { display: flex; gap: 8px; }
      .tut-btn-ok {
        border: none; cursor: pointer; border-radius: 10px;
        padding: 10px 18px; font-size: 13px; font-weight: 700;
        background: #38bdf8; color: #042029;
      }
      .tut-btn-ok:hover { filter: brightness(1.08); }
      .tut-btn-ghost {
        border: 1px solid var(--border, rgba(255,255,255,0.12)); cursor: pointer;
        border-radius: 10px; padding: 10px 16px; font-size: 13px; font-weight: 600;
        background: transparent; color: var(--text-muted, #94a3b8);
      }
      .tut-btn-ghost:hover { color: var(--text-primary, #e2e8f0); }

      /* ===== Tour guiado (spotlight) ===== */
      #tourLayer { position: fixed; inset: 0; z-index: 9998; pointer-events: none; }
      #tourLayer.hidden { display: none; }
      #tourSpot {
        position: absolute; border-radius: 12px; pointer-events: none;
        border: 2px solid #38bdf8;
        box-shadow: 0 0 0 9999px rgba(2,6,23,0.74), 0 0 0 4px rgba(56,189,248,0.25);
        transition: top .25s ease, left .25s ease, width .25s ease, height .25s ease;
      }
      #tourPop {
        position: absolute; pointer-events: auto; width: min(330px, 90vw);
        background: var(--bg-elevated, #0f172a); color: var(--text-primary, #e2e8f0);
        border: 1px solid var(--border, rgba(255,255,255,0.1)); border-radius: 14px;
        padding: 14px 16px 12px; box-shadow: 0 18px 50px rgba(0,0,0,0.55);
      }
      .tour-count { font-size: 11px; font-weight: 700; color: #38bdf8; letter-spacing: .3px; }
      .tour-title { font-size: 15px; font-weight: 800; margin: 4px 0 0; }
      .tour-text { font-size: 13px; line-height: 1.5; color: var(--text-secondary, #b6c4da); margin: 6px 0 0; }
      .tour-text b { color: var(--text-primary, #e5edf7); }
      .tour-nav { margin-top: 14px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .tour-right { display: flex; gap: 8px; }
      .tour-btn { border: none; cursor: pointer; border-radius: 9px; padding: 8px 14px; font-size: 12.5px; font-weight: 700; }
      .tour-prim { background: #38bdf8; color: #042029; }
      .tour-prim:hover { filter: brightness(1.08); }
      .tour-sec { background: transparent; color: var(--text-muted, #94a3b8); border: 1px solid var(--border, rgba(255,255,255,0.12)); }
      .tour-sec:hover { color: var(--text-primary, #e2e8f0); }
      .tour-sec[disabled] { opacity: .4; cursor: default; }
      .tour-skip { background: transparent; color: var(--text-muted, #94a3b8); border: none; font-size: 12px; cursor: pointer; }
      .tour-skip:hover { text-decoration: underline; }

      @keyframes tutFade { from { opacity: 0; } to { opacity: 1; } }
      @keyframes tutUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
    `;
    document.head.appendChild(style);
  }

  // ============================================================
  // Modal de boas-vindas (porta de entrada)
  // ============================================================
  function glossarioHtml(lista) {
    return (
      '<div class="tut-glos">' +
      lista
        .map(
          (a) => `<div class="tut-glos-item">
            <span class="tut-glos-ico" aria-hidden="true">${a.ico}</span>
            <div><div class="tut-glos-nome">${a.nome}</div><div class="tut-glos-desc">${a.curto}</div></div>
          </div>`,
        )
        .join("") +
      "</div>"
    );
  }

  function conteudoAdm(nome) {
    const abas = infoAbas();
    const torre = {
      ico: "📟", nome: "Torre de Controle",
      curto: "Acompanhamento 360 com filtros inteligentes e analise de atrasos (ex.: atraso na saida da fabrica).",
    };
    return `<div class="tut-head">
        <div>
          <h2 class="tut-title">👋 Bem-vindo ao Controle de Entrega${nome ? ", " + nome : ""}!</h2>
          <p class="tut-sub">Voce e <strong>Administrador</strong>. Comece pelo TMS &mdash; o coracao do sistema:</p>
        </div>
        <button type="button" class="tut-close" aria-label="Fechar tutorial" onclick="tutorialFechar()">&times;</button>
      </div>

      <div class="tut-sec-titulo">🚛 Como funciona o TMS (passo a passo)</div>
      <div class="tut-box">
        <ol>
          <li><strong>Criar a viagem:</strong> clique em <strong>+ Nova viagem</strong> e informe Data, Rota, Motorista, Veiculo e Ajudantes (pode marcar varios).</li>
          <li><strong>Montar as paradas:</strong> em "Paradas", use <strong>+ Adicionar loja</strong> para cada loja, na ordem, com hora prevista e volumes. Os totais (volumes, material de campanha, sacolas P/M/G) somam <strong>automaticamente</strong>.</li>
          <li><strong>Salvar:</strong> clique em <strong>Salvar viagem</strong>. Ela entra como <strong>Planejada</strong>.</li>
          <li><strong>Atalho &mdash; Importar do Checklist:</strong> em vez de digitar tudo, importe da Expedicao: escolha a data, selecione os checklists, informe o motorista e importe &mdash; lojas e volumes ja vem prontos.</li>
          <li><strong>Acompanhar:</strong> na lista <strong>Viagens planejadas</strong>, abra a viagem e atualize o status conforme a operacao anda.</li>
          <li><strong>Filtrar e buscar:</strong> por data, rota, motorista, status ou pela busca (loja / placa / codigo).</li>
        </ol>
        <div class="tut-fluxo">
          <strong>Status da viagem:</strong> Planejada → Carregando → Liberada → Em rota → Retorno → Finalizada (ou Cancelada)<br>
          <strong>Status da parada (loja):</strong> Pendente → Em atendimento → Entregue (ou Entregue com ocorrencia / Recusada)
        </div>
      </div>

      <div class="tut-sec-titulo">📂 O que faz cada aba</div>
      ${glossarioHtml(abas.concat(torre))}

      <div class="tut-foot">
        <span class="tut-hint">💡 Clique em <strong>Iniciar tour guiado</strong> para o sistema destacar cada aba na tela.</span>
        <div class="tut-btns">
          <button type="button" class="tut-btn-ghost" onclick="tutorialFechar()">Agora nao</button>
          <button type="button" class="tut-btn-ok" onclick="tutorialIniciarTour()">▶ Iniciar tour guiado</button>
        </div>
      </div>`;
  }

  function conteudoOperador(nome) {
    const abas = infoAbas().filter((a) => ABAS_OPERADOR.includes(a.key));
    return `<div class="tut-head">
        <div>
          <h2 class="tut-title">👋 Bem-vindo ao Controle de Entrega${nome ? ", " + nome : ""}!</h2>
          <p class="tut-sub">Voce e <strong>Operador</strong>. Veja por onde comecar:</p>
        </div>
        <button type="button" class="tut-close" aria-label="Fechar tutorial" onclick="tutorialFechar()">&times;</button>
      </div>

      <div class="tut-sec-titulo">✅ Por onde comecar</div>
      <div class="tut-box">
        <ol>
          <li><strong>Entregas:</strong> lance a entrega do dia e registre ocorrencias quando houver problema.</li>
          <li><strong>Veiculos:</strong> preencha o checklist do veiculo.</li>
          <li><strong>Escalas:</strong> registre a escala da equipe.</li>
        </ol>
        <div class="tut-fluxo">Sua senha e definida pelo administrador. Ao terminar, clique em <strong>Sair</strong> no topo (a sessao expira sozinha em 12h).</div>
      </div>

      <div class="tut-sec-titulo">📂 Suas abas</div>
      ${glossarioHtml(abas)}

      <div class="tut-foot">
        <span class="tut-hint">💡 Clique em <strong>Iniciar tour guiado</strong> para o sistema destacar cada aba na tela.</span>
        <div class="tut-btns">
          <button type="button" class="tut-btn-ghost" onclick="tutorialFechar()">Agora nao</button>
          <button type="button" class="tut-btn-ok" onclick="tutorialIniciarTour()">▶ Iniciar tour guiado</button>
        </div>
      </div>`;
  }

  function montarConteudoModal(usuario) {
    const ehAdm = usuario && usuario.perfil === "ADM";
    const nome = escapar(usuario && usuario.nome ? usuario.nome : "");
    return ehAdm ? conteudoAdm(nome) : conteudoOperador(nome);
  }

  function aoTeclarModal(e) {
    if (e.key === "Escape") fecharModal();
  }

  function abrirModal() {
    instalarEstilos();
    let overlay = document.getElementById("tutorialOverlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "tutorialOverlay";
      overlay.className = "tut-overlay";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) fecharModal();
      });
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `<div class="tut-card">${montarConteudoModal(window.authUsuario)}</div>`;
    overlay.classList.remove("hidden");
  }

  function fecharModal() {
    const overlay = document.getElementById("tutorialOverlay");
    if (overlay) overlay.classList.add("hidden");
  }

  // ============================================================
  // Tour guiado (spotlight)
  // ============================================================
  function passoDeAba(info) {
    return { sel: info.sel, titulo: info.ico + " " + info.nome, texto: info.tour };
  }

  function passosTour() {
    const ehAdm = window.authUsuario && window.authUsuario.perfil === "ADM";
    const identidade = {
      sel: "#authUsuarioLogado", titulo: "Voce esta aqui",
      texto: ehAdm
        ? "Seu nome e perfil (<b>Administrador</b>). Voce tem acesso total ao sistema."
        : "Seu nome e perfil (<b>Operador</b>). E aqui que voce confirma com qual usuario esta logado.",
    };
    const abas = infoAbas().filter((a) => (ehAdm ? true : ABAS_OPERADOR.includes(a.key)));
    const finais = [];
    if (ehAdm) {
      finais.push({
        sel: ".app-header-actions a", titulo: "📟 Torre de Controle",
        texto: "Tela 360 com filtros inteligentes e <b>analise de atrasos</b> (ex.: atraso na saida da fabrica).",
      });
    }
    finais.push({ sel: "#tutorialBtn", titulo: "Rever o tutorial", texto: "Reabra este tutorial e o tour quando quiser, por aqui." });
    finais.push({ sel: '.app-header-actions button[onclick="authSair()"]', titulo: "Sair com seguranca", texto: "Encerre sua sessao aqui ao terminar. Ela tambem expira sozinha em 12 horas." });
    return [identidade].concat(abas.map(passoDeAba)).concat(finais);
  }

  let tourPassos = [];
  let tourIdx = 0;
  let tourEl = null;

  function elementoVisivel(el) {
    return !!(el && el.getClientRects && el.getClientRects().length > 0);
  }

  function garantirSidebarAberta(sel) {
    if (sel.indexOf("nav-tab") !== -1 || sel.indexOf("data-aba") !== -1) {
      document.body.classList.add("sidebar-aberto");
    }
  }

  function camadaTour() {
    let layer = document.getElementById("tourLayer");
    if (layer) return layer;
    layer = document.createElement("div");
    layer.id = "tourLayer";
    layer.innerHTML = `
      <div id="tourSpot"></div>
      <div id="tourPop">
        <div class="tour-count"></div>
        <div class="tour-title"></div>
        <div class="tour-text"></div>
        <div class="tour-nav">
          <button type="button" class="tour-skip">Pular</button>
          <div class="tour-right">
            <button type="button" class="tour-btn tour-sec" data-acao="prev">Anterior</button>
            <button type="button" class="tour-btn tour-prim" data-acao="next">Proximo</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(layer);
    layer.querySelector(".tour-skip").addEventListener("click", encerrarTour);
    layer.querySelector('[data-acao="prev"]').addEventListener("click", tourAnterior);
    layer.querySelector('[data-acao="next"]').addEventListener("click", tourProximo);
    return layer;
  }

  function posicionar() {
    if (!tourEl) return;
    const spot = document.getElementById("tourSpot");
    const pop = document.getElementById("tourPop");
    if (!spot || !pop) return;
    const r = tourEl.getBoundingClientRect();
    const pad = 6;
    spot.style.top = r.top - pad + "px";
    spot.style.left = r.left - pad + "px";
    spot.style.width = r.width + pad * 2 + "px";
    spot.style.height = r.height + pad * 2 + "px";

    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 14;
    let top;
    let left;

    if (r.right < vw * 0.5 && r.right + gap + pw <= vw - 8) {
      // elemento na esquerda (ex.: menu lateral) -> balao a direita
      left = r.right + gap;
      top = clamp(r.top, 12, vh - ph - 12);
    } else if (r.bottom + gap + ph <= vh - 8) {
      top = r.bottom + gap;
      left = clamp(r.left, 12, vw - pw - 12);
    } else if (r.top - gap - ph >= 8) {
      top = r.top - gap - ph;
      left = clamp(r.left, 12, vw - pw - 12);
    } else {
      top = clamp((vh - ph) / 2, 12, vh - ph - 12);
      left = clamp(r.left, 12, vw - pw - 12);
    }
    pop.style.top = top + "px";
    pop.style.left = left + "px";
  }

  function mostrarPasso() {
    const p = tourPassos[tourIdx];
    if (!p) return encerrarTour();
    const el = document.querySelector(p.sel);
    if (!elementoVisivel(el)) {
      if (tourIdx < tourPassos.length - 1) {
        tourIdx += 1;
        return mostrarPasso();
      }
      return encerrarTour();
    }
    tourEl = el;
    garantirSidebarAberta(p.sel);

    const pop = document.getElementById("tourPop");
    pop.style.visibility = "hidden";
    pop.querySelector(".tour-count").textContent = `Passo ${tourIdx + 1} de ${tourPassos.length}`;
    pop.querySelector(".tour-title").innerHTML = p.titulo;
    pop.querySelector(".tour-text").innerHTML = p.texto;
    const prev = pop.querySelector('[data-acao="prev"]');
    const next = pop.querySelector('[data-acao="next"]');
    prev.disabled = tourIdx === 0;
    next.textContent = tourIdx === tourPassos.length - 1 ? "Concluir ✓" : "Proximo →";

    el.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    requestAnimationFrame(() => {
      posicionar();
      pop.style.visibility = "visible";
    });
  }

  function tourProximo() {
    if (tourIdx < tourPassos.length - 1) {
      tourIdx += 1;
      mostrarPasso();
    } else {
      encerrarTour();
    }
  }

  function tourAnterior() {
    if (tourIdx > 0) {
      tourIdx -= 1;
      mostrarPasso();
    }
  }

  function aoTeclarTour(e) {
    if (e.key === "Escape") encerrarTour();
    else if (e.key === "ArrowRight") tourProximo();
    else if (e.key === "ArrowLeft") tourAnterior();
  }

  function iniciarTour() {
    fecharModal();
    instalarEstilos();
    document.body.classList.add("sidebar-aberto");
    tourPassos = passosTour().filter((p) => document.querySelector(p.sel));
    if (!tourPassos.length) {
      abrirModal();
      return;
    }
    tourIdx = 0;
    const layer = camadaTour();
    layer.classList.remove("hidden");
    mostrarPasso();
    window.addEventListener("resize", posicionar);
    window.addEventListener("scroll", posicionar, true);
  }

  function encerrarTour() {
    const layer = document.getElementById("tourLayer");
    if (layer) layer.classList.add("hidden");
    tourEl = null;
    window.removeEventListener("resize", posicionar);
    window.removeEventListener("scroll", posicionar, true);
    if (window.innerWidth <= 1024 && typeof window.fecharSidebar === "function") {
      window.fecharSidebar();
    }
  }

  // Compatibilidade + API publica
  window.tutorialAbrir = abrirModal;
  window.tutorialFechar = fecharModal;
  window.tutorialIniciarTour = iniciarTour;
  window.tutorialEncerrarTour = encerrarTour;

  // ============================================================
  // Botao no header
  // ============================================================
  function instalarBotao() {
    const container = document.querySelector(".app-header-actions");
    if (!container || document.getElementById("tutorialBtn")) return;
    const botao = document.createElement("button");
    botao.id = "tutorialBtn";
    botao.type = "button";
    botao.className = "btn-ghost btn-sm";
    botao.title = "Abrir tutorial / tour guiado";
    botao.textContent = "❓ Tutorial";
    botao.addEventListener("click", abrirModal);
    container.prepend(botao);
  }

  // ============================================================
  // Inicializacao
  // ============================================================
  (window.authReady || Promise.resolve(null)).then((usuario) => {
    if (!usuario) return; // tela de login: nao instala nada
    instalarBotao();
    const chave = PREFIXO_VISTO + usuario.id;
    let jaViu = false;
    try {
      jaViu = localStorage.getItem(chave) === "1";
    } catch (_) {}
    if (!jaViu) {
      abrirModal();
      try {
        localStorage.setItem(chave, "1");
      } catch (_) {}
    }
  });
})();
