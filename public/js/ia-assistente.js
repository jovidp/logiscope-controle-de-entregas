// ================================================================
// ASSISTENTE DE IA — balao flutuante 🤖 (chat com memoria + treino)
// Global: disponivel em todas as telas, enxerga a tela atual do usuario,
// mantem historico persistente e le a "base de conhecimento" ensinada pela
// equipe. Reusa o fetch autenticado de auth.js (token injetado sozinho).
// Fica embaixo A ESQUERDA para nao colidir com o chat de equipe (💬, direita).
// ================================================================
(function iniciarAssistenteIa() {
  let usuario = null;
  let aberto = false;
  let view = "chat"; // 'chat' | 'conhecimento'
  let mensagens = []; // { papel:'user'|'assistant', texto, tela }
  let enviando = false;
  let conhecimentoCache = [];
  let anexos = []; // arquivos anexados p/ o proximo envio: { nome, tipo, conteudo|dataUrl, mime, aviso? }

  const $ = (id) => document.getElementById(id);

  // Worker do pdf.js (extracao de texto de PDF). So configura se a lib carregou.
  if (window.pdfjsLib?.GlobalWorkerOptions) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  function esc(v) {
    return String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  // Markdown leve: titulos (#), bullets (-/*), **negrito** e paragrafos.
  // Remove o bloco de acao (```acao ... ```) — ele vira card, nao texto.
  function md(texto) {
    const limpo = String(texto || "").replace(/```acao[\s\S]*?```/gi, "").trim();
    const linhas = limpo.split(/\r?\n/);
    const html = linhas.map((linha) => {
      if (!linha.trim()) return "";
      const negrito = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      if (/^#{1,4}\s/.test(linha)) return `<h4>${negrito(linha.replace(/^#{1,4}\s*/, ""))}</h4>`;
      if (/^\s*[-*]\s/.test(linha)) return `<p class="ia-bul">${negrito(linha.replace(/^\s*[-*]\s*/, ""))}</p>`;
      return `<p>${negrito(linha)}</p>`;
    });
    return html.join("");
  }

  function rotuloOrigem(origem, modelo) {
    if (origem === "gemini") return `Gemini${modelo ? ` · ${modelo}` : ""}`;
    if (origem === "openai") return `OpenAI${modelo ? ` · ${modelo}` : ""}`;
    return "IA local (regras)";
  }

  async function api(path, options) {
    const resp = await fetch(path, {
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      ...(options || {}),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(body.error || body.detalhe || `Erro na IA (HTTP ${resp.status}).`);
    return body;
  }

  // Best-effort: descobre em que tela/aba o usuario esta, para dar contexto a IA.
  function telaAtual() {
    const sel = [
      ".secao.ativa", ".secao.ativo", ".aba.ativa", ".view.ativa",
      "section.ativa", "[data-secao].ativa", ".pagina.ativa", ".tab-pane.active",
    ];
    for (const s of sel) {
      const el = document.querySelector(s);
      if (!el) continue;
      const h = el.querySelector("h1,h2,h3");
      const t = (h?.textContent || el.getAttribute("data-titulo") || "").trim();
      if (t) return t.replace(/\s+/g, " ").slice(0, 100);
    }
    const nav = document.querySelector("nav .ativo, .menu .ativo, .sidebar .ativa, .nav-item.ativo, .menu-item.ativo");
    if (nav && nav.textContent.trim()) return nav.textContent.replace(/\s+/g, " ").trim().slice(0, 100);
    return (document.title || "Controle de Entrega").replace(/\s+/g, " ").trim().slice(0, 100);
  }

  // ================= ANEXOS (arquivos que a IA le) =================
  const MAX_CHARS_ARQ = 15000; // texto extraido por arquivo
  const IMG_MAX_LADO = 1280; // px — reduz fotos antes de enviar

  function extensao(nome) {
    const m = String(nome || "").toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : "";
  }

  function lerComo(file, como) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error("Falha ao ler o arquivo."));
      if (como === "text") fr.readAsText(file);
      else if (como === "dataURL") fr.readAsDataURL(file);
      else fr.readAsArrayBuffer(file);
    });
  }

  function cortar(txt) {
    const s = String(txt || "").trim();
    return s.length > MAX_CHARS_ARQ ? s.slice(0, MAX_CHARS_ARQ) + "\n...[truncado]" : s;
  }

  async function extrairPlanilha(file) {
    if (typeof XLSX === "undefined") throw new Error("Leitor de planilha indisponível.");
    const buf = await lerComo(file, "buffer");
    const wb = XLSX.read(buf, { type: "array" });
    const partes = wb.SheetNames.slice(0, 8).map((nome) => {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[nome]);
      return `# Planilha: ${nome}\n${csv}`;
    });
    return partes.join("\n\n");
  }

  async function extrairPdf(file) {
    if (!window.pdfjsLib) throw new Error("Leitor de PDF indisponível.");
    const buf = await lerComo(file, "buffer");
    const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
    const maxPag = Math.min(pdf.numPages, 30);
    let texto = "";
    for (let p = 1; p <= maxPag; p++) {
      const page = await pdf.getPage(p);
      const cont = await page.getTextContent();
      texto += cont.items.map((it) => it.str).join(" ") + "\n";
      if (texto.length > MAX_CHARS_ARQ) break;
    }
    texto = texto.trim();
    if (!texto) throw new Error("PDF sem texto extraível (pode ser digitalizado/imagem).");
    return texto;
  }

  async function extrairDocx(file) {
    if (!window.mammoth) throw new Error("Leitor de Word indisponível.");
    const arrayBuffer = await lerComo(file, "buffer");
    const r = await window.mammoth.extractRawText({ arrayBuffer });
    const texto = String(r?.value || "").trim();
    if (!texto) throw new Error("Documento Word sem texto.");
    return texto;
  }

  // Reduz a imagem (canvas) e devolve dataURL jpeg leve p/ enviar ao modelo.
  async function reduzirImagem(file) {
    const dataURL = await lerComo(file, "dataURL");
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        let { width: w, height: h } = img;
        const escala = Math.min(1, IMG_MAX_LADO / Math.max(w, h));
        w = Math.round(w * escala);
        h = Math.round(h * escala);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        try {
          resolve(canvas.toDataURL("image/jpeg", 0.82));
        } catch {
          resolve(dataURL); // fallback (ex: imagem cross-origin) — improvavel aqui
        }
      };
      img.onerror = () => resolve(dataURL);
      img.src = dataURL;
    });
  }

  async function processarArquivo(file) {
    const ext = extensao(file.name);
    const mime = file.type || "";
    if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) {
      const dataUrl = await reduzirImagem(file);
      return { nome: file.name, tipo: "imagem", dataUrl, mime: "image/jpeg" };
    }
    let conteudo = "";
    if (["xlsx", "xls", "xlsm"].includes(ext)) conteudo = await extrairPlanilha(file);
    else if (ext === "pdf" || mime === "application/pdf") conteudo = await extrairPdf(file);
    else if (ext === "docx") conteudo = await extrairDocx(file);
    else if (ext === "doc") throw new Error("Formato .doc antigo não é lido — salve como .docx ou PDF.");
    else conteudo = await lerComo(file, "text"); // csv, txt e afins
    return { nome: file.name, tipo: "texto", conteudo: cortar(conteudo) };
  }

  async function aoSelecionarArquivos(fileList) {
    const files = Array.from(fileList || []).slice(0, 8);
    for (const file of files) {
      if (anexos.length >= 8) break;
      const idx = anexos.push({ nome: file.name, tipo: "processando" }) - 1;
      renderAnexos();
      try {
        anexos[idx] = await processarArquivo(file);
      } catch (err) {
        anexos[idx] = { nome: file.name, tipo: "erro", aviso: err.message };
      }
      renderAnexos();
    }
    const inp = $("iaAsstFile");
    if (inp) inp.value = "";
  }

  function iconeAnexo(a) {
    if (a.tipo === "imagem") return "🖼";
    if (a.tipo === "erro") return "⚠️";
    if (a.tipo === "processando") return "⏳";
    return "📄";
  }

  function renderAnexos() {
    const bar = $("iaAsstAnexos");
    if (!bar) return;
    bar.style.display = anexos.length ? "flex" : "none";
    bar.innerHTML = anexos.map((a, i) => `
      <span class="iaa-anexo ${a.tipo === "erro" ? "erro" : ""}" title="${esc(a.aviso || a.nome)}">
        ${iconeAnexo(a)} <span class="iaa-anexo-nome">${esc(a.nome)}</span>
        <button type="button" class="iaa-anexo-x" data-idx="${i}" title="Remover">✕</button>
      </span>`).join("");
    bar.querySelectorAll(".iaa-anexo-x").forEach((b) =>
      b.addEventListener("click", () => { anexos.splice(Number(b.dataset.idx), 1); renderAnexos(); }));
  }

  // Prepara os anexos validos p/ envio e a lista de nomes p/ mostrar na bolha.
  function anexosParaEnvio() {
    const validos = anexos.filter((a) => a.tipo === "imagem" || a.tipo === "texto");
    const payload = validos.map((a) => a.tipo === "imagem"
      ? { nome: a.nome, tipo: "imagem", mime: a.mime, dados: String(a.dataUrl).split(",")[1] || "" }
      : { nome: a.nome, tipo: "texto", conteudo: a.conteudo });
    return { payload, nomes: validos.map((a) => a.nome) };
  }

  // ================= ACOES (a IA propoe, o usuario confirma) =================
  // Extrai o bloco ```acao {json} ``` da resposta da IA, se houver.
  function extrairAcao(texto) {
    const m = String(texto || "").match(/```acao\s*([\s\S]*?)```/i);
    if (!m) return null;
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj && obj.ferramenta && ACOES[obj.ferramenta]) {
        return { ferramenta: obj.ferramenta, args: obj.args || {} };
      }
    } catch { /* json invalido: ignora, vira so texto */ }
    return null;
  }

  function temFn(nome) {
    return typeof window[nome] === "function";
  }

  // Cadastro simples (motorista/ajudante/placa/loja) -> POST /cadastros.
  async function cadastrar(tipo, valor, extra) {
    if (!valor) throw new Error("Faltou o valor a cadastrar.");
    await api("/cadastros", { method: "POST", body: JSON.stringify({ tipo, valor, extra: extra || null }) });
    return `✅ ${tipo} “${valor}” cadastrado com sucesso.`;
  }

  // Preenche o formulario real e chama a funcao de salvar existente (reusa
  // validacao + calculo + sincronizacao). Retorna quando o registro foi salvo.
  async function preencherESalvar(abrir, salvar, campos) {
    if (!temFn(abrir) || !temFn(salvar) || !temFn("setVal")) {
      throw new Error("Formulário indisponível — abra a aba correspondente e tente de novo.");
    }
    window[abrir]();
    for (const [id, valor] of Object.entries(campos)) {
      if (valor !== undefined && valor !== null && valor !== "") window.setVal(id, String(valor));
    }
    await window[salvar]();
    return true;
  }

  // Registro de acoes: rotulo (titulo do card), valido (checa obrigatorios),
  // resumo (HTML mostrado no card) e run (executa).
  const ACOES = {
    cadastrar_motorista: {
      rotulo: "Cadastrar motorista",
      valido: (a) => !!(a.nome || "").trim(),
      resumo: (a) => `Motorista: <b>${esc(a.nome)}</b>`,
      run: (a) => cadastrar("motorista", (a.nome || "").trim()),
    },
    cadastrar_ajudante: {
      rotulo: "Cadastrar ajudante",
      valido: (a) => !!(a.nome || "").trim(),
      resumo: (a) => `Ajudante: <b>${esc(a.nome)}</b>`,
      run: (a) => cadastrar("ajudante", (a.nome || "").trim()),
    },
    cadastrar_placa: {
      rotulo: "Cadastrar placa",
      valido: (a) => !!(a.placa || "").trim(),
      resumo: (a) => `Placa: <b>${esc(a.placa)}</b>`,
      run: (a) => cadastrar("placa", (a.placa || "").trim().toUpperCase()),
    },
    cadastrar_loja: {
      rotulo: "Cadastrar loja",
      valido: (a) => !!(a.nome || "").trim(),
      resumo: (a) => `Loja: <b>${esc(a.nome)}</b>${a.rota ? ` · rota <b>${esc(a.rota)}</b>` : ""}`,
      run: (a) => cadastrar("loja", (a.nome || "").trim(), a.rota ? { rota: String(a.rota).trim() } : null),
    },
    registrar_atraso_saida: {
      rotulo: "Registrar atraso de saída",
      valido: (a) => a.data && a.motorista && a.placa && a.horaMarcada && a.horaReal,
      resumo: (a) => `<b>${esc(a.motorista)}</b> · placa ${esc(a.placa)}${a.rota ? ` · ${esc(a.rota)}` : ""}<br>${esc(a.data)} · marcada ${esc(a.horaMarcada)} → real ${esc(a.horaReal)}`,
      run: async (a) => {
        await preencherESalvar("abrirFormAtrasoSaida", "salvarAtrasoSaida", {
          dataAtrasoSaida: a.data,
          motoristaAtrasoSaida: a.motorista,
          placaAtrasoSaida: a.placa,
          rotaAtrasoSaida: a.rota,
          horaMarcadaAtrasoSaida: a.horaMarcada,
          horaRealAtrasoSaida: a.horaReal,
          justificativaAtrasoSaida: a.justificativa,
        });
        return "✅ Atraso de saída registrado. Confira no formulário/lista.";
      },
    },
    registrar_retorno_rota: {
      rotulo: "Registrar retorno de rota",
      valido: (a) => a.data && a.motorista && a.placa && a.rotaFeita && a.horaSaida && a.horaRetorno,
      resumo: (a) => `<b>${esc(a.motorista)}</b> · placa ${esc(a.placa)} · rota ${esc(a.rotaFeita)}<br>${esc(a.data)} · saída ${esc(a.horaSaida)} → retorno ${esc(a.horaRetorno)}`,
      run: async (a) => {
        await preencherESalvar("abrirFormRota", "salvarRota", {
          dataRota: a.data,
          motoristaRota: a.motorista,
          placaRota: a.placa,
          rotaFeita: a.rotaFeita,
          rotaSaida: a.horaSaida,
          rotaRetorno: a.horaRetorno,
          responsavelAnaliseRota: a.responsavel,
          rotaObs: a.obs,
        });
        return "✅ Tempo/retorno de rota registrado. Confira no formulário/lista.";
      },
    },
  };

  function injetarEstilos() {
    if ($("iaAsstEstilos")) return;
    const css = `
      #iaAsstBtn{position:fixed;left:20px;bottom:20px;width:56px;height:56px;border-radius:50%;
        background:linear-gradient(135deg,#a855f7,#6366f1);color:#fff;border:none;cursor:pointer;
        box-shadow:0 8px 24px rgba(139,92,246,.45);font-size:26px;z-index:9000;display:flex;align-items:center;
        justify-content:center;transition:transform .15s;}
      #iaAsstBtn:hover{transform:scale(1.06);}
      #iaAsstPainel{position:fixed;left:20px;bottom:88px;width:370px;max-width:calc(100vw - 32px);height:520px;
        max-height:calc(100vh - 120px);background:var(--bg-elevated,#0f172a);border:1px solid var(--border,#1e293b);
        border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.55);z-index:9000;display:none;flex-direction:column;
        overflow:hidden;font-family:inherit;}
      #iaAsstPainel.aberto{display:flex;}
      .iaa-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--border,#1e293b);
        background:linear-gradient(135deg,rgba(168,85,247,.14),rgba(99,102,241,.10));}
      .iaa-head .iaa-titulo{font-weight:800;color:var(--text-heading,#f8fafc);font-size:14px;flex:1;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .iaa-head .iaa-sub{font-size:10px;font-weight:600;color:var(--text-muted,#94a3b8);}
      .iaa-head button{background:none;border:none;color:var(--text-muted,#94a3b8);cursor:pointer;font-size:15px;
        padding:2px 6px;border-radius:6px;}
      .iaa-head button:hover{background:rgba(255,255,255,.06);color:var(--text-heading,#f8fafc);}
      .iaa-tabs{display:flex;border-bottom:1px solid var(--border,#1e293b);}
      .iaa-tab{flex:1;padding:9px;background:none;border:none;color:var(--text-muted,#94a3b8);cursor:pointer;
        font-size:12px;font-weight:700;font-family:inherit;}
      .iaa-tab.ativa{color:#a855f7;box-shadow:inset 0 -2px 0 #a855f7;}
      .iaa-tela{font-size:10px;color:var(--text-muted,#94a3b8);padding:5px 12px;border-bottom:1px solid var(--border,#1e293b);
        background:rgba(255,255,255,.02);display:flex;align-items:center;gap:8px;}
      .iaa-tela #iaAsstTela{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .iaa-tela select{background:rgba(255,255,255,.04);border:1px solid var(--border,#1e293b);color:var(--text-muted,#94a3b8);
        border-radius:6px;font-size:10px;padding:2px 4px;font-family:inherit;outline:none;cursor:pointer;flex:none;}
      .iaa-tela select:focus{border-color:#a855f7;}
      .iaa-corpo{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px;}
      .iaa-msg{max-width:88%;padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.4;word-wrap:break-word;}
      .iaa-msg p{margin:0 0 4px;} .iaa-msg p:last-child{margin-bottom:0;}
      .iaa-msg h4{margin:2px 0 4px;font-size:13px;} .iaa-msg .ia-bul{padding-left:12px;position:relative;}
      .iaa-msg .ia-bul::before{content:"•";position:absolute;left:2px;opacity:.7;}
      .iaa-msg.eu{align-self:flex-end;background:linear-gradient(135deg,#a855f7,#6366f1);color:#fff;border-bottom-right-radius:4px;}
      .iaa-msg.ia{align-self:flex-start;background:rgba(255,255,255,.06);color:var(--text-heading,#f1f5f9);
        border:1px solid var(--border,#1e293b);border-bottom-left-radius:4px;}
      .iaa-msg .iaa-origem{display:block;font-size:9px;opacity:.6;margin-top:4px;}
      .iaa-vazio{color:var(--text-muted,#94a3b8);font-size:12px;text-align:center;margin:auto;padding:0 16px;}
      .iaa-dots{align-self:flex-start;color:var(--text-muted,#94a3b8);font-size:13px;padding:6px 12px;}
      .iaa-dots span{animation:iaaBlink 1.2s infinite;} .iaa-dots span:nth-child(2){animation-delay:.2s;}
      .iaa-dots span:nth-child(3){animation-delay:.4s;}
      @keyframes iaaBlink{0%,60%,100%{opacity:.2;}30%{opacity:1;}}
      .iaa-card{align-self:flex-start;max-width:92%;background:rgba(168,85,247,.09);border:1px solid rgba(168,85,247,.35);
        border-radius:12px;padding:10px 12px;font-size:12px;color:var(--text-heading,#f1f5f9);}
      .iaa-card.feito{background:rgba(34,197,94,.10);border-color:rgba(34,197,94,.4);}
      .iaa-card.erro{background:rgba(239,68,68,.10);border-color:rgba(239,68,68,.4);}
      .iaa-card-tit{font-weight:800;font-size:12px;margin-bottom:5px;}
      .iaa-card-resumo{color:var(--text-muted,#cbd5e1);line-height:1.4;margin-bottom:9px;}
      .iaa-card-msg{color:var(--text-muted,#cbd5e1);line-height:1.4;}
      .iaa-card-acoes{display:flex;gap:8px;}
      .iaa-card-acoes button{flex:1;border:none;border-radius:8px;padding:7px;cursor:pointer;font-weight:800;font-size:12px;font-family:inherit;}
      .iaa-card-ok{background:linear-gradient(135deg,#a855f7,#6366f1);color:#fff;}
      .iaa-card-cancel{background:rgba(255,255,255,.06);color:var(--text-muted,#94a3b8);}
      .iaa-compositor{display:flex;gap:8px;padding:10px;border-top:1px solid var(--border,#1e293b);}
      .iaa-compositor textarea{flex:1;background:rgba(255,255,255,.04);border:1px solid var(--border,#1e293b);
        border-radius:10px;padding:9px 12px;color:var(--text-heading,#f8fafc);font-size:13px;font-family:inherit;
        outline:none;resize:none;max-height:90px;line-height:1.35;}
      .iaa-compositor textarea:focus{border-color:#a855f7;}
      .iaa-compositor button{background:linear-gradient(135deg,#a855f7,#6366f1);border:none;color:#fff;border-radius:10px;
        padding:0 14px;cursor:pointer;font-weight:800;font-size:15px;}
      .iaa-compositor button:disabled{opacity:.5;cursor:default;}
      #iaAsstAnexar{background:rgba(255,255,255,.06)!important;color:var(--text-muted,#94a3b8)!important;font-size:16px;padding:0 11px;}
      #iaAsstAnexar:hover{color:#a855f7!important;}
      .iaa-anexos{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px 0;}
      .iaa-anexo{display:inline-flex;align-items:center;gap:5px;max-width:100%;background:rgba(168,85,247,.12);
        border:1px solid rgba(168,85,247,.3);color:var(--text-heading,#e2e8f0);border-radius:8px;padding:3px 6px 3px 8px;font-size:11px;}
      .iaa-anexo.erro{background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.35);}
      .iaa-anexo-nome{max-width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .iaa-anexo-x{background:none!important;border:none;color:var(--text-muted,#94a3b8)!important;cursor:pointer;font-size:11px;padding:0 2px!important;font-weight:800;}
      .iaa-anexo-x:hover{color:#ef4444!important;}
      .iaa-msg-anexos{margin-top:5px;font-size:10px;opacity:.85;line-height:1.5;}
      /* --- Conhecimento --- */
      .iaa-conh-form{padding:12px;border-bottom:1px solid var(--border,#1e293b);display:flex;flex-direction:column;gap:8px;}
      .iaa-conh-form input,.iaa-conh-form textarea{background:rgba(255,255,255,.04);border:1px solid var(--border,#1e293b);
        border-radius:9px;padding:8px 10px;color:var(--text-heading,#f8fafc);font-size:12px;font-family:inherit;outline:none;resize:vertical;}
      .iaa-conh-form input:focus,.iaa-conh-form textarea:focus{border-color:#a855f7;}
      .iaa-conh-form .iaa-conh-acoes{display:flex;gap:8px;}
      .iaa-conh-form button{flex:1;background:linear-gradient(135deg,#a855f7,#6366f1);border:none;color:#fff;
        border-radius:9px;padding:8px;cursor:pointer;font-weight:800;font-size:12px;}
      .iaa-conh-form button.sec{background:rgba(255,255,255,.06);color:var(--text-muted,#94a3b8);}
      .iaa-conh-item{padding:10px 12px;border-bottom:1px solid var(--border,#1e293b);display:flex;gap:10px;align-items:flex-start;}
      .iaa-conh-item .iaa-conh-txt{flex:1;min-width:0;}
      .iaa-conh-item strong{display:block;font-size:12px;color:var(--text-heading,#f1f5f9);}
      .iaa-conh-item small{display:block;font-size:11px;color:var(--text-muted,#94a3b8);margin-top:2px;word-wrap:break-word;}
      .iaa-conh-item .iaa-tag{display:inline-block;font-size:9px;background:rgba(168,85,247,.18);color:#c4b5fd;
        padding:1px 6px;border-radius:6px;margin-top:4px;}
      .iaa-conh-item button{background:none;border:none;color:var(--text-muted,#94a3b8);cursor:pointer;font-size:14px;}
      .iaa-conh-item button:hover{color:#ef4444;}
    `;
    const style = document.createElement("style");
    style.id = "iaAsstEstilos";
    style.textContent = css;
    document.head.appendChild(style);
  }

  function construir() {
    if ($("iaAsstBtn")) return;
    const btn = document.createElement("button");
    btn.id = "iaAsstBtn";
    btn.type = "button";
    btn.title = "Assistente de IA";
    btn.textContent = "🤖";
    btn.addEventListener("click", alternar);
    document.body.appendChild(btn);

    const painel = document.createElement("div");
    painel.id = "iaAsstPainel";
    painel.innerHTML = `
      <div class="iaa-head">
        <div style="flex:1;min-width:0;">
          <div class="iaa-titulo">🤖 Assistente IA</div>
          <div class="iaa-sub" id="iaAsstSub">Pergunte, cadastre ou ensine algo</div>
        </div>
        <button type="button" id="iaAsstLimpar" title="Limpar conversa">🧹</button>
        <button type="button" id="iaAsstFechar" title="Fechar">✕</button>
      </div>
      <div class="iaa-tabs">
        <button type="button" class="iaa-tab ativa" data-view="chat">Chat</button>
        <button type="button" class="iaa-tab" data-view="conhecimento">📚 Conhecimento</button>
      </div>
      <div class="iaa-tela" id="iaAsstTelaBar">
        <span id="iaAsstTela"></span>
        <select id="iaAsstPeriodo" title="Período analisado pela IA">
          <option value="">Período: auto</option>
          <option value="hoje">Hoje</option>
          <option value="semana">7 dias</option>
          <option value="mes">30 dias</option>
          <option value="trimestre">90 dias</option>
        </select>
      </div>
      <div class="iaa-corpo" id="iaAsstCorpo"></div>
      <div class="iaa-anexos" id="iaAsstAnexos" style="display:none;"></div>
      <div class="iaa-compositor" id="iaAsstCompositor">
        <button type="button" id="iaAsstAnexar" title="Anexar arquivo (imagem, PDF, Word, Excel, CSV)">📎</button>
        <input type="file" id="iaAsstFile" multiple style="display:none;"
          accept="image/*,.pdf,.csv,.txt,.xlsx,.xls,.xlsm,.docx" />
        <textarea id="iaAsstInput" rows="1" placeholder="Pergunte, anexe um arquivo 📎, ou /ensinar &lt;fato&gt;" maxlength="2000"></textarea>
        <button type="button" id="iaAsstEnviar" title="Enviar">➤</button>
      </div>`;
    document.body.appendChild(painel);

    painel.querySelectorAll(".iaa-tab").forEach((t) =>
      t.addEventListener("click", () => trocarView(t.dataset.view)));
    $("iaAsstFechar").addEventListener("click", alternar);
    $("iaAsstLimpar").addEventListener("click", limparConversa);
    $("iaAsstEnviar").addEventListener("click", enviar);
    $("iaAsstAnexar").addEventListener("click", () => $("iaAsstFile")?.click());
    $("iaAsstFile").addEventListener("change", (e) => aoSelecionarArquivos(e.target.files));
    const input = $("iaAsstInput");
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar(); }
    });
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 90) + "px";
    });
  }

  function alternar() {
    aberto = !aberto;
    $("iaAsstPainel").classList.toggle("aberto", aberto);
    if (aberto) {
      atualizarTela();
      if (view === "chat") { if (!mensagens.length) carregarHistorico(); else renderChat(); }
      else renderConhecimento();
      $("iaAsstInput")?.focus();
    }
  }

  function atualizarTela() {
    const el = $("iaAsstTela");
    if (el) el.textContent = `📍 ${telaAtual()}`;
  }

  function trocarView(novo) {
    view = novo;
    document.querySelectorAll(".iaa-tab").forEach((t) => t.classList.toggle("ativa", t.dataset.view === novo));
    const ehChat = novo === "chat";
    $("iaAsstCompositor").style.display = ehChat ? "flex" : "none";
    $("iaAsstTelaBar").style.display = ehChat ? "flex" : "none";
    if (ehChat) { if (!mensagens.length) carregarHistorico(); else renderChat(); }
    else { renderConhecimento(); carregarConhecimento(); }
  }

  // ---------------- CHAT ----------------
  function renderChat(mostrarDots = false) {
    const corpo = $("iaAsstCorpo");
    if (!corpo) return;
    if (!mensagens.length && !mostrarDots) {
      corpo.innerHTML = `<div class="iaa-vazio">Sou a IA da torre. Pergunte sobre entregas, atrasos, rotas ou motoristas; peça para <b>cadastrar</b> loja/motorista/placa ou <b>registrar</b> atraso de saída e retorno de rota; ou me ensine algo com <b>/ensinar</b>.</div>`;
      return;
    }
    corpo.innerHTML = mensagens.map((m, i) => {
      const eu = m.papel === "user";
      const origem = !eu && m.origem ? `<span class="iaa-origem">${esc(rotuloOrigem(m.origem, m.modelo))}</span>` : "";
      const anex = eu && m.anexos?.length
        ? `<div class="iaa-msg-anexos">${m.anexos.map((n) => `📎 ${esc(n)}`).join("<br>")}</div>` : "";
      const bolha = `<div class="iaa-msg ${eu ? "eu" : "ia"}">${eu ? `<p>${esc(m.texto)}</p>` : md(m.texto)}${anex}${origem}</div>`;
      return bolha + cardAcao(m, i);
    }).join("") + (mostrarDots ? `<div class="iaa-dots">IA pensando<span>.</span><span>.</span><span>.</span></div>` : "");
    corpo.scrollTop = corpo.scrollHeight;
    corpo.querySelectorAll(".iaa-card-ok").forEach((b) =>
      b.addEventListener("click", () => confirmarAcao(Number(b.dataset.idx))));
    corpo.querySelectorAll(".iaa-card-cancel").forEach((b) =>
      b.addEventListener("click", () => cancelarAcao(Number(b.dataset.idx))));
  }

  // Card de confirmacao de uma acao proposta pela IA.
  function cardAcao(m, i) {
    if (!m.acao) return "";
    const def = ACOES[m.acao.ferramenta];
    if (!def) return "";
    const args = m.acao.args || {};
    if (m.acaoStatus === "ok") {
      return `<div class="iaa-card feito"><div class="iaa-card-tit">✅ ${esc(def.rotulo)}</div><div class="iaa-card-msg">${esc(m.acaoMsg || "Feito.")}</div></div>`;
    }
    if (m.acaoStatus === "erro") {
      return `<div class="iaa-card erro"><div class="iaa-card-tit">⚠️ ${esc(def.rotulo)}</div><div class="iaa-card-msg">${esc(m.acaoMsg || "Falhou.")}</div></div>`;
    }
    if (m.acaoStatus === "cancel") {
      return `<div class="iaa-card"><div class="iaa-card-tit">🚫 ${esc(def.rotulo)} — cancelado</div></div>`;
    }
    const faltando = def.valido && !def.valido(args);
    const corpo = faltando
      ? `<div class="iaa-card-msg">Faltam dados obrigatórios. Diga os campos que faltam no chat.</div>`
      : `<div class="iaa-card-resumo">${def.resumo(args)}</div>
         <div class="iaa-card-acoes">
           <button type="button" class="iaa-card-ok" data-idx="${i}">Confirmar</button>
           <button type="button" class="iaa-card-cancel" data-idx="${i}">Cancelar</button>
         </div>`;
    return `<div class="iaa-card"><div class="iaa-card-tit">🛠 ${esc(def.rotulo)}</div>${corpo}</div>`;
  }

  async function confirmarAcao(i) {
    const m = mensagens[i];
    if (!m || !m.acao || m.acaoStatus) return;
    const def = ACOES[m.acao.ferramenta];
    m.acaoStatus = "processando";
    renderChat();
    try {
      const msg = await def.run(m.acao.args || {});
      m.acaoStatus = "ok";
      m.acaoMsg = typeof msg === "string" ? msg : "Feito.";
    } catch (err) {
      m.acaoStatus = "erro";
      m.acaoMsg = err.message || "Falha ao executar.";
    }
    renderChat();
  }

  function cancelarAcao(i) {
    const m = mensagens[i];
    if (!m || !m.acao || m.acaoStatus) return;
    m.acaoStatus = "cancel";
    renderChat();
  }

  async function carregarHistorico() {
    const corpo = $("iaAsstCorpo");
    if (corpo) corpo.innerHTML = `<div class="iaa-vazio">Carregando...</div>`;
    try {
      const lista = await api("/ia/chat/historico");
      mensagens = (lista || []).map((m) => ({ papel: m.papel, texto: m.texto }));
      renderChat();
    } catch {
      mensagens = [];
      renderChat();
    }
  }

  async function limparConversa() {
    if (!mensagens.length) return;
    if (!(await confirmarBonito("Apagar todo o histórico desta conversa com a IA?", { okLabel: "Apagar", cancelLabel: "Cancelar" }))) return;
    try {
      await api("/ia/chat/limpar", { method: "POST" });
    } catch { /* segue limpando local mesmo assim */ }
    mensagens = [];
    renderChat();
  }

  async function enviar() {
    if (enviando) return;
    const input = $("iaAsstInput");
    const texto = input.value.trim();
    const { payload: anexosPayload, nomes: anexosNomes } = anexosParaEnvio();
    if (!texto && !anexosPayload.length) return;
    if (anexos.some((a) => a.tipo === "processando")) { alertar("Aguarde os arquivos terminarem de carregar."); return; }

    // Atalho: "/ensinar <fato>" grava direto na base de conhecimento (sem anexos).
    const mEnsina = texto.match(/^\/ensinar\s+([\s\S]+)/i);
    if (mEnsina && !anexosPayload.length) {
      input.value = ""; input.style.height = "auto";
      await ensinarRapido(mEnsina[1].trim());
      return;
    }

    input.value = ""; input.style.height = "auto";
    enviando = true;
    $("iaAsstEnviar").disabled = true;
    mensagens.push({ papel: "user", texto: texto || "(arquivos anexados)", anexos: anexosNomes });
    anexos = []; renderAnexos();
    renderChat(true);
    try {
      const hoje = typeof hojeISO === "function" ? hojeISO() : new Date().toISOString().slice(0, 10);
      const periodo = $("iaAsstPeriodo")?.value || ""; // "" = auto (servidor detecta pelo texto)
      const body = await api("/ia/chat", {
        method: "POST",
        body: JSON.stringify({ pergunta: texto, tela: telaAtual(), hoje, periodo, anexos: anexosPayload }),
      });
      const acao = extrairAcao(body.resposta);
      mensagens.push({ papel: "assistant", texto: body.resposta, origem: body.origem, modelo: body.modelo, acao });
    } catch (err) {
      mensagens.push({ papel: "assistant", texto: `⚠️ ${err.message}`, origem: "local" });
    } finally {
      enviando = false;
      $("iaAsstEnviar").disabled = false;
      renderChat();
      $("iaAsstInput")?.focus();
    }
  }

  async function ensinarRapido(conteudo) {
    mensagens.push({ papel: "user", texto: `/ensinar ${conteudo}` });
    renderChat(true);
    try {
      await api("/ia/conhecimento", { method: "POST", body: JSON.stringify({ conteudo }) });
      conhecimentoCache = [];
      mensagens.push({ papel: "assistant", texto: "✅ Aprendido! Vou lembrar disso nas próximas respostas. Veja/edite na aba **📚 Conhecimento**." });
    } catch (err) {
      mensagens.push({ papel: "assistant", texto: `⚠️ Não consegui salvar: ${err.message}` });
    }
    renderChat();
  }

  // ------------- CONHECIMENTO -------------
  function renderConhecimento() {
    const corpo = $("iaAsstCorpo");
    if (!corpo) return;
    const form = `
      <div class="iaa-conh-form">
        <input type="text" id="iaConhTitulo" placeholder="Título (opcional)" maxlength="120" />
        <textarea id="iaConhConteudo" rows="3" placeholder="O que a IA deve aprender? Ex: A rota BAIXADA III sempre atrasa às sextas por causa de feira." maxlength="4000"></textarea>
        <input type="text" id="iaConhTags" placeholder="Tags (opcional, ex: rotas, atrasos)" maxlength="120" />
        <div class="iaa-conh-acoes">
          <button type="button" id="iaConhSalvar">Ensinar</button>
        </div>
      </div>
      <div id="iaConhLista"></div>`;
    corpo.innerHTML = form;
    $("iaConhSalvar").addEventListener("click", salvarConhecimento);
    renderListaConhecimento();
  }

  function renderListaConhecimento() {
    const lista = $("iaConhLista");
    if (!lista) return;
    if (!conhecimentoCache.length) {
      lista.innerHTML = `<div class="iaa-vazio" style="padding:16px;">Nada ensinado ainda. Adicione fatos e regras que a IA deve considerar sempre.</div>`;
      return;
    }
    lista.innerHTML = conhecimentoCache.map((k) => `
      <div class="iaa-conh-item" data-id="${k.id}">
        <div class="iaa-conh-txt">
          <strong>${esc(k.titulo)}</strong>
          <small>${esc(k.conteudo)}</small>
          ${k.tags ? `<span class="iaa-tag">${esc(k.tags)}</span>` : ""}
        </div>
        <button type="button" class="iaa-conh-del" title="Apagar">🗑</button>
      </div>`).join("");
    lista.querySelectorAll(".iaa-conh-del").forEach((b) =>
      b.addEventListener("click", (e) => apagarConhecimento(Number(e.target.closest(".iaa-conh-item").dataset.id))));
  }

  async function carregarConhecimento() {
    try {
      conhecimentoCache = await api("/ia/conhecimento");
    } catch {
      conhecimentoCache = [];
    }
    if (view === "conhecimento") renderListaConhecimento();
  }

  async function salvarConhecimento() {
    const conteudo = $("iaConhConteudo")?.value.trim();
    if (!conteudo) { $("iaConhConteudo")?.focus(); return; }
    const titulo = $("iaConhTitulo")?.value.trim() || "";
    const tags = $("iaConhTags")?.value.trim() || "";
    const btn = $("iaConhSalvar");
    if (btn) { btn.disabled = true; btn.textContent = "Salvando..."; }
    try {
      await api("/ia/conhecimento", { method: "POST", body: JSON.stringify({ titulo, conteudo, tags }) });
      await carregarConhecimento();
      renderConhecimento();
    } catch (err) {
      alertar(err.message);
      if (btn) { btn.disabled = false; btn.textContent = "Ensinar"; }
    }
  }

  async function apagarConhecimento(id) {
    if (!Number.isInteger(id)) return;
    if (!(await confirmarBonito("Apagar este conhecimento?", { okLabel: "Apagar", cancelLabel: "Cancelar" }))) return;
    try {
      await api(`/ia/conhecimento/${id}`, { method: "DELETE" });
      conhecimentoCache = conhecimentoCache.filter((k) => k.id !== id);
      renderListaConhecimento();
    } catch (err) {
      alertar(err.message);
    }
  }

  async function start() {
    usuario = await window.authReady;
    if (!usuario) return; // sem login: nao monta
    injetarEstilos();
    construir();
    carregarConhecimento();
    // Hook global para outros modulos abrirem o assistente (ex.: command palette).
    window.abrirAssistenteIa = () => { if (!aberto) alternar(); $("iaAsstInput")?.focus(); };
  }

  if (window.authReady && typeof window.authReady.then === "function") {
    start();
  } else {
    document.addEventListener("DOMContentLoaded", start);
  }
})();
