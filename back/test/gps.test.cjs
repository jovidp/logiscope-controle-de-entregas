const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = process.env.CE_TEST_ROOT || path.resolve(__dirname, '../..');
const { decidir, criar } = require(path.join(ROOT, 'back/tms-status-gps'));
const { anexarVisitas, criarDetector } = require(path.join(ROOT, 'back/rastreador-ao-vivo'));
const { resumoViagem } = require(path.join(ROOT, 'back/frota'));
const { criarRotas } = require(path.join(ROOT, 'back/tms-ciclo'));
const DATA = '2026-10-06';
const em = (hora, data = DATA) => new Date(`${data}T${hora}:00-03:00`);
const coords = new Map([['FABRICA', {lat: -22.96, lng: -43.61}], ['A', {lat: -22.85, lng: -43.30}], ['B', {lat: -22.72, lng: -43.15}]]);
const parada = (id, codigo, extra = {}) => ({ id, ordem: id, loja_codigo_pes: codigo, loja_nome: codigo, status: 'Pendente', ...extra });
const viagem = (extra = {}) => ({id: 269, placa: 'FKB1D11', data_viagem: DATA, status: 'Planejada', paradas: [parada(1, 'A'), parada(2, 'B')], ...extra});
const evento = (tipo, hora, codigo, extra = {}) => ({tipo, em: em(hora), lugar_codigo: codigo, placa: 'FKB1D11', viagem_id: 269, ...extra});
const saida = evento('saiu_fabrica', '06:00', 'FABRICA');
const chegadaA = evento('chegou_loja', '07:00', 'A');
const chegadaB = evento('chegou_loja', '09:00', 'B');
const volta = evento('voltou_fabrica', '11:00', 'FABRICA');
test('Saida da fabrica avanca uma viagem planejada', () => {
  assert.deepEqual(decidir(viagem(), [saida], coords, em('06:02')), {saida: {hora: '06:00'}});
});
test('Ultima loja inicia retorno e fabrica finaliza', () => {
  const a = decidir(viagem(), [saida, chegadaA, chegadaB, volta], coords, em('11:06'));
  assert.equal(a.retorno.loja, 'B');
  assert.deepEqual(a.finalizar, {hora: '11:00'});
});
test('Volta com loja que o GPS nao viu finaliza; sem passar em loja nao', () => {
  assert.deepEqual(decidir(viagem({status: 'Em rota', saida_real: '06:00'}), [saida, chegadaA, volta], coords, em('11:10')).finalizar,
    {hora: '11:00', pendentes: ['B']});
  assert.equal(decidir(viagem({status: 'Retorno', saida_real: '06:00'}), [saida, evento('voltou_fabrica', '06:20', 'FABRICA')], coords, em('06:30')).finalizar, undefined);
  // Ida ao posto/manutencao de 5h sem loja nenhuma nao fecha a viagem do dia.
  assert.equal(decidir(viagem({status: 'Em rota', saida_real: '06:00'}), [saida, volta], coords, em('11:10')).finalizar, undefined);
});
test('Volta finaliza na hora em que o GPS ve o caminhao na fabrica', () => {
  const v = viagem({status: 'Retorno', saida_real: '06:00'});
  assert.deepEqual(decidir(v, [saida, chegadaA, chegadaB, volta], coords, em('11:00')).finalizar, {hora: '11:00'});
});
test('Saida de loja sem a chegada conta como passagem', () => {
  const a = decidir(viagem({status: 'Em rota', saida_real: '06:00'}), [saida, chegadaA, evento('saiu_loja', '09:30', 'B'), volta], coords, em('11:00'));
  assert.ok(a.retorno);
  assert.deepEqual(a.finalizar, {hora: '11:00'});
});
test('Finalizada a mao sem horario ganha o horario da volta do GPS', () => {
  const v = viagem({status: 'Finalizada', saida_real: '06:00:00', saida_real_origem: 'botao'});
  assert.deepEqual(decidir(v, [saida, chegadaA, volta], coords, em('16:00')), {finalizar: {hora: '11:00', soHorario: true}});
  // Com horario (de quem for) nao mexe.
  assert.deepEqual(decidir({...v, retorno_real: '11:30:00', retorno_real_origem: 'botao'}, [saida, chegadaA, volta], coords, em('16:00')), {});
});
test('Volta estimada quando o rastreador dormiu chegando', () => {
  const dormiu = {...volta, detalhe: 'sinal parou a 552 m da fábrica, chegando — rastreador desligou?'};
  assert.deepEqual(decidir(viagem({status: 'Retorno', saida_real: '06:00'}), [saida, chegadaA, chegadaB, dormiu], coords, em('11:20')).finalizar,
    {hora: '11:00', estimada: true});
});

