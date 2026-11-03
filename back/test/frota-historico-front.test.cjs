const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const utils=require('../../public/js/frota-rastro-utils');
const periodo=require('../../public/js/frota-periodo');
const HOJE='2026-10-07',PLACA='ABC1D23';
function dados(inicio=HOJE,fim=HOJE){return {placa:PLACA,inicio,fim,dia_inicio:inicio+'T03:00:00Z',primeira:inicio+'T09:00:00Z',ultima:fim+'T10:00:00Z',resumo:{km:10,movendo_min:60,parado_min:0,vel_max:50,pontos_validos:2},dias:[{data:inicio,fonte:'srf',pontos_validos:2,pontos_brutos:2,km:10,primeira:inicio+'T09:00:00Z',ultima:inicio+'T10:00:00Z'}],pontos:[[-22.9,-43.4,30,21600,2],[-22.89,-43.39,40,25200,0]],sem_dados:[],eventos:[]};}
function ambiente(){
  const ids=new Map(),pedidos=[],camadas=[],eventos={};let consulta=async()=>dados(),voltas=0;
  const novo=id=>({id,value:'',hidden:false,disabled:false,innerHTML:'',textContent:'',dataset:{},style:{},classList:{toggle(){},contains(){return false;}},setAttribute(k,v){this[k]=v;},querySelectorAll(){return [];}});
  const el=id=>{if(!ids.has(id))ids.set(id,novo(id));return ids.get(id);};
  const mapa={setView(){return this;},invalidateSize(){},fitBounds(){this.enquadrado=true;}};
  const camada=()=>({addTo(){camadas.push(this);return this;},bindTooltip(){return this;},on(){return this;},setLatLng(){return this;},setStyle(){return this;},setTooltipContent(t){this.tooltip=t;return this;}});
  const document={getElementById:el,addEventListener:(tipo,fn)=>{eventos[tipo]=fn;},hidden:false};
  const L={map:()=>mapa,tileLayer:camada,layerGroup:()=>({addTo(){return this;},clearLayers(){camadas.length=0;}}),canvas:()=>({}),polyline:camada,circleMarker:camada,latLngBounds:p=>p,control:{scale:camada}};
  const fetch=async(url,options)=>{pedidos.push({url,options});const b=url.startsWith('/frota/historico/veiculos')?{veiculos:[{placa:PLACA,primeira:'2026-10-03T03:00:00Z',ultima:'2026-10-07T12:00:00Z'}]}:await consulta(url,options);return {ok:true,json:async()=>b};};
  class Data extends Date{constructor(...args){super(...(args.length?args:['2026-10-07T10:00:00-03:00']));}static now(){return new Date('2026-10-07T10:00:00-03:00').getTime();}}
  const context={window:{L,frtApi:{carregarLeaflet:async()=>{},voltarAoVivo:()=>voltas++},frtTelaCheia:{montar(){}},frtRastroUtils:utils},document,fetch,AbortController,URLSearchParams,Date:Data,Intl,setTimeout,clearTimeout,setInterval,clearInterval};
  vm.runInNewContext(fs.readFileSync(require.resolve('../../public/js/frota-historico.js'),'utf8'),context);
  return {el,document,pedidos,mapa,camadas,api:context.window.frtHistorico,responder:fn=>{consulta=fn;},voltas:()=>voltas};
}
test('Interface consulta placa e cinco dias e mostra o periodo realmente carregado',async()=>{
  const a=ambiente();await a.api.abrir(PLACA);a.el('fhhInicio').value='2026-10-03';a.el('fhhFim').value=HOJE;a.responder(async()=>dados('2026-10-03',HOJE));
  await a.el('fhhForm').onsubmit({preventDefault(){}});
  const p=a.pedidos.at(-1);assert.ok(p.url.includes('placa='+PLACA));assert.ok(p.url.includes('inicio=2026-10-03'));assert.ok(a.el('fhhMapaResumo').textContent.includes('03/10/2026 00:00'));assert.ok(a.el('fhhMapaResumo').textContent.includes('07/10/2026 23:59'));
  assert.equal(a.el('fhhConsultar').disabled,false);assert.ok(a.mapa.enquadrado);assert.ok(a.camadas.length);
});
test('Interface rejeita sexto dia antes de consultar e libera a tela apos falha',async()=>{
  const a=ambiente();await a.api.abrir(PLACA);a.el('fhhInicio').value='2026-10-02';const n=a.pedidos.length;await a.el('fhhForm').onsubmit({preventDefault(){}});assert.equal(a.pedidos.length,n);assert.ok(a.el('fhhStatus').textContent.includes('5 dias'));
  a.el('fhhInicio').value=HOJE;a.responder(async()=>{throw Error('Falha de rede');});await a.el('fhhForm').onsubmit({preventDefault(){}});assert.equal(a.el('fhhConsultar').disabled,false);assert.ok(a.el('fhhStatus').textContent.includes('Falha de rede'),a.el('fhhStatus').textContent);
});
test('Resposta atrasada nao troca o historico novo e sair da aba cancela consulta',async()=>{
  const a=ambiente();await a.api.abrir(PLACA);let terminar;
  a.responder(()=>new Promise(resolve=>{terminar=resolve;}));const velha=a.el('fhhForm').onsubmit({preventDefault(){}});await Promise.resolve();await Promise.resolve();
  a.el('fhhInicio').value='2026-10-06';a.responder(async()=>dados('2026-10-06'));await a.el('fhhForm').onsubmit({preventDefault(){}});
  assert.equal(typeof terminar,'function',a.el('fhhStatus').textContent);terminar(dados());await velha;assert.ok(a.el('fhhMapaResumo').textContent.includes('06/10/2026'));
  let acabar;a.responder(()=>new Promise(resolve=>{acabar=resolve;}));const pendente=a.el('fhhForm').onsubmit({preventDefault(){}});await Promise.resolve();await Promise.resolve();a.api.ocultar();assert.equal(a.el('fhhConsultar').disabled,false);assert.ok(a.pedidos.at(-1).options.signal.aborted);acabar(dados());await pendente;assert.ok(a.el('fhhMapaResumo').textContent.includes('06/10/2026'));
});

