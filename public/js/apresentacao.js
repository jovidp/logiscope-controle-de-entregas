// ================================================================
// MODO APRESENTACAO — tela cheia tipo painel de TV para a operacao.
// Esconde o "cromo" (sidebar, header, chat) e rotaciona automaticamente
// pelas abas analiticas, reusando irParaAba() (que ja dispara os renders).
// ================================================================
(function modoApresentacao() {
  // Abas exibidas no carrossel, em ordem. Todas existem no index.html.
  const SLIDES = [
    { aba: "dashboard", titulo: "🏠 Dashboard" },
    { aba: "monitoramento", titulo: "📡 Monitoramento" },
    { aba: "equipes", titulo: "👥 Equipes" },
    { aba: "ranking", titulo: "🏆 Ranking de Motoristas" },
    { aba: "tendencias", titulo: "📈 Tendências" },
  ];
  const INTERVALO_MS = 15000; // tempo em cada tela

  let idx = 0;
  let timerSlide = null;
  let timerRelogio = null;
  let ativo = false;
  let pausado = false;
  let abaAnterior = null;

  function injetarEstilos() {
    if (document.getElementById("apresentacaoEstilos")) return;
    const css = `
      #apresentacaoBtn{display:inline-flex;align-items:center;gap:5px;}
      body.modo-apresentacao .app-header,
      body.modo-apresentacao .app-sidebar,
      body.modo-apresentacao .sidebar-overlay,
      body.modo-apresentacao #chatBtn,
      body.modo-apresentacao #chatPainel{display:none !important;}
      body.modo-apresentacao{padding-top:60px !important;}
      #apresentacaoBar{display:none;}
      body.modo-apresentacao #apresentacaoBar{
        display:flex;align-items:center;gap:16px;position:fixed;top:0;left:0;right:0;height:56px;
        padding:0 18px;z-index:9600;backdrop-filter:blur(6px);
        background:linear-gradient(90deg,rgba(15,23,42,.97),rgba(30,41,59,.97));
        border-bottom:1px solid var(--border,#1e293b);
      }
      #apresentacaoBar .apr-titulo{font-size:18px;font-weight:800;color:var(--text-heading,#f8fafc);
        white-space:nowrap;min-width:230px;}
      #apresentacaoBar .apr-dots{display:flex;gap:7px;flex:1;align-items:center;}
      #apresentacaoBar .apr-dots span{width:9px;height:9px;border-radius:50%;background:rgba(255,255,255,.18);
        transition:background .2s,box-shadow .2s;cursor:pointer;}
      #apresentacaoBar .apr-dots span.on{background:var(--azul,#38bdf8);box-shadow:0 0 8px var(--azul,#38bdf8);}
      #apresentacaoBar .apr-rel{text-align:right;color:var(--text-heading,#f8fafc);line-height:1.05;}
      #apresentacaoBar .apr-rel #aprHora{font-size:20px;font-weight:800;font-variant-numeric:tabular-nums;}
      #apresentacaoBar .apr-rel small{display:block;font-size:10px;color:var(--text-muted,#94a3b8);}
      #apresentacaoBar .apr-ctrl{display:flex;gap:6px;}
      #apresentacaoBar .apr-ctrl button{background:rgba(255,255,255,.06);border:1px solid var(--border,#1e293b);
        color:var(--text-heading,#f1f5f9);width:36px;height:36px;border-radius:9px;cursor:pointer;font-size:14px;
        display:flex;align-items:center;justify-content:center;font-family:inherit;}
      #apresentacaoBar .apr-ctrl button:hover{background:rgba(255,255,255,.13);}
      #apresentacaoBar .apr-ctrl #aprSair{color:#f87171;}
    `;
    const style = document.createElement("style");
    style.id = "apresentacaoEstilos";
    style.textContent = css;
    document.head.appendChild(style);
  }

  function construirBotao() {
    const acoes = document.querySelector(".app-header-actions");
    if (!acoes || document.getElementById("apresentacaoBtn")) return;
    const b = document.createElement("button");
    b.id = "apresentacaoBtn";
    b.type = "button";
    b.className = "btn-ghost btn-sm";
    b.innerHTML = "📺 Apresentação";
    b.title = "Modo apresentação (tela cheia)";
    b.addEventListener("click", entrar);
    acoes.insertBefore(b, acoes.firstChild);
  }

  function construirBarra() {
    if (document.getElementById("apresentacaoBar")) return;
    const bar = document.createElement("div");
    bar.id = "apresentacaoBar";
    bar.innerHTML = `
      <div class="apr-titulo" id="aprTitulo"></div>
      <div class="apr-dots" id="aprDots"></div>
      <div class="apr-rel"><span id="aprHora"></span><small id="aprData"></small></div>
      <div class="apr-ctrl">
        <button type="button" id="aprPrev" title="Anterior">⏮</button>
        <button type="button" id="aprPause" title="Pausar/Retomar">⏸</button>
        <button type="button" id="aprNext" title="Próximo">⏭</button>
        <button type="button" id="aprSair" title="Sair (Esc)">✕</button>
      </div>`;
    document.body.appendChild(bar);
    document.getElementById("aprPrev").addEventListener("click", anterior);
    document.getElementById("aprNext").addEventListener("click", proximo);
    document.getElementById("aprPause").addEventListener("click", pausarRetomar);
    document.getElementById("aprSair").addEventListener("click", sair);
  }

  function renderDots() {
    const dots = document.getElementById("aprDots");
    if (!dots) return;
    dots.innerHTML = SLIDES.map(
      (s, i) => `<span class="${i === idx ? "on" : ""}" data-i="${i}" title="${s.titulo}"></span>`,
    ).join("");
    dots.querySelectorAll("span").forEach((sp) =>
      sp.addEventListener("click", () => irParaSlide(Number(sp.dataset.i))),
    );
  }

  function tickRelogio() {
    const agora = new Date();
    const hora = document.getElementById("aprHora");
    const data = document.getElementById("aprData");
    if (hora) hora.textContent = agora.toLocaleTimeString("pt-BR");
    if (data)
      data.textContent = agora.toLocaleDateString("pt-BR", {
        weekday: "long",
        day: "2-digit",
        month: "long",
      });
  }

  function reiniciarTimerSlide() {
    if (timerSlide) clearInterval(timerSlide);
    timerSlide = null;
    if (!pausado) timerSlide = setInterval(proximo, INTERVALO_MS);
  }

  function irParaSlide(i) {
    idx = ((i % SLIDES.length) + SLIDES.length) % SLIDES.length;
    const slide = SLIDES[idx];
    if (typeof irParaAba === "function") irParaAba(slide.aba);
    const titulo = document.getElementById("aprTitulo");
    if (titulo) titulo.textContent = slide.titulo;
    renderDots();
    reiniciarTimerSlide();
  }

  function proximo() {
    irParaSlide(idx + 1);
  }
  function anterior() {
    irParaSlide(idx - 1);
  }

  function pausarRetomar() {
    pausado = !pausado;
    const btn = document.getElementById("aprPause");
    if (btn) btn.textContent = pausado ? "▶" : "⏸";
    reiniciarTimerSlide();
  }

  function aoTeclar(e) {
    if (!ativo) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") proximo();
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") anterior();
    else if (e.key === " ") {
      e.preventDefault();
      pausarRetomar();
    } else if (e.key === "Escape") sair();
  }

  function aoMudarFullscreen() {
    // Se o usuario saiu do fullscreen (Esc/F11), encerra a apresentacao.
    if (!document.fullscreenElement && ativo) sair();
  }

  async function entrar() {
    if (ativo) return;
    ativo = true;
    pausado = false;
    idx = 0;
    abaAnterior =
      document.querySelector(".aba:not(.aba-hidden)")?.id?.replace("aba-", "") || "tms";

    construirBarra();
    document.body.classList.add("modo-apresentacao");
    document.body.classList.remove("sidebar-aberto");

    try {
      await document.documentElement.requestFullscreen?.();
    } catch {
      /* fullscreen pode ser bloqueado; segue em tela cheia simulada */
    }

    const btnPause = document.getElementById("aprPause");
    if (btnPause) btnPause.textContent = "⏸";

    tickRelogio();
    timerRelogio = setInterval(tickRelogio, 1000);
    document.addEventListener("fullscreenchange", aoMudarFullscreen);

    irParaSlide(0);
  }

  function sair() {
    if (!ativo) return;
    ativo = false;
    if (timerSlide) clearInterval(timerSlide);
    if (timerRelogio) clearInterval(timerRelogio);
    timerSlide = timerRelogio = null;
    document.body.classList.remove("modo-apresentacao");
    document.removeEventListener("fullscreenchange", aoMudarFullscreen);
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    if (typeof irParaAba === "function") irParaAba(abaAnterior || "tms");
  }

  async function start() {
    const usuario = await window.authReady;
    // Modo apresentacao usa as abas analiticas (Dashboard, Ranking, etc.),
    // que sao restritas; disponivel apenas para ADM.
    if (!usuario || usuario.perfil !== "ADM") return;
    injetarEstilos();
    construirBotao();
  }

  if (window.authReady && typeof window.authReady.then === "function") {
    start();
  } else {
    document.addEventListener("DOMContentLoaded", start);
  }
})();
