// Sugestao local de sequencia de paradas.
// Usa a matriz DESL_DISTANCIAS_KM ja carregada no sistema; nao envia enderecos
// para terceiros e nao altera a viagem ate o usuario confirmar.
(function () {
  "use strict";

  const VELOCIDADE_MEDIA_KMH = 35;
  const TEMPO_DESCARGA_MIN = 30;

  function minutos(v) {
    const m = String(v || "").match(/^(\d{1,2}):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  function distancia(origem, destino, rota) {
    if (origem === destino) return 0;
    if (typeof window._deslBuscarDistancia === "function") {
      const d = window._deslBuscarDistancia(origem, destino, rota);
      return d && Number.isFinite(Number(d.km)) ? Number(d.km) : null;
    }
    return null;
  }

  function lerParadas() {
    return [...document.querySelectorAll("#tmsParadasForm .tms-parada-form")].map((linha) => ({
      id: linha.dataset.paradaId ? Number(linha.dataset.paradaId) : null,
      loja_nome: linha.querySelector(".tms-p-loja")?.value || "",
      hora_prevista: linha.querySelector(".tms-p-hora")?.value || "",
      volumes_previstos: linha.querySelector(".tms-p-volumes")?.value || "",
      material_campanha: linha.querySelector(".tms-p-material")?.value || "",
      retirada_cx: linha.querySelector(".tms-p-retirada-cx")?.value || "",
      retirada_rt: linha.querySelector(".tms-p-retirada-rt")?.value || "",
      sacola_p: linha.querySelector(".tms-p-sacola-p")?.value || "",
      sacola_m: linha.querySelector(".tms-p-sacola-m")?.value || "",
      sacola_g: linha.querySelector(".tms-p-sacola-g")?.value || "",
      sacola: (Number(linha.querySelector(".tms-p-sacola-p")?.value) || 0) +
        (Number(linha.querySelector(".tms-p-sacola-m")?.value) || 0) +
        (Number(linha.querySelector(".tms-p-sacola-g")?.value) || 0),
      prioridade: Number(linha.querySelector(".tms-p-prioridade")?.value) || 2,
    }));
  }

  function avaliar(ordem, rota, saida) {
    let ponto = "FABRICA";
    let agora = minutos(saida) ?? 360;
    let score = 0;
    let kmTotal = 0;
    let semDistancia = 0;
    ordem.forEach((parada, indice) => {
      const km = distancia(ponto, parada.loja_nome, rota);
      const kmSeguro = km == null ? 250 : km;
      if (km == null) semDistancia += 1;
      const deslocamento = (kmSeguro / VELOCIDADE_MEDIA_KMH) * 60;
      const chegada = agora + deslocamento;
      const alvo = minutos(parada.hora_prevista);
      const atraso = alvo == null ? 0 : Math.max(0, chegada - alvo);
      const espera = alvo == null ? 0 : Math.max(0, alvo - chegada);
      // Alta/urgente tende a ficar no início; atraso pesa mais que espera.
      const penalidadePrioridade = (5 - Math.min(4, Math.max(1, parada.prioridade))) * (indice + 1) * 55;
      score += kmSeguro + atraso * 6 + espera * 0.35 + penalidadePrioridade;
      kmTotal += km || 0;
      agora = Math.max(chegada, alvo == null ? chegada : alvo) + TEMPO_DESCARGA_MIN;
      ponto = parada.loja_nome;
    });
    return { score, kmTotal, semDistancia, previsaoFinal: agora };
  }

  function permutar(lista) {
    if (lista.length <= 1) return [lista];
    const resultado = [];
    lista.forEach((item, indice) => {
      const resto = lista.slice(0, indice).concat(lista.slice(indice + 1));
      permutar(resto).forEach((cauda) => resultado.push([item, ...cauda]));
    });
    return resultado;
  }

  function sugerir(paradas, rota, saida) {
    if (paradas.length <= 8) {
      let melhor = null;
      permutar(paradas).forEach((ordem) => {
        const avaliacao = avaliar(ordem, rota, saida);
        if (!melhor || avaliacao.score < melhor.avaliacao.score) melhor = { ordem, avaliacao };
      });
      return melhor;
    }
    // Para rotas grandes, usa insercao gulosa: evita travar o navegador com
    // fatorial e ainda respeita prioridade, horario e distancia.
    const restantes = paradas.slice();
    const ordem = [];
    while (restantes.length) {
      let melhorIndice = 0;
      let melhorScore = Infinity;
      restantes.forEach((item, indice) => {
        const teste = avaliar([...ordem, item], rota, saida);
        if (teste.score < melhorScore) { melhorScore = teste.score; melhorIndice = indice; }
      });
      ordem.push(restantes.splice(melhorIndice, 1)[0]);
    }
    return { ordem, avaliacao: avaliar(ordem, rota, saida) };
  }

  function aplicar(ordem, avaliacao, original) {
    const container = document.getElementById("tmsParadasForm");
    if (!container || typeof window.tmsAdicionarParada !== "function") return;
    container.innerHTML = "";
    ordem.forEach((parada) => window.tmsAdicionarParada(parada));
    if (typeof window.tmsRecalcularTotais === "function") window.tmsRecalcularTotais();
    const reducao = original.length > 1 && ordem.map((p) => p.loja_nome).join("|") === original.map((p) => p.loja_nome).join("|")
      ? "A sequência já estava compatível com os critérios."
      : `Sequência reorganizada: ${ordem.map((p) => p.loja_nome).join(" → ")}.`;
    const aviso = avaliacao.semDistancia ? ` ${avaliacao.semDistancia} trecho(s) sem distância cadastrada foram estimados.` : "";
    if (typeof window.alertar === "function") window.alertar(`${reducao} Distância estimada: ${avaliacao.kmTotal.toFixed(1)} km.${aviso}`);
  }

  window.tmsOtimizarParadas = function () {
    const paradas = lerParadas();
    if (paradas.length < 2) {
      if (typeof window.alertar === "function") window.alertar("Adicione pelo menos duas lojas para otimizar a rota.");
      return;
    }
    if (paradas.some((p) => !p.loja_nome)) {
      if (typeof window.alertar === "function") window.alertar("Preencha todas as lojas antes de otimizar.");
      return;
    }
    const rota = document.getElementById("tmsViagemRota")?.value || "";
    const saida = document.getElementById("tmsViagemHoraSaida")?.value || "06:00";
    const resultado = sugerir(paradas, rota, saida);
    const confirmar = () => aplicar(resultado.ordem, resultado.avaliacao, paradas);
    const msg = `A melhor sequência encontrada começa em ${resultado.ordem[0].loja_nome} e percorre aproximadamente ${resultado.avaliacao.kmTotal.toFixed(1)} km. Aplicar agora?`;
    if (typeof window.confirmarSimples === "function") window.confirmarSimples(msg, confirmar);
    else if (window.confirm(msg)) confirmar();
  };
})();
