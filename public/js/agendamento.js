// ================================================================
// agendamento.js — Aba "🎯 Agendamento" (Assistente de Agendamento)
// ----------------------------------------------------------------
// Painel que recomenda, por rota e loja, o MELHOR horário de
// agendamento para o caminhão chegar no prazo, com base no histórico
// real. Toda a estatística vem do backend:
//     GET /agendamento/recomendacoes?de=&ate=&alvo=0.8
// (ver back/agendamento-engine.js). Aqui só montamos filtros e UI.
//
// Script clássico (escopo global), incluído depois dos script-*.
// Reaproveita os globais: API_URL, alertar, escapar, irParaAba.
// ================================================================

let _agndDados = null; // resposta do endpoint { alvo, rotas:[...] }
let _agndCarregando = false;

// ── helpers ──────────────────────────────────────────────────────
function _agndEsc(v) {
  return typeof escapar === "function"
    ? escapar(v)
    : String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
      );
}

// minutos do dia → "HH:MM"
function _agHHMM(min) {
  if (min == null || !isFinite(min)) return "—";
  let v = Math.round(min) % 1440;
  if (v < 0) v += 1440;
  return String(Math.floor(v / 60)).padStart(2, "0") + ":" + String(v % 60).padStart(2, "0");
}

// duração em minutos → "Hh MM" / "MMmin"
function _agDur(min) {
  if (min == null || !isFinite(min)) return "—";
  const v = Math.round(min);
  const h = Math.floor(v / 60);
  const m = v % 60;
  if (h <= 0) return `${m}min`;
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}

// fração 0..1 → "NN%"
function _agPct(f) {
  if (f == null || !isFinite(f)) return "—";
  return Math.round(f * 100) + "%";
}

function _agHojeMenos(dias) {
  const d = new Date();
  d.setDate(d.getDate() - dias);
  return d.toISOString().split("T")[0];
}

