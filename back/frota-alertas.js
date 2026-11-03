// ================================================================
// frota-alertas.js — avisos da frota no sino 🚨 (e Telegram) + resumo do dia.
// ----------------------------------------------------------------
// Entra no motor de alertas do server.js (avaliarAlertas, a cada 3 min) como
// mais uma regra: devolve candidatos { chave, tipo, severidade, titulo,
// detalhe, aba, evento_em }. A chave identifica o FATO (placa + inicio), entao
// o mesmo episodio nunca avisa duas vezes.
//   frota_parada  parado fora de loja/fabrica ha >= FROTA_PARADA_ALERTA_MIN (45)
//   frota_mudo    rastreador sem sinal em todas as plataformas ha >= 2 h (6h-21h)
//   frota_area    dentro de uma area de risco desenhada na aba Frota
//   frota_noite   rodou entre 22h e 5h (fora rota de viagem/pernoite)
//   frota_jornada direcao continua acima de 5h30 (Lei 13.103)
//   frota_motor   parado com motor ligado >= FROTA_MOTOR_LIGADO_MIN (20) (T4S)
//   frota_vel     velocidade >= FROTA_VEL_MAX (90) — so no sino (sem Telegram,
//                 para nao virar spam; FROTA_VEL_TELEGRAM=1 manda tambem)
//   frota_gps_travado  um aparelho manda sinal FRESCO mas a >= 10 km do que as
//                 outras plataformas mostram, por >= 30 min (GPS sem fixacao
//                 repetindo a ultima posicao, ou aparelho fora do caminhao).
//                 Em 06/10 o SRF do FKC2E12 ficou "na fabrica" de 06h a 09:51
//                 com T4S e Sat em Buzios; o "mudo" nao pega (o sinal chega) e a
//                 escolha por maioria so esconde — este aviso e para CONSERTAR.
// "Vivos" (parada, mudo, area, gps travado) se resolvem sozinhos quando deixam de valer.
// Resumo do dia no Telegram as FROTA_RESUMO_HORA (18:00); FROTA_RESUMO_ATIVO=0 desliga.
// ================================================================
const rastreador = require("./rastreador");
const escolha = require("./rastreador-escolha");

const PARADA_MIN = Number(process.env.FROTA_PARADA_ALERTA_MIN || 45);
const MUDO_MIN = Number(process.env.FROTA_MUDO_ALERTA_MIN || 120);
const MOTOR_MIN = Number(process.env.FROTA_MOTOR_LIGADO_MIN || 20);
const VEL_TELEGRAM = process.env.FROTA_VEL_TELEGRAM === "1";
const TRAVADO_KM = Number(process.env.FROTA_GPS_TRAVADO_KM || 10);
const TRAVADO_MIN = Number(process.env.FROTA_GPS_TRAVADO_MIN || 30);
const TIPOS_VIVOS = ["frota_parada", "frota_mudo", "frota_area", "frota_plataforma", "frota_gps_travado", "frota_loja_demora", "frota_desvio"];

// Inicio de cada desacordo em andamento ("placa|fonte" -> ms). Em memoria: um
// restart so atrasa o aviso em TRAVADO_MIN, nao perde nada.
const desacordoDesde = new Map();

const hhmm = (t) => new Date(new Date(t).getTime() - 3 * 3600000).toISOString().slice(11, 16);
const dur = (min) => (min < 60 ? `${Math.round(min)} min` : `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, "0")}`);

// Ponto dentro do poligono (ray casting em lat/lng — sobra para areas de bairro).
function dentro(p, poli) {
  let d = false;
  for (let i = 0, j = poli.length - 1; i < poli.length; j = i++) {
    const [yi, xi] = poli[i], [yj, xj] = poli[j];
    if ((yi > p.lat) !== (yj > p.lat) && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) d = !d;
  }
  return d;
}

