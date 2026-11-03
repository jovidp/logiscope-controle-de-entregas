const test = require('node:test');
const assert = require('node:assert/strict');
const status = require('../material-status');
const materiais = require('../materiais-rota');
process.env.MATERIAL_STATUS_ONLYOFFICE = '0';

function ambiente({ itens = [], offline = false, ocorrencias = [] } = {}) {
  const linhas = new Map(), consultas = [];
  const db = { async query(sql, params = []) {
    consultas.push({ sql, params });
    if (sql.includes('INSERT INTO material_item_status')) {
      const anterior = linhas.get(params[0]);
      assert.match(sql, /WHERE NOT \$16::boolean/);
      if (anterior && params[15]) return { rows: [] };
      const [chave,data,tipo,loja_codigo,loja,loja_planilha,material,quantidade,transacao,st,obs,resolvido,ocorrencia_id,usuario_id,usuario_nome,manual] = params;
      const m = { chave,data,tipo,loja_codigo,loja,loja_planilha,material,quantidade,transacao,status:st,
        observacao:obs || anterior?.observacao || null, resolvido_em_data:resolvido,ocorrencia_id,usuario_id,usuario_nome,
        manual:manual || anterior?.manual || false,atualizado_em:'07/10/2026 15:00' };
      linhas.set(chave,m);
      return { rows: [m] };
    }
    if (sql.includes('SELECT manual FROM')) return { rows: linhas.has(params[0]) ? [linhas.get(params[0])] : [] };
    if (sql.includes('DELETE FROM material_item_status')) { linhas.delete(params[0]); return { rows: [] }; }
    if (sql.includes('FROM material_item_status')) {
      const [de,ate,loja] = params, anteriores = sql.includes('OR (manual = TRUE');
      return { rows: [...linhas.values()].filter(m => (!loja || m.loja_codigo === loja) &&
        ((m.data >= de && m.data <= ate) || (anteriores && m.manual && m.data < de && ['nao','pendente'].includes(m.status))
          || (sql.includes("OR chave LIKE 'ocorrencia|%'") && m.chave.startsWith('ocorrencia|')))) };
    }
    if (sql.includes('FROM ocorrencias WHERE id=$1')) return {rows:ocorrencias.filter(o=>o.id===params[0] && !o.excluida_em)};
    if (sql.includes('FROM ocorrencias')) {
      const [de,ate,anteriores]=params;
      return {rows:ocorrencias.filter(o=>!o.excluida_em && o.data<=ate && (o.data>=de || (anteriores && ['incorreta','parcial'].includes(o.material_retirada_status))))};
    }
    throw Error('Consulta inesperada: '+sql);
  } };
  status.configurar({ db, chaveLoja:n=>n.toUpperCase(), lojasPes:{ carregarIndice:async()=>({resolver:n=>['A','LOJA A'].includes(n.toUpperCase()) ? {codigo:1,nome:'Loja A'} : null}) } });
  materiais.itensDoPeriodo = async()=>{ if (offline) throw Error('planilha fora do ar'); return {itens,pendentes:[]}; };
  materiais.materiaisDaLoja = async()=>{ if (offline) throw Error('planilha fora do ar'); return {envio:[],retirada:[],pendentes:[]}; };
  return {linhas,consultas};
}
const item = (extra={}) => ({data:'2026-08-01',tipo:'retirada',loja:'A',material:'Caixas vazias',quantidade:'2 caixas',
  transacao:'TR-10',observacao:'Loja não separou o material',status:'pendente',manual:true,...extra});
const usuario = {id:7,nome:'Operador'};
const originais = {itensDoPeriodo:materiais.itensDoPeriodo,materiaisDaLoja:materiais.materiaisDaLoja};
test.after(()=>Object.assign(materiais,originais));

