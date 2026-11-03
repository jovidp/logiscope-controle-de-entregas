'use strict';
const crypto=require('node:crypto'),zlib=require('node:zlib');
const MAX_ZIP=30*1024*1024,MAX_TOTAL=60*1024*1024,MAX_FILE=5*1024*1024,TTL=10*60000;
const erro=(msg,status=400)=>Object.assign(new Error(msg),{status});
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const normalizar=s=>String(s||'').normalize('NFD').replace(/\p{M}/gu,'').toUpperCase().replace(/\b(MOTORISTA|CARRETEIRO)\b/g,'').replace(/[^A-Z0-9]/g,'');
const placa=s=>String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
function dataValida(s){if(!/^\d{4}-\d{2}-\d{2}$/.test(s||''))return false;const d=new Date(s+'T12:00:00Z');return !isNaN(d)&&d.toISOString().slice(0,10)===s;}
function lerZip(buf){
 if(!Buffer.isBuffer(buf)||buf.length<22||buf.length>MAX_ZIP)throw erro('Envie um ZIP de até 30 MB.');
 let fim=-1;for(let i=buf.length-22;i>=Math.max(0,buf.length-65557);i--)if(buf.readUInt32LE(i)===0x06054b50&&i+22+buf.readUInt16LE(i+20)===buf.length){fim=i;break;}
 if(fim<0)throw erro('ZIP inválido ou incompleto.');
 const n=buf.readUInt16LE(fim+10),tam=buf.readUInt32LE(fim+12),inicio=buf.readUInt32LE(fim+16);
 if(buf.readUInt16LE(fim+4)||buf.readUInt16LE(fim+6)||n!==buf.readUInt16LE(fim+8)||n>1000||inicio+tam!==fim)throw erro('ZIP dividido, ZIP64 ou com muitas entradas não é suportado.');
 let pos=inicio,total=0;const entradas=[],nomes=new Set();
 for(let i=0;i<n;i++){
  if(pos+46>fim||buf.readUInt32LE(pos)!==0x02014b50)throw erro('Índice do ZIP inválido.');
  const flags=buf.readUInt16LE(pos+8),metodo=buf.readUInt16LE(pos+10),compacto=buf.readUInt32LE(pos+20),tamanho=buf.readUInt32LE(pos+24),nn=buf.readUInt16LE(pos+28),extra=buf.readUInt16LE(pos+30),coment=buf.readUInt16LE(pos+32),offset=buf.readUInt32LE(pos+42);
  if(pos+46+nn+extra+coment>fim)throw erro('Nome inválido no ZIP.');
  const nome=buf.subarray(pos+46,pos+46+nn).toString('utf8').replace(/\\/g,'/');
  if(!nome||nome.includes('\0')||nome.startsWith('/')||nome.includes(':')||nome.split('/').includes('..')||nomes.has(nome))throw erro('ZIP contém nomes repetidos ou caminhos inválidos.');
  nomes.add(nome);total+=tamanho;if(total>MAX_TOTAL)throw erro('O conteúdo descompactado ultrapassa 60 MB.');
  if(flags&1||![0,8].includes(metodo)||offset+30>inicio)throw erro('ZIP criptografado ou com compressão não suportada.');
  if((buf.readUInt32LE(pos+38)>>>16&0xf000)===0xa000)throw erro('Links dentro do ZIP não são aceitos.');
  if(!nome.endsWith('/')&&!nome.startsWith('__MACOSX/')&&/\.(txt|jpe?g|png)$/i.test(nome)){
   if(tamanho>MAX_FILE)throw erro('Cada texto ou foto deve ter até 5 MB.');
   if(buf.readUInt32LE(offset)!==0x04034b50||buf.readUInt16LE(offset+8)!==metodo||(buf.readUInt16LE(offset+6)&1))throw erro('Cabeçalho do arquivo no ZIP é inválido.');
   const localNome=buf.readUInt16LE(offset+26),localExtra=buf.readUInt16LE(offset+28),de=offset+30+localNome+localExtra;
   if(de>inicio||de+compacto>inicio||buf.subarray(offset+30,offset+30+localNome).toString('utf8').replace(/\\/g,'/')!==nome)throw erro('Arquivo ultrapassa os limites do ZIP.');
   const raw=buf.subarray(de,de+compacto);let dados;
   try{dados=metodo===0?Buffer.from(raw):zlib.inflateRawSync(raw,{maxOutputLength:Math.max(1,tamanho)});}catch{throw erro('Não foi possível descompactar o arquivo.');}
   if(dados.length!==tamanho||crc32(dados)!==buf.readUInt32LE(pos+16))throw erro('Arquivo corrompido dentro do ZIP.');
   entradas.push({nome,dados});
  }
  pos+=46+nn+extra+coment;
 }
 if(pos!==fim)throw erro('Índice do ZIP incompleto.');
 const textos=entradas.filter(e=>/\.txt$/i.test(e.nome));if(textos.length!==1)throw erro('O ZIP deve conter exatamente um texto de conversa (.txt).');
 return {texto:textos[0].dados.toString('utf8'),arquivos:entradas.filter(e=>/\.(jpe?g|png)$/i.test(e.nome))};
}
const crcTabela=Array.from({length:256},(_,n)=>{for(let j=0;j<8;j++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(b){let n=0xffffffff;for(const v of b)n=crcTabela[(n^v)&255]^(n>>>8);return (n^0xffffffff)>>>0;}
function mimeFoto(buf){if(buf.length>=3&&buf[0]===255&&buf[1]===216&&buf[2]===255)return 'image/jpeg';if(buf.length>=8&&buf.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';return null;}
function lerConversa(texto,ordem='dmy'){
 if(!['dmy','mdy'].includes(ordem))throw erro('Escolha dia/mês/ano ou mês/dia/ano.');
 if(Buffer.byteLength(texto)>MAX_FILE)throw erro('Texto de conversa muito grande.');
 const mensagens=[];let atual=null;
 for(const linhaOriginal of texto.split(/\r?\n/)){
  const linha=linhaOriginal.replace(/[\u200e\u200f\u202a-\u202e\ufeff]/g,'').replace(/[\u00a0\u202f]/g,' ');
  const m=linha.match(/^\[?(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?(?:\]\s*|\s+-\s+)(.*)$/i);
  if(!m){if(atual&&atual.corpo.length<10000)atual.corpo+='\n'+linha;continue;}
  const sep=m[8].indexOf(': ');if(sep<1){atual=null;continue;}
  const ano=+m[3]+(m[3].length===2?2000:0),mes=+(ordem==='dmy'?m[2]:m[1]),dia=+(ordem==='dmy'?m[1]:m[2]);
  const data=String(ano).padStart(4,'0')+'-'+String(mes).padStart(2,'0')+'-'+String(dia).padStart(2,'0');let h=+m[4];
  if(!dataValida(data)||+m[5]>59||+(m[6]||0)>59||(m[7]?(h<1||h>12):h>23))throw erro('Data ou horário inválido no texto. Confira o formato da data.');
  if(m[7])h=h%12+(m[7].toUpperCase()==='PM'?12:0);
  atual={data,hora:String(h).padStart(2,'0')+':'+m[5]+':'+(m[6]||'00'),remetente:m[8].slice(0,sep).trim().slice(0,150),corpo:m[8].slice(sep+2).slice(0,10000)};
  mensagens.push(atual);if(mensagens.length>20000)throw erro('Conversa com mais de 20 mil mensagens.');
 }
 if(!mensagens.length)throw erro('Nenhuma mensagem reconhecida. Exporte a conversa como texto do WhatsApp.');
 return mensagens;
}
function montarGrupos(mensagens,arquivos,data){
 const porNome=new Map();for(const f of arquivos){const base=f.nome.split('/').at(-1);if(porNome.has(base))throw erro('Fotos com o mesmo nome em pastas diferentes.');const mime=mimeFoto(f.dados);if(!mime)throw erro('Anexo não é uma foto JPEG ou PNG válida.');porNome.set(base,{...f,mime,sha:hash(f.dados)});}
 const grupos=new Map();
 for(const m of mensagens.filter(m=>m.data===data)){
  const refs=[...m.corpo.matchAll(/([^\s<>:]+\.(?:jpe?g|png))/gi)].map(x=>x[1]);
  const oculta=/<(?:imagem ocultada|mídia oculta|media omitted|image omitted)>/i.test(m.corpo);
  // A presença do remetente nas mensagens do dia é a regra de checklist definida pela operação.
  const chave=m.remetente.normalize('NFKC').toLocaleLowerCase('pt-BR');let g=grupos.get(chave);
  if(!g){g={indice:grupos.size,remetente:m.remetente,data,hora_inicio:m.hora,hora_fim:m.hora,mensagens:0,fotos_indicadas:0,fotos:[],placas:[]};grupos.set(chave,g);}
  g.hora_inicio=[g.hora_inicio,m.hora].sort()[0];g.hora_fim=[g.hora_fim,m.hora].sort().at(-1);g.mensagens++;if(oculta||refs.length)g.fotos_indicadas+=Math.max(1,refs.length);
  for(const ref of refs){const f=porNome.get(ref);if(f&&!g.fotos.some(x=>x.sha===f.sha))g.fotos.push(f);}
  for(const p of m.corpo.toUpperCase().match(/\b[A-Z]{3}[- ]?\d[A-Z0-9]\d{2}\b/g)||[])if(!g.placas.includes(placa(p)))g.placas.push(placa(p));
 }
 return [...grupos.values()];
}
async function garantirTabela(db){await db.query(`CREATE TABLE IF NOT EXISTS checklist_whatsapp_envios(
 id BIGSERIAL PRIMARY KEY,data DATE NOT NULL,remetente TEXT NOT NULL,remetente_chave TEXT NOT NULL,
 motorista_id INTEGER NOT NULL REFERENCES tms_motoristas(id),motorista TEXT NOT NULL,placa TEXT NOT NULL,
 viagem_id INTEGER,rota TEXT,hora_inicio TEXT NOT NULL,hora_fim TEXT NOT NULL,fotos_indicadas INTEGER NOT NULL,
 arquivo_sha TEXT NOT NULL,importado_por INTEGER,criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(data,remetente_chave,placa));
 CREATE TABLE IF NOT EXISTS checklist_whatsapp_fotos(id BIGSERIAL PRIMARY KEY,envio_id BIGINT NOT NULL REFERENCES checklist_whatsapp_envios(id) ON DELETE CASCADE,nome TEXT NOT NULL,mime TEXT NOT NULL,sha TEXT NOT NULL,dados BYTEA NOT NULL,UNIQUE(envio_id,sha));
 ALTER TABLE checklists_diarios ADD COLUMN IF NOT EXISTS origem TEXT;
 ALTER TABLE checklist_whatsapp_envios ADD COLUMN IF NOT EXISTS checklist_id BIGINT REFERENCES checklists_diarios(id) ON DELETE SET NULL;`);}
async function cadastros(db,data){const [m,v]=await Promise.all([
 db.query('SELECT id,nome FROM tms_motoristas WHERE ativo ORDER BY nome'),
 db.query(`SELECT v.id,COALESCE(v.motorista_nome,m.nome) motorista,COALESCE(v.placa,ve.placa) placa,COALESCE(v.rota_nome,r.nome) rota FROM tms_viagens v LEFT JOIN tms_motoristas m ON m.id=v.motorista_id LEFT JOIN tms_veiculos ve ON ve.id=v.veiculo_id LEFT JOIN tms_rotas r ON r.id=v.rota_id WHERE v.data_viagem=$1::date AND v.status<>'Cancelada' ORDER BY v.id`,[data])]);return {motoristas:m.rows,viagens:v.rows};}
function sugerirVinculo(g,cad){
 const primeiro=s=>normalizar(String(s||'').trim().split(/\s+/)[0]);
 const exatos=cad.motoristas.filter(m=>normalizar(m.nome)===normalizar(g.remetente));
 const candidatos=exatos.length?exatos:cad.motoristas.filter(m=>primeiro(m.nome)===primeiro(g.remetente));
 const m=candidatos.length===1?candidatos[0]:null;
 const viagens=m?cad.viagens.filter(v=>normalizar(v.motorista)===normalizar(m.nome)):[];
 return {motorista_sugerido:m?.id||null,sugestoes:candidatos.map(m=>m.id),criterio_vinculo:exatos.length?'nome completo':'primeiro nome',viagem_sugerida:viagens.length===1?viagens[0].id:null};
}
async function registrarChecklist(cliente,{g,m,pl,v},data){
 // Serializa reimportações e nomes diferentes do mesmo motorista/veículo no dia.
 await cliente.query('SELECT pg_advisory_xact_lock(hashtext($1))',[data+'|'+pl]);
 const existentes=(await cliente.query("SELECT id,motorista FROM checklists_diarios WHERE data=$1 AND UPPER(REGEXP_REPLACE(placa,'[^A-Za-z0-9]','','g'))=$2 FOR UPDATE",[data,pl])).rows;
 const existente=existentes.find(c=>normalizar(c.motorista)===normalizar(m.nome));
 if(existente)return {id:existente.id,novo:false};
 const obs='Checklist realizado via grupo de WhatsApp: '+g.remetente+' enviou mensagem em '+data+' às '+g.hora_inicio+'. Placa e rota cruzadas com a viagem '+v.id+' do TMS.';
 for(let i=0;i<5;i++){
  const id=crypto.randomInt(1,2147483647);
  const r=await cliente.query("INSERT INTO checklists_diarios(id,data,motorista,placa,rota,itens,total_itens,obs,origem) VALUES($1,$2,$3,$4,$5,'[]'::jsonb,0,$6,'whatsapp') ON CONFLICT(id) DO NOTHING RETURNING id",[id,data,m.nome,pl,v.rota,obs]);
  if(r.rows.length)return {id:r.rows[0].id,novo:true};
 }
 throw erro('Não foi possível gerar o registro. Tente novamente.',409);
}
function criarRotas({db,registrarAuditoria=async()=>{}}){
 const previews=new Map();const limpar=()=>{for(const [k,v]of previews)if(Date.now()-v.em>TTL&&!v.emUso)previews.delete(k);};
 const dono=req=>String(req.usuarioLogado?.id||'');
 const obter=req=>{limpar();const p=previews.get(req.params.token||req.body?.token);if(!p||p.dono!==dono(req))throw erro('Prévia expirou ou não pertence à sua sessão. Leia o arquivo novamente.',404);return p;};
 const tratar=(fn)=>async(req,res)=>{try{await fn(req,res);}catch(e){res.status(e.status||500).json({error:e.status?e.message:'Não foi possível processar a importação.'});if(!e.status)console.error('[checklist whatsapp]',e.message);}};
 const previa=tratar(async(req,res)=>{
  const data=req.query.data,ordem=req.query.ordem||'dmy';if(!dataValida(data))throw erro('Escolha o dia do checklist.');
  const zip=lerZip(req.body),mensagens=lerConversa(zip.texto,ordem),grupos=montarGrupos(mensagens,zip.arquivos,data),cad=await cadastros(db,data);
  if(!grupos.length)throw erro('Nenhuma mensagem com remetente neste dia. Confira o dia e o formato das datas.');
  limpar();for(const [k,p]of previews)if(p.dono===dono(req)&&!p.emUso)previews.delete(k);
  let bytes=[...previews.values()].reduce((s,p)=>s+p.bytes,0);const novosBytes=zip.arquivos.reduce((s,f)=>s+f.dados.length,0);if(bytes+novosBytes>100*1024*1024||previews.size>=8)throw erro('Há outras importações em conferência. Tente novamente em alguns minutos.',429);
  const token=crypto.randomBytes(24).toString('hex');previews.set(token,{dono:dono(req),em:Date.now(),grupos,bytes:novosBytes,arquivo_sha:hash(req.body),cad,data});
  res.json({token,data,ordem,expires_in_s:TTL/1000,...cad,dias:[...new Set(mensagens.map(m=>m.data))].sort(),grupos:grupos.map(g=>{
   return {...g,fotos:g.fotos.map((f,i)=>({nome:f.nome.split('/').at(-1),url:'/checklists-diarios/whatsapp/previa/'+token+'/foto/'+g.indice+'/'+i})),...sugerirVinculo(g,cad)};
  })});
 });
 const fotoPrevia=tratar(async(req,res)=>{const p=obter(req),f=p.grupos[Number(req.params.grupo)]?.fotos[Number(req.params.foto)];if(!f)throw erro('Foto não encontrada.',404);res.set({'Content-Type':f.mime,'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'}).send(f.dados);});
 const confirmar=tratar(async(req,res)=>{
  const p=obter(req);if(p.emUso)throw erro('Importação em andamento.',409);
  const selecoes=req.body?.selecoes;if(!Array.isArray(selecoes)||!selecoes.length||selecoes.length>p.grupos.length)throw erro('Selecione pelo menos um envio.');
  p.emUso=true;let cliente;try{
  const cad=await cadastros(db,p.data),vistos=new Set();const escolhidos=selecoes.map(s=>{
   if(!Number.isInteger(s.indice)||vistos.has(s.indice))throw erro('Seleção inválida ou repetida.');vistos.add(s.indice);
   const g=p.grupos[s.indice],m=cad.motoristas.find(m=>m.id===Number(s.motorista_id)),pl=placa(s.placa);if(!g||!m||!/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(pl))throw erro('Confira motorista e placa de cada envio.');
   const viagens=cad.viagens.filter(v=>normalizar(v.motorista)===normalizar(m.nome)&&placa(v.placa)===pl&&(s.viagem_id==null||v.id===Number(s.viagem_id)));if(viagens.length!==1)throw erro('Motorista e placa precisam corresponder a uma única viagem prevista neste dia.');return {g,m,pl,v:viagens[0]};
  });
   cliente=await db.connect();await cliente.query('BEGIN');let novos=0,atualizados=0,checklists_novos=0;const ids=[],checklist_ids=[];
   for(const {g,m,pl,v}of escolhidos){
    const remetenteChave=hash(g.remetente.normalize('NFKC').toLocaleLowerCase('pt-BR'));
    const anterior=(await cliente.query('SELECT id,motorista_id FROM checklist_whatsapp_envios WHERE data=$1 AND remetente_chave=$2 AND placa=$3 FOR UPDATE',[p.data,remetenteChave,pl])).rows[0];
    if(anterior&&anterior.motorista_id!==m.id)throw erro('Este remetente e veículo já estão vinculados a outro motorista. Confira o registro.',409);
    const r=await cliente.query(`INSERT INTO checklist_whatsapp_envios(data,remetente,remetente_chave,motorista_id,motorista,placa,viagem_id,rota,hora_inicio,hora_fim,fotos_indicadas,arquivo_sha,importado_por) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT(data,remetente_chave,placa) DO UPDATE SET hora_inicio=LEAST(checklist_whatsapp_envios.hora_inicio,EXCLUDED.hora_inicio),hora_fim=GREATEST(checklist_whatsapp_envios.hora_fim,EXCLUDED.hora_fim),fotos_indicadas=GREATEST(checklist_whatsapp_envios.fotos_indicadas,EXCLUDED.fotos_indicadas),atualizado_em=NOW() WHERE checklist_whatsapp_envios.motorista_id=EXCLUDED.motorista_id RETURNING id`,[p.data,g.remetente,remetenteChave,m.id,m.nome,pl,v.id,v.rota,g.hora_inicio,g.hora_fim,g.fotos_indicadas,p.arquivo_sha,req.usuarioLogado.id]);
    if(!r.rows.length)throw erro('Conflito de vínculo: confira o motorista.',409);const id=r.rows[0].id;ids.push(id);anterior?atualizados++:novos++;
    const checklist=await registrarChecklist(cliente,{g,m,pl,v},p.data);checklist_ids.push(checklist.id);if(checklist.novo)checklists_novos++;
    await cliente.query('UPDATE checklist_whatsapp_envios SET checklist_id=$1 WHERE id=$2',[checklist.id,id]);
    for(const f of g.fotos)await cliente.query('INSERT INTO checklist_whatsapp_fotos(envio_id,nome,mime,sha,dados) VALUES($1,$2,$3,$4,$5) ON CONFLICT(envio_id,sha) DO NOTHING',[id,f.nome.split('/').at(-1),f.mime,f.sha,f.dados]);
   }
   await cliente.query('COMMIT');previews.delete(req.body.token);
   try{await registrarAuditoria(req,'IMPORTAR_ENVIOS_CHECKLIST_WHATSAPP','checklists_diarios',null,{data:p.data,ids,checklist_ids,checklists_novos,novos,atualizados,arquivo_sha:p.arquivo_sha});}catch(e){console.error('[checklist whatsapp auditoria]',e.message);}
   res.json({novos,atualizados,ids,checklists_novos,checklist_ids:[...new Set(checklist_ids)]});
  }catch(e){if(cliente)await cliente.query('ROLLBACK');throw e;}finally{cliente?.release();p.emUso=false;}
 });
 const listar=tratar(async(req,res)=>{
  if(!dataValida(req.query.data))throw erro('Escolha uma data válida.');
  const r=await db.query(`SELECT e.id,to_char(e.data,'YYYY-MM-DD') data,e.remetente,e.motorista,e.placa,e.rota,e.hora_inicio,e.hora_fim,e.fotos_indicadas,c.id IS NOT NULL checklist_realizado,COALESCE(json_agg(json_build_object('id',f.id,'nome',f.nome) ORDER BY f.id) FILTER(WHERE f.id IS NOT NULL),'[]'::json) fotos FROM checklist_whatsapp_envios e LEFT JOIN checklists_diarios c ON c.id=e.checklist_id LEFT JOIN checklist_whatsapp_fotos f ON f.envio_id=e.id WHERE e.data=$1::date GROUP BY e.id,c.id ORDER BY e.hora_inicio,e.id`,[req.query.data]);res.json(r.rows);
 });
 const foto=tratar(async(req,res)=>{if(!/^\d+$/.test(req.params.id))throw erro('Foto inválida.');const f=(await db.query('SELECT mime,dados FROM checklist_whatsapp_fotos WHERE id=$1',[req.params.id])).rows[0];if(!f)throw erro('Foto não encontrada.',404);res.set({'Content-Type':f.mime,'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'}).send(f.dados);});
 return {previa,confirmar,listar,fotoPrevia,foto};
}
function rotaPermitida(req,somenteLeitura=false){
 if(req.method==='GET')return /^\/checklists-diarios\/whatsapp\/(envios|fotos\/\d+|previa\/[a-f0-9]{48}\/foto\/\d+\/\d+)$/.test(req.path);
 return !somenteLeitura&&req.method==='POST'&&/^\/checklists-diarios\/whatsapp\/(previa|confirmar)$/.test(req.path);
}
module.exports={lerZip,lerConversa,montarGrupos,normalizar,crc32,garantirTabela,criarRotas,rotaPermitida,sugerirVinculo};