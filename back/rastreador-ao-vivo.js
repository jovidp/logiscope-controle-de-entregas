// ================================================================
// rastreador-ao-vivo.js — eventos do GPS em tempo real
// ----------------------------------------------------------------
// A cada 10 segundos (iniciado pelo server.js, depois do rastreador.iniciar)
// olha a posicao de cada caminhao (posicoesAtuais: SRF + T4S, a mais recente
// por placa) contra os LUGARES conhecidos (loja_coordenadas: lojas + FABRICA)
// e gera eventos:
//   chegou_loja / saiu_loja        — entrou/saiu do raio de uma loja
//   saiu_fabrica / voltou_fabrica  — idem para a fabrica
//   chegando_loja                  — viagem do TMS com ETA por GPS da proxima
//                                    loja a <= 15 min (1 por parada)
//   hotel                          — rota de viagem parada a noite longe de
//                                    qualquer lugar conhecido (1 por noite)
//
// Funciona pela PLACA, com ou sem viagem no TMS (em 05/10/2026 nao havia
// viagem do dia lancada e mesmo assim os caminhoes rodaram). Com viagem, o
// evento ganha viagem_id/parada_id e o "chegando" usa a ETA da previsao
// (buscarViagensTms ja aplica previsaoTms.preverViagens com o GPS).
//
// Regras (combinadas com quem mantem rastreador.js / previsao-tms.js):
//   - Chegou: dentro de 250 m E parado (< 3 km/h) em 2 leituras SEGUIDAS com
//     posicao nova — sinal parado no transito na porta da loja nao conta.
//     O instante gravado e o da 1a leitura (timestamp real; pernoite ok).
//     Com motor desligado em uma das leituras, aceita intervalo de até 30
//     min e variação de até 50 m, limitada ao raio da área, na mesma loja.
//   - Saiu: passou de 250 m ANDANDO (>= 10 km/h), ou de 400 m em 2 leituras
//     (histerese: nao pisca). O horario e o da PARTIDA (1a leitura depois da
//     ultima parado na loja), nao o de quando ja estava longe.
//   - Lojas a < 150 m uma da outra (Santa Cruz I x II, Campo Grande III x
//     Passeio, Centro I x II, Bangu IV x V, Niteroi II x IV): vale a que esta
//     pendente NESTA viagem, na ordem; sem viagem, nome das duas.
//   - Voltou para a fabrica com o rastreador DORMINDO: aparelho que para de
//     transmitir com o motor desligado (Sat/T4S do FKC2E12 em 06/10: ultimo
//     sinal 15:05 a 550 m da fabrica, chegando a 37 km/h, e mais nada) nunca
//     dava as 2 leituras paradas. Se o ultimo sinal foi CHEGANDO (200+ m mais
//     perto que 10 min antes) a ate 1 km da fabrica e o caminhao ficou mudo
//     10 min, conta como voltou na hora estimada (distancia / velocidade).
//     Se o sinal volta longe, sai um "saiu" normal (o status reabre a viagem
//     que tiver loja nova depois).
//   - 1a vez que o detector ve uma placa (boot), se ja estiver dentro de um
//     lugar, so assume o estado — sem evento (nao inventa "voltou 08:55").
//     Depois de restart, o estado volta do banco (ultimo evento de hoje).
//
// SO REGISTRA E AVISA: nao grava nada em viagem/parada/ocorrencia. Quem
// consome os eventos para preencher horarios e outro modulo.
// Avisos ao vivo vao por SSE com origem 'gps' (o front trata a parte, sem
// disparar o refresh geral de "dados:mudou").
// ================================================================

const qualidade = require("./gps-precisao");
const RAIO_ENTRA_M = 250;
const RAIO_SAI_M = 400;
const JUNTAS_M = 150;
const PARADO_KMH = 3;
const SAIDA_ANDANDO_KMH = 10;
const LEITURAS_CHEGOU = 2;
const CONFIRMA_PARADO_MS = 30 * 60000;
const CONFIRMA_PARADO_DESLOCAMENTO_M = 50;
const CHEGANDO_MIN = Number(process.env.GPS_CHEGANDO_MIN || 15);
const HOTEL_PARADO_MIN = 60;
const HOTEL_LONGE_M = 2000;
const FABRICA = "FABRICA";
const SILENCIO_MIN = Number(process.env.GPS_SILENCIO_FABRICA_MIN || 10);
const SILENCIO_RAIO_M = 1000;
const SILENCIO_CHEGANDO_M = 200;
const SILENCIO_JANELA_MS = 10 * 60000;

function distanciaM(a, b) {
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Hora local de Sao Paulo (0-23) de um instante.
const horaSP = (d) => Number(new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false }).format(d)) % 24;

