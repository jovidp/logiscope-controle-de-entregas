// ================================================================
// CTEs do dia — lembrete de emissão de CTE por LOJA.
// Puxa as viagens do dia do TMS (GET /tms/viagens?data=) e lista, dentro
// de cada rota, as LOJAS daquela rota (paradas). Cada loja tem seu próprio
// checkbox de "CTE emitido" (PUT /tms/paradas/:id/cte).
// Reaproveita helpers globais: $, escapar, hojeISO, alertar e TMS_API.
// ================================================================

const CTES_API = typeof TMS_API !== "undefined" ? TMS_API : window.location.origin;

async function ctesRequest(path, options = {}) {
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {}),
  };
  const resp = await fetch(`${CTES_API}${path}`, { ...options, headers });
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(dados.error || "Erro ao processar solicitacao.");
  return dados;
}

// Viagens (com suas paradas/lojas) da data filtrada.
let ctesViagens = [];

function ctesInit() {
  const inp = document.getElementById("ctesFiltroData");
  if (inp && !inp.value) inp.value = hojeISO();
  ctesCarregar();
}

// manterPosicao: usado quando a recarga vem de uma acao NA LISTA (marcar a rota
// inteira). Ai trocar por "Carregando..." encolheria a pagina e tiraria a
// pessoa do lugar. Na carga inicial e na troca de data, o normal e comecar do
// topo mesmo.
async function ctesCarregar(manterPosicao) {
  const data = document.getElementById("ctesFiltroData")?.value || hojeISO();
  const lista = document.getElementById("ctesLista");
  const resumo = document.getElementById("ctesResumo");
  const y = window.scrollY;
  const altura = manterPosicao && lista ? lista.offsetHeight : 0;

  if (altura) {
    // Segura a altura para a pagina nao encolher enquanto busca no servidor.
    lista.style.minHeight = altura + "px";
  } else if (lista) {
    lista.innerHTML = `<p style="color:var(--text-muted);padding:14px;">Carregando…</p>`;
  }

  try {
    const viagens = await ctesRequest(`/tms/viagens?data=${encodeURIComponent(data)}`);
    ctesViagens = Array.isArray(viagens) ? viagens : [];
    ctesRender();
    if (manterPosicao) {
      requestAnimationFrame(() => {
        window.scrollTo({ top: y, left: 0, behavior: "instant" });
        if (lista) lista.style.minHeight = "";
      });
    }
  } catch (err) {
    if (resumo) resumo.innerHTML = "";
    if (lista) {
      lista.style.minHeight = "";
      lista.innerHTML = `<p style="color:var(--danger,#e5484d);padding:14px;">Erro ao carregar viagens: ${escapar(err.message)}</p>`;
    }
  }
}

// Soma das lojas (paradas) de todas as rotas e quantas já têm CTE.
function ctesContar() {
  let total = 0, feitos = 0;
  ctesViagens.forEach((v) => (v.paradas || []).forEach((p) => {
    total += 1;
    if (p.cte_concluido) feitos += 1;
  }));
  return { total, feitos, pendentes: total - feitos };
}

// Redesenha a lista SEM jogar a pagina para o topo.
//
// ctesRender() troca o innerHTML inteiro. No instante da troca a lista fica com
// altura zero: a pagina encolhe, o navegador percebe que a posicao atual nao
// existe mais e sobe tudo. Quem marca CTE de uma loja no meio de 40 perdia o
// lugar a cada clique e tinha de rolar de novo.
//
// A altura fica travada durante a troca (para a pagina nao encolher) e a
// posicao e restaurada no quadro seguinte. O "instant" e necessario: o
// scroll-behavior do sistema e smooth, e sem isso a restauracao viraria uma
// animacao de volta — o pulo ficaria visivel do mesmo jeito.
function ctesRenderMantendoPosicao() {
  const y = window.scrollY;
  const lista = document.getElementById("ctesLista");
  const altura = lista ? lista.offsetHeight : 0;
  if (lista && altura) lista.style.minHeight = altura + "px";

  ctesRender();

  requestAnimationFrame(() => {
    window.scrollTo({ top: y, left: 0, behavior: "instant" });
    if (lista) lista.style.minHeight = "";
  });
}

