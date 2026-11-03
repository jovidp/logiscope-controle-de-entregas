// ================================================================
// COMMAND PALETTE (Ctrl+K / Cmd+K)
// Busca global para pular direto para qualquer aba ou disparar uma acao
// rapida, sem cacar no menu. Le as nav-tabs em runtime (cobre todas as abas
// automaticamente) e reusa irParaAba() + as funcoes de abrir formulario.
// ================================================================
(function iniciarCommandPalette() {
  let aberto = false;
  let comandos = [];
  let filtrados = [];
  let selecionado = 0;

  function norm(s) {
    return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  }

  function esc(v) {
    return escapar(v);
  }

  // Monta a lista de comandos a partir do DOM + funcoes globais disponiveis.
  function coletarComandos() {
    const cmds = [];
    const vistos = new Set();
    document.querySelectorAll(".nav-tab").forEach((el) => {
      const aba = el.dataset.aba;
      if (!aba || vistos.has(aba)) return;
      vistos.add(aba);
      const label = (el.textContent || aba).replace(/\s+/g, " ").trim();
      cmds.push({ label, grupo: "Ir para", run: () => irNavegar(aba) });
    });
    const acao = (label, fn) => cmds.push({ label, grupo: "Ação", run: fn });
    if (typeof irParaAba === "function") {
      if (typeof abrirFormAtrasoSaida === "function") {
        acao("➕ Registrar atraso de saída", () => { irParaAba("veiculos"); setTimeout(abrirFormAtrasoSaida, 80); });
      }
      if (typeof abrirFormRota === "function") {
        acao("➕ Registrar tempo de rota", () => { irParaAba("veiculos"); setTimeout(abrirFormRota, 80); });
      }
    }
    if (typeof window.abrirFilaResolver === "function") {
      acao("🎯 Resolver agora (pendências)", () => window.abrirFilaResolver());
    }
    if (typeof window.relatorioMaterialAbrir === "function") {
      acao("📦 Relatório de material (envio e retirada)", () => window.relatorioMaterialAbrir());
    }
    if (typeof window.relatorioSemanalAbrir === "function") {
      acao("📊 Relatório semanal (baixar / gerar)", () => window.relatorioSemanalAbrir());
    }
    // Temas (theme.js): abrir o seletor ou pular direto para um tema pelo nome.
    if (typeof window.temaAbrirSeletor === "function") {
      acao("🎨 Trocar tema (cores do sistema)", () => window.temaAbrirSeletor());
      (window.TEMAS_LISTA || []).forEach((t) => {
        acao(`🎨 Tema: ${t.nome}`, () => window.temaAplicar(t.id));
      });
    }
    return cmds;
  }

  function irNavegar(aba) {
    if (typeof irParaAba === "function") irParaAba(aba);
  }

  // Filtra por todos os termos da busca (todos precisam aparecer no rotulo).
  function filtrar(termo) {
    const q = norm(termo).trim();
    if (!q) return comandos.slice(0, 40);
    const termos = q.split(/\s+/);
    return comandos
      .map((c) => {
        const alvo = norm(`${c.label} ${c.grupo}`);
        if (!termos.every((t) => alvo.includes(t))) return null;
        return { c, pos: alvo.indexOf(termos[0]) };
      })
      .filter(Boolean)
      .sort((a, b) => a.pos - b.pos)
      .map((x) => x.c)
      .slice(0, 40);
  }

  function injetarEstilos() {
    if (document.getElementById("cmdkEstilos")) return;
    const css = `
      #cmdkOverlay{position:fixed;inset:0;background:rgba(2,6,23,.55);z-index:10000;display:none;
        align-items:flex-start;justify-content:center;padding-top:12vh;backdrop-filter:blur(2px);}
      #cmdkOverlay.aberto{display:flex;}
      #cmdkBox{width:560px;max-width:calc(100vw - 32px);background:var(--bg-elevated,#0f172a);
        border:1px solid var(--border,#1e293b);border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.6);overflow:hidden;
        font-family:inherit;}
      #cmdkInput{width:100%;box-sizing:border-box;background:transparent;border:none;outline:none;
        padding:16px 18px;font-size:16px;color:var(--text-heading,#f8fafc);border-bottom:1px solid var(--border,#1e293b);}
      #cmdkInput::placeholder{color:var(--text-muted,#94a3b8);}
      #cmdkLista{max-height:52vh;overflow-y:auto;padding:6px;}
      .cmdk-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:9px;cursor:pointer;color:var(--text-heading,#e2e8f0);}
      .cmdk-item .cmdk-grp{margin-left:auto;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted,#94a3b8);}
      .cmdk-item.sel{background:linear-gradient(135deg,rgba(56,189,248,.18),rgba(37,99,235,.14));}
      .cmdk-item:hover{background:rgba(255,255,255,.05);}
      .cmdk-vazio{padding:18px;text-align:center;color:var(--text-muted,#94a3b8);font-size:13px;}
      .cmdk-rodape{display:flex;gap:14px;padding:8px 14px;border-top:1px solid var(--border,#1e293b);
        font-size:10px;color:var(--text-muted,#94a3b8);}
      .cmdk-rodape b{color:var(--text-heading,#cbd5e1);font-weight:700;}
    `;
    const style = document.createElement("style");
    style.id = "cmdkEstilos";
    style.textContent = css;
    document.head.appendChild(style);
  }

  function construir() {
    if (document.getElementById("cmdkOverlay")) return;
    injetarEstilos();
    const ov = document.createElement("div");
    ov.id = "cmdkOverlay";
    ov.innerHTML = `
      <div id="cmdkBox" role="dialog" aria-label="Busca de comandos">
        <input id="cmdkInput" type="text" placeholder="Ir para... ou uma ação (ex: docas, atraso, assistente)" autocomplete="off" />
        <div id="cmdkLista"></div>
        <div class="cmdk-rodape"><span><b>↑↓</b> navegar</span><span><b>Enter</b> abrir</span><span><b>Esc</b> fechar</span></div>
      </div>`;
    document.body.appendChild(ov);
    ov.addEventListener("click", (e) => { if (e.target === ov) fechar(); });
    document.getElementById("cmdkInput").addEventListener("input", (e) => {
      filtrados = filtrar(e.target.value);
      selecionado = 0;
      render();
    });
    document.getElementById("cmdkInput").addEventListener("keydown", aoTeclar);
  }

  function render() {
    const lista = document.getElementById("cmdkLista");
    if (!lista) return;
    if (!filtrados.length) {
      lista.innerHTML = `<div class="cmdk-vazio">Nada encontrado.</div>`;
      return;
    }
    lista.innerHTML = filtrados.map((c, i) => `
      <div class="cmdk-item ${i === selecionado ? "sel" : ""}" data-i="${i}">
        <span>${esc(c.label)}</span><span class="cmdk-grp">${esc(c.grupo)}</span>
      </div>`).join("");
    lista.querySelectorAll(".cmdk-item").forEach((el) => {
      el.addEventListener("click", () => executar(Number(el.dataset.i)));
      el.addEventListener("mousemove", () => {
        const i = Number(el.dataset.i);
        if (i !== selecionado) { selecionado = i; marcarSelecao(); }
      });
    });
    marcarSelecao();
  }

  function marcarSelecao() {
    const itens = document.querySelectorAll("#cmdkLista .cmdk-item");
    itens.forEach((el, i) => el.classList.toggle("sel", i === selecionado));
    itens[selecionado]?.scrollIntoView({ block: "nearest" });
  }

  function aoTeclar(e) {
    if (e.key === "ArrowDown") { e.preventDefault(); selecionado = Math.min(selecionado + 1, filtrados.length - 1); marcarSelecao(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); selecionado = Math.max(selecionado - 1, 0); marcarSelecao(); }
    else if (e.key === "Enter") { e.preventDefault(); executar(selecionado); }
    else if (e.key === "Escape") { e.preventDefault(); fechar(); }
  }

  function executar(i) {
    const cmd = filtrados[i];
    if (!cmd) return;
    fechar();
    try { cmd.run(); } catch (err) { console.error("[cmdk]", err); }
  }

  function abrir() {
    if (!window.authUsuario) return; // so com login
    construir();
    comandos = coletarComandos();
    filtrados = filtrar("");
    selecionado = 0;
    aberto = true;
    document.getElementById("cmdkOverlay").classList.add("aberto");
    const inp = document.getElementById("cmdkInput");
    inp.value = "";
    render();
    setTimeout(() => inp.focus(), 20);
  }

  function fechar() {
    aberto = false;
    document.getElementById("cmdkOverlay")?.classList.remove("aberto");
  }

  // Ctrl+K / Cmd+K abre/fecha em qualquer tela.
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      aberto ? fechar() : abrir();
    }
  });

  window.abrirCommandPalette = abrir;
})();
