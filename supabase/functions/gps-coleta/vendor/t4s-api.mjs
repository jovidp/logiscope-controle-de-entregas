// Gerado por tools/preparar-gps-vendor.cjs.
'use strict';

// API oficial documentada em API T4S.pdf (autenticacao, LastPositions, Routes, Alerts).
// Credenciais e token ficam exclusivamente no servidor. Nao envia comandos ao veiculo.
import { coordenadaValida } from './gps-precisao.mjs';
import { Buffer } from 'node:buffer';

function campo(obj, nome) {
  if (!obj || typeof obj !== 'object') return undefined;
  const chave = Object.keys(obj).find(k => k.toLowerCase() === nome.toLowerCase());
  return chave === undefined ? undefined : obj[chave];
}

function erro(mensagem, status = 502) {
  const e = new Error(mensagem);
  e.statusCliente = status;
  return e;
}

function placaMercosul(valor) {
  const p = String(valor || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z]{3}\d{4}$/.test(p) ? p.slice(0, 4) + 'ABCDEFGHIJ'[Number(p[4])] + p.slice(5) : p;
}

function mapearPosicao(p) {
  const numero = nome => {
    const v = campo(p, nome);
    return v === null || v === undefined || String(v).trim() === '' ? NaN : Number(v);
  };
  const placa = placaMercosul(campo(p, 'plate'));
  const id = numero('deviceId'), lat = numero('latitude'), lng = numero('longitude');
  const velocidade = numero('speed');
  // positionDate e a hora do GPS; systemDate e a recepcao pelo servidor T4S.
  const quando = campo(p, 'positionDate');
  // Evita interpretar datas sem fuso no horario da maquina.
  const posicao_em = typeof quando === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(quando)
    ? new Date(quando) : new Date(NaN);
  if (!/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(placa) || !Number.isSafeInteger(id) || id < 1
    || !coordenadaValida({lat, lng}) || !Number.isFinite(+posicao_em)
    || !Number.isFinite(velocidade) || velocidade < 0 || velocidade > 220) return null;
  const ignicao = String(campo(p, 'ignition') ?? '').toLowerCase();
  const motor = ['online', 'on', 'true', '1'].includes(ignicao) ? 'ligado'
    : ['offline', 'off', 'false', '0'].includes(ignicao) ? 'desligado' : null;
  return { device_id: id, nome: placa, placa, lat, lng, velocidade, rumo: 0,
    posicao_em, motor, online: '', parado_seg: 0, fonte: 't4s',
    endereco: typeof campo(p, 'address') === 'string' ? campo(p, 'address') : '' };
}