function ctesRender() {
  const lista = document.getElementById("ctesLista");
  const resumo = document.getElementById("ctesResumo");
  if (!lista) return;

  const { total, feitos, pendentes } = ctesContar();

  if (total === 0) {
    if (resumo) resumo.innerHTML = "";
    lista.innerHTML = `<p style="color:var(--text-muted);padding:14px;">Nenhuma loja/viagem cadastrada no TMS para esta data.</p>`;
    ctesAtualizarBadge();
    return;
  }

  const pct = total ? Math.round((feitos / total) * 100) : 0;
  if (resumo) {
    resumo.innerHTML = `
      <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:6px 0 14px;">
        <div style="font-size:1.4rem;font-weight:800;color:var(--text-primary);">${feitos}<span style="font-size:0.9rem;color:var(--text-muted);font-weight:600;"> / ${total} CTEs (lojas)</span></div>
        <div style="flex:1;min-width:160px;height:10px;background:var(--surface-2,#2a2a2a);border-radius:999px;overflow:hidden;">
          <div style="height:100%;width:${pct}%;background:${pendentes ? "var(--accent,#f5a623)" : "var(--success,#30a46c)"};transition:width .25s;"></div>
        </div>
        <div style="font-size:0.8rem;font-weight:700;color:${pendentes ? "var(--accent,#f5a623)" : "var(--success,#30a46c)"};">
          ${pendentes ? `${pendentes} pendente${pendentes > 1 ? "s" : ""}` : "Tudo concluído ✅"}
        </div>
        ${pendentes ? `<button type="button" class="btn-green btn-sm" onclick="ctesMarcarDia()" title="Marcar o CTE de todas as lojas pendentes de todas as rotas do dia"
          style="white-space:nowrap;">✓ Marcar todas do dia (${pendentes})</button>` : ""}
      </div>`;
  }

  // Rotas ordenadas por nome; lojas dentro de cada rota por ordem da parada.
  const rotas = [...ctesViagens].sort((a, b) =>
    String(a.rota_nome || a.codigo || "").localeCompare(String(b.rota_nome || b.codigo || "")));

  lista.innerHTML = rotas.map(ctesRotaHtml).join("");
  ctesAtualizarBadge();
}

// Viagem "urgente" para CTE: ja saiu/terminou mas ainda tem loja sem CTE.
function ctesViagemUrgente(v, pendentes) {
  return pendentes > 0 && ["Em rota", "Retorno", "Finalizada"].includes(String(v.status || ""));
}

// Total de frete da rota (ida, retorno e a soma dos dois).
// Loja sem preco cadastrado entra na CONTAGEM do aviso, nunca na soma: um total
// parcial sem aviso passaria por fechado e o valor do lote sairia menor do que e.
function ctesTotalFreteHtml(paradas) {
  let ida = 0, retorno = 0, semPreco = 0;

  paradas.forEach((p) => {
    if (p.frete_na_conta === false) return;   // fora da conta de proposito
    const a = ctesNum(ctesFreteIda(p));
    const b = ctesNum(ctesFreteRetorno(p));
    if (a === null && b === null) { semPreco += 1; return; }
    ida += a || 0;
    retorno += b || 0;
  });

  if (ida === 0 && retorno === 0) return "";

  const valor = (n) => `<strong style="color:var(--text-primary);font-variant-numeric:tabular-nums;">${escapar(ctesMoeda(n))}</strong>`;
  const aviso = semPreco
    ? ` · <span style="color:var(--accent,#f5a623);font-weight:700;">parcial: ${semPreco} loja${semPreco > 1 ? "s" : ""} sem preço</span>`
    : "";

  return `<div style="font-size:0.74rem;color:var(--text-muted);margin-top:4px;">
      💰 Ida ${valor(ida)} · ↩️ Retorno ${valor(retorno)} · Σ Total ${valor(ida + retorno)}${aviso}
    </div>`;
}

