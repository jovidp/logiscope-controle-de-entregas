// ================================================================
// tms-ciclo.js — ciclo da viagem: 🧑 Chegou -> 🚚 Saiu -> 🏁 Voltou
// ----------------------------------------------------------------
// "Saiu" ja existe (POST /tms/viagens/:id/saida, em server.js). Aqui ficam:
//   POST /tms/viagens/:id/chegada  {hora?, lacre?}
//        Motorista chegou na fabrica (substitui a planilha MALOTE LACRADO:
//        horario previsto x chegada + lacre). Planejada -> Carregando.
//   POST /tms/viagens/:id/retorno  {hora?}
//        Caminhao voltou. Viagem -> Finalizada e grava o "Tempo de Rota"
//        (rotas_registradas) com a MESMA regra de jornada do formulario:
//        12h de trabalho (8h normais + ate 4h extra) + 1h de almoco que nao
//        conta; acima disso excedente; R$15/h de extra. Ex.: sai 05:15,
//        limite 18:15.
//   autoStatus(): a cada poucos minutos
//        - viagem Em rota com TODAS as paradas feitas -> Retorno (voltando)
//        - viagem de dia anterior com todas as paradas feitas -> Finalizada
//          (finalizada_auto = true). Viagem com loja pendente fica aberta de
//          proposito: e pendencia de verdade, nao e para sumir.
// Sem body.hora o servidor carimba a hora dele (so para viagem de hoje).
//
// PERNOITE (rotas de viagem, back/pernoite.js) — dois marcos a mais:
//   POST /tms/viagens/:id/hotel_chegada {hora?}  🏨 equipe parou no hotel (dia 1)
//   POST /tms/viagens/:id/hotel_saida   {hora?}  🏨 saiu do hotel (dia 2)
//   - o "Voltou" de viagem com pernoite grava o Tempo de Rota de VIAGEM
//     (is_viagem, parada/saida do hotel) com a regra do formulario: jornada =
//     (fabrica -> hotel) + (hotel -> fabrica). Sem o "No hotel" usa a saida
//     da ultima loja do 1o dia.
//   - "agora" vale no dia seguinte para Saiu do hotel / Voltou;
//   - autoStatus nao finaliza a viagem longa de ontem que ainda nao voltou
//     (ela fica em Retorno ate o 🏁 Voltou ou ate passar a janela).
// ================================================================

const pernoite = require("./pernoite");

const ANTES_DA_CHEGADA = ["Planejada"];
const ABERTAS = ["Planejada", "Carregando", "Liberada", "Em rota", "Retorno"];
const PARADA_FEITA_SQL = `(p.status IN ('Entregue','Entregue com ocorrencia','Recusada','Ocorrencia')
   OR p.ocorrencia_id IS NOT NULL
   OR EXISTS (SELECT 1 FROM ocorrencias o WHERE o.parada_id = p.id AND o.excluida_em IS NULL))`;

// Regra de jornada do formulario "Tempo de Rota" (script-5-formularios.js).
function jornada(saida, retorno) {
  const min = (h) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
  let total = min(retorno) - min(saida);
  if (total < 0) total += 24 * 60; // virou a meia-noite
  // 1h de almoco nao conta como trabalho (dia acima de 6h).
  const trabalhado = total > 360 ? total - 60 : total;
  const normais = Math.min(trabalhado, 480);
  const extras = Math.min(Math.max(trabalhado - 480, 0), 240);
  const excedentes = Math.max(trabalhado - 720, 0);
  return {
    total_min: total, trabalhado_min: trabalhado, horas: Math.floor(total / 60), minutos: total % 60,
    minutos_normais: normais, minutos_extras_permitidos: extras, minutos_excedentes: excedentes,
    valor_extra_aprox: Math.round((extras / 60) * 15 * 100) / 100,
  };
}