// ---------------------------------------------------------------- detector
// Puro (sem banco): recebe leituras e devolve eventos. Da para "reprisar" o
// historico de rastreador_posicoes para testar.
function criarDetector({ agora = () => Date.now() } = {}) {
  const porPlaca = new Map();

  function escolherLugar(leitura, lugares, preferidos) {
    const perto = lugares
      .map((l) => ({ l, d: distanciaM(leitura, l) }))
      .filter((x) => qualidade.dentroLugar(leitura,x.l))
      .sort((a, b) => a.d - b.d);
    if (!perto.length) return null;
    const grupo = perto.map(x => x.l);
    if (grupo.length === 1) return grupo[0];
    for (const cod of preferidos || []) {
      const achou = grupo.find((l) => l.codigo === cod);
      if (achou) return {...achou, nome:grupo.map(l=>l.nome || l.codigo).join(" / "),ambigua:grupo.map(l=>l.codigo)};
    }
    return { ...grupo[0], nome: grupo.map((l) => l.nome || l.codigo).join(" / "), ambigua: grupo.map((l) => l.codigo) };
  }

  function lugarMaisPerto(leitura, lugares) {
    let melhor = Infinity;
    for (const l of lugares) melhor = Math.min(melhor, distanciaM(leitura, l));
    return melhor;
  }

  // Só acompanha o ruído na borda de uma área automática e isolada. Uma
  // leitura dentro da área continua obrigatória para iniciar a chegada.
  function naBorda(leitura, lugar, lugares) {
    if (!lugar || lugar.ambigua || lugar.area_personalizada || lugar.ajuste_proximidade
        || qualidade.poligonoValido(lugar.poligono)) return false;
    const raio = qualidade.raioEntrada(lugar);
    return distanciaM(leitura, lugar) <= raio + Math.min(20, raio * .25)
      && !lugares.some(l => l.codigo !== lugar.codigo && qualidade.dentroLugar(leitura, l));
  }

  function confirmarNaBorda(leitura, anterior, candidato, lugares) {
    if (!anterior || !candidato || Number(anterior.velocidade) >= PARADO_KMH
        || !leitura.fonte || leitura.fonte !== anterior.fonte
        || String(leitura.device_id ?? '') !== String(anterior.device_id ?? '')
        || new Date(leitura.posicao_em) - new Date(anterior.posicao_em) > qualidade.RECENTE_MS
        || !qualidade.dentroLugar(anterior, candidato)
        || distanciaM(leitura, anterior) > Math.min(30, qualidade.raioEntrada(candidato) * .5)) return null;
    return naBorda(leitura, candidato, lugares) ? candidato : null;
  }

  // leitura: { placa, lat, lng, velocidade, posicao_em, fonte }
  // ctx: { preferidos: [codigos pendentes na ordem], longa: bool }
  function processar(leitura, lugares, ctx = {}) {
    const ts = new Date(leitura.posicao_em);
    if (!leitura.placa) return [];
    let estadoAnterior=porPlaca.get(leitura.placa);
    const invalida=qualidade.motivoInvalido(leitura,{agora:ctx.agora ?? agora(),maxIdadeMs:ctx.historico?Infinity:(ctx.maxIdadeMs ?? Infinity)});
    if(invalida || (estadoAnterior?.ultimaPos && qualidade.salto(estadoAnterior.ultimaPos,leitura))) {
      if(estadoAnterior) {estadoAnterior.cand=null;estadoAnterior.n=0;estadoAnterior.fora=0;estadoAnterior.partida=null;}
      return [];
    }
    let s = porPlaca.get(leitura.placa);
    const novo = !s;
    if (!s) { s = { dentro: null, desde: null, cand: null, n: 0, candDesde: null, ultimaTs: 0, paradoDesde: null, paradoPos: null, hotelNoite: null }; porPlaca.set(leitura.placa, s); }
    if (ts.getTime() <= s.ultimaTs) return []; // nada novo desde a ultima leitura
    if(s.ultimaTs && ts.getTime()-s.ultimaTs>qualidade.RECENTE_MS) {
      // Motor desligado transmite menos: duas leituras novas no mesmo ponto
      // podem confirmar a visita. Sinal velho/repetido continua rejeitado.
      const anterior = s.ultimaPos;
      const lugar = Number(leitura.velocidade) < PARADO_KMH ? escolherLugar(leitura, lugares, ctx.preferidos) : null;
      const mesmaParada = s.cand && !s.cand.ambigua
        && lugar && !lugar.ambigua && lugar.codigo === s.cand.codigo
        && ts.getTime()-s.ultimaTs <= CONFIRMA_PARADO_MS
        && anterior && Number(anterior.velocidade) < PARADO_KMH
        && ['desligado','ligado'].includes(anterior.motor) && ['desligado','ligado'].includes(leitura.motor)
        && (anterior.motor === 'desligado' || leitura.motor === 'desligado')
        && leitura.fonte && leitura.fonte === anterior.fonte
        && String(leitura.device_id ?? '') === String(anterior.device_id ?? '')
        // Motor desligado espaça sinais e o GPS varia no ponto de descarga.
        // Ambos devem continuar na mesma área; áreas pequenas mantêm seu limite.
        && distanciaM(anterior, leitura) <= Math.min(CONFIRMA_PARADO_DESLOCAMENTO_M, qualidade.raioEntrada(lugar));
      if (mesmaParada) s.candEspacada = true;
      else { s.cand=null;s.n=0;s.candEspacada=false; }
      s.fora=0;s.foraDesde=null;s.partida=null;s.paradoDesde=null;s.paradoPos=null;
    }
    const leituraAnterior = s.ultimaPos;
    s.ultimaTs = ts.getTime();
    s.ultimaPos = {...leitura};
    // Trilha curta (10 min) para saber se estava CHEGANDO quando o sinal sumiu.
    s.trilha = (s.trilha || []).filter((p) => s.ultimaTs - p.t <= SILENCIO_JANELA_MS);
    s.trilha.push({ lat: leitura.lat, lng: leitura.lng, t: s.ultimaTs });
    const eventos = [];
    const base = { placa: leitura.placa, lat: leitura.lat, lng: leitura.lng, fonte: leitura.fonte || null };
    const parado = (Number(leitura.velocidade) || 0) < PARADO_KMH;

    // A primeira posição pode pegar o caminhão já manobrando para sair.
    // Assume o pátio sem inventar uma chegada, para não perder a saída.
    if(novo && !parado) {
      const fab=lugares.find(l=>l.codigo===FABRICA && qualidade.dentroLugar(leitura,l));
      if(fab){s.dentro=fab;s.desde=ts;s.partida=ts;return eventos;}
    }

    // Tempo parado no mesmo ponto (para o hotel).
    if (parado && s.paradoPos && distanciaM(leitura, s.paradoPos) <= JUNTAS_M) {
      // segue parado
    } else if (parado) { s.paradoDesde = ts; s.paradoPos = { lat: leitura.lat, lng: leitura.lng }; }
    else { s.paradoDesde = null; s.paradoPos = null; }

    if (s.dentro) {
      const atual=lugares.find(l=>l.codigo===s.dentro.codigo);
      if(atual) s.dentro={...s.dentro,...atual};
      const d = distanciaM(leitura, s.dentro);
      const dentroEntrada = qualidade.dentroLugar(leitura,s.dentro);
      const dentroSaida = qualidade.dentroLugar(leitura,s.dentro,true);
      // Partida = 1a leitura depois da ULTIMA parado na loja. Antes o horario
      // gravado era o da 1a leitura a 400 m: em 06/10 o FKD3F13 comecou a sair
      // de Caxias Centro 09:17 e o registro dizia 09:23 (Copacabana I +6 min,
      // Santa Cruz em 05/10 +10 min) — o carro na rua e o sistema "na loja".
      if (parado && (dentroEntrada || naBorda(leitura, s.dentro, lugares))) { s.partida = null; }
      else if (!s.partida) s.partida = ts;
      // Confirma a saida: ja passou do raio de chegada ANDANDO (1 leitura
      // basta — quem anda a 10+ km/h fora do raio foi embora), ou passou de
      // 400 m em 2 leituras SEGUIDAS (reserva: GPS oscilando / manobra no
      // patio, visto na fabrica "saiu 09:24, voltou 09:25").
      // Fabrica fica de fora: o patio passa de 250 m e manobra la dentro
      // virava "saiu e voltou" (LTM4C84, 06/10) — la vale so a regra dos 400 m.
      const andandoFora = s.dentro.codigo !== FABRICA && !dentroEntrada && (Number(leitura.velocidade) || 0) >= SAIDA_ANDANDO_KMH;
      if (!dentroSaida || andandoFora) {
        s.fora = (s.fora || 0) + 1;
        if (s.fora === 1) s.foraDesde = ts;
        if (!andandoFora && s.fora < LEITURAS_CHEGOU) return eventos;
        const em = s.partida && s.partida <= s.foraDesde ? s.partida : s.foraDesde;
        const permanencia = Math.round((em - s.desde) / 60000);
        eventos.push({ ...base, tipo: s.dentro.ambigua ? "saiu_local_incerto" : s.dentro.codigo === FABRICA ? "saiu_fabrica" : "saiu_loja", lugar: s.dentro, em, permanencia_min: permanencia });
        s.dentro = null; s.desde = null; s.fora = 0; s.foraDesde = null; s.partida = null;
      } else {
        s.fora = 0; s.foraDesde = null;
        return eventos; // continua no lugar
      }
    }

    const estrito = parado ? escolherLugar(leitura, lugares, ctx.preferidos) : null;
    const borda = parado && !estrito ? confirmarNaBorda(leitura, leituraAnterior, s.cand, lugares) : null;
    const lugar = estrito || borda;
    if (!lugar) { s.cand = null; s.n = 0; }
    else {
      if (s.cand && s.cand.codigo === lugar.codigo) s.n++;
      else { s.cand = lugar; s.n = 1; s.candDesde = ts; s.candEspacada = false; }
      if (novo) { s.dentro = lugar; s.desde = ts; s.cand = null; s.n = 0; return eventos; } // boot: so assume
      if (s.n >= LEITURAS_CHEGOU) {
        s.dentro = s.cand; s.desde = s.candDesde;
        eventos.push({ ...base, tipo: lugar.ambigua ? "local_incerto" : lugar.codigo === FABRICA ? "voltou_fabrica" : "chegou_loja", lugar: s.dentro, em: s.candDesde,
          detalhe: s.candEspacada ? `primeiro sinal na loja; confirmado com sinais espaçados às ${ts.toISOString()}`
            : borda ? `primeiro sinal na loja; confirmado com oscilação na borda da área às ${ts.toISOString()}` : null });
        s.cand = null; s.n = 0;
        return eventos;
      }
    }

    // Hotel: rota de viagem, parada >= 1h a noite (19h-05h), longe de tudo.
    if (ctx.longa && s.paradoDesde && !s.dentro) {
      const min = (ts - s.paradoDesde) / 60000;
      const h = horaSP(ts);
      const noite = `${ts.toISOString().slice(0, 10)}-${h < 12 ? "m" : "n"}`;
      if (min >= HOTEL_PARADO_MIN && (h >= 19 || h < 5) && s.hotelNoite !== noite && lugarMaisPerto(leitura, lugares) > HOTEL_LONGE_M) {
        s.hotelNoite = noite;
        eventos.push({ ...base, tipo: "hotel", lugar: null, em: s.paradoDesde, permanencia_min: Math.round(min) });
      }
    }
    return eventos;
  }

  // Rastreador mudo chegando na fabrica (ver cabecalho). Chamado a cada ciclo
  // para as placas que NAO trouxeram leitura nova.
  function silencioNaFabrica(placa, lugares, agoraMs = agora()) {
    const s = porPlaca.get(placa);
    if (!s || s.dentro || !s.ultimaPos || !s.ultimaTs || s.silencioVisto === s.ultimaTs) return [];
    if (agoraMs - s.ultimaTs < SILENCIO_MIN * 60000) return [];
    const fab = lugares.find((l) => l.codigo === FABRICA);
    if (!fab) return [];
    s.silencioVisto = s.ultimaTs; // avalia 1 vez por ultimo sinal
    const d = distanciaM(s.ultimaPos, fab);
    const antes = (s.trilha || [])[0];
    if (d > SILENCIO_RAIO_M || !antes || distanciaM(antes, fab) - d < SILENCIO_CHEGANDO_M) return [];
    const ms = d / (Math.max(Number(s.ultimaPos.velocidade) || 0, 20) / 3.6) * 1000; // >= 20 km/h no fim
    const em = new Date(s.ultimaTs + Math.min(ms, 5 * 60000));
    s.dentro = fab; s.desde = em; s.cand = null; s.n = 0; s.fora = 0; s.foraDesde = null; s.partida = null;
    return [{ placa, lat: s.ultimaPos.lat, lng: s.ultimaPos.lng, fonte: s.ultimaPos.fonte || null, tipo: "voltou_fabrica", lugar: fab, em,
      detalhe: `sinal parou a ${Math.round(d)} m da fábrica, chegando — rastreador desligou?` }];
  }

  // Estado depois de restart: placa estava dentro de um lugar (ultimo evento).
  function restaurar(placa, lugar, desde) {
    porPlaca.set(placa, { dentro: lugar, desde, cand: null, n: 0, candDesde: null, ultimaTs: 0, paradoDesde: null, paradoPos: null, hotelNoite: null });
  }

  return { processar, restaurar, silencioNaFabrica, estado: porPlaca };
}

