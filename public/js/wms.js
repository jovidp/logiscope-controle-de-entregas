// ================================================================
// WMS — planilha de ERRO DE VOLUME.
// ----------------------------------------------------------------
// Grade editavel (DATA | LOJA | PEDIDO | VOLUME | DESCRICAO) sobre
// /wms/erro-volume. Comporta-se como planilha: cada celula e um input e a
// linha salva sozinha ao SAIR do campo, e so se o valor mudou (onchange, nao
// oninput — senao gravaria a cada tecla digitada).
//
// A ultima linha e sempre uma linha VAZIA de digitacao. Ela vira registro
// quando data + loja estao preenchidas (Enter ou o botao +). Depois de gravar,
// uma nova linha vazia aparece no lugar — o fluxo de quem lanca varias seguidas.
//
// Prefixo wms* para nao colidir com os globais das outras abas.
// Reusa escapar()/hojeISO()/alertar()/confirmarBonito() do core.
// ================================================================
(function () {
  "use strict";

  const API = window.location.origin;
  // ordem: campo vazio = ordem que veio do servidor (data DESC, id DESC).
  // dir: 1 crescente, -1 decrescente.
  const state = {
    lista: [],
    salvando: new Set(),
    pendentes: new Set(),
    ordem: { campo: "", dir: 1 },
  };

  const esc = (v) =>
    typeof escapar === "function"
      ? escapar(v)
      : String(v == null ? "" : v)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
  const hoje = () =>
    typeof hojeISO === "function" ? hojeISO() : new Date().toLocaleDateString("en-CA");
  const avisar = (m) => (typeof alertar === "function" ? alertar(m) : alert(m));

  // Quando o WMS vive dentro do formulario de ocorrencia, a linha nova herda a
  // data e a loja ja preenchidas no topo. Fora dele (sem esses campos) cai no
  // padrao: data = hoje, loja vazia.
  const ocorrenciaData = () => {
    const el = document.getElementById("dataOcorrencia");
    return el && el.value ? el.value : hoje();
  };
  // O <select id="loja"> guarda a CHAVE em UPPER_SNAKE (RIO_BONITO_II) e exibe o
  // nome formatado. Aqui vale o NOME, nao a chave: alem de aparecer feio na
  // linha, essa string e a que vai para wms_erro_volume.loja, e o resto do
  // sistema grava com espaco (ocorrencias.loja, tms_paradas.loja_nome). Como a
  // checagem de duplicidade compara texto, gravar a chave faria "RIO_BONITO_II"
  // nunca casar com "RIO BONITO II" e o aviso de duplicado sumiria calado.
  const ocorrenciaLoja = () => {
    const sel = document.getElementById("loja");
    if (!sel || !sel.value) return "";
    return typeof formatarNomeLoja === "function"
      ? formatarNomeLoja(sel.value).trim()
      : String(sel.value).replaceAll("_", " ").trim();
  };

  async function wmsRequest(path, options = {}) {
    const headers = {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    };
    const resp = await fetch(`${API}${path}`, { ...options, headers });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(j.error || `HTTP ${resp.status}`);
    return j;
  }

  // ---------- leitura ----------

  async function wmsCarregar() {
    const inicio = document.getElementById("wmsFiltroInicio")?.value;
    const fim = document.getElementById("wmsFiltroFim")?.value;
    const busca = document.getElementById("wmsFiltroBusca")?.value;
    const params = new URLSearchParams();
    if (inicio) params.set("inicio", inicio);
    if (fim) params.set("fim", fim);
    if (busca) params.set("busca", busca);
    const corpo = document.getElementById("wmsCorpo");
    try {
      const j = await wmsRequest(`/wms/erro-volume?${params.toString()}`);
      state.lista = j.lista || [];
      state.truncado = !!j.truncado;
      state.limite = j.limite || 0;
      wmsRender();
    } catch (err) {
      // Nao deixa state.lista com o resultado do filtro ANTERIOR: o resumo e o
      // "Exportar CSV" continuariam servindo dados que nao estao mais na tela.
      state.lista = [];
      state.truncado = false;
      const resumo = document.getElementById("wmsResumo");
      if (resumo) resumo.textContent = "Falha ao carregar — nada a exportar.";
      if (corpo) {
        corpo.innerHTML = `<tr><td colspan="6" style="padding:18px;text-align:center;color:var(--vermelho);">Não foi possível carregar: ${esc(err.message)}</td></tr>`;
      }
    }
  }

  function wmsLimparFiltro() {
    ["wmsFiltroInicio", "wmsFiltroFim", "wmsFiltroBusca"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    wmsCarregar();
  }

  // ---------- ordenacao ----------
  // Clique no cabecalho ordena a grade. Reordena o que JA esta carregado
  // (state.lista), sem ida ao servidor — quando o filtro trunca em 1000, o
  // "mais antigo" e o mais antigo DA PAGINA, nao da tabela; o resumo embaixo
  // avisa do corte.
  //
  // O tipo decide o comparador, e e por isso que ele e explicito aqui:
  //   data     -> o servidor manda "AAAA-MM-DD", entao ordem alfabetica JA e
  //               cronologica; comparar como texto e correto e mais barato.
  //   texto    -> A-Z ignorando acento e caixa (MAGE == MAGÉ).
  //   codigo   -> pedido/volume sao TEXT no banco mas quase sempre numero.
  //               numeric:true faz "10" vir DEPOIS de "9"; sem isso a ordem
  //               por codigo sai "1, 10, 2", que nao e o que ninguem espera.
  const ORDEM_TIPO = {
    data: "data",
    loja: "texto",
    pedido: "codigo",
    volume: "codigo",
    descricao: "texto",
  };

  const ORDEM_DICA = {
    data: ["mais antigo primeiro", "mais novo primeiro"],
    texto: ["A → Z", "Z → A"],
    codigo: ["menor → maior", "maior → menor"],
  };

  const colator = new Intl.Collator("pt-BR", { sensitivity: "base", numeric: true });

  function listaOrdenada() {
    const { campo, dir } = state.ordem;
    if (!campo) return state.lista;
    const tipo = ORDEM_TIPO[campo] || "texto";
    const val = (o) => String(o[campo] == null ? "" : o[campo]).trim();
    // slice(): ordena uma COPIA. state.lista guarda a ordem do servidor, que e
    // para onde a grade volta se a ordenacao for limpa.
    return state.lista.slice().sort((x, y) => {
      const a = val(x);
      const b = val(y);
      // Vazio sempre por ultimo, nos DOIS sentidos (nao multiplica por dir):
      // uma fileira de linhas sem pedido encabecando a grade atrapalha em vez
      // de informar.
      if (!a && !b) return x.id - y.id;
      if (!a) return 1;
      if (!b) return -1;
      const r = tipo === "data" ? (a < b ? -1 : a > b ? 1 : 0) : colator.compare(a, b);
      // Desempate pelo id: sem ele, linhas de valor igual trocam de lugar a
      // cada render e a grade "pisca" sozinha.
      return r !== 0 ? r * dir : x.id - y.id;
    });
  }

  function wmsOrdenarPor(campo) {
    if (!ORDEM_TIPO[campo]) return;
    // Mesmo campo: inverte. Campo novo: comeca crescente.
    if (state.ordem.campo === campo) state.ordem.dir = state.ordem.dir === 1 ? -1 : 1;
    else state.ordem = { campo, dir: 1 };
    wmsRender();
  }

  // Seta indicadora no cabecalho. O <th> so e preparado UMA vez (listener +
  // <span> da seta): reescrever innerHTML a cada render comeria o rotulo da
  // coluna e empilharia um listener por clique.
  function wmsPintarCabecalho() {
    const tabela = document.getElementById("wmsCorpo")?.closest("table");
    if (!tabela) return;
    tabela.querySelectorAll("th[data-ordenar]").forEach((th) => {
      const campo = th.getAttribute("data-ordenar");
      if (!ORDEM_TIPO[campo]) return;
      let seta = th.querySelector(".wms-seta");
      if (!seta) {
        seta = document.createElement("span");
        seta.className = "wms-seta";
        seta.style.cssText = "margin-left:5px;font-size:9px;";
        th.appendChild(seta);
        th.style.cursor = "pointer";
        th.style.userSelect = "none";
        th.addEventListener("click", () => wmsOrdenarPor(campo));
      }
      const ativo = state.ordem.campo === campo;
      const dica = ORDEM_DICA[ORDEM_TIPO[campo]];
      // O title anuncia o que o PROXIMO clique faz, nao o estado atual.
      th.title = ativo && state.ordem.dir === 1 ? `Ordenar: ${dica[1]}` : `Ordenar: ${dica[0]}`;
      seta.textContent = ativo ? (state.ordem.dir === 1 ? "▲" : "▼") : "⇅";
      seta.style.opacity = ativo ? "1" : ".3";
    });
  }

  // ---------- render ----------

  const cell = (html, extra = "") =>
    `<td style="padding:3px 4px;${extra}">${html}</td>`;

  const inputCss =
    "width:100%;padding:6px 8px;border:1px solid transparent;border-radius:6px;" +
    "background:transparent;color:var(--text-heading);font-size:13px;font-family:inherit;";

  function linhaExistente(o) {
    const d = String(o.data || "").slice(0, 10);
    return `<tr data-id="${o.id}" class="wms-linha">
      ${cell(`<input type="date" class="wms-cel" data-campo="data" value="${esc(d)}" style="${inputCss}" onchange="wmsSalvarLinha(${o.id})" />`, "width:140px;")}
      ${cell(`<input type="text" class="wms-cel" data-campo="loja" value="${esc(o.loja)}" style="${inputCss}" onchange="wmsSalvarLinha(${o.id})" />`)}
      ${cell(`<input type="text" data-no-upper class="wms-cel" data-campo="pedido" value="${esc(o.pedido || "")}" style="${inputCss}" onchange="wmsSalvarLinha(${o.id})" />`, "width:150px;")}
      ${cell(`<input type="text" data-no-upper class="wms-cel" data-campo="volume" value="${esc(o.volume || "")}" style="${inputCss}" onchange="wmsSalvarLinha(${o.id})" />`, "width:150px;")}
      ${cell(`<input type="text" class="wms-cel" data-campo="descricao" value="${esc(o.descricao || "")}" style="${inputCss}" onchange="wmsSalvarLinha(${o.id})" />`)}
      ${cell(
        `<div style="display:flex;align-items:center;gap:6px;justify-content:flex-end;">
           <span class="wms-status" style="font-size:11px;color:var(--text-muted);white-space:nowrap;"></span>
           <button type="button" class="btn-ghost btn-sm" title="Excluir esta linha" onclick="wmsExcluir(${o.id})">✕</button>
         </div>`,
        "width:110px;",
      )}
    </tr>`;
  }

  function linhaNova() {
    const enter = "if(event.key==='Enter'){event.preventDefault();wmsAdicionar();}";
    return `<tr id="wmsLinhaNova" style="background:var(--bg-base);">
      ${cell(`<input type="date" id="wmsNovoData" value="${esc(ocorrenciaData())}" style="${inputCss}" onkeydown="${enter}" />`, "width:140px;")}
      ${cell(`<input type="text" id="wmsNovoLoja" value="${esc(ocorrenciaLoja())}" placeholder="Loja *" style="${inputCss}" onkeydown="${enter}" />`)}
      ${cell(`<input type="text" data-no-upper id="wmsNovoPedido" placeholder="Cód. do pedido" style="${inputCss}" onkeydown="${enter}" />`, "width:150px;")}
      ${cell(`<input type="text" data-no-upper id="wmsNovoVolume" placeholder="Cód. do volume" style="${inputCss}" onkeydown="${enter}" />`, "width:150px;")}
      ${cell(`<input type="text" id="wmsNovoDescricao" placeholder="Descrição do erro" style="${inputCss}" onkeydown="${enter}" />`)}
      ${cell(
        `<button type="button" class="btn-green btn-sm" style="width:100%;" onclick="wmsAdicionar()">+ Add</button>`,
        "width:110px;",
      )}
    </tr>`;
  }

  const CAMPOS_NOVOS = ["wmsNovoData", "wmsNovoLoja", "wmsNovoPedido", "wmsNovoVolume", "wmsNovoDescricao"];

  function wmsRender() {
    const corpo = document.getElementById("wmsCorpo");
    if (!corpo) return;

    // Preserva o que ja estava digitado na linha nova: o innerHTML abaixo
    // recria o tbody inteiro, e sem isto excluir outra linha (ou qualquer
    // recarga) apagaria o lancamento em andamento sem aviso.
    const rascunho = {};
    let tinhaAlgo = false;
    CAMPOS_NOVOS.forEach((id) => {
      const el = document.getElementById(id);
      if (el) rascunho[id] = el.value;
    });
    CAMPOS_NOVOS.slice(1).forEach((id) => { if (rascunho[id]) tinhaAlgo = true; });

    // linhaNova() fica sempre por ultimo: a ordenacao mexe so nos registros
    // gravados, nunca na linha de digitacao.
    corpo.innerHTML = listaOrdenada().map(linhaExistente).join("") + linhaNova();

    if (tinhaAlgo || rascunho.wmsNovoData) {
      CAMPOS_NOVOS.forEach((id) => {
        const el = document.getElementById(id);
        if (el && rascunho[id] !== undefined && rascunho[id] !== "") el.value = rascunho[id];
      });
    }

    wmsPintarCabecalho();
    wmsAtualizarResumo();
  }

  // ---------- gravacao ----------

  function lerLinha(id) {
    const tr = document.querySelector(`tr[data-id="${id}"]`);
    if (!tr) return null;
    const val = (campo) => tr.querySelector(`.wms-cel[data-campo="${campo}"]`)?.value ?? "";
    return {
      data: val("data"),
      loja: val("loja").trim(),
      pedido: val("pedido").trim(),
      volume: val("volume"),
      descricao: val("descricao").trim(),
    };
  }

  function marcarStatus(id, texto, cor) {
    const el = document.querySelector(`tr[data-id="${id}"] .wms-status`);
    if (!el) return;
    el.textContent = texto;
    el.style.color = cor || "var(--text-muted)";
    if (texto === "salvo") setTimeout(() => { if (el.textContent === "salvo") el.textContent = ""; }, 1800);
  }

  async function wmsSalvarLinha(id) {
    const body = lerLinha(id);
    if (!body) return;
    if (!body.data || !body.loja) {
      marcarStatus(id, "data e loja obrigatórias", "var(--vermelho)");
      return;
    }
    // Ja existe um PUT desta linha no ar (o usuario editou a celula seguinte
    // antes do anterior voltar). NAO descartar: se descartasse, a segunda
    // edicao sumiria enquanto a linha ainda exibisse "salvo". Marca que ha
    // alteracao pendente e reenvia ao terminar, com o estado atual do DOM.
    if (state.salvando.has(id)) {
      state.pendentes.add(id);
      return;
    }
    state.salvando.add(id);
    marcarStatus(id, "salvando…");
    try {
      const atualizado = await wmsRequest(`/wms/erro-volume/${id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      const i = state.lista.findIndex((x) => x.id === id);
      if (i >= 0) state.lista[i] = atualizado;
      marcarStatus(id, "salvo", "var(--verde)");
      wmsAtualizarResumo();
    } catch (err) {
      marcarStatus(id, "erro", "var(--vermelho)");
      avisar(`Não foi possível salvar a linha: ${err.message}`);
    } finally {
      state.salvando.delete(id);
      if (state.pendentes.has(id)) {
        state.pendentes.delete(id);
        wmsSalvarLinha(id);
      }
    }
  }

  // Sem soma de volume: e codigo de serie, nao quantidade. Conta registros e
  // avisa se o mesmo codigo de volume aparecer mais de uma vez — repetido
  // costuma ser lancamento duplicado.
  function wmsAtualizarResumo() {
    const resumo = document.getElementById("wmsResumo");
    if (!resumo) return;
    if (!state.lista.length) {
      resumo.textContent = "Nenhum registro no filtro atual — comece a digitar na linha de baixo.";
      return;
    }
    const codigos = state.lista.map((o) => (o.volume || "").trim().toUpperCase()).filter(Boolean);
    const vistos = new Set();
    const repetidos = new Set();
    codigos.forEach((c) => (vistos.has(c) ? repetidos.add(c) : vistos.add(c)));
    resumo.textContent =
      `${state.lista.length} registro(s)` +
      (repetidos.size ? ` · ⚠ ${repetidos.size} código(s) de volume repetido(s): ${[...repetidos].slice(0, 5).join(", ")}` : "") +
      // Truncou: avisa em vez de deixar "1000 registro(s)" passar por total.
      // Sem isto o alerta de repetido sairia incompleto calado, e a ordenacao
      // do cabecalho reordenaria so esta pagina — "mais antigo" seria o mais
      // antigo dos 1000 carregados, nao o da tabela.
      (state.truncado
        ? ` · ⚠ mostrando só os ${state.limite} mais recentes do filtro — há mais registros; estreite o período para ver o resto (a ordenação vale só sobre o que está na tela)`
        : "");
  }

  async function wmsAdicionar() {
    const body = {
      data: document.getElementById("wmsNovoData")?.value || "",
      loja: (document.getElementById("wmsNovoLoja")?.value || "").trim(),
      pedido: (document.getElementById("wmsNovoPedido")?.value || "").trim(),
      volume: document.getElementById("wmsNovoVolume")?.value || "",
      descricao: (document.getElementById("wmsNovoDescricao")?.value || "").trim(),
    };
    if (!body.data || !body.loja) {
      avisar("Preencha ao menos a DATA e a LOJA para adicionar a linha.");
      document.getElementById(body.data ? "wmsNovoLoja" : "wmsNovoData")?.focus();
      return;
    }
    // Duplicidade LOJA + VOLUME em qualquer data: consulta o banco (nao so a
    // lista carregada, que e filtrada/truncada) e avisa mostrando o que ja
    // existe. Deixa o usuario decidir — nao bloqueia o cadastro.
    const volChecar = body.volume.trim();
    if (volChecar) {
      try {
        const dups = await wmsRequest(
          `/wms/erro-volume/duplicados?loja=${encodeURIComponent(body.loja)}&volume=${encodeURIComponent(volChecar)}`
        );
        if (Array.isArray(dups) && dups.length) {
          const d = dups[0];
          const quando = String(d.data || "").split("-").reverse().join("/");
          const quem = d.registrado_por ? ` por ${d.registrado_por}` : "";
          const mais = dups.length > 1 ? ` (e mais ${dups.length - 1})` : "";
          const detalhe = d.pedido ? ` · pedido ${d.pedido}` : "";
          const ok = confirm(
            `⚠ Já existe erro para a loja "${d.loja}" com o volume "${d.volume}"${mais}.\n` +
            `Lançado em ${quando}${quem}${detalhe}.\n\n` +
            `Salvar mesmo assim?`
          );
          if (!ok) {
            document.getElementById("wmsNovoVolume")?.focus();
            return;
          }
        }
      } catch (err) {
        // Checagem e best-effort: se falhar, nao impede o cadastro.
        console.warn("[wms] checagem de duplicidade falhou:", err.message);
      }
    }
    try {
      const criado = await wmsRequest("/wms/erro-volume", {
        method: "POST",
        body: JSON.stringify(body),
      });
      state.lista.unshift(criado);
      // Esvazia a linha de digitacao ANTES do render: o render agora preserva
      // rascunho, entao sem limpar aqui os valores recem-gravados voltariam
      // para a linha nova e o usuario lancaria duplicado sem perceber.
      // A data fica (normalmente lancam varias do mesmo dia).
      ["wmsNovoLoja", "wmsNovoPedido", "wmsNovoVolume", "wmsNovoDescricao"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = "";
      });
      wmsRender();
      const dataEl = document.getElementById("wmsNovoData");
      if (dataEl) dataEl.value = body.data;
      document.getElementById("wmsNovoLoja")?.focus();
    } catch (err) {
      avisar(`Não foi possível adicionar: ${err.message}`);
    }
  }

  async function wmsExcluir(id) {
    const ok =
      typeof confirmarBonito === "function"
        ? await confirmarBonito("Excluir esta linha?", { okLabel: "Excluir", cancelLabel: "Cancelar" })
        : confirm("Excluir esta linha?");
    if (!ok) return;
    try {
      await wmsRequest(`/wms/erro-volume/${id}`, { method: "DELETE" });
      state.lista = state.lista.filter((x) => x.id !== id);
      wmsRender();
    } catch (err) {
      avisar(`Não foi possível excluir: ${err.message}`);
    }
  }

  // ---------- exportar ----------

  // CSV com BOM e separador ";" — é o que o Excel pt-BR abre sem pedir nada.
  function wmsExportarCsv() {
    if (!state.lista.length) {
      avisar("Nenhum registro para exportar no filtro atual.");
      return;
    }
    // Campo CSV comum: sempre citado, aspas internas dobradas.
    const campo = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;

    // Campo que o Excel TEM de tratar como texto (codigo de serie): vira a
    // formula ="...", que preserva zeros a esquerda.
    // Atencao: a formula precisa ir DENTRO de um campo citado — emitir
    // ="AB;12" cru faz o ; separar coluna e desloca a linha inteira.
    // Por isso o escape e aplicado duas vezes: uma para a string da formula
    // do Excel, outra para o campo CSV que a carrega.
    const campoTexto = (v) => {
      const formula = `="${String(v == null ? "" : v).replace(/"/g, '""')}"`;
      return `"${formula.replace(/"/g, '""')}"`;
    };

    // Injecao de formula: um valor comecando por = + - @ (ou controle) e
    // executado pelo Excel ao abrir. Neutraliza empacotando como texto.
    const PERIGOSO = /^[=+\-@\t\r]/;
    const campoSeguro = (v) => {
      const s = String(v == null ? "" : v);
      return PERIGOSO.test(s) ? campoTexto(s) : campo(s);
    };

    const brData = (s) => (s || "").slice(0, 10).split("-").reverse().join("/");
    const linhas = [
      ["DATA", "LOJA", "PEDIDO", "VOLUME", "DESCRICAO"].join(";"),
      ...state.lista.map((o) =>
        [
          campo(brData(o.data)),
          campoSeguro(o.loja),
          o.pedido ? campoTexto(o.pedido) : '""',
          o.volume ? campoTexto(o.volume) : '""',
          campoSeguro(o.descricao || ""),
        ].join(";"),
      ),
    ].join("\r\n");
    const blob = new Blob(["﻿" + linhas], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `wms-erro-volume-${hoje()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------- init ----------

  let iniciado = false;
  async function wmsInit() {
    if (!iniciado) {
      iniciado = true;
      const ini = new Date();
      ini.setDate(ini.getDate() - 30);
      const iEl = document.getElementById("wmsFiltroInicio");
      const fEl = document.getElementById("wmsFiltroFim");
      if (iEl && !iEl.value) iEl.value = ini.toLocaleDateString("en-CA");
      if (fEl && !fEl.value) fEl.value = hoje();
      // Ressincroniza a linha nova quando a loja/data da ocorrencia muda.
      const _sincronizarNovo = () => {
        const dEl = document.getElementById("wmsNovoData");
        const lEl = document.getElementById("wmsNovoLoja");
        if (dEl) dEl.value = ocorrenciaData();
        if (lEl) lEl.value = ocorrenciaLoja();
      };
      document.getElementById("loja")?.addEventListener("change", _sincronizarNovo);
      document.getElementById("dataOcorrencia")?.addEventListener("change", _sincronizarNovo);
    }
    await wmsCarregar();
  }

  // Abre/fecha a secao WMS embutida no formulario. Inicia a grade ao abrir;
  // a linha nova ja herda loja/data via linhaNova.
  function toggleWmsSecao() {
    const corpo = document.getElementById("wmsSecaoCorpo");
    if (!corpo) return;
    const abrindo = !corpo.style.display || corpo.style.display === "none";
    corpo.style.display = abrindo ? "block" : "none";
    const chevron = document.getElementById("wmsSecaoChevron");
    const txt = document.getElementById("wmsSecaoToggleTxt");
    if (chevron) chevron.style.transform = abrindo ? "rotate(0deg)" : "rotate(180deg)";
    if (txt) txt.textContent = abrindo ? "Recolher" : "Expandir";
    if (abrindo) wmsInit();
  }

  window.toggleWmsSecao = toggleWmsSecao;
  window.wmsOrdenarPor = wmsOrdenarPor;
  window.wmsInit = wmsInit;
  window.wmsCarregar = wmsCarregar;
  window.wmsLimparFiltro = wmsLimparFiltro;
  window.wmsSalvarLinha = wmsSalvarLinha;
  window.wmsAdicionar = wmsAdicionar;
  window.wmsExcluir = wmsExcluir;
  window.wmsExportarCsv = wmsExportarCsv;
})();