async function garantirColunas(db) {
  await db.query(`
    ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS chegada_fabrica TIME;
    ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS chegada_fabrica_em TIMESTAMP;
    ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS chegada_fabrica_por TEXT;
    ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS chegada_fabrica_origem TEXT;
    ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS lacre TEXT;
    ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS retorno_real TIME;
    ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS retorno_real_em TIMESTAMP;
    ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS retorno_real_por TEXT;
    ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS retorno_real_origem TEXT;
    ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS finalizada_em TIMESTAMP;
    ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS finalizada_auto BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS hotel_chegada TIME;
    ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS hotel_chegada_em TIMESTAMP;
    ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS hotel_chegada_por TEXT;
    ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS hotel_chegada_origem TEXT;
    ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS hotel_saida TIME;
    ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS hotel_saida_em TIMESTAMP;
    ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS hotel_saida_por TEXT;
    ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS hotel_saida_origem TEXT;
  `);
}

const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Le a viagem travada para a transacao + o "agora" do banco (fuso de SP).
async function lerViagem(client, id) {
  const r = await client.query(`
      SELECT v.id, to_char(v.data_viagem, 'YYYY-MM-DD') AS data_iso,
             (v.data_viagem = CURRENT_DATE) AS eh_hoje,
             (CURRENT_DATE - v.data_viagem) AS dias_atras,
             to_char(v.hotel_chegada, 'HH24:MI') AS hotel_chegada,
             to_char(v.hotel_saida, 'HH24:MI') AS hotel_saida,
             v.motorista_nome AS motorista, v.placa, v.rota_nome AS rota, v.status, v.retorno_real,
             to_char(v.hora_saida_fabrica, 'HH24:MI') AS prevista,
             to_char(v.saida_real, 'HH24:MI') AS saida,
             to_char(LOCALTIME, 'HH24:MI') AS agora
        FROM tms_viagens v WHERE v.id = $1 FOR UPDATE`, [id]);
  return r.rows[0] || null;
}

