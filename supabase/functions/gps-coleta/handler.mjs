import { criarPlataformas, normalizar } from './plataformas.mjs';
import { hash, cifrar, decifrar } from './banco.mjs';

const resposta = (dados, status=200) => new Response(JSON.stringify(dados), {status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
async function tokenValido(recebido,esperado) {
  if (!esperado || esperado.length < 32 || !recebido || recebido.length > 512) return false;
  return await hash(recebido) === await hash(`Bearer ${esperado}`);
}

export function criarHandler({env,banco,fetcher=fetch,agora=()=>Date.now()}) {
  return async req => {
    const leitura=req.method==='GET', coleta=req.method==='POST';
    if(!leitura && !coleta)return resposta({erro:'Metodo nao permitido'},405);
    if(!await tokenValido(req.headers.get('Authorization'),env[leitura?'GPS_LEITURA_TOKEN':'GPS_COLETA_TOKEN']))return resposta({erro:'Nao autorizado'},401);
    try {
      if(leitura) {
        const url=new URL(req.url);
        if(url.searchParams.get('status')==='1')return resposta({fontes:await banco.estado()});
        const em=url.searchParams.get('desde') || new Date(agora()-7*86400000).toISOString();
        const id=url.searchParams.get('id') || '0';
        // Preserva microssegundos do Postgres no cursor para nao perder paginas.
        if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(em)
          || !Number.isFinite(Date.parse(em)) || !/^\d{1,19}$/.test(id))return resposta({erro:'Cursor invalido'},400);
        const sinais=await banco.sinais(em,id);
        const ult=sinais.at(-1);
        return resposta({sinais,proximo:ult?{em:ult.criado_em,id:String(ult.id)}:{em,id}});
      }
      const dono=crypto.randomUUID();
      if(!await banco.rpc('gps_tentar_coleta',{p_dono:dono}))return resposta({ocupado:true});
      try {
        const sessoes={};
        for(const s of await banco.lerSessoes()) {
          const origem=env[s.fonte==='t4s'?'T4S_COOKIE':'SAT_COOKIE'] || '';
          if(s.origem_hash===await hash(origem))sessoes[s.fonte]={origem,cookie:await decifrar(s.cookie_cifrado,env.GPS_SESSAO_CHAVE)};
        }
        const plataformas=criarPlataformas({env,fetcher,sessoes,salvarSessao:async(fonte,v)=>banco.upsert('cloud_gps_sessoes',{
          fonte,cookie_cifrado:await cifrar(v.cookie,env.GPS_SESSAO_CHAVE),origem_hash:await hash(v.origem),atualizado_em:new Date(agora()).toISOString()})});
        const fontes=plataformas.configuradas();
        if(!fontes.length)return resposta({erro:'Nenhuma plataforma configurada'},503);
        const resultados=await Promise.all(fontes.map(async fonte=>{
          const tentativa_em=new Date(agora()).toISOString();
          try {
            const lista=await plataformas[fonte]();
            const validas=normalizar(lista,fonte,agora());
            const inseridas=await banco.rpc('gps_salvar_sinais',{p_fonte:fonte,p_lista:validas});
            await banco.upsert('cloud_gps_estado',{fonte,tentativa_em,sucesso_em:new Date(agora()).toISOString(),
              aparelhos:validas.length,rejeitados:lista.length-validas.length,erro:null});
            return {fonte,ok:true,aparelhos:validas.length,inseridas};
          } catch(e) {
            // Nenhum corpo remoto ou URL com credenciais e propagado.
            const erro=/HTTP \d{3}|sessao expirada|formato.*inesperado|login recusado|tabela.*encontrada/.exec(String(e.message))?.[0] || 'Falha na coleta ou persistencia';
            await banco.upsert('cloud_gps_estado',{fonte,tentativa_em,erro}).catch(()=>{});
            return {fonte,ok:false,erro};
          }
        }));
        return resposta({resultados},resultados.some(r=>r.ok)?200:503);
      } finally { await banco.rpc('gps_liberar_coleta',{p_dono:dono}).catch(()=>{}); }
    } catch(_) { return resposta({erro:'Falha ao acessar o banco da coleta'},503); }
  };
}
