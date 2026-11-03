// ================================================================
// ABA "ATRASOS" — Motoristas que mais atrasam
// Alimentada pelas OCORRENCIAS (obterOcorrenciasAtivas): conta os
// registros cujo tipo_problema contem "Atraso" e agrupa por motorista,
// com a media de atraso (min) via hora_agendada_loja -> hora_chegada.
// Respeita o intervalo de datas dos filtros da aba.
// ================================================================

const atrasosState = { _chart: null, _dados: [] };

function atrasosDataLimpa(v) {
  return String(v || "").split("T")[0];
}

function atrasosDentroIntervalo(d, ini, fim) {
  if (!d) return false;
  if (ini && d < ini) return false;
  if (fim && d > fim) return false;
  return true;
}

function atrasosFmtData(iso) {
  const s = atrasosDataLimpa(iso);
  if (!s) return "—";
  const [y, m, d] = s.split("-");
  return d && m && y ? `${d}/${m}/${y}` : s;
}

function atrasosMin(o) {
  return typeof calcularPermanencia === "function"
    ? calcularPermanencia(o.hora_agendada_loja, o.hora_chegada)
    : 0;
}

function atrasosNomeLoja(loja) {
  if (typeof formatarNomeLoja === "function") return formatarNomeLoja(loja);
  return loja || "—";
}

function atrasosCalcular() {
  const ini = document.getElementById("atrasosDataInicio")?.value || "";
  const fim = document.getElementById("atrasosDataFim")?.value || "";

  const ocorrencias =
    typeof obterOcorrenciasAtivas === "function" ? obterOcorrenciasAtivas() : [];
  const temAtraso = (o) => /atraso/i.test(String(o.tipo_problema || ""));
  const dataDe = (o) => atrasosDataLimpa(o.data_ocorrencia || o.data);

  const mapa = new Map();
  ocorrencias.forEach((o) => {
    if (!temAtraso(o)) return;
    const dia = dataDe(o);
    if (!atrasosDentroIntervalo(dia, ini, fim)) return;
    const nome = String(o.motorista || "").trim();
    const chave = (nome || "Não informado").toUpperCase();
    if (!mapa.has(chave)) {
      mapa.set(chave, {
        chave,
        motorista: nome || "Não informado",
        qtd: 0,
        somaMin: 0,
        nMin: 0,
        ultima: "",
      });
    }
    const m = mapa.get(chave);
    m.qtd++;
    const min = atrasosMin(o);
    if (min > 0) {
      m.somaMin += min;
      m.nMin++;
    }
    if (dia > m.ultima) m.ultima = dia;
  });

  const media = (d) => (d.nMin > 0 ? Math.round(d.somaMin / d.nMin) : 0);
  const dados = [...mapa.values()]
    .map((d) => ({ ...d, media: media(d) }))
    .sort((a, b) => b.media - a.media || b.qtd - a.qtd);

  atrasosState._dados = dados;
  atrasosState._ini = ini;
  atrasosState._fim = fim;

  const totQtd = dados.reduce((s, d) => s + d.qtd, 0);
  const totN = dados.reduce((s, d) => s + d.nMin, 0);
  const totSoma = dados.reduce((s, d) => s + d.somaMin, 0);
  const mediaGeral = totN > 0 ? Math.round(totSoma / totN) : 0;

  const vazio = document.getElementById("atrasosVazio");
  if (vazio) vazio.style.display = dados.length ? "none" : "block";
  atrasosFecharDetalhe();

  atrasosRenderKpis(dados, totQtd, mediaGeral);
  atrasosRenderPodio(dados);
  atrasosRenderTabela(dados);
  atrasosRenderGrafico(dados);
}

function atrasosRenderKpis(dados, totQtd, mediaGeral) {
  const el = document.getElementById("atrasosKpis");
  if (!el) return;
  const pior = dados[0];
  const cards = [
    ["Motoristas com atraso", dados.length, "#6366f1"],
    ["Total de atrasos", totQtd, "#f97316"],
    ["Média geral de atraso", `${mediaGeral} min`, "#fb923c"],
    [
      "Maior média de atraso",
      pior && pior.nMin > 0 ? `${pior.motorista} (${pior.media} min)` : "—",
      "#ef4444",
    ],
  ];
  el.innerHTML = cards
    .map(
      ([label, valor, cor]) =>
        `<div class="tms-kpi" style="border-left:3px solid ${cor};">
           <strong style="color:${cor};font-size:22px;">${escapar(String(valor))}</strong>
           <span>${label}</span>
         </div>`,
    )
    .join("");
}

