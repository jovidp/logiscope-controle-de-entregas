// ================================================================
// kpi-ocorrencia.js  —  RELACAO OCORRENCIA -> KPIs  (FONTE UNICA)
// ----------------------------------------------------------------
// Responde a pergunta: "esta entrega, com a ocorrencia que foi lancada,
// alimenta QUAIS indicadores — e ela conta como COMPLETA (In Full)?"
//
// POR QUE ESTE ARQUIVO EXISTE
// ---------------------------
// O campo "Entrega Completa? (In Full)" da Secao 7 do formulario esta
// ESCONDIDO (data-modulo-futuro="sla-otif") e nunca foi preenchivel. Como o
// server fazia `textoParaBoolean(entrega_completa)`, o campo em branco virava
// FALSE — ou seja, TODA entrega era gravada como "nao completa" e o OTIF saia
// "Nao conforme" mesmo em entrega sem nenhuma ocorrencia e no prazo.
// (Em 26/08/2026: 157 entregas "No prazo" marcadas "Nao conforme" so por isso.)
//
// A entrega NAO fica fora do KPI: ela entra, e o In Full passa a ser DERIVADO
// da ocorrencia lancada. So e' "incompleta" quem tem um sinal concreto de
// falta (mercadoria a menos, divergencia de volume/peca, erro de separacao,
// loja fechada, sacola/material parcial...). Atraso, problema de documento,
// demora de conferencia etc. NAO tornam a entrega incompleta — alimentam
// outros indicadores.
//
// DUPLA FACE (Node + navegador): o mesmo arquivo e' `require`ado pelo
// back/server.js e carregado por <script> no index.html. Nao ha copia para
// sair de sincronia. Nao usar sintaxe que o navegador nao entenda.
// ================================================================
(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(raiz, api);
})(typeof self !== "undefined" ? self : this, function () {
  // --- catalogo de KPIs (rotulo = como o usuario ve no sistema) ---
  const KPIS = {
    sla: { rotulo: "Pontualidade (SLA)", icone: "⏱️", painel: "OTIF / SLA" },
    otif: { rotulo: "OTIF — entrega completa", icone: "📦", painel: "OTIF / SLA" },
    documentos: { rotulo: "Documentos (NF / romaneio / espelho)", icone: "📄", painel: "Ranking de documentos" },
    permanencia: { rotulo: "Permanência em loja", icone: "🏬", painel: "Pontuação / permanência" },
    divergencia: { rotulo: "Divergência de carga", icone: "⚖️", painel: "Divergências" },
    expedicao: { rotulo: "Erros de expedição / almoxarifado", icone: "🏭", painel: "Erros por setor" },
    loja: { rotulo: "Erros da loja", icone: "🏪", painel: "Erros por loja" },
    conduta: { rotulo: "Conduta da equipe", icone: "🧑‍✈️", painel: "Conduta do motorista" },
    materiais: { rotulo: "Materiais (sacola / campanha)", icone: "🛍️", painel: "Materiais" },
    frota: { rotulo: "Frota / veículo", icone: "🚚", painel: "Veículos" },
  };

  // --- relacao tipo de ocorrencia -> KPIs alimentados + efeito no In Full ---
  // inFull:false  => esta ocorrencia significa que faltou/nao chegou algo:
  //                  a entrega conta como INCOMPLETA no OTIF.
  // inFull:true   => a entrega chegou completa; a ocorrencia pesa em OUTRO KPI.
  // incerto:true  => o tipo nao diz nada sobre completude (ex.: "Outros"):
  //                  nao derruba o In Full, mas a tela pede confirmacao.
  const TIPOS = {
    "Atraso": { kpis: ["sla"], inFull: true },
    "Atraso do responsável": { kpis: ["sla", "permanencia", "loja"], inFull: true },
    "Caixa não bipada": { kpis: ["documentos", "divergencia"], inFull: true },
    "Mercadoria a mais": { kpis: ["divergencia", "expedicao"], inFull: true },
    "Mercadoria a menos": { kpis: ["divergencia", "expedicao"], inFull: false },
    "Divergência de peça": { kpis: ["divergencia", "expedicao"], inFull: false },
    "Divergência com volume": { kpis: ["divergencia", "expedicao"], inFull: false },
    "Nota fiscal não enviada": { kpis: ["documentos"], inFull: true },
    "Nota fiscal incorreta": { kpis: ["documentos"], inFull: true },
    "Nota fiscal divergente do físico": { kpis: ["documentos", "divergencia"], inFull: false },
    "Romaneio não enviado": { kpis: ["documentos"], inFull: true },
    "Romaneio divergente do físico": { kpis: ["documentos", "divergencia"], inFull: false },
    "Espelho não enviado": { kpis: ["documentos"], inFull: true },
    "Espelho divergente do físico": { kpis: ["documentos", "divergencia"], inFull: false },
    "Loja fechada": { kpis: ["sla", "loja"], inFull: false },
    "Responsável ausente": { kpis: ["permanencia", "loja"], inFull: true },
    "Conferência não realizada pela loja": { kpis: ["permanencia", "loja"], inFull: true },
    "Demora na conferência": { kpis: ["permanencia", "loja"], inFull: true },
    "Dificuldade de acesso à loja": { kpis: ["permanencia", "sla"], inFull: true },
    "Erro de separação": { kpis: ["expedicao", "divergencia"], inFull: false },
    "Erro de expedição": { kpis: ["expedicao", "divergencia"], inFull: false },
    "Erro de conferência no almoxarifado": { kpis: ["expedicao", "divergencia"], inFull: false },
    "Material não localizado": { kpis: ["expedicao", "divergencia"], inFull: false },
    "Material enviado sem conferência": { kpis: ["expedicao"], inFull: true },
    "Divergência com almoxarifado": { kpis: ["expedicao", "divergencia"], inFull: false },
    "Problema com o motorista": { kpis: ["conduta"], inFull: true },
    "Problema com ajudante": { kpis: ["conduta"], inFull: true },
    "Problema com sacola": { kpis: ["materiais"], inFull: true },
    "Problema com folder": { kpis: ["materiais"], inFull: true },
    "Problema de comunicação": { kpis: ["conduta"], inFull: true },
    "Almoxerifado": { kpis: ["expedicao"], inFull: true, incerto: true },
    "Outros": { kpis: [], inFull: true, incerto: true },

    // Grafias antigas que ainda existem na base (importacao / versoes anteriores).
    "Carga/Divergência": { kpis: ["divergencia", "expedicao"], inFull: false },
    "Trânsito/Via": { kpis: ["sla"], inFull: true },
    "Veículo": { kpis: ["sla", "frota"], inFull: true },
    "Documentação": { kpis: ["documentos"], inFull: true },
    "Conduta/Segurança": { kpis: ["conduta"], inFull: true },
  };

  function normalizar(texto) {
    return String(texto == null ? "" : texto)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  // Indice por chave normalizada: casa "Divergencia de peca" com
  // "Divergência de peça", MAIUSCULA com minuscula etc.
  const INDICE = {};
  Object.keys(TIPOS).forEach((nome) => {
    INDICE[normalizar(nome)] = { nome: nome, regra: TIPOS[nome] };
  });

  // tipo_problema e' multivalor separado por virgula (ver sincronizarGrupoMulti).
  function separarTipos(valor) {
    return String(valor == null ? "" : valor)
      .split(/[,;|]/)
      .map(function (t) { return t.trim(); })
      .filter(Boolean);
  }

  function numeroOuNull(valor) {
    if (valor === null || valor === undefined || valor === "") return null;
    const n = Number(valor);
    return Number.isFinite(n) ? n : null;
  }

  function verdadeiro(valor) {
    if (valor === true) return true;
    if (valor === false) return false;
    const t = normalizar(valor);
    return t === "true" || t === "sim" || t === "1";
  }

  // ----------------------------------------------------------------
  // classificarOcorrenciaKpi(dados)
  // Recebe a ocorrencia (snake_case do banco/payload) e devolve a relacao
  // completa: tipos reconhecidos, KPIs alimentados, In Full derivado e o
  // motivo de cada decisao. E' o que a tela mostra e o que o server grava.
  // ----------------------------------------------------------------
  function classificarOcorrenciaKpi(dados) {
    const d = dados || {};
    const tipos = separarTipos(d.tipo_problema != null ? d.tipo_problema : d.tipoOcorrencia);
    const teve = d.teve_ocorrencia === undefined
      ? tipos.length > 0
      : verdadeiro(d.teve_ocorrencia) || tipos.length > 0;

    const reconhecidos = [];
    const desconhecidos = [];
    const kpisMotivos = {};
    const quebramInFull = [];
    let incerto = false;

    function alimenta(chave, motivo) {
      if (!KPIS[chave]) return;
      if (!kpisMotivos[chave]) kpisMotivos[chave] = [];
      if (kpisMotivos[chave].indexOf(motivo) === -1) kpisMotivos[chave].push(motivo);
    }

    // Base: TODA entrega registrada alimenta pontualidade e OTIF. E' o ponto
    // do conserto — entrega sem ocorrencia nao fica de fora, entra como boa.
    alimenta("sla", "toda entrega registrada");
    alimenta("otif", "toda entrega registrada");

    tipos.forEach(function (tipo) {
      const achado = INDICE[normalizar(tipo)];
      if (!achado) {
        desconhecidos.push(tipo);
        incerto = true;
        return;
      }
      reconhecidos.push(achado.nome);
      achado.regra.kpis.forEach(function (k) { alimenta(k, achado.nome); });
      if (achado.regra.inFull === false) {
        quebramInFull.push(achado.nome);
        alimenta("otif", achado.nome);
      }
      if (achado.regra.incerto) incerto = true;
    });

    // Sinais concretos de falta que NAO vem do tipo de ocorrencia, mas de
    // campos proprios do formulario. Valem por si so.
    const parciais = ["parcial", "incorreta"];
    if (parciais.indexOf(normalizar(d.sacola_status)) !== -1) {
      quebramInFull.push("sacola parcial/incorreta");
      alimenta("otif", "sacola parcial/incorreta");
      alimenta("materiais", "sacola parcial/incorreta");
    }
    if (parciais.indexOf(normalizar(d.almoxerifado_status)) !== -1) {
      quebramInFull.push("almoxarifado parcial/incorreto");
      alimenta("otif", "almoxarifado parcial/incorreto");
      alimenta("expedicao", "almoxarifado parcial/incorreto");
    }
    if (parciais.indexOf(normalizar(d.material_envio_status)) !== -1) {
      quebramInFull.push("material de envio parcial/incorreto");
      alimenta("otif", "material de envio parcial/incorreto");
      alimenta("expedicao", "material de envio parcial/incorreto");
    }
    // volume_divergencia = fisico - gerencial. Negativo = chegou menos.
    const divVolume = numeroOuNull(
      d.volume_divergencia !== undefined ? d.volume_divergencia : d.volumeDivergencia,
    );
    if (divVolume !== null && divVolume < 0) {
      quebramInFull.push("volume físico menor que o gerencial");
      alimenta("otif", "volume físico menor que o gerencial");
      alimenta("divergencia", "volume físico menor que o gerencial");
    }

    const inFull = quebramInFull.length === 0;

    const kpis = Object.keys(kpisMotivos).map(function (chave) {
      return {
        chave: chave,
        rotulo: KPIS[chave].rotulo,
        icone: KPIS[chave].icone,
        painel: KPIS[chave].painel,
        motivos: kpisMotivos[chave],
      };
    });
    // Ordem estavel: SLA e OTIF primeiro (sao a base), o resto alfabetico.
    const ordem = ["sla", "otif"];
    kpis.sort(function (a, b) {
      const ia = ordem.indexOf(a.chave);
      const ib = ordem.indexOf(b.chave);
      if (ia !== ib) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return a.rotulo.localeCompare(b.rotulo, "pt-BR");
    });

    return {
      teveOcorrencia: teve,
      tipos: reconhecidos,
      desconhecidos: desconhecidos,
      kpis: kpis,
      inFull: inFull,
      // Motivos de a entrega NAO ser completa (vazio = completa).
      inFullMotivos: quebramInFull,
      // So sinaliza incerteza quando nao ha nenhum motivo concreto de falta.
      incerto: incerto && inFull,
    };
  }

  // Atalho para quem so quer o booleano (server, scripts de migracao).
  function derivarEntregaCompleta(dados) {
    return classificarOcorrenciaKpi(dados).inFull;
  }

  return {
    KPIS_OCORRENCIA: KPIS,
    TIPOS_OCORRENCIA_KPI: TIPOS,
    classificarOcorrenciaKpi: classificarOcorrenciaKpi,
    derivarEntregaCompleta: derivarEntregaCompleta,
  };
});
