'use strict';
// Preparar/implantar somente no novo projeto autorizado, sem imprimir segredos.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const raiz=path.resolve(__dirname,'..');
const PROJETO='seuprojetosupabase';
const URL=`https://${PROJETO}.supabase.co/functions/v1/gps-coleta`;
const arquivo=path.join(raiz,'.env.gps-cloud');
process.chdir(raiz);
require('@dotenvx/dotenvx').config({quiet:true,override:true});
const chave=()=>crypto.createHash('sha256').update('gps-supabase|').update(fs.readFileSync(path.join(raiz,'.env.keys'))).digest();
function guardar(v) {
  const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',chave(),iv);
  const corpo=Buffer.concat([c.update(JSON.stringify(v),'utf8'),c.final()]);
  fs.writeFileSync(arquivo,JSON.stringify({iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),corpo:corpo.toString('base64')}));
}
function ler() {
  const j=JSON.parse(fs.readFileSync(arquivo,'utf8'));
  const d=crypto.createDecipheriv('aes-256-gcm',chave(),Buffer.from(j.iv,'base64'));d.setAuthTag(Buffer.from(j.tag,'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(j.corpo,'base64')),d.final()]).toString('utf8'));
}
async function preparar() {
  const anteriores=fs.existsSync(arquivo)?ler():{};
  const env={};
  for(const n of ['SRF_URL','SRF_EMAIL','SRF_SENHA','T4S_URL','T4S_COOKIE','T4S_CLIENT_KEY','T4S_CLIENT_SECRET','T4S_AUTH_URL','T4S_API_URL','SAT_URL','SAT_COOKIE']) {
    if(process.env[n])env[n]=process.env[n];
  }
  for(const n of ['GPS_COLETA_TOKEN','GPS_LEITURA_TOKEN','GPS_SESSAO_CHAVE'])env[n]=anteriores.env?.[n] || crypto.randomBytes(32).toString('hex');
  const db=require('../back/db');
  try {
    // A sessao mais recente pode ter sido renovada desde o .env.
    for(const [fonte,nome] of [['t4s','T4S_COOKIE'],['sat','SAT_COOKIE']]) {
      const r=await db.query('SELECT valor FROM sistema_config WHERE chave=$1',[`${fonte}_sessao`]);
      const v=r.rows[0]?.valor;
      const hash=crypto.createHash('sha256').update(String(process.env[nome] || '').trim()).digest('hex').slice(0,16);
      if(!v?.cookie || v.env!==hash)continue;
      const b=Buffer.from(v.cookie,'base64');
      const k=crypto.createHash('sha256').update(`${fonte}-sessao|${process.env.DB_PASSWORD || ''}|${process.env.SRF_SENHA || ''}`).digest();
      const d=crypto.createDecipheriv('aes-256-gcm',k,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));
      env[nome]=Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8');
    }
  } finally {await db.pool.end();}
  guardar({projeto:PROJETO,url:URL,env,preparado_em:new Date().toISOString()});
  console.log('Credenciais preparadas em arquivo cifrado. Projeto: '+PROJETO);
  console.log('Fontes: '+['SRF_EMAIL','T4S_COOKIE','T4S_CLIENT_KEY','SAT_COOKIE'].filter(n=>env[n]).join(', '));
}
function encontrarCli() {
  const cache=path.join(process.env.LOCALAPPDATA,'npm-cache','_npx');
  for(const pasta of fs.readdirSync(cache)) {
    const base=path.join(cache,pasta,'node_modules');
    const pacote=path.join(base,'supabase','package.json');
    if(!fs.existsSync(pacote) || JSON.parse(fs.readFileSync(pacote,'utf8')).version!=='2.120.0')continue;
    const exe=path.join(base,'@supabase','cli-windows-x64','bin','supabase.exe');
    if(fs.existsSync(exe))return exe;
  }
  throw new Error('Instale a CLI: npx.cmd --yes supabase@2.120.0 --version');
}
function tokenAcesso() {
  const acesso=path.join(raiz,'.env.gps-acesso');
  const token=fs.existsSync(acesso)?require('dotenv').parse(fs.readFileSync(acesso)).SUPABASE_ACCESS_TOKEN:null;
  return token || process.env.SUPABASE_ACCESS_TOKEN || null;
}
function cli(args) {
  const profile=process.env.GPS_SUPABASE_PROFILE;
  const token=tokenAcesso();
  const r=spawnSync(encontrarCli(),[...args,...(profile?['--profile',profile]:[])],{cwd:raiz,encoding:'utf8',windowsHide:true,
    env:{...process.env,...(token?{SUPABASE_ACCESS_TOKEN:token}:{})}});
  if(r.error || r.status!==0)throw new Error(`Supabase CLI: falhou ${args.slice(0,2).join(' ')} (codigo ${r.status ?? 'execucao'}). Nenhum segredo exibido.`);
  return r.stdout;
}
async function conferirAcesso() {
  const token=tokenAcesso();
  if(token) {
    // Token limitado ao projeto nao precisa de Projects (account-wide).
    const r=await fetch(`https://api.supabase.com/v1/projects/${PROJETO}`,{
      headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw new Error(`Token sem acesso ao novo projeto (HTTP ${r.status}). Confira Project Settings Read e o projeto selecionado.`);
    const projeto=await r.json();
    if(projeto.id!==PROJETO)throw new Error('A API retornou outro projeto');
    if(projeto.status!=='ACTIVE_HEALTHY')throw new Error('O novo projeto ainda nao esta saudavel: '+projeto.status);
    return;
  }
  const dados=JSON.parse(cli(['projects','list','--output-format','json']));
  if(!dados.projects?.some(p=>p.id===PROJETO))throw new Error(`A conta da CLI nao tem acesso ao projeto ${PROJETO}. Autentique a conta correta antes de implantar.`);
}
async function executarSql(sql) {
  const token=tokenAcesso();
  if(token) {
    // API HTTPS: funciona mesmo quando a rede local nao tem IPv6.
    const r=await fetch(`https://api.supabase.com/v1/projects/${PROJETO}/database/query`,{
      method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({query:sql}),signal:AbortSignal.timeout(60000)});
    const j=await r.json();
    if(!r.ok) {
      const mensagem=String(j.message || j.error || 'SQL recusado').replaceAll(token,'[token omitido]').replace(/\b[0-9a-f]{64}\b/gi,'[segredo omitido]');
      throw new Error(`API SQL: HTTP ${r.status}: ${mensagem}`);
    }
    return {rows:Array.isArray(j)?j:(j.rows || j.result || [])};
  }
  return JSON.parse(cli(['db','query','--linked','--project-ref',PROJETO,'--output-format','json',sql]));
}
async function verificar(v) {
  const h={Authorization:`Bearer ${v.env.GPS_COLETA_TOKEN}`};
  const r=await fetch(v.url,{method:'POST',headers:h,signal:AbortSignal.timeout(90000)});
  const j=await r.json();
  if(j.resultados)console.log('Resultado das fontes: '+JSON.stringify(j.resultados));
  if(!r.ok || !j.resultados?.length || j.resultados.some(x=>!x.ok))throw new Error('A coleta real nao passou em todas as fontes. O agendamento nao sera ativado. Confira cloud_gps_estado e logs.');
  console.log('Coleta real validada: '+j.resultados.map(x=>`${x.fonte}=${x.aparelhos}`).join(', '));
  const leitura=await fetch(v.url+'?status=1',{headers:{Authorization:`Bearer ${v.env.GPS_LEITURA_TOKEN}`},signal:AbortSignal.timeout(15000)});
  if(!leitura.ok)throw new Error('Falha na verificacao da leitura protegida');
  const semToken=await fetch(v.url+'?status=1',{signal:AbortSignal.timeout(15000)});
  if(semToken.status!==401)throw new Error('Verificacao de autenticacao falhou');
  return j;
}
function agendamento(v) {
  return `DO $gps$ DECLARE segredo UUID; BEGIN
    SELECT id INTO segredo FROM vault.secrets WHERE name='gps_coleta_token';
    IF segredo IS NULL THEN PERFORM vault.create_secret('${v.env.GPS_COLETA_TOKEN}','gps_coleta_token');
    ELSE PERFORM vault.update_secret(segredo,'${v.env.GPS_COLETA_TOKEN}'); END IF;
  END $gps$;
  SELECT cron.schedule('gps-coleta-30s','30 seconds',
  $job$ SELECT net.http_post(url:='${v.url}',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' ||
      (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='gps_coleta_token')),
    body:='{}'::jsonb,timeout_milliseconds:=90000); $job$);`;
}
async function implantar() {
  // Antes de ler/exportar as credenciais, confirma conta e destino.
  await conferirAcesso();
  const v=ler();if(v.projeto!==PROJETO || v.url!==URL)throw new Error('Pacote pertence a outro projeto');
  const pasta=fs.mkdtempSync(path.join(raiz,'supabase','.gps-deploy-'));
  const envFile=path.join(pasta,'.env'),sqlFile=path.join(pasta,'schedule.sql');
  try {
    const migrations=fs.readdirSync(path.join(raiz,'supabase','migrations')).filter(n=>n.endsWith('_gps_coleta_nuvem.sql'));
    if(migrations.length!==1)throw new Error('Schema GPS nao encontrado');
    const pre=await executarSql("SELECT to_regclass('public.cloud_gps_posicoes') IS NOT NULL AS preparado");
    const rows=pre.rows || pre.result || pre;
    if(!Array.isArray(rows) || !rows[0]?.preparado)await executarSql(fs.readFileSync(path.join(raiz,'supabase','migrations',migrations[0]),'utf8'));
    fs.writeFileSync(envFile,Object.entries(v.env).map(([n,x])=>`${n}=${JSON.stringify(x)}`).join('\n')+'\n');
    cli(['secrets','set','--project-ref',PROJETO,'--env-file',envFile]);
    cli(['functions','deploy','gps-coleta','--project-ref',PROJETO,'--use-api','--no-verify-jwt']);
    await verificar(v);
    fs.writeFileSync(sqlFile,agendamento(v));
    await executarSql(fs.readFileSync(sqlFile,'utf8'));
    console.log('Coleta agendada no Supabase a cada 30 segundos. Retencao na nuvem: 7 dias.');
  } finally {
    // Remove somente os arquivos temporarios dentro do diretorio criado aqui.
    for(const f of [envFile,sqlFile])if(fs.existsSync(f))fs.unlinkSync(f);
    fs.rmdirSync(pasta);
  }
}
async function ativarLocal() {
  const v=ler();await verificar(v);
  // Altera o .env usando a cifragem dotenvx ja adotada, sem valor na linha de comando.
  const dotenvx=require('@dotenvx/dotenvx');
  if(typeof dotenvx.set!=='function')throw new Error('dotenvx.set indisponivel; configure GPS_NUVEM_URL e GPS_LEITURA_TOKEN pelo procedimento cifrado habitual.');
  const config={path:'.env',encrypt:true,quiet:true};
  const r1=dotenvx.set('GPS_NUVEM_URL',v.url,config);
  const r2=dotenvx.set('GPS_LEITURA_TOKEN',v.env.GPS_LEITURA_TOKEN,config);
  if([...r1.processedEnvs,...r2.processedEnvs].some(r=>r.error))throw new Error('Falha ao salvar configuracao local cifrada');
  console.log('Configuracao local cifrada pronta. Reinicie pelo procedimento habitual para ativar a sincronizacao.');
}
async function testarPlataformas() {
  const {criarPlataformas,normalizar}=await import('../supabase/functions/gps-coleta/plataformas.mjs');
  const v=ler(),plataformas=criarPlataformas({env:v.env});
  const resultados=await Promise.all(plataformas.configuradas().map(async fonte=>{
    try {const lista=await plataformas[fonte]();const validas=normalizar(lista,fonte);return {fonte,ok:true,aparelhos:lista.length,sinais_validos:validas.length};}
    catch(_){return {fonte,ok:false,erro:'Nao foi possivel consultar a plataforma'};}
  }));
  console.log(JSON.stringify({validacao_local:resultados}));
  if(resultados.some(r=>!r.ok))process.exitCode=1;
}
async function main() {
  const acao=process.argv[2];
  if(acao==='prepare')await preparar();
  else if(acao==='deploy')await implantar();
  else if(acao==='verify')await verificar(ler());
  else if(acao==='activate-local')await ativarLocal();
  else if(acao==='test-platforms')await testarPlataformas();
  else throw new Error('Uso: node tools/gps-supabase.cjs prepare|deploy|verify|activate-local|test-platforms');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
