// ================================================================
// MODO MANUTENÇÃO — aviso para todos, controle para o super_adm
// ----------------------------------------------------------------
// Enquanto o rafael.mendes mexe no sistema, os demais veem uma faixa fixa no topo
// e param de conseguir gravar (o backend devolve 503 em POST/PUT/DELETE).
// LEITURA continua liberada de proposito: quem esta no meio do expediente ainda
// consegue consultar o que precisa, so nao grava por cima da manutencao.
//
// O super_adm ve a mesma faixa em ambar, com o botao de desligar — serve de
// lembrete, que e o jeito mais comum de isso dar errado: esquecer ligado.
// ================================================================
(function () {
  "use strict";

  let estado = { ativa: false };
  const CHECAGEM_MS = 30000;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

  async function consultar() {
    try {
      const r = await fetch("/manutencao", { credentials: "same-origin", cache: "no-store" });
      if (!r.ok) return;
      estado = await r.json();
      desenhar();
    } catch (_) { /* rede oscilando: mantem o que ja estava na tela */ }
  }

  function desenhar() {
    let faixa = document.getElementById("faixaManutencao");

    if (!estado.ativa) {
      if (faixa) faixa.remove();
      document.body.classList.remove("com-manutencao");
      return;
    }

    if (!faixa) {
      faixa = document.createElement("div");
      faixa.id = "faixaManutencao";
      document.body.prepend(faixa);
    }
    document.body.classList.add("com-manutencao");
    faixa.className = "manutencao-faixa" + (estado.sou_master ? " manutencao-faixa-master" : "");

    const desde = estado.desde
      ? new Date(estado.desde).toLocaleString("pt-BR", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })
      : "";

    faixa.innerHTML = estado.sou_master
      ? `<span class="manutencao-icone">🔧</span>
         <span><strong>Modo manutenção LIGADO por você.</strong>
           Os outros usuários não conseguem gravar${desde ? ` — desde ${esc(desde)}` : ""}.</span>
         <button type="button" class="manutencao-btn" onclick="manutencaoDesligar()">Desligar agora</button>`
      : `<span class="manutencao-icone">🔧</span>
         <span><strong>Sistema em manutenção.</strong>
           ${esc(estado.mensagem || "Consulta liberada; gravação temporariamente bloqueada.")}
           ${estado.previsao ? ` Previsão: ${esc(estado.previsao)}.` : ""}</span>`;
  }

  async function alternar(ativa, mensagem, previsao) {
    const r = await fetch("/manutencao", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ativa, mensagem: mensagem || "", previsao: previsao || "" }),
    });
    const dados = await r.json();
    if (!r.ok) throw new Error(dados.error || `HTTP ${r.status}`);
    await consultar();
    return dados;
  }

  window.manutencaoLigar = async function () {
    const mensagem = prompt(
      "Ligar modo manutenção.\n\n" +
      "Os outros usuários continuam CONSULTANDO, mas não conseguem gravar.\n" +
      "Você (master) segue trabalhando normalmente.\n\n" +
      "Mensagem para eles (opcional):",
      "Ajustes no sistema. Evite lançamentos por alguns minutos."
    );
    if (mensagem === null) return;
    const previsao = prompt("Previsão de retorno (opcional). Ex.: 15 min, 14h30:", "") || "";
    try {
      await alternar(true, mensagem, previsao);
      (window.alertar || alert)("Modo manutenção LIGADO.");
    } catch (e) {
      (window.alertar || alert)(`Nao foi possivel ligar: ${e.message}`);
    }
  };

  window.manutencaoDesligar = async function () {
    try {
      await alternar(false, "", "");
      (window.alertar || alert)("Modo manutenção desligado. Sistema liberado.");
    } catch (e) {
      (window.alertar || alert)(`Nao foi possivel desligar: ${e.message}`);
    }
  };

  // Instala o botao de ligar na aba de Usuarios (area do master).
  function instalarBotao() {
    const aba = document.getElementById("aba-usuarios");
    if (!aba || document.getElementById("btnManutencao") || !estado.sou_master) return;
    const cabecalho = aba.querySelector(".section-head");
    if (!cabecalho) return;
    const b = document.createElement("button");
    b.id = "btnManutencao";
    b.type = "button";
    b.className = "btn-ghost btn-sm";
    b.textContent = "🔧 Modo manutenção";
    b.title = "Bloqueia gravacao para os outros usuarios enquanto voce mexe no sistema";
    b.onclick = () => (estado.ativa ? window.manutencaoDesligar() : window.manutencaoLigar());
    cabecalho.appendChild(b);
  }

  window.manutencaoConsultar = consultar;

  async function iniciar() {
    await consultar();
    instalarBotao();
    setInterval(consultar, CHECAGEM_MS);
  }

  if (window.authReady && typeof window.authReady.then === "function") {
    window.authReady.then(iniciar);
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", iniciar);
  } else {
    iniciar();
  }

  // Encadeia no irParaAba para instalar o botao quando a aba de usuarios abrir.
  const _orig = window.irParaAba;
  window.irParaAba = function (nome, ...rest) {
    if (typeof _orig === "function") _orig(nome, ...rest);
    if (nome === "usuarios") setTimeout(instalarBotao, 0);
  };
})();
