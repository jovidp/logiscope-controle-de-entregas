// ================================================================
// lojas-pes.js — cadastro UNICO de loja pelo PES + km + frete calculado
// ----------------------------------------------------------------
// Ate aqui a loja existia em 5 lugares (cadastros, tms_lojas, tms_fretes_loja,
// metas_loja, deslocamento-distancias.js), todos ligados pelo NOME — e cada
// grafia nova ("PARK SHOPPING", "S. P. ALDEIA", "ITAGUAI") virava loja nova.
// Aqui a loja e identificada pelo PES; toda grafia conhecida vira APELIDO.
//
// Fonte: planilhas da expedicao em \\empresa.local\fileserver\expedicao\{ANO}
//   ROTAS ATUALIZADAS.xlsx
//     "ROTS ATUALIZADAS teste 27.08" -> PES, EMP, loja, rota, ordem, horario
//     "INFORMAÇÕES DAS ROTAS"        -> endereco, CEP, CNPJ, IE (por FL = EMP)
//     "FRETE FABRICA X LOJA"         -> parametros da formula do frete
//   VALOR DE FRETE ATUALIZADO.xlsx   -> km LOJA X LOJA / FABRICA X LOJA / LOJA X FABRICA
//   GUIA EXPEDIÇÃO - 2025.xlsx "CARROS" -> placa -> modelo (Atego/Accelo/...)
//
// Frete de ENVIO de uma loja (formula escrita na propria planilha):
//     km(FABRICA -> loja) x CCD + CC[tipo do caminhao]
// O sistema guarda os insumos (km, CCD, CC) e CALCULA — nao copia o valor —
// para que trocar a tarifa seja mudar um numero, nao 93.
// Frete de RETORNO: por ora a operacao usa o MESMO valor do envio.
//
// Rodar (idempotente):  node back/importar-lojas-pes.js [--dry]
// ================================================================

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { chaveLoja } = require("./normalizar-loja");

const PASTA_PADRAO = "\\\\empresa.local\\fileserver\\expedicao\\{ANO}";
const ARQ_ROTAS = "ROTAS ATUALIZADAS.xlsx";
const ABA_ROTAS = "ROTS ATUALIZADAS teste 27.08";
const ABA_INFO = "INFORMAÇÕES DAS ROTAS";
const ABA_FORMULA = "FRETE FABRICA X LOJA";
const ARQ_KM = "VALOR DE FRETE ATUALIZADO.xlsx";
const ABAS_KM = ["LOJA X LOJA", "FÁBRICA X LOJA", "LOJA X FÁBRICA"];
const ARQ_GUIA = "GUIA EXPEDIÇÃO - 2025.xlsx";
const ABA_CARROS = "CARROS";

const FABRICA = "FABRICA";
// Valores da planilha em 2026-10 — so usados se a leitura da aba falhar.
const PARAMETROS_PADRAO = { ccd: 9, cc: { "2_EIXOS": 436.39, "3_EIXOS": 523.33, "6_EIXOS": 648.95 } };
const ROTULO_TIPO = { "2_EIXOS": "2 eixos (Accelo)", "3_EIXOS": "3 eixos (Atego)", "6_EIXOS": "Carreta (6 eixos)" };

// Grafias que nenhuma regra automatica une, mas sao a MESMA loja (herdado do
// importar-fretes-loja.js; conferido no banco). [grafia, nome da loja]
const APELIDOS_FIXOS = [
  ["ITAGUAI", "ITAGUAÍ I"], // "ITAGUAI" sem numero convive com ITAGUAI II
  ["PASSEIO SHOPPING", "PASSEIO"], // como a capa da frente escreve
  ["TAQUARA I", "TAQUARA"],        // capa: "Taquara I" (rua) x "Taquara Plaza"
];
const ARQ_CAPA = "CAPA DA FRENTE ATUALIZADA 2026.xlsx";
// Erros de digitacao SO da planilha de km (nao viram apelido permanente:
// se um dia existir CAMPO GRANDE II de verdade, ele tera o PES dele).
const CORRECOES_KM = { "CAMPO GRANDE 2": "CAMPO GRANDE 3" };
// Parada que aparece no TMS sem PES e fora da conta de frete por decisao da operacao.
const SEM_PES = [{ nome: "DJOFFER", na_conta: false }];

// ---------------------------------------------------------------- schema
async function garantirTabelas(q) {
  await q.query(`
    CREATE TABLE IF NOT EXISTS lojas_pes (
      codigo TEXT PRIMARY KEY,               -- o PES; loja sem PES usa o nome (ex.: DJOFFER)
      pes TEXT UNIQUE,
      emp TEXT,
      nome TEXT NOT NULL,
      chave TEXT NOT NULL UNIQUE,            -- chaveLoja(nome)
      apelidos TEXT[] NOT NULL DEFAULT '{}', -- outras chaves que significam esta loja
      rota TEXT,
      ordem_rota INTEGER,
      horario_loja TEXT,                     -- 'HH:MM'; NULL = horario normal da loja
      tipo_ponto TEXT,
      endereco TEXT,
      cep TEXT,
      cnpj TEXT,
      inscricao_estadual TEXT,
      na_conta BOOLEAN NOT NULL DEFAULT TRUE,
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      fonte TEXT,
      atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS distancias_loja (
      origem TEXT NOT NULL,                  -- lojas_pes.codigo ou 'FABRICA'
      destino TEXT NOT NULL,
      km NUMERIC(8,1) NOT NULL,
      fonte TEXT,
      atualizado_em TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (origem, destino)
    );
    ALTER TABLE lojas_pes ADD COLUMN IF NOT EXISTS telefone TEXT;  -- celular "OI DA LOJA" (capa da frente)
    ALTER TABLE tms_veiculos ADD COLUMN IF NOT EXISTS tipo_frete TEXT;
    ALTER TABLE tms_veiculos ADD COLUMN IF NOT EXISTS tipo_frete_assumido BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE tms_veiculos ADD COLUMN IF NOT EXISTS carga_kg INTEGER;
  `);
}

