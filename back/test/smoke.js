#!/usr/bin/env node
// ============================================================================
// SMOKE TESTS — Controle de Entrega
// ----------------------------------------------------------------------------
// Verificacoes minimas, sem dependencias externas (usa fetch nativo do Node 18+).
// Cobre: configuracao de backup, autenticacao, PROTECAO DE ROTAS (perfil), e
// leitura basica de ocorrencias/TMS. Projetado para rodar LOCALMENTE e para
// PULAR com mensagem clara quando faltar servidor/credenciais — nunca depende
// de servicos externos impossiveis.
//
// Uso:
//   npm test                      -> checagens de backup + rotas (read-only/negativas)
//   BASE_URL=http://host:3000 npm test
//   SMOKE_USER=xxx SMOKE_PASS=yyy npm test   -> inclui fluxo autenticado (login, leitura)
//   SMOKE_WRITE=1 ...                        -> inclui criacao de ocorrencia avulsa (só com login)
//
// Saida: exit 0 se nada FALHOU (aprovados + pulados); exit 1 se houve falha real.
// ============================================================================

'use strict';

const path = require('path');
const fs = require('fs');

// Carrega variaveis do .env (dotenvx) de forma tolerante: valores em texto puro
// (ex.: PG_DUMP_PATH) sao lidos mesmo sem a chave de decriptacao.
try {
  require('@dotenvx/dotenvx').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });
} catch (_) {
  try { require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') }); } catch (_) {}
}

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT || 5000);

let passed = 0;
let failed = 0;
let skipped = 0;
const falhas = [];

function ok(nome) { passed += 1; console.log(`  ✓ ${nome}`); }
function fail(nome, detalhe) {
  failed += 1;
  falhas.push(`${nome}${detalhe ? ' — ' + detalhe : ''}`);
  console.log(`  ✗ ${nome}${detalhe ? ' — ' + detalhe : ''}`);
}
function skip(nome, motivo) { skipped += 1; console.log(`  ○ SKIP ${nome}${motivo ? ' — ' + motivo : ''}`); }

async function esperaOk(nome, condicao, detalhe) {
  if (condicao) ok(nome); else fail(nome, detalhe);
}

