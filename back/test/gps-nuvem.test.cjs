'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {criar}=require('../rastreador-nuvem');
const agora=Date.parse('2026-10-09T12:00:00Z');
const url='https://seuprojetosupabase.supabase.co/functions/v1/gps-coleta';
const ponto=(extra={})=>({id:1,fonte:'sat',device_id:5,placa:'FKS4U24',nome:'Scudo',lat:-22.9,lng:-43.2,
  velocidade:0,motor:'desligado',rumo:0,posicao_em:'2026-10-08T08:00:00Z',criado_em:'2026-10-08T08:00:01.123456+00:00',...extra});
function cenario({pontos=[ponto()],falhar=false,cfg=null}={}) {
  const comandos=[],updates=[],pedidos=[];
  const db={query:async(sql,params)=>{comandos.push({sql,params});if(sql.startsWith('SELECT valor'))return {rows:cfg?[{valor:cfg}]:[]};
    if(falhar && sql.startsWith('INSERT INTO rastreador_posicoes'))throw new Error('banco indisponivel');return {rows:[],rowCount:1};}};
  const fetcher=async(u,o)=>{pedidos.push({u:String(u),o});return Response.json({sinais:pontos,proximo:pontos.length?{em:pontos.at(-1).criado_em,id:String(pontos.at(-1).id)}:{em:'2026-10-08T08:00:01Z',id:'0'}});};
  const rastreador={gravarAparelhos:async(...a)=>updates.push(a)};
  const worker=criar({db,rastreador,env:{GPS_NUVEM_URL:url,GPS_LEITURA_TOKEN:'x'.repeat(40)},fetcher,agora:()=>agora});
  return {worker,comandos,updates,pedidos};
}
test('Importa sinais de ontem e mantem microssegundos do cursor',async()=>{
  const c=cenario();await c.worker.sincronizar();
  assert.ok(c.comandos.some(x=>x.sql.startsWith('INSERT INTO rastreador_posicoes')));
  const checkpoint=c.comandos.find(x=>x.sql.startsWith('INSERT INTO sistema_config'));
  assert.equal(JSON.parse(checkpoint.params[1]).em,ponto().criado_em);
  assert.equal(c.updates.length,0); // sinal de 28h fica no historico
});
test('Falha de persistencia nao avanca cursor e permite tentar novamente',async()=>{
  const c=cenario({falhar:true});await assert.rejects(c.worker.sincronizar(),/indisponivel/);
  assert.ok(!c.comandos.some(x=>x.sql.startsWith('INSERT INTO sistema_config')));
  await assert.rejects(c.worker.sincronizar(),/indisponivel/);assert.equal(c.pedidos.length,2);
});
test('Consulta sobreposicao de cinco minutos para nao perder commits atrasados',async()=>{
  const c=cenario({pontos:[],cfg:{url,em:'2026-10-09T11:00:00Z',id:'7'}});await c.worker.sincronizar();
  assert.equal(new URL(c.pedidos[0].u).searchParams.get('desde'),'2026-10-09T10:55:00.000Z');
});
test('Sinal recente atualiza aparelhos pela validacao existente',async()=>{
  const c=cenario({pontos:[ponto({posicao_em:new Date(Date.now()-60000).toISOString(),criado_em:new Date(Date.now()-59000).toISOString()})]});
  await c.worker.sincronizar();assert.equal(c.updates[0][1],'sat');assert.equal(c.updates[0][2][0].device_id,5);
});
test('Coordenada invalida nao e gravada nem confirmada',async()=>{
  const c=cenario({pontos:[ponto({lat:0,lng:0})]});await assert.rejects(c.worker.sincronizar(),/invalidos/);
  assert.ok(!c.comandos.some(x=>x.sql.startsWith('INSERT')));
});
test('Sem configuracao de nuvem nao consulta rede nem banco',async()=>{
  const worker=criar({db:{query:()=>{throw Error('nao deve consultar');}},rastreador:{},env:{}});
  assert.deepEqual(await worker.sincronizar(),{sinais:0});
});
