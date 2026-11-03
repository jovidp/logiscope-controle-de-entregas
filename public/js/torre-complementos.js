// ================================================================
// torre-complementos.js
// ----------------------------------------------------------------
// Implementa window.atualizarComplementosTorre(), que era chamado
// defensivamente por atualizarTodasAsViews() (script-1-core.js) mas
// nunca existiu — por isso metade inferior da Torre de Controle
// (torre.html) ficava mostrando "—"/0. Aqui populamos, só com dados
// que JÁ estão em memória:
//
//   ANALYTICS (4 cards inteligentes)
//     • Saúde Operacional  (gauge + badge + stats + barra)
//     • Lojas · tempo médio de descarga
//     • Distribuição de Incidentes (rodapé-resumo)
//     • Disciplina (checklist, pontualidade na saída, motorista destaque)
//
//   ATRASOS NA SAÍDA DA FÁBRICA  (fonte: lerStorage(LS.atrasos))
//     • 4 KPIs (registros, com atraso, média, maior)
//     • painel de distribuição por severidade
//     • tabela detalhada
//     • rankings de motoristas e placas com mais atrasos
//
// Respeita os filtros da Torre: período + motorista (das entregas) e os
// filtros próprios de Atraso na saída / Placa (ligados em
// script-2-torre-dashboard.js).
//
// Script clássico (escopo global). Reaproveita globais já carregados:
// $, getVal, escapar, formatarTempo, formatarDataBR, minutos, lerStorage,
// LS, obterOcorrenciasAtivas. Por isso é incluído DEPOIS dos script-*.
// ================================================================

