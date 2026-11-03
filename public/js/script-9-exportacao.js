// ================================================================
// 27. EXPORTAÇÃO PARA PLANILHA XLSX
// ================================================================

const _MOTORISTAS_PLANILHA = [
  "RENATO MORAES",
  "SILVIO RAMOS",
  "FABIO NUNES",
  "MAURO DIAS",
  "NELSON PRADO",
  "HUGO TAVARES",
  "TIAGO DE MELO",
  "GILSON REIS",
  "SAMUEL COSTA",
  "CELSO BRITO",
  "EDSON",
  "RUBENS LIMA",
  "IVAN MOTA",
  "OTAVIO CRUZ",
  "ANTONIO LUZ",
  "NILTON",
];
// Passa pela mesma canonização de obterRotaDaOcorrencia para que o filtro de
// rota (porRot) compare nomes no mesmo namespace e nunca duplique grafias.
const _ROTAS_PLANILHA = [
  "BAIXADA I+R.SERRENA",
  "BAIXADA II",
  "BAIXADA III",
  "Z.NORTE I",
  "Z.NORTE II",
  "Z.OESTE I",
  "Z.OESTE II",
  "Z.OESTE IV",
  "ALTERNATIVA I",
  "CENTRO E Z.SUL",
  "R.LAGOS",
  "NORTE FLUMINENSE",
  "EXTRA-ENTREGA",
]
  .map((r) => (typeof canonizarRota === "function" ? canonizarRota(r) : r))
  .filter((v, i, a) => a.indexOf(v) === i);

function garantirCamposPeriodoPlanilha() {
  if (document.getElementById("dataInicioPlanilha")) return;
  const btnExportar =
    document.querySelector("button[onclick='exportarPlanilha()']") ||
    document.querySelector('button[onclick="exportarPlanilha()"]');
  if (!btnExportar) return;

  const sel = (id, opts, label, emoji) => `
    <div>
      <label for="${id}" style="font-size:11px;margin:0 0 4px;display:block;color:var(--text-muted,#64748b);font-weight:800;text-transform:uppercase;letter-spacing:.6px;">${emoji} ${label}</label>
      <select id="${id}" style="min-height:42px;padding:0 10px;border-radius:8px;border:1px solid var(--border,#334155);background:var(--bg-base,#0f172a);color:var(--text-heading,#f0f6ff);font-family:inherit;font-size:12px;font-weight:600;">
        <option value="">Todos</option>
        ${opts.map((o) => `<option value="${o}">${o}</option>`).join("")}
      </select>
    </div>`;

  const bloco = document.createElement("div");
  bloco.id = "blocoPeriodoPlanilha";
  bloco.style.cssText =
    "display:flex;align-items:end;gap:10px;flex-wrap:wrap;margin:12px 0;";
  bloco.innerHTML = `
    <div>
      <label for="dataInicioPlanilha" style="font-size:11px;margin:0 0 4px;display:block;color:var(--text-muted,#64748b);font-weight:800;text-transform:uppercase;letter-spacing:.6px;">📅 Data inicial</label>
      <input type="date" id="dataInicioPlanilha" style="min-height:42px;" />
    </div>
    <div>
      <label for="dataFimPlanilha" style="font-size:11px;margin:0 0 4px;display:block;color:var(--text-muted,#64748b);font-weight:800;text-transform:uppercase;letter-spacing:.6px;">📅 Data final</label>
      <input type="date" id="dataFimPlanilha" style="min-height:42px;" />
    </div>
    ${sel("filtroMotoristaPlanilha", _MOTORISTAS_PLANILHA, "Motorista", "🧑")}
    ${sel("filtroRotaPlanilha", _ROTAS_PLANILHA, "Rota", "🚛")}
    <button type="button" onclick="limparPeriodoPlanilha()"
      style="min-height:42px;padding:0 14px;background:rgba(148,163,184,0.12);border:1px solid var(--border,#334155);border-radius:8px;color:var(--text-secondary,#cbd5e1);font-size:12px;font-weight:700;cursor:pointer;">
      🧹 Limpar filtros
    </button>
    <div style="font-size:11px;color:var(--text-muted,#64748b);font-weight:600;align-self:end;padding-bottom:12px;">Em branco = exporta tudo</div>`;
  btnExportar.parentElement.insertBefore(bloco, btnExportar);
}

