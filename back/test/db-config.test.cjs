'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {configurarBanco}=require('../db-config');
test('Banco local mantém parâmetros existentes e não exige TLS',()=>{
  const c=configurarBanco({DB_HOST:'localhost',DB_PORT:'5432',DB_NAME:'teste',DB_USER:'usuario',DB_PASSWORD:'teste'});
  assert.equal(c.host,'localhost');assert.equal(c.password,'teste');assert.equal(c.ssl,undefined);
});
test('Supabase verifica certificado e bloqueia tentativa de desligar TLS',()=>{
  const c=configurarBanco({DB_HOST:'aws-0-sa-east-1.pooler.supabase.com'});
  assert.equal(c.ssl.rejectUnauthorized,true);
  assert.throws(()=>configurarBanco({DB_HOST:'db.example.supabase.co',DB_SSL:'0'}),/TLS/);
});
test('Parâmetros da URL não substituem a verificação TLS',()=>{
  const c=configurarBanco({DATABASE_URL:'postgresql://usuario:teste@db.example.supabase.co/postgres?sslmode=no-verify'});
  assert.equal(c.ssl.rejectUnauthorized,true);assert.equal(new URL(c.connectionString).searchParams.has('sslmode'),false);
  assert.throws(()=>configurarBanco({DATABASE_URL:'https://example.com'}),/PostgreSQL/);
});
test('Schema, certificado e pool são configuráveis sem interpolação SQL livre',()=>{
  const c=configurarBanco({DB_SSL:'1',DB_SSL_CA:'linha1\\nlinha2',DB_SCHEMA:'controle_entrega',DB_POOL_MAX:'5'});
  assert.equal(c.ssl.ca,'linha1\nlinha2');assert.equal(c.options,'-c search_path=controle_entrega,public');assert.equal(c.max,5);
  assert.throws(()=>configurarBanco({DB_SCHEMA:'public; DROP TABLE usuarios'}),/DB_SCHEMA/);
  for(const DB_POOL_MAX of ['0','1.5','100'])assert.throws(()=>configurarBanco({DB_POOL_MAX}),/DB_POOL_MAX/);
});
