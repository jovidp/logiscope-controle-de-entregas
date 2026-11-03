'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const q=require('../gps-precisao');
const escolha=require('../rastreador-escolha');
const {criarDetector}=require('../rastreador-ao-vivo');
const {visitasDoDia}=require('../frota-visitas');
const {escolherTrajeto}=require('../frota');
const {validarArea,criarRotas}=require('../rastreador-ajustes');
const fs=require('node:fs'),vm=require('node:vm');
const requireLocal=require('node:module').createRequire(require.resolve('../rastreador-ao-vivo'));
const agora=Date.parse('2026-10-06T15:00:00Z');
const ponto=(fonte='srf',extra={})=>({placa:'FKB1D11',device_id:1,fonte,lat:-22.9,lng:-43.5,velocidade:0,posicao_em:new Date(agora-60000),...extra});
const loja={codigo:'A',nome:'Loja A',lat:-22.9,lng:-43.5};
const leitura=(min,extra={})=>ponto('srf',{posicao_em:new Date(agora+min*60000),...extra});
const det=()=>criarDetector({agora:()=>agora+86400000});
const fora=()=>leitura(0,{lat:loja.lat+.006,velocidade:30});

test('Fonte bloqueada nunca volta como reserva, mesmo sendo a única',()=>{
  assert.equal(escolha.escolherAtual([ponto()], 'srf',agora,new Set(['srf'])).escolhida,null);
  assert.equal(escolherTrajeto([{...ponto(),t:agora}],null,new Set(['srf'])).lista.length,0);
});
test('Aparelho não vinculado é excluído da seleção',()=>{
  const r=escolha.escolherAtual([ponto(),ponto('t4s',{device_id:2})],null,agora,new Set(),{srf:99});
  assert.equal(r.escolhida.fonte,'t4s');assert.equal(r.rejeitadas[0].motivo,'aparelho não vinculado');
});
test('Sinal preferido defasado não vence uma posição recente',()=>{
  const atual=ponto('sat',{posicao_em:new Date(agora-10000)});
  const velho=ponto('srf',{posicao_em:new Date(agora-3*60000)});
  const r=escolha.escolherAtual([velho,atual],'srf',agora);
  assert.equal(r.escolhida,atual);assert.deepEqual(r.defasadas,['srf']);
});
test('Sinal antigo permanece como última posição e não como preferido',()=>{
  const r=escolha.escolherAtual([ponto('sat',{posicao_em:new Date(agora-8*60000)})],'sat',agora);
  assert.equal(r.motivo,'ultimo_sinal_antigo');
});
test('Dois aparelhos da mesma plataforma não criam maioria artificial',()=>{
  const lista=[ponto(),ponto('srf',{device_id:3,posicao_em:new Date(agora-50000)}),ponto('sat',{lat:-21.5,velocidade:30})];
  const r=escolha.escolherAtual(lista,null,agora);
  assert.equal(r.motivo,'discordancia_sem_consenso');assert.equal(r.confiavel_eventos,false);
});
test('Maioria com horários próximos descarta fonte em outro lugar',()=>{
  const r=escolha.escolherAtual([ponto('srf',{lat:-21}),ponto('sat'),ponto('t4s')],null,agora);
  assert.equal(r.motivo,'maioria');assert.ok(['sat','t4s'].includes(r.escolhida.fonte));assert.deepEqual(r.discordantes,['srf']);
});
test('Horários distantes não são comparados como posições simultâneas',()=>{
  const a=Array.from({length:8},(_,i)=>({...ponto(),t:agora+i*10*60000}));
  const b=a.map(p=>({...p,lat:-21,t:p.t+3*60000}));
  assert.equal(escolha.discorda(a,b),null);
});
test('Coordenadas nulas, vazias, fora do planeta e zero/zero são inválidas',()=>{
  for(const x of [{lat:null},{lng:''},{lat:91},{lng:181},{lat:0,lng:0}])assert.ok(q.motivoInvalido(ponto('srf',x),{agora}));
  assert.equal(q.motivoInvalido(ponto('srf',{lat:0,lng:-43}),{agora}),null);
});
test('Horário futuro, velocidade inválida e baixa precisão são rejeitados',()=>{
  for(const x of [{posicao_em:new Date(agora+120000)},{velocidade:-1},{velocidade:null},{accuracy:200},{valid:false}])assert.ok(q.motivoInvalido(ponto('srf',x),{agora}));
});
test('Salto isolado não contamina a próxima posição verdadeira',()=>{
  const f=q.criarFiltro();assert.equal(f.avaliar(ponto(),{agora}).ok,true);
  assert.equal(f.avaliar(ponto('srf',{lat:-21,posicao_em:new Date(agora)}),{agora}).motivo,'salto impossivel');
  assert.equal(f.avaliar(ponto('srf',{lat:-22.9001,posicao_em:new Date(agora)}),{agora}).ok,true);
  assert.equal(f.diagnostico()[0].rejeitadas,1);
});
test('Leitura repetida ou regressiva não atualiza posição aceita',()=>{
  const f=q.criarFiltro();f.avaliar(ponto(),{agora});
  assert.equal(f.avaliar(ponto(),{agora}).motivo,'leitura repetida');
  assert.equal(f.avaliar(ponto('srf',{posicao_em:new Date(agora-120000)}),{agora}).motivo,'horario regressivo');
});
test('Rua tem raio menor que shopping; tipo desconhecido mantém padrão',()=>{
  assert.deepEqual(q.perfilPonto('RUA'),{perfil:'rua',raio_entrada_m:80,raio_saida_m:150});
  assert.deepEqual(q.perfilPonto('SHOPPING/GALERIA'),{perfil:'shopping',raio_entrada_m:200,raio_saida_m:300});
  assert.equal(q.perfilPonto(null).raio_entrada_m,250);
  const pos={lat:loja.lat+.0012,lng:loja.lng};
  assert.equal(q.dentroLugar(pos,{...loja,...q.perfilPonto('RUA')}),false);
  assert.equal(q.dentroLugar(pos,{...loja,...q.perfilPonto('SHOPPING')}),true);
});
test('Chegada exige duas leituras distintas dentro da área de rua',()=>{
  const d=det(),rua={...loja,...q.perfilPonto('RUA')};
  assert.deepEqual(d.processar(fora(),[rua]),[]);
  assert.deepEqual(d.processar(leitura(1),[rua]),[]);
  assert.deepEqual(d.processar(leitura(1),[rua]),[]);
  const r=d.processar(leitura(2),[rua]);assert.equal(r[0].tipo,'chegou_loja');assert.equal(+r[0].em,+leitura(1).posicao_em);
});
test('Lacuna entre leituras não confirma chegada com amostras desconectadas',()=>{
  const d=det();d.processar(fora(),[loja]);d.processar(leitura(1),[loja]);
  assert.deepEqual(d.processar(leitura(9),[loja]),[]);
  assert.equal(d.processar(leitura(10),[loja])[0].tipo,'chegou_loja');
});
test('Salto do GPS não produz saída falsa da loja',()=>{
  const d=det();d.processar(leitura(0),[loja]);
  assert.deepEqual(d.processar(leitura(1,{lat:-21,velocidade:30}),[loja]),[]);
  assert.equal(d.estado.get('FKB1D11').dentro.codigo,'A');
  assert.deepEqual(d.processar(leitura(2),[loja]),[]);
});
test('Sinal antigo não gera evento ao vivo',()=>{
  const d=det();assert.deepEqual(d.processar(leitura(-10),[loja],{agora,maxIdadeMs:q.RECENTE_MS}),[]);
  assert.equal(d.estado.size,0);
});
test('Área sobreposta é ambígua mesmo quando a rota prefere uma loja',()=>{
  const b={...loja,codigo:'B',nome:'Loja B'};const d=det();d.processar(fora(),[loja,b]);d.processar(leitura(1),[loja,b],{preferidos:['B']});
  const r=d.processar(leitura(2),[loja,b],{preferidos:['B']});
  assert.equal(r[0].tipo,'local_incerto');assert.deepEqual(r[0].lugar.ambigua,['A','B']);
});
test('Visita ambígua não conta como entrega de nenhuma das lojas',()=>{
  const b={...loja,codigo:'B',nome:'Loja B'};
  const r=visitasDoDia([fora(),leitura(1),leitura(2),leitura(3)],[loja,b],{paradas:[{id:1,ordem:1,loja_codigo_pes:'A'},{id:2,ordem:2,loja_codigo_pes:'B'}]});
  assert.ok(r.some(v=>v.confirmacao_necessaria));assert.equal(r.filter(v=>v.sem_registro).length,2);
});
test('Polígono da fábrica mantém manobras dentro do pátio',()=>{
  const fab={...loja,codigo:'FABRICA',poligono:[[-22.901,-43.502],[-22.901,-43.498],[-22.899,-43.498],[-22.899,-43.502]]};
  const d=det();d.processar(leitura(0),[fab]);
  assert.deepEqual(d.processar(leitura(1,{lng:-43.4982,velocidade:20}),[fab]),[]);
  assert.deepEqual(d.processar(leitura(2,{lng:-43.4965,velocidade:20}),[fab]),[]);
  assert.equal(d.processar(leitura(3,{lng:-43.496,velocidade:20}),[fab])[0].tipo,'saiu_fabrica');
});
test('Área manual exige raios coerentes, coordenadas e polígono válidos',()=>{
  const base={...loja,perfil:'rua',raio_entrada_m:80,raio_saida_m:150};
  assert.equal(validarArea(base).perfil,'rua');
  for(const x of [{lat:null},{raio_saida_m:60},{raio_entrada_m:''},{poligono:[[0,0],[1,1]]}])assert.throws(()=>validarArea({...base,...x}));
  assert.throws(()=>validarArea({...base,poligono:[[-22,-43],[-22,-43.001],[-22.001,-43.001]]}));
});
test('Não permite vincular um ID pertencente a outra placa',async()=>{
  let gravou=false;
  const rotas=criarRotas({db:{query:async sql=>{if(sql.startsWith('SELECT'))return {rows:[]};gravou=true;return {rows:[]};}},rastreador:{placaMercosul:p=>p},registrarAuditoria:async()=>{}});
  const res={status(n){this.code=n;return this;},json(j){this.body=j;return this;}};
  await rotas.salvarAparelho({body:{placa:'FKB1D11',fonte:'srf',device_id:99}},res);
  assert.equal(res.code,400);assert.equal(gravou,false);
});
test('Lacuna longa ainda rejeita deslocamento fisicamente impossivel',()=>{
  const a=ponto('srf',{posicao_em:new Date(agora-20*60000)});
  const b=ponto('srf',{lat:-19,posicao_em:new Date(agora)});
  assert.equal(q.salto(a,b),true);
  assert.equal(q.salto(a,{...b,lat:a.lat+.01}),false);
});
test('Area com lados cruzados nao pode ser salva',()=>{
  const p=[[-22.901,-43.502],[-22.899,-43.498],[-22.901,-43.498],[-22.898,-43.502]];
  assert.equal(q.poligonoValido(p),false);
  assert.throws(()=>validarArea({...loja,perfil:'rua',raio_entrada_m:80,raio_saida_m:150,poligono:p}));
});
const vizinha=(codigo,metros,extra={})=>({...loja,codigo,nome:'Loja '+codigo,lat:loja.lat+metros/111195,...q.perfilPonto(null),...extra});