function criarRotas({ db, registrarAuditoria }) {
  // Esqueleto comum: valida hora, abre transacao, le viagem, chama `aplicar`.
  // podeAgora(v): quando o botao (sem hora digitada) vale. Padrao: viagem de hoje.
  const handler = (acao, aplicar, podeAgora = (v) => v.eh_hoje) => async (req, res) => {
    const horaInformada = String(req.body?.hora || "").trim();
    if (horaInformada && !HORA_RE.test(horaInformada)) {
      return res.status(400).json({ error: "Horario invalido (use HH:MM)." });
    }
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const v = await lerViagem(client, req.params.id);
      const erro = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };
      if (!v) erro(404, "Viagem nao encontrada.");
      if (!horaInformada && !podeAgora(v)) erro(400, "Esta viagem nao e de hoje: informe o horario.");
      const hora = horaInformada || v.agora;
      // Rastreador (rastreador-eventos.js) chama por dentro: origem propria e
      // modo "so preenche vazio" no Tempo de Rota.
      const doRastreador = req.origemInterna === "rastreador";
      const origem = doRastreador ? "rastreador" : horaInformada ? "ajuste" : "botao";
      const por = req.usuarioLogado?.nome || null;
      const resultado = await aplicar({ client, v, hora, origem, por, req, erro, horaInformada, doRastreador });
      await client.query("COMMIT");
      await registrarAuditoria(req, acao, "tms_viagens", v.id, { hora, origem, ...resultado.auditoria });
      res.status(200).json({ hora, ...resultado.resposta });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error(`[${acao}]`, err);
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  };

  const chegada = handler("CHEGADA_FABRICA", async ({ client, v, hora, origem, por, req }) => {
    const lacre = req.body?.lacre === undefined ? undefined : String(req.body.lacre || "").trim().slice(0, 40) || null;
    const r = await client.query(`
        UPDATE tms_viagens SET chegada_fabrica = $1, chegada_fabrica_em = NOW(), chegada_fabrica_por = $2,
               chegada_fabrica_origem = $3,
               lacre = CASE WHEN $4::boolean THEN $5 ELSE lacre END,
               status = CASE WHEN status = ANY($6::text[]) THEN 'Carregando' ELSE status END,
               atualizado_em = NOW()
         WHERE id = $7 RETURNING *`,
      [hora, por, origem, lacre !== undefined, lacre ?? null, ANTES_DA_CHEGADA, v.id]);
    const prevista = v.prevista && v.prevista !== "00:00" ? v.prevista : null;
    const j = prevista ? jornada(prevista, hora) : null;
    // Chegou ANTES da saida prevista = ok (0); depois = atraso. Janela de 12h
    // para nao confundir "chegou 04:50 p/ sair 05:00" com atraso de 23h50.
    const atraso = j ? (j.total_min > 12 * 60 ? 0 : j.total_min) : null;
    return { resposta: { viagem: r.rows[0], prevista, atraso_min: atraso }, auditoria: { lacre, prevista, atraso_min: atraso } };
  });

  const retorno = handler("RETORNO_FABRICA", async ({ client, v, hora, origem, por, erro, horaInformada, doRastreador }) => {
    // Finalizada a mao sem o horario da volta: o GPS preenche so o horario.
    if (doRastreador && (v.retorno_real || !['Em rota', 'Retorno', 'Finalizada'].includes(v.status))) {
      erro(409, "A viagem ja foi ajustada ou encerrada; o GPS preservou o registro.");
    }
    if (!v.saida && !doRastreador) erro(400, "Registre primeiro a saida da fabrica (🚚 Saiu) desta viagem.");
    const r = await client.query(`
        UPDATE tms_viagens SET retorno_real = $1, retorno_real_em = NOW(), retorno_real_por = $2,
               retorno_real_origem = $3, status = 'Finalizada',
               finalizada_em = COALESCE(finalizada_em, NOW()), finalizada_auto = FALSE, atualizado_em = NOW()
         WHERE id = $4 RETURNING *`, [hora, por, origem, v.id]);

    // A volta tem sua própria prova GPS. Sem saída conhecida, registra o
    // horário e deixa a jornada pendente até existir uma saída real.
    if (!v.saida) return {
      resposta: { viagem: r.rows[0], jornada: null, tempo_rota: null, falta_saida: true },
      auditoria: { saida: null, falta_saida: true },
    };

    // Rota de viagem que dormiu fora: Tempo de Rota de VIAGEM (hotel).
    const longa = pernoite.ehRotaViagem(v.rota);
    const houvePernoite = longa && !!(v.hotel_saida || v.hotel_chegada || v.dias_atras >= 1 || await temLojaDiaSeguinte(client, v.id));
    if (houvePernoite) {
      const paradaHotel = v.hotel_chegada || await ultimaSaidaDia1(client, v.id);
      const saidaHotel = v.hotel_saida;
      if (!paradaHotel || !saidaHotel || !v.motorista) {
        // Sem a saida do hotel nao da para separar os dois dias: nao inventa.
        return {
          resposta: { viagem: r.rows[0], jornada: null, pernoite: true, falta_hotel: !saidaHotel, tempo_rota: null },
          auditoria: { saida: v.saida, pernoite: true, falta_hotel: !saidaHotel },
        };
      }
      const jp = jornadaPernoite(v.saida, paradaHotel, saidaHotel, hora);
      const tempoRota = await gravarTempoRotaViagem(client, v, hora, paradaHotel, saidaHotel, jp, !v.hotel_chegada, doRastreador);
      return {
        resposta: { viagem: r.rows[0], jornada: jp, pernoite: true, parada_hotel: paradaHotel, saida_hotel: saidaHotel, tempo_rota: tempoRota },
        auditoria: { saida: v.saida, jornada_min: jp.total_min, pernoite: true, parada_hotel: paradaHotel, saida_hotel: saidaHotel, tempo_rota: tempoRota },
      };
    }

    // Tempo de Rota. Hora digitada de OUTRO dia em rota que nao e de viagem:
    // como antes (o botao "agora" so vale no dia).
    const pernoiteAntigo = !horaInformada && !v.eh_hoje;
    const j = jornada(v.saida, hora);
    let tempoRota = null;
    if (!pernoiteAntigo && v.motorista) {
      const existente = await client.query(`
          SELECT id, is_viagem, COALESCE(obs, '') AS obs, LEFT(COALESCE(saida, ''), 5) AS saida FROM rotas_registradas
           WHERE data = $1 AND UPPER(TRIM(motorista)) = UPPER(TRIM($2))
           ORDER BY id DESC LIMIT 1`, [v.data_iso, v.motorista]);
      const ex = existente.rows[0];
      if (ex && ex.is_viagem) {
        tempoRota = { id: ex.id, ignorado: "registro de viagem com pernoite ja existe" };
      } else if (ex && doRastreador && !(ex.obs.includes("🛰 rastreador") && ex.saida === v.saida)) {
        // (o que o proprio GPS gravou para ESTA saida ele acerta: viagem
        // reaberta pelo tms-status-gps.js e finalizada de novo.)
        // Tempo de Rota ja lancado (formulario ou botao): o rastreador nao troca.
        tempoRota = { id: ex.id, ignorado: "Tempo de Rota ja lancado" };
      } else {
        // $1..$11 = os mesmos nos dois comandos (todo parametro precisa ser usado).
        const calc = [v.placa, v.rota, v.saida, hora, j.total_min, j.horas, j.minutos,
          j.minutos_normais, j.minutos_extras_permitidos, j.minutos_excedentes, j.valor_extra_aprox];
        if (ex) {
          await client.query(`
              UPDATE rotas_registradas SET placa = COALESCE(NULLIF(placa, ''), $1), rota_feita = COALESCE(NULLIF(rota_feita, ''), $2),
                     saida = $3, retorno = $4, total_min = $5, horas = $6, minutos = $7, minutos_normais = $8,
                     minutos_extras_permitidos = $9, minutos_excedentes = $10, valor_extra_aprox = $11
               WHERE id = $12`, [...calc, ex.id]);
          tempoRota = { id: ex.id, atualizado: true };
        } else {
          const id = Date.now() % 2147483647;
          await client.query(`
              INSERT INTO rotas_registradas (id, data, motorista, placa, rota_feita, saida, retorno, total_min, horas, minutos,
                     minutos_normais, minutos_extras_permitidos, minutos_excedentes, valor_extra_aprox, obs, is_viagem)
              VALUES ($12, $13, $14, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '${doRastreador ? "Registrado pelo TMS (🛰 rastreador)" : "Registrado pelo TMS (🏁 Voltou)"}', FALSE)`,
            [...calc, id, v.data_iso, v.motorista]);
          tempoRota = { id, criado: true };
        }
      }
    }
    return {
      resposta: { viagem: r.rows[0], jornada: j, pernoite: pernoiteAntigo, tempo_rota: tempoRota },
      auditoria: { saida: v.saida, jornada_min: j.total_min, pernoite: pernoiteAntigo, tempo_rota: tempoRota },
    };
  }, (v) => v.eh_hoje || naJanela(v));

  // 🏨 Hotel (so rota de viagem, depois da saida da fabrica).
  const marcoHotel = (coluna) => async ({ client, v, hora, origem, por, erro }) => {
    if (!pernoite.ehRotaViagem(v.rota)) erro(400, "Hotel so vale para rota de viagem (pernoite).");
    if (!v.saida) erro(400, "Registre primeiro a saida da fabrica (🚚 Saiu) desta viagem.");
    const r = await client.query(`
        UPDATE tms_viagens SET ${coluna} = $1, ${coluna}_em = NOW(), ${coluna}_por = $2, ${coluna}_origem = $3,
               atualizado_em = NOW()
         WHERE id = $4 RETURNING *`, [hora, por, origem, v.id]);
    return { resposta: { viagem: r.rows[0] }, auditoria: { coluna } };
  };
  const hotelChegada = handler("HOTEL_CHEGADA", marcoHotel("hotel_chegada"), (v) => v.eh_hoje);
  const hotelSaida = handler("HOTEL_SAIDA", marcoHotel("hotel_saida"), (v) => naJanela(v) && v.dias_atras >= 1);

  // Nº do lacre do malote: o UNICO dado manual da capa da frente. Grava sem
  // mexer em chegada/status (PUT /tms/viagens/:id/lacre {lacre}).
  const lacre = async (req, res) => {
    try {
      const valor = String(req.body?.lacre ?? "").trim().slice(0, 40) || null;
      const r = await db.query(
        "UPDATE tms_viagens SET lacre = $1, atualizado_em = NOW() WHERE id = $2 RETURNING id, lacre",
        [valor, req.params.id]);
      if (!r.rowCount) return res.status(404).json({ error: "Viagem nao encontrada." });
      await registrarAuditoria(req, "LACRE", "tms_viagens", req.params.id, { lacre: valor });
      res.status(200).json(r.rows[0]);
    } catch (err) {
      console.error("[LACRE]", err);
      res.status(500).json({ error: err.message });
    }
  };

  return { chegada, retorno, lacre, hotelChegada, hotelSaida };
}