test('Falta do sinal de saída não bloqueia retorno e volta depois de loja comprovada', () => {
  const v=viagem({status:'Em rota',saida_real:null});
  const a=decidir(v,[chegadaA,chegadaB,volta],coords,em('11:10'));
  assert.equal(a.saida,undefined);assert.ok(a.retorno);assert.deepEqual(a.finalizar,{hora:'11:00'});
  assert.deepEqual(decidir(v,[volta],coords,em('11:10')),{},'sem loja comprovada não finaliza');
});
test('Reabre a viagem que o GPS fechou se o caminhao volta para loja nova', () => {
  const v = viagem({status: 'Finalizada', saida_real: '06:00:00', retorno_real: '08:00:00', retorno_real_origem: 'rastreador'});
  const passada = [saida, chegadaA, evento('voltou_fabrica', '08:00', 'FABRICA'), evento('saiu_fabrica', '08:40', 'FABRICA')];
  assert.deepEqual(decidir(v, [...passada, evento('chegou_loja', '09:30', 'B')], coords, em('09:35')).reabrir,
    {retorno: '08:00', loja: 'B', em: em('09:30')});
  // Loja que ja tinha visto antes da volta: nao reabre.
  assert.equal(decidir(v, [...passada, evento('chegou_loja', '09:30', 'A')], coords, em('09:35')).reabrir, undefined);
  // Retorno do botao: nunca desfaz.
  assert.equal(decidir({...v, retorno_real_origem: 'botao'}, [...passada, evento('chegou_loja', '09:30', 'B')], coords, em('09:35')).reabrir, undefined);
  // Depois de reaberta, a passada na fabrica nao fecha de novo; a volta de verdade fecha.
  const reaberta = viagem({status: 'Em rota', saida_real: '06:00:00'});
  assert.equal(decidir(reaberta, [...passada, evento('chegou_loja', '09:30', 'B')], coords, em('09:35')).finalizar, undefined);
  assert.equal(decidir(reaberta, [...passada, evento('chegou_loja', '09:30', 'B'), evento('voltou_fabrica', '11:00', 'FABRICA')], coords, em('11:00')).finalizar.hora, '11:00');
});
test('Horarios manuais e viagens encerradas sao preservados', () => {
  assert.equal(decidir(viagem({saida_real: '05:50', saida_real_origem: 'ajuste'}), [saida, chegadaA], coords, em('10:00')).saida, undefined);
  for (const status of ['Finalizada', 'Cancelada']) assert.deepEqual(decidir(viagem({status,saida_real:'06:00',retorno_real:'10:00'}), [saida, chegadaA, chegadaB, volta], coords, em('12:00')), {});
  assert.deepEqual(decidir(viagem({status:'Finalizada'}),[chegadaA,volta],coords,em('12:00')).finalizar,{hora:'11:00',soHorario:true});
  assert.deepEqual(decidir(viagem({retorno_real: '10:55'}), [saida], coords, em('12:00')), {});
});
test('Corrige somente a saida anterior do proprio GPS', () => {
  const a = decidir(viagem({saida_real: '05:00', saida_real_origem: 'rastreador'}), [saida, chegadaA], coords, em('10:00'));
  assert.deepEqual(a.saida, {hora: '06:00', substituir: '05:00'});
});
test('Manobra tardia sem tempo de chegar na loja nao vira saida', () => {
  const a = decidir(viagem(), [saida, evento('saiu_fabrica', '06:59', 'FABRICA'), chegadaA], coords, em('10:00'));
  assert.equal(a.saida.hora, '06:00');
});
test('Eventos futuros nao avancam o status', () => {
  assert.deepEqual(decidir(viagem(), [saida], coords, em('05:59')), {});
});
test('Pernoite usa as lojas e o retorno do segundo dia', () => {
  const a = decidir(viagem({status: 'Em rota', saida_real: '06:00'}), [saida, chegadaA,
    {...chegadaB, em: em('08:00', '2026-10-07')}, {...volta, em: em('12:00', '2026-10-07')}], coords, em('12:10', '2026-10-07'));
  assert.ok(a.retorno);
  assert.equal(a.finalizar.hora, '12:00');
});
function processador(eventos, handlers, queryExtra = async () => ({rows: [], rowCount: 0})) {
  return criar({db: {query: async (sql, params) => sql.includes('SELECT placa') ? {rows: eventos} : queryExtra(sql, params)},
    rastreador: {placaMercosul: p => p, coordenadas: async () => coords}, handlers,
    registrarAuditoria: async () => {}, broadcastAuditoria: () => {}, broadcastEvento: () => {}});
}
test('Falha temporaria de gravacao e tentada novamente no ciclo seguinte', async () => {
  let chamadas = 0;
  const mod = processador([saida], {saida: async (_req, res) => res.status(++chamadas === 1 ? 500 : 200).json({error: chamadas === 1 ? 'temporario' : undefined})});
  assert.deepEqual(await mod.aplicar([viagem()], em('06:05')), []);
  assert.equal((await mod.aplicar([viagem()], em('06:06')))[0].tipo, 'em_rota');
  assert.equal(chamadas, 2);
});
test('Eventos de outra viagem e eventos sem dono em placa ambigua nao sao usados', async () => {
  let chamadas = 0;
  const handlers = {saida: async (_req, res) => {chamadas++; res.json({});}};
  await processador([{...saida, viagem_id: 999}], handlers).aplicar([viagem()], em('06:05'));
  await processador([{...saida, viagem_id: null}], handlers).aplicar([viagem(), viagem({id: 270})], em('06:05'));
  assert.equal(chamadas, 0);
});
test('Mesmo ciclo executa saida, retorno e finalizacao na ordem', async () => {
  const chamadas = [];
  const handlers = {saida: async (_req, res) => {chamadas.push('saida'); res.json({});}, retorno: async (_req, res) => {chamadas.push('finalizar'); res.json({});}};
  const mod = processador([saida, chegadaA, chegadaB, volta], handlers, async () => {chamadas.push('retorno'); return {rowCount: 1};});
  assert.equal((await mod.aplicar([viagem()], em('11:06'))).length, 3);
  assert.deepEqual(chamadas, ['saida', 'retorno', 'finalizar']);
});
const server = fs.readFileSync(path.join(ROOT, 'back/server.js'), 'utf8');
const handlerText = server.slice(server.indexOf('async function registrarSaidaFabrica('), server.indexOf("app.post('/tms/viagens/:id/saida',"));
function resposta() {return {code: 200, status(n) {this.code = n; return this;}, json(body) {this.body = body; return this;}};}
function clientDa(v) {
  const escritas = [];
  return {escritas, release() {}, query: async (sql) => {
    if (/^\s*(UPDATE|INSERT)\b/.test(sql)) escritas.push(sql);
    if (sql.includes('SELECT v.id')) return {rows: [v], rowCount: 1};
    return {rows: [], rowCount: 0};
  }};
}
test('Handler de saida protege ajuste manual feito depois da leitura GPS', async () => {
  const client = clientDa({id: 269, saida_atual: '05:55', saida_real_origem: 'ajuste', status: 'Em rota'});
  const ctx = {db: {connect: async () => client}};
  vm.runInNewContext(handlerText + '\nthis.handler = registrarSaidaFabrica;', ctx);
  const res = resposta();
  await ctx.handler({params: {id: '269'}, body: {hora: '06:00'}, origemInterna: 'rastreador', substituirHora: '05:55'}, res);
  assert.equal(res.code, 409);
  assert.equal(client.escritas.length, 0);
});

