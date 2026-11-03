const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const rastroUtils=require('../../public/js/frota-rastro-utils');
const periodo=require('../../public/js/frota-periodo');
function ambiente(){
  const camada=()=>({linhas:[],clearLayers(){this.linhas=[];}});
  const d={classList:{add(){},remove(){}},dataset:{},innerHTML:''};
  const document={getElementById:id=>id==='frtDetalhe'?d:null,querySelector:()=>null,documentElement:{dataset:{tema:'claro'}}};
  const L={polyline:(coords,opts)=>({bindTooltip(){return this;},on(){return this;},addTo(c){c.linhas.push({coords,opts});return this;}}),circleMarker:()=>({bindTooltip(){return this;},addTo(){return this;}}),latLngBounds:()=>({pad(){return this;}})};
  const context={window:{location:{origin:'http://localhost'},L,frtRastroUtils:rastroUtils,frtPeriodo:periodo},document,localStorage:{getItem:()=>null},Date,Map,Set,WeakMap,setTimeout:fn=>fn(),clearTimeout,URL,URLSearchParams};
  let src=fs.readFileSync(require.resolve('../../public/js/frota.js'),'utf8');
  const end=src.lastIndexOf('})();');
  src=src.slice(0,end)+`
    renderDetalhe=(v,t)=>{window.ultimoDetalhe=t;};
    renderLegendas=()=>{}; renderLista=()=>{}; linhasRegistro=()=>[];
    garantirMapa=async()=>true; desenharMapa=()=>{};
    render=()=>{window.renderizados.push(st.dados);};
    window.renderizados=[];
    window.teste={st,selecionar,fecharDetalhe,carregarTrajeto,desenharTrajeto,desenharRastros,prepararRastros,carregar,textoSinalGps,situacao,popupLugar,
      responder:fn=>{getJson=fn;}};
  `+src.slice(end);
  vm.runInNewContext(src,context);
  const api=context.window.teste;
  Object.assign(api.st,{data:'2026-10-07',sel:'ABC1D23',mapa:{setView(){},fitBounds(){}},camTrajeto:camada(),camRastros:camada(),rastros:new Map([['ABC1D23',Object.assign([{coords:[[1,1],[1,2]],lig:0,banda:3}],{J:{diaIni:0},t0:10,t1:20})]]),dados:{data:'2026-10-07',veiculos:[{placa:'ABC1D23',dia:{pontos:2,ultima:'2026-10-07T09:00:00Z'}}]}});
  return {...api,window:context.window,document};
}
const trajeto=()=>({placa:'ABC1D23',data:'2026-10-07',pontos:[[1,1,30,10,2],[1,2,30,20,0]],dia_inicio:'2026-10-07T03:00:00Z'});

test('Horario exibido pertence ao sinal GPS e nao ao instante de consulta da tela',()=>{
  const a=ambiente();a.st.dados.hoje=true;a.st.dados.gerado_em='2026-10-08T11:00:00Z';
  const v={atual:{fonte:'srf',posicao_em:'2026-10-08T10:45:20Z'},dia:{ultima:'2026-10-07T19:00:00Z',fonte:'t4s'}};
  const texto=a.textoSinalGps(v);assert.ok(texto.includes('SRF'));assert.ok(texto.includes('07:45:20'));assert.ok(!texto.includes('08:00:00'));
  a.st.dados.hoje=false;assert.ok(a.textoSinalGps(v).includes('T4S'));assert.ok(a.textoSinalGps(v).includes('07/10'));
});
test('Situacao Em loja usa a area validada do GPS e preserva compatibilidade com servidor anterior',()=>{
  const a=ambiente();a.st.dados.hoje=true;
  const v={atual:{estado:'parado',perto_de:{codigo:'471',nome:'Niteroi II',m:67,dentro:false}}};
  assert.equal(a.situacao(v).cls,'parado');v.atual.perto_de.dentro=true;assert.equal(a.situacao(v).cls,'loja');
  delete v.atual.perto_de.dentro;assert.equal(a.situacao(v).cls,'loja');
});
test('Posicao antiga sinalizada pelo servidor nao aparece como chegada atual na loja',()=>{
  const a=ambiente();a.st.dados.hoje=true;
  const v={atual:{estado:'parado',idade_min:8,fonte_motivo:'ultimo_sinal_antigo',perto_de:{codigo:'471',nome:'Niteroi II',m:67,dentro:true}}};
  assert.equal(a.situacao(v).cls,'sem');assert.ok(a.situacao(v).rotulo.includes('Sinal antigo'));
});

