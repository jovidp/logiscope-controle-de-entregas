// ================================================================
// ABA "SAÍDA FÁBRICA" — Motoristas que mais atrasam a saída da fábrica
// Alimentada pelos registros de "Atraso na saída da fábrica"
// (LS.atrasos -> /atrasos-saida). Cada registro é UMA saída de fábrica
// (motorista/placa/dia), com hora marcada x hora real. O atraso já vem
// calculado em atrasoMin; usamos como fallback horaReal - horaMarcada.
// Agrupa por motorista e ranqueia por: média de atraso, quantidade de
// saídas atrasadas ou total de minutos. Respeita o intervalo de datas.
// Espelha a aba "Atrasos" (atrasos-motoristas.js) pra ficar consistente.
// ================================================================

const saidaFabState = { _chart: null, _dados: [], _ini: "", _fim: "", _rank: "media" };

function saidaFabDataLimpa(v) {
  return String(v || "").split("T")[0];
}

function saidaFabDentroIntervalo(d, ini, fim) {
  if (!d) return false;
  if (ini && d < ini) return false;
  if (fim && d > fim) return false;
  return true;
}

function saidaFabFmtData(iso) {
  const s = saidaFabDataLimpa(iso);
  if (!s) return "—";
  const [y, m, d] = s.split("-");
  return d && m && y ? `${d}/${m}/${y}` : s;
}

