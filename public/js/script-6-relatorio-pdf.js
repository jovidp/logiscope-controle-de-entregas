// ================================================================
// 24. RELATÓRIO COMPLETO POR DIA
// ================================================================
(function () {
  function relEl(id) {
    return document.getElementById(id);
  }
  function relValor(id) {
    return relEl(id)?.value || "";
  }
  function relDataLimpa(data) {
    return String(data || "").split("T")[0];
  }
  function relHojeISO() {
    return new Date().toISOString().split("T")[0];
  }
  function relEscape(v) {
    return escapar(v);
  }
  function relFormatarDataBR(d) {
    return formatarDataBR(d);
  }
  function relFormatarNomeLoja(l) {
    // Nome polido (canônico) também no PDF: sem duplicar grafias.
    return typeof rotuloLoja === "function" ? rotuloLoja(l) : formatarNomeLoja(l);
  }
  function relFormatarTempo(m) {
    return formatarTempo(m);
  }
  function relTemOcorrenciaRota(o) {
    return !!(
      o.teve_ocorrencia ||
      o.tipo_problema ||
      o.problema_operacional_tipo
    );
  }
  function relFiltrarPorData(lista, campoDataFn, dataE) {
    return dataE
      ? lista.filter((i) => relDataLimpa(campoDataFn(i)) === dataE)
      : lista;
  }
  function relIntervaloSelecionado() {
    const ini =
      relValor("dataRelatorio") || relValor("filtroData") || relHojeISO();
    const fim = relValor("dataRelatorioFim") || ini;
    return ini <= fim ? { ini, fim } : { ini: fim, fim: ini };
  }
  function relFiltrarPorIntervalo(lista, campoDataFn, ini, fim) {
    if (!ini && !fim) return lista;
    return lista.filter((i) => {
      const d = relDataLimpa(campoDataFn(i));
      if (!d) return false;
      return d >= ini && d <= fim;
    });
  }
  function relRotuloPeriodo(ini, fim) {
    return ini === fim
      ? relFormatarDataBR(ini)
      : `${relFormatarDataBR(ini)} → ${relFormatarDataBR(fim)}`;
  }
  function relPartesResponsavelOcorrencia(o) {
    return String(obterResponsavelOcorrencia(o) || "")
      .split(/,|;|\|/)
      .map((v) => normalizarResponsavelOcorrencia(v))
      .filter(Boolean);
  }
  function relOcorrenciaPassaFiltroResponsavel(o, filtro) {
    if (!filtro) return true;
    const partes = relPartesResponsavelOcorrencia(o);
    if (filtro === "__SEM_RESPONSAVEL__") return partes.length === 0;
    return partes.includes(normalizarResponsavelOcorrencia(filtro));
  }
  function relRotuloResponsavelProblemas(filtro) {
    if (!filtro) return "Todos os responsaveis";
    if (filtro === "__SEM_RESPONSAVEL__") return "Sem responsavel informado";
    return normalizarResponsavelOcorrencia(filtro);
  }
  function relLerStorage(chave) {
    return lerStorage(chave);
  }
  function relGarantirCampoData() {
    if (relEl("dataRelatorio")) return;
    const botaoGerar = document.querySelector(
      "button[onclick='gerarRelatorio()']",
    );
    const destino = botaoGerar?.parentElement || document.body;
    const bloco = document.createElement("div");
    bloco.style.cssText =
      "display:flex;align-items:end;gap:10px;flex-wrap:wrap;margin:12px 0;";
    bloco.innerHTML = `<div><label for="dataRelatorio" style="font-size:11px;margin:0 0 4px;display:block;color:var(--text-muted,#64748b);font-weight:800;text-transform:uppercase;letter-spacing:.6px;">De</label><input type="date" id="dataRelatorio" style="min-height:42px;" /></div><div><label for="dataRelatorioFim" style="font-size:11px;margin:0 0 4px;display:block;color:var(--text-muted,#64748b);font-weight:800;text-transform:uppercase;letter-spacing:.6px;">Até</label><input type="date" id="dataRelatorioFim" style="min-height:42px;" /></div>`;
    destino.insertBefore(bloco, botaoGerar || destino.firstChild);
  }
  function relDataSelecionada() {
    return relValor("dataRelatorio") || relValor("filtroData") || relHojeISO();
  }
  function relAbrirContainer() {
    const c = relEl("containerRelatorio");
    if (!c) return;
    c.classList.remove("hidden");
    c.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function relAlertar(texto) {
    alertar(texto);
  }

  function relAnaliseNarrativa(dados) {
    const {
      dataEscolhida,
      entregasDia,
      atrasosDia,
      totalEntregas,
      comOco,
      semOco,
      taxaSucesso,
      semCk,
    } = dados;
    const tempos = entregasDia
      .map((o) => calcularPermanencia(o.hora_chegada, o.fim_descarga))
      .filter((tempo) => tempo > 0);
    const tempoMedio = tempos.length
      ? Math.round(
          tempos.reduce((soma, tempo) => soma + tempo, 0) / tempos.length,
        )
      : 0;
    const atrasosReais = atrasosDia.filter((a) => Number(a.atrasoMin || 0) > 0);
    const tipos = {};
    entregasDia
      .filter((o) => o.teve_ocorrencia || o.tipo_problema)
      .forEach((o) => {
        const tipo = o.tipo_problema || "Não classificada";
        tipos[tipo] = (tipos[tipo] || 0) + 1;
      });
    const principalTipo = Object.entries(tipos).sort((a, b) => b[1] - a[1])[0];
    const responsaveis = {};
    entregasDia.forEach((o) => {
      const nome = obterResponsavelOcorrencia(o);
      if (nome) responsaveis[nome] = (responsaveis[nome] || 0) + 1;
    });
    const principalResponsavel = Object.entries(responsaveis).sort(
      (a, b) => b[1] - a[1],
    )[0];

    const panorama =
      totalEntregas === 0
        ? "Não houve entrega registrada para a data selecionada."
        : `Em ${formatarDataBR(dataEscolhida)}, foram registradas ${totalEntregas} entrega(s). ${semOco} ocorreram sem divergências apontadas e ${comOco} apresentaram ocorrência ou problema operacional, resultando em taxa de sucesso de ${taxaSucesso}%.`;
    const operacao = [
      tempoMedio
        ? `O tempo médio apurado em loja foi de ${formatarTempo(tempoMedio)}.`
        : "Não há horários suficientes para apurar o tempo médio em loja.",
      atrasosReais.length
        ? `${atrasosReais.length} saída(s) da fábrica foram registradas com atraso.`
        : "Não foram identificadas saídas da fábrica em atraso nos registros do dia.",
      semCk
        ? `${semCk} entrega(s) ficaram sem checklist vinculado.`
        : "Todos os registros de entrega possuem checklist indicado.",
    ].join(" ");
    const riscos = principalTipo
      ? `A ocorrência mais frequente foi "${principalTipo[0]}", com ${principalTipo[1]} registro(s).${principalResponsavel ? ` O responsável mais recorrente informado foi ${principalResponsavel[0]}, associado a ${principalResponsavel[1]} registro(s).` : ""}`
      : "Não houve ocorrências classificadas no período, indicando operação sem desvios registrados.";
    const recomendacoes = [];
    if (taxaSucesso < 90 && totalEntregas > 0)
      recomendacoes.push(
        "acompanhar as ocorrências do dia e revisar as causas repetidas",
      );
    if (semCk > 0)
      recomendacoes.push(
        "reforçar o preenchimento do checklist antes da saída",
      );
    if (atrasosReais.length > 0)
      recomendacoes.push("avaliar as justificativas dos atrasos de saída");
    if (!recomendacoes.length)
      recomendacoes.push(
        "manter o acompanhamento operacional e os registros atuais",
      );

    return `
      <div style="margin:8px 0 10px;padding:12px 14px;background:#f8fafc;border:1px solid #cbd5e1;border-left:4px solid #0f766e;border-radius:6px;break-inside:avoid;page-break-inside:avoid;">
        <div style="font-size:9px;font-weight:900;color:#0f766e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:7px;">Análise Inteligente - Resumo Executivo</div>
        <p style="font-size:9px;line-height:1.5;color:#334155;margin:0 0 6px;"><b>Panorama:</b> ${relEscape(panorama)}</p>
        <p style="font-size:9px;line-height:1.5;color:#334155;margin:0 0 6px;"><b>Operação:</b> ${relEscape(operacao)}</p>
        <p style="font-size:9px;line-height:1.5;color:#334155;margin:0 0 6px;"><b>Pontos de atenção:</b> ${relEscape(riscos)}</p>
        <p style="font-size:9px;line-height:1.5;color:#334155;margin:0;"><b>Recomendação:</b> ${relEscape(recomendacoes.join("; "))}.</p>
      </div>`;
  }

  window.gerarRelatorio = function (modoNarrativo = false) {
    relGarantirCampoData();
    const container = relEl("containerRelatorio"),
      divRelatorio = relEl("relatorio");
    if (!container || !divRelatorio) {
      relAlertar("Não encontrei a área do relatório.");
      return;
    }

    const { ini: dataIni, fim: dataFim } = relIntervaloSelecionado();
    const dataEscolhida = dataIni;
    const entregasDia = relFiltrarPorIntervalo(
      ocorrencias,
      (o) => o.data_ocorrencia || o.data,
      dataIni,
      dataFim,
    );
    const atrasosDia = relFiltrarPorIntervalo(
      relLerStorage(LS.atrasos),
      (a) => a.data,
      dataIni,
      dataFim,
    );
    const rotasDia = relFiltrarPorIntervalo(
      relLerStorage(LS.rotas),
      (r) => r.data,
      dataIni,
      dataFim,
    );
    const checklistDia = relFiltrarPorIntervalo(
      relLerStorage(LS.checklist),
      (c) => c.data,
      dataIni,
      dataFim,
    );
    const almocosDia = relFiltrarPorIntervalo(
      relLerStorage(LS.almocos),
      (a) => a.data,
      dataIni,
      dataFim,
    );
    const tacografosDia = relFiltrarPorIntervalo(
      lerStorage(LS.tacografos),
      (t) => t.data,
      dataIni,
      dataFim,
    );
    const diariosDia = relFiltrarPorIntervalo(
      lerStorage(LS.diarios),
      (d) => d.data,
      dataIni,
      dataFim,
    );
    const ocorrenciasRotaDia = entregasDia.filter(relTemOcorrenciaRota);

    const vazio = [
      entregasDia,
      atrasosDia,
      rotasDia,
      checklistDia,
      almocosDia,
    ].every((l) => l.length === 0);
    if (vazio) {
      relAlertar(
        `Nenhum dado encontrado em ${relRotuloPeriodo(dataIni, dataFim)}.`,
      );
      return;
    }

    const totalEntregas = entregasDia.length;
    const comOco = ocorrenciasRotaDia.length;
    const semOco = Math.max(totalEntregas - comOco, 0);
    const taxaSucesso =
      totalEntregas > 0 ? Math.round((semOco / totalEntregas) * 100) : 0;
    const probOp = entregasDia.filter(
      (o) => o.problema_operacional_tipo,
    ).length;
    const semCk = entregasDia.filter((o) => {
      const ck = o.fez_checklist;
      return ck !== true && ck !== "true" && ck !== "sim";
    }).length;
    const narrativaHtml = modoNarrativo
      ? relAnaliseNarrativa({
          dataEscolhida,
          entregasDia,
          atrasosDia,
          totalEntregas,
          comOco,
          semOco,
          taxaSucesso,
          semCk,
        })
      : "";

    const agora = new Date();
    const geradoEm = `${agora.toLocaleDateString("pt-BR")} às ${agora.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;

    const td = (v, extra = "") =>
      `<td style="padding:2px 5px;border-bottom:1px solid #f0f0f0;vertical-align:middle;font-size:8px;color:#334155;${extra}">${relEscape(String(v ?? "-"))}</td>`;
    const th = (v, extra = "") =>
      `<th style="padding:3px 5px;background:#1e293b;color:#e2e8f0;font-size:7.5px;text-align:left;font-weight:700;letter-spacing:.3px;text-transform:uppercase;white-space:nowrap;${extra}">${relEscape(String(v))}</th>`;
    const badge = (txt, cor) =>
      `<span style="display:inline-block;padding:1px 5px;border-radius:10px;font-size:7px;font-weight:700;background:${cor}18;color:${cor};border:1px solid ${cor}30;">${txt}</span>`;

    const kpis = [
      { v: totalEntregas, l: "Total de Entregas" },
      { v: semOco, l: "Sem Ocorrência", c: "#047857" },
      { v: comOco, l: "Com Ocorrência", c: "#b91c1c" },
      { v: taxaSucesso + "%", l: "Taxa de Sucesso", c: "#2563eb" },
      { v: probOp, l: "Prob. Operacionais", c: "#b45309" },
      { v: semCk, l: "Sem Checklist", c: "#dc2626" },
      { v: checklistDia.length, l: "Checklists" },
      {
        v: atrasosDia.filter((a) => Number(a.atrasoMin || 0) > 0).length,
        l: "Saídas Atrasadas",
        c: "#b91c1c",
      },
      { v: rotasDia.length, l: "Rotas Registradas" },
      {
        v: almocosDia.filter((a) => a.status !== "ok").length,
        l: "Almoços Excedidos",
        c: "#b91c1c",
      },
      {
        v: tacografosDia.filter((t) => t.status === "Não devolveu").length,
        l: "Tacóg. Não Dev.",
        c: "#b91c1c",
      },
      {
        v: diariosDia.filter((d) => d.status === "Não preencheu").length,
        l: "Diários N. Preench.",
        c: "#b91c1c",
      },
    ];

    const kpiHtml = kpis
      .map(
        (k) => `
    <div style="background:#fff;border:1px solid #e2e8f0;border-top:2px solid ${k.c || "#94a3b8"};border-radius:5px;padding:4px 5px;text-align:center;">
      <div style="font-size:13px;font-weight:900;color:${k.c || "#0f172a"};">${relEscape(String(k.v))}</div>
      <div style="font-size:7px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.3px;margin-top:1px;">${relEscape(k.l)}</div>
    </div>`,
      )
      .join("");

    const mapaDeslocRel = calcularMapaDeslocamentos(entregasDia);
    const entregasHtml =
      entregasDia.length === 0
        ? `<p style="color:#64748b;font-size:8px;margin:0;">Nenhuma entrega registrada nesse dia.</p>`
        : `<table style="width:100%;border-collapse:collapse;border-radius:5px;overflow:hidden;border:1px solid #e2e8f0;">
          <thead><tr>${["Loja", "Motorista", "Placa", "Rota", "Desloc.", "Chegada", "Saída", "CK", "Ocorrência", "Responsável", "Relato"].map((h) => th(h)).join("")}</tr></thead>
          <tbody>${entregasDia
            .map((o, i) => {
              const temOco = !!(o.teve_ocorrencia || o.tipo_problema);
              const temProb = !!o.problema_operacional_tipo;
              const ck =
                o.fez_checklist === true ||
                o.fez_checklist === "true" ||
                o.fez_checklist === "sim";
              const responsavel = obterResponsavelOcorrencia(o);
              const bgRow = temOco
                ? "#fff8f8"
                : i % 2 === 0
                  ? "#fff"
                  : "#f8fafc";
              const deslocRel = mapaDeslocRel.get(String(o.id));
              const deslocTxt = deslocRel
                ? formatarTempo(deslocRel.minutos)
                : "-";
              const deslocCor =
                deslocRel && deslocRel.minutos > 30 ? "#b45309" : "#047857";
              return `<tr style="background:${bgRow};">
              ${td(relFormatarNomeLoja(o.loja), "font-weight:700;")}
              ${td(o.motorista || "-")}
              ${td(o.placa || "-")}
              ${td(obterRotaDaOcorrencia(o))}
              <td style="padding:2px 5px;border-bottom:1px solid #f0f0f0;font-size:8px;font-weight:700;color:${deslocCor};">${deslocTxt}</td>
              ${td(o.hora_chegada || "--:--")}
              ${td(o.fim_descarga || "--:--")}
              <td style="padding:2px 5px;border-bottom:1px solid #f0f0f0;font-size:8px;text-align:center;">${ck ? "✅" : "❌"}</td>
              <td style="padding:2px 5px;border-bottom:1px solid #f0f0f0;font-size:8px;">${temOco ? `<span style="color:#b91c1c;font-weight:700;">${relEscape(o.tipo_problema || "Sim")}</span>` : `<span style="color:#047857;">OK</span>`}${temProb ? `<br><span style="color:#b45309;font-size:7px;">${relEscape(o.problema_operacional_tipo)}</span>` : ""}</td>
              ${td(responsavel || "-", "color:#92400e;font-weight:700;")}
              ${td(o.descricao || "-", "color:#7f1d1d;max-width:140px;word-break:break-word;")}
            </tr>`;
            })
            .join("")}
          </tbody></table>`;

    const atrasosHtml =
      atrasosDia.length === 0
        ? `<p style="color:#64748b;font-size:11px;margin:0;">Nenhum atraso registrado.</p>`
        : `<table style="width:100%;border-collapse:collapse;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;">
        <thead><tr>${["Data", "Motorista", "Placa", "Rota", "Marcada", "Real", "Atraso", "Justificativa"].map((h) => th(h)).join("")}</tr></thead>
        <tbody>${atrasosDia
          .map(
            (
              a,
              i,
            ) => `<tr style="background:${i % 2 === 0 ? "#fff" : "#f8fafc"};">
          ${td(relFormatarDataBR(a.data))}${td(a.motorista)}${td(a.placa)}${td(a.rota || "-")}
          ${td(a.horaMarcada || "-")}${td(a.horaReal || "-")}
          <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:10px;">${
            Number(a.atrasoMin || 0) > 0
              ? `<span style="color:#b91c1c;font-weight:800;background:#fef2f2;padding:2px 6px;border-radius:20px;">${relEscape(a.atrasoFormatado)}</span>`
              : `<span style="color:#047857;font-weight:700;">✅ No horário</span>`
          }</td>
          ${td(a.justificativa || "-")}</tr>`,
          )
          .join("")}
        </tbody></table>`;

    const rotasHtml =
      rotasDia.length === 0
        ? `<p style="color:#64748b;font-size:11px;margin:0;">Nenhuma rota registrada.</p>`
        : `<table style="width:100%;border-collapse:collapse;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;">
        <thead><tr>${["Motorista", "Placa", "Rota feita", "Saída", "Retorno", "Total", "Extras", "Status"].map((h) => th(h)).join("")}</tr></thead>
        <tbody>${rotasDia
          .map(
            (
              r,
              i,
            ) => `<tr style="background:${i % 2 === 0 ? "#fff" : "#f8fafc"};">
          ${td(r.motorista)}${td(r.placa)}${td(r.rotaFeita || "-")}
          ${td(r.saida || "-")}${td(r.retorno || "-")}
          ${td(`${r.horas || 0}h ${r.minutos || 0}min`)}
          ${td(
            `R$ ${Number(r.valorExtraAprox || 0)
              .toFixed(2)
              .replace(".", ",")}`,
          )}
          <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:10px;">${
            Number(r.minutosExcedentes || 0) > 0
              ? `<span style="color:#b91c1c;font-weight:800;background:#fef2f2;padding:2px 6px;border-radius:20px;">⚠️ Exc. ${relFormatarTempo(r.minutosExcedentes)}</span>`
              : `<span style="color:#047857;font-weight:700;">✅ OK</span>`
          }</td></tr>`,
          )
          .join("")}
        </tbody></table>`;

    const ckHtml =
      checklistDia.length === 0
        ? `<p style="color:#64748b;font-size:11px;margin:0;">Nenhum checklist registrado.</p>`
        : `<table style="width:100%;border-collapse:collapse;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;">
        <thead><tr>${["Motorista", "Placa", "Itens verificados", "Qtd", "Obs"].map((h) => th(h)).join("")}</tr></thead>
        <tbody>${checklistDia
          .map(
            (
              c,
              i,
            ) => `<tr style="background:${i % 2 === 0 ? "#fff" : "#f8fafc"};">
          ${td(c.motorista)}${td(c.placa)}
          ${td((c.itens || []).join(", ") || "-")}
          ${td(c.totalItens ?? (c.itens || []).length)}
          ${td(c.obs || "-")}</tr>`,
          )
          .join("")}
        </tbody></table>`;

    const almocoHtml =
      almocosDia.length === 0
        ? `<p style="color:#64748b;font-size:11px;margin:0;">Nenhum almoço registrado.</p>`
        : `<table style="width:100%;border-collapse:collapse;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;">
        <thead><tr>${["Motorista", "Previsto", "Real", "Duração Real", "Status", "Obs"].map((h) => th(h)).join("")}</tr></thead>
        <tbody>${almocosDia
          .map(
            (
              a,
              i,
            ) => `<tr style="background:${i % 2 === 0 ? "#fff" : "#f8fafc"};">
          ${td(a.motorista)}
          ${td(`${a.prevInicio || "-"} – ${a.prevFim || "-"}`)}
          ${td(`${a.realInicio || "-"} – ${a.realFim || "-"}`)}
          ${td(relFormatarTempo(a.tempoReal || 0))}
          <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:10px;">${
            a.status === "ok"
              ? `<span style="color:#047857;font-weight:700;">✅ OK</span>`
              : `<span style="color:#b91c1c;font-weight:800;background:#fef2f2;padding:2px 6px;border-radius:20px;">⚠️ +${relFormatarTempo(a.diferenca || 0)}</span>`
          }</td>
          ${td(a.obs || "-")}</tr>`,
          )
          .join("")}
        </tbody></table>`;

    const tacHtml =
      tacografosDia.length === 0
        ? `<p style="color:#64748b;font-size:11px;margin:0;">Nenhum tacógrafo registrado.</p>`
        : `<table style="width:100%;border-collapse:collapse;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;">
        <thead><tr>${["Motorista", "Placa", "Status", "Obs"].map((h) => th(h)).join("")}</tr></thead>
        <tbody>${tacografosDia
          .map(
            (
              t,
              i,
            ) => `<tr style="background:${i % 2 === 0 ? "#fff" : "#f8fafc"};">
          ${td(t.motorista)}${td(t.placa)}
          <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:10px;">${
            t.status === "Devolveu"
              ? `<span style="color:#047857;font-weight:700;">✅ Devolveu</span>`
              : t.status === "Não devolveu"
                ? `<span style="color:#b91c1c;font-weight:800;background:#fef2f2;padding:2px 6px;border-radius:20px;">❌ Não devolveu</span>`
                : `<span style="color:#64748b;">— N/A</span>`
          }</td>
          ${td(t.obs || "-")}</tr>`,
          )
          .join("")}
        </tbody></table>`;

    const diarioHtml =
      diariosDia.length === 0
        ? `<p style="color:#64748b;font-size:11px;margin:0;">Nenhum diário registrado.</p>`
        : `<table style="width:100%;border-collapse:collapse;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;">
        <thead><tr>${["Motorista", "Placa", "Status", "Obs"].map((h) => th(h)).join("")}</tr></thead>
        <tbody>${diariosDia
          .map(
            (
              d,
              i,
            ) => `<tr style="background:${i % 2 === 0 ? "#fff" : "#f8fafc"};">
          ${td(d.motorista)}${td(d.placa)}
          <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:10px;">${
            d.status === "Preencheu"
              ? `<span style="color:#047857;font-weight:700;">✅ Preencheu</span>`
              : d.status === "Não preencheu"
                ? `<span style="color:#b91c1c;font-weight:800;background:#fef2f2;padding:2px 6px;border-radius:20px;">❌ Não preencheu</span>`
                : `<span style="color:#64748b;">— N/A</span>`
          }</td>
          ${td(d.obs || "-")}</tr>`,
          )
          .join("")}
        </tbody></table>`;
    const secao = (emoji, titulo, html) => `
    <div style="margin-top:6px;break-inside:auto;page-break-inside:auto;">
      <div style="display:flex;align-items:center;gap:5px;background:#1e293b;color:#fff;padding:3px 8px;border-radius:4px 4px 0 0;font-size:8px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;break-after:avoid;page-break-after:avoid;">
        <span>${emoji}</span><span>${relEscape(titulo)}</span>
      </div>
      <div style="padding:5px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 4px 4px;background:#fff;break-inside:auto;page-break-inside:auto;">
        ${html}
      </div>
    </div>`;

    divRelatorio.innerHTML = `
    <div style="font-family:Arial,sans-serif;padding:8px 10px;background:#fff;color:#0f172a;max-width:720px;width:100%;margin:0 auto;box-sizing:border-box;">
      <style>
        * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
        @media print {
          @page { size: A4 portrait; margin: 6mm; }
          body { margin: 0 !important; }
          .no-break { page-break-inside: avoid; }
          .page-break { page-break-before: always; }
        }
      </style>

      <div style="display:flex;justify-content:space-between;align-items:center;background:#1e293b;color:#fff;border-radius:6px;padding:6px 12px;margin-bottom:6px;">
        <div style="font-size:12px;font-weight:900;letter-spacing:.2px;">${modoNarrativo ? "Relatório Executivo Narrativo" : "Relatório Operacional"}</div>
        <div style="font-size:8.5px;color:#94a3b8;">
          <b style="color:#e2e8f0;">${relEscape(relRotuloPeriodo(dataIni, dataFim))}</b>
          &nbsp;·&nbsp;Gerado: ${relEscape(geradoEm)}
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;margin-bottom:8px;">
        ${kpiHtml}
      </div>

      ${narrativaHtml}
      ${secao("🚚", `Entregas do Dia (${totalEntregas})`, entregasHtml)}
      ${secao("⏰", `Atrasos na Saída da Fábrica (${atrasosDia.length})`, atrasosHtml)}
      ${secao("🚛", `Tempo de Rota (${rotasDia.length})`, rotasHtml)}
      ${secao("🔧", `Checklists Diários (${checklistDia.length})`, ckHtml)}
      ${secao("🍽️", `Controle de Almoço (${almocosDia.length})`, almocoHtml)}
      ${secao("🕐", `Tacógrafo (${tacografosDia.length})`, tacHtml)}
      ${secao("📋", `Diário de Bordo (${diariosDia.length})`, diarioHtml)}
    </div>`;

    relAbrirContainer();
    container.dataset.modoRelatorio = modoNarrativo
      ? "narrativo"
      : "operacional";
  };

  window.gerarRelatorioIA = function () {
    window.gerarRelatorio(true);
  };

  window.gerarRelatorioProblemas = async function () {
    relGarantirCampoData();
    const container = relEl("containerRelatorio"),
      divRelatorio = relEl("relatorio");
    if (!container || !divRelatorio) {
      relAlertar("Não encontrei a área do relatório.");
      return;
    }

    const { ini: dataIni, fim: dataFim } = relIntervaloSelecionado();
    const entregasDia = relFiltrarPorIntervalo(
      ocorrencias,
      (o) => o.data_ocorrencia || o.data,
      dataIni,
      dataFim,
    );
    const filtroResponsavel = relValor("filtroResponsavelRelatorioProblemas");
    const rotuloFiltroResponsavel =
      relRotuloResponsavelProblemas(filtroResponsavel);
    const problemas = entregasDia
      .filter((o) => !!(o.teve_ocorrencia || o.tipo_problema))
      .filter((o) =>
        relOcorrenciaPassaFiltroResponsavel(o, filtroResponsavel),
      );

    let avulsas = [];
    try {
      const params = [];
      if (dataIni) params.push(`inicio=${encodeURIComponent(dataIni)}`);
      if (dataFim) params.push(`fim=${encodeURIComponent(dataFim)}`);
      const url = `${API_URL}/ocorrencias-avulsas${params.length ? `?${params.join("&")}` : ""}`;
      const resp = await fetch(url);
      if (resp.ok) {
        const lista = await resp.json();
        avulsas = (Array.isArray(lista) ? lista : []).filter((o) => {
          if (!filtroResponsavel) return true;
          if (filtroResponsavel === "__SEM_RESPONSAVEL__") return !o.culpa;
          return (
            normalizarResponsavelOcorrencia(o.culpa || "") ===
            normalizarResponsavelOcorrencia(filtroResponsavel)
          );
        });
      }
    } catch (e) {
      console.warn("[Relatorio] Falha ao carregar ocorrencias avulsas:", e);
    }

    let errosLoja = [];
    try {
      const params = ["limite=10000"];
      if (dataIni) params.push(`inicio=${encodeURIComponent(dataIni)}`);
      if (dataFim) params.push(`fim=${encodeURIComponent(dataFim)}`);
      const resp = await fetch(
        `${API_URL}/ocorrencias-operacionais?${params.join("&")}`,
      );
      if (resp.ok) {
        const data = await resp.json();
        errosLoja = Array.isArray(data.registros) ? data.registros : [];
        errosLoja = relFiltrarPorIntervalo(
          errosLoja,
          (o) => o.data_ocorrencia_fmt || o.data_ocorrencia,
          dataIni,
          dataFim,
        );
        errosLoja = errosLoja.filter((o) => {
          if (!filtroResponsavel || filtroResponsavel === "LOJA") return true;
          if (filtroResponsavel === "__SEM_RESPONSAVEL__") return false;
          return (
            normalizarResponsavelOcorrencia(o.area || "") ===
            normalizarResponsavelOcorrencia(filtroResponsavel)
          );
        });
      }
    } catch (e) {
      console.warn("[Relatorio] Falha ao carregar erros de loja:", e);
    }

    if (problemas.length === 0 && avulsas.length === 0 && errosLoja.length === 0) {
      relAlertar(
        `Nenhuma ocorrência encontrada em ${relRotuloPeriodo(dataIni, dataFim)}.`,
      );
      return;
    }

    const agora = new Date();
    const geradoEm = `${agora.toLocaleDateString("pt-BR")} às ${agora.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;

    const td = (v, extra = "") =>
      `<td style="padding:3px 6px;border-bottom:1px solid #f0f0f0;vertical-align:top;font-size:9px;color:#334155;${extra}">${relEscape(String(v ?? "-"))}</td>`;
    const th = (v, extra = "") =>
      `<th style="padding:4px 6px;background:#7f1d1d;color:#fee2e2;font-size:8px;text-align:left;font-weight:700;letter-spacing:.3px;text-transform:uppercase;white-space:nowrap;${extra}">${relEscape(String(v))}</th>`;

    // Agrupamento por tipo de problema
    const porTipo = {};
    problemas.forEach((o) => {
      const t = (o.tipo_problema || "Não classificado").trim();
      porTipo[t] = (porTipo[t] || 0) + 1;
    });
    avulsas.forEach((o) => {
      const t = (o.tipo_problema || o.titulo || "Não classificado").trim();
      porTipo[t] = (porTipo[t] || 0) + 1;
    });
    errosLoja.forEach((o) => {
      const t = (o.tipo || o.macro_falha || "Não classificado").trim();
      porTipo[t] = (porTipo[t] || 0) + 1;
    });
    const tiposOrdenados = Object.entries(porTipo).sort((a, b) => b[1] - a[1]);

    // Agrupamento por responsável
    const porResp = {};
    problemas.forEach((o) => {
      const r = (obterResponsavelOcorrencia(o) || "Não informado").trim();
      porResp[r] = (porResp[r] || 0) + 1;
    });
    avulsas.forEach((o) => {
      const r = (o.culpa || "Não informado").trim();
      porResp[r] = (porResp[r] || 0) + 1;
    });
    errosLoja.forEach((o) => {
      const r = (o.area || "LOJA").trim();
      porResp[r] = (porResp[r] || 0) + 1;
    });
    const respOrdenados = Object.entries(porResp).sort((a, b) => b[1] - a[1]);

    const totalEntregas = entregasDia.length;
    const pct =
      totalEntregas > 0
        ? Math.round((problemas.length / totalEntregas) * 100)
        : 0;

    const kpis = [
      { v: problemas.length, l: "Ocorrências Entrega", c: "#b91c1c" },
      { v: errosLoja.length, l: "Erros de Loja", c: "#dc2626" },
      { v: avulsas.length, l: "Ocorrências Avulsas", c: "#7c3aed" },
      { v: totalEntregas, l: "Total Entregas" },
      { v: pct + "%", l: "% c/ Ocorrência", c: "#b45309" },
    ];

    const kpiHtml = kpis
      .map(
        (k) => `
      <div style="background:#fff;border:1px solid #e2e8f0;border-top:3px solid ${k.c || "#94a3b8"};border-radius:5px;padding:6px 8px;text-align:center;">
        <div style="font-size:18px;font-weight:900;color:${k.c || "#0f172a"};">${relEscape(String(k.v))}</div>
        <div style="font-size:8px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.4px;margin-top:2px;">${relEscape(k.l)}</div>
      </div>`,
      )
      .join("");

    const resumoTiposHtml = `
      <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:5px;overflow:hidden;">
        <thead><tr>${[th("Tipo de Problema"), th("Qtd", "text-align:right;")].join("")}</tr></thead>
        <tbody>${tiposOrdenados
          .map(
            ([tipo, qtd], i) =>
              `<tr style="background:${i % 2 === 0 ? "#fff" : "#fef2f2"};">${td(tipo, "font-weight:700;color:#7f1d1d;")}${td(qtd, "text-align:right;font-weight:800;")}</tr>`,
          )
          .join("")}</tbody>
      </table>`;

    const resumoRespHtml = `
      <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:5px;overflow:hidden;">
        <thead><tr>${[th("Responsável"), th("Qtd", "text-align:right;")].join("")}</tr></thead>
        <tbody>${respOrdenados
          .map(
            ([resp, qtd], i) =>
              `<tr style="background:${i % 2 === 0 ? "#fff" : "#fef2f2"};">${td(resp, "font-weight:700;color:#92400e;")}${td(qtd, "text-align:right;font-weight:800;")}</tr>`,
          )
          .join("")}</tbody>
      </table>`;

    const statusCorAvulsa = (s) => {
      const v = String(s || "").toLowerCase();
      if (v.includes("resolv")) return "#047857";
      if (v.includes("anal")) return "#b45309";
      return "#b91c1c";
    };
    const avulsasHtml =
      avulsas.length === 0
        ? `<p style="color:#64748b;font-size:11px;margin:0;">Nenhuma ocorrência avulsa no período.</p>`
        : `<table style="width:100%;border-collapse:collapse;border-radius:5px;overflow:hidden;border:1px solid #e2e8f0;table-layout:fixed;">
        <colgroup>
          <col style="width:4%;" />
          <col style="width:10%;" />
          <col style="width:7%;" />
          <col style="width:18%;" />
          <col style="width:14%;" />
          <col style="width:10%;" />
          <col style="width:37%;" />
        </colgroup>
        <thead><tr>${["#", "Data", "Hora", "Título", "Setor culpado", "Status", "Descrição"]
          .map((h) => th(h))
          .join("")}</tr></thead>
        <tbody>${avulsas
          .map(
            (o, i) => `<tr style="background:${i % 2 === 0 ? "#fff" : "#fef2f2"};">
              ${td(o.id || i + 1, "font-weight:800;color:#7f1d1d;text-align:center;")}
              ${td(formatarDataBR(o.data_ocorrencia), "white-space:nowrap;")}
              ${td(String(o.hora_ocorrencia || "").slice(0, 5) || "--:--", "white-space:nowrap;text-align:center;")}
              ${td(o.titulo || "-", "font-weight:700;color:#0f172a;")}
              ${td(o.culpa || "Sem setor", "color:#92400e;font-weight:700;")}
              ${td(o.status || "Aberta", `color:${statusCorAvulsa(o.status)};font-weight:800;`)}
              ${td(o.descricao || "-", "color:#7f1d1d;word-break:break-word;white-space:normal;")}
            </tr>`,
          )
          .join("")}</tbody>
      </table>`;

    const detalhesHtml = `
      <table style="width:100%;border-collapse:collapse;border-radius:5px;overflow:hidden;border:1px solid #e2e8f0;table-layout:fixed;">
        <colgroup>
          <col style="width:3%;" />
          <col style="width:7%;" />
          <col style="width:10%;" />
          <col style="width:10%;" />
          <col style="width:6%;" />
          <col style="width:8%;" />
          <col style="width:6%;" />
          <col style="width:6%;" />
          <col style="width:10%;" />
          <col style="width:12%;" />
          <col style="width:22%;" />
        </colgroup>
        <thead><tr>${["#", "Data", "Loja", "Motorista", "Placa", "Rota", "Chegada", "Saída", "Tipo de Problema", "Responsável", "Descrição / Relato"]
          .map((h) => th(h))
          .join("")}</tr></thead>
        <tbody>${problemas
          .map((o, i) => {
            const responsavel = obterResponsavelOcorrencia(o);
            const numero = o.numero || o.id || i + 1;
            return `<tr style="background:${i % 2 === 0 ? "#fff" : "#fef2f2"};">
              ${td(numero, "font-weight:800;color:#7f1d1d;text-align:center;")}
              ${td(formatarDataBR(o.data_ocorrencia || o.data), "white-space:nowrap;")}
              ${td(relFormatarNomeLoja(o.loja), "font-weight:700;")}
              ${td(o.motorista || "-")}
              ${td(o.placa || "-")}
              ${td(obterRotaDaOcorrencia(o))}
              ${td(o.hora_chegada || "--:--")}
              ${td(o.fim_descarga || "--:--")}
              ${td(o.tipo_problema || "Não classificado", "color:#b91c1c;font-weight:700;")}
              ${td(responsavel || "-", "color:#92400e;font-weight:700;")}
              ${td(o.descricao || "-", "color:#7f1d1d;max-width:240px;word-break:break-word;white-space:normal;")}
            </tr>`;
          })
          .join("")}</tbody>
      </table>`;

    const errosLojaHtml =
      errosLoja.length === 0
        ? `<p style="color:#64748b;font-size:11px;margin:0;">Nenhum erro de loja importado no período.</p>`
        : `<table style="width:100%;border-collapse:collapse;border-radius:5px;overflow:hidden;border:1px solid #e2e8f0;table-layout:fixed;">
        <colgroup>
          <col style="width:5%;" /><col style="width:8%;" /><col style="width:11%;" />
          <col style="width:8%;" /><col style="width:11%;" /><col style="width:9%;" />
          <col style="width:13%;" /><col style="width:8%;" /><col style="width:9%;" />
          <col style="width:18%;" />
        </colgroup>
        <thead><tr>${["#", "Data", "Loja", "Rota", "Motorista", "Área", "Tipo", "Gravidade", "Origem", "Observação"]
          .map((h) => th(h))
          .join("")}</tr></thead>
        <tbody>${errosLoja
          .map(
            (o, i) => `<tr style="background:${i % 2 === 0 ? "#fff" : "#fef2f2"};">
              ${td(o.id_externo || o.id || i + 1, "font-weight:800;color:#7f1d1d;text-align:center;")}
              ${td(formatarDataBR(o.data_ocorrencia_fmt || o.data_ocorrencia), "white-space:nowrap;")}
              ${td(relFormatarNomeLoja(o.loja), "font-weight:700;")}
              ${td(o.rota || "-")}
              ${td(o.motorista || "-")}
              ${td(o.area || "LOJA", "color:#92400e;font-weight:700;")}
              ${td(o.tipo || o.macro_falha || "Não classificado", "color:#b91c1c;font-weight:700;")}
              ${td(o.gravidade || "-")}
              ${td(o.origem_erro || "-")}
              ${td(o.observacao || "-", "color:#7f1d1d;word-break:break-word;white-space:normal;")}
            </tr>`,
          )
          .join("")}</tbody>
      </table>`;

    const secao = (emoji, titulo, html) => `
      <div style="margin-top:8px;break-inside:auto;page-break-inside:auto;">
        <div style="display:flex;align-items:center;gap:6px;background:#7f1d1d;color:#fff;padding:4px 10px;border-radius:4px 4px 0 0;font-size:9px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;">
          <span>${emoji}</span><span>${relEscape(titulo)}</span>
        </div>
        <div style="padding:6px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 4px 4px;background:#fff;">${html}</div>
      </div>`;

    divRelatorio.innerHTML = `
      <div style="font-family:Arial,sans-serif;padding:10px 12px;background:#fff;color:#0f172a;max-width:1100px;width:100%;margin:0 auto;box-sizing:border-box;">
        <style>
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
          @media print {
            @page { size: A4 portrait; margin: 6mm; }
            body { margin: 0 !important; }
          }
        </style>

        <div style="display:flex;justify-content:space-between;align-items:center;background:#7f1d1d;color:#fff;border-radius:6px;padding:8px 14px;margin-bottom:8px;">
          <div style="font-size:13px;font-weight:900;letter-spacing:.2px;">⚠️ Relatório de Ocorrências e Erros de Loja</div>
          <div style="font-size:9px;color:#fecaca;">
            <b style="color:#fff;">${relEscape(relRotuloPeriodo(dataIni, dataFim))}</b>
            <span>&nbsp;|&nbsp;Culpa: ${relEscape(rotuloFiltroResponsavel)}</span>
            &nbsp;·&nbsp;Gerado: ${relEscape(geradoEm)}
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;margin-bottom:8px;">
          ${kpiHtml}
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;">
          ${secao("📊", `Por Tipo de Problema (${tiposOrdenados.length})`, resumoTiposHtml)}
          ${secao("👤", `Por Responsável (${respOrdenados.length})`, resumoRespHtml)}
        </div>

        ${secao("📋", `Detalhamento das Ocorrências (${problemas.length})`, detalhesHtml)}
        ${secao("🏪", `Erros de Loja Importados (${errosLoja.length})`, errosLojaHtml)}
        ${secao("📝", `Ocorrências Avulsas (${avulsas.length})`, avulsasHtml)}
      </div>`;

    relAbrirContainer();
    container.dataset.modoRelatorio = "problemas";
  };

  window.ocultarRelatorio = function () {
    relEl("containerRelatorio")?.classList.add("hidden");
  };
  window.excluirRelatorio = function () {
    confirmarSimples("Isso apenas oculta o relatório.", () =>
      window.ocultarRelatorio(),
    );
  };

  document.addEventListener("DOMContentLoaded", () => {
    relGarantirCampoData();
    const ini = relEl("dataRelatorio");
    const fim = relEl("dataRelatorioFim");
    if (ini && !ini.value) ini.value = relHojeISO();
    if (fim && !fim.value) fim.value = ini ? ini.value : relHojeISO();
    // mantém "Até" >= "De" automaticamente
    if (ini && fim) {
      ini.addEventListener("change", () => {
        if (!fim.value || fim.value < ini.value) fim.value = ini.value;
      });
      fim.addEventListener("change", () => {
        if (ini.value && fim.value < ini.value) ini.value = fim.value;
      });
    }
  });
})();

// ================================================================
// 25. BAIXAR PDF - CORRIGIDO SEM CORTAR LATERAL
// ================================================================
let pdfGerando = false;

window.baixarPDF = async function baixarPDF() {
  if (pdfGerando) return;

  const relatorio = $("relatorio");

  if (!relatorio || !relatorio.innerHTML.trim()) {
    alertar("Gere o relatório antes de baixar o PDF.");
    return;
  }

  if (typeof html2pdf !== "function") {
    alertar("A biblioteca html2pdf não foi carregada.");
    return;
  }

  pdfGerando = true;

  const dataIniPDF = getVal("dataRelatorio") || hojeISO();
  const dataFimPDF = getVal("dataRelatorioFim") || dataIniPDF;
  const dataRelatorio =
    dataIniPDF === dataFimPDF
      ? dataIniPDF
      : `${dataIniPDF}_a_${dataFimPDF}`;
  const modoDataset = $("containerRelatorio")?.dataset.modoRelatorio;
  const modoRelatorio =
    modoDataset === "narrativo"
      ? "narrativo"
      : modoDataset === "problemas"
        ? "problemas"
        : "operacional";

  document
    .querySelectorAll("#relatorioPDFTempWrap")
    .forEach((el) => el.remove());

  const orientacaoPDF = "portrait";
  const margemMmPDF = 6;
  const larguraFolhaMm = 210;
  const larguraUtilMm = larguraFolhaMm - margemMmPDF * 2;
  const larguraPDF = Math.floor((larguraUtilMm * 96) / 25.4);

  const wrap = document.createElement("div");
  wrap.id = "relatorioPDFTempWrap";

  Object.assign(wrap.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: larguraPDF + "px",
    maxWidth: larguraPDF + "px",
    minWidth: larguraPDF + "px",
    background: "#ffffff",
    color: "#0f172a",
    zIndex: "2147483647",
    overflow: "visible",
    padding: "0",
    margin: "0",
    boxSizing: "border-box",
    pointerEvents: "none",
  });

  const clone = relatorio.cloneNode(true);

  Object.assign(clone.style, {
    display: "block",
    width: "100%",
    maxWidth: "100%",
    minWidth: "0",
    margin: "0",
    padding: "0",
    background: "#ffffff",
    color: "#0f172a",
    overflow: "visible",
    boxSizing: "border-box",
    transform: "none",
  });

  const primeiroBloco = clone.firstElementChild;

  if (primeiroBloco) {
    Object.assign(primeiroBloco.style, {
      width: "100%",
      maxWidth: "none",
      minWidth: "0",
      margin: "0",
      padding: "10px 12px",
      boxSizing: "border-box",
      overflow: "visible",
    });
  }

  const estiloPDF = document.createElement("style");

  estiloPDF.innerHTML = `
    #relatorioPDFTempWrap,
    #relatorioPDFTempWrap * {
      box-sizing: border-box !important;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }

    #relatorioPDFTempWrap {
      font-family: Arial, sans-serif !important;
      background: #ffffff !important;
      color: #0f172a !important;
      overflow: visible !important;
    }

    #relatorioPDFTempWrap #relatorio,
    #relatorioPDFTempWrap #relatorio > div,
    #relatorioPDFTempWrap div,
    #relatorioPDFTempWrap section,
    #relatorioPDFTempWrap article {
      max-width: 100% !important;
      overflow: visible !important;
    }

    #relatorioPDFTempWrap * {
      transform: none !important;
      zoom: 1 !important;
    }

    #relatorioPDFTempWrap [style*="page-break-inside:avoid"],
    #relatorioPDFTempWrap [style*="page-break-inside: avoid"],
    #relatorioPDFTempWrap [style*="break-inside:avoid"],
    #relatorioPDFTempWrap [style*="break-inside: avoid"] {
      page-break-inside: auto !important;
      break-inside: auto !important;
    }

    #relatorioPDFTempWrap table {
      width: 100% !important;
      max-width: 100% !important;
      min-width: 0 !important;
      table-layout: fixed !important;
      border-collapse: collapse !important;
      margin-left: 0 !important;
      margin-right: 0 !important;
      overflow: visible !important;
      page-break-inside: auto !important;
      break-inside: auto !important;
    }

    #relatorioPDFTempWrap thead {
      display: table-header-group !important;
    }

    #relatorioPDFTempWrap tbody {
      display: table-row-group !important;
    }

    #relatorioPDFTempWrap tr {
      page-break-inside: auto !important;
      break-inside: auto !important;
    }

    #relatorioPDFTempWrap th,
    #relatorioPDFTempWrap td {
      font-size: 7px !important;
      padding: 3px 2px !important;
      white-space: normal !important;
      word-break: break-word !important;
      overflow-wrap: anywhere !important;
      vertical-align: top !important;
      line-height: 1.18 !important;
      max-width: none !important;
    }

    #relatorioPDFTempWrap th {
      font-size: 6.4px !important;
      font-weight: 700 !important;
      letter-spacing: 0 !important;
    }

    #relatorioPDFTempWrap img,
    #relatorioPDFTempWrap canvas,
    #relatorioPDFTempWrap svg {
      max-width: 100% !important;
      height: auto !important;
    }
  `;

  clone.prepend(estiloPDF);
  wrap.appendChild(clone);
  document.body.appendChild(wrap);

  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const alvoPDF = primeiroBloco || clone;
  const alturaPDF = Math.max(
    alvoPDF.scrollHeight,
    alvoPDF.offsetHeight,
    wrap.scrollHeight,
    1123,
  );

  try {
    await html2pdf()
      .set({
        margin: [margemMmPDF, margemMmPDF, margemMmPDF, margemMmPDF],
        filename: `relatorio-${modoRelatorio}-${dataRelatorio}.pdf`,
        image: {
          type: "jpeg",
          quality: 1,
        },
        html2canvas: {
          scale: 2,
          useCORS: true,
          allowTaint: true,
          backgroundColor: "#ffffff",
          scrollX: 0,
          scrollY: 0,
          windowWidth: larguraPDF,
          windowHeight: alturaPDF,
          logging: false,
        },
        jsPDF: {
          unit: "mm",
          format: "a4",
          orientation: orientacaoPDF,
          compress: true,
        },
        pagebreak: {
          mode: ["css", "legacy"],
          before: ".page-break",
          avoid: ["thead", "h1", "h2", "h3", ".rel-kpi"],
        },
      })
      .from(alvoPDF)
      .save();
  } catch (err) {
    console.error(err);
    alertar("Erro ao gerar PDF.");
  } finally {
    wrap.remove();
    pdfGerando = false;
  }
};

window.imprimirRelatorio = function imprimirRelatorio() {
  const relatorio = $("relatorio");
  if (!relatorio || !relatorio.innerHTML.trim()) {
    alertar("Gere o relatório antes de imprimir.");
    return;
  }
  document.body.classList.add("imprimindo-relatorio");
  const finalizar = () => {
    document.body.classList.remove("imprimindo-relatorio");
    window.removeEventListener("afterprint", finalizar);
  };
  window.addEventListener("afterprint", finalizar);
  window.print();
  setTimeout(finalizar, 1500);
};
