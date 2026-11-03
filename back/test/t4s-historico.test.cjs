'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const t4s=require('../rastreador-t4s'),q=require('../gps-precisao');
const {eventosAusentes,validarPontos,criar,selecionarHistorico}=require('../rastreador-t4s-historico');
const headers=['Placa','Modelo veículo','Rastreador','Tecnologia','Data do recebimento','Data da posição','Endereço','Lat/Long','Violação','Bateria backup','Ignição','Bloqueio','GPS/LBS','Velocidade','Bloqueador 1','Bloqueador 2'];
const row=(em,extra={})=>['FKA0C10','Accelo','68560','Safeloggy','08/10/2026 11:53:03',em,'Rua',extra.coord||'-22,87558800 / -43,46590100','Off','Off',extra.motor||'Off','Off',extra.fix||'GPS',extra.vel||'0 km/h','Normal','Normal'];
const html=(rows,pages=1)=>'<table><tr>'+headers.map(h=>'<th>'+h+'</th>').join('')+'</tr>'+rows.map(r=>'<tr>'+r.map(c=>'<td>'+c+'</td>').join('')+'</tr>').join('')+'</table><a href="?page='+pages+'">próxima</a>';
const ini='2026-10-08T10:00:00-03:00',fim='2026-10-08T11:40:00-03:00';

test('Coleta ao vivo usa data GPS em vez da comunicação que chegou dezenove minutos depois',()=>{
  const c=row('08/10/2026 11:34:53');c[8]='08/10/2026 11:53:03';c[9]='08/10/2026 11:34:53';
  const tr='<input class="checkboxVehicle" value="68560|4|-22,875|-43,466|08/10/2026 11:53:03 -03:00|FKA0C10|1">'+c.map(x=>'<td>'+x+'</td>').join('');
  assert.equal(t4s.lerLinha(tr).posicao_em.toISOString(),'2026-10-08T14:34:53.000Z');
});

test('Relatório usa data real do GPS e coordenadas completas, rejeitando LBS e outra placa',()=>{
  const outra=row('08/10/2026 11:13:52');outra[0]='FKB1D11';
  const r=t4s.lerHistorico(html([row('08/10/2026 11:13:52'),row('08/10/2026 11:14:52',{fix:'LBS'}),outra],3),'FKA0C10',68560);
  assert.equal(r.paginas,3);assert.equal(r.pontos.length,1);
  assert.equal(r.pontos[0].posicao_em.toISOString(),'2026-10-08T14:13:52.000Z');
  assert.equal(r.pontos[0].lat,-22.875588);assert.equal(r.pontos[0].motor,'desligado');
});
test('Mudança de cabeçalho interrompe importação, preservando a interpretação das colunas',()=>{
  assert.throws(()=>t4s.lerHistorico(html([row('08/10/2026 11:13:52')]).replace('Data da posição','Outra data'),'FKA0C10',68560),/formato/);
});