// ---------------------------------------------------------------- utilitarios
const limpar = (v) => String(v ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
const alnum = (chave) => String(chave || "").replace(/[^A-Z0-9]/g, "");
// Sem as preposicoes: "S. P. ALDEIA" == "S.P. DA ALDEIA".
const alnumSemPrep = (chave) => alnum(String(chave || "").replace(/\b(DA|DE|DO|DAS|DOS)\b/g, ""));
const baseSemNumero = (chave) => String(chave || "").replace(/\s+\d+$/, "");
const temNumero = (chave) => /\s\d+$/.test(String(chave || ""));

// Placa sem mascara e no padrao Mercosul (KRV7757 == FKE4G14): o 5o caractere
// numerico da placa antiga vira letra (0=A ... 9=J).
function normalizarPlaca(placa) {
  const p = String(placa || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (p.length === 7 && /^[A-Z]{3}\d\d\d\d$/.test(p)) {
    return p.slice(0, 4) + "ABCDEFGHIJ"[Number(p[4])] + p.slice(5);
  }
  return p;
}

// Hora do Excel (fracao do dia, Date ou texto) -> 'HH:MM'.
function paraHHMM(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" && v >= 0 && v < 1) {
    const min = Math.round(v * 24 * 60);
    return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  }
  if (v instanceof Date) return `${String(v.getHours()).padStart(2, "0")}:${String(v.getMinutes()).padStart(2, "0")}`;
  const m = String(v).match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}

function tipoFretePorModelo(modelo) {
  const m = String(modelo || "").toUpperCase();
  if (/ATEGO/.test(m)) return { tipo: "3_EIXOS", assumido: false };
  if (/ACCELO/.test(m)) return { tipo: "2_EIXOS", assumido: false };
  if (/CARRETA|6\s*EIXOS/.test(m)) return { tipo: "6_EIXOS", assumido: false };
  // Iveco e KIA sao menores que o Accelo e a tabela nao tem faixa propria:
  // cobra-se a menor faixa (2 eixos) e marca como assumido.
  if (m) return { tipo: "2_EIXOS", assumido: true };
  return null;
}

// ---------------------------------------------------------------- leitura das planilhas
function pastaExpedicao(pasta) {
  return (pasta || process.env.EXPEDICAO_DIR || PASTA_PADRAO).replace("{ANO}", String(new Date().getFullYear()));
}

function linhasDaAba(arquivo, aba) {
  const wb = XLSX.readFile(arquivo, { cellDates: false });
  const ws = wb.Sheets[aba];
  if (!ws) throw new Error(`Aba "${aba}" nao encontrada em ${path.basename(arquivo)}.`);
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
}

// Blocos de rota: cabecalho (nome da rota na coluna C) + linhas "2º, 3º..." com
// PES/LOJA/EMP/HORARIO/FRETE 2 EIXOS/FRETE 3 EIXOS. Le so as colunas A..J (a
// tabela lateral da R. Lagos, a partir da coluna Q, e uma versao antiga).
function lerRotas(arquivo) {
  const linhas = linhasDaAba(arquivo, ABA_ROTAS);
  const lojas = [];
  let rota = null;
  for (const c of linhas) {
    const atd = limpar(c[0]);
    const nome = limpar(c[2]);
    if (!nome) continue;
    const ehParada = /^\d+º$/.test(atd);
    if (!ehParada) {
      if (!/^(LOJAS|ATD)$/i.test(nome)) rota = nome;
      continue;
    }
    if (/^F[AÁ]BRICA$/i.test(nome)) continue;
    lojas.push({
      rota,
      ordem: parseInt(atd, 10),
      pes: c[1] == null || c[1] === "" ? null : String(c[1]).trim(),
      nome,
      emp: c[3] == null || c[3] === "" ? null : String(c[3]).trim(),
      horario: paraHHMM(c[4]),
      frete2: typeof c[5] === "number" ? c[5] : null,
      frete3: typeof c[6] === "number" ? c[6] : null,
    });
  }
  return lojas;
}

function lerInfo(arquivo) {
  const linhas = linhasDaAba(arquivo, ABA_INFO);
  const porEmp = new Map();
  for (const c of linhas.slice(1)) {
    const emp = c[0] == null ? "" : String(c[0]).trim();
    if (!/^\d+$/.test(emp)) continue;
    porEmp.set(emp, {
      tipo_ponto: limpar(c[3]) || null,
      endereco: limpar(c[4]) || null,
      cep: limpar(c[5]) || null,
      cnpj: limpar(c[6]) || null,
      inscricao_estadual: limpar(c[7]) || null,
    });
  }
  return porEmp;
}

// "CCD" e "CC n EIXOS" sao rotulos com o valor na celula de BAIXO.
function lerParametros(arquivo) {
  const linhas = linhasDaAba(arquivo, ABA_FORMULA);
  const abaixo = (i, j) => (linhas[i + 1] ? linhas[i + 1][j] : null);
  const p = { ccd: null, cc: {} };
  linhas.forEach((c, i) => c.forEach((v, j) => {
    const t = limpar(v).toUpperCase();
    if (t === "CCD" && typeof abaixo(i, j) === "number") p.ccd = abaixo(i, j);
    const m = t.match(/^CC (\d) EIXOS$/);
    if (m && typeof abaixo(i, j) === "number") p.cc[`${m[1]}_EIXOS`] = abaixo(i, j);
  }));
  const ok = p.ccd && p.cc["2_EIXOS"] && p.cc["3_EIXOS"];
  return ok ? { ...PARAMETROS_PADRAO, ...p, cc: { ...PARAMETROS_PADRAO.cc, ...p.cc }, fonte: `${ARQ_ROTAS} / ${ABA_FORMULA}` }
            : { ...PARAMETROS_PADRAO, fonte: "padrao (aba da formula nao lida)" };
}

// As abas de km tem varios blocos lado a lado (ORIGEM | DESTINO | KM | CUSTO).
// Um trecho e qualquer trio texto-texto-numero que nao seja cabecalho/total.
function lerKm(arquivo) {
  const trechos = [];
  for (const aba of ABAS_KM) {
    for (const c of linhasDaAba(arquivo, aba)) {
      for (let j = 0; j + 2 < c.length; j += 1) {
        const o = limpar(c[j]), d = limpar(c[j + 1]), km = c[j + 2];
        if (!o || !d || typeof km !== "number" || typeof c[j] !== "string" || typeof c[j + 1] !== "string") continue;
        if (/^(ORIGEM|TOTAL|DESTINO)$/i.test(o) || /^(ORIGEM|TOTAL|DESTINO|KM)$/i.test(d)) continue;
        trechos.push({ aba, origem: o, destino: d, km });
      }
    }
  }
  return trechos;
}

function lerCarros(arquivo) {
  const linhas = linhasDaAba(arquivo, ABA_CARROS);
  const iCab = linhas.findIndex((c) => c.some((v) => /^VE[IÍ]CULO$/i.test(limpar(v))) && c.some((v) => /^MODELO$/i.test(limpar(v))));
  if (iCab < 0) throw new Error(`Cabecalho VEICULO/MODELO nao encontrado na aba ${ABA_CARROS}.`);
  const cab = linhas[iCab].map((v) => limpar(v).toUpperCase());
  const col = (re) => cab.findIndex((v) => re.test(v));
  const iPlaca = col(/^VE[IÍ]CULO$/), iModelo = col(/^MODELO$/), iCarga = col(/^CARGA$/);
  return linhas.slice(iCab + 1).map((c) => ({
    placa: normalizarPlaca(c[iPlaca]),
    modelo: limpar(c[iModelo]) || null,
    carga_kg: typeof c[iCarga] === "number" ? Math.round(c[iCarga]) : null,
  })).filter((v) => v.placa.length === 7);
}

// CAPA DA FRENTE: uma aba por rota/variacao. Linhas "1º, 2º..." trazem
// loja | horario | RAMAL | OI DA LOJA (celular) | retirada | caixa vazia; abaixo,
// o quadro das docas (carrinho 4 rodas | 2 rodas | sem carrinho | horario).
// Celula de horario do quadro de docas: o Excel guarda hora como FRACAO do dia
// (0.75 = 18:00) — sem isto a capa imprimia "0.75". Texto tem os segundos
// tirados ("ATÉ16:00:00" -> "ATÉ 16:00").
function textoHorario(v) {
  if (typeof v === "number" && v >= 0 && v < 1) return paraHHMM(v);
  const t = limpar(v);
  if (!t) return null;
  return t.replace(/(\d{1,2}:\d{2}):\d{2}/g, "$1").replace(/([A-ZÀ-Ú])(\d{1,2}:\d{2})/gi, "$1 $2");
}

function lerCapa(arquivo) {
  const wb = XLSX.readFile(arquivo, { cellDates: false });
  const telefones = [], docas = [];
  for (const nomeAba of wb.SheetNames) {
    const linhas = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, raw: true, defval: null });
    let quadroDocas = false;
    for (const c of linhas) {
      const a = limpar(c[0]), b = limpar(c[1]);
      if (c.some((v) => /CARRINHO 4 RODAS/i.test(limpar(v)))) { quadroDocas = true; continue; }
      if (/^DATA/i.test(a)) { quadroDocas = false; continue; }
      if (quadroDocas) {
        if (b && !/^(MOTORISTA|CARRO|N[º°])/i.test(a)) {
          docas.push({ aba: nomeAba, loja: b, c4: textoHorario(c[2]), c2: textoHorario(c[3]),
            sem: limpar(c[4]) || null, horario: textoHorario(c[5]) });
        }
        continue;
      }
      if (/^\d+º$/.test(a) && b) {
        const tel = limpar(c[4]);
        telefones.push({ aba: nomeAba, loja: b, telefone: /\d{4}-?\d{4}/.test(tel) ? tel : null });
      }
    }
  }
  return { telefones, docas };
}

