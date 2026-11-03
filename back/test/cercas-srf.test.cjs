const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ROOT = process.env.CE_TEST_ROOT || path.resolve(__dirname, '../..');

// SRF de mentira (nada sai para a plataforma de verdade).
const rastPath = require.resolve(path.join(ROOT, 'back/rastreador'));
const chamadas = [];
let cercasSrf = [];
require.cache[rastPath] = { id: rastPath, filename: rastPath, loaded: true, exports: {
  configurado: () => true,
  srfApi: async (ep) => (ep === 'get_geofences' ? { items: { geofences: cercasSrf } } : { 0: { id: 7, title: 'Rota' }, 1: { id: 6, title: 'ZONA OESTE ' }, pagination: {} }),
  srfEnviar: async (ep, corpo) => {
    chamadas.push({ ep, corpo });
    if (ep === 'add_geofence') { const id = 900 + chamadas.length; cercasSrf.push({ id, name: corpo.name, coordinates: JSON.stringify(corpo.polygon), polygon_color: corpo.polygon_color, group_id: null, active: 1, updated_at: 'agora' }); return { status: 1 }; }
    return { status: 1 };
  },
} };
const { planejar, pontosDoSrf, corpoParaSrf, circulo, criar } = require(path.join(ROOT, 'back/frota-cercas-srf'));

const cerca = (id, extra = {}) => ({ id, name: `C${id}`, group_id: 7, active: 0, type: 'polygon', updated_at: '2026-10-05 11:17:03',
  coordinates: JSON.stringify([{ lat: -22.96, lng: -43.61 }, { lat: -22.97, lng: -43.61 }, { lat: -22.97, lng: -43.62 }]), polygon_color: '#00ff0d', ...extra });

test('Converte poligono e circulo do SRF para pontos [lat,lng]', () => {
  assert.deepEqual(pontosDoSrf(cerca(1)), [[-22.96, -43.61], [-22.97, -43.61], [-22.97, -43.62]]);
  const c = pontosDoSrf({ type: 'circle', radius: 200, center: '{"lat":-22.96,"lng":-43.61}' });
  assert.equal(c.length, 36);
  const R = 6371000, rad = (x) => x * Math.PI / 180;
  for (const [lat, lng] of c) {
    const h = Math.sin(rad(lat + 22.96) / 2) ** 2 + Math.cos(rad(-22.96)) * Math.cos(rad(lat)) * Math.sin(rad(lng + 43.61) / 2) ** 2;
    assert.ok(Math.abs(2 * R * Math.asin(Math.sqrt(h)) - 200) < 2);
  }
  assert.deepEqual(pontosDoSrf({ coordinates: 'lixo' }), []);
  assert.equal(circulo({ lat: 0.5, lng: 0.5 }, 10, 8).length, 8);
});
test('Area daqui vira corpo do add_geofence com a cor do tipo', () => {
  const corpo = corpoParaSrf({ id: 3, nome: ' Comunidade X ', tipo: 'atencao', pontos: [[-22.9, -43.4], [-22.91, -43.4], [-22.91, -43.41]] });
  assert.deepEqual(corpo, { name: 'Comunidade X', polygon_color: '#d97706',
    polygon: [{ lat: -22.9, lng: -43.4 }, { lat: -22.91, lng: -43.4 }, { lat: -22.91, lng: -43.41 }] });
  assert.equal(corpoParaSrf({ id: 4, nome: 'Y', tipo: 'risco', cor: '#ABCDEF', srf_grupo: 7, pontos: [[1, 1], [1, 2], [2, 2]] }).polygon_color, '#abcdef');
  assert.equal(corpoParaSrf({ id: 4, nome: 'Y', tipo: 'risco', srf_grupo: 7, pontos: [[1, 1], [1, 2], [2, 2]] }).group_id, 7);
  assert.throws(() => corpoParaSrf({ id: 5, nome: 'Z', pontos: [[1, 1], [2, 2]] }), /3 pontos/);
});
test('Previa separa nova, igual, mudou, apagada aqui e sumida do SRF', () => {
  const grupos = new Map([[7, 'Rota'], [6, 'ZONA OESTE']]);
  const locais = [
    { id: 10, srf_id: 2, ativo: true, srf_atualizado: '2026-10-05 11:17:03', origem: 'srf', nome: 'C2' },
    { id: 11, srf_id: 3, ativo: true, srf_atualizado: 'velho', origem: 'srf', nome: 'C3' },
    { id: 12, srf_id: 4, ativo: false, srf_atualizado: '2026-10-05 11:17:03', origem: 'srf', nome: 'C4' },
    { id: 13, srf_id: 99, ativo: true, srf_atualizado: 'x', origem: 'local', nome: 'Minha' },
  ];
  const p = planejar([cerca(1), cerca(2), cerca(3), cerca(4), cerca(5, { group_id: 6 })], locais, grupos);
  assert.deepEqual(p.itens.map((i) => [i.srf_id, i.situacao, i.tipo]),
    [[1, 'nova', 'corredor'], [2, 'igual', 'corredor'], [3, 'mudou', 'corredor'], [4, 'apagada_aqui', 'corredor'], [5, 'nova', 'referencia']]);
  assert.deepEqual(p.sumiram.map((s) => s.area_id), [13]);
});

