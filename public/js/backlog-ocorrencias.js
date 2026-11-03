// ================================================================
// BACKLOG DE OCORRÊNCIAS — o que está aberto, por quanto tempo
// ----------------------------------------------------------------
// Um KPI de "112 abertas" nao diz se sao de ontem ou de dois meses atras. Em
// 29/07/2026, 76 das 112 passavam de 30 dias (a mais velha com 68) e ninguem
// via: a fila "Resolver agora" ordenava pelas MAIS RECENTES e cortava em 40,
// entao o backlog antigo nunca aparecia.
//
// Esta tela mostra a distribuicao por idade, lista da mais velha para a mais
// nova e permite encerrar em lote — porque boa parte do acumulado ja foi
// resolvida na pratica e ninguem voltou para fechar. Encerrar exige motivo, que
// vai para a acao corretiva e para a auditoria.
// Consome GET /ocorrencias/backlog e PUT /ocorrencias/encerrar-lote.
// ================================================================
(function () {
  "use strict";

  let dados = null;
  const selecionados = new Set();
  let filtroFaixa = "todas";

  const el = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (m) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])
    );

  // Faixa de idade de um item. Mesmos cortes do resumo do backend.
  function faixaDe(dias) {
    if (dias <= 7) return "ate_7";
    if (dias <= 30) return "de_8_a_30";
    return "mais_30";
  }

  function corDaIdade(dias, prazo) {
    if (dias > 30) return "var(--vermelho)";
    if (dias > prazo) return "var(--amarelo)";
    return "var(--text-secondary)";
  }

  async function carregar() {
    const alvo = el("backlogConteudo");
    if (!alvo) return;
    alvo.innerHTML = '<div class="tms-meta">Carregando backlog...</div>';
    try {
      const r = await fetch("/ocorrencias/backlog", { credentials: "same-origin" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      dados = await r.json();
      selecionados.clear();
      render();
    } catch (e) {
      alvo.innerHTML = `<div class="tms-meta" style="color:var(--vermelho)">Nao foi possivel carregar: ${esc(e.message)}</div>`;
    }
  }

  function render() {
    const alvo = el("backlogConteudo");
    if (!alvo || !dados) return;
    const { resumo, itens, prazo_dias: prazo } = dados;

    const cartao = (rotulo, valor, cor, faixa) => `
      <button type="button" class="backlog-cartao${filtroFaixa === faixa ? " ativo" : ""}"
              onclick="backlogFiltrar('${faixa}')" style="border-color:${cor}33">
        <div class="backlog-cartao-num" style="color:${cor}">${valor}</div>
        <div class="backlog-cartao-rot">${rotulo}</div>
      </button>`;

    const visiveis = itens.filter((i) => filtroFaixa === "todas" || faixaDe(i.dias) === filtroFaixa);

    const linhas = visiveis.map((i) => `
      <tr>
        <td><input type="checkbox" class="backlog-check" value="${i.id}"
                   ${selecionados.has(i.id) ? "checked" : ""} onchange="backlogMarcar(${i.id}, this.checked)" /></td>
        <td>#${i.id}</td>
        <td>${esc(i.data)}</td>
        <td style="color:${corDaIdade(i.dias, prazo)};font-weight:700">${i.dias}d</td>
        <td>${esc(i.loja || "-")}</td>
        <td>${esc(i.rota || "-")}</td>
        <td>${esc(i.tipo || "sem tipo")}</td>
        <td>${i.responsavel ? esc(i.responsavel) : '<span style="color:var(--vermelho)">sem responsável</span>'}</td>
      </tr>`).join("");

    alvo.innerHTML = `
      <div class="backlog-cartoes">
        ${cartao("Todas as abertas", resumo.abertas, "var(--azul)", "todas")}
        ${cartao("Até 7 dias", resumo.ate_7, "var(--verde)", "ate_7")}
        ${cartao("8 a 30 dias", resumo.de_8_a_30, "var(--amarelo)", "de_8_a_30")}
        ${cartao("Mais de 30 dias", resumo.mais_30, "var(--vermelho)", "mais_30")}
      </div>
      <div class="tms-meta" style="margin:10px 0 14px">
        ${resumo.vencidas} passaram do prazo de ${prazo} dias ·
        ${resumo.sem_responsavel} sem responsável ·
        mais antiga há ${resumo.mais_antiga_dias} dias
      </div>

      <div class="backlog-acoes">
        <button type="button" class="btn-ghost btn-sm" onclick="backlogSelecionarVisiveis(true)">Selecionar visíveis</button>
        <button type="button" class="btn-ghost btn-sm" onclick="backlogSelecionarVisiveis(false)">Limpar seleção</button>
        <span class="tms-meta" id="backlogContador"></span>
        <button type="button" class="btn-green btn-sm admin-only-action" onclick="backlogEncerrar()">Encerrar selecionadas</button>
      </div>

      ${visiveis.length ? `
      <div style="overflow-x:auto">
        <table data-ordenavel class="backlog-tabela">
          <thead><tr>
            <th></th><th>#</th><th>Data</th><th>Idade</th><th>Loja</th><th>Rota</th><th>Tipo</th><th>Responsável</th>
          </tr></thead>
          <tbody>${linhas}</tbody>
        </table>
      </div>` : '<div class="tms-meta">Nenhuma ocorrência nesta faixa.</div>'}
    `;
    atualizarContador();
  }

  function atualizarContador() {
    const c = el("backlogContador");
    if (c) c.textContent = selecionados.size ? `${selecionados.size} selecionada(s)` : "";
  }

  window.backlogFiltrar = function (faixa) {
    filtroFaixa = faixa;
    render();
  };

  window.backlogMarcar = function (id, marcado) {
    marcado ? selecionados.add(id) : selecionados.delete(id);
    atualizarContador();
  };

  window.backlogSelecionarVisiveis = function (marcar) {
    if (!dados) return;
    dados.itens
      .filter((i) => filtroFaixa === "todas" || faixaDe(i.dias) === filtroFaixa)
      .forEach((i) => (marcar ? selecionados.add(i.id) : selecionados.delete(i.id)));
    render();
  };

  window.backlogEncerrar = async function () {
    if (!selecionados.size) {
      (window.alertar || alert)("Selecione ao menos uma ocorrência.");
      return;
    }
    const motivo = prompt(
      `Encerrar ${selecionados.size} ocorrência(s).\n\n` +
      "Motivo (fica na ação corretiva e na auditoria):"
    );
    if (motivo === null) return; // cancelou
    if (!motivo.trim()) {
      (window.alertar || alert)("Informe o motivo do encerramento.");
      return;
    }
    try {
      const r = await fetch("/ocorrencias/encerrar-lote", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selecionados], motivo: motivo.trim() }),
      });
      const resp = await r.json();
      if (!r.ok) throw new Error(resp.error || `HTTP ${r.status}`);
      const extra = resp.ignoradas ? ` (${resp.ignoradas} já não estavam abertas)` : "";
      (window.alertar || alert)(`${resp.encerradas} ocorrência(s) encerrada(s)${extra}.`);
      if (typeof window.dispararMudou === "function") window.dispararMudou("ocorrencia");
      await carregar();
    } catch (e) {
      (window.alertar || alert)(`Nao foi possivel encerrar: ${e.message}`);
    }
  };

  window.backlogCarregar = carregar;

  // Recarrega quando outro modulo grava algo (mesmo barramento da fila).
  if (window.Bus && typeof window.Bus.on === "function") {
    window.Bus.on("dados:mudou", () => {
      if (dashboardVisivel()) carregar();
    });
  }

  // --- Inicializacao: mesmo padrao da fila-resolver ---
  function dashboardVisivel() {
    const aba = el("aba-dashboard");
    return Boolean(aba) && !aba.classList.contains("aba-hidden");
  }

  // Carrega ao ENTRAR no Dashboard, encadeando sobre o irParaAba existente.
  const _orig = window.irParaAba;
  window.irParaAba = function (nome, ...rest) {
    if (typeof _orig === "function") _orig(nome, ...rest);
    if (nome === "dashboard") setTimeout(carregar, 0);
  };

  // Primeira carga se o Dashboard ja estiver aberto ao abrir a pagina. Espera o
  // authReady: sem sessao, /ocorrencias/backlog responde 401.
  document.addEventListener("DOMContentLoaded", () => {
    if (window.authReady && typeof window.authReady.then === "function") {
      window.authReady.then(() => { if (dashboardVisivel()) carregar(); });
    } else if (dashboardVisivel()) {
      carregar();
    }
  });
})();
