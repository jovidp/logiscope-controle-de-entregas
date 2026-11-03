// ================================================================
// 9. HISTÓRICO DE ENTREGAS — PAGINADO
// ================================================================
let paginaAtualHistorico = 1;
let itensPorPaginaHistorico = 10;
let filtroRotaPopulado = false;

function popularFiltroRotaHistorico(force = false) {
  const select = $("filtroRotaHistorico");
  if (!select || (filtroRotaPopulado && !force)) return;
  const atual = select.value;
  const rotas = [
    ...new Set(
      ocorrencias.map((o) => obterRotaDaOcorrencia(o)).filter(Boolean),
    ),
  ].sort();
  select.innerHTML =
    `<option value="">Todas as rotas</option>` +
    rotas
      .map((r) => `<option value="${escapar(r)}">${escapar(r)}</option>`)
      .join("");
  if (atual && rotas.includes(atual)) select.value = atual;
  filtroRotaPopulado = true;
}

function normalizarTexto(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function obterEntregasFiltradas() {
  const fData = getVal("filtroDataHistorico") || getVal("filtroData") || "";
  const fTexto = normalizarTexto(getVal("filtroTextoHistorico"));
  const fStatus = getVal("filtroStatusHistorico");
  const fRota = getVal("filtroRotaHistorico");

  return ordenarPorId(ocorrencias).filter((o) => {
    const data = String(o.data_ocorrencia || o.data || "").split("T")[0];
    const rota = obterRotaDaOcorrencia(o);
    const temOco = !!(
      o.teve_ocorrencia ||
      o.tipo_problema ||
      o.problema_operacional_tipo
    );
    if (fData && data !== fData) return false;
    if (fRota && rota !== fRota) return false;
    if (fStatus === "com" && !temOco) return false;
    if (fStatus === "sem" && temOco) return false;
    if (fTexto) {
      // Busca GERAL: varre todos os campos relevantes do registro. Aceita
      // varios termos separados por espaco (TODOS precisam aparecer, ex.:
      // "fabio itaguai"). Inclui data ISO e formatada (DD/MM/AAAA).
      const alvo = normalizarTexto(
        [
          o.id,
          o.loja,
          formatarNomeLoja(o.loja),
          rota,
          o.motorista,
          o.placa,
          o.ajudantes,
          o.recebedor,
          o.cargo,
          data,
          formatarDataBR(data),
          o.hora_chegada,
          o.hora_agendada_loja,
          o.inicio_descarga,
          o.termino_descarga,
          o.fim_descarga,
          o.hora_saida_fabrica,
          o.hora_marcada_saida,
          o.hora_recebedor,
          temOco ? "com ocorrencia" : "sem ocorrencia",
          o.tipo_problema,
          o.descricao,
          o.protocolo_imprevisto,
          o.ocorrencia_responsavel || o.ocorrenciaResponsavel,
          o.ocorrencia_status,
          o.ocorrencia_severidade,
          o.causa_raiz,
          o.acao_corretiva,
          o.problema_operacional_tipo,
          o.problema_operacional_relato,
          o.permanencia_justificativa,
          o.retirada_cx_prevista,
          o.retirada_cx_realizada,
          o.retirada_rt_prevista,
          o.retirada_rt_realizada,
          o.volume_gerencial,
          o.volume_fisico,
          o.transferencia_problema,
          o.transferencia_relato,
          o.sacola_status,
          o.sacola_relato,
          o.almoxerifado_status,
          o.almoxerifado_relato,
          o.material_envio_status,
          o.material_envio_relato,
          o.material_retirada_relato,
        ].join(" "),
      );
      const termos = fTexto.split(/\s+/).filter(Boolean);
      if (!termos.every((t) => alvo.includes(t))) return false;
    }
    return true;
  });
}

function renderizarAvisosAutomaticosOcorrencias() {
  const painel = $("painelAlertasOcorrencias");
  if (!painel) return;

  const hoje = hojeISO();
  const inicioSemana = new Date(`${hoje}T12:00:00`);
  inicioSemana.setDate(inicioSemana.getDate() - 6);
  const limiteRecente = [
    inicioSemana.getFullYear(),
    String(inicioSemana.getMonth() + 1).padStart(2, "0"),
    String(inicioSemana.getDate()).padStart(2, "0"),
  ].join("-");
  const encerrada = (o) =>
    [
      "tratada",
      "encerrada",
      "resolvida",
      "resolvido",
      "finalizada",
      "finalizado",
      "concluida",
      "concluido",
      "nao se aplica",
    ].includes(normalizarTexto(o.ocorrencia_status));
  const temProblema = (o) => !!(o.teve_ocorrencia || o.tipo_problema);
  const dataRegistro = (o) =>
    String(o.data_ocorrencia || o.data || "").split("T")[0];
  const recentes = ocorrencias.filter((o) => {
    const data = dataRegistro(o);
    return temProblema(o) && data >= limiteRecente && data <= hoje;
  });
  const avisos = [];
  const idsAvisados = new Set();
  const adicionar = (o, nivel, titulo, detalhe) => {
    if (o?.id && idsAvisados.has(o.id)) return;
    if (o?.id) idsAvisados.add(o.id);
    avisos.push({ o, nivel, titulo, detalhe });
  };

  ocorrencias.filter(temProblema).forEach((o) => {
    if (
      !encerrada(o) &&
      normalizarTexto(o.ocorrencia_severidade) === "critica"
    ) {
      adicionar(o, "critico", "Ocorrência crítica", "Prioridade imediata.");
    }
  });
  ocorrencias.filter(temProblema).forEach((o) => {
    const prazo = String(o.prazo_solucao || "").split("T")[0];
    if (!encerrada(o) && prazo && prazo < hoje) {
      adicionar(
        o,
        "critico",
        "Prazo vencido",
        `Solução prevista para ${formatarDataBR(prazo)}.`,
      );
    }
  });
  ocorrencias.filter(temProblema).forEach((o) => {
    const status = normalizarTexto(o.ocorrencia_status);
    if (
      ["aberta", "em analise", "em tratamento", "aguardando"].includes(
        status,
      ) &&
      dataRegistro(o) < hoje
    ) {
      adicionar(
        o,
        "atencao",
        "Tratativa pendente",
        "Aberta desde dia anterior.",
      );
    }
  });
  recentes.forEach((o) => {
    const responsavel = normalizarTexto(obterResponsavelOcorrencia(o));
    if (
      !encerrada(o) &&
      (!responsavel || responsavel === "nao informado")
    ) {
      adicionar(
        o,
        "atencao",
        "Sem responsável",
        "Defina quem tratará esta ocorrência.",
      );
    }
  });

  const porLoja = {};
  recentes.forEach((o) => {
    const loja = rotuloLoja(o.loja, "Loja não informada");
    porLoja[loja] = (porLoja[loja] || 0) + 1;
  });
  Object.entries(porLoja)
    .filter(([, total]) => total >= 3)
    .sort((a, b) => b[1] - a[1])
    .forEach(([loja, total]) => {
      avisos.push({
        nivel: "informativo",
        titulo: "Reincidência na loja",
        detalhe: `${loja}: ${total} ocorrências nos últimos 7 dias.`,
      });
    });

  const totais = {
    critico: avisos.filter((a) => a.nivel === "critico").length,
    atencao: avisos.filter((a) => a.nivel === "atencao").length,
    informativo: avisos.filter((a) => a.nivel === "informativo").length,
  };
  const cores = {
    critico: {
      cor: "var(--vermelho)",
      fundo: "rgba(248,113,113,0.08)",
      borda: "rgba(248,113,113,0.25)",
    },
    atencao: {
      cor: "var(--amarelo)",
      fundo: "rgba(251,191,36,0.08)",
      borda: "rgba(251,191,36,0.25)",
    },
    informativo: {
      cor: "var(--azul)",
      fundo: "rgba(56,189,248,0.08)",
      borda: "rgba(56,189,248,0.25)",
    },
  };
  const cards =
    avisos.length === 0
      ? `<div style="padding:12px;border-radius:var(--r-md);background:var(--verde-light);border:1px solid rgba(52,211,153,0.25);color:var(--verde);font-size:13px;font-weight:700;">Nenhum alerta automático identificado agora.</div>`
      : avisos
          .slice(0, 8)
          .map((aviso) => {
            const tema = cores[aviso.nivel];
            const local = aviso.o
              ? `${formatarNomeLoja(aviso.o.loja)} | ${formatarDataBR(dataRegistro(aviso.o))}`
              : "";
            return `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:${tema.fundo};border:1px solid ${tema.borda};border-radius:var(--r-md);">
              <div style="flex:1;min-width:0;">
                <div style="font-size:12px;font-weight:900;color:${tema.cor};text-transform:uppercase;">${escapar(aviso.titulo)}</div>
                <div style="font-size:12px;color:var(--text-secondary);margin-top:3px;">${escapar(aviso.detalhe)}${local ? ` <span style="color:var(--text-muted);">| ${escapar(local)}</span>` : ""}</div>
              </div>
              ${aviso.o ? `<button type="button" class="btn-ghost btn-sm" onclick="editarOcorrencia(${aviso.o.id})">Ver</button>` : ""}
            </div>`;
          })
          .join("");

  painel.innerHTML = `
    <div style="padding:14px;border-radius:var(--r-lg);border:1px solid var(--border);background:var(--bg-elevated);">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:12px;">
        <div>
          <div style="font-size:13px;font-weight:900;color:var(--text-heading);text-transform:uppercase;letter-spacing:.8px;">Avisos automáticos</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">Atualizado a partir das ocorrências e tratativas registradas.</div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <span style="padding:4px 9px;border-radius:999px;background:rgba(248,113,113,0.1);color:var(--vermelho);font-size:11px;font-weight:800;">${totais.critico} críticos</span>
          <span style="padding:4px 9px;border-radius:999px;background:rgba(251,191,36,0.1);color:var(--amarelo);font-size:11px;font-weight:800;">${totais.atencao} atenção</span>
          <span style="padding:4px 9px;border-radius:999px;background:rgba(56,189,248,0.1);color:var(--azul);font-size:11px;font-weight:800;">${totais.informativo} recorrências</span>
        </div>
      </div>
      <div style="display:grid;gap:8px;">${cards}</div>
      ${avisos.length > 8 ? `<div style="font-size:11px;color:var(--text-muted);margin-top:10px;">Mostrando 8 de ${avisos.length} alertas.</div>` : ""}
    </div>`;
}

function calcularMapaDeslocamentos(todos) {
  const grupos = new Map();
  todos.forEach((o) => {
    const data = String(o.data_ocorrencia || o.data || "").split("T")[0];
    const rota = obterRotaDaOcorrencia(o);
    const chave = data + "|" + rota;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(o);
  });
  const mapa = new Map();
  grupos.forEach((grupo) => {
    // Pernoite (rota de viagem): loja do dia seguinte vem depois do 1o dia, e
    // o pulo hotel -> loja nao e deslocamento entre lojas.
    const ordenado = [...grupo].sort((a, b) =>
      (a.dia_seguinte === true) - (b.dia_seguinte === true) ||
      (a.hora_chegada || "00:00").localeCompare(b.hora_chegada || "00:00"),
    );
    for (let i = 1; i < ordenado.length; i++) {
      const ant = ordenado[i - 1];
      const cur = ordenado[i];
      if ((ant.dia_seguinte === true) !== (cur.dia_seguinte === true)) continue;
      if (ant.fim_descarga && cur.hora_chegada) {
        const t = calcularPermanencia(ant.fim_descarga, cur.hora_chegada);
        if (t > 0)
          mapa.set(String(cur.id), { minutos: t, lojaAnterior: ant.loja });
      }
    }
  });
  return mapa;
}

function renderizarCardHistorico(o, mapaDeslocamentos = new Map()) {
  const espera = calcularPermanencia(o.hora_chegada, o.inicio_descarga);
  const descarga = calcularPermanencia(o.inicio_descarga, o.termino_descarga);
  const total = calcularPermanencia(o.hora_chegada, o.fim_descarga);
  const atrasoSaida = calcularPermanencia(
    o.hora_marcada_saida,
    o.hora_saida_fabrica,
  );
  const atrasoLoja = calcularPermanencia(o.hora_agendada_loja, o.hora_chegada);
  const esperaResponsavel = calcularPermanencia(
    o.hora_chegada,
    o.hora_recebedor,
  );
  const deslocInfo = mapaDeslocamentos.get(String(o.id));
  const deslocamento = deslocInfo ? deslocInfo.minutos : 0;
  const lojaAnterior = deslocInfo
    ? formatarNomeLoja(deslocInfo.lojaAnterior)
    : null;

  const temOco = o.teve_ocorrencia || !!o.tipo_problema;
  const temProb = !!o.problema_operacional_tipo;
  const ck =
    o.fez_checklist === true ||
    o.fez_checklist === "true" ||
    o.fez_checklist === "sim";

  const corBorda = temOco || temProb ? "var(--vermelho)" : "var(--verde)";
  const corSaida =
    o.hora_saida_fabrica &&
    o.hora_marcada_saida &&
    minutos(o.hora_saida_fabrica) > minutos(o.hora_marcada_saida)
      ? "var(--vermelho)"
      : "var(--verde)";
  const corChegada = atrasouAlemDaTolerancia(
    o.hora_agendada_loja,
    o.hora_chegada,
  )
    ? "var(--vermelho)"
    : "var(--verde)";

  // Atraso de SLA: chegou na loja MAIS de TOLERANCIA_ATRASO_MIN minutos depois
  // do horario agendado. Dentro da tolerancia nao conta como atraso.
  const temAtrasoLoja = atrasouAlemDaTolerancia(
    o.hora_agendada_loja,
    o.hora_chegada,
  );
  const atrasoSlaRegistrado = o.sla_status === "Atrasada";

  const cardHora = (
    titulo,
    valor,
    cor = "var(--text-heading)",
    icone = "🕐",
  ) => `
    <div class="historico-metrica historico-metrica-hora" style="text-align:center;background:var(--bg-base);padding:10px;border-radius:var(--r-md);border:1px solid var(--border);">
      <small style="display:block;color:var(--text-muted);font-weight:bold;font-size:10px;text-transform:uppercase;">${icone} ${titulo}</small>
      <b style="font-size:1rem;color:${cor};">${valor || "--:--"}</b>
    </div>`;

  const cardTempo = (
    titulo,
    valor,
    cor = "var(--text-heading)",
    icone = "⏱️",
  ) => `
    <div class="historico-metrica historico-metrica-tempo" style="text-align:center;background:var(--bg-base);padding:10px;border-radius:var(--r-md);border:1px solid var(--border);">
      <small style="display:block;color:var(--text-muted);font-weight:bold;font-size:10px;text-transform:uppercase;">${icone} ${titulo}</small>
      <b style="font-size:1.05rem;color:${cor};">${formatarTempo(valor)}</b>
    </div>`;

  const cardMetrica = (
    titulo,
    valor,
    subtitulo = "",
    cor = "var(--text-heading)",
    icone = "📦",
  ) => `
    <div class="historico-metrica" style="background:var(--bg-base);padding:11px;border-radius:var(--r-md);border:1px solid var(--border);">
      <small style="display:block;color:var(--text-muted);font-weight:bold;font-size:10px;text-transform:uppercase;">${icone} ${titulo}</small>
      <b style="display:block;font-size:1.05rem;color:${cor};margin-top:3px;">${formatarNumeroOperacional(valor)}</b>
      ${subtitulo ? `<span style="font-size:11px;color:var(--text-muted);font-weight:700;">${subtitulo}</span>` : ""}
    </div>`;

  const cardDivergencia = (titulo, valor, icone = "⚖️") => {
    const n = numeroOuNulo(valor);
    const cor = n === null || n === 0 ? "var(--verde)" : "var(--vermelho)";
    return `
      <div class="historico-metrica" style="background:var(--bg-base);padding:11px;border-radius:var(--r-md);border:1px solid var(--border);">
        <small style="display:block;color:var(--text-muted);font-weight:bold;font-size:10px;text-transform:uppercase;">${icone} ${titulo}</small>
        <b style="display:block;font-size:1rem;color:${cor};margin-top:3px;">${formatarDivergenciaOperacional(valor)}</b>
      </div>`;
  };

  const textoSacola = {
    correta: "Chegou corretamente",
    parcial: "Chegou parcial/com divergência",
    incorreta: "Não chegou/incorreta",
    na: "Não se aplica",
  };
  const textoTransferencia = {
    sim: "Houve problema",
    nao: "Sem problemas",
  };

  // Almoxerifado e Material de envio usam a mesma escala da sacola. Nao
  // viram card quando o registro nao tem nem status nem relato: sao
  // colunas criadas em 04/08/2026 e TODO registro anterior vem vazio —
  // um "-" fixo em cada card antigo so sujaria o historico inteiro.
  const textoRetirada = {
    correta: "Retirado corretamente",
    parcial: "Retirado parcialmente",
    incorreta: "Não foi retirado",
    na: "Não se aplica",
  };
  const cardConferencia = (titulo, status, relato, textos = textoSacola) => {
    if (!String(status ?? "").trim() && !String(relato ?? "").trim()) return "";
    const cor =
      status === "correta"
        ? "var(--verde)"
        : status === "incorreta"
          ? "var(--vermelho)"
          : status === "parcial"
            ? "var(--amarelo)"
            : "var(--text-heading)";
    return `
          <div style="background:var(--bg-base);padding:10px;border-radius:var(--r-md);border:1px solid var(--border);">
            <small style="display:block;color:var(--text-muted);font-weight:bold;font-size:10px;text-transform:uppercase;">${titulo}</small>
            <b style="display:block;font-size:0.95rem;color:${cor};">${escapar(textos[status] || status || "-")}</b>
            ${relato ? `<span style="font-size:11px;color:var(--text-secondary);">📝 ${escapar(relato)}</span>` : ""}
          </div>`;
  };

  const quantidadesHtml = `
      <div class="historico-bloco historico-quantidades" style="background:var(--bg-overlay);padding:14px;border-radius:var(--r-md);border:1px solid var(--border);margin-bottom:14px;">
        <p style="margin:0 0 10px 0;color:#ec4899;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:1px;">📦 Caixas e Retiradas</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:10px;">
          ${cardMetrica("CX prevista", o.retirada_cx_prevista, "Qtd. a retirar", "var(--azul)", "📦")}
          ${cardMetrica("CX retirada", o.retirada_cx_realizada, "Qtd. realizada", "var(--verde)", "✅")}
          ${cardDivergencia("Diferença CX", o.retirada_cx_divergencia, "⚖️")}
          ${cardMetrica("RT prevista", o.retirada_rt_prevista, "Retirada RT", "var(--roxo)", "🔄")}
          ${cardMetrica("RT retirada", o.retirada_rt_realizada, "Qtd. realizada", "var(--verde)", "✅")}
          ${cardDivergencia("Diferença RT", o.retirada_rt_divergencia, "⚖️")}
        </div>
        <p style="margin:10px 0 10px 0;color:#22d3ee;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:1px;">📊 Conferência de Volume</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:10px;">
          ${cardMetrica("Volume gerencial", o.volume_gerencial, "Sistema", "#22d3ee", "🧾")}
          ${cardMetrica("Volume físico", o.volume_fisico, "Conferido", "var(--verde)", "📦")}
          ${cardDivergencia("Diferença volume", o.volume_divergencia, "⚖️")}
          ${cardMetrica("Material campanha", o.material_campanha_qtd, "Quantidade", "#a855f7", "📋")}
          ${cardMetrica("Sacola P", o.sacola_p, "Pequena", "var(--verde)", "🛍️")}
          ${cardMetrica("Sacola M", o.sacola_m, "Média", "var(--verde)", "🛍️")}
          ${cardMetrica("Sacola G", o.sacola_g, "Grande", "var(--verde)", "🛍️")}
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px;">
          <div style="background:var(--bg-base);padding:10px;border-radius:var(--r-md);border:1px solid var(--border);">
            <small style="display:block;color:var(--text-muted);font-weight:bold;font-size:10px;text-transform:uppercase;">🚚 Transferência</small>
            <b style="display:block;font-size:0.95rem;color:${o.transferencia_problema === "sim" ? "var(--vermelho)" : o.transferencia_problema === "nao" ? "var(--verde)" : "var(--text-heading)"};">${escapar(textoTransferencia[o.transferencia_problema] || "-")}</b>
            ${o.transferencia_relato ? `<span style="font-size:11px;color:var(--text-secondary);">📝 ${escapar(o.transferencia_relato)}</span>` : ""}
          </div>
          <div style="background:var(--bg-base);padding:10px;border-radius:var(--r-md);border:1px solid var(--border);">
            <small style="display:block;color:var(--text-muted);font-weight:bold;font-size:10px;text-transform:uppercase;">🛍️ Sacola</small>
            <b style="display:block;font-size:0.95rem;color:var(--text-heading);">${escapar(textoSacola[o.sacola_status] || o.sacola_status || "-")}</b>
            ${o.sacola_relato ? `<span style="font-size:11px;color:var(--text-secondary);">📝 ${escapar(o.sacola_relato)}</span>` : ""}
          </div>
          ${cardConferencia("🏬 Almoxerifado", o.almoxerifado_status, o.almoxerifado_relato)}
          ${cardConferencia("📨 Material de envio", o.material_envio_status, o.material_envio_relato)}
          ${cardConferencia("↩️ Material de retirada", o.material_retirada_status, o.material_retirada_relato, textoRetirada)}
        </div>
      </div>`;

  // ---- OBSERVACOES DO FORMULARIO ----
  // O que o pessoal digita em campo de texto livre na ocorrencia ficava
  // enterrado dentro de "Detalhes completos". Quem confere o historico
  // quer ler o recado sem abrir nada, entao os textos sobem para um
  // bloco proprio, logo abaixo da conferencia de volume.
  //
  // Os relatos de transferencia, sacola, almoxerifado e material de
  // envio ficam de fora: cada um aparece colado no seu proprio status,
  // ali em cima, onde o texto so faz sentido. Repetir aqui poluiria.
  const observacoesFormulario = [
    ["📝 Observação", o.observacao],
    ["📮 Malote", o.malote_observacao],
    ["⏱️ Justificativa da permanência", o.permanencia_justificativa],
  ].filter(([, texto]) => String(texto ?? "").trim());

  const observacoesHtml = observacoesFormulario.length
    ? `
      <div class="historico-bloco historico-observacoes" style="background:var(--bg-overlay);padding:14px;border-radius:var(--r-md);border:1px solid var(--border);margin-bottom:14px;">
        <p style="margin:0 0 10px 0;color:#22d3ee;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:1px;">🗒️ Observações do formulário</p>
        <div style="display:grid;gap:8px;">
          ${observacoesFormulario
            .map(
              ([rotulo, texto]) => `
          <div style="background:var(--bg-base);padding:10px 12px;border-radius:var(--r-md);border:1px solid var(--border);border-left:3px solid rgba(34,211,238,0.55);">
            <small style="display:block;color:var(--text-muted);font-weight:bold;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;">${rotulo}</small>
            <span style="display:block;font-size:13px;color:var(--text-secondary);margin-top:4px;white-space:pre-wrap;word-break:break-word;">${escapar(String(texto).trim())}</span>
          </div>`,
            )
            .join("")}
        </div>
      </div>`
    : "";

  const corOtif =
    o.otif_status === "Conforme"
      ? "var(--verde)"
      : o.otif_status === "Nao conforme"
        ? "var(--vermelho)"
        : "var(--text-muted)";
  const evidencias = [
    ["Foto", o.pod_foto],
    ["Canhoto", o.pod_canhoto],
    ["Assinatura", o.pod_assinatura],
  ].filter(([, imagem]) => imagem);
  const premiumHtml = MODULOS_FUTUROS_ATIVOS
    ? `
      <div class="historico-bloco" style="background:var(--bg-overlay);padding:14px;border-radius:var(--r-md);border:1px solid var(--border);margin-bottom:14px;">
        <p style="margin:0 0 10px 0;color:var(--verde);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:1px;">Pedido, SLA e Custo</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;">
          <div style="background:var(--bg-base);padding:10px;border-radius:var(--r-md);border:1px solid var(--border);"><small style="display:block;color:var(--text-muted);font-weight:700;">PEDIDO / NF</small><b>${escapar(o.pedido_numero || "-")} / ${escapar(o.nota_fiscal || "-")}</b></div>
          <div style="background:var(--bg-base);padding:10px;border-radius:var(--r-md);border:1px solid var(--border);"><small style="display:block;color:var(--text-muted);font-weight:700;">SLA</small><b style="color:${corOtif};">${escapar(o.sla_status || "Sem prazo")}</b></div>
          <div style="background:var(--bg-base);padding:10px;border-radius:var(--r-md);border:1px solid var(--border);"><small style="display:block;color:var(--text-muted);font-weight:700;">OTIF</small><b style="color:${corOtif};">${escapar(o.otif_status || "Sem SLA")}</b></div>
          <div style="background:var(--bg-base);padding:10px;border-radius:var(--r-md);border:1px solid var(--border);"><small style="display:block;color:var(--text-muted);font-weight:700;">CUSTO TOTAL</small><b style="color:var(--amarelo);">${formatarMoeda(o.custo_total)}</b></div>
        </div>
      </div>
      <div class="historico-bloco" style="background:var(--bg-overlay);padding:14px;border-radius:var(--r-md);border:1px solid var(--border);margin-bottom:14px;">
        <p style="margin:0 0 10px 0;color:var(--azul);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:1px;">Comprovante Digital e Tratativa</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px;">
          <div style="background:var(--bg-base);padding:10px;border-radius:var(--r-md);border:1px solid var(--border);">
            <small style="display:block;color:var(--text-muted);font-weight:700;">POD</small>
            <b>${escapar(o.pod_status || "Pendente")}</b>
            ${o.pod_documento_recebedor ? `<span style="display:block;font-size:11px;color:var(--text-muted);">Documento: ${escapar(o.pod_documento_recebedor)}</span>` : ""}
            ${o.pod_confirmado_em ? `<span style="display:block;font-size:11px;color:var(--text-muted);">Confirmado: ${formatarDataBR(o.pod_confirmado_em)}</span>` : ""}
            ${o.gps_latitude && o.gps_longitude ? `<span style="display:block;font-size:11px;color:var(--text-muted);">GPS: ${escapar(o.gps_latitude)}, ${escapar(o.gps_longitude)}</span>` : ""}
          </div>
          <div style="background:var(--bg-base);padding:10px;border-radius:var(--r-md);border:1px solid var(--border);">
            <small style="display:block;color:var(--text-muted);font-weight:700;">TRATATIVA</small>
            <b>${escapar(o.ocorrencia_status || "-")} ${o.ocorrencia_severidade ? `| ${escapar(o.ocorrencia_severidade)}` : ""}</b>
            ${o.prazo_solucao ? `<span style="display:block;font-size:11px;color:var(--text-muted);">Prazo: ${formatarDataBR(o.prazo_solucao)}</span>` : ""}
          </div>
        </div>
        ${evidencias.length ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">${evidencias.map(([titulo, imagem]) => `<figure style="margin:0;"><img src="${escapar(imagem)}" alt="${titulo}" style="width:84px;height:70px;object-fit:cover;border-radius:7px;border:1px solid var(--border);"><figcaption style="font-size:10px;color:var(--text-muted);">${titulo}</figcaption></figure>`).join("")}</div>` : ""}
        ${o.causa_raiz ? `<p style="font-size:12px;color:var(--text-secondary);margin:10px 0 0;"><b>Causa raiz:</b> ${escapar(o.causa_raiz)}</p>` : ""}
        ${o.acao_corretiva ? `<p style="font-size:12px;color:var(--text-secondary);margin:5px 0 0;"><b>Ação corretiva:</b> ${escapar(o.acao_corretiva)}</p>` : ""}
      </div>`
    : "";
  // ---- DETALHES COMPLETOS (bloco recolhivel) ----
  // 25 colunas eram gravadas no banco e nunca apareciam aqui: malote,
  // permanencia, observacao, rastreio, campanha e os custos antigos.
  //
  // Vao para um <details> nativo em vez de irem direto para o card: o
  // card ja mostra 59 campos e ficaria longo demais para quem so
  // confere o dia. <details> resolve sem JS novo, e ja vem com
  // teclado e leitor de tela funcionando.
  //
  // Campo vazio nao vira linha, e grupo sem nenhuma linha nao vira
  // bloco — senao um registro simples abriria dezenas de tracinhos.
  const vazio = (v) => v === null || v === undefined || v === "";
  const fTexto = (v) => escapar(String(v));
  const fNum = (v) => formatarNumeroOperacional(v);
  const fMoeda = (v) => formatarMoeda(v);
  const fMin = (v) => formatarTempo(Number(v) || 0);
  const fBool = (v) =>
    v === true || v === "true" || v === "sim" ? "Sim" : "Não";

  // Campanha guarda dois campos por material (qual campanha + quantos).
  // Numa linha so: "Banner — Dia das Maes (3)".
  const linhaCampanha = (rotulo, nome, qtd) => {
    if (vazio(nome) && vazio(qtd)) return null;
    const partes = [];
    if (!vazio(nome)) partes.push(escapar(String(nome)));
    if (!vazio(qtd)) partes.push(`(${formatarNumeroOperacional(qtd)})`);
    return [rotulo, partes.join(" "), null];
  };

  const gruposDetalhe = [
    // Observacao do malote, justificativa da permanencia e observacao
    // geral sairam daqui: agora abrem direto no bloco "Observações do
    // formulário", acima. So o que nao e texto livre continua nesta lista.
    ["Malote", [
      ["Status", o.malote_status, fTexto],
    ]],
    ["Permanência e rastreio", [
      ["Permanência", o.permanencia_minutos, fMin],
      ["Responsável", o.ocorrencia_responsavel, fTexto],
      ["Protocolo de imprevisto", o.protocolo_imprevisto, fTexto],
      ["Nº do romaneio", o.romaneio_numero, fTexto],
    ]],
    ["Material de campanha e sacola", [
      linhaCampanha("Banner", o.campanha_banner_campanha, o.campanha_banner_qtd),
      linhaCampanha("Folder", o.campanha_folder_campanha, o.campanha_folder_qtd),
      linhaCampanha("Adesivo", o.campanha_adesivo_campanha, o.campanha_adesivo_qtd),
      linhaCampanha("Quadro", o.campanha_quadro_campanha, o.campanha_quadro_qtd),
      ["Qtd. de sacolas", o.sacola_qtd, fNum],
      ["Entrega completa", o.entrega_completa, fBool],
    ]],
    // A Secao 10 (Custos) saiu do formulario em 03/08/2026: registro
    // novo nao traz esses valores, so os antigos. Por isso o rotulo
    // avisa, em vez de parecer que alguem esqueceu de preencher.
    ["Custos (somente registros antigos)", [
      ["Km previsto", o.km_previsto, fNum],
      ["Km real", o.km_real, fNum],
      ["Custo por km", o.custo_km, fMoeda],
      ["Pedágio", o.pedagio, fMoeda],
      ["Custo de reentrega", o.custo_reentrega, fMoeda],
      ["Custo da ocorrência", o.custo_ocorrencia, fMoeda],
      ["Valor da carga", o.valor_carga, fMoeda],
    ]],
  ];

  let totalDetalhes = 0;
  const blocosDetalhe = gruposDetalhe
    .map(([titulo, linhas]) => {
      const validas = linhas.filter(Boolean).filter(([, v]) => !vazio(v));
      if (!validas.length) return "";
      totalDetalhes += validas.length;
      const itens = validas
        .map(([rot, val, fmt]) => `
          <div style="background:var(--bg-base);padding:9px 11px;border-radius:var(--r-sm);border:1px solid var(--border);">
            <small style="display:block;color:var(--text-muted);font-weight:bold;font-size:10px;text-transform:uppercase;">${rot}</small>
            <b style="display:block;font-size:0.95rem;color:var(--text-heading);margin-top:2px;word-break:break-word;">${fmt ? fmt(val) : val}</b>
          </div>`)
        .join("");
      return `
        <p style="margin:12px 0 8px 0;color:var(--text-muted);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:1px;">${titulo}</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px;">${itens}</div>`;
    })
    .join("");

  const detalhesHtml = blocosDetalhe
    ? `
      <details class="historico-bloco" style="background:var(--bg-overlay);padding:0 14px 12px;border-radius:var(--r-md);border:1px solid var(--border);margin-bottom:14px;">
        <summary style="cursor:pointer;padding:13px 0;color:var(--text-heading);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:1px;list-style:revert;">
          Detalhes completos <span style="color:var(--text-muted);font-weight:700;">(${totalDetalhes})</span>
        </summary>
        ${blocosDetalhe}
      </details>`
    : "";

  const origemTmsHtml = o.viagem_id || o.parada_id
    ? `<span style="display:inline-flex;margin-left:6px;font-size:11px;font-weight:800;color:var(--roxo);background:rgba(167,139,250,0.12);padding:3px 10px;border-radius:var(--r-sm);text-transform:uppercase;border:1px solid rgba(167,139,250,0.28);">TMS | Viagem ${escapar(o.viagem_id || "-")} | Parada ${escapar(o.parada_id || "-")}</span>`
    : "";

  return `
    <div class="item historico-card" style="border-left:6px solid ${corBorda};padding:22px;margin-bottom:20px;">
      <div class="historico-card-cabecalho" style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid var(--border);padding-bottom:14px;margin-bottom:18px;gap:14px;flex-wrap:wrap;">
        <div>
          <span style="font-size:11px;font-weight:800;color:var(--azul);background:var(--azul-light);padding:3px 10px;border-radius:var(--r-sm);text-transform:uppercase;border:1px solid rgba(56,189,248,0.2);">🆔 ID: ${o.id}</span>
          ${origemTmsHtml}
          <h2 class="historico-loja" style="margin:10px 0 0 0;font-size:1.5rem;border:none;padding:0;color:var(--text-heading);">📍 ${formatarNomeLoja(o.loja)}</h2>
        </div>
        <div style="text-align:right;">
          <span style="display:block;font-weight:800;font-size:1.1rem;color:var(--text-heading);">📅 ${formatarDataBR(o.data_ocorrencia)}</span>
          ${o.dia_seguinte === true ? `<span style="display:block;font-size:11px;font-weight:800;color:#0284c7;" title="Rota de viagem: loja feita no dia seguinte, depois do pernoite. A data acima é a da viagem.">🏨 feita no dia seguinte (pernoite)</span>` : ""}
          <span style="color:var(--text-muted);font-size:13px;">Rota: <b style="color:var(--text-secondary);">${obterRotaDaOcorrencia(o)}</b></span>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin-bottom:16px;">
        <div class="historico-bloco" style="background:var(--bg-overlay);padding:14px;border-radius:var(--r-md);border:1px solid var(--border);">
          <p style="margin:0 0 8px 0;color:var(--azul);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:1px;">🚛 Equipe de Transporte</p>
          <p style="margin:4px 0;color:var(--text-secondary);">👤 Motorista: <b style="color:var(--text-heading);">${o.motorista || "-"}</b></p>
          <p style="margin:4px 0;color:var(--text-secondary);">👥 Ajudantes: <b style="color:var(--text-heading);">${o.ajudantes || "S/ Ajudante"}</b></p>
          <p style="margin:0;color:var(--text-secondary);">🔢 Placa: <b style="color:var(--text-heading);">${o.placa || "-"}</b></p>
        </div>
        <div class="historico-bloco" style="background:var(--bg-overlay);padding:14px;border-radius:var(--r-md);border:1px solid var(--border);">
          <p style="margin:0 0 8px 0;color:var(--azul);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:1px;">🏢 Recebimento em Loja</p>
          <p style="margin:4px 0;color:var(--text-secondary);">🤝 Recebedor: <b style="color:var(--text-heading);">${o.recebedor || "-"}</b></p>
          <p style="margin:4px 0;color:var(--text-secondary);">💼 Cargo: <b style="color:var(--text-heading);">${o.cargo || "-"}</b></p>
          <p style="margin:0;color:var(--text-secondary);">🕐 Chegada do resp.: <b style="color:var(--text-heading);">${o.hora_recebedor || "--:--"}</b></p>
        </div>
      </div>

      <div class="historico-bloco historico-linha-tempo" style="background:var(--bg-overlay);padding:14px;border-radius:var(--r-md);border:1px solid var(--border);margin-bottom:14px;">
        <p style="margin:0 0 10px 0;color:var(--azul);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:1px;">🕐 Linha do Tempo da Rota</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:8px;">
          ${cardHora("Saída Marcada", o.hora_marcada_saida, "var(--azul)", "📌")}
          ${cardHora("Saída Real Fábrica", o.hora_saida_fabrica, corSaida, "🏭")}
          ${cardHora("Agendado Loja", o.hora_agendada_loja, "var(--roxo)", "📅")}
          ${cardHora("Chegada na Rota", o.hora_chegada, corChegada, "🚚")}
          ${cardHora("Início Descarga", o.inicio_descarga, "var(--verde)", "📦")}
          ${cardHora("Fim Descarga", o.termino_descarga, "var(--amarelo)", "✅")}
          ${cardHora("Saída da Loja", o.fim_descarga, "var(--text-heading)", "🏁")}
        </div>
      </div>

      <div class="historico-bloco historico-tempos" style="background:var(--bg-overlay);padding:14px;border-radius:var(--r-md);border:1px solid var(--border);margin-bottom:14px;">
        <p style="margin:0 0 10px 0;color:var(--amarelo);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:1px;">⏱️ Tempos calculados</p>
        ${
          deslocamento > 0
            ? `
        <div style="margin-bottom:10px;padding:8px 12px;background:rgba(56,189,248,0.07);border:1px solid rgba(56,189,248,0.2);border-radius:var(--r-md);display:flex;align-items:center;gap:8px;">
          <span style="font-size:1rem;">🚗</span>
          <span style="font-size:12px;color:var(--text-muted);">Deslocamento da loja anterior</span>
          ${lojaAnterior ? `<span style="font-size:11px;font-weight:700;color:var(--azul);background:var(--azul-light);padding:2px 8px;border-radius:6px;">${lojaAnterior}</span><span style="color:var(--text-muted);font-size:13px;">→</span>` : ""}
          <b style="margin-left:auto;font-size:1.1rem;color:${deslocamento > 30 ? "var(--amarelo)" : "var(--verde)"};">${formatarTempo(deslocamento)}</b>
        </div>`
            : ""
        }
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:8px;">
          ${cardTempo("Atraso saída", atrasoSaida, atrasoSaida > 0 ? "var(--vermelho)" : "var(--verde)", "🏭")}
          ${cardTempo("Atraso loja", atrasoLoja, atrasoLoja > 0 ? "var(--vermelho)" : "var(--verde)", "📍")}
          ${cardTempo("Espera/fila", espera, espera > 0 ? "var(--amarelo)" : "var(--verde)", "⏳")}
          ${cardTempo("Até responsável", esperaResponsavel, esperaResponsavel > 0 ? "var(--amarelo)" : "var(--verde)", "🤝")}
          ${cardTempo("Descarga", descarga, "var(--azul)", "📦")}
          ${cardTempo("Total em loja", total, "var(--text-heading)", "🏁")}
        </div>
      </div>

      ${quantidadesHtml}
      ${observacoesHtml}
      ${premiumHtml}

      <div style="background:${ck ? "var(--verde-light)" : "var(--verm-light)"};border:1px solid ${ck ? "rgba(52,211,153,0.25)" : "rgba(248,113,113,0.25)"};padding:12px;border-radius:var(--r-md);margin-bottom:14px;display:flex;align-items:center;gap:10px;">
        <span>${ck ? "✅" : "❌"}</span>
        <span style="font-weight:700;font-size:13px;color:${ck ? "var(--verde)" : "var(--vermelho)"};">CHECK-LIST DO VEÍCULO: ${ck ? "REALIZADO" : "NÃO REALIZADO"}</span>
      </div>

      ${
        temProb
          ? `
        <div style="background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.25);padding:14px;border-radius:var(--r-md);margin-bottom:14px;">
          <div style="color:var(--amarelo);font-weight:900;font-size:13px;margin-bottom:8px;">🚧 PROBLEMA OPERACIONAL: ${(o.problema_operacional_tipo || "N/A").toUpperCase()}</div>
          <p style="margin:0;font-size:13px;color:var(--text-secondary);background:var(--bg-base);padding:10px;border-radius:var(--r-sm);"><b>RELATO:</b> ${o.problema_operacional_relato || "Sem descrição adicional."}</p>
        </div>`
          : ""
      }

      ${
        temOco
          ? `
        <div style="background:var(--verm-light);border:1px solid rgba(248,113,113,0.25);padding:14px;border-radius:var(--r-md);margin-bottom:14px;">
          <div style="color:var(--vermelho);font-weight:900;font-size:13px;margin-bottom:8px;">⚠️ OCORRÊNCIA: ${(o.tipo_problema || "N/A").toUpperCase()}</div>
          <div style="color:var(--amarelo);font-weight:800;font-size:12px;margin-bottom:8px;"><b>RESPONSAVEL:</b> ${escapar(obterResponsavelOcorrencia(o) || "NAO INFORMADO")}</div>
          <p style="margin:0;font-size:13px;color:var(--text-secondary);background:var(--bg-base);padding:10px;border-radius:var(--r-sm);"><b>RELATO:</b> ${o.descricao || "Nenhum detalhe adicional informado."}</p>
        </div>`
          : `<div style="background:var(--verde-light);border:1px solid rgba(52,211,153,0.25);padding:12px;border-radius:var(--r-md);margin-bottom:14px;color:var(--verde);font-weight:bold;font-size:13px;">✅ OPERAÇÃO CONCLUÍDA SEM DIVERGÊNCIAS</div>`
      }

      ${typeof ocorrenciaFotosBotao === "function" ? ocorrenciaFotosBotao(o) : ""}
      ${detalhesHtml}

      <div class="historico-acoes" style="display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;">
        ${
          temAtrasoLoja
            ? atrasoSlaRegistrado
              ? `<span class="btn-sm" style="background:rgba(248,113,113,0.12);color:var(--vermelho);border:1px solid rgba(248,113,113,0.35);font-weight:800;cursor:default;">⏱️ ATRASO SLA REGISTRADO</span>`
              : `<button type="button" onclick="marcarAtrasoSla(${o.id})" class="btn-sm" style="background:var(--amarelo);color:#1a1a1a;font-weight:800;border:none;">⏱️ REGISTRAR ATRASO SLA</button>`
            : ""
        }
        <button onclick="editarOcorrencia(${o.id})" class="btn-blue btn-sm">✏️ EDITAR</button>
        <button onclick="excluirOcorrencia(${o.id})" class="btn-red btn-sm">🗑️ EXCLUIR</button>
      </div>
    </div>`;
}