// Rota de viagem ainda dentro da janela de pernoite (hoje ou ate N dias atras).
const naJanela = (v) => pernoite.ehRotaViagem(v.rota) && v.dias_atras >= 0 && v.dias_atras <= pernoite.DIAS_CONTINUA;

const OCORRENCIAS_DA_VIAGEM = `(o.viagem_id = $1 OR o.id IN (SELECT ocorrencia_id FROM tms_paradas WHERE viagem_id = $1 AND ocorrencia_id IS NOT NULL))
   AND o.excluida_em IS NULL`;
async function temLojaDiaSeguinte(client, id) {
  const r = await client.query(`SELECT 1 FROM ocorrencias o WHERE ${OCORRENCIAS_DA_VIAGEM} AND o.dia_seguinte LIMIT 1`, [id]);
  return r.rowCount > 0;
}
// Sem o 🏨 "No hotel": a parada no hotel e a saida da ultima loja do 1o dia.
async function ultimaSaidaDia1(client, id) {
  const r = await client.query(`SELECT to_char(MAX(o.fim_descarga), 'HH24:MI') AS h FROM ocorrencias o
      WHERE ${OCORRENCIAS_DA_VIAGEM} AND NOT o.dia_seguinte`, [id]);
  return r.rows[0]?.h || null;
}

