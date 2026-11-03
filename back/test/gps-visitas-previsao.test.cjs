'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {criarDetector,anexarVisitas}=require('../rastreador-ao-vivo');
const {reconstruir,ausentes}=require('../rastreador-recuperacao');
const {preverViagens,alertasDoDia}=require('../previsao-tms');
const {resumoViagem}=require('../frota');
const loja={codigo:'554',nome:'NOVA FRIBURGO',lat:-22.2883829,lng:-42.5321289,raio_entrada_m:80,raio_saida_m:150,perfil:'rua'};
const p=(hora,lat,lng,velocidade=0,extra={})=>({placa:'FKB1D11',fonte:'t4s',device_id:1,motor:'ligado',posicao_em:`2026-10-08T${hora}-03:00`,lat,lng,velocidade,...extra});
const antes=p('17:57:34',-22.289356,-42.532031,15);
const chegada=p('17:59:34',-22.288591,-42.532678);
const borda=p('18:01:34',-22.288623,-42.532881);
const ficou=p('18:03:34',borda.lat,borda.lng);
const saiu=p('18:10:34',-22.286,-42.532881,20);
const t={coordenadas:new Map([['554',loja],['T',{codigo:'T',nome:'TERESÓPOLIS',lat:-22.41,lng:-42.97}]]),
  trecho:new Map([['FABRICA|554',60],['554|T',60]]),descarga:new Map(),descargaGeral:30,kmPorMin:.5};
const idx={dist:new Map()},agora={data:'2026-10-09',min:9*60};
const viagem=(extra={})=>({id:277,placa:'FKB1D11',data_viagem:'2026-10-08',rota_nome:'ALTERNATIVA I',status:'Em rota',saida_real:'05:09',
  paradas:[{id:1685,ordem:1,loja_nome:'NOVA FRIBURGO',loja_codigo_pes:'554',status:'Pendente'},
    {id:1687,ordem:2,loja_nome:'TERESÓPOLIS',loja_codigo_pes:'T',status:'Pendente'}],...extra});
const ctx={escapar:String,window:{location:{origin:'http://localhost'}},document:{addEventListener(){},getElementById(){return null;}}};
vm.runInNewContext(fs.readFileSync(require.resolve('../../public/js/tms.js'),'utf8'),ctx);