function ctesRotaHtml(v) {
  const paradas = [...(v.paradas || [])].sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
  const feitos = paradas.filter((p) => p.cte_concluido).length;
  const totalLojas = paradas.length;
  const pendentes = totalLojas - feitos;
  const completa = totalLojas > 0 && feitos === totalLojas;
  const urgente = ctesViagemUrgente(v, pendentes);

  const rota = escapar(v.rota_nome || v.codigo || `Viagem #${v.id}`);
  const sub = [
    v.motorista_nome ? `🧑‍✈️ ${escapar(v.motorista_nome)}` : "",
    v.placa ? `🚚 ${escapar(v.placa)}` : "",
  ].filter(Boolean).join(" · ");

  const lojasHtml = totalLojas
    ? paradas.map(ctesLojaHtml).join("")
    : `<div style="padding:10px 14px;color:var(--text-muted);font-size:0.8rem;">Sem lojas nesta rota.</div>`;

  // Botao "Marcar todas" so quando ha pendencia; "Limpar" quando esta tudo feito.
  const acaoLote = pendentes > 0
    ? `<button type="button" class="btn-green btn-sm" onclick="ctesMarcarRota(${v.id}, true)" title="Emitir CTE de todas as lojas desta rota"
         style="flex:0 0 auto;white-space:nowrap;">✓ Marcar todas</button>`
    : (totalLojas > 0
      ? `<button type="button" onclick="ctesMarcarRota(${v.id}, false)" title="Desmarcar todas"
           style="flex:0 0 auto;font-size:0.72rem;font-weight:700;padding:5px 11px;border-radius:8px;cursor:pointer;
           border:1px solid var(--border,#333);background:transparent;color:var(--text-muted);white-space:nowrap;">Limpar</button>`
      : "");

  return `
    <div class="ctes-rota" style="border:1px solid ${urgente ? "rgba(239,68,68,.5)" : "var(--border,#333)"};border-radius:12px;margin-bottom:14px;overflow:hidden;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;background:var(--surface-2,#242424);border-bottom:1px solid var(--border,#333);">
        <div style="min-width:0;">
          <div style="font-weight:800;font-size:1rem;color:var(--text-primary);">🛣️ ${rota}${urgente ? ` <span title="Viagem ${escapar(String(v.status))} com CTE pendente" style="font-size:0.7rem;color:#ef4444;font-weight:800;">⚠ ${escapar(String(v.status))}</span>` : ""}</div>
          ${sub ? `<div style="font-size:0.76rem;color:var(--text-muted);margin-top:2px;">${sub}</div>` : ""}
          ${ctesTotalFreteHtml(paradas)}
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex:0 0 auto;">
          <span style="font-size:0.74rem;font-weight:800;padding:3px 9px;border-radius:999px;white-space:nowrap;
            color:${completa ? "var(--success,#30a46c)" : "var(--accent,#f5a623)"};
            background:${completa ? "var(--success-soft,rgba(48,164,108,.12))" : "rgba(245,166,35,.12)"};">
            ${feitos}/${totalLojas} lojas${completa ? " ✅" : ""}
          </span>
          ${acaoLote}
        </div>
      </div>
      <div style="padding:8px 10px;">${lojasHtml}</div>
    </div>`;
}

// Marca/desmarca o CTE de TODAS as lojas de uma viagem numa tacada so.
async function ctesMarcarRota(viagemId, concluido) {
  try {
    await ctesRequest(`/tms/viagens/${viagemId}/ctes`, {
      method: "PUT",
      body: JSON.stringify({ concluido }),
    });
    if (window.Bus) window.Bus.emit("dados:mudou", { origem: "ctes", viagem_id: viagemId });
    await ctesCarregar(true);   // acao na lista: nao tirar a pessoa do lugar
  } catch (err) {
    alertar(`Não foi possível emitir os CTEs da rota: ${err.message}`);
  }
}

// Todas as rotas do dia de uma vez (o lote por rota ja existe; aqui e o dia
// inteiro num clique, com confirmacao — CTE e controle fiscal).
async function ctesMarcarDia() {
  const comPendencia = (ctesViagens || []).filter((v) => (v.paradas || []).some((p) => !p.cte_concluido));
  const lojas = comPendencia.reduce((s, v) => s + (v.paradas || []).filter((p) => !p.cte_concluido).length, 0);
  if (!lojas) return;
  const ok = typeof confirmarBonito === "function"
    ? await confirmarBonito(`Marcar como emitido o CTE de ${lojas} loja(s) pendente(s) em ${comPendencia.length} rota(s)?`,
      { okLabel: "Marcar todas", cancelLabel: "Cancelar" })
    : confirm(`Marcar como emitido o CTE de ${lojas} loja(s) pendente(s)?`);
  if (!ok) return;
  const falhas = [];
  for (const v of comPendencia) {
    try {
      await ctesRequest(`/tms/viagens/${v.id}/ctes`, { method: "PUT", body: JSON.stringify({ concluido: true }) });
    } catch (err) {
      falhas.push(`${v.rota_nome || v.codigo || v.id}: ${err.message}`);
    }
  }
  if (window.Bus) window.Bus.emit("dados:mudou", { origem: "ctes" });
  await ctesCarregar(true);
  if (falhas.length) alertar(`Não consegui marcar os CTEs de:\n${falhas.join("\n")}`);
}
window.ctesMarcarDia = ctesMarcarDia;