test('Registro manual salva loja, material, anotação e responsável e aparece no relatório',async()=>{
  const a=ambiente();const m=await status.marcar(item(),usuario);
  assert.equal(m.manual,true);assert.equal(m.status,'pendente');assert.equal(m.loja_codigo,'PES:1');assert.equal(m.usuario_nome,'Operador');
  const r=await status.relatorioPeriodo('2026-08-01','2026-08-01');
  assert.equal(r.manual_disponivel,true);assert.equal(r.linhas.length,1);assert.equal(r.linhas[0].manual,true);
  assert.equal(r.linhas[0].quantidade,'2 caixas');assert.equal(r.linhas[0].obs_item,'Loja não separou o material');assert.equal(r.resumo.pendente,1);
  assert.equal(a.linhas.size,1);
});
test('Mesmo item e alias da loja não duplicam nem sobrescrevem a anotação',async()=>{
  const a=ambiente();await status.marcar(item(),usuario);
  await assert.rejects(status.marcar(item({loja:'Loja A',observacao:'Outra anotação',quantidade:'99'}),usuario),e=>e.status===409);
  assert.equal(a.linhas.size,1);assert.equal([...a.linhas.values()][0].quantidade,'2 caixas');
});
test('Pendência antiga continua visível até retirada e mantém o histórico original',async()=>{
  ambiente();await status.marcar(item(),usuario);
  const r=await status.relatorioPeriodo('2026-10-01','2026-10-07',{incluirAnteriores:true});assert.equal(r.linhas.length,1);
  assert.equal((await status.relatorioPeriodo('2026-10-01','2026-10-07')).linhas.length,0);
  const resolvido=await status.marcar(item({manual:false,status:'ok',data_visita:'2026-10-07',observacao:''}),usuario);
  assert.equal(resolvido.manual,true);assert.equal(resolvido.resolvido_em_data,'2026-10-07');assert.equal(resolvido.observacao,'Loja não separou o material');
  assert.equal((await status.relatorioPeriodo('2026-10-01','2026-10-07',{incluirAnteriores:true})).linhas.length,0);
  const historico=await status.relatorioPeriodo('2026-08-01','2026-08-01');assert.equal(historico.linhas[0].grupo,'ok');assert.equal(historico.linhas[0].resolvido_em_data,'2026-10-07');
});
test('Clique de desmarcação não apaga registro manual',async()=>{
  const a=ambiente();await status.marcar(item(),usuario);
  await assert.rejects(status.marcar(item({manual:false,status:''}),usuario),e=>e.status===400);
  assert.equal(a.linhas.size,1);assert.ok(!a.consultas.some(c=>c.sql.includes('DELETE')));
});
test('Datas impossíveis e campos inválidos não são gravados',async()=>{
  const a=ambiente();
  for(const extra of [{data:'2026-02-31'},{material:''},{loja:''},{tipo:'envio'},{status:'ok'},{material:'x'.repeat(201)},{data_visita:'2026-02-31'}]) {
    await assert.rejects(status.marcar(item(extra),usuario),e=>e.status===400);
  }
  assert.equal(a.linhas.size,0);assert.equal(a.consultas.length,0);
});
test('Manual não duplica item da planilha e marcações comuns conservam comportamento',async()=>{
  ambiente({itens:[{...item(),manual:false}]});await status.marcar(item(),usuario);
  const r=await status.relatorioPeriodo('2026-08-01','2026-08-01');assert.equal(r.linhas.length,1);assert.equal(r.resumo.total,1);
  await status.marcar(item({material:'Item da planilha',manual:false,status:'nao'}),usuario);
  await status.marcar(item({material:'Item da planilha',manual:false,status:''}),usuario);
});
test('Planilha indisponível não esconde lançamentos manuais nem pendências de visitas antigas',async()=>{
  ambiente({offline:true});await status.marcar(item(),usuario);
  const r=await status.relatorioPeriodo('2026-10-01','2026-10-07',{incluirAnteriores:true});
  assert.equal(r.linhas.length,1);assert.ok(r.aviso_planilha);
  const loja=await status.materialDaLoja('2026-10-07','Loja A');assert.equal(loja.anteriores.length,1);
  assert.equal(loja.anteriores[0].itens[0].manual,true);assert.equal(status.resumir(loja).pendentes_anteriores,1);
});
test('Conclusão no mesmo dia registra a data; planilha indisponível impede exportação mensal incompleta',async()=>{
  ambiente();await status.marcar(item(),usuario);
  const r=await status.marcar(item({manual:false,status:'ok',data_visita:'2026-08-01'}),usuario);
  assert.equal(r.resolvido_em_data,'2026-08-01');
  ambiente({offline:true});await status.marcar(item(),usuario);
  await assert.rejects(status.montarPlanilhaMes(2026,8),/Não foi possível ler a planilha/);
});
const ocorrencia = extra => ({id:1439,data:'2026-10-07',loja:'A',rota:'Rota A',motorista:'Motorista A',
  material_retirada_status:'incorreta',material_retirada_relato:'2 CPU\nFIO DA IMPRESSORA SWEDA\nBOBINA DE IMPRESSORA',...extra});
