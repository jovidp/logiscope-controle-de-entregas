// ================================================================
// 10. TORRE DE CONTROLE — RANKINGS
// ================================================================
function processarRankings() {
  const base = obterOcorrenciasAtivas();

  const itemRank = (nome, valor, cor, extra = "") => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);">
      <div>${nome}${extra ? `<div style="font-size:11px;color:var(--text-muted);">${extra}</div>` : ""}</div>
      <span style="font-weight:bold;color:${cor};">${valor}</span>
    </div>`;

  const rankMot = $("rankMotoristas");
  if (rankMot) {
    const mapa = {};
    base.forEach((o) => {
      const n = o.motorista || "Não informado";
      if (!mapa[n]) mapa[n] = { total: 0, oco: 0 };
      mapa[n].total++;
      if (o.teve_ocorrencia) mapa[n].oco++;
    });
    const rank = Object.entries(mapa)
      .map(([n, d]) => ({
        n,
        taxa:
          d.total === 0 ? 0 : Math.round(((d.total - d.oco) / d.total) * 100),
        total: d.total,
      }))
      .sort((a, b) => b.taxa - a.taxa)
      .slice(0, 5);
    rankMot.innerHTML =
      rank.length === 0
        ? `<p style="color:var(--text-muted);font-size:13px;">Sem dados.</p>`
        : rank
            .map((m, i) =>
              itemRank(
                `${i + 1}. ${m.n}`,
                `${m.taxa}%`,
                m.taxa >= 80 ? "var(--verde)" : "var(--vermelho)",
              ),
            )
            .join("");
  }

  const rankAju = $("rankAjudantes");
  if (rankAju) {
    // Descarga acima do limite (>40min / tolerância) é responsabilidade dos
    // ajudantes — por isso conta aqui, e não no ranking do motorista.
    const toMinAju = (h) => {
      if (!h) return 0;
      const [hh, mm] = String(h).split(":").map(Number);
      return hh * 60 + (mm || 0);
    };
    const descargaExcedeu = (o) => {
      const inicio = o.inicio_descarga;
      const saida = o.termino_descarga;
      if (!inicio || !saida) return false;
      const dur = toMinAju(saida) - toMinAju(inicio);
      if (dur <= 0) return false;
      return dur > limiteDescargaLoja(o.loja);
    };
    const mapa = {};
    base.forEach((o) => {
      const excedeu = descargaExcedeu(o);
      extrairAjudantes(o.ajudantes).forEach((n) => {
        if (!mapa[n]) mapa[n] = { total: 0, oco: 0, descarga: 0 };
        mapa[n].total++;
        if (o.teve_ocorrencia) mapa[n].oco++;
        if (excedeu) mapa[n].descarga++;
      });
    });
    const rank = Object.entries(mapa)
      .map(([n, d]) => ({ n, oco: d.oco, total: d.total, descarga: d.descarga }))
      // Ordena pelo total de problemas atribuídos (ocorrências + descargas excedidas).
      .sort(
        (a, b) =>
          b.oco + b.descarga - (a.oco + a.descarga) || b.total - a.total,
      )
      .slice(0, 5);
    rankAju.innerHTML =
      rank.length === 0
        ? `<p style="color:var(--text-muted);font-size:13px;">Sem dados.</p>`
        : rank
            .map((a, i) =>
              itemRank(
                `${i + 1}. ${a.n}`,
                `${a.oco} ⚠️${a.descarga ? ` · ${a.descarga} 📦` : ""}`,
                "var(--vermelho)",
              ),
            )
            .join("");
  }

  const rankEq = $("rankEquipesOcorrencias");
  if (rankEq) {
    const equipes = {};
    base.forEach((o) => {
      const k = `${o.motorista || "Sem motorista"} | ${o.ajudantes || "Sem ajudantes"}`;
      if (!equipes[k])
        equipes[k] = {
          motorista: o.motorista || "-",
          ajudantes: o.ajudantes || "-",
          total: 0,
          oco: 0,
        };
      equipes[k].total++;
      if (o.teve_ocorrencia) equipes[k].oco++;
    });
    const rank = Object.values(equipes)
      .map((e) => ({
        ...e,
        taxa: e.total === 0 ? 0 : Math.round((e.oco / e.total) * 100),
      }))
      .filter((e) => e.oco > 0)
      .sort((a, b) => b.oco - a.oco || b.taxa - a.taxa)
      .slice(0, 5);
    rankEq.innerHTML =
      rank.length === 0
        ? `<p style="color:var(--text-muted);font-size:13px;">Nenhuma equipe com ocorrência.</p>`
        : rank
            .map(
              (
                e,
                i,
              ) => `<div style="padding:10px 0;border-bottom:1px solid var(--border);">
          <div style="font-size:13px;font-weight:bold;color:var(--text-heading);margin-bottom:4px;">${i + 1}. ${e.motorista}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">${e.ajudantes}</div>
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-size:11px;color:var(--text-secondary);">${e.oco} ocorr. / ${e.total} entregas</span>
            <span style="font-weight:bold;color:var(--vermelho);">${e.taxa}%</span>
          </div>
        </div>`,
            )
            .join("");
  }

  const rankRot = $("rankRotas");
  if (rankRot) {
    const rotas = {};
    base.forEach((o) => {
      const r = obterRotaDaOcorrencia(o);
      if (!rotas[r]) rotas[r] = 0;
      if (o.teve_ocorrencia) rotas[r]++;
    });
    const rank = Object.entries(rotas)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    rankRot.innerHTML =
      rank.length === 0
        ? `<p style="color:var(--text-muted);font-size:13px;">Nenhuma rota crítica.</p>`
        : rank
            .map((r, i) =>
              itemRank(`${i + 1}. ${r[0]}`, `${r[1]} ⚠️`, "var(--vermelho)"),
            )
            .join("");
  }

  const rankLen = $("rankLojasLentas");
  if (rankLen) {
    const lojas = {};
    base.forEach((o) => {
      // Agrupa pelo nome JÁ POLIDO (canônico) — funde CAXIAS I com CAXIAS 1.
      const nome = rotuloLoja(o.loja, "Loja não informada");
      if (!lojas[nome]) lojas[nome] = { soma: 0, total: 0 };
      lojas[nome].soma += o.permanencia_minutos || 0;
      lojas[nome].total++;
    });
    const rank = Object.entries(lojas)
      .map(([n, d]) => ({
        n,
        media: d.total > 0 ? Math.round(d.soma / d.total) : 0,
      }))
      .filter((l) => l.media > 0)
      .sort((a, b) => b.media - a.media)
      .slice(0, 5);
    rankLen.innerHTML =
      rank.length === 0
        ? `<p style="color:var(--text-muted);font-size:13px;">Sem dados de tempo.</p>`
        : rank
            .map((l, i) =>
              itemRank(
                `${i + 1}. ${l.n}`,
                formatarTempo(l.media),
                "var(--amarelo)",
              ),
            )
            .join("");
  }
}

function atualizarListaCompacta() {
  const lista = $("listaCompacta");
  if (!lista) return;
  const recentes = ordenarPorId(obterOcorrenciasAtivas()).slice(0, 8);
  lista.innerHTML =
    recentes.length === 0
      ? `<p style="color:var(--text-muted);">Nenhum registro.</p>`
      : recentes
          .map(
            (o) => `
      <div style="background:var(--bg-overlay);padding:12px;border-radius:var(--r-md);border:1px solid var(--border);border-left:4px solid ${o.teve_ocorrencia ? "var(--vermelho)" : "var(--verde)"};margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <b style="font-size:13px;color:var(--text-heading);">${formatarNomeLoja(o.loja)}</b>
          <span style="font-size:11px;color:var(--text-muted);">${formatarDataBR(o.data_ocorrencia)}</span>
        </div>
        <span style="font-size:12px;color:var(--text-secondary);">🚛 ${o.motorista || "-"}</span>
        <span style="float:right;font-size:11px;color:${o.teve_ocorrencia ? "var(--vermelho)" : "var(--verde)"};font-weight:bold;">${o.teve_ocorrencia ? "⚠️ " + o.tipo_problema : "✅ OK"}</span>
      </div>`,
          )
          .join("");
}

// ================================================================
// 11. SALVAR / EXCLUIR OCORRÊNCIAS
// ================================================================
function checksGrupo(grupo) {
  return Array.from(
    document.querySelectorAll(
      `input[type="checkbox"][data-multi-group="${grupo}"]`,
    ),
  );
}
function selecionadosGrupo(grupo) {
  return checksGrupo(grupo)
    .filter((c) => c.checked)
    .map((c) => String(c.value || "").trim())
    .filter(Boolean);
}
const _multiEstado = {};

function sincronizarGrupoMulti(grupo) {
  const valores = checksGrupo(grupo)
    .filter((c) => c.checked)
    .map((c) => String(c.value || "").trim())
    .filter(Boolean);

  _multiEstado[grupo] = valores;

  const campo = $(grupo);
  if (campo) {
    if (campo.tagName === "SELECT") {
      Array.from(campo.options).forEach(
        (opt) => (opt.selected = valores.includes(opt.value)),
      );
    } else {
      campo.value = valores.join(", ");
    }
  }

  const contador = document.querySelector(`[data-multi-count="${grupo}"]`);
  if (contador) {
    contador.textContent =
      valores.length === 0
        ? "Nenhum selecionado"
        : valores.length === 1
          ? "1 selecionado"
          : `${valores.length} selecionados`;
  }

  if (grupo === "tipoOcorrencia") atualizarPainelKpisOcorrencia();

  return valores;
}

// ================================================================
// RELAÇÃO OCORRÊNCIA -> KPIs  (painel do formulário)
// ----------------------------------------------------------------
// Mostra, ao vivo, quais indicadores esta entrega vai alimentar e se ela
// conta como COMPLETA (In Full) — derivado da ocorrência lançada, não de
// um campo que ninguém preenche. As regras vivem em public/js/kpi-ocorrencia.js,
// o MESMO arquivo que o servidor usa para gravar sla_status/otif_status, então
// o que a tela promete é exatamente o que o banco grava.
// ================================================================
function relacaoKpiDoFormulario() {
  if (typeof classificarOcorrenciaKpi !== "function") return null;
  return classificarOcorrenciaKpi({
    teve_ocorrencia: getVal("teveOcorrencia") === "sim",
    tipo_problema:
      getVal("teveOcorrencia") === "sim" ? getVal("tipoOcorrencia") : "",
    sacola_status: getVal("sacolaStatus"),
    almoxerifado_status: getVal("almoxerifadoStatus"),
    material_envio_status: getVal("materialEnvioStatus"),
    volume_divergencia: calcularDivergenciaNumerica(
      numeroCampo("volumeGerencial"),
      numeroCampo("volumeFisico"),
    ),
  });
}

function atualizarPainelKpisOcorrencia() {
  const alvo = $("painelKpisOcorrencia");
  if (!alvo) return;
  const r = relacaoKpiDoFormulario();
  if (!r) {
    alvo.innerHTML = "";
    return;
  }

  const cor = r.inFull ? "var(--verde)" : "var(--vermelho)";
  const rgba = r.inFull ? "52, 211, 153" : "248, 113, 113";

  const selo = r.inFull
    ? "✅ Conta como <b>ENTREGA COMPLETA</b> (In Full)"
    : "❌ Conta como <b>ENTREGA INCOMPLETA</b> (In Full)";

  const porque = r.inFull
    ? r.tipos.length
      ? `Nenhuma das ocorrências lançadas indica falta de mercadoria.`
      : `Sem ocorrência que indique falta de mercadoria.`
    : `Motivo: ${r.inFullMotivos.join(" · ")}`;

  const chips = r.kpis
    .map(
      (k) =>
        `<span title="${escapar(k.motivos.join(" · "))}" style="display:inline-flex;align-items:center;gap:5px;background:var(--bg-overlay);border:1px solid var(--border);border-radius:999px;padding:3px 10px;font-size:11px;font-weight:700;">${k.icone} ${escapar(k.rotulo)}</span>`,
    )
    .join(" ");

  const aviso = r.desconhecidos.length
    ? `<div style="margin-top:8px;font-size:11px;color:var(--amarelo);font-weight:600;">⚠️ Tipo sem regra de KPI: ${r.desconhecidos.map(escapar).join(", ")} — não altera o In Full.</div>`
    : r.incerto
      ? `<div style="margin-top:8px;font-size:11px;color:var(--amarelo);font-weight:600;">⚠️ Ocorrência genérica: se faltou mercadoria, marque também o tipo específico (ex.: Mercadoria a menos).</div>`
      : "";

  alvo.innerHTML = `
    <div style="background:rgba(${rgba},0.06);border:1px solid rgba(${rgba},0.25);border-radius:var(--r-md);padding:12px 14px;">
      <div style="font-size:12px;font-weight:800;color:${cor};margin-bottom:2px;">${selo}</div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:9px;">${escapar(porque)}</div>
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:var(--text-muted);margin-bottom:6px;">Indicadores que esta entrega alimenta</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">${chips}</div>
      ${aviso}
    </div>`;
}
function marcarGrupoMulti(grupo, valorCampo) {
  const valores = String(valorCampo || "")
    .split(/,|;|\|/)
    .map((v) => v.trim())
    .filter(Boolean);
  checksGrupo(grupo).forEach((c) => (c.checked = valores.includes(c.value)));
  sincronizarGrupoMulti(grupo);
}
function limparGrupoMulti(grupo) {
  checksGrupo(grupo).forEach((c) => {
    c.checked = false;
    c.removeAttribute("checked");
  });
  const campo = $(grupo);
  if (campo) {
    if (campo.tagName === "SELECT") {
      Array.from(campo.options).forEach((opt) => (opt.selected = false));
    } else {
      campo.value = "";
    }
  }
  sincronizarGrupoMulti(grupo);
}

function inicializarTodosMultiChecks() {
  if (document._multiCheckDelegationAtivo) return;
  document._multiCheckDelegationAtivo = true;

  document.addEventListener(
    "change",
    function (e) {
      const cb = e.target;
      if (
        cb.tagName === "INPUT" &&
        cb.type === "checkbox" &&
        cb.dataset.multiGroup
      ) {
        e.stopPropagation();
        sincronizarGrupoMulti(cb.dataset.multiGroup);
      }
    },
    true,
  );

  const grupos = new Set(
    Array.from(
      document.querySelectorAll("input[type='checkbox'][data-multi-group]"),
    )
      .map((c) => c.dataset.multiGroup)
      .filter(Boolean),
  );
  grupos.forEach((grupo) => sincronizarGrupoMulti(grupo));
}
function validarFormulario() {
  if (!getVal("loja")) {
    alertar("Selecione uma loja!");
    return false;
  }
  if (!getVal("motorista")) {
    alertar("Selecione um motorista!");
    return false;
  }
  if (!getVal("dataOcorrencia")) {
    alertar("Informe a data da ocorrência!");
    return false;
  }
  if (!getVal("hora_chegada")) {
    alertar("Informe a hora de chegada na rota!");
    return false;
  }
  if (!getVal("inicioDescarga")) {
    alertar("Informe o início da descarga!");
    return false;
  }
  if (!getVal("saidaLoja")) {
    alertar("Informe a saída da loja!");
    return false;
  }
  return true;
}
// ================================================================
// LINK AUTOMÁTICO: SAÍDA DA FÁBRICA → FORMULÁRIO DE OCORRÊNCIA
// ================================================================
function normTexto(v) {
  return String(v || "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}
function normalizarPlacaSaida(v) {
  return String(v || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normPlaca(v) {
  return normalizarPlacaSaida(v);
}

function montarRelatoSaidaFabrica(saida) {
  if (!saida) return "";

  const atraso = Number(saida.atrasoMin || 0);

  const status =
    atraso > 0
      ? `Saiu com atraso de ${saida.atrasoFormatado || formatarTempo(atraso)}`
      : "Saiu no horário";

  return [
    "SAÍDA DA FÁBRICA VINCULADA AUTOMATICAMENTE",
    `Data: ${formatarDataBR(saida.data)}`,
    `Motorista: ${saida.motorista || "-"}`,
    `Placa: ${saida.placa || "-"}`,
    `Rota: ${saida.rota || "-"}`,
    `Hora marcada: ${saida.horaMarcada || "--:--"}`,
    `Hora real: ${saida.horaReal || "--:--"}`,
    `Status: ${status}`,
    saida.justificativa ? `Justificativa: ${saida.justificativa}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function garantirOpcaoSelect(id, valor) {
  const select = $(id);
  if (!select || !valor) return;

  const existe = Array.from(select.options).some((opt) => opt.value === valor);

  if (!existe) {
    const option = document.createElement("option");
    option.value = valor;
    option.textContent = valor;
    select.appendChild(option);
  }
}

