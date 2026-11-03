// Material descrito na ocorrência: o texto original é a fonte da pendência.
'use strict';
const grupos = {ok:'ok',nao:'falha',pendente:'pendente'};
const rotulos = {ok:'Retirado',nao:'Não retirado',pendente:'Pendente'};
const chave = id => `ocorrencia|${id}|retirada`;
function registro(o) {
  if (!o || !Number.isInteger(Number(o.id)) || Number(o.id) <= 0 || !o.loja
    || !['incorreta','parcial'].includes(o.material_retirada_status)) return null;
  const material = String(o.material_retirada_relato || '').replace(/\r\n/g,'\n').trim();
  if (!material) return null;
  return {chave:chave(o.id),data:o.data,tipo:'retirada',loja:o.loja,material,quantidade:null,transacao:null,
    ocorrencia_id:Number(o.id),fonte_formulario:true,rota:o.rota || null,motorista:o.motorista || null,
    conferencia_loja:o.material_retirada_status,relato_loja:material};
}
function montarLinhas(ocorrencias, marcados, {de,ate,codigoLoja,nomeLoja}) {
  const linhas=[];
  for (const o of ocorrencias) {
    const i=registro(o);
    if (!i || i.data>ate) continue;
    const m=marcados.get(i.chave);
    const grupo=grupos[m?.status] || 'pendente';
    if (i.data<de && grupo==='ok') continue;
    linhas.push({...i,loja:nomeLoja(i.loja),loja_planilha:i.loja,loja_codigo:codigoLoja(i.loja),manual:false,
      grupo,situacao:rotulos[m?.status] || (o.material_retirada_status==='parcial'?'Retirada parcial':'Não foi retirado'),
      fonte:'formulario',status_item:m?.status || null,marcado_por:m?.usuario_nome || null,
      marcado_em:m?.atualizado_em || null,obs_item:m?.observacao || null,resolvido_em_data:m?.resolvido_em_data || null});
  }
  return linhas;
}
module.exports={chave,registro,montarLinhas};
