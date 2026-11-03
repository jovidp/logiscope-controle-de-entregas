const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const periodo=require('../../public/js/frota-periodo'),rastros=require('../../public/js/frota-rastro-utils');
const HOJE='2026-10-07',PLACA='FKE4G14';
function painel(data,km=10,comSinal=true){
  const primeira=data+'T09:00:00Z',ultima=data+'T10:00:00Z';
  return {data,hoje:data===HOJE,dia_inicio:data+'T03:00:00Z',lugares:[],lugares_v:'1',veiculos:[{placa:PLACA,modelo:'Caminhão',tipo:'caminhao',atual:{lat:9,lng:9},fontes:[],viagem:{id:data,rota:data,motorista:data},
    dia:{km:comSinal?km:0,pontos:comSinal?2:0,movendo_min:comSinal?60:0,parado_min:0,vel_max:40,excessos:1,paradas_n:1,paradas_fora:0,primeira:comSinal?primeira:null,ultima:comSinal?ultima:null,ultima_pos:comSinal?[-22.89,-43.39]:undefined,fonte:'srf'},
    visitas:comSinal?[{codigo:'LOJA',nome:'Loja',chegou:primeira,saiu:ultima,chegada_vista:true,lat:-22.9,lng:-43.4}]:[],rastro:comSinal?[[-22.9,-43.4,21600,2],[-22.89,-43.39,25200,0]]:[]} ]};
}
function trajeto(data){const p=painel(data);return {...p.veiculos[0].dia,data,placa:PLACA,dia_inicio:p.dia_inicio,pontos:[[-22.9,-43.4,30,21600,2],[-22.89,-43.39,40,25200,0]],paradas:[],eventos:[]};}

test('Periodo inclui as duas datas, cruza meses e valida datas reais, futuro e limite',()=>{
  assert.deepEqual(periodo.datas('2026-09-30','2026-10-02',HOJE),['2026-09-30','2026-10-01','2026-10-02']);
  assert.equal(periodo.datas('2026-09-07',HOJE,HOJE).length,31);
  for(const [de,ate] of [['2026-09-06',HOJE],['2026-10-07','2026-10-06'],['2026-02-30',HOJE],[HOJE,'2026-10-08'],['',HOJE]])assert.throws(()=>periodo.datas(de,ate,HOJE));
});
test('Frota no periodo soma estatisticas diarias e preserva dias sem dados e a ultima posicao valida',()=>{
  const dias=['2026-10-05','2026-10-06',HOJE],entradas=[painel(dias[0],10),painel(dias[1],20),painel(dias[2],0,false)],original=JSON.stringify(entradas);
  const r=periodo.painel(entradas),v=r.veiculos[0];
  assert.equal(v.dia.km,30);assert.equal(v.dia.pontos,4);assert.equal(v.dia.movendo_min,120);assert.equal(v.dia.ultima,'2026-10-06T10:00:00Z');assert.deepEqual(v.dia.ultima_pos,[-22.89,-43.39]);
  assert.equal(r.hoje,false);assert.equal(r.inicio,dias[0]);assert.equal(r.fim,HOJE);assert.deepEqual(v.dias_sem_dados,[HOJE]);assert.equal(JSON.stringify(entradas),original);
  assert.equal(v.visitas[0].data,dias[0]);assert.equal(v.visitas[0].viagem.motorista,dias[0]);assert.equal(v.visitas[1].data,dias[1]);
});
test('Rastros preservam horarios e nao ligam os extremos de dias diferentes',()=>{
  const r=periodo.painel([painel('2026-10-05'),painel('2026-10-06')]);const p=r.veiculos[0].rastro;
  assert.equal(p[2][2],21600+86400);assert.equal(p[2][3],2);assert.equal(p[3][3],0);
  const linhas=rastros.recortarRastro(p,{ini:0,fim:172800,faixa:172800});assert.equal(linhas.pedacos.length,2);
});
test('Trajeto detalhado e reproducao deixam a lacuna entre dias sem interpolacao',()=>{
  const r=periodo.trajeto([trajeto('2026-10-05'),trajeto('2026-10-06')]);
  assert.equal(r.km,20);assert.equal(r.pontos[2][3],21600+86400);assert.equal(r.pontos[2][4],2);
  const durante=rastros.posicaoReplay(r.pontos,60000);assert.equal(durante.semSinal,true);assert.equal(durante.em,25200);
});
test('Um unico dia mantem o painel original e o modo ao vivo',()=>{
  const p=painel(HOJE),t=trajeto(HOJE);assert.equal(periodo.painel([p]),p);assert.equal(periodo.trajeto([t]),t);
});
test('Consultas diarias mantem ordem com no maximo duas requisicoes em andamento',async()=>{
  let ativas=0,max=0;const r=await periodo.consultar(['a','b','c','d'],async d=>{ativas++;max=Math.max(max,ativas);await new Promise(setImmediate);ativas--;return d;});
  assert.equal(max,2);assert.deepEqual(r,['a','b','c','d']);
});
test('Falha de um dia rejeita o periodo inteiro e consulta antiga para de pedir dias',async()=>{
  await assert.rejects(periodo.consultar(['a','b'],async d=>{if(d==='b')throw Error('rede');return d;}),/rede/);
  let atual=true,pedidos=0;const r=await periodo.consultar(['a','b','c','d'],async d=>{pedidos++;atual=false;return d;},()=>atual);
  assert.equal(r,null);assert.equal(pedidos,1);
});

