// ================================================================
// preencher-remessas-tms.js  —  USO ÚNICO
// ----------------------------------------------------------------
// Backfill da coluna `remessas` (JSONB) da tabela `tms_paradas` nas
// viagens que JÁ foram importadas do Checklist Expedicao antes da
// criacao dessa coluna (ou seja, paradas com remessas = NULL).
//
// Para cada viagem com checklist_origem_id preenchido, busca o
// detalhe do checklist na API, monta as 5 secoes de remessa por loja
// (Materiais, Plastico Bolha, Caixa Azul Vazia, Material de Campanha
// e Sacola) e grava em tms_paradas.remessas, casando a parada pela
// loja (loja_nome == store_name).
//
// Usa EXATAMENTE a mesma logica de agrupamento de mapearChecklistParaViagem()
// do server.js.
//
// Só toca em paradas onde remessas IS NULL. Paradas que ja tem o
// snapshot NAO sao alteradas.
//
// FAÇA BACKUP DO BANCO ANTES DE RODAR.
//
// Como rodar (na pasta do projeto, na maquina do servidor):
//     node back/preencher-remessas-tms.js              -> grava de verdade
//     node back/preencher-remessas-tms.js --dry-run    -> só simula/mostra
// ================================================================

const db = require("./db");
require("@dotenvx/dotenvx").config({ quiet: true, override: true });

const DRY = process.argv.includes("--dry-run");

// --- Integracao com o Checklist Expedicao (replica do server.js) ---
const CHECKLIST_API_URL = (process.env.CHECKLIST_API_URL || "http://192.0.2.30:3040").replace(/\/$/, "");
const CHECKLIST_USER = process.env.CHECKLIST_USER || "";
const CHECKLIST_PASS = process.env.CHECKLIST_PASS || "";
const checklistAuthCache = { token: null, expMs: 0 };

