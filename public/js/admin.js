// ================================================================
// ADMIN — Status do servidor, Auditoria, Gestão de usuários, Auto-refresh
// ================================================================

function _esc(str) {
    return escapar(str);
}

// ── Status do servidor ───────────────────────────────────────────
function iniciarStatusServidor() {
    const badge = document.getElementById('serverStatusBadge');
    if (!badge) return;

    async function verificar() {
        try {
            const r = await fetch('/health', { signal: AbortSignal.timeout(5000) });
            const ok = r.ok;
            const cor = ok ? '#34d399' : '#f59e0b';
            const sombra = ok ? 'rgba(52,211,153,.55)' : 'rgba(245,158,11,.55)';
            const label = ok ? 'Online' : 'Instável';
            badge.innerHTML = `<span style="width:7px;height:7px;border-radius:50%;background:${cor};display:inline-block;margin-right:5px;box-shadow:0 0 5px ${sombra};flex-shrink:0;"></span>${label}`;
            badge.style.color = cor;
        } catch {
            badge.innerHTML = `<span style="width:7px;height:7px;border-radius:50%;background:#f87171;display:inline-block;margin-right:5px;flex-shrink:0;"></span>Offline`;
            badge.style.color = '#f87171';
        }
    }

    verificar();
    setInterval(verificar, 30000);
}

// ── Reiniciar servidor (ADM) ─────────────────────────────────────
// Pede o reinício ao backend (/admin/reiniciar), que encerra o processo; um
// relançador/watchdog sobe um node novo. Em seguida esperamos o /health voltar
// e recarregamos a página automaticamente.
function reiniciarServidor() {
    const msg = 'Reiniciar o servidor agora?\n\nO sistema ficará indisponível por alguns segundos e esta página será recarregada.';
    const acao = async () => {
        const btn = document.getElementById('btnReiniciarServidor');
        if (btn) { btn.disabled = true; btn.textContent = '⟳ Reiniciando...'; }
        try {
            const r = await fetch('/admin/reiniciar', { method: 'POST' });
            if (!r.ok) {
                const data = await r.json().catch(() => ({}));
                if (btn) { btn.disabled = false; btn.textContent = '⟳ Reiniciar servidor'; }
                alertar('Erro: ' + (data.error || 'não foi possível reiniciar.'));
                return;
            }
        } catch {
            // Sem resposta = o servidor já está encerrando; segue para a espera.
        }
        _aguardarServidorVoltar();
    };
    // Usa o modal estilizado do sistema (fallback pro confirm nativo).
    if (typeof confirmarSimples === 'function') confirmarSimples(msg, acao);
    else if (confirm(msg)) acao();
}

