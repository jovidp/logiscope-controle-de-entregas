// ================================================================
// frota-diario.js — RESUMO DIARIO por veiculo + relatorios da aba 🛰 Frota
// (e as tabelas de areas de risco e de manutencao).
// ----------------------------------------------------------------
// Relatorio de 30 dias nao pode reler ~600 mil posicoes a cada clique: cada
// dia vira um resumo por placa (tabela frota_resumo_dia, JSON) calculado uma
// vez. Dia que ja passou: calcula e grava. Hoje: calcula na hora (cache 60 s).
// Os resumos NAO sao apagados com a retencao de 60 dias das posicoes, entao
// o km acumulado para a manutencao continua valendo depois.
//
// Resumo de um veiculo no dia:
//   km, movendo_min, parado_min, vel_max
//   excessos       episodios >= FROTA_VEL_MAX (km/h): hora, pico, local
//   paradas_fora   paradas >= 5 min fora de loja/fabrica (mapa de calor)
//   visitas        chegada/saida em lojas e fabrica (frota-visitas.js)
//   jornada        maior trecho de direcao CONTINUA (pausa < 30 min nao zera)
//   noite          movimento entre 22h e 5h (uso fora do horario)
//   motor_parado   minutos parado com motor LIGADO (so T4S informa ignicao)
//   disponibilidade % do dia com sinal recente, por plataforma (SRF/T4S)
//   horas          minutos por hora em cada estado (rodando/parado/loja/fabrica/sem sinal)
//   viagem         rota/motorista/km previsto do TMS
// ================================================================
const rastreador = require("./rastreador");
const { visitasDoDia } = require("./frota-visitas");

const PAUSA_JORNADA_MIN = 30;        // pausa >= 30 min zera a direcao continua (Lei 13.103)
const JORNADA_MAX_MIN = Number(process.env.FROTA_JORNADA_MAX_MIN || 330); // 5h30
const NOITE_INI = 22, NOITE_FIM = 5;
const SINAL_MIN = 15;                // sinal mais novo que isso = "com sinal"
const GAP_SEM_SINAL_MIN = 20;        // buraco maior que isso conta como "sem sinal"
const TOLERANCIA_ATRASO_MIN = Number(process.env.FROTA_TOLERANCIA_ATRASO_MIN || 15);
const MAX_DIAS = 62;
const CELULA_GRAUS = 0.002;          // ~220 m: celula do mapa de calor

const dataOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const iso = (t) => new Date(t).toISOString();
const r1 = (x) => Math.round(x * 10) / 10;
const somaDias = (data, n) => { const d = new Date(`${data}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function diasEntre(de, ate) {
  const out = [];
  for (let d = de; d <= ate && out.length < MAX_DIAS; d = somaDias(d, 1)) out.push(d);
  return out;
}
const mediana = (l) => { if (!l.length) return null; const s = [...l].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function garantirTabelas(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS frota_resumo_dia (
      data DATE NOT NULL,
      placa TEXT NOT NULL,
      resumo JSONB NOT NULL,
      calculado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (data, placa)
    );
    CREATE TABLE IF NOT EXISTS frota_areas (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'risco',
      pontos JSONB NOT NULL,
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      criado_por TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS frota_manutencao (
      id SERIAL PRIMARY KEY,
      placa TEXT NOT NULL,
      item TEXT NOT NULL,
      a_cada_km NUMERIC NOT NULL,
      desde_data DATE NOT NULL,
      desde_km NUMERIC NOT NULL DEFAULT 0,
      observacao TEXT,
      criado_por TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

// ---------------------------------------------------------------- resumo de 1 veiculo
// lista: trajeto do dia (escolherTrajeto: fontes juntas, sem saltos) em ordem.
// brutos: TODOS os pontos do dia da placa (por fonte) — para a disponibilidade.
function resumoVeiculo({ lista, brutos, lug, viagem, inicioDia, fimMs, frota, ehRotaViagem }) {
  const an = frota.analisar(lista, lug);
  const lim = frota.VEL_EXCESSO;
  const PARADO = frota.PARADO_KMH;
  const minutoDe = (t) => Math.max(0, Math.min(1439, Math.floor((t - inicioDia) / 60000)));
  const horaDe = (t) => Math.floor(((t - inicioDia) % 86400000) / 3600000);

  // Lugar de um ponto parado (com memoria: o mesmo ponto parado nao recalcula).
  let memo = null;
  const lugarDo = (p) => {
    if (memo && rastreador.distanciaM(memo.p, p) < 40) return memo.l;
    const l = frota.lugarDe(p, lug);
    const tipo = !l || l.m > frota.NO_LUGAR_M ? "p" : l.codigo === "FABRICA" ? "f" : "l";
    memo = { p, l: tipo };
    return tipo;
  };

  // Estado minuto a minuto: 0 sem sinal, r rodando, p parado fora, l loja, f fabrica.
  const COD = { r: 1, p: 2, l: 3, f: 4 };
  const minutos = new Uint8Array(1440);
  let jornada = { max: 0, ini: null, fim: null, total: 0 }, trecho = 0, trechoIni = null, pausa = 0;
  let motorParado = 0, motorEp = null;
  const motorEpisodios = [];
  const noite = { min: 0, km: 0, trechos: [] };
  let noiteAtual = null;
  for (let i = 0; i < lista.length; i++) {
    const a = lista[i], b = lista[i + 1];
    const fimT = b ? b.t : Math.min(a.t + 60000, fimMs);
    const dtMin = (fimT - a.t) / 60000;
    const movendo = a.velocidade >= PARADO;
    const est = dtMin > GAP_SEM_SINAL_MIN ? 0 : movendo ? COD.r : COD[lugarDo(a)];
    if (est) for (let m = minutoDe(a.t); m < minutoDe(fimT); m++) minutos[m] = est;
    const dt = Math.min(dtMin, 30);
    // Jornada: direcao continua; pausa curta nao zera, pausa >= 30 min zera.
    if (movendo) {
      if (trechoIni == null) trechoIni = a.t;
      trecho += dt; pausa = 0; jornada.total += dt;
      if (trecho > jornada.max) { jornada.max = trecho; jornada.ini = trechoIni; jornada.fim = fimT; }
    } else {
      pausa += dtMin;
      if (pausa >= PAUSA_JORNADA_MIN) { trecho = 0; trechoIni = null; }
    }
    // Motor ligado parado (T4S): episodios continuos.
    if (!movendo && a.motor === "ligado" && dtMin <= GAP_SEM_SINAL_MIN) {
      motorParado += dt;
      if (!motorEp) { motorEp = { inicio: a.t, min: 0, lat: a.lat, lng: a.lng }; motorEpisodios.push(motorEp); }
      motorEp.min += dt;
    } else motorEp = null;
    // Noite: movimento entre 22h e 5h.
    const h = horaDe(a.t);
    if (movendo && (h >= NOITE_INI || h < NOITE_FIM)) {
      noite.min += dt;
      const km = b ? rastreador.distanciaM(a, b) / 1000 : 0;
      noite.km += km;
      if (!noiteAtual || a.t - noiteAtual.fimT > 30 * 60000) { noiteAtual = { inicio: iso(a.t), fimT: fimT, km: 0, lat: a.lat, lng: a.lng }; noite.trechos.push(noiteAtual); }
      noiteAtual.fimT = fimT; noiteAtual.km += km;
    }
  }
  noite.trechos = noite.trechos.map((x) => ({ inicio: x.inicio, fim: iso(x.fimT), km: r1(x.km), lat: x.lat, lng: x.lng })).filter((x) => x.km >= 0.5);
  noite.km = r1(noite.km); noite.min = Math.round(noite.min);

  // Excessos de velocidade em episodios (leituras seguidas = 1 episodio).
  const excessos = [];
  let ep = null;
  for (const p of lista) {
    if (p.velocidade < lim) { ep = null; continue; }
    if (!ep || p.t - ep.ultT > 3 * 60000) { ep = { em: iso(p.t), vel: Math.round(p.velocidade), lat: p.lat, lng: p.lng, leituras: 0, ultT: p.t }; excessos.push(ep); }
    ep.leituras++; ep.ultT = p.t;
    if (p.velocidade > ep.vel) { ep.vel = Math.round(p.velocidade); ep.lat = p.lat; ep.lng = p.lng; }
  }
  excessos.forEach((e) => delete e.ultT);

  // Disponibilidade: minuto coberto = houve sinal da fonte nos 15 min anteriores.
  const minutosDoDia = Math.max(1, Math.min(1440, Math.ceil((fimMs - inicioDia) / 60000)));
  const disponibilidade = {};
  const porFonte = new Map();
  for (const p of brutos) (porFonte.get(p.fonte) || porFonte.set(p.fonte, new Uint8Array(1440)).get(p.fonte));
  for (const p of brutos) {
    const cob = porFonte.get(p.fonte);
    const m0 = minutoDe(p.t);
    for (let m = m0; m < Math.min(1440, m0 + SINAL_MIN); m++) cob[m] = 1;
  }
  for (const [f, cob] of porFonte) {
    let n = 0;
    for (let m = 0; m < minutosDoDia; m++) n += cob[m];
    disponibilidade[f] = Math.round((n / minutosDoDia) * 100);
  }

  // Horas: minutos de cada estado por hora (so ate "agora" no dia de hoje).
  const horas = [];
  for (let h = 0; h < 24; h++) {
    const c = { r: 0, p: 0, l: 0, f: 0, s: 0 };
    for (let m = h * 60; m < h * 60 + 60; m++) {
      if (m >= minutosDoDia) break;
      const e = minutos[m];
      if (e === 1) c.r++; else if (e === 2) c.p++; else if (e === 3) c.l++; else if (e === 4) c.f++; else c.s++;
    }
    horas.push(c);
  }

  const v = viagem || null;
  return {
    km: an.km, movendo_min: an.movendo_min, parado_min: an.parado_min, vel_max: an.vel_max, pontos: lista.length,
    primeira: an.primeira, ultima: an.ultima,
    excessos,
    paradas_fora: an.paradas.filter((p) => !p.lugar).map((p) => ({ lat: p.lat, lng: p.lng, inicio: p.inicio, fim: p.fim, min: p.min, perto: p.perto ? p.perto.nome : null })),
    paradas_n: an.paradas.length,
    visitas: visitasDoDia(lista, lug, v),
    jornada: { max_continua_min: Math.round(jornada.max), inicio: jornada.ini ? iso(jornada.ini) : null, fim: jornada.fim ? iso(jornada.fim) : null, dirigindo_min: Math.round(jornada.total) },
    noite,
    motor_parado: { min: Math.round(motorParado), episodios: motorEpisodios.filter((e) => e.min >= 5).map((e) => ({ inicio: iso(e.inicio), min: Math.round(e.min), lat: e.lat, lng: e.lng })) },
    disponibilidade,
    horas,
    viagem: v ? {
      id: v.id, rota: v.rota_nome || null, motorista: v.motorista_nome || null, status: v.status || null,
      km_previsto: v.km_previsto_calc != null ? Number(v.km_previsto_calc) : null,
      longa: !!(ehRotaViagem && ehRotaViagem(v.rota_nome)),
    } : null,
  };
}

// ---------------------------------------------------------------- dia inteiro
function criar({ db, buscarViagensTms, agoraSP, ehRotaViagem }) {
  const frota = require("./frota"); // tarde: frota.js tambem exige este modulo
  let tabelas = null;
  const garantir = () => (tabelas || (tabelas = garantirTabelas(db).catch((e) => { tabelas = null; throw e; })));
  const hoje = () => agoraSP().data;
  const cacheHoje = new Map(); // data -> { em, p }

  async function lugares() {
    const mapa = await rastreador.coordenadas(db).catch(() => new Map());
    return [...mapa.values()].filter((l) => Number.isFinite(l.lat) && Number.isFinite(l.lng));
  }

  async function calcularDia(data) {
    const inicioDia = frota.inicioDoDia(data);
    const fimMs = Math.min(Date.now(), inicioDia + 86400000);
    await frota.garantirIndice(db);
    const [pontos, lug, viagens, aparelhos] = await Promise.all([
      frota.pontosDoDia(db, data), lugares(),
      buscarViagensTms(data, { pernoite: true }).catch(() => []),
      db.query("SELECT placa, nome, fonte FROM rastreador_aparelhos"),
    ]);
    // Tipo pelo nome do aparelho (T4S traz o modelo completo): carro de passeio
    // e moto nao fazem entrega — ficam fora do tempo de descarga e pontualidade.
    const tipoDa = new Map();
    for (const a of aparelhos.rows.sort((x, y) => (x.fonte === "t4s") - (y.fonte === "t4s"))) if (a.placa) tipoDa.set(a.placa, frota.tipoDoNome(a.nome));
    const porPlaca = new Map();
    for (const p of pontos) (porPlaca.get(p.placa) || porPlaca.set(p.placa, []).get(p.placa)).push(p);
    const viagensDa = new Map();
    for (const v of viagens) {
      const p = rastreador.placaMercosul(v.placa);
      if (p) (viagensDa.get(p) || viagensDa.set(p, []).get(p)).push(v);
    }
    const out = {};
    const prefs = await require("./rastreador-escolha").preferencias(db);
    for (const [placa, brutos] of porPlaca) {
      const traj = frota.escolherTrajeto(brutos, prefs[placa], require("./rastreador-escolha").ignoradas(placa));
      if (!traj.lista.length) continue;
      const vs = viagensDa.get(placa) || [];
      const aberta = (x) => !x.retorno_real && !["Finalizada", "Cancelada"].includes(x.status);
      const viagem = vs.find((x) => x.saida_real && aberta(x)) || vs.find(aberta) || vs[0] || null;
      out[placa] = { tipo: tipoDa.get(placa) || "caminhao", ...resumoVeiculo({ lista: traj.lista, brutos, lug, viagem, inicioDia, fimMs, frota, ehRotaViagem }) };
    }
    return out;
  }

  // Resumo de um dia: hoje (ao vivo, cache 60 s) ou passado (gravado).
  async function resumoDoDia(data, { forcar = false } = {}) {
    await garantir();
    if (data >= hoje()) {
      const c = cacheHoje.get(data);
      if (c && !forcar && Date.now() - c.em < 60000) return c.p;
      const p = calcularDia(data);
      cacheHoje.clear();
      cacheHoje.set(data, { em: Date.now(), p });
      p.catch(() => cacheHoje.delete(data));
      return p;
    }
    // Passado: vale o gravado se foi calculado DEPOIS do fim do dia.
    const fimDia = frota.inicioDoDia(data) + 86400000;
    const r = await db.query("SELECT placa, resumo, calculado_em FROM frota_resumo_dia WHERE data = $1", [data]);
    if (!forcar && r.rows.length && r.rows.every((x) => new Date(x.calculado_em).getTime() > fimDia + 30 * 60000)) {
      return Object.fromEntries(r.rows.map((x) => [x.placa, x.resumo]));
    }
    const calc = await calcularDia(data);
    for (const [placa, resumo] of Object.entries(calc)) {
      await db.query(`
        INSERT INTO frota_resumo_dia (data, placa, resumo, calculado_em) VALUES ($1, $2, $3, NOW())
        ON CONFLICT (data, placa) DO UPDATE SET resumo = EXCLUDED.resumo, calculado_em = NOW()`,
        [data, placa, JSON.stringify(calc[placa])]);
    }
    // Se as posicoes ja foram apagadas (retencao), fica o que estava gravado.
    if (!Object.keys(calc).length && r.rows.length) return Object.fromEntries(r.rows.map((x) => [x.placa, x.resumo]));
    return calc;
  }

  // Preenche os dias que faltam (ate 60 para tras), devagar, em segundo plano.
  let preenchendo = false;
  async function preencherHistorico() {
    if (preenchendo) return;
    preenchendo = true;
    try {
      await garantir();
      const ate = somaDias(hoje(), -1);
      const de = somaDias(ate, -59);
      const feitos = new Set((await db.query("SELECT DISTINCT to_char(data, 'YYYY-MM-DD') AS d FROM frota_resumo_dia WHERE data BETWEEN $1 AND $2", [de, ate])).rows.map((x) => x.d));
      for (const d of diasEntre(de, ate)) {
        if (feitos.has(d)) continue;
        try { await resumoDoDia(d); } catch (e) { console.warn("[frota-diario]", d, e.message); }
        await new Promise((ok) => setTimeout(ok, 1500));
      }
    } finally { preenchendo = false; }
  }

  // ---------------------------------------------------------------- relatorio
  async function relatorio(de, ate) {
    const dias = diasEntre(de, ate);
    const porDia = [];
    for (const d of dias) porDia.push({ data: d, veiculos: await resumoDoDia(d) });
    const [lug, manut] = await Promise.all([
      lugares(),
      db.query("SELECT id, placa, item, a_cada_km, to_char(desde_data,'YYYY-MM-DD') AS desde_data, desde_km, observacao FROM frota_manutencao ORDER BY placa, item"),
    ]);
    const nomeLugar = new Map(lug.map((l) => [l.codigo, l.nome]));
    const hhmmSP = (t) => new Date(new Date(t).getTime() - 3 * 3600000).toISOString().slice(11, 16);

    const lojas = new Map(), fabrica = new Map(), motoristas = new Map(), placas = new Map();
    const excessos = [], jornadas = [], noites = [], otif = [], kmPrev = [], celulas = new Map();
    const horas = Array.from({ length: 24 }, () => ({ r: 0, p: 0, l: 0, f: 0, s: 0 }));
    let diasComDado = 0;
    const mot = (nome) => {
      const k = nome || "(sem viagem no TMS)";
      return motoristas.get(k) || motoristas.set(k, { motorista: k, dias: 0, km: 0, lojas: 0, tempos_loja: [], no_horario: 0, com_previsto: 0, excessos: 0, jornadas: 0, motor_parado_min: 0, noite_km: 0 }).get(k);
    };
    for (const { data, veiculos } of porDia) {
      const ents = Object.entries(veiculos);
      if (ents.length) diasComDado++;
      for (const [placa, r] of ents) {
        const pl = placas.get(placa) || placas.set(placa, { placa, km: 0, dias: 0, motor_parado_min: 0, disp: { srf: [], t4s: [] }, patio: [] }).get(placa);
        pl.km += r.km || 0;
        if ((r.km || 0) > 1) pl.dias++;
        pl.motor_parado_min += (r.motor_parado && r.motor_parado.min) || 0;
        for (const [f, pct] of Object.entries(r.disponibilidade || {})) (pl.disp[f] || (pl.disp[f] = [])).push(pct);
        const vi = r.viagem || {};
        const m = mot(vi.motorista);
        if ((r.km || 0) > 1 || vi.motorista) m.dias++;
        m.km += r.km || 0;
        m.motor_parado_min += (r.motor_parado && r.motor_parado.min) || 0;
        // Lojas: tempo de descarga (so visita com chegada vista E saida), so de
        // veiculo de entrega (o Onix que passa o dia na loja nao e "descarga").
        const entrega = !r.tipo || r.tipo === "caminhao" || r.tipo === "utilitario";
        for (const x of entrega ? r.visitas || [] : []) {
          if (x.sem_registro) continue;
          const completa = x.chegada_vista && x.saiu && x.min != null && x.min <= 600;
          if (x.fabrica) {
            if (completa) { const f = fabrica.get(placa) || fabrica.set(placa, { placa, tempos: [], passagens: 0 }).get(placa); f.tempos.push(x.min); }
            const f2 = fabrica.get(placa) || fabrica.set(placa, { placa, tempos: [], passagens: 0 }).get(placa);
            if (x.chegada_vista) f2.passagens++;
            continue;
          }
          m.lojas++;
          if (completa) {
            const lj = lojas.get(x.nome) || lojas.set(x.nome, { loja: x.nome, tempos: [], ultima: null, placas: new Set() }).get(x.nome);
            lj.tempos.push(x.min); lj.placas.add(placa);
            if (!lj.ultima || x.chegou > lj.ultima) lj.ultima = x.chegou;
            m.tempos_loja.push(x.min);
          }
          if (x.prevista && x.chegada_vista) {
            const [hh, mm] = String(x.prevista).split(":").map(Number);
            const chegou = hhmmSP(x.chegou).split(":").map(Number);
            const atraso = chegou[0] * 60 + chegou[1] - (hh * 60 + mm);
            const ok = atraso <= TOLERANCIA_ATRASO_MIN;
            m.com_previsto++; if (ok) m.no_horario++;
            otif.push({ data, placa, motorista: vi.motorista || null, loja: x.nome, prevista: x.prevista, chegou: x.chegou, atraso_min: atraso, no_horario: ok });
          }
        }
        for (const e of r.excessos || []) { excessos.push({ data, placa, motorista: vi.motorista || null, ...e }); m.excessos++; }
        const j = r.jornada || {};
        if (j.max_continua_min >= JORNADA_MAX_MIN) { jornadas.push({ data, placa, motorista: vi.motorista || null, ...j }); m.jornadas++; }
        for (const t of (r.noite && r.noite.trechos) || []) { noites.push({ data, placa, motorista: vi.motorista || null, viagem_longa: !!vi.longa, ...t }); m.noite_km += t.km; }
        if (vi.km_previsto) kmPrev.push({ data, placa, motorista: vi.motorista || null, rota: vi.rota, km_previsto: vi.km_previsto, km_real: r.km, diferenca_pct: vi.km_previsto ? Math.round(((r.km - vi.km_previsto) / vi.km_previsto) * 100) : null });
        for (const p of r.paradas_fora || []) {
          const k = `${Math.round(p.lat / CELULA_GRAUS)}:${Math.round(p.lng / CELULA_GRAUS)}`;
          const c = celulas.get(k) || celulas.set(k, { lat: 0, lng: 0, n: 0, min: 0, placas: new Set(), perto: p.perto }).get(k);
          c.lat += p.lat; c.lng += p.lng; c.n++; c.min += p.min; c.placas.add(placa);
        }
        (r.horas || []).forEach((h, i) => { for (const k of Object.keys(horas[i])) horas[i][k] += h[k] || 0; });
      }
    }

    // Manutencao: km desde a data da ultima troca (resumos gravados, sem limite de 60 dias).
    const manutencao = [];
    for (const it of manut.rows) {
      const k = await db.query(`SELECT COALESCE(SUM((resumo->>'km')::numeric), 0) AS km FROM frota_resumo_dia WHERE placa = $1 AND data >= $2::date`, [it.placa, it.desde_data]);
      let km = Number(k.rows[0].km) + Number(it.desde_km || 0);
      if (it.desde_data <= hoje()) {
        const hojeR = (await resumoDoDia(hoje()))[it.placa];
        if (hojeR) km += hojeR.km || 0; // hoje ainda nao esta gravado
      }
      const falta = Number(it.a_cada_km) - km;
      manutencao.push({ ...it, a_cada_km: Number(it.a_cada_km), desde_km: Number(it.desde_km), km_desde: Math.round(km), falta_km: Math.round(falta), situacao: falta <= 0 ? "vencida" : falta <= Number(it.a_cada_km) * 0.1 ? "proxima" : "ok" });
    }

    const n = Math.max(1, diasComDado);
    return {
      de, ate, dias: dias.length, dias_com_dado: diasComDado, tolerancia_atraso_min: TOLERANCIA_ATRASO_MIN, jornada_max_min: JORNADA_MAX_MIN,
      vel_excesso: frota.VEL_EXCESSO,
      lojas: [...lojas.values()].map((l) => ({ loja: l.loja, visitas: l.tempos.length, media_min: Math.round(l.tempos.reduce((s, x) => s + x, 0) / l.tempos.length), mediana_min: Math.round(mediana(l.tempos)), max_min: Math.max(...l.tempos), veiculos: l.placas.size, ultima: l.ultima }))
        .sort((a, b) => b.mediana_min - a.mediana_min),
      fabrica: [...fabrica.values()].filter((f) => f.passagens > 0 || f.tempos.length > 0).map((f) => ({ placa: f.placa, passagens: f.passagens, com_saida: f.tempos.length, media_min: f.tempos.length ? Math.round(f.tempos.reduce((s, x) => s + x, 0) / f.tempos.length) : null, mediana_min: f.tempos.length ? Math.round(mediana(f.tempos)) : null }))
        .sort((a, b) => (b.mediana_min || 0) - (a.mediana_min || 0)),
      otif: { total: otif.length, no_horario: otif.filter((x) => x.no_horario).length, itens: otif.sort((a, b) => b.atraso_min - a.atraso_min).slice(0, 300) },
      motoristas: [...motoristas.values()].map((m) => ({
        motorista: m.motorista, dias: m.dias, km: Math.round(m.km), lojas: m.lojas,
        tempo_medio_loja_min: m.tempos_loja.length ? Math.round(m.tempos_loja.reduce((s, x) => s + x, 0) / m.tempos_loja.length) : null,
        pct_no_horario: m.com_previsto ? Math.round((m.no_horario / m.com_previsto) * 100) : null, com_previsto: m.com_previsto,
        excessos: m.excessos, jornadas_acima: m.jornadas, motor_parado_min: Math.round(m.motor_parado_min), noite_km: r1(m.noite_km),
      })).sort((a, b) => b.km - a.km),
      excessos: excessos.sort((a, b) => b.vel - a.vel).slice(0, 300),
      jornadas: jornadas.sort((a, b) => b.max_continua_min - a.max_continua_min),
      noites: noites.sort((a, b) => b.km - a.km),
      veiculos: [...placas.values()].map((p) => ({
        placa: p.placa, km: Math.round(p.km), dias_rodando: p.dias, motor_parado_min: Math.round(p.motor_parado_min),
        disponibilidade: Object.fromEntries(Object.entries(p.disp).filter(([, l]) => l.length).map(([f, l]) => [f, Math.round(l.reduce((s, x) => s + x, 0) / l.length)])),
      })).sort((a, b) => b.km - a.km),
      km_previsto: kmPrev.sort((a, b) => Math.abs(b.diferenca_pct || 0) - Math.abs(a.diferenca_pct || 0)),
      calor: [...celulas.values()].map((c) => ({ lat: r1(c.lat / c.n * 1e4) / 1e4, lng: r1(c.lng / c.n * 1e4) / 1e4, paradas: c.n, min: Math.round(c.min), veiculos: [...c.placas], perto: c.perto }))
        .sort((a, b) => b.min - a.min).slice(0, 400),
      horas: horas.map((h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, r1(v / 60 / n)]))), // carros (media) em cada estado por hora
      manutencao,
      nome_lugar: Object.fromEntries(nomeLugar),
    };
  }

  // ---------------------------------------------------------------- rotas HTTP
  const usuario = (req) => (req.usuarioLogado && (req.usuarioLogado.nome || req.usuarioLogado.usuario)) || null;
  const rotas = {
    relatorio: async (req, res) => {
      try {
        const h = hoje();
        let ate = dataOk(req.query.ate) ? req.query.ate : h;
        let de = dataOk(req.query.de) ? req.query.de : ate;
        if (ate > h) ate = h;
        if (de > ate) [de, ate] = [ate, de];
        if (diasEntre(de, ate).length >= MAX_DIAS) de = somaDias(ate, -(MAX_DIAS - 1));
        res.json(await relatorio(de, ate));
      } catch (err) { res.status(500).json({ error: err.message }); }
    },
    areas: async (req, res) => {
      try { await garantir(); res.json((await db.query("SELECT id, nome, tipo, pontos, ativo FROM frota_areas WHERE ativo ORDER BY nome")).rows); }
      catch (err) { res.status(500).json({ error: err.message }); }
    },
    criarArea: async (req, res) => {
      try {
        await garantir();
        const nome = String((req.body && req.body.nome) || "").trim().slice(0, 80);
        // corredor/referencia: cerca so para ver no mapa (sem aviso) — back/frota-cercas-srf.js.
        const tipo = ["risco", "proibida", "atencao", "corredor", "referencia"].includes(req.body && req.body.tipo) ? req.body.tipo : "risco";
        const pontos = Array.isArray(req.body && req.body.pontos) ? req.body.pontos
          .map((p) => [Number(p[0]), Number(p[1])]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180).slice(0, 200) : [];
        if (!nome) return res.status(400).json({ error: "Dê um nome para a área." });
        if (pontos.length < 3) return res.status(400).json({ error: "A área precisa de pelo menos 3 pontos." });
        const r = await db.query("INSERT INTO frota_areas (nome, tipo, pontos, criado_por) VALUES ($1, $2, $3, $4) RETURNING id",
          [nome, tipo, JSON.stringify(pontos), usuario(req)]);
        res.json({ ok: true, id: r.rows[0].id });
      } catch (err) { res.status(500).json({ error: err.message }); }
    },
    apagarArea: async (req, res) => {
      try { await garantir(); await db.query("UPDATE frota_areas SET ativo = FALSE WHERE id = $1", [Number(req.params.id)]); res.json({ ok: true }); }
      catch (err) { res.status(500).json({ error: err.message }); }
    },
    manutencao: async (req, res) => {
      try { await garantir(); res.json((await db.query("SELECT id, placa, item, a_cada_km, to_char(desde_data,'YYYY-MM-DD') AS desde_data, desde_km, observacao FROM frota_manutencao ORDER BY placa, item")).rows); }
      catch (err) { res.status(500).json({ error: err.message }); }
    },
    criarManutencao: async (req, res) => {
      try {
        await garantir();
        const b = req.body || {};
        const placa = rastreador.placaMercosul(b.placa);
        const item = String(b.item || "").trim().slice(0, 60);
        const aCada = Number(b.a_cada_km), desdeKm = Number(b.desde_km || 0);
        const desde = dataOk(b.desde_data) ? b.desde_data : hoje();
        if (!placa || !item || !(aCada > 0)) return res.status(400).json({ error: "Informe placa, item e a cada quantos km." });
        const r = await db.query(`INSERT INTO frota_manutencao (placa, item, a_cada_km, desde_data, desde_km, observacao, criado_por)
          VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [placa, item, aCada, desde, Number.isFinite(desdeKm) ? desdeKm : 0, String(b.observacao || "").slice(0, 200) || null, usuario(req)]);
        res.json({ ok: true, id: r.rows[0].id });
      } catch (err) { res.status(500).json({ error: err.message }); }
    },
    // Rastreador fixo por placa (rastreador-escolha.js). Ler: quem ve a aba; gravar: ADM.
    fontePreferida: async (req, res) => {
      try { res.json(await require("./rastreador-escolha").preferencias(db)); }
      catch (err) { res.status(500).json({ error: err.message }); }
    },
    salvarFontePreferida: async (req, res) => {
      try {
        const placa = rastreador.placaMercosul(req.body && req.body.placa);
        const fonte = String((req.body && req.body.fonte) || "").toLowerCase();
        if (!placa) return res.status(400).json({ error: "placa obrigatória" });
        if (fonte && !["srf", "t4s", "sat"].includes(fonte)) return res.status(400).json({ error: "fonte inválida" });
        res.json({ ok: true, preferencias: await require("./rastreador-escolha").salvarPreferencia(db, placa, fonte || null) });
      } catch (err) { res.status(500).json({ error: err.message }); }
    },
    apagarManutencao: async (req, res) => {
      try { await garantir(); await db.query("DELETE FROM frota_manutencao WHERE id = $1", [Number(req.params.id)]); res.json({ ok: true }); }
      catch (err) { res.status(500).json({ error: err.message }); }
    },
  };

  return { resumoDoDia, relatorio, preencherHistorico, rotas, garantir, areasAtivas: async () => { await garantir(); return (await db.query("SELECT id, nome, tipo, pontos FROM frota_areas WHERE ativo AND tipo IN ('risco', 'proibida', 'atencao')")).rows; } };
}

module.exports = { criar, resumoVeiculo, JORNADA_MAX_MIN };
