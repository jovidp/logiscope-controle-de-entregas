// ================================================================
// recalcular-infull-ocorrencia.js  —  MIGRACAO DE UMA VEZ
// ----------------------------------------------------------------
// Conserta o `entrega_completa` (In Full) das entregas JA GRAVADAS e
// reclassifica o `otif_status` / `sla_status` a partir dele.
//
// O QUE ESTAVA ERRADO
// -------------------
// O campo "Entrega Completa?" vive numa secao ESCONDIDA do formulario
// (data-modulo-futuro="sla-otif") e nunca chegava ao servidor. La, o
// `textoParaBoolean(undefined)` devolvia FALSE — entao TODA entrega salva era
// gravada como "nao completa" e o OTIF saia "Nao conforme", mesmo em entrega
// sem nenhuma ocorrencia e dentro do prazo.
//
// Sintoma na base em 26/08/2026: 157 entregas 'No prazo' marcadas
// 'Nao conforme', e junho/julho/agosto com 100% de entrega_completa = false.
//
// O QUE ESTE SCRIPT FAZ
// ---------------------
// Recalcula o In Full a partir da OCORRENCIA LANCADA (regras unicas em
// public/js/kpi-ocorrencia.js — as mesmas que o servidor passa a usar):
// so e' incompleta quem tem sinal concreto de falta (mercadoria a menos,
// divergencia de volume/peca, erro de separacao, loja fechada, sacola ou
// material parcial...). Atraso, documento e demora de conferencia NAO tornam
// a entrega incompleta — pesam em outros indicadores.
//
// LIMITES DE SEGURANCA
// --------------------
//  - NAO derruba In Full que ja esta TRUE. Um `true` foi afirmado por alguem
//    (importacao / edicao manual); rebaixa-lo pioraria o OTIF por conta de uma
//    regra automatica. Os casos em que a regra discordaria sao apenas
//    RELATADOS. Use --rebaixar-verdadeiros se quiser aplica-los tambem.
//  - PRESERVA ATRASO MARCADO NA MAO (auditoria acao = 'MARCAR_ATRASO'):
//    e' decisao humana, nao calculo.
//  - Nao mexe em entrega excluida (excluida_em IS NOT NULL).
//
// FACA BACKUP DO BANCO ANTES DE RODAR.
//
// Como rodar (na pasta do projeto, na maquina do servidor):
//     node back/recalcular-infull-ocorrencia.js --dry-run   -> so simula
//     node back/recalcular-infull-ocorrencia.js             -> grava
//     node back/recalcular-infull-ocorrencia.js --desde 2026-06-01
// ================================================================

const db = require("./db");
const { classificarSla } = require("./tempo");
const { classificarOcorrenciaKpi } = require("../public/js/kpi-ocorrencia.js");

const DRY = process.argv.includes("--dry-run");
const REBAIXAR = process.argv.includes("--rebaixar-verdadeiros");
const idxDesde = process.argv.indexOf("--desde");
const DESDE = idxDesde !== -1 ? process.argv[idxDesde + 1] : null;

function otifDe(slaStatus, completa) {
  if (slaStatus === "No prazo" && completa) return "Conforme";
  if (slaStatus === "Sem prazo") return "Sem SLA";
  return "Nao conforme";
}

