'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const arquivo = require.resolve('../tms-programacao');
const modulo = { exports: {} };
vm.runInNewContext(fs.readFileSync(arquivo, 'utf8') +
  '\nmodule.exports.__teste = { atualizarViagem, pontuarViagem, pendenciasDoPlano };', {
  module: modulo, require: createRequire(arquivo), process, console, __dirname: require('node:path').dirname(arquivo),
  setTimeout, clearTimeout, setInterval, clearInterval,
});
const { sincronizarDia, __teste } = modulo.exports;
const clone = x => JSON.parse(JSON.stringify(x));
const DATA = '2026-10-08';
const manual = { salva_em: '2026-10-08T12:00:00Z' };
const parada = (id, nome) => ({ id, ordem: id, loja_nome: nome, status: 'Pendente', volumes_previstos: 90,
  material_campanha: 12, sacola: 8, sacola_p: 8, sacola_m: 0, sacola_g: 0, remessas: null });
const viagem = extra => ({ id: 275, codigo: 'V-20261008-00275', status: 'Em rota', data: DATA,
  rota_nome: 'R.LAGOS', placa: 'FKC2E12', motorista_nome: 'MANUAL', checklist_origem_id: 216,
  programacao: { chave: 'ORIGEM' }, paradas: [parada(1, 'RECREIO')], ...extra });
const ckParada = nome => ({ loja: nome, chave_loja: nome, pes: null, volumes_previstos: 5,
  material_campanha: 1, sacola: 2, sacola_p: 2, sacola_m: 0, sacola_g: 0, remessas: null });
function banco(v, atual = v) {
  const escritas = [], leituras = [];
  return { escritas, leituras, query: async (sql, params) => {
    leituras.push(sql);
    if (/^\s*(INSERT|UPDATE|DELETE)/.test(sql)) { escritas.push({ sql, params }); return { rowCount: 1, rows: [] }; }
    if (sql.includes('FOR UPDATE')) return { rows: [clone(atual)] };
    if (sql.includes('FROM tms_fretes_loja')) return { rows: [] };
    if (sql.includes('json_agg')) return { rows: [clone(v)] };
    if (sql.includes('checklist_origem_id AS ck')) return { rows: [{ ck: 216, id: 275 }] };
    throw Error(`Consulta inesperada: ${sql}`);
  } };
}
function checklists(paradas = [ckParada('RECREIO'), ckParada('BANGU I')]) {
  return { erro: null, lista: [{ id: 216, rota: 'R.LAGOS', status: 'Liberado', paradas }] };
}

test('Checklist nao restaura loja removida nem substitui carga ou totais editados', async () => {
  const v = viagem({ programacao: { chave: 'ORIGEM', edicao_manual: manual } });
  const original = JSON.stringify(v), db = banco(v);
  const resumo = await sincronizarDia(db, DATA, {}, checklists());
  assert.equal(db.escritas.length, 0);
  assert.equal(resumo.viagens.length, 0);
  assert.equal(JSON.stringify(v), original);
  assert.ok(db.leituras.some(sql => sql.includes('FOR UPDATE')));
});

test('Checklist revalida edicao salva depois da leitura inicial, sob trava da viagem', async () => {
  const v = viagem(), db = banco(v, { ...v, programacao: { ...v.programacao, edicao_manual: manual } });
  await sincronizarDia(db, DATA, {}, checklists());
  assert.equal(db.escritas.length, 0);
});

test('Viagem sem edicao continua recebendo cargas, lojas novas e totais do Checklist', async () => {
  const db = banco(viagem());
  const resumo = await sincronizarDia(db, DATA, {}, checklists());
  assert.equal(resumo.viagens[0].paradas_atualizadas, 1);
  assert.equal(resumo.viagens[0].paradas_novas, 1);
  assert.equal(db.escritas.length, 3);
  assert.ok(db.escritas.some(x => x.sql.includes('INSERT INTO tms_paradas')));
});

test('Checklist nao limpa carga manual quando a loja sai da fonte', async () => {
  const v = viagem({ programacao: { chave: 'ORIGEM', edicao_manual: manual } }), db = banco(v);
  await sincronizarDia(db, DATA, {}, checklists([]));
  assert.equal(db.escritas.length, 0);
});

test('Planilha revalida protecao sob trava antes de alterar equipe, horarios ou paradas', async () => {
  const v = viagem({ programacao: { chave: 'ORIGEM', edicao_manual: manual } }), db = banco(v);
  const r = await __teste.atualizarViagem(db, { alvo: { id: v.id, codigo: v.codigo } }, {}, 'teste');
  assert.match(r.motivo, /manual/);
  assert.equal(db.escritas.length, 0);
  assert.equal(db.leituras.length, 1);
});

test('Trocar todas as lojas, placa e rota nao faz a planilha criar copia da viagem editada', () => {
  const bloco = { chave: 'ORIGEM', chave_rota: 'OUTRA', paradas: [{ chave_loja: 'BANGU I' }], placa: { sistema: 'FKB1D11' } };
  const v = viagem({ rota_nome: 'MANUAL', programacao: { chave: 'ORIGEM', edicao_manual: manual } });
  assert.equal(__teste.pontuarViagem(bloco, v).aceita, true);
  assert.match(__teste.pontuarViagem(bloco, v).motivo, /importada antes/);
  assert.equal(__teste.pontuarViagem(bloco, viagem({ rota_nome: 'MANUAL' })).aceita, false);
  assert.equal(__teste.pontuarViagem(bloco, { ...v, status: 'Cancelada' }).aceita, false);
  const repetido = { ...bloco, rota_repetida: true };
  const concorrente = viagem({ placa: 'FKB1D11', rota_nome: 'OUTRA', programacao: {} });
  assert.ok(__teste.pontuarViagem(repetido, v).pontos > __teste.pontuarViagem(repetido, concorrente).pontos);
});

test('Sincronizacao revalida saida sob trava antes de trocar motorista ou placa', async () => {
  const v = viagem(), db = banco(v);
  const r = await __teste.atualizarViagem(db,{ alvo:{ id:v.id,codigo:v.codigo },motorista:{ sistema:'OUTRO' },
    placa:{ sistema:'FKB1D11' } },{},'teste',{ automatica:true });
  assert.match(r.motivo,/troca de motorista\/placa/);
  assert.equal(db.escritas.length,0);
});

test('Bloco protegido nao bloqueia primeira importacao automatica das outras viagens', () => {
  const r = __teste.pendenciasDoPlano({ blocos: [{ acao: 'atualizar', alvo: { edicao_manual: true },
    avisos: ['Planejamento manual preservado'] }] });
  assert.equal(r.length, 0);
});