// Valor mais frequente (as abas sao copias umas das outras; a maioria vence
// erro de digitacao/troca isolada — ex.: AMERICAS x PONTAL).
function maisFrequente(valores, chave = (v) => v) {
  const cont = new Map();
  for (const v of valores) {
    const k = chave(v);
    if (!k) continue;
    const e = cont.get(k) || { v, n: 0 };
    e.n += 1;
    cont.set(k, e);
  }
  return [...cont.values()].sort((x, y) => y.n - x.n)[0]?.v ?? null;
}

function lerPlanilhas(pasta) {
  const dir = pastaExpedicao(pasta);
  const arq = (n) => {
    const p = path.join(dir, n);
    if (!fs.existsSync(p)) throw new Error(`Planilha nao encontrada: ${p}`);
    return p;
  };
  return {
    dir,
    rotas: lerRotas(arq(ARQ_ROTAS)),
    info: lerInfo(arq(ARQ_ROTAS)),
    parametros: lerParametros(arq(ARQ_ROTAS)),
    km: lerKm(arq(ARQ_KM)),
    carros: lerCarros(arq(ARQ_GUIA)),
    capa: fs.existsSync(path.join(dir, ARQ_CAPA)) ? lerCapa(path.join(dir, ARQ_CAPA)) : { telefones: [], docas: [] },
  };
}