// ── CSS (injetado uma vez) ───────────────────────────────────────
function _agndEstilos() {
  if (document.getElementById("agndEstilos")) return;
  const st = document.createElement("style");
  st.id = "agndEstilos";
  st.textContent = `
    .agnd-filtros { display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end; margin-bottom:14px; }
    .agnd-filtros label { display:block; font-size:11px; font-weight:700; color:var(--text-secondary); margin-bottom:4px; }
    .agnd-nota { border:1px solid var(--border); border-radius:10px; padding:10px 12px; margin:0 0 14px;
      background:var(--azul-light,rgba(56,189,248,.08)); color:var(--text-secondary); font-size:12px; line-height:1.45; }
    .agnd-nota strong { color:var(--text-heading,#f0f6ff); }
    .agnd-vazio { color:var(--text-muted); padding:24px 4px; text-align:center; }

    .agnd-rota { margin:0 0 22px; border:1px solid var(--border); border-radius:12px; overflow:hidden; }
    .agnd-rota-head { display:flex; gap:14px; flex-wrap:wrap; align-items:baseline; justify-content:space-between;
      padding:12px 16px; background:var(--bg-overlay,#1e293b); border-bottom:1px solid var(--border-md); }
    .agnd-rota-head h3 { margin:0; font-size:15px; color:var(--text-heading,#f0f6ff); }
    .agnd-rota-chips { display:flex; gap:6px; flex-wrap:wrap; }
    .agnd-chip { background:var(--bg-base); border:1px solid var(--border); color:var(--text-secondary);
      border-radius:999px; padding:3px 10px; font-size:11px; font-weight:700; }

    .agnd-tabela-wrap { overflow-x:auto; }
    .agnd-tabela { width:100%; border-collapse:collapse; font-size:12.5px; min-width:880px; }
    .agnd-tabela th { background:var(--bg-base); color:var(--text-secondary); font-size:10px; text-transform:uppercase;
      letter-spacing:.5px; padding:9px 8px; text-align:left; white-space:nowrap; border-bottom:1px solid var(--border-md); }
    .agnd-tabela td { padding:7px 8px; border-bottom:1px solid var(--border); vertical-align:middle; }
    .agnd-tabela tbody tr:hover { background:var(--azul-light,rgba(56,189,248,.05)); }
    .agnd-ordem { font-weight:700; color:var(--text-muted); text-align:center; width:30px; }
    .agnd-loja { font-weight:700; color:var(--text-primary,#e5edf7); }
    .agnd-loja small { display:block; font-weight:500; color:var(--text-muted); font-size:10.5px; }
    .agnd-hora { font-variant-numeric:tabular-nums; font-weight:700; }
    .agnd-rec { color:var(--verde,#34d399); }
    .agnd-rec-igual { color:var(--text-muted); }
    .agnd-seta { color:var(--text-muted); padding:0 4px; }
    .agnd-mini { font-variant-numeric:tabular-nums; color:var(--text-secondary); white-space:nowrap; }

    .agnd-bar { position:relative; height:7px; border-radius:999px; background:var(--border); overflow:hidden; min-width:64px; }
    .agnd-bar > span { position:absolute; inset:0 auto 0 0; border-radius:999px; }
    .agnd-bar-atual > span { background:var(--vermelho,#f87171); }
    .agnd-bar-proj > span { background:var(--verde,#34d399); }
    .agnd-pont { display:flex; flex-direction:column; gap:4px; min-width:120px; }
    .agnd-pont-linha { display:flex; align-items:center; gap:6px; font-size:11px; color:var(--text-muted); }
    .agnd-pont-linha b { color:var(--text-secondary); font-variant-numeric:tabular-nums; width:34px; text-align:right; }

    .agnd-flag { color:var(--vermelho,#f87171); font-weight:800; cursor:help; }
    .agnd-row-irreal td { background:rgba(248,113,113,.06); }
    .agnd-evid { color:var(--text-secondary); font-size:11.5px; }
    .agnd-evid summary { cursor:pointer; color:var(--azul,#38bdf8); font-weight:700; }
    .agnd-evid ul { margin:6px 0 0; padding-left:18px; }
    .agnd-evid li { margin:2px 0; }
    .agnd-tag-loja { color:var(--amarelo,#fbbf24); font-weight:700; }
  `;
  document.head.appendChild(st);
}

// ── ciclo de vida ────────────────────────────────────────────────
function agendamentoInit() {
  _agndEstilos();
  const app = document.getElementById("agndApp");
  if (!app) return;
  // monta o esqueleto (filtros + container de resultado) uma vez
  if (!document.getElementById("agndFiltros")) {
    app.innerHTML = `
      <div id="agndFiltros" class="agnd-filtros">
        <div><label>De (opcional)</label><input id="agndDe" type="date" /></div>
        <div><label>Até (opcional)</label><input id="agndAte" type="date" /></div>
        <div>
          <label>Meta de pontualidade</label>
          <select id="agndAlvo" data-sem-pesquisa>
            <option value="0.7">70% das vezes no prazo</option>
            <option value="0.8" selected>80% das vezes no prazo</option>
            <option value="0.9">90% das vezes no prazo</option>
          </select>
        </div>
        <div>
          <label>Rota</label>
          <select id="agndRota" data-sem-pesquisa onchange="agndRenderResultado()">
            <option value="">Todas as rotas</option>
          </select>
        </div>
        <button type="button" class="btn-blue btn-sm" onclick="agndCarregar()">🔄 Recalcular</button>
      </div>
      <div class="agnd-nota">
        <strong>Como ler:</strong> o horário <em>recomendado</em> é o que o caminhão
        historicamente cumpre na meta de pontualidade escolhida (ex.: 80% dos dias
        ele chega até esse horário). Lojas em <span class="agnd-flag">vermelho</span>
        têm agendamento atual mais cedo do que o caminhão consegue chegar — fonte de
        atraso crônico. <strong>Trade-off:</strong> agendar mais tarde reduz o atraso,
        mas combina um horário mais tarde com a loja.
      </div>
      <div id="agndResultado"><div class="agnd-vazio">Carregando recomendações…</div></div>`;
    // recalcular ao mudar a meta também
    const alvoSel = document.getElementById("agndAlvo");
    if (alvoSel) alvoSel.addEventListener("change", agndCarregar);
  }
  agndCarregar();
}

