import { criarBanco } from './banco.mjs';
import { criarHandler } from './handler.mjs';

const env = Deno.env.toObject();
let chave = env.SUPABASE_SERVICE_ROLE_KEY;
if (!chave && env.SUPABASE_SECRET_KEYS) chave = JSON.parse(env.SUPABASE_SECRET_KEYS).default;
if (!env.SUPABASE_URL || !chave) throw new Error('Configuracao interna Supabase indisponivel');
const banco = criarBanco({url:env.SUPABASE_URL,chave});
Deno.serve(criarHandler({env,banco}));
