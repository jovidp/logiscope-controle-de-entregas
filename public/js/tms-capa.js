// ================================================================
// tms-capa.js — "🖨️ Capa" no card da viagem: CAPA DA FRENTE automatica
// ----------------------------------------------------------------
// Substitui a planilha "CAPA DA FRENTE ATUALIZADA" (uma aba copiada por rota).
// Tudo vem do TMS / cadastro de lojas (GET /tms/viagens ja traz):
//   sequencia e loja ......... paradas da viagem, na ordem
//   horario da loja .......... hora prevista (programacao ou cadastro PES);
//                              sem horario = "Horário normal"
//   ramal .................... cadastro da loja (portal da TI)
//   OI da loja (celular) ..... cadastro PES (importado das capas antigas)
//   retirada / caixa vazia ... retirada RT / CX da programacao
//   quadro das docas ......... tabela de Docas (lojas de shopping)
//   data, motorista, carro ... viagem
// O UNICO dado manual e o Nº DO LACRE: pedido aqui antes de imprimir e salvo
// na viagem (PUT /tms/viagens/:id/lacre) — reimprimir ja vem preenchido.
// ================================================================
(function () {
  "use strict";

  const esc = (v) => (typeof window.escapar === "function"
    ? window.escapar(v == null ? "" : v)
    : String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
  const avisar = (m) => (typeof window.alertar === "function" ? window.alertar(m) : alert(m));
  const hhmm = (v) => { const m = String(v || "").match(/^(\d{1,2}):(\d{2})/); return m ? `${m[1].padStart(2, "0")}:${m[2]}` : ""; };
  const viagensTms = () => (typeof tmsState !== "undefined" && tmsState && tmsState.viagens) || [];
  const dataBR = (iso) => { const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : ""; };
  const num = (v) => Number(v) || 0;

  // Material da planilha de envio/retirada por loja (GET /materiais-rota/lojas):
  // o motorista sai sabendo o que levar e o que trazer, incluindo o que ficou
  // pendente de visitas anteriores. `material` = { [nomeDaParada]: {...} } ou null.
  const nomeParada = (p) => p.loja_oficial || p.loja_nome || "";
  async function buscarMaterial(v, paradas) {
    const lojas = [...new Set(paradas.map(nomeParada).filter(Boolean))];
    const data = String(v.data_viagem || "").slice(0, 10);
    if (!lojas.length || !/^\d{4}-\d{2}-\d{2}$/.test(data)) return null;
    try {
      const r = await fetch(`${window.location.origin}/materiais-rota/lojas?completo=1&data=${data}&lojas=${encodeURIComponent(lojas.join("|"))}`,
        { headers: { Accept: "application/json" } });
      if (!r.ok) return null;
      return (await r.json()).lojas || null;
    } catch (_) { return null; }
  }
  function quadroMaterial(paradas, material) {
    if (!material) return "";
    const lista = (itens) => itens.map((i) => `${esc(i.material)}${i.quantidade ? ` (${esc(i.quantidade)})` : ""}`).join("; ");
    const linhas = paradas.map((p) => {
      const m = material[nomeParada(p)];
      if (!m) return "";
      const ent = (m.envio || []).filter((i) => i.status_item !== "ok");
      const ret = (m.retirada || []).filter((i) => i.status_item !== "ok");
      const ant = (m.anteriores || []).flatMap((g) => (g.itens && g.itens.length ? g.itens : [{ material: "(itens não listados)", tipo: g.tipo }])
        .filter((i) => i.status_item !== "ok")
        .map((i) => `${g.tipo === "retirada" ? "retirar" : "entregar"} ${esc(i.material)} — de ${esc(dataBR(g.data_origem).slice(0, 5))}`));
      if (!ent.length && !ret.length && !ant.length) return "";
      return `<tr><td class="loja">${esc(nomeParada(p))}</td><td>${lista(ent)}</td><td>${lista(ret)}</td><td>${ant.join("; ")}</td></tr>`;
    }).join("");
    if (!linhas) return "";
    return `<table class="material">
        <thead><tr><th>MATERIAL</th><th>ENTREGAR</th><th>RETIRAR</th><th>PENDENTE DE VISITA ANTERIOR</th></tr></thead>
        <tbody>${linhas}</tbody></table>`;
  }

  function capaHtml(v, material) {
    const paradas = [...(v.paradas || [])].sort((a, b) => (a.ordem || 0) - (b.ordem || 0) || a.id - b.id);
    let totalRota = 0;
    const linhas = paradas.map((p, i) => {
      const rt = num(p.retirada_rt), cx = num(p.retirada_cx), tot = rt + cx;
      totalRota += tot;
      return `<tr>
        <td class="c">${i + 1}º</td>
        <td class="loja">${esc(p.loja_oficial || p.loja_nome || "")}</td>
        <td class="c">${esc(hhmm(p.hora_prevista) || "Horário normal")}</td>
        <td class="c">${esc(p.ramal || "")}</td>
        <td class="c nw">${esc(p.telefone || "")}</td>
        <td class="c">${rt || ""}</td>
        <td class="c">${cx || ""}</td>
        <td class="c b">${tot || ""}</td>
      </tr>`;
    }).join("");
    const docas = paradas.filter((p) => p.docas);
    const quadroDocas = docas.length ? `
      <table class="docas">
        <thead><tr><th>${esc(v.rota_nome || "")}</th><th>HORÁRIO DE MERCADORIA C/ CARRINHO 4 RODAS</th>
          <th>HORÁRIO DE MERCADORIA C/ CARRINHO 2 RODAS</th><th>ENTREGA SEM CARRINHO APÓS HORÁRIO</th><th>HORÁRIO DAS DOCAS</th></tr></thead>
        <tbody>${docas.map((p) => `<tr><td class="loja">${esc(p.loja_oficial || p.loja_nome)}</td>
          <td class="c">${esc(p.docas.carrinho_4 || "")}</td><td class="c">${esc(p.docas.carrinho_2 || "")}</td>
          <td class="c">${esc(p.docas.sem_carrinho || "")}</td><td class="c">${esc(p.docas.horario || "")}</td></tr>`).join("")}</tbody>
      </table>` : "";
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
      <title>Capa da frente — ${esc(v.rota_nome || "")} — ${esc(dataBR(v.data_viagem))}</title>
      <style>
        /* Folha A4 inteira, como a planilha (que imprimia sem margem). Todos os
           tamanhos sao em "em": o script no fim escolhe a maior fonte base em
           que a capa ainda cabe numa folha so — poucas lojas = letra grande,
           rota comprida = encolhe, nunca vaza pra 2a pagina. */
        @page { size: A4 portrait; margin: 6mm; }
        * { box-sizing: border-box; }
        html, body { margin: 0; background: #fff; }
        body { font-family: Arial, Helvetica, sans-serif; color: #000; font-size: 13px; }
        .folha { width: 198mm; margin: 0 auto; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 1.1em; }
        th, td { border: 1.5px solid #000; padding: .45em .4em; }
        th { background: #d9d9d9; font-size: .85em; }
        thead th:first-child { font-size: 1.25em; text-align: left; }
        td.loja { font-weight: 700; font-size: 1.08em; }
        td.c { text-align: center; } td.b { font-weight: 700; } td.nw { white-space: nowrap; }
        .total td { font-weight: 700; font-size: 1.08em; }
        table.docas th { font-size: .77em; }
        table.material th { font-size: .8em; text-align: left; }
        table.material td { font-size: .9em; vertical-align: top; }
        .rodape { margin-top: 1.4em; font-size: 1.25em; font-weight: 700; line-height: 2; }
        .rodape .lacre { font-size: 1.25em; }
        #medida { position: absolute; visibility: hidden; height: 285mm; width: 1px; }
        .acoes { margin: 10px auto; width: 198mm; }
        @media screen { body { background: #e5e5e5; } .folha { background: #fff; padding: 0; box-shadow: 0 0 0 1px #bbb; } }
        @media print { .acoes { display: none; } }
      </style></head><body>
      <div class="acoes"><button onclick="window.print()">🖨️ Imprimir</button></div>
      <div id="medida"></div>
      <div class="folha" id="folha">
      <table>
        <thead><tr><th colspan="3">${esc(v.rota_nome || "ROTA")}</th><th>RAMAL</th><th>OI DA LOJA</th>
          <th>RETIRADA DE MERCADORIA</th><th>CAIXA VAZIA</th><th>TOTAL</th></tr></thead>
        <tbody>${linhas}
          <tr class="total"><td colspan="7" style="text-align:right;">TOTAL DE RETIRADA NA ROTA:</td><td class="c">${totalRota}</td></tr>
        </tbody>
      </table>
      ${quadroDocas}
      ${quadroMaterial(paradas, material)}
      <div class="rodape">
        DATA: ${esc(dataBR(v.data_viagem))}<br>
        MOTORISTA: ${esc(v.motorista_nome || "")}<br>
        ${v.ajudantes ? `AJUDANTES: ${esc(v.ajudantes)}<br>` : ""}
        CARRO: ${esc(v.placa || "")}<br>
        <span class="lacre">Nº DO LACRE: ${esc(v.lacre || "________________")}</span>
      </div>
      </div>
      <script>
        // Maior fonte (9px..26px) em que a capa cabe na altura util da A4
        // (285mm = 297 - 2x6mm) sem estourar a largura.
        function ajustarCapa() {
          var folha = document.getElementById("folha");
          var alturaUtil = document.getElementById("medida").offsetHeight * 0.98;
          var cabe = function (px) {
            document.body.style.fontSize = px + "px";
            return folha.scrollHeight <= alturaUtil && folha.scrollWidth <= folha.clientWidth + 1;
          };
          var lo = 9, hi = 26;
          if (!cabe(lo)) return;
          for (var i = 0; i < 12; i++) { var mid = (lo + hi) / 2; if (cabe(mid)) lo = mid; else hi = mid; }
          document.body.style.fontSize = lo.toFixed(2) + "px";
        }
        window.addEventListener("load", function () { ajustarCapa(); setTimeout(function () { window.print(); }, 300); });
      <\/script>
      </body></html>`;
  }

  function fecharModal() { document.getElementById("tmsCapaModal")?.remove(); }

  async function imprimir(viagemId) {
    const v = viagensTms().find((x) => x.id === viagemId);
    if (!v) return;
    const campo = document.getElementById("tmsCapaLacre");
    const lacre = String(campo?.value || "").trim();
    // Abre a janela AINDA no clique (senao o bloqueador de pop-up barra).
    const janela = window.open("", "_blank");
    if (!janela) { avisar("O navegador bloqueou a janela da capa. Libere pop-ups para este site."); return; }
    try {
      if (lacre !== String(v.lacre || "")) {
        await tmsRequest(`/tms/viagens/${viagemId}/lacre`, { method: "PUT", body: JSON.stringify({ lacre }) });
        v.lacre = lacre || null;
        const bruto = (tmsState.viagensRaw || []).find((x) => x.id === viagemId);
        if (bruto) bruto.lacre = v.lacre;
      }
    } catch (err) {
      avisar(`Não consegui salvar o lacre (a capa sai mesmo assim): ${err.message || err}`);
    }
    fecharModal();
    janela.document.open();
    janela.document.write(`<p style="font-family:Arial;padding:20px;">Montando a capa (buscando o material da planilha)…</p>`);
    const paradas = [...(v.paradas || [])].sort((a, b) => (a.ordem || 0) - (b.ordem || 0) || a.id - b.id);
    const material = await buscarMaterial(v, paradas); // sem material: a capa sai sem o quadro
    janela.document.open();
    janela.document.write(capaHtml(v, material));
    janela.document.close();
  }

  window.tmsCapaFrente = function (viagemId) {
    const v = viagensTms().find((x) => x.id === viagemId);
    if (!v) return;
    fecharModal();
    const div = document.createElement("div");
    div.id = "tmsCapaModal";
    div.style.cssText = "position:fixed;inset:0;z-index:995;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px;";
    div.innerHTML = `
      <div style="background:var(--bg-elevated,#fff);color:var(--text-primary,#111);border-radius:14px;padding:18px;width:min(380px,100%);box-shadow:0 12px 40px rgba(0,0,0,.35);">
        <div style="font-weight:800;font-size:15px;margin-bottom:4px;">🖨️ Capa da frente</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">${esc(v.rota_nome || "")} · ${esc(v.motorista_nome || "")} · ${esc(v.placa || "")}<br>
          Tudo vem do sistema; só falta o lacre.</div>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:700;">Nº do lacre do malote
          <input type="text" id="tmsCapaLacre" maxlength="40" value="${esc(v.lacre || "")}" placeholder="ex.: 13885" style="font-size:16px;padding:8px;" /></label>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">
          <button type="button" class="btn-ghost btn-sm" id="tmsCapaCancelar">Cancelar</button>
          <button type="button" class="btn-blue btn-sm" id="tmsCapaImprimir">🖨️ Imprimir</button>
        </div>
      </div>`;
    document.body.appendChild(div);
    div.addEventListener("click", (e) => { if (e.target === div) fecharModal(); });
    document.getElementById("tmsCapaCancelar").addEventListener("click", fecharModal);
    document.getElementById("tmsCapaImprimir").addEventListener("click", () => imprimir(viagemId));
    const campo = document.getElementById("tmsCapaLacre");
    campo.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); imprimir(viagemId); }
      if (e.key === "Escape") fecharModal();
    });
    campo.focus();
    campo.select();
  };
})();