test('Passeio e CG3 com area sobreposta pedem confirmacao na posicao ao vivo',()=>{
  const a=ambiente();a.st.dados.hoje=true;
  const v={atual:{estado:'parado',perto_de:{codigo:'418',nome:'CAMPO GRANDE III / PASSEIO',
    m:0,dentro:true,ambigua:['418','553'],confirmacao_necessaria:true}}};
  const situacao=a.situacao(v);assert.equal(situacao.cls,'loja');
  assert.ok(situacao.rotulo.includes('CAMPO GRANDE III / PASSEIO'));assert.ok(situacao.rotulo.includes('confirmar loja'));
});

test('Marcador avisa do ponto duplicado e abre ajuste da loja clicada sem mudar coordenadas',async()=>{
  const a=ambiente();let selecionada,fechou=0;
  a.st.lugares=[{codigo:'418',nome:'CAMPO GRANDE III',lat:-22.903692,lng:-43.557930},
    {codigo:'553',nome:'PASSEIO',lat:-22.903692,lng:-43.557930}];
  const botao={},box={querySelector:()=>botao};
  const b=a;
  b.document.createElement=()=>box;
  b.window.frtPrecisao={abrirLoja:async cod=>selecionada=cod};
  b.st.mapa.closePopup=()=>fechou++;
  b.st.lugares=a.st.lugares;
  const antes=JSON.stringify(b.st.lugares);b.popupLugar(b.st.lugares[1]);
  assert.ok(box.innerHTML.includes('Mesmo ponto cadastrado de CAMPO GRANDE III'));
  await botao.onclick();assert.equal(selecionada,'553');assert.equal(fechou,1);
  assert.equal(JSON.stringify(b.st.lugares),antes);
});

