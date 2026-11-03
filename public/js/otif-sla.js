// ================================================================
// PAINEL OTIF / SLA + METAS POR LOJA
// ----------------------------------------------------------------
// Revela um KPI que a base ja calcula mas ninguem via: pontualidade (SLA) e
// OTIF (On Time In Full). Consome GET /painel/otif (medidores + tendencia
// semanal + piores loja/rota). O gargalo e a COBERTURA — a maioria das
// entregas nao tem horario-meta e cai em "Sem prazo"; por isso este mesmo
// painel traz o editor de "Metas por loja" (so ADM): define um horario-limite
// por loja, o form de ocorrencia passa a preencher sozinho (autofill) e o
// botao "aplicar ao historico" recalcula as antigas. Reusa window.Bus.
// ================================================================
(function () {
  "use strict";

  const REFRESH_MS = 5 * 60 * 1000;
  const PERIODOS = [{ d: 30, l: "30 dias" }, { d: 90, l: "90 dias" }, { d: 365, l: "Tudo" }];
  let janela = 90;
  let carregando = false;
  let ultimo = null;       // ultimo payload /painel/otif
  let metas = null;        // [{loja, hora_agendada, sem_horario}]
  let metasMapa = {};      // { CHAVE_LOJA: 'HH:MM' } p/ autofill do form
  let metasSemHorario = new Set(); // CHAVE_LOJA das lojas "sem horário" (n/a legítimo)
  let backendSemHorarioOK = true;  // backend já entende "sem horário"? (evita apagar meta contra server antigo)
  let editorAberto = false;
  let trechoDestinoSel = "";       // loja escolhida no lookup de trecho (sobrevive ao re-render)

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
  function chaveLoja(l) { return String(l || "").trim().toUpperCase().replace(/\s+/g, " "); }

  // Cor "quanto maior melhor" (pontualidade/otif/cobertura).
  function corAlvo(pct) {
    if (pct == null) return "#64748b";
    if (pct >= 80) return "#22c55e";
    if (pct >= 50) return "#f59e0b";
    return "#ef4444";
  }
  function fmtPct(v) { return v == null ? "—" : `${v}%`; }
  // Nomes de loja/rota vêm do banco com "_" (ex.: SAO_GONÇALO_II) — exibe com espaço.
  function nomeLimpo(v) { return String(v == null ? "" : v).replace(/_/g, " ").trim(); }
  // Minutos → "1h12" ou "48min" (para o deslocamento fábrica → 1ª loja).
  function fmtDur(min) {
    if (min == null || isNaN(min)) return "—";
    min = Math.round(min);
    const h = Math.floor(min / 60), m = min % 60;
    return h > 0 ? `${h}h${String(m).padStart(2, "0")}` : `${m}min`;
  }
  // Cor relativa à mediana geral (não há meta fixa): bem acima = vermelho, acima = âmbar.
  function corDesloc(min, base) {
    if (min == null) return "#64748b";
    if (base && min > base * 1.5) return "#ef4444";
    if (base && min > base * 1.15) return "#f59e0b";
    return "#38bdf8";
  }

  function injetarEstilos() {
    if (document.getElementById("otEstilos")) return;
    const css = `
      .otif-sla{background:var(--bg-elevated,#0f172a);border:1px solid var(--border,#1e293b);
        border-radius:14px;padding:14px 16px;margin-bottom:12px;}
      .otif-sla[hidden]{display:none;}
      .ot-head{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap;}
      .ot-head h3{margin:0;font-size:15px;color:var(--text-heading,#f8fafc);display:flex;align-items:center;gap:8px;}
      .ot-periodo{display:flex;gap:4px;}
      .ot-pbtn{background:transparent;border:1px solid var(--border,#1e293b);color:var(--text-muted,#94a3b8);
        border-radius:7px;padding:4px 9px;font-size:11px;cursor:pointer;}
      .ot-pbtn.ativo{background:rgba(56,189,248,.15);border-color:#38bdf8;color:#7dd3fc;}
      .ot-refresh{margin-left:auto;background:transparent;border:1px solid var(--border,#1e293b);color:var(--text-muted,#94a3b8);
        width:28px;height:28px;border-radius:8px;cursor:pointer;font-size:14px;line-height:1;}
      .ot-refresh:hover{color:var(--text-heading,#e2e8f0);border-color:#38bdf8;}
      .ot-refresh.ot-girando{animation:otSpin .8s linear infinite;}@keyframes otSpin{to{transform:rotate(360deg);}}
      .ot-medidores{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px;}
      .ot-med{background:rgba(255,255,255,.03);border:1px solid var(--border,#1e293b);border-radius:11px;
        padding:12px;display:flex;align-items:center;gap:12px;}
      .ot-gauge{flex:0 0 auto;width:58px;height:58px;border-radius:50%;display:flex;align-items:center;justify-content:center;}
      .ot-gauge span{width:46px;height:46px;border-radius:50%;background:var(--bg-elevated,#0f172a);
        display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:var(--text-heading,#e2e8f0);}
      .ot-med-txt strong{display:block;font-size:12.5px;color:var(--text-heading,#e2e8f0);}
      .ot-med-txt small{display:block;font-size:10.5px;color:var(--text-muted,#94a3b8);margin-top:2px;line-height:1.35;}
      .ot-alerta{background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);border-radius:9px;
        padding:9px 12px;margin-bottom:12px;font-size:12px;color:#fcd34d;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
      .ot-alerta b{color:#fde68a;}
      .ot-alerta button{margin-left:auto;background:linear-gradient(135deg,#38bdf8,#2563eb);color:#fff;border:none;
        border-radius:7px;padding:6px 11px;font-size:11.5px;font-weight:700;cursor:pointer;}
      .ot-grid{display:grid;grid-template-columns:1.1fr 1fr;gap:12px;}
      @media(max-width:720px){.ot-medidores{grid-template-columns:1fr;}.ot-grid{grid-template-columns:1fr;}}
      .ot-bloco{background:rgba(255,255,255,.02);border:1px solid var(--border,#1e293b);border-radius:11px;padding:11px 12px;}
      .ot-bloco h4{margin:0 0 9px;font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--text-muted,#94a3b8);}
      .ot-trend{display:flex;align-items:flex-end;gap:5px;height:96px;}
      .ot-bar{flex:1 1 0;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0;}
      .ot-bar .ot-col{width:100%;max-width:22px;border-radius:4px 4px 0 0;background:#334155;transition:height .3s ease;}
      .ot-bar small{font-size:9px;color:var(--text-muted,#64748b);white-space:nowrap;}
      .ot-bar b{font-size:9.5px;color:var(--text,#cbd5e1);}
      .ot-tab{width:100%;border-collapse:collapse;font-size:12px;}
      .ot-tab td{padding:5px 4px;border-bottom:1px solid rgba(255,255,255,.05);color:var(--text,#cbd5e1);}
      .ot-tab td:first-child{color:var(--text-heading,#e2e8f0);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:150px;}
      .ot-tab td:last-child{text-align:right;font-weight:700;}
      .ot-pill{font-size:10px;font-weight:800;padding:2px 6px;border-radius:5px;}
      .ot-metas{margin-top:12px;border-top:1px dashed var(--border,#1e293b);padding-top:11px;}
      .ot-metas-tog{background:transparent;border:1px solid var(--border,#1e293b);color:var(--text-muted,#94a3b8);
        border-radius:8px;padding:7px 11px;font-size:12px;cursor:pointer;width:100%;text-align:left;}
      .ot-metas-tog:hover{border-color:#38bdf8;color:var(--text-heading,#e2e8f0);}
      .ot-metas-corpo{margin-top:11px;}
      .ot-metaform{display:flex;gap:7px;flex-wrap:wrap;align-items:center;margin-bottom:11px;}
      .ot-metaform select,.ot-metaform input{background:var(--bg,#0b1220);color:var(--text-heading,#e2e8f0);
        border:1px solid var(--border,#334155);border-radius:7px;padding:7px 9px;font-size:12px;}
      .ot-metaform select{max-width:210px;flex:1 1 180px;}
      .ot-metaform input[type=time]{width:110px;}
      .ot-btn{background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;border:none;border-radius:8px;
        padding:8px 13px;font-size:12px;font-weight:700;cursor:pointer;}
      .ot-btn.sec{background:linear-gradient(135deg,#38bdf8,#2563eb);}
      .ot-btn:disabled{opacity:.55;cursor:default;}
      .ot-metalista{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:11px;}
      .ot-metachip{display:inline-flex;align-items:center;gap:7px;background:rgba(56,189,248,.1);
        border:1px solid rgba(56,189,248,.25);border-radius:8px;padding:5px 9px;font-size:11.5px;color:#bae6fd;}
      .ot-metachip b{color:#e0f2fe;}
      .ot-metachip button{background:transparent;border:none;color:#fca5a5;cursor:pointer;font-size:13px;line-height:1;padding:0;}
      .ot-metavazio{font-size:11.5px;color:var(--text-muted,#94a3b8);}
      .ot-aplicar{background:rgba(56,189,248,.06);border:1px solid rgba(56,189,248,.2);border-radius:9px;
        padding:9px 11px;font-size:11.5px;color:var(--text-muted,#94a3b8);display:flex;align-items:center;gap:9px;flex-wrap:wrap;}
      .ot-aplicar b{color:#7dd3fc;}
      .ot-vazio{padding:14px;text-align:center;color:var(--text-muted,#94a3b8);font-size:13px;}
      .ot-desl-hero{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin:2px 0 11px;}
      .ot-desl-hero strong{font-size:26px;line-height:1;color:var(--text-heading,#e2e8f0);font-variant-numeric:tabular-nums;}
      .ot-desl-hero small{font-size:11px;color:var(--text-muted,#94a3b8);}
      .ot-trecho-lookup{margin-top:12px;}
      .ot-trecho-lookup label{display:block;font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--text-muted,#94a3b8);margin-bottom:6px;}
      .ot-trecho-lookup select{background:var(--bg,#0b1220);color:var(--text-heading,#e2e8f0);border:1px solid var(--border,#334155);border-radius:7px;padding:7px 9px;font-size:12px;max-width:280px;}
      .ot-trecho-res{margin-top:8px;}
    `;
    const s = document.createElement("style");
    s.id = "otEstilos"; s.textContent = css;
    document.head.appendChild(s);
  }

  function gaugeHtml(pct, rot, sub) {
    const cor = corAlvo(pct);
    const ang = (pct == null ? 0 : Math.max(0, Math.min(100, pct))) + "%";
    return `<div class="ot-med">
      <div class="ot-gauge" style="background:conic-gradient(${cor} ${ang}, rgba(255,255,255,.07) 0);"><span>${fmtPct(pct)}</span></div>
      <div class="ot-med-txt"><strong>${esc(rot)}</strong><small>${sub}</small></div>
    </div>`;
  }

  function renderPeriodo() {
    const box = document.getElementById("otPeriodo");
    if (!box) return;
    box.innerHTML = PERIODOS.map((p) =>
      `<button type="button" class="ot-pbtn ${p.d === janela ? "ativo" : ""}" data-d="${p.d}">${p.l}</button>`).join("");
    box.querySelectorAll(".ot-pbtn").forEach((b) => b.addEventListener("click", () => {
      janela = Number(b.dataset.d); renderPeriodo(); atualizar();
    }));
  }

  function trendHtml(trend) {
    const pts = (trend || []).filter((t) => t.com_meta > 0).slice(-10);
    if (!pts.length) return `<div class="ot-metavazio">Sem semanas com meta definida no período.</div>`;
    return `<div class="ot-trend">${pts.map((t) => {
      const h = Math.max(3, Math.round((t.pct || 0) * 0.9));
      return `<div class="ot-bar" title="${esc(t.semana)}: ${fmtPct(t.pct)} no prazo (${t.no_prazo}/${t.com_meta})">
        <b>${t.pct == null ? "" : t.pct}</b>
        <div class="ot-col" style="height:${h}px;background:${corAlvo(t.pct)};"></div>
        <small>${esc(t.semana)}</small></div>`;
    }).join("")}</div>`;
  }

  function tabelaHtml(titulo, linhas, campoNome) {
    if (!linhas || !linhas.length) return `<div class="ot-bloco"><h4>${esc(titulo)}</h4><div class="ot-metavazio">Sem dados no período.</div></div>`;
    return `<div class="ot-bloco"><h4>${esc(titulo)}</h4><table class="ot-tab"><tbody>${linhas.map((l) => {
      const cor = l.pct_atraso >= 50 ? "#ef4444" : l.pct_atraso >= 25 ? "#f59e0b" : "#64748b";
      return `<tr><td title="${esc(nomeLimpo(l[campoNome]))}">${esc(nomeLimpo(l[campoNome]))}</td>
        <td style="color:var(--text-muted,#94a3b8);">${l.atrasadas}/${l.com_meta} atras.</td>
        <td><span class="ot-pill" style="background:${cor}22;color:${cor};">${fmtPct(l.pct_atraso)}</span></td></tr>`;
    }).join("")}</tbody></table></div>`;
  }

  // Tabela de deslocamento (rota/motorista): amostra + mediana em duração.
  function deslocTab(titulo, linhas, campo, base) {
    if (!linhas || !linhas.length)
      return `<div class="ot-bloco"><h4>${esc(titulo)}</h4><div class="ot-metavazio">Amostra insuficiente (mín. 3 saídas).</div></div>`;
    return `<div class="ot-bloco"><h4>${esc(titulo)}</h4><table class="ot-tab"><tbody>${linhas.map((l) => {
      const cor = corDesloc(l.mediana_min, base);
      return `<tr><td title="${esc(nomeLimpo(l[campo]))}">${esc(nomeLimpo(l[campo]))}</td>
        <td style="color:var(--text-muted,#94a3b8);">${l.amostra}×</td>
        <td><span class="ot-pill" style="background:${cor}22;color:${cor};">${fmtDur(l.mediana_min)}</span></td></tr>`;
    }).join("")}</tbody></table></div>`;
  }

  // Bloco "Fábrica → 1ª loja": manchete (mediana) + quebra por rota e por motorista.
  function deslocHtml(d) {
    const di = d && d.deslocamento_inicial;
    if (!di || !di.amostra) return "";
    const base = di.mediana_min;
    return `
      <div class="ot-bloco ot-desl" style="margin-top:12px;">
        <h4>🏁 Deslocamento fábrica → 1ª loja</h4>
        <div class="ot-desl-hero">
          <strong>${fmtDur(di.mediana_min)}</strong>
          <small>mediana de estrada até a 1ª loja · ${di.amostra} saída(s) no período · média ${fmtDur(di.media_min)}</small>
        </div>
        <div class="ot-grid">
          ${deslocTab("Rotas mais lentas até a 1ª loja", di.por_rota, "rota", base)}
          ${deslocTab("Motoristas mais lentos até a 1ª loja", di.por_motorista, "motorista", base)}
        </div>
      </div>`;
  }

  // Tabela por DESTINO (chegar até a loja, de qualquer origem).
  function deslocDestTab(titulo, linhas, base) {
    if (!linhas || !linhas.length)
      return `<div class="ot-bloco"><h4>${esc(titulo)}</h4><div class="ot-metavazio">Amostra insuficiente (mín. 3).</div></div>`;
    return `<div class="ot-bloco"><h4>${esc(titulo)}</h4><table class="ot-tab"><tbody>${linhas.map((l) => {
      const cor = corDesloc(l.mediana_min, base);
      return `<tr><td title="${esc(nomeLimpo(l.destino))}">${esc(nomeLimpo(l.destino))}</td>
        <td style="color:var(--text-muted,#94a3b8);">${l.amostra}×</td>
        <td><span class="ot-pill" style="background:${cor}22;color:${cor};">${fmtDur(l.mediana_min)}</span></td></tr>`;
    }).join("")}</tbody></table></div>`;
  }

  // Tabela por TRECHO (origem → destino).
  function deslocTrechoTab(titulo, linhas, base) {
    if (!linhas || !linhas.length)
      return `<div class="ot-bloco"><h4>${esc(titulo)}</h4><div class="ot-metavazio">Amostra insuficiente (mín. 3).</div></div>`;
    return `<div class="ot-bloco"><h4>${esc(titulo)}</h4><table class="ot-tab"><tbody>${linhas.map((l) => {
      const cor = corDesloc(l.mediana_min, base);
      return `<tr><td title="${esc(nomeLimpo(l.origem))} → ${esc(nomeLimpo(l.destino))}">${esc(nomeLimpo(l.origem))} <span style="color:#64748b;">→</span> ${esc(nomeLimpo(l.destino))}</td>
        <td style="color:var(--text-muted,#94a3b8);">${l.amostra}×</td>
        <td><span class="ot-pill" style="background:${cor}22;color:${cor};">${fmtDur(l.mediana_min)}</span></td></tr>`;
    }).join("")}</tbody></table></div>`;
  }

  // Bloco "Tempo por trecho": ranking por destino + por par + lookup por loja.
  function deslocTrechosHtml(d) {
    const dt = d && d.deslocamento_trechos;
    if (!dt || (!(dt.fabrica_para_loja || []).length && !(dt.por_trecho || []).length)) return "";
    const base = d.deslocamento_inicial ? d.deslocamento_inicial.mediana_min : null;
    const destinos = [...new Set((dt.todos || []).map((t) => t.destino).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
    return `
      <div class="ot-bloco ot-desl" style="margin-top:12px;">
        <h4>🧭 Tempo por trecho (origem → destino)</h4>
        <div class="ot-grid">
          ${deslocDestTab("Fábrica → loja — mais demorado", dt.fabrica_para_loja, base)}
          ${deslocTrechoTab("Trechos mais demorados (qualquer origem)", dt.por_trecho, base)}
        </div>
        <div class="ot-trecho-lookup">
          <label>🔎 Ver todos os trechos que chegam numa loja (ex.: fábrica → Madureira)</label>
          <select id="otTrechoDestino"><option value="">— escolha a loja de destino —</option>${
            destinos.map((x) => `<option value="${esc(x)}">${esc(nomeLimpo(x))}</option>`).join("")
          }</select>
          <div id="otTrechoLookup" class="ot-trecho-res"></div>
        </div>
      </div>`;
  }

  // Lookup: todos os trechos (origem → destino) que chegam na loja escolhida.
  function renderTrechoLookup(destino) {
    const alvo = document.getElementById("otTrechoLookup");
    if (!alvo) return;
    const dt = ultimo && ultimo.deslocamento_trechos;
    const base = ultimo && ultimo.deslocamento_inicial ? ultimo.deslocamento_inicial.mediana_min : null;
    if (!destino) { alvo.innerHTML = ""; return; }
    const linhas = ((dt && dt.todos) || []).filter((t) => t.destino === destino)
      .sort((a, b) => b.mediana_min - a.mediana_min);
    if (!linhas.length) {
      alvo.innerHTML = `<div class="ot-metavazio">Sem trechos com amostra suficiente para ${esc(nomeLimpo(destino))}.</div>`;
      return;
    }
    // Ausência da perna da fábrica NÃO significa "loja rápida": significa que ela
    // quase nunca é a 1ª parada do dia. Sem esse aviso o número engana.
    const temFabrica = linhas.some((l) => l.origem === "FÁBRICA");
    const nota = temFabrica ? "" :
      `<div class="ot-metavazio" style="margin-top:6px;">Esta loja quase nunca é a 1ª parada — não há trecho direto <b>fábrica → ${esc(nomeLimpo(destino))}</b>. Os tempos acima são das lojas anteriores da rota.</div>`;
    alvo.innerHTML = `<table class="ot-tab"><tbody>${linhas.map((l) => {
      const cor = corDesloc(l.mediana_min, base);
      const fab = l.origem === "FÁBRICA";
      return `<tr><td title="${esc(nomeLimpo(l.origem))} → ${esc(nomeLimpo(l.destino))}">${
        fab ? `<b style="color:#7dd3fc;">${esc(nomeLimpo(l.origem))}</b>` : esc(nomeLimpo(l.origem))
      } <span style="color:#64748b;">→</span> ${esc(nomeLimpo(l.destino))}</td>
        <td style="color:var(--text-muted,#94a3b8);">${l.amostra}×</td>
        <td><span class="ot-pill" style="background:${cor}22;color:${cor};">${fmtDur(l.mediana_min)}</span></td></tr>`;
    }).join("")}</tbody></table>${nota}`;
  }

  // O painel se auto-atualiza (5min / Bus "dados:mudou") e o render() recria o
  // <select>, perdendo a loja escolhida e o resultado no meio da leitura.
  // Guardamos a seleção e a reaplicamos após cada render.
  function restaurarTrechoSel() {
    const sel = document.getElementById("otTrechoDestino");
    if (!sel || !trechoDestinoSel) return;
    if ([...sel.options].some((o) => o.value === trechoDestinoSel)) {
      sel.value = trechoDestinoSel;
      renderTrechoLookup(trechoDestinoSel);
    } else {
      trechoDestinoSel = ""; // a loja sumiu do período novo
    }
  }

  // ---- Editor de metas (so ADM) ----------------------------------------
  function lojasDoSistema() {
    const sel = document.getElementById("loja");
    if (!sel) return [];
    return Array.from(sel.options).map((o) => o.value).filter((v) => v && v !== "");
  }

  function editorHtml() {
    if (!ehAdm()) return "";
    const abertoCls = editorAberto ? "" : "";
    const semMeta = ultimo && ultimo.resumo ? (ultimo.resumo.total - ultimo.resumo.com_meta) : 0;
    let corpo = "";
    if (editorAberto) {
      const opcoes = lojasDoSistema();
      const jaComMeta = new Set((metas || []).map((m) => chaveLoja(m.loja)));
      const semMetaOpts = opcoes.filter((l) => !jaComMeta.has(chaveLoja(l)));
      const chips = (metas && metas.length)
        ? metas.map((m) => `<span class="ot-metachip"><b>${esc(m.loja)}</b> ${
            m.sem_horario
              ? '<i style="font-style:normal;color:#94a3b8;">🚫 sem horário</i>'
              : esc(m.hora_agendada)
          }
            <button type="button" data-remover="${esc(m.loja)}" title="Remover">✕</button></span>`).join("")
        : `<span class="ot-metavazio">Nenhuma meta definida ainda.</span>`;
      corpo = `<div class="ot-metas-corpo">
        <div class="ot-metaform">
          <select id="otMetaLoja"><option value="">— loja —</option>${
            semMetaOpts.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join("")
          }</select>
          <input type="time" id="otMetaHora" />
          <button type="button" class="ot-btn" id="otMetaSalvar">Salvar meta</button>
        </div>
        <label class="ot-semhorario" style="display:flex;align-items:center;gap:7px;margin:8px 0 2px;font-size:12px;color:#94a3b8;cursor:pointer;">
          <input type="checkbox" id="otMetaSemHorario" style="width:15px;height:15px;cursor:pointer;" />
          Esta loja <b style="color:#cbd5e1;font-weight:600;">não trabalha com horário</b> — fica fora do SLA/OTIF (não cobra o campo em branco)
        </label>
        <div class="ot-metalista">${chips}</div>
        <div class="ot-aplicar">
          <span><b>${semMeta}</b> entrega(s) ainda sem meta. "Aplicar" preenche as VAZIAS que já têm chegada e recalcula o SLA/OTIF.</span>
          <button type="button" class="ot-btn sec" id="otMetaAplicar">Aplicar ao histórico</button>
        </div>
      </div>`;
    }
    return `<div class="ot-metas">
      <button type="button" class="ot-metas-tog" id="otMetasTog">🎯 Metas de horário por loja ${editorAberto ? "▾" : "▸"} <span style="color:#64748b;font-weight:400;">(define o prazo que alimenta o SLA)</span></button>
      ${corpo}
    </div>`;
  }

  function render() {
    injetarEstilos();
    const sec = document.getElementById("otif-sla");
    const corpo = document.getElementById("otCorpo");
    if (!sec || !corpo) return;
    const d = ultimo;
    if (!d || !d.resumo || !d.resumo.total) {
      corpo.innerHTML = `<div class="ot-vazio">Sem entregas no período para calcular OTIF/SLA.</div>${editorHtml()}`;
      sec.hidden = false;
      ligarEditor();
      return;
    }
    const r = d.resumo;
    const alerta = (r.cobertura_pct != null && r.cobertura_pct < 60)
      ? `<div class="ot-alerta">⚠️ Só <b>${fmtPct(r.cobertura_pct)}</b> das entregas têm horário-meta — o resto fica fora do indicador (“Sem prazo”). Definir metas por loja aumenta a cobertura.${ehAdm() ? `<button type="button" id="otIrMetas">Definir metas</button>` : ""}</div>`
      : "";

    corpo.innerHTML = `
      ${alerta}
      <div class="ot-medidores">
        ${gaugeHtml(r.pontualidade_pct, "Pontualidade (SLA)", `${r.no_prazo} no prazo · ${r.atrasada} atrasadas`)}
        ${gaugeHtml(r.otif_pct, "OTIF", `On Time In Full · ${r.conforme} conformes`)}
        ${gaugeHtml(r.cobertura_pct, "Cobertura", `${r.com_meta}/${r.avaliaveis ?? r.total} avaliáveis${r.na_legitimo ? ` · ${r.na_legitimo} loja s/ horário` : ""}`)}
      </div>
      <div class="ot-grid">
        <div class="ot-bloco"><h4>Pontualidade por semana</h4>${trendHtml(d.trend)}</div>
        ${tabelaHtml("Piores lojas (atraso)", d.lojas, "loja")}
      </div>
      <div class="ot-grid" style="margin-top:12px;">
        ${tabelaHtml("Piores rotas (atraso)", d.rotas, "rota")}
        <div class="ot-bloco"><h4>Composição do OTIF</h4>
          <table class="ot-tab"><tbody>
            <tr><td>No prazo</td><td></td><td style="color:#22c55e;">${r.no_prazo}</td></tr>
            <tr><td>Atrasada</td><td></td><td style="color:#ef4444;">${r.atrasada}</td></tr>
            <tr><td>Sem horário (a preencher)</td><td></td><td style="color:#64748b;">${Math.max(0, r.total - r.com_meta - (r.na_legitimo || 0))}</td></tr>
            ${r.na_legitimo ? `<tr><td>Loja sem horário (n/a)</td><td></td><td style="color:#64748b;">${r.na_legitimo}</td></tr>` : ""}
            <tr><td>Entrega completa (In Full)</td><td></td><td style="color:#7dd3fc;">${fmtPct(r.in_full_pct)}</td></tr>
          </tbody></table>
        </div>
      </div>
      ${deslocHtml(d)}
      ${deslocTrechosHtml(d)}
      ${editorHtml()}`;
    sec.hidden = false;
    ligarEditor();
    restaurarTrechoSel();
  }

  function ligarEditor() {
    document.getElementById("otIrMetas")?.addEventListener("click", () => { editorAberto = true; render(); document.getElementById("otMetasTog")?.scrollIntoView({ behavior: "smooth", block: "center" }); });
    document.getElementById("otMetasTog")?.addEventListener("click", () => { editorAberto = !editorAberto; render(); });
    document.getElementById("otMetaSalvar")?.addEventListener("click", salvarMeta);
    document.getElementById("otMetaAplicar")?.addEventListener("click", aplicarMetas);
    document.querySelectorAll("[data-remover]").forEach((b) =>
      b.addEventListener("click", () => removerMeta(b.dataset.remover)));
  }

  async function postJson(url, body) {
    const resp = await fetch(`${window.location.origin}${url}`, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body || {}),
    });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(j.error || ("HTTP " + resp.status));
    return j;
  }
  function avisar(msg) { if (typeof window.alertar === "function") window.alertar(msg); else alert(msg); }

  async function salvarMeta() {
    const loja = document.getElementById("otMetaLoja")?.value;
    const hora = document.getElementById("otMetaHora")?.value;
    const semHorario = !!document.getElementById("otMetaSemHorario")?.checked;
    if (!loja) { avisar("Escolha uma loja."); return; }
    if (semHorario && !backendSemHorarioOK) { avisar("⚠️ O recurso \"loja sem horário\" precisa do servidor reiniciado. Reinicie e tente de novo."); return; }
    if (!semHorario && !hora) { avisar("Informe o horário-meta (HH:MM) ou marque \"não trabalha com horário\"."); return; }
    try {
      await postJson("/metas-loja", semHorario ? { loja, sem_horario: true } : { loja, hora_agendada: hora });
      await carregarMetas();
      render();
      Bus.emit("dados:mudou", { origem: "otif-metas" });
    } catch (e) { avisar("❌ " + e.message); }
  }
  async function removerMeta(loja) {
    try {
      await postJson("/metas-loja", { loja, hora_agendada: "" });
      await carregarMetas();
      render();
    } catch (e) { avisar("❌ " + e.message); }
  }
  async function aplicarMetas() {
    if (!(metas && metas.length)) { avisar("Defina ao menos uma meta antes de aplicar."); return; }
    if (!(await confirmarBonito("Preencher o horário-meta nas entregas antigas SEM horário (das lojas com meta) e recalcular o SLA/OTIF?\n\nSó preenche campos vazios — não sobrescreve horários já informados.", { okLabel: "Preencher", cancelLabel: "Cancelar" }))) return;
    const btn = document.getElementById("otMetaAplicar");
    if (btn) { btn.disabled = true; btn.textContent = "Aplicando…"; }
    try {
      const r = await postJson("/metas-loja/aplicar", {});
      avisar(`✓ ${r.atualizadas} entrega(s) atualizadas.`);
      await atualizar();
      Bus.emit("dados:mudou", { origem: "otif-metas" });
    } catch (e) {
      avisar("❌ " + e.message);
      if (btn) { btn.disabled = false; btn.textContent = "Aplicar ao histórico"; }
    }
  }

  // ---- Autofill do form: loja -> horario-meta -------------------------
  function aplicarAutofillMeta() {
    const sel = document.getElementById("loja");
    const campo = document.getElementById("horaAgendadaLoja");
    if (!sel || !campo) return;
    const meta = metasMapa[chaveLoja(sel.value)];
    if (meta && !campo.value) {
      campo.value = meta;
      campo.dispatchEvent(new Event("input", { bubbles: true })); // dispara atualizarPreviewOtif
    }
  }
  function ligarAutofillForm() {
    const sel = document.getElementById("loja");
    if (!sel || sel.dataset.otMeta) return;
    sel.dataset.otMeta = "1";
    sel.addEventListener("change", () => setTimeout(() => {
      aplicarAutofillMeta();
      // reflete "loja sem horário" no preview mesmo sem meta p/ preencher
      if (typeof window.atualizarPreviewOtif === "function") window.atualizarPreviewOtif();
    }, 0));
  }

  // ---- Dados ----------------------------------------------------------
  async function carregarMetas() {
    try {
      const resp = await fetch(`${window.location.origin}/metas-loja`, { headers: { Accept: "application/json" } });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const j = await resp.json();
      metas = j.metas || [];
      // Backend novo devolve o campo sem_horario em cada meta; se há metas e o
      // campo falta, o server ainda é o antigo (não sabe "sem horário").
      backendSemHorarioOK = !metas.length || Object.prototype.hasOwnProperty.call(metas[0], "sem_horario");
      metasMapa = {};
      metasSemHorario = new Set();
      for (const m of metas) {
        if (m.sem_horario) metasSemHorario.add(chaveLoja(m.loja));
        else if (m.hora_agendada) metasMapa[chaveLoja(m.loja)] = m.hora_agendada;
      }
    } catch (_) { metas = metas || []; }
  }

  async function atualizar() {
    const sec = document.getElementById("otif-sla");
    if (!sec || carregando) return;
    carregando = true;
    const btn = document.getElementById("otRefresh");
    if (btn) btn.classList.add("ot-girando");
    try {
      if (metas === null) await carregarMetas();
      const resp = await fetch(`${window.location.origin}/painel/otif?dias=${janela}`, { headers: { Accept: "application/json" } });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      ultimo = await resp.json();
      render();
    } catch (err) {
      const corpo = document.getElementById("otCorpo");
      if (corpo) { corpo.innerHTML = `<div class="ot-vazio">Não foi possível carregar OTIF/SLA agora.</div>`; sec.hidden = false; }
    } finally {
      carregando = false;
      if (btn) btn.classList.remove("ot-girando");
    }
  }

  window.abrirOtifSla = function () {
    if (!dashboardVisivel() && typeof window.irParaAba === "function") window.irParaAba("dashboard");
    atualizar();
    setTimeout(() => document.getElementById("otif-sla")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };
  window.otifSlaAtualizar = atualizar;
  // Usado pelo nag de qualidade (script-4) e pelo preview (script-1-core) p/ saber
  // se a loja selecionada está marcada como "sem horário" (n/a legítimo do SLA).
  window.lojaSemHorario = function (loja) { return metasSemHorario.has(chaveLoja(loja)); };
  // Horário-meta da loja ("HH:MM") ou "" — usado pelo form-automatico.js.
  window.metaHorarioLoja = function (loja) { return String(metasMapa[chaveLoja(loja)] || "").slice(0, 5); };

  Bus.on("dados:mudou", (d) => {
    if (d && d.origem === "otif-metas") return; // ja tratamos localmente
    if (dashboardVisivel()) atualizar();
  });

  const _orig = window.irParaAba;
  window.irParaAba = function (nome, ...rest) {
    if (typeof _orig === "function") _orig(nome, ...rest);
    if (nome === "dashboard") setTimeout(atualizar, 0);
  };

  document.addEventListener("click", (e) => { if (e.target && e.target.id === "otRefresh") atualizar(); });
  document.addEventListener("change", (e) => {
    if (e.target && e.target.id === "otTrechoDestino") {
      trechoDestinoSel = e.target.value;
      renderTrechoLookup(trechoDestinoSel);
    }
  });
  setInterval(() => { if (dashboardVisivel()) atualizar(); }, REFRESH_MS);

  document.addEventListener("DOMContentLoaded", () => {
    renderPeriodo();
    const arranca = () => {
      if (metas === null) carregarMetas(); // metasSemHorario/metasMapa prontos p/ o form mesmo sem abrir o dashboard
      ligarAutofillForm();
      if (dashboardVisivel()) atualizar();
    };
    if (window.authReady && typeof window.authReady.then === "function") window.authReady.then(arranca);
    else arranca();
  });
})();
