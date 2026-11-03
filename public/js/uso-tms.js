// ================================================================
// uso-tms.js — painel "📊 Uso do TMS" (aba TMS, abaixo dos KPIs)
// ----------------------------------------------------------------
// Responde "o time esta usando?": saida pelo BOTAO (na hora) x digitada
// depois, chegada/retorno registrados, quanto tempo depois da SAIDA DA LOJA o
// registro e lancado, e lojas que ficaram sem registro. Compara os ultimos 7
// dias com os 7 dias ANTES dos botoes (linha de base). Detalhe por dia e por
// pessoa — para orientar a equipe, nao para punir. Dados: GET /tms/uso.
// ================================================================
(function () {
  "use strict";

  const REFRESH_MS = 5 * 60 * 1000;
  let dados = null, carregadoEm = 0, carregando = false, aberto = false;

  const esc = (v) => (typeof window.escapar === "function" ? window.escapar(v == null ? "" : v) : String(v == null ? "" : v));
  const visivel = () => { const a = document.getElementById("aba-tms"); return a && !a.classList.contains("aba-hidden"); };
  const dataBR = (iso) => { const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}` : ""; };
  const fmtMin = (m) => (m == null ? "—" : m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${m} min`);
  const fmtPct = (p) => (p == null ? "—" : `${p}%`);
  const VERDE = "#16a34a", LARANJA = "#f97316", VERMELHO = "#dc2626", CINZA = "#64748b";

  // Cor pela meta (maior e melhor, salvo `menorMelhor`).
  function cor(valor, bom, ruim, menorMelhor = false) {
    if (valor == null) return CINZA;
    if (menorMelhor) return valor <= bom ? VERDE : valor >= ruim ? VERMELHO : LARANJA;
    return valor >= bom ? VERDE : valor <= ruim ? VERMELHO : LARANJA;
  }

  function cartao(titulo, valor, c, antes, dica) {
    return `<div title="${esc(dica)}" style="flex:1 1 150px;min-width:150px;border:1px solid var(--border-md,#ddd);border-left:4px solid ${c};
      border-radius:10px;padding:8px 10px;background:var(--bg-elevated,transparent);">
      <div style="font-size:11px;color:var(--text-muted);">${esc(titulo)}</div>
      <div style="font-size:20px;font-weight:800;color:${c};">${esc(valor)}</div>
      <div style="font-size:10.5px;color:var(--text-muted);">${esc(antes)}</div></div>`;
  }

  function tabela(cab, linhas) {
    return `<div style="overflow-x:auto;margin-top:8px;"><table data-ordenavel style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead><tr>${cab.map((c) => `<th style="text-align:left;padding:4px 6px;border-bottom:1px solid var(--border-md,#ddd);white-space:nowrap;">${esc(c)}</th>`).join("")}</tr></thead>
      <tbody>${linhas.map((l) => `<tr>${l.map((c) => `<td style="padding:4px 6px;border-bottom:1px solid var(--border,#eee);white-space:nowrap;">${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }

  function render() {
    const el = document.getElementById("tmsUsoPainel");
    if (!el || !dados) return;
    const r = dados.resumo || {}, a = dados.antes || {};
    const antes = (v, f) => `antes dos botões: ${v == null ? "—" : f(v)}`;
    const cartoes = [
      cartao("Saída pelo botão (na hora)", fmtPct(r.saida_botao_pct), cor(r.saida_botao_pct, 80, 40),
        `digitada depois: ${fmtPct(r.saida_ajuste_pct)}`, "Viagens com 🚚 Saiu clicado no momento da saída. Meta: 80%+"),
      cartao("Registro em até 30 min", fmtPct(r.registro_ate_30_pct), cor(r.registro_ate_30_pct, 70, 30),
        antes(a.registro_ate_30_pct, fmtPct), "Registros da loja lançados até 30 min depois da saída da loja"),
      cartao("Atraso típico do registro", fmtMin(r.registro_mediana_min), cor(r.registro_mediana_min, 30, 90, true),
        antes(a.registro_mediana_min, fmtMin), "Mediana: quanto tempo depois da saída da loja o registro é lançado"),
      cartao("Lojas sem registro", fmtPct(r.sem_registro_pct), cor(r.sem_registro_pct, 5, 20, true),
        antes(a.sem_registro_pct, fmtPct), "Paradas de viagens já iniciadas que terminaram o dia sem registro (só dias fechados)"),
      cartao("Chegou / Voltou", `${fmtPct(r.chegada_pct)} / ${fmtPct(r.retorno_pct)}`, cor(Math.min(r.chegada_pct ?? 0, r.retorno_pct ?? 0), 80, 40),
        "viagens com o marco registrado", "Viagens com 🧑 Chegou e 🏁 Voltou registrados"),
    ].join("");

    const detalhe = aberto ? (() => {
      const dias = [...(dados.dias || [])].reverse().map((d) => [
        esc(dataBR(d.d)), d.viagens ?? 0,
        `${d.saida_botao ?? 0} / ${d.saida_ajuste ?? 0}`, `${d.chegadas ?? 0} / ${d.retornos ?? 0}`,
        d.registros ?? 0, esc(fmtMin(d.registro_mediana_min)), esc(fmtPct(d.registro_ate_30_pct)), d.registro_rapido ?? 0,
        d.paradas ? `${d.sem_registro ?? 0} de ${d.paradas}` : "—",
      ]);
      const pessoas = (dados.pessoas || []).map((p) => [
        esc(p.nome), p.registros, `<b style="color:${cor(p.registro_mediana_min, 30, 90, true)}">${esc(fmtMin(p.registro_mediana_min))}</b>`,
        esc(fmtPct(p.registro_ate_30_pct)), p.rapidos, `${p.saidas_botao} / ${p.saidas_ajuste}`,
      ]);
      return `<div style="font-size:12px;font-weight:700;margin-top:10px;">Por dia</div>` +
        tabela(["Dia", "Viagens", "Saída botão / depois", "Chegou / Voltou", "Registros", "Atraso típico", "Até 30 min", "Pelo ✅ rápido", "Lojas sem registro"], dias) +
        `<div style="font-size:12px;font-weight:700;margin-top:12px;">Por pessoa</div>` +
        tabela(["Quem lançou", "Registros", "Atraso típico", "Até 30 min", "Pelo ✅ rápido", "Saída botão / depois"], pessoas) +
        `<div style="font-size:11px;color:var(--text-muted);margin-top:8px;">💡 O "✅ Entregue sem problema" no card da parada grava o registro em um clique, logo após a entrega.
          Para orientar a equipe, não para punir.</div>`;
    })() : "";

    el.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
        <div style="font-weight:800;">📊 Uso do TMS <span style="font-weight:400;font-size:12px;color:var(--text-muted);">últimos ${r.dias || 0} dia(s) desde ${esc(dataBR(dados.desde))} × 7 dias antes dos botões</span></div>
        <div style="display:flex;gap:6px;">
          <a href="/guia-tms.html" target="_blank" rel="noopener" class="btn-ghost btn-sm" style="text-decoration:none;" title="Passo a passo do dia da viagem (dá para imprimir)">❓ Guia rápido</a>
          <button type="button" class="btn-ghost btn-sm" onclick="tmsUsoAlternar()">${aberto ? "ocultar detalhes ▾" : "ver detalhes ▸"}</button>
          <button type="button" class="btn-ghost btn-sm" onclick="tmsUsoCarregar(true)" title="Atualizar">⟳</button>
        </div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;">${cartoes}</div>${detalhe}`;
  }

  async function carregar(forcar) {
    if (carregando || (!forcar && Date.now() - carregadoEm < REFRESH_MS)) return;
    const kpis = document.getElementById("tmsKpis");
    if (!kpis) return;
    let el = document.getElementById("tmsUsoPainel");
    if (!el) {
      el = document.createElement("section");
      el.id = "tmsUsoPainel";
      el.style.cssText = "margin:12px 0;padding:12px;border:1px solid var(--border-md,#ddd);border-radius:12px;";
      kpis.insertAdjacentElement("afterend", el);
    }
    carregando = true;
    try {
      const resp = await fetch(`${window.location.origin}/tms/uso?dias=30`, { headers: { Accept: "application/json" } });
      if (!resp.ok) { el.hidden = true; return; } // sem permissao/servidor antigo: some sem barulho
      dados = await resp.json();
      carregadoEm = Date.now();
      el.hidden = false;
      render();
    } catch (_) { /* tenta de novo no proximo ciclo */ } finally { carregando = false; }
  }

  window.tmsUsoCarregar = (forcar) => carregar(!!forcar);
  window.tmsUsoAlternar = () => { aberto = !aberto; render(); };

  // Carrega quando a aba TMS esta a vista; atualiza a cada 5 min e quando algo muda.
  setInterval(() => { if (visivel()) carregar(false); }, 30 * 1000);
  if (window.Bus && typeof window.Bus.on === "function") {
    window.Bus.on("dados:mudou", () => { if (visivel()) { carregadoEm = 0; setTimeout(() => carregar(false), 1500); } });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => visivel() && carregar(true));
  else if (visivel()) carregar(true);
})();