const niterois=()=>q.ajustarAreasProximas([
  {codigo:'471',nome:'NITERÓI II',lat:-22.893608238509323,lng:-43.12234296224493,...q.perfilPonto('RUA')},
  {codigo:'551',nome:'NITERÓI IV',lat:-22.894347833333335,lng:-43.12231938888889,...q.perfilPonto('RUA')},
]);
test('FKB1D11: ponto real a 67 m registra Niteroi II no lado oposto a vizinha',()=>{
  const locais=niterois(),p={lat:-22.893008,lng:-43.122333};
  assert.equal(locais[0].raio_entrada_m,32);assert.equal(q.dentroLugar(p,locais[0]),true);assert.equal(q.dentroLugar(p,locais[1]),false);
  const d=det();d.processar(leitura(0,{lat:-22.893008,lng:-43.13,velocidade:30}),locais);
  assert.deepEqual(d.processar(leitura(1,p),locais),[]);const [e]=d.processar(leitura(2,p),locais);
  assert.equal(e.tipo,'chegou_loja');assert.equal(e.lugar.codigo,'471');assert.equal(+e.em,+leitura(1).posicao_em);
});
test('Divisoria de lojas proximas nao cria duas chegadas nem atribui o ponto a vizinha',()=>{
  const locais=niterois();const meio={lat:(locais[0].lat+locais[1].lat)/2,lng:(locais[0].lng+locais[1].lng)/2};
  assert.ok(locais.every(l=>!q.dentroLugar(meio,l)));assert.ok(locais.every(l=>!q.dentroLugar({...meio,lat:meio.lat+.00003},l)));
  const b={lat:locais[1].lat-.0005,lng:locais[1].lng};assert.equal(q.dentroLugar(b,locais[1]),true);assert.equal(q.dentroLugar(b,locais[0]),false);
});
test('Dispersao medida do ponto aprendido conserva parada real de 06:41 sem ampliar area manual',()=>{
  const locais=niterois();const aprendido={...locais[0],origem:'rastreador',amostras:4,dispersao_m:65};
  const inicio={lat:-22.892477,lng:-43.122408};assert.equal(q.dentroLugar(inicio,aprendido),true);assert.equal(q.dentroLugar(inicio,locais[1]),false);
  for(const extra of [{area_personalizada:true},{origem:'manual'},{amostras:1},{dispersao_m:100}])assert.equal(q.dentroLugar(inicio,{...aprendido,...extra}),false);
  assert.equal(q.dentroLugar({...inicio,lat:locais[0].lat+.0015},aprendido),false);
});
test('Area estendida conserva limite do perfil, ajuste manual e histerese da saida',()=>{
  const locais=niterois();const longe={lat:locais[0].lat+.001,lng:locais[0].lng};
  assert.equal(q.dentroLugar(longe,locais[0]),false);assert.equal(q.dentroLugar(longe,locais[0],true),true);
  assert.equal(q.dentroLugar({...longe,lat:locais[0].lat+.002},locais[0],true),false);
  const manual=q.ajustarAreasProximas([{...locais[0],area_personalizada:true,raio_entrada_m:25,raio_saida_m:45},locais[1]]);
  assert.equal(q.dentroLugar({lat:-22.893008,lng:-43.122333},manual[0]),false);
});
test('Extensao verifica todas as vizinhas em vez de apenas a mais perto do centro',()=>{
  const a=vizinha('A',0,q.perfilPonto('RUA')),b=vizinha('B',60,q.perfilPonto('RUA')),c=vizinha('C',-100,q.perfilPonto('RUA'));
  const locais=q.ajustarAreasProximas([a,b,c]),p={lat:a.lat-70/111195,lng:a.lng};
  assert.equal(q.dentroLugar(p,locais[0]),false);assert.equal(q.dentroLugar(p,locais[2]),true);
});
test('Visitas do dia recuperam chegada real de Niteroi II sem marcar Niteroi IV',()=>{
  const locais=niterois(),p={lat:-22.893008,lng:-43.122333};
  const lista=[leitura(0,{...p,lng:-43.13,velocidade:30}),leitura(1,p),leitura(2,p),leitura(3,p),leitura(4,{...p,lat:p.lat+.002,velocidade:30})];
  const visitas=visitasDoDia(lista,locais,{paradas:[{id:1,loja_codigo_pes:'471'},{id:2,loja_codigo_pes:'551'}]});
  const real=visitas.find(v=>v.codigo==='471');assert.equal(real.chegada_vista,true);assert.equal(real.saiu,leitura(4).posicao_em.toISOString());assert.equal(real.min,3);
  assert.equal(visitas.find(v=>v.codigo==='551').sem_registro,true);
});
test('Lojas próximas recebem áreas menores sem mudar o cadastro de origem',()=>{
  const a=vizinha('A',0),b=vizinha('B',201);const [x,y]=q.ajustarAreasProximas([a,b]);
  assert.equal(x.raio_entrada_m,50);assert.equal(x.raio_saida_m,100);
  assert.equal(y.raio_entrada_m,50);assert.equal(y.raio_saida_m,100);
  assert.equal(x.ajuste_proximidade.vizinha_codigo,'B');assert.equal(x.ajuste_proximidade.distancia_m,201);
  assert.equal(a.raio_entrada_m,250);assert.equal(b.raio_saida_m,400);
  assert.equal(q.dentroLugar(a,x),true);assert.equal(q.dentroLugar(a,y),false);
});
test('Quanto menor a distância entre lojas, menores os raios de entrada e saída',()=>{
  const a=vizinha('A',0),b=vizinha('B',60);const [x,y]=q.ajustarAreasProximas([a,b]);
  assert.ok(x.raio_entrada_m>=20&&x.raio_entrada_m<50);
  assert.ok(x.raio_saida_m>x.raio_entrada_m&&x.raio_saida_m<100);
  assert.ok(x.raio_entrada_m+y.raio_entrada_m<q.distanciaM(a,b));
  assert.equal(q.dentroLugar(a,y),false);assert.equal(q.dentroLugar(b,x),false);
});
test('Lojas afastadas mantêm o perfil e a fábrica não reduz lojas vizinhas',()=>{
  const a=vizinha('A',0),b=vizinha('B',700,{...q.perfilPonto('SHOPPING')}),fab=vizinha('FABRICA',10);
  const r=q.ajustarAreasProximas([a,b,fab]);assert.equal(r[0],a);assert.equal(r[1],b);assert.equal(r[2],fab);
});
test('Coordenadas inválidas e pontos extras não participam da redução de lojas',()=>{
  const a=vizinha('A',0);const extras=[vizinha('CSG',10),vizinha('FILIAL_RESENDE',10),vizinha('DJOFFER',10),vizinha('FORA',10,{loja_cadastrada:false}),vizinha('B',10,{lat:null})];
  const r=q.ajustarAreasProximas([a,...extras]);assert.equal(r[0],a);assert.deepEqual(r.slice(1),extras);
});
test('Áreas desenhadas mantêm o contorno e ajuste manual menor não é ampliado',()=>{
  const a=vizinha('A',0,{area_personalizada:true,raio_entrada_m:25,raio_saida_m:45});
  const b=vizinha('B',100,{poligono:[[-22.902,-43.502],[-22.902,-43.498],[-22.898,-43.498],[-22.898,-43.502]]});
  const [x,y]=q.ajustarAreasProximas([a,b]);assert.equal(x.raio_entrada_m,25);assert.equal(x.raio_saida_m,45);assert.equal(y,b);
});
test('Shopping perto de outra loja também recebe limite menor',()=>{
  const a=vizinha('A',0,q.perfilPonto('SHOPPING')),b=vizinha('B',290,q.perfilPonto('RUA'));
  const [x,y]=q.ajustarAreasProximas([a,b]);assert.equal(x.perfil,'shopping');assert.equal(x.raio_entrada_m,50);assert.equal(y.raio_entrada_m,50);
});
test('Mesmo ponto mantém a necessidade de confirmação em vez de atribuir duas visitas',()=>{
  const locais=q.ajustarAreasProximas([vizinha('A',0),vizinha('B',0)]);assert.ok(locais.every(l=>l.raio_entrada_m===20&&l.ajuste_proximidade.sobreposicao_inevitavel));
  const d=det();d.processar(fora(),locais);d.processar(leitura(1),locais);const [e]=d.processar(leitura(2),locais);
  assert.equal(e.tipo,'local_incerto');assert.deepEqual(e.lugar.ambigua,['A','B']);
});
test('Lojas vizinhas passam a ter chegadas e saídas separadas nas visitas do dia',()=>{
  const a=vizinha('A',0),b=vizinha('B',201);const locais=q.ajustarAreasProximas([a,b]);
  const p=(min,l,vel=0)=>leitura(min,{lat:l.lat,lng:l.lng,velocidade:vel});
  const lista=[fora(),p(1,a),p(2,a),p(3,a),p(4,b,15),p(5,b),p(6,b),p(7,b),p(8,{...b,lat:b.lat+.005},30)];
  const r=visitasDoDia(lista,locais,{paradas:[{id:1,ordem:1,loja_codigo_pes:'A'},{id:2,ordem:2,loja_codigo_pes:'B'}]});
  assert.equal(r.length,2);assert.deepEqual(r.map(v=>v.codigo),['A','B']);assert.ok(r.every(v=>v.na_viagem&&!v.ambigua&&!v.sem_registro));
  assert.equal(r[0].chegou,leitura(1).posicao_em.toISOString());assert.equal(r[0].saiu,leitura(4).posicao_em.toISOString());
  assert.equal(r[1].chegou,leitura(5).posicao_em.toISOString());assert.equal(r[1].saiu,leitura(8).posicao_em.toISOString());
});
test('Carregamento das coordenadas entrega os limites efetivos após ajustes manuais',async()=>{
  const rast=require('../rastreador');rast.esquecerCoordenadas();
  const rows=[vizinha('A',0,{loja_cadastrada:true}),vizinha('B',201,{loja_cadastrada:true}),vizinha('FABRICA',10,{loja_cadastrada:false})];
  const banco={query:async sql=>({rows:sql.includes('loja_coordenadas')?rows:[{valor:{A:{raio_entrada_m:35,raio_saida_m:70,area_personalizada:true}}}]})};
  try{const mapa=await rast.coordenadas(banco);assert.equal(mapa.get('A').raio_entrada_m,35);assert.equal(mapa.get('B').raio_entrada_m,50);assert.equal(mapa.get('FABRICA').raio_entrada_m,250);assert.equal(mapa.get('A').ajuste_proximidade.vizinha_codigo,'B');}finally{rast.esquecerCoordenadas();}
});