function atrasosRenderPodio(dados) {
  const el = document.getElementById("atrasosPodio");
  if (!el) return;
  if (!dados.length) {
    el.innerHTML = "";
    return;
  }
  const top = dados.slice(0, 3);
  const medalha = (i) => (i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉");
  const cartao = (d, i) => `
    <div style="background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.25);border-radius:12px;padding:14px 16px;">
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:1.4rem;">${medalha(i)}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:700;color:var(--text-heading);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapar(d.motorista)}</div>
          <div style="font-size:11px;color:var(--text-muted);">${d.qtd} atraso(s) · último ${atrasosFmtData(d.ultima)}</div>
        </div>
        <span style="font-size:1.3rem;font-weight:800;color:var(--vermelho);white-space:nowrap;">${d.nMin > 0 ? `${d.media} min` : "—"}</span>
      </div>
    </div>`;
  el.innerHTML = `
    <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:var(--vermelho);margin-bottom:10px;">⚠️ Maior média de atraso</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;">${top.map(cartao).join("")}</div>`;
}

function atrasosRenderTabela(dados) {
  const el = document.getElementById("atrasosTabela");
  if (!el) return;
  if (!dados.length) {
    el.innerHTML = "";
    return;
  }
  const linhas = dados
    .map((d, i) => {
      const corMedia =
        d.media >= 30
          ? "rgba(248,113,113,0.10)"
          : d.media >= 15
            ? "rgba(245,158,11,0.10)"
            : "rgba(52,211,153,0.10)";
      const corMediaBorda =
        d.media >= 30
          ? "rgba(248,113,113,0.3)"
          : d.media >= 15
            ? "rgba(245,158,11,0.3)"
            : "rgba(52,211,153,0.3)";
      const corMediaTexto =
        d.media >= 30
          ? "var(--vermelho)"
          : d.media >= 15
            ? "var(--amarelo)"
            : "var(--verde)";
      return `<tr style="border-bottom:1px solid var(--border);cursor:pointer;" onclick="atrasosMostrarDetalhe(${i})">
        <td style="padding:10px 12px;text-align:center;font-weight:800;color:var(--text-muted);">${i + 1}</td>
        <td style="padding:10px 12px;font-weight:700;color:var(--text-heading);">${escapar(d.motorista)}</td>
        <td style="padding:10px 12px;text-align:center;">${d.nMin > 0 ? `<span style="background:${corMedia};border:1px solid ${corMediaBorda};color:${corMediaTexto};font-weight:800;font-size:13px;padding:3px 10px;border-radius:8px;">${d.media} min</span>` : `<span style="color:var(--text-muted);">—</span>`}</td>
        <td style="padding:10px 12px;text-align:center;color:var(--laranja,#fb923c);font-weight:700;">${d.qtd}</td>
        <td style="padding:10px 12px;text-align:center;color:var(--text-muted);">${atrasosFmtData(d.ultima)}</td>
      </tr>`;
    })
    .join("");
  el.innerHTML = `
    <div style="overflow-x:auto;background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;">
      <table data-ordenavel style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead>
          <tr style="background:rgba(255,255,255,0.03);border-bottom:2px solid var(--border);">
            <th style="padding:10px 12px;text-align:center;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">#</th>
            <th style="padding:10px 12px;text-align:left;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Motorista</th>
            <th style="padding:10px 12px;text-align:center;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Média de atraso</th>
            <th style="padding:10px 12px;text-align:center;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Atrasos</th>
            <th style="padding:10px 12px;text-align:center;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Último atraso</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>`;
}

function atrasosRenderGrafico(dados) {
  const canvas = document.getElementById("atrasosGrafico");
  if (atrasosState._chart) {
    atrasosState._chart.destroy();
    atrasosState._chart = null;
  }
  if (!canvas || typeof Chart === "undefined" || !dados.length) return;

  const top = dados.slice(0, 15);
  atrasosState._chart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: top.map((d) => d.motorista),
      datasets: [
        {
          label: "Média de atraso (min)",
          data: top.map((d) => d.media),
          backgroundColor: "rgba(251,146,60,0.45)",
          borderColor: "rgba(251,146,60,0.95)",
          borderWidth: 1,
          borderRadius: 4,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      onClick: (evt, els) => {
        if (els.length) atrasosMostrarDetalhe(els[0].index);
      },
      onHover: (evt, els) => {
        evt.native.target.style.cursor = els.length ? "pointer" : "default";
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            afterLabel: (ctx) => {
              const d = top[ctx.dataIndex];
              if (!d) return "";
              return d.nMin > 0
                ? `${d.qtd} atraso(s) com horário`
                : "Sem horários para calcular a média";
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { color: "#64748b", font: { size: 10 }, precision: 0 },
          grid: { color: "rgba(255,255,255,0.05)" },
        },
        y: {
          ticks: { color: "#94a3b8", font: { size: 11 } },
          grid: { display: false },
        },
      },
    },
  });
}

