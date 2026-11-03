// ================================================================
// frota-calcular-rota.js — km e tempo de um veiculo ate 1 ou mais destinos
// ----------------------------------------------------------------
// Pedido de 06/10/2026: "na Sat, a partir de um veiculo, ela me da os km e o
// tempo para chegar no destino que eu coloquei; da para ter isso no sistema
// e de quebra botar mais de um ponto e calcular tempo e rota?"
//
//   GET /frota/rota?q={json}           calcula (aba Frota -> 🧭 Calcular rota)
//       origem:  {tipo:'placa', placa} | {tipo:'lugar', codigo} | {tipo:'ll', lat, lng, rotulo}
//       destinos: [{tipo:'lugar', codigo} | {tipo:'ll', lat, lng, rotulo}, parada_min?]  (1 a 25)
//       otimizar: melhor ordem (menor tempo) — a origem fica fixa
//       voltar:   termina na fabrica
//       saida:    "HH:MM" (sem ela: agora)
//   GET /frota/rota/veiculos           posicao atual de cada placa + lugares
//   GET /frota/rota/endereco?q=texto   endereco -> coordenadas (Nominatim/OSM)
//
// ROTA pela rua: OSRM (o mesmo roteador do rastro da aba Frota), na mesma
// cadencia de 1 consulta/s. O OSRM e de CARRO e sem transito, entao o TEMPO
// de cada trecho e, nesta ordem:
//   1. historico do trecho (mediana real das nossas entregas, >= 3 vezes);
//   2. km do OSRM / velocidade REAL da nossa frota naquela faixa de distancia
//      (previsao-tms.js: cidade ~12 km/h, estrada mais);
//   3. o tempo do OSRM, se for maior que o 2 (nunca promete menos que um carro).
// PARADA em cada destino: a informada; senao a mediana de descarga da loja;
// senao a media geral; ponto que nao e loja = 0.
// So leitura: nada e gravado. Endereco digitado vai para o Nominatim (OSM);
// o resto (rota) leva so coordenadas.
// ================================================================
const rotasRua = require("./frota-rotas");
const rastreador = require("./rastreador");
const lojasPes = require("./lojas-pes");
const previsaoTms = require("./previsao-tms");

