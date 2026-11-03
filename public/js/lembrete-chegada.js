// ================================================================
// LEMBRETE DE CHEGADA — alerta diário às 17:15
// Lembra de preencher o "Horário de Chegada" (campo #hora_chegada,
// "Chegada na Rota"). Dispara 1x por dia; pode ser adiado (snooze).
// ================================================================
(function () {
  "use strict";

  // ---- Configuração ----------------------------------------------
  const HORA_ALVO = 17; // 17h
  const MIN_ALVO = 15; //   :15  -> 17:15
  const SNOOZE_MIN = 10; // "Lembrar depois" => +10 min
  const CHECK_MS = 30 * 1000; // verifica a cada 30s
  const KEY_DIA = "lembreteChegada_ultimoDia"; // dia já tratado (AAAA-MM-DD)

  let snoozeAte = 0; // timestamp (ms) até o qual fica adiado

  // ---- Utilidades ------------------------------------------------
  function diaISO(d) {
    return (
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0")
    );
  }

  function jaTratadoHoje() {
    return localStorage.getItem(KEY_DIA) === diaISO(new Date());
  }

  function marcarTratadoHoje() {
    localStorage.setItem(KEY_DIA, diaISO(new Date()));
  }

  function deveDisparar() {
    if (document.getElementById("lembreteChegadaBanner")) return false; // já visível
    if (jaTratadoHoje()) return false;
    if (snoozeAte && Date.now() < snoozeAte) return false;
    const agora = new Date();
    const minAgora = agora.getHours() * 60 + agora.getMinutes();
    return minAgora >= HORA_ALVO * 60 + MIN_ALVO; // 17:15 em diante (mesmo dia)
  }

  // ---- Som de atenção (beep curto) -------------------------------
  function tocarBeep() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const fazerTom = (freq, inicio, dur) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + inicio);
        gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + inicio + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + inicio + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + inicio);
        osc.stop(ctx.currentTime + inicio + dur);
      };
      fazerTom(880, 0, 0.25);
      fazerTom(1175, 0.28, 0.3);
    } catch (e) {
      /* autoplay bloqueado — ignora */
    }
  }

  // ---- Notificação do navegador (funciona com a aba em 2º plano) -
  function pedirPermissaoNotificacao() {
    try {
      if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission().catch(() => {});
      }
    } catch (e) {}
  }

  function notificarNavegador() {
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        const n = new Notification("⏰ Horário de Chegada", {
          body: "São 17:15 — não esqueça de preencher o horário de chegada na rota.",
          tag: "lembrete-chegada",
          requireInteraction: true,
        });
        n.onclick = function () {
          window.focus();
          irParaCampoChegada();
          n.close();
        };
      }
    } catch (e) {}
  }

  // ---- Ação: levar o usuário ao campo de chegada -----------------
  function irParaCampoChegada() {
    try {
      if (typeof irParaAba === "function") irParaAba("entregas");
      if (typeof abrirForm === "function") setTimeout(abrirForm, 120);
      setTimeout(() => {
        const campo = document.getElementById("hora_chegada");
        if (campo) {
          campo.scrollIntoView({ behavior: "smooth", block: "center" });
          campo.focus();
        }
      }, 450);
    } catch (e) {}
  }

  // ---- Banner visual ---------------------------------------------
  function injetarEstilo() {
    if (document.getElementById("lembreteChegadaStyle")) return;
    const st = document.createElement("style");
    st.id = "lembreteChegadaStyle";
    st.textContent = `
      #lembreteChegadaOverlay{position:fixed;inset:0;background:rgba(0,0,0,.45);
        z-index:99998;display:flex;align-items:flex-start;justify-content:center;
        padding-top:14vh;animation:lcFade .25s ease-out;}
      #lembreteChegadaBanner{width:92%;max-width:440px;background:var(--bg-elevated,#1e293b);
        border:1px solid var(--border,#334155);border-left:6px solid var(--azul,#38bdf8);
        border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.5);padding:22px 22px 18px;
        text-align:center;animation:lcPop .3s cubic-bezier(.2,.9,.3,1.2);}
      #lembreteChegadaBanner .lc-ico{font-size:40px;line-height:1;margin-bottom:8px;
        display:inline-block;animation:lcShake 1.2s ease-in-out infinite;}
      #lembreteChegadaBanner h3{margin:0 0 6px;font-size:18px;font-weight:800;
        color:var(--text-heading,#f1f5f9);}
      #lembreteChegadaBanner p{margin:0 0 18px;font-size:13.5px;line-height:1.5;
        color:var(--text-muted,#94a3b8);}
      #lembreteChegadaBanner .lc-acoes{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;}
      #lembreteChegadaBanner button{font-family:inherit;font-weight:700;font-size:13px;
        padding:10px 16px;border-radius:10px;cursor:pointer;border:1px solid transparent;}
      #lembreteChegadaBanner .lc-ok{background:var(--azul,#38bdf8);color:#06283b;flex:1 1 100%;}
      #lembreteChegadaBanner .lc-snooze{background:transparent;color:var(--text-muted,#94a3b8);
        border-color:var(--border,#334155);}
      #lembreteChegadaBanner .lc-fechar{background:transparent;color:var(--text-muted,#94a3b8);
        border-color:var(--border,#334155);}
      @keyframes lcFade{from{opacity:0}to{opacity:1}}
      @keyframes lcPop{from{opacity:0;transform:translateY(-18px) scale(.96)}to{opacity:1;transform:none}}
      @keyframes lcShake{0%,100%{transform:rotate(0)}15%{transform:rotate(-12deg)}30%{transform:rotate(12deg)}45%{transform:rotate(-8deg)}60%{transform:rotate(8deg)}75%{transform:rotate(0)}}
    `;
    document.head.appendChild(st);
  }

  function fecharBanner() {
    const ov = document.getElementById("lembreteChegadaOverlay");
    if (ov) ov.remove();
  }

  function mostrarBanner() {
    injetarEstilo();
    fecharBanner();

    const overlay = document.createElement("div");
    overlay.id = "lembreteChegadaOverlay";

    const banner = document.createElement("div");
    banner.id = "lembreteChegadaBanner";
    banner.innerHTML = `
      <span class="lc-ico">⏰</span>
      <h3>Horário de Chegada</h3>
      <p>São <strong>17:15</strong> — não esqueça de preencher o
         <strong>horário de chegada na rota</strong>.</p>
      <div class="lc-acoes">
        <button type="button" class="lc-ok">Preencher agora</button>
        <button type="button" class="lc-snooze">Lembrar em ${SNOOZE_MIN} min</button>
        <button type="button" class="lc-fechar">Dispensar hoje</button>
      </div>`;

    banner.querySelector(".lc-ok").addEventListener("click", function () {
      marcarTratadoHoje();
      fecharBanner();
      irParaCampoChegada();
    });
    banner.querySelector(".lc-snooze").addEventListener("click", function () {
      snoozeAte = Date.now() + SNOOZE_MIN * 60 * 1000;
      fecharBanner();
    });
    banner.querySelector(".lc-fechar").addEventListener("click", function () {
      marcarTratadoHoje();
      fecharBanner();
    });

    overlay.appendChild(banner);
    document.body.appendChild(overlay);
  }

  // ---- Disparo ---------------------------------------------------
  function disparar() {
    mostrarBanner();
    notificarNavegador();
    tocarBeep();
  }

  function verificar() {
    if (deveDisparar()) disparar();
  }

  // ---- Inicialização ---------------------------------------------
  function iniciar() {
    pedirPermissaoNotificacao();
    setTimeout(verificar, 2500); // checagem inicial após carregar o app
    setInterval(verificar, CHECK_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", iniciar);
  } else {
    iniciar();
  }

  // Atalho para teste manual no console: testarLembreteChegada()
  window.testarLembreteChegada = disparar;
})();
