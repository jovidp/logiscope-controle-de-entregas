// ================================================================
// PAINEL "AGORA" — resumo operacional + alertas na tela principal
// ----------------------------------------------------------------
// Consome GET /painel/resumo (agregacao read-only no servidor) e desenha, no
// topo da aba Dashboard, indicadores praticos do dia e alertas acionaveis.
// Cada indicador/alerta leva o usuario direto para a aba relevante (irParaAba).
// Atualiza ao entrar na aba Dashboard e a cada 60s enquanto ela estiver aberta.
// Nao depende de bibliotecas; usa o window.fetch (ja tratado para o cookie de sessao).
// ================================================================
(function () {
  "use strict";

  const REFRESH_MS = 60000;
  let carregando = false;

  function esc(v) {
    return escapar(v);
  }

  function dashboardVisivel() {
    const aba = document.getElementById("aba-dashboard");
    return aba && !aba.classList.contains("aba-hidden");
  }

  // Definicao dos cartoes de indicador: chave no payload, rotulo, aba destino e
  // se um valor > 0 deve acender em "atencao" (amarelo) ou "alerta" (vermelho).
  const CARTOES = [
    { chave: "entregas_pendentes", rotulo: "Pendentes", aba: "tms", tom: "neutro" },
    { chave: "entregas_atrasadas", rotulo: "Atrasadas", aba: "tms", tom: "alerta" },
    { chave: "entregas_concluidas", rotulo: "Concluídas", aba: "tms", tom: "ok" },
    { chave: "ocorrencias_abertas", rotulo: "Ocorr. abertas", aba: "ocorrencias-avulsas", tom: "alerta" },
    { chave: "rotas_em_risco", rotulo: "Rotas em risco", aba: "tms", tom: "atencao" },
    { chave: "motoristas_sem_checklist", rotulo: "Sem checklist", aba: "entregas", tom: "atencao" },
    { chave: "saidas_atrasadas", rotulo: "Saídas atrasadas", aba: "entregas", tom: "atencao" },
    { chave: "viagens_hoje", rotulo: "Viagens hoje", aba: "tms", tom: "neutro" },
  ];

  function irPara(aba) {
    if (typeof window.irParaAba === "function") window.irParaAba(aba);
  }

  function render(dados) {
    const contInd = document.getElementById("paIndicadores");
    const contAlt = document.getElementById("paAlertas");
    const hora = document.getElementById("paAtualizado");
    if (!contInd || !contAlt) return;

    const ind = (dados && dados.indicadores) || {};
    const alertas = (dados && dados.alertas) || [];

    if (hora) {
      const d = dados && dados.atualizado_em ? new Date(dados.atualizado_em) : new Date();
      hora.textContent = "atualizado " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    }

    contInd.innerHTML = CARTOES.map((c) => {
      const valor = Number(ind[c.chave] || 0);
      // So "acende" quando ha algo relevante; zero fica neutro para evitar poluicao.
      let tom = "neutro";
      if (c.tom === "ok" && valor > 0) tom = "ok";
      else if ((c.tom === "alerta" || c.tom === "atencao") && valor > 0) tom = c.tom;
      return `<button type="button" class="pa-card pa-${tom}" onclick="painelAgoraIr('${c.aba}')" title="Ver ${esc(c.rotulo)}">
        <span class="pa-num">${valor}</span>
        <span class="pa-lbl">${esc(c.rotulo)}</span>
      </button>`;
    }).join("");

    if (!alertas.length) {
      contAlt.innerHTML = `<div class="pa-sem-alertas">✓ Nenhum alerta no momento.</div>`;
      return;
    }
    contAlt.innerHTML = alertas.map((a) => `
      <button type="button" class="pa-alerta pa-nivel-${esc(a.nivel)}" onclick="painelAgoraIr('${esc(a.aba)}')">
        <span class="pa-alerta-ic">${esc(a.icone || "•")}</span>
        <span class="pa-alerta-txt">
          <strong>${esc(a.titulo)}</strong>
          <small>${esc(a.detalhe || "")}</small>
        </span>
        <span class="pa-alerta-seta">›</span>
      </button>`).join("");
  }

  async function atualizar() {
    const contInd = document.getElementById("paIndicadores");
    if (!contInd || carregando) return;
    carregando = true;
    try {
      const resp = await fetch(`${window.location.origin}/painel/resumo`, { headers: { Accept: "application/json" } });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const dados = await resp.json();
      render(dados);
    } catch (err) {
      const contAlt = document.getElementById("paAlertas");
      if (contAlt) contAlt.innerHTML = `<div class="pa-sem-alertas">Não foi possível carregar o resumo agora.</div>`;
    } finally {
      carregando = false;
    }
  }

  // Navegacao a partir de um cartao/alerta.
  window.painelAgoraIr = function (aba) { irPara(aba); };
  // Exposto para outras partes atualizarem o painel se precisarem.
  window.painelAgoraAtualizar = atualizar;

  // Atualiza ao ENTRAR na aba Dashboard (encadeia sobre o irParaAba existente).
  const _orig = window.irParaAba;
  window.irParaAba = function (nome, ...rest) {
    if (typeof _orig === "function") _orig(nome, ...rest);
    if (nome === "dashboard") setTimeout(atualizar, 0);
  };

  // Poll leve: so busca quando a aba Dashboard esta visivel.
  setInterval(() => { if (dashboardVisivel()) atualizar(); }, REFRESH_MS);

  // Primeira carga: se o Dashboard ja estiver aberto ao carregar a pagina.
  document.addEventListener("DOMContentLoaded", () => {
    if (window.authReady && typeof window.authReady.then === "function") {
      window.authReady.then(() => { if (dashboardVisivel()) atualizar(); });
    } else if (dashboardVisivel()) {
      atualizar();
    }
  });
})();
