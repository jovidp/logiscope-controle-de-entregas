const test=require('node:test'),assert=require('node:assert/strict');
const {semSaltos,escolherTrajeto,inicioDoDia}=require('../frota');
const {pontosParaMapa}=require('../frota-historico');
const ponto=(hora,lat,lng,velocidade)=>({placa:'FKD3F13',fonte:'srf',device_id:24,posicao_em:'2026-10-07T'+hora+'Z',t:Date.parse('2026-10-07T'+hora+'Z'),lat,lng,velocidade});
test('FKD3F13: copia parada nao descarta o restante da viagem ao retomar o sinal',()=>{
  const l=[ponto('08:17:27',-23.011303,-43.533037,54),ponto('08:17:33',-23.011597,-43.532197,54),ponto('08:18:05',-23.011597,-43.532197,0),ponto('08:18:33',-23.011597,-43.532197,0),ponto('08:19:03',-23.015898,-43.518997,54),ponto('08:19:25',-23.016495,-43.515563,48),ponto('08:19:33',-23.016803,-43.514535,48),ponto('08:20:03',-23.017892,-43.510648,37)];
  const r=semSaltos(l);assert.equal(r.length,l.length-1);assert.ok(!r.includes(l[3]));assert.equal(r.at(-1),l.at(-1));
  const h=pontosParaMapa(r,inicioDoDia('2026-10-07'));assert.equal(h.at(-1)[3],8*3600+20*60+3-3*3600);
});
test('FKD3F13: retorno da noite anterior sobrevive a coordenada antiga reemitida',()=>{
  const l=[ponto('21:00:00',-22.895845,-43.399567,31),ponto('21:00:58',-22.895845,-43.399567,0),ponto('21:01:28',-22.895845,-43.399567,0),ponto('21:01:58',-22.895845,-43.399567,0),ponto('21:02:59',-22.920083,-43.396653,59),ponto('21:03:23',-22.923765,-43.397992,54),ponto('21:03:28',-22.924478,-43.3979,57)];
  const r=semSaltos(l);assert.equal(r.length,l.length-1);assert.equal(r.at(-1),l.at(-1));assert.ok(!r.includes(l[3]));
});
test('Pico isolado sai sem interromper pontos verdadeiros antes e depois',()=>{
  const l=[ponto('08:00:00',-22.9,-43.4,30),ponto('08:01:00',-22.899,-43.4,30),ponto('08:02:00',-23.55,-46.63,0),ponto('08:03:00',-22.897,-43.4,30),ponto('08:04:00',-22.896,-43.4,30)];
  assert.deepEqual(semSaltos(l),[l[0],l[1],l[3],l[4]]);
});
test('Varias leituras em local distante impossivel continuam rejeitadas',()=>{
  const l=[ponto('08:00:00',-22.9,-43.4,0),ponto('08:01:00',-22.9,-43.4,0),ponto('08:02:00',-22.9,-43.4,0),ponto('08:03:00',-23.55,-46.63,0),ponto('08:04:00',-23.55,-46.63,0),ponto('08:05:00',-23.55,-46.63,0),ponto('08:06:00',-22.9,-43.4,0),ponto('08:07:00',-22.9,-43.4,0),ponto('08:08:00',-22.9,-43.4,0)];
  assert.deepEqual(semSaltos(l),[...l.slice(0,3),...l.slice(6)]);
});
test('Coordenada diferente na quebra nao e tratada como copia parada',()=>{
  const l=[ponto('08:00:00',-22.9,-43.4,0),ponto('08:01:00',-22.9,-43.4,0),ponto('08:02:00',-22.9,-43.4,0),ponto('08:03:00',-23.55,-46.63,0),ponto('08:04:00',-23.55,-46.63,30)];
  assert.deepEqual(semSaltos(l),l.slice(0,3));
});
test('Reparo de continuidade nao permite fonte bloqueada como reserva',()=>{
  const l=[ponto('08:17:33',-23.011597,-43.532197,54),ponto('08:18:05',-23.011597,-43.532197,0),ponto('08:18:33',-23.011597,-43.532197,0),ponto('08:19:03',-23.015898,-43.518997,54),ponto('08:19:25',-23.016495,-43.515563,48)];
  assert.deepEqual(escolherTrajeto(l,null,['srf']).lista,[]);
});