test('Leitura so e confirmada depois de gravar e pode ser repetida apos falha no banco',async()=>{
  const {gravarAparelhos}=require('../rastreador');
  for(const falhaEm of [1,2]) {
    const a=ponto('srf',{device_id:900000+falhaEm,posicao_em:new Date(Date.now()-30000)});
    let chamadas=0;
    const db={query:async sql=>{chamadas++;if(chamadas===1)assert.ok(sql.includes('INSERT INTO rastreador_posicoes'));if(chamadas===falhaEm)throw Error('banco indisponivel');return {rows:[]};}};
    await assert.rejects(gravarAparelhos(db,'srf',[a]),/banco indisponivel/);
    await gravarAparelhos(db,'srf',[a]);
    assert.equal(chamadas,falhaEm+2,'retry grava aparelho e historico');
    await gravarAparelhos(db,'srf',[a]);
    assert.equal(chamadas,falhaEm+2,'so a leitura persistida vira duplicada');
  }
});

function rotasNovoPonto({duplicado=false,falharGravacao=false}={}) {
  const escritas=[],auditorias=[];let consultas=0,invalidacoes=0;
  const db={query:async(sql,params)=>{consultas++;if(sql.startsWith('SELECT'))return {rows:duplicado?[{codigo:'418'}]:[]};
    if(falharGravacao)throw Error('Banco indisponivel');escritas.push({sql,params});return {rows:[]};}};
  const rotas=criarRotas({db,rastreador:{esquecerCoordenadas(){invalidacoes++;}},
    invalidarCache(){invalidacoes++;},registrarAuditoria:async(...args)=>auditorias.push(args)});
  const res={status(n){this.code=n;return this;},json(j){this.body=j;return this;}};
  return {rotas,res,escritas,auditorias,consultas:()=>consultas,invalidacoes:()=>invalidacoes};
}
test('Novo ponto recebe codigo proprio, area e origem manual sem mudar cadastro de loja',async()=>{
  const a=rotasNovoPonto();const b={...loja,nome:' Pátio de apoio ',raio_entrada_m:80,raio_saida_m:150};
  await a.rotas.criarPonto({body:b},a.res);
  assert.equal(a.res.code,201);assert.match(a.res.body.codigo,/^PONTO_[a-f0-9-]+$/);
  assert.equal(a.res.body.lugar.nome,'Pátio de apoio');assert.equal(a.res.body.lugar.origem,'manual');
  assert.equal(a.res.body.lugar.loja_cadastrada,false);assert.equal(a.res.body.lugar.area_personalizada,true);
  assert.equal(a.escritas.length,1);assert.equal(a.escritas[0].params[0],a.res.body.codigo);
  assert.equal(a.escritas[0].params[4],'rastreador_areas_loja');assert.equal(a.auditorias[0][1],'CRIAR_PONTO_GPS');
  assert.equal(a.invalidacoes(),2);
});
test('Criacao rejeita nome e area invalidos antes de gravar',async()=>{
  const base={nome:'Pátio',...loja,raio_entrada_m:80,raio_saida_m:150};
  for(const extra of [{nome:''},{nome:'a'.repeat(121)},{lat:''},{raio_saida_m:70},{poligono:[[loja.lat,loja.lng],[loja.lat+.001,loja.lng]]}]) {
    const a=rotasNovoPonto();await a.rotas.criarPonto({body:{...base,...extra}},a.res);
    assert.equal(a.res.code,400);assert.equal(a.consultas(),0);assert.equal(a.escritas.length,0);assert.equal(a.auditorias.length,0);
  }
});
test('Nome duplicado e falha no banco nao anunciam novo ponto',async()=>{
  for(const modo of [{duplicado:true,code:409},{falharGravacao:true,code:500}]) {
    const a=rotasNovoPonto(modo);await a.rotas.criarPonto({body:{nome:'Pátio',...loja,raio_entrada_m:80,raio_saida_m:150}},a.res);
    assert.equal(a.res.code,modo.code);assert.equal(a.auditorias.length,0);assert.equal(a.escritas.length,0);assert.equal(a.invalidacoes(),0);
  }
});

