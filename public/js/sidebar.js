// Sidebar: abrir/fechar e estado inicial por largura de tela.
// Extraido de public/html/index.html.
// toggleSidebar/fecharSidebar sao globais de proposito: sao chamadas por
// atributos onclick no HTML e por tutorial.js (window.fecharSidebar).
// Nao envolver em IIFE nem converter para modulo.

function toggleSidebar() {
  document.body.classList.toggle("sidebar-aberto");
}
function fecharSidebar() {
  document.body.classList.remove("sidebar-aberto");
}
// Estado inicial: aberto no desktop, fechado no mobile
(function () {
  if (window.innerWidth > 1024) {
    document.body.classList.add("sidebar-aberto");
  }
  // No mobile, fecha o menu ao escolher uma aba
  document.querySelectorAll(".sidebar-nav .nav-tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      if (window.innerWidth <= 1024) fecharSidebar();
    });
  });
})();
