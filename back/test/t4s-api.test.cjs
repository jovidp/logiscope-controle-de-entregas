'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { criar, mapearPosicao } = require('../t4s-api');
const { criar: criarRotas, filtrosAlertas } = require('../t4s-api-rotas');
const credenciais = () => ({ T4S_CLIENT_KEY: 'chave-teste', T4S_CLIENT_SECRET: 'segredo-teste' });
const resposta = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const posicao = (extra = {}) => ({ plate: 'ABC1234', deviceId: 100, latitude: -22.88, longitude: -43.40,
  positionDate: '2026-10-08T10:00:00-03:00', systemDate: '2026-10-08T12:00:00-03:00', speed: 0, ignition: 'Offline', ...extra });
const paginada = (chave, itens, page = 1, total = itens.length) => ({ [chave]: itens, page, totalRecords: total, success: true });
function cliente(consulta, env = credenciais()) {
  let logins = 0;
  const api = criar({ env, fetcher: async (url, opcoes) => {
    if (new URL(url).pathname === '/api/Authentication') { logins++; return resposta({authenticated:true, token:`token-${logins}`}); }
    return consulta(new URL(url), opcoes);
  }});
  return { api, logins: () => logins };
}
async function chamar(handler, query = {}) {
  const r = { code: 200, data: null, set() {}, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
  await handler({query}, r); return r;
}

test('sem credenciais nao consulta e nao divulga segredos no status', async () => {
  const api = criar({env:{T4S_CLIENT_KEY:'chave-teste'},fetcher:()=>assert.fail('nao deve consultar')});
  assert.deepEqual(api.info(), {configurado:false,credenciais_incompletas:true,autenticado_em:null,ultima_consulta:null,erro:null});
  await assert.rejects(api.listarRotas(), e => e.statusCliente === 503);
});
test('autentica com ClientKey/ClientSecret, usa Bearer e compartilha login concorrente', async () => {
  const pedidos = [];
  const api = criar({env:credenciais(),fetcher:async (url, o) => {
    pedidos.push({url:new URL(url),o});
    return resposta(new URL(url).pathname === '/api/Authentication' ? {token:'teste',authenticated:true}
      : paginada('routes',[]));
  }});
  await Promise.all([api.listarRotas(), api.listarRotas()]);
  assert.equal(pedidos.filter(p=>p.o.method==='POST').length,1);
  assert.deepEqual(JSON.parse(pedidos[0].o.body),{ClientKey:'chave-teste',ClientSecret:'segredo-teste'});
  assert.equal(pedidos[0].url.host,'authentication-rastreamento.t4stecnologia.com.br');
  assert.equal(pedidos[1].url.host,'externalapi-rastreamento.t4stecnologia.com.br');
  assert.equal(pedidos[1].o.headers.Authorization,'Bearer teste');
  assert.equal(pedidos[1].o.redirect,'manual');
  assert.equal(pedidos[1].url.searchParams.get('RecordsPerPage'),'20');
  assert.equal(JSON.stringify(api.info()).includes('teste'),false);
});
test('renova uma vez quando o endpoint responde 401', async () => {
  let n = 0;
  const c = cliente((_u,o)=>{n++;return o.headers.Authorization==='Bearer token-1' ? resposta({},401) : resposta(paginada('routes',[]));});
  await c.api.listarRotas(); assert.equal(n,2); assert.equal(c.logins(),2);
});
test('401 persistente para apos uma renovacao; 403 nao renova', async () => {
  for (const status of [401,403]) {
    let n=0;const c=cliente(()=>{n++;return resposta({},status);});
    await assert.rejects(c.api.listarRotas(),/acesso recusado/);
    assert.equal(c.logins(),status===401?2:1);assert.equal(n,status===401?2:1);
  }
});
test('renova antes de expirar o JWT e quando mudam as credenciais', async () => {
  let agora=1000000,n=0;const env=credenciais();
  const api=criar({env,agora:()=>agora,fetcher:async url=>{
    if(new URL(url).pathname==='/api/Authentication'){n++;return resposta({token:`x.${Buffer.from(JSON.stringify({exp:(agora+100000)/1000})).toString('base64url')}.x`});}
    return resposta(paginada('routes',[]));
  }});
  await api.listarRotas();agora+=92000;await api.listarRotas();assert.equal(n,2);
  env.T4S_CLIENT_SECRET='outro';await api.listarRotas();assert.equal(n,3);
});
test('token ausente, expirado e falha logica nao viram sucesso', async () => {
  for(const dados of [{}, {token:'x',authenticated:false}, {token:`x.${Buffer.from('{"exp":1}').toString('base64url')}.x`}]){
    const api=criar({env:credenciais(),fetcher:async()=>resposta(dados)});
    await assert.rejects(api.listarRotas());
  }
  const c=cliente(()=>resposta({success:false,msgError:'segredo-teste'}));
  await assert.rejects(c.api.listarRotas(),e=>!/segredo-teste/.test(e.message));
});
test('timeout inclui leitura do corpo e erros de rede nao revelam dados sensiveis', async () => {
  const api=criar({env:{...credenciais(),T4S_API_TIMEOUT_MS:'5'},fetcher:async(_u,o)=>({ok:true,status:200,
    json:()=>new Promise((_,reject)=>o.signal.addEventListener('abort',()=>reject(new Error('segredo')),{once:true}))})});
  await assert.rejects(api.listarRotas(),/sem resposta/);
  const rede=criar({env:credenciais(),fetcher:async()=>{throw new Error('segredo-teste');}});
  await assert.rejects(rede.listarRotas(),e=>e.message==='T4S: nao foi possivel conectar ao servico.');
});
test('URLs configuradas exigem HTTPS e origem sem credenciais ou redirecionamento', async () => {
  for(const url of ['http://example.com','https://u:segredo@example.com','https://example.com/api','https://example.com/?token=segredo']){
    const c=cliente(()=>assert.fail('nao consulta'),{...credenciais(),T4S_API_URL:url});
    await assert.rejects(c.api.listarRotas(),e=>e.statusCliente===503);assert.equal(c.logins(),0);
  }
  const c=cliente(()=>resposta({},302));await assert.rejects(c.api.listarRotas(),/HTTP 302/);
});
test('posicoes percorrem paginas, descartam dados invalidos e mantem ultima posicao por aparelho', async () => {
  const paginas=[];const c=cliente(u=>{
    const p=Number(u.searchParams.get('PageNumber'));paginas.push(p);
    return resposta(paginada('lastpositions',p===1?[posicao(),posicao({deviceId:101,latitude:null})]
      :[posicao({positionDate:'2026-10-08T10:02:00-03:00'}),posicao({deviceId:102,plate:'XYZ9A99'})],p,22));
  });
  const lista=await c.api.listarPosicoes();assert.deepEqual(paginas,[1,2]);assert.equal(lista.length,2);
  assert.equal(lista[0].posicao_em.toISOString(),'2026-10-08T13:02:00.000Z');assert.equal(lista[0].placa,'ABC1C34');
});
test('paginacao incorreta, repetida, vazia ou excessiva interrompe a coleta', async () => {
  for(const modo of ['pagina','repetida','vazia','excessiva']){
    const c=cliente(u=>{
      const p=Number(u.searchParams.get('PageNumber'));
      return resposta(paginada('lastPositions',modo==='vazia'?[]:[posicao()],modo==='pagina'?0:p,modo==='excessiva'?2001:modeTotal(modo)));
    });
    await assert.rejects(c.api.listarPosicoes());
  }
  function modeTotal(modo){return modo==='vazia'?40:21;}
});
test('mapeamento preserva hora GPS e ignicao sem inventar coordenadas ou velocidade', () => {
  const p=mapearPosicao(posicao());assert.equal(p.posicao_em.toISOString(),'2026-10-08T13:00:00.000Z');assert.equal(p.motor,'desligado');
  assert.equal(mapearPosicao(posicao({ignition:'Online'})).motor,'ligado');
  assert.equal(mapearPosicao(posicao({ignition:'desconhecida'})).motor,null);
  for(const extra of [{latitude:null},{longitude:''},{latitude:100},{latitude:0,longitude:0},{speed:null},{speed:300},{deviceId:0},{positionDate:'2026-10-08T10:00:00'},{plate:'errada'}]) assert.equal(mapearPosicao(posicao(extra)),null);
});
test('pagina final vazia com registros declarados nao e tratada como coleta completa', async () => {
  const c=cliente(u=>{
    const p=Number(u.searchParams.get('PageNumber'));
    return resposta(paginada('lastpositions',p===1?[posicao()]:[],p,21));
  });
  await assert.rejects(c.api.listarPosicoes(),/vazia/);
});
test('limite global impede percorrer paginas por tempo indefinido', async () => {
  let agora=1000000,pedidos=0;
  const api=criar({env:credenciais(),agora:()=>agora,fetcher:async url=>{
    if(new URL(url).pathname==='/api/Authentication')return resposta({token:'token'});
    const p=Number(new URL(url).searchParams.get('PageNumber'));pedidos++;agora+=31000;
    return resposta(paginada('lastpositions',[posicao({deviceId:p})],p,60));
  }});
  await assert.rejects(api.listarPosicoes(),/excedeu um minuto/);assert.equal(pedidos,2);
});
test('Alertas usa filtros documentados e placas repetidas na query', async () => {
  const c=cliente(u=>{
    assert.equal(u.pathname,'/api/Alerts');assert.deepEqual(u.searchParams.getAll('Plates'),['ABC1234','XYZ9A99']);
    assert.equal(u.searchParams.get('DateStart'),'08/10/2026');assert.equal(u.searchParams.get('Status'),'2');
    return resposta(paginada('alerts',[]));
  });
  await c.api.listarAlertas({plates:['ABC1234','XYZ9A99'],dateStart:'08/10/2026',dateEnd:'08/10/2026',status:[2]});
});
test('filtros rejeitam datas impossiveis, periodos longos, placas e paginas invalidas', () => {
  const base={inicio:'2026-10-08',fim:'2026-10-08'};
  assert.deepEqual(filtrosAlertas({...base,placa:'ABC-1234',status:'0'}),{page:1,plates:['ABC1234'],dateStart:'08/10/2026',dateEnd:'08/10/2026',status:[0]});
  for(const q of [{inicio:'2026-02-30'},{fim:'2026-10-07'},{fim:'2026-11-09'},{page:'1abc'},{page:'101'},{placa:'?token'},{status:'-1'},{inicio:['2026-10-08']}]) assert.throws(()=>filtrosAlertas({...base,...q}),e=>e.statusCliente===400);
});
test('rotas locais compartilham consultas, exibem apenas campos publicos e usam cache', async () => {
  let n=0;const api={configurado:()=>true,listarRotas:async()=>{n++;return {itens:[{routeId:1,name:'Rota',tolerance:50,processed:true,token:'segredo'}],page:1,totalRecords:1,totalPages:1,recordsPerPage:20};}};
  const rotas=criarRotas({api,navegador:{},rastreador:{}});
  const [a,b]=await Promise.all([chamar(rotas.rotas),chamar(rotas.rotas)]);
  assert.equal(n,1);assert.deepEqual(a.data,b.data);assert.equal(JSON.stringify(a.data).includes('segredo'),false);
  assert.deepEqual(a.data.itens[0],{id:1,nome:'Rota',tolerancia:50,processada:true});
});
test('rotas locais mostram falta de credenciais e erro de filtros sem consulta externa', async () => {
  const api={configurado:()=>false,info:()=>({configurado:false}),listarAlertas:()=>assert.fail('nao consulta')};
  const rotas=criarRotas({api,navegador:{historicoConfigurado:()=>true},rastreador:{estado:{t4s:{aparelhos:2}}}});
  assert.equal((await chamar(rotas.rotas)).code,503);
  assert.equal((await chamar(rotas.alertas,{inicio:'invalida'})).code,400);
  assert.equal((await chamar(rotas.status)).data.modo_posicoes,'navegador');
});
test('cache descarta erros para permitir tentar novamente', async () => {
  let n=0;const api={configurado:()=>true,listarRotas:async()=>{if(++n===1)throw new Error('interno');return {itens:[],page:1,totalRecords:0,totalPages:1,recordsPerPage:20};}};
  const r=criarRotas({api,navegador:{},rastreador:{}});
  assert.equal((await chamar(r.rotas)).code,502);assert.equal((await chamar(r.rotas)).code,200);assert.equal(n,2);
});
test('bridge usa API quando configurada e cookie continua disponivel sem credenciais', async () => {
  const nomes=['T4S_CLIENT_KEY','T4S_CLIENT_SECRET','T4S_COOKIE'],antes=Object.fromEntries(nomes.map(n=>[n,process.env[n]])),fetchAntes=global.fetch;
  try{
    delete process.env.T4S_CLIENT_KEY;delete process.env.T4S_CLIENT_SECRET;process.env.T4S_COOKIE='cookie-teste';
    const t4s=require('../rastreador-t4s');assert.equal(t4s.modoConexao(),'navegador');assert.equal(t4s.configurado(),true);
    const pedidos=[];global.fetch=async(u,o)=>{pedidos.push(new URL(u).pathname);if(new URL(u).pathname==='/Home/List')return {ok:true,status:200,headers:{getSetCookie:()=>[]},text:async()=>''};return resposta(new URL(u).pathname==='/api/Authentication'?{token:'bridge-token'}:paginada('lastpositions',[posicao()]));};
    assert.deepEqual(await t4s.listarAparelhos(),[]);assert.deepEqual(pedidos,['/Home/List']);
    process.env.T4S_CLIENT_KEY='bridge-key';process.env.T4S_CLIENT_SECRET='bridge-secret';
    assert.equal(t4s.modoConexao(),'api');assert.equal((await t4s.listarAparelhos()).length,1);
    assert.deepEqual(pedidos,['/Home/List','/api/Authentication','/api/LastPositions']);
    // Testar cookie novo deve usar o site mesmo com API habilitada.
    await t4s.listarAparelhos(100,'outro-cookie');assert.equal(pedidos.at(-1),'/Home/List');
  }finally{global.fetch=fetchAntes;for(const n of nomes)if(antes[n]===undefined)delete process.env[n];else process.env[n]=antes[n];}
});
test('posicoes da API alimentam detector existente de chegou e saiu da loja', () => {
  const {criarDetector}=require('../rastreador-ao-vivo');
  const loja={codigo:'A',nome:'Loja A',lat:-22.88,lng:-43.40};
  const d=criarDetector({agora:()=>Date.parse('2026-10-08T15:00:00-03:00')});
  const base=Date.parse('2026-10-08T10:00:00-03:00');
  const dados=[[0,-22.886,20],[60,-22.88,0],[120,-22.88,0],[180,-22.882,15],[240,-22.886,25],[300,-22.889,25]];
  const eventos=dados.flatMap(([seg,latitude,speed])=>d.processar(mapearPosicao(posicao({latitude,speed,positionDate:new Date(base+seg*1000).toISOString()})),[loja],{historico:true}));
  assert.deepEqual(eventos.map(e=>e.tipo),['chegou_loja','saiu_loja']);
  assert.equal(eventos[0].em.toISOString(),'2026-10-08T13:01:00.000Z');
});
