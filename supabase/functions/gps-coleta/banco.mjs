export function criarBanco({ url, chave, fetcher = fetch }) {
  const chamar = async (caminho, opcoes = {}) => {
    const r = await fetcher(`${url}/rest/v1/${caminho}`, { ...opcoes, signal: AbortSignal.timeout(15000),
      headers: { apikey: chave, ...(chave.startsWith('sb_') ? {} : { Authorization: `Bearer ${chave}` }),
        'Content-Type': 'application/json', ...opcoes.headers } });
    if (!r.ok) throw new Error(`Banco Supabase: HTTP ${r.status}`);
    if(r.status===204 || opcoes.headers?.Prefer?.includes('return=minimal'))return null;
    const texto=await r.text();
    return texto?JSON.parse(texto):null;
  };
  return {
    rpc: (nome, corpo) => chamar(`rpc/${nome}`, { method: 'POST', body: JSON.stringify(corpo) }),
    lerSessoes: () => chamar('cloud_gps_sessoes?select=fonte,cookie_cifrado,origem_hash'),
    upsert: (tabela, corpo) => chamar(tabela, { method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(corpo) }),
    estado: () => chamar('cloud_gps_estado?select=fonte,tentativa_em,sucesso_em,aparelhos,rejeitados,erro&order=fonte'),
    sinais: async (em, id) => {
      const q = new URLSearchParams({ select: 'id,fonte,device_id,placa,nome,lat,lng,velocidade,rumo,motor,online,parado_seg,posicao_em,criado_em',
        order: 'criado_em.asc,id.asc', limit: '1000', or: `(criado_em.gt.${em},and(criado_em.eq.${em},id.gt.${id}))` });
      return chamar(`cloud_gps_posicoes?${q}`);
    },
  };
}

const encoder = new TextEncoder(), decoder = new TextDecoder();
export const hash = async texto => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(texto)))].map(b => b.toString(16).padStart(2,'0')).join('');
const chaveAes = async senha => crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encoder.encode(senha)), 'AES-GCM', false, ['encrypt','decrypt']);
export async function cifrar(texto, senha) {
  if (!senha || senha.length < 32) throw new Error('Chave de sessao nao configurada');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const corpo = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await chaveAes(senha),encoder.encode(texto)));
  return btoa(String.fromCharCode(...iv,...corpo));
}
export async function decifrar(texto, senha) {
  const bytes = Uint8Array.from(atob(texto),c=>c.charCodeAt(0));
  return decoder.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12)},await chaveAes(senha),bytes.slice(12)));
}
