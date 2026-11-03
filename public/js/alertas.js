// ================================================================
// ALERTAS PROATIVOS — sino 🚨 do header (feed + push ao vivo)
// ----------------------------------------------------------------
// Consome GET /alertas (o motor avaliarAlertas() no backend gera). Mostra um
// badge com os não-lidos e um painel dropdown com a lista priorizada. Clicar
// num alerta marca como lido e faz deep-link (ocorrência abre no form da aba
// entregas; senão vai pra aba relevante). Reage ao window.Bus "dados:mudou":
// quando o servidor empurra um alerta novo (SSE origem 'alerta'), refaz a
// busca e dá um toast. O canal externo (Telegram) é opcional e vive no
// backend — aqui é sempre in-app. Segue o padrão do fila-resolver.
// ================================================================
(function () {
  "use strict";

  const REFRESH_MS = 60000;
  let carregando = false;
  let itens = [];
  let naoLidos = 0;
  let aberto = false;
  let ultimoTotalNaoLido = 0;

  const Bus = window.Bus || (window.Bus = (function () {
    const ouv = {};
    return {
      on(e, f) { (ouv[e] = ouv[e] || []).push(f); return () => Bus.off(e, f); },
      off(e, f) { ouv[e] = (ouv[e] || []).filter((x) => x !== f); },
      emit(e, d) { (ouv[e] || []).forEach((f) => { try { f(d); } catch (x) { console.error("[Bus]", e, x); } }); },
    };
  })());

  function esc(v) {
    return escapar(v);
  }

  const SEV = {
    alta: { cor: "#ef4444", ic: "🔴" },
    media: { cor: "#f59e0b", ic: "🟡" },
    baixa: { cor: "#22c55e", ic: "🟢" },
  };

  function injetarEstilos() {
    if (document.getElementById("alEstilos")) return;
    const css = `
      #alertasPainel{position:absolute;top:52px;right:12px;width:min(380px,92vw);z-index:1200;
        background:var(--bg-elevated,#0f172a);border:1px solid var(--border,#1e293b);border-radius:14px;
        box-shadow:0 18px 48px rgba(0,0,0,.5);overflow:hidden;display:none;}
      #alertasPainel.aberto{display:block;}
      .al-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--border,#1e293b);}
      .al-head strong{font-size:14px;color:var(--text-heading,#f8fafc);}
      .al-head .al-cnt{background:#ef4444;color:#fff;font-size:11px;font-weight:800;border-radius:9px;padding:1px 7px;}
      .al-head .al-acoes{margin-left:auto;display:flex;gap:6px;}
      .al-head button{background:transparent;border:1px solid var(--border,#334155);color:var(--text-muted,#94a3b8);
        border-radius:7px;padding:5px 8px;font-size:11px;cursor:pointer;}
      .al-head button:hover{color:var(--text-heading,#e2e8f0);border-color:#38bdf8;}
      .al-lista{max-height:min(60vh,440px);overflow-y:auto;}
      .al-item{display:flex;gap:10px;padding:10px 13px;border-bottom:1px solid rgba(255,255,255,.05);
        cursor:pointer;border-left:3px solid transparent;transition:background .15s;}
      .al-item:hover{background:rgba(255,255,255,.03);}
      .al-item.nao-lido{background:rgba(56,189,248,.05);}
      .al-bolinha{flex:0 0 auto;width:9px;height:9px;border-radius:50%;margin-top:5px;}
      .al-txt{min-width:0;flex:1 1 auto;}
      .al-txt strong{display:block;font-size:13px;color:var(--text-heading,#e2e8f0);font-weight:600;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .al-txt small{display:block;font-size:11px;color:var(--text-muted,#94a3b8);margin-top:2px;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .al-quando{flex:0 0 auto;font-size:10px;color:var(--text-muted,#64748b);white-space:nowrap;margin-top:2px;}
      .al-vazio{padding:26px 14px;text-align:center;color:var(--text-muted,#94a3b8);font-size:13px;}
      .al-toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%) translateY(20px);z-index:2000;
        background:var(--bg-elevated,#0f172a);border:1px solid #ef4444;border-radius:12px;padding:11px 16px;
        box-shadow:0 12px 36px rgba(0,0,0,.5);font-size:13px;color:var(--text-heading,#e2e8f0);
        display:flex;align-items:center;gap:9px;opacity:0;transition:all .3s ease;pointer-events:none;max-width:90vw;}
      .al-toast.show{opacity:1;transform:translateX(-50%) translateY(0);}
    `;
    const s = document.createElement("style");
    s.id = "alEstilos"; s.textContent = css;
    document.head.appendChild(s);
  }

  function garantirPainel() {
    let p = document.getElementById("alertasPainel");
    if (p) return p;
    p = document.createElement("div");
    p.id = "alertasPainel";
    document.body.appendChild(p);
    return p;
  }

  function setBadge(n) {
    const b = document.getElementById("alertasBadge");
    if (!b) return;
    b.textContent = n > 99 ? "99+" : String(n);
    b.style.display = n > 0 ? "inline-flex" : "none";
  }

  function render() {
    injetarEstilos();
    const p = garantirPainel();
    const acoes = itens.length
      ? `<button type="button" id="alLerTodos">✓ Ler todos</button><button type="button" id="alRefresh">↻</button>`
      : `<button type="button" id="alRefresh">↻</button>`;
    const corpo = itens.length
      ? itens.map((a) => {
          const sev = SEV[a.severidade] || SEV.media;
          return `<div class="al-item ${a.lido ? "" : "nao-lido"}" data-id="${a.id}">
            <span class="al-bolinha" style="background:${sev.cor};"></span>
            <span class="al-txt"><strong>${esc(a.titulo)}</strong><small>${esc(a.detalhe || "")}</small></span>
            <span class="al-quando">${esc(a.criado || "")}</span>
          </div>`;
        }).join("")
      : `<div class="al-vazio">✓ Nenhum alerta aberto.<br>Tudo sob controle.</div>`;
    p.innerHTML = `
      <div class="al-head"><strong>🚨 Alertas</strong>${naoLidos ? `<span class="al-cnt">${naoLidos}</span>` : ""}
        <span class="al-acoes">${acoes}</span></div>
      <div class="al-lista">${corpo}</div>`;
    p.classList.toggle("aberto", aberto);

    p.querySelectorAll(".al-item").forEach((el) =>
      el.addEventListener("click", () => abrirAlerta(Number(el.dataset.id))));
    document.getElementById("alLerTodos")?.addEventListener("click", (e) => { e.stopPropagation(); lerTodos(); });
    document.getElementById("alRefresh")?.addEventListener("click", (e) => { e.stopPropagation(); atualizar(); });
  }

  // Deep-link do alerta (mesma logica do fila-resolver).
  function irPara(a) {
    if (!a) return;
    if (a.ocorrencia_id && typeof window.editarOcorrencia === "function") {
      if (typeof window.irParaAba === "function") window.irParaAba("entregas");
      setTimeout(() => {
        window.editarOcorrencia(a.ocorrencia_id);
        setTimeout(() => document.getElementById("form")?.scrollIntoView({ behavior: "smooth", block: "start" }), 140);
      }, 60);
      return;
    }
    if (a.aba && typeof window.irParaAba === "function") window.irParaAba(a.aba);
  }

  async function abrirAlerta(id) {
    const a = itens.find((x) => x.id === id);
    fechar();
    irPara(a);
    if (a && !a.lido) { try { await fetch(`${window.location.origin}/alertas/${id}/lido`, { method: "POST" }); } catch (_) {} atualizar(); }
  }

  async function lerTodos() {
    try { await fetch(`${window.location.origin}/alertas/lidos`, { method: "POST" }); } catch (_) {}
    atualizar();
  }

  function abrir() { aberto = true; render(); }
  function fechar() { aberto = false; const p = document.getElementById("alertasPainel"); if (p) p.classList.remove("aberto"); }
  function alternar() { aberto ? fechar() : abrir(); }

  function toast(msg) {
    injetarEstilos();
    let t = document.getElementById("alToast");
    if (!t) { t = document.createElement("div"); t.id = "alToast"; t.className = "al-toast"; document.body.appendChild(t); }
    t.innerHTML = `🚨 ${esc(msg)}`;
    t.classList.add("show");
    clearTimeout(t._tm);
    t._tm = setTimeout(() => t.classList.remove("show"), 4500);
  }

  async function atualizar() {
    if (carregando) return;
    carregando = true;
    try {
      const resp = await fetch(`${window.location.origin}/alertas`, { headers: { Accept: "application/json" } });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const j = await resp.json();
      itens = j.alertas || [];
      naoLidos = j.nao_lidos || 0;
      setBadge(naoLidos);
      if (aberto) render();
    } catch (_) { /* silencioso: alerta nao pode atrapalhar o resto */ }
    finally { carregando = false; }
  }

  window.abrirAlertas = abrir;
  window.alertasAtualizar = atualizar;

  // Push ao vivo: o SSE do servidor vira "dados:mudou". Se veio um alerta novo,
  // recarrega e avisa; qualquer outra mudanca tambem revalida (barato).
  Bus.on("dados:mudou", (d) => {
    const eraAlerta = d && d.origem === "alerta";
    atualizar().then(() => {
      if (eraAlerta && naoLidos > ultimoTotalNaoLido && itens[0]) toast(itens[0].titulo);
      ultimoTotalNaoLido = naoLidos;
    });
  });

  document.addEventListener("click", (e) => {
    const sino = document.getElementById("alertasSino");
    const painel = document.getElementById("alertasPainel");
    if (sino && sino.contains(e.target)) { e.preventDefault(); alternar(); return; }
    if (aberto && painel && !painel.contains(e.target)) fechar();
  });

  setInterval(atualizar, REFRESH_MS);

  document.addEventListener("DOMContentLoaded", () => {
    // Semeia o baseline com o que ja existe, pra so dar toast em alerta REALMENTE novo.
    const arranca = () => atualizar().then(() => { ultimoTotalNaoLido = naoLidos; });
    if (window.authReady && typeof window.authReady.then === "function") window.authReady.then(arranca);
    else arranca();
  });
})();
