import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarHandler } from '../functions/gps-coleta/handler.mjs';
import { normalizar,mapearSrf,criarPlataformas } from '../functions/gps-coleta/plataformas.mjs';
import { criarBanco,cifrar,decifrar } from '../functions/gps-coleta/banco.mjs';
import { createRequire } from 'node:module';
import { lerLinha } from '../functions/gps-coleta/vendor/t4s-parser.mjs';
import { lerVeiculo } from '../functions/gps-coleta/vendor/sat-parser.mjs';
const require=createRequire(import.meta.url);
const t4sLocal=require('../../back/rastreador-t4s');
const agora=Date.parse('2026-10-09T12:00:00Z');
const env={GPS_COLETA_TOKEN:'c'.repeat(40),GPS_LEITURA_TOKEN:'l'.repeat(40),GPS_SESSAO_CHAVE:'s'.repeat(40),
  SRF_URL:'https://srf.example',SRF_EMAIL:'e',SRF_SENHA:'p',SAT_COOKIE:'_session_id=teste'};
const p={id:4,registration_plate:'FKS4U24',description:'Scudo',last_state:{latitude:-22.9,longitude:-43.2,timestamp:'2026-10-09T11:59:00Z',speed:0,ignition:false}};
test('PostgREST 201 com return=minimal confirma a gravacao sem exigir JSON',async()=>{
  const banco=criarBanco({url:'https://test',chave:'teste',fetcher:async()=>new Response(null,{status:201})});
  assert.equal(await banco.upsert('cloud_gps_estado',{fonte:'sat'}),null);
});
function bancoFalso() {
  const salvos=[],estados=[];
  return {salvos,estados,rpc:async(n,v)=>{
    if(n==='gps_tentar_coleta')return true;
    if(n==='gps_salvar_sinais'){salvos.push(v);return v.p_lista.length;}
    return null;},lerSessoes:async()=>[],upsert:async(t,v)=>estados.push({t,v}),estado:async()=>[],sinais:async()=>[]};
}
test('Sem autenticacao nao consulta plataformas ou banco; token de leitura nao coleta',async()=>{
  const handler=criarHandler({env,banco:{},fetcher:()=>{throw Error('nao deve consultar');}});
  assert.equal((await handler(new Request('https://test',{method:'POST'}))).status,401);
  assert.equal((await handler(new Request('https://test',{method:'POST',headers:{Authorization:`Bearer ${env.GPS_LEITURA_TOKEN}`}}))).status,401);
});
test('Falha no SRF nao impede guardar o sinal da Sat',async()=>{
  const banco=bancoFalso();const fetcher=async url=>{
    if(String(url).includes('srf.example'))throw Error('rede fora: cookie=segredo');
    return Response.json([p]);};
  const handler=criarHandler({env,banco,fetcher,agora:()=>agora});
  const r=await handler(new Request('https://test',{method:'POST',headers:{Authorization:`Bearer ${env.GPS_COLETA_TOKEN}`}}));
  assert.equal(r.status,200);assert.equal(banco.salvos[0].p_fonte,'sat');
  assert.ok(!(await r.text()).includes('segredo'));
});
test('Coleta concorrente nao consulta plataformas quando trava ja esta tomada',async()=>{
  const banco={rpc:async()=>false};
  const handler=criarHandler({env,banco,fetcher:()=>{throw Error('nao deve consultar');}});
  const r=await handler(new Request('https://test',{method:'POST',headers:{Authorization:`Bearer ${env.GPS_COLETA_TOKEN}`}}));
  assert.deepEqual(await r.json(),{ocupado:true});
});
test('Leitura nao devolve cookies e rejeita injecao no cursor',async()=>{
  const handler=criarHandler({env,banco:bancoFalso()});
  const headers={Authorization:`Bearer ${env.GPS_LEITURA_TOKEN}`};
  assert.equal((await handler(new Request('https://test?desde=or.evil',{headers}))).status,400);
  const r=await handler(new Request('https://test?desde=2026-10-09T11:59:01.123456%2B00:00&id=2',{headers}));
  assert.equal(r.status,200);assert.equal((await r.json()).sinais.length,0);
});
test('Sessao cifrada so pode ser lida com a chave correta',async()=>{
  const texto='cookie_secreto';const c=await cifrar(texto,env.GPS_SESSAO_CHAVE);
  assert.ok(!c.includes(texto));assert.equal(await decifrar(c,env.GPS_SESSAO_CHAVE),texto);
  await assert.rejects(decifrar(c,'outra'.repeat(10)));
});
test('Normalizacao preserva hora GPS, rejeita futuro e coordenadas invalidas',()=>{
  const lista=[lerVeiculo(p),{...lerVeiculo(p),lat:0,lng:0},{...lerVeiculo(p),posicao_em:new Date(agora+120000)}];
  const n=normalizar(lista,'sat',agora);assert.equal(n.length,1);assert.equal(Date.parse(n[0].posicao_em),Date.parse(p.last_state.timestamp));
  assert.equal(n[0].motor,'desligado');
});
test('Parser T4S da nuvem tem o mesmo resultado do parser de producao',()=>{
  const celulas=Array.from({length:15},(_,i)=>`<td>${i===9?'09/10/2026 08:59:00 -03:00':i===11?'Off':i===14?'0':''}</td>`).join('');
  const tr=`<input class="checkboxVehicle" value="9|tec|-22.9|-43.2|09/10/2026 09:00:00 -03:00|FKS4U24|1">${celulas}`;
  assert.deepEqual(lerLinha(tr),t4sLocal.lerLinha(tr));
});
test('SRF normaliza placa antiga para Mercosul usando o horario do aparelho',()=>{
  const x=mapearSrf([{items:[{id:1,name:'FKO1015 - Accelo',lat:-22.9,lng:-43.2,timestamp:agora/1000,speed:0}]}])[0];
  assert.equal(x.placa,'FKF5H15');assert.equal(+x.posicao_em,agora);
});
test('Renovacao do cookie Sat e persistida para sobreviver a outro worker',async()=>{
  const sessoes={},salvas=[];
  const plataformas=criarPlataformas({env,sessoes,salvarSessao:async(f,v)=>salvas.push({f,v}),
    fetcher:async()=>Response.json([p],{headers:{'Set-Cookie':'_session_id=renovada; Path=/'}})});
  await plataformas.sat();assert.equal(salvas[0].v.cookie,'_session_id=renovada');
});