function forcarMostrarProblemaOperacional(tipo, relato) {
  const select = $("tipoProblemaExtra");
  const campo = $("campoProblemaExtra");
  const textarea = $("relatoProblemaExtra");

  if (!select || !campo || !textarea) return;

  garantirOpcaoSelect("tipoProblemaExtra", tipo);

  select.value = tipo;

  campo.classList.remove("hidden");
  campo.style.display = "block";
  campo.style.visibility = "visible";
  campo.style.opacity = "1";

  textarea.value = relato || "";

  select.dispatchEvent(new Event("change", { bubbles: true }));
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
}

function garantirAlertaSaidaNoFormulario() {
  if ($("alertaSaidaFabricaVinculada")) return;

  const referencia = $("horaSaidaFabrica") || $("horaMarcadaSaida");
  if (!referencia) return;

  const bloco = referencia.closest("div")?.parentElement?.parentElement;

  if (!bloco) return;

  const alerta = document.createElement("div");
  alerta.id = "alertaSaidaFabricaVinculada";
  alerta.className = "hidden";
  alerta.style.cssText = `
    margin-top: 12px;
    padding: 12px 14px;
    border-radius: 10px;
    border: 1px solid rgba(249,115,22,0.35);
    background: rgba(249,115,22,0.10);
    color: var(--text-secondary);
    font-size: 12px;
    line-height: 1.5;
    grid-column: 1 / -1;
  `;

  bloco.appendChild(alerta);
}

