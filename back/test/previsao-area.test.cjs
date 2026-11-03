'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {preverViagens, alertasDoDia} = require('../previsao-tms');
const {resumoViagem} = require('../frota');
const park = {codigo:'455',lat:-22.926973978559317,lng:-43.57653699983051,raio_entrada_m:250};
const tempos = {coordenadas:new Map([['455',park],['395',{codigo:'395',lat:-22.94,lng:-43.58}]]),
  trecho:new Map([['FABRICA|455',60],['455|395',15]]),descarga:new Map(),descargaGeral:30,kmPorMin:0.5};
const idx = {dist:new Map()};
const agora = {data:'2026-10-09',min:8*60+38};
function calcular(gps, coordenadas=tempos.coordenadas) {
  const v={id:284,placa:'FKA0C10',data_viagem:agora.data,status:'Em rota',saida_real:'08:02:00',
    rastreador:{lat:-22.927,lng:-43.5767,velocidade:13,estado:'sem_sinal',posicao_em:'2026-10-09T11:21:40Z',confiavel_eventos:false,fonte_motivo:'ultimo_sinal_antigo',...gps},
    paradas:[{id:1712,ordem:1,loja_codigo_pes:'455',loja_nome:'PARK',status:'Pendente',hora_prevista:'08:30:00'},
      {id:1713,ordem:2,loja_codigo_pes:'395',loja_nome:'OLINDA ELLIS',status:'Pendente'}]};
  preverViagens([v],idx,{...tempos,coordenadas},agora);
  return v;
}
test('FKA0C10: último sinal no Park não projeta nova chegada nem confirma visita',()=>{
  const v=calcular(); const p=v.paradas[0];
  assert.equal(p.gps_na_area_em,'2026-10-09T11:21:40.000Z');
  assert.equal(p.gps_na_area_antigo,true);
  for(const k of ['eta','no_local','gps_chegou_em','gps_no_local']) assert.equal(p[k],undefined);
  assert.equal(p.status,'Pendente'); assert.equal(v.paradas[1].eta,undefined);
  assert.equal(alertasDoDia([v],agora).some(a=>a.tipo==='eta_atraso'),false);
  const resumo=resumoViagem(v);
  assert.equal(resumo.area_sinal,'PARK');assert.equal(resumo.proxima,null);assert.equal(resumo.paradas_visitadas,0);
});
test('Sinal recente em movimento na área aguarda confirmação de parada',()=>{
  const p=calcular({posicao_em:'2026-10-09T11:37:40Z',estado:'movendo',confiavel_eventos:true,fonte_motivo:'mais_recente'}).paradas[0];
  assert.equal(p.gps_na_area_antigo,false);assert.equal(p.eta,undefined);assert.equal(p.no_local,undefined);
});
test('Sinal recente parado na área conserva no local',()=>{
  const v=calcular({posicao_em:'2026-10-09T11:37:40Z',velocidade:0,estado:'parado',confiavel_eventos:true});const p=v.paradas[0];
  assert.equal(p.no_local,true);assert.equal(p.gps_na_area_em,undefined);
  assert.equal(resumoViagem(v).atual,'PARK');assert.equal(resumoViagem(v).proxima,'OLINDA ELLIS');
  assert.equal(resumoViagem(v).paradas_visitadas,0);
});
test('Área ambígua, sinal de ontem e fontes discordantes não afirmam presença',()=>{
  const ambigua=new Map([...tempos.coordenadas,['X',{...park,codigo:'X'}]]);
  assert.equal(calcular({},ambigua).paradas[0].gps_na_area_em,undefined);
  assert.equal(calcular({posicao_em:'2026-10-08T11:21:40Z'}).paradas[0].gps_na_area_em,undefined);
  assert.equal(calcular({posicao_em:'2026-10-09T11:37:40Z',estado:'movendo',fonte_motivo:'discordancia_sem_consenso'}).paradas[0].gps_na_area_em,undefined);
});
test('Previsão respeita a área menor da loja e usa somente sinal recente',()=>{
  const menor=new Map([...tempos.coordenadas]);menor.set('455',{...park,raio_entrada_m:20});
  const p=calcular({lat:-22.9279,velocidade:0,estado:'parado',posicao_em:'2026-10-09T11:37:40Z',confiavel_eventos:true},menor).paradas[0];
  assert.equal(p.no_local,undefined);assert.equal(p.eta_fonte,'gps');
  const velho=calcular({lat:-22.95,estado:'movendo'}).paradas[0];
  assert.notEqual(velho.eta_fonte,'gps');
});
test('TMS mostra hora do último sinal na área em vez de chegada futura',()=>{
  const ctx={escapar:String,window:{location:{origin:'http://localhost'}},document:{addEventListener(){},getElementById(){return null;}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../../public/js/tms.js'),'utf8'),ctx);
  const html=ctx.tmsEtaParadaHtml(calcular().paradas[0]);
  assert.match(html,/último sinal na área da loja às 08:21/);assert.match(html,/aguardando atualização/);assert.doesNotMatch(html,/chega ~/);
});