function ambientePrecisao({falhar=false,erroSalvar=null,falhaConsultaDepois=false,consultaAntiga=false,segurarSalvar=false}={}) {
  const els={},pedidos=[],referencias=[];let marcador,scrolls=0,salvou=false,liberarSalvar;
  const node=id=>els[id] ||= {dataset:{},value:'',style:{},textContent:'',options:[],
    querySelectorAll:()=>[],scrollIntoView(){scrolls++;}};
  const details={open:false};node('frtPrecisao').querySelector=()=>details;
  Object.defineProperty(node('gpsLoja'),'innerHTML',{set(html){
    this.options=[...html.matchAll(/value="([^"]+)"/g)].map(m=>({value:m[1]}));
    this.value=this.options[0]?.value || '';
  }});
  let lugares=[{codigo:'418',nome:'CAMPO GRANDE III',lat:-22.903692,lng:-43.557930,raio_entrada_m:20,raio_saida_m:40},
    {codigo:'553',nome:'PASSEIO',lat:-22.903692,lng:-43.557930,raio_entrada_m:20,raio_saida_m:40}];
  const antigos=lugares.map(l=>({...l}));
  const forma=()=>({bindTooltip(){return this;},addTo(){return this;}});
  const eventosMapa={};
  const map={setView(){return this;},invalidateSize(){},removeLayer(){},on(k,fn){eventosMapa[k]=fn;}};
  const window={frtApi:{carregarLeaflet:async()=>{},distM:(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1])*111195},
    frtAtualizar(){},L:{map:()=>map,tileLayer:forma,layerGroup:()=>({addTo(){return this;},clearLayers(){referencias.length=0;}}),
      marker:pos=>{marcador={pos,on(k,fn){this[k]=fn;return this;},getLatLng(){return {lat:this.pos[0],lng:this.pos[1]};},...forma()};return marcador;},
      circle:forma,circleMarker:pos=>{referencias.push(pos);return forma();},polygon:forma,polyline:forma}};
  const fetch=async(url,opcoes)=>{
    pedidos.push({url,opcoes});if(falhar)return {ok:false,status:500,json:async()=>({error:'Falha no GPS'})};
    if(opcoes?.method==='POST'){
      if(erroSalvar)return {ok:false,status:400,json:async()=>({error:erroSalvar})};
      if(segurarSalvar)await new Promise(ok=>liberarSalvar=ok);
      const b=JSON.parse(opcoes.body),codigo=url.split('/').at(-1);
      if(url==='/frota/precisao/pontos'){
        const lugar={...b,codigo:'PONTO_TESTE',lat:Number(b.lat),lng:Number(b.lng),origem:'manual',loja_cadastrada:false};
        lugares=[...lugares,lugar];salvou=true;return {ok:true,json:async()=>({ok:true,codigo:lugar.codigo,lugar})};
      }
      lugares=lugares.map(l=>l.codigo===codigo?{...l,...b,lat:Number(b.lat),lng:Number(b.lng)}:l);
      salvou=true;
      return {ok:true,json:async()=>({ok:true})};
    }
    if(salvou && falhaConsultaDepois)return {ok:false,status:500,json:async()=>({error:'Consulta indisponivel'})};
    return {ok:true,json:async()=>({lugares:salvou && consultaAntiga?antigos:lugares,aparelhos:[],idade_max_eventos_s:300,comparacao_max_s:60})};
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../public/js/frota-precisao.js'),'utf8'),
    {window,document:{getElementById:node},fetch});
  return {window,els,pedidos,referencias,abrir:window.frtPrecisao.abrirLoja,
    clicar(lat,lng){eventosMapa.click({latlng:{lat,lng}});},
    arrastar(lat,lng){marcador.pos=[lat,lng];marcador.dragend();},lugares:()=>lugares,scrolls:()=>scrolls,liberar:()=>liberarSalvar()};
}
test('Ajuste direto abre Passeio, mostra CG3 como referencia e grava apenas Passeio',async()=>{
  const a=ambientePrecisao();await a.abrir('553');
  assert.equal(a.els.gpsLoja.value,'553');assert.equal(a.scrolls(),1);
  assert.ok(a.els.gpsProximidade.textContent.includes('Mesmo ponto cadastrado de CAMPO GRANDE III'));
  assert.equal(a.pedidos.filter(p=>p.opcoes?.method==='POST').length,0);
  assert.equal(a.referencias.length,1);
  const cgAntes=JSON.stringify(a.lugares()[0]);
  a.arrastar(-22.9036,-43.5572);a.els.gpsAreaForm.onsubmit({preventDefault(){}});
  for(let i=0;i<30;i++)await Promise.resolve();
  const post=a.pedidos.filter(p=>p.opcoes?.method==='POST');
  assert.equal(post.length,1);assert.ok(post[0].url.endsWith('/lojas/553'));
  assert.equal(JSON.parse(post[0].opcoes.body).lng,'-43.5572000');
  assert.equal(JSON.stringify(a.lugares()[0]),cgAntes);assert.equal(a.els.gpsLoja.value,'553');
});
test('Falha ao carregar ajuste nao salva ponto nem abre mapa com outra loja',async()=>{
  const a=ambientePrecisao({falhar:true});await a.abrir('553');
  assert.equal(a.scrolls(),0);assert.equal(a.referencias.length,0);
  assert.ok(a.els.gpsAjusteStatus.textContent.includes('Falha no GPS'));
  assert.equal(a.pedidos.length,1);assert.equal(a.pedidos[0].opcoes.method,undefined);
});

