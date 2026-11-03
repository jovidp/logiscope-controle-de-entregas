// @ts-check
// ================================================================
// EVENT BUS CENTRAL — "sistema vivo" (Fase 2 do roadmap de integração)
// ----------------------------------------------------------------
// Um pub/sub client-side (window.Bus) + o "wiring" de dados:mudou. Quando
// qualquer tela GRAVA algo (ocorrência, avulsa, viagem TMS, status, CTE…),
// ela chama window.dispararMudou('origem'); aqui, as telas VISÍVEIS se
// atualizam sozinhas — sem F5. Só refresca o que está à vista (barato) e
// junta rajadas de eventos num debounce.
//
// A fila "Resolver agora" e a aba CTEs já se auto-inscrevem no Bus (com a
// própria lógica), então o wiring central NÃO mexe nelas (evita refresh duplo).
// Carrega ANTES dos demais scripts para o Bus existir desde cedo; ainda assim,
// quem cria o Bus primeiro vence (idempotente).
// ================================================================
(function () {
  "use strict";

  // 1) Bus (idempotente: se alguém já criou, reaproveita).
  if (!window.Bus) {
    /** @type {Record<string, Array<(dados?: any) => void>>} */
    const ouvintes = {};
    window.Bus = {
      on(ev, fn) { (ouvintes[ev] = ouvintes[ev] || []).push(fn); return () => window.Bus.off(ev, fn); },
      off(ev, fn) { ouvintes[ev] = (ouvintes[ev] || []).filter((f) => f !== fn); },
      emit(ev, dados) {
        (ouvintes[ev] || []).forEach((fn) => { try { fn(dados); } catch (e) { console.error("[Bus]", ev, e); } });
      },
    };
  }

  // 2) Atalho para os emissores: window.dispararMudou('ocorrencia'|'tms'|'avulsa'|…)
  window.dispararMudou = function (origem, extra) {
    try { window.Bus.emit("dados:mudou", { origem: origem || "", ...(extra || {}) }); } catch (_) {}
  };

  // 3) Wiring central: ao receber dados:mudou, atualiza as telas visíveis (debounced).
  const visivel = (id) => {
    const el = document.getElementById(id);
    return el && !el.classList.contains("aba-hidden");
  };
  // O parametro e a UNIAO dos nomes que existem: window[fn] so compila se
  // 'fn' for um deles, entao um typo aqui para de ser descoberto em producao.
  // Para acrescentar uma tela, declare a funcao em globals.d.ts tambem.
  /** @param {"painelAgoraAtualizar"|"tmsAtualizar"|"carregarTorre"|"saidaFabCalcular"|"wmsCarregar"} fn */
  const chamar = (fn) => { try { if (typeof window[fn] === "function") window[fn](); } catch (e) { console.error("[Bus wiring]", fn, e); } };

  let t = null;
  window.Bus.on("dados:mudou", () => {
    clearTimeout(t);
    t = setTimeout(() => {
      // Cache compartilhado de ocorrências (várias telas dependem dele).
      try { if (typeof window.carregarHistorico === "function") window.carregarHistorico(true); } catch (_) {}
      // Só a tela à vista é refeita — leve.
      if (visivel("aba-dashboard")) chamar("painelAgoraAtualizar");
      if (visivel("aba-tms")) chamar("tmsAtualizar");
      if (visivel("aba-monitoramento")) chamar("carregarTorre");
      if (visivel("aba-saida-fabrica")) chamar("saidaFabCalcular");
      // Planilha do WMS: sem isto, dois conferentes na mesma lista ficam com
      // versoes divergentes e um sobrescreve o codigo digitado pelo outro.
      if (visivel("aba-wms")) chamar("wmsCarregar");
      // fila "Resolver agora" e aba CTEs tratam o evento por conta própria.
    }, 300);
  });

  // 4) Tempo real entre usuários (Fase 4): recebe "dados:mudou" empurrado pelo
  //    servidor (SSE em /eventos) e repassa ao Bus. Assim uma mudança feita por
  //    OUTRO usuário/PC atualiza a tela visível aqui, sem F5 e sem ação nenhuma.
  let sseConectado = false;
  function conectarSSE() {
    if (sseConectado || !window.authUsuario || !("EventSource" in window)) return;
    sseConectado = true;
    let es;
    try { es = new EventSource(`${window.location.origin}/eventos`); }
    catch (_) { sseConectado = false; return; }
    es.onmessage = (ev) => {
      let dados = {};
      try { dados = JSON.parse(ev.data); } catch (_) {}
      // Eventos do GPS (chegou/saiu de loja, chegando...) chegam a cada minuto:
      // vao por canal proprio, SEM o refresh geral de "dados:mudou" (que
      // recarregaria historico, TMS e torre em todas as telas abertas).
      if (dados.origem === "gps") { window.Bus.emit("gps:evento", dados); return; }
      // Repassa ao mesmo canal que o wiring local ja escuta.
      window.Bus.emit("dados:mudou", { ...dados, remoto: true });
    };
    // EventSource reconecta sozinho (respeitando o "retry" do servidor); nada a fazer.
    es.onerror = () => {};
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (window.authReady && typeof window.authReady.then === "function") {
      window.authReady.then(conectarSSE);
    } else {
      conectarSSE();
    }
    // Fallback: cobre login sem reload de pagina (conecta assim que autenticar).
    setInterval(conectarSSE, 4000);
  });
})();