// Regra do formulario "Tempo de Rota" com viagem (script-5 calcularDadosRota):
// jornada = (saida -> hotel) + (saida do hotel -> retorno); 1h de almoco
// descontada em cada dia acima de 6h.
function jornadaPernoite(saida, paradaHotel, saidaHotel, retorno) {
  const min = (h) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
  const trecho = (de, para) => { let m = min(para) - min(de); if (m < 0) m += 1440; return m; };
  const dia1 = trecho(saida, paradaHotel), dia2 = trecho(saidaHotel, retorno);
  const total = dia1 + dia2;
  const trabalhado = [dia1, dia2].reduce((a, t) => a + (t > 360 ? t - 60 : t), 0);
  const normais = Math.min(trabalhado, 480);
  const extras = Math.min(Math.max(trabalhado - 480, 0), 240);
  const excedentes = Math.max(trabalhado - 720, 0);
  return {
    total_min: total, trabalhado_min: trabalhado, horas: Math.floor(total / 60), minutos: total % 60,
    minutos_normais: normais, minutos_extras_permitidos: extras, minutos_excedentes: excedentes,
    valor_extra_aprox: Math.round((extras / 60) * 15 * 100) / 100, dia1_min: dia1, dia2_min: dia2,
  };
}

// Grava/atualiza o Tempo de Rota de viagem. Registro de viagem lancado no
// formulario (obs sem "TMS") manda: nao sobrescreve.
async function gravarTempoRotaViagem(client, v, hora, paradaHotel, saidaHotel, j, hotelEstimado, doRastreador = false) {
  const existente = await client.query(`
      SELECT id, is_viagem, COALESCE(obs, '') AS obs FROM rotas_registradas
       WHERE data = $1 AND UPPER(TRIM(motorista)) = UPPER(TRIM($2))
       ORDER BY id DESC LIMIT 1`, [v.data_iso, v.motorista]);
  const ex = existente.rows[0];
  if (ex && ex.is_viagem && !/TMS/.test(ex.obs)) return { id: ex.id, ignorado: "registro de viagem do formulario ja existe" };
  if (ex && doRastreador) return { id: ex.id, ignorado: "Tempo de Rota ja lancado" };
  const obs = `Registrado pelo TMS (${doRastreador ? "🛰 rastreador" : "🏁 Voltou"}, pernoite${hotelEstimado ? "; chegada no hotel = saida da ultima loja do 1o dia" : ""})`;
  const calc = [v.placa, v.rota, v.saida, hora, j.total_min, j.horas, j.minutos, j.minutos_normais,
    j.minutos_extras_permitidos, j.minutos_excedentes, j.valor_extra_aprox, paradaHotel, saidaHotel, obs];
  if (ex) {
    await client.query(`
        UPDATE rotas_registradas SET placa = COALESCE(NULLIF(placa, ''), $1), rota_feita = COALESCE(NULLIF(rota_feita, ''), $2),
               saida = $3, retorno = $4, total_min = $5, horas = $6, minutos = $7, minutos_normais = $8,
               minutos_extras_permitidos = $9, minutos_excedentes = $10, valor_extra_aprox = $11,
               parada_hotel = $12, saida_hotel = $13, obs = $14, is_viagem = TRUE
         WHERE id = $15`, [...calc, ex.id]);
    return { id: ex.id, atualizado: true };
  }
  const id = Date.now() % 2147483647;
  await client.query(`
      INSERT INTO rotas_registradas (id, data, motorista, placa, rota_feita, saida, retorno, total_min, horas, minutos,
             minutos_normais, minutos_extras_permitidos, minutos_excedentes, valor_extra_aprox, parada_hotel, saida_hotel, obs, is_viagem)
      VALUES ($15, $16, $17, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, TRUE)`,
    [...calc, id, v.data_iso, v.motorista]);
  return { id, criado: true };
}

