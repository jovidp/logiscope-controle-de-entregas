// ================================================================
// previsao-tms.js — previsao de chegada por loja (sem GPS) + alertas do TMS
// ----------------------------------------------------------------
// PREVISAO: a partir da saida REAL da fabrica (botao 🚚 Saiu) e do que ja foi
// registrado nas lojas, projeta a chegada em cada loja pendente:
//   trecho = mediana historica do trecho (>= 3 amostras, ocorrencias dos
//            ultimos 180 dias), senao km do trecho / velocidade media real
//   descarga = mediana historica da loja, senao a mediana geral
// A previsao parte da loja registrada MAIS ADIANTADA na rota (o registro e
// lancado depois da entrega e nem sempre na ordem); loja que ficou para tras
// sem registro e marcada sem_registro e nao gera alerta de atraso.
// Quando a API do rastreador ficar pronta, ela so substitui o "ponto de
// partida" (posicao real); o resto continua valendo.
//
// ALERTAS (entram no motor do sino 🚨 via avaliarAlertas):
//   jornada      — 10h30 / 11h30 / 12h de TRABALHO (descontada 1h de almoco)
//                  e jornada PREVISTA acima de 12h
//   eta_atraso   — proxima loja vai chegar >= 15 min depois do horario
//   fechamento   — a partir das 17h, viagem do dia com loja sem registro;
//                  e 1 resumo diario das viagens antigas com pendencia
//
// PERNOITE (rotas de viagem, back/pernoite.js): o relogio e ABSOLUTO desde
// 00:00 do dia da viagem (dia seguinte = +1440). Se a proxima loja cairia
// depois de TMS_PERNOITE_APOS (20:00), a equipe dorme e retoma no dia
// seguinte as TMS_PERNOITE_RETOMA (07:30) — o hotel fica na regiao da loja.
// Jornada conta por dia (no 2o dia, a partir da saida do hotel) e o
// fechamento das 17h nao cobra no 1o dia as lojas que ficam para o 2o.
// ================================================================

const { FABRICA } = require("./lojas-pes");
const { ehRotaViagem, DIAS_CONTINUA } = require("./pernoite");
const { distanciaM } = require("./rastreador");
const qualidadeGps = require("./gps-precisao");
// GPS (rastreador): a proxima loja pendente parte da POSICAO REAL do caminhao.
// Distancia em linha reta x fator de estrada / velocidade tipica da faixa.
const FATOR_ESTRADA = 1.35;

const TRABALHO_MAX = 720;       // 12h de trabalho (8h + 4h extra)
const ALMOCO = 60;              // 1h, descontada em dia acima de 6h
const FECHAMENTO_HORA = Number(process.env.TMS_FECHAMENTO_HORA || 17);
const ATRASO_ETA_MIN = Number(process.env.TMS_ETA_ALERTA_MIN || 15);

