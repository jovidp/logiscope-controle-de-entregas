'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { criarDetector } = require('../rastreador-ao-vivo');
const { eventosAusentes } = require('../rastreador-t4s-historico');
const loja = { codigo:'499', nome:'SULACAP', lat:-22.88629652613396, lng:-43.40179153251244 };
const ponto = (hora, lat, lng, velocidade=0, motor='desligado') => ({
  placa:'FKA0C10', fonte:'t4s', device_id:68560, lat, lng, velocidade, motor,
  posicao_em:new Date(`2026-10-08T${hora}-03:00`),
});
const chegada = [
  ponto('13:24:10', -22.8853, -43.4015, 20, 'ligado'),
  ponto('13:26:09', -22.8862, -43.4017, 0, 'ligado'),
  ponto('13:43:29', -22.8864, -43.4019),
  ponto('13:58:31', -22.8862, -43.4018),
  ponto('14:13:33', -22.8861, -43.402),
];
const viagem = {paradas:[{loja_codigo_pes:'499'}]};

test('Sulacap confirma 13:26 com ignição ligada na chegada, desligada depois e variação de 30 m', () => {
  const eventos = eventosAusentes(chegada, [loja], viagem, []);
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].tipo, 'chegou_loja');
  assert.equal(eventos[0].em.toISOString(), '2026-10-08T16:26:09.000Z');
  assert.match(eventos[0].detalhe, /sinais espaçados/);
  assert.deepEqual(eventosAusentes(chegada, [loja], viagem,
    [{tipo:'chegou_loja', lugar_codigo:'499', em:eventos[0].em}]), []);
});

test('Sinais espaçados não confirmam com motor ligado nos dois, desconhecido ou deslocamento maior que 50 m', () => {
  for (const pontos of [
    chegada.slice(0,3).map(p=>({...p,motor:'ligado'})),
    chegada.slice(0,3).map((p,i)=>i===1?{...p,motor:null}:p),
    chegada.slice(0,3).map((p,i)=>i===2?{...p,lat:p.lat-.0006}:p),
  ]) assert.deepEqual(eventosAusentes(pontos, [loja], viagem, []), []);
});

test('Confirmação espaçada respeita deslocamento permitido em áreas pequenas e não registra passagem em movimento', () => {
  const area = {...loja,raio_entrada_m:20};
  const d = criarDetector();
  const pontos = [chegada[0], {...chegada[1],lat:loja.lat-15/111195,lng:loja.lng},
    {...chegada[2],lat:loja.lat+15/111195,lng:loja.lng}];
  assert.deepEqual(pontos.flatMap(p=>d.processar(p,[area],{historico:true})), []);
  assert.deepEqual(eventosAusentes(chegada.map(p=>({...p,velocidade:20})), [loja], viagem, []), []);
});
