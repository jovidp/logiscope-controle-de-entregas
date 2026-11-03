// ================================================================
// rastreador-eventos.js — horarios da viagem pelo rastreador
// ----------------------------------------------------------------
// Le as PARADAS do caminhao no dia (rastreador.paradasDoDia) e acha:
//   🧑 chegou na fabrica  = inicio da parada na fabrica antes da saida
//   🚚 saiu               = fim da parada na fabrica que abre a "excursao"
//   🏨 hotel (rota longa) = parada longa fora da fabrica atravessando a noite
//   🏁 voltou             = inicio da 1a parada na fabrica depois da excursao
// Excursao = saiu da fabrica e so voltou >= 60 min depois (descarta manobra
// no patio). Mais de uma no dia: a que passa nas lojas da viagem, senao a
// mais longa.
//
// "Completar dias pendentes" (POST /tms/rastreador/completar, ADM):
//   - so viagens SEM o horario (o que alguem digitou/apertou nunca e trocado);
//   - so viagem com PROVA de que aconteceu: loja com registro, ou o caminhao
//     passou numa loja da viagem. Sem prova fica para o operador;
//   - grava pelos MESMOS caminhos dos botoes (Chegou/Saiu/Hotel/Voltou), com
//     origem "rastreador" — jornada, Tempo de Rota e status saem pela mesma
//     regra; nesse modo eles so PREENCHEM vazio (nao sobrescrevem).
// ================================================================

const rastreador = require("./rastreador");
const lojasPes = require("./lojas-pes");
const pernoite = require("./pernoite");

// Aprendida das paradas em 05/10/2026 (57 amostras, ±10 m). loja_coordenadas manda.
const FABRICA_PADRAO = { lat: -22.96402, lng: -43.6184 };
const RAIO_FABRICA_M = 300;
const RAIO_LOJA_M = 250;
const EXCURSAO_MIN = 60;