// ---------------------------------------------------------------- resolvedor de nome -> loja
// Ordem: chave exata (inclui apelidos) -> so letras/numeros -> sem preposicao
// -> nome SEM numero que so tem UMA loja com aquela base (RIO BONITO -> RIO BONITO 2).
function criarResolvedor(lojas) {
  const porChave = new Map(), porAlnum = new Map(), porSemPrep = new Map(), porPes = new Map(), porBase = new Map();
  const add = (mapa, k, loja) => {
    if (!k) return;
    const atual = mapa.get(k);
    mapa.set(k, atual && atual !== loja ? "AMBIGUO" : loja);
  };
  for (const l of lojas) {
    if (l.pes) porPes.set(String(l.pes), l);
    for (const k of [l.chave, ...(l.apelidos || [])]) {
      add(porChave, k, l);
      add(porAlnum, alnum(k), l);
      add(porSemPrep, alnumSemPrep(k), l);
    }
    add(porBase, alnum(baseSemNumero(l.chave)), l);
  }
  const ok = (v) => (v && v !== "AMBIGUO" ? v : null);
  return function resolver(nome, pes) {
    if (pes && porPes.has(String(pes))) return porPes.get(String(pes));
    const k = chaveLoja(limpar(nome));
    if (!k) return null;
    return ok(porChave.get(k)) || ok(porAlnum.get(alnum(k))) || ok(porSemPrep.get(alnumSemPrep(k)))
      || (!temNumero(k) ? ok(porBase.get(alnum(k))) : null) || null;
  };
}