test('Salvar repetidamente envia um unico ajuste e mostra retorno ao lado do botao',async()=>{
  const a=ambientePrecisao({segurarSalvar:true});await a.abrir('553');a.arrastar(-22.9036,-43.5572);
  assert.equal(a.els.gpsAreaStatus.textContent,'Alteração ainda não salva.');
  const p=a.els.gpsAreaForm.onsubmit({preventDefault(){}});
  assert.equal(a.els.gpsSalvar.disabled,true);assert.equal(a.els.gpsSalvar.textContent,'Salvando…');
  assert.ok(a.els.gpsAreaStatus.textContent.includes('Salvando PASSEIO'));
  await a.els.gpsAreaForm.onsubmit({preventDefault(){}});
  assert.equal(a.pedidos.filter(x=>x.opcoes?.method==='POST').length,1);
  await a.abrir('418');assert.equal(a.els.gpsLoja.value,'553');
  a.liberar();await p;assert.ok(!a.els.gpsSalvar.disabled);
  assert.equal(a.els.gpsSalvar.textContent,'Salvar área');assert.equal(a.els.gpsAreaStatus.textContent,'Área de PASSEIO salva.');
});
for(const modo of ['falhaConsultaDepois','consultaAntiga'])test('Ponto aceito nao volta ao antigo quando '+modo,async()=>{
  const a=ambientePrecisao({[modo]:true});await a.abrir('553');a.arrastar(-22.9036,-43.5572);
  await a.els.gpsAreaForm.onsubmit({preventDefault(){}});
  assert.equal(a.els.gpsLat.value,'-22.9036000');assert.equal(a.els.gpsLng.value,'-43.5572000');
  assert.ok(a.els.gpsAreaStatus.textContent.includes('o ajuste foi gravado'));
  assert.ok(!a.els.gpsSalvar.disabled);
});
test('Erro do servidor fica junto do botao e conserva edicao para nova tentativa',async()=>{
  const a=ambientePrecisao({erroSalvar:'O ponto de descarga deve ficar dentro da área desenhada.'});
  await a.abrir('553');a.arrastar(-22.9036,-43.5572);await a.els.gpsAreaForm.onsubmit({preventDefault(){}});
  assert.ok(a.els.gpsAreaStatus.textContent.includes('dentro da área desenhada'));
  assert.equal(a.els.gpsLng.value,'-43.5572000');assert.ok(!a.els.gpsSalvar.disabled);
  assert.equal(a.pedidos.filter(x=>x.opcoes?.method==='POST').length,1);
  assert.equal(a.lugares()[1].lng,-43.557930);
});
test('Campo invalido apresenta a causa junto do botao mesmo antes de enviar',async()=>{
  const a=ambientePrecisao();await a.abrir('553');
  a.els.gpsEntrada.validationMessage='Preencha este campo.';a.els.gpsEntrada.oninvalid();
  assert.equal(a.els.gpsAreaStatus.textContent,'Raio de entrada: Preencha este campo.');
  assert.equal(a.pedidos.filter(x=>x.opcoes?.method==='POST').length,0);
});