test('Mensagem Sem posições de madrugada é um intervalo vazio válido; formato desconhecido continua rejeitado',()=>{
  assert.deepEqual(t4s.lerHistorico('Sem posi&#231;&#245;es','FKD3F13',1),{pontos:[],paginas:1});
  assert.deepEqual(t4s.lerHistorico('<div>Sem posições</div>','FKD3F13',1),{pontos:[],paginas:1});
  assert.throws(()=>t4s.lerHistorico('<div>Erro desconhecido</div>','FKD3F13',1),/formato/);
});
test('Consulta busca todas as páginas e ordena pela posição, não pelo recebimento',async()=>{
  const old=process.env.T4S_COOKIE;process.env.T4S_COOKIE='session-test';const calls=[];
  try {
    const fetcher=async(url,opts)=>{const data=new URLSearchParams(opts.body);calls.push({url,data});return {ok:true,status:200,headers:{getSetCookie:()=>[]},text:async()=>url.endsWith('DetailedEventsDeviceIdAndTechnologyId')?'<option value="68560*4">Atual</option>':html([row(data.get('Page')==='1'?'08/10/2026 11:24:50':'08/10/2026 11:13:52')],2)};};
    const r=await t4s.listarHistorico('FKA0C10',68560,ini,fim,{fetcher});assert.equal(calls.length,3);
    assert.equal(calls[1].data.get('DeviceIdAndTechnologyId'),'68560*4');assert.equal(calls[1].data.get('GPRSDatetimeFrom'),'08/10/2026 10:00');
    assert.deepEqual(r.map(p=>p.posicao_em.toISOString()),['2026-10-08T14:13:52.000Z','2026-10-08T14:24:50.000Z']);
  } finally {if(old===undefined)delete process.env.T4S_COOKIE;else process.env.T4S_COOKIE=old;}
});
test('Página repetida e aparelho de outra placa interrompem o relatório',async()=>{
  const old=process.env.T4S_COOKIE;process.env.T4S_COOKIE='session-test';
  try {
    const fetcher=async(url)=>({ok:true,status:200,headers:{getSetCookie:()=>[]},text:async()=>url.endsWith('DetailedEventsDeviceIdAndTechnologyId')?'<option value="68560*4">Atual</option>':html([row('08/10/2026 11:13:52')],2)});
    await assert.rejects(t4s.listarHistorico('FKA0C10',68560,ini,fim,{fetcher}),/repetiu/);
    await assert.rejects(t4s.listarHistorico('FKA0C10',99,ini,fim,{fetcher}),/não pertence/);
  } finally {if(old===undefined)delete process.env.T4S_COOKIE;else process.env.T4S_COOKIE=old;}
});
test('Raio manual de Bangu I permanece em 200 metros mesmo com vizinha a 403 metros',()=>{
  const a={codigo:'341',nome:'BANGU I',lat:-22.8785278,lng:-43.4681582,raio_entrada_m:200,raio_saida_m:300,area_personalizada:true};
  const b={codigo:'549',lat:-22.87557265151512,lng:-43.46588718867924,raio_entrada_m:23,raio_saida_m:36,area_personalizada:true};
  const [x,y]=q.ajustarAreasProximas([a,b]);assert.equal(x.raio_entrada_m,200);assert.equal(x.raio_saida_m,300);assert.equal(y.raio_entrada_m,23);
});
test('Áreas manuais sobrepostas continuam ambíguas e não geram duas entregas',()=>{
  const l={codigo:'341',lat:-22.8785278,lng:-43.4681582,raio_entrada_m:200,raio_saida_m:300,area_personalizada:true};
  const lugares=q.ajustarAreasProximas([l,{...l,codigo:'549'}]);
  const p=(min,extra={})=>({placa:'FKA0C10',device_id:68560,fonte:'t4s',...l,velocidade:0,motor:'desligado',posicao_em:new Date('2026-10-08T13:'+min+':00Z'),...extra});
  assert.deepEqual(eventosAusentes([p('00',{lat:l.lat+.01,velocidade:30}),p('01'),p('02')],lugares,{paradas:[{loja_codigo_pes:'341'},{loja_codigo_pes:'549'}]},[]),[]);
});
test('Bangu V confirma 11:13 com motor desligado e nova posição parada ao ligar às 11:24',()=>{
  const l={codigo:'549',lat:-22.87557265151512,lng:-43.46588718867924,raio_entrada_m:23,raio_saida_m:36,area_personalizada:true};
  const pontos=t4s.lerHistorico(html([row('08/10/2026 10:56:55',{coord:'-22,875615 / -43,465270',motor:'On',vel:'17 km/h'}),row('08/10/2026 11:13:52'),row('08/10/2026 11:24:50',{motor:'On'}),row('08/10/2026 11:25:57',{coord:'-22,875593 / -43,466033',motor:'On',vel:'13 km/h'}),row('08/10/2026 11:26:56',{coord:'-22,875750 / -43,470635',motor:'On',vel:'35 km/h'})]),'FKA0C10',68560).pontos;
  const v={paradas:[{loja_codigo_pes:'549'}]},r=eventosAusentes(pontos,[l],v,[]);
  assert.deepEqual(r.map(e=>e.tipo),['chegou_loja','saiu_loja']);assert.equal(r[0].em.toISOString(),'2026-10-08T14:13:52.000Z');assert.equal(r[1].em.toISOString(),'2026-10-08T14:25:57.000Z');
  assert.equal(eventosAusentes(pontos,[l],v,[{tipo:'chegou_loja',lugar_codigo:'549'},{tipo:'saiu_loja',lugar_codigo:'549'}]).length,0);
});
test('Validação elimina outra fonte, aparelho errado, posição fora do período e salto impossível',()=>{
  const p=t4s.lerHistorico(html([row('08/10/2026 11:13:52')]),'FKA0C10',68560).pontos[0];
  const lista=[p,{...p,fonte:'sat'},{...p,device_id:9},{...p,posicao_em:new Date('2026-10-07T10:00:00Z')},{...p,posicao_em:new Date(+p.posicao_em+1000),lat:-20}];
  assert.deepEqual(validarPontos(lista,'FKA0C10',68560,ini,fim),[p]);
});
test('Histórico respeita fonte bloqueada e a escolha de fonte preferida',()=>{
  const pontos=Array.from({length:6},(_,i)=>({placa:'FKA0C10',fonte:'t4s',device_id:68560,lat:-22.875,lng:-43.466,
    velocidade:0,motor:'desligado',posicao_em:new Date(Date.parse('2026-10-08T13:00:00Z')+i*60000)}));
  assert.equal(selecionarHistorico(pontos,'FKA0C10',null,new Set(['t4s'])).length,0);
  const sat=pontos.map(p=>({...p,fonte:'sat',device_id:1,lat:-22.95,lng:-43.6}));
  assert.ok(selecionarHistorico([...pontos,...sat],'FKA0C10','sat',new Set()).every(p=>p.fonte==='sat'));
});
test('Viagem alterada durante a consulta não recebe eventos sob a placa antiga',async()=>{
  const escritas=[];const client={query:async(sql)=>{escritas.push(sql);return {rows:sql.startsWith('SELECT id,placa')?[{id:281,placa:'FKB1D11',status:'Em rota'}]:[]};},release(){}};
  const db={query:async()=>({rows:[]}),connect:async()=>client};
  const svc=criar({db,rastreador:{coordenadas:async()=>new Map()},t4s:{}});
  const r=await svc.recuperar({id:281,placa:'FKA0C10'},{fonte:'t4s',device_id:68560},{desde:ini,ate:fim,pontos:[]});
  assert.equal(r.alterada,true);assert.ok(escritas.includes('ROLLBACK'));assert.ok(escritas.every(s=>!s.startsWith('INSERT')));
});

