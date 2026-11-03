// ================================================================
// tms-status-gps.js — o status da viagem anda sozinho pelo GPS
// ----------------------------------------------------------------
// Pedido de 06/10/2026: "assim que o caminhao sair da fabrica, de Planejada
// para Em rota; chegou na ultima loja, Em retorno; chegou na fabrica,
// Finalizada".
//
//   Planejada/Carregando/Liberada --🏭➡️ saiu da fabrica--> Em rota
//   Em rota  --📍 chegou na ultima loja que faltava-->     Retorno ("em retorno")
//   Retorno  --🏭 voltou para a fabrica-->                  Finalizada
//
// Le os eventos que o rastreador-ao-vivo.js grava (rastreador_eventos_loja) e
// roda no fim de cada ciclo dele (1 min), com as viagens que ele ja buscou.
// Grava pelos MESMOS caminhos dos botoes 🚚 Saiu e 🏁 Voltou, com origem
// "rastreador": jornada, atraso de saida, Tempo de Rota e ocorrencias saem pela
// regra de sempre, e nesse modo so PREENCHEM vazio. O que alguem apertou ou
// digitou nunca e trocado.
//
// Cuidados (vistos nos eventos de 05-06/10/2026):
//   - Saidas curtas sem loja (posto, recado: TUO8H06 19 min, FKG6J16 44 min) e
//     GPS trocado piscando "saiu/voltou" (FKC2E12, 06/10, 5 saidas em 1h40):
//     a 1a saida ja poe Em rota; quando o caminhao chega na 1a loja da viagem
//     a saida e acertada para a ultima saida da fabrica antes dela que de
//     tempo de chegar la (reta a 100 km/h). So corrige saida que o proprio
//     rastreador gravou.
//   - Lojas próximas exigem visita própria; uma parada não cobre a vizinha.
//   - "saiu e voltou" em menos de 60 min sem loja nenhuma nao conta (manobra,
//     posto, recado).
//
// Pedido de 06/10/2026 (tarde): "assim que o GPS indicar que o carro esta na
// fabrica, o TMS tem que mostrar a rota finalizada e o horario que o carro
// chegou". Antes a volta esperava 5 min "confirmando" e so valia com TODAS as
// lojas vistas: o FKF5H15 parou na fabrica 16:33 e a viagem 271 seguiu aberta
// ate alguem apertar o 🏁 16:34. Agora:
//   - a volta finaliza NA HORA (TMS_GPS_CONFIRMA_VOLTA_MIN=5 volta ao antigo);
//   - basta ter passado em 1 loja da viagem: loja que o GPS nao viu nao segura
//     mais a viagem aberta (o registro que falta continua cobrado no card);
//   - viagem Finalizada A MAO sem o horario da volta (FKC2E12, 06/10) ganha o
//     horario do GPS (so preenche vazio);
//   - REABRE: se a volta era so uma passada na fabrica (carregar, almoco) e o
//     caminhao sai de novo e chega numa loja da viagem que ainda nao tinha
//     visto, a viagem volta para Em rota e o retorno fica para a volta de
//     verdade. So desfaz retorno que o proprio GPS gravou.
// TMS_STATUS_GPS=0 desliga.
// ================================================================

const FEITA = new Set(["Entregue", "Entregue com ocorrencia", "Recusada", "Ocorrencia"]);
const ANTES_DA_SAIDA = ["Planejada", "Carregando", "Liberada"];
const ABERTAS = [...ANTES_DA_SAIDA, "Em rota", "Retorno"];
const FABRICA = "FABRICA";
const KMH_RETA = 100;
const EXCURSAO_MIN = 60;
const CONFIRMA_VOLTA_MIN = Number(process.env.TMS_GPS_CONFIRMA_VOLTA_MIN || 0);