test('Criar ponto usa nome e clique no mapa e mantem as lojas existentes',async()=>{
  const a=ambientePrecisao();await a.abrir('553');const lojasAntes=JSON.stringify(a.lugares());
  await a.els.gpsNovoPonto.onclick();assert.equal(a.els.gpsLoja.value,'__NOVO__');
  assert.equal(a.els.gpsNomeCampo.hidden,false);assert.equal(a.els.gpsSalvar.textContent,'Criar ponto');
  assert.equal(a.els.gpsRestaurar.disabled,true);assert.equal(a.els.gpsLat.value,'');
  a.els.gpsNome.value='Pátio de apoio';a.clicar(-22.904,-43.558);
  assert.equal(a.els.gpsLat.value,'-22.9040000');
  await a.els.gpsAreaForm.onsubmit({preventDefault(){}});
  const post=a.pedidos.find(x=>x.opcoes?.method==='POST');
  assert.equal(post.url,'/frota/precisao/pontos');assert.equal(JSON.parse(post.opcoes.body).nome,'Pátio de apoio');
  assert.equal(JSON.stringify(a.lugares().slice(0,2)),lojasAntes);
  assert.equal(a.els.gpsLoja.value,'PONTO_TESTE');assert.equal(a.els.gpsNomeCampo.hidden,true);
  assert.equal(a.els.gpsAreaStatus.textContent,'Ponto Pátio de apoio criado.');
  assert.equal(a.els.gpsRestaurar.disabled,false);
});
test('Cancelar ponto retorna para a loja anterior sem gravar',async()=>{
  const a=ambientePrecisao();await a.abrir('553');await a.els.gpsNovoPonto.onclick();
  a.clicar(-22.904,-43.558);a.els.gpsCancelarNovo.onclick();
  assert.equal(a.els.gpsLoja.value,'553');assert.equal(a.els.gpsNomeCampo.hidden,true);
  assert.equal(a.pedidos.filter(x=>x.opcoes?.method==='POST').length,0);
});
for(const modo of ['falhaConsultaDepois','consultaAntiga'])test('Novo ponto fica selecionado mesmo quando '+modo,async()=>{
  const a=ambientePrecisao({[modo]:true});await a.abrir('553');await a.els.gpsNovoPonto.onclick();
  a.els.gpsNome.value='Pátio de apoio';a.clicar(-22.904,-43.558);
  await a.els.gpsAreaForm.onsubmit({preventDefault(){}});
  assert.equal(a.els.gpsLoja.value,'PONTO_TESTE');assert.equal(a.els.gpsNomeCampo.hidden,true);
  assert.ok(a.els.gpsAreaStatus.textContent.includes('o ajuste foi gravado'));
});
test('Editar raio sai do desenho incompleto e envia area circular',async()=>{
  const a=ambientePrecisao();await a.abrir('553');a.els.gpsDesenhar.onclick();
  a.clicar(-22.9036,-43.5572);a.clicar(-22.9035,-43.5572);
  a.els.gpsEntrada.value='76';a.els.gpsEntrada.oninput();a.els.gpsSaida.value='88';a.els.gpsSaida.oninput();
  await a.els.gpsAreaForm.onsubmit({preventDefault(){}});
  const b=JSON.parse(a.pedidos.find(x=>x.opcoes?.method==='POST').opcoes.body);
  assert.equal(b.poligono,null);assert.equal(b.raio_entrada_m,'76');assert.equal(b.raio_saida_m,'88');
});
test('Desenho vazio permite raio, mas um desenho com dois vertices ainda precisa ser concluido',async()=>{
  const a=ambientePrecisao();await a.abrir('553');a.els.gpsDesenhar.onclick();
  await a.els.gpsAreaForm.onsubmit({preventDefault(){}});
  assert.equal(a.pedidos.filter(x=>x.opcoes?.method==='POST').length,1);
  a.els.gpsDesenhar.onclick();a.clicar(-22.9036,-43.5572);a.clicar(-22.9035,-43.5572);
  await a.els.gpsAreaForm.onsubmit({preventDefault(){}});
  assert.equal(a.pedidos.filter(x=>x.opcoes?.method==='POST').length,1);
  assert.ok(a.els.gpsAreaStatus.textContent.includes('pelo menos três pontos'));
});
test('Criar ponto com desenho envia os vertices sem criar entregas de loja',async()=>{
  const a=ambientePrecisao();await a.abrir('553');await a.els.gpsNovoPonto.onclick();
  a.els.gpsNome.value='Pátio';a.clicar(-22.904,-43.558);a.els.gpsDesenhar.onclick();
  a.clicar(-22.9039,-43.5581);a.clicar(-22.9039,-43.5579);a.clicar(-22.9041,-43.558);
  await a.els.gpsAreaForm.onsubmit({preventDefault(){}});
  const b=JSON.parse(a.pedidos.find(x=>x.opcoes?.method==='POST').opcoes.body);
  assert.equal(b.poligono.length,3);assert.equal(a.lugares().at(-1).loja_cadastrada,false);
});
test('Selecionar carro mantem rastro ate a linha detalhada estar desenhada',()=>{
  const a=ambiente();a.desenharRastros();assert.equal(a.st.camRastros.linhas.length,2);
  const t=trajeto();a.st.trajAssin='2|2026-10-07T09:00:00Z';a.desenharTrajeto(a.st.dados.veiculos[0],t,false);
  assert.equal(a.st.trajDesenhado,'ABC1D23');assert.equal(a.st.camTrajeto.linhas.length,1);assert.equal(a.st.camRastros.linhas.length,0);
  a.st.trajDesenhado=null;a.desenharRastros();assert.equal(a.st.camRastros.linhas.length,2);
});
test('Trajeto sem linha conectada conserva o rastro de reserva',()=>{
  const a=ambiente(),t=trajeto();t.pontos[1][4]=2;
  a.desenharTrajeto(a.st.dados.veiculos[0],t,false);
  assert.equal(a.st.trajDesenhado,null);assert.equal(a.st.camRastros.linhas.length,2);
});
test('Falha de rede preserva ultimo trajeto confirmado e permite tentar novamente',async()=>{
  const a=ambiente(),t=trajeto();a.st.trajeto=t;a.desenharTrajeto(a.st.dados.veiculos[0],t,false);
  const linha=a.st.camTrajeto.linhas[0];a.responder(async()=>{throw Error('rede indisponivel');});
  await a.carregarTrajeto('ABC1D23',false);
  assert.equal(a.st.trajeto,t);assert.equal(a.st.camTrajeto.linhas[0],linha);assert.equal(a.st.trajAssin,null);assert.ok(a.window.ultimoDetalhe.erro.includes('rede indisponivel'));
  a.responder(async()=>trajeto());await a.carregarTrajeto('ABC1D23',false);assert.equal(a.st.trajAssin,'2|2026-10-07T09:00:00Z');
});
test('Resposta de carro anterior nao desenha linha apos trocar selecao',async()=>{
  const a=ambiente();let resolver;a.responder(()=>new Promise(ok=>resolver=ok));
  const pendente=a.carregarTrajeto('ABC1D23',false);a.st.sel='DEF4G56';resolver(trajeto());await pendente;
  assert.equal(a.st.trajeto,null);assert.equal(a.st.camTrajeto.linhas.length,0);
});
test('Assinatura do trajeto corresponde ao painel que iniciou o pedido',async()=>{
  const a=ambiente();let resolver;a.responder(()=>new Promise(ok=>resolver=ok));
  const p=a.carregarTrajeto('ABC1D23',false);a.st.dados.veiculos[0].dia={pontos:3,ultima:'2026-10-07T09:01:00Z'};
  resolver(trajeto());await p;assert.equal(a.st.trajAssin,'2|2026-10-07T09:00:00Z');
});
test('Resposta pedida com rastro desligado nao apaga mapa ao religa-lo',async()=>{
  const a=ambiente();a.st.sel=null;a.st.rastro='off';let resolver,pedidos=[];
  a.responder(url=>{if(url.includes('fonte-preferida'))return Promise.resolve({});pedidos.push(url);return pedidos.length===1?new Promise(ok=>resolver=ok):Promise.resolve({data:a.st.data,veiculos:[{placa:'ABC1D23',rastro:[[1,1,0,2],[1,2,60,0]]}]});});
  const p=a.carregar();a.st.rastro='dia';await a.carregar();resolver({data:a.st.data,veiculos:[{placa:'ABC1D23'}]});await p;
  for(let i=0;i<10;i++)await Promise.resolve();
  assert.equal(pedidos.length,2);assert.ok(pedidos[1].includes('rastro=1'));assert.equal(a.window.renderizados.length,1);assert.equal(a.window.renderizados[0].veiculos[0].rastro.length,2);
});