const MAX_DESTINOS = 25;
const FAIXAS_KM = [10, 40, 80, Infinity]; // as mesmas do previsao-tms.js
const faixaKm = (km) => FAIXAS_KM.findIndex((lim) => km < lim);
const PERTO_LUGAR_M = 300; // veiculo a ate 300 m de uma loja/fabrica "esta la"
const NOMINATIM = (process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org").replace(/\/+$/, "");
const GEOCODE = process.env.FROTA_GEOCODE !== "0";

const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });
const numOk = (x) => x !== null && x !== undefined && x !== "" && Number.isFinite(Number(x));
const coordOk = (lat, lng) => numOk(lat) && numOk(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(Number(lat) === 0 && Number(lng) === 0);
const r5 = (x) => Math.round(x * 1e5) / 1e5;
const hhmm = (min) => {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
const minDe = (h) => { const m = String(h || "").match(/^([01]\d|2[0-3]):([0-5]\d)$/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

// ---------------------------------------------------------------- entrada
function validar(b) {
  if (!b || typeof b !== "object") throw erro("Pedido vazio.");
  const ponto = (p, oQue) => {
    if (!p || typeof p !== "object") throw erro(`${oQue}: ponto inválido.`);
    if (p.tipo === "placa") { const placa = rastreador.placaMercosul(p.placa); if (!placa) throw erro(`${oQue}: placa inválida.`); return { tipo: "placa", placa }; }
    if (p.tipo === "lugar") { const codigo = String(p.codigo || "").trim(); if (!codigo) throw erro(`${oQue}: lugar sem código.`); return { tipo: "lugar", codigo }; }
    if (p.tipo === "ll") {
      if (!coordOk(Number(p.lat), Number(p.lng))) throw erro(`${oQue}: coordenadas inválidas.`);
      return { tipo: "ll", lat: Number(p.lat), lng: Number(p.lng), rotulo: String(p.rotulo || "").trim().slice(0, 120) || null };
    }
    throw erro(`${oQue}: tipo de ponto desconhecido.`);
  };
  const destinos = Array.isArray(b.destinos) ? b.destinos : [];
  if (!destinos.length) throw erro("Coloque pelo menos um destino.");
  if (destinos.length > MAX_DESTINOS) throw erro(`No máximo ${MAX_DESTINOS} destinos por cálculo.`);
  const saida = b.saida ? minDe(b.saida) : null;
  if (b.saida && saida == null) throw erro("Horário de saída inválido (use HH:MM).");
  return {
    origem: ponto(b.origem, "Origem"),
    destinos: destinos.map((d, i) => {
      const p = ponto(d, `Destino ${i + 1}`);
      if (p.tipo === "placa") throw erro(`Destino ${i + 1}: destino não pode ser um veículo.`);
      const par = d.parada_min;
      if (numOk(par) && (Number(par) < 0 || Number(par) > 600)) throw erro(`Destino ${i + 1}: parada de 0 a 600 min.`);
      return { ...p, parada_min: numOk(par) ? Math.round(Number(par)) : null };
    }),
    otimizar: !!b.otimizar,
    voltar: !!b.voltar,
    saida,
  };
}

// ---------------------------------------------------------------- tempos
// Tempo de UM trecho (de/para: codigos de lugar quando existem).
function tempoTrecho(t, { de, para, km, minOsrm }) {
  const hist = t && de && para && de !== para ? (t.trecho.get(`${de}|${para}`) ?? t.trecho.get(`${para}|${de}`)) : null;
  if (hist != null) return { min: hist, fonte: "historico" };
  const vel = t && ((t.kmPorMinFaixa && t.kmPorMinFaixa[faixaKm(km)]) || t.kmPorMin);
  const minFrota = vel ? km / vel : null;
  if (minFrota != null && minFrota > minOsrm) return { min: minFrota, fonte: "frota" };
  return { min: minOsrm, fonte: "osrm" };
}
function paradaDe(t, d) {
  if (d.parada_min != null) return { min: d.parada_min, fonte: "informada" };
  if (d.fim || !d.codigo || d.codigo === lojasPes.FABRICA) return { min: 0, fonte: "nenhuma" };
  const hist = t && t.descarga.get(d.codigo);
  if (hist != null) return { min: hist, fonte: "historico" };
  return { min: t ? t.descargaGeral : 30, fonte: "media" };
}

// Monta o resultado a partir das pernas do OSRM (puro: testavel).
//   seq: destinos na ordem final; legs: pernas do OSRM na mesma ordem.
function montar({ origem, seq, legs, t, saidaMin }) {
  let relogio = saidaMin, anterior = origem, km = 0, dirigindo = 0, parado = 0;
  const pontos = seq.map((d, i) => {
    const leg = legs[i] || { distance: 0, duration: 0 };
    const kmT = leg.distance / 1000, minOsrm = leg.duration / 60;
    const tr = tempoTrecho(t, { de: anterior.codigo, para: d.codigo, km: kmT, minOsrm });
    const chegada = relogio + tr.min;
    const par = paradaDe(t, d);
    relogio = chegada + par.min;
    km += kmT; dirigindo += tr.min; parado += par.min;
    anterior = d;
    return {
      ordem: i + 1, rotulo: d.rotulo, codigo: d.codigo || null, lat: d.lat, lng: d.lng, fim: !!d.fim, entrada: d.entrada ?? null,
      trecho_km: Math.round(kmT * 10) / 10, trecho_min: Math.round(tr.min), trecho_fonte: tr.fonte, trecho_min_carro: Math.round(minOsrm),
      chegada: hhmm(chegada), chegada_dia: Math.floor(chegada / 1440), parada_min: Math.round(par.min), parada_fonte: par.fonte,
      saida: hhmm(relogio), saida_dia: Math.floor(relogio / 1440),
    };
  });
  return {
    pontos,
    total: { km: Math.round(km * 10) / 10, dirigindo_min: Math.round(dirigindo), paradas_min: Math.round(parado), total_min: Math.round(relogio - saidaMin),
      saida: hhmm(saidaMin), fim: hhmm(relogio), fim_dia: Math.floor(relogio / 1440) },
  };
}

// ---------------------------------------------------------------- rotas
function criar({ db, agoraSP = previsaoTms.agoraSP }) {
  const memo = new Map(); // url do OSRM -> { em, j } (10 min)
  async function osrm(caminho) {
    const c = memo.get(caminho);
    if (c && Date.now() - c.em < 10 * 60000) return c.j;
    const j = await rotasRua.osrm(caminho);
    if (j && j.code === "Ok") {
      memo.set(caminho, { em: Date.now(), j });
      if (memo.size > 200) memo.delete(memo.keys().next().value);
    }
    return j;
  }

  async function calcular(entrada) {
    const e = validar(entrada);
    const coords = await rastreador.coordenadas(db);
    const lugar = (codigo, oQue) => {
      const l = coords.get(codigo);
      if (!l || !coordOk(l.lat, l.lng)) throw erro(`${oQue}: "${codigo}" não tem coordenada no cadastro.`);
      return { codigo, rotulo: codigo === lojasPes.FABRICA ? "Fábrica" : l.nome || codigo, lat: Number(l.lat), lng: Number(l.lng) };
    };
    const avisos = [];
    const agora = agoraSP();

    let origem;
    if (e.origem.tipo === "placa") {
      const a = (await rastreador.posicoesAtuais(db)).find((x) => x.placa === e.origem.placa);
      if (!a || !coordOk(a.lat, a.lng)) throw erro(`Sem posição do ${e.origem.placa} no rastreador agora.`);
      const idade = Math.round((Date.now() - new Date(a.posicao_em).getTime()) / 60000);
      const perto = rastreador.pertoDe(a, coords);
      origem = { tipo: "placa", placa: e.origem.placa, rotulo: e.origem.placa, lat: Number(a.lat), lng: Number(a.lng),
        posicao_em: a.posicao_em, idade_min: idade, fonte: a.fonte || null, velocidade: Number(a.velocidade) || 0,
        codigo: perto && perto.m <= PERTO_LUGAR_M ? perto.codigo : null, perto: perto || null };
      if (idade > 15) avisos.push(`A posição do ${e.origem.placa} é de ${idade} min atrás (${a.fonte || "rastreador"}): o cálculo parte de onde ele estava.`);
    } else if (e.origem.tipo === "lugar") origem = { tipo: "lugar", ...lugar(e.origem.codigo, "Origem") };
    else origem = { tipo: "ll", codigo: null, rotulo: e.origem.rotulo || "Ponto marcado", lat: e.origem.lat, lng: e.origem.lng };

    const destinos = e.destinos.map((d, i) => ({
      ...(d.tipo === "lugar" ? lugar(d.codigo, `Destino ${i + 1}`) : { codigo: null, rotulo: d.rotulo || `Ponto ${i + 1}`, lat: d.lat, lng: d.lng }),
      parada_min: d.parada_min, entrada: i,
    }));
    if (e.voltar) destinos.push({ ...lugar(lojasPes.FABRICA, "Fábrica"), parada_min: null, fim: true, entrada: null });

    // OSRM: com "melhor ordem", o /trip escolhe a sequencia (origem fixa; com
    // volta, a fabrica fixa no fim). Sem, o /route segue a ordem da lista.
    const cs = [origem, ...destinos].map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
    const livres = destinos.length - (e.voltar ? 1 : 0);
    let ordem = destinos.map((_, i) => i), legs, geo, otimizado = false;
    if (e.otimizar && livres >= 2) {
      const j = await osrm(`/trip/v1/driving/${cs}?source=first&destination=${e.voltar ? "last" : "any"}&roundtrip=false&overview=full&geometries=geojson`);
      if (!j || j.code !== "Ok" || !j.trips || !j.trips[0]) throw erro(j && j.code === "NoTrips" ? "Não achei caminho pela rua ligando todos os pontos." : `Roteador: ${(j && (j.message || j.code)) || "sem resposta"}`, 502);
      const pos = j.waypoints.map((w) => w.waypoint_index);
      ordem = destinos.map((_, i) => i).sort((x, y) => pos[x + 1] - pos[y + 1]);
      legs = j.trips[0].legs; geo = j.trips[0].geometry;
      otimizado = ordem.some((v, i) => v !== i);
    } else {
      const j = await osrm(`/route/v1/driving/${cs}?overview=full&geometries=geojson`);
      if (!j || j.code !== "Ok" || !j.routes || !j.routes[0]) throw erro(j && j.code === "NoRoute" ? "Não achei caminho pela rua entre os pontos." : `Roteador: ${(j && (j.message || j.code)) || "sem resposta"}`, 502);
      legs = j.routes[0].legs; geo = j.routes[0].geometry;
    }

    let t = null;
    try { const idx = await lojasPes.carregarIndice(db); if (idx) t = await previsaoTms.carregarTempos(db, idx); }
    catch (err) { avisos.push("Sem o histórico de tempos agora: usei só o tempo do roteador."); }
    const saidaMin = e.origem.tipo === "placa" || e.saida == null ? agora.min : e.saida;
    const r = montar({ origem, seq: ordem.map((i) => destinos[i]), legs, t, saidaMin });
    const linha = (geo && geo.coordinates ? geo.coordinates : []).map(([lng, lat]) => [r5(lat), r5(lng)]);
    return {
      origem: { tipo: origem.tipo, placa: origem.placa || null, rotulo: origem.rotulo, codigo: origem.codigo || null, lat: origem.lat, lng: origem.lng,
        posicao_em: origem.posicao_em || null, idade_min: origem.idade_min ?? null, fonte: origem.fonte || null, velocidade: origem.velocidade ?? null,
        perto: origem.perto || null },
      ...r,
      otimizado, ordem_entrada: ordem.filter((i) => destinos[i].entrada != null).map((i) => destinos[i].entrada),
      geometria: rotasRua.simplificar(linha, 10),
      velocidades_frota: t ? { cidade: t.kmPorMinFaixa?.[0] ? Math.round(t.kmPorMinFaixa[0] * 60) : null, estrada: t.kmPorMinFaixa?.[3] ? Math.round(t.kmPorMinFaixa[3] * 60) : null } : null,
      avisos,
      calculado_em: new Date().toISOString(),
    };
  }

  // Endereco -> coordenadas (Nominatim/OSM): 1 consulta/s, sem autocompletar
  // (regra do servico: so busca por clique), resultado guardado 1 dia.
  const enderecos = new Map();
  let proximaBusca = 0;
  async function buscarEndereco(texto) {
    if (!GEOCODE) throw erro("Busca de endereço desligada (FROTA_GEOCODE=0).");
    const q = String(texto || "").trim().slice(0, 200);
    if (q.length < 4) throw erro("Digite pelo menos 4 letras do endereço.");
    const k = q.toLowerCase();
    const c = enderecos.get(k);
    if (c && Date.now() - c.em < 86400000) return c.lista;
    const espera = proximaBusca - Date.now();
    proximaBusca = Math.max(Date.now(), proximaBusca) + 1100;
    if (espera > 0) await new Promise((ok) => setTimeout(ok, espera));
    // Vies para o estado do RJ (sem limitar: endereco de fora tambem acha).
    const u = `${NOMINATIM}/search?${new URLSearchParams({ format: "jsonv2", q, countrycodes: "br", limit: "6", "accept-language": "pt-BR", viewbox: "-44.95,-20.70,-40.90,-23.40" })}`;
    const r = await fetch(u, { headers: { "User-Agent": "ControleDeEntrega-Frota/1.0 (calculadora de rota interna)", Accept: "application/json" }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw erro(`Busca de endereço indisponível (HTTP ${r.status}).`, 502);
    const lista = (await r.json()).map((x) => ({ rotulo: String(x.display_name || "").replace(/, Brasil$/, ""), lat: Number(x.lat), lng: Number(x.lon), tipo: x.type || null }))
      .filter((x) => coordOk(x.lat, x.lng));
    enderecos.set(k, { em: Date.now(), lista });
    if (enderecos.size > 500) enderecos.delete(enderecos.keys().next().value);
    return lista;
  }

  async function veiculos() {
    const [atuais, coords] = await Promise.all([rastreador.posicoesAtuais(db), rastreador.coordenadas(db)]);
    const agora = Date.now();
    return {
      veiculos: atuais.filter((a) => a.placa && coordOk(a.lat, a.lng)).map((a) => {
        const perto = rastreador.pertoDe(a, coords);
        return { placa: a.placa, nome: a.nome || null, lat: Number(a.lat), lng: Number(a.lng), velocidade: Number(a.velocidade) || 0, fonte: a.fonte || null,
          idade_min: Math.round((agora - new Date(a.posicao_em).getTime()) / 60000), perto: perto && perto.m <= 1500 ? perto : null };
      }).sort((x, y) => x.placa.localeCompare(y.placa)),
      lugares: [...coords.values()].filter((l) => coordOk(l.lat, l.lng)).map((l) => ({ codigo: l.codigo, nome: l.codigo === lojasPes.FABRICA ? "Fábrica" : l.nome || l.codigo, lat: Number(l.lat), lng: Number(l.lng) }))
        .sort((x, y) => (x.codigo === lojasPes.FABRICA ? -1 : y.codigo === lojasPes.FABRICA ? 1 : String(x.nome).localeCompare(String(y.nome), "pt-BR"))),
    };
  }

  const responder = (fn) => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (err) {
      if (!err.status) console.error("[calcular rota]", err.message);
      res.status(err.status || 500).json({ error: err.message });
    }
  };
  return {
    calcular, buscarEndereco, veiculos,
    rotas: {
      calcular: responder((req) => {
        let b;
        try { b = JSON.parse(String(req.query.q || "")); } catch (_) { throw erro("Pedido inválido."); }
        return calcular(b);
      }),
      endereco: responder((req) => buscarEndereco(req.query.q)),
      veiculos: responder(() => veiculos()),
    },
  };
}

module.exports = { criar, validar, montar, tempoTrecho, paradaDe, MAX_DESTINOS };
