// ================================================================
// frota-cercas-srf.js — cercas (geofences) entre o SRF e o sistema
// ----------------------------------------------------------------
// Pedido de 06/10/2026: "no SRF existem as cercas, teria como migrar elas
// para ca e daqui do meu sistema migrar as que eu montar para la?"
//
// As cercas daqui sao as AREAS da aba Frota (tabela frota_areas, desenhadas
// em "Alertas e areas"). Cada area ganha o vinculo com a cerca do SRF:
//   origem ('local' | 'srf'), cor, srf_id, srf_grupo, srf_ativo (ativa la),
//   srf_atualizado (updated_at de la: diz se mudou), srf_sync_em,
//   srf_pendente (mexida aqui depois do ultimo envio).
//
// ⬇ Trazer do SRF  (GET /frota/areas/srf = previa; POST .../srf/importar)
//   - cerca nova -> area nova. Grupo "Rota" -> tipo 'corredor', outro grupo
//     -> 'referencia'. Esses dois tipos NAO geram aviso (o caminhao vive
//     dentro do corredor da rota); na lista da para trocar para risco/atencao.
//   - cerca que mudou la (updated_at) -> nome/desenho/cor atualizados aqui.
//   - cerca apagada la -> area que veio de la sai daqui; area feita aqui so
//     perde o vinculo (pode ser enviada de novo).
//   - area apagada aqui NAO volta (vale a escolha daqui).
//   - circulo do SRF vira poligono de 36 lados.
//   Em 06/10/2026 o SRF tinha 13 cercas, todas corredores de rota do grupo
//   "Rota" (Z.NORTE I, BAIXADA II, CENTRO/Z.SUL...), todas DESATIVADAS la.
// ⬆ Enviar ao SRF  (POST /frota/areas/:id/srf e /frota/areas/srf/enviar)
//   - sem vinculo -> add_geofence (nome, poligono, cor do tipo);
//   - com vinculo -> edit_geofence (mesma cerca la).
// 🗑 Apagar com ?srf=1 -> destroy_geofence antes de apagar aqui.
// Tudo por clique de ADM (POST/PUT/DELETE em /frota ja sao so ADM). Nada roda
// sozinho: o SRF e o rastreio de producao da empresa.
// ================================================================
const rastreador = require("./rastreador");

const COR_TIPO = { risco: "#dc2626", proibida: "#7f1d1d", atencao: "#d97706", corredor: "#2563eb", referencia: "#64748b" };
const TIPOS = Object.keys(COR_TIPO);
const TIPOS_AVISO = ["risco", "proibida", "atencao"];
const LADOS_CIRCULO = 36;

