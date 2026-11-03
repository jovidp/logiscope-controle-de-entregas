// ================================================================
// pernoite-form.js — "🏨 Entregue no dia seguinte" no form de ocorrencia
// ----------------------------------------------------------------
// Rotas de VIAGEM (NORTE FLUMINENSE, ALTERNATIVA, BAIXADA + SERRANA, LAGOS):
// a equipe dorme num hotel na regiao e termina a rota no dia seguinte. O
// registro fica com a DATA DA VIAGEM (a rota do dia anterior) e esta marca
// diz que a loja foi feita no dia seguinte — os horarios contam la
// (back/pernoite.js, coluna ocorrencias.dia_seguinte).
//
// A caixa so aparece em rota de viagem. Marca sozinha quando:
//   - a chegada e ANTES da saida da fabrica (so pode ser no dia seguinte);
//   - veio do TMS e a previsao jogou essa loja para o 2o dia.
// Depois que o operador mexe na caixa, ninguem mais muda por ele.
// ================================================================
(function iniciarPernoiteForm() {
  "use strict";

  const ROTA_VIAGEM_RE = /FLUMINENSE|ALTERNATIVA|SERR[AE]N|LAGOS/;
  const normalizar = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
  const ehRotaViagem = (nome) => ROTA_VIAGEM_RE.test(normalizar(nome));
  window.ehRotaViagem = ehRotaViagem;

  const $ = (id) => document.getElementById(id);
  const minDe = (h) => {
    const m = String(h || "").match(/^(\d{1,2}):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const dataBR = (iso) => {
    const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}` : "";
  };
  const diaSeguinteISO = (iso) => {
    const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
    if (Number.isNaN(d.getTime())) return "";
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  };

  function rotaAtual() {
    const ctx = window.tmsOcorrenciaContexto;
    if (ctx && ctx.rota) return ctx.rota;
    const loja = $("loja")?.value || "";
    const mapa = typeof lojasRotas !== "undefined" && lojasRotas ? lojasRotas : null;
    if (!mapa || !loja) return "";
    return mapa[loja] || mapa[String(loja).trim().toUpperCase().replace(/\s+/g, "_")] || "";
  }

  // Sugestao vinda de fora (TMS): true/false/null.
  let sugestaoTms = null;

  function atualizar() {
    const box = $("campoDiaSeguinte"), chk = $("diaSeguinte"), dica = $("diaSeguinteDica");
    if (!box || !chk) return;
    const longa = ehRotaViagem(rotaAtual());
    box.style.display = longa || chk.checked ? "" : "none";
    if (!longa && !chk.checked) return;

    const chegada = minDe($("hora_chegada")?.value), saida = minDe($("horaSaidaFabrica")?.value);
    const certo = chegada != null && saida != null && chegada < saida;
    if (chk.dataset.manual !== "1") {
      if (certo) { chk.checked = true; chk.dataset.auto = "1"; }
      else if (sugestaoTms !== null) chk.checked = sugestaoTms;
      else if (chk.dataset.auto === "1") chk.checked = false; // corrigiu o horario
      if (!certo) delete chk.dataset.auto;
    }

    const data = $("dataOcorrencia")?.value || "";
    const d1 = dataBR(data), d2 = dataBR(diaSeguinteISO(data));
    let txt = d1
      ? `O registro fica na viagem de <strong>${d1}</strong> (data da rota). Marque se a loja foi feita em <strong>${d2}</strong>, depois que a equipe dormiu na região.`
      : "Marque se a loja foi feita no dia seguinte, depois que a equipe dormiu na região.";
    if (certo && chk.dataset.manual !== "1") txt += " <em>Marcado sozinho: a chegada é antes da saída da fábrica.</em>";
    else if (sugestaoTms && chk.dataset.manual !== "1" && chk.checked) txt += " <em>Pela previsão do TMS esta loja ficou para o dia seguinte.</em>";
    if (dica) dica.innerHTML = txt;
  }

  // Chamado pelo limparForm (script-5): volta ao estado neutro.
  window.pernoiteFormReset = function () {
    const chk = $("diaSeguinte");
    if (chk) { chk.checked = false; delete chk.dataset.manual; delete chk.dataset.auto; }
    sugestaoTms = null;
    atualizar();
  };

  // Edicao de registro existente: o valor salvo manda (conta como manual).
  window.pernoiteFormPreencher = function (valor) {
    const chk = $("diaSeguinte");
    if (!chk) return;
    chk.checked = valor === true || valor === "true";
    chk.dataset.manual = "1";
    atualizar();
  };

  // Aberto pelo TMS (ou ligado a viagem pelo vinculo-viagem.js): se a previsao
  // pos a loja no 2o dia. false explicito (Desfazer) desmarca o que foi sugerido.
  window.pernoiteFormDoTms = function ({ sugerirDiaSeguinte } = {}) {
    sugestaoTms = sugerirDiaSeguinte === true ? true : sugerirDiaSeguinte === false ? false : null;
    atualizar();
  };

  // Para o payload: so manda quando a caixa e relevante; senao o servidor deduz.
  window.pernoiteFormValor = function () {
    const box = $("campoDiaSeguinte"), chk = $("diaSeguinte");
    if (!box || !chk || box.style.display === "none") return undefined;
    return chk.checked;
  };

  function ligar() {
    const chk = $("diaSeguinte");
    if (!chk) return;
    chk.addEventListener("change", () => { chk.dataset.manual = "1"; atualizar(); });
    ["hora_chegada", "horaSaidaFabrica", "loja", "dataOcorrencia"].forEach((id) => {
      $(id)?.addEventListener("input", atualizar);
      $(id)?.addEventListener("change", atualizar);
    });
    atualizar();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ligar);
  else ligar();
})();