function distanciaM(a, b) {
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const fmtSP = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});
function partesSP(d) {
  const p = Object.fromEntries(fmtSP.formatToParts(d).map((x) => [x.type, x.value]));
  return { data: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour === "24" ? "00" : p.hour}:${p.minute}` };
}
// Brasil sem horario de verao desde 2019: SP = -03:00 o ano todo.
const instante = (dataISO, hhmm) => new Date(`${dataISO}T${hhmm}:00-03:00`);

// "GPS não separa: 375, 376" -> ["375", "376"]
const codigosAmbiguos = (detalhe) => {
  const m = String(detalhe || "").match(/separa:\s*(.+)$/);
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
};

// Decide o que fazer com UMA viagem. Puro (da para testar com os eventos do
// banco). v: viagem do buscarViagensTms (status, saida_real "HH:MM:SS",
// saida_real_origem, retorno_real, retorno_real_origem, data_viagem,
// paradas[].loja_codigo_pes); eventos: da placa, em ordem de tempo, desde o
// inicio do dia da viagem.
function decidir(v, eventos, coords, agora = new Date()) {
  const acoes = {};
  // Finalizada a mao sem o horario da volta: o GPS so preenche o horario.
  const fechadaSemHora = v.status === "Finalizada" && !v.retorno_real;
  // Finalizada pelo proprio GPS: reabre se a volta era so uma passada.
  const fechadaPeloGps = v.status === "Finalizada" && !!v.retorno_real && v.retorno_real_origem === "rastreador";
  const fechada = fechadaSemHora || fechadaPeloGps || (v.status === 'Finalizada' && !v.saida_real);
  if (!fechada && (!ABERTAS.includes(v.status) || v.retorno_real)) return acoes;
  eventos = eventos.filter((e) => e.em <= agora).sort((a, b) => a.em - b.em);
  const paradas = v.paradas || [];
  const daViagem = new Set(paradas.map((p) => p.loja_codigo_pes).filter(Boolean));
  const cobre = (e) => {
    const s = new Set();
    // A confirmação de uma loja não comprova a visita à loja vizinha.
    if (daViagem.has(e.lugar_codigo) && !codigosAmbiguos(e.detalhe).length) s.add(e.lugar_codigo);
    return s;
  };
  const fabrica = eventos.filter((e) => e.tipo === "saiu_fabrica" || e.tipo === "voltou_fabrica");
  const ehLoja = (e) => e.tipo === "chegou_loja" || e.tipo === "saiu_loja";
  // Passagem por loja DESTA viagem: chegou OU saiu (o FKD3F13 em 06/10 so
  // teve o "saiu" de Caxias Centro — a chegada caiu num restart).
  const passagens = eventos.filter(ehLoja).map((e) => ({ ...e, cobre: cobre(e) })).filter((e) => e.cobre.size);
  const chegadas = passagens.filter((e) => e.tipo === "chegou_loja");
  const saidaAtual = v.saida_real ? String(v.saida_real).slice(0, 5) : null;

  // 1. Saida da fabrica (Em rota). So saidas no dia da viagem.
  if (!fechada || !saidaAtual) {
    const saidas = fabrica.filter((e) => e.tipo === "saiu_fabrica" && partesSP(e.em).data === v.data_viagem);
    const primeira = chegadas[0];
    let saidaGps = null;
    if (primeira) {
      const antes = saidas.filter((e) => e.em < primeira.em);
      const loja = coords.get(primeira.lugar_codigo), fab = coords.get(FABRICA);
      const minimoMin = loja && fab ? (distanciaM(loja, fab) / 1000 / KMH_RETA) * 60 : 0;
      const daTempo = antes.filter((e) => (primeira.em - e.em) / 60000 >= minimoMin);
      saidaGps = daTempo[daTempo.length - 1] || antes[0] || null;
    } else {
      const ultimo = fabrica[fabrica.length - 1];
      if (ultimo && ultimo.tipo === "saiu_fabrica" && saidas.includes(ultimo)) saidaGps = ultimo; // saiu e nao voltou
    }
    if (saidaGps) {
      const hora = partesSP(saidaGps.em).hora;
      if (!saidaAtual) acoes.saida = v.status==='Finalizada' ? {hora,soHorario:true} : {hora};
      else if (v.saida_real_origem === "rastreador" && primeira && hora !== saidaAtual) acoes.saida = { hora, substituir: saidaAtual };
    }
  }
  if(v.retorno_real && !fechadaPeloGps)return acoes;
  const saidaHora = acoes.saida ? acoes.saida.hora : saidaAtual;
  // A falta do sinal da saída não pode apagar uma volta comprovada depois
  // das lojas. A primeira visita limita a busca, sem inventar hora de saída.
  const primeiraPassagem = passagens[0];
  if (!saidaHora && (!primeiraPassagem || !(['Em rota','Retorno'].includes(v.status) || fechada))) return acoes;
  const saidaEm = saidaHora ? instante(v.data_viagem, saidaHora) : primeiraPassagem.em;
  const visitas = passagens.filter((e) => e.em >= saidaEm);
  // Qualquer loja depois da saida (inclusive fora do roteiro: CSG, filial).
  const lojasDepois = eventos.filter((e) => ehLoja(e) && e.em >= saidaEm);
  // Viagem sem roteiro com codigo de loja: qualquer loja vale como passagem.
  const passou = daViagem.size ? visitas : lojasDepois;

  // 0. Reabrir: a volta que o GPS gravou era so uma passada na fabrica — o
  //    caminhao saiu de novo e chegou numa loja da viagem que ainda nao tinha
  //    visto antes daquela volta.
  if (fechadaPeloGps) {
    const hora = String(v.retorno_real).slice(0, 5);
    const volta = fabrica.find((e) => e.tipo === "voltou_fabrica" && e.em > saidaEm && partesSP(e.em).hora === hora);
    const saiuDepois = volta && fabrica.find((e) => e.tipo === "saiu_fabrica" && e.em > volta.em);
    if (!saiuDepois) return acoes;
    const vistas = new Set(visitas.filter((e) => e.em < volta.em).flatMap((e) => [...e.cobre]));
    const nova = visitas.find((e) => e.tipo === "chegou_loja" && e.em > saiuDepois.em && [...e.cobre].some((c) => !vistas.has(c)));
    if (nova) acoes.reabrir = { retorno: hora, loja: nova.lugar_nome || nova.lugar_codigo, em: nova.em };
    return acoes;
  }
  let status = acoes.saida && ANTES_DA_SAIDA.includes(v.status) ? "Em rota" : v.status;

  // 2. Chegou na ultima loja que faltava (Retorno).
  const visitados = new Set(visitas.flatMap((e) => [...e.cobre]));
  const faltam = paradas.filter((p) => !(p.ocorrencia_id || FEITA.has(p.status)) && !(p.loja_codigo_pes && visitados.has(p.loja_codigo_pes)));
  if (status === "Em rota" && paradas.length && !faltam.length) {
    const ultima = visitas[visitas.length - 1];
    acoes.retorno = { loja: ultima ? ultima.lugar_nome || ultima.lugar_codigo : null, em: ultima ? ultima.em : null };
    status = "Retorno";
  }

  // 3. Voltou para a fabrica (Finalizada) — na hora. Em rota com loja que o
  //    GPS nao viu tambem fecha, desde que tenha passado em alguma loja da
  //    viagem (sem isso, uma ida ao posto de manha fecharia a viagem do dia).
  const podeFechar = status === "Retorno" || fechadaSemHora || (status === "Em rota" && passou.length > 0);
  if (podeFechar) {
    const ultimaLoja = lojasDepois.length ? lojasDepois[lojasDepois.length - 1].em : saidaEm;
    for (const volta of fabrica) {
      if (volta.tipo !== "voltou_fabrica" || volta.em <= saidaEm || volta.em < ultimaLoja) continue;
      if ((volta.em - saidaEm) / 60000 < EXCURSAO_MIN && !passou.some((c) => c.em < volta.em)) continue; // manobra/recado
      if (CONFIRMA_VOLTA_MIN > 0) {
        if (agora - volta.em < CONFIRMA_VOLTA_MIN * 60000) break; // espera confirmar
        const saiuLogo = fabrica.some((e) => e.tipo === "saiu_fabrica" && e.em > volta.em && e.em - volta.em <= CONFIRMA_VOLTA_MIN * 60000);
        if (saiuLogo) continue; // GPS piscando no portao
      }
      acoes.finalizar = { hora: partesSP(volta.em).hora };
      if (/sinal parou/.test(volta.detalhe || "")) acoes.finalizar.estimada = true;
      if (fechadaSemHora) acoes.finalizar.soHorario = true;
      else if (faltam.length) acoes.finalizar.pendentes = faltam.map((p) => p.loja_nome || p.loja_codigo_pes || "loja");
      break;
    }
  }
  return acoes;
}

function criar({ db, rastreador, handlers, registrarAuditoria, broadcastAuditoria, broadcastEvento }) {
  const desligado = String(process.env.TMS_STATUS_GPS ?? "1") === "0";
  const falhas = new Map(); // limita os avisos, mas tenta de novo em cada ciclo

  const chamar = (fn, id, body, extra = {}) => new Promise((ok) => {
    const res = { status(s) { this.s = s; return this; }, json(j) { ok({ status: this.s || 200, ...j }); } };
    Promise.resolve().then(() => fn({ params: { id: String(id) }, body, usuarioLogado: { nome: "🛰 GPS" }, origemInterna: "rastreador", ...extra }, res))
      .catch((err) => ok({ status: 500, error: err.message }));
  });

  async function executar(v, acao, hora, fn) {
    const chave = `${v.id}|${acao}|${hora || ""}`;
    const r = await fn();
    if (r.status >= 400) {
      if (falhas.size > 500) falhas.clear();
      if (falhas.get(chave) !== r.error) {
        console.warn(`[tms-status-gps] viagem ${v.id} ${acao} ${hora || ""}: ${r.error || `HTTP ${r.status}`}`);
      }
      falhas.set(chave, r.error);
      return false;
    }
    falhas.delete(chave);
    return true;
  }

  // viagens: as do ciclo do rastreador-ao-vivo (buscarViagensTms de hoje +
  // pernoite que continua).
  async function aplicar(viagens, agora = new Date()) {
    if (desligado) return [];
    // Abertas + Finalizada sem horario da volta (preenche) + Finalizada pelo
    // GPS (pode reabrir).
    const abertas = viagens.filter((v) => v.placa && (ABERTAS.includes(v.status) ? !v.retorno_real
      : v.status === "Finalizada" && (!v.saida_real || !v.retorno_real || v.retorno_real_origem === "rastreador")));
    if (!abertas.length) return [];
    // Mesma placa com 2+ viagens no dia: so os eventos ja amarrados a viagem.
    const porDiaPlaca = new Map();
    for (const v of viagens) {
      if (v.status === "Cancelada") continue;
      const k = `${v.data_viagem}|${rastreador.placaMercosul(v.placa)}`;
      porDiaPlaca.set(k, (porDiaPlaca.get(k) || 0) + 1);
    }
    const desde = instante(abertas.map((v) => v.data_viagem).sort()[0], "00:00");
    const placas = [...new Set(abertas.map((v) => rastreador.placaMercosul(v.placa)))];
    const r = await db.query(`
      SELECT placa, tipo, lugar_codigo, lugar_nome, detalhe, em, viagem_id, fonte
        FROM rastreador_eventos_loja
       WHERE em >= $1 AND placa = ANY($2::text[])
         AND tipo IN ('saiu_fabrica', 'voltou_fabrica', 'chegou_loja', 'saiu_loja')
       ORDER BY em, id`, [desde, placas]);
    const eventosDa = new Map();
    for (const e of r.rows) {
      if(e.fonte && require("./rastreador-escolha").ignoradas(e.placa).has(e.fonte)) continue;
      const ev = { ...e, em: new Date(e.em) };
      (eventosDa.get(e.placa) || eventosDa.set(e.placa, []).get(e.placa)).push(ev);
    }
    const coords = await rastreador.coordenadas(db);

    const mudancas = [];
    for (const v of abertas) {
      const placa = rastreador.placaMercosul(v.placa);
      const inicio = instante(v.data_viagem, "00:00");
      const multi = porDiaPlaca.get(`${v.data_viagem}|${placa}`) > 1;
      const eventos = (eventosDa.get(placa) || []).filter((e) => e.em >= inicio && e.em <= agora
        && (e.viagem_id === v.id || (e.viagem_id == null && !multi
          && abertas.filter((outra) => rastreador.placaMercosul(outra.placa) === placa).length === 1)));
      if (!eventos.length) continue;
      const a = decidir(v, eventos, coords, agora);
      const base = { viagem_id: v.id, placa, motorista: v.motorista_nome, rota: v.rota_nome };

      if (a.reabrir) {
        // So desfaz o retorno que o proprio GPS gravou, e so se ninguem mexeu.
        const u = await db.query(`
            UPDATE tms_viagens SET status = 'Em rota', retorno_real = NULL, retorno_real_em = NULL, retorno_real_por = NULL,
                   retorno_real_origem = NULL, finalizada_em = NULL, finalizada_auto = FALSE, atualizado_em = NOW()
             WHERE id = $1 AND status = 'Finalizada' AND retorno_real_origem = 'rastreador'
               AND to_char(retorno_real, 'HH24:MI') = $2
            RETURNING id`, [v.id, a.reabrir.retorno]);
        if (u.rowCount) {
          await registrarAuditoria({}, "AUTO_STATUS", "tms_viagens", v.id,
            { de: "Finalizada", para: "Em rota", origem: "gps", retorno_desfeito: a.reabrir.retorno, loja: a.reabrir.loja });
          mudancas.push({ ...base, tipo: "reaberta", em: a.reabrir.em,
            texto: `${placa} saiu de novo e chegou em ${a.reabrir.loja} — viagem REABERTA (Em rota); a volta das ${a.reabrir.retorno} era só uma passada na fábrica` });
        }
        continue;
      }

      if (a.saida) {
        const ok = await executar(v, "saida", a.saida.hora, () =>
          chamar(handlers.saida, v.id, { hora: a.saida.hora }, {
            ...(a.saida.substituir ? {substituirHora:a.saida.substituir} : {}),
            ...(a.saida.soHorario ? {completarHorarioEncerrada:true} : {}),
          }));
        if (!ok) continue; // snapshot mudou ou falhou: rele no proximo ciclo
        if (ok) mudancas.push({ ...base, tipo: a.saida.soHorario ? 'saida_preenchida' : "em_rota", hora: a.saida.hora, de: v.status, corrigida: a.saida.substituir || null,
          texto: a.saida.soHorario ? `${placa} horário da saída preenchido pelo GPS: ${a.saida.hora}` : a.saida.substituir ? `${placa} saída da fábrica acertada pelo GPS: ${a.saida.substituir} → ${a.saida.hora}`
            : `${placa} saiu da fábrica ${a.saida.hora} — viagem EM ROTA` });
      }
      if (a.retorno) {
        const u = await db.query(`UPDATE tms_viagens SET status = 'Retorno', atualizado_em = NOW()
            WHERE id = $1 AND status = 'Em rota' AND retorno_real IS NULL RETURNING id`, [v.id]);
        if (u.rowCount) {
          await registrarAuditoria({}, "AUTO_STATUS", "tms_viagens", v.id, { de: "Em rota", para: "Retorno", origem: "gps", ultima_loja: a.retorno.loja });
          mudancas.push({ ...base, tipo: "retorno", em: a.retorno.em, texto: `${placa} chegou na última loja${a.retorno.loja ? ` (${a.retorno.loja})` : ""} — viagem EM RETORNO` });
        } else continue; // alguem mexeu no status agora: proxima volta decide
      }
      if (a.finalizar) {
        const ok = await executar(v, "retorno", a.finalizar.hora, () => chamar(handlers.retorno, v.id, { hora: a.finalizar.hora }));
        const f = a.finalizar;
        const estimada = f.estimada ? " (horário estimado: o rastreador desligou chegando)" : "";
        const pend = f.pendentes ? ` — ${f.pendentes.length} loja(s) sem passagem do GPS: ${f.pendentes.join(", ")}` : "";
        if (ok) mudancas.push({ ...base, tipo: f.soHorario ? "retorno_preenchido" : "finalizada", hora: f.hora,
          texto: f.soHorario ? `${placa} voltou para a fábrica ${f.hora} — horário da volta preenchido pelo GPS${estimada}`
            : `${placa} voltou para a fábrica ${f.hora} — viagem FINALIZADA${estimada}${pend}` });
      }
    }

    if (mudancas.length) {
      console.log(`[tms-status-gps] ${mudancas.map((m) => `${m.viagem_id}:${m.tipo}${m.hora ? ` ${m.hora}` : ""}`).join(", ")}`);
      try { broadcastAuditoria("tms_viagens"); } catch (_) {}
      for (const m of mudancas) {
        try {
          broadcastEvento("gps", { tipo: `viagem_${m.tipo}`, placa: m.placa, em: m.em || new Date(), motorista: m.motorista || null, rota: m.rota || null, texto: m.texto });
        } catch (_) {}
      }
    }
    return mudancas;
  }

  return { aplicar };
}

// Timer proprio (60 s, defasado 30 s do ciclo do rastreador-ao-vivo, que grava
// os eventos): busca as viagens de hoje + pernoite que continua e aplica.
function iniciar({ buscarViagensTms, agoraSP, intervaloMs = 60000, ...deps }) {
  if (String(process.env.TMS_STATUS_GPS ?? "1") === "0") { console.log("[tms-status-gps] desligado (TMS_STATUS_GPS=0)"); return null; }
  const mod = criar(deps);
  let rodando = false;
  const rodar = async () => {
    if (rodando) return;
    rodando = true;
    try { await mod.aplicar(await buscarViagensTms(agoraSP().data, { pernoite: true })); }
    catch (err) { console.error("[tms-status-gps]", err.message); }
    finally { rodando = false; }
  };
  setTimeout(() => { rodar(); setInterval(rodar, intervaloMs); }, 50000);
  console.log("[tms-status-gps] status da viagem pelo GPS ativo (saiu -> Em rota, ultima loja -> Retorno, voltou -> Finalizada)");
  return { ...mod, rodar };
}

module.exports = { criar, iniciar, decidir, partesSP };
