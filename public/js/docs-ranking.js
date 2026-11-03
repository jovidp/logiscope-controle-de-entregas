// ================================================================
// RANKING SIMPLES DE DOCUMENTOS POR MOTORISTA
// Conta tacografos devolvidos, diarios preenchidos e checklists feitos
// e calcula uma pontuacao simples (entregas - nao entregas).
// Usa o cache local ja carregado (SERVER_CACHE via lerStorage).
// ================================================================

const docsState = { _chart: null };

function docsDataLimpa(v) {
  return String(v || "").split("T")[0];
}

function docsDentroIntervalo(d, ini, fim) {
  if (!d) return false;
  if (ini && d < ini) return false;
  if (fim && d > fim) return false;
  return true;
}

function docsNomeMotorista(v) {
  const nome =
    typeof window.canonizarMotorista === "function"
      ? window.canonizarMotorista(v)
      : String(v || "").trim();
  return String(nome || "").trim().toUpperCase();
}

function docsCalcular() {
  const ini = document.getElementById("docsDataInicio")?.value || "";
  const fim = document.getElementById("docsDataFim")?.value || "";

  const tacografos = (typeof lerStorage === "function" ? lerStorage(LS.tacografos) : []) || [];
  const diarios = (typeof lerStorage === "function" ? lerStorage(LS.diarios) : []) || [];
  const checklists = (typeof lerStorage === "function" ? lerStorage(LS.checklist) : []) || [];

  const filtrar = (lista) =>
    lista.filter((r) => docsDentroIntervalo(docsDataLimpa(r.data), ini, fim));

  const tac = filtrar(tacografos);
  const diar = filtrar(diarios);
  const ck = filtrar(checklists);

  const mapa = new Map();
  const obter = (nome) => {
    const chave = docsNomeMotorista(nome);
    if (!chave) return null;
    if (!mapa.has(chave)) {
      mapa.set(chave, {
        motorista: chave,
        tacOk: 0, tacFalha: 0,
        diarioOk: 0, diarioFalha: 0,
        // Checklist conta DIA, nao linha: a tela promete "1x por dia" mas nada
        // impede lancar o mesmo dia duas vezes, e contando por linha o
        // motorista que repetiu subia no ranking por ter digitado de novo.
        ckDias: new Set(),
        ckOk: 0,
        score: 0,
        diasComRegistro: new Set(),
      });
    }
    return mapa.get(chave);
  };

  tac.forEach((r) => {
    const m = obter(r.motorista);
    if (!m) return;
    m.diasComRegistro.add(docsDataLimpa(r.data));
    if (r.status === "Devolveu") m.tacOk++;
    else if (r.status === "Não devolveu") m.tacFalha++;
  });

  diar.forEach((r) => {
    const m = obter(r.motorista);
    if (!m) return;
    m.diasComRegistro.add(docsDataLimpa(r.data));
    if (r.status === "Preencheu") m.diarioOk++;
    else if (r.status === "Não preencheu") m.diarioFalha++;
  });

  ck.forEach((r) => {
    const m = obter(r.motorista);
    if (!m) return;
    m.diasComRegistro.add(docsDataLimpa(r.data));
    m.ckDias.add(docsDataLimpa(r.data));
  });
  // ckOk sai do Set: dois checklists do mesmo motorista no mesmo dia valem 1.
  mapa.forEach((m) => { m.ckOk = m.ckDias.size; });

  // Pontuacao simples: +1 por entrega, -1 por falha. Checklist nao tem
  // status de falha (so existe ou nao existe), entao so soma positivamente.
  const dados = [...mapa.values()].map((d) => {
    const positivos = d.tacOk + d.diarioOk + d.ckOk;
    const negativos = d.tacFalha + d.diarioFalha;
    const score = positivos - negativos;
    const dias = d.diasComRegistro.size;
    const totalPossivel = positivos + negativos;
    const taxa = totalPossivel > 0 ? Math.round((positivos / totalPossivel) * 100) : 0;
    return { ...d, positivos, negativos, score, dias, taxa };
  })
    .filter((d) => d.positivos > 0 || d.negativos > 0)
    .sort((a, b) => b.score - a.score || b.taxa - a.taxa);

  docsRenderKpis(dados);
  docsRenderPodio(dados);
  docsRenderTabela(dados);
  docsRenderGrafico(dados);
}