(function () {
  function _tcEl(id) {
    return typeof $ === "function" ? $(id) : document.getElementById(id);
  }
  function _tcEsc(v) {
    return typeof escapar === "function"
      ? escapar(v)
      : String(v == null ? "" : v);
  }
  function _tcSetText(id, v) {
    const el = _tcEl(id);
    if (el) el.textContent = v;
  }
  function _tcSetWidth(id, pct) {
    const el = _tcEl(id);
    if (el) el.style.width = Math.min(Math.max(Number(pct) || 0, 0), 100) + "%";
  }
  function _tcVal(id) {
    return typeof getVal === "function"
      ? getVal(id)
      : _tcEl(id)
        ? _tcEl(id).value
        : "";
  }
  function _tcTempo(min) {
    const m = Math.round(Number(min) || 0);
    return typeof formatarTempo === "function" ? formatarTempo(m) : m + "min";
  }
  function _tcDataBR(d) {
    return typeof formatarDataBR === "function" ? formatarDataBR(d) : d || "—";
  }
  function _tcMin(h) {
    if (typeof minutos === "function") return minutos(h);
    const [hh, mm] = String(h || "").split(":").map(Number);
    return hh * 60 + (mm || 0);
  }
  // Espelha booleanSeguro do servidor (fez_checklist pode vir como
  // boolean ou string "Sim"/"true"/"x"…).
  function _tcVerdadeiro(v) {
    if (v === true) return true;
    if (v === false || v == null) return false;
    return ["true", "sim", "x", "feito", "realizou", "1"].includes(
      String(v).trim().toLowerCase(),
    );
  }
  function _tcCorTaxa(t) {
    return t >= 90 ? "#34d399" : t >= 75 ? "#fbbf24" : t >= 50 ? "#fb923c" : "#f87171";
  }
  function _tcBadgeSaude(t, total) {
    if (!total)
      return { txt: "Sem dados", cor: "#94a3b8", bg: "rgba(148,163,184,.12)", bd: "rgba(148,163,184,.25)" };
    if (t >= 90)
      return { txt: "Excelente", cor: "#34d399", bg: "rgba(52,211,153,.12)", bd: "rgba(52,211,153,.25)" };
    if (t >= 75)
      return { txt: "Boa", cor: "#fbbf24", bg: "rgba(251,191,36,.12)", bd: "rgba(251,191,36,.25)" };
    if (t >= 50)
      return { txt: "Atenção", cor: "#fb923c", bg: "rgba(249,115,22,.14)", bd: "rgba(249,115,22,.28)" };
    return { txt: "Crítica", cor: "#f87171", bg: "rgba(248,113,113,.14)", bd: "rgba(248,113,113,.28)" };
  }
  // Classifica um atraso (em minutos) em faixas de severidade, alinhadas
  // com as opções do filtro #filtroAtrasoSaida.
  function _tcSev(min) {
    const m = Number(min) || 0;
    if (m <= 0) return { key: "ok", label: "No horário", cls: "badge-ok", cor: "#34d399" };
    if (m <= 15) return { key: "leve", label: "Leve", cls: "badge-leve", cor: "#fbbf24" };
    if (m <= 60) return { key: "relevante", label: "Relevante", cls: "badge-relevante", cor: "#fb923c" };
    return { key: "critico", label: "Crítico", cls: "badge-critico", cor: "#f87171" };
  }

  // ----------------------------------------------------------------
  // ANALYTICS — 4 cards inteligentes
  // ----------------------------------------------------------------
  function _tcAnalytics() {
    const entregas =
      typeof obterOcorrenciasAtivas === "function" ? obterOcorrenciasAtivas() : [];
    const total = entregas.length;
    const comOco = entregas.filter((o) => o.teve_ocorrencia).length;
    const semOco = total - comOco;
    const taxa = total ? Math.round((semOco / total) * 100) : 0;

    // --- Card Saúde Operacional ---
    _tcSetText("saudeEntregasSem", semOco);
    _tcSetText("saudeEntregasCom", comOco);
    _tcSetText("saudeTotalEntregas", total);
    _tcSetText("gaugeTexto", (total ? taxa : 0) + "%");
    const arc = _tcEl("gaugeArc");
    if (arc) {
      const LEN = 157; // comprimento aproximado do semicírculo
      arc.style.strokeDashoffset = String(LEN - (LEN * Math.min(taxa, 100)) / 100);
      arc.style.stroke = _tcCorTaxa(taxa);
    }
    _tcSetWidth("progressSaude", taxa);
    const badge = _tcEl("badgeSaude");
    if (badge) {
      const b = _tcBadgeSaude(taxa, total);
      badge.textContent = b.txt;
      badge.style.color = b.cor;
      badge.style.background = b.bg;
      badge.style.borderColor = b.bd;
    }

    // --- Card Lojas · tempo médio de descarga ---
    const comTempo = entregas.filter((o) => Number(o.permanencia_minutos) > 0);
    const mediaPerm = comTempo.length
      ? Math.round(
          comTempo.reduce((a, o) => a + Number(o.permanencia_minutos), 0) /
            comTempo.length,
        )
      : 0;
    _tcSetText("tempoMedioCard", mediaPerm ? _tcTempo(mediaPerm) : "—");

    // --- Card Distribuição · rodapé-resumo (a lista é de outra função) ---
    _tcSetText(
      "footerOcorrencias",
      total
        ? `${comOco} com ocorrência de ${total} entregas (${total ? Math.round((comOco / total) * 100) : 0}%)`
        : "Sem entregas no período",
    );

    // --- Card Disciplina ---
    // Checklist do veículo
    const comCheck = entregas.filter((o) => _tcVerdadeiro(o.fez_checklist)).length;
    const pctCheck = total ? Math.round((comCheck / total) * 100) : 0;
    _tcSetText("checklistPct", (total ? pctCheck : 0) + "%");
    _tcSetText("checklistSub", `${comCheck} de ${total} veículos com checklist`);
    _tcSetWidth("progressChecklist", pctCheck);

    // Pontualidade na saída da fábrica (entregas com as duas horas)
    const comSaida = entregas.filter(
      (o) => o.hora_marcada_saida && o.hora_saida_fabrica,
    );
    const pontuais = comSaida.filter(
      (o) => _tcMin(o.hora_saida_fabrica) <= _tcMin(o.hora_marcada_saida),
    ).length;
    const pctPont = comSaida.length
      ? Math.round((pontuais / comSaida.length) * 100)
      : 0;
    _tcSetText("pontualidadePct", (comSaida.length ? pctPont : 0) + "%");
    _tcSetText("pontualidadeSub", `${pontuais} de ${comSaida.length} saídas no horário`);
    _tcSetWidth("progressPontualidade", pctPont);

    // Motorista destaque (melhor taxa de sucesso, mín. 3 entregas)
    const mapaMot = {};
    entregas.forEach((o) => {
      const n = o.motorista || "";
      if (!n) return;
      if (!mapaMot[n]) mapaMot[n] = { total: 0, oco: 0 };
      mapaMot[n].total++;
      if (o.teve_ocorrencia) mapaMot[n].oco++;
    });
    let melhor = null;
    Object.entries(mapaMot).forEach(([n, d]) => {
      if (d.total < 3) return;
      const t = Math.round(((d.total - d.oco) / d.total) * 100);
      if (!melhor || t > melhor.taxa || (t === melhor.taxa && d.total > melhor.total))
        melhor = { n, taxa: t, total: d.total };
    });
    if (!melhor) {
      // Fallback: ninguém com 3+ entregas — pega o de maior volume.
      Object.entries(mapaMot).forEach(([n, d]) => {
        const t = Math.round(((d.total - d.oco) / d.total) * 100);
        if (!melhor || d.total > melhor.total) melhor = { n, taxa: t, total: d.total };
      });
    }
    _tcSetText("nomeDestaqueMotorista", melhor ? melhor.n : "—");
    _tcSetText(
      "taxaDestaqueMotorista",
      melhor ? `${melhor.taxa}% de sucesso · ${melhor.total} entregas` : "—% de sucesso",
    );
  }

  // ----------------------------------------------------------------
  // ATRASOS NA SAÍDA DA FÁBRICA
  // ----------------------------------------------------------------
  // Aplica os filtros da Torre relevantes à lista de atrasos.
  function _tcAtrasosFiltrados() {
    const lista =
      typeof lerStorage === "function" && typeof LS !== "undefined"
        ? lerStorage(LS.atrasos)
        : [];
    const dI = _tcVal("filtroDataInicial");
    const dF = _tcVal("filtroDataFinal");
    const mot = _tcVal("filtroMotorista");
    const placa = _tcVal("filtroPlacaAtrasoSaida");
    const cat = _tcVal("filtroAtrasoSaida");
    return (Array.isArray(lista) ? lista : []).filter((a) => {
      const d = String(a.data || "").split("T")[0];
      if (dI && d < dI) return false;
      if (dF && d > dF) return false;
      if (mot && a.motorista !== mot) return false;
      if (placa && a.placa !== placa) return false;
      if (cat) {
        const m = Number(a.atrasoMin) || 0;
        if (cat === "com_atraso" && !(m > 0)) return false;
        if (cat === "sem_atraso" && m > 0) return false;
        if (cat === "leve" && !(m > 0 && m <= 15)) return false;
        if (cat === "relevante" && !(m > 15 && m <= 60)) return false;
        if (cat === "critico" && !(m > 60)) return false;
      }
      return true;
    });
  }

  function _tcRankAtraso(elId, lista, keyFn) {
    const el = _tcEl(elId);
    if (!el) return;
    const m = {};
    lista.forEach((a) => {
      const k = keyFn(a);
      if (!k) return;
      if (!m[k]) m[k] = { n: 0, soma: 0 };
      m[k].n++;
      m[k].soma += Number(a.atrasoMin) || 0;
    });
    const rank = Object.entries(m)
      .map(([k, d]) => ({ k, n: d.n, soma: d.soma }))
      .sort((a, b) => b.n - a.n || b.soma - a.soma)
      .slice(0, 5);
    el.innerHTML = rank.length
      ? rank
          .map(
            (r, i) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);">
          <div>${i + 1}. ${_tcEsc(r.k)}<div style="font-size:11px;color:var(--text-muted);">${_tcTempo(Math.round(r.soma / r.n))} médio</div></div>
          <span style="font-weight:bold;color:var(--vermelho,#f87171);">${r.n} atraso${r.n === 1 ? "" : "s"}</span>
        </div>`,
          )
          .join("")
      : `<p style="color:var(--text-muted);font-size:13px;">Sem atrasos no período.</p>`;
  }

  function _tcAtrasoSaida() {
    const lista = _tcAtrasosFiltrados();
    const totalReg = lista.length;
    const comAtraso = lista.filter((a) => (Number(a.atrasoMin) || 0) > 0);
    const nCom = comAtraso.length;
    const mediaAtr = nCom
      ? Math.round(comAtraso.reduce((s, a) => s + (Number(a.atrasoMin) || 0), 0) / nCom)
      : 0;
    const maior = lista.reduce((mx, a) => Math.max(mx, Number(a.atrasoMin) || 0), 0);

    _tcSetText("totalRegistrosAtrasoSaida", totalReg);
    _tcSetText("saidasComAtraso", nCom);
    _tcSetText("mediaAtrasoSaida", mediaAtr ? _tcTempo(mediaAtr) : "0min");
    _tcSetText("maiorAtrasoSaida", maior ? _tcTempo(maior) : "0min");

    _tcSetText(
      "resumoAtrasoSaidaTorre",
      totalReg
        ? `${totalReg} registro${totalReg === 1 ? "" : "s"} · ${nCom} com atraso · média ${mediaAtr ? _tcTempo(mediaAtr) : "0min"}`
        : "Sem registros de saída no período",
    );

    // Painel: distribuição por severidade
    const sev = { ok: 0, leve: 0, relevante: 0, critico: 0 };
    lista.forEach((a) => {
      sev[_tcSev(a.atrasoMin).key]++;
    });
    const painel = _tcEl("painelAtrasosSaidaTorre");
    if (painel) {
      const cardSev = (emoji, label, n, cor) =>
        `<div class="card" style="border-color:${cor}40;">
           <h2 style="color:${cor};">${n}</h2><p>${emoji} ${label}</p>
         </div>`;
      painel.innerHTML =
        cardSev("✅", "No horário", sev.ok, "#34d399") +
        cardSev("🟡", "Leve ≤15min", sev.leve, "#fbbf24") +
        cardSev("🟠", "Relevante ≤1h", sev.relevante, "#fb923c") +
        cardSev("🔴", "Crítico >1h", sev.critico, "#f87171");
    }

    // Tabela detalhada
    const tabela = _tcEl("tabelaAtrasosSaidaTorre");
    if (tabela) {
      if (!totalReg) {
        tabela.innerHTML = `<div class="empty-torre">Nenhum registro de atraso na saída para os filtros atuais.</div>`;
      } else {
        const linhas = lista
          .slice()
          .sort(
            (a, b) =>
              String(b.data || "").localeCompare(String(a.data || "")) ||
              (Number(b.atrasoMin) || 0) - (Number(a.atrasoMin) || 0),
          )
          .slice(0, 60)
          .map((a) => {
            const s = _tcSev(a.atrasoMin);
            return `<tr>
              <td>${_tcEsc(_tcDataBR(a.data))}</td>
              <td>${_tcEsc(a.motorista || "-")}</td>
              <td>${_tcEsc(a.placa || "-")}</td>
              <td>${_tcEsc(a.rota || "-")}</td>
              <td>${_tcEsc(a.horaMarcada || "--:--")}</td>
              <td>${_tcEsc(a.horaReal || "--:--")}</td>
              <td style="font-weight:800;color:${s.cor};">${_tcEsc(a.atrasoFormatado || _tcTempo(a.atrasoMin))}</td>
              <td><span class="badge-torre ${s.cls}">${s.label}</span></td>
            </tr>`;
          })
          .join("");
        tabela.innerHTML = `<table data-ordenavel class="torre-table">
          <thead><tr>
            <th>Data</th><th>Motorista</th><th>Placa</th><th>Rota</th>
            <th>Marcada</th><th>Real</th><th>Atraso</th><th>Status</th>
          </tr></thead>
          <tbody>${linhas}</tbody>
        </table>`;
      }
    }

    // Rankings (só entre os que tiveram atraso)
    _tcRankAtraso("rankMotoristasAtrasoSaida", comAtraso, (a) => a.motorista || "Não informado");
    _tcRankAtraso("rankPlacasAtrasoSaida", comAtraso, (a) => a.placa || "Não informado");
  }

  // ----------------------------------------------------------------
  // Ponto de entrada chamado por atualizarTodasAsViews().
  // ----------------------------------------------------------------
  window.atualizarComplementosTorre = function () {
    // Só age na Torre (estes elementos não existem no index).
    if (!_tcEl("cardSaude") && !_tcEl("tabelaAtrasosSaidaTorre")) return;
    try {
      _tcAnalytics();
    } catch (e) {
      console.warn("[torre-complementos] analytics", e);
    }
    try {
      _tcAtrasoSaida();
    } catch (e) {
      console.warn("[torre-complementos] atraso saída", e);
    }
  };
})();