test('Carro selecionado tem rastro de reserva mesmo sem estar marcado na lista',async()=>{
  const a=ambiente();a.st.sel=null;a.st.ver=new Map();a.st.modo='completo';a.st.rastro='dia';
  a.st.dados.dia_inicio='2026-10-07T03:00:00Z';a.st.dados.hoje=false;
  a.st.dados.veiculos[0].rastro=[[1,1,10,2],[1,2,20,0]];
  let resolver;a.responder(()=>new Promise(ok=>resolver=ok));
  a.selecionar('ABC1D23');a.desenharRastros();assert.equal(a.st.camRastros.linhas.length,2);
  resolver(trajeto());for(let i=0;i<10;i++)await Promise.resolve();
  assert.equal(a.st.trajDesenhado,'ABC1D23');a.fecharDetalhe();assert.equal(a.st.rastros.size,0);
});
test('Painel mais recente mostra rastro novo enquanto detalhe anterior aguarda atualizacao',()=>{
  const a=ambiente();a.st.trajeto=trajeto();a.st.trajAssin='2|2026-10-07T09:00:00Z';
  a.desenharTrajeto(a.st.dados.veiculos[0],a.st.trajeto,false);assert.equal(a.st.camRastros.linhas.length,0);
  a.st.dados.veiculos[0].dia={pontos:3,ultima:'2026-10-07T09:01:00Z'};a.desenharRastros();
  assert.equal(a.st.camRastros.linhas.length,2);assert.equal(a.st.camTrajeto.linhas.length,1);
});
