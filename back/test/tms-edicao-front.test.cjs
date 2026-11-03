'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function diferido() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const dados = ids => [{ id: 275, paradas: ids.map((id, i) => ({ id, ordem: i + 1 })) }];
function ambiente() {
  const timers = new Map(), puts = [], gets = [], avisos = [];
  let timerId = 0;
  const ctx = {
    window: { location: { origin: 'http://localhost' } }, document: { addEventListener() {}, getElementById: () => null },
    alertar: m => avisos.push(m),
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, opts) => { const r = diferido(); puts.push({ url, body: JSON.parse(opts.body), r }); return r.promise; },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../public/js/tms.js'), 'utf8') + `
    tmsPopularFiltros = () => {};
    tmsAplicarFiltros = () => { tmsState.viagens = tmsState.viagensRaw; };
    globalThis.fixture = { state: tmsState, agendar: tmsAgendarSalvarOrdem,
      carregar: tmsCarregarViagens, fila: () => tmsOrdemFila, pendentes: tmsOrdensPendentes };
  `, ctx);
  ctx.tmsRequest = () => { const r = diferido(); gets.push(r); return r.promise; };
  const f = ctx.fixture;
  f.state.viagensRaw = f.state.viagens = dados([1, 2, 3]);
  return { ...f, ctx, puts, gets, avisos,
    executarTimer() { const [id, fn] = timers.entries().next().value; timers.delete(id); fn(); },
    ordem: () => Array.from(f.state.viagensRaw[0].paradas, p => p.id),
    editar(ids) { f.state.viagensRaw = f.state.viagens = dados(ids); f.agendar(275); },
  };
}
async function ticks() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
const sucesso = { ok: true, json: async () => ({ ok: true }) };

test('Atualizacao durante os 700ms preserva e envia a ordem escolhida pelo usuario', async () => {
  const a = ambiente(); a.editar([3, 1, 2]);
  const ler = a.carregar(); a.gets[0].resolve(dados([1, 2, 3])); await ler;
  assert.deepEqual(a.ordem(), [3, 1, 2]);
  a.executarTimer(); await ticks();
  assert.deepEqual(a.puts[0].body.paradas, [3, 1, 2]);
  a.puts[0].r.resolve(sucesso); await ticks();
  a.gets[1].resolve(dados([3, 1, 2])); await a.fila();
  assert.deepEqual(a.ordem(), [3, 1, 2]); assert.equal(a.pendentes.size, 0);
});

test('GET antigo nao desfaz gravacao concluida mesmo quando chega por ultimo', async () => {
  const a = ambiente(); a.editar([2, 3, 1]);
  const antigo = a.carregar();
  a.executarTimer(); await ticks(); a.puts[0].r.resolve(sucesso); await ticks();
  a.gets[1].resolve(dados([2, 3, 1])); await a.fila();
  a.gets[0].resolve(dados([1, 2, 3])); await antigo;
  assert.deepEqual(a.ordem(), [2, 3, 1]);
});

test('Resposta do primeiro movimento nao apaga segundo movimento ainda pendente', async () => {
  const a = ambiente(); a.editar([2, 1, 3]); a.executarTimer(); await ticks();
  a.editar([2, 3, 1]); a.puts[0].r.resolve(sucesso); await a.fila();
  assert.deepEqual(Array.from(a.pendentes.get(275)), [2, 3, 1]);
  const ler = a.carregar(); a.gets[0].resolve(dados([2, 1, 3])); await ler;
  assert.deepEqual(a.ordem(), [2, 3, 1]);
  a.executarTimer(); await ticks(); assert.deepEqual(a.puts[1].body.paradas, [2, 3, 1]);
  a.puts[1].r.resolve(sucesso); await ticks(); a.gets[1].resolve(dados([2, 3, 1])); await a.fila();
});

test('Falha no PUT avisa e recupera ordem realmente gravada', async () => {
  const a = ambiente(); a.editar([3, 2, 1]); a.executarTimer(); await ticks();
  a.puts[0].r.resolve({ ok: false, status: 409, json: async () => ({ error: 'Lojas mudaram' }) });
  await ticks(); a.gets[0].resolve(dados([1, 2, 3])); await a.fila();
  assert.deepEqual(a.ordem(), [1, 2, 3]); assert.equal(a.pendentes.size, 0);
  assert.match(a.avisos[0], /nao foi salva|não foi salva/);
});

test('Duas consultas concorrentes aplicam somente a resposta da mais recente', async () => {
  const a = ambiente(); const antiga = a.carregar(), nova = a.carregar();
  a.gets[1].resolve(dados([3, 2, 1])); await nova;
  a.gets[0].resolve(dados([1, 2, 3])); await antiga;
  assert.deepEqual(a.ordem(), [3, 2, 1]);
});

test('Lojas novas do servidor continuam visiveis enquanto uma ordem aguarda gravacao', async () => {
  const a = ambiente(); a.editar([3, 1, 2]); const ler = a.carregar();
  a.gets[0].resolve(dados([1, 2, 3, 4])); await ler;
  assert.deepEqual(a.ordem(), [3, 1, 2, 4]);
});