test('Atalho consulta automaticamente a placa e o dia escolhidos na Frota',async()=>{
  const a=ambiente();a.responder(async()=>dados('2026-10-06','2026-10-06'));
  await a.api.abrir(PLACA,{data:'2026-10-06',consultar:true});
  const q=new URL(a.pedidos.at(-1).url,'http://localhost').searchParams;
  assert.equal(q.get('placa'),PLACA);assert.equal(q.get('inicio'),'2026-10-06');assert.equal(q.get('fim'),'2026-10-06');
  assert.equal(a.el('fhhInicio').value,'2026-10-06');assert.equal(a.el('fhhFim').value,'2026-10-06');assert.ok(a.mapa.enquadrado);
});

test('Atalho sem veiculo prepara o dia e aguarda a escolha; retorno usa a navegacao da Frota',async()=>{
  const a=ambiente();await a.api.abrir(undefined,{data:'2026-10-05',consultar:false});
  assert.equal(a.pedidos.length,1);assert.equal(a.el('fhhInicio').value,'2026-10-05');assert.equal(a.el('fhhFim').value,'2026-10-05');
  assert.ok(a.el('fhhStatus').textContent.includes('Escolha um veículo'));a.el('fhhVoltarBtn').onclick();assert.equal(a.voltas(),1);
});

test('Veiculo sem leituras nao dispara consulta usando a selecao anterior',async()=>{
  const a=ambiente();await a.api.abrir(PLACA);const n=a.pedidos.length;
  await a.api.abrir('XYZ9Z99',{data:HOJE,consultar:true});
  assert.equal(a.pedidos.length,n);assert.equal(a.el('fhhVeiculo').value,'');assert.ok(a.el('fhhStatus').textContent.includes('XYZ9Z99'));
});

