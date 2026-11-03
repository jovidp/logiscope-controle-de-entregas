'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {criar,reconstruir,ausentes,donoDoEvento}=require('../rastreador-recuperacao');
const {criarDetector,listar}=require('../rastreador-ao-vivo');
const {decidir}=require('../tms-status-gps');
const loja={codigo:'A',nome:'Loja A',lat:-22.9,lng:-43.5};
const base=Date.parse('2026-10-08T06:00:00-03:00');
const ponto=(min,extra={})=>({placa:'FKA0C10',fonte:'srf',device_id:1,...loja,velocidade:0,
  motor:'ligado',posicao_em:new Date(base+min*60000),...extra});
const ev=(tipo,min,extra={})=>({placa:'FKA0C10',tipo,lugar:loja,lugar_codigo:'A',em:new Date(base+min*60000),...extra});
const desde=new Date(base).toISOString(),ate=new Date(base+300*60000).toISOString();

test('Recupera lacuna antiga mesmo havendo evento mais recente e usa SRF/Sat sem T4S',()=>{
  for(const fonte of ['srf','sat']) {
    const pts=[ponto(0,{lat:loja.lat+.006,velocidade:30,fonte}),ponto(1,{fonte}),ponto(2,{fonte}),
      ponto(5,{lat:loja.lat+.006,velocidade:30,fonte}),ponto(30,{fonte}),ponto(31,{fonte})];
    const eventos=reconstruir(pts,[loja]);
    const novos=ausentes(eventos,[ev('chegou_loja',30)],desde,ate);
    assert.deepEqual(novos.map(e=>e.tipo),['chegou_loja','saiu_loja']);
    assert.equal(+novos[0].em,base+60000);assert.equal(novos[0].fonte,fonte);
  }
});
test('Visita existente com horários alguns minutos diferentes não ganha eventos duplicados',()=>{
  const detectados=[ev('chegou_loja',10),ev('saiu_loja',40)];
  const existentes=[ev('chegou_loja',6),ev('saiu_loja',47)];
  assert.deepEqual(ausentes(detectados,existentes,desde,ate),[]);
});
test('Saída sem chegada recupera a chegada, preservando a saída conhecida',()=>{
  const detectados=[ev('chegou_loja',10),ev('saiu_loja',40)];
  assert.deepEqual(ausentes(detectados,[ev('saiu_loja',47)],desde,ate).map(e=>e.tipo),['chegou_loja']);
});
test('Segunda visita tem horários próprios e uma reprise não duplica nenhuma das duas',()=>{
  const primeira=[ev('chegou_loja',10),ev('saiu_loja',40)];
  const segunda=[ev('chegou_loja',100),ev('saiu_loja',130)];
  const novos=ausentes([...primeira,...segunda],primeira,desde,ate);
  assert.equal(novos.length,2);assert.equal(+novos[0].em,+segunda[0].em);
  assert.deepEqual(ausentes([...primeira,...segunda],[...primeira,...novos],desde,ate),[]);
});
test('Revalidação aceita datas ISO e visita aberta, sem duplicar chegada',()=>{
  const novos=ausentes([ev('chegou_loja',10)],[],desde,ate);
  assert.deepEqual(ausentes(novos,[ev('chegou_loja',10)],desde,ate),[]);
});
test('Boot manobrando no pátio registra saída sem inventar chegada e conserva histerese',()=>{
  const fab={...loja,codigo:'FABRICA'},det=criarDetector();
  assert.deepEqual(det.processar(ponto(0,{velocidade:12}),[fab]),[]);
  assert.deepEqual(det.processar(ponto(1,{lat:loja.lat+.0025,velocidade:12}),[fab]),[]);
  assert.deepEqual(det.processar(ponto(2,{lat:loja.lat+.005,velocidade:20}),[fab]),[]);
  const [saida]=det.processar(ponto(3,{lat:loja.lat+.006,velocidade:20}),[fab]);
  assert.equal(saida.tipo,'saiu_fabrica');assert.equal(+saida.em,base);
});
test('Retorno à fábrica com sinais espaçados conserva hora da primeira posição parada',()=>{
  const fab={...loja,codigo:'FABRICA'};
  const eventos=reconstruir([ponto(0,{lat:loja.lat+.006,velocidade:30}),ponto(1),ponto(16,{motor:'desligado'})],[fab]);
  assert.equal(eventos.length,1);assert.equal(eventos[0].tipo,'voltou_fabrica');assert.equal(+eventos[0].em,base+60000);
});
test('Visita encerrada recebe evento; placa com duas viagens não recebe associação arbitrária',()=>{
  const v={id:1,placa:'FKA0C10',data_viagem:'2026-10-08',status:'Finalizada',rota_nome:'Z.OESTE II'};
  assert.equal(donoDoEvento(ev('chegou_loja',10),[v]),v);
  assert.equal(donoDoEvento(ev('chegou_loja',10),[v,{...v,id:2}]),null);
});
test('Dia seguinte associa pernoite; viagem nova no dia tem prioridade',()=>{
  const v={id:1,placa:'FKA0C10',data_viagem:'2026-10-07',rota_nome:'R.LAGOS'};
  assert.equal(donoDoEvento(ev('chegou_loja',10),[v]),v);
  const nova={...v,id:2,data_viagem:'2026-10-08'};
  assert.equal(donoDoEvento(ev('chegou_loja',10),[v,nova]),nova);
});
test('Consulta por placa aplica filtro no SQL antes do limite de 500',async()=>{
  let consulta;
  await listar({query:async(sql,params)=>{consulta={sql,params};return {rows:[]};}},'2026-10-08',{placa:'FKA0C10'});
  assert.deepEqual(consulta.params,['2026-10-08','FKA0C10']);
  assert.ok(consulta.sql.indexOf('placa=$2')<consulta.sql.indexOf('LIMIT 500'));
});
test('Evento de uma loja não marca a vizinha como visitada nem inicia retorno antecipado',()=>{
  const vizinha={...loja,codigo:'B',lat:loja.lat+.0005};
  const v={id:1,data_viagem:'2026-10-08',status:'Em rota',saida_real:'06:00',
    paradas:[{loja_codigo_pes:'A'},{loja_codigo_pes:'B'}]};
  const a=decidir(v,[ev('chegou_loja',10)],new Map([['A',loja],['B',vizinha]]),new Date(base+60*60000));
  assert.equal(a.retorno,undefined);
});