test('Falha na segunda pagina conserva a primeira antes de interromper a consulta',async()=>{
  const old=process.env.T4S_COOKIE;process.env.T4S_COOKIE='session-test';const salvos=[];
  try {
    const fetcher=async(url,opts)=>{
      const page=new URLSearchParams(opts.body).get('Page');
      if(page==='2'){assert.equal(salvos.length,1);throw Error('rede caiu');}
      return {ok:true,status:200,headers:{getSetCookie:()=>[]},text:async()=>
        url.endsWith('DetailedEventsDeviceIdAndTechnologyId')?'<option value="68560*4">Atual</option>':
          html([row('08/10/2026 11:13:52')],2)};
    };
    await assert.rejects(t4s.listarHistorico('FKA0C10',68560,ini,fim,
      {fetcher,onPagina:async pontos=>salvos.push(...pontos)}),/rede caiu/);
    assert.equal(salvos[0].posicao_em.toISOString(),'2026-10-08T14:13:52.000Z');
  } finally {if(old===undefined)delete process.env.T4S_COOKIE;else process.env.T4S_COOKIE=old;}
});

test('Boot à tarde recupera primeiras horas e continua avançando também em viagem finalizada',async()=>{
  let momento=Date.parse('2026-10-08T15:00:00-03:00');const consultas=[];
  const v={id:281,placa:'FKA0C10',data_viagem:'2026-10-08',status:'Finalizada',paradas:[]};
  const banco={query:async sql=>({rows:sql.includes('FROM rastreador_aparelhos')?[{placa:v.placa,fonte:'t4s',device_id:68560}]:[]}),
    connect:async()=>({query:async sql=>({rows:sql.startsWith('SELECT id,placa')?[v]:[]}),release(){}})};
  const svc=criar({db:banco,rastreador:{coordenadas:async()=>new Map()},agora:()=>momento,
    sinais:{guardar:async()=>0},t4s:{configurado:()=>true,listarHistorico:async(_placa,_device,de,ate)=>{consultas.push({de:+de,ate:+ate});return [];}}});
  await svc.rodar([v]);
  const inicio=Date.parse('2026-10-08T00:00:00-03:00');
  assert.equal(consultas[0].de,inicio);assert.equal(consultas.at(-1).ate,inicio+6*3600000);
  const qtd=consultas.length;momento+=5*60000;await svc.rodar([v]);
  assert.equal(consultas[qtd].de,inicio+4.5*3600000);
  assert.equal(consultas.at(-1).ate,inicio+10.5*3600000);
});
