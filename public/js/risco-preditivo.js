// ================================================================
// RISCO PREDITIVO DE ATRASO — "quem tem mais chance de atrasar HOJE?"
// ----------------------------------------------------------------
// Card no topo do Dashboard. Consome GET /painel/risco, que cruza a escala
// do dia (tms_viagens de hoje) com o historico de cada motorista (atraso de
// saida + estouro de rota + ocorrencias) e devolve um score 0-100 por
// motorista, ja ordenado. Por cima, um briefing curto da IA (Gemini) com o
// que fazer antes da saida — quando a IA nao esta disponivel, os scores
// valem sozinhos. Sem escala hoje, o backend manda a watchlist geral dos
// piores dos ultimos 60 dias (o titulo do card se ajusta).
//
// Reusa o mesmo event bus (window.Bus) do fila-resolver: quando alguem grava
// algo relevante, o card se reatualiza sem F5 (respeitando o cache do server).
// Frontend puro; window.fetch ja carrega o cookie de sessao.
// ================================================================
(function () {
  "use strict";

  const REFRESH_MS = 5 * 60 * 1000;   // leve: o server ja cacheia por ~10 min
  let carregando = false;
  let expandido = null;               // motorista com detalhe aberto

  // Reaproveita o bus se o fila-resolver ja o criou; senao cria (idempotente).
  const Bus = window.Bus || (window.Bus = (function () {
    const ouvintes = {};
    return {
      on(ev, fn) { (ouvintes[ev] = ouvintes[ev] || []).push(fn); return () => Bus.off(ev, fn); },
      off(ev, fn) { ouvintes[ev] = (ouvintes[ev] || []).filter((f) => f !== fn); },
      emit(ev, d) { (ouvintes[ev] || []).forEach((fn) => { try { fn(d); } catch (e) { console.error("[Bus]", ev, e); } }); },
    };
  })());

  function esc(v) {
    return escapar(v);
  }

  function dashboardVisivel() {
    const aba = document.getElementById("aba-dashboard");
    return aba && !aba.classList.contains("aba-hidden");
  }

  const NIVEL_META = {
    alto: { cor: "rp-alto", chip: "ALTO", emoji: "🔴" },
    medio: { cor: "rp-medio", chip: "MÉDIO", emoji: "🟡" },
    baixo: { cor: "rp-baixo", chip: "BAIXO", emoji: "🟢" },
    insuficiente: { cor: "rp-insuf", chip: "SEM DADOS", emoji: "⚪" },
  };

  function injetarEstilos() {
    if (document.getElementById("rpEstilos")) return;
    const css = `
      .risco-preditivo{background:var(--bg-elevated,#0f172a);border:1px solid var(--border,#1e293b);
        border-radius:14px;padding:14px 16px;margin-bottom:12px;}
      .risco-preditivo[hidden]{display:none;}
      .rp-head{display:flex;align-items:center;gap:10px;margin-bottom:10px;}
      .rp-head h3{margin:0;font-size:15px;color:var(--text-heading,#f8fafc);display:flex;align-items:center;gap:8px;}
      .rp-badge{background:#334155;color:#e2e8f0;font-size:11px;font-weight:700;min-width:20px;height:20px;
        border-radius:10px;display:inline-flex;align-items:center;justify-content:center;padding:0 7px;}
      .rp-refresh{margin-left:auto;background:transparent;border:1px solid var(--border,#1e293b);color:var(--text-muted,#94a3b8);
        width:28px;height:28px;border-radius:8px;cursor:pointer;font-size:14px;line-height:1;}
      .rp-refresh:hover{color:var(--text-heading,#e2e8f0);border-color:#38bdf8;}
      .rp-refresh.rp-girando{animation:rpSpin .8s linear infinite;}
      @keyframes rpSpin{to{transform:rotate(360deg);}}
      .rp-briefing{background:linear-gradient(135deg,rgba(56,189,248,.08),rgba(37,99,235,.05));
        border:1px solid rgba(56,189,248,.25);border-radius:10px;padding:10px 12px;margin-bottom:11px;
        font-size:12.5px;line-height:1.5;color:var(--text,#cbd5e1);white-space:pre-wrap;}
      .rp-briefing[hidden]{display:none;}
      .rp-briefing .rp-brief-tag{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:700;
        letter-spacing:.4px;color:#38bdf8;text-transform:uppercase;margin-bottom:5px;}
      .rp-lista{display:flex;flex-direction:column;gap:7px;max-height:420px;overflow-y:auto;}
      .rp-item{border-radius:10px;background:rgba(255,255,255,.03);border-left:3px solid var(--border,#334155);
        overflow:hidden;}
      .rp-item.rp-alto{border-left-color:#ef4444;}
      .rp-item.rp-medio{border-left-color:#f59e0b;}
      .rp-item.rp-baixo{border-left-color:#22c55e;}
      .rp-item.rp-insuf{border-left-color:#64748b;}
      .rp-row{display:flex;align-items:center;gap:11px;padding:9px 11px;cursor:pointer;}
      .rp-row:hover{background:rgba(255,255,255,.02);}
      .rp-gauge{flex:0 0 auto;width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;
        font-size:14px;font-weight:800;color:#fff;position:relative;}
      .rp-alto  .rp-gauge{background:conic-gradient(#ef4444 var(--pct),rgba(239,68,68,.15) 0);}
      .rp-medio .rp-gauge{background:conic-gradient(#f59e0b var(--pct),rgba(245,158,11,.15) 0);}
      .rp-baixo .rp-gauge{background:conic-gradient(#22c55e var(--pct),rgba(34,197,94,.15) 0);}
      .rp-insuf .rp-gauge{background:conic-gradient(#64748b var(--pct),rgba(100,116,139,.15) 0);}
      .rp-gauge span{width:34px;height:34px;border-radius:50%;background:var(--bg-elevated,#0f172a);
        display:flex;align-items:center;justify-content:center;font-size:13px;}
      .rp-txt{min-width:0;flex:1 1 auto;}
      .rp-txt strong{display:flex;align-items:center;gap:7px;font-size:13.5px;color:var(--text-heading,#e2e8f0);
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .rp-txt small{display:block;font-size:11px;color:var(--text-muted,#94a3b8);margin-top:2px;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .rp-chip{font-size:9.5px;font-weight:800;letter-spacing:.4px;padding:2px 6px;border-radius:6px;flex:0 0 auto;}
      .rp-alto  .rp-chip{background:rgba(239,68,68,.18);color:#fca5a5;}
      .rp-medio .rp-chip{background:rgba(245,158,11,.18);color:#fcd34d;}
      .rp-baixo .rp-chip{background:rgba(34,197,94,.18);color:#86efac;}
      .rp-insuf .rp-chip{background:rgba(100,116,139,.2);color:#cbd5e1;}
      .rp-piora{font-size:10.5px;color:#fca5a5;flex:0 0 auto;}
      .rp-rota{font-size:10.5px;color:#7dd3fc;flex:0 0 auto;}
      .rp-caret{flex:0 0 auto;color:var(--text-muted,#64748b);font-size:12px;transition:transform .18s ease;}
      .rp-item.rp-aberto .rp-caret{transform:rotate(90deg);}
      .rp-det{padding:0 12px 11px 64px;display:grid;grid-template-columns:repeat(3,1fr);gap:8px;}
      .rp-fator{background:rgba(255,255,255,.03);border:1px solid var(--border,#1e293b);border-radius:8px;padding:8px 9px;}
      .rp-fator b{display:block;font-size:16px;color:var(--text-heading,#e2e8f0);line-height:1.1;}
      .rp-fator small{display:block;font-size:10px;color:var(--text-muted,#94a3b8);margin-top:3px;text-transform:uppercase;letter-spacing:.3px;}
      .rp-vazio{padding:14px;text-align:center;color:var(--text-muted,#94a3b8);font-size:13px;}
      @media(max-width:560px){.rp-det{padding-left:12px;}.rp-rota,.rp-piora{display:none;}}
    `;
    const style = document.createElement("style");
    style.id = "rpEstilos";
    style.textContent = css;
    document.head.appendChild(style);
  }

  function fatorHtml(rot, valor, sub) {
    return `<div class="rp-fator"><b>${esc(valor)}</b><small>${esc(rot)}</small><small style="text-transform:none;color:#64748b;margin-top:1px;">${esc(sub)}</small></div>`;
  }

  function detHtml(it) {
    const f = it.fatores || {};
    const s = f.saida || {}, r = f.rota || {}, o = f.ocorrencia || {};
    return `<div class="rp-det">
      ${fatorHtml("Saída fábrica", `${s.pct || 0}%`, `${s.atrasadas || 0}/${s.registros || 0} atrasos · méd ${s.media_min || 0}min`)}
      ${fatorHtml("Tempo de rota", `${r.pct || 0}%`, `${r.excedentes || 0}/${r.registros || 0} estouraram`)}
      ${fatorHtml("Ocorrências", `${o.pct || 0}%`, `${o.com_problema || 0}/${o.registros || 0} registros`)}
    </div>`;
  }

  function render(dados) {
    injetarEstilos();
    const sec = document.getElementById("risco-preditivo");
    const lista = document.getElementById("rpLista");
    const badge = document.getElementById("rpBadge");
    const titulo = document.getElementById("rpTitulo");
    const brief = document.getElementById("rpBriefing");
    if (!sec || !lista) return;

    const itens = (dados && dados.itens) || [];
    const escala = !!(dados && dados.usando_escala_do_dia);

    if (titulo) titulo.textContent = escala ? "🎯 Risco de atraso · escala de hoje" : "🎯 Risco de atraso · watchlist";
    if (badge) badge.textContent = String(itens.length);

    // Briefing da IA (opcional).
    if (brief) {
      if (dados && dados.briefing) {
        const prov = dados.briefing_provedor ? ` · ${esc(dados.briefing_provedor)}` : "";
        brief.innerHTML = `<span class="rp-brief-tag">🤖 Briefing da IA${prov}</span>${esc(dados.briefing)}`;
        brief.hidden = false;
      } else {
        brief.hidden = true;
      }
    }

    if (!itens.length) {
      if (!sec.dataset.forcar) { sec.hidden = true; return; }
      lista.innerHTML = `<div class="rp-vazio">Sem histórico suficiente para calcular risco.</div>`;
      sec.hidden = false;
      return;
    }

    sec.hidden = false;
    lista.innerHTML = itens.map((it) => {
      const meta = NIVEL_META[it.nivel] || NIVEL_META.baixo;
      const aberto = expandido === it.motorista;
      const pct = Math.max(0, Math.min(100, it.score)) + "%";
      const piora = (it.fatores && it.fatores.piorando) ? `<span class="rp-piora" title="Piorou nas últimas 2 semanas">📈 piorando</span>` : "";
      const rota = it.rota ? `<span class="rp-rota">${esc(it.rota)}</span>` : "";
      const hoje = it.escalado_hoje ? ` · sai hoje` : "";
      return `<div class="rp-item ${meta.cor} ${aberto ? "rp-aberto" : ""}" data-mot="${esc(it.motorista)}">
        <div class="rp-row">
          <span class="rp-gauge" style="--pct:${pct}"><span>${esc(it.score)}</span></span>
          <span class="rp-txt">
            <strong>${esc(it.motorista)} <span class="rp-chip">${meta.emoji} ${meta.chip}</span> ${piora}</strong>
            <small>${esc(it.resumo || "")}${esc(hoje)}</small>
          </span>
          ${rota}
          <span class="rp-caret">▸</span>
        </div>
        ${aberto ? detHtml(it) : ""}
      </div>`;
    }).join("");

    // Clique na linha expande/colapsa o detalhe dos fatores.
    lista.querySelectorAll(".rp-row").forEach((row) => {
      row.addEventListener("click", () => {
        const mot = row.parentElement.dataset.mot;
        expandido = expandido === mot ? null : mot;
        render(dados);
      });
    });
  }

  async function atualizar() {
    const sec = document.getElementById("risco-preditivo");
    if (!sec || carregando) return;
    carregando = true;
    const btn = document.getElementById("rpRefresh");
    if (btn) btn.classList.add("rp-girando");
    try {
      const resp = await fetch(`${window.location.origin}/painel/risco`, { headers: { Accept: "application/json" } });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      render(await resp.json());
    } catch (err) {
      const lista = document.getElementById("rpLista");
      if (lista && sec.dataset.forcar) {
        lista.innerHTML = `<div class="rp-vazio">Não foi possível calcular o risco agora.</div>`;
        sec.hidden = false;
      }
    } finally {
      carregando = false;
      if (btn) btn.classList.remove("rp-girando");
    }
  }

  // Abre/forca o painel (command palette / botao dedicado).
  window.abrirRiscoPreditivo = function () {
    const sec = document.getElementById("risco-preditivo");
    if (!sec) return;
    sec.dataset.forcar = "1";
    if (!dashboardVisivel() && typeof window.irParaAba === "function") window.irParaAba("dashboard");
    atualizar();
    setTimeout(() => sec.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };
  window.riscoPreditivoAtualizar = atualizar;

  // Reage a mudancas de dados (event bus) — so recarrega se o Dashboard aparece.
  Bus.on("dados:mudou", () => { if (dashboardVisivel()) atualizar(); });

  // Atualiza ao ENTRAR no Dashboard (encadeia sobre o irParaAba existente).
  const _orig = window.irParaAba;
  window.irParaAba = function (nome, ...rest) {
    if (typeof _orig === "function") _orig(nome, ...rest);
    if (nome === "dashboard") setTimeout(atualizar, 0);
  };

  document.addEventListener("click", (e) => {
    if (e.target && e.target.id === "rpRefresh") atualizar();
  });

  setInterval(() => { if (dashboardVisivel()) atualizar(); }, REFRESH_MS);

  document.addEventListener("DOMContentLoaded", () => {
    if (window.authReady && typeof window.authReady.then === "function") {
      window.authReady.then(() => { if (dashboardVisivel()) atualizar(); });
    } else if (dashboardVisivel()) {
      atualizar();
    }
  });
})();
