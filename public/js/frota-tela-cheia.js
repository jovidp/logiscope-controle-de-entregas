(function(){
  'use strict';
  function montar(redimensionar,opcoes={}){
    const painel=document.getElementById(opcoes.painel || 'frtMapaPainel'),botao=document.getElementById(opcoes.botao || 'frtTelaCheiaBtn');
    if(!painel || !botao || botao.dataset.montado)return;
    botao.dataset.montado='1';
    const botoes=[botao,document.getElementById(opcoes.botaoMapa || 'frtTelaCheiaMapaBtn')].filter(Boolean);
    const classe=opcoes.classe || 'frt-tela-cheia';
    let nativo=false,overflowAnterior='',focoAnterior=null;
    const ativo=()=>painel.classList.contains(classe);
    const ajustar=()=>{requestAnimationFrame(redimensionar);setTimeout(redimensionar,120);};
    function atualizar(){for(const b of botoes){b.textContent=ativo()?'⛶ Sair da tela cheia':'⛶ Tela cheia';b.setAttribute('aria-pressed',String(ativo()));}ajustar();}
    function limpar(){if(!ativo())return;painel.classList.remove(classe);document.body.style.overflow=overflowAnterior;nativo=false;atualizar();focoAnterior?.focus?.();}
    async function sair(){if(document.fullscreenElement===painel){try{await document.exitFullscreen();}catch(_){return;}}limpar();}
    async function entrar(acionador=botao){
      if(ativo())return;
      focoAnterior=document.activeElement;overflowAnterior=document.body.style.overflow;
      painel.classList.add(classe);document.body.style.overflow='hidden';atualizar();
      if(document.fullscreenEnabled && painel.requestFullscreen){try{await painel.requestFullscreen();nativo=document.fullscreenElement===painel;}catch(_){nativo=false;}}
      if(ativo())acionador.focus();ajustar();
    }
    for(const b of botoes)b.onclick=()=>ativo()?sair():entrar(b);
    document.addEventListener('fullscreenchange',()=>{if(document.fullscreenElement===painel){nativo=true;atualizar();}else if(nativo)limpar();});
    document.addEventListener('keydown',e=>{if(e.key==='Escape' && ativo() && !nativo){e.preventDefault();sair();}});
    // Navegar para outra aba também encerra o modo ampliado.
    const aba=document.getElementById('aba-frota');
    if(aba && typeof MutationObserver!=='undefined')new MutationObserver(()=>{if(ativo() && aba.classList.contains('aba-hidden'))sair();}).observe(aba,{attributes:true,attributeFilter:['class']});
    const parte=opcoes.parte && document.getElementById(opcoes.parte);
    if(parte && typeof MutationObserver!=='undefined')new MutationObserver(()=>{if(ativo() && parte.hidden)sair();}).observe(parte,{attributes:true,attributeFilter:['hidden']});
    if(typeof ResizeObserver!=='undefined')new ResizeObserver(()=>ajustar()).observe(document.getElementById(opcoes.mapa || 'frtMapa'));
  }
  window.frtTelaCheia={montar};
})();