// Leituras reais do FKE4G14 em 07/10: 46 m entre sinais separados por 1 s.
const krv=()=>[
  ponto('11:11:24',-22.70628,-42.658197,76),
  ponto('11:11:32',-22.70648,-42.65649,83),
  ponto('11:11:47',-22.707408,-42.653187,81),
  ponto('11:12:18',-22.710608,-42.647417,83),
  ponto('11:12:24',-22.71134,-42.646288,83),
  ponto('11:12:25',-22.711633,-42.645963,83),
  ponto('11:12:56',-22.716368,-42.640967,76),
  ponto('11:13:02',-22.717072,-42.640023,70),
  ponto('11:13:08',-22.717608,-42.638993,74),
].map(p=>({...p,placa:'FKE4G14',device_id:25}));
test('FKE4G14: imprecisao em sinais de 1 segundo nao apaga o restante do trajeto',()=>{
  const l=krv(),r=semSaltos(l);
  assert.equal(r.at(-1),l.at(-1));
  assert.deepEqual(r,[...l.slice(0,5),...l.slice(6)]);
});
test('FKE4G14: rastro e historico conservam a linha apos o sinal impreciso',()=>{
  const {montarRastro}=require('../frota');
  const {recortarRastro}=require('../../public/js/frota-rastro-utils');
  const l=krv(),r=escolherTrajeto(l,null,[]).lista;
  const inicio=inicioDoDia('2026-10-07'),fim=(l.at(-1).t-inicio)/1000;
  const h=pontosParaMapa(r,inicio);
  assert.equal(h.at(-1)[3],fim);
  assert.ok(h.slice(1).every(p=>p[4]===0));
  const j={ini:8*3600,fim:9*3600,faixa:3600};
  const desenho=recortarRastro(montarRastro(r,inicio),j);
  assert.equal(desenho.t1,fim);assert.ok(desenho.pedacos.length);
});
test('Deslocamento curto sem continuidade confirmada nao libera um salto distante',()=>{
  const l=krv();l[6]={...l[6],lat:-23.55,lng:-46.63};
  const r=semSaltos(l);assert.ok(!r.includes(l[6]));
});