async function main() {
  const client = await db.connect();
  try {
    if (DESDE && !/^\d{4}-\d{2}-\d{2}$/.test(DESDE)) {
      throw new Error("--desde precisa ser uma data no formato AAAA-MM-DD.");
    }

    // IDs com atraso marcado na mao — SLA intocavel.
    const manuais = new Set();
    const aud = await client.query(`
      SELECT DISTINCT recurso_id
        FROM sistema_auditoria
       WHERE acao = 'MARCAR_ATRASO' AND recurso = 'ocorrencias'
         AND recurso_id IS NOT NULL
    `);
    aud.rows.forEach((r) => manuais.add(String(r.recurso_id)));

    const params = DESDE ? [DESDE] : [];
    const { rows } = await client.query(
      `
      SELECT id,
             data_ocorrencia,
             hora_agendada_loja::text AS hora_agendada_loja,
             hora_chegada::text       AS hora_chegada,
             teve_ocorrencia,
             tipo_problema,
             sacola_status,
             almoxerifado_status,
             material_envio_status,
             volume_divergencia,
             entrega_completa,
             sla_status,
             otif_status
        FROM ocorrencias
       WHERE excluida_em IS NULL
         ${DESDE ? "AND data_ocorrencia >= $1::date" : ""}
       ORDER BY id
    `,
      params,
    );

    console.log(
      `Entregas analisadas: ${rows.length}` +
        (DESDE ? `  (desde ${DESDE})` : "") +
        (DRY ? "   (DRY-RUN: nada sera gravado)" : ""),
    );
    console.log(`Atrasos marcados na mao (SLA preservado): ${manuais.size}`);

    const mudancas = [];
    const rebaixamentosIgnorados = [];
    let semTipoConhecido = 0;

    for (const r of rows) {
      const relacao = classificarOcorrenciaKpi(r);
      let completaNova = relacao.inFull;

      if (relacao.desconhecidos.length > 0) semTipoConhecido += 1;

      // Trava: nao rebaixar um TRUE afirmado por alguem.
      if (r.entrega_completa === true && completaNova === false) {
        if (REBAIXAR) {
          // segue com o rebaixamento
        } else {
          rebaixamentosIgnorados.push({
            id: r.id,
            motivos: relacao.inFullMotivos.join("; "),
          });
          completaNova = true;
        }
      }

      const slaNovo = manuais.has(String(r.id))
        ? r.sla_status
        : classificarSla(r.hora_agendada_loja, r.hora_chegada);
      const otifNovo = manuais.has(String(r.id))
        ? "Nao conforme"
        : otifDe(slaNovo, completaNova === true);

      if (
        completaNova !== r.entrega_completa ||
        slaNovo !== r.sla_status ||
        otifNovo !== r.otif_status
      ) {
        mudancas.push({
          id: r.id,
          completaDe: r.entrega_completa,
          completaPara: completaNova,
          slaDe: r.sla_status,
          slaPara: slaNovo,
          otifDe: r.otif_status,
          otifPara: otifNovo,
          tipo: r.tipo_problema || "(sem ocorrencia)",
        });
      }
    }

    const viraramCompletas = mudancas.filter(
      (m) => m.completaDe !== true && m.completaPara === true,
    ).length;
    const viraramConformes = mudancas.filter(
      (m) => m.otifDe !== "Conforme" && m.otifPara === "Conforme",
    ).length;
    const ganharamSla = mudancas.filter(
      (m) => m.slaDe === null && m.slaPara !== null,
    ).length;

    console.log(`\nRegistros que mudam: ${mudancas.length}`);
    console.log(`  In Full corrigido para COMPLETA: ${viraramCompletas}`);
    console.log(`  OTIF passa a 'Conforme': ${viraramConformes}`);
    if (ganharamSla > 0) {
      console.log(`  Entravam sem SLA e passam a ter classificacao: ${ganharamSla}`);
    }
    if (semTipoConhecido > 0) {
      console.log(
        `  ⚠ ${semTipoConhecido} entrega(s) com tipo de ocorrencia fora do catalogo ` +
          "(nao alteram o In Full — ver kpi-ocorrencia.js).",
      );
    }
    if (rebaixamentosIgnorados.length > 0) {
      console.log(
        `\n⚠ ${rebaixamentosIgnorados.length} entrega(s) estao gravadas como COMPLETAS ` +
          "mas a ocorrencia indica falta. NAO foram rebaixadas.\n" +
          "  Para aplicar tambem esses casos: --rebaixar-verdadeiros",
      );
      rebaixamentosIgnorados.slice(0, 5).forEach((m) => {
        console.log(`    #${m.id}: ${m.motivos}`);
      });
    }

    if (mudancas.length === 0) {
      console.log("\nNada a alterar. Encerrando.");
      return;
    }

    console.log("\nAmostra (ate 10):");
    mudancas.slice(0, 10).forEach((m) => {
      console.log(
        `  #${m.id} [${m.tipo}]: completa ${m.completaDe} -> ${m.completaPara}` +
          `  |  SLA ${m.slaDe} -> ${m.slaPara}  |  OTIF ${m.otifDe} -> ${m.otifPara}`,
      );
    });

    if (DRY) {
      console.log("\n(DRY-RUN) Rode sem --dry-run para gravar de verdade.");
      return;
    }

    await client.query("BEGIN");
    for (const m of mudancas) {
      await client.query(
        `UPDATE ocorrencias
            SET entrega_completa = $1, sla_status = $2, otif_status = $3
          WHERE id = $4`,
        [m.completaPara, m.slaPara, m.otifPara, m.id],
      );
    }
    await client.query("COMMIT");

    console.log(`\n✅ Atualizados: ${mudancas.length} registro(s).`);
    console.log(
      "Os paineis OTIF/SLA tem cache de alguns minutos — reinicie o servidor " +
        "ou aguarde o cache expirar para ver os numeros novos.",
    );
  } catch (err) {
    if (!DRY) await client.query("ROLLBACK").catch(() => {});
    console.error("❌ Falhou, nenhuma alteracao foi feita:", err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    process.exit();
  }
}

main();
