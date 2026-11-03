'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {lerZip,lerConversa,montarGrupos,criarRotas,rotaPermitida,crc32,sugerirVinculo}=require('../checklist-whatsapp');
function zip(entries,method=0){
 const locals=[],centrals=[];let offset=0;
 for(const [name,value] of entries){const nome=Buffer.from(name),dados=Buffer.from(value),raw=method===8?zlib.deflateRawSync(dados):dados;
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(method,8);local.writeUInt32LE(crc32(dados),14);local.writeUInt32LE(raw.length,18);local.writeUInt32LE(dados.length,22);local.writeUInt16LE(nome.length,26);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(method,10);central.writeUInt32LE(crc32(dados),16);central.writeUInt32LE(raw.length,20);central.writeUInt32LE(dados.length,24);central.writeUInt16LE(nome.length,28);central.writeUInt32LE(offset,42);
  locals.push(local,nome,raw);centrals.push(central,nome);offset+=local.length+nome.length+raw.length;
 }
 const indice=Buffer.concat(centrals),fim=Buffer.alloc(22);fim.writeUInt32LE(0x06054b50);fim.writeUInt16LE(entries.length,8);fim.writeUInt16LE(entries.length,10);fim.writeUInt32LE(indice.length,12);fim.writeUInt32LE(offset,16);return Buffer.concat([...locals,indice,fim]);
}
const texto='[10/7/26, 3:52:55 AM] Fabio Nunes: <Mensagem de album>\n[10/7/26, 3:52:56 AM] Fabio Nunes: <imagem ocultada>\n[10/7/26, 3:52:57 AM] Fabio Nunes: <imagem ocultada>\n[10/7/26, 4:52:38 AM] Silvio Motorista: <imagem ocultada>\n[10/7/26, 6:01:03 AM] Hugo Daniel Carreteiro: <imagem ocultada>';
const png=Buffer.from([137,80,78,71,13,10,26,10,0]),jpeg=Buffer.from([255,216,255,0]);
test('datas ambíguas precisam seguir a ordem escolhida; álbum não conta como foto',()=>{
 const mdy=lerConversa(texto,'mdy'),dmy=lerConversa(texto,'dmy');assert.equal(mdy[0].data,'2026-10-07');assert.equal(dmy[0].data,'2026-07-10');
 const grupos=montarGrupos(mdy,[],'2026-10-07');assert.equal(grupos.length,3);assert.deepEqual(grupos.map(g=>g.fotos_indicadas),[2,1,1]);assert.ok(grupos.every(g=>g.fotos.length===0));assert.deepEqual(montarGrupos(mdy,[],'2026-07-10'),[]);
});
test('Android, linhas continuadas, horários AM/PM e mensagens de sistema',()=>{
 const m=lerConversa('07/10/2026 00:04 - Aviso de criptografia\n07/10/2026 04:15 - Nome: IMG-1.jpg (arquivo anexado)\nLegenda FKD3F13\n[10/7/26, 12:01:03 AM] Nome: <imagem ocultada>\n[10/7/26, 12:01:04 PM] Nome: <imagem ocultada>','mdy');
 assert.equal(m.length,3);assert.equal(m[0].data,'2026-07-10');assert.match(m[0].corpo,/Legenda FKD3F13/);assert.equal(m[1].hora,'00:01:03');assert.equal(m[2].hora,'12:01:04');
});
test('datas impossíveis e horários inválidos não são ajustados silenciosamente',()=>{
 for(const line of ['[31/2/26, 03:00] A: <imagem ocultada>','[7/10/26, 25:00] A: <imagem ocultada>','[7/10/26, 0:00 PM] A: <imagem ocultada>'])assert.throws(()=>lerConversa(line,'dmy'),/inválido/);
 assert.throws(()=>lerConversa(texto,'ymd'),/Escolha/);
});
test('ZIP armazenado ou deflate reconhece texto e ignora Markdown',()=>{
 for(const method of [0,8]){const result=lerZip(zip([['chat.txt',texto],['chat.md','ignorar']],method));assert.equal(result.texto,texto);assert.equal(result.arquivos.length,0);}
});
test('ZIP com travessia, nomes duplicados, CRC corrompido ou sem conversa é recusado',()=>{
 assert.throws(()=>lerZip(zip([['../chat.txt',texto]])),/caminhos/);assert.throws(()=>lerZip(zip([['C:\\chat.txt',texto]])),/caminhos/);
 assert.throws(()=>lerZip(zip([['chat.txt',texto],['chat.txt',texto]])),/repetidos/);
 const b=zip([['chat.txt',texto]]);b[40]^=1;assert.throws(()=>lerZip(b),/corrompido/);
 assert.throws(()=>lerZip(zip([['foto.jpg',jpeg]])),/exatamente um texto/);assert.throws(()=>lerZip(Buffer.alloc(30)),/inválido/);
});
test('limites de expansão e compressão não suportada são bloqueados',()=>{
 const b=zip([['chat.txt',texto]],8),central=b.readUInt32LE(b.length-6);b.writeUInt32LE(61*1024*1024,central+24);assert.throws(()=>lerZip(b),/60 MB/);
 const c=zip([['chat.txt',texto]]),index=c.readUInt32LE(c.length-6);c.writeUInt16LE(99,index+10);assert.throws(()=>lerZip(c),/compressão/);
});
test('anexos são associados à mensagem, deduplicados por conteúdo e não confundidos com fotos ocultas',()=>{
 const txt='07/10/2026 04:00 - Nome: IMG-A.jpg (arquivo anexado) FKD-3F13\n07/10/2026 04:01 - Nome: IMG-B.jpg (arquivo anexado)\n07/10/2026 04:02 - Nome: sem.jpg (arquivo anexado)\n07/10/2026 04:03 - Outro: <imagem ocultada>';
 const grupos=montarGrupos(lerConversa(txt),[{nome:'IMG-A.jpg',dados:jpeg},{nome:'pasta/IMG-B.jpg',dados:jpeg},{nome:'avulsa.png',dados:png}],'2026-10-07');
 assert.equal(grupos[0].fotos_indicadas,3);assert.equal(grupos[0].fotos.length,1);assert.deepEqual(grupos[0].placas,['FKD3F13']);assert.equal(grupos[1].fotos.length,0);
 assert.throws(()=>montarGrupos([], [{nome:'f.jpg',dados:Buffer.from('<svg/>')}],'2026-10-07'),/não é uma foto/);
});
const motoristas=[{id:48,nome:'FABIO NUNES'},{id:51,nome:'SILVIO RAMOS'},{id:45,nome:'HUGO TAVARES'}];
const viagens=[{id:275,motorista:'FABIO NUNES',placa:'FKC2E12',rota:'R.LAGOS'},{id:276,motorista:'SILVIO RAMOS',placa:'FKD3F13',rota:'Z.NORTE I'},{id:272,motorista:'HUGO TAVARES',placa:'FKF5H15',rota:'Z.NORTE II'}];
function banco(){const queries=[],salvos=new Map(),fotos=new Set(),checklists=new Map();let release=0;
 const client={async query(sql,args){queries.push({sql,args});
  if(sql.startsWith('SELECT id,motorista_id')){const v=salvos.get(args.join('|'));return {rows:v?[v]:[]};}
  if(sql.startsWith('INSERT INTO checklist_whatsapp_envios')){const key=[args[0],args[2],args[5]].join('|'),ant=salvos.get(key);if(ant&&ant.motorista_id!==args[3])return {rows:[]};const v=ant||{id:salvos.size+1,motorista_id:args[3]};salvos.set(key,v);return {rows:[{id:v.id}]};}
  if(sql.startsWith('SELECT id,motorista FROM checklists_diarios'))return {rows:[...checklists.values()].filter(c=>c.data===args[0]&&c.placa===args[1])};
  if(sql.startsWith('INSERT INTO checklists_diarios')){const [id,data,motorista,placa,rota,obs]=args;checklists.set(id,{id,data,motorista,placa,rota,obs,itens:[],total_itens:0,origem:'whatsapp'});return {rows:[{id}]};}
  if(sql.startsWith('INSERT INTO checklist_whatsapp_fotos'))fotos.add(args[0]+'|'+args[3]);return {rows:[]};},release(){release++;}};
 const db={async query(sql,args){queries.push({sql,args});if(sql.startsWith('SELECT id,nome'))return {rows:motoristas};if(sql.startsWith('SELECT v.id'))return {rows:viagens};throw Error('Consulta inesperada');},async connect(){return client;}};
 return {db,queries,salvos,fotos,checklists,get release(){return release;}};
}
function req(body,extra={}){return {usuarioLogado:{id:1},query:{data:'2026-10-07',ordem:'mdy'},params:{},body,...extra};}
async function chamar(fn,r){const result={code:200};const res={status(n){result.code=n;return this;},json(value){result.body=value;return this;},set(headers){result.headers=headers;return this;},send(value){result.body=value;return this;}};await fn(r,res);return result;}
async function previa(routes,txt=texto,extras=[]){return chamar(routes.previa,req(zip([['chat.txt',txt],...extras])));}
const escolha=(token,selecoes=[{indice:0,motorista_id:48,placa:'FKC2E12'}])=>req({token,selecoes});
test('prévia é somente leitura; nome único cruza TMS; outro usuário não vê a foto',async()=>{
 const b=banco(),r=criarRotas({db:b.db}),p=await previa(r);assert.equal(p.code,200);assert.equal(p.body.grupos[0].motorista_sugerido,48);assert.equal(p.body.grupos[1].motorista_sugerido,51);assert.deepEqual(p.body.grupos[1].sugestoes,[51]);assert.equal(p.body.grupos[2].motorista_sugerido,45);assert.deepEqual(p.body.grupos[2].sugestoes,[45]);assert.equal(b.salvos.size,0);
 const other=await chamar(r.confirmar,{...escolha(p.body.token),usuarioLogado:{id:2}});assert.equal(other.code,404);
 assert.equal((await chamar(r.fotoPrevia,req(null,{usuarioLogado:{id:2},params:{token:p.body.token,grupo:'0',foto:'0'}}))).code,404);
});
test('vínculo motorista/placa errado, duplicado ou sem viagem é recusado antes de gravar',async()=>{
 const b=banco(),r=criarRotas({db:b.db}),p=await previa(r);
 for(const sels of [[{indice:0,motorista_id:48,placa:'FKD3F13'}],[{indice:0,motorista_id:999,placa:'FKC2E12'}],[{indice:0,motorista_id:48,placa:'FKC2E12'},{indice:0,motorista_id:48,placa:'FKC2E12'}]])assert.equal((await chamar(r.confirmar,escolha(p.body.token,sels))).code,400);
 assert.equal(b.salvos.size,0);assert.ok(!b.queries.some(q=>q.sql==='BEGIN'));assert.equal((await chamar(r.confirmar,escolha(p.body.token))).code,200);
});
test('confirmar sem fotos registra checklist feito; nova importação reaproveita o registro',async()=>{
 const b=banco(),audits=[],r=criarRotas({db:b.db,registrarAuditoria:async(...args)=>audits.push(args)}),p=await previa(r);
 const first=await chamar(r.confirmar,escolha(p.body.token));assert.equal(first.code,200);assert.equal(first.body.novos,1);assert.equal(b.fotos.size,0);assert.equal(audits.length,1);assert.equal(b.release,1);
 assert.equal((await chamar(r.confirmar,escolha(p.body.token))).code,404);
 const again=await previa(r),second=await chamar(r.confirmar,escolha(again.body.token));assert.equal(second.body.atualizados,1);assert.equal(b.salvos.size,1);
 assert.equal(b.checklists.size,1);assert.equal(first.body.checklists_novos,1);assert.equal(second.body.checklists_novos,0);assert.deepEqual(first.body.checklist_ids,second.body.checklist_ids);const checklist=[...b.checklists.values()][0];assert.equal(checklist.placa,'FKC2E12');assert.equal(checklist.rota,'R.LAGOS');assert.equal(checklist.origem,'whatsapp');assert.deepEqual(checklist.itens,[]);assert.ok(b.queries.some(q=>q.sql==='COMMIT'));
});
test('fotos da prévia são privadas; bytes ficam fora do JSON e anexos não duplicam na confirmação',async()=>{
 const b=banco(),r=criarRotas({db:b.db}),txt='[10/7/26, 3:52:56 AM] Fabio Nunes: <attached: IMG-1.png>';
 const p=await previa(r,txt,[['IMG-1.png',png]]);assert.equal(p.body.grupos[0].fotos[0].dados,undefined);
 const photo=await chamar(r.fotoPrevia,req(null,{params:{token:p.body.token,grupo:'0',foto:'0'}}));assert.deepEqual(photo.body,png);assert.equal(photo.headers['Cache-Control'],'private, no-store');
 await chamar(r.confirmar,escolha(p.body.token));const p2=await previa(r,txt,[['IMG-1.png',png]]);await chamar(r.confirmar,escolha(p2.body.token));assert.equal(b.fotos.size,1);
});
test('duas confirmações simultâneas do mesmo token não gravam duas vezes',async()=>{
 const b=banco(),r=criarRotas({db:b.db}),p=await previa(r),results=await Promise.all([chamar(r.confirmar,escolha(p.body.token)),chamar(r.confirmar,escolha(p.body.token))]);
 assert.deepEqual(results.map(v=>v.code).sort(),[200,409]);assert.equal(b.queries.filter(q=>q.sql==='BEGIN').length,1);
});
test('falha no banco causa rollback e permite tentar a confirmação novamente',async()=>{
 const b=banco(),client=await b.db.connect(),original=client.query;let fail=true;client.query=async function(sql,args){if(fail&&sql.startsWith('INSERT INTO checklist_whatsapp_envios')){fail=false;throw Object.assign(Error('Falha controlada'),{status:503});}return original(sql,args);};
 const r=criarRotas({db:b.db}),p=await previa(r);assert.equal((await chamar(r.confirmar,escolha(p.body.token))).code,503);assert.ok(b.queries.some(q=>q.sql==='ROLLBACK'));assert.equal((await chamar(r.confirmar,escolha(p.body.token))).code,200);assert.equal(b.release,2);
});
test('rotas de leitura não dão permissão para importar, apagar ou acessar outros recursos',()=>{
 assert.equal(rotaPermitida({method:'GET',path:'/checklists-diarios/whatsapp/envios'},true),true);
 assert.equal(rotaPermitida({method:'POST',path:'/checklists-diarios/whatsapp/previa'},true),false);
 assert.equal(rotaPermitida({method:'POST',path:'/checklists-diarios/whatsapp/confirmar'}),true);
 for(const [method,path] of [['DELETE','/checklists-diarios/whatsapp/envios'],['GET','/tms/viagens'],['POST','/checklists-diarios/whatsapp/fotos/1'],['GET','/checklists-diarios/whatsapp/confirmar']])assert.equal(rotaPermitida({method,path}),false);
});
test('qualquer mensagem do remetente no dia conta; não importa outro dia ou avisos de sistema',()=>{
 const txt='07/10/2026 04:00 - Mensagens protegidas por criptografia\n07/10/2026 04:01 - Fabio Nunes: Bom dia\n07/10/2026 04:02 - Fabio Nunes: Saindo\n07/10/2026 04:03 - Silvio Motorista: Pronto\n06/10/2026 04:04 - Outro: Já saí';
 const grupos=montarGrupos(lerConversa(txt),[],'2026-10-07');assert.equal(grupos.length,2);assert.equal(grupos[0].mensagens,2);assert.equal(grupos[0].fotos_indicadas,0);assert.equal(grupos[0].hora_inicio,'04:01:00');
});
test('primeiro nome duplicado não associa motoristas automaticamente; várias viagens exigem escolha',()=>{
 const cad={motoristas:[...motoristas,{id:60,nome:'SILVIO OUTRO'}],viagens};
 const v=sugerirVinculo({remetente:'Silvio Motorista'},cad);assert.equal(v.motorista_sugerido,null);assert.equal(v.viagem_sugerida,null);assert.deepEqual(v.sugestoes,[51,60]);
 const completo=sugerirVinculo({remetente:'Silvio Ramos'},cad);assert.equal(completo.motorista_sugerido,51);assert.equal(completo.viagem_sugerida,276);
 const varias=sugerirVinculo({remetente:'Fabio Nunes'},{motoristas,viagens:[...viagens,{...viagens[0],id:300,rota:'Outra rota'}]});assert.equal(varias.motorista_sugerido,48);assert.equal(varias.viagem_sugerida,null);
});
test('viagem explícita resolve duas rotas com a mesma placa, sem aceitar viagem de outro motorista',async()=>{
 const b=banco(),original=b.db.query;b.db.query=async function(sql,args){const r=await original(sql,args);return sql.startsWith('SELECT v.id')?{rows:[...r.rows,{...viagens[0],id:300,rota:'OUTRA ROTA'}]}:r;};
 const r=criarRotas({db:b.db}),p=await previa(r);
 assert.equal((await chamar(r.confirmar,escolha(p.body.token))).code,400);
 assert.equal((await chamar(r.confirmar,escolha(p.body.token,[{indice:0,motorista_id:48,placa:'FKC2E12',viagem_id:276}]))).code,400);
 const ok=await chamar(r.confirmar,escolha(p.body.token,[{indice:0,motorista_id:48,placa:'FKC2E12',viagem_id:300}]));assert.equal(ok.code,200);assert.equal([...b.checklists.values()][0].rota,'OUTRA ROTA');
});
test('checklist manual existente é reaproveitado, preservando itens verificados',async()=>{
 const b=banco();b.checklists.set(42,{id:42,data:'2026-10-07',motorista:'FABIO NUNES',placa:'FKC2E12',rota:'MANUAL',itens:['Pneus'],total_itens:1});
 const r=criarRotas({db:b.db}),p=await previa(r),ok=await chamar(r.confirmar,escolha(p.body.token));assert.equal(ok.code,200);assert.equal(ok.body.checklists_novos,0);assert.deepEqual(ok.body.checklist_ids,[42]);assert.equal(b.checklists.size,1);assert.deepEqual(b.checklists.get(42).itens,['Pneus']);
});
test('dois nomes do mesmo motorista no dia reaproveitam um único checklist',async()=>{
 const b=banco(),r=criarRotas({db:b.db}),p=await previa(r,'[10/7/26, 3:52:56 AM] Fabio Nunes: Bom dia\n[10/7/26, 4:52:38 AM] Fabio Motorista: Saindo');
 const ok=await chamar(r.confirmar,escolha(p.body.token,[{indice:0,motorista_id:48,placa:'FKC2E12'},{indice:1,motorista_id:48,placa:'FKC2E12'}]));assert.equal(ok.code,200);assert.equal(b.salvos.size,2);assert.equal(b.checklists.size,1);assert.equal(ok.body.checklists_novos,1);
});
