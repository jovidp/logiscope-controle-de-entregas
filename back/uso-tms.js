// ================================================================
// uso-tms.js — "o time esta usando?" (GET /tms/uso?dias=14)
// ----------------------------------------------------------------
// Previsao de chegada, alertas e jornada so funcionam se a equipe clicar
// Chegou/Saiu/Voltou NA HORA e lancar o registro da loja logo apos a entrega.
// Aqui se mede isso, por dia e por pessoa:
//   - viagens com saida pelo BOTAO x digitada depois (ajuste) x sem saida
//   - chegada / retorno registrados
//   - registro da loja: atraso entre a SAIDA DA LOJA (fim_descarga) e o
//     lancamento (hora do POST na sistema_auditoria — ocorrencias nao tem
//     criado_em) e quantos foram pelo "Entregue sem problema" do card
//   - lojas sem registro nas viagens ja iniciadas
// Contado a partir do lancamento dos botoes (TMS_USO_DESDE, padrao 2026-10-01).
// ================================================================

const DESDE = process.env.TMS_USO_DESDE || "2026-10-01";
const FEITA = `(p.status IN ('Entregue','Entregue com ocorrencia','Recusada','Ocorrencia')
   OR p.ocorrencia_id IS NOT NULL
   OR EXISTS (SELECT 1 FROM ocorrencias o WHERE o.parada_id = p.id AND o.excluida_em IS NULL))`;

const mediana = (arr) => {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const i = Math.floor(a.length / 2);
  return Math.round(a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2);
};
const pct = (n, d) => (d ? Math.round((100 * n) / d) : null);

