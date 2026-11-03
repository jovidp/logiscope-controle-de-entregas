// ================================================================
// recalcular-sla-tolerancia.js  —  MIGRACAO DE UMA VEZ
// ----------------------------------------------------------------
// Reclassifica `sla_status` / `otif_status` das entregas JA GRAVADAS
// aplicando a tolerancia de atraso (TOLERANCIA_ATRASO_MIN, back/tempo.js).
//
// Antes: chegar 1 minuto depois do horario agendado ja era "Atrasada".
// Agora: so e "Atrasada" quem passou da tolerancia. Entregas dentro da
// janela viram "No prazo" (e o OTIF acompanha).
//
// So mexe em linhas que TEM hora_agendada_loja E hora_chegada — sao as
// unicas que a tolerancia pode mudar. Quem nao tem horario continua
// "Sem prazo".
//
// TAMBEM NAO MEXE em linhas com sla_status NULL: essas nunca foram
// classificadas (e trabalho do preencher-atrasos-entregas.js), e preenche-las
// aqui mudaria os paineis OTIF por um motivo que nao tem nada a ver com
// tolerancia. Elas so sao CONTADAS e reportadas no fim.
//
// PRESERVA ATRASO MARCADO NA MAO: entregas registradas pelo botao
// "REGISTRAR ATRASO SLA" (POST /ocorrencias/:id/marcar-atraso) sao uma
// decisao humana, nao um calculo — se fossem recalculadas, a marcacao
// seria silenciosamente desfeita. Elas sao identificadas pela auditoria
// (acao = 'MARCAR_ATRASO') e ficam de fora.
//
// FACA BACKUP DO BANCO ANTES DE RODAR.
//
// Como rodar (na pasta do projeto, na maquina do servidor):
//     node back/recalcular-sla-tolerancia.js --dry-run   -> so simula/mostra
//     node back/recalcular-sla-tolerancia.js             -> grava de verdade
// ================================================================

const db = require("./db");
const { classificarSla, TOLERANCIA_ATRASO_MIN } = require("./tempo");

const DRY = process.argv.includes("--dry-run");

function otifDe(slaStatus, completa) {
  if (slaStatus === "No prazo" && completa) return "Conforme";
  if (slaStatus === "Sem prazo") return "Sem SLA";
  return "Nao conforme";
}

async function main() {
  const client = await db.connect();
  try {
    // IDs com atraso marcado na mao — intocaveis.
    const manuais = new Set();
    const aud = await client.query(`
      SELECT DISTINCT recurso_id
        FROM sistema_auditoria
       WHERE acao = 'MARCAR_ATRASO' AND recurso = 'ocorrencias'
         AND recurso_id IS NOT NULL
    `);
    aud.rows.forEach((r) => manuais.add(String(r.recurso_id)));

    const { rows } = await client.query(`
      SELECT id,
             hora_agendada_loja::text AS hora_agendada_loja,
             hora_chegada::text       AS hora_chegada,
             entrega_completa,
             sla_status,
             otif_status
        FROM ocorrencias
       WHERE excluida_em IS NULL
         AND hora_agendada_loja IS NOT NULL
         AND hora_chegada IS NOT NULL
       ORDER BY id
    `);

    console.log(
      `Tolerancia aplicada: ${TOLERANCIA_ATRASO_MIN} min` +
        `${DRY ? "   (DRY-RUN: nada sera gravado)" : ""}`,
    );
    console.log(`Entregas com horario agendado e chegada: ${rows.length}`);
    console.log(`Atrasos marcados na mao (preservados): ${manuais.size}`);

    const mudancas = [];
    let preservados = 0;
    let semClassificacao = 0;

    for (const r of rows) {
      if (manuais.has(String(r.id))) {
        preservados += 1;
        continue;
      }
      // Nunca classificada: fora do escopo desta migracao (ver cabecalho).
      if (r.sla_status === null || r.sla_status === undefined) {
        semClassificacao += 1;
        continue;
      }
      const slaNovo = classificarSla(r.hora_agendada_loja, r.hora_chegada);
      const otifNovo = otifDe(slaNovo, r.entrega_completa === true);
      if (slaNovo !== r.sla_status || otifNovo !== r.otif_status) {
        mudancas.push({
          id: r.id,
          de: r.sla_status,
          para: slaNovo,
          otifDe: r.otif_status,
          otifPara: otifNovo,
        });
      }
    }

    const viraramNoPrazo = mudancas.filter(
      (m) => m.de === "Atrasada" && m.para === "No prazo",
    ).length;
    const outras = mudancas.length - viraramNoPrazo;

    console.log(`\nRegistros que mudam: ${mudancas.length}`);
    console.log(`  Atrasada -> No prazo (efeito da tolerancia): ${viraramNoPrazo}`);
    if (outras > 0) {
      console.log(`  Outras correcoes (SLA/OTIF fora de sincronia): ${outras}`);
    }
    if (preservados > 0) {
      console.log(`  Ignorados por marcacao manual: ${preservados}`);
    }
    if (semClassificacao > 0) {
      console.log(
        `\n⚠ ${semClassificacao} entrega(s) com horario mas SEM sla_status ` +
          "(nunca classificadas) — NAO tocadas aqui.\n" +
          "  Isso e outro assunto: rode 'node back/preencher-atrasos-entregas.js --dry-run'\n" +
          "  se quiser trata-las. Elas entrariam nos paineis OTIF como novas.",
      );
    }

    if (mudancas.length === 0) {
      console.log("\nNada a alterar. Encerrando.");
      return;
    }

    console.log("\nAmostra (ate 10):");
    mudancas.slice(0, 10).forEach((m) => {
      console.log(
        `  #${m.id}: ${m.de} -> ${m.para}  |  OTIF ${m.otifDe} -> ${m.otifPara}`,
      );
    });

    if (DRY) {
      console.log("\n(DRY-RUN) Rode sem --dry-run para gravar de verdade.");
      return;
    }

    await client.query("BEGIN");
    for (const m of mudancas) {
      await client.query(
        "UPDATE ocorrencias SET sla_status = $1, otif_status = $2 WHERE id = $3",
        [m.para, m.otifPara, m.id],
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
