// ================================================================
// tms-saida-fabrica.js — ciclo da viagem no card do TMS
//     🧑 Chegou na fabrica  ->  🚚 Saiu  ->  🏁 Voltou
// ----------------------------------------------------------------
// Um clique por marco; o servidor grava a hora DELE (nada digitado):
//   Chegou (POST /tms/viagens/:id/chegada): substitui a planilha MALOTE
//          LACRADO (previsto x chegada + lacre). Planejada -> Carregando.
//   Saiu   (POST .../saida): viagem Em rota + registro "Saida de fabrica"
//          (de onde o formulario puxa a saida) + ocorrencias da viagem.
//   Voltou (POST .../retorno): viagem Finalizada + "Tempo de Rota" (jornada,
//          hora extra) com a mesma regra do formulario (8h + ate 4h extra
//          de trabalho, + 1h de almoco que nao conta).
// Cada marco feito vira um selo; o 🕒 ao lado corrige ou registra um horario
// digitado (fica marcado ✎ = "ajuste", para nao se passar por carimbo).
// "Chegou" e opcional: da para clicar "Saiu" direto.
//
// Rota de VIAGEM (pernoite, back/pernoite.js): entre Saiu e Voltou entram
//   🏨 No hotel (dia 1, opcional) e 🏨 Saiu do hotel (dia 2). Com a saida do
//   hotel o "Voltou" grava o Tempo de Rota de viagem (dia 1 + dia 2) e a
//   previsao/jornada do 2o dia passam a contar dela, nao de estimativa.
// ================================================================
(function () {
  "use strict";

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
  const hojeISO = () => new Date().toLocaleDateString("en-CA");
  const dataDa = (viagem) => String(viagem.data_viagem || "").split("T")[0];
  // 00:00 vem da programacao quando a planilha nao tinha horario: nao e meta.
  const marcadaDa = (viagem) => { const h = hhmm(viagem.hora_saida_fabrica); return h && h !== "00:00" ? h : ""; };
  // Minutos de A ate B, virando a meia-noite.
  const entre = (a, b) => { let m = minutos(b) - minutos(a); if (m < 0) m += 1440; return m; };
  const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${m}min`);

  const MARCOS = {
    chegada: { campo: "chegada_fabrica", origem: "chegada_fabrica_origem", por: "chegada_fabrica_por", icone: "🧑", verbo: "Chegou",
      dica: "Motorista chegou na fábrica (hora do servidor). A viagem passa para Carregando." },
    saida: { campo: "saida_real", origem: "saida_real_origem", por: "saida_real_por", icone: "🚚", verbo: "Saiu",
      dica: "Grava agora a saída real da fábrica e põe a viagem Em rota." },
    retorno: { campo: "retorno_real", origem: "retorno_real_origem", por: "retorno_real_por", icone: "🏁", verbo: "Voltou",
      dica: "Caminhão voltou à fábrica: finaliza a viagem e grava o Tempo de Rota (jornada e hora extra)." },
    hotel_chegada: { campo: "hotel_chegada", origem: "hotel_chegada_origem", por: "hotel_chegada_por", icone: "🏨", verbo: "No hotel",
      dica: "A equipe parou para dormir no hotel (fim do 1º dia de trabalho). Opcional: sem ele vale a saída da última loja do dia." },
    hotel_saida: { campo: "hotel_saida", origem: "hotel_saida_origem", por: "hotel_saida_por", icone: "🏨", verbo: "Saiu do hotel",
      dica: "A equipe saiu do hotel e retomou a rota (início do 2º dia). A jornada do dia conta daqui." },
  };
  const ehLonga = (viagem) => typeof window.ehRotaViagem === "function" && window.ehRotaViagem(viagem.rota_nome);
  const COR = { ok: "#16a34a", atencao: "#f97316", ruim: "#dc2626", neutro: "#64748b" };

  // Texto extra e cor de cada selo.
  function avaliacao(viagem, chave) {
    const real = hhmm(viagem[MARCOS[chave].campo]);
    const marcada = marcadaDa(viagem);
    if (chave === "chegada") {
      if (!marcada) return { cor: COR.neutro, texto: "" };
      const depois = entre(marcada, real);
      const atraso = depois > 720 ? 0 : depois; // chegou antes da saida prevista
      return atraso === 0 ? { cor: COR.ok, texto: "" } : { cor: atraso > 30 ? COR.ruim : COR.atencao, texto: ` · +${atraso}min` };
    }
    if (chave === "saida") {
      if (!marcada) return { cor: COR.neutro, texto: "" };
      const atraso = Math.max(0, minutos(real) - minutos(marcada));
      return atraso === 0 ? { cor: COR.ok, texto: " · no horário" } : { cor: atraso > 30 ? COR.ruim : COR.atencao, texto: ` · +${atraso}min` };
    }
    if (chave === "hotel_chegada") return { cor: COR.neutro, texto: " · fim do 1º dia" };
    if (chave === "hotel_saida") return { cor: COR.neutro, texto: " · 2º dia" };
    const saida = hhmm(viagem.saida_real);
    if (!saida) return { cor: COR.neutro, texto: "" };
    if (hhmm(viagem.hotel_saida)) {
      // Pernoite: (fabrica -> hotel) + (hotel -> fabrica), almoco por dia.
      const hotel = hhmm(viagem.hotel_chegada);
      const d2 = entre(hhmm(viagem.hotel_saida), real);
      const d1 = hotel ? entre(saida, hotel) : null;
      const trab = (t) => (t > 360 ? t - 60 : t);
      const trabalhado = (d1 == null ? 0 : trab(d1)) + trab(d2);
      const cor = trabalhado > 720 ? COR.ruim : trabalhado > 480 ? COR.atencao : COR.ok;
      return { cor, texto: d1 == null ? ` · 2º dia ${fmtMin(d2)}` : ` · jornada ${fmtMin(d1 + d2)} (2 dias)` };
    }
    const total = entre(saida, real);
    // 12h de trabalho (8h + ate 4h extra) + 1h de almoco => 13h corridas.
    const trabalhado = total > 360 ? total - 60 : total;
    const cor = trabalhado > 720 ? COR.ruim : trabalhado > 480 ? COR.atencao : COR.ok;
    return { cor, texto: ` · jornada ${fmtMin(total)}` };
  }

  function selo(viagem, chave) {
    const m = MARCOS[chave];
    const real = hhmm(viagem[m.campo]);
    const { cor, texto } = avaliacao(viagem, chave);
    const ajuste = viagem[m.origem] === "ajuste";
    const rastreado = viagem[m.origem] === "rastreador";
    const partes = [rastreado ? "Preenchido pelo rastreador (histórico do GPS)" : ajuste ? "Horário digitado" : "Registrado pelo botão"];
    if (viagem[m.por]) partes.push(`por ${viagem[m.por]}`);
    if (chave !== "retorno" && marcadaDa(viagem)) partes.push(`saída prevista ${marcadaDa(viagem)}`);
    if (chave === "chegada" && viagem.lacre) partes.push(`lacre ${viagem.lacre}`);
    return `<span title="${esc(partes.join(" · "))}" style="display:inline-flex;align-items:center;gap:3px;font-size:11.5px;font-weight:700;
      color:${cor};background:${cor}1f;border:1px solid ${cor}55;border-radius:16px;padding:4px 9px;white-space:nowrap;">
      ${m.icone} ${esc(real)}${rastreado ? "🛰" : ajuste ? "✎" : ""}${esc(texto)}</span>`;
  }

  function popover(viagem, chave, rotulo) {
    const id = Number(viagem.id);
    const m = MARCOS[chave];
    const lacre = chave === "chegada"
      ? `<label style="font-size:11px;color:var(--text-muted);white-space:nowrap;">Lacre
           <input type="text" id="tmsMk-${chave}-L${id}" value="${esc(viagem.lacre || "")}" maxlength="40" style="width:90px;" /></label>`
      : "";
    return `
      <details class="tms-marco-ajuste" style="position:relative;">
        <summary class="btn-ghost btn-sm" style="list-style:none;cursor:pointer;" title="${esc(rotulo)}">${m.icone}🕒</summary>
        <div style="position:absolute;right:0;top:calc(100% + 4px);z-index:20;display:flex;gap:6px;align-items:flex-end;flex-wrap:wrap;
          background:var(--bg-elevated, #fff);border:1px solid var(--border-md, #ccc);border-radius:10px;padding:8px;box-shadow:0 6px 18px rgba(0,0,0,.18);min-width:200px;">
          <label style="font-size:11px;color:var(--text-muted);white-space:nowrap;">${esc(rotulo)}
            <input type="time" id="tmsMk-${chave}-H${id}" value="${esc(hhmm(viagem[m.campo]))}"
              onkeydown="if(event.key==='Enter'){event.preventDefault();tmsMarcoAjustar('${chave}',${id});}" /></label>
          ${lacre}
          <button type="button" class="btn-blue btn-sm" onclick="tmsMarcoAjustar('${chave}',${id})">OK</button>
        </div>
      </details>`;
  }

  function botao(viagem, chave, principal) {
    const id = Number(viagem.id);
    const m = MARCOS[chave];
    return `<button type="button" class="${principal ? "btn-green" : "btn-ghost"} btn-sm" id="tmsMk-${chave}-B${id}"
      onclick="tmsMarcoAgora('${chave}',${id})" title="${esc(m.dica)}">${m.icone} ${m.verbo}${principal ? " agora" : ""}</button>`;
  }

  // HTML do ciclo (vai na barra de acoes do card da viagem).
  window.tmsSaidaHtml = function (viagem) {
    if (!viagem) return "";
    const feito = (c) => !!viagem[MARCOS[c].campo];
    const html = [];
    for (const c of ["chegada", "saida", "hotel_chegada", "hotel_saida", "retorno"]) {
      if (feito(c)) html.push(selo(viagem, c) + popover(viagem, c, `Corrigir ${MARCOS[c].verbo.toLowerCase()}`));
    }
    if (viagem.status === "Cancelada" || feito("retorno")) return html.join("");
    const data = dataDa(viagem);
    const hoje = hojeISO();
    if (data > hoje) return html.join(""); // viagem futura
    const ehHoje = data === hoje;
    if (!feito("saida")) {
      if (viagem.status === "Finalizada") return html.join("");
      if (!feito("chegada")) {
        if (ehHoje) html.push(botao(viagem, "chegada", false));
        html.push(popover(viagem, "chegada", ehHoje ? "Chegou em outro horário" : "Registrar chegada"));
      }
      if (ehHoje) html.push(botao(viagem, "saida", true));
      html.push(popover(viagem, "saida", ehHoje ? "Saiu em outro horário" : "Registrar saída"));
    } else {
      // Rota de viagem: 🏨 hotel entre a saida e a volta. "Agora" do Saiu do
      // hotel e do Voltou vale no dia seguinte (o servidor confere a janela).
      const longa = ehLonga(viagem);
      const diaSeguinte = longa && data < hoje;
      if (longa && !feito("hotel_saida")) {
        if (ehHoje && !feito("hotel_chegada")) {
          html.push(botao(viagem, "hotel_chegada", false));
          html.push(popover(viagem, "hotel_chegada", "Chegou no hotel em outro horário"));
        }
        if (diaSeguinte) html.push(botao(viagem, "hotel_saida", true));
        html.push(popover(viagem, "hotel_saida", diaSeguinte ? "Saiu do hotel em outro horário" : "Registrar saída do hotel"));
      }
      // Voltou: tambem para viagem ja Finalizada (automatico) que nao teve retorno.
      const voltouAgora = ehHoje || diaSeguinte;
      if (voltouAgora) html.push(botao(viagem, "retorno", !(diaSeguinte && !feito("hotel_saida"))));
      html.push(popover(viagem, "retorno", voltouAgora ? "Voltou em outro horário" : "Registrar retorno"));
    }
    return html.join("");
  };

  function mensagem(chave, r) {
    if (chave === "chegada") {
      const at = r.atraso_min == null ? "" : r.atraso_min === 0 ? " — no horário" : ` — ${r.atraso_min}min depois da saída prevista`;
      return `🧑 Chegada registrada às ${r.hora}${at}.`;
    }
    if (chave === "saida") {
      const at = r.atraso_min == null ? "" : r.atraso_min === 0 ? " — no horário" : ` — ${r.atraso_min}min de atraso`;
      const ocs = r.ocorrencias_atualizadas ? ` ${r.ocorrencias_atualizadas} registro(s) já lançado(s) atualizado(s).` : "";
      return `🚚 Saída registrada às ${r.hora}${at}.${ocs}`;
    }
    if (chave === "hotel_chegada") return `🏨 Parada no hotel registrada às ${r.hora}. Bom descanso para a equipe.`;
    if (chave === "hotel_saida") return `🏨 Saída do hotel registrada às ${r.hora}. A jornada de hoje conta a partir daqui.`;
    if (r.pernoite && !r.jornada) {
      return `🏁 Retorno às ${r.hora}. Viagem com pernoite: registre a saída do hotel (🏨🕒) para gravar o Tempo de Rota.`;
    }
    const j = r.jornada || {};
    const extra = j.minutos_excedentes > 0 ? ` ⚠️ ${fmtMin(j.minutos_excedentes)} acima das 12h de trabalho.`
      : j.minutos_extras_permitidos > 0 ? ` Hora extra: ${fmtMin(j.minutos_extras_permitidos)}.` : "";
    const almoco = j.total_min > j.trabalhado_min ? ` (${fmtMin(j.trabalhado_min)} trabalhadas, descontado 1h de almoço)` : "";
    const dias = j.dia1_min != null ? ` (1º dia ${fmtMin(j.dia1_min)} + 2º dia ${fmtMin(j.dia2_min)})` : "";
    const tr = r.pernoite && r.tempo_rota ? ` Tempo de Rota de viagem gravado${dias}.`
      : r.pernoite ? " Viagem com pernoite: lance o Tempo de Rota com os horários do hotel."
      : r.tempo_rota ? " Tempo de Rota gravado." : "";
    return `🏁 Retorno às ${r.hora} — jornada ${fmtMin(j.total_min || 0)}${almoco}.${extra}${tr}`;
  }

  async function registrar(chave, viagemId, corpo) {
    const trava = `${chave}:${viagemId}`;
    if (enviando.has(trava)) return;
    enviando.add(trava);
    const btn = document.getElementById(`tmsMk-${chave}-B${viagemId}`);
    const textoBtn = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "Gravando..."; }
    try {
      const r = await tmsRequest(`/tms/viagens/${viagemId}/${chave}`, { method: "POST", body: JSON.stringify(corpo) });
      // O formulario de ocorrencia le a saida do cache do registro "Saida de
      // fabrica", e o Tempo de Rota tem cache proprio: recarrega os dois.
      // (lista vazia recarregaria TUDO — por isso a chegada nao chama.)
      if (chave !== "chegada" && typeof carregarDadosServidorLocal === "function" && typeof LS !== "undefined") {
        await carregarDadosServidorLocal(true, [chave === "saida" ? LS.atrasos : LS.rotas]);
      }
      await tmsCarregarViagens();
      if (typeof window.dispararMudou === "function") window.dispararMudou("tms");
      avisar(mensagem(chave, r));
    } catch (err) {
      avisar(`Não consegui registrar: ${err.message || err}`);
      if (btn) { btn.disabled = false; btn.textContent = textoBtn; }
    } finally {
      enviando.delete(trava);
    }
  }

  window.tmsMarcoAgora = (chave, viagemId) => registrar(chave, viagemId, {});

  window.tmsMarcoAjustar = function (chave, viagemId) {
    const hora = hhmm(document.getElementById(`tmsMk-${chave}-H${viagemId}`)?.value);
    if (!hora) { avisar("Informe o horário."); return; }
    const corpo = { hora };
    const lacre = document.getElementById(`tmsMk-${chave}-L${viagemId}`);
    if (lacre) corpo.lacre = lacre.value;
    registrar(chave, viagemId, corpo);
  };

  // Nomes antigos (v1), caso alguma tela aberta ainda chame.
  window.tmsSaidaAgora = (viagemId) => window.tmsMarcoAgora("saida", viagemId);
  window.tmsSaidaAjustar = (viagemId) => window.tmsMarcoAjustar("saida", viagemId);
})();