function renderizarPaginacao(totalItens) {
  const container = $("paginacaoHistoricoOcorrencias");
  if (!container) return;
  const totalPag = Math.ceil(totalItens / itensPorPaginaHistorico);
  container.innerHTML = "";
  if (totalPag <= 1) return;

  const btn = (texto, pag, ativo, off) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = texto;
    b.disabled = off;
    b.className = ativo ? "pag-btn ativo" : "pag-btn";
    if (!off)
      b.onclick = () => {
        paginaAtualHistorico = pag;
        atualizarTela();
      };
    return b;
  };
  container.appendChild(
    btn("‹", paginaAtualHistorico - 1, false, paginaAtualHistorico === 1),
  );
  const pags = [];
  for (let i = 1; i <= totalPag; i++) {
    if (i === 1 || i === totalPag || Math.abs(i - paginaAtualHistorico) <= 1)
      pags.push(i);
  }
  let ultima = 0;
  pags.forEach((p) => {
    if (p - ultima > 1) {
      const s = document.createElement("span");
      s.textContent = "...";
      s.className = "pag-ellipsis";
      container.appendChild(s);
    }
    container.appendChild(btn(String(p), p, p === paginaAtualHistorico, false));
    ultima = p;
  });
  container.appendChild(
    btn(
      "›",
      paginaAtualHistorico + 1,
      false,
      paginaAtualHistorico === totalPag,
    ),
  );
}