async function checklistRenovarToken() {
  if (!CHECKLIST_USER || !CHECKLIST_PASS) {
    throw new Error("Configure CHECKLIST_USER e CHECKLIST_PASS no .env para usar a integracao.");
  }
  const resp = await fetch(`${CHECKLIST_API_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nickname: CHECKLIST_USER, password: CHECKLIST_PASS }),
  });
  if (!resp.ok) throw new Error(`Falha ao autenticar no Checklist Expedicao (HTTP ${resp.status}).`);
  const data = await resp.json();
  if (!data.token) throw new Error("Resposta do login sem token.");
  let expMs = Date.now() + 60 * 60 * 1000;
  try {
    const payload = JSON.parse(Buffer.from(data.token.split(".")[1], "base64").toString("utf8"));
    if (payload.exp) expMs = payload.exp * 1000;
  } catch { /* fallback ja definido */ }
  checklistAuthCache.token = data.token;
  checklistAuthCache.expMs = expMs - 60 * 1000;
}

async function checklistApi(caminho) {
  if (!checklistAuthCache.token || Date.now() >= checklistAuthCache.expMs) {
    await checklistRenovarToken();
  }
  let resp = await fetch(`${CHECKLIST_API_URL}${caminho}`, {
    headers: { Authorization: `Bearer ${checklistAuthCache.token}` },
  });
  if (resp.status === 401) {
    await checklistRenovarToken();
    resp = await fetch(`${CHECKLIST_API_URL}${caminho}`, {
      headers: { Authorization: `Bearer ${checklistAuthCache.token}` },
    });
  }
  if (!resp.ok) throw new Error(`Checklist API ${caminho}: HTTP ${resp.status}`);
  return resp.json();
}

// --- Monta as remessas por loja (store_name) a partir do detalhe ---
const num = (v) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);

function montarRemessasPorLoja(detalhe) {
  const agrupar = (lista, fn) => {
    const mapa = new Map();
    (lista || []).forEach((item) => {
      const arr = mapa.get(item.store_id) || [];
      arr.push(fn(item));
      mapa.set(item.store_id, arr);
    });
    return mapa;
  };
  const materiais = agrupar(detalhe.material_shipments, (m) => ({
    setor: m.sector || "", descricao: m.description || "", quantidade: num(m.quantity), carregado: !!m.loaded,
  }));
  const bolha = agrupar(detalhe.bubble_wrap_shipments, (b) => ({
    material: b.material || "", carregado: !!b.loaded,
  }));
  const caixa = agrupar(detalhe.empty_blue_box_shipments, (c) => ({
    quantidade: num(c.quantity), carregado: !!c.loaded,
  }));
  const campanha = agrupar(detalhe.campaign_material_shipments, (c) => ({
    campanha: c.campaign_name || "", adesivo: num(c.quantity_adesivo), banner: num(c.quantity_banner),
    folder: num(c.quantity_folder), total: num(c.quantity_total), carregado: !!c.loaded,
  }));
  const sacolas = agrupar(detalhe.bag_shipments, (b) => ({
    tamanho: b.size || "", p: num(b.quantity_p), m: num(b.quantity_m), g: num(b.quantity_g),
    total: num(b.quantity), carregado: !!b.loaded,
  }));

  // store_id -> store_name (das lojas do checklist)
  const idParaNome = new Map();
  (detalhe.stores || []).forEach((s) => idParaNome.set(s.store_id, s.store_name));

  // Resultado: chave normalizada do nome da loja -> objeto remessas
  const porNome = new Map();
  const idsComRemessa = new Set([
    ...materiais.keys(), ...bolha.keys(), ...caixa.keys(), ...campanha.keys(), ...sacolas.keys(),
  ]);
  for (const storeId of idsComRemessa) {
    const remessas = {
      materiais: materiais.get(storeId) || [],
      plastico_bolha: bolha.get(storeId) || [],
      caixa_azul: caixa.get(storeId) || [],
      campanha: campanha.get(storeId) || [],
      sacolas: sacolas.get(storeId) || [],
    };
    const nome = idParaNome.get(storeId);
    if (nome) porNome.set(normalizar(nome), remessas);
  }
  return porNome;
}

function normalizar(s) {
  return String(s || "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

async function main() {
  const client = await db.connect();
  try {
    // Viagens importadas que possuem ao menos uma parada sem remessas.
    const { rows: viagens } = await client.query(`
      SELECT DISTINCT v.id, v.codigo, v.checklist_origem_id
        FROM tms_viagens v
        JOIN tms_paradas p ON p.viagem_id = v.id
       WHERE v.checklist_origem_id IS NOT NULL
         AND p.remessas IS NULL
       ORDER BY v.id
    `);

    console.log(`Viagens importadas com paradas sem remessas: ${viagens.length}${DRY ? "  (DRY-RUN: nada sera gravado)" : ""}`);
    if (viagens.length === 0) {
      console.log("Nada a preencher. Encerrando.");
      return;
    }

    let paradasAtualizadas = 0;
    let viagensComErro = 0;

    if (!DRY) await client.query("BEGIN");

    for (const v of viagens) {
      let detalhe;
      try {
        detalhe = await checklistApi(`/api/checklists/${v.checklist_origem_id}`);
      } catch (err) {
        console.warn(`  ! Viagem ${v.codigo || v.id} (checklist #${v.checklist_origem_id}): ${err.message}`);
        viagensComErro += 1;
        continue;
      }
      const porNome = montarRemessasPorLoja(detalhe);
      if (porNome.size === 0) continue; // checklist sem nenhuma remessa

      const { rows: paradas } = await client.query(
        "SELECT id, loja_nome FROM tms_paradas WHERE viagem_id = $1 AND remessas IS NULL",
        [v.id]
      );
      for (const par of paradas) {
        const remessas = porNome.get(normalizar(par.loja_nome));
        if (!remessas) continue;
        if (!DRY) {
          await client.query("UPDATE tms_paradas SET remessas = $1 WHERE id = $2", [JSON.stringify(remessas), par.id]);
        }
        paradasAtualizadas += 1;
      }
    }

    if (!DRY) await client.query("COMMIT");

    console.log(`✅ ${DRY ? "Simuladas" : "Atualizadas"}: ${paradasAtualizadas} parada(s) em ${viagens.length - viagensComErro} viagem(ens).`);
    if (viagensComErro) console.log(`   ⚠️ ${viagensComErro} viagem(ens) com erro ao consultar o checklist (ignoradas).`);
    if (DRY) console.log("\n(DRY-RUN) Rode sem --dry-run para gravar de verdade.");
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