function docsRenderKpis(dados) {
  const el = document.getElementById("docsKpis");
  if (!el) return;
  const totalMot = dados.length;
  const totalOk = dados.reduce((s, d) => s + d.positivos, 0);
  const totalFalha = dados.reduce((s, d) => s + d.negativos, 0);
  const totalPossivel = totalOk + totalFalha;
  const taxaGeral = totalPossivel > 0 ? Math.round((totalOk / totalPossivel) * 100) : 0;
  const cards = [
    ["Motoristas avaliados", totalMot, "#6366f1"],
    ["Entregas (✓)", totalOk, "#22c55e"],
    ["Não entregas (✗)", totalFalha, "#ef4444"],
    ["Taxa de cumprimento", `${taxaGeral}%`, taxaGeral >= 80 ? "#22c55e" : taxaGeral >= 50 ? "#f59e0b" : "#ef4444"],
  ];
  el.innerHTML = cards.map(([label, valor, cor]) =>
    `<div class="tms-kpi" style="border-left:3px solid ${cor};">
       <strong style="color:${cor};font-size:25px;">${escapar(String(valor))}</strong>
       <span>${label}</span>
     </div>`).join("");
}

function docsRenderPodio(dados) {
  const el = document.getElementById("docsPodio");
  if (!el) return;
  if (!dados.length) {
    el.innerHTML = `<p style="color:var(--text-muted);padding:14px 0;">Sem dados no período selecionado.</p>`;
    return;
  }
  const top = dados.slice(0, 3);
  const bottom = dados.slice(-3).reverse();
  const cartao = (d, pos, tipo) => {
    const icone = tipo === "top"
      ? (pos === 0 ? "🥇" : pos === 1 ? "🥈" : "🥉")
      : "⚠️";
    const cor = tipo === "top" ? "var(--verde)" : "var(--vermelho)";
    const bg = tipo === "top" ? "rgba(52,211,153,0.08)" : "rgba(248,113,113,0.08)";
    const borda = tipo === "top" ? "rgba(52,211,153,0.25)" : "rgba(248,113,113,0.25)";
    return `
      <div style="background:${bg};border:1px solid ${borda};border-radius:12px;padding:14px 16px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
          <span style="font-size:1.4rem;">${icone}</span>
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:700;color:var(--text-heading);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapar(d.motorista)}</div>
            <div style="font-size:11px;color:var(--text-muted);">${d.dias} dia(s) com registro</div>
          </div>
          <span style="font-size:1.2rem;font-weight:800;color:${cor};">${d.score > 0 ? "+" : ""}${d.score}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;font-size:11px;text-align:center;">
          <div style="background:rgba(255,255,255,0.04);border-radius:7px;padding:6px 4px;">
            <div style="font-weight:800;color:var(--text-heading);">${d.tacOk}/${d.tacOk + d.tacFalha}</div>
            <div style="color:var(--text-muted);">Tacógrafo</div>
          </div>
          <div style="background:rgba(255,255,255,0.04);border-radius:7px;padding:6px 4px;">
            <div style="font-weight:800;color:var(--text-heading);">${d.diarioOk}/${d.diarioOk + d.diarioFalha}</div>
            <div style="color:var(--text-muted);">Diário</div>
          </div>
          <div style="background:rgba(255,255,255,0.04);border-radius:7px;padding:6px 4px;">
            <div style="font-weight:800;color:var(--text-heading);">${d.ckOk}</div>
            <div style="color:var(--text-muted);">Checklist</div>
          </div>
        </div>
      </div>`;
  };

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
      <div>
        <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:var(--verde);margin-bottom:10px;">🏆 Melhores</div>
        <div style="display:grid;gap:10px;">${top.map((d, i) => cartao(d, i, "top")).join("")}</div>
      </div>
      <div>
        <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:var(--vermelho);margin-bottom:10px;">⚠️ Piores</div>
        <div style="display:grid;gap:10px;">${bottom.map((d, i) => cartao(d, i, "bottom")).join("")}</div>
      </div>
    </div>`;
}

function docsRenderTabela(dados) {
  const el = document.getElementById("docsTabela");
  if (!el) return;
  if (!dados.length) { el.innerHTML = ""; return; }
  const linhas = dados.map((d, i) => {
    const corScore = d.score >= 0 ? "var(--verde)" : "var(--vermelho)";
    const corTaxa = d.taxa >= 80 ? "var(--verde)" : d.taxa >= 50 ? "var(--amarelo)" : "var(--vermelho)";
    return `<tr style="border-bottom:1px solid var(--border);">
      <td style="padding:10px 12px;text-align:center;font-weight:800;color:var(--text-muted);">${i + 1}</td>
      <td style="padding:10px 12px;font-weight:700;color:var(--text-heading);">${escapar(d.motorista)}</td>
      <td style="padding:10px 12px;text-align:center;color:var(--text-muted);">${d.dias}</td>
      <td style="padding:10px 12px;text-align:center;">
        <span style="color:var(--verde);font-weight:700;">${d.tacOk}</span>
        <span style="color:var(--text-muted);"> / </span>
        <span style="color:${d.tacFalha > 0 ? "var(--vermelho)" : "var(--text-muted)"};font-weight:700;">${d.tacFalha}</span>
      </td>
      <td style="padding:10px 12px;text-align:center;">
        <span style="color:var(--verde);font-weight:700;">${d.diarioOk}</span>
        <span style="color:var(--text-muted);"> / </span>
        <span style="color:${d.diarioFalha > 0 ? "var(--vermelho)" : "var(--text-muted)"};font-weight:700;">${d.diarioFalha}</span>
      </td>
      <td style="padding:10px 12px;text-align:center;color:var(--azul);font-weight:700;">${d.ckOk}</td>
      <td style="padding:10px 12px;text-align:center;">
        <span style="font-weight:800;color:${corTaxa};">${d.taxa}%</span>
      </td>
      <td style="padding:10px 12px;text-align:center;">
        <span style="background:${d.score >= 0 ? "rgba(52,211,153,0.10)" : "rgba(248,113,113,0.10)"};border:1px solid ${d.score >= 0 ? "rgba(52,211,153,0.3)" : "rgba(248,113,113,0.3)"};color:${corScore};font-weight:800;font-size:13px;padding:3px 10px;border-radius:8px;">${d.score > 0 ? "+" : ""}${d.score}</span>
      </td>
    </tr>`;
  }).join("");
  el.innerHTML = `
    <div style="overflow-x:auto;background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;">
      <table data-ordenavel style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead>
          <tr style="background:rgba(255,255,255,0.03);border-bottom:2px solid var(--border);">
            <th style="padding:10px 12px;text-align:center;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">#</th>
            <th style="padding:10px 12px;text-align:left;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Motorista</th>
            <th style="padding:10px 12px;text-align:center;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Dias</th>
            <th style="padding:10px 12px;text-align:center;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Tacógrafo ✓/✗</th>
            <th style="padding:10px 12px;text-align:center;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Diário ✓/✗</th>
            <th style="padding:10px 12px;text-align:center;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Checklist</th>
            <th style="padding:10px 12px;text-align:center;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Taxa</th>
            <th style="padding:10px 12px;text-align:center;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Score</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>`;
}

