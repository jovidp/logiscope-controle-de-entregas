// ================================================================
// QUALIDADE DE DADO — "o painel vale o que os inputs valem"
// ----------------------------------------------------------------
// Seção colapsável no Dashboard. Consome GET /painel/qualidade e mostra um
// ÍNDICE (média da completude dos campos essenciais + condicionais), a lista
// de campos do pior ao melhor (pra equipe ver onde falta preencher) e os
// motoristas com pior completude. Campos condicionais já vêm medidos no
// denominador certo (ex.: tipo_problema só quando houve ocorrência). Fica
// recolhida por padrão pra não competir com os outros painéis.
// ================================================================
(function () {
  "use strict";

  const REFRESH_MS = 5 * 60 * 1000;
  const PERIODOS = [{ d: 30, l: "30d" }, { d: 90, l: "90d" }, { d: 365, l: "Tudo" }];
  let janela = 90;
  let carregando = false;
  let ultimo = null;
  let expandido = false;
  let juntarAberto = false; // ferramenta ADM "Juntar rotas" (unificar grafias)
  let rotasUso = null;      // cache da lista {rota, n} de /rotas/uso

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
  function dashboardVisivel() {
    const aba = document.getElementById("aba-dashboard");
    return aba && !aba.classList.contains("aba-hidden");
  }
  function ehAdm() { return !!(window.authUsuario && window.authUsuario.perfil === "ADM"); }
  function cor(pct) {
    if (pct == null) return "#64748b";
    if (pct >= 80) return "#22c55e";
    if (pct >= 50) return "#f59e0b";
    return "#ef4444";
  }
  const GRUPO_LABEL = { essencial: "Essenciais", condicional: "Condicionais", avancado: "Oportunidades (quase sem uso hoje)" };

  function injetarEstilos() {
    if (document.getElementById("qdEstilos")) return;
    const css = `
      .qd-sec{background:var(--bg-elevated,#0f172a);border:1px solid var(--border,#1e293b);
        border-radius:14px;padding:14px 16px;margin-bottom:12px;}
      .qd-sec[hidden]{display:none;}
      .qd-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
      .qd-head h3{margin:0;font-size:15px;color:var(--text-heading,#f8fafc);display:flex;align-items:center;gap:9px;}
      .qd-indice{font-size:13px;font-weight:800;padding:2px 9px;border-radius:8px;}
      .qd-periodo{display:flex;gap:4px;}
      .qd-pbtn{background:transparent;border:1px solid var(--border,#1e293b);color:var(--text-muted,#94a3b8);
        border-radius:7px;padding:3px 8px;font-size:11px;cursor:pointer;}
      .qd-pbtn.ativo{background:rgba(56,189,248,.15);border-color:#38bdf8;color:#7dd3fc;}
      .qd-toggle{background:transparent;border:1px solid var(--border,#1e293b);color:var(--text-muted,#94a3b8);
        border-radius:7px;padding:4px 10px;font-size:11.5px;cursor:pointer;margin-left:auto;}
      .qd-toggle:hover{border-color:#38bdf8;color:var(--text-heading,#e2e8f0);}
      .qd-refresh{background:transparent;border:1px solid var(--border,#1e293b);color:var(--text-muted,#94a3b8);
        width:28px;height:28px;border-radius:8px;cursor:pointer;font-size:14px;line-height:1;}
      .qd-refresh.qd-girando{animation:qdSpin .8s linear infinite;}@keyframes qdSpin{to{transform:rotate(360deg);}}
      .qd-resumo{margin-top:9px;font-size:12px;color:var(--text-muted,#94a3b8);line-height:1.5;}
      .qd-resumo b{color:#fca5a5;}
      .qd-corpo{margin-top:12px;}
      .qd-corpo[hidden]{display:none;}
      .qd-grupo{font-size:10.5px;letter-spacing:.5px;text-transform:uppercase;color:var(--text-muted,#64748b);
        margin:12px 0 7px;}
      .qd-grupo:first-child{margin-top:0;}
      .qd-campo{display:flex;align-items:center;gap:10px;margin-bottom:7px;}
      .qd-lbl{flex:0 0 42%;min-width:0;font-size:12px;color:var(--text-heading,#e2e8f0);
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .qd-lbl small{color:var(--text-muted,#64748b);font-size:10.5px;}
      .qd-barra{flex:1 1 auto;height:9px;border-radius:5px;background:rgba(255,255,255,.06);overflow:hidden;}
      .qd-fill{height:100%;border-radius:5px;transition:width .4s ease;}
      .qd-val{flex:0 0 auto;width:96px;text-align:right;font-size:11.5px;color:var(--text-muted,#94a3b8);}
      .qd-val b{font-weight:800;}
      .qd-mot{margin-top:14px;border-top:1px dashed var(--border,#1e293b);padding-top:11px;}
      .qd-mot h4{margin:0 0 9px;font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--text-muted,#94a3b8);}
      .qd-mot-item{display:flex;align-items:center;gap:9px;margin-bottom:6px;font-size:12px;}
      .qd-mot-pct{flex:0 0 auto;width:40px;font-weight:800;text-align:right;}
      .qd-mot-nome{flex:1 1 auto;color:var(--text-heading,#e2e8f0);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .qd-mot-n{flex:0 0 auto;font-size:10.5px;color:var(--text-muted,#64748b);}
      .qd-vazio{padding:10px 0;color:var(--text-muted,#94a3b8);font-size:12.5px;}
      .qd-acao{margin-top:12px;background:rgba(56,189,248,.06);border:1px solid rgba(56,189,248,.2);
        border-radius:9px;padding:9px 11px;font-size:11.5px;color:var(--text-muted,#94a3b8);
        display:flex;align-items:center;gap:9px;flex-wrap:wrap;}
      .qd-acao b{color:#7dd3fc;}
      .qd-btn{margin-left:auto;background:linear-gradient(135deg,#38bdf8,#2563eb);color:#fff;border:none;
        border-radius:8px;padding:7px 12px;font-size:11.5px;font-weight:700;cursor:pointer;white-space:nowrap;}
      .qd-btn:disabled{opacity:.55;cursor:default;}
      .qd-juntar-wrap{margin-top:12px;border-top:1px dashed var(--border,#1e293b);padding-top:11px;}
      .qd-juntar-tog{background:transparent;border:1px solid var(--border,#1e293b);color:var(--text-muted,#94a3b8);
        border-radius:8px;padding:7px 11px;font-size:12px;cursor:pointer;width:100%;text-align:left;}
      .qd-juntar-tog:hover{border-color:#38bdf8;color:var(--text-heading,#e2e8f0);}
      .qd-juntar-load{padding:10px 2px;color:var(--text-muted,#94a3b8);font-size:12px;}
      .qd-juntar-hint{margin:10px 0;font-size:11.5px;color:var(--text-muted,#94a3b8);line-height:1.5;}
      .qd-juntar-lista{max-height:220px;overflow:auto;border:1px solid var(--border,#1e293b);border-radius:9px;padding:6px;}
      .qd-juntar-item{display:flex;align-items:center;gap:9px;padding:5px 6px;border-radius:7px;cursor:pointer;font-size:12.5px;}
      .qd-juntar-item:hover{background:rgba(255,255,255,.04);}
      .qd-juntar-chk{flex:0 0 auto;width:15px;height:15px;cursor:pointer;}
      .qd-juntar-nome{flex:1 1 auto;color:var(--text-heading,#e2e8f0);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .qd-juntar-n{flex:0 0 auto;font-size:10.5px;color:var(--text-muted,#64748b);background:rgba(255,255,255,.05);
        border-radius:6px;padding:1px 7px;}
      .qd-juntar-acao{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:11px;}
      .qd-juntar-destlbl{font-size:11.5px;color:var(--text-muted,#94a3b8);display:flex;align-items:center;gap:7px;}
      .qd-juntar-dest{background:var(--bg-elevated,#0f172a);border:1px solid var(--border,#1e293b);
        color:var(--text-heading,#e2e8f0);border-radius:7px;padding:5px 8px;font-size:12px;max-width:220px;}
      .qd-juntar-acao .qd-btn{margin-left:auto;}
    `;
    const s = document.createElement("style");
    s.id = "qdEstilos"; s.textContent = css;
    document.head.appendChild(s);
  }

  function renderPeriodo() {
    const box = document.getElementById("qdPeriodo");
    if (!box) return;
    box.innerHTML = PERIODOS.map((p) =>
      `<button type="button" class="qd-pbtn ${p.d === janela ? "ativo" : ""}" data-d="${p.d}">${p.l}</button>`).join("");
    box.querySelectorAll(".qd-pbtn").forEach((b) => b.addEventListener("click", () => {
      janela = Number(b.dataset.d); renderPeriodo(); atualizar();
    }));
  }

  function campoHtml(c) {
    const pctTxt = c.pct == null ? "n/a" : `${c.pct}%`;
    const nota = c.nota ? ` <small>· ${esc(c.nota)}</small>` : "";
    return `<div class="qd-campo">
      <span class="qd-lbl">${esc(c.label)}${nota}</span>
      <span class="qd-barra"><span class="qd-fill" style="width:${c.pct == null ? 0 : c.pct}%;background:${cor(c.pct)};"></span></span>
      <span class="qd-val"><b style="color:${cor(c.pct)};">${pctTxt}</b> <span style="opacity:.7;">${c.ok}/${c.base}</span></span>
    </div>`;
  }

  function render() {
    injetarEstilos();
    const sec = document.getElementById("qualidade-dados");
    const badge = document.getElementById("qdIndice");
    const resumo = document.getElementById("qdResumo");
    const corpo = document.getElementById("qdCorpo");
    const toggle = document.getElementById("qdToggle");
    if (!sec || !ultimo) return;

    const ind = ultimo.indice;
    if (badge) {
      badge.textContent = ind == null ? "—" : `${ind}%`;
      badge.style.background = cor(ind) + "22";
      badge.style.color = cor(ind);
    }

    // Resumo (sempre visível): os 3 piores campos que a equipe deveria preencher.
    const preencheveis = (ultimo.campos || []).filter((c) => c.grupo !== "avancado" && c.pct != null);
    const piores = preencheveis.slice().sort((a, b) => a.pct - b.pct).slice(0, 3);
    if (resumo) {
      resumo.innerHTML = piores.length
        ? `${ultimo.total} entregas analisadas. Preencher melhor: ` +
          piores.map((c) => `<b>${esc(c.label)} (${c.pct}%)</b>`).join(", ") + "."
        : `${ultimo.total} entregas analisadas.`;
    }

    // Corpo (ao expandir): campos por grupo, do pior ao melhor + piores motoristas.
    if (corpo) {
      const grupos = ["essencial", "condicional", "avancado"];
      let html = "";
      for (const gr of grupos) {
        const lista = (ultimo.campos || []).filter((c) => c.grupo === gr).sort((a, b) => (a.pct ?? 999) - (b.pct ?? 999));
        if (!lista.length) continue;
        html += `<div class="qd-grupo">${esc(GRUPO_LABEL[gr] || gr)}</div>` + lista.map(campoHtml).join("");
      }
      const mot = ultimo.motoristas || [];
      html += `<div class="qd-mot"><h4>Motoristas com pior preenchimento</h4>` +
        (mot.length
          ? mot.map((m) => `<div class="qd-mot-item">
              <span class="qd-mot-pct" style="color:${cor(m.pct)};">${m.pct}%</span>
              <span class="qd-mot-nome">${esc(m.motorista)}</span>
              <span class="qd-mot-n">${m.entregas} entregas</span></div>`).join("")
          : `<div class="qd-vazio">Sem motoristas com volume suficiente no período.</div>`) +
        `</div>`;
      corpo.innerHTML = html;
      // Ação ADM: preencher rotas em branco pela loja (rota costuma ser o pior campo).
      const rotaC = (ultimo.campos || []).find((c) => c.campo === "rota");
      if (ehAdm() && rotaC && rotaC.pct != null && rotaC.pct < 90) {
        const faltam = rotaC.base - rotaC.ok;
        corpo.innerHTML += `<div class="qd-acao">
          <span>🔧 <b>${faltam}</b> entrega(s) sem rota — dá pra preencher pela loja (fonte canônica).</span>
          <button type="button" id="qdDerivarRotas" class="qd-btn">Preencher rotas em branco</button>
        </div>`;
      }
      // Ferramenta ADM: juntar/unificar grafias da mesma rota.
      if (ehAdm()) {
        corpo.innerHTML += `<div class="qd-juntar-wrap">
          <button type="button" id="qdJuntarTog" class="qd-juntar-tog">🔗 Juntar rotas (unificar grafias) ${juntarAberto ? "▾" : "▸"}</button>
          <div id="qdJuntar"></div>
        </div>`;
      }
      corpo.hidden = !expandido;
      document.getElementById("qdDerivarRotas")?.addEventListener("click", derivarRotas);
      document.getElementById("qdJuntarTog")?.addEventListener("click", toggleJuntar);
      if (ehAdm() && juntarAberto) renderJuntar();
    }
    if (toggle) toggle.textContent = expandido ? "ocultar detalhes ▾" : "ver detalhes ▸";
    sec.hidden = false;
  }

  async function derivarRotas() {
    if (!(await confirmarBonito("Preencher a rota (pela loja) das entregas que estão SEM rota?\n\nSó preenche vazios — não sobrescreve.", { okLabel: "Preencher", cancelLabel: "Cancelar" }))) return;
    const btn = document.getElementById("qdDerivarRotas");
    if (btn) { btn.disabled = true; btn.textContent = "Preenchendo…"; }
    try {
      const resp = await fetch(`${window.location.origin}/ocorrencias/derivar-rotas`, { method: "POST", headers: { Accept: "application/json" } });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(j.error || ("HTTP " + resp.status));
      alertar(`✓ ${j.atualizadas} rota(s) preenchidas.`);
      atualizar();
      if (window.Bus) window.Bus.emit("dados:mudou", { origem: "qualidade" });
    } catch (e) {
      alertar("❌ " + e.message);
      if (btn) { btn.disabled = false; btn.textContent = "Preencher rotas em branco"; }
    }
  }

  function toggleJuntar() {
    juntarAberto = !juntarAberto;
    const tog = document.getElementById("qdJuntarTog");
    if (tog) tog.textContent = `🔗 Juntar rotas (unificar grafias) ${juntarAberto ? "▾" : "▸"}`;
    const box = document.getElementById("qdJuntar");
    if (!box) return;
    if (juntarAberto) renderJuntar();
    else box.innerHTML = "";
  }

  // Lista as grafias em uso (GET /rotas/uso) e monta a UI: marcar as que são a
  // MESMA rota + escolher a grafia final. As entregas marcadas passam ao destino.
  async function renderJuntar() {
    const box = document.getElementById("qdJuntar");
    if (!box) return;
    box.innerHTML = `<div class="qd-juntar-load">Carregando rotas em uso…</div>`;
    try {
      const resp = await fetch(`${window.location.origin}/rotas/uso`, { headers: { Accept: "application/json" } });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(j.error || ("HTTP " + resp.status));
      rotasUso = j.rotas || [];
    } catch (e) {
      box.innerHTML = `<div class="qd-juntar-load">❌ ${esc(e.message)}</div>`;
      return;
    }
    if (!rotasUso.length) {
      box.innerHTML = `<div class="qd-juntar-load">Nenhuma rota preenchida ainda.</div>`;
      return;
    }
    const opts = rotasUso.map((r) => `<option value="${esc(r.rota)}">${esc(r.rota)} (${r.n})</option>`).join("");
    box.innerHTML = `
      <div class="qd-juntar-hint">Marque as grafias que são a <b>mesma</b> rota e escolha a grafia final. As entregas marcadas passam a usar o destino (não dá pra desfazer em lote).</div>
      <div class="qd-juntar-lista">
        ${rotasUso.map((r) => `<label class="qd-juntar-item">
          <input type="checkbox" class="qd-juntar-chk" value="${esc(r.rota)}">
          <span class="qd-juntar-nome">${esc(r.rota)}</span>
          <span class="qd-juntar-n">${r.n}</span>
        </label>`).join("")}
      </div>
      <div class="qd-juntar-acao">
        <label class="qd-juntar-destlbl">Unificar em:
          <select id="qdJuntarDest" class="qd-juntar-dest">${opts}</select>
        </label>
        <button type="button" id="qdMesclarBtn" class="qd-btn">Mesclar selecionadas</button>
      </div>`;
    document.getElementById("qdMesclarBtn")?.addEventListener("click", mesclarRotas);
  }

  async function mesclarRotas() {
    const box = document.getElementById("qdJuntar");
    if (!box) return;
    const para = document.getElementById("qdJuntarDest")?.value || "";
    const marcadas = Array.from(box.querySelectorAll(".qd-juntar-chk:checked")).map((c) => c.value);
    const origens = marcadas.filter((d) => d !== para);
    if (!para) { alertar("Escolha a grafia final (destino)."); return; }
    if (!origens.length) { alertar("Marque ao menos uma grafia diferente do destino."); return; }
    if (!(await confirmarBonito(`Unificar ${origens.length} grafia(s) em "${para}"?\n\n${origens.join("\n")}\n\nIsso reescreve a rota dessas entregas.`, { okLabel: "Unificar", cancelLabel: "Cancelar" }))) return;
    const btn = document.getElementById("qdMesclarBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Mesclando…"; }
    try {
      const resp = await fetch(`${window.location.origin}/rotas/mesclar`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ de: origens, para }),
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(j.error || ("HTTP " + resp.status));
      alertar(`✓ ${j.atualizadas} entrega(s) unificadas em "${para}".`);
      rotasUso = null;
      await atualizar(); // recomputa a qualidade; render() reabre o Juntar (juntarAberto segue true)
      if (window.Bus) window.Bus.emit("dados:mudou", { origem: "qualidade" });
    } catch (e) {
      alertar("❌ " + e.message);
      if (btn) { btn.disabled = false; btn.textContent = "Mesclar selecionadas"; }
    }
  }

  async function atualizar() {
    const sec = document.getElementById("qualidade-dados");
    if (!sec || carregando) return;
    carregando = true;
    const btn = document.getElementById("qdRefresh");
    if (btn) btn.classList.add("qd-girando");
    try {
      const resp = await fetch(`${window.location.origin}/painel/qualidade?dias=${janela}`, { headers: { Accept: "application/json" } });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      ultimo = await resp.json();
      render();
    } catch (_) {
      if (sec.dataset.forcar) {
        const resumo = document.getElementById("qdResumo");
        if (resumo) resumo.textContent = "Não foi possível carregar a qualidade de dado agora.";
        sec.hidden = false;
      }
    } finally {
      carregando = false;
      if (btn) btn.classList.remove("qd-girando");
    }
  }

  window.abrirQualidadeDados = function () {
    expandido = true;
    if (!dashboardVisivel() && typeof window.irParaAba === "function") window.irParaAba("dashboard");
    atualizar();
    setTimeout(() => document.getElementById("qualidade-dados")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };
  window.qualidadeDadosAtualizar = atualizar;

  Bus.on("dados:mudou", (d) => {
    if (d && (d.origem === "otif-metas" || d.origem === "alerta" || d.origem === "qualidade")) return; // ruído
    if (dashboardVisivel()) atualizar();
  });

  const _orig = window.irParaAba;
  window.irParaAba = function (nome, ...rest) {
    if (typeof _orig === "function") _orig(nome, ...rest);
    if (nome === "dashboard") setTimeout(atualizar, 0);
  };

  document.addEventListener("click", (e) => {
    if (!e.target) return;
    if (e.target.id === "qdRefresh") { atualizar(); return; }
    if (e.target.id === "qdToggle") {
      expandido = !expandido;
      const corpo = document.getElementById("qdCorpo");
      if (corpo) corpo.hidden = !expandido;
      const t = document.getElementById("qdToggle");
      if (t) t.textContent = expandido ? "ocultar detalhes ▾" : "ver detalhes ▸";
    }
  });

  setInterval(() => { if (dashboardVisivel()) atualizar(); }, REFRESH_MS);

  document.addEventListener("DOMContentLoaded", () => {
    renderPeriodo();
    if (window.authReady && typeof window.authReady.then === "function") {
      window.authReady.then(() => { if (dashboardVisivel()) atualizar(); });
    } else if (dashboardVisivel()) {
      atualizar();
    }
  });
})();
