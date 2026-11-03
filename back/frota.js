// ================================================================
// frota.js — aba 🛰 Frota (gestao detalhada; o painel "Frota agora" do TMS
// continua como esta). So LE o que o rastreador ja grava:
//   rastreador_aparelhos  -> ultimo sinal de cada aparelho (SRF/T4S)
//   rastreador_posicoes   -> historico de pontos (trajeto, km, paradas)
//   rastreador_eventos_loja -> chegou/saiu de loja e fabrica (rastreador-ao-vivo)
//   loja_coordenadas      -> lojas, fabrica e pontos extras (CSG, filiais)
//   viagens do TMS        -> motorista/rota/andamento do dia
//
//   GET /frota/painel?data=AAAA-MM-DD   -> resumo de cada veiculo no dia
//   GET /frota/trajeto?placa=&data=     -> pontos + paradas + eventos do dia
// ================================================================
const rastreador = require("./rastreador");
const aoVivo = require("./rastreador-ao-vivo");
const { visitasDoDia } = require("./frota-visitas");
const rotasRua = require("./frota-rotas");
const escolha = require("./rastreador-escolha");
const qualidade = require("./gps-precisao");

// Troca a reta entre dois sinais pelo caminho na rua (frota-rotas.js), quando
// ja calculado. pos(p) -> {lat,lng}; lig(p) -> 0/1/2; criar(a, b, [lat,lng],
// fracao do caminho) -> ponto intermediario no formato da lista.
function pelaRua(lista, pos, lig, criar) {
  const out = [];
  lista.forEach((p, i) => {
    if (i > 0 && lig(p) !== 2) {
      const a = lista[i - 1];
      const via = rotasRua.caminho(pos(a), pos(p), lig(p));
      if (via && via.length > 2) {
        const meio = via.slice(1, -1); // as pontas sao (quase) os proprios sinais
        const seq = [pos(a), ...meio.map(([lat, lng]) => ({ lat, lng })), pos(p)];
        const acum = [0];
        for (let j = 1; j < seq.length; j++) acum.push(acum[j - 1] + rotasRua.distM(seq[j - 1], seq[j]));
        const total = acum[acum.length - 1] || 1;
        meio.forEach((ll, j) => out.push(criar(a, p, ll, acum[j + 1] / total)));
      }
    }
    out.push(p);
  });
  return out;
}

const PARADO_KMH = 3;
const PARADA_MIN = 5;          // parada so conta a partir de 5 min
const PARADA_JUNTA_M = 150;    // pontos parados ate 150 m = mesma parada
const NO_LUGAR_M = 250;        // parada a ate 250 m de um lugar conhecido = naquele lugar
const SALTO_KMH = 130;         // trecho que exigiria >130 km/h = salto do GPS (fora do km)
const VEL_EXCESSO = Number(process.env.FROTA_VEL_MAX || 90);
const FEITA = new Set(["Entregue", "Entregue com ocorrencia", "Recusada", "Ocorrencia"]);

const dataOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

// "FKJ8M18 - MERCEDES-BENZ / Accelo 1016 2p (diesel) (E5)" -> "MERCEDES-BENZ / Accelo 1016"
function modeloDoNome(nome) {
  const resto = String(nome || "").split(" - ").slice(1).join(" - ").trim();
  return resto.replace(/\s+\d+p\b.*$/i, "").replace(/\s*\((?:diesel|dies)\).*$/i, "").trim() || null;
}
function tipoDoNome(nome) {
  const n = String(nome || "").toUpperCase();
  if (/\bMOTO\b/.test(n)) return "moto";
  if (/\bONIBUS\b|ÔNIBUS/.test(n)) return "onibus"; // onibus de rota de funcionarios (Sat)
  if (/ONIX|BYD|SONG|GOL\b|HB20|CARRO|SIENA|PALIO|RANGER|CAMINHONETE/.test(n)) return "carro";
  if (/SCUDO|SPRINTER|DAILY|FIORINO|MASTER|DUCATO|KANGOO/.test(n)) return "utilitario";
  return "caminhao";
}

async function pontosDoDia(db, data, placa) {
  const r = await db.query(`
    SELECT fonte, device_id, placa, lat, lng, velocidade, motor, posicao_em
      FROM rastreador_posicoes
     WHERE posicao_em >= ($1::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'
       AND posicao_em <  ($1::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo'
       AND placa IS NOT NULL ${placa ? "AND placa = $2" : ""}
     ORDER BY posicao_em`, placa ? [data, placa] : [data]);
  // ORDER BY so por horario: o indice idx_rastreador_posicoes_em entrega na
  // ordem sem Sort (o agrupamento por placa e feito no JS, mantendo a ordem).
  return r.rows.map((p) => ({ ...p, lat: Number(p.lat), lng: Number(p.lng), velocidade: Number(p.velocidade) || 0, t: new Date(p.posicao_em).getTime() }));
}