async function agndCarregar() {
  const res = document.getElementById("agndResultado");
  if (_agndCarregando) return;
  _agndCarregando = true;
  if (res) res.innerHTML = `<div class="agnd-vazio">Calculando recomendações…</div>`;

  const de = document.getElementById("agndDe")?.value || "";
  const ate = document.getElementById("agndAte")?.value || "";
  const alvo = document.getElementById("agndAlvo")?.value || "0.8";
  const params = new URLSearchParams({ alvo });
  if (de) params.set("de", de);
  if (ate) params.set("ate", ate);

  try {
    const r = await fetch(`${API_URL}/agendamento/recomendacoes?${params.toString()}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    _agndDados = await r.json();
  } catch (err) {
    console.error("[agndCarregar]", err);
    _agndDados = null;
    if (res) res.innerHTML = `<div class="agnd-vazio">Não consegui carregar as recomendações.<br><small>${_agndEsc(err.message)}</small></div>`;
    _agndCarregando = false;
    return;
  }
  _agndCarregando = false;
  agndPreencherRotas();
  agndRenderResultado();
}

function agndPreencherRotas() {
  const sel = document.getElementById("agndRota");
  if (!sel || !_agndDados) return;
  const atual = sel.value;
  const rotas = (_agndDados.rotas || []).map((r) => r.rota);
  sel.innerHTML =
    `<option value="">Todas as rotas (${rotas.length})</option>` +
    rotas.map((r) => `<option value="${_agndEsc(r)}">${_agndEsc(r)}</option>`).join("");
  if (atual && rotas.includes(atual)) sel.value = atual;
}

function agndRenderResultado() {
  const res = document.getElementById("agndResultado");
  if (!res) return;
  if (!_agndDados || !(_agndDados.rotas || []).length) {
    res.innerHTML = `<div class="agnd-vazio">Sem entregas com horário de chegada no período. Ajuste o filtro de datas.</div>`;
    return;
  }
  const filtroRota = document.getElementById("agndRota")?.value || "";
  const rotas = filtroRota ? _agndDados.rotas.filter((r) => r.rota === filtroRota) : _agndDados.rotas;
  if (!rotas.length) {
    res.innerHTML = `<div class="agnd-vazio">Rota sem dados suficientes.</div>`;
    return;
  }
  res.innerHTML = rotas.map(_agndRotaHtml).join("");
}

function _agndRotaHtml(rota) {
  const linhas = (rota.lojas || []).map(_agndLinhaHtml).join("");
  return `
    <div class="agnd-rota">
      <div class="agnd-rota-head">
        <h3>${_agndEsc(rota.rota)}</h3>
        <div class="agnd-rota-chips">
          <span class="agnd-chip">${rota.qtd_dias || (rota.dias || []).length} dia(s)</span>
          <span class="agnd-chip">${rota.lojas.length} loja(s)</span>
          <span class="agnd-chip">Saída fábrica ${_agndEsc(rota.saida_fabrica || "—")}</span>
          <span class="agnd-chip">Jornada ${_agndEsc(rota.jornada_med_humana || _agDur(rota.jornada_med))}</span>
        </div>
      </div>
      <div class="agnd-tabela-wrap">
        <table data-ordenavel class="agnd-tabela">
          <thead>
            <tr>
              <th>#</th><th>Loja</th>
              <th title="Horário típico (mediano) em que o caminhão chega hoje">Chega hoje</th>
              <th title="Horário agendado atual (mais frequente)">Agendado</th>
              <th title="Horário recomendado para chegar no prazo na meta escolhida">Recomendado</th>
              <th title="Pontualidade atual vs projetada com o horário recomendado">Pontualidade</th>
              <th title="Espera: chegada → início da descarga">Espera</th>
              <th title="Tempo de descarga (início → fim)">Descarga</th>
              <th title="Deslocamento até esta loja (mediano)">Deslocamento</th>
              <th title="Agendamento irrealista">⚠</th>
            </tr>
          </thead>
          <tbody>${linhas}</tbody>
        </table>
      </div>
    </div>`;
}

function _agndLinhaHtml(l) {
  const recIgual = l.recomendado && l.agendado_atual && l.recomendado === l.agendado_atual;
  const recHtml = l.recomendado
    ? `<span class="agnd-hora ${recIgual ? "agnd-rec-igual" : "agnd-rec"}">${_agndEsc(l.recomendado)}</span>`
    : "—";
  const agendadoHtml = l.agendado_atual
    ? `<span class="agnd-hora">${_agndEsc(l.agendado_atual)}</span>`
    : `<span class="agnd-mini">sem agendado</span>`;

  const pontA = l.pontualidade_atual;
  const pontP = l.pontualidade_projetada;
  const pontHtml = `
    <div class="agnd-pont">
      <div class="agnd-pont-linha" title="Pontualidade com o agendamento atual">
        <span style="width:38px;">atual</span>
        <div class="agnd-bar agnd-bar-atual"><span style="width:${Math.round((pontA || 0) * 100)}%"></span></div>
        <b>${_agPct(pontA)}</b>
      </div>
      <div class="agnd-pont-linha" title="Pontualidade projetada com o horário recomendado">
        <span style="width:38px;">proj.</span>
        <div class="agnd-bar agnd-bar-proj"><span style="width:${Math.round((pontP || 0) * 100)}%"></span></div>
        <b>${_agPct(pontP)}</b>
      </div>
    </div>`;

  const flag = l.irrealista
    ? `<span class="agnd-flag" title="Agenda às ${_agndEsc(l.agendado_atual)} mas costuma chegar às ${_agHHMM(l.chegada_med)} — atraso crônico.">⚠</span>`
    : "";

  // evidências de texto (atrasos extraídos dos relatos)
  let evid = "";
  if ((l.atrasos_texto || []).length) {
    const itens = l.atrasos_texto
      .slice(0, 8)
      .map((a) => {
        const tag = a.origem === "loja" ? ` <span class="agnd-tag-loja">(loja)</span>` : "";
        return `<li><b>${a.minutos} min</b>${tag} — <span class="agnd-mini">${_agndEsc(a.trecho)}</span></li>`;
      })
      .join("");
    evid = `
      <tr class="agnd-row-evid"><td></td><td colspan="9">
        <details class="agnd-evid">
          <summary>${l.atrasos_texto.length} relato(s) de atraso no histórico</summary>
          <ul>${itens}</ul>
        </details>
      </td></tr>`;
  }

  return `
    <tr class="${l.irrealista ? "agnd-row-irreal" : ""}">
      <td class="agnd-ordem">${l.ordem}ª</td>
      <td class="agnd-loja">${_agndEsc(l.loja)}<small>${l.n} entrega(s)</small></td>
      <td class="agnd-hora agnd-mini">${_agHHMM(l.chegada_med)}</td>
      <td>${agendadoHtml}</td>
      <td>${recHtml}</td>
      <td>${pontHtml}</td>
      <td class="agnd-mini">${_agDur(l.espera_med)}</td>
      <td class="agnd-mini">${_agDur(l.descarga_med)}</td>
      <td class="agnd-mini">${_agDur(l.deslocamento_med)}</td>
      <td style="text-align:center;">${flag}</td>
    </tr>
    ${evid}`;
}
