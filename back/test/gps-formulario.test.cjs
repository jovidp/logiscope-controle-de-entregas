'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
function ambiente(eventos,extra={}) {
  const campos={};
  for(const id of ['placa','dataOcorrencia','loja','diaSeguinte','hora_chegada','saidaLoja','horaSaidaFabrica'])
    campos[id]={value:'',checked:false,title:'',classList:{add(){},remove(){}},dispatchEvent(){}};
  Object.assign(campos.placa,{value:'FKA0C10'});Object.assign(campos.dataOcorrencia,{value:'2026-10-08'});Object.assign(campos.loja,{value:'SULACAP'});
  const ctx={window:{gpsEventosDoDia:async()=>eventos,...extra},document:{readyState:'loading',getElementById:id=>campos[id],addEventListener(){}},
    Date,Intl,URLSearchParams,console,Event:class{},setTimeout(){},clearTimeout(){}};
  let fonte=fs.readFileSync(require.resolve('../../public/js/form-automatico'),'utf8');
  fonte=fonte.replace('let _timerGps = null;','window.completarGpsTeste = completarDoGps; window.completarTmsTeste = completarDoTms; let _timerGps = null;');
  vm.runInNewContext(fonte,ctx);
  return {campos,ctx,completar:()=>ctx.window.completarGpsTeste()};
}
const evento=(tipo,hora,extra={})=>({tipo,em:`2026-10-08T${hora}:00-03:00`,lugar_nome:'SULACAP',placa:'FKA0C10',...extra});
test('Preenche saída GPS quando só a saída foi captada; preserva chegada vazia e horários manuais',async()=>{
  const a=ambiente([evento('saiu_loja','14:16')]);await a.completar();
  assert.equal(a.campos.saidaLoja.value,'14:16');assert.equal(a.campos.hora_chegada.value,'');
  a.campos.saidaLoja.value='14:30';await a.completar();assert.equal(a.campos.saidaLoja.value,'14:30');
});
test('Resposta de outra loja, data, parada ou pernoite não preenche o formulário atual',async()=>{
  for(const trocar of [a=>a.campos.loja.value='BANGU',a=>a.campos.dataOcorrencia.value='2026-10-07',
    a=>a.campos.diaSeguinte.checked=true,a=>a.ctx.window.tmsOcorrenciaContexto={viagem_id:281,parada_id:9}]) {
    let concluir;const a=ambiente([],{gpsEventosDoDia:()=>new Promise(r=>concluir=r)});
    const pendente=a.completar();trocar(a);concluir([evento('chegou_loja','13:26'),evento('saiu_loja','14:16')]);await pendente;
    assert.equal(a.campos.hora_chegada.value,'');assert.equal(a.campos.saidaLoja.value,'');
  }
});
test('Parada de outra viagem não é usada pelo nome e a última saída inclui revisitas',async()=>{
  const a=ambiente([evento('chegou_loja','11:00',{viagem_id:99,parada_id:1}),
    evento('chegou_loja','13:26',{viagem_id:281,parada_id:1704}),evento('saiu_loja','13:40',{viagem_id:281,parada_id:1704}),
    evento('saiu_loja','14:16',{viagem_id:281,parada_id:1704})],{tmsOcorrenciaContexto:{viagem_id:281,parada_id:1704}});
  await a.completar();assert.equal(a.campos.hora_chegada.value,'13:26');assert.equal(a.campos.saidaLoja.value,'14:16');
});
test('Saída anterior à chegada manual e visita ambígua não são preenchidas',async()=>{
  const a=ambiente([evento('saiu_loja','12:00')]);a.campos.hora_chegada.value='13:00';await a.completar();assert.equal(a.campos.saidaLoja.value,'');
  const b=ambiente([evento('chegou_loja','13:26',{lugar_nome:'SULACAP / BANGU',detalhe:'GPS não separa: A, B'})]);
  await b.completar();assert.equal(b.campos.hora_chegada.value,'');
});
test('Manobra antiga não vira saída da fábrica quando há saída real da viagem',async()=>{
  const a=ambiente([evento('saiu_fabrica','05:30'),evento('chegou_loja','13:26')],{tmsOcorrenciaContexto:{viagem_id:281,parada_id:1704}});
  a.ctx.tmsState={viagens:[{id:281,saida_real:'06:15:00'}]};await a.completar();assert.equal(a.campos.horaSaidaFabrica.value,'06:15');
});

test('Complemento TMS também descarta consulta pendente quando a loja muda',async()=>{
  let concluir;
  const a=ambiente([],{tmsOcorrenciaContexto:{viagem_id:281,parada_id:1704},gpsEventosDoDia:()=>new Promise(r=>concluir=r)});
  a.ctx.tmsState={viagens:[{id:281,saida_real:'06:15',paradas:[{id:1704,hora_prevista:'13:00'}]}]};
  const pendente=a.ctx.window.completarTmsTeste(281,1704);
  a.campos.loja.value='BANGU';concluir([]);await pendente;
  assert.equal(a.campos.horaSaidaFabrica.value,'');
});
