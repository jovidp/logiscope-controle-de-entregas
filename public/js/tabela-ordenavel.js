// ================================================================
// TABELA ORDENAVEL — ordenacao por clique no cabecalho, generica.
// ----------------------------------------------------------------
// POR QUE NO DOM, E NAO NO ARRAY DE CADA TELA:
// as grades do sistema nascem de template string dentro de cada modulo
// (`el.innerHTML = "<table>..."`) e sao recriadas inteiras a cada refresh.
// Nao existe um formato comum de dados para ordenar antes de renderizar —
// cada modulo tem o seu. Trabalhar no DOM (reordenar os <tr>) liga a
// ordenacao em qualquer tabela sem que o modulo dono precise mudar nada
// alem de marcar a tabela.
//
// USO — marcar a tabela e so:
//     <table data-ordenavel style="...">
//
// Ajustes finos, quando precisar:
//   <th data-tipo="texto|numero|data">  forca o tipo (a deducao errou)
//   <th data-sem-ordenar>               coluna fora da ordenacao (acoes)
//   <td data-ordenar-valor="2026-08-19"> valor real da celula, quando o que
//                                        aparece e formatado/decorado
//   <tr data-fixa>                      linha ancorada (nunca reordena)
//
// GARANTIAS:
//   - linha de TOTAL/rodape, linha de grupo (celula com colspan) e <tfoot>
//     nunca sao reordenados: ficam onde estao.
//   - a ordem escolhida SOBREVIVE ao refresh da tela. As grades se
//     redesenham sozinhas (filtro, SSE, timer); sem isso a ordenacao sumiria
//     no meio do uso e pareceria bug.
// ================================================================
(function () {
  "use strict";

  // Ordem escolhida por tabela, viva fora do DOM: o modulo dono recria a
  // <table> inteira a cada render, entao guardar no elemento se perderia.
  // chave -> { col, dir }   (dir: 1 crescente, -1 decrescente)
  const ordens = new Map();

  const colator = new Intl.Collator("pt-BR", { sensitivity: "base", numeric: true });

  // Placeholders de "sem valor". Entram como vazio na deducao de tipo, senao
  // uma coluna de datas com dois tracinhos seria classificada como texto.
  const VAZIOS = new Set(["", "-", "--", "—", "–", "n/a", "N/A", "?", "…"]);

  const DATA_BR = /^(\d{2})\/(\d{2})\/(\d{4})/;
  const DATA_ISO = /^(\d{4})-(\d{2})-(\d{2})/;
  // Numero pt-BR, com as unidades que aparecem nas grades: 85%, 12 min,
  // R$ 1.234,56, 3,5 h, -2. Exige a string INTEIRA para nao confundir com
  // "12/3" (tacografo ✓/✗), que tem barra e nao e numero.
  const NUMERO = /^-?\s*R?\$?\s*\d{1,3}(\.\d{3})*(,\d+)?\s*(%|min|h|km|kg|un)?$|^-?\s*\d+([.,]\d+)?\s*(%|min|h|km|kg|un)?$/;

  // ---------- leitura de celula ----------

  function textoCelula(td) {
    if (!td) return "";
    // data-ordenar-valor manda: e a saida para celula decorada (badge, icone,
    // "12 min" com <small>), onde o texto visivel nao ordena direito.
    const explicito = td.getAttribute("data-ordenar-valor");
    if (explicito !== null) return explicito.trim();
    // Celula editavel (planilha): o que vale e o que esta digitado, nao o
    // value do HTML, que fica congelado no valor inicial.
    const campo = td.querySelector("input, select, textarea");
    if (campo) return String(campo.value == null ? "" : campo.value).trim();
    return (td.textContent || "").replace(/\s+/g, " ").trim();
  }

  const ehVazio = (v) => VAZIOS.has(v) || VAZIOS.has(v.toLowerCase());

  // ---------- tipo da coluna ----------

  // Deduz pelo conteudo REAL da coluna, e exige que todos os valores
  // preenchidos batam: uma coluna e de data so se nao houver nenhuma linha
  // que nao seja data. Na duvida cai em texto, que nunca da resultado absurdo.
  function tipoDaColuna(linhas, col, th) {
    const forcado = th && th.getAttribute("data-tipo");
    if (forcado) return forcado;

    const vals = linhas
      .map((tr) => textoCelula(tr.cells[col]))
      .filter((v) => v && !ehVazio(v));
    if (!vals.length) return "texto";

    if (vals.every((v) => DATA_BR.test(v) || DATA_ISO.test(v))) return "data";
    if (vals.every((v) => NUMERO.test(v))) return "numero";
    return "texto";
  }

  // ---------- conversao para comparacao ----------

  function chaveData(v) {
    const br = v.match(DATA_BR);
    if (br) return `${br[3]}-${br[2]}-${br[1]}`; // vira ISO: compara como texto
    const iso = v.match(DATA_ISO);
    return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : v;
  }

  function chaveNumero(v) {
    // pt-BR -> float: tira unidade e simbolo, ponto e milhar, virgula e decimal.
    const limpo = v
      .replace(/[R$\s%]/g, "")
      .replace(/(min|km|kg|un|h)$/i, "")
      .replace(/\./g, "")
      .replace(",", ".");
    const n = parseFloat(limpo);
    return Number.isNaN(n) ? null : n;
  }

  // ---------- ordenacao ----------

  // Linha que participa da ordenacao. Fica de fora: rodape de TOTAL, linha de
  // grupo/estado vazio (tem celula com colspan) e quem se marcou como fixa.
  function linhaOrdenavel(tr) {
    if (tr.hasAttribute("data-fixa")) return false;
    if (tr.closest("tfoot")) return false;
    for (const td of tr.cells) if (td.hasAttribute("colspan") || td.colSpan > 1) return false;
    return true;
  }

  function aplicarOrdem(tabela, col, dir) {
    const tbody = tabela.tBodies[0];
    if (!tbody) return;

    const todas = Array.from(tbody.rows);
    const moveis = todas.filter(linhaOrdenavel);
    if (moveis.length < 2) return;

    const ths = tabela.tHead ? Array.from(tabela.tHead.querySelectorAll("th")) : [];
    const tipo = tipoDaColuna(moveis, col, ths[col]);

    // Posicao original: desempate estavel. Sem isso, linhas de valor igual
    // trocam de lugar a cada reordenacao e a grade "pisca" sozinha.
    const pos = new Map(moveis.map((tr, i) => [tr, i]));

    const ordenadas = moveis.slice().sort((x, y) => {
      const a = textoCelula(x.cells[col]);
      const b = textoCelula(y.cells[col]);
      const va = ehVazio(a) ? "" : a;
      const vb = ehVazio(b) ? "" : b;

      // Vazio sempre por ultimo, nos DOIS sentidos (nao multiplica por dir):
      // uma fileira de celulas vazias encabecando a grade atrapalha em vez
      // de informar.
      if (!va && !vb) return pos.get(x) - pos.get(y);
      if (!va) return 1;
      if (!vb) return -1;

      let r = 0;
      if (tipo === "data") {
        const ka = chaveData(va);
        const kb = chaveData(vb);
        r = ka < kb ? -1 : ka > kb ? 1 : 0;
      } else if (tipo === "numero") {
        const ka = chaveNumero(va);
        const kb = chaveNumero(vb);
        if (ka === null && kb === null) r = 0;
        else if (ka === null) return 1;
        else if (kb === null) return -1;
        else r = ka < kb ? -1 : ka > kb ? 1 : 0;
      } else {
        r = colator.compare(va, vb);
      }
      return r !== 0 ? r * dir : pos.get(x) - pos.get(y);
    });

    // Reinsere so as moveis, na ordem nova, ancorando cada linha fixa na
    // posicao em que ela ja estava (um TOTAL no fim continua no fim).
    let i = 0;
    const frag = document.createDocumentFragment();
    todas.forEach((tr) => frag.appendChild(linhaOrdenavel(tr) ? ordenadas[i++] : tr));
    tbody.appendChild(frag);
  }

  // ---------- chave estavel da tabela ----------

  // A <table> e recriada a cada render, entao a identidade nao pode morar
  // nela. Usa o id do ancestral mais proximo + a posicao da tabela dentro
  // dele: sobrevive ao innerHTML e nao exige nome manual em cada grade.
  function chaveDaTabela(tabela) {
    if (tabela.id) return `#${tabela.id}`;
    const nome = tabela.getAttribute("data-ordenavel");
    if (nome) return `nome:${nome}`;
    let raiz = tabela.parentElement;
    while (raiz && !raiz.id) raiz = raiz.parentElement;
    const escopo = raiz || document.body;
    const irmas = Array.from(escopo.querySelectorAll("table[data-ordenavel]"));
    return `${raiz ? "#" + raiz.id : "body"}[${irmas.indexOf(tabela)}]`;
  }

  // ---------- cabecalho ----------

  const SETA = { asc: "▲", desc: "▼", nenhuma: "⇅" };
  const DICA = {
    data: ["mais antigo primeiro", "mais novo primeiro"],
    numero: ["menor → maior", "maior → menor"],
    texto: ["A → Z", "Z → A"],
  };

  function pintarCabecalho(tabela) {
    if (!tabela.tHead) return;
    const atual = ordens.get(chaveDaTabela(tabela));
    const moveis = tabela.tBodies[0] ? Array.from(tabela.tBodies[0].rows).filter(linhaOrdenavel) : [];
    Array.from(tabela.tHead.querySelectorAll("th")).forEach((th, col) => {
      if (th.hasAttribute("data-sem-ordenar")) return;
      let seta = th.querySelector(".tord-seta");
      if (!seta) {
        seta = document.createElement("span");
        seta.className = "tord-seta";
        seta.style.cssText = "margin-left:5px;font-size:9px;font-weight:400;";
        th.appendChild(seta);
        th.style.cursor = "pointer";
        th.style.userSelect = "none";
      }
      const ativo = atual && atual.col === col;
      const tipo = moveis.length ? tipoDaColuna(moveis, col, th) : "texto";
      const dica = DICA[tipo] || DICA.texto;
      // O title anuncia o que o PROXIMO clique faz, nao o estado de agora.
      th.title = ativo && atual.dir === 1 ? `Ordenar: ${dica[1]}` : `Ordenar: ${dica[0]}`;
      seta.textContent = ativo ? (atual.dir === 1 ? SETA.asc : SETA.desc) : SETA.nenhuma;
      seta.style.opacity = ativo ? "1" : ".3";
    });
  }

  // ---------- ligacao ----------

  // Delegacao no documento: pega tabela que ainda nem existe quando este
  // arquivo roda, e nao deixa listener orfao quando o modulo dono troca o
  // innerHTML do container.
  document.addEventListener("click", (ev) => {
    const th = ev.target.closest ? ev.target.closest("th") : null;
    if (!th || th.hasAttribute("data-sem-ordenar")) return;
    const tabela = th.closest("table[data-ordenavel]");
    if (!tabela || !tabela.tHead || !tabela.tHead.contains(th)) return;

    const col = Array.from(th.parentElement.cells).indexOf(th);
    if (col < 0) return;

    const chave = chaveDaTabela(tabela);
    const atual = ordens.get(chave);
    // Mesma coluna: inverte. Coluna nova: comeca crescente.
    const dir = atual && atual.col === col ? -atual.dir : 1;
    ordens.set(chave, { col, dir });

    aplicarOrdem(tabela, col, dir);
    pintarCabecalho(tabela);
  });

  // Reaplica depois que a tela se redesenha. As grades voltam do servidor
  // (filtro, SSE, timer) e trocam o innerHTML inteiro; sem isto a ordenacao
  // escolhida sumiria sozinha no meio do uso.
  let agendado = null;
  function reaplicarTudo() {
    agendado = null;
    document.querySelectorAll("table[data-ordenavel]").forEach((tabela) => {
      const alvo = ordens.get(chaveDaTabela(tabela));
      if (alvo) aplicarOrdem(tabela, alvo.col, alvo.dir);
      pintarCabecalho(tabela);
    });
  }

  const observador = new MutationObserver((mutacoes) => {
    if (agendado) return;
    // So reage a mudanca que trouxe/levou linha ou tabela — ignora o proprio
    // trabalho de reordenar (que move <tr> ja existentes) e as trocas de
    // atributo/texto que acontecem o tempo todo na tela.
    const relevante = mutacoes.some((m) =>
      Array.from(m.addedNodes).some(
        (n) => n.nodeType === 1 && (n.tagName === "TABLE" || n.querySelector?.("table[data-ordenavel]")),
      ),
    );
    if (!relevante) return;
    agendado = setTimeout(reaplicarTudo, 60);
  });

  function iniciar() {
    observador.observe(document.body, { childList: true, subtree: true });
    reaplicarTudo();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciar);
  else iniciar();

  // Gancho para quem quiser reaplicar na mao depois de um render proprio.
  window.tabelaOrdenavelReaplicar = reaplicarTudo;
})();