// Frete vem do servidor como NUMERIC (string) ou null quando a loja ainda nao
// esta na tabela de preco. Devolve null nesses casos — e nao 0 — para a tela
// poder distinguir "custa zero" de "nao ha valor cadastrado".
function ctesNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function ctesMoeda(v) {
  const n = ctesNum(v);
  if (n === null) return null;
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

// Linha de frete da loja: valor de IDA e de RETORNO, que e o que a pessoa
// precisa ter na mao para emitir o CTE daquela loja.
function ctesFreteHtml(p) {
  // Parada marcada como fora da conta (na_conta = false no banco): nao e falta
  // de cadastro, e decisao da operacao. Precisa ficar escrito, senao alguem
  // "corrige" cadastrando um preco que nao deveria existir.
  if (p.frete_na_conta === false) {
    return `<div style="font-size:0.7rem;color:var(--text-muted);margin-top:3px;opacity:.75;">
      💰 não entra na conta do frete
    </div>`;
  }

  const ida = ctesMoeda(ctesFreteIda(p));
  const volta = ctesMoeda(ctesFreteRetorno(p));

  if (!ida && !volta) {
    return `<div style="font-size:0.7rem;color:var(--text-muted);margin-top:3px;opacity:.75;">
      💰 frete não cadastrado para esta loja
    </div>`;
  }

  const item = (rotulo, valor) => `
    <span style="display:inline-flex;align-items:baseline;gap:4px;">
      <span style="color:var(--text-muted);">${rotulo}</span>
      <strong style="color:var(--text-primary);font-variant-numeric:tabular-nums;">${valor ? escapar(valor) : "—"}</strong>
    </span>`;

  const tipo = p.frete_calc != null ? ({ "2_EIXOS": "2 eixos", "3_EIXOS": "3 eixos", "6_EIXOS": "carreta" }[p.frete_tipo] || "") : "";
  const dica = p.frete_calc != null
    ? `Calculado: ${p.km_fabrica} km da fábrica × CCD + taxa fixa do caminhão (${tipo}). Retorno = mesmo valor do envio.`
    : "Valor da tabela antiga de frete";
  return `<div style="display:flex;flex-wrap:wrap;gap:4px 14px;font-size:0.74rem;margin-top:3px;" title="${escapar(dica)}">
      ${item(`💰 Ida${tipo ? ` (${tipo})` : ""}`, ida)}${item("↩️ Retorno", volta)}${p.pes ? item("PES", String(p.pes)) : ""}
    </div>`;
}

// Frete de ida: o calculado pelo cadastro de lojas (km x CCD + taxa do tipo de
// caminhao da viagem) quando existe; senao o valor da tabela antiga.
function ctesFreteIda(p) {
  return p.frete_calc != null ? p.frete_calc : p.frete_envio;
}

// Retorno: modelo atual da operacao = mesmo valor do envio (calculado).
function ctesFreteRetorno(p) {
  return p.frete_retorno_calc != null ? p.frete_retorno_calc : p.frete_retorno;
}

function ctesLojaHtml(p) {
  const feito = !!p.cte_concluido;
  const loja = escapar(p.loja_nome || `Loja #${p.loja_id || p.id}`);
  const cod = p.loja_codigo ? `<span style="color:var(--text-muted);font-weight:500;"> · ${escapar(String(p.loja_codigo))}</span>` : "";
  const vol = (p.volumes_previstos != null && p.volumes_previstos !== "")
    ? `<span style="font-size:0.74rem;color:var(--text-muted);"> · 📦 ${escapar(String(p.volumes_previstos))} vol.</span>` : "";
  const frete = ctesFreteHtml(p);

  let assinatura = "";
  if (feito) {
    const quando = p.cte_concluido_em ? ctesFmtData(p.cte_concluido_em) : "";
    const quem = p.cte_concluido_por ? escapar(p.cte_concluido_por) : "";
    const partes = [quem, quando].filter(Boolean).join(" · ");
    assinatura = partes ? `<div style="font-size:0.68rem;color:var(--success,#30a46c);margin-top:2px;">✅ ${partes}</div>` : "";
  }

  return `
    <label style="display:flex;align-items:flex-start;gap:12px;padding:9px 10px;border-radius:8px;cursor:pointer;
        background:${feito ? "var(--success-soft,rgba(48,164,108,.07))" : "transparent"};">
      <input type="checkbox" ${feito ? "checked" : ""}
        onchange="ctesToggle(${p.id}, this)"
        style="width:20px;height:20px;min-height:0;min-width:20px;padding:0;flex:0 0 auto;margin-top:1px;cursor:pointer;appearance:auto;-webkit-appearance:checkbox;accent-color:var(--success,#30a46c);" />
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;font-size:0.9rem;color:var(--text-primary);${feito ? "text-decoration:line-through;text-decoration-color:var(--text-muted);" : ""}">🏬 ${loja}${cod}${vol}</div>
        ${frete}
        ${assinatura}
      </div>
    </label>`;
}

async function ctesToggle(paradaId, checkbox) {
  const concluido = checkbox.checked;
  checkbox.disabled = true;
  try {
    const atualizada = await ctesRequest(`/tms/paradas/${paradaId}/cte`, {
      method: "PUT",
      body: JSON.stringify({ concluido }),
    });
    // Atualiza a parada no estado local e re-renderiza (resumo + contadores da rota).
    for (const v of ctesViagens) {
      const p = (v.paradas || []).find((x) => x.id === paradaId);
      if (p) { Object.assign(p, atualizada); break; }
    }
    if (window.Bus) window.Bus.emit("dados:mudou", { origem: "ctes", parada_id: paradaId });
    ctesRenderMantendoPosicao();
  } catch (err) {
    checkbox.checked = !concluido;
    checkbox.disabled = false;
    alertar(`Não foi possível salvar o CTE: ${err.message}`);
  }
}

// Badge da aba: nº de lojas com CTE pendente HOJE (independe do filtro de data).
async function ctesAtualizarBadge() {
  const badge = document.getElementById("badgeNavCtes");
  if (!badge) return;
  try {
    const dataFiltro = document.getElementById("ctesFiltroData")?.value;
    let viagens;
    if (dataFiltro === hojeISO()) {
      viagens = ctesViagens;
    } else {
      viagens = await ctesRequest(`/tms/viagens?data=${encodeURIComponent(hojeISO())}`);
    }
    let pend = 0;
    (Array.isArray(viagens) ? viagens : []).forEach((v) =>
      (v.paradas || []).forEach((p) => { if (!p.cte_concluido) pend += 1; }));
    badge.textContent = pend;
    badge.style.display = pend > 0 ? "" : "none";
  } catch {
    /* badge é só indicador; ignora falhas */
  }
}

function ctesFmtData(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d)) return escapar(String(iso));
    return d.toLocaleString("pt-BR", {
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return escapar(String(iso));
  }
}

document.addEventListener("DOMContentLoaded", () => {
  setTimeout(() => ctesAtualizarBadge(), 1500);
  // Reage ao event bus: se o CTE mudou em outra tela (ex.: fila "Resolver agora"),
  // recarrega a lista quando a aba CTEs estiver aberta e sempre atualiza o badge.
  if (window.Bus) {
    window.Bus.on("dados:mudou", (d) => {
      if (d && d.origem === "ctes") return; // ja tratado localmente
      const aba = document.getElementById("aba-ctes");
      // Mudanca vinda de OUTRO usuario/tela: recarrega mantendo a posicao.
      // Atualizacao automatica nunca deve tirar do lugar quem esta no meio da
      // conferencia — e pior do que a lista ficar alguns segundos desatualizada.
      if (aba && !aba.classList.contains("aba-hidden")) ctesCarregar(true);
      else ctesAtualizarBadge();
    });
  }
});

window.ctesInit = ctesInit;
window.ctesCarregar = ctesCarregar;
window.ctesToggle = ctesToggle;
window.ctesMarcarRota = ctesMarcarRota;