function criar({ env = {}, fetcher = (...args) => fetch(...args), agora = () => Date.now() } = {}) {
  let autenticacao = null, pendente = null;
  const estado = { autenticado_em: null, ultima_consulta: null, erro: null };
  const credenciais = () => ({
    key: String(env.T4S_CLIENT_KEY || '').trim(), secret: String(env.T4S_CLIENT_SECRET || '').trim(),
  });
  const configurado = () => !!(credenciais().key && credenciais().secret);
  const info = () => ({ configurado: configurado(),
    credenciais_incompletas: !!credenciais().key !== !!credenciais().secret,
    ...estado });

  function urlBase(nome, padrao) {
    let u;
    try { u = new URL(env[nome] || padrao); } catch (_) { throw erro(`T4S: ${nome} invalida.`, 503); }
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || !['', '/'].includes(u.pathname)) {
      throw erro(`T4S: ${nome} deve ser uma origem HTTPS sem caminho ou credenciais.`, 503);
    }
    return u.origin;
  }

  async function json(url, opcoes, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetcher(url, { ...opcoes, redirect: 'manual', signal: ctrl.signal });
      if (!r.ok) {
        const e = erro([401, 403].includes(r.status)
          ? 'T4S: acesso recusado. Confira as credenciais e a liberacao da API.'
          : `T4S: servico respondeu HTTP ${r.status}.`);
        e.httpStatus = r.status;
        throw e;
      }
      let data;
      try { data = await r.json(); }
      catch (e) { if (ctrl.signal.aborted) throw e; throw erro('T4S: resposta nao e JSON valido.'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw erro('T4S: formato de resposta inesperado.');
      if (campo(data, 'success') === false || campo(data, 'authenticated') === false) {
        throw erro('T4S: a API informou falha na solicitacao.');
      }
      return data;
    } catch (e) {
      if (ctrl.signal.aborted) throw erro(`T4S: sem resposta em ${timeoutMs} ms.`);
      if (e.statusCliente) throw e;
      // Erros de rede e corpo da API podem incluir segredos; nao os propaga.
      throw erro('T4S: nao foi possivel conectar ao servico.');
    } finally { clearTimeout(timer); }
  }

  function duracaoPedido() {
    const n = Number(env.T4S_API_TIMEOUT_MS || 15000);
    return Number.isFinite(n) && n >= 1 && n <= 60000 ? n : 15000;
  }

  async function obterToken() {
    const c = credenciais();
    if (!configurado()) throw erro('Configure T4S_CLIENT_KEY e T4S_CLIENT_SECRET fornecidos pela T4S.', 503);
    if (autenticacao && autenticacao.key === c.key && autenticacao.secret === c.secret && agora() < autenticacao.expira) {
      return autenticacao.token;
    }
    if (!pendente) {
      pendente = (async () => {
        const data = await json(urlBase('T4S_AUTH_URL', 'https://authentication-rastreamento.t4stecnologia.com.br') + '/api/Authentication', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ ClientKey: c.key, ClientSecret: c.secret }),
        }, duracaoPedido());
        const token = campo(data, 'token');
        if (typeof token !== 'string' || !token.trim() || /\s/.test(token)) throw erro('T4S: autenticacao respondeu sem token valido.');
        let expira = agora() + 5 * 60000;
        try {
          const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
          if (Number.isFinite(Number(payload.exp)) && Number(payload.exp) > 0) expira = Number(payload.exp) * 1000;
        } catch (_) { /* token opaco: cache curto; 401 renova uma vez */ }
        if (expira <= agora()) throw erro('T4S: autenticacao respondeu com token expirado.');
        autenticacao = { ...c, token, expira: expira - Math.min(60000, (expira - agora()) / 10) };
        estado.autenticado_em = new Date(agora()).toISOString();
        return token;
      })().finally(() => { pendente = null; });
    }
    return pendente;
  }

  async function consultar(caminho, parametros = {}, timeoutMs = duracaoPedido()) {
    try {
      const url = new URL(caminho, urlBase('T4S_API_URL', 'https://externalapi-rastreamento.t4stecnologia.com.br'));
      for (const [nome, valor] of Object.entries(parametros)) {
        for (const v of Array.isArray(valor) ? valor : [valor]) if (v !== undefined && v !== null && v !== '') url.searchParams.append(nome, String(v));
      }
      for (let tentativa = 0; tentativa < 2; tentativa++) {
        const token = await obterToken();
        try {
          const data = await json(url, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }, timeoutMs);
          estado.ultima_consulta = new Date(agora()).toISOString(); estado.erro = null;
          return data;
        } catch (e) {
          if (e.httpStatus !== 401 || tentativa) throw e;
          if (autenticacao?.token === token) autenticacao = null;
        }
      }
    } catch (e) { estado.erro = e.message; throw e; }
  }

  function pagina(data, chave, solicitada) {
    const itens = campo(data, chave), total = Number(campo(data, 'totalRecords'));
    const numero = Number(campo(data, 'page'));
    if (!Array.isArray(itens) || !Number.isSafeInteger(total) || total < 0
      || !Number.isSafeInteger(numero) || numero !== solicitada || itens.some(i => !i || typeof i !== 'object' || Array.isArray(i))) {
      throw erro('T4S: resposta paginada em formato inesperado.');
    }
    return { itens, page: numero, totalRecords: total, totalPages: Math.max(1, Math.ceil(total / 20)), recordsPerPage: 20 };
  }

  async function listarPosicoes(timeoutMs = duracaoPedido()) {
    const lista = [], assinaturas = new Set();
    const limiteEm = agora() + 60000;
    let paginas = 1;
    for (let p = 1; p <= paginas; p++) {
      const restante = limiteEm - agora();
      if (restante <= 0) throw erro('T4S: coleta de posicoes excedeu um minuto; tente novamente.');
      const r = pagina(await consultar('/api/LastPositions', { PageNumber: p, RecordsPerPage: 20 }, Math.min(timeoutMs, restante)), 'lastpositions', p);
      paginas = Math.max(paginas, r.totalPages);
      if (paginas > 100) throw erro('T4S: mais de 100 paginas de veiculos; consulte a configuracao da frota.');
      const assinatura = JSON.stringify(r.itens);
      if ((!r.itens.length && r.totalRecords > 0) || (r.itens.length && assinaturas.has(assinatura))) {
        throw erro('T4S: pagina de posicoes vazia ou repetida; coleta interrompida.');
      }
      assinaturas.add(assinatura);
      lista.push(...r.itens.map(mapearPosicao).filter(Boolean));
    }
    // Um aparelho pode mudar entre paginas: conserva o sinal mais novo.
    const unicos = new Map();
    for (const pos of lista) {
      const anterior = unicos.get(pos.device_id);
      if (!anterior || pos.posicao_em > anterior.posicao_em) unicos.set(pos.device_id, pos);
    }
    return [...unicos.values()];
  }

  async function listarRotas({ page = 1 } = {}) {
    return pagina(await consultar('/api/Routes', { PageNumber: page, RecordsPerPage: 20 }), 'routes', page);
  }
  async function listarAlertas({ page = 1, plates = [], dateStart, dateEnd, status = [] } = {}) {
    return pagina(await consultar('/api/Alerts', { PageNumber: page, RecordsPerPage: 20,
      Plates: plates, DateStart: dateStart, DateEnd: dateEnd, Status: status }), 'alerts', page);
  }
  async function listarStatus({ page = 1 } = {}) {
    return pagina(await consultar('/api/Alerts/AlertsStatus', { PageNumber: page, RecordsPerPage: 20 }), 'alertsStatus', page);
  }
  return { configurado, info, listarPosicoes, listarRotas, listarAlertas, listarStatus };
}

export { criar, campo, mapearPosicao, placaMercosul, erro };
