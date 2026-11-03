'use strict';
function criar({db,rastreador,agoraSP}) {
  let cache=null;
  async function ler() {
    const [atuais,r]=await Promise.all([rastreador.posicoesAtuais(db),db.query('SELECT fonte,device_id,placa,posicao_em,online,motor FROM rastreador_aparelhos ORDER BY placa,fonte')]);
    const chave=a=>a.placa || `${a.fonte}:${a.device_id}`,porAtual=new Map(atuais.map(a=>[chave(a),a])),grupos=new Map(),agora=Date.now();
    for(const a of r.rows){const k=chave(a);(grupos.get(k)||grupos.set(k,[]).get(k)).push({fonte:a.fonte,posicao_em:a.posicao_em,online:a.online || null,motor:a.motor || null,idade_min:a.posicao_em?Math.round((agora-Date.parse(a.posicao_em))/60000):null});}
    const st=rastreador.estado;
    return {data:agoraSP().data,gerado_em:new Date().toISOString(),coleta_intervalo_s:Math.round(rastreador.intervaloColetaMs()/1000),
      plataformas:{srf:{configurado:rastreador.configurado(),ultima_coleta:st.ultima_coleta,erro:st.erro,falhas_seguidas:st.falhas_seguidas,aparelhos:st.aparelhos},t4s:{...st.t4s},sat:{...st.sat}},
      veiculos:[...grupos].map(([placa,fontes])=>({placa,atual:porAtual.get(placa)||null,fontes}))};
  }
  async function leitura() {
    if(!cache || Date.now()-cache.em>2000){const c={em:Date.now(),p:ler()};cache=c;c.p.catch(()=>{if(cache===c)cache=null;});}
    return cache.p;
  }
  async function posicoes(req,res){try{res.set?.('Cache-Control','no-store');res.json(await leitura());}catch(e){res.status(500).json({error:e.message});}}
  return {posicoes,leitura};
}
module.exports={criar};