// ================================================================
// km-real-viagem.js — KM REAL da viagem preenchido pelo GPS.
// ----------------------------------------------------------------
// O campo "KM real" do TMS (tms_viagens.km_real) alimenta custo por km, mas
// quase ninguem digita. O resumo diario da frota (frota-diario.js, tabela
// frota_resumo_dia) ja tem o km rodado por placa e a viagem do TMS ligada a
// ela naquele dia — aqui so juntamos os dois.
//
// Regras (para nao gravar numero errado):
//   - so viagem FINALIZADA e com km_real VAZIO (o digitado nunca e trocado;
//     depois de preenchido pelo GPS o usuario pode corrigir no Editar);
//   - so dias que ja terminaram; rota de viagem (pernoite) soma o dia da
//     viagem + o seguinte e espera os dois acabarem;
//   - placa com 2+ viagens no mesmo dia fica de fora (o km do dia nao diz de
//     qual viagem e cada trecho);
//   - km muito baixo (< 5) ou menor que 40% do previsto = buraco de sinal:
//     nao grava (o resumo ainda pode ser recalculado com mais pontos).
// km_real_origem = 'gps' marca o que veio daqui (o Editar continua livre).
// ================================================================
const rastreador = require("./rastreador");

const DIAS_ATRAS = Number(process.env.KM_REAL_GPS_DIAS || 14);
const INTERVALO_MS = Number(process.env.KM_REAL_GPS_MS || 30 * 60000);
const KM_MIN = 5;
const FRACAO_MIN_PREVISTO = 0.4;

const somaDias = (data, n) => { const d = new Date(`${data}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function garantir(db) {
  await db.query("ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS km_real_origem TEXT");
}

async function preencher({ db, diario, agoraSP, ehRotaViagem, registrarAuditoria }) {
  await garantir(db);
  const hoje = agoraSP().data;
  const de = somaDias(hoje, -DIAS_ATRAS);
  const ontem = somaDias(hoje, -1);

  const pend = await db.query(`
    SELECT v.id, to_char(v.data_viagem, 'YYYY-MM-DD') AS data, v.placa, v.rota_nome, v.km_previsto,
           (SELECT COUNT(*) FROM tms_viagens o
             WHERE o.data_viagem = v.data_viagem AND o.id <> v.id AND o.status <> 'Cancelada'
               AND upper(regexp_replace(o.placa, '[^A-Za-z0-9]', '', 'g')) = upper(regexp_replace(v.placa, '[^A-Za-z0-9]', '', 'g'))) AS outras
      FROM tms_viagens v
     WHERE v.status = 'Finalizada' AND v.km_real IS NULL AND v.placa IS NOT NULL
       AND v.data_viagem BETWEEN $1::date AND $2::date
     ORDER BY v.data_viagem`, [de, ontem]);
  if (!pend.rows.length) return [];

  const resumos = new Map(); // data -> { placa: resumo }
  const doDia = async (data) => {
    if (!resumos.has(data)) resumos.set(data, await diario.resumoDoDia(data).catch(() => ({})));
    return resumos.get(data);
  };

  const gravadas = [];
  for (const v of pend.rows) {
    if (Number(v.outras) > 0) continue;
    const longa = !!(ehRotaViagem && ehRotaViagem(v.rota_nome));
    const dias = longa ? [v.data, somaDias(v.data, 1)] : [v.data];
    if (dias[dias.length - 1] > ontem) continue; // 2o dia da rota de viagem ainda nao acabou
    const placa = rastreador.placaMercosul(v.placa);
    let km = 0, previsto = Number(v.km_previsto) || null;
    for (const d of dias) {
      const r = (await doDia(d))[placa];
      // No 2o dia so conta se o resumo ainda e desta viagem (nao de outra nova).
      if (!r || (d !== v.data && r.viagem && r.viagem.id && r.viagem.id !== v.id)) continue;
      km += Number(r.km) || 0;
      if (!previsto && r.viagem && r.viagem.id === v.id && r.viagem.km_previsto) previsto = r.viagem.km_previsto;
    }
    if (km < KM_MIN || (previsto && km < previsto * FRACAO_MIN_PREVISTO)) continue;
    km = Math.round(km * 10) / 10;
    const up = await db.query(
      "UPDATE tms_viagens SET km_real = $1, km_real_origem = 'gps', atualizado_em = NOW() WHERE id = $2 AND km_real IS NULL",
      [km, v.id]);
    if (!up.rowCount) continue;
    gravadas.push({ id: v.id, data: v.data, placa, km, previsto });
    if (registrarAuditoria) {
      await registrarAuditoria({ usuarioLogado: null, ip: null }, "KM_REAL_GPS", "tms_viagens", v.id,
        { km_real: km, km_previsto: previsto, dias }).catch(() => {});
    }
  }
  return gravadas;
}

let timer = null;
function iniciar(deps) {
  if (!INTERVALO_MS) { console.log("[km-real] KM_REAL_GPS_MS=0 — desligado"); return; }
  const rodar = () => preencher(deps)
    .then((g) => { if (g.length) console.log(`[km-real] km real pelo GPS em ${g.length} viagem(ns): ${g.map((x) => `${x.id}=${x.km}km`).join(", ")}`); })
    .catch((err) => console.error("[km-real] falhou:", err.message));
  setTimeout(rodar, 3 * 60000); // depois do boot assentar (resumos de dias passados podem ser calculados aqui)
  if (timer) clearInterval(timer);
  timer = setInterval(rodar, INTERVALO_MS);
}

module.exports = { preencher, iniciar };
