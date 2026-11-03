'use strict';
// Preserva os parsers e a validacao ja usados em producao; sem credenciais.
const fs = require('node:fs');
const path = require('node:path');
const base = path.resolve(__dirname, '..');
const dir = path.join(base, 'supabase/functions/gps-coleta/vendor');
fs.mkdirSync(dir, { recursive: true });
const ler = nome => fs.readFileSync(path.join(base, 'back', nome), 'utf8');
const escrever = (nome, texto) => fs.writeFileSync(path.join(dir, nome), '// Gerado por tools/preparar-gps-vendor.cjs.\n' + texto);
let gps = ler('gps-precisao.js').replace(/module\.exports = (\{[^;]+\});/, 'export $1;');
escrever('gps-precisao.mjs', gps);
let api = ler('t4s-api.js').replace("const { coordenadaValida } = require('./gps-precisao');", "import { coordenadaValida } from './gps-precisao.mjs';\nimport { Buffer } from 'node:buffer';")
  .replace('env = process.env', 'env = {}')
  .replace(/module\.exports = \{[^;]+\};/, 'export { criar, campo, mapearPosicao, placaMercosul, erro };');
escrever('t4s-api.mjs', api);
const t4s = ler('rastreador-t4s.js');
escrever('t4s-parser.mjs', t4s.slice(t4s.indexOf('const LETRA_MERCOSUL'), t4s.indexOf('function erroSessao')) + '\nexport { lerLinha, lerDataT4s };\n');
const sat = ler('rastreador-satfleet.js');
escrever('sat-parser.mjs', sat.slice(sat.indexOf('const LETRA_MERCOSUL'), sat.indexOf('// O servidor da Sat')) + '\nexport { lerVeiculo };\n');
console.log('Parsers e validacao GPS preparados para a Edge Function.');
