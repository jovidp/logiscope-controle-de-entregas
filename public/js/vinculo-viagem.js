// ================================================================
// vinculo-viagem.js — "esta loja esta pendente numa viagem do TMS"
// ----------------------------------------------------------------
// Registro lancado pelo formulario comum (sem passar pelo TMS) nao fica
// ligado a viagem: a parada continua Pendente no TMS e, na rota de viagem,
// a loja do dia seguinte cai solta na data de hoje. Aqui, ao escolher loja e
// data, procura a loja PENDENTE numa viagem:
//   - de ontem que segue hoje (pernoite, back/pernoite.js) — "registrar
//     nela" poe a DATA DA VIAGEM e marca 🏨 dia seguinte;
//   - do proprio dia.
// So liga com um clique (nunca sozinho). Ligado, o salvar grava viagem_id e
// parada_id como se viesse do TMS (a parada fica Entregue).
// Nao roda quando o formulario veio do TMS nem na edicao de registro.
// ================================================================
(function iniciarVinculoViagem() {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (v) => (typeof window.escapar === "function"
    ? window.escapar(v == null ? "" : v)
    : String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
  const hojeLocal = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const dataBR = (iso) => { const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}` : iso; };
  const FEITA = ["Entregue", "Entregue com ocorrencia", "Recusada", "Ocorrencia"];
  const pendente = (p) => !p.ocorrencia_id && !FEITA.includes(p.status);
  const chaveLoja = (nome) => (typeof window.tmsResolverLojaKey === "function" ? window.tmsResolverLojaKey(nome) : nome);
  const editando = () => typeof editandoIndex !== "undefined" && editandoIndex !== null && editandoIndex !== undefined;

  let seq = 0, ultimaChave = "", candidatos = [], ligado = null; // ligado = { v, p, dataAntes }

  function caixa(html, cor) {
    const el = $("vinculoViagemInfo");
    if (!el) return;
    if (!html) { el.style.display = "none"; el.innerHTML = ""; return; }
    el.style.display = "";
    el.innerHTML = `<div style="background:${cor}14;border:1px solid ${cor}55;border-radius:8px;padding:9px 12px;font-size:12px;color:var(--text-heading);line-height:1.5;">${html}</div>`;
  }

  function desenhar() {
    if (ligado) {
      const { v, p } = ligado;
      caixa(`✔ <b>Ligado à viagem ${esc(v.rota_nome || "")} de ${esc(dataBR(v.data_viagem))}</b> — parada ${esc(p.ordem)} (${esc(p.loja_nome)}).
        Ao salvar, a parada fica Entregue no TMS.${v.continua_pernoite ? " Registro na data da viagem, marcado 🏨 dia seguinte." : ""}
        <button type="button" class="btn-ghost btn-sm" style="margin-left:6px;" onclick="vinculoViagemDesfazer()">Desfazer</button>`, "#16a34a");
      return;
    }
    if (!candidatos.length) { caixa(""); return; }
    const linhas = candidatos.map(({ v, p }, i) => {
      const texto = v.continua_pernoite
        ? `🏨 <b>${esc(p.loja_nome)}</b> está pendente na viagem <b>${esc(v.rota_nome || "")}</b> de <b>${esc(dataBR(v.data_viagem))}</b> — a equipe dormiu na região e termina hoje (${esc(v.motorista_nome || "-")}).`
        : `🚚 <b>${esc(p.loja_nome)}</b> está pendente na viagem <b>${esc(v.rota_nome || "")}</b> de ${esc(dataBR(v.data_viagem))} (${esc(v.motorista_nome || "-")} · ${esc(v.placa || "-")}).`;
      return `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;${i ? "margin-top:6px;" : ""}">
        <span style="flex:1;min-width:220px;">${texto}</span>
        <button type="button" class="btn-blue btn-sm" onclick="vinculoViagemLigar(${Number(v.id)}, ${Number(p.id)})">Registrar nessa viagem</button></div>`;
    }).join("");
    caixa(linhas, "#0284c7");
  }

  async function verificar() {
    if (ligado) return;
    const ctx = window.tmsOcorrenciaContexto;
    const loja = $("loja")?.value || "", data = $("dataOcorrencia")?.value || "";
    if (ctx || editando() || !loja || !/^\d{4}-\d{2}-\d{2}$/.test(data)) {
      candidatos = []; ultimaChave = ""; caixa(""); return;
    }
    const chave = `${loja}|${data}`;
    if (chave === ultimaChave) return;
    ultimaChave = chave;
    const meu = ++seq;
    try {
      const pernoite = data === hojeLocal() ? "&pernoite=1" : "";
      const r = await fetch(`${window.location.origin}/tms/viagens?data=${encodeURIComponent(data)}${pernoite}`, { headers: { Accept: "application/json" } });
      if (!r.ok || meu !== seq) return;
      const viagens = await r.json();
      if (meu !== seq || window.tmsOcorrenciaContexto || ligado) return;
      candidatos = [];
      (Array.isArray(viagens) ? viagens : []).forEach((v) => {
        if (["Cancelada"].includes(v.status)) return;
        (v.paradas || []).forEach((p) => { if (pendente(p) && chaveLoja(p.loja_nome) === loja) candidatos.push({ v, p }); });
      });
      // Pernoite primeiro: e o caso que se perde.
      candidatos.sort((a, b) => (b.v.continua_pernoite === true) - (a.v.continua_pernoite === true));
      desenhar();
    } catch (_) { /* sem TMS, sem aviso */ }
  }

  window.vinculoViagemLigar = function (viagemId, paradaId) {
    const c = candidatos.find(({ v, p }) => v.id === viagemId && p.id === paradaId);
    if (!c) return;
    const { v, p } = c;
    // preenchidos: o que ESTE vinculo preencheu — o Desfazer limpa so isso.
    ligado = { v, p, dataAntes: $("dataOcorrencia")?.value || "", preenchidos: [], ajudantes: false };
    window.tmsOcorrenciaContexto = { viagem_id: v.id, parada_id: p.id, rota: v.rota_nome || "", origem: "vinculo" };
    const dataViagem = String(v.data_viagem || "").slice(0, 10);
    if (dataViagem && typeof preencherCampo === "function") preencherCampo("dataOcorrencia", dataViagem);
    // Equipe da viagem (so o que estiver vazio: quem preencheu a mao manda).
    const vazio = (id) => !String($(id)?.value || "").trim();
    const preencher = (id, valor, select) => {
      if (!valor || !vazio(id)) return;
      if (select && typeof garantirOpcaoSelect === "function") garantirOpcaoSelect(id, valor);
      preencherCampo(id, valor);
      ligado.preenchidos.push(id);
    };
    if (typeof preencherCampo === "function") {
      preencher("motorista", v.motorista_nome, true);
      preencher("placa", v.placa, true);
      preencher("horaAgendadaLoja", p.hora_prevista ? String(p.hora_prevista).slice(0, 5) : "", false);
    }
    const semAjudante = typeof checksGrupo === "function" ? !checksGrupo("ajudantes").some((c) => c.checked) : vazio("ajudantes");
    if (v.ajudantes && typeof marcarGrupoMulti === "function" && semAjudante) {
      marcarGrupoMulti("ajudantes", v.ajudantes);
      ligado.ajudantes = true;
    }
    if (typeof pernoiteFormDoTms === "function") pernoiteFormDoTms({ sugerirDiaSeguinte: v.continua_pernoite === true });
    desenhar();
  };

  window.vinculoViagemDesfazer = function () {
    if (!ligado) return;
    const { dataAntes: antes, preenchidos, ajudantes } = ligado;
    ligado = null;
    if (window.tmsOcorrenciaContexto && window.tmsOcorrenciaContexto.origem === "vinculo") window.tmsOcorrenciaContexto = null;
    if (typeof preencherCampo === "function") preenchidos.forEach((id) => preencherCampo(id, ""));
    if (ajudantes && typeof limparGrupoMulti === "function") limparGrupoMulti("ajudantes");
    if (typeof pernoiteFormDoTms === "function") pernoiteFormDoTms({ sugerirDiaSeguinte: false });
    if (antes && typeof preencherCampo === "function") preencherCampo("dataOcorrencia", antes);
    ultimaChave = "";
    verificar();
  };

  // Formulario limpo (abrirForm/limparForm): esquece o vinculo.
  window.vinculoViagemReset = function () {
    ligado = null; candidatos = []; ultimaChave = ""; seq++;
    caixa("");
  };

  document.addEventListener("change", (e) => {
    if (!e.target || (e.target.id !== "loja" && e.target.id !== "dataOcorrencia")) return;
    // Trocou a loja depois de ligar: o vinculo era de outra loja, desfaz.
    if (ligado && e.target.id === "loja" && chaveLoja(ligado.p.loja_nome) !== e.target.value) {
      window.vinculoViagemDesfazer();
      return;
    }
    setTimeout(verificar, 50);
  });
})();
