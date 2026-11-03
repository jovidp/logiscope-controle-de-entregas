// Ajustes de aparelho e área de loja; consultas e gravações locais auditáveis.
'use strict';
const q = require('./gps-precisao');
const escolha = require('./rastreador-escolha');
const {randomUUID} = require('node:crypto');
const CHAVE = 'rastreador_areas_loja';
let cache;
async function lerAreas(db) {
  if(cache && Date.now()-cache.em<60000) return cache.valor;
  const r=await db.query('SELECT valor FROM sistema_config WHERE chave=$1',[CHAVE]);
  const valor=r.rows[0]?.valor || {};
  cache={em:Date.now(),valor};
  return valor;
}
function validarArea(b) {
  const lat=Number(b.lat),lng=Number(b.lng),entra=Number(b.raio_entrada_m),sai=Number(b.raio_saida_m);
  if(!q.coordenadaValida(b)) throw Object.assign(new Error('Informe coordenadas válidas para o ponto de descarga.'),{status:400});
  if(!q.numero(b.raio_entrada_m)||!q.numero(b.raio_saida_m)||entra<20||entra>1000||sai<=entra||sai>2000) throw Object.assign(new Error('Entrada: 20 a 1000 m. Saída: maior que a entrada, até 2000 m.'),{status:400});
  let poligono=null;
  if(b.poligono!=null) {
    if(!q.poligonoValido(b.poligono)) throw Object.assign(new Error('Desenhe uma área válida com pelo menos três pontos.'),{status:400});
    poligono=b.poligono.map(p=>p.map(Number));
    if(poligono.some(p=>q.distanciaM({lat,lng},{lat:p[0],lng:p[1]})>3000)) throw Object.assign(new Error('A área deve ficar a até 3 km do ponto de descarga.'),{status:400});
    if(!q.dentroPoligono({lat,lng},poligono) && q.distanciaBorda({lat,lng},poligono)>1) throw Object.assign(new Error('O ponto de descarga deve ficar dentro da área desenhada.'),{status:400});
  }
  return {lat,lng,raio_entrada_m:entra,raio_saida_m:sai,poligono,area_personalizada:true,perfil:["shopping","rua","padrao"].includes(b.perfil)?b.perfil:"padrao"};
}
function criarRotas({db,rastreador,registrarAuditoria,invalidarCache = () => {}}) {
  async function criarPonto(req,res) {
    try {
      const nome=String(req.body?.nome || '').trim();
      if(!nome || nome.length>120 || /[\x00-\x1f\x7f]/.test(nome))return res.status(400).json({error:'Informe um nome de 1 a 120 caracteres para o ponto.'});
      const area=validarArea(req.body || {});
      const existente=await db.query('SELECT codigo FROM loja_coordenadas WHERE LOWER(TRIM(nome))=LOWER($1) LIMIT 1',[nome]);
      if(existente.rows.length)return res.status(409).json({error:'Já existe um ponto com esse nome. Selecione-o na lista para ajustar.'});
      const codigo='PONTO_'+randomUUID();
      // Ponto e area sao criados na mesma instrucao: uma falha nao deixa cadastro parcial.
      await db.query(`WITH novo AS (
        INSERT INTO loja_coordenadas(codigo,nome,lat,lng,origem) VALUES($1,$2,$3,$4,'manual') RETURNING codigo
      ) INSERT INTO sistema_config(chave,valor,atualizado_em)
        SELECT $5,jsonb_build_object(novo.codigo,$6::jsonb),NOW() FROM novo
        ON CONFLICT(chave) DO UPDATE SET valor=sistema_config.valor || EXCLUDED.valor,atualizado_em=NOW()`,
        [codigo,nome,area.lat,area.lng,CHAVE,JSON.stringify(area)]);
      cache=null;rastreador.esquecerCoordenadas();invalidarCache();
      const lugar={codigo,nome,...area,origem:'manual',loja_cadastrada:false};
      await registrarAuditoria(req,'CRIAR_PONTO_GPS','loja_coordenadas',null,{codigo,nome,area});
      res.status(201).json({ok:true,codigo,lugar});
    }catch(e){res.status(e.status || 500).json({error:e.message});}
  }
  async function diagnostico(req,res) {
    try {
      await escolha.preferencias(db);
      const [areas,coords,aparelhos,intervalos]=await Promise.all([
        lerAreas(db),rastreador.coordenadas(db),
        db.query('SELECT fonte,device_id,nome,placa,lat,lng,velocidade,posicao_em FROM rastreador_aparelhos WHERE placa IS NOT NULL ORDER BY placa,fonte,device_id'),
        db.query(`WITH passos AS (
          SELECT fonte,device_id, EXTRACT(EPOCH FROM posicao_em-LAG(posicao_em) OVER(PARTITION BY fonte,device_id ORDER BY posicao_em)) AS segundos
          FROM rastreador_posicoes WHERE posicao_em>=NOW()-INTERVAL '24 hours'
        ) SELECT fonte,device_id,COUNT(*)::int AS amostras,
          ROUND(percentile_cont(0.5) WITHIN GROUP(ORDER BY segundos))::int AS intervalo_mediano_s,
          ROUND(percentile_cont(0.95) WITHIN GROUP(ORDER BY segundos))::int AS intervalo_p95_s
          FROM passos WHERE segundos>0 GROUP BY fonte,device_id`)
      ]);
      const gaps=new Map(intervalos.rows.map(a=>[a.fonte+':'+a.device_id,a]));
      const agora=Date.now();
      const lista=aparelhos.rows.map(a=>({...a,...gaps.get(a.fonte+':'+a.device_id),
        idade_s:a.posicao_em?Math.max(0,Math.round((agora-new Date(a.posicao_em))/1000)):null,
        bloqueada:escolha.ignoradas(a.placa).has(a.fonte),vinculo:escolha.vinculados(a.placa)[a.fonte] ?? null,
        validacao:q.motivoInvalido(a,{agora,maxIdadeMs:q.RECENTE_MS})}));
      res.json({gerado_em:new Date().toISOString(),idade_max_eventos_s:q.RECENTE_MS/1000,comparacao_max_s:q.SINCRONIA_MS/1000,
        aparelhos:lista,lugares:[...coords.values()],areas,rejeicoes:rastreador.diagnosticoGps()});
    } catch(e) {res.status(500).json({error:e.message});}
  }
  async function salvarArea(req,res) {
    try {
      const codigo=String(req.params.codigo || '').trim();
      const atual=await db.query('SELECT codigo FROM loja_coordenadas WHERE codigo=$1',[codigo]);
      if(!atual.rows.length) return res.status(404).json({error:'Loja não encontrada.'});
      const valor=req.body?.restaurar?null:validarArea(req.body || {});
      // Atualiza só esta loja, sem perder edições simultâneas das outras.
      await db.query(`INSERT INTO sistema_config(chave,valor,atualizado_em) VALUES($1,CASE WHEN $3::jsonb IS NULL THEN '{}'::jsonb ELSE jsonb_build_object($2::text,$3::jsonb) END,NOW())
        ON CONFLICT(chave) DO UPDATE SET valor=CASE WHEN $3::jsonb IS NULL THEN sistema_config.valor-$2::text ELSE jsonb_set(sistema_config.valor,ARRAY[$2::text],$3::jsonb) END,atualizado_em=NOW()`,[CHAVE,codigo,valor?JSON.stringify(valor):null]);
      cache=null;rastreador.esquecerCoordenadas();invalidarCache();
      await registrarAuditoria(req,'AJUSTAR_AREA_GPS','loja_coordenadas',null,{codigo,area:valor});
      res.json({ok:true});
    } catch(e) {res.status(e.status || 500).json({error:e.message});}
  }
  async function salvarAparelho(req,res) {
    try {
      const b=req.body || {}, placa=rastreador.placaMercosul(b.placa),fonte=String(b.fonte || '').toLowerCase();
      if(!/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(placa)||!['srf','t4s','sat'].includes(fonte)) return res.status(400).json({error:'Informe placa e plataforma válidas.'});
      const id=b.device_id===null?null:Number(b.device_id);
      if(id!==null) {
        if(!q.numero(b.device_id)||!Number.isSafeInteger(id)||id<1) return res.status(400).json({error:'Identificador do aparelho inválido.'});
        const r=await db.query('SELECT device_id FROM rastreador_aparelhos WHERE placa=$1 AND fonte=$2 AND device_id=$3',[placa,fonte,id]);
        if(!r.rows.length) return res.status(400).json({error:'Esse aparelho não está cadastrado nesta placa e plataforma.'});
      }
      await escolha.salvarVinculo(db,placa,fonte,id);invalidarCache();
      await registrarAuditoria(req,'VINCULAR_APARELHO_GPS','rastreador_aparelhos',id,{placa,fonte,device_id:id});
      res.json({ok:true});
    } catch(e) {res.status(500).json({error:e.message});}
  }
  async function bloquearFonte(req,res) {
    try {
      const b=req.body || {},placa=rastreador.placaMercosul(b.placa),fonte=String(b.fonte || '').toLowerCase();
      if(!/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(placa)||!['srf','t4s','sat'].includes(fonte)||typeof b.bloqueada!=='boolean') return res.status(400).json({error:'Placa, plataforma ou bloqueio inválido.'});
      await escolha.preferencias(db);
      const ignoradas=escolha.ignoradas(placa);
      if(b.bloqueada) ignoradas.add(fonte); else ignoradas.delete(fonte);
      await escolha.salvarIgnoradas(db,placa,[...ignoradas]);invalidarCache();
      await registrarAuditoria(req,'BLOQUEAR_FONTE_GPS','rastreador_aparelhos',null,{placa,fonte,bloqueada:b.bloqueada});
      res.json({ok:true});
    } catch(e) {res.status(500).json({error:e.message});}
  }
  return {diagnostico,criarPonto,salvarArea,salvarAparelho,bloquearFonte};
}
module.exports={lerAreas,validarArea,criarRotas};
