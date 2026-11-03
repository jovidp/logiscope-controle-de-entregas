const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = process.env.CE_TEST_ROOT || path.resolve(__dirname, '../..');
const { validar, montar, tempoTrecho, paradaDe } = require(path.join(ROOT, 'back/frota-calcular-rota'));

// Tempos de mentira no formato do previsao-tms.carregarTempos.
const t = {
  trecho: new Map([['FABRICA|375', 106]]),
  descarga: new Map([['375', 37]]),
  descargaGeral: 30,
  kmPorMin: 0.5,
  kmPorMinFaixa: [0.2, 0.4, 0.6, 0.9], // 12, 24, 36, 54 km/h
};

test('Valida o pedido e normaliza placa, destinos e parada', () => {
  const e = validar({ origem: { tipo: 'placa', placa: 'fkb-1d11' }, destinos: [{ tipo: 'lugar', codigo: ' 375 ' }, { tipo: 'll', lat: '-22.9', lng: '-43.2', rotulo: 'X', parada_min: '15' }], otimizar: 1, saida: '06:30' });
  assert.deepEqual(e.origem, { tipo: 'placa', placa: 'FKB1D11' });
  assert.deepEqual(e.destinos, [{ tipo: 'lugar', codigo: '375', parada_min: null }, { tipo: 'll', lat: -22.9, lng: -43.2, rotulo: 'X', parada_min: 15 }]);
  assert.equal(e.otimizar, true); assert.equal(e.voltar, false); assert.equal(e.saida, 390);
  const ruim = (b, re) => assert.throws(() => validar(b), re);
  ruim({ origem: { tipo: 'lugar', codigo: 'FABRICA' }, destinos: [] }, /pelo menos um destino/);
  ruim({ origem: { tipo: 'lugar', codigo: 'FABRICA' }, destinos: Array(26).fill({ tipo: 'lugar', codigo: '1' }) }, /25/);
  ruim({ origem: { tipo: 'lugar', codigo: 'FABRICA' }, destinos: [{ tipo: 'll', lat: 0, lng: 0 }] }, /coordenadas/);
  ruim({ origem: { tipo: 'lugar', codigo: 'FABRICA' }, destinos: [{ tipo: 'placa', placa: 'FKB1D11' }] }, /não pode ser um veículo/);
  ruim({ origem: { tipo: 'lugar', codigo: 'FABRICA' }, destinos: [{ tipo: 'lugar', codigo: '1', parada_min: 900 }] }, /0 a 600/);
  ruim({ origem: { tipo: 'lugar', codigo: 'FABRICA' }, destinos: [{ tipo: 'lugar', codigo: '1' }], saida: '25:00' }, /HH:MM/);
});

test('Tempo do trecho: historico > velocidade da frota > carro (o maior dos dois)', () => {
  assert.deepEqual(tempoTrecho(t, { de: 'FABRICA', para: '375', km: 59, minOsrm: 60 }), { min: 106, fonte: 'historico' });
  assert.deepEqual(tempoTrecho(t, { de: '375', para: 'FABRICA', km: 59, minOsrm: 60 }), { min: 106, fonte: 'historico' }); // volta = ida
  // 30 km a 24 km/h = 75 min > 40 min de carro.
  assert.deepEqual(tempoTrecho(t, { de: null, para: '999', km: 30, minOsrm: 40 }), { min: 75, fonte: 'frota' });
  // Carro mais lento que a media da frota: vale o carro (nunca promete menos).
  assert.deepEqual(tempoTrecho(t, { de: null, para: '999', km: 30, minOsrm: 90 }), { min: 90, fonte: 'osrm' });
  assert.deepEqual(tempoTrecho(null, { km: 30, minOsrm: 40 }), { min: 40, fonte: 'osrm' });
});

test('Parada: informada > mediana da loja > media geral; fabrica e ponto solto = 0', () => {
  assert.deepEqual(paradaDe(t, { codigo: '375', parada_min: 0 }), { min: 0, fonte: 'informada' });
  assert.deepEqual(paradaDe(t, { codigo: '375', parada_min: null }), { min: 37, fonte: 'historico' });
  assert.deepEqual(paradaDe(t, { codigo: '500', parada_min: null }), { min: 30, fonte: 'media' });
  assert.deepEqual(paradaDe(t, { codigo: 'FABRICA', parada_min: null }), { min: 0, fonte: 'nenhuma' });
  assert.deepEqual(paradaDe(t, { codigo: null, parada_min: null }), { min: 0, fonte: 'nenhuma' });
  assert.deepEqual(paradaDe(t, { codigo: '375', parada_min: null, fim: true }), { min: 0, fonte: 'nenhuma' });
});

test('Monta horarios encadeados, totais e virada do dia', () => {
  const r = montar({
    origem: { codigo: 'FABRICA' }, t, saidaMin: 22 * 60,
    seq: [{ rotulo: 'CENTRO I', codigo: '375', lat: 1, lng: 1, parada_min: null }, { rotulo: 'Fábrica', codigo: 'FABRICA', lat: 2, lng: 2, parada_min: null, fim: true }],
    legs: [{ distance: 59000, duration: 3600 }, { distance: 59000, duration: 3600 }],
  });
  assert.deepEqual(r.pontos.map((p) => [p.trecho_min, p.trecho_fonte, p.chegada, p.chegada_dia, p.parada_min, p.saida]),
    [[106, 'historico', '23:46', 0, 37, '00:23'], [106, 'historico', '02:09', 1, 0, '02:09']]);
  assert.deepEqual(r.total, { km: 118, dirigindo_min: 212, paradas_min: 37, total_min: 249, saida: '22:00', fim: '02:09', fim_dia: 1 });
});

test('Tela: le coordenada de link do Google Maps e de "lat,lng"', () => {
  const code = fs.readFileSync(path.join(ROOT, 'public/js/frota-rota.js'), 'utf8');
  const ini = code.indexOf('function pontoDoTexto(');
  const fim = code.indexOf('function adicionar(', ini);
  const ctx = {};
  vm.runInNewContext(code.slice(ini, fim) + '\nthis.f = pontoDoTexto;', ctx);
  const f = ctx.f;
  const ll = (x) => x && [x.lat, x.lng];
  assert.deepEqual(ll(f('https://www.google.com/maps/place/West+Shopping/@-22.8845727,-43.5577678,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d-22.8845727!4d-43.5551929')), [-22.8845727, -43.5551929]);
  assert.deepEqual(ll(f('https://www.google.com/maps/@-22.9068,-43.1729,15z')), [-22.9068, -43.1729]);
  assert.deepEqual(ll(f('https://maps.google.com/?q=-22.9068,-43.1729')), [-22.9068, -43.1729]);
  assert.deepEqual(ll(f(' -22.90684, -43.17290 ')), [-22.90684, -43.1729]);
  assert.equal(f('Rua Dr. Fernando 5, Campo Grande'), null);
  assert.equal(f('https://maps.app.goo.gl/abc123'), null);
});
