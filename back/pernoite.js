// ================================================================
// pernoite.js — rotas de VIAGEM (o caminhao dorme fora)
// ----------------------------------------------------------------
// NORTE FLUMINENSE, ALTERNATIVA, BAIXADA + SERRANA e REGIAO DOS LAGOS saem
// num dia, fazem parte das lojas, a equipe dorme num hotel na regiao e no
// dia seguinte segue a viagem. Ex. real (R.LAGOS 25/08): saiu 14:04, fez
// Marica II, Marica I, Saquarema II ate 20:36, dormiu, e no dia seguinte
// fez Araruama 08:08 e Iguaba 09:30.
//
// CONVENCAO (uma so, em todo o sistema):
//   - a ocorrencia fica com a DATA DA VIAGEM (a rota do dia anterior) — e o
//     que o TMS ja fazia e o que o operador espera ("registro da rota
//     anterior no dia seguinte");
//   - a coluna `dia_seguinte` diz que aquela loja foi feita no dia seguinte
//     (depois do pernoite). Instante real = data_ocorrencia + 1 dia + hora.
//   Sem a marca, Araruama 08:08 parecia ter sido feita 6h ANTES da saida da
//   fabrica, o que estragava trecho, tempo de rota, jornada e previsao.
//
// Deducao automatica (quando o formulario nao manda a marca): rota de
// viagem com chegada ANTES da saida da fabrica so pode ser no dia seguinte.
// Nao da para deduzir mais que isso: o motorista inverte a ordem planejada
// (NORTE FLUMINENSE 20/08 fez Macae III no 1o dia e Macae I no 2o).
// ================================================================

const ROTA_VIAGEM_RE = /FLUMINENSE|ALTERNATIVA|SERR[AE]N|LAGOS/;
// Quantos dias para tras uma viagem de rota longa ainda "continua" no TMS.
const DIAS_CONTINUA = Math.max(1, Number(process.env.TMS_PERNOITE_DIAS || 1));

function normalizar(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();
}

function ehRotaViagem(nome) {
  return ROTA_VIAGEM_RE.test(normalizar(nome));
}

// Mesma regra em SQL (para filtros/backfill). `col` e uma expressao de texto.
function sqlEhRotaViagem(col) {
  return `(translate(UPPER(COALESCE(${col}, '')), 'ÁÀÂÃÉÊÍÓÔÕÚÇ', 'AAAAEEIOOOUC') ~ '${ROTA_VIAGEM_RE.source}')`;
}

const minDe = (h) => {
  const m = String(h || "").match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

function deduzirDiaSeguinte({ rota, hora_chegada, hora_saida_fabrica }) {
  if (!ehRotaViagem(rota)) return false;
  const chegada = minDe(hora_chegada), saida = minDe(hora_saida_fabrica);
  return chegada != null && saida != null && chegada < saida;
}

function lerBooleano(valor) {
  if (valor === true || valor === false) return valor;
  const t = String(valor ?? "").trim().toLowerCase();
  if (["true", "sim", "1", "on"].includes(t)) return true;
  if (["false", "nao", "não", "0", "off", ""].includes(t)) return false;
  return null;
}

async function garantirColunas(db) {
  await db.query("ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS dia_seguinte BOOLEAN NOT NULL DEFAULT FALSE");
  // Backfill UNICO dos casos CERTOS do historico (chegada antes da saida da
  // fabrica numa rota de viagem). Uma vez so: se alguem desmarcar a mao
  // depois, o boot nao remarca.
  const feito = await db.query("SELECT 1 FROM sistema_config WHERE chave = 'pernoite_backfill_v1'");
  if (feito.rowCount) return;
  const r = await db.query(`
      UPDATE ocorrencias SET dia_seguinte = TRUE
       WHERE dia_seguinte = FALSE AND excluida_em IS NULL
         AND hora_chegada IS NOT NULL AND hora_saida_fabrica IS NOT NULL
         AND hora_chegada < hora_saida_fabrica
         AND ${sqlEhRotaViagem("rota")}`);
  await db.query("INSERT INTO sistema_config (chave, valor) VALUES ('pernoite_backfill_v1', to_jsonb($1::int)) ON CONFLICT (chave) DO NOTHING", [r.rowCount]);
  console.log(`[pernoite] backfill: ${r.rowCount} ocorrencia(s) marcadas como dia seguinte.`);
}

// Depois do INSERT/UPDATE da ocorrencia (o INSERT tem 90 parametros
// posicionais; gravar a marca a parte evita renumerar tudo).
//   - formulario mandou `dia_seguinte`: vale o que veio;
//   - nao mandou (cliente antigo em cache, importacao): so marca quando a
//     deducao e certa, nunca desmarca.
async function gravarDiaSeguinte(db, id, body) {
  if (!id) return;
  const informado = body && Object.prototype.hasOwnProperty.call(body, "dia_seguinte")
    ? lerBooleano(body.dia_seguinte) : null;
  if (informado !== null) {
    await db.query("UPDATE ocorrencias SET dia_seguinte = $1 WHERE id = $2", [informado, id]);
    return;
  }
  const r = await db.query(
    `SELECT o.rota, COALESCE(v.rota_nome, '') AS rota_viagem,
            to_char(o.hora_chegada, 'HH24:MI') AS hora_chegada,
            to_char(o.hora_saida_fabrica, 'HH24:MI') AS hora_saida_fabrica
       FROM ocorrencias o LEFT JOIN tms_viagens v ON v.id = o.viagem_id
      WHERE o.id = $1`, [id]);
  const o = r.rows[0];
  if (!o) return;
  const rota = `${o.rota || ""} ${o.rota_viagem || ""}`;
  if (deduzirDiaSeguinte({ rota, hora_chegada: o.hora_chegada, hora_saida_fabrica: o.hora_saida_fabrica })) {
    await db.query("UPDATE ocorrencias SET dia_seguinte = TRUE WHERE id = $1", [id]);
  }
}

module.exports = {
  DIAS_CONTINUA,
  ehRotaViagem,
  sqlEhRotaViagem,
  deduzirDiaSeguinte,
  garantirColunas,
  gravarDiaSeguinte,
};
