'use strict';
// Opcional: TMS_TEST_PG=1. Executa SQL real somente em tabelas TEMPORARIAS
// desta conexao, sem gravar viagens, auditoria ou sequencias da operacao.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { chaveLoja } = require('../normalizar-loja');
test('PUT real preserva todos os campos e a sincronizacao nao restaura planejamento antigo',
  { skip: process.env.TMS_TEST_PG !== '1' }, async () => {
  const db = require('../db'), client = await db.connect();
  try {
    for (const tabela of ['tms_viagens', 'tms_paradas', 'tms_lojas', 'tms_fretes_loja']) {
      await client.query(`CREATE TEMP TABLE ${tabela} (LIKE public.${tabela} INCLUDING DEFAULTS)`);
      const r = await client.query(`SELECT '${tabela}'::regclass::oid = 'pg_temp.${tabela}'::regclass::oid AS temporaria`);
      assert.equal(r.rows[0].temporaria, true);
    }
    await client.query('ALTER TABLE pg_temp.tms_viagens ADD PRIMARY KEY(id)');
    await client.query('CREATE TEMP SEQUENCE tms_edicao_viagem_seq START 1000');
    await client.query("ALTER TABLE pg_temp.tms_viagens ALTER COLUMN id SET DEFAULT nextval('pg_temp.tms_edicao_viagem_seq')");
    await client.query('CREATE TEMP SEQUENCE tms_edicao_parada_seq START 1000');
    await client.query("ALTER TABLE pg_temp.tms_paradas ALTER COLUMN id SET DEFAULT nextval('pg_temp.tms_edicao_parada_seq')");
    await client.query('CREATE TEMP TABLE ocorrencias (parada_id int, excluida_em timestamptz)');
    await client.query('CREATE TEMP TABLE cadastros (tipo text, valor text, oculto boolean DEFAULT false)');
    const programacao = require('../tms-programacao');
    const chaveOrigem = `2026-10-08|${programacao.chaveRota('R.LAGOS')}`;
    await client.query(`INSERT INTO tms_viagens (id,codigo,data_viagem,motorista_nome,placa,rota_nome,status,checklist_origem_id,programacao)
      VALUES (275,'V-20261008-00275','2026-10-08','ORIGINAL','FKC2E12','R.LAGOS','Planejada',216,$1::jsonb)`,
      [JSON.stringify({ chave: chaveOrigem, arquivo: 'teste.xlsx' })]);
    await client.query(`INSERT INTO tms_paradas (id,viagem_id,ordem,loja_nome,loja_id,status,programacao,observacao)
      VALUES (1,275,1,'RECREIO',100,'Pendente','{"pes":"418","saiu_do_checklist":216}','Preservar'),
      (2,275,2,'BANGU II',102,'Pendente',NULL,NULL)`);
    await client.query("INSERT INTO tms_lojas (id,codigo,nome) VALUES (100,'RECREIO','RECREIO'),(101,'BANGU I','BANGU I')");
    const source = fs.readFileSync(require.resolve('../server'), 'utf8');
    const inicio = source.indexOf("app.put('/tms/viagens/:id',");
    const fim = source.indexOf('// ================= DIVIDIR VIAGEM', inicio);
    const preencherInicio = source.indexOf('async function preencherLojaIdDaViagem(');
    const preencherFim = source.indexOf('// opcoes.pernoite:', preencherInicio);
    let handler;
    const ctx = { db: { connect: async () => ({ query: (...a) => client.query(...a), release() {} }) },
      app: { put: (rota, fn) => { handler = fn; } }, chaveLoja,
      vazioParaNull: v => v === '' || v === undefined || v === null ? null : v,
      buscarViagensTms: async () => (await client.query('SELECT * FROM tms_viagens')).rows,
      registrarAuditoria: async () => {},
    };
    vm.runInNewContext(source.slice(preencherInicio, preencherFim) + source.slice(inicio, fim), ctx);
    const body = { data_viagem: '2026-10-08', motorista: 'EDITADO', placa: 'FKB1D11', rota: 'ROTA MANUAL', ajudantes: 'AJUDANTE',
      hora_saida_fabrica: '09:30', volumes_previstos: 17, material_campanha: 4, sacola: 6, sacola_p: 1, sacola_m: 2, sacola_g: 3,
      observacao: 'Observacao editada', responsavel_monitoramento: 'TESTE', km_previsto: 42, km_real: 41,
      custo_frete: 200, custo_combustivel: 60, pedagio: 10, outros_custos: 5,
      paradas: [{ id: 1, loja: 'BANGU I', hora_prevista: '10:00', volumes_previstos: 7, material_campanha: 2,
        sacola: 2, sacola_p: 1, sacola_m: 1, sacola_g: 0, retirada_cx: 3, retirada_rt: 4, prioridade: 3 },
        { loja: 'PASSEIO', hora_prevista: '11:00', volumes_previstos: 10, material_campanha: 2,
          sacola: 4, sacola_p: 0, sacola_m: 1, sacola_g: 3, retirada_cx: 5, retirada_rt: 6, prioridade: 1 }],
    };
    const resposta = () => ({ code: null, body: null, status(n) { this.code = n; return this; }, json(x) { this.body = x; return this; } });
    const res = resposta(); await handler({ params: { id: 275 }, body }, res);
    assert.equal(res.code, 200, res.body?.error);
    const antes = await client.query('SELECT * FROM tms_viagens WHERE id=275');
    const v = antes.rows[0];
    for (const campo of ['hora_saida_fabrica','volumes_previstos','material_campanha','sacola','sacola_p','sacola_m','sacola_g',
      'observacao','responsavel_monitoramento','km_previsto','km_real','custo_frete','custo_combustivel','pedagio','outros_custos']) {
      const atual = campo === 'hora_saida_fabrica' ? String(v[campo]).slice(0,5) : v[campo];
      if (typeof body[campo] === 'number') assert.equal(Number(atual), body[campo], campo);
      else assert.equal(String(atual), String(body[campo]), campo);
    }
    assert.equal(v.motorista_nome, 'EDITADO'); assert.equal(v.placa, 'FKB1D11'); assert.equal(v.rota_nome, 'ROTA MANUAL');
    assert.equal(v.programacao.chave, chaveOrigem); assert.equal(v.programacao.arquivo, 'teste.xlsx');
    assert.ok(v.programacao.edicao_manual.salva_em);
    const paradasAntes = (await client.query('SELECT * FROM tms_paradas ORDER BY ordem')).rows;
    assert.deepEqual(paradasAntes.map(p => p.loja_nome), ['BANGU I','PASSEIO']);
    assert.equal(paradasAntes[0].loja_id, 101); assert.equal(paradasAntes[0].observacao, 'Preservar');
    assert.equal(paradasAntes[0].programacao.pes, undefined); assert.equal(paradasAntes[0].programacao.saiu_do_checklist, undefined);
    const arquivo = require.resolve('../tms-programacao'), modulo = { exports: {} };
    vm.runInNewContext(fs.readFileSync(arquivo,'utf8') + '\nmodule.exports.atualizarViagemTeste = atualizarViagem;', {
      module: modulo, require: createRequire(arquivo), process, console, __dirname: require('node:path').dirname(arquivo),
      setTimeout, clearTimeout, setInterval, clearInterval,
    });
    const ck = { erro: null, lista: [{ id:216, rota:'R.LAGOS', status:'Liberado', paradas:[
      { loja:'RECREIO',chave_loja:'RECREIO',volumes_previstos:900 },{ loja:'BANGU I',chave_loja:'BANGU I',volumes_previstos:100 },
    ] }] };
    for (let i=0;i<2;i++) {
      await client.query('BEGIN');
      const r = await modulo.exports.sincronizarDia(client,'2026-10-08',{},ck);
      assert.equal(r.viagens.length,0);
      const planilha = await modulo.exports.atualizarViagemTeste(client,{ alvo:{ id:275,codigo:v.codigo } },{},'teste');
      assert.match(planilha.motivo,/manual/);
      await client.query('COMMIT');
    }
    assert.deepEqual((await client.query('SELECT * FROM tms_viagens WHERE id=275')).rows, antes.rows);
    assert.deepEqual((await client.query('SELECT * FROM tms_paradas ORDER BY ordem')).rows, paradasAntes);
    // Falha depois de comecar a atualizar nao deixa cabecalho/marcador/paradas parcialmente salvos.
    const falha = resposta();
    await handler({ params:{ id:275 },body:{ ...body,motorista:'NAO GRAVAR',paradas:[body.paradas[0],body.paradas[0]] } },falha);
    assert.equal(falha.code,500);
    assert.deepEqual((await client.query('SELECT * FROM tms_viagens WHERE id=275')).rows, antes.rows);
    assert.deepEqual((await client.query('SELECT * FROM tms_paradas ORDER BY ordem')).rows, paradasAntes);
    const payload = { data_viagem:'2026-10-08', arquivo:'teste.xlsx', blocos:[{ rota:'R.LAGOS', placa:'FKC2E12', motorista:'ORIGINAL',
      paradas:[{ loja:'RECREIO', hora_loja:'06:00', cx:20, rt:30 }] }] };
    // A importacao completa reencontra a origem mesmo apos mudar lojas, equipe e rota.
    await client.query('BEGIN');
    const importado = await programacao.importar(client,payload,[],'teste');
    await client.query('COMMIT');
    assert.equal(importado.criadas.length,0); assert.equal(importado.atualizadas.length,0);
    assert.equal(importado.puladas.length,1); assert.match(importado.puladas[0].motivo,/manual/);
    assert.deepEqual((await client.query('SELECT * FROM tms_viagens WHERE id=275')).rows, antes.rows);
    // Alterar o dia tambem conserva o vinculo com o bloco antigo, sem recriar a viagem.
    const mudouDia = resposta();
    await handler({ params:{ id:275 },body:{ ...body,data_viagem:'2026-10-09' } },mudouDia);
    assert.equal(mudouDia.code,200,mudouDia.body?.error);
    await client.query('BEGIN');
    const antigoDia = await programacao.importar(client,payload,[],'teste');
    await client.query('COMMIT');
    assert.equal(antigoDia.criadas.length,0); assert.equal(antigoDia.puladas.length,1);
    const final = await client.query("SELECT to_char(data_viagem,'YYYY-MM-DD') AS data FROM tms_viagens WHERE id=275");
    assert.equal(final.rows[0].data,'2026-10-09');
    assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM tms_viagens')).rows[0].n,1);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release(); await db.pool.end();
  }
});
