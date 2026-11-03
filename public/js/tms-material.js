// ================================================================
// tms-material.js — material da planilha de envio/retirada no card da parada
// ----------------------------------------------------------------
// Cada parada do TMS mostra quanto material tem para ENTREGAR e RETIRAR
// naquela loja no dia da viagem e quanto ficou PENDENTE de visitas
// anteriores (GET /materiais-rota/lojas, so contagens). Quem acompanha a rota
// ve isso sem abrir formulario. Busca so viagens de ontem em diante, em lote
// por dia, com cache de 5 min. tms.js chama tmsMaterialParadaHtml no card;
// o conteudo chega depois e preenche os marcadores.
// ================================================================
(function () {
  "use strict";

  const CACHE_MS = 5 * 60 * 1000;
  const cache = new Map();     // "data|loja" -> { em, resumo }
  const pedidos = new Map();   // data -> Set(lojas) a buscar
  let agendado = null;

  const esc = (v) => (typeof window.escapar === "function"
    ? window.escapar(v == null ? "" : v)
    : String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));

  const ontemIso = () => { const d = new Date(); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

  function textoResumo(r) {
    if (!r) return "";
    const partes = [];
    if (r.entregar) partes.push(`📦 ${r.entregar} p/ entregar`);
    if (r.retirar) partes.push(`↩️ ${r.retirar} p/ retirar`);
    if (r.pendentes_anteriores) partes.push(`<b style="color:#ef4444;">🔁 ${r.pendentes_anteriores} pendente(s) de visita anterior</b>`);
    if (!partes.length) return "";
    const ok = r.marcados_ok ? ` · ✅ ${r.marcados_ok} conferido(s)` : "";
    return `<span title="Material da planilha de envio e retirada (OnlyOffice). Detalhe e marcação no registro da parada.">Material: ${partes.join(" · ")}${ok}</span>`;
  }

  function preencher() {
    document.querySelectorAll(".tms-mat[data-mat-data]").forEach((el) => {
      const c = cache.get(`${el.dataset.matData}|${el.dataset.matLoja}`);
      if (!c) return;
      const html = textoResumo(c.resumo);
      el.innerHTML = html;
      el.style.display = html ? "" : "none";
    });
  }

  async function buscar() {
    agendado = null;
    const lote = [...pedidos.entries()];
    pedidos.clear();
    for (const [data, lojasSet] of lote) {
      const lojas = [...lojasSet];
      for (let i = 0; i < lojas.length; i += 40) {
        const parte = lojas.slice(i, i + 40);
        try {
          const r = await fetch(`${window.location.origin}/materiais-rota/lojas?data=${data}&lojas=${encodeURIComponent(parte.join("|"))}`,
            { headers: { Accept: "application/json" } });
          if (!r.ok) { parte.forEach((l) => cache.set(`${data}|${l}`, { em: Date.now(), resumo: null })); continue; }
          const j = await r.json();
          for (const l of parte) cache.set(`${data}|${l}`, { em: Date.now(), resumo: j.lojas?.[l]?.resumo || null });
        } catch (_) { /* sem rede/planilha: card segue sem o material */ }
      }
    }
    preencher();
  }

  window.tmsMaterialParadaHtml = function (viagem, parada) {
    const data = String(viagem?.data_viagem || "").slice(0, 10);
    const loja = String(parada?.loja_oficial || parada?.loja_nome || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !loja || data < ontemIso()) return "";
    const k = `${data}|${loja}`;
    const c = cache.get(k);
    if (!c || Date.now() - c.em > CACHE_MS) {
      if (!pedidos.has(data)) pedidos.set(data, new Set());
      pedidos.get(data).add(loja);
      if (!agendado) agendado = setTimeout(buscar, 50);
    }
    const html = c ? textoResumo(c.resumo) : "";
    return `<div class="tms-mat tms-meta" data-mat-data="${esc(data)}" data-mat-loja="${esc(loja)}" style="${html ? "" : "display:none;"}margin-top:2px;">${html}</div>`;
  };

})();