test('Observação do formulário entra no relatório sem depender de item na planilha ou novo lançamento',async()=>{
  const a=ambiente({ocorrencias:[ocorrencia()]});const r=await status.relatorioPeriodo('2026-10-07','2026-10-07');
  assert.equal(r.linhas.length,1);const l=r.linhas[0];assert.equal(l.material,ocorrencia().material_retirada_relato);
  assert.equal(l.ocorrencia_id,1439);assert.equal(l.grupo,'pendente');assert.equal(l.situacao,'Não foi retirado');
  assert.equal(l.fonte_formulario,true);assert.equal(l.quantidade,null);assert.equal(r.resumo.pendente,1);
  assert.ok(!a.consultas.some(c=>c.sql.includes('INSERT')));
});
test('Retirada parcial com relato também entra; não se aplica, correta e excluídas não viram pendências',async()=>{
  ambiente({ocorrencias:[ocorrencia({id:1,material_retirada_status:'parcial'}),ocorrencia({id:2,material_retirada_status:'na'}),
    ocorrencia({id:3,material_retirada_status:'correta'}),ocorrencia({id:4,excluida_em:'2026-10-07'}),ocorrencia({id:5,material_retirada_relato:'  '})]});
  const r=await status.relatorioPeriodo('2026-10-07','2026-10-07');assert.equal(r.linhas.length,1);assert.equal(r.linhas[0].situacao,'Retirada parcial');
});
test('Conferência usa ocorrência original e mantém a identidade quando a anotação é editada',async()=>{
  const o=ocorrencia();const a=ambiente({ocorrencias:[o]});
  const r=await status.marcar({fonte_formulario:true,ocorrencia_id:1439,tipo:'retirada',status:'ok',data_visita:'2026-10-07',
    data:'2025-01-01',loja:'Outra loja',material:'Texto forjado',quantidade:'999'},usuario);
  assert.equal(r.chave,'ocorrencia|1439|retirada');assert.equal(r.ocorrencia_id,1439);assert.equal(r.material,o.material_retirada_relato);assert.equal(r.quantidade,null);
  o.material_retirada_relato='Texto corrigido no formulário';
  const rel=await status.relatorioPeriodo('2026-10-07','2026-10-07');assert.equal(rel.linhas[0].grupo,'ok');assert.equal(rel.linhas[0].material,o.material_retirada_relato);
  assert.equal(a.linhas.size,1);
});
test('Duas ocorrências da mesma loja e data mantêm anotações e conferências independentes',async()=>{
  const primeiro=ocorrencia({id:1}),segundo=ocorrencia({id:2});ambiente({ocorrencias:[primeiro,segundo]});
  await status.marcar({fonte_formulario:true,ocorrencia_id:1,tipo:'retirada',status:'ok',data_visita:'2026-10-07'},usuario);
  const r=await status.relatorioPeriodo('2026-10-07','2026-10-07');assert.equal(r.linhas.length,2);assert.equal(r.resumo.ok,1);assert.equal(r.resumo.pendente,1);
});
test('Pendência do formulário de data anterior aparece até ser confirmada e mantém histórico',async()=>{
  const o=ocorrencia({data:'2026-08-01'});ambiente({ocorrencias:[o]});
  assert.equal((await status.relatorioPeriodo('2026-10-01','2026-10-07')).linhas.length,0);
  assert.equal((await status.relatorioPeriodo('2026-10-01','2026-10-07',{incluirAnteriores:true})).linhas.length,1);
  await status.marcar({fonte_formulario:true,ocorrencia_id:1439,tipo:'retirada',status:'ok',data_visita:'2026-10-07'},usuario);
  assert.equal((await status.relatorioPeriodo('2026-10-01','2026-10-07',{incluirAnteriores:true})).linhas.length,0);
  assert.equal((await status.relatorioPeriodo('2026-08-01','2026-08-01')).linhas[0].resolvido_em_data,'2026-10-07');
});
test('Ocorrência inexistente ou excluída não aceita conferência e planilha indisponível preserva relato',async()=>{
  const a=ambiente({offline:true,ocorrencias:[ocorrencia()]});
  await assert.rejects(status.marcar({fonte_formulario:true,ocorrencia_id:999,tipo:'retirada',status:'ok'},usuario),e=>e.status===400);
  const r=await status.relatorioPeriodo('2026-10-07','2026-10-07');assert.equal(r.linhas[0].material,ocorrencia().material_retirada_relato);assert.ok(r.aviso_planilha);
  assert.equal(a.linhas.size,0);
});