test('SQL real recupera eventos em viagem finalizada, mantém horários manuais e suporta retry sem duplicata',
  {skip:process.env.TMS_TEST_PG!=='1'},async()=>{
  const db=require('../db'),c=await db.connect();
  try {
    await c.query(`CREATE TEMP TABLE tms_viagens(id int PRIMARY KEY,placa text,data_viagem date,status text,rota_nome text,saida_real time,retorno_real time);
      CREATE TEMP TABLE tms_paradas(id int PRIMARY KEY,viagem_id int,loja_nome text,ordem int,loja_id int);
      CREATE TEMP TABLE sistema_config(chave text,valor jsonb);
      CREATE TEMP TABLE tms_veiculos(placa text,modelo text,tipo_frete text,tipo_frete_assumido bool);
      CREATE TEMP TABLE lojas_pes(codigo text,pes text,nome text,chave text,apelidos text[],ativo bool);
      CREATE TEMP TABLE distancias_loja(origem text,destino text,km numeric);
      CREATE TEMP TABLE cadastros(tipo text,valor text,extra jsonb);
      CREATE TEMP TABLE docas(id int,loja text,carrinho_4_rodas bool,carrinho_2_rodas bool,sem_carrinho_apos_horario bool,horario text);
      CREATE TEMP TABLE rastreador_posicoes(placa text,fonte text,device_id int,lat float8,lng float8,velocidade numeric,motor text,posicao_em timestamptz);
      CREATE TEMP TABLE rastreador_eventos_loja(id bigserial PRIMARY KEY,placa text,tipo text,lugar_codigo text,lugar_nome text,em timestamptz,
        viagem_id int,parada_id int,lat float8,lng float8,fonte text,permanencia_min int,detalhe text,UNIQUE(placa,tipo,lugar_codigo,em));
      INSERT INTO tms_viagens VALUES(1,'FKA0C10','2026-10-08','Finalizada','Z.OESTE II','06:15','15:00');
      INSERT INTO tms_paradas VALUES(1,1,'Loja A',1,100);
      INSERT INTO lojas_pes VALUES('A','A','Loja A','LOJA A','{}',true);
      INSERT INTO tms_veiculos(placa) VALUES('FKA0C10');`);
    for(const nome of ['tms_viagens','tms_paradas','rastreador_eventos_loja','rastreador_posicoes'])
      assert.equal((await c.query(`SELECT '${nome}'::regclass::oid='pg_temp.${nome}'::regclass::oid AS segura`)).rows[0].segura,true);
    const pts=[ponto(0,{lat:loja.lat+.006,velocidade:30}),ponto(10),ponto(11),ponto(40,{lat:loja.lat+.006,velocidade:30})];
    for(const p of pts)await c.query('INSERT INTO rastreador_posicoes VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [p.placa,p.fonte,p.device_id,p.lat,p.lng,p.velocidade,p.motor,p.posicao_em]);
    const banco={query:(...args)=>c.query(...args),connect:async()=>({query:(...args)=>c.query(...args),release(){}})};
    const avisos=[],rastreador={coordenadas:async()=>new Map([['A',loja]])};
    const svc=criar({db:banco,rastreador,broadcastEvento:(_tipo,e)=>avisos.push(e)});
    const plano=await svc.planejar({desde,ate});assert.equal(plano.eventos.length,2);
    assert.equal((await svc.aplicar(plano)).length,2);assert.equal(avisos.length,2);
    assert.equal((await svc.aplicar(plano)).length,0);
    assert.equal((await svc.planejar({desde,ate})).eventos.length,0);
    assert.equal((await c.query('SELECT count(*)::int n FROM rastreador_eventos_loja')).rows[0].n,2);
    assert.deepEqual((await c.query('SELECT saida_real,retorno_real,status FROM tms_viagens')).rows[0],
      {saida_real:'06:15:00',retorno_real:'15:00:00',status:'Finalizada'});
    await c.query('DELETE FROM rastreador_eventos_loja');
    let inserts=0;
    const falha=criar({rastreador,db:{query:banco.query,connect:async()=>({query:async(sql,args)=>{
      if(sql.includes('INSERT INTO rastreador_eventos_loja') && ++inserts===2)throw Error('falha de evento');return c.query(sql,args);
    },release(){}})},broadcastEvento:()=>assert.fail('sem aviso antes do commit')});
    await assert.rejects(falha.aplicar(plano),/falha de evento/);
    assert.equal((await c.query('SELECT count(*)::int n FROM rastreador_eventos_loja')).rows[0].n,0);
    await c.query("UPDATE tms_viagens SET placa='FKB1D11'");
    assert.equal((await svc.aplicar(plano)).length,0,'não grava se a viagem mudou de placa');
  }finally{await c.query('ROLLBACK').catch(()=>{});c.release();await db.pool.end();}
});
