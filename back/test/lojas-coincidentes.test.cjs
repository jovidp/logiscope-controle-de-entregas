'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {createRequire}=require('node:module');
const rast=require('../rastreador');
const q=require('../gps-precisao');
const {amostrasDasEntregas}=require('../rastreador-lojas');
const centro={lat:-22.903692131034493,lng:-43.55793045512807};
const lojas=[{...centro,codigo:'418',nome:'CAMPO GRANDE III'},{...centro,codigo:'553',nome:'PASSEIO'}];
const parada=(ini,fim,extra={})=>({...centro,ini,fim,dur_min:fim-ini,...extra});
const entregas=[{codigo:'418',nome:'CAMPO GRANDE III',chegada:'08:05',saida:'08:54'},
  {codigo:'553',nome:'PASSEIO',chegada:'07:50',saida:'09:50'}];

test('Passeio e CG3 no mesmo GPS mostram os dois nomes ao vivo',()=>{
  const coords=new Map(q.ajustarAreasProximas(lojas).map(l=>[l.codigo,l]));
  for(const valores of [coords,new Map([...coords].reverse())]) {
    const p=rast.pertoDe(centro,valores);
    assert.equal(p.dentro,true);assert.equal(p.confirmacao_necessaria,true);
    assert.deepEqual([...p.ambigua].sort(),['418','553']);
    assert.ok(p.nome.includes('PASSEIO'));assert.ok(p.nome.includes('CAMPO GRANDE III'));
  }
});
test('Posicao ao vivo escolhe area que contem o GPS antes do centro mais perto',()=>{
  const p=rast.pertoDe(centro,new Map([
    ['418',{...lojas[0],lat:centro.lat+.0003,raio_entrada_m:20}],
    ['553',{...lojas[1],lat:centro.lat+.0008,raio_entrada_m:200}],
  ]));
  assert.equal(p.codigo,'553');assert.equal(p.dentro,true);assert.equal(p.ambigua,undefined);
});
test('Uma parada atribuida a duas lojas nao aprende duas coordenadas',()=>{
  const r=amostrasDasEntregas([parada(470,590)],entregas);
  assert.equal(r.amostras.length,0);assert.deepEqual([...r.revisar.keys()].sort(),['418','553']);
});
test('Registros duplicados da mesma loja nao aumentam confianca',()=>{
  const r=amostrasDasEntregas([parada(480,550)],[entregas[0],entregas[0]]);
  assert.equal(r.amostras.length,1);assert.equal(r.revisar.size,0);
});
test('Paradas distintas conservam aprendizado separado e ignoram parada curta',()=>{
  const r=amostrasDasEntregas([parada(480,534),parada(535,580),parada(600,602)],
    [{...entregas[0],chegada:'08:05',saida:'08:34'},{...entregas[1],chegada:'09:00',saida:'09:30'},
      {codigo:'C',chegada:'10:00',saida:'10:02'}]);
  assert.deepEqual(r.amostras.map(x=>x.entrega.codigo),['418','553']);assert.equal(r.semParada,1);
});
test('Mesmo centro em paradas independentes fica para revisao e nao e gravado',async()=>{
  const arquivo=require.resolve('../rastreador-lojas');const localRequire=createRequire(arquivo);
  const modulo={exports:{}};
  const fakeRast={...rast,listarAparelhos:async()=>[{placa:'FKB1D11',device_id:1}],
    paradasDoDia:async()=>[parada(480,510),parada(540,570)]};
  vm.runInNewContext(fs.readFileSync(arquivo,'utf8'),{module:modulo,console,setTimeout:fn=>fn(),
    require:Object.assign(n=>n==='./rastreador'?fakeRast:n==='./lojas-pes'?{FABRICA:'FABRICA',
      carregarIndice:async()=>({lojas,resolver:n=>lojas.find(l=>l.nome===n)})}:localRequire(n),{main:null})});
  let escritas=0;
  const db={query:async sql=>{
    if(sql.includes('FROM ocorrencias'))return {rowCount:6,rows:Array.from({length:3},(_,i)=>lojas.map((l,j)=>({
      id:i*2+j,loja:l.nome,placa:'FKB1D11',dia:'2026-10-0'+(i+1),
      chegada:j?'09:00':'08:00',saida:j?'09:30':'08:30',dia_seguinte:false,
    }))).flat()};
    escritas++;return {rows:[]};
  }};
  const r=await modulo.exports.aprender(db,{gravar:true,log:()=>{}});
  assert.equal(escritas,0);assert.equal(r.lojas_com_coordenada,0);
  assert.deepEqual(Array.from(r.para_revisar).sort(),['CAMPO GRANDE III','PASSEIO']);
  assert.ok(r.lojas.every(l=>l.confianca==='baixa' && l.motivo_revisao));
});