test('Saída recuperada após fechamento preenche só o horário, preservando retorno manual',()=>{
  const v=viagem({status:'Finalizada',saida_real:null,retorno_real:'10:55',retorno_real_origem:'botao'});
  assert.deepEqual(decidir(v,[saida,chegadaA,volta],coords,em('12:00')),{saida:{hora:'06:00',soHorario:true}});
});

test('Handler completa saída vazia de viagem encerrada apenas com sinalizador interno e mantém horários preenchidos',async()=>{
  for(const extra of [{},{saida_atual:'05:55',saida_real_origem:'ajuste'},{status:'Cancelada'}]) {
    const v={id:269,data_iso:DATA,motorista:'Motorista',placa:'FKB1D11',status:'Finalizada',retorno_real:'11:00',saida_atual:null,...extra};
    const client=clientDa(v);
    const ctx={db:{connect:async()=>client},placaSemMascara:p=>p,PLACA_SQL:c=>c,STATUS_ANTES_DA_SAIDA:['Planejada','Carregando','Liberada'],
      registrarAuditoria:async()=>{},broadcastAuditoria(){},console};
    vm.runInNewContext(handlerText+'\nthis.handler = registrarSaidaFabrica;',ctx);
    const res=resposta();await ctx.handler({params:{id:'269'},body:{hora:'06:00'},origemInterna:'rastreador',completarHorarioEncerrada:true},res);
    if(v.saida_atual || v.status==='Cancelada') {assert.equal(res.code,409);assert.equal(client.escritas.length,0);}
    else {assert.equal(res.code,200);assert.ok(client.escritas.some(sql=>sql.includes("status = CASE WHEN status = ANY")));}
  }
});
test('Handler de retorno protege retorno manual e cancelamento concorrentes', async () => {
  for (const v of [{id: 269, retorno_real: '11:00', status: 'Finalizada'}, {id: 269, status: 'Cancelada'}]) {
    const client = clientDa(v);
    const rotas = criarRotas({db: {connect: async () => client}, registrarAuditoria: async () => {}});
    const res = resposta();
    await rotas.retorno({params: {id: 269}, body: {hora: '11:05'}, origemInterna: 'rastreador'}, res);
    assert.equal(res.code, 409);
    assert.equal(client.escritas.length, 0);
  }
});
function clientRetorno(v, tempoRota) {
  const escritas = [];
  return {escritas, release() {}, query: async (sql) => {
    if (/^\s*(UPDATE|INSERT)\b/.test(sql)) escritas.push(sql.trim().split(/\s+/).slice(0, 2).join(' '));
    if (sql.includes('SELECT v.id')) return {rows: [v], rowCount: 1};
    if (sql.includes('FROM rotas_registradas') && tempoRota) return {rows: [tempoRota], rowCount: 1};
    return {rows: [], rowCount: 0};
  }};
}
const viagemRetorno = (extra = {}) => ({id: 268, data_iso: DATA, eh_hoje: true, dias_atras: 0, motorista: 'JULIO', placa: 'FKC2E12', rota: 'MISSAO',
  status: 'Finalizada', retorno_real: null, saida: '06:41', agora: '16:50', ...extra});
