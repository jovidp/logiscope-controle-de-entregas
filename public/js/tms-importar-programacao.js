// ================================================================
// tms-importar-programacao.js — botao "Importar programação" do TMS
// ----------------------------------------------------------------
// Fluxo: escolher a planilha -> ler no navegador (TmsProgramacao.lerMatriz,
// em tms-programacao-parser.js) -> pedir a PREVIA ao servidor -> o usuario
// confere rota a rota e escolhe Criar / Atualizar viagem X / Nao importar ->
// importar (tudo ou nada).
//
// O servidor refaz o plano na hora de gravar; a previa serve para o usuario
// ver EXATAMENTE o que vai acontecer antes de confirmar.
// Prefixo tmsProg* para nao colidir com os globais das outras abas.
// ================================================================
(function () {
  "use strict";

  const API = window.location.origin;
  const ID = "tmsModalProgramacao";
  const estado = {
    arquivo: "",
    wb: null,
    abas: [],        // [{ nome, blocos, avisos, textos_topo }]
    aba: "",
    data: "",
    dataOrigem: "",
    previa: null,
    escolhas: new Map(), // indice -> "criar" | "ignorar" | "atualizar:<id>"
    ocupado: false,
    verde: false,    // previa sem nada para conferir: Enter importa
    // Contadores contra corrida: cada escolha de arquivo e cada previa ganham um
    // numero; resposta que chega depois de outra escolha e descartada.
    seqArquivo: 0,
    seqPrevia: 0,
    caminhoPasta: null,      // arquivo da pasta aberto agora (para o ✅)
    focarAposPrevia: false,  // so a previa de um arquivo recem-aberto leva o foco ao Importar
    abaDica: "",
    abaAuto: "",
    carregandoArquivo: false,
    focoIndice: null,
  };

  const esc = (v) => (typeof window.escapar === "function"
    ? window.escapar(v == null ? "" : v)
    : String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
  const el = (id) => document.getElementById(id);
  const hoje = () => (typeof window.hojeISO === "function" ? window.hojeISO() : new Date().toISOString().slice(0, 10));
  const brl = (v) => (v == null ? "—" : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
  const dataBR = (iso) => (iso ? iso.split("-").reverse().join("/") : "");
  const avisar = (m) => (typeof window.alertar === "function" ? window.alertar(m) : alert(m));

  async function api(caminho, corpo) {
    const resp = await fetch(`${API}${caminho}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(corpo),
    });
    const dados = await resp.json().catch(() => ({}));
    if (!resp.ok) throw Object.assign(new Error(dados.error || `Erro ${resp.status}`), { status: resp.status });
    return dados;
  }

  // ── modal ─────────────────────────────────────────────────────
  function garantirModal() {
    if (el(ID)) return el(ID);
    const div = document.createElement("div");
    div.id = ID;
    div.className = "hidden";
    div.setAttribute("role", "dialog");
    div.setAttribute("aria-modal", "true");
    div.setAttribute("aria-labelledby", "tmsProgTitulo");
    div.style.cssText = "position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:9002;display:none;align-items:center;justify-content:center;padding:16px;";
    div.innerHTML = `
      <div style="background:var(--bg-elevated);border-radius:10px;max-width:1180px;width:100%;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 25px 60px rgba(0,0,0,.35);overflow:hidden;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--border-md);background:var(--bg-overlay);color:var(--text-heading);">
          <div>
            <div id="tmsProgTitulo" style="font-weight:800;font-size:15px;">Importar programação de rotas</div>
            <div style="font-size:11px;opacity:.8;">Planilha (lojas, horários, RT/CX, equipe e placa) + Checklist Expedição (volumes e materiais) · confira antes de importar</div>
          </div>
          <button type="button" class="btn-ghost btn-sm" onclick="tmsFecharImportarProgramacao()">Fechar</button>
        </div>
        <div id="tmsProgCorpo" style="padding:14px 18px;overflow:auto;flex:1;">
          <div id="tmsProgPasta" style="margin-bottom:10px;"></div>
          <label for="tmsProgArquivo" id="tmsProgDrop" tabindex="0" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:20px;border:2px dashed var(--border);border-radius:14px;background:var(--bg-base);cursor:pointer;text-align:center;">
            <span style="font-size:26px;" aria-hidden="true">🗓️</span>
            <span style="font-weight:700;color:var(--text-heading);font-size:14px;" id="tmsProgDropTitulo">Escolha ou arraste a planilha de programação</span>
            <span style="font-size:12px;color:var(--text-muted);">.xlsx, .xls ou .csv — um bloco "ROTA" por viagem</span>
            <input id="tmsProgArquivo" type="file" accept=".xlsx,.xls,.xlsm,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" style="display:none;" />
          </label>
          <div id="tmsProgOpcoes" style="display:none;margin-top:12px;gap:12px;flex-wrap:wrap;align-items:flex-end;">
            <div id="tmsProgAbaWrap" style="display:none;">
              <label for="tmsProgAba" style="font-size:11px;font-weight:700;color:var(--text-secondary);display:block;">Aba</label>
              <select id="tmsProgAba"></select>
            </div>
            <div>
              <label for="tmsProgData" style="font-size:11px;font-weight:700;color:var(--text-secondary);display:block;">Data das viagens</label>
              <input type="date" id="tmsProgData" />
            </div>
            <div id="tmsProgDataDica" style="font-size:11px;color:var(--text-muted);padding-bottom:6px;"></div>
          </div>
          <div id="tmsProgResumo" style="margin-top:12px;"></div>
          <div id="tmsProgBlocos"></div>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;align-items:center;gap:8px;background:var(--bg-base);">
          <span id="tmsProgStatus" style="margin-right:auto;font-size:12px;color:var(--text-muted);" aria-live="polite"></span>
          <button type="button" class="btn-ghost btn-sm" onclick="tmsFecharImportarProgramacao()">Cancelar</button>
          <button type="button" class="btn-green btn-sm" id="tmsProgBtnImportar" disabled onclick="tmsConfirmarImportarProgramacao()">Importar</button>
        </div>
      </div>`;
    document.body.appendChild(div);

    el("tmsProgArquivo").addEventListener("change", (e) => escolherArquivoLocal(e.target.files && e.target.files[0]));
    el("tmsProgAba").addEventListener("change", (e) => { escolherAba(e.target.value); });
    el("tmsProgData").addEventListener("change", (e) => {
      estado.data = e.target.value;
      estado.dataOrigem = "manual";
      estado.escolhas.clear(); // viagens do dia mudaram: volta para a sugestao
      pedirPrevia();
    });
    const drop = el("tmsProgDrop");
    ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.style.borderColor = "var(--azul, #2563eb)"; }));
    ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.style.borderColor = ""; }));
    drop.addEventListener("drop", (e) => escolherArquivoLocal(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]));
    drop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); el("tmsProgArquivo").click(); }
    });
    div.addEventListener("keydown", (e) => {
      if (e.key === "Escape") window.tmsFecharImportarProgramacao();
      // Enter importa (previa toda verde) SO quando o foco nao esta em nada
      // interativo: no campo "trocar arquivo", na pasta, na data, num select ou
      // num detalhe, o Enter e daquele controle — antes ele importava junto.
      if (e.key !== "Enter" || e.defaultPrevented || !estado.verde || estado.ocupado) return;
      if (e.target.closest && e.target.closest("#tmsProgDrop, #tmsProgPasta, #tmsProgOpcoes, #tmsProgBlocos, button, input, select, textarea, summary, label, a")) return;
      e.preventDefault();
      window.tmsConfirmarImportarProgramacao();
    });
    return div;
  }

  // ── pasta ROTA COMPARTILHADA ──────────────────────────────────
  // Lista as planilhas da pasta da operacao e ja abre a do proximo dia ainda nao
  // importado (sem a janela de escolher arquivo).
  async function carregarPasta() {
    const box = el("tmsProgPasta");
    if (!box) return;
    const seqAoListar = estado.seqArquivo;
    box.innerHTML = `<div style="font-size:12px;color:var(--text-muted);">Procurando planilhas na pasta ROTA COMPARTILHADA...</div>`;
    let dados;
    try {
      const resp = await fetch(`${API}/tms/programacao/pasta`, { headers: { Accept: "application/json" } });
      dados = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(dados.error || `Erro ${resp.status}`);
    } catch (err) {
      box.innerHTML = `<div style="font-size:12px;color:var(--text-muted);">Pasta da programação indisponível agora (${esc(err.message || err)}). Escolha o arquivo abaixo.</div>`;
      return;
    }
    const arquivos = (dados.arquivos || []).filter((a) => a.data);
    if (!arquivos.length) {
      box.innerHTML = `<div style="font-size:12px;color:var(--text-muted);">Nenhuma planilha com data no nome em ${esc(dados.pasta || "")}.</div>`;
      return;
    }
    const hojeIso = dados.hoje || hoje();
    const rotuloDia = (d) => {
      const dias = Math.round((Date.parse(`${d}T12:00:00Z`) - Date.parse(`${hojeIso}T12:00:00Z`)) / 86400000);
      return dias === 0 ? "hoje" : dias === 1 ? "amanhã" : dias === -1 ? "ontem" : "";
    };
    // Proximo dia (>= hoje) ainda nao importado; o mais cedo primeiro.
    const sugerido = arquivos.filter((a) => a.data >= hojeIso && !a.importada).sort((a, b) => a.data.localeCompare(b.data))[0] || null;
    const visiveis = arquivos.slice(0, 8);
    if (sugerido && !visiveis.includes(sugerido)) visiveis.unshift(sugerido);
    box.innerHTML = `<div style="font-size:11px;font-weight:700;color:var(--text-secondary);margin-bottom:6px;">📂 Pasta ROTA COMPARTILHADA</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">${visiveis.map((a) => {
        const rot = rotuloDia(a.data);
        const marcado = sugerido && a.caminho === sugerido.caminho;
        return `<button type="button" class="btn-ghost btn-sm tms-prog-arq" data-caminho="${esc(a.caminho)}" data-nome="${esc(a.nome)}"
          aria-pressed="${marcado ? "true" : "false"}" title="${esc(a.caminho)}">
          <span class="tms-prog-arq-marca">${marcado ? "✅" : "📄"}</span> ${esc(dataBR(a.data))}${rot ? ` (${esc(rot)})` : ""}${a.importada ? " · já importada" : ""}</button>`;
      }).join("")}</div>`;
    box.querySelectorAll(".tms-prog-arq").forEach((b) => b.addEventListener("click", () => abrirDaPasta(b.dataset.caminho, b.dataset.nome)));
    // So abre sozinho se ninguem escolheu nada desde que o modal abriu (a lista
    // pode demorar; o usuario pode ter aberto um arquivo do PC nesse meio tempo).
    if (sugerido && !estado.arquivo && estado.seqArquivo === seqAoListar && !sugerido.grande) {
      abrirDaPasta(sugerido.caminho, sugerido.nome);
    } else {
      marcarArquivo(estado.caminhoPasta);
    }
  }

  // Destaque do arquivo aberto. setProperty(..., "important"): o tema pinta a
  // borda do .btn-ghost com !important e um estilo inline comum nao aparecia.
  function marcarArquivo(caminho) {
    el("tmsProgPasta")?.querySelectorAll(".tms-prog-arq").forEach((b) => {
      const sim = !!caminho && b.dataset.caminho === caminho;
      b.setAttribute("aria-pressed", sim ? "true" : "false");
      if (sim) {
        b.style.setProperty("border-color", "#16a34a", "important");
        b.style.setProperty("background", "#f0fdf4", "important");
        b.style.setProperty("color", "#14532d", "important");
        b.style.setProperty("font-weight", "800", "important");
      } else {
        ["border-color", "background", "color", "font-weight"].forEach((p) => b.style.removeProperty(p));
      }
      const marca = b.querySelector(".tms-prog-arq-marca");
      if (marca) marca.textContent = sim ? "✅" : "📄";
    });
  }

  // Tira da tela a previa do arquivo anterior enquanto o novo carrega: o botao
  // Importar nao pode valer para um arquivo que nao e mais o escolhido.
  function limparPrevia(msg) {
    estado.previa = null;
    estado.verde = false;
    estado.seqPrevia += 1; // resposta de previa ainda em voo vira lixo
    estado.ocupado = true;
    el("tmsProgResumo").innerHTML = "";
    el("tmsProgBlocos").innerHTML = "";
    atualizarBotao();
    status(msg || "");
  }

  // Enquanto um arquivo novo baixa/le, data e aba ficam travadas e nenhuma
  // previa pode ser pedida: elas usariam as rotas do arquivo ANTERIOR (e o
  // Importar voltava a valer para ele).
  function carregando(sim) {
    estado.carregandoArquivo = !!sim;
    ["tmsProgData", "tmsProgAba"].forEach((id) => { const c = el(id); if (c) c.disabled = !!sim; });
    atualizarBotao();
  }

  async function abrirDaPasta(caminho, nome) {
    const seq = ++estado.seqArquivo;
    const anterior = estado.caminhoPasta;
    estado.caminhoPasta = caminho;
    marcarArquivo(caminho);
    limparPrevia(`Abrindo ${nome}...`);
    carregando(true);
    try {
      const resp = await fetch(`${API}/tms/programacao/pasta/arquivo?caminho=${encodeURIComponent(caminho)}`);
      if (!resp.ok) {
        const dados = await resp.json().catch(() => ({}));
        throw new Error(dados.error || `Erro ${resp.status}`);
      }
      const blob = await resp.blob();
      if (seq !== estado.seqArquivo) return; // o usuario escolheu outro arquivo nesse meio tempo
      // Data vem do nome do arquivo (DD.MM.AA): descarta data escolhida antes.
      estado.dataOrigem = "";
      await lerArquivo(new File([blob], nome, { type: blob.type }), seq);
    } catch (err) {
      if (seq !== estado.seqArquivo) return;
      // Falhou: a tela volta para o arquivo que ja estava aberto (✅ e previa).
      estado.caminhoPasta = anterior;
      marcarArquivo(anterior);
      estado.ocupado = false;
      carregando(false);
      status("");
      avisar(`Não consegui abrir ${nome}: ${err.message || err}`);
      if (estado.abas.length && estado.aba) pedirPrevia();
    }
  }

  function escolherArquivoLocal(file) {
    if (!file) return;
    const seq = ++estado.seqArquivo;
    estado.caminhoPasta = null;
    marcarArquivo(null);
    estado.dataOrigem = "";
    lerArquivo(file, seq);
  }

  // Aba certa. Os arquivos reais tem a Planilha1 (programacao do dia) e
  // rascunhos (Planilha2/3). Vence a PRIMEIRA aba que tem rotas com algum
  // PES/RT/CX — mesmo pela metade: a Planilha1 e preenchida ao longo do dia e
  // um rascunho completo nao pode ganhar dela. Sem nenhuma assim, a primeira com rotas.
  function melhorAba(abas) {
    const comDados = abas.find((a) => a.blocos.some((b) => b.paradas.some((p) => p.pes || p.rt != null || p.cx != null)));
    return comDados || abas.find((a) => a.blocos.length) || abas[0] || null;
  }

  function status(msg) {
    const s = el("tmsProgStatus");
    if (s) s.textContent = msg || "";
  }

  // ── leitura do arquivo ────────────────────────────────────────
  async function lerArquivo(file, seq = estado.seqArquivo) {
    if (!file) return;
    if (!window.TmsProgramacao) { avisar("Leitor da programação não carregou. Recarregue a página (Ctrl+F5)."); return; }
    if (!window.XLSX) { avisar("Leitor de planilha indisponível (sem internet para carregar o XLSX?). Recarregue a página."); return; }
    limparPrevia("Lendo planilha...");
    carregando(true);
    estado.arquivo = file.name || "";
    estado.escolhas.clear();
    // A previa que vier deste arquivo pode levar o foco ao Importar (e so ela).
    estado.focarAposPrevia = true;
    el("tmsProgDropTitulo").textContent = `📄 ${estado.arquivo} — clique para trocar`;
    // Com a planilha aberta a area de arrastar vira uma linha: sobra tela para a previa.
    const drop = el("tmsProgDrop");
    if (drop) {
      drop.style.padding = "8px 12px";
      drop.style.flexDirection = "row";
      drop.querySelectorAll("span:not(#tmsProgDropTitulo)").forEach((s) => { s.style.display = "none"; });
    }
    el("tmsProgBlocos").innerHTML = "";
    status("Lendo planilha...");
    try {
      const buffer = await file.arrayBuffer();
      if (seq !== estado.seqArquivo) return; // outro arquivo foi escolhido
      let wb;
      if (/\.csv$/i.test(estado.arquivo)) {
        let texto = new TextDecoder("utf-8").decode(buffer).replace(/^﻿/, "");
        if (texto.includes("�")) texto = new TextDecoder("windows-1252").decode(buffer);
        const primeira = texto.split(/\r?\n/)[0] || "";
        const fs = (primeira.match(/;/g) || []).length > (primeira.match(/,/g) || []).length ? ";" : ",";
        wb = window.XLSX.read(texto, { type: "string", FS: fs, raw: true });
      } else {
        wb = window.XLSX.read(buffer, { type: "array", cellDates: false });
      }
      estado.wb = wb;
      estado.abas = wb.SheetNames.map((nome) => {
        const ws = wb.Sheets[nome];
        if (!ws || !ws["!ref"]) return { nome, blocos: [], avisos: ["Aba vazia."], textos_topo: [] };
        const inicio = window.XLSX.utils.decode_range(ws["!ref"]).s.r + 1;
        const matriz = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "", blankrows: true });
        return { nome, ...window.TmsProgramacao.lerMatriz(matriz, { linhaInicial: inicio }) };
      });
      const sel = el("tmsProgAba");
      sel.innerHTML = estado.abas.map((a) => `<option value="${esc(a.nome)}">${esc(a.nome)} (${a.blocos.length} rota${a.blocos.length === 1 ? "" : "s"})</option>`).join("");
      el("tmsProgAbaWrap").style.display = estado.abas.length > 1 ? "" : "none";
      el("tmsProgOpcoes").style.display = "flex";
      const comRotas = melhorAba(estado.abas);
      sel.value = comRotas ? comRotas.nome : "";
      estado.abaAuto = comRotas ? comRotas.nome : "";
      estado.abaDica = comRotas && estado.abas[0] && comRotas.nome !== estado.abas[0].nome
        ? `Usei a aba "${comRotas.nome}" (a primeira aba não tem rotas com PES/RT/CX).`
        : "";
      estado.ocupado = false;
      carregando(false);
      escolherAba(sel.value);
    } catch (err) {
      if (seq !== estado.seqArquivo) return;
      estado.ocupado = false;
      carregando(false);
      status("");
      el("tmsProgResumo").innerHTML = caixa("erro", `Não consegui ler a planilha: ${esc(err.message || err)}`);
    }
  }

  function escolherAba(nome) {
    estado.aba = nome;
    estado.escolhas.clear();
    const aba = estado.abas.find((a) => a.nome === nome);
    if (!aba) return;
    // Data: nome do arquivo, da aba ou titulo da planilha; senao, hoje.
    const detectada = window.TmsProgramacao.detectarData([aba.nome, estado.arquivo.replace(/\.[^.]+$/, ""), ...aba.textos_topo], hoje());
    if (estado.dataOrigem !== "manual" || !estado.data) {
      estado.data = detectada || hoje();
      estado.dataOrigem = detectada ? "planilha" : "hoje";
    }
    el("tmsProgData").value = estado.data;
    el("tmsProgDataDica").innerHTML = estado.dataOrigem === "planilha"
      ? "Data encontrada na planilha — confira."
      : estado.dataOrigem === "hoje"
        ? `<span style="color:#b45309;font-weight:700;">A planilha não diz a data: usei hoje (${esc(dataBR(estado.data))}). Troque se for para outro dia.</span>`
        : "";
    // Dica so para a aba que a tela escolheu sozinha (nao quando o usuario troca).
    if (estado.abaDica && nome === estado.abaAuto) {
      el("tmsProgDataDica").innerHTML += ` <span style="color:#b45309;">${esc(estado.abaDica)}</span>`;
    }
    if (!aba.blocos.length) {
      estado.previa = null;
      el("tmsProgBlocos").innerHTML = "";
      el("tmsProgResumo").innerHTML = caixa("erro", ["Nenhuma rota encontrada nesta aba.", ...aba.avisos].map(esc).join("<br>"));
      atualizarBotao();
      status("");
      return;
    }
    pedirPrevia();
  }

  function payload() {
    const aba = estado.abas.find((a) => a.nome === estado.aba);
    return {
      data_viagem: estado.data,
      arquivo: estado.arquivo,
      aba: estado.aba,
      blocos: aba ? aba.blocos : [],
      escolhas: [...estado.escolhas.entries()].map(([indice, v]) => {
        const [acao, alvo] = String(v).split(":");
        return { indice, acao, alvo_id: alvo ? Number(alvo) : null };
      }),
    };
  }

  // anterior: escolhas antes da troca que disparou esta previa. Se o servidor
  // recusar (ex.: mesma viagem em duas rotas), volta para elas e mantem a tela.
  async function pedirPrevia(anterior) {
    if (estado.carregandoArquivo) return; // o arquivo novo pede a propria previa quando terminar de ler
    if (!estado.data) {
      // Sem data nao ha previa valida: tira a antiga da tela e trava o Importar.
      limparPrevia("Informe a data.");
      estado.ocupado = false;
      atualizarBotao();
      return;
    }
    // So a ULTIMA previa pedida vale: trocar a data de novo antes da anterior
    // responder fazia a resposta velha (outra data) aparecer por cima da nova.
    const seq = ++estado.seqPrevia;
    estado.ocupado = true;
    atualizarBotao();
    status("Conferindo com as viagens do dia...");
    try {
      const previa = await api("/tms/programacao/previa", payload());
      if (seq !== estado.seqPrevia) return;
      estado.previa = previa;
      render();
      status("");
    } catch (err) {
      if (seq !== estado.seqPrevia) return;
      if (anterior && estado.previa) {
        estado.escolhas = anterior;
        render();
        status("");
        avisar(err.message || String(err));
        return;
      }
      estado.previa = null;
      estado.verde = false;
      el("tmsProgBlocos").innerHTML = "";
      el("tmsProgResumo").innerHTML = caixa("erro", esc(err.message || err));
      status("");
    } finally {
      if (seq === estado.seqPrevia) {
        estado.ocupado = false;
        atualizarBotao();
      }
    }
  }

  // ── render ────────────────────────────────────────────────────
  function caixa(tipo, html) {
    const cor = {
      erro: "background:#fef2f2;border-color:#fecaca;color:#991b1b;",
      aviso: "background:#fffbeb;border-color:#fde68a;color:#92400e;",
      info: "background:var(--bg-base);border-color:var(--border);color:var(--text-secondary);",
    }[tipo];
    return `<div style="border:1px solid;border-radius:8px;padding:8px 10px;font-size:12px;margin-top:6px;${cor}">${html}</div>`;
  }

  function selo(como) {
    const mapa = {
      exato: ["", ""],
      cadastro: ["", ""],
      aproximado: ["≈ casado", "#0e7490"],
      historico: ["do histórico", "#0e7490"],
      pes: ["pelo PES", "#0e7490"],
      checklist: ["só no checklist", "#7c3aed"],
      novo: ["fora do cadastro", "#b45309"],
      desconhecida: ["fora do cadastro", "#b45309"],
    }[como] || ["", ""];
    return mapa[0] ? ` <span style="font-size:10px;font-weight:700;color:${mapa[1]};">${esc(mapa[0])}</span>` : "";
  }

  function pessoa(p) {
    if (!p) return `<span style="color:var(--text-muted);">—</span>`;
    const trocou = p.sistema && p.planilha && p.sistema.toUpperCase() !== p.planilha.toUpperCase();
    return `<b>${esc(p.sistema)}</b>${trocou ? ` <span style="color:var(--text-muted);font-size:11px;">(planilha: ${esc(p.planilha)})</span>` : ""}${selo(p.como)}`;
  }

  function opcoesAcao(b) {
    const atual = b.acao === "atualizar" && b.alvo ? `atualizar:${b.alvo.id}` : b.acao;
    const origem = { checklist: "Checklist", programacao: "planilha", pedidos: "pedidos", manual: "manual" };
    const viagens = (estado.previa.viagens_do_dia || []).map((v) => {
      const valor = `atualizar:${v.id}`;
      const rotulo = `Atualizar ${v.codigo || `#${v.id}`} · ${v.rota_nome || "-"} · ${v.motorista_nome || "-"} · ${v.placa || "-"} (${origem[v.origem] || v.origem})`;
      return `<option value="${valor}" ${valor === atual ? "selected" : ""}>${esc(rotulo)}</option>`;
    }).join("");
    return `<option value="criar" ${atual === "criar" ? "selected" : ""}>Criar viagem nova</option>${viagens}<option value="ignorar" ${atual === "ignorar" ? "selected" : ""}>Não importar esta rota</option>`;
  }

  // Mesma regra do itensDoChecklist do servidor. So e usada quando a previa vem
  // de um servidor que ainda nao manda "itens" (tela nova com servidor antigo,
  // antes do reinicio): sem isto a tela dizia "nenhum item" em toda loja.
  function itensDasRemessas(r) {
    if (!r) return [];
    const n = (v) => (v === null || v === undefined || v === "" ? null : Number(v) || 0);
    const limpo = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const out = [];
    (r.materiais || []).forEach((m) => out.push({ texto: `${limpo(m.setor) ? `${limpo(m.setor)}: ` : ""}${limpo(m.descricao) || "-"}`, quantidade: n(m.quantidade), carregado: !!m.carregado }));
    (r.campanha || []).forEach((c) => out.push({ texto: limpo(c.campanha) || "Material de campanha", quantidade: n(c.total), carregado: !!c.carregado }));
    (r.caixa_azul || []).forEach((c) => out.push({ texto: "Caixa azul vazia", quantidade: n(c.quantidade), carregado: !!c.carregado }));
    (r.plastico_bolha || []).forEach((b) => out.push({ texto: limpo(b.material) || "Plástico bolha", quantidade: null, carregado: !!b.carregado }));
    (r.sacolas || []).forEach((s) => {
      const total = n(s.total) || ((n(s.p) || 0) + (n(s.m) || 0) + (n(s.g) || 0));
      if (total) out.push({ texto: `Sacola P ${n(s.p) || 0} / M ${n(s.m) || 0} / G ${n(s.g) || 0}`, quantidade: total, carregado: !!s.carregado });
    });
    return out;
  }

  // Item a item do que o checklist manda para a loja. Devolve HTML ja escapado.
  function materiais(c) {
    if (!c) return "";
    const itens = Array.isArray(c.itens) ? c.itens : itensDasRemessas(c.remessas);
    if (!itens.length) return `<span style="color:var(--text-muted);">nenhum item</span>`;
    return itens.map((i) => {
      const qtd = i.quantidade == null ? "" : ` (${esc(i.quantidade)})`;
      const ok = i.carregado
        ? `<span title="carregado" aria-label="carregado">✅</span>`
        : `<span title="ainda não carregado" aria-label="ainda não carregado">⏳</span>`;
      return `<div>${ok} ${esc(i.texto)}${qtd}</div>`;
    }).join("");
  }

  function tabelaParadas(b) {
    const th = (t) => `<th style="text-align:left;padding:4px 6px;border-bottom:1px solid var(--border);white-space:nowrap;">${esc(t)}</th>`;
    const td = (t, extra = "") => `<td style="padding:4px 6px;border-bottom:1px solid var(--border);white-space:nowrap;${extra}">${t}</td>`;
    const destino = { atualiza: "✓ completa a parada", nova: "+ parada nova", ignorada: "—" };
    const linhas = b.paradas.map((p) => `<tr>
        ${td(esc(p.atd ? `${p.atd}º` : ""))}
        ${td(`<b>${esc(p.loja_sistema)}</b>${p.loja_sistema !== p.loja ? ` <span style="color:var(--text-muted);">(${esc(p.loja)})</span>` : ""}${selo(p.loja_como === "ok" ? "" : p.loja_como)}${p.checklist && p.checklist.casada_por ? ` <span style="font-size:10px;color:#0e7490;">casada pelo ${esc(p.checklist.casada_por)}</span>` : ""}`)}
        ${td(esc(p.pes || ""))}
        ${td(esc(p.hora_loja || ""))}
        ${td(p.rt == null ? "" : esc(p.rt), "text-align:right;")}
        ${td(p.cx == null ? "" : esc(p.cx), "text-align:right;")}
        ${p.checklist ? td(esc(p.checklist.volumes_previstos ?? ""), "text-align:right;font-weight:700;") : td("sem checklist", "color:#b45309;")}
        ${td(materiais(p.checklist), "white-space:normal;min-width:240px;vertical-align:top;")}
        ${td(esc(destino[p.destino] || ""), p.destino === "nova" ? "color:#15803d;font-weight:700;" : "color:var(--text-muted);")}
      </tr>`).join("");
    return `<div style="overflow:auto;margin-top:8px;">
      <table style="width:100%;border-collapse:collapse;font-size:11px;">
        <thead><tr>${th("ATD")}${th("Loja")}${th("PES")}${th("Horário")}${th("RT")}${th("CX")}${th("Volumes (checklist)")}${th("Materiais (checklist)")}${th("No TMS")}</tr></thead>
        <tbody>${linhas}</tbody>
      </table></div>`;
  }

  // ── nomes fora do cadastro: cadastrar direto da previa ─────────
  // Motorista/ajudante/placa/rota que a previa marcou "fora do cadastro" viram
  // uma lista com caixas (todas marcadas; desmarque o que for erro de digitacao)
  // e um botao. Depois de cadastrar, a previa se refaz e o aviso some.
  const ROTULO_TIPO = { motorista: "motorista", ajudante: "ajudante", placa: "placa", rota: "rota" };
  function nomesNovos(blocos) {
    const vistos = new Set();
    const out = [];
    const add = (tipo, valor) => {
      const v = String(valor || "").trim();
      const k = `${tipo}|${v.toUpperCase()}`;
      if (!v || vistos.has(k)) return;
      vistos.add(k);
      out.push({ tipo, valor: v });
    };
    (blocos || []).forEach((b) => {
      if (b.acao === "ignorar") return;
      if (b.rota && b.rota.como === "novo") add("rota", b.rota.sistema);
      if (b.motorista && b.motorista.como === "novo") add("motorista", b.motorista.sistema);
      if (b.placa && b.placa.como === "novo") add("placa", b.placa.sistema);
      (b.ajudantes || []).forEach((a) => { if (a.como === "novo") add("ajudante", a.sistema); });
    });
    return out;
  }

  function htmlNomesNovos(blocos) {
    const novos = nomesNovos(blocos);
    if (!novos.length) return "";
    const itens = novos.map((n, i) => `
      <label style="display:inline-flex;align-items:center;gap:4px;margin:2px 10px 2px 0;font-size:12px;">
        <input type="checkbox" class="tms-prog-novo" data-i="${i}" checked style="width:16px;height:16px;min-width:16px;min-height:0;padding:0;margin:0;appearance:auto;-webkit-appearance:checkbox;accent-color:#16a34a;" />
        <b>${esc(n.valor)}</b> <span style="color:var(--text-muted);">(${esc(ROTULO_TIPO[n.tipo])})</span></label>`).join("");
    estado.nomesNovos = novos;
    return caixa("aviso", `<div style="margin-bottom:4px;">Fora do cadastro — desmarque o que for só erro de digitação:</div>${itens}
      <div style="margin-top:6px;"><button type="button" class="btn-blue btn-sm" id="tmsProgCadastrarNovos">➕ Cadastrar selecionados</button></div>`);
  }

  async function cadastrarNomesNovos() {
    const marcados = [...document.querySelectorAll(".tms-prog-novo")].filter((c) => c.checked)
      .map((c) => (estado.nomesNovos || [])[Number(c.dataset.i)]).filter(Boolean);
    if (!marcados.length) { avisar("Nenhum nome marcado."); return; }
    const btn = el("tmsProgCadastrarNovos");
    if (btn) { btn.disabled = true; btn.textContent = "Cadastrando..."; }
    const falhas = [];
    for (const n of marcados) {
      try { await api("/cadastros", { tipo: n.tipo, valor: n.valor }); } catch (err) { falhas.push(`${n.valor}: ${err.message}`); }
    }
    if (typeof window.dispararMudou === "function") window.dispararMudou("cadastros");
    if (falhas.length) avisar(`Não consegui cadastrar:\n${falhas.join("\n")}`);
    status(`${marcados.length - falhas.length} nome(s) cadastrado(s).`);
    pedirPrevia();
  }

  function render() {
    const pv = estado.previa;
    if (!pv) return;
    const aba = estado.abas.find((a) => a.nome === estado.aba);
    const blocos = pv.blocos;
    const n = (acao) => blocos.filter((b) => b.acao === acao).length;
    const lojas = blocos.filter((b) => b.acao !== "ignorar").reduce((s, b) => s + b.paradas.length, 0);
    const avisosAba = (aba && aba.avisos) || [];
    // "Tudo verde" = nada que alguem precise conferir: sem aviso, toda rota com
    // checklist, toda loja casada e sem troca de MOTORISTA/PLACA (troca de
    // ajudante so aparece no resumo). Ai a previa vira um resumo + um clique.
    const precisaAtencao = (b) => b.acao !== "ignorar" && !!(b.avisos.length || !b.checklist || b.troca_equipe
      || (b.lojas_sem_checklist || []).length || (b.lojas_so_no_checklist || []).length || (b.lojas_so_na_viagem || []).length);
    const verde = !pv.checklist_erro && !(pv.checklists_sem_rota || []).length && !avisosAba.length
      && blocos.some((b) => b.acao !== "ignorar") && !blocos.some(precisaAtencao);
    estado.verde = verde;
    const volumes = blocos.filter((b) => b.acao !== "ignorar").reduce((s, b) => s + (Number(b.totais.volumes) || 0), 0);
    const mudancas = blocos.filter((b) => b.acao !== "ignorar").flatMap((b) => (b.divergencias || []).map((d) => `${b.rota ? b.rota.sistema : ""}: ${d}`));
    const resumoLinha = `<b>${blocos.length}</b> rota(s) para <b>${esc(dataBR(pv.data_viagem))}</b> · ${lojas} loja(s) · ${volumes} volume(s) do Checklist · `
      + `<b>${n("criar")}</b> viagem(ns) nova(s) · <b>${n("atualizar")}</b> atualiza(m) viagem já existente${n("ignorar") ? ` · ${n("ignorar")} fora` : ""}`;
    el("tmsProgResumo").innerHTML = (verde
      ? `<div style="border:1px solid #86efac;background:#f0fdf4;color:#14532d;border-radius:10px;padding:12px 14px;font-size:13px;">
          <div style="font-weight:800;font-size:14px;">✅ Tudo certo — nada precisa de conferência</div>
          <div style="margin-top:4px;">${resumoLinha}</div>
          ${mudancas.length ? `<div style="margin-top:6px;font-size:12px;">O que muda na equipe: ${mudancas.map(esc).join("<br>")}</div>` : ""}
          <div style="margin-top:6px;font-size:12px;">Clique em <b>Importar</b> (ou aperte Enter).</div>
        </div>`
      : caixa("info", resumoLinha)
        + (blocos.some(precisaAtencao) ? caixa("aviso", `⚠️ <b>${blocos.filter(precisaAtencao).length}</b> rota(s) precisam de conferência — estão logo abaixo.`) : ""))
      + (avisosAba.length ? caixa("aviso", avisosAba.map(esc).join("<br>")) : "")
      + htmlNomesNovos(blocos)
      + (pv.checklist_erro ? caixa("erro", esc(pv.checklist_erro)) : "")
      + ((pv.checklists_sem_rota || []).length
        ? caixa("aviso", "Checklist(s) de expedição deste dia sem rota nesta planilha (não entram aqui; se a rota sair, use Importar do Checklist):<br>"
          + pv.checklists_sem_rota.map((c) => `<b>#${esc(c.id)}</b> ${esc(c.rota || "-")} · placa ${esc(c.placa || "-")} · ${esc(c.lojas.length)} loja(s), ${esc(c.volumes)} volume(s): ${esc(c.lojas.join(", "))}`).join("<br>"))
        : "");

    const cartao = (b) => {
      const corBorda = b.acao === "ignorar" ? "var(--border)" : b.acao === "criar" ? "#86efac" : "#93c5fd";
      const totais = [
        b.totais.cx != null ? `CX ${b.totais.cx}` : "",
        b.totais.rt != null ? `RT ${b.totais.rt}` : "",
        b.totais.volumes != null ? `${b.totais.volumes} volumes` : "",
        b.totais.sacolas != null ? `${b.totais.sacolas} sacolas` : "",
        b.totais.material_campanha != null ? `${b.totais.material_campanha} mat. campanha` : "",
      ].filter(Boolean).join(" · ");
      const extras = [
        b.hora_saida ? `Saída <b>${esc(b.hora_saida)}</b>` : `<span style="color:#b45309;">sem horário de saída</span>`,
        b.checklist ? `<span style="color:#0e7490;">Checklist <b>#${esc(b.checklist.id)}</b> (${esc(b.checklist.status || "")} · ${esc(b.checklist.motivo)})</span>` : `<span style="color:#b45309;">sem checklist de expedição</span>`,
      ].filter(Boolean).join(" · ");
      const soNaViagem = (b.lojas_so_na_viagem || []).length
        ? caixa("info", `Lojas que estão na viagem e não na planilha (continuam como estão): <b>${b.lojas_so_na_viagem.map(esc).join(", ")}</b>`)
        : "";
      return `<section style="border:1px solid var(--border);border-left:4px solid ${corBorda};border-radius:10px;padding:10px 12px;margin-top:10px;background:var(--bg-elevated);${b.acao === "ignorar" ? "opacity:.6;" : ""}">
        <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;">
          <div style="font-weight:800;font-size:14px;color:var(--text-heading);">
            ${esc(b.rota ? b.rota.sistema : `Rota ${b.indice + 1}`)}
            ${b.rota && b.rota.planilha.toUpperCase() !== b.rota.sistema.toUpperCase() ? `<span style="font-weight:400;font-size:11px;color:var(--text-muted);">(planilha: ${esc(b.rota.planilha)})</span>` : ""}
            ${b.rota ? selo(b.rota.como) : ""}
            <span style="font-weight:400;font-size:11px;color:var(--text-muted);">· linha ${esc(b.linha || "?")} · ${b.paradas.length} loja(s)</span>
          </div>
          <label style="font-size:11px;color:var(--text-secondary);display:flex;gap:6px;align-items:center;">O que fazer
            <select data-indice="${b.indice}" class="tms-prog-acao" style="max-width:520px;">${opcoesAcao(b)}</select>
          </label>
        </div>
        ${b.alvo ? `<div style="font-size:11px;color:#1d4ed8;margin-top:2px;">Viagem encontrada: ${esc(b.sugestao && b.sugestao.alvo_id === b.alvo.id ? b.sugestao.motivo : "escolhida por você")}</div>` : ""}
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:4px 16px;font-size:12px;margin-top:8px;color:var(--text-secondary);">
          <div>Motorista: ${pessoa(b.motorista)}</div>
          <div>Placa: ${pessoa(b.placa)}</div>
          <div>Ajudantes: ${b.ajudantes.length ? b.ajudantes.map(pessoa).join(", ") : `<span style="color:var(--text-muted);">—</span>`}</div>
        </div>
        <div style="font-size:12px;margin-top:4px;color:var(--text-secondary);">${extras}${totais ? ` · ${esc(totais)}` : ""}</div>
        ${(b.divergencias || []).length ? caixa("info", b.divergencias.map(esc).join("<br>")) : ""}
        ${b.avisos.length ? caixa("aviso", b.avisos.map(esc).join("<br>")) : ""}
        ${soNaViagem}
        ${(b.lojas_so_no_checklist || []).length ? caixa("info", `Lojas que estão no checklist e não na planilha (entram no fim da viagem, com volume e itens): <b>${b.lojas_so_no_checklist.map(esc).join(", ")}</b>`) : ""}
        ${(b.lojas_sem_checklist || []).length && b.checklist ? caixa("aviso", `Lojas da planilha sem volume no checklist #${esc(b.checklist.id)}: <b>${b.lojas_sem_checklist.map(esc).join(", ")}</b>`) : ""}
        <details style="margin-top:6px;"><summary style="cursor:pointer;font-size:12px;font-weight:700;color:var(--text-heading);">Lojas da rota</summary>${tabelaParadas(b)}</details>
      </section>`;
    };
    // Rotas com pendencia primeiro e abertas; as que estao certas ficam recolhidas.
    const comPendencia = blocos.filter(precisaAtencao);
    const semPendencia = blocos.filter((b) => !precisaAtencao(b));
    el("tmsProgBlocos").innerHTML = comPendencia.map(cartao).join("")
      + (semPendencia.length
        ? `<details style="margin-top:10px;"><summary style="cursor:pointer;font-size:12px;font-weight:700;color:var(--text-heading);">`
          + `${verde ? "Ver detalhes das rotas" : `${semPendencia.length} rota(s) sem pendência`} (${semPendencia.length})</summary>${semPendencia.map(cartao).join("")}</details>`
        : "");

    el("tmsProgCadastrarNovos")?.addEventListener("click", cadastrarNomesNovos);
    el("tmsProgBlocos").querySelectorAll(".tms-prog-acao").forEach((sel) => {
      sel.addEventListener("change", () => {
        // So o que o usuario MUDOU vira escolha manual; as outras rotas seguem a
        // sugestao do servidor. Congelar todas impedia passar para uma rota a
        // viagem que estava sugerida para outra (dava conflito).
        const anterior = new Map(estado.escolhas);
        estado.escolhas.set(Number(sel.dataset.indice), sel.value);
        estado.focoIndice = sel.dataset.indice; // o render refaz a tela: devolve o foco a este select
        pedirPrevia(anterior);
      });
    });
    atualizarBotao();
    // Foco no Importar so quando a previa veio de um arquivo recem-aberto e a
    // pessoa nao esta num campo (data, aba, select): la o Enter e do campo.
    if (estado.focoIndice != null) {
      const alvo = el("tmsProgBlocos").querySelector(`.tms-prog-acao[data-indice="${estado.focoIndice}"]`);
      estado.focoIndice = null;
      if (alvo) {
        // Rota que ficou recolhida em "sem pendencia": abre o detalhe para o foco caber.
        const det = alvo.closest("details");
        if (det) det.open = true;
        alvo.focus();
      }
    }
    const focar = verde && estado.focarAposPrevia;
    estado.focarAposPrevia = false;
    const ativo = document.activeElement;
    const emCampo = ativo && ativo !== document.body && el(ID)?.contains(ativo)
      && /^(INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(ativo.tagName);
    if (focar && !emCampo) setTimeout(() => el("tmsProgBtnImportar")?.focus(), 0);
  }

  function atualizarBotao() {
    const btn = el("tmsProgBtnImportar");
    if (!btn) return;
    const blocos = estado.previa ? estado.previa.blocos.filter((b) => b.acao !== "ignorar" && b.paradas.length) : [];
    btn.disabled = estado.ocupado || estado.carregandoArquivo || !blocos.length;
    btn.textContent = blocos.length ? `Importar ${blocos.length} rota${blocos.length === 1 ? "" : "s"}` : "Importar";
  }

  // ── API publica (onclick) ─────────────────────────────────────
  window.tmsAbrirImportarProgramacao = function () {
    const modal = garantirModal();
    estado.arquivo = "";
    estado.wb = null;
    estado.abas = [];
    estado.aba = "";
    estado.data = "";
    estado.dataOrigem = "";
    estado.previa = null;
    estado.escolhas.clear();
    // Invalida download/leitura/previa ainda em voo da abertura anterior do modal.
    estado.seqArquivo += 1;
    estado.seqPrevia += 1;
    estado.ocupado = false;
    estado.caminhoPasta = null;
    estado.focarAposPrevia = false;
    estado.abaDica = "";
    el("tmsProgArquivo").value = "";
    el("tmsProgDropTitulo").textContent = "Escolha ou arraste a planilha de programação";
    const drop = el("tmsProgDrop");
    drop.style.padding = "20px";
    drop.style.flexDirection = "column";
    drop.querySelectorAll("span").forEach((s) => { s.style.display = ""; });
    el("tmsProgOpcoes").style.display = "none";
    el("tmsProgResumo").innerHTML = "";
    el("tmsProgBlocos").innerHTML = "";
    estado.verde = false;
    status("");
    carregando(false);
    modal.classList.remove("hidden");
    modal.style.display = "flex";
    el("tmsProgDrop").focus?.();
    carregarPasta();
  };

  window.tmsFecharImportarProgramacao = function () {
    const modal = el(ID);
    if (!modal) return;
    modal.classList.add("hidden");
    modal.style.display = "none";
  };

  window.tmsConfirmarImportarProgramacao = async function () {
    if (!estado.previa || estado.ocupado) return;
    // A previa na tela tem que ser da data que esta no campo.
    if (estado.previa.data_viagem !== estado.data) { pedirPrevia(); return; }
    // Manda so as escolhas feitas a mao. O resto o servidor recalcula na hora de
    // gravar: se o dia mudou depois da previa (outra aba ou outro usuario
    // importou), congelar "Criar" duplicaria todas as viagens.
    estado.ocupado = true;
    atualizarBotao();
    const btn = el("tmsProgBtnImportar");
    if (btn) btn.textContent = "Importando...";
    status("Gravando...");
    try {
      const r = await api("/tms/programacao/importar", payload());
      const data = r.data_viagem;
      window.tmsFecharImportarProgramacao();
      const filtro = el("tmsFiltroData");
      if (filtro && data) filtro.value = data;
      if (typeof window.tmsCarregarViagens === "function") await window.tmsCarregarViagens();
      if (typeof window.dispararMudou === "function") window.dispararMudou("tms");
      const linhas = [
        `Programação de ${dataBR(data)} importada.`,
        r.criadas.length ? `${r.criadas.length} viagem(ns) criada(s): ${r.criadas.map((x) => x.rota).join(", ")}.` : "",
        r.atualizadas.length ? `${r.atualizadas.length} viagem(ns) atualizada(s): ${r.atualizadas.map((x) => `${x.rota} (${x.paradas_atualizadas} parada(s) completada(s)${x.paradas_novas ? `, ${x.paradas_novas} nova(s)` : ""})`).join(", ")}.` : "",
        r.ignoradas.length ? `${r.ignoradas.length} rota(s) não importada(s).` : "",
        r.transferencias?.length ? `${r.transferencias.length} loja(s) transferida(s) para a rota da planilha.` : "",
        r.remocoes?.length ? `${r.remocoes.length} parada(s) duplicada(s) ou retirada(s) da planilha removida(s).` : "",
        r.puladas?.length ? r.puladas.map(x => x.motivo).join("\n") : "",
        r.avisos?.length ? r.avisos.join("\n") : "",
        r.checklist_erro ? `Atenção: ${r.checklist_erro}` : "",
      ].filter(Boolean);
      avisar(linhas.join("\n"));
    } catch (err) {
      status("");
      avisar(`Falha ao importar: ${err.message || err}`);
      if (err && err.status === 400) {
        // O dia mudou desde a previa (ex.: outra aba importou). Solta os "Criar"
        // manuais, que ficariam travando toda nova escolha, e refaz a previa.
        [...estado.escolhas.entries()].forEach(([i, v]) => { if (v === "criar") estado.escolhas.delete(i); });
        // Espera a previa nova antes de liberar o botao: sem isso um 2o clique
        // gravava olhando a tela velha.
        await pedirPrevia();
        return;
      }
    } finally {
      estado.ocupado = false;
      atualizarBotao();
    }
  };

  // ── selo da sincronizacao com o Checklist (barra do TMS) ───────
  // O servidor puxa volume e materiais do Checklist sozinho a cada poucos minutos;
  // o selo mostra quando foi a ultima vez e deixa forcar agora.
  function horaCurta(iso) {
    try { return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }); } catch (_) { return ""; }
  }

  function garantirSelo() {
    let selo = el("tmsSyncChecklist");
    if (selo) return selo;
    const botao = document.querySelector('#aba-tms button[onclick="tmsAbrirImportarProgramacao()"]');
    const cabecalho = botao && botao.closest(".section-head");
    if (!cabecalho) return null;
    selo = document.createElement("div");
    selo.id = "tmsSyncChecklist";
    selo.className = "admin-only-action";
    selo.setAttribute("aria-live", "polite");
    selo.style.cssText = "display:none;font-size:12px;color:var(--text-muted);margin:6px 0 2px;gap:8px;align-items:center;flex-wrap:wrap;";
    cabecalho.insertAdjacentElement("afterend", selo);
    return selo;
  }

  function desenharSelo(d) {
    const selo = garantirSelo();
    if (!selo) return;
    const ultima = d && d.ultima;
    const comErro = ultima && (ultima.resultados || []).find((r) => r.erro);
    const erro = comErro && comErro.erro;
    // Falha de gravacao no banco nao e culpa do Checklist: o selo diz qual foi.
    const doBanco = comErro && comErro.origemErro === 'gravacao';
    const mudou = ultima ? (ultima.resultados || []).reduce((s, r) => s + (r.viagens || []).length, 0) : 0;
    const texto = !d || !d.intervalo_min
      ? `🔄 Checklist: sincronização automática desligada${ultima ? ` · última manual às ${horaCurta(ultima.em)}` : ""}.`
      : erro
        ? (doBanco
          ? `⚠️ Sincronização com o Checklist falhou ao gravar (${horaCurta(ultima.em)}). Tenta de novo a cada ${d.intervalo_min} min.`
          : `⚠️ Checklist sem resposta na última tentativa (${horaCurta(ultima.em)}). Tenta de novo sozinho a cada ${d.intervalo_min} min.`)
        : ultima
          ? `🔄 Checklist sincroniza sozinho a cada ${d.intervalo_min} min · última às ${horaCurta(ultima.em)}${mudou ? ` (${mudou} viagem(ns) atualizada(s))` : " (sem mudança)"}`
          : `🔄 Checklist sincroniza sozinho a cada ${d.intervalo_min} min · primeira sincronização em instantes`;
    // Planilha da rede: entra sozinha nos dias ja importados a mao.
    const pl = d && d.planilha;
    const plResultados = (pl && pl.resultados) || [];
    const plAplicadas = plResultados.reduce((s, r) => s + (r.aplicadas || []).length, 0);
    const plAvisos = plResultados.reduce((s, r) => s + (r.avisos || []).length, 0);
    const plErro = pl && (pl.erro || plResultados.map((r) => r.erro).filter(Boolean)[0]);
    const textoPlanilha = !d || !d.intervalo_min ? ""
      : !pl ? ""
        : plErro ? ` · ⚠️ Planilha: ${plErro}`
          : !plResultados.length ? " · Planilha: entra sozinha depois da 1ª importação do dia"
            : ` · Planilha conferida às ${horaCurta(pl.em)}${plAplicadas ? ` (${plAplicadas} rota(s) atualizada(s))` : plAvisos ? " (com avisos)" : " (sem mudança)"}`;
    // Mensagem real do erro e avisos (checklist que saiu do dia, viagem ja em rota...) no title.
    const avisos = [
      ...(ultima ? (ultima.resultados || []).flatMap((r) => r.avisos || []) : []),
      ...plResultados.flatMap((r) => r.avisos || []),
    ];
    const detalhe = [erro, plErro, ...avisos].filter(Boolean).join("\n");
    selo.innerHTML = `<span title="${esc(detalhe)}">${esc(texto + textoPlanilha)}${avisos.length ? ` · ⚠️ ${esc(avisos.length)} aviso(s) (passe o mouse)` : ""}</span><button type="button" class="btn-ghost btn-sm" id="tmsSyncAgora" style="padding:2px 8px;font-size:11px;">Sincronizar agora</button>`;
    selo.style.display = "flex";
    el("tmsSyncAgora").addEventListener("click", sincronizarAgora);
  }

  async function atualizarSelo() {
    const aba = el("aba-tms");
    if (!aba || aba.offsetParent === null || document.visibilityState === "hidden") return;
    try {
      const resp = await fetch(`${API}/tms/programacao/sincronizacao`, { headers: { Accept: "application/json" } });
      if (!resp.ok) { const s = el("tmsSyncChecklist"); if (s) s.style.display = "none"; return; }
      desenharSelo(await resp.json());
    } catch (_) { /* servidor fora: o proximo ciclo tenta de novo */ }
  }

  async function sincronizarAgora() {
    const botao = el("tmsSyncAgora");
    if (botao) { botao.disabled = true; botao.textContent = "Sincronizando..."; }
    try {
      await api("/tms/programacao/sincronizar", {});
      // Relê o estado (formato do GET /sincronizacao, com planilha + Checklist).
      await atualizarSelo();
      if (typeof window.tmsCarregarViagens === "function") await window.tmsCarregarViagens();
    } catch (err) {
      avisar(`Não consegui sincronizar: ${err.message || err}`);
      if (botao) { botao.disabled = false; botao.textContent = "Sincronizar agora"; }
    }
  }

  setInterval(atualizarSelo, 60000);
  document.addEventListener("click", (e) => {
    // Ao abrir a aba TMS o selo aparece logo, sem esperar o minuto.
    if (e.target && e.target.closest && e.target.closest('[data-aba="tms"], [onclick*="tms"]')) setTimeout(atualizarSelo, 400);
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(atualizarSelo, 1500));
  else setTimeout(atualizarSelo, 1500);
})();
