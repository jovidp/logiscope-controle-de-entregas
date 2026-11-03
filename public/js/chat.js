// ================================================================
// CHAT ENTRE USUARIOS — balao flutuante (sala geral + mensagens diretas)
// Reusa o fetch autenticado de auth.js (token injetado automaticamente).
// ================================================================
(function iniciarChat() {
  const POLL_RESUMO_MS = 5000; // atualiza badges (sempre)
  const POLL_CONVERSA_MS = 3000; // atualiza mensagens da conversa aberta

  let usuario = null;
  let aberto = false;
  let view = "geral"; // 'geral' | 'contatos' | 'dm'
  let dmAlvo = null; // { id, nome } quando view === 'dm'
  let contatos = [];
  let resumo = { geral: 0, diretas: [], total: 0 };
  let mensagens = [];
  let ultimoId = 0;
  let timerResumo = null;
  let timerConversa = null;
  let totalAnterior = null; // p/ detectar quando chega mensagem nova (badge sobe)

  // --- Som de notificacao (Web Audio API, sem arquivo externo) ---
  let audioCtx = null;
  let mudo = localStorage.getItem("chatMudo") === "1";
  let ultimoSomTs = 0;

  function tocarSom() {
    if (mudo) return;
    const agora = Date.now();
    if (agora - ultimoSomTs < 1200) return; // evita tocar duas vezes seguidas
    ultimoSomTs = agora;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const ctx = audioCtx;
      const t0 = ctx.currentTime;
      const ganho = ctx.createGain();
      ganho.connect(ctx.destination);
      ganho.gain.setValueAtTime(0.0001, t0);
      ganho.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
      ganho.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, t0); // nota 1
      osc.frequency.setValueAtTime(1174.66, t0 + 0.12); // nota 2 (sobe)
      osc.connect(ganho);
      osc.start(t0);
      osc.stop(t0 + 0.5);
    } catch {
      /* silencioso */
    }
  }

  function alternarMudo() {
    mudo = !mudo;
    localStorage.setItem("chatMudo", mudo ? "1" : "0");
    atualizarBotaoMudo();
    if (!mudo) tocarSom(); // toca uma vez ao reativar, como previa
  }

  function atualizarBotaoMudo() {
    const btn = document.getElementById("chatMudoBtn");
    if (!btn) return;
    btn.textContent = mudo ? "🔇" : "🔔";
    btn.title = mudo ? "Som desativado" : "Som ativado";
  }

  function esc(v) {
    return escapar(v);
  }

  function horaFmt(ts) {
    try {
      return new Date(ts).toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  }

  async function api(path, options) {
    const resp = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...(options || {}),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(body.error || "Erro no chat.");
    return body;
  }

  // Identificador da conversa atual para os endpoints.
  function conversaAtual() {
    if (view === "dm" && dmAlvo) return String(dmAlvo.id);
    return "geral";
  }

  function injetarEstilos() {
    if (document.getElementById("chatEstilos")) return;
    const css = `
      #chatBtn{position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:50%;
        background:linear-gradient(135deg,var(--azul,#38bdf8),#2563eb);color:#fff;border:none;cursor:pointer;
        box-shadow:0 8px 24px rgba(37,99,235,.4);font-size:24px;z-index:9000;display:flex;align-items:center;
        justify-content:center;transition:transform .15s;}
      #chatBtn:hover{transform:scale(1.06);}
      #chatBtn .chat-badge{position:absolute;top:-3px;right:-3px;}
      .chat-badge{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#ef4444;color:#fff;
        font-size:11px;font-weight:800;display:none;align-items:center;justify-content:center;line-height:1;}
      .chat-badge.on{display:inline-flex;}
      #chatPainel{position:fixed;right:20px;bottom:88px;width:340px;max-width:calc(100vw - 32px);height:480px;
        max-height:calc(100vh - 120px);background:var(--bg-elevated,#0f172a);border:1px solid var(--border,#1e293b);
        border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.5);z-index:9000;display:none;flex-direction:column;
        overflow:hidden;font-family:inherit;}
      #chatPainel.aberto{display:flex;}
      .chat-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--border,#1e293b);
        background:rgba(255,255,255,.02);}
      .chat-head .chat-titulo{font-weight:800;color:var(--text-heading,#f8fafc);font-size:14px;flex:1;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .chat-head button{background:none;border:none;color:var(--text-muted,#94a3b8);cursor:pointer;font-size:16px;
        padding:2px 6px;border-radius:6px;}
      .chat-head button:hover{background:rgba(255,255,255,.06);color:var(--text-heading,#f8fafc);}
      .chat-tabs{display:flex;border-bottom:1px solid var(--border,#1e293b);}
      .chat-tab{flex:1;padding:9px;background:none;border:none;color:var(--text-muted,#94a3b8);cursor:pointer;
        font-size:12px;font-weight:700;font-family:inherit;position:relative;}
      .chat-tab.ativa{color:var(--azul,#38bdf8);box-shadow:inset 0 -2px 0 var(--azul,#38bdf8);}
      .chat-tab .chat-badge{position:absolute;top:5px;right:14px;}
      .chat-corpo{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;}
      .chat-msg{max-width:80%;padding:7px 11px;border-radius:12px;font-size:13px;line-height:1.35;word-wrap:break-word;}
      .chat-msg .chat-de{font-size:10px;font-weight:800;opacity:.8;margin-bottom:2px;}
      .chat-msg .chat-hora{font-size:9px;opacity:.55;margin-top:3px;text-align:right;}
      .chat-msg.eu{align-self:flex-end;background:linear-gradient(135deg,var(--azul,#38bdf8),#2563eb);color:#fff;
        border-bottom-right-radius:4px;}
      .chat-msg.outro{align-self:flex-start;background:rgba(255,255,255,.06);color:var(--text-heading,#f1f5f9);
        border:1px solid var(--border,#1e293b);border-bottom-left-radius:4px;}
      .chat-vazio{color:var(--text-muted,#94a3b8);font-size:12px;text-align:center;margin:auto;}
      .chat-contato{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;cursor:pointer;}
      .chat-contato:hover{background:rgba(255,255,255,.05);}
      .chat-contato .chat-av{width:34px;height:34px;border-radius:50%;background:rgba(56,189,248,.15);
        color:var(--azul,#38bdf8);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;}
      .chat-contato .chat-nome{flex:1;font-size:13px;font-weight:700;color:var(--text-heading,#f1f5f9);}
      .chat-compositor{display:flex;gap:8px;padding:10px;border-top:1px solid var(--border,#1e293b);}
      .chat-compositor input{flex:1;background:rgba(255,255,255,.04);border:1px solid var(--border,#1e293b);
        border-radius:10px;padding:9px 12px;color:var(--text-heading,#f8fafc);font-size:13px;font-family:inherit;outline:none;}
      .chat-compositor input:focus{border-color:var(--azul,#38bdf8);}
      .chat-compositor button{background:var(--azul,#38bdf8);border:none;color:#fff;border-radius:10px;padding:0 14px;
        cursor:pointer;font-weight:800;}
    `;
    const style = document.createElement("style");
    style.id = "chatEstilos";
    style.textContent = css;
    document.head.appendChild(style);
  }

  function construir() {
    if (document.getElementById("chatBtn")) return;
    const btn = document.createElement("button");
    btn.id = "chatBtn";
    btn.type = "button";
    btn.title = "Chat da equipe";
    btn.innerHTML = `💬<span class="chat-badge" id="chatBtnBadge"></span>`;
    btn.addEventListener("click", alternarPainel);
    document.body.appendChild(btn);

    const painel = document.createElement("div");
    painel.id = "chatPainel";
    painel.innerHTML = `
      <div class="chat-head">
        <button type="button" id="chatVoltar" title="Voltar" style="display:none;">←</button>
        <span class="chat-titulo" id="chatTitulo">Chat da equipe</span>
        <button type="button" id="chatMudoBtn" title="Som ativado">🔔</button>
        <button type="button" id="chatFechar" title="Fechar">✕</button>
      </div>
      <div class="chat-tabs" id="chatTabs">
        <button type="button" class="chat-tab ativa" data-view="geral">Geral<span class="chat-badge" id="chatBadgeGeral"></span></button>
        <button type="button" class="chat-tab" data-view="contatos">Diretas<span class="chat-badge" id="chatBadgeDiretas"></span></button>
      </div>
      <div class="chat-corpo" id="chatCorpo"></div>
      <div class="chat-compositor" id="chatCompositor" style="display:none;">
        <input type="text" id="chatInput" placeholder="Escreva uma mensagem..." maxlength="2000" autocomplete="off" />
        <button type="button" id="chatEnviar">➤</button>
      </div>`;
    document.body.appendChild(painel);

    painel.querySelectorAll(".chat-tab").forEach((t) =>
      t.addEventListener("click", () => trocarView(t.dataset.view)),
    );
    document.getElementById("chatFechar").addEventListener("click", alternarPainel);
    document.getElementById("chatMudoBtn").addEventListener("click", alternarMudo);
    atualizarBotaoMudo();
    document.getElementById("chatVoltar").addEventListener("click", () => trocarView("contatos"));
    document.getElementById("chatEnviar").addEventListener("click", enviar);
  }

  function alternarPainel() {
    aberto = !aberto;
    document.getElementById("chatPainel").classList.toggle("aberto", aberto);
    if (aberto) {
      trocarView(view === "dm" ? "dm" : "geral");
    } else {
      pararPollConversa();
    }
  }

  function trocarView(novo) {
    view = novo;
    const ehConversa = novo === "geral" || novo === "dm";
    document.getElementById("chatCompositor").style.display = ehConversa ? "flex" : "none";
    document.getElementById("chatVoltar").style.display = novo === "dm" ? "" : "none";

    document.querySelectorAll("#chatTabs .chat-tab").forEach((t) => {
      const ativa = (novo === "geral" && t.dataset.view === "geral") ||
        ((novo === "contatos" || novo === "dm") && t.dataset.view === "contatos");
      t.classList.toggle("ativa", ativa);
    });

    if (novo === "geral") {
      document.getElementById("chatTitulo").textContent = "Chat da equipe";
      abrirConversa("geral");
    } else if (novo === "dm") {
      document.getElementById("chatTitulo").textContent = dmAlvo ? dmAlvo.nome : "Conversa";
      abrirConversa(String(dmAlvo.id));
    } else {
      pararPollConversa();
      document.getElementById("chatTitulo").textContent = "Mensagens diretas";
      renderContatos(); // mostra o que ja temos em cache
      // ...e recarrega do servidor (pega usuarios cadastrados apos abrir a pagina)
      carregarContatos().then(() => {
        if (view === "contatos") renderContatos();
      });
    }
  }

  function renderContatos() {
    const corpo = document.getElementById("chatCorpo");
    if (!contatos.length) {
      corpo.innerHTML = `<div class="chat-vazio">Nenhum outro usuario cadastrado.</div>`;
      return;
    }
    const naoLidasPorId = {};
    (resumo.diretas || []).forEach((d) => (naoLidasPorId[d.usuario_id] = d.qtd));
    corpo.innerHTML = contatos
      .map((c) => {
        const inicial = esc((c.nome || "?").trim().charAt(0).toUpperCase());
        const n = naoLidasPorId[c.id] || 0;
        return `<div class="chat-contato" data-id="${c.id}" data-nome="${esc(c.nome)}">
          <div class="chat-av">${inicial}</div>
          <div class="chat-nome">${esc(c.nome)}</div>
          <span class="chat-badge ${n ? "on" : ""}">${n || ""}</span>
        </div>`;
      })
      .join("");
    corpo.querySelectorAll(".chat-contato").forEach((el) =>
      el.addEventListener("click", () => {
        dmAlvo = { id: Number(el.dataset.id), nome: el.dataset.nome };
        trocarView("dm");
      }),
    );
  }

  function renderMensagens(scrollFim = true) {
    const corpo = document.getElementById("chatCorpo");
    if (!mensagens.length) {
      corpo.innerHTML = `<div class="chat-vazio">Nenhuma mensagem ainda. Diga ola!</div>`;
      return;
    }
    const mostrarNome = view === "geral";
    corpo.innerHTML = mensagens
      .map((m) => {
        const eu = m.remetente_id === usuario.id;
        const de = !eu && mostrarNome ? `<div class="chat-de">${esc(m.remetente_nome)}</div>` : "";
        return `<div class="chat-msg ${eu ? "eu" : "outro"}">
          ${de}<div>${esc(m.texto)}</div>
          <div class="chat-hora">${horaFmt(m.criado_em)}</div>
        </div>`;
      })
      .join("");
    if (scrollFim) corpo.scrollTop = corpo.scrollHeight;
  }

  async function abrirConversa(conversa) {
    pararPollConversa();
    mensagens = [];
    ultimoId = 0;
    document.getElementById("chatCorpo").innerHTML = `<div class="chat-vazio">Carregando...</div>`;
    try {
      const lista = await api(`/chat/mensagens?conversa=${encodeURIComponent(conversa)}`);
      mensagens = lista;
      ultimoId = lista.length ? lista[lista.length - 1].id : 0;
      renderMensagens();
      await marcarLido(conversa);
    } catch (err) {
      document.getElementById("chatCorpo").innerHTML =
        `<div class="chat-vazio">Falha ao carregar: ${esc(err.message)}</div>`;
    }
    timerConversa = setInterval(() => atualizarConversa(conversa), POLL_CONVERSA_MS);
  }

  async function atualizarConversa(conversa) {
    if (document.hidden || !aberto) return;
    try {
      const novas = await api(
        `/chat/mensagens?conversa=${encodeURIComponent(conversa)}&after=${ultimoId}`,
      );
      if (novas.length) {
        mensagens = mensagens.concat(novas);
        ultimoId = novas[novas.length - 1].id;
        renderMensagens();
        if (novas.some((m) => m.remetente_id !== usuario.id)) tocarSom();
        await marcarLido(conversa);
      }
    } catch {
      /* silencioso */
    }
  }

  function pararPollConversa() {
    if (timerConversa) {
      clearInterval(timerConversa);
      timerConversa = null;
    }
  }

  async function marcarLido(conversa) {
    try {
      await api("/chat/ler", {
        method: "POST",
        body: JSON.stringify({ conversa }),
      });
      atualizarResumo();
    } catch {
      /* silencioso */
    }
  }

  async function enviar() {
    const input = document.getElementById("chatInput");
    const texto = input.value.trim();
    if (!texto) return;
    input.value = "";
    const destinatario_id = view === "dm" && dmAlvo ? dmAlvo.id : null;
    try {
      const msg = await api("/chat/mensagens", {
        method: "POST",
        body: JSON.stringify({ texto, destinatario_id }),
      });
      mensagens.push(msg);
      ultimoId = msg.id;
      renderMensagens();
    } catch (err) {
      input.value = texto;
      alertar(err.message);
    }
  }

  function aplicarBadges() {
    const setBadge = (id, n) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = n > 99 ? "99+" : n || "";
      el.classList.toggle("on", n > 0);
    };
    setBadge("chatBtnBadge", resumo.total);
    setBadge("chatBadgeGeral", resumo.geral);
    const totalDiretas = (resumo.diretas || []).reduce((a, d) => a + d.qtd, 0);
    setBadge("chatBadgeDiretas", totalDiretas);
    if (view === "contatos" && aberto) renderContatos();
  }

  async function atualizarResumo() {
    if (document.hidden) return;
    try {
      resumo = await api("/chat/resumo");
      // toca o som quando o total de nao lidas aumenta (mensagem nova chegou).
      // na 1a leitura so guarda o valor, sem tocar.
      if (totalAnterior !== null && resumo.total > totalAnterior) tocarSom();
      totalAnterior = resumo.total;
      aplicarBadges();
    } catch {
      /* silencioso */
    }
  }

  async function carregarContatos() {
    try {
      contatos = await api("/chat/contatos");
    } catch {
      contatos = [];
    }
  }

  async function start() {
    usuario = await window.authReady;
    if (!usuario) return; // sem login: nao monta o chat
    injetarEstilos();
    construir();
    await carregarContatos();
    await atualizarResumo();
    timerResumo = setInterval(atualizarResumo, POLL_RESUMO_MS);
  }

  if (window.authReady && typeof window.authReady.then === "function") {
    start();
  } else {
    document.addEventListener("DOMContentLoaded", start);
  }
})();