test('Nova Friburgo: confirma a visita de ontem apesar de oscilação de 21 m na borda',()=>{
  const eventos=reconstruir([antes,chegada,borda,ficou,saiu],[loja]);
  assert.deepEqual(eventos.map(e=>e.tipo),['chegou_loja','saiu_loja']);
  assert.equal(eventos[0].em.toISOString(),'2026-10-08T20:59:34.000Z');
  assert.equal(eventos[1].em.toISOString(),'2026-10-08T21:10:34.000Z');
  assert.match(eventos[0].detalhe,/oscilação na borda/);
  assert.deepEqual(ausentes(eventos,eventos,'2026-10-08T03:00Z','2026-10-09T12:00Z'),[]);
});
test('Borda exige leitura prévia dentro, parada e continuidade do mesmo aparelho',()=>{
  for(const alterada of [{...borda,velocidade:13},{...borda,fonte:'srf'},{...borda,device_id:2},
    {...borda,posicao_em:'2026-10-08T21:10:34Z'},{...borda,lng:-42.5335}]) {
    const d=criarDetector();d.processar(antes,[loja]);d.processar(chegada,[loja]);
    assert.deepEqual(d.processar(alterada,[loja]),[]);
  }
  assert.equal(reconstruir([antes,borda,ficou],[loja]).length,0);
});
test('Borda não amplia área manual, polígono, loja vizinha ou área sobreposta',()=>{
  for(const l of [{...loja,area_personalizada:true},{...loja,ajuste_proximidade:{reduzida:true}},
    {...loja,poligono:[[loja.lat-.0001,loja.lng-.0001],[loja.lat+.0001,loja.lng-.0001],[loja.lat,loja.lng+.0001]]}]) {
    assert.equal(reconstruir([antes,chegada,borda],[l]).length,0);
  }
  const vizinha={...loja,codigo:'X',lat:borda.lat,lng:borda.lng};
  assert.equal(reconstruir([antes,chegada,borda],[loja,vizinha]).filter(e=>e.tipo==='chegou_loja').length,0);
});
test('Visita recuperada ontem sai da previsão de hoje e continua sem entrega registrada',async()=>{
  const v=viagem();const eventos=reconstruir([antes,chegada,borda,ficou,saiu],[loja])
    .map(e=>({...e,lugar_codigo:e.lugar.codigo,viagem_id:277,parada_id:1685}));
  await anexarVisitas({query:async sql=>({rows:sql.includes('rastreador_eventos_loja')?eventos:[]})},[v],{diasAtras:100000});
  preverViagens([v],idx,t,agora);
  const parada=v.paradas[0];assert.equal(parada.eta,undefined);assert.equal(parada.sem_registro_fonte,'gps');
  assert.equal(parada.status,'Pendente');assert.equal(parada.ocorrencia_id,undefined);
  assert.equal(resumoViagem(v).proxima,'TERESÓPOLIS');assert.equal(resumoViagem(v).paradas_visitadas,1);
  const html=ctx.tmsEtaParadaHtml(parada,v);assert.match(html,/visitada em 08\/10\/2026/);assert.doesNotMatch(html,/chega ~/);
});
test('Evento de chegada aberto ontem não mantém no local quando o GPS já está longe ou antigo',()=>{
  for(const gps of [undefined,{lat:-22.41,lng:-42.97,velocidade:0,estado:'parado',posicao_em:'2026-10-09T11:59Z',confiavel_eventos:true},
    {lat:loja.lat,lng:loja.lng,velocidade:0,estado:'sem_sinal',posicao_em:chegada.posicao_em,confiavel_eventos:false,fonte_motivo:'ultimo_sinal_antigo'}]) {
    const v=viagem({rastreador:gps});Object.assign(v.paradas[0],{gps_chegou_em:chegada.posicao_em,gps_chegou_rel:1079,gps_no_local:true});
    preverViagens([v],idx,t,agora);assert.equal(v.paradas[0].no_local,undefined);assert.equal(v.paradas[0].gps_no_local,false);
    assert.notEqual(resumoViagem(v).atual,'NOVA FRIBURGO');assert.equal(v.paradas[0].sem_registro_fonte,'gps');
  }
});
test('Recalcular mesmo objeto limpa chegada prevista, no local e retorno antigos',()=>{
  const v=viagem();preverViagens([v],idx,t,agora);assert.ok(v.paradas[0].eta);
  Object.assign(v.paradas[0],{gps_chegou_em:chegada.posicao_em,gps_chegou_rel:1079,gps_saiu_em:saiu.posicao_em,gps_saiu_rel:1090});
  preverViagens([v],idx,t,agora);assert.equal(v.paradas[0].eta,undefined);assert.equal(v.paradas[0].eta_em,undefined);
  assert.equal(alertasDoDia([v],agora).some(a=>a.tipo==='eta_atraso'&&a.titulo.includes('FRIBURGO')),false);
  v.status='Finalizada';preverViagens([v],idx,t,agora);assert.equal(v.retorno_previsto,undefined);
  assert.equal(v.paradas[1].eta,undefined);
});
test('Evento sem viagem no dia atual pertence à viagem atual antes de um pernoite antigo',async()=>{
  const antiga=viagem(),nova=viagem({id:300,data_viagem:'2026-10-09'});
  const e={placa:'FKB1D11',tipo:'chegou_loja',lugar_codigo:'554',em:'2026-10-09T11:00Z',viagem_id:null};
  const db={query:async sql=>({rows:sql.includes('rastreador_eventos_loja')?[e]:[]})};
  await anexarVisitas(db,[antiga,nova],{diasAtras:100000});
  assert.equal(antiga.paradas[0].gps_chegou_em,undefined);assert.equal(nova.paradas[0].gps_chegou_em,'2026-10-09T11:00:00.000Z');
  await anexarVisitas({query:async()=>({rows:[]})},[nova],{diasAtras:100000});
  assert.equal(nova.paradas[0].gps_chegou_em,undefined);assert.equal(nova.paradas[0].gps_no_local,undefined);
});
test('Previsão vencida e dia absoluto não aparecem como chegada futura de hoje',()=>{
  const html=ctx.tmsEtaParadaHtml({eta:'18:30',eta_em:'2026-10-08T21:30Z',eta_passou:true});
  assert.match(html,/08\/10\/2026 vencida/);assert.doesNotMatch(html,/chega ~/);
  const v=viagem({rastreador:{lat:-22.41,lng:-42.97,velocidade:30,estado:'movendo',posicao_em:'2026-10-09T11:59Z',confiavel_eventos:true}});
  preverViagens([v],idx,t,agora);assert.ok(v.paradas[0].eta_em.startsWith('2026-10-09'));
});
