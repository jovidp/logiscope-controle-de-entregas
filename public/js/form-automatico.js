// ================================================================
// FORMULÁRIO DE OCORRÊNCIA — PREENCHIMENTO AUTOMÁTICO
// ----------------------------------------------------------------
// Só front. Três coisas:
//
// 1. Botão "⏱ agora" nos horários MANUAIS (início/fim da descarga e
//    chegada do responsável): um clique grava a hora atual. Só aparece
//    quando a data do registro é hoje (ou é o 2º dia de uma viagem com
//    pernoite). Horário do rastreador, Saída GPS e Saída da fábrica vêm
//    do GPS (completarDoGps) — pedido de 05/10/2026.
//
// 2. Aberto pelo TMS, completa o que o TMS já sabe, SÓ em campo vazio
//    (nunca passa por cima do rascunho nem do que veio da tela de saída
//    da fábrica):
//      Agendado com a Loja <- hora prevista da parada; sem ela, a meta
//                             da loja (metas_loja), salvo loja "sem horário"
//      Saída Marcada       <- saída prevista da viagem
//      Saída Real Fábrica  <- botão "Saiu" do TMS (ou saída do hotel,
//                             quando marcado o pernoite)
//    Medido em 05/10/2026: dos 259 registros de 30 dias (todos via TMS),
//    17 ficaram sem agendado tendo meta e 30 sem saída marcada tendo a
//    prevista na viagem.
//
// 4. Antes de salvar um registro NOVO, confere no servidor se já existe
//    registro da mesma parada do TMS ou da mesma loja na mesma data e
//    pergunta antes de gravar outro (não bloqueia: missão extra existe).
// ================================================================
(function () {
  "use strict";

  const $id = (id) => document.getElementById(id);
  const hhmm = (v) => String(v || "").slice(0, 5);
  const hojeISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const ontemISO = () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function setHora(id, valor, origem) {
    const el = $id(id);
    if (!el || !valor) return false;
    el.value = hhmm(valor);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (origem) {
      el.title = `Preenchido automaticamente: ${origem}`;
      el.classList.add("fa-auto");
      setTimeout(() => el.classList.remove("fa-auto"), 2500);
    }
    return true;
  }

  // ---------------------------------------------------------------
  // 1. Botão "agora"
  // ---------------------------------------------------------------
  // Só nos campos MANUAIS. Chegada na loja (Horário do rastreador), Saída GPS
  // e Saída da fábrica vêm do GPS (completarDoGps, abaixo) — pedido de 05/10.
  const CAMPOS_AGORA = ["inicioDescarga", "terminoDescarga", "horaRecebedor"];

  function podeAgora() {
    const data = $id("dataOcorrencia")?.value || "";
    if (!data || data === hojeISO()) return true;
    return !!$id("diaSeguinte")?.checked && data === ontemISO();
  }

  function montarBotoesAgora() {
    CAMPOS_AGORA.forEach((id) => {
      const campo = $id(id);
      if (!campo || campo.dataset.faAgora) return;
      campo.dataset.faAgora = "1";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "fa-agora";
      btn.dataset.faAgoraPara = id;
      btn.tabIndex = -1; // não entra no Tab nem no pulo automático
      btn.title = "Preencher com a hora atual";
      btn.textContent = "⏱ agora";
      campo.insertAdjacentElement("afterend", btn);
    });
    atualizarBotoesAgora();
  }

  function atualizarBotoesAgora() {
    const mostrar = podeAgora();
    document.querySelectorAll("#form .fa-agora").forEach((b) => (b.style.display = mostrar ? "" : "none"));
  }

  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".fa-agora");
    if (!btn) return;
    e.preventDefault();
    const d = new Date();
    setHora(btn.dataset.faAgoraPara, `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`);
  });

  // ---------------------------------------------------------------
  // 2. Completa com o que o TMS já sabe
  // ---------------------------------------------------------------
  // ---------------------------------------------------------------
  // GPS: Horário do rastreador / Saída GPS / Saída da fábrica
  // ---------------------------------------------------------------
  // Eventos do back/rastreador-ao-vivo.js (via gps-eventos.js). Só campo
  // vazio, só registro NOVO. Loja: pela parada do TMS quando houver; senão
  // pelo nome (BANGU_I = "BANGU I"; "SANTA CRUZ I / SANTA CRUZ II" casa com
  // as duas, porque o GPS não separa lojas coladas).
  const normNome = (s) =>
    String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const horaLocal = (iso) =>
    new Date(iso).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
  const somarDia = (iso, dias) => {
    const d = new Date(`${iso}T12:00:00`);
    d.setDate(d.getDate() + dias);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  let consultaGps = 0;
  async function completarDoGps() {
    const consulta = ++consultaGps;
    if (typeof window.gpsEventosDoDia !== "function") return;
    if (typeof editandoIndex !== "undefined" && editandoIndex !== null && editandoIndex !== undefined) return;
    const placa = $id("placa")?.value || "";
    const data = $id("dataOcorrencia")?.value || "";
    const loja = $id("loja")?.value || "";
    const viagemId = window.tmsOcorrenciaContexto?.viagem_id ?? null;
    const paradaId = window.tmsOcorrenciaContexto?.parada_id ?? null;
    if (!placa || !data) return;
    const diaSeguinte = !!$id("diaSeguinte")?.checked;
    const eventos = await window.gpsEventosDoDia(placa, diaSeguinte ? somarDia(data, 1) : data);
    if (consulta !== consultaGps || !eventos.length || ($id("placa")?.value || "") !== placa
      || ($id("loja")?.value || "") !== loja || ($id("dataOcorrencia")?.value || "") !== data
      || !!$id("diaSeguinte")?.checked !== diaSeguinte
      || (window.tmsOcorrenciaContexto?.viagem_id ?? null) !== viagemId
      || (window.tmsOcorrenciaContexto?.parada_id ?? null) !== paradaId
      || (typeof editandoIndex !== "undefined" && editandoIndex != null)) return;
    const ordem = eventos.filter(e => viagemId == null || e.viagem_id == null || Number(e.viagem_id) === Number(viagemId))
      .sort((a, b) => new Date(a.em) - new Date(b.em));
    const vazio = (id) => $id(id) && !$id(id).value;

    const alvo = normNome(loja);
    const daLoja = (e) => paradaId != null && e.parada_id != null
      ? Number(e.parada_id) === Number(paradaId)
      : alvo && normNome(e.lugar_nome) === alvo && !/GPS não separa/.test(e.detalhe || "");
    const chegou = ordem.find((e) => e.tipo === "chegou_loja" && daLoja(e));
    if (vazio("horaSaidaFabrica") && !diaSeguinte) {
      const viagem = typeof tmsState !== "undefined" ? (tmsState.viagens || []).find(v => Number(v.id) === Number(viagemId)) : null;
      if (viagem?.saida_real) setHora("horaSaidaFabrica", viagem.saida_real, "saída real da viagem no TMS");
      else {
        const primeiraLoja = ordem.find(e => e.tipo === "chegou_loja");
        const saidas = ordem.filter(e => e.tipo === "saiu_fabrica" && (!primeiraLoja || new Date(e.em) < new Date(primeiraLoja.em)));
        const saiu = saidas[saidas.length-1];
        if (saiu) setHora("horaSaidaFabrica", horaLocal(saiu.em), "rastreador (GPS) — saiu da fábrica");
      }
    }
    if (chegou && vazio("hora_chegada")) setHora("hora_chegada", horaLocal(chegou.em), "rastreador (GPS) — chegou na loja");
    if (vazio("saidaLoja")) {
      const horaChegada = $id("hora_chegada")?.value;
      const limite = horaChegada ? new Date(`${diaSeguinte ? somarDia(data, 1) : data}T${hhmm(horaChegada)}:00-03:00`) : chegou ? new Date(chegou.em) : null;
      const saidas = ordem.filter(e => e.tipo === "saiu_loja" && daLoja(e) && (!limite || new Date(e.em) >= limite));
      const saiu = saidas[saidas.length-1];
      if (saiu) setHora("saidaLoja", horaLocal(saiu.em), "rastreador (GPS) — saiu da loja");
    }
  }

  let _timerGps = null;
  const agendarGps = (ms = 600) => {
    clearTimeout(_timerGps);
    _timerGps = setTimeout(() => completarDoGps().catch(() => {}), ms);
  };

  async function completarDoTms(viagemId, paradaId) {
    if (typeof tmsState === "undefined") return;
    const ctx = window.tmsOcorrenciaContexto;
    if (!ctx || ctx.parada_id !== paradaId) return; // usuário já trocou de parada
    const viagem = (tmsState.viagens || []).find((v) => v.id === viagemId);
    const parada = viagem?.paradas?.find((p) => p.id === paradaId);
    if (!viagem || !parada) return;
    const lojaInicial = $id("loja")?.value || "";
    const dataInicial = $id("dataOcorrencia")?.value || "";

    // GPS primeiro: a saída da fábrica pelo rastreador vale mais que o botão.
    try { await completarDoGps(); } catch (_) {}
    if (window.tmsOcorrenciaContexto?.parada_id !== paradaId
      || window.tmsOcorrenciaContexto?.viagem_id !== viagemId
      || ($id("loja")?.value || "") !== lojaInicial || ($id("dataOcorrencia")?.value || "") !== dataInicial) return;

    const vazio = (id) => $id(id) && !$id(id).value;
    const loja = $id("loja")?.value || "";

    if (vazio("horaAgendadaLoja")) {
      const semHorario = typeof window.lojaSemHorario === "function" && window.lojaSemHorario(loja);
      if (parada.hora_prevista) setHora("horaAgendadaLoja", parada.hora_prevista, "hora prevista da parada no TMS");
      else if (!semHorario && typeof window.metaHorarioLoja === "function")
        setHora("horaAgendadaLoja", window.metaHorarioLoja(loja), "horário-meta da loja");
    }
    if (vazio("horaMarcadaSaida")) setHora("horaMarcadaSaida", viagem.hora_saida_fabrica, "saída prevista da viagem no TMS");
    if (vazio("horaSaidaFabrica")) {
      if ($id("diaSeguinte")?.checked) setHora("horaSaidaFabrica", viagem.hotel_saida, "saída do hotel no TMS");
      else setHora("horaSaidaFabrica", viagem.saida_real, "botão Saiu do TMS");
    }
    atualizarBotoesAgora();
  }

  function embrulharAberturaTms() {
    if (typeof window.tmsAbrirOcorrencia !== "function" || window.tmsAbrirOcorrencia._fa) return;
    const original = window.tmsAbrirOcorrencia;
    const embrulhada = function (viagemId, paradaId) {
      const r = original.apply(this, arguments);
      // O TMS preenche em ~100ms, a saída da fábrica em ~300ms e o rascunho
      // em ~450ms: completa depois de todos, só o que ficou vazio.
      setTimeout(() => completarDoTms(viagemId, paradaId), 800);
      return r;
    };
    embrulhada._fa = true;
    window.tmsAbrirOcorrencia = embrulhada;
  }

  // ---------------------------------------------------------------
  // 4. Aviso de registro duplicado
  // ---------------------------------------------------------------
  const normLoja = (s) => String(s || "").trim().toUpperCase().replace(/\s+/g, " ");

  async function buscarDuplicados() {
    const loja = normLoja($id("loja")?.value);
    const data = $id("dataOcorrencia")?.value || "";
    const paradaId = window.tmsOcorrenciaContexto?.parada_id ?? null;
    if (!loja || !data) return [];
    const base = typeof API_URL !== "undefined" && API_URL ? API_URL : window.location.origin;
    const resp = await fetch(`${base}/ocorrencias?limite=300&_=${Date.now()}`, { cache: "no-store" });
    if (!resp.ok) return [];
    const lista = await resp.json();
    return (Array.isArray(lista) ? lista : []).filter(
      (o) =>
        (paradaId != null && o.parada_id != null && Number(o.parada_id) === Number(paradaId)) ||
        (normLoja(o.loja) === loja && String(o.data_ocorrencia || "").slice(0, 10) === data),
    );
  }

  function embrulharSalvar() {
    if (typeof window.salvar !== "function" || window.salvar._fa) return;
    const original = window.salvar;
    // Trava de clique repetido: em 17/09/2026 São Gonçalo II ganhou 9
    // registros idênticos (ids seguidos) e Niterói IV 4 — o Salvar não tinha
    // trava. Enquanto um salvamento (conferência + gravação) está em curso,
    // os cliques seguintes são ignorados.
    let ocupado = false;
    const embrulhada = async function () {
      if (ocupado) return;
      ocupado = true;
      try {
        return await conferirESalvar.apply(this, arguments);
      } finally {
        ocupado = false;
      }
    };
    const conferirESalvar = async function () {
      const editando = typeof editandoIndex !== "undefined" && editandoIndex !== null && editandoIndex !== undefined;
      if (!editando) {
        try {
          const dup = await buscarDuplicados();
          if (dup.length) {
            const linhas = dup
              .slice(0, 3)
              .map(
                (o) =>
                  `• #${o.id} — ${o.motorista || "sem motorista"}` +
                  (o.hora_chegada ? `, chegada ${hhmm(o.hora_chegada)}` : "") +
                  (o.teve_ocorrencia ? " (com ocorrência)" : ""),
              )
              .join("\n");
            const msg =
              `⚠️ Já existe ${dup.length > 1 ? dup.length + " registros" : "registro"} desta ` +
              `${window.tmsOcorrenciaContexto?.parada_id != null ? "parada / " : ""}loja nesta data:\n\n${linhas}\n\n` +
              "Se for a mesma entrega, volte e edite o registro pelo histórico.\nSalvar outro mesmo assim?";
            const ok =
              typeof confirmarBonito === "function"
                ? await confirmarBonito(msg, { okLabel: "Salvar outro", cancelLabel: "Voltar" })
                : window.confirm(msg);
            if (!ok) return;
          }
        } catch (err) {
          console.warn("[form-automatico] checagem de duplicado falhou:", err); // não impede salvar
        }
      }
      return original.apply(this, arguments);
    };
    embrulhada._fa = true;
    window.salvar = embrulhada;
  }

  // ---------------------------------------------------------------
  function iniciar() {
    if (!$id("form")) return;
    montarBotoesAgora();
    embrulharAberturaTms();
    embrulharSalvar();
    ["dataOcorrencia", "diaSeguinte"].forEach((id) => {
      $id(id)?.addEventListener("change", atualizarBotoesAgora);
      $id(id)?.addEventListener("input", atualizarBotoesAgora);
    });
    // Registro aberto à mão: ao escolher placa/loja/data, busca o GPS.
    ["placa", "loja", "dataOcorrencia", "diaSeguinte", "motorista"].forEach((id) => {
      $id(id)?.addEventListener("change", () => agendarGps(1200)); // depois da escala automática
    });
    new MutationObserver(() => { if (!$id("form").classList.contains("hidden")) agendarGps(1500); })
      .observe($id("form"), { attributes: true, attributeFilter: ["class"] });
    // abrirForm/editar trocam a data por código, sem evento.
    new MutationObserver(atualizarBotoesAgora).observe($id("form"), { attributes: true, attributeFilter: ["class"] });
    document.addEventListener("click", () => setTimeout(atualizarBotoesAgora, 400));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(iniciar, 0));
  } else {
    setTimeout(iniciar, 0);
  }
})();