// Banco de verdade, tudo dentro de uma transacao desfeita no fim.
test('Trazer do SRF e enviar ao SRF no banco (ROLLBACK)', { skip: !process.env.CE_TEST_DB }, async () => {
  const db = require(path.join(ROOT, 'back/db'));
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const q = { query: (sql, p) => client.query(sql, p) };
    const garantirBase = () => client.query(`CREATE TABLE IF NOT EXISTS frota_areas (id SERIAL PRIMARY KEY, nome TEXT NOT NULL, tipo TEXT NOT NULL DEFAULT 'risco',
      pontos JSONB NOT NULL, ativo BOOLEAN NOT NULL DEFAULT TRUE, criado_por TEXT, criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const mod = criar({ db: q, garantirBase, registrarAuditoria: async () => {} });
    cercasSrf = [cerca(1, { name: 'Z.NORTE I' }), cerca(2, { name: 'BAIXADA II', active: 1 })];
    assert.deepEqual(await mod.importar({ por: 'teste' }), { novas: 2, atualizadas: 0, iguais: 0, ignoradas: 0, removidas: 0, desvinculadas: 0 });
    assert.deepEqual(await mod.importar({ por: 'teste' }), { novas: 0, atualizadas: 0, iguais: 2, ignoradas: 0, removidas: 0, desvinculadas: 0 });
    const trazidas = (await client.query("SELECT nome, tipo, origem, srf_ativo, jsonb_array_length(pontos) n FROM frota_areas WHERE srf_id IN (1,2) ORDER BY srf_id")).rows;
    assert.deepEqual(trazidas, [{ nome: 'Z.NORTE I', tipo: 'corredor', origem: 'srf', srf_ativo: false, n: 3 }, { nome: 'BAIXADA II', tipo: 'corredor', origem: 'srf', srf_ativo: true, n: 3 }]);
    // Mudou la -> atualiza; sumiu la -> sai daqui.
    cercasSrf = [cerca(1, { name: 'Z.NORTE I (nova)', updated_at: '2026-10-06 17:00:00' })];
    const r = await mod.importar({ por: 'teste' });
    assert.equal(r.atualizadas, 1); assert.equal(r.removidas, 1);
    // Area desenhada aqui -> vai para o SRF e fica vinculada.
    const nova = (await client.query("INSERT INTO frota_areas (nome, tipo, pontos) VALUES ('Comunidade X', 'risco', '[[-22.9,-43.4],[-22.91,-43.4],[-22.91,-43.41]]') RETURNING id")).rows[0].id;
    const env = await mod.enviarUma(nova);
    assert.equal(env.criada, true);
    assert.equal(chamadas.at(-1).ep, 'add_geofence');
    assert.equal(chamadas.at(-1).corpo.polygon_color, '#dc2626');
    const v = (await client.query('SELECT srf_id, srf_pendente FROM frota_areas WHERE id = $1', [nova])).rows[0];
    assert.equal(v.srf_id, env.srf_id); assert.equal(v.srf_pendente, false);
    // Reenviar a mesma = edit_geofence (nao duplica la).
    await mod.enviarUma(nova);
    assert.equal(chamadas.at(-1).ep, 'edit_geofence');
    assert.equal(chamadas.at(-1).corpo.id, env.srf_id);
    // E o proximo "Trazer" ja reconhece a enviada (nao volta duplicada).
    assert.equal((await mod.importar({ por: 'teste' })).novas, 0);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await db.pool.end();
  }
});