function atualizarTela() {
  const lista = $("lista");
  if (!lista) return;

  const filtrados = obterEntregasFiltradas();
  const total = filtrados.length;
  const totalPag = Math.max(1, Math.ceil(total / itensPorPaginaHistorico));
  if (paginaAtualHistorico > totalPag) paginaAtualHistorico = totalPag;
  if (paginaAtualHistorico < 1) paginaAtualHistorico = 1;

  const inicio = (paginaAtualHistorico - 1) * itensPorPaginaHistorico;
  const pagina = filtrados.slice(inicio, inicio + itensPorPaginaHistorico);

  const info = $("infoHistoricoOcorrencias") || $("infoResultadosHistorico");
  const badge = $("badgeContadorHistorico");
  const textoInfo =
    total === 0
      ? "Nenhuma entrega encontrada."
      : `Mostrando ${inicio + 1} a ${Math.min(inicio + itensPorPaginaHistorico, total)} de ${total} entregas`;
  if (info) info.textContent = textoInfo;
  if (badge) {
    badge.style.display = "inline-flex";
    badge.textContent = total;
  }

  const mapaDeslocamentos = calcularMapaDeslocamentos(ocorrencias);
  lista.innerHTML =
    pagina.length === 0
      ? `<div style="text-align:center;padding:50px;color:var(--text-muted);background:var(--bg-elevated);border-radius:var(--r-lg);border:1px solid var(--border);">🔍 Nenhum registro encontrado.</div>`
      : pagina
          .map((o) => renderizarCardHistorico(o, mapaDeslocamentos))
          .join("");

  renderizarPaginacao(total);
}

function filtrarHistorico() {
  paginaAtualHistorico = 1;
  atualizarTela();
}
function limparFiltroHistorico() {
  [
    "filtroDataHistorico",
    "filtroData",
    "filtroTextoHistorico",
    "filtroStatusHistorico",
    "filtroRotaHistorico",
  ].forEach((id) => setVal(id, ""));
  const pp = $("itensPorPaginaOcorrencias");
  if (pp) pp.value = "10";
  itensPorPaginaHistorico = 10;
  paginaAtualHistorico = 1;
  atualizarTela();
}
function alterarItensPorPaginaOcorrencias() {
  itensPorPaginaHistorico = Number($("itensPorPaginaOcorrencias")?.value || 10);
  paginaAtualHistorico = 1;
  atualizarTela();
}
