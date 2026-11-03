'use strict';

function configurarBanco(env = process.env) {
  const connectionString = String(env.DATABASE_URL || '').trim();
  let url;
  if (connectionString) {
    try { url = new URL(connectionString); } catch { throw Error('DATABASE_URL inválida.'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw Error('DATABASE_URL precisa ser PostgreSQL.');
  }
  const host = url ? url.hostname : String(env.DB_HOST || '');
  const supabase = /(?:^|\.)supabase\.(?:co|com)$/i.test(host);
  const sslConfigurado = String(env.DB_SSL || '').toLowerCase();
  if (supabase && ['0','false','off','disable'].includes(sslConfigurado)) throw Error('A conexão com Supabase exige TLS.');
  const ssl = supabase || ['1','true','on','require','verify-full'].includes(sslConfigurado);
  if (url && ssl) {
    // Esses parâmetros do pg-connection-string substituem o objeto ssl.
    // A verificação do certificado deve permanecer ativa.
    for (const k of ['sslmode','sslcert','sslkey','sslrootcert']) url.searchParams.delete(k);
  }
  const config = url ? {connectionString:url.toString()} : {
    user:env.DB_USER,host:env.DB_HOST,database:env.DB_NAME,password:env.DB_PASSWORD,port:env.DB_PORT,
  };
  if (ssl) config.ssl = {rejectUnauthorized:true,
    ...(env.DB_SSL_CA ? {ca:String(env.DB_SSL_CA).replace(/\\n/g,'\n')} : {})};
  if (env.DB_SCHEMA) {
    if (!/^[a-z_][a-z0-9_]*$/.test(env.DB_SCHEMA)) throw Error('DB_SCHEMA inválido.');
    config.options = `-c search_path=${env.DB_SCHEMA},public`;
  }
  if (env.DB_POOL_MAX) {
    const max = Number(env.DB_POOL_MAX);
    if (!Number.isInteger(max) || max < 1 || max > 30) throw Error('DB_POOL_MAX precisa estar entre 1 e 30.');
    config.max = max;
  }
  return {...config,keepAlive:true,idleTimeoutMillis:30000,connectionTimeoutMillis:10000};
}
module.exports = {configurarBanco};
