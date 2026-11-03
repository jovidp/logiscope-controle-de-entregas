// ================================================================
// relatorio-semanal.js — "📊 Relatório semanal" (Dashboard e Ctrl+K)
// ----------------------------------------------------------------
// O servidor gera sozinho, toda segunda a partir das 07:00, a planilha da
// semana anterior (back/relatorio-semanal.js). Aqui: baixar os ja gerados e,
// para ADM, gerar na hora (semana passada ou um periodo escolhido).
// ================================================================
(function () {
  "use strict";

  const esc = (v) => (typeof window.escapar === "function"
    ? window.escapar(v == null ? "" : v)
    : String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
  const br = (s) => String(s || "").replace(/^(\d{4})-(\d{2})-(\d{2}).*/, "$3/$2/$1");
  const $ = (id) => document.getElementById(id);

  function fechar() { $("relSemModal")?.remove(); }

  async function listar() {
    const lista = $("relSemLista");
    if (!lista) return;
    lista.innerHTML = `<div style="color:var(--text-muted);padding:8px;">Carregando…</div>`;
    try {
      const r = await fetch(`${window.location.origin}/relatorio-semanal`, { headers: { Accept: "application/json" } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(r.status === 404 ? "O servidor ainda não tem o relatório semanal (falta reiniciar)." : (d.error || `erro ${r.status}`));
      const arq = d.arquivos || [];
      lista.innerHTML = arq.length
        ? arq.map((a) => `<a href="${window.location.origin}/relatorio-semanal/arquivo/${encodeURIComponent(a.nome)}" download
              style="display:flex;justify-content:space-between;gap:8px;padding:8px 10px;border:1px solid var(--border-subtle,#8883);border-radius:8px;margin-bottom:6px;text-decoration:none;color:inherit;">
              <span>⬇ Semana de <b>${esc(br(a.de))}</b> a <b>${esc(br(a.ate))}</b></span>
              <span style="font-size:11px;color:var(--text-muted);">gerado ${esc(new Date(a.gerado_em).toLocaleString("pt-BR"))}</span></a>`).join("")
        : `<div style="color:var(--text-muted);padding:8px;">Nenhum ainda. O primeiro sai sozinho até 1 hora depois que o servidor for reiniciado; depois, toda segunda às 07:00.</div>`;
    } catch (err) {
      lista.innerHTML = `<div style="color:#dc2626;padding:8px;">${esc(err.message || err)}</div>`;
    }
  }

  async function gerar() {
    const btn = $("relSemGerar"), msg = $("relSemMsg");
    const de = $("relSemDe").value, ate = $("relSemAte").value;
    btn.disabled = true;
    msg.textContent = "Gerando…";
    try {
      const r = await fetch(`${window.location.origin}/relatorio-semanal/gerar`, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(de && ate ? { de, ate } : {}),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(r.status === 403 ? "Só ADM pode gerar na hora." : (d.error || `erro ${r.status}`));
      msg.textContent = `Pronto: ${d.nome}${d.rede ? " (copiado para a pasta da rede)" : d.erro_rede ? " (não consegui copiar para a rede: " + d.erro_rede + ")" : ""}${d.telegram ? " · enviado no Telegram" : ""}.`;
      listar();
    } catch (err) {
      msg.textContent = err.message || String(err);
    } finally {
      btn.disabled = false;
    }
  }

  window.relatorioSemanalAbrir = function () {
    fechar();
    const div = document.createElement("div");
    div.id = "relSemModal";
    div.style.cssText = "position:fixed;inset:0;z-index:995;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px;";
    div.innerHTML = `
      <div style="background:var(--bg-elevated,#fff);color:var(--text-primary,#111);border-radius:14px;padding:18px;width:min(560px,100%);max-height:90vh;overflow:auto;box-shadow:0 12px 40px rgba(0,0,0,.35);">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
          <div><div style="font-weight:800;font-size:16px;">📊 Relatório semanal</div>
            <div style="font-size:12px;color:var(--text-muted);">Sai sozinho toda segunda às 07:00 (semana anterior, de segunda a domingo): resumo comparado com a semana de antes, motoristas, lojas, problemas, material pendente e paradas sem registro. Também vai para a pasta da expedição no file server.</div></div>
          <button type="button" class="btn-ghost btn-sm" id="relSemFechar">✕</button>
        </div>
        <div id="relSemLista" style="margin-top:12px;"></div>
        <details class="admin-only-action" style="margin-top:10px;">
          <summary style="cursor:pointer;font-size:13px;font-weight:700;">Gerar agora (ADM)</summary>
          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-top:8px;">
            <label style="display:flex;flex-direction:column;font-size:11px;font-weight:700;">De<input type="date" id="relSemDe" style="font-size:14px;padding:6px;"></label>
            <label style="display:flex;flex-direction:column;font-size:11px;font-weight:700;">Até<input type="date" id="relSemAte" style="font-size:14px;padding:6px;"></label>
            <button type="button" class="btn-blue btn-sm" id="relSemGerar">Gerar</button>
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Em branco = semana passada. Gerar de novo a mesma semana substitui o arquivo.</div>
          <div id="relSemMsg" style="font-size:12px;margin-top:6px;"></div>
        </details>
      </div>`;
    document.body.appendChild(div);
    div.addEventListener("click", (e) => { if (e.target === div) fechar(); });
    div.addEventListener("keydown", (e) => { if (e.key === "Escape") fechar(); });
    $("relSemFechar").addEventListener("click", fechar);
    $("relSemGerar").addEventListener("click", gerar);
    listar();
  };
})();