test('Reabrir a aba preserva periodo personalizado, enquanto o atalho adota o dia da Frota',async()=>{
  const a=ambiente();await a.api.abrir(PLACA);a.el('fhhInicio').value='2026-10-03';a.el('fhhFim').value='2026-10-05';
  await a.api.abrir(PLACA);assert.equal(a.el('fhhInicio').value,'2026-10-03');assert.equal(a.el('fhhFim').value,'2026-10-05');
  await a.api.abrir(PLACA,{data:HOJE,consultar:true});assert.equal(a.el('fhhInicio').value,HOJE);assert.equal(a.el('fhhFim').value,HOJE);
});

test('Sair imediatamente durante abertura impede consulta automatica atrasada',async()=>{
  const a=ambiente();const abertura=a.api.abrir(PLACA,{data:HOJE,consultar:true});a.api.ocultar();await abertura;
  assert.equal(a.pedidos.length,1);assert.equal(a.el('fhhVeiculo').value,'');
});

function frota(){
  const ids=new Map(),abas=[],aberturas=[],telaCheia=[];let ocultou=0;
  const el=id=>{if(!ids.has(id)){const classes=new Set();ids.set(id,{id,dataset:{},style:{},value:'',hidden:false,innerHTML:'',classList:{add:k=>classes.add(k),remove:k=>classes.delete(k),contains:k=>classes.has(k),toggle(k,v){v?classes.add(k):classes.delete(k);}},setAttribute(k,v){this[k]=v;},querySelector:s=>s[0]==='#'?el(s.slice(1)):null,querySelectorAll:s=>s==='.frt-abas [data-parte]'?abas:[]});}return ids.get(id);};
  for(const parte of ['vivo','historico','operacao','rota','relatorios','areas','manutencao']){const b=el('aba-'+parte);b.dataset.parte=parte;abas.push(b);}
  const context={window:{location:{origin:'http://localhost'},frtPeriodo:periodo,frtHistorico:{abrir:(...args)=>aberturas.push(args),ocultar:()=>ocultou++},frtTelaCheia:{montar:(_,opcoes)=>telaCheia.push(opcoes)}},document:{getElementById:el,querySelector:()=>null},localStorage:{getItem:()=>null},Date,Intl,Map,Set,WeakMap,clearInterval,setTimeout:fn=>fn()};
  let src=fs.readFileSync(require.resolve('../../public/js/frota.js'),'utf8');const end=src.lastIndexOf('})();');
  src=src.slice(0,end)+'window.teste={st,montar,renderDetalhe};'+src.slice(end);vm.runInNewContext(src,context);
  const api=context.window.teste;api.montar();api.st.data='2026-10-06';
  return {el,abas,aberturas,telaCheia,api,voltar:context.window.frtApi.voltarAoVivo,ocultou:()=>ocultou};
}

test('Aba separada de historico continua acessivel e retorno preserva data e placa',()=>{
  const a=frota();a.api.st.sel=PLACA;a.abas.find(b=>b.dataset.parte==='historico').onclick();
  assert.equal(a.el('frtVivo').hidden,true);assert.equal(a.el('frtParteHistorico').hidden,false);
  assert.equal(a.abas.find(b=>b.dataset.parte==='historico')['aria-selected'],'true');
  assert.equal(a.aberturas[0][0],PLACA);
  a.voltar();assert.equal(a.el('frtVivo').hidden,false);assert.equal(a.el('frtParteHistorico').hidden,true);assert.equal(a.ocultou(),1);
  assert.equal(a.api.st.sel,PLACA);assert.equal(a.api.st.data,'2026-10-06');assert.equal(a.telaCheia[0].parte,'frtVivo');
});

test('Ao vivo oferece campos De e Ate e consulta no proprio painel',()=>{
  const a=frota();const html=a.el('frtRaiz').innerHTML;
  assert.ok(html.includes('id="frtDataFim"'));assert.ok(html.includes('id="frtConsultarBtn"'));assert.ok(!html.includes('id="frtHistoricoBtn"'));
  assert.equal(typeof a.el('frtConsultarBtn').onclick,'function');a.el('frtDataFim').onchange();
  assert.equal(a.aberturas.length,0);assert.ok(a.el('frtAviso').innerHTML.includes('Consultar período'));
});