// Indice por horario: o painel le o dia inteiro de TODOS os carros a cada
// minuto e o indice (placa, posicao_em) nao serve para isso. Com a retencao de
// 60 dias (rastreador.js) a tabela chega perto de 1 milhao de linhas.
let indice = null;
function garantirIndice(db) {
  if (!indice) {
    indice = db.query("CREATE INDEX IF NOT EXISTS idx_rastreador_posicoes_em ON rastreador_posicoes (posicao_em)")
      .catch((err) => { indice = null; console.warn("[frota] indice por horario:", err.message); });
  }
  return indice;
}

// Trajeto do dia. Prioridade fixa (SRF, Sat, T4S), respeitando a preferida:
// o numero de leituras que chega depois nao troca o desenho do dia inteiro.
// Misturar SRF e T4S ponto a
// ponto faz zigue-zague quando os aparelhos discordam alguns metros. Onde a
// base fica muda por mais de 5 min — inclusive antes do 1o e depois do ultimo
// ponto dela — entram os pontos da outra fonte: vale o rastreador que deu sinal.
const BURACO_MS = 5 * 60 * 1000;
const MARGEM_MS = 30 * 1000;
function escolherTrajeto(pontos, pref, ign) {
  const porFonte = new Map();
  for (const p of pontos) {
    if (!qualidade.coordenadaValida(p) || !Number.isFinite(p.t) || !escolha.aparelhoPermitido(p, escolha.vinculados(p.placa))) continue;
    (porFonte.get(p.fonte) || porFonte.set(p.fonte, []).get(p.fonte)).push(p);
  }
  // Fonte que discorda das outras no dia (aparelho parado em outro lugar) sai.
  for (const f of escolha.fontesDescartadas(porFonte, pref, ign)) porFonte.delete(f);
  const prioridade = f => ({ srf: 0, sat: 1, t4s: 2 })[f] ?? 3;
  const ordem = [...porFonte.entries()].sort((a, b) => ((b[0] === pref) - (a[0] === pref)) || prioridade(a[0]) - prioridade(b[0]) || a[0].localeCompare(b[0]));
  if (!ordem.length) return { fonte: null, lista: [] };
  const [fonte, base] = ordem[0];
  const outras = ordem.slice(1).flatMap(([, l]) => l).sort((a, b) => a.t - b.t);
  if (!outras.length) return { fonte, lista: semSaltos(base) };
  const marcos = [-Infinity, ...base.map((p) => p.t), Infinity];
  const extra = [];
  let j = 0;
  for (let i = 1; i < marcos.length; i++) {
    const de = marcos[i - 1], ate = marcos[i];
    if (ate - de <= BURACO_MS) continue;
    while (j < outras.length && outras[j].t <= de + MARGEM_MS) j++;
    while (j < outras.length && outras[j].t < ate - MARGEM_MS) extra.push(outras[j++]);
  }
  if (!extra.length) return { fonte, lista: semSaltos(base) };
  return {
    fonte: [fonte, ...new Set(extra.map((p) => p.fonte))].join("+"),
    lista: semSaltos(base.concat(extra).sort((a, b) => a.t - b.t)),
  };
}