test('Handler de retorno deixa o GPS preencher o horario de viagem finalizada a mao', async () => {
  const client = clientRetorno(viagemRetorno());
  const rotas = criarRotas({db: {connect: async () => client}, registrarAuditoria: async () => {}});
  const res = resposta();
  await rotas.retorno({params: {id: 268}, body: {hora: '15:06'}, origemInterna: 'rastreador'}, res);
  assert.equal(res.code, 200);
  assert.deepEqual(client.escritas, ['UPDATE tms_viagens', 'INSERT INTO']);
});

test('GPS preenche volta sem saída conhecida e deixa jornada pendente, sem inventar duração', async () => {
  const client=clientRetorno(viagemRetorno({status:'Em rota',saida:null}));
  const rotas=criarRotas({db:{connect:async()=>client},registrarAuditoria:async()=>{}}),res=resposta();
  await rotas.retorno({params:{id:268},body:{hora:'15:06'},origemInterna:'rastreador'},res);
  assert.equal(res.code,200);assert.equal(res.body.jornada,null);assert.equal(res.body.falta_saida,true);
  assert.deepEqual(client.escritas,['UPDATE tms_viagens']);
});
test('GPS acerta o proprio Tempo de Rota da mesma saida, mas nao o do botao', async () => {
  for (const [obs, esperado] of [['Registrado pelo TMS (🛰 rastreador)', ['UPDATE tms_viagens', 'UPDATE rotas_registradas']],
    ['Registrado pelo TMS (🏁 Voltou)', ['UPDATE tms_viagens']]]) {
    const client = clientRetorno(viagemRetorno({status: 'Em rota'}), {id: 5, is_viagem: false, obs, saida: '06:41'});
    const rotas = criarRotas({db: {connect: async () => client}, registrarAuditoria: async () => {}});
    const res = resposta();
    await rotas.retorno({params: {id: 268}, body: {hora: '15:06'}, origemInterna: 'rastreador'}, res);
    assert.equal(res.code, 200);
    assert.deepEqual(client.escritas, esperado);
  }
});
test('Detector: rastreador mudo chegando na fabrica vira voltou na hora estimada', () => {
  const fab = {codigo: 'FABRICA', lat: -22.96, lng: -43.61};
  const ponto = (metrosNorte, hora, velocidade) => ({placa: 'FKC2E12', lat: fab.lat + metrosNorte / 111195, lng: fab.lng, velocidade, posicao_em: em(hora), fonte: 'sat'});
  let d = criarDetector({agora: () => em('15:06').getTime()});
  d.restaurar('FKC2E12', null, null);
  for (const p of [ponto(8400, '14:57', 70), ponto(4000, '15:01', 50), ponto(550, '15:05', 36)]) d.processar(p, [fab]);
  assert.deepEqual(d.silencioNaFabrica('FKC2E12', [fab], em('15:14').getTime()), []); // ainda nao deu 10 min
  const [e] = d.silencioNaFabrica('FKC2E12', [fab], em('15:16').getTime());
  assert.equal(e.tipo, 'voltou_fabrica');
  assert.equal(Math.round((e.em - em('15:05')) / 1000), 55); // 550 m a 36 km/h
  assert.match(e.detalhe, /sinal parou a 55\d m/);
  assert.deepEqual(d.silencioNaFabrica('FKC2E12', [fab], em('15:30').getTime()), []); // 1 vez so
  // Saindo da fabrica (cada vez mais longe) e mudo: nao e volta.
  d = criarDetector({agora: () => em('06:20').getTime()});
  d.restaurar('FKC2E12', null, null);
  for (const p of [ponto(300, '06:05', 30), ponto(900, '06:07', 40)]) d.processar(p, [fab]);
  assert.deepEqual(d.silencioNaFabrica('FKC2E12', [fab], em('06:30').getTime()), []);
  // Parado longe (2 km) e mudo: nao e volta.
  d = criarDetector({agora: () => em('12:00').getTime()});
  d.restaurar('FKC2E12', null, null);
  for (const p of [ponto(6000, '11:40', 60), ponto(2000, '11:45', 0)]) d.processar(p, [fab]);
  assert.deepEqual(d.silencioNaFabrica('FKC2E12', [fab], em('12:00').getTime()), []);
});
test('Visitas GPS apontam Queimados mantendo os registros pendentes', async () => {
  const v = viagem({paradas: [parada(1, 'N IGUACU III'), parada(2, 'TOP'), parada(3, 'N IGUACU II'), parada(4, 'QUEIMADOS')]});
  const events = v.paradas.slice(0, 3).flatMap((p, i) => [evento('chegou_loja', `0${7+i}:00`, p.loja_codigo_pes, {parada_id: p.id}), evento('saiu_loja', `0${7+i}:30`, p.loja_codigo_pes, {parada_id: p.id})]);
  await anexarVisitas({query: async sql => ({rows: sql.includes('rastreador_eventos_loja') ? [saida, ...events] : []})}, [v], {diasAtras: 100000});
  const resumo = resumoViagem(v);
  assert.equal(resumo.proxima, 'QUEIMADOS');
  assert.equal(resumo.paradas_visitadas, 3);
  assert.equal(resumo.paradas_feitas, 0);
  assert.deepEqual(resumo.sem_registro, ['N IGUACU III', 'TOP', 'N IGUACU II']);
  assert.ok(v.paradas.every(p => p.status === 'Pendente'));
});
test('Detector reconhece saida andando fora da loja sem esperar 400 metros', () => {
  const detector = criarDetector();
  const loja = {codigo: 'A', lat: -22.85, lng: -43.30};
  detector.restaurar('FKB1D11', loja, em('07:00'));
  const events = detector.processar({placa: 'FKB1D11', lat: loja.lat + 0.0028, lng: loja.lng, velocidade: 20, posicao_em: em('07:20')}, [loja]);
  assert.equal(events[0].tipo, 'saiu_loja');
});
test('Resumo do card usa GPS, sinaliza lojas puladas e escapa nomes', () => {
  const code = fs.readFileSync(path.join(ROOT, 'public/js/tms.js'), 'utf8');
  const start = code.indexOf('function tmsRoteiroHtml(');
  const end = code.indexOf('// Previsao de chegada da parada pendente', start);
  const ctx = {escapar: s => String(s).replaceAll('<', '&lt;')};
  vm.runInNewContext(code.slice(start, end) + '\nthis.render = tmsRoteiroHtml;', ctx);
  const html = ctx.render(viagem({paradas: [parada(1, 'A'), parada(2, 'B', {gps_chegou_em: em('07:00').toISOString()}), parada(3, '<QUEIMADOS>')]}));
  assert.ok(html.includes('próxima: &lt;QUEIMADOS>'));
  assert.ok(html.includes('1 sem registro'));
  assert.ok(html.includes('1 sem passagem confirmada'));
});
