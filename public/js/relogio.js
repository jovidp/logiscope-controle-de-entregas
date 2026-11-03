// ================================================================
// RELÓGIO DO CABEÇALHO
// ----------------------------------------------------------------
// Hora do SERVIDOR, nao do computador de quem acessa. Num sistema onde o
// horario decide as coisas — saida da fabrica, prazo de entrega, atraso, backup
// das 16:00 — duas maquinas com relogio diferente viram discussao sobre quem
// atrasou. O /health devolve a hora do servidor; o relogio sincroniza com ela e
// mostra a diferenca quando o computador local esta fora de hora.
//
// Se o /health nao responder ou nao trouxer hora, cai na hora local e avisa
// discretamente no title — melhor um relogio honesto do que um errado calado.
// ================================================================
(function () {
  "use strict";

  const DIAS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
  const RESSINC_MS = 5 * 60 * 1000; // reconfere o desvio a cada 5 min

  // Diferenca entre o relogio do servidor e o desta maquina, em ms.
  let desvio = 0;
  let sincronizado = false;

  const dois = (n) => String(n).padStart(2, "0");

  // Ida e volta acima disso torna a medicao inutil: a correcao de latencia
  // (metade do tempo) passa a ser maior que a precisao do proprio cabecalho
  // Date, que so tem segundos. A rede daqui oscila muito — um fetch que ficou
  // pendurado minutos chegava a jogar o relogio MINUTOS para tras, que foi o
  // que apareceu na tela: relogio ambar marcando 6 min a menos.
  const IDA_VOLTA_MAX_MS = 2000;

  async function sincronizar() {
    try {
      const t0 = Date.now();
      const r = await fetch("/health", { credentials: "same-origin", cache: "no-store" });
      if (!r.ok) throw new Error("health " + r.status);

      const idaVolta = Date.now() - t0;
      if (idaVolta > IDA_VOLTA_MAX_MS) {
        // Resposta lenta demais para servir de referencia. Mantem o desvio
        // anterior (que veio de uma medicao boa) em vez de estragar o relogio.
        return;
      }

      // Data do cabecalho HTTP: existe em qualquer resposta e nao depende do
      // corpo do /health ter um campo de hora.
      const cabecalho = r.headers.get("date");
      if (!cabecalho) throw new Error("sem cabecalho Date");

      const doServidor = new Date(cabecalho).getTime() + idaVolta / 2;
      if (!Number.isFinite(doServidor)) throw new Error("data invalida");

      const novoDesvio = doServidor - Date.now();
      // Sanidade: mais de 12h de diferenca e fuso mal configurado ou data
      // absurda, nao relogio atrasado. Melhor mostrar a hora local.
      if (Math.abs(novoDesvio) > 12 * 3600 * 1000) throw new Error("desvio absurdo");

      desvio = novoDesvio;
      sincronizado = true;
    } catch (_) {
      desvio = 0;
      sincronizado = false;
    }
    desenhar();
  }

  function agora() {
    return new Date(Date.now() + desvio);
  }

  function desenhar() {
    const el = document.getElementById("relogioCabecalho");
    if (!el) return;

    const d = agora();
    const hora = `${dois(d.getHours())}:${dois(d.getMinutes())}:${dois(d.getSeconds())}`;
    const data = `${DIAS[d.getDay()]} ${dois(d.getDate())}/${dois(d.getMonth() + 1)}`;

    el.querySelector(".relogio-hora").textContent = hora;
    el.querySelector(".relogio-data").textContent = data;
    // Em tela estreita o CSS esconde a data; guarda no dataset para o title
    // continuar mostrando o dia (ver o final desta funcao).
    el.dataset.data = data;

    // Só chama atencao quando o relogio local esta MESMO fora (mais de 1 min).
    const fora = sincronizado && Math.abs(desvio) > 60000;
    el.classList.toggle("relogio-fora", fora);
    const base = !sincronizado
      ? "Hora deste computador (nao foi possivel falar com o servidor)"
      : fora
        ? `Hora do servidor. Este computador esta ${desvio > 0 ? "atrasado" : "adiantado"} ` +
          `em ${Math.round(Math.abs(desvio) / 60000)} min.`
        : "Hora do servidor";
    el.title = `${data} — ${base}`;
  }

  function instalar() {
    const destino = document.querySelector(".app-header-actions");
    if (!destino || document.getElementById("relogioCabecalho")) return;

    const el = document.createElement("div");
    el.id = "relogioCabecalho";
    el.className = "relogio";
    el.innerHTML =
      '<span class="relogio-hora">--:--:--</span>' +
      '<span class="relogio-data"></span>';
    destino.prepend(el);

    desenhar();
    // Alinha o tique com a virada do segundo, para o numero nao "pular" 2s.
    setTimeout(() => {
      desenhar();
      setInterval(desenhar, 1000);
    }, 1000 - (agora().getMilliseconds() || 0));

    sincronizar();
    setInterval(sincronizar, RESSINC_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", instalar);
  } else {
    instalar();
  }

  // O cabecalho so aparece depois do login; reinstala quando a sessao abre.
  if (window.authReady && typeof window.authReady.then === "function") {
    window.authReady.then(() => setTimeout(instalar, 0));
  }
})();
