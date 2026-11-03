// Une consultas diárias sem ligar o fim de um dia ao início do seguinte.
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.frtPeriodo=api;})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const DIA=86400000,MAX_DIAS=31;
  function datas(inicio,fim,hoje){
    const valida=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
    if(!valida(inicio)||!valida(fim))throw Error('Informe as datas De e Até.');
    const n=(Date.parse(fim)-Date.parse(inicio))/DIA+1;
    if(n<1)throw Error('A data Até deve ser igual ou posterior à data De.');
    if(n>MAX_DIAS)throw Error('Consulte até '+MAX_DIAS+' dias por vez.');
    if(fim>hoje)throw Error('Escolha um período até hoje.');
    return Array.from({length:n},(_,i)=>new Date(Date.parse(inicio)+i*DIA).toISOString().slice(0,10));
  }
  async function consultar(dias,buscar,atual=()=>true){
    const respostas=new Array(dias.length);let proximo=0,falhou=false;
    async function worker(){while(!falhou&&atual()&&proximo<dias.length){const i=proximo++;try{respostas[i]=await buscar(dias[i]);}catch(e){falhou=true;throw e;}}}
    await Promise.all(Array.from({length:Math.min(2,dias.length)},worker));
    return atual()?respostas:null;
  }
  function somar(analises){
    const r={km:0,pontos:0,movendo_min:0,parado_min:0,excessos:0,eventos:0,paradas_n:0,paradas_fora:0,vel_max:0,primeira:null,ultima:null,paradas:[]};
    const fontes=new Set();
    for(const a of analises){
      if(!a)continue;
      for(const k of ['km','pontos','movendo_min','parado_min','excessos','eventos','paradas_n','paradas_fora'])r[k]+=Number(a[k])||0;
      r.vel_max=Math.max(r.vel_max,Number(a.vel_max)||0);
      if(a.primeira&&(!r.primeira||Date.parse(a.primeira)<Date.parse(r.primeira)))r.primeira=a.primeira;
      if(a.ultima&&(!r.ultima||Date.parse(a.ultima)>Date.parse(r.ultima))){r.ultima=a.ultima;r.ultima_pos=a.ultima_pos;}
      r.paradas.push(...(a.paradas||[]));
      if(a.fonte)for(const f of a.fonte.split('+'))fontes.add(f);
    }
    r.km=Math.round(r.km*10)/10;r.fonte=[...fontes].join('+')||null;
    return r;
  }
  function unirPontos(lista,inicio,campoTempo,campoLigacao){
    const pontos=[];
    for(const resposta of lista){
      const deslocamento=(Date.parse(resposta.dia_inicio)-inicio)/1000;
      if(!Number.isFinite(deslocamento))throw Error('O servidor não informou o início do dia do GPS.');
      for(const [i,original] of (resposta.pontos||[]).entries()){
        const p=[...original];p[campoTempo]+=deslocamento;if(i===0)p[campoLigacao]=2;pontos.push(p);
      }
    }
    return pontos;
  }
  function painel(respostas){
    if(respostas.length===1)return respostas[0];
    const primeira=respostas[0],ultima=respostas.at(-1),inicio=Date.parse(primeira.dia_inicio),porPlaca=new Map();
    for(const p of respostas)for(const v of p.veiculos||[]){
      if(!porPlaca.has(v.placa))porPlaca.set(v.placa,[]);
      porPlaca.get(v.placa).push({data:p.data,dia_inicio:p.dia_inicio,v});
    }
    const veiculos=[...porPlaca.entries()].map(([placa,dias])=>{
      const base=dias.at(-1).v,viagem=[...dias].reverse().find(d=>d.v.viagem)?.v.viagem||null;
      const visitas=dias.flatMap(d=>(d.v.visitas||[]).map(x=>({...x,data:d.data,viagem:d.v.viagem})));
      const comRastro=dias.some(d=>Array.isArray(d.v.rastro));
      const rastro=comRastro?unirPontos(dias.map(d=>({dia_inicio:d.dia_inicio,pontos:d.v.rastro||[]})),inicio,2,3):undefined;
      return {...base,placa,viagem,dia:somar(dias.map(d=>d.v.dia)),visitas,
        dias_sem_dados:respostas.filter(p=>!p.veiculos?.some(v=>v.placa===placa&&v.dia?.pontos>0)).map(p=>p.data),
        ...(comRastro?{rastro}:{}),volta:undefined};
    });
    const comLugares=[...respostas].reverse().find(p=>Array.isArray(p.lugares));
    return {...ultima,data:primeira.data,inicio:primeira.data,fim:ultima.data,total_dias:respostas.length,hoje:false,dia_inicio:primeira.dia_inicio,veiculos,
      ...(comLugares?{lugares:comLugares.lugares,lugares_v:comLugares.lugares_v}:{})};
  }
  function trajeto(respostas){
    if(respostas.length===1)return respostas[0];
    const primeira=respostas[0],ultima=respostas.at(-1);
    return {...primeira,...somar(respostas),inicio:primeira.data,fim:ultima.data,total_dias:respostas.length,
      pontos:unirPontos(respostas,Date.parse(primeira.dia_inicio),3,4),
      eventos:respostas.flatMap(r=>r.eventos||[]).sort((a,b)=>Date.parse(b.em)-Date.parse(a.em)),
      dias_sem_dados:respostas.filter(r=>!r.pontos?.length).map(r=>r.data)};
  }
  return {MAX_DIAS,datas,consultar,painel,trajeto};
});