function atrasosMostrarDetalhe(indice) {
  const d = atrasosState._dados[indice];
  const shell = document.getElementById("atrasosDetalhe");
  const titulo = document.getElementById("atrasosDetalheTitulo");
  const conteudo = document.getElementById("atrasosDetalheConteudo");
  if (!d || !shell || !conteudo) return;

  // Puxa TODAS as lojas que o motorista fez no periodo (nao so os atrasos),
  // com rota, horarios e tempo gasto na loja (chegada -> saida da loja).
  const ocorrencias =
    typeof obterOcorrenciasAtivas === "function" ? obterOcorrenciasAtivas() : [];
  const dataDe = (o) => atrasosDataLimpa(o.data_ocorrencia || o.data);
  const rotaDe = (o) =>
    typeof obterRotaDaOcorrencia === "function"
      ? obterRotaDaOcorrencia(o)
      : o.rota_nome || o.rota || "—";
  const calcMin = (a, b) =>
    typeof calcularPermanencia === "function" ? calcularPermanencia(a, b) : 0;
  const hhmm = (t) => {
    const s = String(t || "").trim();
    return s ? s.slice(0, 5) : "—";
  };
  const fmtTempo = (m) =>
    m > 0 ? (typeof formatarTempo === "function" ? formatarTempo(m) : `${m}min`) : "—";

  const regs = ocorrencias
    .filter(
      (o) =>
        (String(o.motorista || "").trim() || "Não informado").toUpperCase() ===
          d.chave && atrasosDentroIntervalo(dataDe(o), atrasosState._ini, atrasosState._fim),
    )
    .sort((a, b) => {
      const da = dataDe(a);
      const db = dataDe(b);
      // Dias mais recentes primeiro; dentro do dia, ordem da rota (chegada crescente).
      if (da !== db) return db.localeCompare(da);
      return String(a.hora_chegada || "").localeCompare(
        String(b.hora_chegada || ""),
      );
    });

  if (titulo) {
    titulo.textContent = `📋 ${d.motorista} — ${regs.length} loja(s) no período · ${d.qtd} atraso(s)${d.nMin > 0 ? ` · média ${d.media} min` : ""}`;
  }

  const linhas = regs
    .map((o) => {
      const tempoLoja = calcMin(o.hora_chegada, o.fim_descarga);
      const atraso = calcMin(o.hora_agendada_loja, o.hora_chegada);
      return `<tr style="border-bottom:1px solid var(--border);">
        <td style="padding:8px 12px;color:var(--text-muted);white-space:nowrap;">${atrasosFmtData(dataDe(o))}</td>
        <td style="padding:8px 12px;font-weight:700;color:var(--text-heading);white-space:nowrap;">${escapar(rotaDe(o) || "—")}</td>
        <td style="padding:8px 12px;color:var(--azul);">${escapar(atrasosNomeLoja(o.loja) || "—")}</td>
        <td style="padding:8px 12px;text-align:center;white-space:nowrap;">${hhmm(o.hora_chegada)}</td>
        <td style="padding:8px 12px;text-align:center;white-space:nowrap;">${hhmm(o.fim_descarga)}</td>
        <td style="padding:8px 12px;text-align:center;white-space:nowrap;font-weight:700;color:var(--text-heading);">${fmtTempo(tempoLoja)}</td>
        <td style="padding:8px 12px;text-align:center;white-space:nowrap;font-weight:700;color:${atraso > 0 ? "var(--laranja,#fb923c)" : "var(--text-muted)"};">${atraso > 0 ? `${atraso} min` : "—"}</td>
      </tr>`;
    })
    .join("");

  conteudo.innerHTML = `
    <div style="overflow-x:auto;">
      <table data-ordenavel style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead>
          <tr style="background:rgba(255,255,255,0.03);border-bottom:2px solid var(--border);">
            <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Data</th>
            <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Rota</th>
            <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Loja</th>
            <th style="padding:8px 12px;text-align:center;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Chegada</th>
            <th style="padding:8px 12px;text-align:center;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Saída da loja</th>
            <th style="padding:8px 12px;text-align:center;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Tempo na loja</th>
            <th style="padding:8px 12px;text-align:center;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Atraso</th>
          </tr>
        </thead>
        <tbody>${linhas || `<tr><td colspan="7" style="padding:14px;text-align:center;color:var(--text-muted);">Sem lojas registradas no período.</td></tr>`}</tbody>
      </table>
    </div>`;
  shell.style.display = "block";
  shell.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function atrasosFecharDetalhe() {
  const shell = document.getElementById("atrasosDetalhe");
  if (shell) shell.style.display = "none";
}

function atrasosLimparFiltro() {
  const ini = document.getElementById("atrasosDataInicio");
  const fim = document.getElementById("atrasosDataFim");
  if (ini) ini.value = "";
  if (fim) fim.value = "";
  atrasosCalcular();
}

function atrasosInit() {
  // Pre-popula com os ultimos 30 dias quando vazio.
  const ini = document.getElementById("atrasosDataInicio");
  const fim = document.getElementById("atrasosDataFim");
  if (ini && !ini.value) {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    ini.value = d.toISOString().split("T")[0];
  }
  if (fim && !fim.value) {
    fim.value = typeof hojeISO === "function" ? hojeISO() : new Date().toISOString().split("T")[0];
  }
  atrasosCalcular();
}

window.atrasosCalcular = atrasosCalcular;
window.atrasosLimparFiltro = atrasosLimparFiltro;
window.atrasosMostrarDetalhe = atrasosMostrarDetalhe;
window.atrasosFecharDetalhe = atrasosFecharDetalhe;
window.atrasosInit = atrasosInit;