const hhmm = (min) => { const m = ((Math.round(min) % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
const somaDia = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// Paradas de D (e D+1 quando rota longa) numa linha do tempo unica (D+1 = +1440).
async function linhaDoTempo(deviceId, dataISO, longa, cache) {
  const pegar = async (iso) => {
    const k = `${deviceId}|${iso}`;
    if (!cache.has(k)) cache.set(k, await rastreador.paradasDoDia(deviceId, iso));
    return cache.get(k);
  };
  const d0 = await pegar(dataISO);
  const d1 = longa ? (await pegar(somaDia(dataISO, 1))).map((p) => ({ ...p, ini: p.ini + 1440, fim: p.fim + 1440 })) : [];
  // Junta parada que vira a meia-noite (fim 1440 em D + ini 0 em D+1)
  const todas = [...d0, ...d1].sort((a, b) => a.ini - b.ini);
  const juntas = [];
  for (const p of todas) {
    const ult = juntas[juntas.length - 1];
    if (ult && p.ini - ult.fim <= 2 && rastreador.distanciaM(ult, p) < 150) { ult.fim = Math.max(ult.fim, p.fim); ult.dur_min = ult.fim - ult.ini; }
    else juntas.push({ ...p });
  }
  return juntas;
}

// Marcos de UMA viagem a partir da linha do tempo.
// chegadasRegistradas: minutos (dia seguinte = +1440) das entregas ja lancadas
// nesta viagem — a prova mais forte de QUAL saida da fabrica foi a viagem.
function acharMarcos(paradas, fab, lojasViagem, longa, chegadasRegistradas = []) {
  const naFab = (p) => rastreador.distanciaM(p, fab) <= RAIO_FABRICA_M;
  const fabs = paradas.map((p, i) => ({ p, i })).filter((x) => naFab(x.p));
  // Excursoes: entre duas paradas na fabrica com >= 60 min fora
  const exc = [];
  for (let k = 0; k < fabs.length; k++) {
    const a = fabs[k].p, b = fabs[k + 1] ? fabs[k + 1].p : null;
    if (a.fim >= 1440) break; // a saida tem de ser no dia da viagem
    const fora = paradas.slice(fabs[k].i + 1, b ? fabs[k + 1].i : paradas.length);
    if (!b && !fora.length) continue;
    const volta = b ? b.ini : null;
    if (volta != null && volta - a.fim < EXCURSAO_MIN) continue; // manobra no patio
    const lojas = new Set();
    for (const p of fora) for (const l of lojasViagem) if (l.coord && rastreador.distanciaM(p, l.coord) <= RAIO_LOJA_M) lojas.add(l.codigo);
    const ate = volta ?? Infinity;
    const registros = chegadasRegistradas.filter((m) => m >= a.fim && m <= ate).length;
    exc.push({ chegada: a.ini, saida: a.fim, retorno: volta, fora, lojas, registros, dur: (volta ?? paradas[paradas.length - 1].fim) - a.fim });
  }
  if (!exc.length) return null;
  // Mais de uma saida no dia (ex.: 09:13-12:40 e depois 17:32 guardando o
  // caminhao): vence a que contem os horarios das entregas registradas, depois
  // a que passa nas lojas da viagem, depois a que voltou, depois a mais longa.
  const melhor = [...exc].sort((x, y) =>
    (y.registros - x.registros) || (y.lojas.size - x.lojas.size)
    || ((y.retorno != null) - (x.retorno != null)) || (y.dur - x.dur))[0];
  if (chegadasRegistradas.length && !melhor.registros && !melhor.lojas.size) return null; // nenhuma saida bate com a viagem
  const r = {
    chegada: melhor.chegada >= 180 && melhor.chegada < melhor.saida ? melhor.chegada : null, // dormiu na fabrica: sem "chegou"
    saida: melhor.saida, retorno: melhor.retorno, lojas_visitadas: melhor.lojas.size,
  };
  // Hotel (rota longa): maior parada fora da fabrica que cruza a meia-noite
  if (longa && (r.retorno == null || r.retorno >= 1440)) {
    const noite = melhor.fora.filter((p) => p.ini < 1440 && p.fim > 1440 && p.dur_min >= 240).sort((a, b) => b.dur_min - a.dur_min)[0];
    if (noite) { r.hotel_chegada = noite.ini; r.hotel_saida = noite.fim; }
  }
  return r;
}

// Viagens sem horario + o que o rastreador acha. Nao grava nada.
async function planejar(db, { dias = 45, log = () => {} } = {}) {
  const idx = await lojasPes.carregarIndice(db);
  const coords = await rastreador.coordenadas(db).catch(() => new Map());
  const fab = coords.get(lojasPes.FABRICA) || FABRICA_PADRAO;
  const aparelhos = await rastreador.listarAparelhos();
  const porPlaca = new Map(aparelhos.map((a) => [a.placa, a.device_id]));
  const vs = await db.query(`
      SELECT v.id, to_char(v.data_viagem, 'YYYY-MM-DD') AS data, v.placa, v.rota_nome AS rota, v.status, v.motorista_nome AS motorista,
             to_char(v.chegada_fabrica, 'HH24:MI') AS chegada_fabrica, to_char(v.saida_real, 'HH24:MI') AS saida_real,
             to_char(v.retorno_real, 'HH24:MI') AS retorno_real, to_char(v.hotel_chegada, 'HH24:MI') AS hotel_chegada,
             to_char(v.hotel_saida, 'HH24:MI') AS hotel_saida,
             (SELECT COUNT(*) FROM tms_paradas p WHERE p.viagem_id = v.id
                 AND (p.ocorrencia_id IS NOT NULL OR EXISTS (SELECT 1 FROM ocorrencias o WHERE o.parada_id = p.id AND o.excluida_em IS NULL)))::int AS lojas_registradas,
             (SELECT json_agg(p.loja_nome ORDER BY p.ordem) FROM tms_paradas p WHERE p.viagem_id = v.id) AS lojas,
             (SELECT json_agg(EXTRACT(HOUR FROM o.hora_chegada) * 60 + EXTRACT(MINUTE FROM o.hora_chegada) + CASE WHEN o.dia_seguinte THEN 1440 ELSE 0 END)
                FROM ocorrencias o
               WHERE o.excluida_em IS NULL AND o.hora_chegada IS NOT NULL
                 AND (o.viagem_id = v.id OR o.parada_id IN (SELECT id FROM tms_paradas WHERE viagem_id = v.id)
                      OR o.id IN (SELECT ocorrencia_id FROM tms_paradas WHERE viagem_id = v.id AND ocorrencia_id IS NOT NULL))) AS chegadas
        FROM tms_viagens v
       WHERE v.data_viagem >= CURRENT_DATE - $1::int AND v.data_viagem < CURRENT_DATE AND v.status <> 'Cancelada'
         AND (v.saida_real IS NULL OR v.retorno_real IS NULL OR v.chegada_fabrica IS NULL)
       ORDER BY v.data_viagem, v.id`, [dias]);
  // Mesma placa com 2+ viagens no dia: o rastreador nao separa — fica manual
  const porDiaPlaca = new Map();
  for (const v of vs.rows) { const k = `${v.data}|${rastreador.placaMercosul(v.placa)}`; porDiaPlaca.set(k, (porDiaPlaca.get(k) || 0) + 1); }

  const cache = new Map(), plano = [];
  for (const v of vs.rows) {
    const item = { viagem_id: v.id, data: v.data, placa: v.placa, rota: v.rota, motorista: v.motorista, status: v.status, preencher: {}, motivo: null };
    plano.push(item);
    const dev = porPlaca.get(rastreador.placaMercosul(v.placa));
    if (!dev) { item.motivo = "placa sem rastreador"; continue; }
    if (porDiaPlaca.get(`${v.data}|${rastreador.placaMercosul(v.placa)}`) > 1) { item.motivo = "mesma placa com mais de uma viagem no dia"; continue; }
    const longa = pernoite.ehRotaViagem(v.rota);
    const lojasViagem = (v.lojas || []).map((n) => { const l = idx && idx.resolver(n); return l ? { codigo: l.codigo, coord: coords.get(l.codigo) } : null; }).filter(Boolean);
    let m;
    try { m = acharMarcos(await linhaDoTempo(dev, v.data, longa, cache), fab, lojasViagem, longa, (v.chegadas || []).map(Number)); }
    catch (err) { item.motivo = `historico indisponivel (${err.message})`; continue; }
    if (!m) { item.motivo = "rastreador nao mostra saida da fabrica nesse dia"; continue; }
    // Prova de que a viagem aconteceu
    if (!v.lojas_registradas && !m.lojas_visitadas) { item.motivo = "sem prova: nenhuma loja registrada nem visitada pelo caminhao"; continue; }
    item.prova = v.lojas_registradas ? `${v.lojas_registradas} loja(s) com registro` : `passou em ${m.lojas_visitadas} loja(s) da viagem`;
    if (!v.chegada_fabrica && m.chegada != null) item.preencher.chegada = hhmm(m.chegada);
    if (!v.saida_real) item.preencher.saida = hhmm(m.saida);
    if (longa && !v.hotel_chegada && m.hotel_chegada != null) item.preencher.hotel_chegada = hhmm(m.hotel_chegada);
    if (longa && !v.hotel_saida && m.hotel_saida != null) item.preencher.hotel_saida = hhmm(m.hotel_saida);
    if (!v.retorno_real && m.retorno != null) { item.preencher.retorno = hhmm(m.retorno); if (m.retorno >= 1440) item.retorno_dia_seguinte = true; }
    if (!Object.keys(item.preencher).length) item.motivo = m.retorno == null ? "ainda nao voltou para a fabrica no rastreador" : "nada a preencher";
    if (plano.length % 10 === 0) log(`[completar] ${plano.length}/${vs.rowCount}`);
  }
  return plano;
}

// Aplica o plano pelos mesmos handlers dos botoes (ordem do ciclo).
async function aplicar(plano, { handlers, usuario = "🛰 rastreador" }) {
  const chamar = (fn, id, hora) => new Promise((ok) => {
    const res = { status(s) { this.s = s; return this; }, json(j) { ok({ status: this.s || 200, ...j }); } };
    fn({ params: { id: String(id) }, body: { hora }, usuarioLogado: { nome: usuario }, origemInterna: "rastreador" }, res);
  });
  const ordem = [["chegada", handlers.chegada], ["saida", handlers.saida], ["hotel_chegada", handlers.hotelChegada],
    ["hotel_saida", handlers.hotelSaida], ["retorno", handlers.retorno]];
  const resultado = [];
  for (const item of plano) {
    if (!item.preencher || !Object.keys(item.preencher).length) continue;
    const feitos = {}, erros = {};
    for (const [chave, fn] of ordem) {
      const hora = item.preencher[chave];
      if (!hora || !fn) continue;
      const r = await chamar(fn, item.viagem_id, hora);
      if (r.status >= 400) erros[chave] = r.error || `HTTP ${r.status}`; else feitos[chave] = hora;
    }
    resultado.push({ viagem_id: item.viagem_id, data: item.data, rota: item.rota, feitos, erros });
  }
  return resultado;
}

module.exports = { planejar, aplicar, acharMarcos, linhaDoTempo, FABRICA_PADRAO };