function cicloGps({falharInsert=false,falhasInsert=0,falharHistorico=false,historico=[]}={}){
  const base=Date.now()-180000,gravados=[],avisos=[],intervalos=[];let atual=[],inserts=0,leiturasHistorico=0;
  const db={query:async(sql,params)=>{
    if(sql.includes('INSERT INTO rastreador_eventos_loja')){inserts++;if(falharInsert || falhasInsert>0){falharInsert=false;falhasInsert--;throw Error('banco temporariamente indisponivel');}gravados.push(params);return {rows:[{id:gravados.length}]};}
    if(sql.includes('FROM rastreador_posicoes')){leiturasHistorico++;if(falharHistorico){falharHistorico=false;throw Error('historico temporariamente indisponivel');}return {rows:historico};}
    return {rows:[]};
  }};
  const ctx={module:{exports:{}},require:p=>p==='./rastreador-escolha'?{preferencias:async()=>({}),ignoradas:()=>new Set()}:requireLocal(p),Date,Intl,Map,Set,process:{env:{}},console:{log(){},error(){}},setTimeout(){},setInterval:(fn,ms)=>intervalos.push(ms)};
  vm.runInNewContext(fs.readFileSync(require.resolve('../rastreador-ao-vivo'),'utf8'),ctx);
  const rastreador={coordenadas:async()=>new Map([['A',loja]]),posicoesAtuais:async()=>atual,placaMercosul:p=>p};
  const ciclo=ctx.module.exports.iniciar({db,rastreador,buscarViagensTms:async()=>[],agoraSP:()=>({data:new Date().toISOString().slice(0,10)}),broadcastEvento:(tipo,dados)=>avisos.push(dados)});
  const p=(seg,extra={})=>({...loja,placa:'FKB1D11',fonte:'srf',device_id:1,velocidade:0,estado:'parado',posicao_em:new Date(base+seg*1000),...extra});
  return {ciclo,p,gravados,avisos,intervalos,lerHistorico:()=>leiturasHistorico,inserts:()=>inserts,atualizar:p=>{atual=[p];}};
}
test('Evento de chegada que falha no banco e repetido mesmo quando o GPS nao manda outro sinal',async()=>{
  const a=cicloGps({falharInsert:true});assert.equal(a.intervalos[0],10000);
  a.atualizar(a.p(0,{lat:loja.lat+.006,velocidade:30,estado:'movendo'}));await a.ciclo.rodar();
  a.atualizar(a.p(60));await a.ciclo.rodar();a.atualizar(a.p(90));await a.ciclo.rodar();
  assert.equal(a.inserts(),1);assert.equal(a.gravados.length,0);assert.equal(a.avisos.length,0);
  await a.ciclo.rodar();assert.equal(a.inserts(),2);assert.equal(a.gravados.length,1);assert.equal(a.gravados[0][1],'chegou_loja');assert.equal(+a.gravados[0][4],+a.p(60).posicao_em);assert.equal(a.avisos.length,1);
  await a.ciclo.rodar();assert.equal(a.gravados.length,1);assert.equal(a.avisos.length,1);
});
test('Falha da recuperacao apos restart nao desliga a reprise do historico',async()=>{
  const a=cicloGps({falharHistorico:true});await a.ciclo.rodar();assert.equal(a.lerHistorico(),1);
  await a.ciclo.rodar();assert.equal(a.lerHistorico(),2);await a.ciclo.rodar();assert.equal(a.lerHistorico(),2);
});
test('Reprise mantem todos os eventos pendentes quando a primeira gravacao falha',async()=>{
  const base=Date.now()-150000,raw=(seg,extra={})=>({...loja,placa:'FKB1D11',device_id:1,fonte:'srf',velocidade:0,posicao_em:new Date(base+seg*1000),...extra});
  const a=cicloGps({falhasInsert:2,historico:[raw(0,{lat:loja.lat+.006,velocidade:30}),raw(30),raw(60),raw(90,{lat:loja.lat+.006,velocidade:30})]});
  await a.ciclo.rodar();assert.equal(a.gravados.length,0);await a.ciclo.rodar();
  assert.deepEqual(a.gravados.map(p=>p[1]),['chegou_loja','saiu_loja']);assert.equal(a.avisos.length,2);
  await a.ciclo.rodar();assert.equal(a.gravados.length,2);
});

