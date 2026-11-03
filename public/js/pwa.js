(function iniciarPwa() {
  if (!("serviceWorker" in navigator)) return;

  let eventoInstalacao = null;

  function atualizarConexao() {
    document.body.classList.toggle("app-offline", !navigator.onLine);
    let aviso = document.getElementById("pwaOfflineAviso");
    if (!navigator.onLine && !aviso) {
      aviso = document.createElement("div");
      aviso.id = "pwaOfflineAviso";
      aviso.className = "pwa-offline-aviso";
      aviso.setAttribute("role", "status");
      aviso.textContent = "Sem conexao. Os dados nao serao atualizados.";
      document.body.prepend(aviso);
    } else if (navigator.onLine) {
      aviso?.remove();
    }
  }

  function prepararBotaoInstalar() {
    const acoes = document.querySelector(".app-header-actions");
    if (!acoes || document.getElementById("pwaInstalarBtn")) return;

    const botao = document.createElement("button");
    botao.id = "pwaInstalarBtn";
    botao.type = "button";
    botao.className = "btn-blue btn-sm pwa-install-button";
    botao.textContent = "Instalar app";
    botao.addEventListener("click", async () => {
      if (!eventoInstalacao) return;
      eventoInstalacao.prompt();
      await eventoInstalacao.userChoice;
      eventoInstalacao = null;
      botao.remove();
    });
    acoes.prepend(botao);
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    eventoInstalacao = event;
    prepararBotaoInstalar();
  });
  window.addEventListener("appinstalled", () => {
    eventoInstalacao = null;
    document.getElementById("pwaInstalarBtn")?.remove();
  });
  window.addEventListener("online", atualizarConexao);
  window.addEventListener("offline", atualizarConexao);

  document.addEventListener("DOMContentLoaded", atualizarConexao, { once: true });
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js"), { once: true });
})();