// ---------------------------------------------------------------- importacao
async function importar(q, { pasta, dry = false, log = console.log } = {}) {
  const dados = lerPlanilhas(pasta);
  const avisos = [];

  // Nome "oficial" e a grafia que o sistema ja usa (tms_fretes_loja, pelo PES);
  // a da planilha vira apelido. Assim nada que ja casa deixa de casar.
  const fretes = await q.query("SELECT chave, loja_nome, pes FROM tms_fretes_loja").catch(() => ({ rows: [] }));
  // Um PES pode ter 2 linhas la (PARK e PARK SHOPPING, ITAGUAI e ITAGUAI 1):
  // vale a que tem o nome da planilha; senao a de nome numerado/mais longo.
  const fretesDoPes = (pes, nomePlanilha) => {
    const doPes = fretes.rows.filter((r) => String(r.pes || "") === pes);
    return doPes.find((r) => r.chave === chaveLoja(nomePlanilha))
      || doPes.sort((a, b) => temNumero(b.chave) - temNumero(a.chave) || b.chave.length - a.chave.length)[0];
  };

  const lojas = new Map(); // codigo -> loja
  for (const r of dados.rotas) {
    if (!r.pes) {
      if (!SEM_PES.some((s) => chaveLoja(s.nome) === chaveLoja(r.nome))) avisos.push(`Loja sem PES na planilha: ${r.nome} (${r.rota})`);
      continue;
    }
    if (lojas.has(r.pes)) { avisos.push(`PES ${r.pes} repetido na planilha (${r.nome}) — mantida a 1a ocorrencia`); continue; }
    const fr = fretesDoPes(r.pes, r.nome);
    const nome = fr ? fr.loja_nome : r.nome;
    const chave = fr ? fr.chave : chaveLoja(r.nome);
    const info = (r.emp && dados.info.get(r.emp)) || {};
    lojas.set(r.pes, {
      codigo: r.pes, pes: r.pes, emp: r.emp, nome, chave,
      apelidos: new Set([chaveLoja(r.nome)].filter((k) => k !== chave)),
      rota: r.rota, ordem_rota: r.ordem, horario_loja: r.horario, na_conta: true,
      ...info, frete2_planilha: r.frete2, frete3_planilha: r.frete3,
    });
  }
  for (const s of SEM_PES) {
    const chave = chaveLoja(s.nome);
    lojas.set(chave, { codigo: chave, pes: null, emp: null, nome: s.nome, chave, apelidos: new Set(), rota: null,
      ordem_rota: null, horario_loja: null, na_conta: s.na_conta });
  }
  // Grafias do sistema com o mesmo PES (ex.: tms_fretes_loja "PARK SHOPPING")
  for (const fr of fretes.rows) {
    const l = fr.pes && lojas.get(String(fr.pes));
    if (l && fr.chave !== l.chave) l.apelidos.add(fr.chave);
  }
  for (const [grafia, alvo] of APELIDOS_FIXOS) {
    const l = [...lojas.values()].find((x) => x.chave === chaveLoja(alvo));
    if (l) l.apelidos.add(chaveLoja(grafia)); else avisos.push(`Apelido fixo sem loja: ${grafia} -> ${alvo}`);
  }

  // Toda grafia que ja existe no banco vira apelido da loja certa (ou aviso).
  const lista = () => [...lojas.values()].map((l) => ({ ...l, apelidos: [...l.apelidos] }));
  let resolver = criarResolvedor(lista());
  const grafias = await q.query(`
      SELECT DISTINCT nome FROM (
        SELECT loja AS nome FROM ocorrencias WHERE excluida_em IS NULL
        UNION SELECT loja_nome FROM tms_paradas
        UNION SELECT valor FROM cadastros WHERE tipo = 'loja'
        UNION SELECT loja FROM metas_loja
      ) t WHERE nome IS NOT NULL AND TRIM(nome) <> ''`);
  const semLoja = new Set();
  for (const { nome } of grafias.rows) {
    const l = resolver(nome);
    if (!l) { semLoja.add(limpar(nome)); continue; }
    const k = chaveLoja(limpar(nome));
    if (k !== l.chave) lojas.get(l.codigo).apelidos.add(k);
  }
  resolver = criarResolvedor(lista());

  // Capa da frente: celular (OI) por loja e quadro das docas.
  const capaSemLoja = new Set();
  const telsPorLoja = new Map(), docasPorLoja = new Map();
  for (const t of dados.capa.telefones) {
    const l = resolver(t.loja);
    if (!l) { capaSemLoja.add(t.loja); continue; }
    if (t.telefone) (telsPorLoja.get(l.codigo) || telsPorLoja.set(l.codigo, []).get(l.codigo)).push(t.telefone);
  }
  for (const d of dados.capa.docas) {
    const l = resolver(d.loja);
    if (!l) { capaSemLoja.add(d.loja); continue; }
    (docasPorLoja.get(l.codigo) || docasPorLoja.set(l.codigo, []).get(l.codigo)).push(d);
  }
  for (const [cod, tels] of telsPorLoja) {
    lojas.get(cod).telefone = maisFrequente(tels, (t) => t.replace(/\D/g, ""));
  }

  // Km: nomes -> codigo; FABRICA e especial.
  const codigoDe = (nome) => {
    if (/^F[AÁ]BRICA$/i.test(limpar(nome))) return FABRICA;
    const k = chaveLoja(limpar(nome));
    const l = resolver(CORRECOES_KM[k] || nome);
    return l ? l.codigo : null;
  };
  const distancias = new Map();
  const kmSemLoja = new Set();
  for (const t of dados.km) {
    const o = codigoDe(t.origem), d = codigoDe(t.destino);
    if (!o) kmSemLoja.add(t.origem);
    if (!d) kmSemLoja.add(t.destino);
    if (!o || !d || o === d) continue;
    const chave = `${o}|${d}`;
    const atual = distancias.get(chave);
    if (atual && Math.abs(atual.km - t.km) > 0.05) avisos.push(`km divergente ${t.origem} -> ${t.destino}: ${atual.km} (${atual.aba}) x ${t.km} (${t.aba}) — mantido ${atual.km}`);
    if (!atual) distancias.set(chave, { origem: o, destino: d, km: t.km, aba: t.aba });
  }

  // Confere a formula contra o valor que a planilha traz (so relatorio).
  const p = dados.parametros;
  let freteConfere = 0;
  const freteDiverge = [];
  for (const l of lojas.values()) {
    const km = distancias.get(`${FABRICA}|${l.codigo}`)?.km;
    if (km == null) continue;
    for (const [tipo, valor] of [["2_EIXOS", l.frete2_planilha], ["3_EIXOS", l.frete3_planilha]]) {
      if (valor == null) continue;
      const calc = Math.round((km * p.ccd + p.cc[tipo]) * 100) / 100;
      if (Math.abs(calc - valor) <= 0.02) freteConfere += 1;
      else freteDiverge.push(`${l.nome} ${tipo}: planilha ${valor} x formula ${calc}`);
    }
  }

  // Grava a placa com a grafia que o sistema ja usa (FKO1007), nao a convertida
  // para Mercosul (LTM4C84) — a comparacao normaliza os dois lados de qualquer jeito.
  const placasSistema = await q.query(`
      SELECT DISTINCT placa FROM (SELECT placa FROM tms_viagens UNION SELECT valor FROM cadastros WHERE tipo = 'placa') t
       WHERE placa IS NOT NULL`);
  const grafiaPlaca = new Map(placasSistema.rows.map((r) => [normalizarPlaca(r.placa), String(r.placa).toUpperCase().replace(/[^A-Z0-9]/g, "")]));
  const carros = [];
  for (const c of dados.carros) {
    const t = tipoFretePorModelo(c.modelo);
    carros.push({ ...c, placa: grafiaPlaca.get(c.placa) || c.placa,
      tipo_frete: t ? t.tipo : null, tipo_frete_assumido: t ? t.assumido : true });
  }
  const placasSemModelo = [...grafiaPlaca.entries()]
    .filter(([norm]) => !dados.carros.some((c) => c.placa === norm && c.modelo))
    .map(([, original]) => original).filter((p) => p.length === 7);

  const relatorio = {
    pasta: dados.dir,
    lojas: lojas.size,
    lojas_com_horario: [...lojas.values()].filter((l) => l.horario_loja).length,
    lojas_com_endereco: [...lojas.values()].filter((l) => l.endereco).length,
    apelidos: [...lojas.values()].reduce((a, l) => a + l.apelidos.size, 0),
    distancias: distancias.size,
    carros: carros.length,
    parametros: p,
    frete_formula_confere: freteConfere,
    frete_formula_diverge: freteDiverge,
    grafias_sem_loja: [...semLoja].sort(),
    km_nomes_sem_loja: [...kmSemLoja].sort(),
    placas_sem_modelo: placasSemModelo.sort(),
    lojas_com_telefone: telsPorLoja.size,
    lojas_com_docas: docasPorLoja.size,
    capa_nomes_sem_loja: [...capaSemLoja].sort(),
    avisos,
  };
  log(`Lojas: ${relatorio.lojas} (${relatorio.lojas_com_horario} com horario, ${relatorio.lojas_com_endereco} com endereco), apelidos: ${relatorio.apelidos}`);
  log(`Trechos de km: ${relatorio.distancias} | Carros: ${relatorio.carros} | Formula: km x ${p.ccd} + CC ${JSON.stringify(p.cc)} [${p.fonte}]`);
  log(`Frete planilha x formula: ${freteConfere} conferem, ${freteDiverge.length} divergem`);
  if (dry) return { gravado: false, relatorio, lojas: lista(), distancias: [...distancias.values()], carros };

  await garantirTabelas(q);
  await q.query("BEGIN");
  try {
    for (const l of lojas.values()) {
      await q.query(`
        INSERT INTO lojas_pes (codigo, pes, emp, nome, chave, apelidos, rota, ordem_rota, horario_loja,
                               tipo_ponto, endereco, cep, cnpj, inscricao_estadual, na_conta, ativo, fonte, atualizado_em, telefone)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,TRUE,$16,NOW(),$17)
        ON CONFLICT (codigo) DO UPDATE SET pes=EXCLUDED.pes, emp=EXCLUDED.emp, nome=EXCLUDED.nome, chave=EXCLUDED.chave,
          telefone=COALESCE(EXCLUDED.telefone, lojas_pes.telefone),
          apelidos=EXCLUDED.apelidos, rota=EXCLUDED.rota, ordem_rota=EXCLUDED.ordem_rota, horario_loja=EXCLUDED.horario_loja,
          tipo_ponto=COALESCE(EXCLUDED.tipo_ponto, lojas_pes.tipo_ponto), endereco=COALESCE(EXCLUDED.endereco, lojas_pes.endereco),
          cep=COALESCE(EXCLUDED.cep, lojas_pes.cep), cnpj=COALESCE(EXCLUDED.cnpj, lojas_pes.cnpj),
          inscricao_estadual=COALESCE(EXCLUDED.inscricao_estadual, lojas_pes.inscricao_estadual),
          na_conta=EXCLUDED.na_conta, ativo=TRUE, fonte=EXCLUDED.fonte, atualizado_em=NOW()`,
        [l.codigo, l.pes, l.emp, l.nome, l.chave, [...l.apelidos], l.rota, l.ordem_rota, l.horario_loja,
         l.tipo_ponto || null, l.endereco || null, l.cep || null, l.cnpj || null, l.inscricao_estadual || null,
         l.na_conta, `${ARQ_ROTAS} / ${ABA_ROTAS}`, l.telefone || null]);
    }
    // Docas: loja sem linha ganha uma; linha que ESTE importador criou e que
    // ninguem editou depois (atualizado_em = criado_em) e reescrita. Linha
    // ajustada a mao na tela de Docas nunca e sobrescrita.
    const MARCA_DOCAS = "Importado da planilha CAPA DA FRENTE";
    const docasExistentes = await q.query("SELECT id, loja, observacao, (atualizado_em = criado_em) AS intocada FROM docas");
    const docasDaLoja = new Map();
    for (const r of docasExistentes.rows) {
      const cod = resolver(r.loja)?.codigo;
      if (cod) (docasDaLoja.get(cod) || docasDaLoja.set(cod, []).get(cod)).push(r);
    }
    let docasCriadas = 0, docasAtualizadas = 0;
    for (const [cod, linhas] of docasPorLoja) {
      const l = lojas.get(cod);
      const d = maisFrequente(linhas, (x) => [x.c4, x.c2, x.sem, x.horario].join("|"));
      const existentes = docasDaLoja.get(cod) || [];
      if (!existentes.length) {
        await q.query(`
          INSERT INTO docas (filial, loja, carrinho_4_rodas, carrinho_2_rodas, sem_carrinho_apos_horario, horario, observacao)
          VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [l.emp || l.pes || "-", l.nome, d.c4, d.c2, d.sem, d.horario, MARCA_DOCAS]);
        docasCriadas += 1;
        continue;
      }
      for (const r of existentes.filter((x) => x.observacao === MARCA_DOCAS && x.intocada)) {
        const up = await q.query(`
          UPDATE docas SET carrinho_4_rodas = $1, carrinho_2_rodas = $2, sem_carrinho_apos_horario = $3, horario = $4
           WHERE id = $5 AND (carrinho_4_rodas, carrinho_2_rodas, sem_carrinho_apos_horario, horario)
                 IS DISTINCT FROM ($1, $2, $3, $4)`,
          [d.c4, d.c2, d.sem, d.horario, r.id]);
        docasAtualizadas += up.rowCount;
      }
    }
    relatorio.docas_criadas = docasCriadas;
    relatorio.docas_atualizadas = docasAtualizadas;
    // Loja que saiu da planilha fica inativa (nao apaga: historico aponta pra ela).
    // Loja cadastrada A MAO (fonte "... cadastro manual", ex.: BUZIOS II pela
    // NF-e em 05/10/2026) nao esta na planilha e nao pode ser desativada por ela.
    await q.query(`UPDATE lojas_pes SET ativo = FALSE, atualizado_em = NOW()
                    WHERE codigo <> ALL($1::text[]) AND ativo AND COALESCE(fonte, '') NOT ILIKE '%cadastro manual%'`,
      [[...lojas.keys()]]);
    for (const d of distancias.values()) {
      await q.query(`
        INSERT INTO distancias_loja (origem, destino, km, fonte, atualizado_em) VALUES ($1,$2,$3,$4,NOW())
        ON CONFLICT (origem, destino) DO UPDATE SET km=EXCLUDED.km, fonte=EXCLUDED.fonte, atualizado_em=NOW()`,
        [d.origem, d.destino, d.km, `${ARQ_KM} / ${d.aba}`]);
    }
    for (const c of carros) {
      await q.query(`
        INSERT INTO tms_veiculos (placa, modelo, carga_kg, tipo_frete, tipo_frete_assumido)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (placa) DO UPDATE SET modelo=COALESCE(EXCLUDED.modelo, tms_veiculos.modelo),
          carga_kg=COALESCE(EXCLUDED.carga_kg, tms_veiculos.carga_kg),
          tipo_frete=COALESCE(EXCLUDED.tipo_frete, tms_veiculos.tipo_frete),
          tipo_frete_assumido=CASE WHEN EXCLUDED.tipo_frete IS NULL THEN tms_veiculos.tipo_frete_assumido
                                   ELSE EXCLUDED.tipo_frete_assumido END`,
        [c.placa, c.modelo, c.carga_kg, c.tipo_frete, c.tipo_frete_assumido]);
    }
    await q.query(`
      INSERT INTO sistema_config (chave, valor, atualizado_em) VALUES ('frete_parametros', $1::jsonb, NOW())
      ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = NOW()`,
      [JSON.stringify({ ccd: p.ccd, cc: p.cc, fonte: p.fonte })]);

    // Horario da loja -> metas_loja (o que o OTIF usa). So preenche o que esta
    // VAZIO: meta digitada por alguem nunca e sobrescrita. Sem horario na
    // planilha = "Horario normal" na operacao = sem_horario (n/a legitimo).
    let metas = 0;
    for (const { nome } of grafias.rows) {
      const l = resolver(nome);
      if (!l || !l.na_conta) continue;
      const grafia = limpar(nome);
      const r = await q.query(`
        INSERT INTO metas_loja (loja_chave, loja, hora_agendada, sem_horario, criado_por, atualizado_em)
        VALUES (UPPER($1), $1, $2, $3, 'planilha ROTAS ATUALIZADAS', NOW())
        ON CONFLICT (loja_chave) DO NOTHING`,
        [grafia, l.horario_loja, !l.horario_loja]);
      metas += r.rowCount;
    }
    await q.query("COMMIT");
    relatorio.metas_criadas = metas;
    log(`Gravado. metas_loja novas: ${metas}`);
  } catch (err) {
    await q.query("ROLLBACK").catch(() => {});
    throw err;
  }
  return { gravado: true, relatorio };
}

// ---------------------------------------------------------------- uso em tempo de execucao
let _cache = null;
const CACHE_MS = 60 * 1000;

async function carregarIndice(q, { forcar = false } = {}) {
  if (!forcar && _cache && Date.now() - _cache.em < CACHE_MS) return _cache.idx;
  try {
    const [lojas, dist, veic, cfg, ramais, docas] = await Promise.all([
      q.query("SELECT * FROM lojas_pes WHERE ativo"),
      q.query("SELECT origem, destino, km FROM distancias_loja"),
      q.query("SELECT placa, modelo, tipo_frete, tipo_frete_assumido FROM tms_veiculos"),
      q.query("SELECT valor FROM sistema_config WHERE chave = 'frete_parametros'"),
      q.query("SELECT valor, extra->>'ramal' AS ramal FROM cadastros WHERE tipo = 'loja' AND extra->>'ramal' IS NOT NULL"),
      q.query("SELECT loja, carrinho_4_rodas, carrinho_2_rodas, sem_carrinho_apos_horario, horario FROM docas ORDER BY id DESC"),
    ]);
    const resolver = criarResolvedor(lojas.rows);
    // Ramal (portal da TI, em cadastros.extra) e docas, indexados pela loja do PES.
    const ramal = new Map(), docasPorLoja = new Map();
    for (const r of ramais.rows) { const l = resolver(r.valor); if (l && !ramal.has(l.codigo)) ramal.set(l.codigo, r.ramal); }
    for (const d of docas.rows) { const l = resolver(d.loja); if (l && !docasPorLoja.has(l.codigo)) docasPorLoja.set(l.codigo, d); }
    const idx = {
      lojas: lojas.rows,
      resolver,
      ramal,
      docas: docasPorLoja,
      dist: new Map(dist.rows.map((r) => [`${r.origem}|${r.destino}`, Number(r.km)])),
      veiculos: new Map(veic.rows.map((r) => [normalizarPlaca(r.placa), r])),
      parametros: cfg.rows[0]?.valor || PARAMETROS_PADRAO,
    };
    _cache = { em: Date.now(), idx };
    return idx;
  } catch (err) {
    // Tabelas ainda nao criadas (importacao nunca rodou): segue sem enriquecer.
    if (!/does not exist|não existe/.test(err.message)) console.error("[lojas-pes] indice:", err.message);
    return null;
  }
}

function limparCacheIndice() { _cache = null; }

const r2 = (n) => Math.round(n * 100) / 100;

// Acrescenta aos objetos de viagem/parada (vindos do GET /tms/viagens):
//   parada: pes, emp, loja_oficial, km_fabrica, frete_calc, frete_tipo,
//           hora_prevista (so se vazia, do horario da loja) + hora_prevista_origem
//           frete_retorno_calc (= envio, modelo atual)
//   viagem: tipo_frete, tipo_frete_rotulo, tipo_frete_assumido, km_previsto_calc,
//           km_trechos_faltando, frete_calc_ida, frete_calc_retorno,
//           frete_calc_total (ida + retorno), frete_lojas_sem_preco
function enriquecerViagens(viagens, idx) {
  if (!idx) return viagens;
  const { ccd, cc } = idx.parametros;
  for (const v of viagens) {
    const veic = idx.veiculos.get(normalizarPlaca(v.placa));
    const tipo = (veic && veic.tipo_frete) || "2_EIXOS";
    v.tipo_frete = tipo;
    v.tipo_frete_rotulo = ROTULO_TIPO[tipo] || tipo;
    v.tipo_frete_assumido = !veic || !veic.tipo_frete || !!veic.tipo_frete_assumido;

    const paradas = [...(v.paradas || [])].sort((a, b) => (a.ordem || 0) - (b.ordem || 0) || a.id - b.id);
    let total = 0, semPreco = 0;
    for (const p of paradas) {
      const pesPlanilha = p.programacao && typeof p.programacao === "object" ? p.programacao.pes : null;
      const l = idx.resolver(p.loja_nome, pesPlanilha);
      p.loja_codigo_pes = l ? l.codigo : null;
      p.pes = l ? l.pes : null;
      p.emp = l ? l.emp : null;
      p.loja_oficial = l ? l.nome : null;
      // Para a capa da frente: celular (OI), ramal e regras de doca da loja.
      p.telefone = l ? l.telefone || null : null;
      p.ramal = l && idx.ramal ? idx.ramal.get(l.codigo) || null : null;
      const dk = l && idx.docas ? idx.docas.get(l.codigo) : null;
      p.docas = dk ? { carrinho_4: dk.carrinho_4_rodas, carrinho_2: dk.carrinho_2_rodas,
        sem_carrinho: dk.sem_carrinho_apos_horario, horario: dk.horario } : null;
      if (!p.hora_prevista && l && l.horario_loja) {
        p.hora_prevista = l.horario_loja;
        p.hora_prevista_origem = "cadastro";
      }
      const km = l ? idx.dist.get(`${FABRICA}|${l.codigo}`) : undefined;
      p.km_fabrica = km ?? null;
      p.frete_tipo = tipo;
      p.frete_calc = l && l.na_conta && km != null ? r2(km * ccd + cc[tipo]) : null;
      // Modelo vigente (operacao, 2026-10): frete de RETORNO = frete de ENVIO.
      p.frete_retorno_calc = p.frete_calc;
      if (l && !l.na_conta) p.frete_na_conta = false;
      if (p.frete_calc != null) total += p.frete_calc;
      else if (!(l && !l.na_conta)) semPreco += 1;
    }

    // km previsto: FABRICA -> 1a -> ... -> ultima -> FABRICA, na ordem das paradas.
    const pontos = [FABRICA, ...paradas.map((p) => p.loja_codigo_pes), FABRICA];
    let km = 0, faltando = 0;
    for (let i = 0; i + 1 < pontos.length; i += 1) {
      const a = pontos[i], b = pontos[i + 1];
      if (!a || !b) { faltando += 1; continue; }
      if (a === b) continue;
      // A planilha so tem o sentido da rota; viagem em outra ordem usa o
      // sentido contrario (a diferenca medida ida x volta e de poucos km).
      const d = idx.dist.get(`${a}|${b}`) ?? idx.dist.get(`${b}|${a}`);
      if (d == null) faltando += 1; else km += d;
    }
    v.km_previsto_calc = paradas.length ? r2(km) : null;
    v.km_trechos_faltando = paradas.length ? faltando : 0;
    // Total da viagem = ida + retorno (a mesma soma do "Σ Total" da aba CTEs).
    v.frete_calc_ida = total ? r2(total) : null;
    v.frete_calc_retorno = v.frete_calc_ida;
    v.frete_calc_total = total ? r2(total * 2) : null;
    v.frete_lojas_sem_preco = semPreco;
  }
  return viagens;
}

// ---------------------------------------------------------------- painel de custo
// Frete CALCULADO (ida + retorno) das viagens do periodo, para o Painel de
// Custo: totais, custo por km previsto e por volume ENTREGUE (registrado),
// e rankings por rota / motorista / loja.
async function custoFreteTms(q, dias) {
  const idx = await carregarIndice(q);
  if (!idx) return null;
  const v = await q.query(`
      SELECT id, motorista_nome, placa, rota_nome, to_char(data_viagem, 'YYYY-MM-DD') AS data_viagem
        FROM tms_viagens
       WHERE data_viagem >= CURRENT_DATE - ($1::int * INTERVAL '1 day') AND data_viagem <= CURRENT_DATE
         AND status <> 'Cancelada'`, [dias]);
  if (!v.rowCount) return { viagens: 0, total: 0, por_rota: [], por_motorista: [], por_loja: [] };
  const p = await q.query(`
      SELECT p.id, p.viagem_id, p.ordem, p.loja_nome, p.programacao, p.hora_prevista,
             COALESCE(o.volume_fisico, o.volume_gerencial) AS volume_entregue
        FROM tms_paradas p
        LEFT JOIN LATERAL (
            SELECT oc.volume_fisico, oc.volume_gerencial FROM ocorrencias oc
             WHERE (oc.id = p.ocorrencia_id OR oc.parada_id = p.id) AND oc.excluida_em IS NULL
             ORDER BY (oc.id = p.ocorrencia_id) DESC, oc.id DESC LIMIT 1) o ON TRUE
       WHERE p.viagem_id = ANY($1::int[])`, [v.rows.map((r) => r.id)]);
  const viagens = v.rows.map((x) => ({ ...x, paradas: p.rows.filter((y) => y.viagem_id === x.id) }));
  enriquecerViagens(viagens, idx);

  const grupos = { rota: new Map(), motorista: new Map(), loja: new Map() };
  const somar = (dim, chave, frete, volume, viagemId) => {
    const k = String(chave || "").trim() || "(sem)";
    const g = grupos[dim].get(k) || { chave: k, total: 0, volume: 0, freteComVolume: 0, viagens: new Set(), lojas: 0 };
    g.total += frete; g.volume += volume; g.lojas += 1; g.viagens.add(viagemId);
    if (volume > 0) g.freteComVolume += frete; // custo/volume so com volume registrado
    grupos[dim].set(k, g);
  };
  let total = 0, km = 0, volume = 0, freteComVolume = 0, comFrete = 0, estimadas = 0;
  for (const via of viagens) {
    if (!via.frete_calc_total) continue;
    comFrete += 1;
    if (via.tipo_frete_assumido) estimadas += 1;
    total += via.frete_calc_total;
    km += Number(via.km_previsto_calc) || 0;
    for (const par of via.paradas) {
      if (par.frete_calc == null) continue;
      const frete = par.frete_calc + (par.frete_retorno_calc || 0);
      const vol = Number(par.volume_entregue) || 0;
      volume += vol;
      if (vol > 0) freteComVolume += frete;
      somar("rota", via.rota_nome, frete, vol, via.id);
      somar("motorista", via.motorista_nome, frete, vol, via.id);
      somar("loja", par.loja_oficial || par.loja_nome, frete, vol, via.id);
    }
  }
  const ranking = (dim) => [...grupos[dim].values()]
    .map((g) => ({ chave: g.chave, total: r2(g.total), viagens: g.viagens.size, lojas: g.lojas,
      volume: g.volume, por_volume: g.volume ? r2(g.freteComVolume / g.volume) : null }))
    .sort((a, b) => b.total - a.total).slice(0, 12);
  return {
    viagens: v.rowCount, viagens_com_frete: comFrete, viagens_tipo_estimado: estimadas,
    total: r2(total), km_previsto: Math.round(km), volume_entregue: volume,
    por_km: km ? r2(total / km) : null, por_volume: volume ? r2(freteComVolume / volume) : null,
    medio_viagem: comFrete ? r2(total / comFrete) : null,
    por_rota: ranking("rota"), por_motorista: ranking("motorista"), por_loja: ranking("loja"),
  };
}

module.exports = {
  FABRICA, PARAMETROS_PADRAO, ROTULO_TIPO, custoFreteTms,
  garantirTabelas, lerPlanilhas, importar, criarResolvedor, carregarIndice, limparCacheIndice,
  enriquecerViagens, normalizarPlaca, tipoFretePorModelo, pastaExpedicao,
};