function abrirProblemaOperacionalAutomatico(tipo, relato) {
  const select = document.getElementById("tipoProblemaExtra");
  const campo = document.getElementById("campoProblemaExtra");
  const textarea = document.getElementById("relatoProblemaExtra");

  if (!select || !campo || !textarea) return;

  const existe = Array.from(select.options).some((opt) => opt.value === tipo);

  if (!existe) {
    const option = document.createElement("option");
    option.value = tipo;
    option.textContent = tipo;
    select.appendChild(option);
  }

  select.value = tipo;

  campo.classList.remove("hidden");
  campo.style.display = "block";
  campo.style.visibility = "visible";
  campo.style.opacity = "1";

  textarea.value = relato || "";
}

function inicializarLinkSaidaFabricaOcorrencia() {
  ["dataOcorrencia", "motorista", "placa"].forEach((id) => {
    const campo = document.getElementById(id);
    if (!campo) return;

    campo.addEventListener("change", atualizarDadosOcorrenciaPeloDia);
    campo.addEventListener("input", atualizarDadosOcorrenciaPeloDia);
  });
}

async function atualizarDadosOcorrenciaPeloDia() {
  if (atualizandoDadosOcorrenciaPeloDia) return;
  atualizandoDadosOcorrenciaPeloDia = true;
  try {
    await preencherPlacaAjudantesDaRotaDoDia();
    preencherOcorrenciaComSaidaDoDia();
  } finally {
    atualizandoDadosOcorrenciaPeloDia = false;
  }
}
function buscarSaidaFabricaDoDia(data, motorista, placa) {
  const lista = lerStorage(LS.atrasos);

  const dataBusca = String(data || "").split("T")[0];
  const motoristaBusca = String(motorista || "").trim();
  const placaBusca = normalizarPlacaSaida(placa);

  if (!dataBusca || !motoristaBusca) return null;

  const saidasDoDia = lista.filter((item) => {
    const mesmaData = String(item.data || "").split("T")[0] === dataBusca;
    const mesmoMotorista =
      String(item.motorista || "").trim() === motoristaBusca;

    return mesmaData && mesmoMotorista;
  });

  if (saidasDoDia.length === 0) return null;

  if (placaBusca) {
    const porPlaca = saidasDoDia.find(
      (item) => normalizarPlacaSaida(item.placa) === placaBusca,
    );

    if (porPlaca) return porPlaca;
  }

  return [...saidasDoDia].sort(
    (a, b) => Number(b.id || 0) - Number(a.id || 0),
  )[0];
}

