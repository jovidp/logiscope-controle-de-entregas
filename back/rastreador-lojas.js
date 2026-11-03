// ================================================================
// rastreador-lojas.js — onde cada loja (e a fabrica) fica DE VERDADE
// ----------------------------------------------------------------
// Sem servico de mapa externo: cruza os registros de entrega (placa + loja +
// hora de chegada) com as PARADAS do rastreador naquele dia
// (rastreador.paradasDoDia). A parada que cobre a chegada/saida da loja e o
// ponto onde o caminhao descarrega — melhor que o endereco do cadastro.
//   - fabrica: a parada que termina perto da saida da fabrica do dia;
//   - por loja: mediana das amostras, descarta as que ficam a > 300 m dela
//     (registro com loja/hora errada) e mede a dispersao.
// Grava em loja_coordenadas (origem 'rastreador'); 'manual' nao e tocada.
// Rodar: node back/rastreador-lojas.js [dias=90] [--gravar]  (sem --gravar = so mostra)
//        ou POST /tms/rastreador/aprender-lojas (ADM).
// ================================================================

const rastreador = require("./rastreador");
const lojasPes = require("./lojas-pes");

const RAIO_INLIER_M = 300;
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
const minDe = (h) => { const m = String(h || "").match(/^(\d{1,2}):(\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const mediana = (arr) => { const a = [...arr].sort((x, y) => x - y); const i = Math.floor(a.length / 2); return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2; };
const somaDia = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// Parada que mais se sobrepoe a [chegada, saida da loja] (tolerancia 10 min).
function paradaDaEntrega(paradas, chegada, saida) {
  const a = chegada - 10, b = (saida != null && saida >= chegada ? saida : chegada + 20) + 10;
  let melhor = null;
  for (const p of paradas) {
    const sobre = Math.min(b, p.fim) - Math.max(a, p.ini);
    if (sobre > 0 && (!melhor || sobre > melhor.sobre)) melhor = { ...p, sobre };
  }
  return melhor;
}

// Uma parada continua nao prova o ponto de duas lojas diferentes.
// Registros repetidos da mesma loja tambem contam como uma unica amostra.
function amostrasDasEntregas(paradas, entregas) {
  const porParada = new Map();
  let semParada=0;
  for (const o of entregas) {
    const chegada = minDe(o.chegada);
    if (chegada == null) continue;
    const p = paradaDaEntrega(paradas, chegada, minDe(o.saida));
    if (!p || p.dur_min < 3) {semParada++;continue;}
    const chave = JSON.stringify([p.ini,p.fim,p.lat,p.lng]);
    if (!porParada.has(chave)) porParada.set(chave,{p,lojas:new Map()});
    porParada.get(chave).lojas.set(o.codigo,o);
  }
  const amostras=[], revisar=new Map();
  for (const {p,lojas} of porParada.values()) {
    if (lojas.size>1) {for (const [codigo,o] of lojas) revisar.set(codigo,o.nome);continue;}
    amostras.push({entrega:[...lojas.values()][0],parada:p});
  }
  return {amostras,revisar,semParada};
}

async function aprender(db, { dias = 90, gravar = false, log = console.log } = {}) {
  const idx = await lojasPes.carregarIndice(db, { forcar: true });
  if (!idx) throw new Error("cadastro de lojas (lojas_pes) indisponivel");
  // Placa -> aparelho (atualiza a lista antes)
  const aparelhos = await rastreador.listarAparelhos();
  const porPlaca = new Map(aparelhos.map((a) => [a.placa, a.device_id]));

  const oc = await db.query(`
      SELECT id, to_char(data_ocorrencia + CASE WHEN dia_seguinte THEN 1 ELSE 0 END, 'YYYY-MM-DD') AS dia,
             placa, loja, to_char(hora_chegada, 'HH24:MI') AS chegada, to_char(fim_descarga, 'HH24:MI') AS saida,
             to_char(hora_saida_fabrica, 'HH24:MI') AS saida_fabrica, dia_seguinte
        FROM ocorrencias
       WHERE excluida_em IS NULL AND hora_chegada IS NOT NULL AND NULLIF(TRIM(placa), '') IS NOT NULL
         AND data_ocorrencia >= CURRENT_DATE - $1::int
       ORDER BY data_ocorrencia`, [dias]);

  // Agrupa por aparelho + dia real (cada um vira 1 chamada de historico)
  const grupos = new Map();
  let semAparelho = 0, semLoja = 0;
  for (const o of oc.rows) {
    const dev = porPlaca.get(rastreador.placaMercosul(o.placa));
    if (!dev) { semAparelho++; continue; }
    const loja = idx.resolver(o.loja);
    if (!loja) { semLoja++; continue; }
    const k = `${dev}|${o.dia}`;
    (grupos.get(k) || grupos.set(k, { dev, dia: o.dia, ocs: [] }).get(k)).ocs.push({ ...o, codigo: loja.codigo, nome: loja.nome || loja.chave || o.loja });
  }
  log(`[aprender] ${oc.rowCount} registros · ${grupos.size} dia(s) de caminhao para consultar · sem aparelho: ${semAparelho} · loja fora do cadastro: ${semLoja}`);

  const amostras = new Map(); // codigo -> { nome, pts: [{lat,lng}] }
  const add = (codigo, nome, p) => (amostras.get(codigo) || amostras.set(codigo, { nome, pts: [] }).get(codigo)).pts.push({ lat: p.lat, lng: p.lng });
  let feitos = 0, falhas = 0, semParada = 0;
  const pontosParaRevisar = new Map();
  for (const g of grupos.values()) {
    let paradas;
    try { paradas = await rastreador.paradasDoDia(g.dev, g.dia); }
    catch (err) { falhas++; if (falhas <= 3) log(`[aprender] historico ${g.dev} ${g.dia}: ${err.message}`); continue; }
    feitos++;
    const selecionadas=amostrasDasEntregas(paradas,g.ocs);
    for(const [codigo,nome] of selecionadas.revisar)pontosParaRevisar.set(codigo,nome);
    for(const {entrega:o,parada:p} of selecionadas.amostras)add(o.codigo,o.nome,p);
    semParada+=selecionadas.semParada;
    // Fabrica: parada que termina ate 25 min da saida da fabrica (so no dia da saida)
    const sf = g.ocs.find((o) => !o.dia_seguinte && minDe(o.saida_fabrica) != null);
    if (sf) {
      const alvo = minDe(sf.saida_fabrica);
      const p = paradas.filter((x) => Math.abs(x.fim - alvo) <= 25 && x.dur_min >= 10).sort((x, y) => Math.abs(x.fim - alvo) - Math.abs(y.fim - alvo))[0];
      if (p) add(lojasPes.FABRICA, "FÁBRICA", p);
    }
    if (feitos % 20 === 0) log(`[aprender] ${feitos}/${grupos.size}…`);
    await pausa(250); // nao martelar a plataforma
  }

  // Consolida: mediana, descarta outliers, dispersao
  const resultado = [];
  for (const [codigo, { nome, pts }] of amostras) {
    const centro = { lat: mediana(pts.map((p) => p.lat)), lng: mediana(pts.map((p) => p.lng)) };
    const dentro = pts.filter((p) => rastreador.distanciaM(centro, p) <= RAIO_INLIER_M);
    if (!dentro.length) continue;
    const c2 = { lat: mediana(dentro.map((p) => p.lat)), lng: mediana(dentro.map((p) => p.lng)) };
    const disp = Math.round(mediana(dentro.map((p) => rastreador.distanciaM(c2, p))));
    // Confianca: 1 amostra so, ou mais descartes que acertos (registros
    // discordando entre si) = baixa — fica para revisao, NAO e gravada.
    // Ex. real: TERESOPOLIS com 3 amostras discordantes caiu em Sao Goncalo.
    const descartadas = pts.length - dentro.length;
    const confianca = dentro.length >= 3 && disp <= 80 && dentro.length > descartadas ? "alta"
      : dentro.length >= 2 && dentro.length >= descartadas ? "media" : "baixa";
    resultado.push({ codigo, nome, lat: c2.lat, lng: c2.lng, amostras: dentro.length, descartadas, dispersao_m: disp, confianca });
  }
  resultado.sort((a, b) => a.codigo.localeCompare(b.codigo));

  // Mesmo centro aprendido: baixa dispersao nao distingue a loja atendida.
  for(let i=0;i<resultado.length;i++)for(let j=i+1;j<resultado.length;j++) {
    const a=resultado[i],b=resultado[j];
    if(a.codigo===lojasPes.FABRICA || b.codigo===lojasPes.FABRICA || rastreador.distanciaM(a,b)>1)continue;
    for(const r of [a,b]){r.confianca='baixa';r.motivo_revisao='ponto compartilhado entre lojas';pontosParaRevisar.set(r.codigo,r.nome);}
  }

  if (gravar) {
    for (const r of resultado.filter((x) => x.confianca !== "baixa")) {
      await db.query(`
        INSERT INTO loja_coordenadas (codigo, nome, lat, lng, amostras, dispersao_m, origem, atualizado_em)
        VALUES ($1,$2,$3,$4,$5,$6,'rastreador',NOW())
        ON CONFLICT (codigo) DO UPDATE SET nome=$2, lat=$3, lng=$4, amostras=$5, dispersao_m=$6, atualizado_em=NOW()
         WHERE loja_coordenadas.origem <> 'manual'`,
        [r.codigo, r.nome, r.lat, r.lng, r.amostras, r.dispersao_m]);
    }
    rastreador.esquecerCoordenadas();
  }
  const totalLojas = (idx.lojas || []).length;
  const validas = resultado.filter((x) => x.confianca !== "baixa");
  const codigosValidos=new Set(validas.map(x=>x.codigo));
  return { dias_consultados: feitos, falhas, entregas_sem_parada: semParada, lojas_cadastro: totalLojas,
    lojas_com_coordenada: validas.length, para_revisar: [...new Set([...pontosParaRevisar].filter(([codigo])=>!codigosValidos.has(codigo)).map(([,nome])=>nome).concat(resultado.filter((x) => x.confianca === "baixa").map((x) => x.nome)))],
    gravado: gravar, lojas: resultado };
}

module.exports = { aprender, paradaDaEntrega, amostrasDasEntregas };

// CLI
if (require.main === module) {
  const db = require("./db");
  const dias = Number(process.argv.find((a) => /^\d+$/.test(a)) || 90);
  const gravar = process.argv.includes("--gravar");
  (async () => {
    if (gravar) await rastreador.garantirTabelas(db);
    const r = await aprender(db, { dias, gravar });
    console.log(`\nRevisar (baixa confianca, NAO gravadas): ${r.para_revisar.join(", ") || "-"}`);
    console.log(`${r.lojas_com_coordenada} de ${r.lojas_cadastro} lojas com coordenada · ${r.dias_consultados} dias consultados · falhas ${r.falhas} · entregas sem parada ${r.entregas_sem_parada} · ${gravar ? "GRAVADO" : "so leitura (use --gravar)"}`);
    for (const l of r.lojas) console.log(`${l.codigo.padEnd(14)} ${String(l.nome).slice(0, 22).padEnd(22)} ${l.lat.toFixed(5)},${l.lng.toFixed(5)}  n=${l.amostras}${l.descartadas ? ` (-${l.descartadas})` : ""}  ±${l.dispersao_m}m  ${l.confianca}`);
    process.exit(0);
  })().catch((e) => { console.error("FALHOU", e); process.exit(1); });
}
