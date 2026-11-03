// ================================================================
// preencher-atrasos-entregas.js  —  USO ÚNICO
// ----------------------------------------------------------------
// Preenche (backfill) os campos `sla_status` e `otif_status` da tabela
// `ocorrencias` nos registros ANTIGOS que estão com esses campos vazios.
//
// Usa EXATAMENTE a mesma lógica de indicadoresEntrega() do server.js:
//   sla_status : compara hora_agendada_loja x hora_chegada, com TOLERANCIA
//                de 20 min (TOLERANCIA_ATRASO_MIN em back/tempo.js)
//                  -> "Atrasada"  (chegou MAIS de 20 min depois do agendado)
//                  -> "No prazo"  (chegou até 20 min depois, ou antes)
//                  -> "Sem prazo" (falta hora agendada ou hora de chegada)
//   otif_status: derivado de sla_status + entrega_completa
//                  -> "Conforme"     (No prazo E entrega completa)
//                  -> "Sem SLA"      (Sem prazo)
//                  -> "Nao conforme" (demais casos)
//
// IN FULL DERIVADO: quando `entrega_completa` está em branco (o campo vive
// numa seção escondida do formulário e quase nunca chega ao banco), quem
// decide é a OCORRÊNCIA LANÇADA — mesmas regras do servidor, em
// public/js/kpi-ocorrencia.js. Em branco NÃO é mais sinônimo de "incompleta":
// entrega sem ocorrência conta como completa. Para CORRIGIR o `false` que a
// versão anterior gravou, use back/recalcular-infull-ocorrencia.js.
//
// Só toca em linhas onde sla_status OU otif_status estão NULL.
// Registros que já têm os indicadores preenchidos NÃO são alterados.
//
// FAÇA BACKUP DO BANCO ANTES DE RODAR.
//
// Como rodar (na pasta do projeto, na máquina do servidor):
//     node back/preencher-atrasos-entregas.js              -> grava de verdade
//     node back/preencher-atrasos-entregas.js --dry-run    -> só simula/mostra
// ================================================================

const db = require("./db");
const { classificarSla } = require("./tempo");
const { derivarEntregaCompleta } = require("../public/js/kpi-ocorrencia.js");

// --- réplicas fiéis das funções do server.js -------------------
function vazioParaNull(valor) {
  return valor === undefined || valor === null || valor === "" ? null : valor;
}

function textoParaBoolean(valor) {
  if (valor === true) return true;
  if (valor === false) return false;
  const texto = String(valor || "").trim().toLowerCase();
  return texto === "true" || texto === "sim" || texto === "feito" || texto === "realizou";
}

// calcularMinutos: fonte unica em ./tempo.js (require no topo).

function indicadores(dados) {
  const agendada = vazioParaNull(dados.hora_agendada_loja);
  const chegada = vazioParaNull(dados.hora_chegada);
  const informado = vazioParaNull(dados.entrega_completa);
  const completa =
    informado === null
      ? derivarEntregaCompleta(dados)
      : textoParaBoolean(informado);
  const slaStatus = classificarSla(agendada, chegada);
  const otifStatus =
    slaStatus === "No prazo" && completa
      ? "Conforme"
      : slaStatus === "Sem prazo"
        ? "Sem SLA"
        : "Nao conforme";
  return { slaStatus, otifStatus };
}
// ---------------------------------------------------------------

const DRY = process.argv.includes("--dry-run");

async function main() {
  const client = await db.connect();
  try {
    const { rows } = await client.query(`
      SELECT id, hora_agendada_loja, hora_chegada, entrega_completa,
             teve_ocorrencia, tipo_problema, sacola_status,
             almoxerifado_status, material_envio_status, volume_divergencia
        FROM ocorrencias
       WHERE sla_status IS NULL OR otif_status IS NULL
       ORDER BY id
    `);

    console.log(
      `Registros sem SLA/OTIF: ${rows.length}${DRY ? "  (DRY-RUN: nada será gravado)" : ""}`,
    );
    if (rows.length === 0) {
      console.log("Nada a preencher. Encerrando.");
      return;
    }

    const contagem = { Atrasada: 0, "No prazo": 0, "Sem prazo": 0 };

    if (!DRY) await client.query("BEGIN");

    let processados = 0;
    for (const r of rows) {
      const { slaStatus, otifStatus } = indicadores(r);
      contagem[slaStatus] = (contagem[slaStatus] || 0) + 1;
      if (!DRY) {
        await client.query(
          "UPDATE ocorrencias SET sla_status = $1, otif_status = $2 WHERE id = $3",
          [slaStatus, otifStatus, r.id],
        );
      }
      processados += 1;
    }

    if (!DRY) await client.query("COMMIT");

    console.log(`✅ ${DRY ? "Simulados" : "Atualizados"}: ${processados} registro(s).`);
    console.log(
      `   Atrasada: ${contagem["Atrasada"] || 0} | ` +
        `No prazo: ${contagem["No prazo"] || 0} | ` +
        `Sem prazo: ${contagem["Sem prazo"] || 0}`,
    );
    if (DRY) console.log("\n(DRY-RUN) Rode sem --dry-run para gravar de verdade.");
  } catch (err) {
    if (!DRY) await client.query("ROLLBACK").catch(() => {});
    console.error("❌ Falhou, nenhuma alteração foi feita:", err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    process.exit();
  }
}

main();
