'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {criar,normalizar}=require('../rastreador-sinais');
const ponto=(device_id,extra={})=>({fonte:'t4s',device_id,placa:'FKA0C10',
  lat:-22.875588,lng:-43.465901,velocidade:0,motor:'desligado',rumo:0,
  posicao_em:new Date(Date.now()-30000),...extra});
async function ambiente(t) {
  const diretorio=await fs.mkdtemp(path.join(os.tmpdir(),'gps-pendentes-test-'));
  t.after(()=>fs.rm(diretorio,{recursive:true,force:true}));
  return {diretorio,fila:criar({diretorio})};
}
test('Queda do banco conserva todos os sinais em disco antes da primeira tentativa SQL',async t=>{
  const {diretorio,fila}=await ambiente(t),pontos=[ponto(1),ponto(2)];
  await assert.rejects(fila.guardar({query:async()=>{
    const arquivos=await fs.readdir(diretorio);
    assert.equal(arquivos.length,1);
    assert.equal(JSON.parse(await fs.readFile(path.join(diretorio,arquivos[0]),'utf8')).length,2);
    throw Error('banco indisponivel');
  }},pontos),/banco indisponivel/);
  assert.equal((await fs.readdir(diretorio)).length,1);
  const gravados=[];
  // Nova instancia representa o servidor reiniciado, sem memoria anterior.
  assert.equal(await criar({diretorio}).drenar({query:async(sql,args)=>{
    gravados.push(...JSON.parse(args[0]));return {rowCount:2};
  }}),2);
  assert.deepEqual(gravados.map(p=>p.device_id),[1,2]);
  assert.equal((await fs.readdir(diretorio)).length,0);
});
test('Repetir sinal durante indisponibilidade nao multiplica arquivos e exclui so depois do INSERT',async t=>{
  const {diretorio,fila}=await ambiente(t),p=ponto(1);
  const indisponivel={query:async()=>{throw Error('falha');}};
  await assert.rejects(fila.guardar(indisponivel,[p]),/falha/);
  await assert.rejects(fila.guardar(indisponivel,[p]),/falha/);
  assert.equal((await fs.readdir(diretorio)).length,1);
  await assert.rejects(criar({diretorio}).drenar(indisponivel),/falha/);
  assert.equal((await fs.readdir(diretorio)).length,1);
  await fila.drenar({query:async(sql)=>{assert.match(sql,/ON CONFLICT/);return {rowCount:1};}});
  assert.deepEqual(await fs.readdir(diretorio),[]);
});
test('Sinal pendente preserva a data GPS original mesmo se o banco voltar dias depois',async t=>{
  const {diretorio,fila}=await ambiente(t);
  const p=ponto(1,{posicao_em:new Date(Date.now()-3*86400000)});
  await assert.rejects(fila.guardar({query:async()=>{throw Error('falha');}},[p]),/falha/);
  await criar({diretorio}).drenar({query:async(sql,args)=>{
    assert.equal(JSON.parse(args[0])[0].posicao_em,p.posicao_em.toISOString());return {rowCount:1};
  }});
});
test('Fila preserva fontes e remove segredos, rejeitando coordenadas e fontes invalidas',()=>{
  const validos=['srf','t4s','sat'].map(fonte=>ponto(1,{fonte,cookie:'segredo',senha:'segredo'}));
  const salvos=normalizar([...validos,ponto(1,{lat:NaN}),ponto(1,{fonte:'inventada'}),ponto(1,{valid:false})]);
  assert.deepEqual(salvos.map(p=>p.fonte),['srf','t4s','sat']);
  assert.ok(!JSON.stringify(salvos).includes('segredo'));
});
test('Coletores preservam o lote todo mesmo quando falha o resumo do primeiro aparelho',async t=>{
  const {diretorio,fila}=await ambiente(t),escritas=[];
  await assert.rejects(require('../rastreador').gravarAparelhos({query:async(sql,args)=>{
    if(sql.includes('INSERT INTO rastreador_posicoes')){escritas.push(...JSON.parse(args[0]));return {rowCount:2};}
    throw Error('resumo falhou');
  }},'t4s',[ponto(992001),ponto(992002)],{sinais:fila}),/resumo falhou/);
  assert.deepEqual(escritas.map(p=>p.device_id),[992001,992002]);
  assert.deepEqual(await fs.readdir(diretorio),[]);
});
test('Banco travado nao bloqueia a presalvacao das outras plataformas',async t=>{
  const {diretorio,fila}=await ambiente(t);
  let soltar,avisar;const trava=new Promise(r=>soltar=r),primeiro=new Promise(r=>avisar=r);
  let chamadas=0;
  const db={query:async()=>{if(++chamadas===1){avisar();await trava;}return {rowCount:1};}};
  const a=fila.guardar(db,[ponto(1,{fonte:'srf'})]);await primeiro;
  const b=fila.guardar(db,[ponto(2,{fonte:'sat'})]);
  try {
    let arquivos=[];
    for(let i=0;i<100;i++) {
      arquivos=await fs.readdir(diretorio);
      if(arquivos.filter(n=>n.endsWith('.json')).length===2)break;
      await new Promise(r=>setTimeout(r,10));
    }
    assert.equal(arquivos.filter(n=>n.endsWith('.json')).length,2);
  } finally {soltar();await Promise.all([a,b]);}
  assert.deepEqual(await fs.readdir(diretorio),[]);
});
