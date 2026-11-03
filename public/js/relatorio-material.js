// ================================================================
// relatorio-material.js — "📦 Relatório de material" (botão na barra do TMS)
// ----------------------------------------------------------------
// O material da planilha "RETIRADA E ENVIO DE MATERIAL" foi ou não foi?
// GET /materiais-rota/relatorio?de&ate devolve cada item do período com a
// SITUAÇÃO, cruzando:
//   - a conferência no formulário de ocorrência da mesma loja/dia
//     (Material de Envio / Material de Retirada) — manda mais;
//   - o status escrito na planilha pela expedição ("ok", "entregue"...).
// Inclui também o texto de Material de Retirada anotado nas ocorrências
// com retirada não realizada ou parcial, mesmo sem item na planilha.
// Filtra por tipo/situação/texto, mostra a aba PENDENTES e baixa em Excel.
// ================================================================
(function () {
  "use strict";

  const esc = (v) => (typeof window.escapar === "function"
    ? window.escapar(v == null ? "" : v)
    : String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
  const avisar = (m) => (typeof window.alertar === "function" ? window.alertar(m) : alert(m));
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const dataBR = (s) => { const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : (s || ""); };
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  const GRUPOS = {
    ok: { icone: "✅", rotulo: "Foi", cor: "#16a34a" },
    falha: { icone: "❌", rotulo: "Não foi", cor: "#dc2626" },
    parcial: { icone: "⚠️", rotulo: "Parcial", cor: "#ca8a04" },
    pendente: { icone: "⏳", rotulo: "Pendente", cor: "#d97706" },
    aberto: { icone: "❔", rotulo: "Sem confirmação", cor: "#64748b" },
  };
  const CONFERENCIA = {
    envio: { correta: "Chegou corretamente", parcial: "Parcial / divergência", incorreta: "Não chegou / incorreta", na: "Não se aplica" },
    retirada: { correta: "Retirado corretamente", parcial: "Retirado parcialmente", incorreta: "Não foi retirado", na: "Não se aplica" },
  };

  let dados = null;
  let seqConsulta = 0;
  let visiveis = []; // linhas na tela (indice dos botoes de marcacao)

  // Botoes foi / nao foi / pendente (PUT /materiais-rota/item, de materiais-rota.js).
  const CORES_ST = { ok: "#16a34a", nao: "#dc2626", pendente: "#d97706" };
  function botoesItem(l, idx) {
    const rot = (window.materialRotulosItem || {})[l.tipo];
    if (!rot || typeof window.materialMarcarItem !== "function") return "";
    const bt = (st) => {
      const ativo = l.status_item === st;
      return `<button type="button" data-rel-idx="${idx}" data-rel-st="${st}" title="${ativo ? (l.manual || l.fonte_formulario ? "Já marcado" : "Clique de novo para desmarcar") : "Marcar este item"}"
        style="font-size:11px;padding:1px 6px;min-height:0;border-radius:4px;cursor:pointer;border:1px solid ${CORES_ST[st]}${ativo ? "" : "55"};
        background:${ativo ? CORES_ST[st] : "transparent"};color:${ativo ? "#fff" : "inherit"};">${rot[st]}</button>`;
    };
    return `<div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:4px;">${bt("ok")}${bt("nao")}${bt("pendente")}</div>`;
  }
  async function aoMarcar(e) {
    const b = e.target.closest("[data-rel-idx]");
    if (!b) return;
    const l = visiveis[Number(b.dataset.relIdx)];
    if (!l) return;
    if ((l.manual || l.fonte_formulario) && l.status_item === b.dataset.relSt) return;
    const novo = l.status_item === b.dataset.relSt ? "" : b.dataset.relSt;
    b.parentElement.querySelectorAll("button").forEach((x) => { x.disabled = true; });
    try {
      const resposta = await window.materialMarcarItem(l, novo, novo === "ok" ? iso(new Date()) : "");
      l.resolvido_em_data = resposta.resolvido_em_data || null;
    } catch (err) {
      avisar(`Não consegui marcar: ${err.message || err}`);
      render();
      return;
    }
    if (!novo) { gerar(); return; } // desmarcou: volta a situacao calculada pelo servidor
    const rot = window.materialRotulosItem[l.tipo];
    l.status_item = novo;
    l.grupo = { ok: "ok", nao: "falha", pendente: "pendente" }[novo];
    l.situacao = rot[novo].replace(/^[^\p{L}]+/u, "");
    l.fonte = "item";
    l.marcado_por = "você";
    l.marcado_em = new Date().toLocaleString("pt-BR");
    render();
  }

  const $ = (id) => document.getElementById(id);

  function fechar() { seqConsulta++; dados = null; $("relMatModal")?.remove(); }

  function filtrados() {
    if (!dados) return [];
    const tipo = $("relMatTipo").value, grupo = $("relMatGrupo").value, busca = norm($("relMatBusca").value).trim();
    return dados.linhas.filter((l) => (!tipo || l.tipo === tipo) && (!grupo || l.grupo === grupo)
      && (!busca || norm(`${l.loja} ${l.loja_planilha} ${l.material} ${l.rota || ""} ${l.motorista || ""} ${l.transacao || ""}`).includes(busca)));
  }

  function chip(g, n) {
    const G = GRUPOS[g];
    return `<button type="button" data-grupo="${g}" class="relMatChip" style="border:1px solid ${G.cor}55;background:${G.cor}14;color:inherit;border-radius:10px;padding:6px 12px;cursor:pointer;text-align:left;">
      <div style="font-size:11px;color:${G.cor};font-weight:700;">${G.icone} ${G.rotulo}</div><div style="font-size:20px;font-weight:800;">${n}</div></button>`;
  }

  function render() {
    const corpo = $("relMatCorpo");
    if (!corpo || !dados) return;
    const lin = filtrados();
    const r = { ok: 0, falha: 0, parcial: 0, pendente: 0, aberto: 0 };
    lin.forEach((l) => { r[l.grupo] += 1; });
    visiveis = lin;
    const linhas = lin.map((l, idx) => {
      const G = GRUPOS[l.grupo];
      const det = [];
      if (l.quantidade) det.push(`qtd ${esc(l.quantidade)}`);
      if (l.transacao) det.push(`transação ${esc(l.transacao)}`);
      if (l.origem) det.push(`vem de ${esc(l.origem)}`);
      if (l.destino) det.push(`vai para ${esc(l.destino)}`);
      if (l.obs_planilha) det.push(esc(l.obs_planilha));
      if (l.manual) det.push(`Lançamento manual${l.data < dados.de ? " · pendência anterior" : ""}`);
      if (l.fonte_formulario) det.push(`Anotado no formulário${l.data < dados.de ? " · pendência anterior" : ""}`);
      if (l.resolvido_em_data) det.push(`${l.tipo === "retirada" ? "retirado" : "entregue"} em ${esc(dataBR(l.resolvido_em_data))}`);
      const fonte = l.fonte_formulario
        ? `formulário de ocorrência #${esc(l.ocorrencia_id)}${l.marcado_por ? ` · conferido por ${esc(l.marcado_por)}` : ""}`
        : l.fonte === "item"
        ? `marcado por ${esc(l.marcado_por || "-")}${l.marcado_em ? ` · ${esc(l.marcado_em)}` : ""}${l.obs_item ? ` · “${esc(l.obs_item)}”` : ""}`
        : l.fonte === "loja"
        ? `conferido na ocorrência${l.ocorrencia_id ? ` #${l.ocorrencia_id}` : ""}`
        : l.fonte === "planilha" ? `marcado na planilha: "${esc(l.status_planilha)}"`
          : l.ocorrencia_id ? `ocorrência #${l.ocorrencia_id} sem conferência da ${l.tipo === "envio" ? "entrega" : "retirada"}` : "sem ocorrência lançada";
      return `<tr>
        <td style="white-space:nowrap;">${esc(dataBR(l.data))}</td>
        <td>${l.tipo === "envio" ? "📦 Envio" : "↩️ Retirada"}</td>
        <td><b>${esc(l.loja)}</b>${l.rota ? `<div style="font-size:11px;color:var(--text-muted);">${esc(l.rota)}</div>` : ""}</td>
        <td><div style="white-space:pre-line;">${esc(l.material)}</div>${det.length ? `<div style="font-size:11px;color:var(--text-muted);">${det.join(" · ")}</div>` : ""}</td>
        <td><span style="font-weight:700;color:${G.cor};white-space:nowrap;">${G.icone} ${esc(l.situacao)}</span>
          <div style="font-size:11px;color:var(--text-muted);">${fonte}</div>
          ${l.relato_loja && !l.fonte_formulario ? `<div style="font-size:11px;">“${esc(l.relato_loja)}”</div>` : ""}
          ${botoesItem(l, idx)}</td>
      </tr>`;
    }).join("");
    const pend = dados.pendentes || [];
    corpo.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin:10px 0;">
        ${chip("ok", r.ok)}${chip("falha", r.falha)}${chip("pendente", r.pendente)}${chip("parcial", r.parcial)}${chip("aberto", r.aberto)}
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">${lin.length} de ${dados.linhas.length} registros · ${esc(dataBR(dados.de))} a ${esc(dataBR(dados.ate))}${dados.linhas.some(l => (l.manual || l.fonte_formulario) && l.data < dados.de) ? " · inclui pendências anteriores" : ""}</div>
      ${dados.aviso_planilha ? `<p role="status" style="color:#d97706;font-size:12px;">${esc(dados.aviso_planilha)}</p>` : ""}
      ${lin.length ? `<div style="overflow:auto;max-height:46vh;border:1px solid var(--border-subtle,#8883);border-radius:8px;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead style="position:sticky;top:0;background:var(--bg-elevated,#fff);"><tr>
            <th style="text-align:left;padding:6px;">Data</th><th style="text-align:left;padding:6px;">Tipo</th><th style="text-align:left;padding:6px;">Loja</th>
            <th style="text-align:left;padding:6px;">Material</th><th style="text-align:left;padding:6px;">Situação</th></tr></thead>
          <tbody>${linhas}</tbody></table></div>`
        : `<div style="padding:16px;text-align:center;color:var(--text-muted);">Nenhum item com esses filtros.</div>`}
      ${pend.length ? `<details style="margin-top:10px;"><summary style="cursor:pointer;font-weight:700;color:#d97706;">⏳ Aba PENDENTES da planilha — ainda sem dia (${pend.length})</summary>
        <ul style="margin:6px 0 0;padding-left:18px;font-size:13px;">${pend.map((p) => `<li><b>${esc(p.loja)}</b> — ${p.tipo === "retirada" ? "retirar" : "entregar"}: ${esc(p.material)}${p.quantidade ? ` (qtd ${esc(p.quantidade)})` : ""}${p.data_tr ? ` · TR ${esc(p.data_tr)}` : ""}${p.obs_planilha ? ` · ${esc(p.obs_planilha)}` : ""}</li>`).join("")}</ul></details>` : ""}
      <style>#relMatModal td{padding:6px;border-top:1px solid var(--border-subtle,#8883);vertical-align:top;}</style>`;
    corpo.querySelectorAll(".relMatChip").forEach((b) => b.addEventListener("click", () => {
      const sel = $("relMatGrupo");
      sel.value = sel.value === b.dataset.grupo ? "" : b.dataset.grupo;
      render();
    }));
  }

  async function gerar() {
    const de = $("relMatDe").value, ate = $("relMatAte").value;
    if (!de || !ate || de > ate) { avisar("Escolha o período (a data inicial não pode ser depois da final)."); return; }
    const corpo = $("relMatCorpo");
    if (!corpo) return;
    const seq = ++seqConsulta;
    corpo.innerHTML = `<div style="padding:16px;color:var(--text-muted);">Lendo as planilhas da expedição e cruzando com as ocorrências…</div>`;
    try {
      const resp = await fetch(`${window.location.origin}/materiais-rota/relatorio?de=${de}&ate=${ate}&anteriores=${$("relMatAnteriores").checked ? "1" : "0"}`, { headers: { Accept: "application/json" } });
      const d = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(resp.status === 404 ? "O servidor ainda não tem o relatório (falta reiniciar)." : (d.error || `erro ${resp.status}`));
      if (seq !== seqConsulta || $("relMatCorpo") !== corpo) return;
      dados = d;
      render();
    } catch (err) {
      if (seq !== seqConsulta || $("relMatCorpo") !== corpo) return;
      dados = null;
      corpo.innerHTML = `<div style="padding:16px;color:#dc2626;">${esc(err.message || err)}</div>`;
    }
  }

  function baixarExcel() {
    if (!dados) { avisar("Gere o relatório primeiro."); return; }
    if (typeof XLSX === "undefined") { avisar("Biblioteca de Excel não carregou. Recarregue a página."); return; }
    const itens = filtrados().map((l) => ({
      Data: dataBR(l.data), Tipo: l.tipo === "envio" ? "Envio" : "Retirada", Loja: l.loja, "Loja (como na planilha)": l.loja_planilha,
      Rota: l.rota || "", Material: l.material, Quantidade: l.quantidade || "", Setor: l.setor || "", "Transação": l.transacao || "",
      "Vem de": l.origem || "", "Vai para": l.destino || "",
      Resultado: GRUPOS[l.grupo].rotulo, "Situação": l.situacao,
      Fonte: l.fonte_formulario ? "Formulário de ocorrência" : l.manual ? "Lançamento manual" : l.fonte === "item" ? "Marcado no sistema" : l.fonte === "loja" ? "Conferência na ocorrência" : l.fonte === "planilha" ? "Planilha da expedição" : "",
      "Data da conclusão": dataBR(l.resolvido_em_data || ""),
      "Status na planilha": l.status_planilha || "", "Obs. planilha": l.obs_planilha || "",
      "Marcado por": l.marcado_por || "", "Marcado em": l.marcado_em || "", "Observação do item": l.obs_item || "",
      "Conferência na ocorrência": (CONFERENCIA[l.tipo] || {})[l.conferencia_loja] || "", "Relato": l.relato_loja || "",
      "Ocorrência": l.ocorrencia_id || "", Motorista: l.motorista || "",
    }));
    const pend = (dados.pendentes || []).map((p) => ({
      Tipo: p.tipo === "envio" ? "Envio" : "Retirada", Loja: p.loja, "Loja (como na planilha)": p.loja_planilha, Material: p.material,
      Quantidade: p.quantidade || "", Setor: p.setor || "", "Transação": p.transacao || "", "Data da TR": p.data_tr || "",
      "Status na planilha": p.status_planilha || "", "Obs. planilha": p.obs_planilha || "",
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(itens.length ? itens : [{ Aviso: "Nenhum item com os filtros escolhidos" }]), "Material");
    if (pend.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(pend), "Pendentes");
    XLSX.writeFile(wb, `relatorio-material_${dados.de}_a_${dados.ate}.xlsx`);
  }

  window.relatorioMaterialAbrir = function () {
    fechar();
    const hoje = new Date(), inicio = new Date();
    inicio.setDate(hoje.getDate() - 7);
    const div = document.createElement("div");
    div.id = "relMatModal";
    div.style.cssText = "position:fixed;inset:0;z-index:995;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px;";
    const campo = "font-size:14px;padding:6px 8px;";
    div.innerHTML = `
      <div style="background:var(--bg-elevated,#fff);color:var(--text-primary,#111);border-radius:14px;padding:18px;width:min(1100px,100%);max-height:94vh;overflow:auto;box-shadow:0 12px 40px rgba(0,0,0,.35);">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
          <div><div style="font-weight:800;font-size:16px;">📦 Relatório de material — envio e retirada</div>
            <div style="font-size:12px;color:var(--text-muted);">Materiais da planilha e retiradas não realizadas que você anotou no formulário de ocorrência.</div></div>
          <button type="button" class="btn-ghost btn-sm" id="relMatFechar">✕</button>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-top:12px;">
          <label style="display:flex;flex-direction:column;font-size:11px;font-weight:700;">De<input type="date" id="relMatDe" value="${iso(inicio)}" style="${campo}"></label>
          <label style="display:flex;flex-direction:column;font-size:11px;font-weight:700;">Até<input type="date" id="relMatAte" value="${iso(hoje)}" style="${campo}"></label>
          <label style="display:flex;flex-direction:column;font-size:11px;font-weight:700;">Tipo<select id="relMatTipo" style="${campo}">
            <option value="">Envio e retirada</option><option value="envio">📦 Só envio</option><option value="retirada">↩️ Só retirada</option></select></label>
          <label style="display:flex;flex-direction:column;font-size:11px;font-weight:700;">Situação<select id="relMatGrupo" style="${campo}">
            <option value="">Todas</option><option value="ok">✅ Foi</option><option value="falha">❌ Não foi</option>
            <option value="pendente">⏳ Pendente</option><option value="parcial">⚠️ Parcial</option><option value="aberto">❔ Sem confirmação</option></select></label>
          <label style="display:flex;flex-direction:column;font-size:11px;font-weight:700;flex:1;min-width:160px;">Buscar<input type="search" id="relMatBusca" placeholder="loja, material, rota, transação…" style="${campo}"></label>
          <button type="button" class="btn-blue btn-sm" id="relMatGerar">Gerar</button>
          <button type="button" class="btn-ghost btn-sm" id="relMatExcel">⬇ Excel</button>
        </div>
        <label style="display:flex;gap:6px;align-items:center;font-size:12px;margin-top:8px;"><input type="checkbox" id="relMatAnteriores" checked> Incluir pendências de datas anteriores</label>
        <div id="relMatCorpo"></div>
      </div>`;
    document.body.appendChild(div);
    div.addEventListener("click", (e) => { if (e.target === div) fechar(); });
    div.addEventListener("keydown", (e) => { if (e.key === "Escape") fechar(); });
    $("relMatFechar").addEventListener("click", fechar);
    $("relMatGerar").addEventListener("click", gerar);
    $("relMatExcel").addEventListener("click", baixarExcel);
    $("relMatAnteriores").addEventListener("change", gerar);
    $("relMatCorpo").addEventListener("click", aoMarcar);
    ["relMatTipo", "relMatGrupo"].forEach((id) => $(id).addEventListener("change", render));
    $("relMatBusca").addEventListener("input", render);
    ["relMatDe", "relMatAte"].forEach((id) => $(id).addEventListener("change", gerar));
    gerar();
  };
})();
