'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('SQL real recupera GPS atrasado uma vez, sem alterar entrega ou horário já registrado',
  {skip:process.env.TMS_TEST_PG!=='1'},async()=>{
  const db=require('../db'),c=await db.connect();
  const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
  const diretorio=await fs.mkdtemp(path.join(os.tmpdir(),'gps-historico-pg-'));
  const sinais=require('../rastreador-sinais').criar({diretorio});
  try {
    // Todas as tabelas e sequências são temporárias e exclusivas desta conexão.
    await c.query(`CREATE TEMP TABLE tms_viagens(id int PRIMARY KEY,placa text,status text,programacao jsonb);
      CREATE TEMP TABLE tms_paradas(id int PRIMARY KEY,viagem_id int,loja_nome text,loja_id int,status text);
      CREATE TEMP TABLE sistema_config(chave text,valor jsonb);
      CREATE TEMP TABLE rastreador_aparelhos(fonte text,device_id int,placa text);
      CREATE TEMP TABLE ocorrencias(id int,parada_id int,hora_chegada time);
      CREATE TEMP TABLE rastreador_posicoes(id bigserial PRIMARY KEY,fonte text,device_id int,placa text,
        lat float8,lng float8,velocidade numeric,motor text,rumo int,posicao_em timestamptz,
        UNIQUE(fonte,device_id,posicao_em));
      CREATE TEMP TABLE rastreador_eventos_loja(id bigserial PRIMARY KEY,placa text,tipo text,lugar_codigo text,
        lugar_nome text,em timestamptz,viagem_id int,parada_id int,lat float8,lng float8,fonte text,
        permanencia_min int,detalhe text,UNIQUE(placa,tipo,lugar_codigo,em));`);
    for(const t of ['tms_viagens','tms_paradas','rastreador_posicoes','rastreador_eventos_loja','rastreador_aparelhos']) {
      assert.equal((await c.query(`SELECT '${t}'::regclass::oid='pg_temp.${t}'::regclass::oid AS temporaria`)).rows[0].temporaria,true);
    }
    await c.query(`INSERT INTO tms_viagens VALUES(281,'FKA0C10','Em rota','{"edicao_manual":true}');
      INSERT INTO rastreador_aparelhos VALUES('t4s',68560,'FKA0C10');
      INSERT INTO tms_paradas VALUES(1702,281,'BANGU V',101,'Pendente'),(1703,281,'BANGU IV',100,'Pendente');
      INSERT INTO ocorrencias VALUES(1,1703,'12:00');
      INSERT INTO rastreador_eventos_loja(placa,tipo,lugar_codigo,em,viagem_id,parada_id,fonte)
        VALUES('FKA0C10','chegou_loja','538','2026-10-08T12:23:32-03:00',281,1703,'t4s');`);
    const v={id:281,placa:'FKA0C10',status:'Em rota',paradas:[
      {id:1702,loja_nome:'BANGU V',loja_id:101,loja_codigo_pes:'549'},
      {id:1703,loja_nome:'BANGU IV',loja_id:100,loja_codigo_pes:'538'}]};
    const l={codigo:'549',nome:'BANGU V',lat:-22.87557265151512,lng:-43.46588718867924,raio_entrada_m:23,raio_saida_m:36,area_personalizada:true};
    const iv={codigo:'538',nome:'BANGU IV',lat:-22.875044272452847,lng:-43.465818129245285,raio_entrada_m:23,raio_saida_m:30,area_personalizada:true};
    const p=(hora,lat,lng,vel=0,motor='desligado')=>({placa:'FKA0C10',device_id:68560,fonte:'t4s',lat,lng,velocidade:vel,motor,rumo:0,posicao_em:new Date('2026-10-08T'+hora+'-03:00')});
    const pontos=[p('10:56:55',-22.875615,-43.46527,17,'ligado'),p('11:13:52',-22.875588,-43.465901),
      p('11:24:50',-22.875563,-43.46587,0,'ligado'),p('11:25:57',-22.875593,-43.466033,13,'ligado'),
      p('11:26:56',-22.87575,-43.470635,35,'ligado'),p('11:30:51',-22.875066,-43.465913,0,'ligado'),
      p('11:32:53',-22.874985,-43.465996,0,'ligado')];
    const banco={query:(...a)=>c.query(...a),connect:async()=>({query:(...a)=>c.query(...a),release(){}})};
    const avisos=[];const svc=require('../rastreador-t4s-historico').criar({db:banco,
      sinais,rastreador:{coordenadas:async()=>new Map([['549',l],['538',iv]])},broadcastEvento:(tipo,e)=>avisos.push(e)});
    const opts={desde:'2026-10-08T10:00:00-03:00',ate:'2026-10-08T11:40:00-03:00',pontos};
    const r=await svc.recuperar(v,{fonte:'t4s',device_id:68560},opts);
    assert.equal(r.inseridas,7);assert.equal(r.eventos.length,2);assert.equal(avisos.length,2);
    const e=(await c.query("SELECT tipo,em,detalhe FROM rastreador_eventos_loja WHERE lugar_codigo='549' ORDER BY em")).rows;
    assert.equal(e[0].em.toISOString(),'2026-10-08T14:13:52.000Z');assert.equal(e[1].em.toISOString(),'2026-10-08T14:25:57.000Z');
    assert.match(e[0].detalhe,/recuperado do histórico T4S/);
    const repetir=await svc.recuperar(v,{fonte:'t4s',device_id:68560},opts);
    assert.equal(repetir.inseridas,0);assert.equal(repetir.eventos.length,0);assert.equal(avisos.length,2);
    assert.equal((await c.query("SELECT em FROM rastreador_eventos_loja WHERE lugar_codigo='538'")).rows[0].em.toISOString(),'2026-10-08T15:23:32.000Z');
    assert.equal((await c.query('SELECT hora_chegada FROM ocorrencias')).rows[0].hora_chegada,'12:00:00');
    assert.equal((await c.query('SELECT status FROM tms_paradas WHERE id=1702')).rows[0].status,'Pendente');
    assert.deepEqual((await c.query('SELECT programacao FROM tms_viagens')).rows[0].programacao,{edicao_manual:true});

    // Simula falha no calculo/gravação dos eventos. Os sinais recebidos
    // antes da transacao devem sobreviver ao ROLLBACK dos horarios.
    await c.query("DELETE FROM pg_temp.rastreador_eventos_loja WHERE lugar_codigo='549'");
    const falha=require('../rastreador-t4s-historico').criar({
      db:{query:banco.query,connect:async()=>({query:async(sql,args)=>{
        if(sql.includes('INSERT INTO rastreador_eventos_loja'))throw Error('evento falhou');
        return c.query(sql,args);
      },release(){}})},sinais,rastreador:{coordenadas:async()=>new Map([['549',l],['538',iv]])},
      broadcastEvento:()=>assert.fail('nao anuncia evento sem commit'),
    });
    const adicional=p('11:14:00',-22.875588,-43.465901);
    await assert.rejects(falha.recuperar(v,{fonte:'t4s',device_id:68560},
      {...opts,pontos:[...pontos,adicional]}),/evento falhou/);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM rastreador_posicoes')).rows[0].n,8);
    assert.equal((await c.query("SELECT count(*)::int AS n FROM rastreador_eventos_loja WHERE lugar_codigo='549'")).rows[0].n,0);
    assert.deepEqual(await fs.readdir(diretorio),[]);

    // Um servidor novo recompõe eventos com o dia inteiro salvo, mesmo
    // sem sessao ou acesso ao T4S e mais de seis horas depois da parada.
    const offline=require('../rastreador-t4s-historico').criar({db:banco,sinais,
      t4s:{configurado:()=>false,listarHistorico:async()=>assert.fail('nao deve consultar a plataforma')},
      agora:()=>Date.parse('2026-10-08T18:00:00-03:00'),
      rastreador:{coordenadas:async()=>new Map([['549',l],['538',iv]])},
    });
    await offline.rodar([{...v,data_viagem:'2026-10-08'}]);
    const recuperadas=(await c.query("SELECT tipo,em FROM rastreador_eventos_loja WHERE lugar_codigo='549' ORDER BY em")).rows;
    assert.equal(recuperadas.length,2);
    assert.equal(recuperadas[0].em.toISOString(),'2026-10-08T14:13:52.000Z');
    assert.equal(recuperadas[1].em.toISOString(),'2026-10-08T14:25:57.000Z');
    await offline.rodar([{...v,data_viagem:'2026-10-08'}]);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM rastreador_eventos_loja')).rows[0].n,3);
    assert.equal((await c.query('SELECT hora_chegada FROM ocorrencias')).rows[0].hora_chegada,'12:00:00');
  } finally {
    await c.query('ROLLBACK').catch(()=>{});c.release();await db.pool.end();
    await fs.rm(diretorio,{recursive:true,force:true});
  }
});