// Mede a janela [inicio, fim] (datas 'YYYY-MM-DD').
async function medir(db, inicio, fim, hoje = fim) {
  const params = [inicio, fim];
  const janela = `data_viagem >= $1::date AND data_viagem <= $2::date`;

  const viagens = await db.query(`
      SELECT to_char(data_viagem, 'YYYY-MM-DD') AS d, COUNT(*)::int AS viagens,
             COUNT(*) FILTER (WHERE saida_real_origem = 'botao')::int AS saida_botao,
             COUNT(*) FILTER (WHERE saida_real_origem = 'ajuste')::int AS saida_ajuste,
             COUNT(*) FILTER (WHERE chegada_fabrica IS NOT NULL)::int AS chegadas,
             COUNT(*) FILTER (WHERE chegada_fabrica_origem = 'botao')::int AS chegada_botao,
             COUNT(*) FILTER (WHERE retorno_real IS NOT NULL)::int AS retornos,
             COUNT(*) FILTER (WHERE retorno_real_origem = 'botao')::int AS retorno_botao,
             COUNT(*) FILTER (WHERE status = 'Finalizada')::int AS finalizadas
        FROM tms_viagens v
       WHERE ${janela} AND status <> 'Cancelada'
         AND EXISTS (SELECT 1 FROM tms_paradas p WHERE p.viagem_id = v.id)
       GROUP BY 1 ORDER BY 1`, params);

  const paradas = await db.query(`
      SELECT to_char(v.data_viagem, 'YYYY-MM-DD') AS d, COUNT(*)::int AS paradas,
             COUNT(*) FILTER (WHERE NOT ${FEITA})::int AS sem_registro
        FROM tms_paradas p JOIN tms_viagens v ON v.id = p.viagem_id
       WHERE ${janela.replace(/data_viagem/g, "v.data_viagem")} AND v.status <> 'Cancelada'
         AND (v.saida_real IS NOT NULL OR v.status IN ('Em rota','Retorno','Finalizada'))
       GROUP BY 1`, params);

  // Registro da loja: hora do lancamento (auditoria) - saida da loja.
  const registros = await db.query(`
      WITH a AS (
        SELECT DISTINCT ON (recurso_id) recurso_id::int AS id, criado_em, usuario_nome
          FROM sistema_auditoria
         WHERE recurso = 'ocorrencias' AND acao = 'POST' AND recurso_id ~ '^[0-9]+$'
           AND criado_em >= $1::date
         ORDER BY recurso_id, criado_em)
      SELECT to_char(o.data_ocorrencia, 'YYYY-MM-DD') AS d, COALESCE(NULLIF(TRIM(a.usuario_nome), ''), '(sem nome)') AS quem,
             -- dia_seguinte (pernoite): a entrega foi no dia seguinte ao da data da viagem
             EXTRACT(EPOCH FROM (a.criado_em - (o.data_ocorrencia + CASE WHEN o.dia_seguinte THEN 1 ELSE 0 END
                                                + COALESCE(o.fim_descarga, o.hora_chegada)))) / 60.0 AS atraso_min,
             COALESCE(o.observacao, '') LIKE 'Registro rápido pelo TMS%' AS rapido
        FROM ocorrencias o JOIN a ON a.id = o.id
       WHERE o.excluida_em IS NULL AND o.data_ocorrencia >= $1::date AND o.data_ocorrencia <= $2::date
         AND COALESCE(o.fim_descarga, o.hora_chegada) IS NOT NULL`, params);

  const saidasPorPessoa = await db.query(`
      SELECT COALESCE(NULLIF(TRIM(saida_real_por), ''), '(sem nome)') AS quem,
             COUNT(*) FILTER (WHERE saida_real_origem = 'botao')::int AS botao,
             COUNT(*) FILTER (WHERE saida_real_origem = 'ajuste')::int AS ajuste
        FROM tms_viagens WHERE ${janela} AND saida_real IS NOT NULL GROUP BY 1`, params);

  // Atraso fora de -60 min .. 7 dias e digitacao errada de horario: fica de fora da mediana.
  const regs = registros.rows.map((r) => ({ ...r, atraso: Number(r.atraso_min) }))
    .filter((r) => r.atraso >= -60 && r.atraso <= 7 * 1440);

  const porDia = new Map(viagens.rows.map((r) => [r.d, { ...r }]));
  for (const p of paradas.rows) Object.assign(porDia.get(p.d) || porDia.set(p.d, { d: p.d }).get(p.d), p);
  const regsDia = new Map();
  for (const r of regs) (regsDia.get(r.d) || regsDia.set(r.d, []).get(r.d)).push(r);
  const dias_ = [...porDia.values()].sort((a, b) => a.d.localeCompare(b.d)).map((x) => {
    const rs = regsDia.get(x.d) || [];
    return {
      ...x,
      registros: rs.length,
      registro_mediana_min: mediana(rs.map((r) => r.atraso)),
      registro_ate_30_pct: pct(rs.filter((r) => r.atraso <= 30).length, rs.length),
      registro_rapido: rs.filter((r) => r.rapido).length,
    };
  });

  const pessoas = new Map();
  for (const r of regs) {
    const p = pessoas.get(r.quem) || { nome: r.quem, atrasos: [], rapidos: 0, saidas_botao: 0, saidas_ajuste: 0 };
    p.atrasos.push(r.atraso);
    if (r.rapido) p.rapidos += 1;
    pessoas.set(r.quem, p);
  }
  for (const s of saidasPorPessoa.rows) {
    const p = pessoas.get(s.quem) || { nome: s.quem, atrasos: [], rapidos: 0, saidas_botao: 0, saidas_ajuste: 0 };
    p.saidas_botao = s.botao; p.saidas_ajuste = s.ajuste;
    pessoas.set(s.quem, p);
  }

  // Resumo dos ultimos 7 dias da janela.
  const ult = dias_.slice(-7);
  const soma = (k) => ult.reduce((a, x) => a + (Number(x[k]) || 0), 0);
  const regs7 = regs.filter((r) => ult.some((x) => x.d === r.d));
  return {
    resumo: {
      dias: ult.length,
      viagens: soma("viagens"),
      saida_botao_pct: pct(soma("saida_botao"), soma("viagens")),
      saida_ajuste_pct: pct(soma("saida_ajuste"), soma("viagens")),
      chegada_pct: pct(soma("chegadas"), soma("viagens")),
      retorno_pct: pct(soma("retornos"), soma("viagens")),
      registros: regs7.length,
      registro_mediana_min: mediana(regs7.map((r) => r.atraso)),
      registro_ate_30_pct: pct(regs7.filter((r) => r.atraso <= 30).length, regs7.length),
      registro_rapido_pct: pct(regs7.filter((r) => r.rapido).length, regs7.length),
      // So dias JA FECHADOS: no dia corrente loja ainda nao visitada nao e falha.
      sem_registro_pct: (() => {
        const fechados = ult.filter((x) => x.d < hoje);
        const tot = fechados.reduce((a, x) => a + (Number(x.paradas) || 0), 0);
        return pct(fechados.reduce((a, x) => a + (Number(x.sem_registro) || 0), 0), tot);
      })(),
    },
    dias: dias_,
    pessoas: [...pessoas.values()].map((p) => ({
      nome: p.nome, registros: p.atrasos.length, registro_mediana_min: mediana(p.atrasos),
      registro_ate_30_pct: pct(p.atrasos.filter((a) => a <= 30).length, p.atrasos.length),
      rapidos: p.rapidos, saidas_botao: p.saidas_botao, saidas_ajuste: p.saidas_ajuste,
    })).sort((a, b) => (b.registros + b.saidas_botao + b.saidas_ajuste) - (a.registros + a.saidas_botao + a.saidas_ajuste)),
  };
}

// Atual (desde o lancamento dos botoes, ate `dias` atras) + LINHA DE BASE: os
// 14 dias anteriores ao lancamento, para comparar antes x depois.
async function montarUsoTms(db, dias) {
  const r = await db.query(
    "SELECT to_char(GREATEST($1::date, CURRENT_DATE - $2::int), 'YYYY-MM-DD') AS ini, to_char(CURRENT_DATE, 'YYYY-MM-DD') AS fim, " +
    "to_char($1::date - 14, 'YYYY-MM-DD') AS base_ini, to_char($1::date - 1, 'YYYY-MM-DD') AS base_fim", [DESDE, dias]);
  const j = r.rows[0];
  const [atual, base] = await Promise.all([medir(db, j.ini, j.fim, j.fim), medir(db, j.base_ini, j.base_fim, j.fim)]);
  return { desde: DESDE, ...atual, antes: { de: j.base_ini, ate: j.base_fim, ...base.resumo } };
}

module.exports = { montarUsoTms };