function limparPeriodoPlanilha() {
  [
    "dataInicioPlanilha",
    "dataFimPlanilha",
    "filtroMotoristaPlanilha",
    "filtroRotaPlanilha",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
}

async function exportarPlanilha() {
  if (typeof XLSX === "undefined") {
    alertar("❌ Biblioteca XLSX não carregada. Verifique sua conexão.");
    return;
  }

  garantirCamposPeriodoPlanilha();

  const dataInicio = getVal("dataInicioPlanilha");
  const dataFim = getVal("dataFimPlanilha");
  const filtroMotorista = getVal("filtroMotoristaPlanilha");
  const filtroRota = getVal("filtroRotaPlanilha");

  if (dataInicio && dataFim && dataInicio > dataFim) {
    alertar("⚠️ A data inicial deve ser anterior ou igual à data final.");
    return;
  }

  // Feedback visual no botão durante a busca
  const btnExp =
    document.querySelector("button[onclick='exportarPlanilha()']") ||
    document.querySelector('button[onclick="exportarPlanilha()"]');
  const txtOrig = btnExp ? btnExp.innerHTML : "";
  if (btnExp) {
    btnExp.innerHTML = "⏳ Buscando dados...";
    btnExp.disabled = true;
  }

  try {
    carregandoHistorico = false;
    await carregarHistorico(true);
  } catch (e) {
    console.warn("[planilha] Falha ao buscar dados frescos:", e);
  } finally {
    if (btnExp) {
      btnExp.innerHTML = txtOrig;
      btnExp.disabled = false;
    }
  }

  // ── HELPERS DE FILTRO ────────────────────────────────────────
  const porPeriodo = (lista, campoFn) => {
    if (!dataInicio && !dataFim) return lista;
    return lista.filter((item) => {
      const d = String(campoFn(item) || "").split("T")[0];
      if (!d) return false;
      if (dataInicio && d < dataInicio) return false;
      if (dataFim && d > dataFim) return false;
      return true;
    });
  };
  const porMot = (lista, fn = (i) => i.motorista) =>
    filtroMotorista
      ? lista.filter((i) => normTexto(fn(i)) === normTexto(filtroMotorista))
      : lista;
  const porRot = (lista, fn = (i) => i.rota) =>
    filtroRota
      ? lista.filter((i) => normTexto(fn(i)) === normTexto(filtroRota))
      : lista;

  const periodoTexto = (() => {
    const p = [];
    if (dataInicio && dataFim)
      p.push(`${formatarDataBR(dataInicio)} a ${formatarDataBR(dataFim)}`);
    else if (dataInicio) p.push(`A partir de ${formatarDataBR(dataInicio)}`);
    else if (dataFim) p.push(`Até ${formatarDataBR(dataFim)}`);
    else p.push("Todos os registros");
    if (filtroMotorista) p.push(`Motorista: ${filtroMotorista}`);
    if (filtroRota) p.push(`Rota: ${filtroRota}`);
    return p.join(" · ");
  })();

  // ── 1) ENTREGAS ─────────────────────────────────────────────
  const ocBase = porRot(
    porMot(porPeriodo(ocorrencias, (o) => o.data_ocorrencia || o.data)),
    (o) => obterRotaDaOcorrencia(o),
  );
  const mapaDeslocPlanilha = calcularMapaDeslocamentos(ocBase);
  const entregas = ocBase.map((o) => {
    const espera = calcularPermanencia(o.hora_chegada, o.inicio_descarga);
    const descarga = calcularPermanencia(o.inicio_descarga, o.termino_descarga);
    const total = calcularPermanencia(o.hora_chegada, o.fim_descarga);
    const deslocPlan = mapaDeslocPlanilha.get(String(o.id));
    return {
      ID: o.id || "",
      Data: formatarDataBR(o.data_ocorrencia || o.data),
      Loja: rotuloLoja(o.loja),
      Rota: obterRotaDaOcorrencia(o),
      Protocolo: o.protocolo_imprevisto || o.protocolo || "",
      Motorista: o.motorista || "",
      Placa: o.placa || "",
      Ajudantes: o.ajudantes || "",
      Recebedor: o.recebedor || "",
      Cargo: o.cargo || "",
      "Hora Recebedor": o.hora_recebedor || "",
      "Saída Marcada": o.hora_marcada_saida || "",
      "Saída Real Fábrica": o.hora_saida_fabrica || "",
      "Agendado Loja": o.hora_agendada_loja || "",
      "Chegada na Rota": o.hora_chegada || "",
      "Início Descarga": o.inicio_descarga || "",
      "Fim Descarga": o.termino_descarga || "",
      "Saída da Loja": o.fim_descarga || "",
      "Desloc. Loja Anterior (min)": deslocPlan ? deslocPlan.minutos : "",
      "Loja Anterior": deslocPlan
        ? formatarNomeLoja(deslocPlan.lojaAnterior)
        : "",
      "Espera (min)": espera || "",
      "Descarga (min)": descarga || "",
      "Total em Loja (min)": total || "",
      Checklist:
        o.fez_checklist === true ||
        o.fez_checklist === "true" ||
        o.fez_checklist === "sim"
          ? "Sim"
          : "Não",
      "Teve Ocorrência": o.teve_ocorrencia ? "Sim" : "Não",
      "Tipo Ocorrência": o.tipo_problema || "",
      "Responsável Ocorrência": obterResponsavelOcorrencia(o) || "",
      "Relato Ocorrência": o.descricao || "",
      "Problema Operacional": o.problema_operacional_tipo || "",
      "Relato Problema Op.": o.problema_operacional_relato || "",
      "Retirada CX Prevista": o.retirada_cx_prevista ?? "",
      "Retirada CX Realizada": o.retirada_cx_realizada ?? "",
      "Divergência CX": o.retirada_cx_divergencia ?? "",
      "Retirada RT Prevista": o.retirada_rt_prevista ?? "",
      "Retirada RT Realizada": o.retirada_rt_realizada ?? "",
      "Divergência RT": o.retirada_rt_divergencia ?? "",
      "Volume Gerencial": o.volume_gerencial ?? "",
      "Volume Físico": o.volume_fisico ?? "",
      "Divergência Volume": o.volume_divergencia ?? "",
      "Problema Transferência": textoSimNao(o.transferencia_problema),
      "Relato Transferência": o.transferencia_relato || "",
      "Status Sacola": o.sacola_status || "",
      "Relato Sacola": o.sacola_relato || "",
      "Qtd Material Campanha": o.material_campanha_qtd ?? "",
      "Sacola P": o.sacola_p ?? "",
      "Sacola M": o.sacola_m ?? "",
      "Sacola G": o.sacola_g ?? "",
      ...(MODULOS_FUTUROS_ATIVOS
        ? {
            Pedido: o.pedido_numero || "",
            "Nota Fiscal": o.nota_fiscal || "",
            Romaneio: o.romaneio_numero || "",
            "Valor da Carga": o.valor_carga ?? "",
            "Entrega Completa": o.entrega_completa ? "Sim" : "Nao",
            SLA: o.sla_status || "",
            OTIF: o.otif_status || "",
            "Severidade Ocorrencia": o.ocorrencia_severidade || "",
            "Status Tratativa": o.ocorrencia_status || "",
            "Causa Raiz": o.causa_raiz || "",
            "Acao Corretiva": o.acao_corretiva || "",
            "Prazo Solucao": formatarDataBR(o.prazo_solucao),
            "Km Previsto": o.km_previsto ?? "",
            "Km Real": o.km_real ?? "",
            "Custo por Km": o.custo_km ?? "",
            Pedagio: o.pedagio ?? "",
            "Custo Reentrega": o.custo_reentrega ?? "",
            "Custo Ocorrencia": o.custo_ocorrencia ?? "",
            "Custo Total": o.custo_total ?? "",
            "Status POD": o.pod_status || "",
            "Documento Recebedor POD": o.pod_documento_recebedor || "",
            "Latitude POD": o.gps_latitude || "",
            "Longitude POD": o.gps_longitude || "",
            "POD Confirmado Em": o.pod_confirmado_em || "",
          }
        : {}),
    };
  });

  // ── 2) AVISOS DE MONITORAMENTO ──────────────────────────────
  const avisos = porMot(porPeriodo(lerStorage(LS.avisos), (a) => a.data)).map(
    (a) => ({
      Data: formatarDataBR(a.data),
      Hora: a.hora || "",
      Motorista: a.motorista || "",
      Placa: a.placa || "",
      Rota: a.rota || "",
      Tipos: (a.tipos || []).join("; "),
      Status: a.status || "",
      Justificativa: a.justificativa || "",
    }),
  );

  // ── 3) CHECKLISTS ────────────────────────────────────────────
  const checklists = porMot(
    porPeriodo(lerStorage(LS.checklist), (c) => c.data),
  ).map((c) => ({
    Data: formatarDataBR(c.data),
    Motorista: c.motorista || "",
    Placa: c.placa || "",
    "Itens Verificados": (c.itens || []).join("; "),
    "Qtd Itens": c.totalItens ?? (c.itens || []).length,
    Observação: c.obs || "",
  }));

  // ── 4) ATRASOS NA SAÍDA DA FÁBRICA ──────────────────────────
  const atrasos = porRot(
    porMot(porPeriodo(lerStorage(LS.atrasos), (a) => a.data)),
  ).map((a) => ({
    Data: formatarDataBR(a.data),
    Motorista: a.motorista || "",
    Placa: a.placa || "",
    Rota: a.rota || "",
    "Hora Marcada": a.horaMarcada || a.hora_marcada || "",
    "Hora Real": a.horaReal || a.hora_real || "",
    "Atraso (min)": Number(a.atrasoMin || a.atraso_min || 0),
    "Atraso Formatado": a.atrasoFormatado || a.atraso_formatado || "",
    Justificativa: a.justificativa || "",
  }));

  // ── 5) TEMPO DE ROTA ────────────────────────────────────────
  const rotasReg = porMot(porPeriodo(lerStorage(LS.rotas), (r) => r.data)).map(
    (r) => ({
      Data: formatarDataBR(r.data),
      Motorista: r.motorista || "",
      Placa: r.placa || "",
      "Rota Feita": r.rotaFeita || r.rota_feita || "",
      Saída: r.saida || "",
      Retorno: r.retorno || "",
      "Total (min)": Number(r.totalMin || r.total_min || 0),
      "Horas Normais (min)": Number(r.minutosNormais || r.minutos_normais || 0),
      "Horas Extras (min)": Number(
        r.minutosExtrasPermitidos || r.minutos_extras_permitidos || 0,
      ),
      "Excedente (min)": Number(
        r.minutosExcedentes || r.minutos_excedentes || 0,
      ),
      "Valor Extra (R$)": Number(
        Number(r.valorExtraAprox || r.valor_extra_aprox || 0).toFixed(2),
      ),
      Observação: r.obs || "",
    }),
  );

  // ── 6) ALMOÇOS ──────────────────────────────────────────────
  const almocos = porMot(porPeriodo(lerStorage(LS.almocos), (a) => a.data)).map(
    (a) => ({
      Data: formatarDataBR(a.data),
      Motorista: a.motorista || "",
      "Prev. Início": a.prevInicio || a.prev_inicio || "",
      "Prev. Fim": a.prevFim || a.prev_fim || "",
      "Real Início": a.realInicio || a.real_inicio || "",
      "Real Fim": a.realFim || a.real_fim || "",
      "Duração Real (min)": Number(a.tempoReal || a.tempo_real || 0),
      "Duração Prevista (min)": Number(a.tempoPrev || a.tempo_prev || 0),
      "Diferença (min)": Number(a.diferenca || 0),
      Status: a.status === "ok" ? "Dentro do prazo" : "Excedeu",
      Observação: a.obs || "",
    }),
  );

  // ── 7) TACÓGRAFOS ───────────────────────────────────────────
  const tacografos = porMot(
    porPeriodo(lerStorage(LS.tacografos), (t) => t.data),
  ).map((t) => ({
    Data: formatarDataBR(t.data),
    Motorista: t.motorista || "",
    Placa: t.placa || "",
    Status: t.status || "",
    Observação: t.obs || "",
  }));

  // ── 8) DIÁRIOS DE BORDO ─────────────────────────────────────
  const diarios = porMot(porPeriodo(lerStorage(LS.diarios), (d) => d.data)).map(
    (d) => ({
      Data: formatarDataBR(d.data),
      Motorista: d.motorista || "",
      Placa: d.placa || "",
      Status: d.status || "",
      Observação: d.obs || "",
    }),
  );

  // ── 9) ESCALAS ──────────────────────────────────────────────
  const escalas = porRot(
    porMot(porPeriodo(lerStorage("entregasDia"), (e) => e.data)),
  ).map((e) => ({
    Data: formatarDataBR(e.data),
    Rota: e.rota || "",
    Missão: e.missao || "Principal",
    Motorista: e.motorista || "",
    Placa: e.placa || "",
    Ajudantes: e.ajudantes || "",
  }));

  // ── 10) RESUMO POR MOTORISTA ─────────────────────────────────
  const tacRaw = porPeriodo(lerStorage(LS.tacografos), (t) => t.data);
  const diarRaw = porPeriodo(lerStorage(LS.diarios), (d) => d.data);
  const ckRaw = porPeriodo(lerStorage(LS.checklist), (c) => c.data);
  const atrasosRaw = porPeriodo(lerStorage(LS.atrasos), (a) => a.data);

  const todosMots = [
    ...new Set(
      [
        ...ocBase.map((o) => o.motorista),
        ...tacRaw.map((t) => t.motorista),
      ].filter(Boolean),
    ),
  ].sort();

  const porMotorista = todosMots.map((mot) => {
    const eM = ocBase.filter((o) => normTexto(o.motorista) === normTexto(mot));
    const tot = eM.length;
    const com = eM.filter((o) => o.teve_ocorrencia).length;
    const sem = tot - com;

    const tacM = tacRaw.filter(
      (t) => normTexto(t.motorista) === normTexto(mot),
    );
    const tacD = tacM.filter(
      (t) => normTexto(t.status || "") === "devolveu",
    ).length;
    const diarM = diarRaw.filter(
      (d) => normTexto(d.motorista) === normTexto(mot),
    );
    const diarP = diarM.filter(
      (d) => normTexto(d.status || "") === "preencheu",
    ).length;
    const ckM = ckRaw.filter((c) => normTexto(c.motorista) === normTexto(mot));
    const atM = atrasosRaw.filter(
      (a) => normTexto(a.motorista) === normTexto(mot),
    );
    const atOk = atM.filter(
      (a) => Number(a.atrasoMin || a.atraso_min || 0) <= 0,
    ).length;

    return {
      Motorista: mot,
      "Total Entregas": tot,
      "Sem Ocorrência": sem,
      "Com Ocorrência": com,
      "Taxa Sucesso (%)": tot ? Math.round((sem / tot) * 100) : "",
      "Checklists Feitos": ckM.length,
      "Tacógrafos Devolvidos": tacD,
      "Total Tacógrafos": tacM.length,
      "Tacógrafo (%)": tacM.length
        ? Math.round((tacD / tacM.length) * 100)
        : "",
      "Diários Preenchidos": diarP,
      "Total Diários": diarM.length,
      "Diário (%)": diarM.length
        ? Math.round((diarP / diarM.length) * 100)
        : "",
      "Saídas Registradas": atM.length,
      "Saídas no Prazo": atOk,
      "Saída Pontual (%)": atM.length
        ? Math.round((atOk / atM.length) * 100)
        : "",
    };
  });

  // ── 11) RESUMO POR ROTA ──────────────────────────────────────
  const todasRotas = [
    ...new Set(ocBase.map((o) => obterRotaDaOcorrencia(o)).filter(Boolean)),
  ].sort();
  const porRota = todasRotas.map((rota) => {
    const eR = ocBase.filter((o) => obterRotaDaOcorrencia(o) === rota);
    const tot = eR.length;
    const com = eR.filter((o) => o.teve_ocorrencia).length;
    const sem = tot - com;
    const tempos = eR
      .map((o) => calcularPermanencia(o.hora_chegada, o.fim_descarga))
      .filter((t) => t > 0);
    const media = tempos.length
      ? Math.round(tempos.reduce((a, b) => a + b, 0) / tempos.length)
      : "";
    const mots = [...new Set(eR.map((o) => o.motorista).filter(Boolean))]
      .sort()
      .join(", ");
    return {
      Rota: rota,
      "Total Entregas": tot,
      "Sem Ocorrência": sem,
      "Com Ocorrência": com,
      "Taxa Sucesso (%)": tot ? Math.round((sem / tot) * 100) : "",
      "Média Tempo em Loja (min)": media,
      Motoristas: mots,
    };
  });

  // ── 12) RESUMO GERAL ─────────────────────────────────────────
  const totE = entregas.length;
  const comOco = entregas.filter((e) => e["Teve Ocorrência"] === "Sim").length;
  const semOco = totE - comOco;
  const taxa = totE ? Math.round((semOco / totE) * 100) + "%" : "0%";

  const resumo = [
    { Indicador: "Período", Valor: periodoTexto },
    { Indicador: "Gerado em", Valor: new Date().toLocaleString("pt-BR") },
    { Indicador: "", Valor: "" },
    { Indicador: "Total de Entregas", Valor: totE },
    { Indicador: "Sem Ocorrência", Valor: semOco },
    { Indicador: "Com Ocorrência", Valor: comOco },
    { Indicador: "Taxa de Sucesso", Valor: taxa },
    { Indicador: "", Valor: "" },
    { Indicador: "Motoristas analisados", Valor: porMotorista.length },
    { Indicador: "Rotas analisadas", Valor: porRota.length },
    { Indicador: "", Valor: "" },
    { Indicador: "Avisos de Monitoramento", Valor: avisos.length },
    { Indicador: "Checklists", Valor: checklists.length },
    { Indicador: "Atrasos na Saída", Valor: atrasos.length },
    { Indicador: "Rotas Registradas", Valor: rotasReg.length },
    { Indicador: "Almoços", Valor: almocos.length },
    { Indicador: "Tacógrafos", Valor: tacografos.length },
    { Indicador: "Diários de Bordo", Valor: diarios.length },
    { Indicador: "Escalas Registradas", Valor: escalas.length },
  ];

  // ── MONTAGEM DO WORKBOOK ─────────────────────────────────────
  const wb = XLSX.utils.book_new();

  const abas = [
    { nome: "Resumo", dados: resumo },
    { nome: "Por Motorista", dados: porMotorista },
    { nome: "Por Rota", dados: porRota },
    { nome: "Entregas", dados: entregas },
    { nome: "Escalas", dados: escalas },
    { nome: "Avisos Monitor.", dados: avisos },
    { nome: "Checklists", dados: checklists },
    { nome: "Atrasos Saída", dados: atrasos },
    { nome: "Rotas", dados: rotasReg },
    { nome: "Almoços", dados: almocos },
    { nome: "Tacógrafos", dados: tacografos },
    { nome: "Diários Bordo", dados: diarios },
  ];

  let abasCriadas = 0;
  abas.forEach(({ nome, dados }) => {
    if (!dados || dados.length === 0) return;
    const ws = XLSX.utils.json_to_sheet(dados);

    ws["!cols"] = Object.keys(dados[0]).map((k) => {
      const max = Math.max(
        k.length,
        ...dados.map((l) => String(l[k] ?? "").length),
      );
      return { wch: Math.min(Math.max(max + 2, 10), 55) };
    });

    ws["!views"] = [
      { state: "frozen", xSplit: 0, ySplit: 1, topLeftCell: "A2" },
    ];

    XLSX.utils.book_append_sheet(wb, ws, nome.substring(0, 31));
    abasCriadas++;
  });

  if (abasCriadas <= 1) {
    alertar(
      dataInicio || dataFim || filtroMotorista || filtroRota
        ? "Nenhum dado encontrado para os filtros selecionados."
        : "Nenhum dado encontrado para exportar.",
    );
    return;
  }

  const sufixo = (() => {
    if (dataInicio && dataFim) return `_${dataInicio}_a_${dataFim}`;
    if (dataInicio) return `_de_${dataInicio}`;
    if (dataFim) return `_ate_${dataFim}`;
    return "_completo";
  })();
  const hoje = new Date();
  const nomeArquivo = `Controle_Entregas${sufixo}_${hoje.toISOString().slice(0, 10)}_${hoje.toTimeString().slice(0, 5).replace(":", "h")}.xlsx`;

  XLSX.writeFile(wb, nomeArquivo);
  alertar(
    `✅ Planilha exportada (${abasCriadas - 1} aba(s) de dados) · ${periodoTexto}`,
  );
}

document.addEventListener("DOMContentLoaded", garantirCamposPeriodoPlanilha);
