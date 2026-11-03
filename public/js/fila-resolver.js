// ================================================================
// FILA "RESOLVER AGORA" — worklist de pendencias acionaveis (+ acoes de 1 clique)
// ----------------------------------------------------------------
// Item #3 da iniciativa de eficiencia. Consome GET /painel/fila e desenha, no
// topo do Dashboard, a lista de coisas que alguem precisa RESOLVER hoje, ja
// priorizada. Onde da, resolve SEM sair da fila (acoes de 1 clique):
//   - ocorrencia sem responsavel -> select de setor + Atribuir
//   - checklist faltando         -> botao "Feito"
//   - avulsa sem responsavel     -> select de setor culpado + Atribuir
// Os demais itens (ja com responsavel, CTE) mantem o "Resolver ›" que leva
// direto ao registro (form da ocorrencia na aba entregas, ou aba relevante).
//
// Semente da Fase 2 do roadmap (atualizar sem F5): expoe window.Bus (emit/on)
// e, apos cada acao, emite "dados:mudou" e reatualiza a fila + painel "Agora".
// Frontend puro; reusa window.fetch (ja trata o cookie de sessao).
// ================================================================
(function () {
  "use strict";

  const REFRESH_MS = 60000;
  let carregando = false;
  let itensAtuais = [];

  // ---- Mini event bus (Fase 2): pub/sub client-side, sem dependencias. ----
  // Idempotente: se outro modulo ja criou window.Bus, reaproveita.
  const Bus = window.Bus || (window.Bus = (function () {
    const ouvintes = {};
    return {
      on(evento, fn) { (ouvintes[evento] = ouvintes[evento] || []).push(fn); return () => Bus.off(evento, fn); },
      off(evento, fn) { ouvintes[evento] = (ouvintes[evento] || []).filter((f) => f !== fn); },
      emit(evento, dados) {
        (ouvintes[evento] || []).forEach((fn) => { try { fn(dados); } catch (e) { console.error("[Bus]", evento, e); } });
      },
    };
  })());

  // Setores culpados das avulsas (espelha OAVUL_SETORES em ocorrencias.js).
  const SETORES_CULPA = [
    "EXPEDICAO", "TRANSPORTE", "ESTOQUE", "4 ANDAR", "COMERCIAL",
    "CONTROLE DE ESTOQUE", "VM", "GRAFICA", "LOJA", "SUPERVISAO INTERNA",
    "ALMOXERIFADO", "EQUIPE DA ENTREGA", "SEGURANCA DO TRABALHO", "PLANEJAMENTO", "T.I",
  ];

  function esc(v) {
    return escapar(v);
  }

  function dashboardVisivel() {
    const aba = document.getElementById("aba-dashboard");
    return aba && !aba.classList.contains("aba-hidden");
  }

  // Le a lista de responsaveis direto do form (fica sempre em sincronia com o HTML).
  function opcoesResponsavel() {
    const doDom = Array.from(document.querySelectorAll('[data-multi-group="ocorrenciaResponsavel"]'))
      .map((el) => el.value).filter(Boolean);
    return doDom.length ? doDom : SETORES_CULPA;
  }

  function selectHtml(opcoes) {
    return `<select class="fr-sel"><option value="">— setor —</option>` +
      opcoes.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("") +
      `</select>`;
  }

  function injetarEstilos() {
    if (document.getElementById("frEstilos")) return;
    const css = `
      .fila-resolver{background:var(--bg-elevated,#0f172a);border:1px solid var(--border,#1e293b);
        border-radius:14px;padding:14px 16px;margin-bottom:12px;}
      .fila-resolver[hidden]{display:none;}
      .fr-head{display:flex;align-items:center;gap:10px;margin-bottom:10px;}
      .fr-head h3{margin:0;font-size:15px;color:var(--text-heading,#f8fafc);display:flex;align-items:center;gap:8px;}
      .fr-badge{background:#ef4444;color:#fff;font-size:11px;font-weight:700;min-width:20px;height:20px;
        border-radius:10px;display:inline-flex;align-items:center;justify-content:center;padding:0 6px;}
      .fr-badge[data-zero="1"]{background:#22c55e;}
      .fr-refresh{margin-left:auto;background:transparent;border:1px solid var(--border,#1e293b);color:var(--text-muted,#94a3b8);
        width:28px;height:28px;border-radius:8px;cursor:pointer;font-size:14px;line-height:1;}
      .fr-refresh:hover{color:var(--text-heading,#e2e8f0);border-color:#38bdf8;}
      .fr-lista{display:flex;flex-direction:column;gap:7px;max-height:360px;overflow-y:auto;}
      .fr-item{display:flex;align-items:center;gap:11px;padding:9px 11px;border-radius:10px;
        background:rgba(255,255,255,.03);border-left:3px solid var(--border,#334155);transition:opacity .25s ease;}
      .fr-item.fr-alta{border-left-color:#ef4444;}
      .fr-item.fr-media{border-left-color:#f59e0b;}
      .fr-item.fr-baixa{border-left-color:#64748b;}
      .fr-item.fr-saindo{opacity:0;}
      .fr-ic{font-size:17px;line-height:1;flex:0 0 auto;}
      .fr-txt{min-width:0;flex:1 1 auto;}
      .fr-txt strong{display:block;font-size:13px;color:var(--text-heading,#e2e8f0);
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .fr-txt small{display:block;font-size:11px;color:var(--text-muted,#94a3b8);
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .fr-acao{flex:0 0 auto;display:flex;align-items:center;gap:6px;}
      .fr-sel{background:var(--bg,#0b1220);color:var(--text-heading,#e2e8f0);border:1px solid var(--border,#334155);
        border-radius:7px;padding:6px 8px;font-size:12px;max-width:150px;}
      .fr-btn{background:linear-gradient(135deg,#38bdf8,#2563eb);color:#fff;border:none;
        border-radius:8px;padding:7px 12px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;}
      .fr-btn:hover{filter:brightness(1.08);}
      .fr-btn:disabled{opacity:.55;cursor:default;}
      .fr-ok{background:linear-gradient(135deg,#22c55e,#16a34a);}
      .fr-open{background:transparent;border:1px solid var(--border,#334155);color:var(--text-muted,#94a3b8);
        border-radius:8px;padding:6px 9px;font-size:12px;cursor:pointer;line-height:1;}
      .fr-open:hover{color:var(--text-heading,#e2e8f0);border-color:#38bdf8;}
      .fr-vazio{padding:14px;text-align:center;color:var(--text-muted,#94a3b8);font-size:13px;}
    `;
    const style = document.createElement("style");
    style.id = "frEstilos";
    style.textContent = css;
    document.head.appendChild(style);
  }

  // Deep-link "Resolver ›" / ↗: leva direto ao registro. Ocorrencias (parada e
  // checklist) editam-se no #form da aba entregas -> navega, edita e rola ate ele.
  function abrirRegistro(item) {
    if (!item) return;
    if (item.ocorrencia_id && typeof window.editarOcorrencia === "function") {
      if (typeof window.irParaAba === "function") window.irParaAba("entregas");
      setTimeout(() => {
        window.editarOcorrencia(item.ocorrencia_id);
        setTimeout(() => {
          document.getElementById("form")?.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 140);
      }, 60);
      return;
    }
    if (item.aba && typeof window.irParaAba === "function") window.irParaAba(item.aba);
  }

  // PUT com JSON; devolve {ok, dados} ou lanca.
  async function putJson(url, body) {
    const resp = await fetch(`${window.location.origin}${url}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body || {}),
    });
    if (!resp.ok) {
      let msg = "HTTP " + resp.status;
      try { const j = await resp.json(); if (j && j.error) msg = j.error; } catch (_) {}
      const erro = new Error(msg);
      erro.status = resp.status;
      throw erro;
    }
    return resp.json().catch(() => ({}));
  }

  // Executa a acao de 1 clique de um item e, no sucesso, some com ele e reatualiza.
  async function executarAcao(rowEl, item, acao) {
    if (!item) return;
    const btns = rowEl.querySelectorAll("button, select");
    const sel = rowEl.querySelector(".fr-sel");
    let url, corpo;
    if (acao === "responsavel") {
      const v = sel && sel.value;
      if (!v) { sel && sel.focus(); return; }
      url = `/ocorrencias/${item.ocorrencia_id}/responsavel`; corpo = { responsavel: v };
    } else if (acao === "culpa") {
      const v = sel && sel.value;
      if (!v) { sel && sel.focus(); return; }
      url = `/ocorrencias-avulsas/${item.avulsa_id}/culpa`; corpo = { culpa: v };
    } else if (acao === "checklist") {
      url = `/ocorrencias/${item.ocorrencia_id}/checklist`; corpo = {};
    } else if (acao === "cte_lote") {
      // Emite CTE de todas as paradas COM REMESSA da viagem (mesmo criterio do item).
      url = `/tms/viagens/${item.viagem_id}/ctes`; corpo = { concluido: true, somente_com_remessa: true };
    } else { return; }

    btns.forEach((b) => (b.disabled = true));
    try {
      await putJson(url, corpo);
      // Sucesso: anima a saida do item, reatualiza a propria fila e avisa o bus
      // (o wiring central cuida de painel/historico/TMS/torre visiveis).
      rowEl.classList.add("fr-saindo");
      Bus.emit("dados:mudou", { origem: "fila-resolver", tipo: item.tipo, acao });
      setTimeout(atualizar, 260);
    } catch (err) {
      btns.forEach((b) => (b.disabled = false));
      // Endpoint ainda nao implantado (servidor sem restart) -> 404 (ADM) ou 403
      // (operador, fora da whitelist antiga): cai no deep-link, assim o usuario
      // resolve na mao sem ficar travado ate o restart.
      if (err.status === 404 || err.status === 403) { abrirRegistro(item); return; }
      alertar("❌ Não foi possível concluir: " + err.message);
    }
  }

  // Monta a "zona de acao" (lado direito) conforme o tipo do item.
  function zonaAcao(it, i) {
    if (it.tipo === "ocorrencia_sem_resp" && it.ocorrencia_id) {
      return `<div class="fr-acao">${selectHtml(opcoesResponsavel())}
        <button type="button" class="fr-btn fr-ok" data-i="${i}" data-acao="responsavel">Atribuir</button>
        <button type="button" class="fr-open" data-i="${i}" data-acao="abrir" title="Abrir registro">↗</button></div>`;
    }
    if (it.tipo === "avulsa_sem_resp" && it.avulsa_id) {
      return `<div class="fr-acao">${selectHtml(SETORES_CULPA)}
        <button type="button" class="fr-btn fr-ok" data-i="${i}" data-acao="culpa">Atribuir</button>
        <button type="button" class="fr-open" data-i="${i}" data-acao="abrir" title="Abrir registro">↗</button></div>`;
    }
    if (it.tipo === "sem_checklist" && it.ocorrencia_id) {
      return `<div class="fr-acao">
        <button type="button" class="fr-btn fr-ok" data-i="${i}" data-acao="checklist">✓ Feito</button>
        <button type="button" class="fr-open" data-i="${i}" data-acao="abrir" title="Abrir registro">↗</button></div>`;
    }
    if (it.tipo === "sem_cte" && it.viagem_id) {
      return `<div class="fr-acao">
        <button type="button" class="fr-btn fr-ok" data-i="${i}" data-acao="cte_lote">Emitir CTEs</button>
        <button type="button" class="fr-open" data-i="${i}" data-acao="abrir" title="Abrir aba CTEs">↗</button></div>`;
    }
    return `<div class="fr-acao">
      <button type="button" class="fr-btn" data-i="${i}" data-acao="abrir">Resolver ›</button></div>`;
  }

  function render(dados) {
    injetarEstilos();
    const sec = document.getElementById("fila-resolver");
    const lista = document.getElementById("frLista");
    const badge = document.getElementById("frBadge");
    if (!sec || !lista) return;

    itensAtuais = (dados && dados.itens) || [];
    const total = itensAtuais.length;

    if (badge) {
      badge.textContent = String(total);
      badge.setAttribute("data-zero", total === 0 ? "1" : "0");
    }

    if (total === 0) {
      if (!sec.dataset.forcar) { sec.hidden = true; return; }
      lista.innerHTML = `<div class="fr-vazio">✓ Nada pendente. Tudo em dia!</div>`;
      sec.hidden = false;
      return;
    }

    sec.hidden = false;
    lista.innerHTML = itensAtuais.map((it, i) => `
      <div class="fr-item fr-${esc(it.prioridade || "baixa")}" data-row="${i}">
        <span class="fr-ic">${esc(it.icone || "•")}</span>
        <span class="fr-txt">
          <strong>${esc(it.titulo)}</strong>
          <small>${esc(it.detalhe || "")}</small>
        </span>
        ${zonaAcao(it, i)}
      </div>`).join("");

    // Um unico handler por clique (delegacao dentro da lista).
    lista.querySelectorAll("[data-acao]").forEach((el) => {
      el.addEventListener("click", () => {
        const i = Number(el.dataset.i);
        const item = itensAtuais[i];
        const acao = el.dataset.acao;
        const rowEl = el.closest(".fr-item");
        if (acao === "abrir") abrirRegistro(item);
        else executarAcao(rowEl, item, acao);
      });
    });
  }

  async function atualizar() {
    const sec = document.getElementById("fila-resolver");
    if (!sec || carregando) return;
    carregando = true;
    try {
      const resp = await fetch(`${window.location.origin}/painel/fila`, { headers: { Accept: "application/json" } });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      render(await resp.json());
    } catch (err) {
      const lista = document.getElementById("frLista");
      if (lista && sec.dataset.forcar) {
        lista.innerHTML = `<div class="fr-vazio">Não foi possível carregar a fila agora.</div>`;
        sec.hidden = false;
      }
    } finally {
      carregando = false;
    }
  }

  // Abre/forca a exibicao do painel (command palette e botao dedicado).
  window.abrirFilaResolver = function () {
    const sec = document.getElementById("fila-resolver");
    if (!sec) return;
    sec.dataset.forcar = "1";
    if (!dashboardVisivel() && typeof window.irParaAba === "function") window.irParaAba("dashboard");
    atualizar();
    setTimeout(() => sec.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };
  window.filaResolverAtualizar = atualizar;

  // Reage a mudancas emitidas por outras partes (quando existir): atualiza se visivel.
  Bus.on("dados:mudou", (d) => {
    if (d && d.origem === "fila-resolver") return; // ja tratamos localmente
    if (dashboardVisivel()) atualizar();
  });

  // Atualiza ao ENTRAR no Dashboard (encadeia sobre o irParaAba existente).
  const _orig = window.irParaAba;
  window.irParaAba = function (nome, ...rest) {
    if (typeof _orig === "function") _orig(nome, ...rest);
    if (nome === "dashboard") setTimeout(atualizar, 0);
  };

  // Botao de atualizar do cabecalho.
  document.addEventListener("click", (e) => {
    if (e.target && e.target.id === "frRefresh") atualizar();
  });

  // Poll leve: so busca quando o Dashboard esta visivel.
  setInterval(() => { if (dashboardVisivel()) atualizar(); }, REFRESH_MS);

  // Primeira carga se o Dashboard ja estiver aberto ao carregar a pagina.
  document.addEventListener("DOMContentLoaded", () => {
    if (window.authReady && typeof window.authReady.then === "function") {
      window.authReady.then(() => { if (dashboardVisivel()) atualizar(); });
    } else if (dashboardVisivel()) {
      atualizar();
    }
  });
})();