const r6 = (x) => Math.round(Number(x) * 1e6) / 1e6;
const valido = ([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
const corValida = (c) => (/^#[0-9a-f]{6}$/i.test(String(c || "")) ? String(c).toLowerCase() : null);
const json = (v) => { if (typeof v !== "string") return v; try { return JSON.parse(v); } catch (_) { return null; } };

function circulo(centro, raioM, lados = LADOS_CIRCULO) {
  const dLat = raioM / 111320, dLng = raioM / (111320 * Math.cos((centro.lat * Math.PI) / 180));
  return Array.from({ length: lados }, (_, i) => {
    const a = (2 * Math.PI * i) / lados;
    return [r6(centro.lat + dLat * Math.sin(a)), r6(centro.lng + dLng * Math.cos(a))];
  });
}

// Cerca do SRF -> [[lat,lng],...] (formato das areas daqui).
function pontosDoSrf(g) {
  if (String(g.type || "polygon") === "circle") {
    const c = json(g.center);
    const raio = Number(g.radius);
    if (c && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng)) && raio > 0) {
      return circulo({ lat: Number(c.lat), lng: Number(c.lng) }, raio);
    }
  }
  const c = json(g.coordinates);
  return (Array.isArray(c) ? c : []).map((p) => [r6(p.lat), r6(p.lng)]).filter(valido);
}
// Area daqui -> corpo do add/edit_geofence.
function corpoParaSrf(area) {
  const pontos = (Array.isArray(area.pontos) ? area.pontos : []).map((p) => [Number(p[0]), Number(p[1])]).filter(valido);
  if (pontos.length < 3) throw Object.assign(new Error("A área precisa de pelo menos 3 pontos."), { status: 400 });
  const corpo = {
    name: String(area.nome || "").trim().slice(0, 80) || `Área ${area.id}`,
    polygon: pontos.map(([lat, lng]) => ({ lat, lng })),
    polygon_color: corValida(area.cor) || COR_TIPO[area.tipo] || COR_TIPO.risco,
  };
  if (area.srf_grupo) corpo.group_id = Number(area.srf_grupo);
  return corpo;
}
const cercasDe = (lista) => ((lista && lista.items && lista.items.geofences) || []).filter((g) => g && Number.isFinite(Number(g.id)));
// geofences_groups vem como {"0": {...}, "1": {...}, pagination}.
const gruposDe = (r) => new Map(Object.values(r || {}).filter((g) => g && g.id != null && g.title != null).map((g) => [Number(g.id), String(g.title).trim()]));
const tipoDoGrupo = (titulo) => (/rota/i.test(titulo || "") ? "corredor" : "referencia");
const idDaResposta = (j) => Number((j && (j.item?.id ?? j.geofence?.id ?? j.data?.id ?? j.id)) || 0) || null;

// Compara as cercas do SRF com as areas daqui. Puro (testavel).
//   locais: linhas de frota_areas com srf_id (ativas ou apagadas).
function planejar(cercas, locais, grupos = new Map()) {
  const porSrf = new Map(locais.filter((l) => l.srf_id != null).map((l) => [Number(l.srf_id), l]));
  const itens = cercas.map((g) => {
    const l = porSrf.get(Number(g.id));
    const pontos = pontosDoSrf(g);
    const situacao = pontos.length < 3 ? "invalida"
      : !l ? "nova"
      : !l.ativo ? "apagada_aqui"
      : String(l.srf_atualizado || "") !== String(g.updated_at || "") ? "mudou" : "igual";
    return { srf_id: Number(g.id), nome: String(g.name || "").trim(), grupo: grupos.get(Number(g.group_id)) || null, ativa_srf: Number(g.active) === 1,
      pontos: pontos.length, tipo: tipoDoGrupo(grupos.get(Number(g.group_id))), area_id: l ? l.id : null, situacao };
  });
  const vivos = new Set(cercas.map((g) => Number(g.id)));
  const sumiram = locais.filter((l) => l.srf_id != null && !vivos.has(Number(l.srf_id)))
    .map((l) => ({ area_id: l.id, srf_id: Number(l.srf_id), nome: l.nome, origem: l.origem, ativo: l.ativo }));
  return { itens, sumiram };
}

function criar({ db, garantirBase, registrarAuditoria }) {
  let pronto = null;
  const garantir = () => (pronto ||= (async () => {
    await garantirBase();
    await db.query(`
      ALTER TABLE frota_areas ADD COLUMN IF NOT EXISTS origem TEXT NOT NULL DEFAULT 'local';
      ALTER TABLE frota_areas ADD COLUMN IF NOT EXISTS cor TEXT;
      ALTER TABLE frota_areas ADD COLUMN IF NOT EXISTS srf_id INTEGER;
      ALTER TABLE frota_areas ADD COLUMN IF NOT EXISTS srf_grupo INTEGER;
      ALTER TABLE frota_areas ADD COLUMN IF NOT EXISTS srf_ativo BOOLEAN;
      ALTER TABLE frota_areas ADD COLUMN IF NOT EXISTS srf_atualizado TEXT;
      ALTER TABLE frota_areas ADD COLUMN IF NOT EXISTS srf_sync_em TIMESTAMPTZ;
      ALTER TABLE frota_areas ADD COLUMN IF NOT EXISTS srf_pendente BOOLEAN NOT NULL DEFAULT FALSE;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_frota_areas_srf ON frota_areas (srf_id) WHERE srf_id IS NOT NULL;
    `);
  })().catch((err) => { pronto = null; throw err; }));
  const usuario = (req) => (req.usuarioLogado && (req.usuarioLogado.nome || req.usuarioLogado.usuario)) || null;
  const travas = new Set(); // envio em andamento por area (clique duplo nao duplica la)

  async function lerSrf() {
    if (!rastreador.configurado()) throw Object.assign(new Error("SRF não configurado (SRF_URL/SRF_EMAIL/SRF_SENHA no .env)."), { status: 400 });
    const [lista, grupos] = await Promise.all([
      rastreador.srfApi("get_geofences", {}, 60000),
      rastreador.srfApi("geofences_groups").catch(() => ({})),
    ]);
    return { cercas: cercasDe(lista), grupos: gruposDe(grupos) };
  }
  async function locaisVinculados() {
    return (await db.query("SELECT id, nome, origem, ativo, srf_id, srf_atualizado FROM frota_areas WHERE srf_id IS NOT NULL")).rows;
  }

  async function importar({ ids = null, por = null } = {}) {
    await garantir();
    const { cercas, grupos } = await lerSrf();
    const plano = planejar(cercas, await locaisVinculados(), grupos);
    const porId = new Map(cercas.map((g) => [Number(g.id), g]));
    const res = { novas: 0, atualizadas: 0, iguais: 0, ignoradas: 0, removidas: 0, desvinculadas: 0 };
    for (const it of plano.itens) {
      if (ids && !ids.includes(it.srf_id)) continue;
      const g = porId.get(it.srf_id);
      const comum = [JSON.stringify(pontosDoSrf(g)), corValida(g.polygon_color), Number(g.group_id) || null, Number(g.active) === 1, String(g.updated_at || "")];
      if (it.situacao === "nova") {
        await db.query(`
          INSERT INTO frota_areas (nome, tipo, pontos, cor, srf_grupo, srf_ativo, srf_atualizado, srf_id, origem, criado_por, srf_sync_em)
          VALUES ($6, $7, $1, $2, $3, $4, $5, $8, 'srf', $9, NOW())`,
          [...comum, it.nome.slice(0, 80) || `Cerca SRF ${it.srf_id}`, it.tipo, it.srf_id, `SRF (trazida por ${por || "?"})`]);
        res.novas++;
      } else if (it.situacao === "mudou") {
        await db.query(`
          UPDATE frota_areas SET pontos = $1, cor = $2, srf_grupo = $3, srf_ativo = $4, srf_atualizado = $5,
                 nome = $6, srf_sync_em = NOW(), srf_pendente = FALSE
           WHERE id = $7`, [...comum, it.nome.slice(0, 80) || `Cerca SRF ${it.srf_id}`, it.area_id]);
        res.atualizadas++;
      } else if (it.situacao === "igual") {
        await db.query("UPDATE frota_areas SET srf_ativo = $1, srf_sync_em = NOW() WHERE id = $2", [it.ativa_srf, it.area_id]);
        res.iguais++;
      } else res.ignoradas++; // apagada aqui ou desenho invalido
    }
    // Apagadas no SRF (so quando trouxe TUDO: com lista de ids nao da para saber).
    if (!ids) {
      for (const s of plano.sumiram) {
        if (s.origem === "srf" && s.ativo) {
          await db.query("UPDATE frota_areas SET ativo = FALSE, srf_id = NULL, srf_ativo = NULL WHERE id = $1", [s.area_id]);
          res.removidas++;
        } else {
          await db.query("UPDATE frota_areas SET srf_id = NULL, srf_ativo = NULL, srf_atualizado = NULL, srf_pendente = FALSE WHERE id = $1", [s.area_id]);
          if (s.ativo) res.desvinculadas++;
        }
      }
    }
    return res;
  }

  async function enviarUma(id) {
    await garantir();
    if (travas.has(id)) throw Object.assign(new Error("Esta área já está sendo enviada."), { status: 409 });
    travas.add(id);
    try {
      const a = (await db.query("SELECT * FROM frota_areas WHERE id = $1 AND ativo", [id])).rows[0];
      if (!a) throw Object.assign(new Error("Área não encontrada."), { status: 404 });
      const corpo = corpoParaSrf(a);
      let srfId = a.srf_id ? Number(a.srf_id) : null;
      if (srfId) await rastreador.srfEnviar("edit_geofence", { id: srfId, ...corpo });
      else srfId = idDaResposta(await rastreador.srfEnviar("add_geofence", corpo));
      // Rele a lista: confirma que esta la e pega o updated_at (e o id, se a
      // resposta do "criar" nao trouxe).
      const { cercas } = await lerSrf();
      let g = srfId ? cercas.find((x) => Number(x.id) === srfId) : null;
      if (!g && !a.srf_id) {
        const usados = new Set((await locaisVinculados()).map((l) => Number(l.srf_id)));
        g = cercas.filter((x) => String(x.name || "").trim() === corpo.name && !usados.has(Number(x.id))).sort((x, y) => Number(y.id) - Number(x.id))[0];
      }
      if (!g) throw new Error("O SRF aceitou o envio, mas a cerca não apareceu na lista dele — confira no SRF antes de enviar de novo.");
      await db.query(`
        UPDATE frota_areas SET srf_id = $1, srf_grupo = $2, srf_ativo = $3, srf_atualizado = $4, srf_sync_em = NOW(), srf_pendente = FALSE
         WHERE id = $5`, [Number(g.id), Number(g.group_id) || null, Number(g.active) === 1, String(g.updated_at || ""), id]);
      return { area_id: id, srf_id: Number(g.id), criada: !a.srf_id, nome: a.nome };
    } finally {
      travas.delete(id);
    }
  }

  const responder = (fn) => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (err) {
      if (!err.status) console.error("[cercas srf]", err.message);
      res.status(err.status || 502).json({ error: err.status ? err.message : `SRF: ${err.message}` });
    }
  };

  const rotas = {
    // Lista das areas (substitui a do frota-diario: traz o vinculo com o SRF).
    // ?tipos=risco,proibida,atencao filtra (o mapa ao vivo so precisa dessas).
    listar: responder(async (req) => {
      await garantir();
      const tipos = String(req.query.tipos || "").split(",").map((t) => t.trim()).filter((t) => TIPOS.includes(t));
      const r = await db.query(`
        SELECT id, nome, tipo, pontos, ativo, origem, cor, srf_id, srf_ativo, srf_pendente, srf_sync_em, criado_por, criado_em
          FROM frota_areas WHERE ativo ${tipos.length ? "AND tipo = ANY($1::text[])" : ""} ORDER BY nome`, tipos.length ? [tipos] : []);
      return r.rows;
    }),
    // Previa do "Trazer do SRF" (so leitura nos dois lados).
    previa: responder(async () => {
      await garantir();
      const { cercas, grupos } = await lerSrf();
      const plano = planejar(cercas, await locaisVinculados(), grupos);
      const naoEnviadas = (await db.query("SELECT COUNT(*)::int AS n FROM frota_areas WHERE ativo AND (srf_id IS NULL OR srf_pendente)")).rows[0].n;
      const conta = (s) => plano.itens.filter((i) => i.situacao === s).length;
      return { ...plano, sumiram: plano.sumiram.filter((s) => s.ativo), resumo: { total: cercas.length, novas: conta("nova"), mudaram: conta("mudou"),
        iguais: conta("igual"), apagadas_aqui: conta("apagada_aqui"), para_enviar: naoEnviadas } };
    }),
    importar: responder(async (req) => {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : null;
      const r = await importar({ ids, por: usuario(req) });
      await registrarAuditoria(req, "IMPORTAR_CERCAS_SRF", "frota_areas", null, { ...r, ids });
      return r;
    }),
    enviar: responder(async (req) => {
      const r = await enviarUma(Number(req.params.id));
      await registrarAuditoria(req, "ENVIAR_CERCA_SRF", "frota_areas", r.area_id, r);
      return r;
    }),
    // Todas as areas daqui ainda sem cerca la (ou mexidas depois do envio).
    enviarTodas: responder(async (req) => {
      await garantir();
      const ids = (await db.query("SELECT id FROM frota_areas WHERE ativo AND (srf_id IS NULL OR srf_pendente) ORDER BY id")).rows.map((x) => x.id);
      const feitas = [], falhas = [];
      for (const id of ids) {
        try { feitas.push(await enviarUma(id)); } catch (err) { falhas.push({ area_id: id, erro: err.message }); }
      }
      await registrarAuditoria(req, "ENVIAR_CERCA_SRF", "frota_areas", null, { enviadas: feitas.length, falhas });
      return { enviadas: feitas.length, criadas: feitas.filter((f) => f.criada).length, falhas };
    }),
    // Troca tipo/nome aqui. Nome (ou cor, numa area feita aqui) mexido em area
    // ligada ao SRF fica "alterada aqui" ate reenviar.
    editar: responder(async (req) => {
      await garantir();
      const id = Number(req.params.id);
      const b = req.body || {};
      const a = (await db.query("SELECT id, nome, tipo, origem, cor, srf_id FROM frota_areas WHERE id = $1 AND ativo", [id])).rows[0];
      if (!a) throw Object.assign(new Error("Área não encontrada."), { status: 404 });
      const tipo = b.tipo === undefined ? a.tipo : String(b.tipo);
      if (!TIPOS.includes(tipo)) throw Object.assign(new Error("Tipo inválido."), { status: 400 });
      const nome = b.nome === undefined ? a.nome : String(b.nome).trim().slice(0, 80);
      if (!nome) throw Object.assign(new Error("Dê um nome para a área."), { status: 400 });
      const mudaLa = !!a.srf_id && (nome !== a.nome || (tipo !== a.tipo && !a.cor));
      await db.query("UPDATE frota_areas SET tipo = $1, nome = $2, srf_pendente = srf_pendente OR $3 WHERE id = $4", [tipo, nome, mudaLa, id]);
      await registrarAuditoria(req, "EDITAR_AREA_FROTA", "frota_areas", id, { de: { tipo: a.tipo, nome: a.nome }, para: { tipo, nome } });
      return { ok: true, srf_pendente: mudaLa || undefined };
    }),
    // DELETE /frota/areas/:id[?srf=1] — com srf=1 apaga a cerca la ANTES; se
    // o SRF recusar, nada e apagado aqui.
    apagar: (apagarLocal) => async (req, res) => {
      if (String(req.query.srf || "") === "1") {
        try {
          await garantir();
          const a = (await db.query("SELECT id, srf_id FROM frota_areas WHERE id = $1", [Number(req.params.id)])).rows[0];
          if (a && a.srf_id) {
            await rastreador.srfEnviar("destroy_geofence", { id: Number(a.srf_id) });
            await db.query("UPDATE frota_areas SET srf_id = NULL, srf_ativo = NULL, srf_pendente = FALSE WHERE id = $1", [a.id]);
            await registrarAuditoria(req, "APAGAR_CERCA_SRF", "frota_areas", a.id, { srf_id: a.srf_id });
          }
        } catch (err) {
          return res.status(502).json({ error: `Não consegui apagar no SRF (${err.message}). Nada foi apagado.` });
        }
      }
      return apagarLocal(req, res);
    },
  };

  return { garantir, importar, enviarUma, rotas };
}

module.exports = { criar, planejar, pontosDoSrf, corpoParaSrf, circulo, COR_TIPO, TIPOS, TIPOS_AVISO };
