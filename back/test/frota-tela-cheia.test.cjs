const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function ambiente({nativo=false,rejeitar=false}={}){
  const eventos={},classes=new Set(),abaClasses=new Set();let resize=0,observador;
  const foco={chamadas:0,focus(){this.chamadas++;}};
  const painel={classList:{contains:k=>classes.has(k),add:k=>classes.add(k),remove:k=>classes.delete(k)}};
  const botao={dataset:{},atributos:{},focus(){},setAttribute(k,v){this.atributos[k]=v;}};
  const aba={classList:{contains:k=>abaClasses.has(k)}};
  const doc={body:{style:{overflow:'auto'}},activeElement:foco,fullscreenEnabled:nativo,fullscreenElement:null,getElementById:id=>({frtMapaPainel:painel,frtTelaCheiaBtn:botao,'aba-frota':aba,frtMapa:{}}[id]),addEventListener:(k,fn)=>eventos[k]=fn};
  if(nativo)painel.requestFullscreen=async()=>{if(rejeitar)throw Error('negado');doc.fullscreenElement=painel;eventos.fullscreenchange();};
  doc.exitFullscreen=async()=>{doc.fullscreenElement=null;eventos.fullscreenchange();};
  const context={document:doc,window:{},requestAnimationFrame:fn=>fn(),setTimeout:fn=>fn(),MutationObserver:class{constructor(fn){observador=fn;}observe(){}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../public/js/frota-tela-cheia.js'),'utf8'),context);
  context.window.frtTelaCheia.montar(()=>resize++);
  return {doc,painel,botao,eventos,classes,abaClasses,foco,observar:()=>observador(),resize:()=>resize};
}
test('Tela cheia inclui painel existente, atualiza botao e restaura rolagem',async()=>{
  const a=ambiente();await a.botao.onclick();assert.ok(a.classes.has('frt-tela-cheia'));assert.equal(a.doc.body.style.overflow,'hidden');assert.equal(a.botao.atributos['aria-pressed'],'true');assert.ok(a.resize()>0);
  await a.botao.onclick();assert.equal(a.classes.size,0);assert.equal(a.doc.body.style.overflow,'auto');assert.equal(a.foco.chamadas,1);
});
test('Esc fecha o modo ampliado quando o navegador nao oferece fullscreen',async()=>{
  const a=ambiente();await a.botao.onclick();let prevented=false;a.eventos.keydown({key:'Escape',preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(a.classes.size,0);
});
test('Recusa do fullscreen nativo ainda permite ampliar o mapa e sair',async()=>{
  const a=ambiente({nativo:true,rejeitar:true});await a.botao.onclick();assert.ok(a.classes.has('frt-tela-cheia'));await a.botao.onclick();assert.equal(a.classes.size,0);
});
test('Saida nativa por Esc limpa estilos e devolve o foco',async()=>{
  const a=ambiente({nativo:true});await a.botao.onclick();assert.equal(a.doc.fullscreenElement,a.painel);a.doc.fullscreenElement=null;a.eventos.fullscreenchange();assert.equal(a.classes.size,0);assert.equal(a.doc.body.style.overflow,'auto');assert.equal(a.foco.chamadas,1);
});
test('Mudar de aba encerra a tela cheia',async()=>{
  const a=ambiente();await a.botao.onclick();a.abaClasses.add('aba-hidden');a.observar();assert.equal(a.classes.size,0);
});