function tela(){
  const ids=new Map(),pedidos=[],renders=[],csv=[],abas=[];let responder=async url=>{const q=new URL(url);const data=q.searchParams.get('data');return q.pathname.endsWith('fonte-preferida')?{}:q.pathname.endsWith('trajeto')?trajeto(data):painel(data);};
  const el=id=>{if(!ids.has(id)){const classes=new Set();ids.set(id,{id,innerHTML:'',textContent:'',value:'',dataset:{},style:{},classList:{add:k=>classes.add(k),remove:k=>classes.delete(k),contains:k=>classes.has(k),toggle(k,v){v?classes.add(k):classes.delete(k);}},setAttribute(k,v){this[k]=v;},querySelector:s=>s.startsWith('#')?el(s.slice(1)):null,querySelectorAll:s=>s==='.frt-abas [data-parte]'?abas:[]});}return ids.get(id);};
  for(const parte of ['vivo','historico','operacao','rota','relatorios','areas','manutencao']){const b=el('aba-'+parte);b.dataset.parte=parte;abas.push(b);}
  class Data extends Date{constructor(...args){super(...(args.length?args:[HOJE+'T12:00:00-03:00']));}static now(){return new Date(HOJE+'T12:00:00-03:00').getTime();}}
  const context={window:{location:{origin:'http://localhost'},frtPeriodo:periodo,frtRastroUtils:rastros},document:{getElementById:el,querySelector:()=>null,hidden:false},localStorage:{getItem:()=>null},Date:Data,Intl,Map,Set,WeakMap,setTimeout:fn=>fn(),clearInterval,URL,URLSearchParams};
  let src=fs.readFileSync(require.resolve('../../public/js/frota.js'),'utf8'),end=src.lastIndexOf('})();');
  src=src.slice(0,end)+`
    getJson=async url=>{window.pedidos.push(url);return window.responder(url);};
    render=()=>{window.renders.push(st.dados);}; renderLista=()=>{};renderLegendas=()=>{};
    desenharMapa=async()=>{};garantirMapa=async()=>true;desenharTrajeto=(v,t)=>{window.desenhado=t;};
    renderDetalhe=(v,t)=>{window.detalhe=t;};baixarCsv=(linhas,nome)=>window.csv.push({linhas,nome});
    window.teste={st,montar,irParaPeriodo,carregar,carregarTrajeto,podeAtualizar,exportarRegistro,textosVisita};
  `+src.slice(end);
  Object.assign(context.window,{pedidos,renders,csv,responder:url=>responder(url)});vm.runInNewContext(src,context);context.window.teste.montar();
  return {el,pedidos,renders,csv,window:context.window,api:context.window.teste,responder:fn=>{responder=fn;}};
}
test('De e Ate carregam todos os dias dentro do Ao vivo; Hoje restaura o dia atual',async()=>{
  const a=tela();a.el('frtData').value='2026-10-05';a.el('frtDataFim').value=HOJE;await a.el('frtConsultarBtn').onclick();
  assert.equal(a.api.st.fim,HOJE);assert.equal(a.renders.at(-1).veiculos[0].dia.km,30);assert.equal(a.el('frtVivo').hidden,undefined);
  assert.equal(a.pedidos.filter(p=>p.includes('/painel?')).length,3);assert.equal(a.api.podeAtualizar(),false);
  await a.el('frtHojeBtn').onclick();assert.equal(a.api.st.data,HOJE);assert.equal(a.api.st.fim,HOJE);assert.equal(a.api.podeAtualizar(),true);
  assert.equal(a.renders.at(-1).hoje,true);assert.equal(a.renders.at(-1).veiculos[0].dia.km,10);
});
test('Periodo invalido nao consulta e erro parcial preserva o ultimo mapa concluido',async()=>{
  const a=tela();await a.api.irParaPeriodo(HOJE,HOJE);const anterior=a.api.st.dados,n=a.pedidos.length;
  await a.api.irParaPeriodo(HOJE,'2026-10-06');assert.equal(a.pedidos.length,n);assert.equal(a.api.st.dados,anterior);
  a.responder(async url=>{if(url.includes('data=2026-10-06'))throw Error('GPS indisponível');return painel('2026-10-05');});
  await a.api.irParaPeriodo('2026-10-05','2026-10-06');assert.equal(a.api.st.dados,anterior);assert.equal(a.renders.length,1);assert.ok(a.el('frtAviso').innerHTML.includes('última consulta concluída'));
});
test('Resposta do periodo antigo nao sobrescreve troca apenas da data Ate',async()=>{
  const a=tela();let soltar;a.responder(url=>url.includes('data=2026-10-06')?new Promise(ok=>soltar=ok):Promise.resolve(painel('2026-10-05')));
  const antigo=a.api.irParaPeriodo('2026-10-05','2026-10-06');a.responder(async url=>url.includes('fonte-preferida')?{}:painel('2026-10-05'));
  await a.api.irParaPeriodo('2026-10-05','2026-10-05');soltar(painel('2026-10-06'));await antigo;await new Promise(setImmediate);
  assert.equal(a.renders.length,1);assert.equal(a.renders[0].data,'2026-10-05');assert.equal(a.renders[0].fim,undefined);
});
test('Detalhe do carro consulta o mesmo periodo e exportacao mantem data e motorista de cada visita',async()=>{
  const a=tela();await a.api.irParaPeriodo('2026-10-05','2026-10-06');a.api.st.sel=PLACA;await a.api.carregarTrajeto(PLACA,false);
  assert.equal(a.window.detalhe.km,20);assert.equal(a.window.desenhado.pontos[2][4],2);
  a.api.exportarRegistro();const {linhas,nome}=a.csv[0];assert.equal(linhas[1][0],'2026-10-06');assert.equal(linhas[1][2],'2026-10-06');assert.equal(linhas[2][0],'2026-10-05');assert.equal(linhas[2][2],'2026-10-05');assert.ok(nome.includes('2026-10-05_a_2026-10-06'));
  assert.match(a.api.textosVisita(a.api.st.dados.veiculos[0].visitas[0]).chegou,/05\/10/);
});
test('Hoje descarta o periodo e consulta unica com 404 antigo pode usar fallback apenas em hoje',async()=>{
  const a=tela();a.responder(async()=>{throw Object.assign(Error('not found'),{status:404});});
  await a.api.irParaPeriodo('2026-10-05','2026-10-06');assert.equal(a.api.st.dados,null);assert.equal(a.pedidos.length,2);assert.ok(a.pedidos.every(p=>p.includes('/frota/painel')));
});
