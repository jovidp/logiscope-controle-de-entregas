'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const ctx={escapar: v => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),window:{location:{origin:'http://localhost'}},document:{addEventListener(){},getElementById(){return null;}}};
vm.runInNewContext(fs.readFileSync(require.resolve('../../public/js/tms.js'),'utf8'),ctx);
const registro={ocorrencia_id:1465,status:'Entregue com ocorrencia',ocorrencia_hora_chegada:'09:03',ocorrencia_inicio_descarga:'09:10',ocorrencia_termino_descarga:'09:25',ocorrencia_saida_loja:'09:07'};
test('TMS mostra todos os horários registrados mesmo após concluir a parada',()=>{
  const html=ctx.tmsHorariosParadaHtml(registro);assert.match(html,/Registro: chegada 09:03/);assert.match(html,/descarga 09:10–09:25/);assert.match(html,/saída 09:07/);
});
test('Horário do registro e primeira leitura do GPS aparecem separados',()=>{
  const html=ctx.tmsHorariosParadaHtml({...registro,gps_chegou_em:'2026-10-08T11:06:10Z',gps_saiu_em:'2026-10-08T11:10:11Z'});
  assert.match(html,/Registro: chegada 09:03/);assert.match(html,/GPS: primeiro sinal na loja 08:06 · saída 08:10/);
});
test('GPS sem registro mostra a evidência e o aviso de confirmação espaçada',()=>{
  const html=ctx.tmsHorariosParadaHtml({gps_chegou_em:'2026-10-08T15:23:32Z',gps_chegada_detalhe:'primeiro sinal na loja; confirmado com sinais espaçados às 2026-10-08T15:28:58Z'});
  assert.match(html,/GPS: primeiro sinal na loja 12:23/);assert.match(html,/confirmação com sinais espaçados/);assert.doesNotMatch(html,/Registro:/);
  assert.equal(ctx.tmsHorariosParadaHtml({status:'Pendente'}),'');
});
test('Saída de fábrica informada no registro não substitui um marco real',()=>{
  const paradas=[{ocorrencia_id:1,ocorrencia_saida_fabrica:'07:19'},{ocorrencia_id:2,ocorrencia_saida_fabrica:'07:19'}];
  assert.match(ctx.tmsHorariosViagemHtml({paradas}),/Saída fábrica informada nos registros: 07:19/);
  assert.equal(ctx.tmsHorariosViagemHtml({paradas,saida_real:'07:20:00'}),'');
  assert.match(ctx.tmsHorariosViagemHtml({paradas:[...paradas,{ocorrencia_id:3,ocorrencia_saida_fabrica:'07:30'}]}),/registros divergentes/);
});
test('Horários inexistentes ou inválidos não são inventados na tela',()=>{
  assert.equal(ctx.tmsHorariosParadaHtml({ocorrencia_id:1,ocorrencia_hora_chegada:'<script>'}),'');
  assert.equal(ctx.tmsHorariosViagemHtml({paradas:[{ocorrencia_id:1,ocorrencia_saida_fabrica:'<script>'}]}),'');
});