// Posicao impossivel da plataforma: em 05/10 o T4S mandou o TUO8H06 na Grande
// Sao Paulo e, 3 min depois, na fabrica (335 km). Quebra a lista onde ir de um
// ponto ao outro exigiria >130 km/h; o MAIOR pedaco e a ancora e, a partir
// dele, so ficam os pedacos que se ligam ao anterior em velocidade possivel
// (um ponto falso de 3+ leituras em SP fica de fora, nao so os de 1-2).
// Vale para km, paradas, trajeto, rastro e registro de visitas.
// Uma plataforma pode repetir a mesma coordenada com horario novo e velocidade
// zero enquanto o carro continua andando. Ao retomar o GPS, essa ultima copia
// faria o trecho parecer impossivel e cortaria todo o resto de uma viagem valida.
// Repara apenas quando os vizinhos confirmam a continuidade; pontos distantes
// persistentes continuam passando pela verificacao dos pedacos abaixo.
function repararPicos(lista) {
  const limpos = [];
  for (let i = 0; i < lista.length; i++) {
    const p = lista[i], a = limpos[limpos.length - 1];
    if (a && kmh(a, p) > SALTO_KMH) {
      const prox = lista[i + 1];
      // Sinais separados por 1-2 s amplificam poucos metros de erro do GPS
      // (FKE4G14: 46 m em 1 s). Descarta apenas a leitura intermediaria
      // quando os dois caminhos ate o proximo sinal confirmam continuidade.
      // Sem essa confirmacao, o filtro de saltos continua valendo.
      if (prox && p.t > a.t && rastreador.distanciaM(a, p) <= 100
        && kmh(a, prox) <= SALTO_KMH && kmh(p, prox) <= SALTO_KMH) continue;
      // Ponto fora do percurso seguido de volta ao percurso: rejeita so o pico.
      if (prox && kmh(p, prox) > SALTO_KMH && kmh(a, prox) <= SALTO_KMH) continue;
      const anterior = limpos[limpos.length - 2];
      // A copia parada tem a mesma coordenada da leitura anterior. Remover
      // apenas ela precisa tornar plausiveis a retomada e a leitura seguinte.
      if (anterior && prox && a.velocidade < PARADO_KMH
        && a.t > anterior.t && a.t - anterior.t <= BURACO_MS
        && rastreador.distanciaM(anterior, a) < TREMOR_M
        && kmh(anterior, p) <= SALTO_KMH && kmh(p, prox) <= SALTO_KMH) {
        limpos.pop();
      }
    }
    limpos.push(p);
  }
  return limpos;
}
// Margem espacial fixa: alguns metros de erro entre sinais de 1-3 s
// nao equivalem a uma viagem impossivel. A margem nao aumenta com o tempo.
const INCERTEZA_TRAJETO_M = 60;
function saltoTrajeto(a, b) {
  const dt = b.t - a.t;
  const d = rastreador.distanciaM(a, b);
  return dt <= 0 ? d > INCERTEZA_TRAJETO_M : d > INCERTEZA_TRAJETO_M + dt / 1000 * SALTO_KMH / 3.6;
}
function semSaltos(lista) {
  lista = repararPicos(lista);
  if (lista.length < 2) return lista;
  const pedacos = [[lista[0]]];
  for (let i = 1; i < lista.length; i++) {
    if (saltoTrajeto(lista[i - 1], lista[i])) pedacos.push([]);
    pedacos[pedacos.length - 1].push(lista[i]);
  }
  if (pedacos.length === 1) return lista;
  let ancora = 0;
  pedacos.forEach((p, i) => { if (p.length > pedacos[ancora].length) ancora = i; });
  const ok = new Set([ancora]);
  let fim = pedacos[ancora][pedacos[ancora].length - 1];
  for (let i = ancora + 1; i < pedacos.length; i++) {
    if (!saltoTrajeto(fim, pedacos[i][0])) { ok.add(i); fim = pedacos[i][pedacos[i].length - 1]; }
  }
  let ini = pedacos[ancora][0];
  for (let i = ancora - 1; i >= 0; i--) {
    const p = pedacos[i];
    if (!saltoTrajeto(p[p.length - 1], ini)) { ok.add(i); ini = p[0]; }
  }
  // Um ponto impreciso na borda nao invalida todo o trecho seguinte.
  // Conserva os pedacos ja aceitos e procura continuidade nas duas bordas
  // dos rejeitados. A busca so avanca ate 5 min e exige pelo menos duas
  // leituras coerentes; o trecho precisa ligar aos vizinhos ja confirmados.
  const aceitos = pedacos.map((p, i) => ok.has(i) ? p : []);
  for (let i = 0; i < pedacos.length; i++) {
    if (ok.has(i)) continue;
    const p = pedacos[i];
    let antes = null, depois = null;
    for (let j = i - 1; j >= 0; j--) {
      if (aceitos[j].length) { antes = aceitos[j][aceitos[j].length - 1]; break; }
    }
    for (let j = i + 1; j < aceitos.length; j++) {
      if (aceitos[j].length) { depois = aceitos[j][0]; break; }
    }
    let de = 0, ate = p.length - 1;
    while (antes && de <= ate && saltoTrajeto(antes, p[de])) {
      de++;
      if (de <= ate && p[de].t - p[0].t > BURACO_MS) { de = p.length; break; }
    }
    while (depois && ate >= de && saltoTrajeto(p[ate], depois)) {
      ate--;
      if (ate >= de && p[p.length - 1].t - p[ate].t > BURACO_MS) { ate = -1; break; }
    }
    if (ate - de >= 1) aceitos[i] = p.slice(de, ate + 1);
  }
  return aceitos.flat();
}