const minDe = (h) => {
  const m = String(h || "").match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const PERNOITE_APOS = minDe(process.env.TMS_PERNOITE_APOS) ?? 20 * 60;
const PERNOITE_RETOMA = minDe(process.env.TMS_PERNOITE_RETOMA) ?? 7 * 60 + 30;
const diasEntre = (de, ate) => Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${String(de).slice(0, 10)}T12:00:00Z`)) / 86400000);
const hhmm = (min) => {
  if (min == null) return null;
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
const trabalhado = (corrido) => (corrido > 360 ? corrido - ALMOCO : corrido);
const fmt = (m) => `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, "0")}`;
const mediana = (arr) => {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const i = Math.floor(a.length / 2);
  return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
};
function agoraSP() {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return { data: `${g("year")}-${g("month")}-${g("day")}`, min: (Number(g("hour")) % 24) * 60 + Number(g("minute")) };
}

// ---------------------------------------------------------------- tempos historicos
const FAIXAS_KM = [10, 40, 80, Infinity]; // ate 10 km, 10-40, 40-80, 80+
const faixaKm = (km) => FAIXAS_KM.findIndex((lim) => km < lim);
let _tempos = null;
const TEMPOS_MS = 30 * 60 * 1000;

async function carregarTempos(db, idx) {
  if (_tempos && Date.now() - _tempos.em < TEMPOS_MS) return _tempos.t;
  const r = await db.query(`
      -- dia_seguinte (pernoite) ordena DEPOIS do 1o dia; trecho que atravessa
      -- o hotel (dia muda entre uma loja e a outra) nao e trecho de estrada.
      WITH ordenado AS (
        SELECT loja, hora_chegada, fim_descarga, hora_saida_fabrica, dia_seguinte,
               ROW_NUMBER() OVER w AS rn, LAG(fim_descarga) OVER w AS prev_saida, LAG(loja) OVER w AS prev_loja,
               LAG(dia_seguinte) OVER w AS prev_dia_seguinte
          FROM ocorrencias
         WHERE excluida_em IS NULL AND hora_chegada IS NOT NULL AND data_ocorrencia >= CURRENT_DATE - 180
           AND NULLIF(TRIM(motorista),'') IS NOT NULL AND NULLIF(TRIM(loja),'') IS NOT NULL
        WINDOW w AS (PARTITION BY data_ocorrencia, NULLIF(TRIM(motorista),'') ORDER BY dia_seguinte, hora_chegada, id))
      SELECT CASE WHEN rn = 1 THEN NULL ELSE prev_loja END AS origem, rn = 1 AS da_fabrica, loja AS destino,
             CASE WHEN rn = 1 AND dia_seguinte THEN NULL
                  WHEN rn > 1 AND prev_dia_seguinte IS DISTINCT FROM dia_seguinte THEN NULL
                  ELSE EXTRACT(EPOCH FROM (hora_chegada - CASE WHEN rn = 1 THEN hora_saida_fabrica ELSE prev_saida END)) / 60.0
             END AS viagem_min,
             EXTRACT(EPOCH FROM (fim_descarga - hora_chegada)) / 60.0 AS descarga_min
        FROM ordenado`);
  const trechos = new Map(), descargas = new Map(), todasDescargas = [], velocidades = [];
  const velFaixa = FAIXAS_KM.map(() => []);
  for (const row of r.rows) {
    const d = idx.resolver(row.destino);
    if (!d) continue;
    const dm = Number(row.descarga_min);
    if (dm >= 3 && dm <= 240) { (descargas.get(d.codigo) || descargas.set(d.codigo, []).get(d.codigo)).push(dm); todasDescargas.push(dm); }
    const vm = Number(row.viagem_min);
    if (!(vm >= 1 && vm <= 600)) continue;
    const o = row.da_fabrica ? FABRICA : idx.resolver(row.origem)?.codigo;
    if (!o || o === d.codigo) continue;
    const k = `${o}|${d.codigo}`;
    (trechos.get(k) || trechos.set(k, []).get(k)).push(vm);
    const km = idx.dist.get(k) ?? idx.dist.get(`${d.codigo}|${o}`);
    if (km && km >= 2) { velocidades.push(km / vm); velFaixa[faixaKm(km)].push(km / vm); }
  }
  const t = {
    trecho: new Map([...trechos].filter(([, v]) => v.length >= 3).map(([k, v]) => [k, mediana(v)])),
    descarga: new Map([...descargas].filter(([, v]) => v.length >= 3).map(([k, v]) => [k, mediana(v)])),
    descargaGeral: mediana(todasDescargas) ?? 30,
    kmPorMin: mediana(velocidades) ?? 0.5,
    // Velocidade por faixa de distancia (>= 10 amostras): cidade anda ~12 km/h,
    // estrada acima de 80 km ~53 km/h. Uma media so estimava a volta de
    // Arraial do Cabo (213 km) em 10h.
    kmPorMinFaixa: velFaixa.map((v) => (v.length >= 10 ? mediana(v) : null)),
  };
  _tempos = { em: Date.now(), t };
  return t;
}

function tempoTrecho(t, idx, de, para) {
  if (!de || !para) return null;
  if (de === para) return 0;
  const hist = t.trecho.get(`${de}|${para}`) ?? t.trecho.get(`${para}|${de}`);
  if (hist != null) return { min: hist, fonte: "historico" };
  const km = idx.dist.get(`${de}|${para}`) ?? idx.dist.get(`${para}|${de}`);
  if (km != null) return { min: km / ((t.kmPorMinFaixa && t.kmPorMinFaixa[faixaKm(km)]) || t.kmPorMin), fonte: "km" };
  // Sem historico nem km cadastrado: distancia entre as coordenadas aprendidas
  // pelo rastreador (linha reta x fator de estrada).
  const a = t.coordenadas && t.coordenadas.get(de), b = t.coordenadas && t.coordenadas.get(para);
  if (a && b) {
    const kmMapa = (distanciaM(a, b) / 1000) * FATOR_ESTRADA;
    return { min: kmMapa / ((t.kmPorMinFaixa && t.kmPorMinFaixa[faixaKm(kmMapa)]) || t.kmPorMin), fonte: "km" };
  }
  return null;
}

const FEITA = ["Entregue", "Entregue com ocorrencia", "Recusada", "Ocorrencia"];
// REGISTRO: registro lancado ou status final. E o que cobra lancamento
// (fechamento, "falta lancar") e fecha a viagem.
const paradaFeita = (p) => !!p.ocorrencia_id || FEITA.includes(p.status);
// GPS viu o caminhao nesta loja (anexarVisitas, back/rastreador-ao-vivo.js).
const visitadaGps = (p) => !!(p && (p.gps_chegou_em || p.gps_saiu_em));
// ROTEIRO: ja passou por ela, com registro OU pelo GPS. Proxima loja, ETA,
// "chegando" e atraso usam esta — o registro chega bem depois da entrega e,
// sem isso, loja ja visitada virava "proxima" (06/10: FKB1D11 "proxima
// N IGUACU III" indo para QUEIMADOS).
const paradaVisitada = (p) => paradaFeita(p) || visitadaGps(p);
// Saida da fabrica: botao "Saiu" (saida_real); sem ele, a do GPS no mesmo dia.
const saidaDe = (v) => {
  const botao = minDe(v.saida_real);
  if (botao != null) return botao;
  const g = v.gps_saida_fabrica_rel;
  return g != null && g >= 0 && g < 1440 ? g : null;
};
// Voltou para a fabrica: botao "Voltou" ou o GPS na fabrica depois das lojas.
const voltouFabrica = (v) => !!(v.retorno_real || v.gps_voltou_fabrica_em);

// ---------------------------------------------------------------- previsao
// Acrescenta: parada.eta, eta_atraso_min, eta_fonte;
//             viagem.retorno_previsto, jornada_prevista_trabalho_min.
function preverViagens(viagens, idx, t, agora = agoraSP()) {
  for (const v of viagens) {
    // Consultas/caches podem enriquecer o mesmo objeto novamente. A previsão
    // antiga nunca sobrevive a uma visita nova ou ao fechamento da viagem.
    for (const p of v.paradas || []) {
      for (const campo of ['eta','eta_em','eta_atraso_min','eta_fonte','eta_passou','eta_dia_seguinte','eta_pernoite',
        'distancia_km','no_local','sem_registro','sem_registro_fonte','gps_na_area_em','gps_na_area_antigo']) delete p[campo];
      if (visitadaGps(p) && !paradaFeita(p)) { p.sem_registro = true; p.sem_registro_fonte = 'gps'; }
      if (v.retorno_real || ['Finalizada','Cancelada'].includes(v.status)) p.gps_no_local = false;
    }
    for (const campo of ['retorno_previsto','retorno_previsto_dia_seguinte','jornada_prevista_trabalho_min',
      'pernoite_previsto','inicio_dia2','_inicio_dia2_min','_inicio_dia2_exato','_agora_rel','saida_fonte']) delete v[campo];
    if (!idx || !t) continue;
    const longa = ehRotaViagem(v.rota_nome);
    const dias = diasEntre(v.data_viagem, agora.data);
    // Viagem de hoje; ou rota de viagem de ontem que segue hoje (pernoite).
    if (!(dias === 0 || (longa && dias >= 1 && dias <= DIAS_CONTINUA))) continue;
    // Sem o botao "Saiu", vale a saida que o GPS viu (06/10: as 4 viagens do
    // dia "Planejada" com os caminhoes na rua e nenhuma previsao).
    const saida = saidaDe(v);
    if (saida == null || v.retorno_real || ["Finalizada", "Cancelada"].includes(v.status)) continue;
    if (minDe(v.saida_real) == null) v.saida_fonte = "gps";
    // Relogio absoluto desde 00:00 do dia da viagem.
    const agoraRel = dias > 0 ? agora.min + 1440 * dias : agora.min < saida ? agora.min + 1440 : agora.min;
    const rel = (m, diaSeguinte) => (diaSeguinte ? m + 1440 : m < saida ? m + 1440 : m);
    // Hotel registrado no TMS (🏨) manda; sem ele, estima.
    const hotelChegada = longa ? minDe(v.hotel_chegada) : null;
    const hotelSaida = longa ? minDe(v.hotel_saida) : null;
    let inicioDia2 = hotelSaida != null ? 1440 + hotelSaida : null; // saida do hotel
    let fimDia1 = hotelChegada != null ? rel(hotelChegada, false) : null; // fim do 1o dia
    const hotelExato = hotelSaida != null;
    // Posicao fresca do rastreador (anexada pelo GET /tms/viagens).
    const ultimoGps = v.rastreador;
    const agoraMs = Date.parse(`${agora.data}T00:00:00-03:00`) + agora.min * 60000;
    const sinalValido = ultimoGps && !qualidadeGps.motivoInvalido(ultimoGps, { agora: agoraMs });
    const sinalRecente = sinalValido && !qualidadeGps.motivoInvalido(ultimoGps, { agora: agoraMs, maxIdadeMs: qualidadeGps.RECENTE_MS });
    const fonteSegura = ultimoGps && (ultimoGps.confiavel_eventos !== false || ultimoGps.fonte_motivo === "ultimo_sinal_antigo");
    const gps = sinalRecente && fonteSegura && ultimoGps.estado !== "sem_sinal" ? ultimoGps : null;
    let gpsUsado = false;
    const paradas = [...(v.paradas || [])].sort((a, b) => (a.ordem || 0) - (b.ordem || 0) || a.id - b.id);
    // O registro costuma ser lancado DEPOIS da entrega e nem sempre na ordem:
    // loja pendente ANTES da visitada mais adiantada (registro ou GPS) ja
    // ficou para tras (so falta o registro) — nao entra na previsao nem gera
    // alerta de atraso.
    let ultimaVisitada = -1;
    paradas.forEach((p, i) => { if (paradaVisitada(p)) ultimaVisitada = i; });
    let cursor = saida, pos = FABRICA, quebrou = false;
    paradas.forEach((p, i) => {
      const cod = p.loja_codigo_pes;
      const desc = (cod && t.descarga.get(cod)) || t.descargaGeral;
      if (paradaVisitada(p)) {
        const reg = paradaFeita(p);
        const ds = !!p.ocorrencia_dia_seguinte;
        const saiuReg = reg ? minDe(p.ocorrencia_saida_loja) : null;
        const chegouReg = reg ? minDe(p.ocorrencia_hora_chegada) : null;
        // Horario do registro manda; sem ele, o do GPS (ja em minutos desde a
        // 00:00 do dia da viagem — o 2o dia da pernoite vem com +1440).
        const chegou = chegouReg != null ? rel(chegouReg, ds) : p.gps_chegou_rel ?? null;
        const saiuLoja = saiuReg != null ? rel(saiuReg, ds) : p.gps_saiu_rel ?? null;
        // Esta na loja agora (GPS) e ainda nao saiu: a descarga segue ate pelo
        // menos agora, e o caminhao parte DAQUI para a proxima.
        const areaAtual = cod && t.coordenadas && t.coordenadas.get(cod);
        const aquiAgora = !!p.gps_no_local && saiuReg == null && !!gps && gps.estado === 'parado'
          && (!p.gps_chegou_em || new Date(gps.posicao_em) >= new Date(p.gps_chegou_em))
          && (areaAtual ? qualidadeGps.dentroLugar(gps, areaAtual, true)
            : gps.perto_de?.dentro && gps.perto_de.codigo === cod && !gps.perto_de.ambigua);
        // Um evento aberto de ontem é prova de visita, não de presença agora.
        if (!aquiAgora) p.gps_no_local = false;
        let fim = null;
        if (aquiAgora) {
          fim = Math.max(chegou != null ? chegou + desc : agoraRel, agoraRel);
          p.no_local = true;
          delete p.sem_registro; delete p.sem_registro_fonte;
          gpsUsado = true;
        } else if (saiuLoja != null) fim = saiuLoja;
        else if (chegou != null) fim = chegou + desc;
        else { const tr = tempoTrecho(t, idx, pos, cod); fim = cursor + (tr ? tr.min : 0) + desc; }
        // Passou pela loja (GPS) e o registro nao veio: avisa no card, com a
        // prova do GPS. Enquanto esta la dentro, e "no local", nao cobranca.
        if (!reg && !aquiAgora) { p.sem_registro = true; p.sem_registro_fonte = "gps"; }
        if (!hotelExato && chegou != null && chegou >= 1440) {
          const ini = chegou - 15;
          inicioDia2 = inicioDia2 == null ? ini : Math.min(inicioDia2, ini);
        }
        if (fim < 1440 && hotelChegada == null) fimDia1 = fimDia1 == null ? fim : Math.max(fimDia1, fim);
        cursor = Math.max(cursor, fim);
        pos = cod || pos;
        return;
      }
      if (i < ultimaVisitada) { p.sem_registro = true; return; }
      // O último sinal já pode estar na área da loja, mas ainda com velocidade
      // da chegada. Não projetar uma chegada futura nem inventar uma visita.
      const alvoArea = cod && t.coordenadas && t.coordenadas.get(cod);
      const mesmoDia = sinalValido && new Date(ultimoGps.posicao_em).getTime() >= Date.parse(`${agora.data}T00:00:00-03:00`);
      const areaUnica = alvoArea && sinalValido && [...t.coordenadas.values()]
        .filter(l => qualidadeGps.dentroLugar(ultimoGps, l)).length === 1;
      if (!gpsUsado && mesmoDia && fonteSegura && areaUnica && qualidadeGps.dentroLugar(ultimoGps, alvoArea)
          && (!gps || gps.estado === "movendo")) {
        p.gps_na_area_em = new Date(ultimoGps.posicao_em).toISOString();
        p.gps_na_area_antigo = !gps;
        gpsUsado = true;
        quebrou = true; // Sem parada confirmada, não estimar a saída desta loja.
        return;
      }
      // 1a loja pendente: com GPS, parte de onde o caminhao esta agora.
      if (gps && !gpsUsado && cod && t.coordenadas && t.coordenadas.get(cod)) {
        gpsUsado = true;
        const alvo = t.coordenadas.get(cod);
        const m = distanciaM(gps, alvo);
        let etaGps;
        // "No local" so PARADO: passando na porta (ou ja saindo) a 30 km/h o
        // card dizia "📍 no local agora" com o caminhao indo embora.
        if (areaUnica && qualidadeGps.dentroLugar(gps, alvo) && gps.estado !== "movendo") { etaGps = agoraRel; p.no_local = true; }
        else {
          const km = (m / 1000) * FATOR_ESTRADA;
          const faixa = km < 10 ? 0 : km < 40 ? 1 : km < 80 ? 2 : 3;
          const vel = (t.kmPorMinFaixa && t.kmPorMinFaixa[faixa]) || t.kmPorMin;
          etaGps = agoraRel + km / vel;
          // Rota de viagem parada a noite (ou ja no hotel e sem ter saido): pernoite.
          const descansando = gps.estado === "parado" && (etaGps > PERNOITE_APOS || (hotelChegada != null && hotelSaida == null));
          if (longa && etaGps < 1440 && descansando) {
            if (fimDia1 == null) fimDia1 = cursor;
            etaGps = Math.max(etaGps, 1440 + (hotelSaida ?? PERNOITE_RETOMA));
            p.eta_pernoite = true;
            v.pernoite_previsto = true;
            if (inicioDia2 == null) inicioDia2 = 1440 + PERNOITE_RETOMA;
          }
        }
        p.distancia_km = Math.round(m / 100) / 10;
        if (etaGps < agoraRel) p.eta_passou = true;
        p.eta = hhmm(etaGps);
        p.eta_em = new Date(Date.parse(`${v.data_viagem}T00:00:00-03:00`) + etaGps * 60000).toISOString();
        p.eta_dia_seguinte = etaGps >= 1440;
        p.eta_fonte = "gps";
        const prevista = minDe(p.hora_prevista);
        if (prevista != null) {
          const prevRel = longa
            ? (Math.abs(etaGps - prevista) <= Math.abs(etaGps - (prevista + 1440)) ? prevista : prevista + 1440)
            : prevista < saida - 120 ? prevista + 1440 : prevista;
          p.eta_atraso_min = Math.round(etaGps - prevRel);
        }
        cursor = Math.max(cursor, etaGps) + desc;
        pos = cod;
        quebrou = false;
        return;
      }
      const tr = quebrou ? null : tempoTrecho(t, idx, pos, cod);
      if (!tr) { quebrou = true; return; } // sem como estimar daqui pra frente
      // Sem GPS nao da para saber se "ja devia ter chegado" e atraso ou so
      // registro por lancar: a previsao segue o modelo e marca o caso.
      let eta = cursor + tr.min;
      if (longa && cursor < 1440 && (eta > PERNOITE_APOS || hotelChegada != null || hotelSaida != null)) {
        // Passaria das 20h (ou a equipe ja parou no hotel): dorme na regiao e
        // faz essa loja no dia seguinte, a partir da saida do hotel.
        if (fimDia1 == null) fimDia1 = cursor;
        eta = Math.max(eta, 1440 + (hotelSaida ?? PERNOITE_RETOMA));
        p.eta_pernoite = true;
        v.pernoite_previsto = true;
        if (inicioDia2 == null) inicioDia2 = 1440 + PERNOITE_RETOMA;
      }
      if (eta < agoraRel) p.eta_passou = true;
      p.eta = hhmm(eta);
      p.eta_em = new Date(Date.parse(`${v.data_viagem}T00:00:00-03:00`) + eta * 60000).toISOString();
      p.eta_dia_seguinte = eta >= 1440;
      p.eta_fonte = tr.fonte;
      const prevista = minDe(p.hora_prevista);
      if (prevista != null) {
        let prevRel = prevista < saida - 120 ? prevista + 1440 : prevista;
        // Rota de viagem: o horario previsto vale no dia em que a loja cai.
        if (longa) prevRel = Math.abs(eta - prevista) <= Math.abs(eta - (prevista + 1440)) ? prevista : prevista + 1440;
        p.eta_atraso_min = Math.round(eta - prevRel);
      }
      cursor = eta + desc;
      pos = cod;
    });
    if (!quebrou) {
      const volta = tempoTrecho(t, idx, pos, FABRICA);
      if (volta) {
        const fim = cursor + volta.min;
        v.retorno_previsto = hhmm(fim);
        v.retorno_previsto_dia_seguinte = fim >= 1440;
        // Pernoite: jornada e do dia de HOJE — no 1o dia, da fabrica ate o
        // hotel; no 2o, do hotel ate a volta. Sem pernoite, como antes.
        let ini = saida, ate = fim;
        if (longa && inicioDia2 != null) {
          if (agoraRel >= inicioDia2 - 60) ini = inicioDia2;
          else ate = fimDia1 ?? fim; // 1o dia termina na ultima loja antes do hotel
        }
        v.jornada_prevista_trabalho_min = Math.round(trabalhado(Math.max(0, ate - ini)));
      }
    }
    if (longa && inicioDia2 != null) {
      v.pernoite_previsto = true;
      v.inicio_dia2 = hhmm(inicioDia2);
      v._inicio_dia2_min = inicioDia2;
      v._inicio_dia2_exato = hotelExato;
      v._agora_rel = agoraRel;
    }
  }
  return viagens;
}

// ---------------------------------------------------------------- alertas
// Recebe as viagens de HOJE ja enriquecidas/previstas. Devolve candidatos no
// formato do avaliarAlertas + as chaves vivas (para auto-resolver as outras).
function alertasDoDia(viagens, agora = agoraSP()) {
  const candidatos = [];
  for (const v of viagens) {
    if (v.status === "Cancelada") continue;
    const mot = v.motorista_nome || "motorista";
    const rota = v.rota_nome ? ` (${v.rota_nome})` : "";
    // pend = sem REGISTRO (cobranca/fechamento); aVisitar = nem registro nem
    // GPS (roteiro: pernoite, proxima, atraso).
    const pend = (v.paradas || []).filter((p) => !paradaFeita(p));
    const aVisitar = (v.paradas || []).filter((p) => !paradaVisitada(p));
    const saida = saidaDe(v);
    const longa = ehRotaViagem(v.rota_nome);
    const dias = diasEntre(v.data_viagem, agora.data);

    // Jornada (so enquanto o caminhao nao voltou). Rota de viagem com loja
    // para amanha: a noite e de descanso no hotel (sem alerta) e no 2o dia a
    // jornada conta da saida do hotel, nao da fabrica.
    let inicio = saida, origem = minDe(v.saida_real) != null ? "Saiu" : "Saiu (GPS)", sufixo = "";
    if (longa && aVisitar.length && saida != null) {
      if (dias === 0 && (agora.min >= PERNOITE_APOS || v.hotel_chegada)) inicio = null;
      else if (dias >= 1) {
        const hs = minDe(v.hotel_saida);
        const base = hs != null ? 1440 + hs : v._inicio_dia2_min ?? 1440 + PERNOITE_RETOMA;
        const agoraAbs = agora.min + 1440 * dias;
        inicio = agoraAbs >= base ? base - 1440 * dias : null;
        origem = hs != null ? "Saiu do hotel" : v._inicio_dia2_min != null ? "Saiu do hotel ~" : "Saída do hotel (estimada)";
        sufixo = "-d2";
      }
    }
    if (inicio != null && !voltouFabrica(v) && v.status !== "Finalizada") {
      const corrido = (agora.min - inicio + 1440) % 1440;
      const trab = trabalhado(corrido);
      const limite = hhmm(inicio + TRABALHO_MAX + ALMOCO);
      const semReg = pend.length - aVisitar.length;
      const resto = (aVisitar.length ? ` · ${aVisitar.length} loja(s) a visitar` : "") + (semReg > 0 ? ` · ${semReg} sem registro` : "");
      const nivel = trab >= 720 ? ["12h", "alta", `Passou de 12h de trabalho: ${mot}`]
        : trab >= 690 ? ["11h30", "alta", `Jornada em 11h30: ${mot}`]
        : trab >= 630 ? ["10h30", "media", `Jornada em 10h30: ${mot}`] : null;
      if (nivel) {
        candidatos.push({ chave: `jornada-${v.id}${sufixo}-${nivel[0]}`, tipo: "jornada", severidade: nivel[1], titulo: nivel[2],
          detalhe: `${origem} ${hhmm(inicio)} · limite ${limite} (12h + 1h almoço)${rota}${resto}`, aba: "tms" });
      } else if (v.jornada_prevista_trabalho_min > TRABALHO_MAX) {
        candidatos.push({ chave: `jornada-${v.id}-prevista`, tipo: "jornada", severidade: "media",
          titulo: `Jornada prevista acima de 12h: ${mot}`,
          detalhe: `Retorno previsto ${v.retorno_previsto}${v.retorno_previsto_dia_seguinte && dias === 0 ? " (dia seguinte)" : ""} · ${fmt(v.jornada_prevista_trabalho_min)} de trabalho · limite ${limite}${rota}`, aba: "tms" });
      }
    }

    // Proxima loja (a 1a NAO visitada) com chegada prevista atrasada. Loja que
    // o GPS ja viu nao entra: atraso dela e assunto do registro/OTIF.
    const prox = aVisitar.find((p) => p.eta && !p.no_local);
    if (prox && prox.eta_atraso_min >= ATRASO_ETA_MIN) {
      candidatos.push({ chave: `eta-${prox.id}`, tipo: "eta_atraso", severidade: prox.eta_atraso_min >= 45 ? "alta" : "media",
        titulo: `Vai chegar atrasado: ${prox.loja_nome}`,
        detalhe: `${mot}${rota} · previsão ${prox.eta}${prox.eta_dia_seguinte && dias === 0 ? " (dia seguinte)" : ""}, horário ${String(prox.hora_prevista).slice(0, 5)} (+${prox.eta_atraso_min} min)`,
        aba: "tms" });
    }

    // Fechamento do dia. Rota de viagem no 1o dia: loja pendente e a do dia
    // seguinte (pernoite), nao esquecimento — so cobra a partir do 2o dia.
    // Comecou: botao "Saiu", status, ou o GPS viu sair/passar em loja (sem
    // isso, viagem esquecida em "Planejada" nunca era cobrada as 17h).
    const comecou = saida != null || ["Em rota", "Retorno", "Finalizada"].includes(v.status)
      || (v.paradas || []).some(visitadaGps);
    if (agora.min >= FECHAMENTO_HORA * 60 && comecou && pend.length && !(longa && dias === 0)) {
      const nomes = pend.slice(0, 4).map((p) => p.loja_nome).join(", ") + (pend.length > 4 ? "…" : "");
      candidatos.push({ chave: `fechamento-${v.id}-${agora.data}`, tipo: "fechamento", severidade: "media",
        titulo: `Fechamento: ${pend.length} loja(s) sem registro — ${mot}`, detalhe: `${nomes}${rota}`, aba: "tms" });
    }
  }
  return candidatos;
}

module.exports = { carregarTempos, preverViagens, alertasDoDia, agoraSP, minDe, hhmm,
  paradaFeita, paradaVisitada, visitadaGps, saidaDe };
