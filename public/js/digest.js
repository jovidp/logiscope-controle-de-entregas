// ================================================================
// RESUMO DO PERIODO — traz o digest para dentro do sistema.
// ----------------------------------------------------------------
// O servidor ja montava este resumo (montarDigestTexto em back/server.js) para
// mandar por um canal externo, mas nenhuma tela consumia GET /painel/digest:
// o dado existia e ninguem via. Este modulo desenha o resumo no Dashboard.
//
// Nao confundir com o painel "Agora" (painel-agora.js), que é do DIA corrente:
// aqui a leitura é de PERIODO (qualidade 30d, pontualidade 7d, pior loja), ou
// seja, saude da operacao ao longo do tempo. Por isso fica logo abaixo dele.
//
// A secao se auto-injeta em vez de morar no index.html: as duas copias do
// index (dev e producao) estao divergentes, entao quanto menos HTML precisar
// ser replicado a mao, menor a chance de uma delas ficar para tras.
// Reusa as classes .painel-agora/.pa-head para nao mexer no style.css.
// ================================================================
(function () {
  "use strict";

  // O digest resume dias/semanas: revalidar a cada entrada na aba seria gasto
  // sem ganho. Uma leitura por janela de 5 min ja acompanha qualquer mudanca.
  const VALIDADE_MS = 5 * 60 * 1000;
  let buscadoEm = 0;
  let carregando = false;

  function esc(v) {
    return escapar(v);
  }

  function dashboardVisivel() {
    const aba = document.getElementById("aba-dashboard");
    return aba && !aba.classList.contains("aba-hidden");
  }

  // Cria a secao uma unica vez, logo apos o painel "Agora".
  function garantirSecao() {
    let sec = document.getElementById("digestPeriodo");
    if (sec) return sec;
    const ancora = document.getElementById("painel-agora");
    if (!ancora || !ancora.parentNode) return null;

    sec = document.createElement("section");
    sec.id = "digestPeriodo";
    sec.className = "painel-agora";
    sec.hidden = true; // so aparece quando ha conteudo de verdade
    sec.innerHTML = `
      <div class="pa-head">
        <h3>📈 Resumo do período</h3>
        <span class="pa-hora">
          <span id="digestAtualizado"></span>
          <button type="button" id="digestRefresh" title="Atualizar resumo"
            style="background:none;border:none;color:inherit;cursor:pointer;font-size:1rem;line-height:1;padding:0 0 0 6px;">↻</button>
        </span>
      </div>
      <div id="digestCorpo"></div>`;
    ancora.parentNode.insertBefore(sec, ancora.nextSibling);
    sec.querySelector("#digestRefresh").addEventListener("click", () => atualizar(true));
    return sec;
  }

  // O texto vem pronto do servidor, em linhas:
  //   "• Pontualidade (7d): 92% no prazo"   -> item principal
  //   "  pior loja: MEIER (18% atraso)"     -> detalhe do item acima (indentado)
  // A primeira linha é o titulo do envio externo e o cabecalho daqui ja cumpre
  // esse papel, entao ela é descartada.
  function render(texto) {
    const corpo = document.getElementById("digestCorpo");
    const sec = document.getElementById("digestPeriodo");
    if (!corpo || !sec) return;

    const linhas = String(texto || "")
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("📊"));

    if (!linhas.length) {
      sec.hidden = true;
      return;
    }

    corpo.innerHTML = linhas
      .map((l) => {
        const detalhe = /^\s{2,}/.test(l);
        const txt = esc(l.replace(/^[\s•]+/, ""));
        return detalhe
          ? `<div style="font-size:.75rem;color:var(--text-muted);margin:0 0 6px 14px;">${txt}</div>`
          : `<div style="font-size:.85rem;color:var(--text-body,var(--text-heading));margin:0 0 2px;">• ${txt}</div>`;
      })
      .join("");
    sec.hidden = false;
  }

  async function atualizar(forcar) {
    if (carregando) return;
    if (!forcar && Date.now() - buscadoEm < VALIDADE_MS) return;
    if (!garantirSecao()) return;
    carregando = true;
    try {
      const resp = await fetch(`${window.location.origin}/painel/digest`, {
        headers: { Accept: "application/json" },
      });
      // 401/403: perfil sem acesso ao painel. Some com a secao em vez de expor
      // um erro que o usuario nao pode resolver.
      if (!resp.ok) {
        const sec = document.getElementById("digestPeriodo");
        if (sec) sec.hidden = true;
        return;
      }
      const dados = await resp.json();
      render(dados && dados.texto);
      buscadoEm = Date.now();
      const rot = document.getElementById("digestAtualizado");
      if (rot) {
        rot.textContent =
          "atualizado " +
          new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      }
    } catch (err) {
      const sec = document.getElementById("digestPeriodo");
      if (sec) sec.hidden = true;
    } finally {
      carregando = false;
    }
  }

  window.digestAtualizar = atualizar;

  // Carrega ao ENTRAR no Dashboard, encadeando sobre o irParaAba existente
  // (mesmo padrao do painel-agora.js; os dois wrappers convivem).
  const _orig = window.irParaAba;
  window.irParaAba = function (nome, ...rest) {
    if (typeof _orig === "function") _orig(nome, ...rest);
    if (nome === "dashboard") setTimeout(() => atualizar(false), 0);
  };

  document.addEventListener("DOMContentLoaded", () => {
    if (window.authReady && typeof window.authReady.then === "function") {
      window.authReady.then(() => { if (dashboardVisivel()) atualizar(false); });
    } else if (dashboardVisivel()) {
      atualizar(false);
    }
  });
})();