// ---------------------------------------------------------------- rastro
// O trajeto do dia enxuto para desenhar no mapa:
//  - tira picos do GPS (ponto que exigiria >130 km/h para ir E para voltar) e
//    o "tremor" do carro parado (ponto parado a menos de 60 m do ultimo que
//    ficou — sem isso a fabrica vira um rabisco);
//  - cada ponto diz como liga ao anterior: 0 = linha cheia; 1 = tracejada
//    (sinal mais espacado que 5 min: passou por ali, o caminho exato nao se
//    sabe — T4S de alguns carros so manda a cada 15 min); 2 = nao liga
//    (buraco > 2 h, ou salto impossivel: ligar seria inventar caminho);
//  - simplifica as retas (Douglas-Peucker, 10 m) dentro dos trechos cheios.
// Formato: [[lat, lng, segundos desde 00:00 do dia, ligacao], ...]
const TREMOR_M = 60;
const TRACEJA_MS = 5 * 60 * 1000;
const CORTA_MS = 2 * 60 * 60 * 1000;
const SIMPLIFICA_M = 10;

function kmh(a, b) {
  const d = rastreador.distanciaM(a, b);
  const dt = (b.t - a.t) / 1000;
  if (dt <= 0) return d > 50 ? Infinity : 0;
  return (d / dt) * 3.6;
}

// Douglas-Peucker iterativo, em metros (projecao local — sobra para uma cidade).
function simplificar(pts, tol) {
  if (pts.length <= 2) return pts;
  const lat0 = (pts[0].lat * Math.PI) / 180;
  const kx = 111320 * Math.cos(lat0), ky = 110540;
  const xy = pts.map((p) => [p.lng * kx, p.lat * ky]);
  const manter = new Uint8Array(pts.length);
  manter[0] = manter[pts.length - 1] = 1;
  // Horarios de chegada/saida precisam sobreviver a simplificacao geometrica.
  const marcos = new Set([0, pts.length - 1]);
  for (let i = 1; i < pts.length; i++) {
    if (Number.isFinite(pts[i-1].velocidade) && Number.isFinite(pts[i].velocidade)
      && (pts[i-1].velocidade < PARADO_KMH) !== (pts[i].velocidade < PARADO_KMH)) {
      marcos.add(i-1); marcos.add(i);
    }
  }
  const fixos = [...marcos].sort((a,b)=>a-b);
  fixos.forEach(i=>{manter[i]=1;});
  const pilha = fixos.slice(1).map((i,k)=>[fixos[k],i]);
  while (pilha.length) {
    const [i, j] = pilha.pop();
    const [x1, y1] = xy[i], [x2, y2] = xy[j];
    const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
    let maior = -1, idx = -1;
    for (let k = i + 1; k < j; k++) {
      const [x, y] = xy[k];
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2));
      const d = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
      if (d > maior) { maior = d; idx = k; }
    }
    if (maior > tol) { manter[idx] = 1; pilha.push([i, idx], [idx, j]); }
  }
  return pts.filter((_, k) => manter[k]);
}

// Rastro que nao sai do patio (todos os pontos a menos de 300 m um do outro)
// nao vai para o mapa: manobra na fabrica so poluiria o desenho.
const RASTRO_MIN_M = 300;

// Pontos sem o tremor do carro parado. tAnt[i] = horario do ultimo sinal
// RECEBIDO antes de limpos[i] (mesmo descartado): o buraco de SINAL se mede
// por ele — medido pelo ultimo ponto que ficou, toda saida de parada parecia
// "sinal espacado" (23 de 27 tracejados de 05/10 eram falsos).
function semTremor(lista) {
  const limpos = [], tAnt = [];
  let tBruto = -Infinity, pendente = null, antesPendente = -Infinity;
  const guardar = (p, anterior) => { limpos.push(p); tAnt.push(anterior); };
  for (const p of lista) {
    if (!Number.isFinite(p.t) || p.t <= tBruto) continue;
    const ult = limpos[limpos.length - 1];
    const repetido = ult && ult.velocidade < PARADO_KMH && p.velocidade < PARADO_KMH
      && p.t - tBruto <= TRACEJA_MS && rastreador.distanciaM(ult, p) < TREMOR_M;
    if (repetido) { pendente = p; antesPendente = tBruto; }
    else {
      // Guarda o ultimo sinal parado: a saida ocorreu depois dele, nao depois
      // do primeiro sinal de uma parada que pode ter durado varias horas.
      if (pendente) guardar(pendente, antesPendente);
      guardar(p, tBruto);
      pendente = null;
    }
    tBruto = p.t;
  }
  if (pendente) guardar(pendente, antesPendente);
  return { limpos, tAnt };
}

// Como cada ponto liga ao anterior: 0 cheia, 1 tracejada (buraco de SINAL
// > 5 min), 2 nao liga (buraco > 2 h, ou salto impossivel).
function ligacao(limpos, tAnt, i) {
  if (i === 0) return 2;
  const a = limpos[i - 1], p = limpos[i];
  if (saltoTrajeto(a, p)) return 2; // sobrou salto entre pedacos
  const dt = p.t - Math.max(a.t, tAnt[i]);
  if (dt > CORTA_MS) return 2;
  return dt > TRACEJA_MS ? 1 : 0;
}