// Status que anda sozinho. Devolve as mudancas feitas.
async function autoStatus({ db, registrarAuditoria }) {
  const todasFeitas = `
      EXISTS (SELECT 1 FROM tms_paradas p WHERE p.viagem_id = v.id)
      AND NOT EXISTS (SELECT 1 FROM tms_paradas p WHERE p.viagem_id = v.id AND NOT ${PARADA_FEITA_SQL})`;
  // Rota de viagem de ontem que saiu e ainda nao voltou: esta voltando do
  // pernoite — vai para Retorno, nao para Finalizada (sumiria antes do 🏁).
  const viagemLongaAberta = `v.data_viagem < CURRENT_DATE AND v.data_viagem >= CURRENT_DATE - ${Number(pernoite.DIAS_CONTINUA)}
      AND v.saida_real IS NOT NULL AND v.retorno_real IS NULL AND ${pernoite.sqlEhRotaViagem("v.rota_nome")}`;
  const voltando = await db.query(`
      UPDATE tms_viagens v SET status = 'Retorno', atualizado_em = NOW()
       WHERE (v.data_viagem = CURRENT_DATE OR (${viagemLongaAberta}))
         AND v.status = 'Em rota' AND ${todasFeitas}
      RETURNING v.id, 'Em rota' AS de, 'Retorno' AS para`);
  const fechadas = await db.query(`
      UPDATE tms_viagens v SET status = 'Finalizada', finalizada_em = NOW(), finalizada_auto = TRUE, atualizado_em = NOW()
        FROM (SELECT id, status AS antes FROM tms_viagens) a
       WHERE a.id = v.id AND v.data_viagem < CURRENT_DATE AND v.status = ANY($1::text[]) AND ${todasFeitas}
         AND NOT (${viagemLongaAberta})
      RETURNING v.id, a.antes AS de, 'Finalizada' AS para`, [ABERTAS]);
  const mudancas = [...voltando.rows, ...fechadas.rows];
  for (const m of mudancas) {
    await registrarAuditoria({}, "AUTO_STATUS", "tms_viagens", m.id, { de: m.de, para: m.para });
  }
  return mudancas;
}

let timer = null;
function iniciar({ db, registrarAuditoria }) {
  const ms = Number(process.env.TMS_AUTO_STATUS_MS || 2 * 60 * 1000);
  if (!ms) return;
  const rodar = () => autoStatus({ db, registrarAuditoria })
    .then((m) => { if (m.length) console.log(`[tms-ciclo] status automatico: ${m.length} viagem(ns) (${m.map((x) => `${x.id}:${x.de}->${x.para}`).join(", ")})`); })
    .catch((err) => console.error("[tms-ciclo] status automatico falhou:", err.message));
  setTimeout(rodar, 15000);
  if (timer) clearInterval(timer);
  timer = setInterval(rodar, ms);
  console.log(`[tms-ciclo] status automatico ativo (a cada ${Math.round(ms / 1000)}s)`);
}

module.exports = { garantirColunas, criarRotas, autoStatus, iniciar, jornada };
