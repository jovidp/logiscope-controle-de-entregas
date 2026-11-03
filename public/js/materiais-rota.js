// ================================================================
// materiais-rota.js — "o que ENTREGAR e RETIRAR nesta loja" no formulario
// ----------------------------------------------------------------
// Mostra, no bloco "📨 Material de Envio" do formulario de ocorrencia, o que a
// planilha "RETIRADA E ENVIO DE MATERIAL" da expedicao manda entregar e
// retirar na loja/data do formulario (GET /materiais-rota). Somente leitura:
// quem lanca confere a lista e marca logo abaixo se chegou certo
// (material_envio_status, que e salvo na ocorrencia).
// Atualiza sozinho quando loja ou data mudam — inclusive quando o TMS abre o
// formulario ja preenchido.
// ================================================================
(function () {
  "use strict";

  let ultimaChave = "", seq = 0;
  let ultimo = null;   // { d, loja, data } do ultimo render (redesenha apos marcar)
  let registro = [];   // itens com botao no render atual (indice -> item)

  // Marcacao item a item (PUT /materiais-rota/item): foi / nao foi / pendente.
  const ROTULOS = {
    envio: { ok: "✅ Entregue", nao: "❌ Não entregue", pendente: "⏳ Pendente" },
    retirada: { ok: "✅ Retirado", nao: "❌ Não retirado", pendente: "⏳ Pendente" },
  };
  const CORES = { ok: "#16a34a", nao: "#dc2626", pendente: "#d97706" };
  async function marcarItem(item, status, dataVisita, observacao) {
    const r = await fetch(`${window.location.origin}/materiais-rota/item`, {
      method: "PUT", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        data: item.data, tipo: item.tipo, loja: item.loja_planilha || item.loja, material: item.material,
        transacao: item.transacao || "", quantidade: item.quantidade || "", status, data_visita: dataVisita || "",
        observacao: observacao || "",
        fonte_formulario: item.fonte_formulario === true, ocorrencia_id: item.ocorrencia_id || null,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 404 ? "O servidor ainda não tem a marcação de material (falta reiniciar)." : (j.error || `erro ${r.status}`));
    return j;
  }
  window.materialMarcarItem = marcarItem;
  window.materialRotulosItem = ROTULOS;

  const esc = (v) => (typeof window.escapar === "function"
    ? window.escapar(v == null ? "" : v)
    : String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
  const val = (id) => String(document.getElementById(id)?.value || "").trim();
  const dataBR = (iso) => { const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}` : iso; };

  function painel() {
    let el = document.getElementById("ocMaterialRotaPanel");
    if (el) return el;
    const select = document.getElementById("materialEnvioStatus");
    if (!select) return null;
    el = document.createElement("div");
    el.id = "ocMaterialRotaPanel";
    el.style.cssText = "margin-bottom:10px;font-size:0.8rem;";
    select.parentElement.insertBefore(el, select);
    el.addEventListener("click", aoClicarMarcacao);
    el.addEventListener("change", aoMudarMotivo);
    // Enter no motivo salva (sem enviar o formulario da ocorrencia).
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.matches("[data-mat-obs]")) { e.preventDefault(); e.target.blur(); }
    });
    return el;
  }

  async function aoClicarMarcacao(e) {
    const b = e.target.closest("[data-mat-idx]");
    if (!b || !ultimo) return;
    e.preventDefault();
    const item = registro[Number(b.dataset.matIdx)];
    if (!item) return;
    if (item.manual && item.status_item === b.dataset.matSt) return;
    const novo = item.status_item === b.dataset.matSt ? "" : b.dataset.matSt; // clicar de novo desmarca
    b.parentElement.querySelectorAll("button").forEach((x) => { x.disabled = true; });
    try {
      await marcarItem(item, novo, ultimo.data);
      item.status_item = novo || null;
      item.marcado_por = novo ? "você, agora" : null;
      item.marcado_em = null;
    } catch (err) {
      const avisar = typeof window.alertar === "function" ? window.alertar : alert;
      avisar(`Não consegui marcar o material: ${err.message || err}`);
    }
    render(painel(), ultimo.d, ultimo.loja, ultimo.data);
  }

  function botoes(i) {
    if (!i.data || !i.tipo) return "";
    const idx = registro.push(i) - 1;
    const rot = ROTULOS[i.tipo] || ROTULOS.envio;
    const bt = (st) => {
      const ativo = i.status_item === st;
      return `<button type="button" data-mat-idx="${idx}" data-mat-st="${st}" title="${ativo ? "Clique de novo para desmarcar" : ""}"
        style="font-size:0.7rem;padding:2px 7px;min-height:0;border-radius:4px;cursor:pointer;border:1px solid ${CORES[st]}${ativo ? "" : "55"};
        background:${ativo ? CORES[st] : "transparent"};color:${ativo ? "#fff" : "inherit"};font-weight:${ativo ? 700 : 400};">${rot[st]}</button>`;
    };
    const quem = i.status_item && i.marcado_por ? `<span style="font-size:0.68rem;color:var(--text-muted);">${esc(i.marcado_por)}${i.marcado_em ? ` · ${esc(i.marcado_em)}` : ""}</span>` : "";
    // Motivo: campo so quando "nao foi"/"pendente"; se ja foi, mostra o motivo antigo como texto.
    const motivo = ["nao", "pendente"].includes(i.status_item)
      ? `<input type="text" data-mat-obs="${idx}" value="${esc(i.obs_item || "")}" maxlength="500"
          placeholder="Motivo (opcional) — ex.: loja não separou. Enter salva"
          style="width:100%;margin-top:4px;font-size:0.75rem;padding:4px 6px;min-height:0;">`
      : i.obs_item ? `<div style="font-size:0.7rem;color:var(--text-muted);">motivo anterior: “${esc(i.obs_item)}”</div>` : "";
    return `<div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-top:3px;">${bt("ok")}${bt("nao")}${bt("pendente")}${quem}</div>${motivo}`;
  }

  // Salva o motivo (mesmo status, so a observacao).
  async function aoMudarMotivo(e) {
    const campo = e.target.closest("[data-mat-obs]");
    if (!campo || !ultimo) return;
    const item = registro[Number(campo.dataset.matObs)];
    const texto = campo.value.trim();
    if (!item || texto === (item.obs_item || "")) return;
    campo.disabled = true;
    try {
      await marcarItem({ ...item }, item.status_item, ultimo.data, texto);
      item.obs_item = texto;
      campo.style.borderColor = "#16a34a";
    } catch (err) {
      const avisar = typeof window.alertar === "function" ? window.alertar : alert;
      avisar(`Não consegui salvar o motivo: ${err.message || err}`);
    } finally {
      campo.disabled = false;
    }
  }

  function linhaItem(i, marcavel = true) {
    const partes = [];
    if (i.quantidade) partes.push(`qtd ${esc(i.quantidade)}`);
    if (i.setor) partes.push(esc(i.setor));
    if (i.transacao) partes.push(`transação ${esc(i.transacao)}`);
    if (i.origem) partes.push(`vem de ${esc(i.origem)}`);
    if (i.destino) partes.push(`vai para ${esc(i.destino)}`);
    if (i.obs) partes.push(esc(i.obs));
    const status = i.status
      ? ` <span style="font-size:0.7rem;font-weight:700;color:#16a34a;border:1px solid #16a34a55;border-radius:10px;padding:0 6px;">${esc(i.status)}</span>`
      : "";
    return `<li style="margin:5px 0;"><b>${esc(i.material)}</b>${status}${partes.length ? `<div style="color:var(--text-muted);font-size:0.72rem;">${partes.join(" · ")}</div>` : ""}${marcavel ? botoes(i) : ""}</li>`;
  }

  function bloco(titulo, cor, itens) {
    if (!itens.length) return "";
    return `<div style="margin-top:8px;"><div style="font-weight:700;color:${cor};">${titulo} (${itens.length})</div>
      <ul style="margin:4px 0 0;padding-left:18px;">${itens.map((i) => linhaItem(i)).join("")}</ul></div>`;
  }

  // Material que nao foi numa visita anterior e voltou para esta (GET /materiais-rota -> anteriores).
  function blocoAnteriores(lista) {
    if (!lista || !lista.length) return "";
    const grupos = lista.map((p) => {
      const oQue = p.status === "item"
        ? "marcado item a item"
        : p.tipo === "retirada"
          ? (p.status === "parcial" ? "retirada parcial" : "não foi retirado")
          : (p.status === "parcial" ? "chegou parcial" : "não chegou");
      // Mantem o objeto (sem copiar) para a marcacao atualizar o proprio item.
      const itens = p.itens && p.itens.length
        ? `<ul style="margin:2px 0 0;padding-left:18px;">${p.itens.map((i) => { i.status = null; return linhaItem(i); }).join("")}</ul>`
        : `<div style="font-size:0.72rem;color:var(--text-muted);">(a planilha daquele dia não lista os itens)</div>`;
      return `<div style="margin-top:6px;">
          <div><b>${p.tipo === "retirada" ? "↩️ Retirar" : "📦 Entregar"}</b> — ficou da visita de ${esc(dataBR(p.data_origem))} (${oQue}${p.ocorrencia_id ? `, ocorrência #${esc(p.ocorrencia_id)}` : ""})</div>
          ${p.relato ? `<div style="font-size:0.72rem;color:var(--text-muted);">“${esc(p.relato)}”</div>` : ""}
          ${itens}
        </div>`;
    }).join("");
    return `<div style="margin-top:10px;padding:8px;border-radius:8px;background:rgba(239,68,68,0.07);border:1px solid rgba(239,68,68,0.35);">
        <div style="font-weight:700;color:#ef4444;">🔁 Pendente de visitas anteriores (${lista.length})</div>
        <div style="font-size:0.7rem;color:var(--text-muted);">Marque ✅ em cada item quando ele for entregue/retirado — ele sai desta lista na próxima visita.</div>
        ${grupos}
      </div>`;
  }

  function render(el, d, loja, data) {
    ultimo = { d, loja, data };
    registro = [];
    const vazio = !d.envio.length && !d.retirada.length && !(d.anteriores && d.anteriores.length);
    const origem = d.arquivo
      ? `planilha <b>${esc(d.arquivo.replace(/\.xlsx?$/i, ""))}</b>, aba ${esc(d.aba)}${d.origem ? ` (${esc(d.origem)})` : ""}`
      : "planilha de envio e retirada (sem aba para este dia)";
    const pendentes = d.pendentes && d.pendentes.length
      ? `<details style="margin-top:8px;"><summary style="cursor:pointer;color:#f59e0b;font-weight:700;">⏳ Pendentes na planilha para esta loja, sem data (${d.pendentes.length})</summary>
          <ul style="margin:4px 0 0;padding-left:18px;">${d.pendentes.map((i) => linhaItem({ ...i, material: `${i.tipo === "retirada" ? "Retirar: " : "Entregar: "}${i.material}` }, false)).join("")}</ul></details>`
      : "";
    el.innerHTML = `
      <div style="background:rgba(96,165,250,0.06);border:1px dashed rgba(96,165,250,0.35);border-radius:8px;padding:10px;">
        <div style="font-weight:700;">📋 Envio e retirada de material — ${esc(loja)} em ${esc(dataBR(data))}</div>
        <div style="font-size:0.7rem;color:var(--text-muted);">Da ${origem}. Marque cada item (salva na hora no sistema).</div>
        ${vazio ? `<div style="margin-top:6px;color:var(--text-muted);">Nada para entregar ou retirar nesta loja neste dia.</div>` : ""}
        ${bloco("📦 Entregar nesta loja", "#60a5fa", d.envio)}
        ${bloco("↩️ Retirar desta loja", "#f472b6", d.retirada)}
        ${blocoAnteriores(d.anteriores)}
        ${pendentes}
      </div>`;
    ajustarConferenciaGeral(d);
  }

  // Com botao por item, a conferencia GERAL (select "Material de Envio" /
  // "Material de Retirada") e redundante: a marcacao item a item ja vale mais
  // que ela no relatorio (back/materiais-rota.js). Some quando ha item daquele
  // tipo — a nao ser que o registro ja tenha valor salvo (edicao de registro
  // antigo: nao esconde dado). Sem item na planilha, volta: e a unica conferencia.
  let ultimoD = null;
  function ajustarConferenciaGeral(d) {
    ultimoD = d;
    const tipos = [
      { select: "materialEnvioStatus", relato: "campoMaterialEnvioRelato", itens: d ? d.envio : [], caixaInteira: false },
      { select: "materialRetiradaStatus", relato: "campoMaterialRetiradaRelato", itens: d ? d.retirada : [], caixaInteira: true },
    ];
    tipos.forEach((t) => {
      const sel = document.getElementById(t.select);
      if (!sel) return;
      const esconder = !!(t.itens && t.itens.length) && !String(sel.value || "").trim();
      // A caixa do envio tambem abriga este painel: la so o select some.
      const alvos = t.caixaInteira ? [sel.parentElement] : [sel, document.getElementById(t.relato)];
      alvos.forEach((el) => {
        if (!el) return;
        if (esconder) { el.dataset.escondidoPorItens = "1"; el.style.display = "none"; }
        else if (el.dataset.escondidoPorItens) { delete el.dataset.escondidoPorItens; el.style.display = ""; }
      });
    });
  }
  // Valor carregado depois (a edicao preenche o select): reavalia para mostrar.
  document.addEventListener("change", (e) => {
    if (e.target && (e.target.id === "materialEnvioStatus" || e.target.id === "materialRetiradaStatus")) ajustarConferenciaGeral(ultimoD);
  });

  async function atualizar(forcar) {
    const el = painel();
    if (!el) return;
    const loja = val("loja"), data = val("dataOcorrencia");
    const chave = `${loja}|${data}`;
    if (!forcar && chave === ultimaChave) return;
    ultimaChave = chave;
    if (!loja || !/^\d{4}-\d{2}-\d{2}$/.test(data)) { el.innerHTML = ""; ajustarConferenciaGeral(null); return; }
    const meu = ++seq;
    el.innerHTML = `<div style="color:var(--text-muted);font-size:0.75rem;">📋 Buscando envio e retirada de material de ${esc(loja)}…</div>`;
    try {
      const resp = await fetch(`${window.location.origin}/materiais-rota?data=${encodeURIComponent(data)}&loja=${encodeURIComponent(loja)}`,
        { headers: { Accept: "application/json" } });
      const d = await resp.json().catch(() => ({}));
      if (meu !== seq) return; // usuario ja trocou de loja/data
      if (!resp.ok) {
        ajustarConferenciaGeral(null);
        el.innerHTML = resp.status === 404 ? "" // servidor ainda sem a rota (antes do restart)
          : `<div style="color:#f59e0b;font-size:0.75rem;">📋 ${esc(d.error || "Não consegui ler a planilha de envio e retirada.")}</div>`;
        return;
      }
      render(el, d, d.loja || loja, data);
    } catch (_) {
      if (meu === seq) { el.innerHTML = ""; ajustarConferenciaGeral(null); }
    }
  }

  // Loja/data mudam por digitacao, select ou preenchimento automatico (TMS):
  // escuta os eventos e ainda confere a cada 1,5 s enquanto o formulario esta aberto.
  document.addEventListener("change", (e) => {
    if (e.target && (e.target.id === "loja" || e.target.id === "dataOcorrencia")) atualizar(false);
  });
  setInterval(() => {
    const campo = document.getElementById("loja");
    if (campo && campo.offsetParent !== null) atualizar(false);
  }, 1500);

  window.materiaisRotaAtualizar = () => atualizar(true);
})();