const paradoEspacado=(min,extra={})=>leitura(min,{motor:'desligado',device_id:1,...extra});
test('Motor desligado confirma duas posições novas no mesmo ponto após mais de cinco minutos',()=>{
  const d=det();d.processar(fora(),[loja]);d.processar(paradoEspacado(1),[loja]);
  const [e]=d.processar(paradoEspacado(7),[loja]);
  assert.equal(e.tipo,'chegou_loja');assert.equal(+e.em,+leitura(1).posicao_em);
  assert.match(e.detalhe,/confirmado com sinais espaçados/);
});
test('Uma posição de motor desligado repetida nunca confirma chegada',()=>{
  const d=det();d.processar(fora(),[loja]);const p=paradoEspacado(1);d.processar(p,[loja]);
  assert.deepEqual(d.processar(p,[loja]),[]);assert.equal(d.estado.get(p.placa).n,1);
});
test('Confirmação espaçada exige mesmo aparelho, fonte, ponto e motor desligado',()=>{
  for(const extra of [{motor:null},{fonte:'sat'},{device_id:2},{lat:loja.lat+.0006},{velocidade:5}]) {
    const d=det();d.processar(fora(),[loja]);d.processar(paradoEspacado(1),[loja]);
    assert.deepEqual(d.processar(paradoEspacado(7,extra),[loja]),[]);
  }
});
test('Lacuna maior que trinta minutos e áreas ambíguas não confirmam chegada espaçada',()=>{
  const d=det();d.processar(fora(),[loja]);d.processar(paradoEspacado(1),[loja]);
  assert.deepEqual(d.processar(paradoEspacado(32),[loja]),[]);
  const lugares=[loja,{...loja,codigo:'B'}],amb=det();amb.processar(fora(),lugares);amb.processar(paradoEspacado(1),lugares);
  assert.deepEqual(amb.processar(paradoEspacado(7),lugares),[]);
});
test('Confirmação espaçada não flexibiliza sinal antigo e recupera retorno parado à fábrica',()=>{
  const d=det();d.processar(fora(),[loja]);d.processar(paradoEspacado(1),[loja]);
  assert.deepEqual(d.processar(paradoEspacado(7),[loja],{agora:agora+15*60000,maxIdadeMs:q.RECENTE_MS}),[]);
  const fab={...loja,codigo:'FABRICA'},f=det();f.processar(fora(),[fab]);f.processar(paradoEspacado(1),[fab]);
  const [e]=f.processar(paradoEspacado(7),[fab]);assert.equal(e.tipo,'voltou_fabrica');assert.equal(+e.em,+leitura(1).posicao_em);
});
test('Visitas históricas preservam ignição para a confirmação espaçada',()=>{
  const r=visitasDoDia([fora(),paradoEspacado(1),paradoEspacado(7)],[loja],{paradas:[{id:1,ordem:1,loja_codigo_pes:'A'}]});
  assert.equal(r.length,1);assert.equal(r[0].chegada_vista,true);assert.equal(r[0].chegou,leitura(1).posicao_em.toISOString());
});
test('FKA0C10 Bangu IV confirma 12:23 após nova leitura 12:28 sem ampliar os 23 metros',()=>{
  const l={codigo:'538',nome:'BANGU IV',lat:-22.875044272452847,lng:-43.465818129245285,raio_entrada_m:23,raio_saida_m:30,area_personalizada:true};
  const p=(hora,lat,motor='desligado')=>({placa:'FKA0C10',fonte:'t4s',device_id:68560,lat,lng:-43.4659,velocidade:0,motor,posicao_em:new Date('2026-10-08T'+hora+'-03:00')});
  const d=criarDetector({agora:()=>Date.parse('2026-10-08T14:00:00-03:00')});
  d.processar(p('11:14:46',-22.8756),[l]);d.processar(p('11:30:58',-22.8751,'ligado'),[l]);
  d.processar({...p('11:53:01',-22.8748),lng:-43.4658},[l]);d.processar(p('12:23:32',-22.875),[l]);
  const [e]=d.processar(p('12:28:58',-22.875),[l]);assert.equal(e.tipo,'chegou_loja');assert.equal(e.em.toISOString(),'2026-10-08T15:23:32.000Z');
});

test('Boot recupera chegada espaçada do histórico com ignição e preserva a justificativa',async()=>{
  const base=Date.now()-20*60000;
  const p=(min,extra={})=>({...loja,placa:'FKB1D11',device_id:1,fonte:'t4s',motor:'desligado',velocidade:0,posicao_em:new Date(base+min*60000),...extra});
  const a=cicloGps({historico:[p(0,{lat:loja.lat+.006,velocidade:30,motor:'ligado'}),p(1),p(7)]});
  await a.ciclo.rodar();assert.equal(a.gravados.length,1);assert.equal(a.gravados[0][1],'chegou_loja');
  assert.equal(+a.gravados[0][4],+p(1).posicao_em);assert.match(a.gravados[0][12],/sinais espaçados/);
  await a.ciclo.rodar();assert.equal(a.gravados.length,1);
});
