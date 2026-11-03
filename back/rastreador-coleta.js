'use strict';
// Uma consulta por plataforma em andamento, sem bloquear as demais.
function criarColetaFontes() {
  const pendentes=new Map();
  function executar(fonte,coletar) {
    if(pendentes.has(fonte))return pendentes.get(fonte);
    const p=Promise.resolve().then(coletar).finally(()=>{if(pendentes.get(fonte)===p)pendentes.delete(fonte);});
    pendentes.set(fonte,p);return p;
  }
  return {executar};
}
module.exports={criarColetaFontes};