function montarRastro(lista, inicioDiaMs) {
  const { limpos, tAnt } = semTremor(lista);
  if (!limpos.some((p) => rastreador.distanciaM(limpos[0], p) >= RASTRO_MIN_M)) return [];
  // Trechos de linha cheia; entre um e outro, tracejado ou corte.
  const trechos = [];
  let atual = [], ligInicio = 2;
  limpos.forEach((p, i) => {
    if (i === 0) { atual = [p]; return; }
    const lig = ligacao(limpos, tAnt, i);
    if (lig === 0) { atual.push(p); return; }
    trechos.push({ lig: ligInicio, pts: atual });
    atual = [p];
    ligInicio = lig;
  });
  if (atual.length) trechos.push({ lig: ligInicio, pts: atual });
  const r5 = (x) => Math.round(x * 1e5) / 1e5;
  const seg = (t) => Math.round((t - inicioDiaMs) / 1000);
  const out = [];
  for (const tr of trechos) {
    simplificar(tr.pts, SIMPLIFICA_M).forEach((p, k) => out.push([r5(p.lat), r5(p.lng), seg(p.t), k === 0 ? tr.lig : 0]));
  }
  // Entre sinais distantes, o caminho pela rua (o ponto do meio herda a ligacao
  // do trecho: tracejado continua tracejado, mas agora em cima da rua).
  return pelaRua(out, (p) => ({ lat: p[0], lng: p[1] }), (p) => p[3],
    (a, b, ll, f) => [ll[0], ll[1], Math.round(a[2] + (b[2] - a[2]) * f), b[3]]);
}

// 00:00 do dia em Sao Paulo (sem horario de verao desde 2019: -03:00 fixo,
// o mesmo corte que pontosDoDia faz com AT TIME ZONE).
const inicioDoDia = (data) => Date.parse(`${data}T00:00:00-03:00`);

// Lugar mais perto; lojas coladas (<150 m da mais perto, dentro do raio) saem
// juntas no nome ("SANTA CRUZ I / SANTA CRUZ III"), igual ao aviso ao vivo.
function lugarDe(pos, lugares) {
  const perto = lugares.map((l) => ({ l, m: rastreador.distanciaM(pos, l) })).sort((a, b) => a.m - b.m);
  if (!perto.length) return null;
  const [p0] = perto;
  const dentro=perto.filter(x=>qualidade.dentroLugar(pos,x.l));
  const grupo=dentro.length?dentro:[p0];
  return {codigo:grupo[0].l.codigo,nome:grupo.map(x=>x.l.nome || x.l.codigo).join(" / "),m:Math.round(grupo[0].m),dentro:dentro.length>0};
}

// km, tempo rodando/parado, velocidade maxima, excessos e paradas >= 5 min.
function analisar(lista, lugares) {
  const r = { km: 0, pontos: lista.length, primeira: null, ultima: null, movendo_min: 0, parado_min: 0, vel_max: 0, excessos: 0, paradas: [] };
  if (!lista.length) return r;
  r.primeira = lista[0].posicao_em; r.ultima = lista[lista.length - 1].posicao_em;
  // Onde terminou o dia (o mapa usa em dias passados, quando "agora" nao vale).
  r.ultima_pos = [lista[lista.length - 1].lat, lista[lista.length - 1].lng];
  let parada = null;
  const fecharParada = (fimT) => {
    if (!parada) return;
    const min = Math.round((fimT - parada.inicioT) / 60000);
    if (min >= PARADA_MIN) {
      const perto = lugarDe(parada, lugares);
      r.paradas.push({
        lat: parada.lat, lng: parada.lng, inicio: new Date(parada.inicioT).toISOString(), fim: new Date(fimT).toISOString(), min,
        lugar: perto && perto.dentro ? perto.nome : null,
        perto: perto && !perto.dentro ? perto : null,
      });
    }
    parada = null;
  };
  for (let i = 0; i < lista.length; i++) {
    const p = lista[i];
    r.vel_max = Math.max(r.vel_max, p.velocidade);
    if (p.velocidade >= VEL_EXCESSO) r.excessos++;
    const parado = p.velocidade < PARADO_KMH;
    if (i > 0) {
      const a = lista[i - 1];
      const dt = (p.t - a.t) / 60000;
      const d = rastreador.distanciaM(a, p);
      // Tremor do GPS com o carro parado nao e quilometragem.
      const tremor = a.velocidade < PARADO_KMH && p.velocidade < PARADO_KMH && d < TREMOR_M;
      if (!tremor && dt > 0 && dt <= CORTA_MS / 60000 && !saltoTrajeto(a, p)) r.km += d / 1000;
      // O intervalo entre dois pontos conta como o estado do ponto anterior
      // (limitado a 30 min: buraco maior e aparelho sem sinal, nao tempo de uso).
      if (dt > 30) fecharParada(a.t);
      const min = dt > 30 ? 0 : Math.max(0, dt);
      if (a.velocidade < PARADO_KMH) r.parado_min += min; else r.movendo_min += min;
    }
    if (parado) {
      if (parada && rastreador.distanciaM(parada, p) <= PARADA_JUNTA_M) continue;
      fecharParada(p.t);
      parada = { lat: p.lat, lng: p.lng, inicioT: p.t };
    } else {
      // UMA leitura >= 3 km/h no mesmo lugar (GPS parado marca 2-5 km/h as
      // vezes) nao encerra a parada: so 2 seguidas ou sair dos 150 m.
      const proxMove = lista[i + 1] && lista[i + 1].velocidade >= PARADO_KMH;
      if (parada && !proxMove && rastreador.distanciaM(parada, p) <= PARADA_JUNTA_M) continue;
      fecharParada(p.t);
    }
  }
  fecharParada(lista[lista.length - 1].t);
  r.km = Math.round(r.km * 10) / 10;
  r.movendo_min = Math.round(r.movendo_min);
  r.parado_min = Math.round(r.parado_min);
  r.vel_max = Math.round(r.vel_max);
  return r;
}