function docsRenderGrafico(dados) {
  const canvas = document.getElementById("docsGrafico");
  if (!canvas || typeof Chart === "undefined") return;
  if (docsState._chart) { docsState._chart.destroy(); docsState._chart = null; }
  if (!dados.length) return;

  const top = dados.slice(0, 15);
  const labels = top.map((d) => d.motorista);

  docsState._chart = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Entregues (✓)",
          data: top.map((d) => d.positivos),
          backgroundColor: "rgba(52,211,153,0.55)",
          borderColor: "rgba(52,211,153,0.9)",
          borderWidth: 1,
          borderRadius: 4,
        },
        {
          label: "Não entregues (✗)",
          data: top.map((d) => d.negativos),
          backgroundColor: "rgba(248,113,113,0.55)",
          borderColor: "rgba(248,113,113,0.9)",
          borderWidth: 1,
          borderRadius: 4,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: "#94a3b8", font: { size: 11 } } },
      },
      scales: {
        x: {
          stacked: true,
          ticks: { color: "#64748b", font: { size: 10 }, precision: 0 },
          grid: { color: "rgba(255,255,255,0.05)" },
        },
        y: {
          stacked: true,
          ticks: { color: "#94a3b8", font: { size: 11 } },
          grid: { display: false },
        },
      },
    },
  });
}

function docsLimparFiltro() {
  const ini = document.getElementById("docsDataInicio");
  const fim = document.getElementById("docsDataFim");
  if (ini) ini.value = "";
  if (fim) fim.value = "";
  docsCalcular();
}

function docsInit() {
  // Pre-popula com ultimos 30 dias se vazio.
  const ini = document.getElementById("docsDataInicio");
  const fim = document.getElementById("docsDataFim");
  if (ini && !ini.value && typeof hojeISO === "function") {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    ini.value = d.toISOString().split("T")[0];
  }
  if (fim && !fim.value && typeof hojeISO === "function") {
    fim.value = hojeISO();
  }
  docsCalcular();
}

window.docsCalcular = docsCalcular;
window.docsLimparFiltro = docsLimparFiltro;
window.docsInit = docsInit;
