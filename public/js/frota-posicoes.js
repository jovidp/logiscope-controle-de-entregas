(function(){
  'use strict';
  const INTERVALO_MS=5000;
  let ultimo=null,ocupado=false,timer=null,opcoes=null;
  function mesclar(painel,leitura=ultimo){
    if(!painel?.hoje || !leitura || painel.data!==leitura.data || !Number.isFinite(Date.parse(leitura.gerado_em)) || Date.parse(leitura.gerado_em)<Date.parse(painel.posicoes_atualizadas_em || painel.gerado_em))return painel;
    const porPlaca=new Map(leitura.veiculos.map(v=>[v.placa,v]));
    return {...painel,plataformas:leitura.plataformas,coleta_intervalo_s:leitura.coleta_intervalo_s,posicoes_atualizadas_em:leitura.gerado_em,
      veiculos:painel.veiculos.map(v=>porPlaca.has(v.placa)?{...v,...porPlaca.get(v.placa)}:v)};
  }
  async function atualizar(){
    if(ocupado || !opcoes?.permitido())return;
    ocupado=true;const data=opcoes.lerData();
    try{
      const r=await fetch('/frota/posicoes',{headers:{Accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(10000)});
      if(!r.ok)throw Error(`HTTP ${r.status}`);
      const leitura=await r.json();
      if(!opcoes.permitido() || opcoes.lerData()!==data || leitura.data!==data)return;
      if(ultimo?.data===leitura.data && Date.parse(leitura.gerado_em)<Date.parse(ultimo.gerado_em))return;
      ultimo=leitura;opcoes.receber(leitura);
    }catch(e){if(opcoes.permitido())opcoes.erro?.(e);}
    finally{ocupado=false;}
  }
  function iniciar(config){
    opcoes=config;if(timer)return;
    timer=setInterval(atualizar,INTERVALO_MS);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)atualizar();});
  }
  window.frtPosicoes={mesclar,iniciar,atualizar,intervaloMs:INTERVALO_MS};
})();