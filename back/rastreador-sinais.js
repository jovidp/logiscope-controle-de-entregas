'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const qualidade = require('./gps-precisao');

// Somente leituras GPS, sem cookies ou credenciais. O arquivo fica pendente
// ate o banco confirmar o INSERT; uma queda ou reinicio permite repetir.
const DIRETORIO = path.join(__dirname, '..', 'backups', 'gps-pendentes');
function normalizar(pontos) {
  return pontos.filter(p => ['srf','t4s','sat'].includes(p.fonte)
    && Number.isSafeInteger(Number(p.device_id)) && Number(p.device_id)>0
    && /^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(p.placa)
    && !qualidade.motivoInvalido(p)).map(p => ({
    fonte:p.fonte, device_id:Number(p.device_id), placa:p.placa,
    lat:Number(p.lat), lng:Number(p.lng), velocidade:Number(p.velocidade),
    rumo:qualidade.numero(p.rumo) ? Math.round(Number(p.rumo)) : null,
    motor:p.motor == null ? null : String(p.motor),
    posicao_em:new Date(p.posicao_em).toISOString(),
  }));
}
async function inserir(db, pontos) {
  if (!pontos.length) return 0;
  const r = await db.query(`INSERT INTO rastreador_posicoes
    (fonte,device_id,placa,lat,lng,velocidade,rumo,motor,posicao_em)
    SELECT fonte,device_id,placa,lat,lng,velocidade,rumo,motor,posicao_em
    FROM jsonb_to_recordset($1::jsonb) AS p(fonte text,device_id int,placa text,
      lat float8,lng float8,velocidade numeric,rumo int,motor text,posicao_em timestamptz)
    ON CONFLICT (fonte,device_id,posicao_em) DO NOTHING`, [JSON.stringify(pontos)]);
  return r.rowCount || 0;
}
function criar({diretorio=DIRETORIO}={}) {
  let fila=Promise.resolve();
  const exclusivo=fn=>{const tarefa=fila.then(fn);fila=tarefa.catch(()=>{});return tarefa;};
  async function consumir(db, arquivo, pontos) {
    if(!pontos) {
      const conteudo=await fs.readFile(arquivo,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
      if(conteudo===null)return 0;
      pontos=JSON.parse(conteudo);
    }
    // Nao revalida a idade: uma leitura valida recebida antes da queda
    // deve ser preservada mesmo se o banco voltar dias depois.
    const inseridas=await inserir(db,pontos);
    await fs.unlink(arquivo).catch(e=>{if(e.code!=='ENOENT')throw e;});
    return inseridas;
  }
  const guardar=async(db,pontos)=>{
    const lista=normalizar(pontos);
    if(!lista.length)return 0;
    const conteudo=JSON.stringify(lista);
    const nome=crypto.createHash('sha256').update(conteudo).digest('hex')+'.json';
    await fs.mkdir(diretorio,{recursive:true});
    const arquivo=path.join(diretorio,nome);
    const temporario=arquivo+'.'+crypto.randomUUID()+'.tmp';
    try {
      await fs.writeFile(temporario,conteudo,{flag:'wx',flush:true});
      await fs.rename(temporario,arquivo);
    } finally {await fs.unlink(temporario).catch(e=>{if(e.code!=='ENOENT')throw e;});}
    // Salvar no disco nao espera a fila SQL: uma fonte lenta ou o banco
    // indisponivel nao podem deixar sinais de outras fontes so na memoria.
    return exclusivo(()=>consumir(db,arquivo,lista));
  };
  const drenar=db=>exclusivo(async()=>{
    const nomes=await fs.readdir(diretorio).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
    let inseridas=0;
    for(const nome of nomes.filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).slice(0,100)) {
      inseridas+=await consumir(db,path.join(diretorio,nome));
    }
    return inseridas;
  });
  return {guardar,drenar};
}
module.exports={criar,normalizar,inserir,DIRETORIO,padrao:criar()};
