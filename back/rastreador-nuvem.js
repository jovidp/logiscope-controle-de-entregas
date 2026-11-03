'use strict';
const sinaisGps=require('./rastreador-sinais');
const CHAVE='gps_nuvem_cursor';
function criar({db,rastreador,env=process.env,fetcher=fetch,agora=()=>Date.now()}) {
  const url=String(env.GPS_NUVEM_URL || '').replace(/\/+$/,'');
  const token=String(env.GPS_LEITURA_TOKEN || '');
  const configurado=()=>!!(url && token);
  const estado={configurado:configurado(),ultima_sincronizacao:null,sinais:0,erro:null};
  let pendente=null,timer=null;
  async function sincronizar() {
    if(!configurado())return {sinais:0};
    // Uma funcao com autenticacao propria e consultada; nenhuma chave admin
    // do Supabase precisa ficar no navegador ou no servidor local.
    const origem=new URL(url);
    if(origem.protocol!=='https:' || origem.username || origem.password || origem.search || origem.hash
      || origem.pathname!=='/functions/v1/gps-coleta')throw new Error('GPS_NUVEM_URL invalida');
    const cfg=await db.query('SELECT valor FROM sistema_config WHERE chave=$1',[CHAVE]);
    const anterior=cfg.rows[0]?.valor;
    const base=anterior?.url===url && anterior?.em?anterior:{em:new Date(agora()-7*86400000).toISOString(),id:'0'};
    // Sobreposicao reimporta transacoes que terminaram depois de outro lote.
    let cursor={em:new Date(Date.parse(base.em)-5*60000).toISOString(),id:'0'};
    let sinais=0,ultimaPagina=false,ultimo=base;
    for(let pagina=0;pagina<10;pagina++) {
      const endereco=new URL(url);endereco.search=new URLSearchParams({desde:cursor.em,id:String(cursor.id)}).toString();
      const r=await fetcher(endereco,{headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(20000)});
      if(!r.ok)throw new Error(`Sincronizacao GPS: HTTP ${r.status}`);
      const dados=await r.json();
      if(!Array.isArray(dados.sinais) || dados.sinais.length>1000 || !dados.proximo
        || !Number.isFinite(Date.parse(dados.proximo.em)) || !/^\d{1,19}$/.test(String(dados.proximo.id)))throw new Error('Resposta GPS da nuvem invalida');
      // Historico antigo tambem deve ser inserido. Nao aplica aqui o limite de
      // idade usado no sinal ao vivo; recuperacao de viagens usa esse historico.
      const validos=sinaisGps.normalizar(dados.sinais);
      if(validos.length!==dados.sinais.length)throw new Error('A nuvem retornou sinais GPS invalidos');
      sinais+=await sinaisGps.inserir(db,validos);
      const recentes=new Map();
      for(const p of dados.sinais) {
        const chave=p.fonte+':'+p.device_id,anteriorP=recentes.get(chave);
        if(!anteriorP || Date.parse(p.posicao_em)>Date.parse(anteriorP.posicao_em))recentes.set(chave,p);
      }
      for(const fonte of ['srf','t4s','sat']) {
        const lista=[...recentes.values()].filter(p=>p.fonte===fonte && agora()-Date.parse(p.posicao_em)<=86400000);
        if(lista.length)await rastreador.gravarAparelhos(db,fonte,lista);
      }
      // Checkpoint so depois de persistir TODO o lote. Retry e idempotente.
      if(dados.sinais.length) {
        const fim=dados.sinais.at(-1);
        if(fim.criado_em!==dados.proximo.em || String(fim.id)!==String(dados.proximo.id))throw new Error('Cursor GPS nao corresponde ao lote');
        if(dados.proximo.em>ultimo.em || (dados.proximo.em===ultimo.em && BigInt(dados.proximo.id)>BigInt(ultimo.id || '0'))) {
          ultimo={...dados.proximo};
          await db.query(`INSERT INTO sistema_config(chave,valor,atualizado_em) VALUES($1,$2,NOW())
            ON CONFLICT(chave) DO UPDATE SET valor=EXCLUDED.valor,atualizado_em=NOW()`,[CHAVE,JSON.stringify({...ultimo,url})]);
        }
      }
      cursor=dados.proximo;
      if(dados.sinais.length<1000){ultimaPagina=true;break;}
    }
    estado.ultima_sincronizacao=new Date(agora()).toISOString();estado.sinais=sinais;estado.erro=null;
    return {sinais,completo:ultimaPagina};
  }
  function rodar() {
    if(pendente)return pendente;
    pendente=sincronizar().catch(e=>{estado.erro=e.message;throw e;}).finally(()=>{pendente=null;});
    return pendente;
  }
  function iniciar() {
    if(!configurado() || timer)return;
    const executar=()=>rodar().catch(e=>console.error('[gps nuvem]',e.message));
    executar();timer=setInterval(executar,60000);timer.unref?.();
  }
  return {configurado,estado,sincronizar:rodar,iniciar,parar:()=>{clearInterval(timer);timer=null;}};
}
let instancia=null;
function iniciar(opcoes){if(!instancia){instancia=criar(opcoes);instancia.iniciar();}return instancia;}
module.exports={criar,iniciar,estado:()=>instancia?.estado || {configurado:false}};
