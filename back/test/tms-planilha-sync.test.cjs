'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { podeReconciliar } = require('../tms-reconciliar-planilha');
const parada = { status:'Pendente',programacao:{ origem:'planilha' } }, viagem = { status:'Em rota',programacao:{} };
test('Parada pendente da planilha pode acompanhar mudanca de rota em viagem em andamento', () => {
  assert.equal(podeReconciliar(parada,viagem),true);
});
test('Entrega, atendimento, ocorrencia, CTe e pedidos preservam o registro original', () => {
  for (const extra of [{ status:'Entregue' },{ status:'Em atendimento' },{ ocorrencia_id:99 },{ possui_ocorrencia:true },
    { cte_concluido:true },{ pedidos:[{ id:1 }] }]) assert.equal(podeReconciliar({ ...parada,...extra },viagem),false);
});
test('Edicao manual e viagem finalizada continuam protegidas da reconciliacao', () => {
  assert.equal(podeReconciliar(parada,{ ...viagem,programacao:{ edicao_manual:{} } }),false);
  assert.equal(podeReconciliar(parada,{ ...viagem,status:'Finalizada' }),false);
});

test('SQL real transfere lojas do dia 8, elimina copias, atualiza Em rota e preserva historico e ordem manual',
  { skip:process.env.TMS_TEST_PG!=='1' },async()=>{
  const db=require('../db'),client=await db.connect(),prog=require('../tms-programacao');
  try {
    for (const t of ['tms_viagens','tms_paradas','tms_lojas','tms_fretes_loja','tms_programacao_sync']) {
      await client.query(`CREATE TEMP TABLE ${t} (LIKE public.${t} INCLUDING DEFAULTS)`);
      assert.equal((await client.query(`SELECT '${t}'::regclass::oid='pg_temp.${t}'::regclass::oid AS temporaria`)).rows[0].temporaria,true);
    }
    await client.query('ALTER TABLE pg_temp.tms_viagens ADD PRIMARY KEY(id)');
    await client.query('ALTER TABLE pg_temp.tms_programacao_sync ADD PRIMARY KEY(data)');
    for (const t of ['tms_viagens','tms_paradas']) {
      await client.query(`CREATE TEMP SEQUENCE ${t}_teste_seq START 1000`);
      await client.query(`ALTER TABLE pg_temp.${t} ALTER COLUMN id SET DEFAULT nextval('pg_temp.${t}_teste_seq')`);
    }
    await client.query('CREATE TEMP TABLE ocorrencias (parada_id int,excluida_em timestamptz)');
    await client.query('CREATE TEMP TABLE cadastros (tipo text,valor text,oculto boolean DEFAULT false)');
    const data='2026-10-08',placas=['AAA1A11','BBB2B22','CCC3C33',null,'DDD4D44'];
    for (const [i,rota] of ['ALFA','BETA','GAMA','BETA','HISTORICA'].entries()) {
      await client.query(`INSERT INTO tms_viagens(id,codigo,data_viagem,rota_nome,motorista_nome,placa,status,programacao)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,[i+1,`V-${i+1}`,data,rota,`M${i+1}`,placas[i],
        [1,2,4].includes(i)?'Em rota':'Planejada',JSON.stringify({ chave:`${data}|${prog.chaveRota(rota)}${i===3?'|bloco-4':''}` })]);
    }
    const iniciais=[['SANTA CRUZ II',1,10],['MAX SHOPPING',2,25],['ITAGUAÍ II',2,60],['OLINDA ELLIS',2,12],
      ['WEST III',2,13],['ANGRA DOS REIS',2,14],['ANGRA DOS REIS',3,14],['PARK',4,42],['CARIOCA',5,500]];
    for (const [i,[loja,id,vol]] of iniciais.entries()) await client.query(`INSERT INTO tms_paradas
      (id,viagem_id,ordem,loja_nome,status,volumes_previstos,hora_prevista,programacao,ocorrencia_id)
      VALUES($1,$2,$3,$4,$5,$6,'07:30',$7::jsonb,$8)`,[i+1,id,i+1,loja,i===8?'Entregue':'Pendente',vol,
        JSON.stringify({ origem:'planilha',checklist:false }),i===8?99:null]);
    const historica=(await client.query('SELECT * FROM tms_paradas WHERE id=9')).rows[0];
    // Mantem a ordem historica inicial da unica parada ja entregue.
    await client.query('UPDATE tms_paradas SET ordem=1 WHERE id=9'); historica.ordem=1;
    const blocos=[['ALFA',1,['SANTA CRUZ II','ITAGUAÍ II','MAX SHOPPING']],['BETA',2,['PARK','OLINDA ELLIS','WEST III']],
      ['GAMA',3,['ANGRA DOS REIS']],['HISTORICA',5,['CARIOCA']]].map(([rota,id,lojas])=>({rota,motorista:`M${id}`,
        placa:placas[id-1],paradas:lojas.map(loja=>({loja,hora_loja:'09:00',cx:7,rt:2}))}));
    const payload={data_viagem:data,arquivo:'08.10.26.xlsx',aba:'Folha1',blocos};
    await client.query('BEGIN'); const r=await prog.importar(client,payload,[],'teste'); await client.query('COMMIT');
    const ordem=async id=>(await client.query('SELECT id,loja_nome FROM tms_paradas WHERE viagem_id=$1 ORDER BY ordem,id',[id])).rows;
    assert.deepEqual((await ordem(1)).map(p=>p.id),[1,3,2]);
    assert.deepEqual((await ordem(2)).map(p=>p.id),[8,4,5]);
    assert.deepEqual((await ordem(3)).map(p=>p.id),[7]);
    assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM tms_paradas WHERE id=6')).rows[0].n,0);
    assert.equal(r.transferencias.length,3);
    assert.equal((await client.query('SELECT status FROM tms_viagens WHERE id=4')).rows[0].status,'Cancelada');
    assert.equal((await client.query('SELECT volumes_previstos FROM tms_viagens WHERE id=1')).rows[0].volumes_previstos,95);
    assert.equal((await client.query('SELECT volumes_previstos FROM tms_viagens WHERE id=2')).rows[0].volumes_previstos,67);
    assert.deepEqual((await client.query('SELECT * FROM tms_paradas WHERE id=9')).rows[0],historica);
    assert.ok((await client.query('SELECT programacao FROM tms_viagens WHERE id=2')).rows[0].programacao.reconciliacao_planilha.length);
    await client.query('BEGIN');const deNovo=await prog.importar(client,payload,[],'teste');await client.query('COMMIT');
    assert.equal(deNovo.transferencias.length,0);assert.equal(deNovo.remocoes.length,0);
    await client.query(`UPDATE tms_viagens SET programacao=programacao || '{"ordem_manual":true}'::jsonb WHERE id=1`);
    await client.query('UPDATE tms_paradas SET ordem=CASE id WHEN 2 THEN 1 WHEN 3 THEN 2 ELSE 3 END WHERE viagem_id=1');
    await client.query('BEGIN');await prog.importar(client,payload,[],'teste');await client.query('COMMIT');
    assert.deepEqual((await ordem(1)).map(p=>p.id),[2,3,1]);

    // Exerce o caminho AUTOMATICO: mesma planilha/mesmo hash pode ser relida
    // para a migracao da reconciliacao e para Sincronizar agora.
    const fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module');
    const arquivo=require.resolve('../tms-programacao'),modulo={exports:{}};
    vm.runInNewContext(fs.readFileSync(arquivo,'utf8')+`
      module.exports.syncTeste=async(deps,linha,listagem,blocos,opcoes)=>{
        lerConteudoArquivo=async()=>Buffer.from('teste');
        lerAbasDaPlanilha=()=>({nome:'Folha1',blocos});
        xlsxNode=()=>({});
        return sincronizarPlanilhaDia(deps,linha,listagem,opcoes);
      };`,{module:modulo,require:createRequire(arquivo),__dirname:require('node:path').dirname(arquivo),
      process,console,Buffer,setTimeout,clearTimeout,setInterval,clearInterval});
    const hashes=Object.fromEntries(r.blocos.map(b=>[b.chave,prog.hashBloco(prog.sanearBlocos(blocos)[b.indice])]));
    await client.query("INSERT INTO tms_programacao_sync(data,blocos_hash) VALUES($1,$2::jsonb)",[data,JSON.stringify(hashes)]);
    const linha={data,blocos_hash:hashes,arquivo_modificado:'igual',arquivo_tamanho:10,ignoradas:[]};
    const listagem={arquivos:[{data,nome:'08.10.26.xlsx',modificado:'igual',tamanho:10}]};
    const deps={db:{connect:async()=>({query:(...a)=>client.query(...a),release(){}})}};
    const auto=await modulo.exports.syncTeste(deps,linha,listagem,blocos,{});
    assert.equal(auto.erro,null);assert.ok(auto.aplicadas.some(x=>x.viagem_id===2));
    const atualizada={...linha,blocos_hash:{...hashes,__reconciliacao:'1'}};
    const cache=await modulo.exports.syncTeste(deps,atualizada,listagem,blocos,{});
    assert.equal(cache.sem_mudanca,true);
    const forcada=await modulo.exports.syncTeste(deps,atualizada,listagem,blocos,{forcar:true});
    assert.equal(forcada.sem_mudanca,false);assert.ok(forcada.aplicadas.some(x=>x.viagem_id===2));
    // Campo apagado no rascunho da planilha nao conserva equipe da rota antiga.
    await client.query(`UPDATE tms_viagens SET status='Planejada',saida_real=NULL,
      programacao=programacao || '{"fonte":"planilha"}'::jsonb WHERE id=2`);
    const semEquipe=blocos.map(b=>b.rota==='BETA'?{...b,motorista:null,placa:null}:b);
    await client.query('BEGIN');await prog.importar(client,{...payload,blocos:semEquipe},[],'teste');await client.query('COMMIT');
    const equipe=(await client.query('SELECT motorista_nome,placa FROM tms_viagens WHERE id=2')).rows[0];
    assert.equal(equipe.motorista_nome,null);assert.equal(equipe.placa,null);
  } finally {await client.query('ROLLBACK').catch(()=>{});client.release();await db.pool.end();}
});
