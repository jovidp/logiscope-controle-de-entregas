const test=require('node:test'),assert=require('node:assert/strict');
const {validarPeriodo,montarHistorico,pontosParaMapa,criar}=require('../frota-historico');
const {semTremor,montarRastro,analisar,inicioDoDia}=require('../frota');
const {recortarRastro,posicaoReplay}=require('../../public/js/frota-rastro-utils');
const PLACA='ABC1D23',HOJE='2026-10-07';
const ponto=(dia,min,extra={})=>{const t=inicioDoDia(dia)+min*60000;return {placa:PLACA,fonte:'srf',device_id:999999,lat:-22.9,lng:-43.4,velocidade:0,t,posicao_em:new Date(t).toISOString(),...extra};};
test('Periodo inclui cinco dias completos de Sao Paulo e exclui meia noite seguinte',()=>{
  const p=validarPeriodo('2026-10-03','2026-10-07',HOJE);assert.equal(p.dias,5);assert.equal(new Date(p.inicio_ms).toISOString(),'2026-10-03T03:00:00.000Z');assert.equal(new Date(p.fim_ms).toISOString(),'2026-10-08T03:00:00.000Z');
  const unico=validarPeriodo(HOJE,HOJE,HOJE);assert.equal(unico.fim_ms-unico.inicio_ms,86400000);
});
test('Periodo rejeita sexto dia, datas impossiveis, ordem invertida e futuro',()=>{
  for(const [a,b] of [['2026-10-02',HOJE],['2026-02-31','2026-03-01'],[HOJE,'2026-10-06'],[HOJE,'2026-10-08'],['2026-02-29','2026-02-29'],['2026-2-03',HOJE]])assert.throws(()=>validarPeriodo(a,b,HOJE));
  assert.equal(validarPeriodo('2024-02-29','2024-02-29',HOJE).dias,1);
});
test('Limpeza conserva primeiro e ultimo sinal de parada longa antes de sair',()=>{
  const lista=Array.from({length:121},(_,i)=>ponto(HOJE,360+i));lista.push(ponto(HOJE,481,{velocidade:30,lng:-43.39}));
  const limpos=semTremor(lista).limpos;assert.deepEqual(limpos.map(p=>p.t),[lista[0].t,lista[120].t,lista[121].t]);
  const rastro=montarRastro(lista,inicioDoDia(HOJE));assert.ok(rastro.some(p=>p[2]===480*60),'horario da saida sobrevive a simplificacao');
  const replay=pontosParaMapa(lista,inicioDoDia(HOJE));const p=posicaoReplay(replay,420*60);assert.equal(p.lng,-43.4,'carro continua parado antes de sair');
});
test('Chegada e parada final conservam horarios sem rabisco de leituras repetidas',()=>{
  const lista=[ponto(HOJE,360,{velocidade:30}),...Array.from({length:40},(_,i)=>ponto(HOJE,361+i,{lng:-43.3999}))];
  assert.deepEqual(semTremor(lista).limpos.map(p=>p.t),[lista[0].t,lista[1].t,lista.at(-1).t]);
  assert.deepEqual(montarRastro(lista,inicioDoDia(HOJE)),[],'manobra de poucos metros nao vira rastro');
});
test('Sinais duplicados e regressivos nao entram na reproducao',()=>{
  const a=ponto(HOJE,360),b=ponto(HOJE,362);const l=semTremor([a,{...a,lng:-43.41},ponto(HOJE,359),b]).limpos;
  assert.deepEqual(l.map(p=>p.t),[a.t,b.t]);
});
test('Lacuna longa nao vira parada de doze horas nem linha ligada no mesmo lugar',()=>{
  const a=ponto(HOJE,360),b=ponto(HOJE,1080);const pts=pontosParaMapa([a,b],inicioDoDia(HOJE));assert.equal(pts.length,2);assert.equal(pts[1][4],2);
  const an=analisar([a,b],[]);assert.equal(an.parado_min,0);assert.deepEqual(an.paradas,[]);
});
test('Distancia numa lacuna de varias horas nao conta como km observados',()=>{
  const an=analisar([ponto(HOJE,360,{velocidade:50}),ponto(HOJE,1080,{velocidade:50,lng:-43.1})],[]);
  assert.equal(an.km,0);assert.equal(an.movendo_min,0);
});
test('Historico indica dias vazios e nao une extremos de dias diferentes',()=>{
  const periodo=validarPeriodo('2026-10-03',HOJE,HOJE);
  const lista=[ponto('2026-10-03',360),ponto('2026-10-03',361,{lng:-43.399,velocidade:15}),ponto(HOJE,360),ponto(HOJE,361,{lng:-43.399,velocidade:15})];
  const h=montarHistorico(lista,periodo,[],{},[],PLACA);
  assert.equal(h.dias.length,5);assert.deepEqual(h.sem_dados,['2026-10-04','2026-10-05','2026-10-06']);
  assert.equal(h.pontos[2][4],2);assert.ok(h.pontos[2][3]>3*86400);
  const meio=posicaoReplay(h.pontos,2*86400);assert.equal(meio.semSinal,true);assert.equal(meio.lng,h.pontos[1][1]);
});
test('Fonte principal pode mudar entre dias sem excluir o dia com menos leituras',()=>{
  const periodo=validarPeriodo('2026-10-06',HOJE,HOJE);
  const l=[ponto('2026-10-06',360),ponto('2026-10-06',361),ponto(HOJE,360,{fonte:'sat'}),ponto(HOJE,361,{fonte:'sat'}),ponto(HOJE,362,{fonte:'sat'})];
  const h=montarHistorico(l,periodo,[],{},[],PLACA);assert.equal(h.dias[0].fonte,'srf');assert.equal(h.dias[1].fonte,'sat');assert.equal(h.resumo.pontos_validos,5);
});
test('Fonte bloqueada nao aparece no historico mesmo quando e a unica',()=>{
  const p=validarPeriodo(HOJE,HOJE,HOJE);const h=montarHistorico([ponto(HOJE,360),ponto(HOJE,361)],p,[],{},['srf'],PLACA);assert.equal(h.pontos.length,0);assert.deepEqual(h.sem_dados,[HOJE]);
});
test('Limites exatos excluem leitura da meia noite posterior e anterior ao periodo',()=>{
  const p=validarPeriodo(HOJE,HOJE,HOJE);const l=[ponto('2026-10-06',1439),ponto(HOJE,0),ponto(HOJE,1439),ponto('2026-10-08',0)];
  const h=montarHistorico(l,p,[],{},[],PLACA);assert.equal(h.resumo.pontos_validos,2);assert.equal(h.pontos[0][3],0);assert.equal(h.pontos.at(-1)[3],86340);
});
test('Recorte de uma hora preserva trecho que cruza o inicio da janela',()=>{
  const J={ini:100,fim:180,faixa:80};const r=recortarRastro([[0,0,90,2],[0,10,110,0],[0,20,200,0]],J);
  assert.equal(r.t0,100);assert.equal(r.t1,180);assert.equal(r.pedacos[0].coords[0][1],5);assert.ok(r.pedacos.at(-1).coords.at(-1)[1]<20);
});
test('Recorte nao liga lacuna e nao desenha depois da hora escolhida',()=>{
  const J={ini:0,fim:100,faixa:100};const r=recortarRastro([[0,0,0,2],[0,1,20,0],[0,2,30,2],[0,3,60,1],[0,4,120,0]],J);
  assert.equal(r.t1,100);assert.ok(!r.pedacos.some(x=>x.coords.some((c,i)=>i&&x.coords[i-1][1]===1&&c[1]===2)));
});
test('Reproducao sinaliza ausencia de sinal e so volta a mover no ponto seguinte',()=>{
  const P=[[1,2,30,0,2],[3,4,60,100,2],[4,5,60,200,0]];
  assert.deepEqual(posicaoReplay(P,50),{lat:1,lng:2,vel:null,em:0,semSinal:true,aproximado:false});
  assert.equal(posicaoReplay(P,100).lat,3);assert.equal(posicaoReplay(P,100).semSinal,false);
  assert.equal(posicaoReplay(P,150).lat,3.5);assert.equal(posicaoReplay(P,150).aproximado,true);
});
function resposta(){return {codigo:200,status(n){this.codigo=n;return this;},set(){},json(b){this.corpo=b;return this;}};}
test('Endpoint valida periodo antes de tocar o banco',async()=>{
  let chamadas=0;const api=criar({db:{query(){chamadas++;throw Error('nao deveria consultar');}},agoraSP:()=>({data:HOJE})});const res=resposta();await api.historico({query:{placa:PLACA,inicio:'2026-10-01',fim:HOJE}},res);assert.equal(res.codigo,400);assert.equal(chamadas,0);
});
test('Endpoint filtra placa e intervalo em SQL e compartilha consulta concorrente',async()=>{
  const chamadas=[];const db={async query(sql,args){chamadas.push({sql,args});return {rows:sql.includes('rastreador_posicoes')?[ponto(HOJE,360),ponto(HOJE,361)]:[]};}};
  const api=criar({db,agoraSP:()=>({data:HOJE}),obterLugares:async()=>new Map(),obterPreferencias:async()=>({}),obterIgnoradas:()=>[]});
  const req={query:{placa:PLACA,inicio:HOJE,fim:HOJE}},a=resposta(),b=resposta();await Promise.all([api.historico(req,a),api.historico(req,b)]);
  assert.equal(a.codigo,200);assert.equal(chamadas.length,2);assert.deepEqual(chamadas[0].args,[PLACA,HOJE,HOJE]);assert.ok(chamadas[0].sql.includes("AT TIME ZONE 'America/Sao_Paulo'"));assert.equal(a.corpo.resumo.pontos_validos,2);assert.deepEqual(a.corpo,b.corpo);
});
test('Tela cheia do historico usa seus controles e sai ao esconder a parte',async()=>{
  const vm=require('node:vm'),fs=require('node:fs');
  const classes=new Set(),observadores=[],eventos={};
  const painel={classList:{contains:c=>classes.has(c),add:c=>classes.add(c),remove:c=>classes.delete(c)}};
  const botao={dataset:{},setAttribute(){},focus(){}},mapaBotao={setAttribute(){},focus(){}};
  const parte={hidden:false},aba={classList:{contains:()=>false}},mapa={};
  const ids={historicoPainel:painel,historicoBtn:botao,historicoMapaBtn:mapaBotao,historicoMapa:mapa,historicoParte:parte,'aba-frota':aba};
  const document={body:{style:{overflow:'auto'}},getElementById:id=>ids[id],addEventListener:(tipo,fn)=>{eventos[tipo]=fn;},fullscreenEnabled:false};
  const context={window:{},document,requestAnimationFrame:fn=>fn(),setTimeout:()=>{},MutationObserver:class{constructor(fn){this.fn=fn;}observe(alvo){observadores.push({alvo,fn:this.fn});}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../../public/js/frota-tela-cheia.js'),'utf8'),context);
  context.window.frtTelaCheia.montar(()=>{},{painel:'historicoPainel',botao:'historicoBtn',botaoMapa:'historicoMapaBtn',mapa:'historicoMapa',classe:'historico-ampliado',parte:'historicoParte'});
  await mapaBotao.onclick();assert.ok(classes.has('historico-ampliado'));assert.equal(document.body.style.overflow,'hidden');
  parte.hidden=true;observadores.find(o=>o.alvo===parte).fn();assert.equal(classes.size,0);assert.equal(document.body.style.overflow,'auto');
});