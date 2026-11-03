// ================================================================
// gps-eventos.js (front) — avisos ao vivo do GPS
// ----------------------------------------------------------------
// O servidor (back/rastreador-ao-vivo.js) detecta pela posicao dos caminhoes:
// chegou/saiu de loja, saiu/voltou para a fabrica, chegando na proxima loja
// (ETA <= 15 min) e parada de pernoite. Cada evento chega por SSE com origem
// 'gps' — o event-bus.js manda para "gps:evento" (sem o refresh geral).
//
//   - notificacao no canto da tela (some sozinha; 🔕 silencia neste PC);
//   - lista "📍 Movimento de hoje" dentro do painel 🛰 Frota agora (aba TMS);
//   - window.gpsEventosDoDia(placa, data) para o formulario de ocorrencia
//     puxar Horario do rastreador / Saida GPS / Saida da fabrica.
// ================================================================
(function () {
  "use strict";

  const API = () => window.location.origin;
  const LS_MUDO = "controleEntregaGpsMudo";
  const ICONE = { chegou_loja: "📍", saiu_loja: "🚚", saiu_fabrica: "🏭➡️", voltou_fabrica: "🏭", chegando_loja: "⏱️", hotel: "🏨",
    // Status da viagem andando pelo GPS (back/tms-status-gps.js).
    viagem_em_rota: "🚚", viagem_retorno: "↩️", viagem_finalizada: "🏁", viagem_retorno_preenchido: "🏁", viagem_reaberta: "🔄" };
  const COR = { chegou_loja: "#16a34a", saiu_loja: "#0ea5e9", saiu_fabrica: "#0ea5e9", voltou_fabrica: "#64748b", chegando_loja: "#d97706", hotel: "#a855f7",
    viagem_finalizada: "#16a34a", viagem_retorno_preenchido: "#16a34a", viagem_reaberta: "#d97706" };
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const hhmm = (d) => new Date(d).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const hojeISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const mudo = () => { try { return localStorage.getItem(LS_MUDO) === "1"; } catch (_) { return false; } };

  // ---------------------------------------------------------- notificacao
  function pilha() {
    let p = document.getElementById("gpsToasts");
    if (!p) {
      p = document.createElement("div");
      p.id = "gpsToasts";
      p.setAttribute("aria-live", "polite");
      p.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:9998;display:flex;flex-direction:column;gap:8px;max-width:min(380px,calc(100vw - 32px));";
      document.body.appendChild(p);
    }
    return p;
  }

  function notificar(e) {
    if (mudo()) return;
    const t = document.createElement("div");
    t.style.cssText = `background:var(--bg-elevated,#1e293b);color:var(--text-heading,#f1f5f9);border:1px solid var(--border,#334155);border-left:4px solid ${COR[e.tipo] || "#64748b"};border-radius:10px;padding:10px 12px;box-shadow:0 8px 24px rgba(0,0,0,.25);font-size:13px;display:flex;gap:10px;align-items:flex-start;`;
    const extra = [e.motorista, e.rota].filter(Boolean).join(" · ");
    t.innerHTML = `<span style="font-size:18px;line-height:1;">${ICONE[e.tipo] || "🛰"}</span>
      <div style="flex:1;min-width:0;"><b>${esc(e.texto || "")}</b>
        <div style="font-size:11px;color:var(--text-muted,#94a3b8);margin-top:2px;">${esc(hhmm(e.em || Date.now()))}${extra ? " · " + esc(extra) : ""}</div></div>
      <button type="button" title="Fechar" style="all:unset;cursor:pointer;color:var(--text-muted,#94a3b8);font-size:16px;line-height:1;">×</button>`;
    t.querySelector("button").onclick = () => t.remove();
    pilha().appendChild(t);
    setTimeout(() => t.remove(), 9000);
    while (pilha().children.length > 4) pilha().firstChild.remove();
  }

  // ---------------------------------------------------------- dados
  async function buscar(data, placa) {
    const q = new URLSearchParams({ data: data || hojeISO() });
    if (placa) q.set("placa", placa);
    const r = await fetch(`${API()}/tms/gps-eventos?${q}`, { headers: { Accept: "application/json" } });
    if (!r.ok) return [];
    return r.json();
  }
  window.gpsEventosDoDia = (placa, data) => buscar(data, placa).catch(() => []);

  // ---------------------------------------------------------- lista no painel Frota
  function caixa() {
    const frota = document.getElementById("tmsFrota");
    if (!frota) return null;
    let c = document.getElementById("gpsMovimento");
    if (!c) {
      c = document.createElement("div");
      c.id = "gpsMovimento";
      c.style.cssText = "margin-top:14px;";
      c.innerHTML = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          <b style="font-size:13px;">📍 Movimento de hoje</b>
          <span id="gpsMovimentoSub" style="font-size:11px;color:var(--text-muted);"></span>
          <button type="button" id="gpsMudoBtn" class="btn-ghost btn-sm" style="margin-left:auto;"></button>
        </div><div id="gpsMovimentoLista"></div>`;
      frota.appendChild(c);
      c.querySelector("#gpsMudoBtn").onclick = () => {
        try { localStorage.setItem(LS_MUDO, mudo() ? "0" : "1"); } catch (_) {}
        rotularMudo();
      };
      rotularMudo();
    }
    return c;
  }
  function rotularMudo() {
    const b = document.getElementById("gpsMudoBtn");
    if (b) {
      b.textContent = mudo() ? "🔕 Avisos desligados" : "🔔 Avisos ligados";
      b.title = mudo() ? "Voltar a mostrar os avisos de chegada/saída neste computador" : "Parar de mostrar os avisos de chegada/saída neste computador";
    }
  }

  let ultima = [];
  async function atualizarLista() {
    const c = caixa();
    if (!c || document.getElementById("tmsFrota").style.display === "none") return;
    try { ultima = await buscar(hojeISO()); } catch (_) { return; }
    const lista = document.getElementById("gpsMovimentoLista");
    const sub = document.getElementById("gpsMovimentoSub");
    if (sub) sub.textContent = ultima.length ? `${ultima.length} evento(s)` : "";
    if (!lista) return;
    lista.innerHTML = ultima.length
      ? ultima.slice(0, 40).map((e) => `<div style="display:flex;gap:10px;align-items:center;padding:5px 0;border-top:1px solid var(--border);font-size:12.5px;">
          <span style="font-family:var(--font-mono,monospace);color:var(--text-muted);min-width:42px;">${esc(hhmm(e.em))}</span>
          <span>${ICONE[e.tipo] || "🛰"}</span>
          <span style="flex:1;">${esc(e.texto)}${e.detalhe ? ` <span style="color:var(--text-muted);font-size:11px;">(${esc(e.detalhe)})</span>` : ""}</span>
          ${e.fonte === "t4s" ? `<span style="font-size:10px;font-weight:700;color:var(--text-muted);border:1px solid var(--border);border-radius:999px;padding:1px 7px;">T4S</span>` : ""}
        </div>`).join("")
      : `<p style="color:var(--text-muted);font-size:12px;margin:4px 0;">Nenhuma chegada ou saída detectada hoje ainda.</p>`;
  }

  // ---------------------------------------------------------- liga
  function ligar() {
    if (!window.Bus) return;
    window.Bus.on("gps:evento", (e) => {
      notificar(e);
      atualizarLista();
    });
  }

  setInterval(() => {
    const aba = document.getElementById("aba-tms");
    if (aba && aba.offsetParent !== null) atualizarLista();
  }, 60000);

  const arranca = () => { ligar(); setTimeout(atualizarLista, 2500); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", arranca);
  else arranca();
})();
