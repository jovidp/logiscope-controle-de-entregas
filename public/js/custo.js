// ================================================================
// PAINEL DE CUSTO — "quanto cada entrega/rota/motorista custa"
// ----------------------------------------------------------------
// Seção colapsável no Dashboard. Consome GET /painel/custo e mostra os KPIs
// (total gasto, custo médio por entrega, custo por km, custo de FALHAS) e os
// rankings por rota / motorista / loja. custo_total já é derivado no salvar;
// aqui só se AGREGA. A "cobertura" avisa quantas entregas têm custo lançado —
// enquanto estiver baixa, o painel mostra um estado de "comece a preencher".
// Também preenche o card "Custo Apurado" do topo do dashboard.
// ================================================================
(function () {
  "use strict";

  const REFRESH_MS = 5 * 60 * 1000;
  const PERIODOS = [{ d: 30, l: "30d" }, { d: 90, l: "90d" }, { d: 365, l: "Tudo" }];
  let janela = 90;
  let carregando = false;
  let ultimo = null;
  let expandido = false;
  let dim = "rota"; // dimensão do ranking em foco: rota | motorista | loja

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
  // Formata dinheiro em BRL; null/0 -> "R$ 0,00".
  function brl(n) {
    const v = Number(n || 0);
    return "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // Versão curta pro card do topo (R$ 12,3 mil / R$ 1,2 mi).
  function brlCurto(n) {
    const v = Number(n || 0);
    if (v >= 1e6) return "R$ " + (v / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mi";
    if (v >= 1e3) return "R$ " + (v / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mil";
    return brl(v);
  }
  function corCobertura(pct) {
    if (pct == null) return "#64748b";
    if (pct >= 70) return "#22c55e";
    if (pct >= 30) return "#f59e0b";
    return "#ef4444";
  }

  function injetarEstilos() {
    if (document.getElementById("cxEstilos")) return;
    const css = `
      .cx-sec{background:var(--bg-elevated,#0f172a);border:1px solid var(--border,#1e293b);
        border-radius:14px;padding:14px 16px;margin-bottom:12px;}
      .cx-sec[hidden]{display:none;}
      .cx-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
      .cx-head h3{margin:0;font-size:15px;color:var(--text-heading,#f8fafc);display:flex;align-items:center;gap:9px;}
      .cx-total{font-size:13px;font-weight:800;padding:2px 9px;border-radius:8px;background:rgba(251,191,36,.14);color:#fbbf24;}
      .cx-periodo{display:flex;gap:4px;}
      .cx-pbtn{background:transparent;border:1px solid var(--border,#1e293b);color:var(--text-muted,#94a3b8);
        border-radius:7px;padding:3px 8px;font-size:11px;cursor:pointer;}
      .cx-pbtn.ativo{background:rgba(251,191,36,.15);border-color:#fbbf24;color:#fcd34d;}
      .cx-toggle{background:transparent;border:1px solid var(--border,#1e293b);color:var(--text-muted,#94a3b8);
        border-radius:7px;padding:4px 10px;font-size:11.5px;cursor:pointer;margin-left:auto;}
      .cx-toggle:hover{border-color:#fbbf24;color:var(--text-heading,#e2e8f0);}
      .cx-refresh{background:transparent;border:1px solid var(--border,#1e293b);color:var(--text-muted,#94a3b8);
        width:28px;height:28px;border-radius:8px;cursor:pointer;font-size:14px;line-height:1;}
      .cx-refresh.cx-girando{animation:cxSpin .8s linear infinite;}@keyframes cxSpin{to{transform:rotate(360deg);}}
      .cx-resumo{margin-top:11px;}
      .cx-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:9px;}
      .cx-kpi{background:rgba(255,255,255,.03);border:1px solid var(--border,#1e293b);border-radius:10px;padding:10px 12px;}
      .cx-kpi .k-lbl{font-size:10.5px;letter-spacing:.4px;text-transform:uppercase;color:var(--text-muted,#94a3b8);}
      .cx-kpi .k-val{font-size:18px;font-weight:800;color:var(--text-heading,#f8fafc);margin-top:3px;}
      .cx-kpi .k-sub{font-size:10.5px;color:var(--text-muted,#64748b);margin-top:2px;}
      .cx-kpi.falhas .k-val{color:#fca5a5;}
      .cx-cob{margin-top:10px;font-size:12px;color:var(--text-muted,#94a3b8);line-height:1.5;}
      .cx-cob b{color:var(--text-heading,#e2e8f0);}
      .cx-vazio{margin-top:11px;background:rgba(251,191,36,.06);border:1px solid rgba(251,191,36,.2);
        border-radius:9px;padding:11px 13px;font-size:12.5px;color:var(--text-muted,#cbd5e1);line-height:1.6;}
      .cx-vazio b{color:#fcd34d;}
      .cx-corpo{margin-top:12px;}
      .cx-corpo[hidden]{display:none;}
      .cx-tabs{display:flex;gap:6px;margin-bottom:10px;}
      .cx-tab{background:transparent;border:1px solid var(--border,#1e293b);color:var(--text-muted,#94a3b8);
        border-radius:7px;padding:4px 11px;font-size:12px;cursor:pointer;}
      .cx-tab.ativo{background:rgba(251,191,36,.13);border-color:#fbbf24;color:#fcd34d;}
      .cx-row{display:flex;align-items:center;gap:10px;margin-bottom:7px;}
      .cx-nome{flex:0 0 34%;min-width:0;font-size:12px;color:var(--text-heading,#e2e8f0);
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .cx-barra{flex:1 1 auto;height:9px;border-radius:5px;background:rgba(255,255,255,.06);overflow:hidden;}
      .cx-fill{height:100%;border-radius:5px;background:linear-gradient(90deg,#f59e0b,#fbbf24);transition:width .4s ease;}
      .cx-cifra{flex:0 0 auto;width:150px;text-align:right;font-size:11.5px;color:var(--text-muted,#94a3b8);}
      .cx-cifra b{color:var(--text-heading,#f8fafc);font-weight:800;}
      .cx-cifra .f{color:#fca5a5;}
      .cx-listavazia{padding:10px 0;color:var(--text-muted,#94a3b8);font-size:12.5px;}
    `;
    const s = document.createElement("style");
    s.id = "cxEstilos"; s.textContent = css;
    document.head.appendChild(s);
  }

  function renderPeriodo() {
    const box = document.getElementById("cxPeriodo");
    if (!box) return;
    box.innerHTML = PERIODOS.map((p) =>
      `<button type="button" class="cx-pbtn ${p.d === janela ? "ativo" : ""}" data-d="${p.d}">${p.l}</button>`).join("");
    box.querySelectorAll(".cx-pbtn").forEach((b) => b.addEventListener("click", () => {
      janela = Number(b.dataset.d); renderPeriodo(); atualizar();
    }));
  }

  function atualizarCardTopo(d) {
    const val = document.getElementById("cardCustoValor");
    const nota = document.getElementById("cardCustoNota");
    if (!val || !nota) return;
    // Sem custo digitado nas ocorrencias, o card mostra o frete calculado do TMS.
    if ((!d || !d.com_custo) && d && d.frete_tms && d.frete_tms.total) {
      val.textContent = brlCurto(d.frete_tms.total);
      val.style.color = "#fbbf24";
      nota.textContent = `frete TMS · ${d.frete_tms.viagens_com_frete} viagem(ns) · ${d.frete_tms.por_volume != null ? brl(d.frete_tms.por_volume) + "/volume" : "ida + retorno"}`;
      return;
    }
    if (!d || !d.com_custo) {
      val.textContent = "—";
      val.style.color = "var(--text-secondary)";
      nota.textContent = "sem custo lançado ainda";
      return;
    }
    val.textContent = brlCurto(d.total_gasto);
    val.style.color = "#fbbf24";
    nota.textContent = `${d.com_custo} entrega(s) · média ${brl(d.custo_medio_entrega)}`;
  }

  // Frete CALCULADO do TMS (km x CCD + taxa do caminhao, ida + retorno), vindo
  // do cadastro de lojas por PES. Fica separado do custo digitado.
  function freteTmsResumoHtml(f) {
    if (!f || !f.total) return "";
    const est = f.viagens_tipo_estimado ? ` · ${f.viagens_tipo_estimado} com tipo de caminhão estimado` : "";
    return `<div class="cx-cob" style="margin-bottom:6px;"><b>🚚 Frete do TMS</b> (calculado: km × CCD + taxa do caminhão, ida + retorno)${est}</div>
      <div class="cx-kpis">
        <div class="cx-kpi"><div class="k-lbl">Frete total</div><div class="k-val">${brl(f.total)}</div><div class="k-sub">${f.viagens_com_frete} viagem(ns)</div></div>
        <div class="cx-kpi"><div class="k-lbl">Médio / viagem</div><div class="k-val">${f.medio_viagem != null ? brl(f.medio_viagem) : "—"}</div><div class="k-sub">ida + retorno</div></div>
        <div class="cx-kpi"><div class="k-lbl">Frete / km</div><div class="k-val">${f.por_km != null ? brl(f.por_km) : "—"}</div><div class="k-sub">${(f.km_previsto || 0).toLocaleString("pt-BR")} km previstos</div></div>
        <div class="cx-kpi"><div class="k-lbl">Frete / volume</div><div class="k-val">${f.por_volume != null ? brl(f.por_volume) : "—"}</div><div class="k-sub">${(f.volume_entregue || 0).toLocaleString("pt-BR")} vol. entregues</div></div>
      </div>`;
  }

  function freteTmsRankingHtml(f) {
    if (!f || !f.total) return "";
    const lista = (dim === "motorista" ? f.por_motorista : dim === "loja" ? f.por_loja : f.por_rota) || [];
    if (!lista.length) return "";
    const max = lista.reduce((m, x) => Math.max(m, Number(x.total) || 0), 0) || 1;
    return `<div class="cx-cob" style="margin:8px 0 4px;">🚚 Frete do TMS:</div>` + lista.map((x) => `
      <div class="cx-row">
        <div class="cx-nome" title="${esc(x.chave)}">${esc(x.chave)}</div>
        <div class="cx-barra"><div class="cx-fill" style="width:${Math.round((100 * x.total) / max)}%"></div></div>
        <div class="cx-cifra"><b>${brl(x.total)}</b> · ${x.viagens} viag.${x.por_volume != null ? ` · ${brl(x.por_volume)}/vol` : ""}</div>
      </div>`).join("");
  }

  function rankAtual(d) {
    return d && (dim === "motorista" ? d.por_motorista : dim === "loja" ? d.por_loja : d.por_rota) || [];
  }

  function render() {
    injetarEstilos();
    const sec = document.getElementById("painel-custo");
    const total = document.getElementById("cxTotal");
    const resumo = document.getElementById("cxResumo");
    const corpo = document.getElementById("cxCorpo");
    const toggle = document.getElementById("cxToggle");
    if (!sec || !resumo) return;
    const d = ultimo;
    if (!d) return;

    atualizarCardTopo(d);
    sec.hidden = false;
    if (total) total.textContent = brlCurto(d.total_gasto);

    // KPIs sempre visíveis.
    const kpis = [
      `<div class="cx-kpi"><div class="k-lbl">Total gasto</div><div class="k-val">${brl(d.total_gasto)}</div><div class="k-sub">no período</div></div>`,
      `<div class="cx-kpi"><div class="k-lbl">Médio / entrega</div><div class="k-val">${d.custo_medio_entrega != null ? brl(d.custo_medio_entrega) : "—"}</div><div class="k-sub">${d.com_custo} c/ custo</div></div>`,
      `<div class="cx-kpi"><div class="k-lbl">Custo / km</div><div class="k-val">${d.custo_por_km != null ? brl(d.custo_por_km) : "—"}</div><div class="k-sub">${d.total_km ? d.total_km.toLocaleString("pt-BR") + " km" : "sem km"}</div></div>`,
      `<div class="cx-kpi falhas"><div class="k-lbl">Custo de falhas</div><div class="k-val">${brl(d.total_falhas)}</div><div class="k-sub">reentrega + ocorrência</div></div>`,
    ].join("");

    const cor = corCobertura(d.cobertura);
    const cob = `<div class="cx-cob">Cobertura: <b style="color:${cor}">${d.cobertura == null ? "—" : d.cobertura + "%"}</b> das entregas têm custo lançado (${d.com_custo}/${d.total_entregas}).</div>`;

    // Estado "comece a preencher" quando quase ninguém lançou custo.
    let vazio = "";
    if (!d.com_custo) {
      vazio = `<div class="cx-vazio"><b>Nenhum custo lançado ainda.</b> A seção <b>"Custos Operacionais"</b> agora aparece no formulário da ocorrência (km, custo/km, pedágio, reentrega e ocorrência). Conforme a equipe preencher, este painel mostra o custo por entrega, rota, motorista e loja — e o dinheiro que vaza por falhas.</div>`;
    } else if (d.cobertura != null && d.cobertura < 30) {
      vazio = `<div class="cx-vazio">Só <b>${d.cobertura}%</b> das entregas têm custo lançado — os números abaixo cobrem uma amostra pequena. Quanto mais a equipe preencher a seção "Custos Operacionais", mais fiel fica a análise.</div>`;
    }

    resumo.innerHTML = `${freteTmsResumoHtml(d.frete_tms)}<div class="cx-kpis">${kpis}</div>${cob}${vazio}`;

    // Corpo (detalhe) — rankings por dimensão.
    if (corpo) {
      const lista = rankAtual(d);
      const max = lista.reduce((m, x) => Math.max(m, Number(x.total) || 0), 0) || 1;
      const linhas = lista.length
        ? lista.map((x) => {
            const pct = Math.round((100 * (Number(x.total) || 0)) / max);
            const f = Number(x.falhas) || 0;
            return `<div class="cx-row">
              <div class="cx-nome" title="${esc(x.chave)}">${esc(x.chave)}</div>
              <div class="cx-barra"><div class="cx-fill" style="width:${pct}%"></div></div>
              <div class="cx-cifra"><b>${brl(x.total)}</b> · ${x.entregas}ent${f > 0 ? ` · <span class="f">${brl(f)} falha</span>` : ""}</div>
            </div>`;
          }).join("")
        : `<div class="cx-listavazia">Nenhum custo lançado neste recorte.</div>`;
      const tabs = [["rota", "Por rota"], ["motorista", "Por motorista"], ["loja", "Por loja"]]
        .map(([k, l]) => `<button type="button" class="cx-tab ${k === dim ? "ativo" : ""}" data-dim="${k}">${l}</button>`).join("");
      corpo.innerHTML = `<div class="cx-tabs">${tabs}</div>${freteTmsRankingHtml(d.frete_tms)}
        <div class="cx-cob" style="margin-top:10px;">Custo lançado nas ocorrências (km, pedágio, reentrega, ocorrência):</div>${linhas}`;
      corpo.querySelectorAll(".cx-tab").forEach((b) => b.addEventListener("click", () => {
        dim = b.dataset.dim; render();
      }));
    }

    if (toggle) toggle.textContent = expandido ? "ocultar detalhes ▾" : "ver detalhes ▸";
    if (corpo) corpo.hidden = !expandido;
  }

  async function atualizar() {
    const sec = document.getElementById("painel-custo");
    if (!sec || carregando) return;
    carregando = true;
    const btn = document.getElementById("cxRefresh");
    if (btn) btn.classList.add("cx-girando");
    try {
      const resp = await fetch(`${window.location.origin}/painel/custo?dias=${janela}`, { headers: { Accept: "application/json" } });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      ultimo = await resp.json();
      render();
    } catch (_) {
      // Silencioso: o painel só some se nunca carregou (mantém o dashboard limpo).
    } finally {
      carregando = false;
      if (btn) btn.classList.remove("cx-girando");
    }
  }

  window.abrirPainelCusto = function () {
    expandido = true;
    if (!dashboardVisivel() && typeof window.irParaAba === "function") window.irParaAba("dashboard");
    atualizar();
    setTimeout(() => document.getElementById("painel-custo")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };
  window.painelCustoAtualizar = atualizar;

  Bus.on("dados:mudou", (d) => {
    if (d && (d.origem === "otif-metas" || d.origem === "alerta")) return; // ruído
    if (dashboardVisivel()) atualizar();
  });

  document.addEventListener("click", (e) => {
    if (!e.target) return;
    if (e.target.id === "cxRefresh") { atualizar(); return; }
    if (e.target.id === "cxToggle") {
      expandido = !expandido;
      const corpo = document.getElementById("cxCorpo");
      if (corpo) corpo.hidden = !expandido;
      const t = document.getElementById("cxToggle");
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
