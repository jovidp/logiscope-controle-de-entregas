'use strict';
const { campo, erro, placaMercosul, padrao } = require('./t4s-api');

const texto = v => typeof v === 'string' ? v.slice(0, 1000) : '';
const numero = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
function inteiro(v, nome, minimo = 1, maximo = 100) {
  if (typeof v !== 'string' && typeof v !== 'number') throw erro(`${nome} invalido.`, 400);
  if (!/^\d+$/.test(String(v)) || !Number.isSafeInteger(Number(v)) || Number(v) < minimo || Number(v) > maximo) {
    throw erro(`${nome} invalido.`, 400);
  }
  return Number(v);
}
function dataISO(v, nome) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw erro(`${nome} deve ter formato AAAA-MM-DD.`, 400);
  const d = new Date(`${v}T12:00:00Z`);
  if (!Number.isFinite(+d) || d.toISOString().slice(0, 10) !== v) throw erro(`${nome} invalida.`, 400);
  return v;
}
const dataBR = iso => iso.split('-').reverse().join('/');
function filtrosAlertas(q) {
  const page = inteiro(q.page ?? '1', 'Pagina');
  const inicio = dataISO(q.inicio, 'Data inicial'), fim = dataISO(q.fim, 'Data final');
  const diferenca = Date.parse(fim) - Date.parse(inicio);
  if (diferenca < 0 || diferenca > 30 * 86400000) throw erro('Escolha um periodo de ate 31 dias, com fim apos o inicio.', 400);
  const plates = [];
  if (q.placa !== undefined && q.placa !== '') {
    if (typeof q.placa !== 'string' || !/^[A-Za-z]{3}[- ]?\d[A-Za-z0-9]\d{2}$/.test(q.placa.trim())) throw erro('Placa invalida.', 400);
    // Filtro vai com a grafia informada: o T4S pode manter a placa antiga.
    plates.push(q.placa.trim().toUpperCase().replace(/[- ]/g, ''));
  }
  const status = q.status !== undefined && q.status !== '' ? [inteiro(q.status, 'Status', 0, 2147483647)] : [];
  return { page, plates, dateStart: dataBR(inicio), dateEnd: dataBR(fim), status };
}

function criar({ api = padrao, navegador = require('./rastreador-t4s'), rastreador = require('./rastreador'), agora = () => Date.now() } = {}) {
  // Cache e consultas compartilhadas limitam chamadas de varios operadores.
  const cache = new Map();
  async function emCache(chave, consulta) {
    const anterior = cache.get(chave);
    if (anterior && agora() < anterior.ate) return anterior.p;
    for (const [k, v] of cache) if (agora() >= v.ate) cache.delete(k);
    if (cache.size >= 100) cache.delete(cache.keys().next().value);
    const entrada = { ate: agora() + 30000, p: Promise.resolve().then(consulta) };
    cache.set(chave, entrada);
    entrada.p.catch(() => { if (cache.get(chave) === entrada) cache.delete(chave); });
    return entrada.p;
  }
  function handler(acao) {
    return async (req, res) => {
      res.set?.('Cache-Control', 'no-store');
      try { res.json(await acao(req)); }
      catch (e) { res.status(e.statusCliente || 502).json({ error: e.statusCliente ? e.message : 'T4S: falha ao consultar a API.' }); }
    };
  }
  function exigirAPI() {
    if (!api.configurado()) throw erro('Solicite ClientKey e ClientSecret a T4S e configure T4S_CLIENT_KEY e T4S_CLIENT_SECRET no servidor.', 503);
  }
  const envelope = (r, itens) => ({ itens, page: r.page, totalRecords: r.totalRecords, totalPages: r.totalPages, recordsPerPage: r.recordsPerPage });
  const status = handler(async () => ({ ...api.info(),
    modo_posicoes: api.configurado() ? 'api' : navegador.historicoConfigurado() ? 'navegador' : 'desconectado',
    coleta: { ultima_coleta: rastreador.estado.t4s.ultima_coleta, aparelhos: rastreador.estado.t4s.aparelhos,
      erro: rastreador.estado.t4s.erro },
  }));
  const rotas = handler(async req => {
    const page = inteiro(req.query.page ?? '1', 'Pagina');
    exigirAPI();
    const r = await emCache(`rotas:${page}`, () => api.listarRotas({page}));
    return envelope(r, r.itens.map(i => ({ id: numero(campo(i, 'routeId')), nome: texto(campo(i, 'name')),
      tolerancia: numero(campo(i, 'tolerance')), processada: campo(i, 'processed') === true })));
  });
  const alertas = handler(async req => {
    const filtros = filtrosAlertas(req.query);
    exigirAPI();
    const r = await emCache(`alertas:${JSON.stringify(filtros)}`, () => api.listarAlertas(filtros));
    return envelope(r, r.itens.map(i => {
      const lat = numero(campo(i, 'latitude')), lng = numero(campo(i, 'longitude'));
      return { id: numero(campo(i, 'alertId')), placa: placaMercosul(campo(i, 'plate')),
        tipo: texto(campo(i, 'alertType')), status: texto(campo(i, 'status')) || numero(campo(i, 'status')),
        em: texto(campo(i, 'positionDate')), empresa: texto(campo(i, 'company')), lat, lng };
    }));
  });
  const statusAlertas = handler(async req => {
    const page = inteiro(req.query.page ?? '1', 'Pagina');
    exigirAPI();
    const r = await emCache(`status:${page}`, () => api.listarStatus({page}));
    return envelope(r, r.itens.map(i => ({ id: numero(campo(i, 'alertsStatusId')), nome: texto(campo(i, 'name')) })));
  });
  return { status, rotas, alertas, statusAlertas };
}

module.exports = { criar, filtrosAlertas, inteiro, dataISO };