function criar({ db, diario, agoraSP, enviarTelegram, operacao }) {
  const frota = require("./frota");
  const hoje = () => agoraSP().data;

  async function candidatos() {
    const data = hoje();
    const agora = Date.now();
    const horaSP = Number(hhmm(agora).slice(0, 2));
    const [resumos, atuais, aparelhos, areas] = await Promise.all([
      diario.resumoDoDia(data),
      rastreador.posicoesAtuais(db),
      db.query("SELECT placa, fonte, lat, lng, posicao_em, atualizado_em FROM rastreador_aparelhos WHERE placa IS NOT NULL"),
      diario.areasAtivas().catch(() => []),
    ]);
    const out = [];
    const motoristaDe = (placa) => { const r = resumos[placa]; return r && r.viagem && r.viagem.motorista ? ` · ${r.viagem.motorista}` : ""; };

    for (const [placa, r] of Object.entries(resumos)) {
      const longa = !!(r.viagem && r.viagem.longa);
      // Parada longa fora de loja AINDA acontecendo (a ultima parada vai ate o ultimo sinal).
      const ult = (r.paradas_fora || [])[r.paradas_fora.length - 1];
      if (ult && r.ultima && Math.abs(Date.parse(ult.fim) - Date.parse(r.ultima)) < 3 * 60000 && agora - Date.parse(r.ultima) < 30 * 60000) {
        const min = (agora - Date.parse(ult.inicio)) / 60000;
        const horaNoite = horaSP >= 21 || horaSP < 5;
        if (min >= PARADA_MIN && !(longa && horaNoite)) {
          out.push({ chave: `frota-parada-${placa}-${ult.inicio}`, tipo: "frota_parada", severidade: min >= 120 ? "alta" : "media",
            titulo: `${placa} parado fora de loja há ${dur(min)}`,
            detalhe: `desde ${hhmm(ult.inicio)}${ult.perto ? ` · perto de ${ult.perto}` : ""}${motoristaDe(placa)}`, aba: "frota", evento_em: ult.inicio });
        }
      }
      // Uso fora do horario (22h-5h), fora rota de viagem longa.
      if (!longa) for (const t of (r.noite && r.noite.trechos) || []) {
        if (t.km < 1) continue;
        out.push({ chave: `frota-noite-${placa}-${t.inicio}`, tipo: "frota_noite", severidade: "alta",
          titulo: `${placa} rodou fora do horário (${hhmm(t.inicio)}–${hhmm(t.fim)})`,
          detalhe: `${t.km} km entre 22h e 5h, sem viagem longa no TMS${motoristaDe(placa)}`, aba: "frota", evento_em: t.inicio });
      }
      // Jornada continua acima do limite.
      const j = r.jornada || {};
      if (j.max_continua_min >= require("./frota-diario").JORNADA_MAX_MIN) {
        out.push({ chave: `frota-jornada-${placa}-${data}`, tipo: "frota_jornada", severidade: "media",
          titulo: `${placa}: ${dur(j.max_continua_min)} de direção sem pausa de 30 min`,
          detalhe: `${hhmm(j.inicio)}–${hhmm(j.fim)} · limite ${dur(require("./frota-diario").JORNADA_MAX_MIN)} (Lei 13.103)${motoristaDe(placa)}`, aba: "frota", evento_em: j.inicio });
      }
      // Motor ligado parado.
      for (const e of (r.motor_parado && r.motor_parado.episodios) || []) {
        if (e.min < MOTOR_MIN) continue;
        out.push({ chave: `frota-motor-${placa}-${e.inicio}`, tipo: "frota_motor", severidade: "baixa",
          titulo: `${placa} parado com motor ligado ${dur(e.min)}`, detalhe: `desde ${hhmm(e.inicio)}${motoristaDe(placa)}`, aba: "frota", evento_em: e.inicio });
      }
      // Excesso de velocidade.
      for (const e of r.excessos || []) {
        out.push({ chave: `frota-vel-${placa}-${e.em}`, tipo: "frota_vel", severidade: e.vel >= frota.VEL_EXCESSO + 20 ? "alta" : "media",
          titulo: `${placa} a ${e.vel} km/h`, detalhe: `${hhmm(e.em)}${motoristaDe(placa)}`, aba: "frota", evento_em: e.em, semTelegram: !VEL_TELEGRAM });
      }
    }

    // Rastreador mudo em TODAS as plataformas (so no horario de operacao e
    // para quem deu sinal nas ultimas 48 h — o FKU6W26, mudo ha dias, fica no relatorio).
    // Plataforma que PAROU de coletar (ex.: sessao do T4S expirou em 05/10
    // 18:46): 1 aviso so, e os carros dela nao sao acusados de "mudo".
    const coleta = new Map();
    for (const a of aparelhos.rows) {
      const t = a.atualizado_em ? new Date(a.atualizado_em).getTime() : 0;
      if (t > (coleta.get(a.fonte) || 0)) coleta.set(a.fonte, t);
    }
    const parada = new Set();
    for (const [fonte, t] of coleta) {
      const min = (agora - t) / 60000;
      if (min < 30) continue;
      parada.add(fonte);
      out.push({ chave: `frota-plataforma-${fonte}-${data}`, tipo: "frota_plataforma", severidade: "alta",
        titulo: `${String(fonte).toUpperCase()} parou de responder há ${dur(min)}`,
        detalhe: fonte === "t4s" ? "Sessão do T4S pode ter expirado: use o botão 🔑 Reconectar T4S no painel do TMS"
          : fonte === "sat" ? "Sessão da Sat pode ter expirado: use o botão 🔑 Reconectar Sat no painel do TMS"
          : `Última coleta ${hhmm(t)} — conferir a plataforma`,
        aba: "frota", evento_em: new Date(t).toISOString() });
    }
    if (horaSP >= 6 && horaSP < 21) {
      const ultimo = new Map();
      for (const a of aparelhos.rows) {
        if (parada.has(a.fonte)) continue; // plataforma parada: nao e culpa do carro
        const t = a.posicao_em ? new Date(a.posicao_em).getTime() : 0;
        if (t > (ultimo.get(a.placa) || 0)) ultimo.set(a.placa, t);
      }
      for (const [placa, t] of ultimo) {
        const min = (agora - t) / 60000;
        if (min >= MUDO_MIN && min <= 48 * 60) {
          out.push({ chave: `frota-mudo-${placa}-${data}`, tipo: "frota_mudo", severidade: "media",
            titulo: `${placa} sem sinal há ${dur(min)}`, detalhe: `último sinal ${hhmm(t)} — rastreador desligado, sem cobertura ou com defeito`, aba: "frota", evento_em: new Date(t).toISOString() });
        }
      }
    }

    // GPS travado: compara cada aparelho com a posicao escolhida da placa
    // (maioria/preferida — rastreador-escolha.js), so entre sinais quase
    // simultaneos (<= 5 min de diferenca; caminhao a 80 km/h anda ~7 km nisso,
    // dai o limite de 10 km). Fonte ja marcada como ignorada na placa (aparelho
    // sabidamente fora do carro) nao avisa: o problema ja e conhecido.
    {
      await escolha.preferencias(db); // carrega o cache das ignoradas
      const escolhida = new Map(atuais.filter((a) => a.placa).map((a) => [a.placa, a]));
      const vistos = new Set();
      for (const a of aparelhos.rows) {
        const ref = escolhida.get(a.placa);
        if (!ref || ref.fonte === a.fonte || parada.has(a.fonte) || escolha.ignoradas(a.placa).has(a.fonte)) continue;
        const ta = a.posicao_em ? new Date(a.posicao_em).getTime() : 0;
        const tr = ref.posicao_em ? new Date(ref.posicao_em).getTime() : 0;
        if (agora - ta > 30 * 60000 || agora - tr > 30 * 60000 || Math.abs(ta - tr) > 5 * 60000) continue;
        const km = rastreador.distanciaM({ lat: Number(a.lat), lng: Number(a.lng) }, { lat: Number(ref.lat), lng: Number(ref.lng) }) / 1000;
        if (!Number.isFinite(km) || km < TRAVADO_KM) continue;
        const k = `${a.placa}|${a.fonte}`;
        vistos.add(k);
        if (!desacordoDesde.has(k)) desacordoDesde.set(k, agora);
        const min = (agora - desacordoDesde.get(k)) / 60000;
        if (min < TRAVADO_MIN) continue;
        const inicio = new Date(desacordoDesde.get(k)).toISOString();
        out.push({ chave: `frota-gpstravado-${a.placa}-${a.fonte}-${inicio}`, tipo: "frota_gps_travado", severidade: "media",
          titulo: `${String(a.fonte).toUpperCase()} do ${a.placa} mostra outro lugar há ${dur(min)}`,
          detalhe: `a ${Math.round(km)} km do que ${String(ref.fonte).toUpperCase()} mostra — GPS do aparelho travado ou aparelho fora do caminhão; avisar o fornecedor${motoristaDe(a.placa)}`,
          aba: "frota", evento_em: inicio });
      }
      // Desacordo que acabou (ou cujo sinal envelheceu) recomeca do zero.
      for (const k of [...desacordoDesde.keys()]) if (!vistos.has(k)) desacordoDesde.delete(k);
    }

    // Dentro de area de risco agora (chave = area + placa + inicio do trecho dentro).
    if (areas.length) {
      for (const a of atuais) {
        if (!a.placa || a.estado === "sem_sinal" || !Number.isFinite(a.lat)) continue;
        for (const ar of areas) {
          const poli = Array.isArray(ar.pontos) ? ar.pontos : [];
          if (poli.length < 3 || !dentro(a, poli)) continue;
          out.push({ chave: `frota-area-${ar.id}-${a.placa}-${data}-${hhmm(a.posicao_em).slice(0, 2)}`, tipo: "frota_area", severidade: ar.tipo === "atencao" ? "media" : "alta",
            titulo: `${a.placa} dentro da área "${ar.nome}"`, detalhe: `${ar.tipo === "proibida" ? "área proibida" : ar.tipo === "atencao" ? "área de atenção" : "área de risco"} · ${a.velocidade >= 3 ? `rodando a ${Math.round(a.velocidade)} km/h` : "parado"}${motoristaDe(a.placa)}`,
            aba: "frota", evento_em: a.posicao_em });
        }
      }
    }
    if (operacao) { try { out.push(...await operacao.candidatos()); } catch(e) { console.warn("[frota-operacao]",e.message); } }
    return out;
  }

  // ---------------------------------------------------------------- resumo do dia (Telegram)
  async function textoResumo(data = hoje()) {
    const r = await diario.relatorio(data, data);
    const km = r.veiculos.reduce((s, v) => s + v.km, 0);
    const rodaram = r.veiculos.filter((v) => v.km > 1).length;
    const visitas = r.lojas.reduce((s, l) => s + l.visitas, 0);
    const media = visitas ? Math.round(r.lojas.reduce((s, l) => s + l.media_min * l.visitas, 0) / visitas) : null;
    const resumos = await diario.resumoDoDia(data);
    const paradas = Object.entries(resumos).flatMap(([placa, x]) => (x.paradas_fora || []).filter((p) => p.min >= PARADA_MIN).map((p) => ({ placa, ...p })));
    const linhas = [
      `🛰 Frota — resumo de ${data.split("-").reverse().join("/")}`,
      `🚚 ${rodaram} veículo(s) rodaram · ${Math.round(km)} km no total`,
      `🏬 ${visitas} passagem(ns) em loja com saída registrada${media != null ? ` · tempo médio na loja ${dur(media)}` : ""}`,
      r.lojas.length ? `🐢 Loja mais demorada: ${r.lojas[0].loja} (${dur(r.lojas[0].mediana_min)})` : null,
      r.otif.total ? `⏱ Pontualidade (GPS × previsto): ${Math.round((r.otif.no_horario / r.otif.total) * 100)}% no horário (${r.otif.total} chegadas)` : null,
      paradas.length ? `⏸ ${paradas.length} parada(s) de ${PARADA_MIN}+ min fora de loja: ${paradas.slice(0, 4).map((p) => `${p.placa} ${dur(p.min)}`).join(", ")}` : null,
      r.excessos.length ? `⚠ ${r.excessos.length} excesso(s) de velocidade · maior ${r.excessos[0].vel} km/h (${r.excessos[0].placa})` : null,
      r.noites.filter((n) => !n.viagem_longa).length ? `🌙 Uso fora do horário: ${r.noites.filter((n) => !n.viagem_longa).map((n) => `${n.placa} ${n.km} km`).join(", ")}` : null,
      r.jornadas.length ? `😴 Jornada sem pausa acima de ${dur(r.jornada_max_min)}: ${r.jornadas.map((j) => j.placa).join(", ")}` : null,
      r.manutencao.filter((m) => m.situacao !== "ok").length ? `🔧 Manutenção: ${r.manutencao.filter((m) => m.situacao !== "ok").map((m) => `${m.placa} ${m.item} (${m.situacao === "vencida" ? "vencida" : `faltam ${m.falta_km} km`})`).join(", ")}` : null,
    ].filter(Boolean);
    return linhas.join("\n");
  }

  let timer = null;
  function agendarResumo() {
    if (process.env.FROTA_RESUMO_ATIVO === "0") return;
    const [h, m] = String(process.env.FROTA_RESUMO_HORA || "18:00").split(":").map(Number);
    const agoraSPms = Date.now() - 3 * 3600000;
    const alvo = new Date(agoraSPms); alvo.setUTCHours(h || 18, m || 0, 0, 0);
    let espera = alvo.getTime() - agoraSPms;
    if (espera <= 0) espera += 86400000;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try { await enviarTelegram(await textoResumo()); } catch (e) { console.error("[frota-resumo]", e.message); }
      agendarResumo();
    }, espera);
  }

  const rotas = {
    resumoTexto: async (req, res) => {
      try { res.json({ texto: await textoResumo(/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.data || "")) ? req.query.data : hoje()) }); }
      catch (err) { res.status(500).json({ error: err.message }); }
    },
    resumoEnviar: async (req, res) => {
      try {
        const texto = await textoResumo();
        const ok = await enviarTelegram(texto);
        res.json(ok ? { ok: true } : { ok: false, motivo: "Telegram não configurado (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID).", texto });
      } catch (err) { res.status(500).json({ error: err.message }); }
    },
    limites: (req, res) => res.json({
      parada_min: PARADA_MIN, mudo_min: MUDO_MIN, motor_min: MOTOR_MIN, vel: frota.VEL_EXCESSO,
      jornada_min: require("./frota-diario").JORNADA_MAX_MIN, resumo_hora: process.env.FROTA_RESUMO_HORA || "18:00",
      resumo_ativo: process.env.FROTA_RESUMO_ATIVO !== "0", vel_telegram: VEL_TELEGRAM,
    }),
  };

  return { candidatos, textoResumo, agendarResumo, rotas, TIPOS_VIVOS };
}

module.exports = { criar, dentro };