// Proxima loja e contagens. ROTEIRO: loja que o GPS ja viu conta como
// visitada mesmo sem registro (previsao-tms.paradaVisitada) — antes so o
// registro contava e, em 06/10, o FKB1D11 aparecia "3/12 lojas · proxima:
// N IGUACU III" indo para QUEIMADOS. A proxima e a 1a NAO visitada DEPOIS da
// ultima visitada; as de antes sem visita nem registro sao "puladas". Com o
// caminhao dentro de uma loja agora (GPS), "atual" diz qual.
// paradas_feitas continua = com REGISTRO (cobranca de lancamento).
function resumoViagem(v) {
  if (!v) return null;
  const { paradaFeita, paradaVisitada, visitadaGps } = require("./previsao-tms");
  const paradas = [...(v.paradas || [])].sort((a, b) => (a.ordem || 0) - (b.ordem || 0) || a.id - b.id);
  let ult = -1;
  paradas.forEach((p, i) => { if (paradaVisitada(p)) ult = i; });
  const atual = paradas.find((p) => p.gps_no_local || p.no_local) || null;
  const proxima = paradas.find((p, i) => i > ult && !paradaVisitada(p) && p !== atual) || null;
  const areaSinal = proxima && proxima.gps_na_area_em ? proxima : null;
  return {
    id: v.id, rota: v.rota_nome || null, motorista: v.motorista_nome || null, status: v.status || null,
    saida_real: v.saida_real || null, retorno_real: v.retorno_real || null, continua_pernoite: !!v.continua_pernoite,
    saida_gps: v.gps_saida_fabrica_em || null, voltou_gps: v.gps_voltou_fabrica_em || null,
    paradas_total: paradas.length,
    paradas_feitas: paradas.filter((p) => p.ocorrencia_id || FEITA.has(p.status)).length,
    paradas_visitadas: paradas.filter(paradaVisitada).length,
    proxima: proxima && !areaSinal ? proxima.loja_nome : null,
    atual: atual ? atual.loja_nome : null,
    area_sinal: areaSinal ? areaSinal.loja_nome : null,
    area_sinal_em: areaSinal ? areaSinal.gps_na_area_em : null,
    area_sinal_antigo: areaSinal ? !!areaSinal.gps_na_area_antigo : false,
    // Passou pelo GPS e o registro nao veio (a que esta "atual" ainda nao conta).
    sem_registro: paradas.filter((p) => visitadaGps(p) && !paradaFeita(p) && !p.gps_no_local).map((p) => p.loja_nome),
    // Ficaram para tras sem visita do GPS nem registro (pulou ou o GPS nao viu).
    puladas: paradas.filter((p, i) => i < ult && !paradaVisitada(p)).map((p) => p.loja_nome),
  };
}

