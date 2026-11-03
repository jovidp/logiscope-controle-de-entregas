// ================================================================
// tms-entrega-rapida.js — "✅ Entregue sem problema" direto no card do TMS
// ----------------------------------------------------------------
// Antes: abrir o registro, esperar o formulario, conferir, salvar, voltar ao
// TMS. Agora, na parada pendente: Chegada, Inicio (vazio = chegada), Saida e
// um clique (ou Enter). Quando HA problema continua o "Lancar registro".
//
// O clique manda para POST /ocorrencias o MESMO registro que o formulario
// completo mandaria, com o que o TMS ja sabe (loja, motorista, placa,
// ajudantes, horario agendado, volume, sacolas, material de campanha, retirada
// prevista, saida da fabrica/hotel do dia). O servidor liga o registro a parada
// e marca "Entregue" — SLA/OTIF/permanencia saem pela mesma regra de sempre.
// Os 3 horarios sao obrigatorios de verdade: sao eles que alimentam pontualidade
// e permanencia, entao nada e inventado.
//
// A lista do TMS se redesenha sozinha (tempo real); os horarios digitados ficam
// guardados aqui por parada para nao sumirem no meio da digitacao.
// ================================================================
(function () {
  "use strict";

  const digitado = new Map(); // parada_id -> { chegada, inicio, saida }
  const enviando = new Set();

  const esc = (v) => (typeof window.escapar === "function"
    ? window.escapar(v == null ? "" : v)
    : String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
  const avisar = (m) => (typeof window.alertar === "function" ? window.alertar(m) : alert(m));
  const hhmm = (v) => {
    const m = String(v || "").match(/^(\d{1,2}):(\d{2})/);
    return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "";
  };
  const minutos = (v) => { const h = hhmm(v); return h ? Number(h.slice(0, 2)) * 60 + Number(h.slice(3)) : null; };
  // tmsState e const no tms.js: visivel pelo nome entre scripts, nao em window.
  const viagensTms = () => (typeof tmsState !== "undefined" && tmsState && tmsState.viagens) || [];
  const pendente = (p) => !p.ocorrencia_id && ["Pendente", "Em atendimento", "", null, undefined].includes(p.status);

  // HTML da linha rapida (so para parada pendente e sem registro).
  window.tmsEntregaRapidaHtml = function (viagem, parada) {
    if (!viagem || !parada || !pendente(parada)) return "";
    const d = digitado.get(parada.id) || {};
    const id = `tmsR${parada.id}`;
    const campo = (nome, rotulo, dica) => `
      <label style="display:flex;flex-direction:column;font-size:10px;color:var(--text-muted);gap:2px;">${rotulo}
        <input type="time" id="${id}-${nome}" value="${esc(d[nome] || "")}" data-parada="${parada.id}" data-campo="${nome}"
          class="tms-r-campo" title="${esc(dica)}" style="min-width:92px;" /></label>`;
    return `
      <div class="tms-rapida" style="display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px;margin-top:6px;">
        ${campo("chegada", "Chegada", "Hora que o caminhão chegou na loja")}
        ${campo("inicio", "Início descarga", "Vazio = mesma hora da chegada")}
        ${campo("saida", "Saída da loja", "Enter aqui já salva")}
        ${diaSeguinteHtml(viagem, parada)}
        <button type="button" class="btn-green btn-sm" id="${id}-btn"
          onclick="tmsEntregaRapida(${Number(viagem.id)}, ${Number(parada.id)})"
          title="Grava o registro da entrega sem ocorrência e marca a parada como Entregue">✅ Entregue sem problema</button>
      </div>`;
  };

  // Rota de viagem (pernoite): "🏨 dia seguinte" = loja feita depois que a
  // equipe dormiu na regiao. A data do registro continua a da viagem
  // (back/pernoite.js). Ja vem marcada quando a viagem e de ontem e a
  // previsao pos esta loja no 2o dia.
  const ehLonga = (v) => typeof window.ehRotaViagem === "function" && window.ehRotaViagem(v && v.rota_nome);
  const hojeLocal = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const diaSeguintePadrao = (v, p) => !!p.eta_dia_seguinte && String(v.data_viagem || "").slice(0, 10) < hojeLocal();
  function diaSeguinteHtml(viagem, parada) {
    if (!ehLonga(viagem)) return "";
    const d = digitado.get(parada.id) || {};
    const marcado = d.ds !== undefined ? d.ds : diaSeguintePadrao(viagem, parada);
    return `
        <label style="display:flex;align-items:center;gap:5px;font-size:11px;font-weight:700;color:var(--text-heading);padding-bottom:6px;"
          title="Loja feita no dia seguinte, depois que a equipe dormiu na região. O registro fica na viagem de ${esc(String(viagem.data_viagem || "").slice(0, 10).split("-").reverse().join("/"))}.">
          <input type="checkbox" id="tmsR${parada.id}-ds" class="tms-r-ds" data-parada="${parada.id}" ${marcado ? "checked" : ""} /> 🏨 dia seguinte</label>`;
  }
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (!t || !t.classList || !t.classList.contains("tms-r-ds")) return;
    const pid = Number(t.dataset.parada);
    const d = digitado.get(pid) || {};
    d.ds = t.checked;
    digitado.set(pid, d);
  });

  // Guarda o que foi digitado; Enter em qualquer campo salva.
  document.addEventListener("input", (e) => {
    const t = e.target;
    if (!t || !t.classList || !t.classList.contains("tms-r-campo")) return;
    const pid = Number(t.dataset.parada);
    const d = digitado.get(pid) || {};
    d[t.dataset.campo] = t.value;
    digitado.set(pid, d);
  });
  // A lista do TMS e redesenhada inteira (tempo real, gravacao da parada ao
  // lado): o campo onde a pessoa digitava e recriado e o cursor sumia — o Enter
  // seguinte ia para o vazio. Guarda o campo com foco e devolve apos o redesenho.
  let focoAtual = null; // { id, pos }
  document.addEventListener("focusin", (e) => {
    const t = e.target;
    focoAtual = t && t.classList && t.classList.contains("tms-r-campo") ? { id: t.id } : null;
  });
  document.addEventListener("focusout", (e) => {
    // Saiu de verdade (clicou em outro lugar): so esquece se o campo ainda existe.
    const t = e.target;
    if (t && t.classList && t.classList.contains("tms-r-campo") && document.body.contains(t)) {
      setTimeout(() => {
        if (document.activeElement && document.activeElement !== document.body) focoAtual = null;
      }, 0);
    }
  });
  function observarLista() {
    const lista = document.getElementById("tmsViagensLista");
    if (!lista || lista.dataset.rapidaObservada) return;
    lista.dataset.rapidaObservada = "1";
    new MutationObserver(() => {
      if (!focoAtual) return;
      const ativo = document.activeElement;
      if (ativo && ativo !== document.body && ativo.id === focoAtual.id) return;
      if (ativo && ativo !== document.body) return; // a pessoa ja foi para outro controle
      const campo = document.getElementById(focoAtual.id);
      if (campo) campo.focus({ preventScroll: true });
    }).observe(lista, { childList: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", observarLista);
  else observarLista();

  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (e.key !== "Enter" || !t || !t.classList || !t.classList.contains("tms-r-campo")) return;
    e.preventDefault();
    const pid = Number(t.dataset.parada);
    const viagem = viagensTms().find((v) => (v.paradas || []).some((p) => p.id === pid));
    if (viagem) window.tmsEntregaRapida(viagem.id, pid);
  });

  // Saida da fabrica do dia (ou do hotel, no 2o dia) — mesma busca do formulario.
  function saidaDoDia(data, motorista, placa) {
    try {
      if (typeof window.buscarSaidaFabricaDoDia === "function") {
        const s = window.buscarSaidaFabricaDoDia(data, motorista, placa);
        if (s) return { marcada: s.horaMarcada || "", real: s.horaReal || "" };
      }
      if (typeof window.buscarSaidaHotelDiaAnterior === "function") {
        const v = window.buscarSaidaHotelDiaAnterior(data, motorista, placa);
        if (v) return { marcada: "", real: v.saidaHotel || v.saida_hotel || "" };
      }
    } catch (_) { /* sem a busca, o registro vai sem saida — igual ao formulario */ }
    return { marcada: "", real: "" };
  }

  function lerHorarios(paradaId) {
    const val = (nome) => hhmm(document.getElementById(`tmsR${paradaId}-${nome}`)?.value || (digitado.get(paradaId) || {})[nome]);
    const chegada = val("chegada");
    const inicio = val("inicio") || chegada;
    const saida = val("saida");
    if (!chegada) return { erro: "Informe a hora de chegada." };
    if (!saida) return { erro: "Informe a hora de saída da loja." };
    if (minutos(inicio) < minutos(chegada)) return { erro: "O início da descarga não pode ser antes da chegada." };
    if (minutos(saida) < minutos(inicio)) return { erro: "A saída não pode ser antes do início da descarga." };
    return { chegada, inicio, saida };
  }

  window.tmsEntregaRapida = async function (viagemId, paradaId) {
    if (enviando.has(paradaId)) return;
    const viagem = viagensTms().find((v) => v.id === viagemId);
    const parada = viagem && (viagem.paradas || []).find((p) => p.id === paradaId);
    if (!viagem || !parada) return;
    if (!pendente(parada)) { avisar("Esta parada já tem registro."); return; }
    const h = lerHorarios(paradaId);
    if (h.erro) {
      avisar(`${parada.loja_nome}: ${h.erro}`);
      document.getElementById(`tmsR${paradaId}-${h.erro.includes("chegada") ? "chegada" : "saida"}`)?.focus();
      return;
    }

    const data = String(viagem.data_viagem || "").split("T")[0];
    const loja = typeof window.tmsResolverLojaKey === "function" ? window.tmsResolverLojaKey(parada.loja_nome) : parada.loja_nome;
    const saida = saidaDoDia(data, viagem.motorista_nome, viagem.placa);
    const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
    const volume = num(parada.volumes_previstos ?? viagem.volumes_previstos);
    const sacP = num(parada.sacola_p ?? viagem.sacola_p);
    const sacM = num(parada.sacola_m ?? viagem.sacola_m);
    const sacG = num(parada.sacola_g ?? viagem.sacola_g);
    const sacolaQtd = (sacP || 0) + (sacM || 0) + (sacG || 0) || null;
    const cxPrev = Number(parada.retirada_cx) > 0 ? Number(parada.retirada_cx) : null;
    const rtPrev = Number(parada.retirada_rt) > 0 ? Number(parada.retirada_rt) : null;
    const material = num(parada.material_campanha ?? viagem.material_campanha);

    const payload = {
      tipo_registro: "entrega",
      loja,
      motorista: viagem.motorista_nome || "",
      placa: viagem.placa || "",
      ajudantes: viagem.ajudantes || "",
      data_ocorrencia: data,
      hora_chegada: h.chegada,
      hora_agendada_loja: hhmm(parada.hora_prevista),
      inicio_descarga: h.inicio,
      fim_descarga: h.saida,
      hora_marcada_saida: saida.marcada,
      hora_saida_fabrica: saida.real,
      teve_ocorrencia: false,
      tipo_problema: null,
      ocorrencia_responsavel: "",
      ocorrencia_status: "Nao se aplica",
      // "Sem problema" = a contagem bateu com o planejado.
      volume_gerencial: volume,
      volume_fisico: volume,
      volume_divergencia: volume == null ? null : 0,
      retirada_cx_prevista: cxPrev,
      retirada_rt_prevista: rtPrev,
      material_campanha_qtd: material,
      sacola_p: sacP,
      sacola_m: sacM,
      sacola_g: sacG,
      sacola_qtd: sacolaQtd,
      observacao: "Registro rápido pelo TMS: entregue sem problema.",
      viagem_id: viagem.id,
      parada_id: parada.id,
    };
    if (ehLonga(viagem)) {
      const chk = document.getElementById(`tmsR${paradaId}-ds`);
      const marcado = chk ? chk.checked : diaSeguintePadrao(viagem, parada);
      // Chegada antes da saida da fabrica so pode ser no dia seguinte.
      const certo = saida.real && minutos(h.chegada) < minutos(saida.real);
      payload.dia_seguinte = !!(marcado || certo);
    }

    enviando.add(paradaId);
    const btn = document.getElementById(`tmsR${paradaId}-btn`);
    if (btn) { btn.disabled = true; btn.textContent = "Gravando..."; }
    try {
      const resp = await fetch(`${window.location.origin}/ocorrencias`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      const dados = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(dados.error || dados.detalhe || `Erro ${resp.status}`);
      digitado.delete(paradaId);
      if (typeof window.tmsLimparRascunho === "function") window.tmsLimparRascunho(paradaId);
      if (typeof window.tmsCarregarViagens === "function") await window.tmsCarregarViagens();
      if (typeof window.dispararMudou === "function") { window.dispararMudou("ocorrencia"); window.dispararMudou("tms"); }
    } catch (err) {
      avisar(`Não consegui gravar a entrega de ${parada.loja_nome}: ${err.message || err}`);
      if (btn) { btn.disabled = false; btn.textContent = "✅ Entregue sem problema"; }
    } finally {
      enviando.delete(paradaId);
    }
  };
})();