// "YYYY-MM-DD" -> dia anterior "YYYY-MM-DD" (sem fuso, sem virar mes/ano errado).
function diaAnteriorISO(dataISO) {
  const m = String(dataISO || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Ocorrencia do 2o dia de uma viagem (pernoite): nesse dia o motorista sai do
// HOTEL, nao da fabrica. Procura no registro de "Tempo de Rota" uma viagem do
// mesmo motorista cuja data (= saida da fabrica, dia 1) seja o dia ANTERIOR ao
// da ocorrencia, e devolve o horario de saida do hotel. Reaproveita o padrao de
// match de buscarSaidaFabricaDoDia (mesmo motorista; placa quando disponivel).
function buscarSaidaHotelDiaAnterior(data, motorista, placa) {
  const dataDia1 = diaAnteriorISO(String(data || "").split("T")[0]);
  const motoristaBusca = String(motorista || "").trim();
  if (!dataDia1 || !motoristaBusca) return null;

  const placaBusca = normalizarPlacaSaida(placa);

  const viagens = lerStorage(LS.rotas).filter((r) => {
    const ehViagem = r.isViagem === true || r.is_viagem === true;
    const temSaidaHotel = !!(r.saidaHotel || r.saida_hotel);
    const mesmaData = String(r.data || "").split("T")[0] === dataDia1;
    const mesmoMotorista = String(r.motorista || "").trim() === motoristaBusca;
    return ehViagem && temSaidaHotel && mesmaData && mesmoMotorista;
  });

  if (viagens.length === 0) return null;

  if (placaBusca) {
    const porPlaca = viagens.find(
      (r) => normalizarPlacaSaida(r.placa) === placaBusca,
    );
    if (porPlaca) return porPlaca;
  }

  return [...viagens].sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
}

async function carregarEntregasDiaBanco() {
  try {
    SERVER_CACHE.entregasDia = await apiStorageGet("entregasDia");
  } catch (err) {
    console.warn("[ocorrencia] Falha ao carregar /entregas-dia:", err);
  }

  return Array.isArray(SERVER_CACHE.entregasDia)
    ? SERVER_CACHE.entregasDia
    : [];
}

async function buscarEntregaRotaDoDia(data, motorista) {
  const dataBusca = String(data || "").split("T")[0];
  const motoristaBusca = normTexto(motorista);

  if (!dataBusca || !motoristaBusca) return null;

  let lista = lerStorage("entregasDia");
  if (lista.length === 0) lista = await carregarEntregasDiaBanco();

  const encontrados = lista.filter((item) => {
    const mesmaData =
      String(item.data || item.data_entrega || "").split("T")[0] === dataBusca;
    const mesmoMotorista = normTexto(item.motorista) === motoristaBusca;
    return mesmaData && mesmoMotorista;
  });

  if (encontrados.length === 0) {
    lista = await carregarEntregasDiaBanco();
    return (
      lista
        .filter((item) => {
          const mesmaData =
            String(item.data || item.data_entrega || "").split("T")[0] ===
            dataBusca;
          const mesmoMotorista = normTexto(item.motorista) === motoristaBusca;
          return mesmaData && mesmoMotorista;
        })
        .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0] || null
    );
  }

  return [...encontrados].sort(
    (a, b) => Number(b.id || 0) - Number(a.id || 0),
  )[0];
}

async function preencherPlacaAjudantesDaRotaDoDia() {
  const data = getVal("dataOcorrencia");
  const motorista = getVal("motorista");
  if (!data || !motorista) return null;

  const entrega = await buscarEntregaRotaDoDia(data, motorista);
  if (!entrega) return null;

  if (entrega.placa) {
    garantirOpcaoSelect("placa", entrega.placa);
    preencherCampo("placa", entrega.placa);
  }

  if (entrega.ajudantes) {
    marcarGrupoMulti("ajudantes", entrega.ajudantes);
  }

  return entrega;
}

function escalaNaDataERota(item, data, rota, missao) {
  const mesmaDataRota =
    String(item.data || item.data_entrega || "").split("T")[0] === data &&
    normTexto(item.rota) === normTexto(rota);
  if (!mesmaDataRota) return false;
  if (!missao) return true;
  return normTexto(item.missao || "Principal") === normTexto(missao);
}

function limparFormularioEscala() {
  setVal("escalaRota", "");
  setVal("escalaMissao", "Principal");
  setVal("escalaMotorista", "");
  setVal("escalaPlaca", "");
  limparGrupoMulti("escalaAjudantes");
  const av = document.getElementById("escalaMissaoAviso");
  if (av) av.style.display = "none";
}

async function atualizarOpcoesEscalaMissao() {
  const data = getVal("escalaData");
  const rota = getVal("escalaRota");
  const aviso = document.getElementById("escalaMissaoAviso");
  if (!aviso) return;
  if (!data || !rota) {
    aviso.style.display = "none";
    return;
  }
  const lista = await carregarEntregasDiaBanco();
  const existentes = lista.filter((item) =>
    escalaNaDataERota(item, data, rota),
  );
  if (existentes.length > 0) {
    const missoesUsadas = existentes
      .map((e) => e.missao || "Principal")
      .join(", ");
    aviso.textContent = `⚠️ Já existe escala nessa data: ${missoesUsadas}`;
    aviso.style.display = "block";
  } else {
    aviso.style.display = "none";
  }
}

async function salvarEscala() {
  const data = getVal("escalaData");
  const rota = getVal("escalaRota");
  const motorista = getVal("escalaMotorista");
  const missao = getVal("escalaMissao") || "Principal";

  if (!data || !rota || !motorista) {
    alertar("Preencha data, rota e motorista da escala.");
    return;
  }

  const lista = await carregarEntregasDiaBanco();
  const duplicada = lista.find((item) =>
    escalaNaDataERota(item, data, rota, missao),
  );
  if (duplicada) {
    alertar(
      `Já existe escala para ${rota} / ${missao} nessa data. Escolha uma missão diferente ou exclua a existente.`,
    );
    return;
  }

  const registro = {
    id: gerarIdCompatBanco(),
    data,
    rota,
    missao,
    motorista,
    placa: getVal("escalaPlaca"),
    ajudantes: selecionadosGrupo("escalaAjudantes").join(", "),
    obs: "",
  };

  try {
    const salvo = await apiStoragePost("entregasDia", registro);
    SERVER_CACHE.entregasDia = [
      salvo || registro,
      ...lerStorage("entregasDia").filter(
        (item) => String(item.id) !== String(registro.id),
      ),
    ];
    limparFormularioEscala();
    await renderizarListaEscalas();
    alertar("Escala salva com sucesso.");
  } catch (err) {
    console.error("[escala] Falha ao salvar:", err);
    alertar("Erro ao salvar a escala no servidor.");
  }
}

async function renderizarListaEscalas() {
  const container = $("listaEscalas");
  if (!container) return;

  const filtroData = getVal("escalaFiltroData");
  const registros = await carregarEntregasDiaBanco();
  const lista = registros
    .filter((item) => {
      if (!filtroData) return true;
      return (
        String(item.data || item.data_entrega || "").split("T")[0] ===
        filtroData
      );
    })
    .sort((a, b) => Number(b.id || 0) - Number(a.id || 0));

  if (lista.length === 0) {
    container.innerHTML =
      '<p style="color:var(--text-muted);font-size:13px;text-align:center;padding:16px;">Nenhuma escala registrada para a data.</p>';
    return;
  }

  container.innerHTML = lista
    .map((item) => {
      const missao = item.missao || "Principal";
      const ehMissao = missao !== "Principal";
      const corBorda = ehMissao ? "var(--roxo)" : "var(--azul)";
      const badgeMissao = ehMissao
        ? `<span style="font-size:10px;font-weight:700;background:rgba(167,139,250,.15);color:var(--roxo);border:1px solid rgba(167,139,250,.3);padding:2px 8px;border-radius:6px;margin-left:8px;">${escapar(missao)}</span>`
        : "";
      return `
        <div class="item" style="padding:12px 14px;margin-bottom:8px;border-left:4px solid ${corBorda};">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
            <div>
              <div style="font-size:13px;font-weight:800;color:var(--text-heading);display:flex;align-items:center;flex-wrap:wrap;gap:4px;">${escapar(item.rota || "-")}${badgeMissao}</div>
              <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">${escapar(item.motorista || "-")} ${item.placa ? ` | ${escapar(item.placa)}` : ""}</div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${escapar(formatarDataBR(item.data || item.data_entrega))} | Ajudantes: ${escapar(item.ajudantes || "Nenhum")}</div>
            </div>
            <button type="button" onclick="excluirEscala(${Number(item.id)})" class="btn-red btn-sm">Excluir</button>
          </div>
        </div>`;
    })
    .join("");
}

function excluirEscala(id) {
  confirmarSimples("Deseja excluir esta escala?", async () => {
    try {
      await apiStorageDelete("entregasDia", id);
      SERVER_CACHE.entregasDia = lerStorage("entregasDia").filter(
        (item) => String(item.id) !== String(id),
      );
      await renderizarListaEscalas();
    } catch (err) {
      console.error("[escala] Falha ao excluir:", err);
      alertar("Erro ao excluir a escala no servidor.");
    }
  });
}

async function preencherEscalaAutomatica() {
  const informativo = $("escalaAutoInfo");
  if (informativo) informativo.style.display = "none";

  const data = getVal("dataOcorrencia");
  const loja = getVal("loja");
  const rota = lojasRotas[loja];
  if (!data || !rota) return;

  let lista = lerStorage("entregasDia");
  let escalas = lista.filter((item) => escalaNaDataERota(item, data, rota));

  if (escalas.length === 0) {
    lista = await carregarEntregasDiaBanco();
    escalas = lista.filter((item) => escalaNaDataERota(item, data, rota));
  }
  if (escalas.length === 0) return;

  // Missão configurada para esta loja (se houver), senão "Principal"
  const missaoLoja = lojasMissoes[loja] || null;
  let escala;
  if (missaoLoja) {
    escala = escalas.find(
      (e) => normTexto(e.missao || "Principal") === normTexto(missaoLoja),
    );
  }
  // fallback: "Principal" ou, se só tiver uma, usa ela; se houver múltiplas sem configuração, usa a primeira
  if (!escala)
    escala =
      escalas.find((e) => !e.missao || e.missao === "Principal") || escalas[0];

  garantirOpcaoSelect("motorista", escala.motorista);
  garantirOpcaoSelect("placa", escala.placa);
  setVal("motorista", escala.motorista || "");
  setVal("placa", escala.placa || "");
  marcarGrupoMulti("ajudantes", escala.ajudantes || "");

  if (informativo) {
    const texto = $("escalaAutoInfoTexto");
    const missaoLabel =
      escala.missao && escala.missao !== "Principal"
        ? ` · ${escala.missao}`
        : "";
    const aviso =
      escalas.length > 1
        ? ` (${escalas.length} missões nessa data — verifique o motorista)`
        : "";
    if (texto)
      texto.textContent = `Equipe preenchida automaticamente - ${rota}${missaoLabel}${aviso}`;
    informativo.style.display = "flex";
  }

  atualizarDadosOcorrenciaPeloDia();
}

function mostrarProblemaOperacional(tipo, relato) {
  garantirOpcaoSelect("tipoProblemaExtra", tipo);

  const selectProblema = $("tipoProblemaExtra");
  const campoProblema = $("campoProblemaExtra");
  const relatoProblema = $("relatoProblemaExtra");

  if (selectProblema) {
    selectProblema.value = tipo;
    selectProblema.dispatchEvent(new Event("change", { bubbles: true }));
  }

  if (campoProblema) {
    campoProblema.classList.remove("hidden");
    campoProblema.style.display = "block";
  }

  if (relatoProblema && relato) {
    relatoProblema.value = relato;
    relatoProblema.dispatchEvent(new Event("input", { bubbles: true }));
    relatoProblema.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function preencherOcorrenciaComSaidaDoDia() {
  const data = getVal("dataOcorrencia");
  const motorista = getVal("motorista");
  const placa = getVal("placa");

  garantirAlertaSaidaNoFormulario();

  const alerta = $("alertaSaidaFabricaVinculada");

  if (!data || !motorista) {
    if (alerta) alerta.classList.add("hidden");
    return;
  }

  const saida = buscarSaidaFabricaDoDia(data, motorista, placa);

  if (!saida) {
    // Sem saida da fabrica no mesmo dia: pode ser o 2o dia de uma viagem
    // (pernoite). Nesse caso a partida do dia e a SAIDA DO HOTEL.
    const viagem = buscarSaidaHotelDiaAnterior(data, motorista, placa);
    if (viagem) {
      const saidaHotel = viagem.saidaHotel || viagem.saida_hotel || "";
      preencherCampo("horaMarcadaSaida", "");
      preencherCampo("horaSaidaFabrica", saidaHotel);
      if (alerta) {
        alerta.classList.remove("hidden");
        alerta.style.borderColor = "rgba(168,85,247,0.35)";
        alerta.style.background = "rgba(168,85,247,0.10)";
        alerta.innerHTML = `
          🏨 <b>2º dia da viagem — saída do hotel</b><br>
          Viagem de <b>${formatarDataBR(viagem.data)}</b> |
          Motorista: <b>${escapar(viagem.motorista)}</b> |
          Placa: <b>${escapar(viagem.placa || "-")}</b><br>
          Saída do hotel: <b>${escapar(saidaHotel || "--:--")}</b>
          (usada como saída do dia)
        `;
      }
      return;
    }
    if (alerta) {
      alerta.classList.remove("hidden");
      alerta.style.borderColor = "rgba(148,163,184,0.25)";
      alerta.style.background = "rgba(148,163,184,0.08)";
      alerta.innerHTML = `
        ℹ️ Nenhuma saída da fábrica encontrada para
        <b>${formatarDataBR(data)}</b> com o motorista
        <b>${escapar(motorista)}</b>.
      `;
    }
    return;
  }

  preencherCampo("horaMarcadaSaida", saida.horaMarcada || "");
  preencherCampo("horaSaidaFabrica", saida.horaReal || "");

  const atraso = Number(saida.atrasoMin || 0);

  // O problema operacional NÃO é preenchido automaticamente — fica a critério
  // do usuário. Aqui só vinculamos as horas e exibimos o aviso informativo.

  if (alerta) {
    alerta.classList.remove("hidden");
    alerta.style.borderColor =
      atraso > 0 ? "rgba(248,113,113,0.35)" : "rgba(52,211,153,0.35)";
    alerta.style.background =
      atraso > 0 ? "rgba(248,113,113,0.10)" : "rgba(52,211,153,0.10)";

    alerta.innerHTML = `
      ${atraso > 0 ? "⚠️" : "✅"}
      <b>Saída da fábrica vinculada ao formulário</b><br>
      Data: <b>${formatarDataBR(saida.data)}</b> |
      Motorista: <b>${escapar(saida.motorista)}</b> |
      Placa: <b>${escapar(saida.placa || "-")}</b> |
      Rota: <b>${escapar(saida.rota || "-")}</b><br>
      Marcada: <b>${escapar(saida.horaMarcada || "--:--")}</b> |
      Real: <b>${escapar(saida.horaReal || "--:--")}</b> |
      Atraso: <b>${escapar(saida.atrasoFormatado || formatarTempo(atraso))}</b>
      ${
        saida.justificativa
          ? `<br>Justificativa: <b>${escapar(saida.justificativa)}</b>`
          : ""
      }
    `;
  }
}

// Empurrãozinho de qualidade: campo vazio que enfraquece um indicador.
// Aviso leve — não bloqueia, só pede confirmação consciente.
//
// SÓ COBRA O HORÁRIO AGENDADO. Sem ele o SLA cai em "Sem prazo" e a entrega
// realmente sai do cálculo de pontualidade — aí o aviso é verdadeiro. O
// horário só é cobrado se a loja NÃO estiver marcada como "sem horário"
// (metas_loja): loja sem horário em branco é legítimo, não é lacuna.
//
// NÃO cobra mais "Entrega completa? (In Full)": esse campo é DERIVADO da
// ocorrência lançada (kpi-ocorrencia.js). A entrega entra no OTIF de qualquer
// jeito — o painel acima do botão mostra como ela vai contar.
async function confirmarCamposQualidade() {
  const semHorario =
    typeof window.lojaSemHorario === "function" &&
    window.lojaSemHorario(getVal("loja"));
  if (semHorario || getVal("horaAgendadaLoja")) return true;
  return await confirmarBonito(
    "⚠️ Sem o horário agendado da loja não há meta para comparar.\n\n" +
      "Esta entrega ENTRA nos KPIs, mas fica como “Sem prazo”: não conta na " +
      "pontualidade (SLA) nem no OTIF.\n\nSalvar mesmo assim?",
    { okLabel: "Salvar assim", cancelLabel: "Voltar e preencher" },
  );
}

async function salvar() {
  if (!validarFormulario()) return;
  if (!(await confirmarCamposQualidade())) return;

  preencherOcorrenciaComSaidaDoDia();

  sincronizarGrupoMulti("ajudantes");
  const tipoProblemaSalvo = getVal("tipoProblemaExtra");
  const relatoProblemaSalvo = getVal("relatoProblemaExtra");

  sincronizarGrupoMulti("ajudantes");
  const dosCbs = checksGrupo("ajudantes")
    .filter((c) => c.checked)
    .map((c) => String(c.value || "").trim())
    .filter(Boolean);

  const doCampo = String(getVal("ajudantes") || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  const ajudantes = (dosCbs.length > 0 ? dosCbs : doCampo).join(", ");

  const retiradaCxPrevista = numeroCampo("retiradaCxPrevista");
  const retiradaCxRealizada = numeroCampo("retiradaCxRealizada");
  const retiradaRtPrevista = numeroCampo("retiradaRtPrevista");
  const retiradaRtRealizada = numeroCampo("retiradaRtRealizada");
  const volumeGerencial = numeroCampo("volumeGerencial");
  const volumeFisico = numeroCampo("volumeFisico");
  const materialCampanhaQtd = numeroCampo("materialCampanhaQtd");
  const campanhaBannerQtd = numeroCampo("campanhaBannerQtd");
  const campanhaFolderQtd = numeroCampo("campanhaFolderQtd");
  const campanhaAdesivoQtd = numeroCampo("campanhaAdesivoQtd");
  const campanhaQuadroQtd = numeroCampo("campanhaQuadroQtd");
  const sacolaP = numeroCampo("sacolaP");
  const sacolaM = numeroCampo("sacolaM");
  const sacolaG = numeroCampo("sacolaG");
  const sacolaQtd = (sacolaP ?? 0) + (sacolaM ?? 0) + (sacolaG ?? 0) || null;
  const retiradaCxDivergencia = calcularDivergenciaNumerica(
    retiradaCxPrevista,
    retiradaCxRealizada,
  );
  const retiradaRtDivergencia = calcularDivergenciaNumerica(
    retiradaRtPrevista,
    retiradaRtRealizada,
  );
  const volumeDivergencia = calcularDivergenciaNumerica(
    volumeGerencial,
    volumeFisico,
  );
  let podFoto;
  let podCanhoto;
  let podAssinatura;
  try {
    [podFoto, podCanhoto, podAssinatura] = await Promise.all([
      lerArquivoEvidencia("podFoto", "podFotoAtual"),
      lerArquivoEvidencia("podCanhoto", "podCanhotoAtual"),
      lerArquivoEvidencia("podAssinatura", "podAssinaturaAtual"),
    ]);
  } catch (erro) {
    console.warn("POD não anexado:", erro);
    return;
  }

  const novaOco = {
    tipo_registro: "entrega",
    loja: getVal("loja"),
    motorista: getVal("motorista"),
    placa: getVal("placa"),
    ajudantes,
    recebedor: getVal("recebedor"),
    cargo: getVal("cargo"),
    data_ocorrencia: getVal("dataOcorrencia"),
    hora_chegada: getVal("hora_chegada"),
    hora_agendada_loja: getVal("horaAgendadaLoja"),
    inicio_descarga: getVal("inicioDescarga"),
    termino_descarga: getVal("terminoDescarga"),
    fim_descarga: getVal("saidaLoja"),
    permanencia_justificativa: $("permanenciaTeveJustificativa")?.checked
      ? getVal("permanenciaJustificativa") || ""
      : "",
    fez_checklist: getVal("fezChecklist") === "sim",
    problema_operacional_tipo: getVal("tipoProblemaExtra") || null,
    problema_operacional_relato: getVal("relatoProblemaExtra") || "",
    teve_ocorrencia: getVal("teveOcorrencia") === "sim",
    tipo_problema:
      getVal("teveOcorrencia") === "sim" ? getVal("tipoOcorrencia") : null,
    ocorrencia_responsavel:
      getVal("teveOcorrencia") === "sim" ? getResponsavelOcorrenciaForm() : "",
    ocorrenciaResponsavel:
      getVal("teveOcorrencia") === "sim" ? getResponsavelOcorrenciaForm() : "",
    descricao: getVal("relato"),
    // Lista JSON de data-URIs ja comprimidos (ver ocorrencia-fotos.js).
    // Nao entra no MODULOS_FUTUROS_ATIVOS: foto vale desde ja.
    ocorrencia_fotos:
      typeof ocorrenciaFotosValor === "function" ? ocorrenciaFotosValor() : null,
    protocolo_imprevisto: getVal("protocolo"),
    hora_recebedor: getVal("horaRecebedor"),
    hora_marcada_saida: getVal("horaMarcadaSaida"),
    hora_saida_fabrica: getVal("horaSaidaFabrica"),
    // Campos novos do HTML: caixas, retiradas, volumes, transferência e sacola.
    // Salvando em snake_case e camelCase para evitar perda por diferença de nomenclatura.
    retirada_cx_prevista: retiradaCxPrevista,
    retirada_cx_realizada: retiradaCxRealizada,
    retirada_cx_divergencia: retiradaCxDivergencia,
    retiradaCxPrevista,
    retiradaCxRealizada,
    retiradaCxDivergencia,
    retirada_rt_prevista: retiradaRtPrevista,
    retirada_rt_realizada: retiradaRtRealizada,
    retirada_rt_divergencia: retiradaRtDivergencia,
    retiradaRtPrevista,
    retiradaRtRealizada,
    retiradaRtDivergencia,
    volume_gerencial: volumeGerencial,
    volume_fisico: volumeFisico,
    volume_divergencia: volumeDivergencia,
    volumeGerencial,
    volumeFisico,
    volumeDivergencia,
    transferencia_problema: getVal("transferenciaProblema"),
    transferenciaProblema: getVal("transferenciaProblema"),
    transferencia_relato:
      getVal("transferenciaProblema") === "sim"
        ? getVal("transferenciaRelato")
        : "",
    transferenciaRelato:
      getVal("transferenciaProblema") === "sim"
        ? getVal("transferenciaRelato")
        : "",
    sacola_status: getVal("sacolaStatus"),
    sacolaStatus: getVal("sacolaStatus"),
    sacola_relato: ["parcial", "incorreta"].includes(getVal("sacolaStatus"))
      ? getVal("sacolaRelato")
      : "",
    sacolaRelato: ["parcial", "incorreta"].includes(getVal("sacolaStatus"))
      ? getVal("sacolaRelato")
      : "",
    almoxerifado_status: getVal("almoxerifadoStatus"),
    almoxerifadoStatus: getVal("almoxerifadoStatus"),
    almoxerifado_relato: ["parcial", "incorreta"].includes(
      getVal("almoxerifadoStatus"),
    )
      ? getVal("almoxerifadoRelato")
      : "",
    almoxerifadoRelato: ["parcial", "incorreta"].includes(
      getVal("almoxerifadoStatus"),
    )
      ? getVal("almoxerifadoRelato")
      : "",
    material_envio_status: getVal("materialEnvioStatus"),
    materialEnvioStatus: getVal("materialEnvioStatus"),
    material_envio_relato: ["parcial", "incorreta"].includes(
      getVal("materialEnvioStatus"),
    )
      ? getVal("materialEnvioRelato")
      : "",
    materialEnvioRelato: ["parcial", "incorreta"].includes(
      getVal("materialEnvioStatus"),
    )
      ? getVal("materialEnvioRelato")
      : "",
    material_retirada_status: getVal("materialRetiradaStatus"),
    material_retirada_relato: ["parcial", "incorreta"].includes(
      getVal("materialRetiradaStatus"),
    )
      ? getVal("materialRetiradaRelato")
      : "",
    malote_status: getVal("maloteStatus"),
    malote_observacao: getVal("maloteObservacao"),
    observacao: getVal("observacaoGeral"),
    material_campanha_qtd: materialCampanhaQtd,
    materialCampanhaQtd,
    campanha_banner_qtd: campanhaBannerQtd,
    campanha_banner_campanha: getVal("campanhaBannerCampanha"),
    campanhaBannerQtd,
    campanhaBannerCampanha: getVal("campanhaBannerCampanha"),
    campanha_folder_qtd: campanhaFolderQtd,
    campanha_folder_campanha: getVal("campanhaFolderCampanha"),
    campanhaFolderQtd,
    campanhaFolderCampanha: getVal("campanhaFolderCampanha"),
    campanha_adesivo_qtd: campanhaAdesivoQtd,
    campanha_adesivo_campanha: getVal("campanhaAdesivoCampanha"),
    campanhaAdesivoQtd,
    campanhaAdesivoCampanha: getVal("campanhaAdesivoCampanha"),
    campanha_quadro_qtd: campanhaQuadroQtd,
    campanha_quadro_campanha: getVal("campanhaQuadroCampanha"),
    campanhaQuadroQtd,
    campanhaQuadroCampanha: getVal("campanhaQuadroCampanha"),
    sacola_qtd: sacolaQtd,
    sacolaQtd,
    sacola_p: sacolaP,
    sacolaP,
    sacola_m: sacolaM,
    sacolaM,
    sacola_g: sacolaG,
    sacolaG,
    ocorrencia_severidade: getVal("ocorrenciaSeveridade"),
    ocorrencia_status:
      getVal("teveOcorrencia") === "sim"
        ? getVal("ocorrenciaStatus") || "Aberta"
        : "Nao se aplica",
    causa_raiz: getVal("causaRaiz"),
    acao_corretiva: getVal("acaoCorretiva"),
    prazo_solucao: getVal("prazoSolucao"),
    ...(MODULOS_FUTUROS_ATIVOS
      ? {
          pedido_numero: getVal("pedidoNumero"),
          nota_fiscal: getVal("notaFiscal"),
          romaneio_numero: getVal("romaneioNumero"),
          valor_carga: numeroCampo("valorCarga"),
          // Em BRANCO manda null (não false): null = "ninguém respondeu",
          // e aí o servidor deriva o In Full da ocorrência lançada. Mandar
          // false marcava toda entrega como incompleta e derrubava o OTIF.
          entrega_completa: getVal("entregaCompleta")
            ? getVal("entregaCompleta") === "sim"
            : null,
          km_previsto: numeroCampo("kmPrevisto"),
          km_real: numeroCampo("kmReal"),
          custo_km: numeroCampo("custoKm"),
          pedagio: numeroCampo("pedagio"),
          custo_reentrega: numeroCampo("custoReentrega"),
          custo_ocorrencia: numeroCampo("custoOcorrencia"),
          pod_status: getVal("podStatus"),
          pod_documento_recebedor: getVal("podDocumentoRecebedor"),
          pod_foto: podFoto,
          pod_canhoto: podCanhoto,
          pod_assinatura: podAssinatura,
          gps_latitude: numeroCampo("gpsLatitude"),
          gps_longitude: numeroCampo("gpsLongitude"),
          pod_confirmado_em: getVal("podConfirmadoEm") || null,
        }
      : {}),
    viagem_id: window.tmsOcorrenciaContexto?.viagem_id || null,
    parada_id: window.tmsOcorrenciaContexto?.parada_id || null,
    // Rota de viagem: loja feita no dia seguinte (pernoite-form.js). Fora
    // de rota de viagem nao vai no payload e o servidor deduz sozinho.
    ...(typeof pernoiteFormValor === "function" && pernoiteFormValor() !== undefined
      ? { dia_seguinte: pernoiteFormValor() }
      : {}),
  };

  try {
    const isEdit = editandoIndex !== null && editandoIndex !== undefined;
    const url = isEdit
      ? `${API_URL}/ocorrencias/${editandoIndex}`
      : `${API_URL}/ocorrencias`;
    const res = await fetch(url, {
      method: isEdit ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(novaOco),
    });
    if (!res.ok) {
      let m = `Erro HTTP ${res.status}`;
      try {
        const erro = await res.json();
        m = erro.detalhe || erro.error || m;
      } catch (_) {}
      alertar("❌ Erro ao salvar: " + m);
      return;
    }
    alertar(
      isEdit ? "✅ Ocorrência atualizada!" : "✅ Ocorrência salva com sucesso!",
    );
    editandoIndex = null;
    const btnS = document.querySelector("#form button.btn-green");
    if (btnS) btnS.textContent = "Salvar";
    // Registro gravado: descarta o rascunho do TMS desta parada (se houver) e
    // zera o contexto, para nao re-salvar rascunho vazio nem restaurar depois.
    if (window.tmsOcorrenciaContexto?.parada_id != null && typeof tmsLimparRascunho === "function") {
      tmsLimparRascunho(window.tmsOcorrenciaContexto.parada_id);
    }
    window.tmsOcorrenciaContexto = null;
    fecharForm();
    limparForm();
    await carregarHistorico();
    if (typeof window.tmsAtualizar === "function") {
      await window.tmsAtualizar();
    }
    if (typeof window.dispararMudou === "function") window.dispararMudou("ocorrencia");
  } catch (err) {
    console.error(err);
    alertar("❌ Não foi possível conectar ao servidor.");
  }
}

async function excluirOcorrencia(id) {
  confirmarSimples("Deseja excluir este registro?", async () => {
    try {
      const res = await fetch(`${API_URL}/ocorrencias/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        alertar("❌ Erro ao excluir o registro.");
        return;
      }
      alertar("✅ Registro excluído com sucesso.");
      await carregarHistorico();
      if (typeof window.tmsAtualizar === "function") {
        await window.tmsAtualizar();
      }
      if (typeof window.dispararMudou === "function") window.dispararMudou("ocorrencia");
    } catch (err) {
      console.error(err);
      alertar("❌ Não foi possível conectar ao servidor.");
    }
  });
}

async function marcarAtrasoSla(id) {
  confirmarSimples(
    "Registrar atraso de SLA nesta entrega? Ela será marcada como 'Atrasada' e contará como não conforme no OTIF.",
    async () => {
      try {
        const res = await fetch(`${API_URL}/ocorrencias/${id}/marcar-atraso`, {
          method: "POST",
        });
        if (!res.ok) {
          let m = `Erro HTTP ${res.status}`;
          try {
            const erro = await res.json();
            m = erro.detalhe || erro.error || m;
          } catch (_) {}
          alertar("❌ Erro ao registrar atraso: " + m);
          return;
        }
        alertar("✅ Atraso de SLA registrado.");
        await carregarHistorico();
        if (typeof window.tmsAtualizar === "function") {
          await window.tmsAtualizar();
        }
      } catch (err) {
        console.error(err);
        alertar("❌ Não foi possível conectar ao servidor.");
      }
    },
  );
}