function saidaFabHHMM(t) {
  const s = String(t || "").trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Minutos de atraso de UM registro. Usa atrasoMin quando presente (0 é válido:
// significa "saiu no horário"); só recalcula quando o campo não veio.
function saidaFabAtrasoReg(a) {
  const raw = a.atrasoMin;
  if (raw !== undefined && raw !== null && raw !== "" && Number.isFinite(Number(raw))) {
    return Math.max(0, Number(raw));
  }
  const marc = saidaFabHHMM(a.horaMarcada);
  const real = saidaFabHHMM(a.horaReal);
  if (marc == null || real == null) return 0;
  return Math.max(0, real - marc);
}

function saidaFabFmtTempo(m) {
  if (!(m > 0)) return "—";
  return typeof formatarTempo === "function" ? formatarTempo(m) : `${m}min`;
}

function saidaFabCalcular() {
  const ini = document.getElementById("saidaFabDataInicio")?.value || "";
  const fim = document.getElementById("saidaFabDataFim")?.value || "";
  const rank = document.getElementById("saidaFabRankBy")?.value || "media";

  const registros = typeof lerStorage === "function" ? lerStorage(LS.atrasos) : [];
  const dataDe = (a) => saidaFabDataLimpa(a.data);

  const mapa = new Map();
  registros.forEach((a) => {
    const dia = dataDe(a);
    if (!saidaFabDentroIntervalo(dia, ini, fim)) return;
    const nome = String(a.motorista || "").trim();
    const chave = (nome || "Não informado").toUpperCase();
    if (!mapa.has(chave)) {
      mapa.set(chave, {
        chave,
        motorista: nome || "Não informado",
        total: 0, // saídas registradas
        atrasadas: 0, // saídas com atraso > 0
        somaMin: 0, // soma dos minutos de atraso (só atrasadas)
        maior: 0, // maior atraso pontual
        ultima: "",
      });
    }
    const m = mapa.get(chave);
    m.total++;
    const min = saidaFabAtrasoReg(a);
    if (min > 0) {
      m.atrasadas++;
      m.somaMin += min;
      if (min > m.maior) m.maior = min;
    }
    if (dia > m.ultima) m.ultima = dia;
  });

  const dados = [...mapa.values()].map((d) => ({
    ...d,
    media: d.atrasadas > 0 ? Math.round(d.somaMin / d.atrasadas) : 0,
    pontualidade: d.total > 0 ? Math.round(((d.total - d.atrasadas) / d.total) * 100) : 0,
  }));

  saidaFabOrdenar(dados, rank);

  saidaFabState._dados = dados;
  saidaFabState._ini = ini;
  saidaFabState._fim = fim;
  saidaFabState._rank = rank;

  const totAtrasadas = dados.reduce((s, d) => s + d.atrasadas, 0);
  const totSaidas = dados.reduce((s, d) => s + d.total, 0);
  const totSoma = dados.reduce((s, d) => s + d.somaMin, 0);
  const mediaGeral = totAtrasadas > 0 ? Math.round(totSoma / totAtrasadas) : 0;
  const comAtraso = dados.filter((d) => d.atrasadas > 0).length;

  const vazio = document.getElementById("saidaFabVazio");
  if (vazio) vazio.style.display = dados.length ? "none" : "block";
  saidaFabFecharDetalhe();

  saidaFabRenderKpis(comAtraso, totAtrasadas, totSaidas, mediaGeral);
  saidaFabRenderPodio(dados);
  saidaFabRenderTabela(dados);
  saidaFabRenderGrafico(dados);
}

// Ordena in-place conforme a métrica escolhida (média / quantidade / total).
function saidaFabOrdenar(dados, rank) {
  if (rank === "qtd") {
    dados.sort((a, b) => b.atrasadas - a.atrasadas || b.media - a.media);
  } else if (rank === "total") {
    dados.sort((a, b) => b.somaMin - a.somaMin || b.atrasadas - a.atrasadas);
  } else {
    dados.sort((a, b) => b.media - a.media || b.atrasadas - a.atrasadas);
  }
}

function saidaFabValorRank(d, rank) {
  if (rank === "qtd") return d.atrasadas;
  if (rank === "total") return d.somaMin;
  return d.media;
}

function saidaFabRenderKpis(comAtraso, totAtrasadas, totSaidas, mediaGeral) {
  const el = document.getElementById("saidaFabKpis");
  if (!el) return;
  const pior = saidaFabState._dados.find((d) => d.atrasadas > 0);
  const cards = [
    ["Motoristas que atrasaram", comAtraso, "#a855f7"],
    ["Saídas atrasadas", `${totAtrasadas} de ${totSaidas}`, "#f97316"],
    ["Média geral de atraso", `${mediaGeral} min`, "#fb923c"],
    [
      "Pior motorista",
      pior ? `${pior.motorista} (${pior.media} min)` : "—",
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

function saidaFabRenderPodio(dados) {
  const el = document.getElementById("saidaFabPodio");
  if (!el) return;
  const top = dados.filter((d) => d.atrasadas > 0).slice(0, 3);
  if (!top.length) {
    el.innerHTML = "";
    return;
  }
  const medalha = (i) => (i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉");
  const rank = saidaFabState._rank;
  const destaque = (d) =>
    rank === "qtd"
      ? `${d.atrasadas} atraso(s)`
      : rank === "total"
        ? saidaFabFmtTempo(d.somaMin)
        : `${d.media} min`;
  const cartao = (d, i) => `
    <div style="background:rgba(168,85,247,0.08);border:1px solid rgba(168,85,247,0.25);border-radius:12px;padding:14px 16px;">
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:1.4rem;">${medalha(i)}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:700;color:var(--text-heading);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapar(d.motorista)}</div>
          <div style="font-size:11px;color:var(--text-muted);">${d.atrasadas}/${d.total} saída(s) atrasada(s) · último ${saidaFabFmtData(d.ultima)}</div>
        </div>
        <span style="font-size:1.3rem;font-weight:800;color:#c084fc;white-space:nowrap;">${destaque(d)}</span>
      </div>
    </div>`;
  el.innerHTML = `
    <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:#c084fc;margin-bottom:10px;">🏭 Quem mais atrasa a saída da fábrica</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;">${top.map(cartao).join("")}</div>`;
}

function saidaFabRenderTabela(dados) {
  const el = document.getElementById("saidaFabTabela");
  if (!el) return;
  if (!dados.length) {
    el.innerHTML = "";
    return;
  }
  const corDe = (media, base) =>
    media >= 30
      ? `rgba(248,113,113,${base})`
      : media >= 15
        ? `rgba(245,158,11,${base})`
        : `rgba(52,211,153,${base})`;
  const corTexto = (media) =>
    media >= 30 ? "var(--vermelho)" : media >= 15 ? "var(--amarelo)" : "var(--verde)";
  const corPont = (p) =>
    p >= 90 ? "var(--verde)" : p >= 70 ? "var(--amarelo)" : "var(--vermelho)";

  const linhas = dados
    .map((d, i) => {
      return `<tr style="border-bottom:1px solid var(--border);cursor:pointer;" onclick="saidaFabMostrarDetalhe(${i})">
        <td style="padding:10px 12px;text-align:center;font-weight:800;color:var(--text-muted);">${i + 1}</td>
        <td style="padding:10px 12px;font-weight:700;color:var(--text-heading);">${escapar(d.motorista)}</td>
        <td style="padding:10px 12px;text-align:center;">${d.atrasadas > 0 ? `<span style="background:${corDe(d.media, 0.1)};border:1px solid ${corDe(d.media, 0.3)};color:${corTexto(d.media)};font-weight:800;font-size:13px;padding:3px 10px;border-radius:8px;">${d.media} min</span>` : `<span style="color:var(--text-muted);">—</span>`}</td>
        <td style="padding:10px 12px;text-align:center;color:var(--laranja,#fb923c);font-weight:700;">${d.atrasadas}</td>
        <td style="padding:10px 12px;text-align:center;color:var(--text-muted);">${d.total}</td>
        <td style="padding:10px 12px;text-align:center;font-weight:700;color:${corPont(d.pontualidade)};">${d.pontualidade}%</td>
        <td style="padding:10px 12px;text-align:center;color:var(--text-heading);font-weight:700;">${saidaFabFmtTempo(d.maior)}</td>
        <td style="padding:10px 12px;text-align:center;color:var(--text-muted);">${saidaFabFmtData(d.ultima)}</td>
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
            <th style="padding:10px 12px;text-align:center;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Saídas atrasadas</th>
            <th style="padding:10px 12px;text-align:center;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Total de saídas</th>
            <th style="padding:10px 12px;text-align:center;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Pontualidade</th>
            <th style="padding:10px 12px;text-align:center;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Maior atraso</th>
            <th style="padding:10px 12px;text-align:center;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Última saída</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>`;
}

function saidaFabRenderGrafico(dados) {
  const canvas = document.getElementById("saidaFabGrafico");
  if (saidaFabState._chart) {
    saidaFabState._chart.destroy();
    saidaFabState._chart = null;
  }
  const comAtraso = dados.filter((d) => d.atrasadas > 0);
  if (!canvas || typeof Chart === "undefined" || !comAtraso.length) return;

  const rank = saidaFabState._rank;
  const top = comAtraso.slice(0, 15);
  const rotulo =
    rank === "qtd"
      ? "Saídas atrasadas"
      : rank === "total"
        ? "Total de atraso (min)"
        : "Média de atraso (min)";

  saidaFabState._chart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: top.map((d) => d.motorista),
      datasets: [
        {
          label: rotulo,
          data: top.map((d) => saidaFabValorRank(d, rank)),
          backgroundColor: "rgba(168,85,247,0.45)",
          borderColor: "rgba(168,85,247,0.95)",
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
        if (els.length) saidaFabMostrarDetalhe(els[0].index);
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
              return `${d.atrasadas}/${d.total} saída(s) atrasada(s) · pontualidade ${d.pontualidade}%`;
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

function saidaFabMostrarDetalhe(indice) {
  const d = saidaFabState._dados[indice];
  const shell = document.getElementById("saidaFabDetalhe");
  const titulo = document.getElementById("saidaFabDetalheTitulo");
  const conteudo = document.getElementById("saidaFabDetalheConteudo");
  if (!d || !shell || !conteudo) return;

  const registros = typeof lerStorage === "function" ? lerStorage(LS.atrasos) : [];
  const dataDe = (a) => saidaFabDataLimpa(a.data);
  const hhmm = (t) => {
    const s = String(t || "").trim();
    return s ? s.slice(0, 5) : "—";
  };

  const regs = registros
    .filter(
      (a) =>
        (String(a.motorista || "").trim() || "Não informado").toUpperCase() === d.chave &&
        saidaFabDentroIntervalo(dataDe(a), saidaFabState._ini, saidaFabState._fim),
    )
    .sort((a, b) => {
      const da = dataDe(a);
      const db = dataDe(b);
      if (da !== db) return db.localeCompare(da);
      return String(a.horaMarcada || "").localeCompare(String(b.horaMarcada || ""));
    });

  if (titulo) {
    titulo.textContent = `🏭 ${d.motorista} — ${d.total} saída(s) no período · ${d.atrasadas} atrasada(s)${d.atrasadas > 0 ? ` · média ${d.media} min` : ""}`;
  }

  const linhas = regs
    .map((a) => {
      const atraso = saidaFabAtrasoReg(a);
      return `<tr style="border-bottom:1px solid var(--border);">
        <td style="padding:8px 12px;color:var(--text-muted);white-space:nowrap;">${saidaFabFmtData(dataDe(a))}</td>
        <td style="padding:8px 12px;font-weight:700;color:var(--text-heading);white-space:nowrap;">${escapar(a.rota || "—")}</td>
        <td style="padding:8px 12px;color:var(--azul);white-space:nowrap;">${escapar(a.placa || "—")}</td>
        <td style="padding:8px 12px;text-align:center;white-space:nowrap;">${hhmm(a.horaMarcada)}</td>
        <td style="padding:8px 12px;text-align:center;white-space:nowrap;">${hhmm(a.horaReal)}</td>
        <td style="padding:8px 12px;text-align:center;white-space:nowrap;font-weight:700;color:${atraso > 0 ? "var(--laranja,#fb923c)" : "var(--verde)"};">${atraso > 0 ? `${atraso} min` : "no horário"}</td>
        <td style="padding:8px 12px;color:var(--text-muted);">${escapar(a.justificativa || "—")}</td>
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
            <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Placa</th>
            <th style="padding:8px 12px;text-align:center;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Marcada</th>
            <th style="padding:8px 12px;text-align:center;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Real</th>
            <th style="padding:8px 12px;text-align:center;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Atraso</th>
            <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">Justificativa</th>
          </tr>
        </thead>
        <tbody>${linhas || `<tr><td colspan="7" style="padding:14px;text-align:center;color:var(--text-muted);">Sem saídas registradas no período.</td></tr>`}</tbody>
      </table>
    </div>`;
  shell.style.display = "block";
  shell.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function saidaFabFecharDetalhe() {
  const shell = document.getElementById("saidaFabDetalhe");
  if (shell) shell.style.display = "none";
}

function saidaFabLimparFiltro() {
  const ini = document.getElementById("saidaFabDataInicio");
  const fim = document.getElementById("saidaFabDataFim");
  if (ini) ini.value = "";
  if (fim) fim.value = "";
  saidaFabCalcular();
}

function saidaFabInit() {
  // Pré-popula com os últimos 30 dias quando vazio.
  const ini = document.getElementById("saidaFabDataInicio");
  const fim = document.getElementById("saidaFabDataFim");
  if (ini && !ini.value) {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    ini.value = d.toISOString().split("T")[0];
  }
  if (fim && !fim.value) {
    fim.value =
      typeof hojeISO === "function" ? hojeISO() : new Date().toISOString().split("T")[0];
  }
  saidaFabCalcular();
}

window.saidaFabCalcular = saidaFabCalcular;
window.saidaFabLimparFiltro = saidaFabLimparFiltro;
window.saidaFabMostrarDetalhe = saidaFabMostrarDetalhe;
window.saidaFabFecharDetalhe = saidaFabFecharDetalhe;
window.saidaFabInit = saidaFabInit;
