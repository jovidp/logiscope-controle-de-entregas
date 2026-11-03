'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const op=require('../frota-operacao');
const agora=Date.parse('2026-10-06T18:00:00Z'),loja={codigo:'A',nome:'Loja A',lat:-22.9,lng:-43.5,raio_entrada_m:80,raio_saida_m:150};
const ponto=(min=0,extra={})=>({placa:'FKB1D11',lat:-22.9,lng:-43.5,velocidade:0,posicao_em:new Date(agora+min*60000),confiavel_eventos:true,...extra});
const visita=(extra={})=>({codigo:'A',nome:'Loja A',chegou:new Date(agora-100*60000).toISOString(),chegada_vista:true,saiu:null,min:null,...extra});
const perfil=(extra={})=>({placa:'FKB1D11',visita:visita(),atual:ponto(),lugares:[loja],historico:new Map(),agora,...extra});
const viagem=(extra={})=>({id:1,codigo:'V-1',data_viagem:'2026-10-06',status:'Finalizada',placa:'FKB1D11',paradas:[{status:'Entregue'},{status:'Pendente',gps_chegou_em:new Date()},{status:'Recusada'}],...extra});
const percurso={status:'pronto',chave:'v1',pontos:[[-22.9,-43.52],[-22.9,-43.48]]};
const fora=(min=0,extra={})=>ponto(min,{lat:-22.87,velocidade:30,...extra});
test('Referencia por loja exige cinco visitas e usa margem mais conservadora',()=>{
  assert.equal(op.limiteLoja({amostras:4,mediana_min:10}).limite_min,90);
  assert.equal(op.limiteLoja({amostras:5,mediana_min:10}).limite_min,40);
  assert.equal(op.limiteLoja({amostras:10,mediana_min:80}).limite_min,120);
});
test('Historico exclui areas ambiguas, fabrica, carros e visitas incompletas',()=>{
  const v=visita({saiu:new Date(agora).toISOString(),min:100});
  const h=op.historicoLojas([{tipo:'caminhao',visitas:[v,{...v,ambigua:['A','B']},{...v,chegada_vista:false},{...v,fabrica:true},{...v,min:1000},{...v,saiu:null}]},{tipo:'carro',visitas:[v]}]);
  assert.deepEqual(h.get('A'),{amostras:1,mediana_min:100});
});
test('Demora em andamento usa horario do sinal e referencia da propria loja',()=>{
  const a=op.demoraLoja(perfil());assert.equal(a.min,100);assert.equal(a.excedeu,true);assert.equal(a.referencia,'limite_padrao');
  const b=op.demoraLoja(perfil({historico:new Map([['A',{amostras:6,mediana_min:100}]])}));assert.equal(b.excedeu,false);
});
test('Demora nao acusa loja com sinal velho, chegada desconhecida ou sobreposicao',()=>{
  for(const extra of [{atual:ponto(-10)},{atual:ponto(0,{confiavel_eventos:false})},{visita:visita({chegada_vista:false})},{visita:visita({ambigua:['A','B']})},{lugares:[loja,{...loja,codigo:'B'}]},{aoVivo:false}])assert.equal(op.demoraLoja(perfil(extra)),null);
});
test('Visita concluida pode ser consultada em data passada',()=>{
  const x=op.demoraLoja(perfil({atual:null,aoVivo:false,visita:visita({saiu:new Date(agora-10*60000).toISOString()})}));assert.equal(x.min,90);assert.equal(x.em_andamento,false);
});
test('Custos ausentes nao viram zero e GPS ou recusa nao contam como entrega',()=>{
  const c=op.custoViagem(viagem({frete_calc_total:2000}));assert.equal(c.total_cadastrado,null);assert.equal(c.custo_por_entrega,null);assert.equal(c.entregas_confirmadas,1);assert.equal(c.custos_faltando.length,4);assert.equal(c.provisorio,true);
});
test('Custo cadastrado e frete previsto ficam separados, com zero explicito preservado',()=>{
  const c=op.custoViagem(viagem({custo_frete:0,custo_combustivel:100,pedagio:0,outros_custos:50,km_real:100,frete_calc_total:2000}));
  assert.equal(c.total_cadastrado,150);assert.equal(c.custo_por_entrega,150);assert.equal(c.custo_por_km,1.5);assert.equal(c.custos_completos,true);assert.equal(c.provisorio,false);
});
test('Viagem em andamento tem media provisoria e sem entrega nao divide por zero',()=>{
  const c=op.custoViagem(viagem({status:'Em rota',custo_frete:200,custo_combustivel:0,pedagio:0,outros_custos:0,paradas:[],km_real:0}));assert.equal(c.provisorio,true);assert.equal(c.custo_por_entrega,null);assert.equal(c.custo_por_km,null);
});
test('Valores vazios ou negativos sao pendencias de preenchimento',()=>{
  const c=op.custoViagem(viagem({custo_frete:'',custo_combustivel:-1,pedagio:0,outros_custos:null}));assert.equal(c.total_cadastrado,0);assert.deepEqual(c.custos_faltando,['frete','combustível','outros']);
});
test('Percurso usa pontos fixos e ordem da programacao, incluindo retorno',()=>{
  const fab={codigo:'FABRICA',lat:-22.96,lng:-43.6},b={codigo:'B',lat:-22.8,lng:-43.3},chamadas=[];
  const r=op.percursoPlanejado({paradas:[{id:2,ordem:2,loja_codigo_pes:'B'},{id:1,ordem:1,loja_codigo_pes:'A'}]},[fab,loja,b],(a,b)=>{chamadas.push([a.codigo,b.codigo]);return [[a.lat,a.lng],[b.lat,b.lng]];});
  assert.deepEqual(chamadas,[['FABRICA','A'],['A','B'],['B','FABRICA']]);assert.equal(r.status,'pronto');
});
test('Percurso incompleto ou ainda sem geometria nunca usa reta como referencia',()=>{
  const fab={codigo:'FABRICA',lat:-22.96,lng:-43.6},v={paradas:[{loja_codigo_pes:'A'}]};
  assert.equal(op.percursoPlanejado(v,[fab],()=>assert.fail()).status,'sem_coordenadas');
  const r=op.percursoPlanejado(v,[fab,loja],()=>null);assert.equal(r.status,'calculando');assert.deepEqual(r.pontos,[]);
});
test('Desvio exige tempo e leituras distintas; repetir sinal nao confirma',()=>{
  const m=op.criarMonitorDesvio();let r;
  for(let i=0;i<5;i++)r=m.avaliar('FKB1D11',fora(),percurso,1,op.PADRAO,{agora});
  assert.equal(r.leituras,1);assert.equal(r.confirmado,false);
  for(let min=2;min<=10;min+=2)r=m.avaliar('FKB1D11',fora(min),percurso,1,op.PADRAO,{agora:agora+min*60000});
  assert.equal(r.confirmado,true);assert.equal(r.min,10);
});
test('Desvio acaba ao voltar ao percurso e recomeca depois de falta de sinal',()=>{
  const m=op.criarMonitorDesvio();m.avaliar('FKB1D11',fora(),percurso,1,op.PADRAO,{agora});
  const r=m.avaliar('FKB1D11',fora(10),percurso,1,op.PADRAO,{agora:agora+10*60000});assert.equal(r.min,0);
  assert.equal(m.avaliar('FKB1D11',ponto(11,{velocidade:30}),percurso,1,op.PADRAO,{agora:agora+11*60000}).status,'no_percurso');
});
test('Desvio nao confirma com sinal antigo, divergente, percurso pendente ou visita',()=>{
  const m=op.criarMonitorDesvio();
  assert.equal(m.avaliar('X',fora(-10),percurso,1,op.PADRAO,{agora}).status,'sem_sinal_confiavel');
  assert.equal(m.avaliar('X',fora(0,{confiavel_eventos:false}),percurso,1,op.PADRAO,{agora}).status,'sem_sinal_confiavel');
  assert.equal(m.avaliar('X',fora(),{status:'calculando'},1,op.PADRAO,{agora}).confirmado,false);
  assert.equal(m.avaliar('X',fora(),percurso,1,op.PADRAO,{agora,emLoja:true}).status,'na_loja');
});
test('Outra viagem ou mudanca da geometria reinicia a confirmacao',()=>{
  const m=op.criarMonitorDesvio();m.avaliar('X',fora(),percurso,1,op.PADRAO,{agora});
  const r=m.avaliar('X',fora(2),{...percurso,chave:'v2'},2,op.PADRAO,{agora:agora+120000});assert.equal(r.min,0);assert.equal(r.leituras,1);
});
test('Configuracao rejeita vazio, infinito e limites que geram ruido',()=>{
  assert.deepEqual(op.validarConfig(op.PADRAO),op.PADRAO);
  for(const x of [{desvio_min:0},{desvio_m:''},{loja_min:null},{loja_fator:Infinity}])assert.throws(()=>op.validarConfig({...op.PADRAO,...x}));
});
test('Painel oculta custos para perfil de Frota e nega datas invalidas',async()=>{
  const db={query:async sql=>({rows:[]})},diario={garantir:async()=>{},resumoDoDia:async()=>({})};
  const r=op.criar({db,diario,buscarViagensTms:async()=>[viagem()],agoraSP:()=>({data:'2026-10-06'}),registrarAuditoria:async()=>{},roteador:{iniciar:async()=>{},planejado:()=>null},rastreador:{coordenadas:async()=>new Map(),posicoesAtuais:async()=>[],placaMercosul:p=>p}});
  const res={status(n){this.code=n;return this;},json(j){this.body=j;return this;}};
  await r.rotas.painel({query:{data:'2026-10-05'},usuarioLogado:{perfil:'CUSTOM'}},res);assert.equal(res.body.custos_permitidos,false);assert.equal(res.body.custos,undefined);
  await r.rotas.painel({query:{data:'2026-10-05'},usuarioLogado:{perfil:'ADM'}},res);assert.equal(res.body.custos.length,1);
  await r.rotas.painel({query:{data:'2026-02-30'},usuarioLogado:{perfil:'ADM'}},res);assert.equal(res.code,400);
});
test('Salto isolado e horario regressivo nao iniciam confirmacao de desvio',()=>{
  const m=op.criarMonitorDesvio();m.avaliar('X',fora(),percurso,1,op.PADRAO,{agora});
  assert.equal(m.avaliar('X',fora(1,{lat:-21}),percurso,1,op.PADRAO,{agora:agora+60000}).status,'sem_sinal_confiavel');
  m.avaliar('X',fora(),percurso,1,op.PADRAO,{agora});
  assert.equal(m.avaliar('X',fora(-1),percurso,1,op.PADRAO,{agora}).status,'sem_sinal_confiavel');
});