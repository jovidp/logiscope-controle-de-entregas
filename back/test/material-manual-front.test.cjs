const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const relato='2 CPU\nFIO DA IMPRESSORA SWEDA\nBOBINA DE IMPRESSORA';
function ambiente({linhas=[],erroMarcar=false}={}) {
  const ids=new Map(),pedidos=[],exports=[],avisos=[];let modal;
  const el=id=>{if(!ids.has(id))ids.set(id,{id,value:'',checked:true,innerHTML:'',textContent:'',listeners:{},style:{},addEventListener(tipo,fn){this.listeners[tipo]=fn;},querySelectorAll(){return [];},remove(){ids.delete(id);}});return ids.get(id);};
  el('relMatDe').value='2026-10-07';el('relMatAte').value='2026-10-07';
  const document={getElementById:el,createElement:()=>({style:{},addEventListener(){}}),body:{appendChild(div){modal=div;}}};
  const context={window:{location:{origin:'http://localhost'},alertar:m=>avisos.push(m),materialRotulosItem:{retirada:{ok:'Retirado',nao:'Não retirado',pendente:'Pendente'}},materialMarcarItem:async(item,status,data)=>{
    pedidos.push({marcacao:{item,status,data}});if(erroMarcar)throw Error('Falha de rede');return {resolvido_em_data:data};}},document,Date,
    fetch:async url=>{pedidos.push({url});return {ok:true,json:async()=>({de:'2026-10-07',ate:'2026-10-07',linhas,pendentes:[]})};},
    XLSX:{utils:{book_new:()=>({}),book_append_sheet(){},json_to_sheet:rows=>{exports.push(rows);return {};}},writeFile(){}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../../public/js/relatorio-material.js'),'utf8'),context);
  return {el,pedidos,exports,avisos,modal:()=>modal,abrir:context.window.relatorioMaterialAbrir};
}
const linha=extra=>({data:'2026-10-07',tipo:'retirada',loja:'RECREIO',material:relato,ocorrencia_id:1439,fonte_formulario:true,
  grupo:'pendente',situacao:'Não foi retirado',fonte:'formulario',status_item:null,...extra});
async function abrir(a){a.abrir();for(let i=0;i<10;i++)await Promise.resolve();}
function evento(st){return {target:{closest:()=>({dataset:{relIdx:'0',relSt:st},parentElement:{querySelectorAll:()=>[]}})}};}

test('Relatório mostra anotação original e ocorrência, sem pedir um novo cadastro',async()=>{
  const a=ambiente({linhas:[linha()]});await abrir(a);
  const html=a.el('relMatCorpo').innerHTML;assert.ok(html.includes(relato));assert.ok(html.includes('ocorrência #1439'));assert.ok(html.includes('Não foi retirado'));assert.ok(html.includes('white-space:pre-line'));
  assert.ok(!a.modal().innerHTML.includes('relMatManualForm'));assert.equal(a.pedidos.length,1);
});
test('Buscar texto e filtrar pendente inclui material anotado no formulário',async()=>{
  const a=ambiente({linhas:[linha()]});await abrir(a);a.el('relMatGrupo').value='pendente';a.el('relMatBusca').value='BOBINA';a.el('relMatBusca').listeners.input();
  assert.ok(a.el('relMatCorpo').innerHTML.includes(relato));a.el('relMatGrupo').value='ok';a.el('relMatGrupo').listeners.change();assert.ok(!a.el('relMatCorpo').innerHTML.includes(relato));
});
test('Excel conserva descrição completa e identifica o formulário e a ocorrência',async()=>{
  const a=ambiente({linhas:[linha()]});await abrir(a);a.el('relMatExcel').listeners.click();
  const row=a.exports[0][0];assert.equal(row.Material,relato);assert.equal(row.Fonte,'Formulário de ocorrência');assert.equal(row.Ocorrência,1439);assert.equal(row.Quantidade,'');
});
test('Confirmação de retirada registra data sem alterar anotação original',async()=>{
  const l=linha();const a=ambiente({linhas:[l]});await abrir(a);await a.el('relMatCorpo').listeners.click(evento('ok'));
  const m=a.pedidos.find(p=>p.marcacao).marcacao;assert.equal(m.item.ocorrencia_id,1439);assert.equal(m.item.fonte_formulario,true);assert.equal(m.status,'ok');assert.match(m.data,/^\d{4}-\d{2}-\d{2}$/);
  assert.equal(l.material,relato);assert.equal(l.status_item,'ok');assert.ok(a.el('relMatCorpo').innerHTML.includes('retirado em'));
});
test('Falha de conferência conserva a pendência e a opção de antigas muda a consulta',async()=>{
  const l=linha({data:'2026-08-01'});const a=ambiente({linhas:[l],erroMarcar:true});await abrir(a);await a.el('relMatCorpo').listeners.click(evento('ok'));
  assert.equal(l.grupo,'pendente');assert.ok(a.avisos[0].includes('Falha de rede'));assert.ok(a.el('relMatCorpo').innerHTML.includes('pendência anterior'));
  a.el('relMatAnteriores').checked=false;await a.el('relMatAnteriores').listeners.change();assert.ok(a.pedidos.at(-1).url.includes('anteriores=0'));
});
test('Repetir botão ativo não remove conferência; texto do formulário é escapado',async()=>{
  const a=ambiente({linhas:[linha({status_item:'pendente',material:'<script>alert(1)</script>'})]});await abrir(a);await a.el('relMatCorpo').listeners.click(evento('pendente'));
  assert.ok(!a.pedidos.some(p=>p.marcacao));assert.ok(!a.el('relMatCorpo').innerHTML.includes('<script>'));assert.ok(a.el('relMatCorpo').innerHTML.includes('&lt;script&gt;'));
});
test('Cliente de marcação envia a origem e o ID da ocorrência ao servidor',async()=>{
  let body;const context={window:{location:{origin:'http://localhost'}},document:{addEventListener(){}},setInterval(){},fetch:async(_url,opts)=>{body=JSON.parse(opts.body);return {ok:true,json:async()=>({})};}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../../public/js/materiais-rota.js'),'utf8'),context);
  await context.window.materialMarcarItem(linha(),'ok','2026-10-07');assert.equal(body.fonte_formulario,true);assert.equal(body.ocorrencia_id,1439);assert.equal(body.material,relato);
});
