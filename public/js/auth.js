// ================================================================
// Autenticacao global e controle visual de permissoes
// ================================================================
(function iniciarAutenticacao() {
  document.documentElement.classList.add("auth-pendente");
  const AUTH_API = window.location.origin;
  // A sessao agora vive 100% no banco (tabela sistema_sessoes) e e identificada
  // por um cookie HttpOnly enviado pelo servidor. Nada de token em storage do
  // navegador. F5 e navegacao na mesma aba mantem o login (cookie continua);
  // fechar o navegador apaga o cookie de sessao -> logoff automatico.
  const TOKEN_KEY = "controleEntregaToken";
  // Limpeza: remove tokens antigos que ficaram salvos em versoes anteriores.
  try { window.localStorage.removeItem(TOKEN_KEY); } catch (_) {}
  try { window.sessionStorage.removeItem(TOKEN_KEY); } catch (_) {}
  const fetchOriginal = window.fetch.bind(window);
  let resolverAuth;

  window.authUsuario = null;
  window.authReady = new Promise((resolve) => {
    resolverAuth = resolve;
  });
  window.authTemPermissao = function (permissao) {
    if (!window.authUsuario) return false;
    if (window.authUsuario.perfil === "ADM") return true;
    return [
      "visualizar_dados",
      "registrar_ocorrencia",
      "registrar_escala",
      "registrar_checklist",
      "monitorar_operacao",
    ].includes(permissao);
  };

  window.fetch = function fetchComCookie(input, options = {}) {
  let destino;
  try {
    const url = typeof input === "string" ? input : input?.url || "";
    destino = new URL(url || window.location.href, window.location.origin);
  } catch (_) {
    return fetchOriginal(input, options);
  }

  if (destino.origin !== AUTH_API) {
    return fetchOriginal(input, options);
  }

  // Garante que o cookie de sessao acompanhe a requisicao para a propria origem.
  return fetchOriginal(input, {
    credentials: "same-origin",
    ...options,
  }).then((resposta) => {
    const authPath = destino.pathname.startsWith("/auth/");
    if (resposta.status === 401 && !authPath) {
      window.authUsuario = null;
      if (!document.getElementById("authTela") || document.getElementById("authTela").classList.contains("hidden")) {
        location.reload();
      }
    }
    return resposta;
  });
};

  async function requisicao(path, options = {}) {
    const resposta = await window.fetch(`${AUTH_API}${path}`, {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    const body = await resposta.json().catch(() => ({}));
    if (!resposta.ok) throw new Error(body.error || "Erro na autenticacao.");
    return body;
  }

  function escaparAuth(valor) {
    return String(valor || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  const SENHA_MIN = 8;
  const SENHAS_COMUNS = new Set([
    "123456", "1234567", "12345678", "123456789", "1234567890",
    "password", "passw0rd", "qwerty", "qwerty123", "abc123",
    "111111", "000000", "123123", "123321", "654321", "121212",
    "senha", "senha123", "senha@123", "mudar123", "admin", "admin123",
    "root", "master", "login", "usuario", "iloveyou", "letmein",
    "controle", "entrega", "controle123", "12345",
  ]);

  function semAcentosAuth(texto) {
    return String(texto || "").normalize("NFD").replace(/\p{M}/gu, "");
  }

  function temSequenciaAuth(valor) {
    if (valor.length < 4) return false;
    let asc = 1;
    let desc = 1;
    let rep = 1;
    for (let i = 1; i < valor.length; i += 1) {
      const diff = valor.charCodeAt(i) - valor.charCodeAt(i - 1);
      asc = diff === 1 ? asc + 1 : 1;
      desc = diff === -1 ? desc + 1 : 1;
      rep = diff === 0 ? rep + 1 : 1;
      if (asc >= 4 || desc >= 4 || rep >= 4) return true;
    }
    return false;
  }

  function avaliarSenhaAuth(senha, ...contexto) {
    const feedback = [];
    if (!senha) return { aceitavel: false, feedback: ["Informe uma senha."] };

    const len = senha.length;
    const lower = senha.toLowerCase();
    const norm = semAcentosAuth(lower);
    const temMin = /[a-z]/.test(senha);
    const temMai = /[A-Z]/.test(senha);
    const temNum = /[0-9]/.test(senha);
    const temSimb = /[^A-Za-z0-9\s]/.test(senha);
    const classes = (temMin ? 1 : 0) + (temMai ? 1 : 0) + (temNum ? 1 : 0) + (temSimb ? 1 : 0);

    const comum = SENHAS_COMUNS.has(lower) || SENHAS_COMUNS.has(norm);
    const sequencia = temSequenciaAuth(norm);
    const usaContexto = contexto.some((p) => {
      const w = semAcentosAuth(String(p || "").toLowerCase()).trim();
      return w.length >= 3 && norm.includes(w);
    });

    let score = 0;
    if (len >= SENHA_MIN) score += 1;
    if (len >= 12) score += 1;
    if (classes >= 3) score += 1;
    if (classes >= 4 || len >= 16) score += 1;

    if (len < SENHA_MIN) feedback.push(`Use ao menos ${SENHA_MIN} caracteres.`);
    if (!temMai || !temMin) feedback.push("Misture letras maiusculas e minusculas.");
    if (!temNum) feedback.push("Inclua ao menos um numero.");
    if (!temSimb) feedback.push("Inclua ao menos um simbolo (ex.: ! @ # $).");
    if (sequencia) { feedback.push("Evite sequencias ou caracteres repetidos."); score -= 1; }
    if (usaContexto) { feedback.push("Nao use seu nome ou usuario na senha."); score = Math.min(score, 1); }
    if (comum) { feedback.push("Essa senha e muito comum e facil de adivinhar."); score = 0; }

    score = Math.max(0, Math.min(4, score));
    return { aceitavel: !comum && !usaContexto && len >= SENHA_MIN && score >= 2, feedback };
  }

  function validarSenhaAuth(senha, ...contexto) {
    const forca = avaliarSenhaAuth(senha, ...contexto);
    if (!forca.aceitavel) {
      throw new Error(`Senha fraca. ${forca.feedback.join(" ")}`);
    }
  }

  function criarEstrutura() {
    if (document.getElementById("authTela")) return;
    document.body.insertAdjacentHTML(
      "afterbegin",
      `<div id="authTela" class="auth-screen">
        <div class="auth-card">
          <div class="auth-brand">CONTROLE DE ENTREGA</div>
          <h1 id="authTitulo">Entrar no sistema</h1>
          <p id="authDescricao">Informe seu usuario e senha para continuar.</p>
          <form id="authLoginForm" class="auth-form">
            <input id="authLoginUsuario" autocomplete="username" placeholder="Usuario" data-no-upper required />
            <input id="authLoginSenha" type="password" autocomplete="current-password" placeholder="Senha" required />
            <button type="submit" class="btn-blue">Entrar</button>
          </form>
          <form id="authBootstrapForm" class="auth-form hidden">
            <input id="authPrimeiroNome" placeholder="Nome do administrador" required />
            <input id="authPrimeiroUsuario" placeholder="Usuario" data-no-upper required />
            <input id="authPrimeiroSenha" type="password" placeholder="Senha forte (minimo 8 caracteres)" minlength="8" required />
            <button type="submit" class="btn-green">Criar administrador inicial</button>
          </form>
          <form id="authRegistroForm" class="auth-form hidden">
            <input id="authRegNome" autocomplete="name" placeholder="Seu nome" required />
            <input id="authRegUsuario" autocomplete="username" placeholder="Usuario (seu login)" data-no-upper required />
            <input id="authRegSenha" type="password" autocomplete="new-password" placeholder="Senha forte (minimo 8 caracteres)" minlength="8" required />
            <input id="authRegCodigo" placeholder="Codigo de cadastro" data-no-upper required />
            <button type="submit" class="btn-green">Criar minha conta</button>
          </form>
          <div class="auth-alt">
            <button type="button" id="authLinkRegistro" class="auth-link hidden" onclick="authMostrarRegistro()">Não tem conta? Criar conta</button>
            <button type="button" id="authLinkLogin" class="auth-link hidden" onclick="authMostrarLoginForm()">Já tenho conta — Entrar</button>
          </div>
          <p id="authErro" class="auth-error"></p>
        </div>
      </div>
      <div id="authUsuariosModal" class="auth-users hidden">
        <div class="auth-users-card">
          <div class="auth-users-head">
            <h2>Usuarios e permissoes</h2>
            <button type="button" class="btn-ghost btn-sm" onclick="authFecharUsuarios()">Fechar</button>
          </div>
          <form id="authNovoUsuarioForm" class="auth-user-form">
            <input id="authNovoNome" placeholder="Nome" required />
            <input id="authNovoLogin" placeholder="Usuario" data-no-upper required />
            <input id="authNovaSenha" type="password" placeholder="Senha forte" minlength="8" required />
            <select id="authNovoPerfil"><option value="OPERADOR">OPERADOR</option><option value="ADM">ADM</option></select>
            <button type="submit" class="btn-blue">Cadastrar</button>
          </form>
          <div class="auth-codigo-box">
            <label>🔑 Códigos de auto-cadastro <small>— na aba "Criar conta", quem digitar o código ADM vira ADM; quem digitar o código Operador vira OPERADOR. Sem código válido, não cadastra.</small></label>
            <div class="auth-codigo-linha">
              <input id="authCadastroCodigoAdm" placeholder="Código ADM (vazio = ninguém se cadastra como ADM)" data-no-upper />
              <button type="button" class="btn-ghost btn-sm" onclick="authGerarCodigo('authCadastroCodigoAdm')" title="Gerar código forte aleatório">🎲</button>
            </div>
            <div class="auth-codigo-linha" style="margin-top:8px;">
              <input id="authCadastroCodigoOp" placeholder="Código Operador (vazio = desativado)" data-no-upper />
              <button type="button" class="btn-ghost btn-sm" onclick="authGerarCodigo('authCadastroCodigoOp')" title="Gerar código forte aleatório">🎲</button>
              <button type="button" class="btn-blue btn-sm" onclick="authSalvarCodigo()">Salvar códigos</button>
            </div>
            <small id="authCadastroCodigoHint" class="auth-codigo-hint"></small>
          </div>
          <div id="authUsuariosLista"></div>
        </div>
      </div>`,
    );

    document.getElementById("authLoginForm").addEventListener("submit", fazerLogin);
    document.getElementById("authBootstrapForm").addEventListener("submit", criarPrimeiroAdm);
    document.getElementById("authRegistroForm").addEventListener("submit", cadastrarConta);
    document.getElementById("authNovoUsuarioForm").addEventListener("submit", cadastrarUsuario);
    window.temaInstalarBotoes?.();
  }

  // O link "Criar conta" fica SEMPRE visivel na tela de login (o usuario pediu
  // que o cadastro fique aqui). So some quando nao estamos no form de login
  // (ex.: bootstrap do 1o admin, ou ja dentro do proprio form de registro).
  // Se o auto-cadastro estiver desativado, o servidor avisa no submit.
  function atualizarLinkRegistro() {
    const link = document.getElementById("authLinkRegistro");
    const loginVisivel = !document.getElementById("authLoginForm")?.classList.contains("hidden");
    if (link) link.classList.toggle("hidden", !loginVisivel);
  }

  // Alterna login <-> cadastro na mesma tela (sem recarregar).
  function authMostrarRegistro() {
    erro("");
    document.getElementById("authLoginForm").classList.add("hidden");
    document.getElementById("authRegistroForm").classList.remove("hidden");
    document.getElementById("authLinkRegistro").classList.add("hidden");
    document.getElementById("authLinkLogin").classList.remove("hidden");
    document.getElementById("authTitulo").textContent = "Criar conta";
    document.getElementById("authDescricao").textContent = "Preencha seus dados e o código de cadastro para entrar.";
  }
  function authMostrarLoginForm() {
    erro("");
    document.getElementById("authRegistroForm").classList.add("hidden");
    document.getElementById("authLoginForm").classList.remove("hidden");
    document.getElementById("authLinkLogin").classList.add("hidden");
    document.getElementById("authLinkRegistro").classList.remove("hidden");
    document.getElementById("authTitulo").textContent = "Entrar no sistema";
    document.getElementById("authDescricao").textContent = "Informe seu usuario e senha para continuar.";
  }
  window.authMostrarRegistro = authMostrarRegistro;
  window.authMostrarLoginForm = authMostrarLoginForm;

  async function cadastrarConta(event) {
    event.preventDefault();
    erro("");
    const nome = document.getElementById("authRegNome").value;
    const usuario = document.getElementById("authRegUsuario").value;
    const senha = document.getElementById("authRegSenha").value;
    const codigo = document.getElementById("authRegCodigo").value;
    try {
      validarSenhaAuth(senha, usuario, nome);
      const retorno = await requisicao("/auth/registrar", {
        method: "POST",
        body: JSON.stringify({ nome, usuario, senha, codigo }),
      });
      // Auto-login: o servidor ja criou a sessao/cookie. Entra direto.
      window.authUsuario = retorno.usuario;
      aplicarPerfil();
      location.reload();
    } catch (err) {
      erro(err.message);
    }
  }

  function erro(mensagem) {
    const el = document.getElementById("authErro");
    if (el) el.textContent = mensagem || "";
  }

  function mostrarLogin(primeiroCadastro) {
    criarEstrutura();
    document.body.classList.add("auth-bloqueado");
    document.getElementById("authTela").classList.remove("hidden");
    document.getElementById("authLoginForm").classList.toggle("hidden", primeiroCadastro);
    document.getElementById("authBootstrapForm").classList.toggle("hidden", !primeiroCadastro);
    document.getElementById("authTitulo").textContent = primeiroCadastro
      ? "Criar administrador inicial"
      : "Entrar no sistema";
    document.getElementById("authDescricao").textContent = primeiroCadastro
      ? "Este primeiro usuario tera acesso total ao sistema."
      : "Informe seu usuario e senha para continuar.";
  }

  function aplicarPerfil() {
    const usuario = window.authUsuario;
    if (!usuario) return;
    const isMaster = usuario.super_adm === true;
    // "Ve tudo": o master e o preset ADM. Os demais (OPERADOR/CUSTOM) sao restritos.
    const verTudo = isMaster || usuario.perfil === "ADM";
    document.body.classList.remove("auth-bloqueado");
    document.documentElement.classList.remove("auth-pendente");
    document.body.classList.toggle("perfil-operador", usuario.perfil === "OPERADOR");
    // Marcador generico p/ CSS de restricao (esconde botoes .admin-only-action etc.).
    document.body.classList.toggle("perfil-restrito", !verTudo);
    document.getElementById("authTela")?.classList.add("hidden");

    const header = document.querySelector(".app-header-actions");
    if (header && !document.getElementById("authUsuarioLogado")) {
      header.insertAdjacentHTML(
        "beforeend",
        `<span id="authUsuarioLogado" class="auth-user-pill"></span>
         <button id="authGerenciarBtn" type="button" class="btn-ghost btn-sm" onclick="authAbrirUsuarios()">Usuarios</button>
         <button type="button" class="btn-ghost btn-sm" onclick="authSair()">Sair</button>`,
      );
    }
    const pill = document.getElementById("authUsuarioLogado");
    if (pill) {
      // Cabe pouco no cabecalho: o nome inteiro era cortado no meio e sobrava
      // "Rafael Mendes |", com o separador solto na ponta. Mostra o
      // primeiro nome (mais o inicial do sobrenome, quando houver) e deixa o
      // nome completo no title.
      const perfil = isMaster ? "MASTER" : usuario.perfil;
      const partes = String(usuario.nome || "").trim().split(/\s+/).filter(Boolean);
      const curto = partes.length > 1
        ? `${partes[0]} ${partes[partes.length - 1][0]}.`
        : (partes[0] || usuario.usuario || "");
      pill.textContent = `${curto} | ${perfil}`;
      pill.title = `${usuario.nome} — ${perfil}`;
    }
    // Gestao de usuarios/acessos: SO o master (o "adm universal").
    document.getElementById("authGerenciarBtn")?.classList.toggle("hidden", !isMaster);

    // helper: mostra/esconde uma aba de verdade (vence o display:none inline).
    const mostrarAba = (tab, mostra) => {
      tab.classList.toggle("hidden", !mostra);
      tab.style.display = mostra ? "" : "none";
    };

    if (verTudo) {
      // Master/ADM: todas as abas de modulo aparecem. As abas de GESTAO
      // (data-adm-only: Auditoria/Usuarios) so aparecem para o master.
      document.querySelectorAll(".nav-tab").forEach((tab) => {
        const admOnly = tab.hasAttribute("data-adm-only");
        mostrarAba(tab, admOnly ? isMaster : true);
      });
      setTimeout(() => {
        if (typeof irParaAba !== "function") return;
        irParaAba("tms");
        if (typeof tmsAtualizar === "function") tmsAtualizar();
      }, 0);
    } else if (usuario.perfil === "OPERADOR") {
      // Perfil OPERADOR: lista legada, comportamento inalterado.
      const abasOperador = [
        "tms", "ssw", "frota", "dashboard", "monitoramento", "entregas", "docas", "veiculos",
        "atrasos", "tendencias", "ocorrencias-avulsas", "ocorrencias-entrega",
        "docs-motoristas", "escalas",
      ];
      document.querySelectorAll(".nav-tab").forEach((tab) => {
        mostrarAba(tab, abasOperador.includes(tab.dataset.aba));
      });
      document.querySelector(".app-header-actions a")?.classList.add("hidden");
      if (location.pathname.toLowerCase().endsWith("torre.html")) {
        location.replace("/index.html");
        return;
      }
      setTimeout(() => typeof irParaAba === "function" && irParaAba("dashboard"), 0);
    } else {
      // Perfil CUSTOM: so as abas liberadas pelos modulos concedidos (vem do
      // servidor em abasPermitidas). Abre a primeira, disparando o init da aba.
      const permitidas = new Set(usuario.abasPermitidas || []);
      // Acesso ao portal SSW acompanha a permissao do TMS.
      if (permitidas.has("tms") || permitidas.has("ctes")) permitidas.add("ssw");
      document.querySelectorAll(".nav-tab").forEach((tab) => {
        const aba = tab.dataset.aba;
        mostrarAba(tab, !!aba && permitidas.has(aba));
      });
      document.querySelector(".app-header-actions a")?.classList.add("hidden");
      if (location.pathname.toLowerCase().endsWith("torre.html")) {
        location.replace("/index.html");
        return;
      }
      const primeira = (usuario.abasPermitidas || [])[0];
      setTimeout(() => {
        const btn = primeira && document.querySelector(`.nav-tab[data-aba="${primeira}"]`);
        if (btn) btn.click(); // dispara irParaAba + init especifico da aba
      }, 0);
    }

    // A secao WMS foi movida da aba para dentro do formulario de ocorrencia.
    // Segue a mesma permissao que a antiga aba 'wms' tinha: master ve tudo;
    // OPERADOR nunca teve; CUSTOM so se 'wms' estava nas abas concedidas.
    const _temWms = verTudo
      || (usuario.perfil !== "OPERADOR" && new Set(usuario.abasPermitidas || []).has("wms"));
    const _secWms = document.getElementById("secaoWmsForm");
    if (_secWms) {
      _secWms.classList.toggle("hidden", !_temWms);
      _secWms.style.display = _temWms ? "" : "none";
    }
  }

  async function fazerLogin(event) {
    event.preventDefault();
    erro("");
    try {
      const retorno = await requisicao("/auth/login", {
        method: "POST",
        body: JSON.stringify({
          usuario: document.getElementById("authLoginUsuario").value,
          senha: document.getElementById("authLoginSenha").value,
        }),
      });
      // O cookie de sessao ja foi definido pelo servidor; nada a guardar no navegador.
      window.authUsuario = retorno.usuario;
      aplicarPerfil();
      location.reload();
    } catch (err) {
      erro(err.message);
    }
  }

  async function criarPrimeiroAdm(event) {
    event.preventDefault();
    erro("");
    try {
      validarSenhaAuth(
        document.getElementById("authPrimeiroSenha").value,
        document.getElementById("authPrimeiroUsuario").value,
        document.getElementById("authPrimeiroNome").value,
      );
      await requisicao("/auth/bootstrap", {
        method: "POST",
        body: JSON.stringify({
          nome: document.getElementById("authPrimeiroNome").value,
          usuario: document.getElementById("authPrimeiroUsuario").value,
          senha: document.getElementById("authPrimeiroSenha").value,
        }),
      });
      mostrarLogin(false);
      erro("Administrador criado. Faca login para entrar.");
    } catch (err) {
      erro(err.message);
    }
  }

  async function carregarUsuarios() {
    const usuarios = await requisicao("/auth/usuarios");
    const lista = document.getElementById("authUsuariosLista");
    lista.innerHTML = usuarios
      .map(
        (usuario) => `<div class="auth-user-row">
          <div><strong>${escaparAuth(usuario.nome)}</strong><small>${escaparAuth(usuario.usuario)} | ${usuario.super_adm ? "MASTER" : usuario.perfil}</small></div>
          <select onchange="authAlterarUsuario(${usuario.id}, { perfil: this.value })" ${usuario.super_adm ? "disabled title='Conta master — gerencie pela aba Usuários'" : ""}>
            <option value="CUSTOM" ${usuario.perfil === "CUSTOM" ? "selected" : ""}>Personalizado</option>
            <option value="OPERADOR" ${usuario.perfil === "OPERADOR" ? "selected" : ""}>OPERADOR</option>
            <option value="ADM" ${usuario.perfil === "ADM" ? "selected" : ""}>ADM</option>
          </select>
          <button type="button" class="btn-ghost btn-sm" onclick="authAlterarUsuario(${usuario.id}, { ativo: ${usuario.ativo ? "false" : "true"} })">
            ${usuario.ativo ? "Desativar" : "Ativar"}
          </button>
          <button type="button" class="btn-red btn-sm" onclick="authExcluirUsuario(${usuario.id})">
            Excluir
          </button>
        </div>`,
      )
      .join("");
  }

  async function cadastrarUsuario(event) {
    event.preventDefault();
    try {
      validarSenhaAuth(
        document.getElementById("authNovaSenha").value,
        document.getElementById("authNovoLogin").value,
        document.getElementById("authNovoNome").value,
      );
      await requisicao("/auth/usuarios", {
        method: "POST",
        body: JSON.stringify({
          nome: document.getElementById("authNovoNome").value,
          usuario: document.getElementById("authNovoLogin").value,
          senha: document.getElementById("authNovaSenha").value,
          perfil: document.getElementById("authNovoPerfil").value,
        }),
      });
      event.target.reset();
      await carregarUsuarios();
    } catch (err) {
      alertar(err.message);
    }
  }

  async function carregarCodigoCadastro() {
    const inAdm = document.getElementById("authCadastroCodigoAdm");
    const inOp = document.getElementById("authCadastroCodigoOp");
    const hint = document.getElementById("authCadastroCodigoHint");
    if (!inAdm || !inOp) return;
    try {
      const r = await requisicao("/auth/cadastro-codigo");
      inAdm.value = r.adm || "";
      inOp.value = r.operador || "";
      if (hint) hint.textContent = (r.adm || r.operador)
        ? 'Auto-cadastro ATIVO. Compartilhe cada código só com quem deve ter aquele nível de acesso.'
        : 'Auto-cadastro DESATIVADO. Defina ao menos um código para liberar a aba "Criar conta".';
    } catch (_) { /* ignora */ }
  }
  // Gera um codigo forte aleatorio (16 chars, 4 classes garantidas -> score alto)
  // com crypto do navegador. Um clique resolve o vetor de "codigo memoravel fraco".
  window.authGerarCodigo = function (id) {
    const el = document.getElementById(id);
    if (!el) return;
    const U = "ABCDEFGHJKLMNPQRSTUVWXYZ", L = "abcdefghijkmnpqrstuvwxyz", D = "23456789", S = "!@#$%&*";
    const rnd = (n) => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
    const from = (set) => set[rnd(set.length)];
    const chars = [];
    for (let i = 0; i < 2; i++) chars.push(from(U));
    for (let i = 0; i < 8; i++) chars.push(from(L));
    for (let i = 0; i < 4; i++) chars.push(from(D));
    for (let i = 0; i < 2; i++) chars.push(from(S));
    for (let i = chars.length - 1; i > 0; i--) { const j = rnd(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
    el.value = chars.join("");
    const hint = document.getElementById("authCadastroCodigoHint");
    if (hint) hint.textContent = "Código forte gerado. Copie e guarde num lugar seguro — depois clique em Salvar códigos.";
  };

  window.authSalvarCodigo = async function () {
    const inAdm = document.getElementById("authCadastroCodigoAdm");
    const inOp = document.getElementById("authCadastroCodigoOp");
    const hint = document.getElementById("authCadastroCodigoHint");
    try {
      const r = await requisicao("/auth/cadastro-codigo", {
        method: "PUT",
        body: JSON.stringify({ adm: inAdm.value.trim(), operador: inOp.value.trim() }),
      });
      if (hint) hint.textContent = r.habilitado
        ? `✓ Salvo. Código ADM: ${r.adm_definido ? "ativo" : "—"} · Código Operador: ${r.operador_definido ? "ativo" : "—"}.`
        : '✓ Códigos removidos. Auto-cadastro DESATIVADO.';
    } catch (err) {
      alertar(err.message);
    }
  };

  window.authAbrirUsuarios = async function () {
    // Modal legado: lista rapida + gestao dos codigos de auto-cadastro. O editor
    // de permissoes por modulo fica na aba "Usuarios" da sidebar (mais completo).
    document.getElementById("authUsuariosModal").classList.remove("hidden");
    await carregarUsuarios();
    await carregarCodigoCadastro();
  };
  window.authFecharUsuarios = function () {
    document.getElementById("authUsuariosModal").classList.add("hidden");
  };
  window.authAlterarUsuario = async function (id, alteracao) {
    try {
      await requisicao(`/auth/usuarios/${id}`, {
        method: "PUT",
        body: JSON.stringify(alteracao),
      });
      await carregarUsuarios();
    } catch (err) {
      alertar(err.message);
    }
  };
  window.authExcluirUsuario = async function (id) {
    if (!(await confirmarBonito("Deseja excluir definitivamente este usuario?", { okLabel: "Excluir", cancelLabel: "Cancelar" }))) return;
    try {
      await requisicao(`/auth/usuarios/${id}`, { method: "DELETE" });
      await carregarUsuarios();
    } catch (err) {
      alertar(err.message);
    }
  };
  window.authSair = async function () {
    try {
      // O servidor apaga a sessao do banco e limpa o cookie HttpOnly.
      await requisicao("/auth/logout", { method: "POST" });
    } catch (_) {}
    location.reload();
  };

  document.addEventListener("DOMContentLoaded", async () => {
    criarEstrutura();
    try {
      const status = await requisicao("/auth/status");
      // Tenta validar a sessao pelo cookie HttpOnly (validado no banco).
      try {
        window.authUsuario = await requisicao("/auth/me");
        aplicarPerfil();
        resolverAuth(window.authUsuario);
        return;
      } catch (_) {
        // Sem sessao valida -> mostra login.
      }
      mostrarLogin(!status.possuiUsuarios);
      if (status.possuiUsuarios) atualizarLinkRegistro();
    } catch (err) {
      mostrarLogin(false);
      erro("Servidor indisponivel para login.");
    }
    resolverAuth(null);
  });
})();