// ---------------------------------------------------------------- banco
async function garantirTabela(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS rastreador_eventos_loja (
      id BIGSERIAL PRIMARY KEY,
      placa TEXT NOT NULL,
      tipo TEXT NOT NULL,
      lugar_codigo TEXT, lugar_nome TEXT,
      em TIMESTAMPTZ NOT NULL,
      viagem_id INTEGER, parada_id INTEGER,
      lat DOUBLE PRECISION, lng DOUBLE PRECISION,
      fonte TEXT,
      permanencia_min INTEGER,
      eta TEXT,
      detalhe TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_rastreador_eventos_loja ON rastreador_eventos_loja (placa, tipo, COALESCE(lugar_codigo, ''), em);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_rastreador_eventos_chegando ON rastreador_eventos_loja (parada_id, tipo) WHERE tipo = 'chegando_loja';
    CREATE INDEX IF NOT EXISTS idx_rastreador_eventos_loja_em ON rastreador_eventos_loja (em DESC);
    CREATE INDEX IF NOT EXISTS idx_rastreador_eventos_loja_viagem ON rastreador_eventos_loja (viagem_id);
    CREATE INDEX IF NOT EXISTS idx_rastreador_eventos_loja_parada ON rastreador_eventos_loja (parada_id);
  `);
}

const ROTULO = {
  local_incerto: e => `parado na área de ${e.lugar_nome} — confirme a loja atendida`,
  saiu_local_incerto: e => `saiu da área de ${e.lugar_nome} — loja não confirmada`,
  chegou_loja: (e) => `chegou em ${e.lugar_nome}`,
  saiu_loja: (e) => `saiu de ${e.lugar_nome}${e.permanencia_min != null ? ` (ficou ${e.permanencia_min} min)` : ""}`,
  saiu_fabrica: () => "saiu da fábrica",
  voltou_fabrica: (e) => `voltou para a fábrica${/sinal parou/.test(e.detalhe || "") ? " (hora estimada: o rastreador desligou chegando)" : ""}`,
  chegando_loja: (e) => `chegando em ${e.lugar_nome}${e.eta ? ` ~${e.eta}` : ""}`,
  hotel: (e) => `parou para o pernoite${e.permanencia_min ? ` (parado há ${e.permanencia_min} min)` : ""}`,
};
const frase = (e) => (ROTULO[e.tipo] ? ROTULO[e.tipo](e) : e.tipo);

// ---------------------------------------------------------------- ciclo
function iniciar({ db, rastreador, buscarViagensTms, agoraSP, ehRotaViagem, broadcastEvento, aplicarStatus, recuperarHistorico, intervaloMs = 10000 }) {
  const detector = criarDetector();
  let pronto = false, rodando = false, reprisado = false;
  const pendentesPersistencia=[];

  async function restaurarDoBanco(lugaresPorCodigo) {
    const r = await db.query(`
      SELECT DISTINCT ON (placa) placa, tipo, lugar_codigo, em
        FROM rastreador_eventos_loja
       WHERE em >= NOW() - INTERVAL '36 hours' AND tipo IN ('chegou_loja','saiu_loja','voltou_fabrica','saiu_fabrica')
       ORDER BY placa, em DESC`);
    for (const e of r.rows) {
      if (e.tipo === "chegou_loja" || e.tipo === "voltou_fabrica") {
        const lugar = lugaresPorCodigo.get(e.lugar_codigo);
        if (lugar) detector.restaurar(e.placa, lugar, new Date(e.em));
      }
    }
  }

  // Boot com caminhao DENTRO de uma loja: o detector so "assumia" o lugar e a
  // chegada sumia. Em 06/10/2026 o servidor subiu 8 vezes e o FKD3F13 perdeu
  // as chegadas de Caxias Centro (08:31) e Caxias I (09:49) — o horario nao
  // apareceu no registro. Agora, no 1o ciclo, reprisa as posicoes GRAVADAS de
  // hoje a partir do ultimo evento de cada placa (mesma escolha de fontes do
  // trajeto da aba Frota: aparelho ignorado/discordante fica de fora) e devolve
  // os eventos que ficaram para tras. A leitura ao vivo seguinte ja chega com
  // ultimaTs adiante e nao repete nada.
  async function reprisarHoje(lugares, ctxDe = () => ({})) {
    const frota = require("./frota"); // tarde: frota.js tambem exige este modulo
    const escolha = require("./rastreador-escolha");
    const ult = await db.query(`
      SELECT DISTINCT ON (placa) placa, tipo, em
        FROM rastreador_eventos_loja
       WHERE em >= (date_trunc('day', NOW() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')
         AND tipo IN ('chegou_loja','saiu_loja','voltou_fabrica','saiu_fabrica')
       ORDER BY placa, em DESC`);
    const ultimo = new Map(ult.rows.map((e) => [e.placa, e]));
    const r = await db.query(`
      SELECT placa, fonte, device_id, lat, lng, velocidade, motor, posicao_em
        FROM rastreador_posicoes
       WHERE posicao_em >= (date_trunc('day', NOW() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')
         AND placa IS NOT NULL
       ORDER BY posicao_em`);
    const porPlaca = new Map();
    for (const p of r.rows) {
      if(qualidade.motivoInvalido(p))continue;
      const pt = { ...p, lat: Number(p.lat), lng: Number(p.lng), velocidade: Number(p.velocidade), t: new Date(p.posicao_em).getTime() };
      (porPlaca.get(p.placa) || porPlaca.set(p.placa, []).get(p.placa)).push(pt);
    }
    const prefs = await escolha.preferencias(db);
    const saida = [];
    for (const [placa, pontos] of porPlaca) {
      const u = ultimo.get(placa);
      const desde = u ? new Date(u.em).getTime() : -Infinity;
      // Depois de um "saiu" o carro esta FORA: estado limpo, mas nao "novo"
      // (senao a 1a leitura dentro da proxima loja seria so assumida de novo).
      // Depois de um "chegou" o restaurarDoBanco ja deixou o carro dentro.
      if (u && (u.tipo === "saiu_loja" || u.tipo === "saiu_fabrica") && !detector.estado.has(placa)) detector.restaurar(placa, null, null);
      const lista = frota.escolherTrajeto(pontos, prefs[placa], escolha.ignoradas(placa)).lista.filter((p) => p.t > desde);
      for (const p of lista) {
        for (const e of detector.processar({ placa, lat: p.lat, lng: p.lng, velocidade: p.velocidade, posicao_em: p.posicao_em, fonte: p.fonte, motor: p.motor, device_id: p.device_id }, lugares, {...ctxDe(placa),historico:true})) {
          saida.push(e);
        }
      }
    }
    return saida;
  }

  async function gravar(e) {
    const r = await db.query(`
      INSERT INTO rastreador_eventos_loja (placa, tipo, lugar_codigo, lugar_nome, em, viagem_id, parada_id, lat, lng, fonte, permanencia_min, eta, detalhe)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT DO NOTHING RETURNING id`,
      [e.placa, e.tipo, e.lugar_codigo, e.lugar_nome, e.em, e.viagem_id || null, e.parada_id || null,
        e.lat, e.lng, e.fonte, e.permanencia_min ?? null, e.eta || null, e.detalhe || null]);
    return r.rows[0] ? r.rows[0].id : null;
  }

  async function rodar() {
    if (rodando) return;
    rodando = true;
    try {
      const coords = await rastreador.coordenadas(db);
      const lugares = [...coords.values()].filter((l) => Number.isFinite(l.lat) && Number.isFinite(l.lng));
      if (!lugares.length) return;
      if (!pronto) { await restaurarDoBanco(new Map(lugares.map((l) => [l.codigo, l]))); pronto = true; }

      const agora = agoraSP();
      const [posicoes, viagens] = await Promise.all([
        rastreador.posicoesAtuais(db),
        buscarViagensTms(agora.data, { pernoite: true }).catch(() => []),
      ]);
      // Viagem aberta por placa (a de hoje vence a que continua de ontem).
      const viagemDa = new Map();
      for (const v of viagens) {
        if (v.retorno_real || ["Finalizada", "Cancelada"].includes(v.status)) continue;
        const p = rastreador.placaMercosul(v.placa);
        if (!viagemDa.has(p) || viagemDa.get(p).continua_pernoite) viagemDa.set(p, v);
      }
      // Pendente para ROTEIRO (desempate de lojas coladas e "chegando"): sem
      // registro E sem visita do GPS (anexarVisitas) — nem chegada gravada
      // neste mesmo ciclo, porque a lista de viagens foi lida antes dela.
      // Antes, loja ja visitada e sem registro seguia "preferida" e o
      // "chegando" mirava loja que tinha ficado para tras.
      const visitouAgora = new Set();
      const pendentes = (v) => [...(v.paradas || [])]
        .sort((a, b) => (a.ordem || 0) - (b.ordem || 0) || a.id - b.id)
        .filter((p) => !p.ocorrencia_id && !["Entregue", "Entregue com ocorrencia", "Recusada", "Ocorrencia"].includes(p.status)
          && !p.gps_chegou_em && !p.gps_saiu_em && !visitouAgora.has(p.id));
      const ctxDe = (placa) => {
        const v = viagemDa.get(placa);
        return v ? { preferidos: pendentes(v).map((p) => p.loja_codigo_pes).filter(Boolean), longa: !!(ehRotaViagem && ehRotaViagem(v.rota_nome)) } : {};
      };

      const novos = [];
      const persistirPendentes = async () => {
        while(pendentesPersistencia.length){
          const reg=pendentesPersistencia[0];
          const id=await gravar(reg);
          pendentesPersistencia.shift();
          if ((reg.tipo === "chegou_loja" || reg.tipo === "saiu_loja") && reg.parada_id) visitouAgora.add(reg.parada_id);
          if(id)novos.push(reg);
        }
      };
      const registrar = async (eventos, v) => {
        for (const e of eventos) {
          const viagem=typeof v==='function'?v(e):v;
          const parada = viagem && e.lugar && !e.lugar.ambigua ? (viagem.paradas || []).find((p) => p.loja_codigo_pes === e.lugar.codigo) : null;
          const reg = {
            placa: e.placa, tipo: e.tipo, em: e.em, lat: e.lat, lng: e.lng, fonte: e.fonte,
            lugar_codigo: e.lugar ? e.lugar.codigo : null, lugar_nome: e.lugar ? e.lugar.nome || e.lugar.codigo : null,
            viagem_id: viagem ? viagem.id : null, parada_id: parada ? parada.id : null, permanencia_min: e.permanencia_min,
            detalhe: e.detalhe || (e.lugar && e.lugar.ambigua ? `GPS não separa: ${e.lugar.ambigua.join(", ")}` : null),
            motorista: viagem ? viagem.motorista_nome : null, rota: viagem ? viagem.rota_nome : null,
          };
          pendentesPersistencia.push(reg);
        }
        await persistirPendentes();
      };
      await persistirPendentes();

      // 1o ciclo depois do boot: recupera o que aconteceu com o servidor fora.
      if (!reprisado) {
        try {
          const atrasados = await reprisarHoje(lugares, ctxDe);
          await registrar(atrasados, e=>viagemDa.get(e.placa));
          reprisado = true;
          if (atrasados.length) console.log(`[gps ao vivo] boot: ${atrasados.length} evento(s) recuperado(s) das posições gravadas (${atrasados.map((e) => `${e.placa} ${e.tipo} ${e.lugar ? e.lugar.nome || e.lugar.codigo : ""}`).join("; ")})`);
        } catch (err) {
          console.error("[gps ao vivo] reprise do boot falhou:", err.message);
        }
      }

      for (const a of posicoes) {
        if (a.estado === "sem_sinal" || a.confiavel_eventos === false || qualidade.motivoInvalido(a,{maxIdadeMs:qualidade.RECENTE_MS})) continue;
        const v = viagemDa.get(a.placa);
        await registrar(detector.processar(a, lugares, {...ctxDe(a.placa),maxIdadeMs:qualidade.RECENTE_MS}), v);
      }
      // Rastreador que dormiu chegando na fabrica (motor desligado).
      for (const placa of [...detector.estado.keys()]) {
        await registrar(detector.silencioNaFabrica(placa, lugares, Date.now()), viagemDa.get(placa));
      }

      // Chegando: ETA por GPS da proxima loja pendente a <= CHEGANDO_MIN.
      for (const v of viagemDa.values()) {
        const prox = pendentes(v).find((p) => p.eta_fonte === "gps");
        if (!prox || prox.no_local || !prox.eta || prox.eta_dia_seguinte) continue;
        const m = String(prox.eta).match(/^(\d{2}):(\d{2})/);
        if (!m) continue;
        const faltam = Number(m[1]) * 60 + Number(m[2]) - agora.min;
        if (faltam < 0 || faltam > CHEGANDO_MIN) continue;
        const pos = v.rastreador || {};
        const reg = {
          placa: rastreador.placaMercosul(v.placa), tipo: "chegando_loja", em: new Date(),
          lat: pos.lat, lng: pos.lng, fonte: pos.fonte || null,
          lugar_codigo: prox.loja_codigo_pes, lugar_nome: prox.loja_nome || prox.loja_codigo_pes,
          viagem_id: v.id, parada_id: prox.id, eta: prox.eta,
          detalhe: prox.distancia_km != null ? `${prox.distancia_km} km` : null,
          motorista: v.motorista_nome, rota: v.rota_nome,
        };
        if (await gravar(reg)) novos.push(reg);
      }

      for (const e of novos) {
        try {
          broadcastEvento("gps", {
            tipo: e.tipo, placa: e.placa, lugar: e.lugar_nome, em: e.em, eta: e.eta || null,
            motorista: e.motorista || null, rota: e.rota || null, texto: `${e.placa} ${frase(e)}`,
          });
        } catch (_) {}
      }
      // Depois de persistir os eventos, avanca o status no mesmo ciclo.
      if (aplicarStatus) await aplicarStatus(viagens);
      // Consulta independente: o relatório da T4S não bloqueia a coleta ao vivo.
      if (recuperarHistorico) recuperarHistorico(viagens).catch(err=>console.error('[gps histórico]',err.message));
    } catch (err) {
      console.error("[gps ao vivo]", err.message);
    } finally {
      rodando = false;
    }
  }

  setTimeout(rodar, 20000); // depois da 1a coleta do rastreador
  setInterval(rodar, intervaloMs);
  console.log(`[gps ao vivo] eventos de loja/fabrica a cada ${Math.round(intervaloMs / 1000)}s`);
  return { rodar, detector };
}

// ---------------------------------------------------------------- visitas por parada
// O GPS ja sabe por quais lojas o caminhao passou, mas o TMS so via "feita"
// quando o REGISTRO era lancado — e o registro chega bem depois e nem sempre
// na ordem. Em 06/10/2026 o FKB1D11 ja tinha passado por N IGUACU III, TOP e
// N IGUACU II, tudo "Pendente", e a aba Frota dizia "proxima: N IGUACU III"
// com o caminhao indo para QUEIMADOS (os 4 caminhoes do dia tinham o mesmo).
// Aqui cada parada ganha a visita do GPS (so leitura). Quem usa decide:
//   ROTEIRO (proxima, ETA, chegando, atraso): visitada conta como feita;
//   REGISTRO (status, fechamento, "falta lancar"): continua exigindo registro.
// Campos (rel = minutos desde 00:00 do dia da viagem em SP; 2o dia = +1440):
//   parada.gps_chegou_em / gps_saiu_em (ISO), gps_chegou_rel / gps_saiu_rel,
//          gps_no_local (chegou e e o ultimo lugar da viagem: esta la agora);
//   viagem.gps_saida_fabrica_em / _rel (ultima saida da fabrica ANTES da 1a
//          loja — manobra no patio nao conta), gps_voltou_fabrica_em / _rel
//          (volta a fabrica DEPOIS de ter passado em loja), gps_lojas_visitadas.
// Evento sem viagem_id (viagem fechada/inexistente na hora) casa pela placa,
// pelo dia e pelo codigo da loja — so se a placa tiver UMA viagem no dia.
const LETRA_MERCOSUL = "ABCDEFGHIJ";
const placaMercosul = (p) => {
  const x = String(p || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^[A-Z]{3}\d{4}$/.test(x) ? x.slice(0, 4) + LETRA_MERCOSUL[Number(x[4])] + x.slice(5) : x;
};
const inicioDiaSP = (data) => Date.parse(`${String(data).slice(0, 10)}T00:00:00-03:00`);
const hojeSP = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());

async function anexarVisitas(db, viagens, { diasAtras = 3 } = {}) {
  const pernoite = require("./pernoite");
  const limite = inicioDiaSP(hojeSP()) - diasAtras * 86400000;
  const alvo = (viagens || []).filter((v) => v && v.data_viagem && inicioDiaSP(v.data_viagem) >= limite);
  if (!alvo.length) return viagens;
  for (const v of alvo) {
    for (const p of v.paradas || []) for (const campo of ['gps_chegou_em','gps_saiu_em','gps_chegou_rel',
      'gps_saiu_rel','gps_chegada_detalhe','gps_no_local']) delete p[campo];
    for (const campo of ['gps_saida_fabrica_em','gps_saida_fabrica_rel','gps_voltou_fabrica_em',
      'gps_voltou_fabrica_rel','gps_lojas_visitadas']) delete v[campo];
  }
  const ids = alvo.map((v) => v.id);
  const placas = [...new Set(alvo.map((v) => placaMercosul(v.placa)).filter(Boolean))];
  const desde = alvo.map((v) => String(v.data_viagem).slice(0, 10)).sort()[0];
  const r = await db.query(`
    SELECT placa, tipo, lugar_codigo, em, viagem_id, parada_id, fonte, detalhe
      FROM rastreador_eventos_loja
     WHERE tipo IN ('chegou_loja','saiu_loja','saiu_fabrica','voltou_fabrica')
       AND (viagem_id = ANY($1::int[]) OR (viagem_id IS NULL AND placa = ANY($2::text[])))
       AND em >= ($3::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'
     ORDER BY em`, [ids, placas, desde]);
  r.rows = r.rows.filter(e => !e.fonte || !require("./rastreador-escolha").ignoradas(e.placa).has(e.fonte));
  const cods = [...new Set(r.rows.map((e) => e.lugar_codigo).filter(Boolean).concat("FABRICA"))];
  const coords = new Map((await db.query("SELECT codigo, lat, lng FROM loja_coordenadas WHERE codigo = ANY($1::text[])", [cods])).rows
    .map((c) => [c.codigo, { lat: Number(c.lat), lng: Number(c.lng) }]));

  // Janela de cada viagem (dia dela; rota de viagem + os dias de pernoite) e
  // quantas viagens a placa tem em cada dia (2+ = evento sem dono nao casa).
  const janela = new Map();
  const viagensDaPlacaNoDia = new Map();
  for (const v of alvo) {
    const ini = inicioDiaSP(v.data_viagem);
    const dias = 1 + (pernoite.ehRotaViagem(v.rota_nome) ? pernoite.DIAS_CONTINUA : 0);
    janela.set(v.id, [ini, ini + dias * 86400000]);
    const k = `${placaMercosul(v.placa)}|${String(v.data_viagem).slice(0, 10)}`;
    viagensDaPlacaNoDia.set(k, (viagensDaPlacaNoDia.get(k) || 0) + 1);
  }
  const porViagem = new Map(alvo.map((v) => [v.id, []]));
  for (const e of r.rows) {
    if (e.viagem_id != null) { if (porViagem.has(e.viagem_id)) porViagem.get(e.viagem_id).push(e); continue; }
    const t = new Date(e.em).getTime();
    const candidatos = alvo.filter((v) => placaMercosul(v.placa) === placaMercosul(e.placa) && t >= janela.get(v.id)[0] && t < janela.get(v.id)[1]);
    const diaEvento = new Intl.DateTimeFormat('en-CA', {timeZone:'America/Sao_Paulo'}).format(new Date(e.em));
    const doDia = candidatos.filter(v => String(v.data_viagem).slice(0, 10) === diaEvento);
    const donos = doDia.length ? doDia : candidatos;
    if (donos.length === 1 && viagensDaPlacaNoDia.get(`${e.placa}|${String(donos[0].data_viagem).slice(0, 10)}`) === 1) porViagem.get(donos[0].id).push(e);
  }

  for (const v of alvo) {
    const ini = inicioDiaSP(v.data_viagem);
    const rel = (em) => Math.round((new Date(em).getTime() - ini) / 60000);
    const paradas = [...(v.paradas || [])].sort((a, b) => (a.ordem || 0) - (b.ordem || 0) || a.id - b.id);
    const porId = new Map(paradas.map((p) => [p.id, p]));
    const evs = porViagem.get(v.id) || [];
    const lojaEvs = evs.filter((e) => e.tipo === "chegou_loja" || e.tipo === "saiu_loja");
    // Parada do evento: a gravada nele (se for desta viagem) ou, pelo codigo
    // da loja, a 1a sem chegada (chegou) / a que esta aberta (saiu).
    const paradaDo = (e) => {
      if (e.parada_id != null && porId.has(e.parada_id)) return porId.get(e.parada_id);
      const mesmas = paradas.filter((p) => p.loja_codigo_pes && p.loja_codigo_pes === e.lugar_codigo);
      if (!mesmas.length) return null;
      if (e.tipo === "chegou_loja") return mesmas.find((p) => !p.gps_chegou_em) || mesmas[mesmas.length - 1];
      return mesmas.find((p) => p.gps_chegou_em && !p.gps_saiu_em) || mesmas.find((p) => !p.gps_saiu_em) || mesmas[0];
    };
    let ultimaLoja = null; // ultimo evento de loja da viagem, mesmo de loja fora do roteiro
    for (const e of lojaEvs) {
      const p = paradaDo(e);
      ultimaLoja = { e, p };
      if (!p) continue;
      if (e.tipo === "chegou_loja") {
        if (!p.gps_chegou_em) { p.gps_chegou_em = new Date(e.em).toISOString(); p.gps_chegou_rel = rel(e.em); p.gps_chegada_detalhe = e.detalhe || null; }
      } else if (!p.gps_saiu_em || new Date(e.em) > new Date(p.gps_saiu_em)) {
        p.gps_saiu_em = new Date(e.em).toISOString(); p.gps_saiu_rel = rel(e.em);
      }
    }
    // Esta na loja agora: o ULTIMO evento de loja da viagem (de qualquer loja)
    // foi "chegou" nesta parada e nada depois (saida/volta da fabrica) o tirou
    // de la. Vale tambem para quem saiu e voltou (Buzios II, 06/10).
    if (ultimaLoja && ultimaLoja.p && ultimaLoja.e.tipo === "chegou_loja"
        && !v.retorno_real && !['Finalizada','Cancelada'].includes(v.status)) {
      const t = new Date(ultimaLoja.e.em).getTime();
      const depois = evs.some((x) => new Date(x.em).getTime() > t && (x.tipo === "voltou_fabrica" || x.tipo === "saiu_fabrica"));
      if (!depois) ultimaLoja.p.gps_no_local = true;
    }
    const tPrimeiraLoja = lojaEvs.length ? new Date(lojaEvs[0].em).getTime() : Infinity;
    const tUltimaLoja = lojaEvs.length ? new Date(lojaEvs[lojaEvs.length - 1].em).getTime() : null;
    // Saida: a ULTIMA saiu_fabrica antes da 1a loja (manobra no patio fica
    // para tras) que ainda DA TEMPO de chegar la — linha reta a 100 km/h e o
    // limite por baixo. Em 06/10 um aparelho largado na fabrica gerou
    // "saiu/voltou" ate 08:21 com o FKC2E12 chegando em Buzios (170 km) 08:36:
    // so a saida das 06:41 e possivel. Sem loja ainda: a ultima sem volta depois.
    const saidas = evs.filter((e) => e.tipo === "saiu_fabrica" && new Date(e.em).getTime() < tPrimeiraLoja);
    const possivel = (s) => {
      if (tPrimeiraLoja === Infinity) return true;
      const a = coords.get("FABRICA"), b = coords.get(lojaEvs[0].lugar_codigo);
      if (!a || !b) return true;
      return tPrimeiraLoja - new Date(s.em).getTime() >= (distanciaM(a, b) / 1000 / 100) * 3600000;
    };
    const plausiveis = saidas.filter(possivel);
    let saida = plausiveis.length ? plausiveis[plausiveis.length - 1] : saidas.length ? saidas[0] : null;
    if (saida && tPrimeiraLoja === Infinity && evs.some((e) => e.tipo === "voltou_fabrica" && new Date(e.em) > new Date(saida.em))) saida = null;
    if (saida) { v.gps_saida_fabrica_em = new Date(saida.em).toISOString(); v.gps_saida_fabrica_rel = rel(saida.em); }
    const volta = tUltimaLoja != null ? evs.find((e) => e.tipo === "voltou_fabrica" && new Date(e.em).getTime() > tUltimaLoja) : null;
    if (volta) { v.gps_voltou_fabrica_em = new Date(volta.em).toISOString(); v.gps_voltou_fabrica_rel = rel(volta.em); }
    v.gps_lojas_visitadas = paradas.filter((p) => p.gps_chegou_em || p.gps_saiu_em).length;
  }
  return viagens;
}

// Lista do dia para a tela.
async function listar(db, dataISO, {placa=null}={}) {
  const r = await db.query(`
    SELECT id, placa, tipo, lugar_codigo, lugar_nome, em, viagem_id, parada_id, fonte, permanencia_min, eta, detalhe
      FROM rastreador_eventos_loja
     WHERE (em AT TIME ZONE 'America/Sao_Paulo')::date = $1::date
       AND ($2::text IS NULL OR placa=$2)
     ORDER BY em DESC LIMIT 500`, [dataISO,placa]);
  return r.rows.map((e) => ({ ...e, texto: `${e.placa} ${frase(e)}` }));
}

module.exports = { criarDetector, garantirTabela, iniciar, listar, frase, distanciaM, anexarVisitas };
