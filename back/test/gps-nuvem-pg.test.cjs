'use strict';
// Executa o DDL em pg_temp, sem extensoes, jobs ou tabelas da operacao.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
test('Schema GPS: duplicatas, constraints e exclusao de coletas em PostgreSQL real',
  {skip:process.env.TMS_TEST_PG!=='1'},async()=>{
    const db=require('../db'),client=await db.connect();
    try {
      await client.query('BEGIN');
      const dir=path.join(__dirname,'../../supabase/migrations');
      const file=fs.readdirSync(dir).find(n=>n.endsWith('_gps_coleta_nuvem.sql'));
      let sql=fs.readFileSync(path.join(dir,file),'utf8');
      sql=sql.slice(sql.indexOf('CREATE TABLE'),sql.indexOf('-- A coleta sera agendada'));
      sql=sql.replace(/REVOKE [\s\S]*?;/g,'').replace(/GRANT [\s\S]*?;/g,'')
        .replaceAll('public.','pg_temp.').replaceAll('CREATE TABLE pg_temp.','CREATE TEMP TABLE pg_temp.');
      await client.query(sql);
      const sinais=[{device_id:7,placa:'FKS4U24',nome:'teste',lat:-22.9,lng:-43.2,velocidade:0,rumo:0,motor:'desligado',online:'',parado_seg:0,posicao_em:new Date().toISOString()}];
      const inserir=lista=>client.query('SELECT pg_temp.gps_salvar_sinais($1,$2::jsonb) AS n',['sat',JSON.stringify(lista)]);
      assert.equal((await inserir(sinais)).rows[0].n,1);
      assert.equal((await inserir(sinais)).rows[0].n,0);
      await client.query('SAVEPOINT invalido');
      await assert.rejects(inserir([{...sinais[0],device_id:8,lat:0,lng:0}]),e=>e.code==='23514');
      await client.query('ROLLBACK TO SAVEPOINT invalido');
      const a=crypto.randomUUID(),b=crypto.randomUUID();
      assert.equal((await client.query('SELECT pg_temp.gps_tentar_coleta($1) AS ok',[a])).rows[0].ok,true);
      assert.equal((await client.query('SELECT pg_temp.gps_tentar_coleta($1) AS ok',[b])).rows[0].ok,false);
      await client.query('SELECT pg_temp.gps_liberar_coleta($1)',[b]);
      assert.equal((await client.query('SELECT pg_temp.gps_tentar_coleta($1) AS ok',[b])).rows[0].ok,false);
      await client.query('SELECT pg_temp.gps_liberar_coleta($1)',[a]);
      assert.equal((await client.query('SELECT pg_temp.gps_tentar_coleta($1) AS ok',[b])).rows[0].ok,true);
    } finally {await client.query('ROLLBACK');client.release();await db.pool.end();}
});
