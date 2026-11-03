// ============================================================================
// SERVICE WORKER — deliberadamente minimo
// ----------------------------------------------------------------------------
// Versoes anteriores cacheavam CSS e JS com network-first e fallback para o
// cache. Offline isso ajuda; aqui virou armadilha: a producao roda de um file
// server que oscila (124 falhas de escrita so em 30/07/2026). Num blip o fetch
// morre, o cache antigo responde, e o navegador fica preso numa versao velha —
// a tela abre com o layout antigo enquanto o servidor ja entrega o novo, e
// NADA no servidor acusa problema. Isso custou varias horas de diagnostico:
// eu media o servidor (sempre certo) e o usuario via o cache (sempre velho).
//
// Agora o SW NAO intercepta CSS, JS nem HTML. Esses arquivos ja tem "?v=N" no
// index e o proprio navegador cuida deles com ETag/max-age=0. Fica so a pagina
// offline e as imagens, que sao grandes, mudam pouco e nao carregam logica.
//
// Se um dia voltar a cachear script/style: bumpe CACHE_NAME a CADA deploy de
// front, senao o problema acima volta silenciosamente.
// ============================================================================

const CACHE_NAME = "controle-entrega-shell-v5";
const APP_SHELL = ["/offline.html", "/img/icon-192.png", "/img/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      // Limpa tambem o que ficou preso DENTRO do cache atual (CSS/JS de antes
      // desta mudanca): sem isso, quem ja tinha o SW antigo seguiria vendo a
      // tela velha mesmo depois do deploy.
      .then(() => caches.open(CACHE_NAME))
      .then((cache) =>
        cache.keys().then((reqs) =>
          Promise.all(
            reqs
              .filter((r) => /\.(css|js|html)(\?|$)/i.test(new URL(r.url).pathname + new URL(r.url).search))
              .map((r) => cache.delete(r))
          )
        )
      )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navegacao: sempre da rede. So cai no offline.html se realmente nao houver
  // conexao — nunca serve HTML velho de cache.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/offline.html")));
    return;
  }

  // CSS/JS/fonte: NAO intercepta. Deixa passar direto para a rede, para o
  // deploy chegar no navegador sem intermediario.
  if (["style", "script", "font", "document"].includes(request.destination)) return;

  // Imagem: cache-first, que e onde o cache realmente compensa.
  if (request.destination === "image") {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((resp) => {
          if (resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then((c) => c.put(request, copy));
          }
          return resp;
        });
      })
    );
  }
});
