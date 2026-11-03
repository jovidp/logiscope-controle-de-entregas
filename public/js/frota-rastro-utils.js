// Regras comuns do rastro e da reproducao. Nao interpola lacunas sem GPS.
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.frtRastroUtils=api;})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  function recortarRastro(pts,J){
    const pedacos=[];let atual=null,t0=null,t1=null;
    if(!J || !Array.isArray(pts))return {pedacos,t0,t1};
    for(let i=1;i<pts.length;i++){
      const a=pts[i-1],b=pts[i];
      if(b[3]===2 || b[2]<=a[2]){atual=null;continue;}
      const de=Math.max(a[2],J.ini),ate=Math.min(b[2],J.fim);
      if(ate<=de){atual=null;continue;}
      const coord=t=>{const f=(t-a[2])/(b[2]-a[2]);return [a[0]+(b[0]-a[0])*f,a[1]+(b[1]-a[1])*f];};
      const banda=Math.min(3,Math.max(0,Math.floor((((de+ate)/2-J.ini)/J.faixa)*4)));
      if(!atual || atual.lig!==b[3] || atual.banda!==banda){atual={lig:b[3],banda,coords:[coord(de)]};pedacos.push(atual);}
      atual.coords.push(coord(ate));
      if(t0==null)t0=de;t1=ate;
    }
    return {pedacos,t0,t1};
  }
  function posicaoReplay(P,s){
    if(!Array.isArray(P)||!P.length)return null;
    const ponto=p=>({lat:p[0],lng:p[1],vel:p[2],em:p[3],semSinal:false,aproximado:false});
    if(s<=P[0][3])return ponto(P[0]);
    if(s>=P[P.length-1][3])return ponto(P[P.length-1]);
    let lo=0,hi=P.length-1;
    while(hi-lo>1){const m=(lo+hi)>>1;if(P[m][3]<=s)lo=m;else hi=m;}
    const a=P[lo],b=P[hi];
    if(s===a[3])return ponto(a);
    if(b[4]===2)return {...ponto(a),vel:null,semSinal:true};
    const f=(s-a[3])/Math.max(1,b[3]-a[3]);
    return {lat:a[0]+(b[0]-a[0])*f,lng:a[1]+(b[1]-a[1])*f,vel:a[2]+(b[2]-a[2])*f,em:s,semSinal:false,aproximado:true};
  }
  return {recortarRastro,posicaoReplay};
});