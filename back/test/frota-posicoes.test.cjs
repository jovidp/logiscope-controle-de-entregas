'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {criarColetaFontes}=require('../rastreador-coleta');
const {criar}=require('../frota-posicoes');
const DATA='2026-10-06';
function tela(fetch){
  const listeners={},timers=[];
  const ctx={window:{},document:{hidden:false,addEventListener:(k,f)=>listeners[k]=f},fetch,AbortSignal,setInterval:(f,ms)=>{timers.push({f,ms});return timers.length;}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../public/js/frota-posicoes.js'),'utf8'),ctx);
  return {api:ctx.window.frtPosicoes,listeners,timers};
}
const painel=()=>({hoje:true,data:DATA,gerado_em:'2026-10-06T18:00:00Z',veiculos:[{placa:'A',atual:{lat:1},dia:{km:20},viagem:{id:1},visitas:[{codigo:'L'}],rastro:[[1,1]]}]});
const snapshot=(extra={})=>({data:DATA,gerado_em:'2026-10-06T18:00:10Z',coleta_intervalo_s:5,plataformas:{srf:{ultima_coleta:'agora'}},veiculos:[{placa:'A',atual:{lat:2},fontes:[]}],...extra});
test('Consulta lenta nao duplica a mesma fonte nem impede outras plataformas',async()=>{
  const c=criarColetaFontes();let liberar,consultas=0,rapidas=0;
  const lento=new Promise(ok=>liberar=ok),a=c.executar('t4s',()=>{consultas++;return lento;}),b=c.executar('t4s',()=>assert.fail('duplicou'));
  assert.equal(a,b);
  await c.executar('srf',()=>rapidas++);await c.executar('srf',()=>rapidas++);
  assert.equal(consultas,1);assert.equal(rapidas,2);liberar('ok');assert.equal(await a,'ok');
});
test('Falha na consulta libera a fonte para a proxima tentativa',async()=>{
  const c=criarColetaFontes();await assert.rejects(c.executar('sat',()=>{throw Error('temporario');}));
  assert.equal(await c.executar('sat',()=>42),42);
});
test('Posicao atualizada preserva viagem, visitas, km e rastro',()=>{
  const t=tela(),p=painel(),r=t.api.mesclar(p,snapshot());assert.equal(r.veiculos[0].atual.lat,2);assert.equal(r.coleta_intervalo_s,5);
  for(const k of ['dia','viagem','visitas','rastro'])assert.equal(r.veiculos[0][k],p.veiculos[0][k]);
});
test('Snapshot antigo nao regride posicao e nao altera dia passado',()=>{
  const t=tela(),p=painel();assert.equal(t.api.mesclar(p,snapshot({gerado_em:'2026-10-06T17:59:00Z'})),p);
  const passado={...p,hoje:false};assert.equal(t.api.mesclar(passado,snapshot()),passado);
  assert.equal(t.api.mesclar(p,snapshot({data:'2026-10-05'})),p);
});
test('Fonte agora invalida apaga posicao anterior sem perder o historico',()=>{
  const t=tela(),p=painel(),r=t.api.mesclar(p,snapshot({veiculos:[{placa:'A',atual:null,fontes:[]}]}));assert.equal(r.veiculos[0].atual,null);assert.equal(r.veiculos[0].dia.km,20);
});
test('Atualizacao de cinco segundos nao cria pedidos sobrepostos',async()=>{
  let liberar,consultas=0,recebidos=0;const pendente=new Promise(ok=>liberar=ok);
  const t=tela(async()=>{consultas++;await pendente;return {ok:true,json:async()=>snapshot()};});
  t.api.iniciar({permitido:()=>true,lerData:()=>DATA,receber:()=>recebidos++});assert.equal(t.timers[0].ms,5000);
  const a=t.api.atualizar();await t.api.atualizar();assert.equal(consultas,1);liberar();await a;assert.equal(recebidos,1);
});
test('Aba oculta nao consulta e resposta de outro dia e descartada',async()=>{
  let permitido=false,consultas=0,recebidos=0;const t=tela(async()=>{consultas++;return {ok:true,json:async()=>snapshot({data:'2026-10-05'})};});
  t.api.iniciar({permitido:()=>permitido,lerData:()=>DATA,receber:()=>recebidos++});await t.api.atualizar();assert.equal(consultas,0);
  permitido=true;await t.api.atualizar();assert.equal(consultas,1);assert.equal(recebidos,0);
});
test('Consulta leve compartilha cache entre usuarios e nao le historico',async()=>{
  let queries=0,atuais=0;
  const r=criar({db:{query:async sql=>{queries++;assert.match(sql,/rastreador_aparelhos/);assert.doesNotMatch(sql,/rastreador_posicoes/);return {rows:[{placa:'A',fonte:'srf',posicao_em:new Date(),device_id:1}]};}},rastreador:{posicoesAtuais:async()=>{atuais++;return [{placa:'A',lat:1}];},estado:{t4s:{},sat:{}},configurado:()=>true,intervaloColetaMs:()=>5000},agoraSP:()=>({data:DATA})});
  const [a,b]=await Promise.all([r.leitura(),r.leitura()]);assert.equal(queries,1);assert.equal(atuais,1);assert.equal(a,b);assert.equal(a.coleta_intervalo_s,5);assert.equal(a.veiculos[0].atual.lat,1);
});