const krvNovo=()=>[
  ponto('13:02:53',-22.564305,-42.361502,91),
  ponto('13:02:56',-22.563827,-42.36095,93),
  ponto('13:03:05',-22.56207,-42.359517,100),
  ponto('13:03:17',-22.560302,-42.356987,89),
  ponto('13:03:23',-22.55924,-42.356472,94),
  ponto('13:03:26',-22.558252,-42.356288,100),
  ponto('13:03:36',-22.55577,-42.355617,102),
  ponto('13:03:56',-22.551363,-42.352272,107),
  ponto('13:04:26',-22.544303,-42.348492,104),
].map(p=>({...p,placa:'FKE4G14',device_id:25}));
test('KRV: quebra de 111 metros em 3 segundos conserva o percurso posterior confirmado',()=>{
  const l=krvNovo(),r=semSaltos(l);
  assert.deepEqual(r,l); // 111 m em 3 s cabe na margem espacial de 60 m.
  const h=pontosParaMapa(r,inicioDoDia('2026-10-07'));
  assert.equal(h.at(-1)[3],10*3600+4*60+26);
  assert.ok(h.slice(1).every(p=>p[4]===0));
});
test('Trecho anterior tambem e recuperado quando a ancora esta depois da quebra',()=>{
  const l=krvNovo();l.push(ponto('13:04:37',-22.541628,-42.347582,100),ponto('13:04:56',-22.537555,-42.344842,102));
  const r=semSaltos(l);assert.equal(r[0],l[0]);assert.equal(r.at(-1),l.at(-1));
});
test('RKO: coordenada antiga repetida nao elimina as leituras seguintes da viagem',()=>{
  const l=['11:25:18','11:25:46','11:26:16','11:26:46','11:27:16'].map(h=>ponto(h,-22.994828,-43.593587,0));
  l.push(ponto('11:30:16',-22.926508,-43.569948,0),ponto('11:30:47',-22.926508,-43.569948,0),ponto('11:30:56',-22.923657,-43.567977,9),ponto('11:31:16',-22.923678,-43.56773,0),ponto('11:32:47',-22.922968,-43.56532,0),ponto('11:32:58',-22.922722,-43.56476,31));
  const r=semSaltos(l);assert.equal(r.at(-1),l.at(-1));assert.ok(l.slice(0,5).every(p=>r.includes(p)));assert.ok(r.includes(l[8]));
});
test('LTS: volta do SRF apos reserva T4S conserva o restante do trajeto',()=>{
  const l=[ponto('11:49:51',-22.4853,-43.8986,63),ponto('11:50:35',-22.4813,-43.8949,67),ponto('11:51:31',-22.4764,-43.8829,67),ponto('11:52:20',-22.4759,-43.8802,69),ponto('11:52:45',-22.4709,-43.87,70),ponto('11:53:01',-22.4702,-43.8666,69),ponto('11:53:34',-22.4671,-43.8622,69),ponto('11:54:47',-22.461043,-43.850398,72)];
  const r=semSaltos(l);assert.equal(r[0],l[0]);assert.equal(r.at(-1),l.at(-1));assert.ok(l.slice(0,4).every(p=>r.includes(p)));
});
test('Recuperacao nao aguarda indefinidamente ate um salto distante parecer possivel',()=>{
  const l=Array.from({length:6},(_,i)=>ponto('08:00:0'+i,-22.9,-43.4,0));
  l.push(ponto('08:00:10',-22.96,-43.4,0),ponto('08:06:10',-22.96,-43.4,0),ponto('08:06:20',-22.96,-43.4,0));
  assert.deepEqual(semSaltos(l),l.slice(0,6));
});


test('Mais leituras da outra fonte nao substituem o trajeto ja desenhado',()=>{
  const sat=Array.from({length:6},(_,i)=>({...ponto('09:0'+i+':00',-22.9+i*.001,-43.4,30),fonte:'sat'}));
  const t4s=Array.from({length:4},(_,i)=>({...sat[i],fonte:'t4s',t:sat[i].t+1000}));
  const antes=escolherTrajeto([...sat,...t4s].sort((a,b)=>a.t-b.t),null,[]);
  const mais=Array.from({length:20},(_,i)=>({...sat.at(-1),fonte:'t4s',t:sat.at(-1).t+(i+1)*1000}));
  const depois=escolherTrajeto([...sat,...t4s,...mais].sort((a,b)=>a.t-b.t),null,[]);
  assert.equal(antes.fonte,'sat');assert.equal(depois.fonte,'sat');
  assert.ok(antes.lista.every(p=>depois.lista.includes(p)));
});
test('Fonte preferida e lacunas continuam usando a reserva permitida',()=>{
  const a=ponto('09:00:00',-22.9,-43.4,30),b=ponto('09:20:00',-22.88,-43.4,30);
  const reserva=[ponto('09:06:00',-22.894,-43.4,30),ponto('09:12:00',-22.888,-43.4,30)].map(p=>({...p,fonte:'t4s'}));
  const r=escolherTrajeto([a,...reserva,b],'srf',[]);
  assert.deepEqual(r.lista,[a,...reserva,b]);assert.equal(r.fonte,'srf+t4s');
  assert.deepEqual(escolherTrajeto([a,...reserva,b],'srf',['t4s']).lista,[a,b]);
});
test('Margem espacial evita que um intervalo curto recorte uma viagem inteira',()=>{
  const l=[ponto('09:00:00',-22.9,-43.4,70),ponto('09:00:03',-22.9,-43.399,70),ponto('09:00:06',-22.9,-43.398,70)];
  for(let i=1;i<=l.length;i++)assert.deepEqual(semSaltos(l.slice(0,i)),l.slice(0,i));
  const h=pontosParaMapa(l,inicioDoDia('2026-10-07'));assert.ok(h.slice(1).every(p=>p[4]===0));
  const {analisar}=require('../frota');assert.ok(analisar(l,[]).km>0);
});