// Faz polling no /health até responder de novo e recarrega a página. Desiste
// após ~60s pedindo F5 manual (evita loop infinito se algo travar de vez).
function _aguardarServidorVoltar() {
    const btn = document.getElementById('btnReiniciarServidor');
    let tentativas = 0;
    const MAX = 40; // 40 x 1,5s = 60s
    const timer = setInterval(async () => {
        tentativas += 1;
        try {
            const r = await fetch('/health', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
            if (r.ok) {
                clearInterval(timer);
                if (btn) btn.textContent = '✓ Reiniciado';
                location.reload();
                return;
            }
        } catch { /* ainda caído/subindo */ }
        if (tentativas >= MAX) {
            clearInterval(timer);
            if (btn) { btn.disabled = false; btn.textContent = '⟳ Reiniciar servidor'; }
            alertar('O servidor está demorando a responder. Aguarde mais um pouco e recarregue a página (F5).');
        }
    }, 1500);
}

// ── Auto-refresh ─────────────────────────────────────────────────
let _autoRefreshInterval = null;

function _atualizarLabeUltimaAtt() {
    const el = document.getElementById('ultimaAtualizacaoLabel');
    if (el) {
        el.textContent = '🔄 Atualizado ' + new Date().toLocaleTimeString('pt-BR');
    }
}

// Ciclo único de atualização automática (a cada 1 minuto).
// Quando o usuário pode ver dados, delega para carregarHistorico (que busca
// /ocorrencias, recarrega o cache local, re-renderiza tudo e marca o label).
// Caso contrário, faz só o refresh do cache local + re-render.
function iniciarAutoRefresh() {
    if (_autoRefreshInterval) return;
    _atualizarLabeUltimaAtt();
    _autoRefreshInterval = setInterval(async () => {
        if (document.hidden) return;
        try {
            const podeDados =
                typeof authTemPermissao === 'function' &&
                authTemPermissao('visualizar_dados');
            if (podeDados && typeof carregarHistorico === 'function') {
                await carregarHistorico(true);
            } else {
                if (typeof carregarDadosServidorLocal === 'function') {
                    await carregarDadosServidorLocal(true);
                }
                if (typeof atualizarTodasAsViews === 'function') atualizarTodasAsViews();
                _atualizarLabeUltimaAtt();
            }
            if (typeof tmsAtualizar === 'function') tmsAtualizar();
        } catch { /* silencioso */ }
    }, 60000);
}

// Atualização em tempo real das seções de Controle de Veículos
// (Checklist diário, Tacógrafo e Diário de Bordo). Mais frequente que o
// ciclo geral (60s) porque recarrega apenas os caches pequenos desses
// módulos e re-renderiza respeitando os filtros de data de cada seção,
// sem disparar o re-render pesado do dashboard.
let _realtimeVeiculosInterval = null;
function iniciarRealtimeVeiculos() {
    if (_realtimeVeiculosInterval) return;
    _realtimeVeiculosInterval = setInterval(async () => {
        if (document.hidden) return;
        try {
            if (typeof carregarCachesVeiculos === 'function') {
                await carregarCachesVeiculos();
            } else if (typeof carregarDadosServidorLocal === 'function') {
                await carregarDadosServidorLocal(true);
            }
            if (typeof renderizarListaChecklistDiario === 'function') renderizarListaChecklistDiario();
            if (typeof renderTacografos === 'function') renderTacografos();
            if (typeof renderDiarios === 'function') renderDiarios();
            _atualizarLabeUltimaAtt();
        } catch { /* silencioso */ }
    }, 10000);
}

// ── Inicialização após autenticação ──────────────────────────────
window.authReady?.then(() => {
    const u = window.authUsuario || {};
    const isMaster = u.super_adm === true;
    // Elementos de GESTAO (data-adm-only): Auditoria, Usuarios, gerar codigo,
    // reiniciar. So o master (adm universal) ve. As abas de MODULO ja NAO usam
    // mais este atributo — quem as mostra e' o aplicarPerfil por permissao.
    document.querySelectorAll('[data-adm-only]').forEach((el) => {
        el.style.display = isMaster ? '' : 'none';
    });
    iniciarStatusServidor();
    // Auto-refresh e realtime batem em varios endpoints (ocorrencias, veiculos,
    // paineis). Um CUSTOM sem esses modulos so tomaria 403 — nao liga pra ele.
    const verTudo = isMaster || u.perfil === 'ADM' || u.perfil === 'OPERADOR';
    if (verTudo) {
        iniciarAutoRefresh();
        iniciarRealtimeVeiculos();
    }
});

// ── Auditoria ────────────────────────────────────────────────────
const AUDIT_LIMITE = 50;
let _auditPagina = 1;
let _auditFiltroAcao = '';

async function auditoriaCarregar(pagina = 1) {
    _auditPagina = pagina;
    const container = document.getElementById('auditoriaTabela');
    if (!container) return;
    container.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:24px;">Carregando...</p>';

    try {
        let url = `/auditoria?limite=${AUDIT_LIMITE}&pagina=${pagina}`;
        const r = await fetch(url);
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Erro desconhecido');

        const { dados, total } = data;
        const totalPags = Math.ceil(total / AUDIT_LIMITE);

        if (!dados || !dados.length) {
            container.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:24px;">Nenhum registro encontrado.</p>';
            return;
        }

        const acaoBadge = (acao) => {
            const mapa = {
                LOGIN:      ['#34d399', 'rgba(52,211,153,.15)'],
                LOGOUT:     ['#94a3b8', 'rgba(148,163,184,.12)'],
                POST:       ['#38bdf8', 'rgba(56,189,248,.12)'],
                PUT:        ['#f59e0b', 'rgba(245,158,11,.12)'],
                PUT_STATUS: ['#f59e0b', 'rgba(245,158,11,.12)'],
                DELETE:     ['#f87171', 'rgba(248,113,113,.15)'],
            };
            const [cor, bg] = mapa[acao] || ['#94a3b8', 'rgba(148,163,184,.12)'];
            return `<span style="font-size:10px;font-weight:800;padding:2px 7px;border-radius:5px;background:${bg};color:${cor};border:1px solid ${cor}44;">${_esc(acao)}</span>`;
        };

        const linhas = dados.map((reg) => `
            <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
                <td style="padding:9px 12px;color:var(--text-muted);white-space:nowrap;">
                    ${new Date(reg.criado_em).toLocaleString('pt-BR')}
                </td>
                <td style="padding:9px 12px;color:var(--text-primary);font-weight:600;">
                    ${_esc(reg.usuario_nome || '—')}
                </td>
                <td style="padding:9px 12px;">${acaoBadge(reg.acao)}</td>
                <td style="padding:9px 12px;color:var(--text-secondary);">${_esc(reg.recurso)}</td>
                <td style="padding:9px 12px;color:var(--text-muted);">${_esc(reg.recurso_id || '—')}</td>
                <td style="padding:9px 12px;color:var(--text-muted);font-size:11px;">${_esc(reg.ip || '—')}</td>
            </tr>
        `).join('');

        container.innerHTML = `
            <div style="overflow-x:auto;">
                <table data-ordenavel style="width:100%;border-collapse:collapse;font-size:12px;min-width:600px;">
                    <thead>
                        <tr style="color:var(--text-muted);font-weight:700;text-transform:uppercase;font-size:10px;letter-spacing:.8px;">
                            <th style="padding:8px 12px;text-align:left;border-bottom:1px solid var(--border);">Data / Hora</th>
                            <th style="padding:8px 12px;text-align:left;border-bottom:1px solid var(--border);">Usuário</th>
                            <th style="padding:8px 12px;text-align:left;border-bottom:1px solid var(--border);">Ação</th>
                            <th style="padding:8px 12px;text-align:left;border-bottom:1px solid var(--border);">Recurso</th>
                            <th style="padding:8px 12px;text-align:left;border-bottom:1px solid var(--border);">ID</th>
                            <th style="padding:8px 12px;text-align:left;border-bottom:1px solid var(--border);">IP</th>
                        </tr>
                    </thead>
                    <tbody>${linhas}</tbody>
                </table>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 4px 0;flex-wrap:wrap;gap:8px;">
                <span style="color:var(--text-muted);font-size:12px;">${total} registro(s) · pág. ${pagina} / ${totalPags}</span>
                <div style="display:flex;gap:6px;">
                    ${pagina > 1 ? `<button onclick="auditoriaCarregar(${pagina - 1})" class="btn-ghost btn-sm">← Anterior</button>` : ''}
                    ${pagina < totalPags ? `<button onclick="auditoriaCarregar(${pagina + 1})" class="btn-ghost btn-sm">Próxima →</button>` : ''}
                </div>
            </div>
        `;
    } catch (err) {
        container.innerHTML = `<p style="color:var(--vermelho);text-align:center;padding:24px;">Erro ao carregar: ${_esc(err.message)}</p>`;
    }
}

// ── Gestão de usuários ───────────────────────────────────────────
const USUARIOS_SENHA_MIN = 8;
const USUARIOS_SENHAS_COMUNS = new Set([
    '123456', '1234567', '12345678', '123456789', '1234567890',
    'password', 'passw0rd', 'qwerty', 'qwerty123', 'abc123',
    '111111', '000000', '123123', '123321', '654321', '121212',
    'senha', 'senha123', 'senha@123', 'mudar123', 'admin', 'admin123',
    'root', 'master', 'login', 'usuario', 'iloveyou', 'letmein',
    'controle', 'entrega', 'controle123', '12345'
]);

function usuariosSemAcentos(texto) {
    return String(texto || '').normalize('NFD').replace(/\p{M}/gu, '');
}

function usuariosTemSequencia(valor) {
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

function usuariosAvaliarSenha(senha, ...contexto) {
    const feedback = [];
    if (!senha) return { aceitavel: false, feedback: ['Informe uma senha.'] };

    const len = senha.length;
    const lower = senha.toLowerCase();
    const norm = usuariosSemAcentos(lower);
    const temMin = /[a-z]/.test(senha);
    const temMai = /[A-Z]/.test(senha);
    const temNum = /[0-9]/.test(senha);
    const temSimb = /[^A-Za-z0-9\s]/.test(senha);
    const classes = (temMin ? 1 : 0) + (temMai ? 1 : 0) + (temNum ? 1 : 0) + (temSimb ? 1 : 0);
    const comum = USUARIOS_SENHAS_COMUNS.has(lower) || USUARIOS_SENHAS_COMUNS.has(norm);
    const sequencia = usuariosTemSequencia(norm);
    const usaContexto = contexto.some((p) => {
        const w = usuariosSemAcentos(String(p || '').toLowerCase()).trim();
        return w.length >= 3 && norm.includes(w);
    });

    let score = 0;
    if (len >= USUARIOS_SENHA_MIN) score += 1;
    if (len >= 12) score += 1;
    if (classes >= 3) score += 1;
    if (classes >= 4 || len >= 16) score += 1;

    if (len < USUARIOS_SENHA_MIN) feedback.push(`Use ao menos ${USUARIOS_SENHA_MIN} caracteres.`);
    if (!temMai || !temMin) feedback.push('Misture letras maiusculas e minusculas.');
    if (!temNum) feedback.push('Inclua ao menos um numero.');
    if (!temSimb) feedback.push('Inclua ao menos um simbolo (ex.: ! @ # $).');
    if (sequencia) { feedback.push('Evite sequencias ou caracteres repetidos.'); score -= 1; }
    if (usaContexto) { feedback.push('Nao use seu nome ou usuario na senha.'); score = Math.min(score, 1); }
    if (comum) { feedback.push('Essa senha e muito comum e facil de adivinhar.'); score = 0; }

    score = Math.max(0, Math.min(4, score));
    return { aceitavel: !comum && !usaContexto && len >= USUARIOS_SENHA_MIN && score >= 2, feedback };
}

// ---- Editor de permissões por módulo (só o master usa esta aba) ----
let _modulosCatalogo = null;
async function usuariosCarregarCatalogo() {
    if (_modulosCatalogo) return _modulosCatalogo;
    try {
        const r = await fetch('/auth/modulos');
        const d = await r.json();
        if (r.ok && Array.isArray(d.modulos)) _modulosCatalogo = d.modulos;
    } catch (_) { /* ignora */ }
    return _modulosCatalogo || [];
}

// Renderiza os checkboxes de módulo, marcando os já concedidos ao usuário.
async function usuariosRenderModulos(marcados) {
    const cont = document.getElementById('usuariosModalModulos');
    if (!cont) return;
    const cat = await usuariosCarregarCatalogo();
    const setM = new Set(marcados || []);
    if (!cat.length) {
        cont.innerHTML = '<span style="font-size:12px;color:var(--text-muted);">Não foi possível carregar os módulos.</span>';
        return;
    }
    const grupos = {};
    cat.forEach((m) => { (grupos[m.grupo || 'Outros'] = grupos[m.grupo || 'Outros'] || []).push(m); });
    cont.innerHTML = Object.entries(grupos).map(([g, mods]) => `
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:var(--text-muted);margin:6px 0 2px;">${_esc(g)}</div>
        ${mods.map((m) => `
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-heading);cursor:pointer;">
            <input type="checkbox" value="${_esc(m.chave)}" ${setM.has(m.chave) ? 'checked' : ''} style="width:15px;height:15px;accent-color:#38bdf8;flex:none;" />
            ${_esc(m.rotulo)}
          </label>`).join('')}
    `).join('');
    usuariosPerfilMudou();
}

// Mostra/atenua o bloco de módulos conforme o perfil (só CUSTOM usa a seleção).
function usuariosPerfilMudou() {
    const perfil = document.getElementById('usuariosModalPerfil')?.value;
    const bloco = document.getElementById('usuariosModalModulosBloco');
    const dica = document.getElementById('usuariosModalModulosDica');
    if (!bloco) return;
    const isCustom = perfil === 'CUSTOM';
    bloco.style.opacity = isCustom ? '1' : '.5';
    document.querySelectorAll('#usuariosModalModulos input[type=checkbox]').forEach((c) => { c.disabled = !isCustom; });
    if (dica) {
        dica.textContent = isCustom
            ? 'Marque só os módulos que este usuário pode ver e usar.'
            : (perfil === 'ADM'
                ? 'Perfil ADM enxerga tudo — a seleção abaixo é ignorada.'
                : 'Perfil OPERADOR usa o pacote padrão de operação — a seleção abaixo é ignorada.');
    }
}

async function usuariosCarregar() {
    const container = document.getElementById('usuariosLista');
    if (!container) return;
    container.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:24px;">Carregando...</p>';

    try {
        const r = await fetch('/auth/usuarios');
        const lista = await r.json();
        if (!r.ok) throw new Error(lista.error || 'Erro desconhecido');

        if (!lista.length) {
            container.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:24px;">Nenhum usuário cadastrado.</p>';
            return;
        }

        const linhas = lista.map((u) => {
            const isMaster = u.super_adm === true;
            const rotuloPerfil = isMaster ? 'MASTER' : u.perfil;
            const cores = {
                MASTER: ['#a78bfa', 'rgba(167,139,250,.16)', 'rgba(167,139,250,.34)'],
                ADM: ['#f97316', 'rgba(249,115,22,.18)', 'rgba(249,115,22,.3)'],
                OPERADOR: ['#38bdf8', 'rgba(56,189,248,.12)', 'rgba(56,189,248,.25)'],
                CUSTOM: ['#34d399', 'rgba(52,211,153,.12)', 'rgba(52,211,153,.28)'],
            };
            const perfilCor = cores[rotuloPerfil] || cores.CUSTOM;
            const qtdMod = Array.isArray(u.permissoes) ? u.permissoes.length : 0;
            const resumoMod = isMaster || u.perfil === 'ADM'
                ? 'todos os módulos'
                : (u.perfil === 'OPERADOR' ? 'pacote operação'
                    : (qtdMod ? `${qtdMod} módulo${qtdMod > 1 ? 's' : ''}` : 'nenhum módulo'));
            const dadosEsc = _esc(JSON.stringify(u)).replace(/"/g, '&quot;');
            return `
                <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
                    <td style="padding:11px 14px;font-weight:700;color:var(--text-heading);">${_esc(u.nome)}</td>
                    <td style="padding:11px 14px;color:var(--text-secondary);">@${_esc(u.usuario)}</td>
                    <td style="padding:11px 14px;">
                        <span style="font-size:10px;font-weight:800;padding:2px 8px;border-radius:6px;background:${perfilCor[1]};color:${perfilCor[0]};border:1px solid ${perfilCor[2]};">${_esc(rotuloPerfil)}</span>
                        <div style="font-size:10px;color:var(--text-muted);margin-top:3px;">${_esc(resumoMod)}</div>
                    </td>
                    <td style="padding:11px 14px;">
                        <span style="font-size:11px;font-weight:700;color:${u.ativo ? '#34d399' : '#64748b'};">${u.ativo ? '● Ativo' : '○ Inativo'}</span>
                    </td>
                    <td style="padding:11px 14px;text-align:right;">
                        <div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;">
                            <button onclick="usuariosAbrirModal(${dadosEsc})" class="btn-ghost btn-sm">Editar</button>
                            <button onclick="usuariosToggleAtivo(${u.id}, ${u.ativo})" class="btn-ghost btn-sm" style="color:${u.ativo ? '#f87171' : '#34d399'};">
                                ${u.ativo ? 'Desativar' : 'Ativar'}
                            </button>
                            <button onclick="usuariosExcluir(${u.id})" class="btn-red btn-sm">Excluir</button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');

        container.innerHTML = `
            <div style="overflow-x:auto;">
                <table data-ordenavel style="width:100%;border-collapse:collapse;font-size:13px;min-width:520px;">
                    <thead>
                        <tr style="color:var(--text-muted);font-weight:700;text-transform:uppercase;font-size:10px;letter-spacing:.8px;">
                            <th style="padding:10px 14px;text-align:left;border-bottom:1px solid var(--border);">Nome</th>
                            <th style="padding:10px 14px;text-align:left;border-bottom:1px solid var(--border);">Usuário</th>
                            <th style="padding:10px 14px;text-align:left;border-bottom:1px solid var(--border);">Perfil</th>
                            <th style="padding:10px 14px;text-align:left;border-bottom:1px solid var(--border);">Status</th>
                            <th style="padding:10px 14px;text-align:right;border-bottom:1px solid var(--border);">Ações</th>
                        </tr>
                    </thead>
                    <tbody>${linhas}</tbody>
                </table>
            </div>
        `;
    } catch (err) {
        container.innerHTML = `<p style="color:var(--vermelho);text-align:center;padding:24px;">Erro: ${_esc(err.message)}</p>`;
    }
}

function usuariosAbrirModal(usuario) {
    const u = typeof usuario === 'string' ? JSON.parse(usuario) : usuario;
    const modal = document.getElementById('usuariosModal');
    if (!modal) return;

    document.getElementById('usuariosModalTitulo').textContent = u?.id ? 'Editar Usuário' : 'Novo Usuário';
    document.getElementById('usuariosModalId').value = u?.id || '';
    document.getElementById('usuariosModalNome').value = u?.nome || '';
    document.getElementById('usuariosModalUsuario').value = u?.usuario || '';
    document.getElementById('usuariosModalUsuario').disabled = !!u?.id;
    document.getElementById('usuariosModalPerfil').value = u?.perfil || 'CUSTOM';
    document.getElementById('usuariosModalSenha').value = '';
    document.getElementById('usuariosModalSenhaLabel').textContent =
        u?.id ? 'Nova senha forte (deixe vazio para manter)' : 'Senha forte (minimo 8 caracteres)';
    // Monta os checkboxes de módulo marcando os já concedidos (perfil CUSTOM).
    usuariosRenderModulos(Array.isArray(u?.permissoes) ? u.permissoes : []);

    const btnExcluir = document.getElementById('usuariosModalExcluirBtn');
    if (btnExcluir) {
        btnExcluir.style.display = u?.id ? '' : 'none';
        btnExcluir.onclick = () => usuariosExcluir(u.id);
    }

    modal.style.display = 'flex';
}

function usuariosFecharModal() {
    const modal = document.getElementById('usuariosModal');
    if (modal) modal.style.display = 'none';
}

async function usuariosSalvar() {
    const id = document.getElementById('usuariosModalId').value;
    const nome = document.getElementById('usuariosModalNome').value.trim();
    const usuario = document.getElementById('usuariosModalUsuario').value.trim();
    const perfil = document.getElementById('usuariosModalPerfil').value;
    const senha = document.getElementById('usuariosModalSenha').value;
    const btnSalvar = document.getElementById('usuariosModalSalvarBtn');

    if (!nome) { alertar('Informe o nome.'); return; }
    if (!id && !usuario) { alertar('Informe o nome de usuário.'); return; }
    if (!id || senha) {
        const forca = usuariosAvaliarSenha(senha, usuario, nome);
        if (!forca.aceitavel) {
            alertar(`Senha fraca. ${forca.feedback.join(' ')}`);
            return;
        }
    }

    // Módulos marcados só fazem sentido no perfil CUSTOM; nos outros manda [] pra
    // não guardar seleção fantasma.
    const permissoes = perfil === 'CUSTOM'
        ? Array.from(document.querySelectorAll('#usuariosModalModulos input[type=checkbox]:checked')).map((c) => c.value)
        : [];
    const body = { nome, perfil, permissoes };
    if (!id) { body.usuario = usuario; body.senha = senha; }
    else if (senha) { body.senha = senha; }

    if (btnSalvar) { btnSalvar.disabled = true; btnSalvar.textContent = 'Salvando...'; }

    try {
        const r = id
            ? await fetch(`/auth/usuarios/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            : await fetch('/auth/usuarios',        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

        const data = await r.json();
        if (!r.ok) {
            const motivos = Array.isArray(data.motivos) && data.motivos.length
                ? ` ${data.motivos.join(' ')}`
                : '';
            throw new Error((data.error || 'Erro ao salvar usuario.') + motivos);
        }

        usuariosFecharModal();
        usuariosCarregar();
    } catch (err) {
        alertar(`Erro: ${err.message}`);
    } finally {
        if (btnSalvar) { btnSalvar.disabled = false; btnSalvar.textContent = 'Salvar'; }
    }
}

async function usuariosToggleAtivo(id, ativoAtual) {
    const acao = ativoAtual ? 'desativar' : 'ativar';
    if (!(await confirmarBonito(`Deseja ${acao} este usuário?`, { okLabel: acao === 'desativar' ? 'Desativar' : 'Ativar', cancelLabel: 'Cancelar' }))) return;

    try {
        const r = await fetch(`/auth/usuarios/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ativo: !ativoAtual })
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Erro ao atualizar usuário.');
        usuariosCarregar();
    } catch (err) {
        alertar(`Erro: ${err.message}`);
    }
}

async function usuariosExcluir(id) {
    if (!id) return;
    if (!(await confirmarBonito('Deseja excluir definitivamente este usuario?', { okLabel: 'Excluir', cancelLabel: 'Cancelar' }))) return;

    try {
        const r = await fetch(`/auth/usuarios/${id}`, { method: 'DELETE' });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Erro ao excluir usuario.');
        usuariosFecharModal();
        usuariosCarregar();
    } catch (err) {
        alertar(`Erro: ${err.message}`);
    }
}