function criarRotas({ db, buscarViagensTms, agoraSP }) {
  const hoje = () => agoraSP().data;

  async function lugares() {
    const mapa = await rastreador.coordenadas(db).catch(() => new Map());
    return [...mapa.values()].filter((l) => Number.isFinite(l.lat) && Number.isFinite(l.lng));
  }

  // Mesmo resultado para todo mundo por ~1 min (o rastreador coleta de minuto
  // em minuto): cache curto + pedido em andamento compartilhado. Sem isso,
  // cada aba aberta recalculava o dia inteiro de todos os carros 1-2x/min.
  const cachePainel = new Map();
  const painel = async (req, res) => {
    try {
      const data = dataOk(req.query.data) ? req.query.data : hoje();
      // ?rastro=1: junto de cada veiculo vai o rastro do dia (mapa da aba).
      const comRastro = req.query.rastro === "1";
      const k = `${data}|${comRastro}`;
      const ttl = data === hoje() ? 20000 : 10 * 60000;
      let c = cachePainel.get(k);
      if (!c || Date.now() - c.em > ttl) {
        c = { em: Date.now(), p: montarPainel(data, comRastro) };
        c.p.catch(() => cachePainel.delete(k));
        cachePainel.set(k, c);
        if (cachePainel.size > 6) cachePainel.delete(cachePainel.keys().next().value);
      }
      const corpo = await c.p;
      // Lojas so mudam a cada 10 min (cache do rastreador): quem ja tem a
      // mesma versao recebe sem a lista (~10 KB a menos por chamada).
      res.json(req.query.lugares_v === corpo.lugares_v ? { ...corpo, lugares: undefined } : corpo);
    } catch (err) { res.status(500).json({ error: err.message }); }
  };

  async function montarPainel(data, comRastro) {
    const inicioDia = inicioDoDia(data);
    await garantirIndice(db);
    if (comRastro) await rotasRua.iniciar(db);
    const prefs = await escolha.preferencias(db);
    const [aparelhos, atuais, pontos, lug, viagens, eventos] = await Promise.all([
      db.query("SELECT fonte, device_id, nome, placa, posicao_em, online, motor FROM rastreador_aparelhos ORDER BY placa, fonte"),
      rastreador.posicoesAtuais(db),
      pontosDoDia(db, data),
      lugares(),
      buscarViagensTms(data, { pernoite: true }).catch(() => []),
      aoVivo.listar(db, data).catch(() => []),
    ]);
    const agora = Date.now();
    const porPlaca = new Map();
    const item = (placa) => porPlaca.get(placa) || porPlaca.set(placa, { placa, nomes: [], fontes: [], pontos: [], viagens: [], eventos: 0 }).get(placa);
    for (const a of aparelhos.rows) {
      const it = item(a.placa || `${a.fonte}:${a.device_id}`);
      it.nomes.push({ fonte: a.fonte, nome: a.nome });
      it.fontes.push({
        fonte: a.fonte, posicao_em: a.posicao_em, online: a.online || null, motor: a.motor || null,
        idade_min: a.posicao_em ? Math.round((agora - new Date(a.posicao_em).getTime()) / 60000) : null,
      });
    }
    for (const a of atuais) {
      const k = a.placa || `${a.fonte}:${a.device_id}`; // aparelho sem placa reconhecida
      if (porPlaca.has(k)) item(k).atual = a;
    }
    for (const p of pontos) if (porPlaca.has(p.placa)) item(p.placa).pontos.push(p);
    for (const e of eventos) if (porPlaca.has(e.placa)) item(e.placa).eventos++;
    for (const v of viagens) {
      const p = rastreador.placaMercosul(v.placa);
      if (p && porPlaca.has(p)) item(p).viagens.push(v);
    }

    const veiculos = [...porPlaca.values()].map((it) => {
      // T4S traz o modelo completo; o SRF so "ATEGO". Fica o mais descritivo.
      const nomeT4s = (it.nomes.find((n) => n.fonte === "t4s") || {}).nome;
      const nome = nomeT4s || (it.nomes[0] || {}).nome;
      const traj = escolherTrajeto(it.pontos, prefs[it.placa], escolha.ignoradas(it.placa));
      // Viagem do dia: a que JA SAIU e nao voltou (pernoite no 2o dia) vence a
      // de hoje ainda "Planejada"; depois qualquer aberta; senao a mais recente.
      const aberta = (x) => !x.retorno_real && !["Finalizada", "Cancelada"].includes(x.status);
      // Saiu = botao "Saiu" ou saida da fabrica vista pelo GPS (anexarVisitas).
      const v = it.viagens.find((x) => (x.saida_real || x.gps_saida_fabrica_em) && aberta(x)) || it.viagens.find(aberta) || it.viagens[0];
      return {
        placa: it.placa, modelo: modeloDoNome(nome), tipo: tipoDoNome(nome),
        atual: it.atual || null, fontes: it.fontes,
        dia: { ...analisar(traj.lista, lug), fonte: traj.fonte, eventos: it.eventos },
        viagem: resumoViagem(v), viagens_no_dia: it.viagens.length,
        // Registro de chegada/saida em cada loja/fabrica (frota-visitas.js).
        visitas: visitasDoDia(traj.lista, lug, v || null),
        ...(comRastro ? { rastro: montarRastro(traj.lista, inicioDia) } : {}),
      };
    });
    // No painel so a contagem; a lista de paradas vem no /frota/trajeto.
    veiculos.forEach((v) => { v.dia.paradas_n = v.dia.paradas.length; v.dia.paradas_fora = v.dia.paradas.filter((p) => !p.lugar).length; delete v.dia.paradas; });

    // Volta prevista para a fabrica: quem SAIU da fabrica hoje e ainda nao
    // voltou, com sinal fresco -> tempo de carro (OSRM) da posicao atual ate la.
    const fab = lug.find((l) => l.codigo === "FABRICA");
    if (fab && data === hoje()) {
      for (const v of veiculos) {
        const a = v.atual;
        if (!a || a.estado === "sem_sinal" || !Number.isFinite(a.lat)) continue;
        const fabs = (v.visitas || []).filter((x) => x.fabrica);
        const ultima = fabs[fabs.length - 1];
        if (!ultima || !ultima.saiu || qualidade.dentroLugar(a,fab,true)) continue;
        const t = rotasRua.tempoAte({ lat: a.lat, lng: a.lng }, fab);
        if (t) v.volta = { eta: new Date(Date.now() + t.s * 1000).toISOString(), min: Math.round(t.s / 60), km: Math.round(t.m / 100) / 10, saiu: ultima.saiu };
      }
    }

    const st = rastreador.estado;
    const lugaresV = `${lug.length}:${lug.reduce((h, l) => (h * 31 + Math.round(l.lat * 1e5) + Math.round(l.lng * 1e5) + String(l.nome || "").length) | 0, 7)}`;
    return {
      data, hoje: data === hoje(), gerado_em: new Date().toISOString(), vel_excesso: VEL_EXCESSO,
      dia_inicio: new Date(inicioDia).toISOString(),
      plataformas: {
        srf: { configurado: rastreador.configurado(), ultima_coleta: st.ultima_coleta, erro: st.erro, falhas_seguidas: st.falhas_seguidas, aparelhos: st.aparelhos },
        t4s: { ...st.t4s },
        sat: { ...(st.sat || { configurado: false }) },
      },
      veiculos,
      lugares_v: lugaresV,
      lugares: lug.map((l) => ({ codigo: l.codigo, nome: l.nome, lat: l.lat, lng: l.lng, origem: l.origem })),
    };
  }

  const trajeto = async (req, res) => {
    try {
      const placa = rastreador.placaMercosul(req.query.placa);
      if (!placa) return res.status(400).json({ error: "placa obrigatoria" });
      const data = dataOk(req.query.data) ? req.query.data : hoje();
      await garantirIndice(db);
      const [pontos, lug, eventos] = await Promise.all([
        pontosDoDia(db, data, placa), lugares(),
        aoVivo.listar(db, data).then((l) => l.filter((e) => e.placa === placa)).catch(() => []),
      ]);
      const traj = escolherTrajeto(pontos, (await escolha.preferencias(db))[placa], escolha.ignoradas(placa));
      const an = analisar(traj.lista, lug);
      // Pontos sem o tremor de carro parado (o dia todo parado eram centenas de
      // pontos iguais) e com a mesma ligacao do rastro: [lat, lng, km/h,
      // segundos desde 00:00, ligacao 0 cheia / 1 tracejada / 2 nao liga].
      const inicioDia = inicioDoDia(data);
      const { limpos, tAnt } = semTremor(traj.lista);
      await rotasRua.iniciar(db);
      const pontosBase = limpos.map((p, i) => [Math.round(p.lat * 1e6) / 1e6, Math.round(p.lng * 1e6) / 1e6, Math.round(p.velocidade),
        Math.round((p.t - inicioDia) / 1000), ligacao(limpos, tAnt, i)]);
      res.json({
        placa, data, fonte: traj.fonte, ...an, vel_excesso: VEL_EXCESSO,
        dia_inicio: new Date(inicioDia).toISOString(),
        pontos: pelaRua(pontosBase, (p) => ({ lat: p[0], lng: p[1] }), (p) => p[4],
          (a, b, ll, f) => [ll[0], ll[1], b[2], Math.round(a[3] + (b[3] - a[3]) * f), b[4]]),
        eventos: eventos.slice().reverse(),
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  };

  return { painel, trajeto, invalidarCache: () => cachePainel.clear() };
}

module.exports = {
  criarRotas, analisar, escolherTrajeto, semSaltos, semTremor, montarRastro, simplificar, inicioDoDia, modeloDoNome, tipoDoNome,
  pontosDoDia, lugarDe, resumoViagem, garantirIndice, ligacao, saltoTrajeto, VEL_EXCESSO, PARADO_KMH, NO_LUGAR_M,
};