// fetch com timeout; devolve { erroRede: true } quando o servidor nao responde.
async function req(caminho, opcoes = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${BASE_URL}${caminho}`, { signal: ctrl.signal, ...opcoes });
    return resp;
  } catch (err) {
    return { erroRede: true, mensagem: err.message };
  } finally {
    clearTimeout(t);
  }
}

// ============================================================================
// 1) CONFIGURACAO DE BACKUP (pg_dump localizavel)  — Front 2
// ============================================================================
function resolverPgDump() {
  const configurado = String(process.env.PG_DUMP_PATH || '').trim();
  if (configurado && fs.existsSync(configurado)) return configurado;
  const bases = [process.env.ProgramFiles || 'C:\\Program Files', process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'];
  const cands = [];
  for (const base of bases) {
    const raiz = path.join(base, 'PostgreSQL');
    try {
      for (const v of fs.readdirSync(raiz)) {
        const exe = path.join(raiz, v, 'bin', 'pg_dump.exe');
        if (fs.existsSync(exe)) cands.push({ v: parseInt(v, 10) || 0, exe });
      }
    } catch (_) { /* ignora */ }
  }
  if (cands.length) { cands.sort((a, b) => b.v - a.v); return cands[0].exe; }
  return null; // nao localizado
}

function testarBackup() {
  console.log('\n[1] Configuracao de backup (Front 2)');
  const pgDump = resolverPgDump();
  if (!pgDump) {
    // Nao e falha "dura": em outra maquina o pg_dump pode estar so no PATH.
    skip('pg_dump localizavel', 'nao encontrado via PG_DUMP_PATH nem em Program Files\\PostgreSQL (verifique o PATH)');
    return;
  }
  ok(`pg_dump localizado (${pgDump === 'string' ? pgDump : path.basename(pgDump)})`);
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync(pgDump, ['--version'], { encoding: 'utf8', timeout: TIMEOUT_MS });
    esperaOk('pg_dump --version responde', r.status === 0 && /pg_dump/.test(r.stdout || ''), (r.stderr || '').slice(0, 120));
  } catch (err) {
    fail('pg_dump --version responde', err.message);
  }
}

// ============================================================================
// 2) ROTAS PUBLICAS + PROTECAO DE ROTAS (sem login)  — Front 1
// ============================================================================
async function testarRotas() {
  console.log('\n[2] Autenticacao e protecao de rotas (Front 1)');

  const health = await req('/health');
  if (health.erroRede) {
    skip('servidor acessivel', `${BASE_URL} nao respondeu (${health.mensagem}). Suba o servidor para os testes HTTP.`);
    return false;
  }
  esperaOk('GET /health -> 200 (publico)', health.status === 200);

  const status = await req('/auth/status');
  let body = {};
  try { body = await status.json(); } catch (_) {}
  esperaOk('GET /auth/status -> 200 (publico)', status.status === 200 && typeof body.possuiUsuarios === 'boolean');

  // Rotas de DADOS devem exigir login -> 401 sem cookie.
  const protegidas = ['/ocorrencias', '/docas', '/tms/viagens', '/roteiros', '/ocorrencias-avulsas', '/config/tolerancias'];
  for (const rota of protegidas) {
    const r = await req(rota);
    esperaOk(`GET ${rota} sem login -> 401`, r.status === 401, `recebido ${r.status}`);
  }

  // Rotas ADMINISTRATIVAS tambem exigem login -> 401 sem cookie.
  for (const rota of ['/auth/usuarios', '/auditoria']) {
    const r = await req(rota);
    esperaOk(`GET ${rota} sem login -> 401`, r.status === 401, `recebido ${r.status}`);
  }

  // Mutacao sem login deve ser negada (nao 200).
  const post = await req('/docas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  esperaOk('POST /docas sem login -> negado (401/403)', post.status === 401 || post.status === 403, `recebido ${post.status}`);

  // Mescla de rotas (ADM) tambem nao pode rodar sem login. 404 = ainda nao
  // implantado -> SKIP, nao falha.
  const mesclar = await req('/rotas/mesclar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (mesclar.status === 404) skip('POST /rotas/mesclar sem login -> negado', 'endpoint novo ainda nao implantado (reinicie o servidor)');
  else esperaOk('POST /rotas/mesclar sem login -> negado (401/403)', mesclar.status === 401 || mesclar.status === 403, `recebido ${mesclar.status}`);

  // Painel "Agora": endpoint novo. 401 = protegido e no ar; 404 = ainda nao
  // implantado (reinicie o servidor). Qualquer outro status e falha.
  const painel = await req('/painel/resumo');
  if (painel.status === 404) skip('GET /painel/resumo sem login -> 401', 'endpoint novo ainda nao implantado (reinicie o servidor)');
  else esperaOk('GET /painel/resumo sem login -> 401', painel.status === 401, `recebido ${painel.status}`);

  // Paineis novos (risco/OTIF/qualidade/digest/alertas/metas): protegidos -> 401
  // sem login. 404 = ainda nao implantado (reinicie o servidor) -> SKIP, nao falha.
  const paineisNovos = ['/painel/risco', '/painel/otif', '/painel/qualidade', '/painel/digest', '/alertas', '/metas-loja', '/rotas/uso'];
  for (const rota of paineisNovos) {
    const r = await req(rota);
    if (r.status === 404) skip(`GET ${rota} sem login -> 401`, 'endpoint novo ainda nao implantado (reinicie o servidor)');
    else esperaOk(`GET ${rota} sem login -> 401`, r.status === 401, `recebido ${r.status}`);
  }

  return true;
}

// ============================================================================
// 3) FLUXO AUTENTICADO (opcional): login, leitura de ocorrencias e TMS,
//    e prova de que OPERADOR nao acessa rota administrativa.  — Fronts 1/6
// ============================================================================
function extrairCookie(resp) {
  const sc = resp.headers.get('set-cookie') || '';
  const m = sc.match(/ce_sessao_h=[^;]+/);
  return m ? m[0] : '';
}

async function testarAutenticado() {
  console.log('\n[3] Fluxo autenticado (login + leitura)');
  const usuario = process.env.SMOKE_USER;
  const senha = process.env.SMOKE_PASS;
  if (!usuario || !senha) {
    skip('login e leitura autenticada', 'defina SMOKE_USER e SMOKE_PASS para habilitar');
    return;
  }

  const login = await req('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario, senha }),
  });
  if (login.erroRede) { skip('login', 'servidor indisponivel'); return; }
  if (login.status !== 200) { fail('POST /auth/login -> 200', `recebido ${login.status} (credenciais SMOKE_USER/PASS?)`); return; }
  ok('POST /auth/login -> 200');

  const cookie = extrairCookie(login);
  if (!cookie) { fail('cookie de sessao recebido', 'set-cookie ausente'); return; }
  ok('cookie de sessao recebido');
  const auth = { headers: { cookie, 'Content-Type': 'application/json' } };

  const me = await req('/auth/me', auth);
  let perfil = null;
  try { perfil = (await me.json()).perfil; } catch (_) {}
  esperaOk('GET /auth/me -> 200 autenticado', me.status === 200 && !!perfil, `recebido ${me.status}`);

  // Leitura/listagem de ocorrencias (Front 6).
  const oco = await req('/ocorrencias', auth);
  let ocoBody = null;
  try { ocoBody = await oco.json(); } catch (_) {}
  esperaOk('GET /ocorrencias autenticado -> 200 (lista)', oco.status === 200 && Array.isArray(ocoBody), `recebido ${oco.status}`);

  // Fluxo basico de TMS: listar viagens.
  const tms = await req('/tms/viagens', auth);
  let tmsBody = null;
  try { tmsBody = await tms.json(); } catch (_) {}
  esperaOk('GET /tms/viagens autenticado -> 200 (lista)', tms.status === 200 && Array.isArray(tmsBody), `recebido ${tms.status}`);

  // Paineis novos (leitura autenticada): 200 + forma esperada. 404 = ainda nao
  // implantado -> SKIP. Cada um confere um campo-chave do payload.
  const paineis = [
    { rota: '/painel/risco', campo: (b) => Array.isArray(b.itens) },
    { rota: '/painel/otif', campo: (b) => b.resumo && typeof b.resumo.total === 'number' },
    { rota: '/painel/qualidade', campo: (b) => Array.isArray(b.campos) && ('indice' in b) },
    { rota: '/painel/digest', campo: (b) => typeof b.texto === 'string' },
    { rota: '/alertas', campo: (b) => Array.isArray(b.alertas) && typeof b.nao_lidos === 'number' },
    { rota: '/metas-loja', campo: (b) => Array.isArray(b.metas) },
    { rota: '/rotas/uso', campo: (b) => Array.isArray(b.rotas) },
  ];
  for (const p of paineis) {
    const r = await req(p.rota, auth);
    if (r.status === 404) { skip(`GET ${p.rota} autenticado -> 200`, 'endpoint novo ainda nao implantado (reinicie o servidor)'); continue; }
    let body = null;
    try { body = await r.json(); } catch (_) {}
    esperaOk(`GET ${p.rota} autenticado -> 200 (forma ok)`, r.status === 200 && body && p.campo(body), `recebido ${r.status}`);
  }

  // Controle de perfil: OPERADOR nao acessa /auth/usuarios (403); ADM acessa (200).
  const usuarios = await req('/auth/usuarios', auth);
  if (perfil === 'ADM') {
    esperaOk('ADM: GET /auth/usuarios -> 200', usuarios.status === 200, `recebido ${usuarios.status}`);
  } else if (perfil === 'OPERADOR') {
    esperaOk('OPERADOR: GET /auth/usuarios -> 403 (bloqueado)', usuarios.status === 403, `recebido ${usuarios.status}`);
  } else {
    skip('controle de perfil em /auth/usuarios', 'perfil desconhecido');
  }

  // Criacao/listagem de ocorrencia — SO com SMOKE_WRITE=1 (evita poluir producao).
  if (process.env.SMOKE_WRITE === '1') {
    const marcador = `SMOKE-TEST ${new Date().toISOString()}`;
    const criar = await req('/ocorrencias-avulsas', {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify({
        data_ocorrencia: new Date().toISOString().slice(0, 10),
        descricao: marcador,
        escopo: 'GERAL',
        status: 'Aberta',
      }),
    });
    esperaOk('POST /ocorrencias-avulsas -> 200/201', criar.status === 200 || criar.status === 201, `recebido ${criar.status}`);
    const lista = await req('/ocorrencias-avulsas', auth);
    let listaBody = [];
    try { listaBody = await lista.json(); } catch (_) {}
    const achou = Array.isArray(listaBody) && listaBody.some((o) => o.descricao === marcador);
    esperaOk('ocorrencia criada aparece na listagem', achou);
  } else {
    skip('criacao de ocorrencia (POST)', 'defina SMOKE_WRITE=1 para habilitar (cria registro real)');
  }

  // Encerra a sessao de teste.
  await req('/auth/logout', { method: 'POST', headers: auth.headers });
}

// ============================================================================
(async function main() {
  console.log(`Smoke tests — alvo: ${BASE_URL}`);
  testarBackup();
  const servidorOk = await testarRotas();
  if (servidorOk) await testarAutenticado();
  else skip('fluxo autenticado', 'servidor indisponivel');

  console.log(`\nResumo: ${passed} aprovados, ${failed} falharam, ${skipped} pulados.`);
  if (failed > 0) {
    console.log('\nFalhas:');
    for (const f of falhas) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
})();
