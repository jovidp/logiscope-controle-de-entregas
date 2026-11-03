// ================================================================
// ATUALIZAÇÃO AUTOMÁTICA DA PÁGINA
// ----------------------------------------------------------------
// O deploy e copia manual de arquivo, entao antes disso cada usuario so via a
// versao nova quando lembrava de dar F5 — podia passar dias na antiga.
//
// O servidor avisa por SSE quando o index.html muda (origem "versao"). Aqui a
// pagina se recarrega sozinha.
//
// A regra que manda: NUNCA recarregar por cima de quem esta digitando. Perder
// um lancamento pela metade e muito pior do que ficar 10 minutos na versao
// antiga. Se houver formulario com conteudo, o aviso vira uma barra discreta e
// quem decide a hora e o usuario.
// ================================================================
(function () {
  "use strict";

  let digitalAtual = null;
  let avisando = false;
  const RECHECAGEM_MS = 5 * 60 * 1000; // rede de seguranca se o SSE cair

  async function lerDigital() {
    try {
      const r = await fetch("/versao-front", { credentials: "same-origin", cache: "no-store" });
      if (!r.ok) return null;
      const d = await r.json();
      return d.digital || null;
    } catch (_) { return null; }
  }

  // Tem trabalho em andamento? Considera qualquer campo VISIVEL preenchido —
  // e melhor errar para o lado de nao recarregar.
  function usuarioDigitando() {
    const campos = document.querySelectorAll(
      "form input, form textarea, form select, .section-shell input, .section-shell textarea"
    );
    for (const c of campos) {
      if (c.offsetParent === null) continue;          // escondido: nao conta
      if (c.type === "hidden" || c.disabled || c.readOnly) continue;
      if (c.type === "checkbox" || c.type === "radio") { if (c.checked) return true; continue; }
      const v = String(c.value || "").trim();
      if (!v) continue;
      // Campo de data/hora costuma vir preenchido sozinho: nao e sinal de
      // trabalho em andamento.
      if ((c.type === "date" || c.type === "time") && !c.dataset.tocado) continue;
      return true;
    }
    // Modal aberto tambem conta como "no meio de alguma coisa".
    return Boolean(document.querySelector(".modal:not(.hidden), #tmsModalImportar:not(.hidden), #tmsModalImportarPedidos:not(.hidden)"));
  }

  function recarregar() {
    // replace() em vez de reload() para nao empilhar no historico.
    window.location.replace(window.location.pathname + window.location.search);
  }

  function mostrarBarra() {
    if (document.getElementById("barraAtualizacao")) return;
    const b = document.createElement("div");
    b.id = "barraAtualizacao";
    b.className = "atualizacao-barra";
    b.innerHTML =
      '<span>Uma versão nova do sistema foi publicada.</span>' +
      '<button type="button" class="atualizacao-btn" id="btnAtualizarAgora">Atualizar agora</button>' +
      '<button type="button" class="atualizacao-x" id="btnAtualizarDepois" title="Continuar nesta versão">✕</button>';
    document.body.appendChild(b);
    document.getElementById("btnAtualizarAgora").onclick = recarregar;
    document.getElementById("btnAtualizarDepois").onclick = () => { b.remove(); avisando = false; };
  }

  function versaoNova() {
    if (avisando) return;
    avisando = true;

    if (usuarioDigitando()) {
      mostrarBarra();   // quem decide a hora e o usuario
      return;
    }
    // Ninguem mexendo: recarrega sozinho, com uma folga curta para o caso de a
    // pessoa comecar a digitar exatamente agora. 1,5s e o suficiente para essa
    // guarda e mantem a atualizacao praticamente imediata.
    setTimeout(() => {
      if (usuarioDigitando()) { mostrarBarra(); return; }
      recarregar();
    }, 1500);
  }

  async function conferir() {
    const d = await lerDigital();
    if (!d) return;
    if (digitalAtual === null) { digitalAtual = d; return; }  // primeira leitura
    if (d !== digitalAtual) versaoNova();
  }

  async function iniciar() {
    digitalAtual = await lerDigital();

    // Caminho principal: o servidor empurra pelo SSE (event-bus.js repassa ao Bus).
    if (window.Bus && typeof window.Bus.on === "function") {
      window.Bus.on("dados:mudou", (dados) => {
        if (dados && dados.origem === "versao") {
          if (dados.digital && dados.digital === digitalAtual) return;
          versaoNova();
        }
      });
    }
    // Rede de seguranca: se o SSE cair (a rede daqui oscila), ainda confere.
    setInterval(conferir, RECHECAGEM_MS);
  }

  if (window.authReady && typeof window.authReady.then === "function") {
    window.authReady.then(iniciar);
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", iniciar);
  } else {
    iniciar();
  }

  // Marca campo de data/hora que o usuario realmente tocou (ver usuarioDigitando).
  document.addEventListener("input", (e) => {
    const t = e.target;
    if (t && (t.type === "date" || t.type === "time")) t.dataset.tocado = "1";
  }, true);
})();
