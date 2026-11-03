'use strict';
const { chaveLoja } = require('./normalizar-loja');

async function snapshot(client, data) {
  // Mesma ordem de travas dos formularios: viagem antes das paradas.
  const viagens = (await client.query('SELECT * FROM tms_viagens WHERE data_viagem = $1 ORDER BY id FOR UPDATE', [data])).rows;
  const paradas = (await client.query(`SELECT p.*,
    EXISTS (SELECT 1 FROM ocorrencias o WHERE o.parada_id=p.id AND o.excluida_em IS NULL) AS possui_ocorrencia
    FROM tms_paradas p WHERE p.viagem_id = ANY($1::int[]) ORDER BY p.id`, [viagens.map(v => v.id)])).rows;
  return { viagens, paradas };
}

function podeReconciliar(p, v) {
  return v && !v.programacao?.edicao_manual && !['Cancelada', 'Finalizada'].includes(v.status)
    && (p.status || 'Pendente') === 'Pendente' && !p.ocorrencia_id && !p.possui_ocorrencia
    && !p.cte_concluido && (!p.pedidos || !Object.keys(p.pedidos).length)
    && p.programacao?.origem === 'planilha';
}

async function reconciliar(client, plano, resultado, antes) {
  const aplicadas = [...resultado.criadas, ...resultado.atualizadas];
  if (!aplicadas.length) return;
  const atual = await snapshot(client, plano.data_viagem);
  const viagens = new Map(atual.viagens.map(v => [v.id, v]));
  const idsAntigos = new Set(antes.paradas.map(p => p.id));
  const alvos = new Map(aplicadas.map(x => [x.indice, x]));
  const destinos = new Map(), lojasFonte = new Set(), ambiguas = new Set();
  for (const b of plano.blocos) {
    for (const x of b.paradas) {
      const chave = chaveLoja(x.loja_sistema);
      lojasFonte.add(chave);
      const aplicado = alvos.get(b.indice);
      if (!aplicado || x.origem === 'checklist') continue;
      if (destinos.has(chave) && destinos.get(chave).viagem_id !== aplicado.viagem_id) ambiguas.add(chave);
      destinos.set(chave, { viagem_id: aplicado.viagem_id, x });
    }
  }
  const removidas = [], transferidas = [], alteradas = new Set();
  const elegivel = p => podeReconciliar(p, viagens.get(p.viagem_id));
  const guardar = async (p, acao, destino) => {
    await client.query(`UPDATE tms_viagens SET programacao = COALESCE(programacao,'{}'::jsonb) ||
      jsonb_build_object('reconciliacao_planilha', COALESCE(programacao->'reconciliacao_planilha','[]'::jsonb) || $2::jsonb)
      WHERE id=$1`, [p.viagem_id, JSON.stringify([{ acao, destino: destino || null, em: new Date().toISOString(), parada: p }])]);
  };
  const remover = async (p, motivo) => {
    const r = await client.query(`DELETE FROM tms_paradas p WHERE id=$1 AND viagem_id=$2
      AND COALESCE(status,'Pendente')='Pendente' AND ocorrencia_id IS NULL AND NOT COALESCE(cte_concluido,false)
      AND NOT EXISTS (SELECT 1 FROM ocorrencias o WHERE o.parada_id=p.id AND o.excluida_em IS NULL)
      RETURNING id`, [p.id, p.viagem_id]);
    if (!r.rowCount) return;
    await guardar(p, motivo);
    removidas.push({ id: p.id, viagem_id: p.viagem_id, loja: p.loja_nome, motivo });
    alteradas.add(p.viagem_id);
    atual.paradas = atual.paradas.filter(x => x.id !== p.id);
  };

  for (const [chave, destino] of destinos) {
    if (ambiguas.has(chave)) continue;
    const grupo = atual.paradas.filter(p => chaveLoja(p.loja_nome) === chave
      && !(viagens.get(p.viagem_id)?.status === 'Cancelada' && !p.ocorrencia_id && !p.possui_ocorrencia && !p.cte_concluido));
    const locais = grupo.filter(p => p.viagem_id === destino.viagem_id);
    // Uma edicao manual ou entrega ja registrada em outro caminhao nao muda de dono.
    const bloqueada = grupo.find(p => p.viagem_id !== destino.viagem_id && !elegivel(p));
    if (bloqueada) {
      for (const p of locais.filter(p => !idsAntigos.has(p.id) && elegivel(p))) await remover(p, 'conflito_com_historico_ou_edicao');
      resultado.avisos = resultado.avisos || [];
      resultado.avisos.push(`${bloqueada.loja_nome}: preservada na viagem ${viagens.get(bloqueada.viagem_id)?.codigo}; confira a mudança na planilha.`);
      continue;
    }
    // Prioridade para registro que ja era da rota certa; depois o original que
    // mudou de rota. A copia inserida neste ciclo nao substitui id/carga/historico.
    const manter = locais.find(p => idsAntigos.has(p.id))
      || grupo.find(p => idsAntigos.has(p.id) && elegivel(p)) || locais[0];
    if (!manter) continue;
    if (manter.viagem_id !== destino.viagem_id) {
      const modelo = locais.find(elegivel);
      if (!modelo || !elegivel(manter)) continue;
      const r = await client.query(`UPDATE tms_paradas p SET viagem_id=$2, ordem=$3,
        hora_prevista=$4, retirada_cx=$5, retirada_rt=$6,
        programacao=COALESCE(programacao,'{}'::jsonb) || $7::jsonb, atualizado_em=NOW()
        WHERE id=$1 AND viagem_id=$8 AND COALESCE(status,'Pendente')='Pendente' AND ocorrencia_id IS NULL
          AND NOT COALESCE(cte_concluido,false)
          AND NOT EXISTS (SELECT 1 FROM ocorrencias o WHERE o.parada_id=p.id AND o.excluida_em IS NULL) RETURNING id`,
      [manter.id, destino.viagem_id, modelo.ordem, modelo.hora_prevista, modelo.retirada_cx, modelo.retirada_rt,
        JSON.stringify(modelo.programacao || {}), manter.viagem_id]);
      if (!r.rowCount) continue;
      await guardar(manter, 'transferida', destino.viagem_id);
      transferidas.push({ id: manter.id, loja: manter.loja_nome, de: manter.viagem_id, para: destino.viagem_id });
      alteradas.add(manter.viagem_id); alteradas.add(destino.viagem_id);
      const carga = destino.x.checklist;
      if (carga) await client.query(`UPDATE tms_paradas SET volumes_previstos=$2, material_campanha=$3,
        sacola=$4, sacola_p=$5, sacola_m=$6, sacola_g=$7, remessas=$8::jsonb WHERE id=$1`,
      [manter.id, carga.volumes_previstos, carga.material_campanha, carga.sacola, carga.sacola_p, carga.sacola_m, carga.sacola_g,
        carga.remessas ? JSON.stringify(carga.remessas) : null]);
      manter.viagem_id = destino.viagem_id;
    }
    for (const p of grupo) {
      if (p.id !== manter.id && elegivel(p)) await remover(p, 'duplicada_apos_transferencia');
    }
  }

  const idsAplicadas = new Set(aplicadas.map(x => x.viagem_id));
  for (const p of atual.paradas.slice()) {
    const v = viagens.get(p.viagem_id);
    if (idsAplicadas.has(p.viagem_id) && !lojasFonte.has(chaveLoja(p.loja_nome)) && elegivel(p)
        && !v.checklist_origem_id && !p.programacao?.checklist) await remover(p, 'retirada_da_planilha');
  }
  // Releitura depois das transferencias: carga, ordem e contadores correspondem ao banco.
  const final = await snapshot(client, plano.data_viagem);
  for (const item of aplicadas) {
    const b = plano.blocos.find(b => b.indice === item.indice), v = viagens.get(item.viagem_id);
    const paradas = final.paradas.filter(p => p.viagem_id === item.viagem_id);
    const pos = new Map(b.paradas.map((x,i) => [chaveLoja(x.loja_sistema), i]));
    if (!v?.programacao?.ordem_manual && !v?.programacao?.edicao_manual) {
      const historicas = paradas.filter(p => !elegivel(p)).sort((a,b) => a.ordem-b.ordem || a.id-b.id);
      const pendentes = paradas.filter(elegivel).sort((a,b) => (pos.get(chaveLoja(a.loja_nome)) ?? 999)
        - (pos.get(chaveLoja(b.loja_nome)) ?? 999) || a.ordem-b.ordem || a.id-b.id);
      const ocupadas = new Set(historicas.map(p => p.ordem));
      let proxima = 1;
      const ordens = pendentes.map(() => {
        while (ocupadas.has(proxima)) proxima += 1;
        return proxima++;
      });
      await client.query(`UPDATE tms_paradas p SET ordem=n.ordem, atualizado_em=NOW()
        FROM unnest($1::int[],$2::int[]) n(id,ordem) WHERE p.id=n.id AND p.viagem_id=$3
        AND p.ordem IS DISTINCT FROM n.ordem`, [pendentes.map(p => p.id), ordens, item.viagem_id]);
    }
    item.paradas_transferidas = transferidas.filter(x => x.para === item.viagem_id).length;
    item.paradas_removidas = removidas.filter(x => x.viagem_id === item.viagem_id).length;
    item.paradas_novas = paradas.filter(p => !idsAntigos.has(p.id)).length;
    item.lojas_so_na_viagem = paradas.filter(p => !pos.has(chaveLoja(p.loja_nome))).map(p => p.loja_nome);
  }
  for (const id of alteradas) {
    const v = viagens.get(id);
    if (v?.programacao?.edicao_manual) continue;
    await client.query(`UPDATE tms_viagens v SET volumes_previstos=s.vol,material_campanha=s.mat,
      sacola=s.sac,sacola_p=s.sp,sacola_m=s.sm,sacola_g=s.sg,atualizado_em=NOW()
      FROM (SELECT NULLIF(SUM(volumes_previstos),0)::int AS vol,NULLIF(SUM(material_campanha),0)::int AS mat,
        NULLIF(SUM(sacola),0)::int AS sac,NULLIF(SUM(sacola_p),0)::int AS sp,NULLIF(SUM(sacola_m),0)::int AS sm,
        NULLIF(SUM(sacola_g),0)::int AS sg FROM tms_paradas WHERE viagem_id=$1) s WHERE v.id=$1`, [id]);
    if (!idsAplicadas.has(id) && !final.paradas.some(p => p.viagem_id === id)
        && ['Planejada','Carregando','Liberada'].includes(v.status) && !v.saida_real && !v.checklist_origem_id) {
      await client.query("UPDATE tms_viagens SET status='Cancelada', atualizado_em=NOW() WHERE id=$1", [id]);
      resultado.viagens_canceladas = [...(resultado.viagens_canceladas || []), { id, codigo: v.codigo }];
    }
  }
  resultado.transferencias = transferidas;
  resultado.remocoes = removidas;
}
module.exports = { snapshot, reconciliar, podeReconciliar };
