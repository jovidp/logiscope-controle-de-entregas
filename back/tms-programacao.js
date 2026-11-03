// ================================================================
// tms-programacao.js  —  PLANILHA DE PROGRAMACAO + CHECKLIST EXPEDICAO -> TMS
// ----------------------------------------------------------------
// Cada viagem do dia nasce (ou e completada) juntando DUAS fontes, cada uma
// dona de uma parte da informacao:
//
//   PLANILHA de programacao (lida no navegador por tms-programacao-parser.js)
//     loja, PES, horario da loja, horario de saida, RT, CX,
//     motorista, ajudantes e placa
//   CHECKLIST EXPEDICAO (API, mesma integracao do "Importar do Checklist")
//     volume por loja e os materiais que vao para a loja: material de
//     campanha, sacolas P/M/G e as remessas (materiais, plastico bolha,
//     caixa azul, campanha, sacola)
//
// As colunas 434, 3386, ALMOXARIFADO, SACOLA (numero de pedido), CARGA WMS e
// FRETE da planilha sao DESCONSIDERADAS de proposito (decisao da operacao).
//
// Fluxo:
//   1. saneia os blocos que vieram do navegador (nao confiavel);
//   2. casa rota / motorista / placa / ajudantes / loja com os cadastros;
//   3. acha a viagem do MESMO DIA que ja representa o bloco (Checklist, manual
//      ou importacao anterior) e o CHECKLIST do dia que corresponde a ele;
//   4. planeja por bloco: CRIAR viagem nova ou ATUALIZAR a existente.
//
// Previa (POST /tms/programacao/previa) so planeja. Importacao
// (POST /tms/programacao/importar) replaneja dentro da transacao e grava tudo
// ou nada. Se a API do Checklist estiver fora, a importacao segue so com a
// planilha e a previa avisa que volumes/materiais nao vieram.
//
// Loja da planilha casa com a do checklist pelo nome canonico ou pelo PES. Loja
// que so esta no CHECKLIST tambem vira parada (no fim): a carga dela esta no
// caminhao. Checklist do dia sem rota na planilha aparece na previa como aviso.
//
// ATUALIZAR reconcilia as paradas pendentes com a planilha: transfere registros
// entre rotas, retira copias antigas e acompanha a ordem da programacao.
// Entregas, ocorrencias, CTe, pedidos e edicoes manuais permanecem preservados.
// Reimportar e seguro: o bloco reencontra a viagem pela chave gravada em
// tms_viagens.programacao->>'chave'.
// ================================================================

const fs = require('fs');
const path = require('path');
// Desde 2026-10 a programacao fica na sala "Expedição" do OnlyOffice DocSpace;
// a pasta de rede vira reserva (so se o OnlyOffice falhar ou nao estiver configurado).
const onlyoffice = require('./onlyoffice');
const { chaveLoja } = require('./normalizar-loja');
const { canonizarRota } = require('./normalizar-rota');
const reconciliacaoPlanilha = require('./tms-reconciliar-planilha');
const VERSAO_RECONCILIACAO = '1';

const MAX_BLOCOS = 60;
const MAX_PARADAS = 60;

// ── saneamento ──────────────────────────────────────────────────
function txt(v, limite = 120) {
    if (v === null || v === undefined) return null;
    const t = String(v).replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, limite) : null;
}

function horaValida(v) {
    const t = txt(v, 8);
    const m = t && t.match(/^(\d{2}):(\d{2})$/);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
    return `${m[1]}:${m[2]}`;
}

function inteiroValido(v, max = 100000) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > max) return null;
    return Math.round(n);
}

function dataValida(v) {
    const t = txt(v, 10);
    if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
    const d = new Date(`${t}T00:00:00Z`);
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t ? null : t;
}

function erroCliente(msg) {
    return Object.assign(new Error(msg), { statusCliente: 400 });
}

// So o que a operacao puxa da planilha. Qualquer outro campo que o navegador
// mande (docs, almoxarifado, sacola, wms, frete) e descartado aqui.
function sanearBlocos(blocos) {
    if (!Array.isArray(blocos) || blocos.length === 0) throw erroCliente('Nenhuma rota lida da planilha.');
    if (blocos.length > MAX_BLOCOS) throw erroCliente(`A planilha tem mais de ${MAX_BLOCOS} rotas.`);
    return blocos.map((b, indice) => {
        const paradasBrutas = Array.isArray(b?.paradas) ? b.paradas : [];
        if (paradasBrutas.length > MAX_PARADAS) throw erroCliente(`A rota ${indice + 1} tem mais de ${MAX_PARADAS} lojas.`);
        const ajudantes = (Array.isArray(b?.ajudantes) ? b.ajudantes : [])
            .map((a) => txt(a, 60)).filter(Boolean).slice(0, 10);
        const paradas = paradasBrutas.map((p) => ({
            atd: inteiroValido(p?.atd, 999),
            loja: txt(p?.loja, 80),
            pes: txt(p?.pes, 20),
            emp: txt(p?.emp, 20),
            hora_loja: horaValida(p?.hora_loja),
            rt: inteiroValido(p?.rt),
            cx: inteiroValido(p?.cx),
            linha: inteiroValido(p?.linha, 1000000),
        })).filter((p) => p.loja);
        return {
            indice,
            linha: inteiroValido(b?.linha, 1000000),
            rota: txt(b?.rota, 80),
            hora_saida: horaValida(b?.hora_saida),
            motorista: txt(b?.motorista, 80),
            ajudantes,
            placa: txt(b?.placa, 12),
            paradas,
        };
    });
}

// ── casamento de nomes ──────────────────────────────────────────
function semAcento(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function chavePessoa(s) {
    return semAcento(s).toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function chavePlaca(s) {
    return semAcento(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Chave de rota = canonica + letra do desdobramento: "Z. NORTE II (A)" e
// "Z.NORTE II (A)" casam; "(A)" e "(B)" sao viagens diferentes.
function chaveRota(nome) {
    const t = String(nome || '');
    if (!t.trim()) return '';
    const letra = (t.match(/\(\s*([A-Z0-9])\s*\)/i) || [])[1];
    // "SERRENA" e grafia do proprio cadastro; o canonizador so conhece SERRANA.
    const base = canonizarRota(t.replace(/SERRENA/gi, 'SERRANA'));
    return `${base}|${letra ? letra.toUpperCase() : ''}`;
}

function baseRota(chave) {
    return String(chave || '').split('|')[0];
}

function vazio(v) {
    const t = String(v ?? '').trim();
    return !t || /^selecione$/i.test(t) || /^mesm[oa] da original$/i.test(t);
}

//   exato      -> mesmo nome (ignorando acento/pontuacao)
//   aproximado -> um e o outro + sobrenome/inicial ("EDSON LEAL" x "EDSON"),
//                 so quando ha UM candidato
//   novo       -> fora do cadastro; grava como veio da planilha
function resolverPessoa(nome, lista) {
    const original = txt(nome, 80);
    if (!original) return null;
    const n = chavePessoa(original);
    const exato = lista.find((x) => chavePessoa(x) === n);
    if (exato) return { planilha: original, sistema: exato, como: 'exato' };
    const candidatos = lista.filter((x) => {
        const k = chavePessoa(x);
        return k && (n.startsWith(`${k} `) || k.startsWith(`${n} `));
    });
    if (candidatos.length === 1) return { planilha: original, sistema: candidatos[0], como: 'aproximado' };
    return { planilha: original, sistema: original.toUpperCase(), como: 'novo' };
}

// ── contexto do dia ─────────────────────────────────────────────
async function carregarContexto(q, data) {
    const cad = await q.query(
        `SELECT tipo, valor FROM cadastros
          WHERE NOT oculto AND tipo IN ('rota', 'motorista', 'placa', 'ajudante', 'loja')`);
    const porTipo = { rota: [], motorista: [], placa: [], ajudante: [], loja: [] };
    cad.rows.forEach((r) => porTipo[r.tipo] && porTipo[r.tipo].push(r.valor));

    const usoRotas = await q.query(
        `SELECT rota_nome, COUNT(*)::int AS n FROM tms_viagens
          WHERE rota_nome IS NOT NULL AND data_viagem >= CURRENT_DATE - 180
          GROUP BY rota_nome`);

    const fretes = await q.query('SELECT loja_nome, pes FROM tms_fretes_loja');

    const viagens = await q.query(`
        SELECT v.id, v.codigo, v.rota_nome, v.motorista_nome, v.placa, v.ajudantes, v.status,
               v.checklist_origem_id, v.importacao_chave, v.programacao,
               COALESCE(json_agg(json_build_object(
                   'id', p.id, 'ordem', p.ordem, 'loja_nome', p.loja_nome, 'status', p.status,
                   'pes', p.programacao->>'pes'
               ) ORDER BY p.ordem, p.id) FILTER (WHERE p.id IS NOT NULL), '[]') AS paradas
          FROM tms_viagens v
          LEFT JOIN tms_paradas p ON p.viagem_id = v.id
         WHERE v.data_viagem = $1::date
            OR (v.programacao ? 'edicao_manual' AND v.programacao->>'chave' LIKE $1::text || '|%')
         GROUP BY v.id
         ORDER BY v.id`, [data]);

    const uso = new Map(usoRotas.rows.map((r) => [r.rota_nome, r.n]));
    const rotasPorChave = new Map();
    const registrarRota = (nome, origem) => {
        const k = chaveRota(nome);
        if (!k || k === '|') return;
        const atual = rotasPorChave.get(k);
        const peso = (origem === 'cadastro' ? 1000000 : 0) + (uso.get(nome) || 0);
        if (!atual || peso > atual.peso) rotasPorChave.set(k, { nome, origem, peso });
    };
    porTipo.rota.forEach((r) => registrarRota(r, 'cadastro'));
    usoRotas.rows.forEach((r) => registrarRota(r.rota_nome, 'historico'));

    const lojasConhecidas = new Set();
    porTipo.loja.forEach((l) => lojasConhecidas.add(chaveLoja(l)));
    const lojaPorPes = new Map();
    // O inverso (loja -> PES) da o PES de parada antiga que nao o tem gravado
    // (veio do "Importar do Checklist" antes desta importacao existir).
    const pesPorChaveLoja = new Map();
    fretes.rows.forEach((f) => {
        lojasConhecidas.add(chaveLoja(f.loja_nome));
        if (f.pes) {
            lojaPorPes.set(String(f.pes).trim(), f.loja_nome);
            if (!pesPorChaveLoja.has(chaveLoja(f.loja_nome))) pesPorChaveLoja.set(chaveLoja(f.loja_nome), String(f.pes).trim());
        }
    });

    return {
        motoristas: porTipo.motorista,
        ajudantes: porTipo.ajudante,
        placas: new Map(porTipo.placa.map((p) => [chavePlaca(p), p])),
        rotasPorChave,
        lojasConhecidas,
        lojaPorPes,
        pesPorChaveLoja,
        viagens: viagens.rows,
    };
}

// Checklists do dia ja no formato de parada do TMS (mesmo mapeamento do
// "Importar do Checklist"). Falha da API nao derruba a importacao.
// Checklist cancelado nao conta (e refeito com outro numero): nunca casa, nunca sincroniza.
const checklistCancelado = (c) => /CANCEL/i.test(String(c?.status || ''));

// todosJaBaixados: a listagem ja lida neste ciclo (a sincronizacao roda 2 datas
// e a listagem e paginada; baixar 1 vez so).
async function carregarChecklists(data, deps, todosJaBaixados = null) {
    if (!deps || typeof deps.checklistListarTodos !== 'function') {
        return { lista: [], erro: 'Integração com o Checklist Expedição indisponível.' };
    }
    try {
        const todos = todosJaBaixados || await deps.checklistListarTodos();
        // Dia da ENTREGA manda: o checklist e carregado na vespera (load 29/09,
        // delivery 30/09). Aceitar a data de carga tambem puxava o checklist de
        // AMANHA para a programacao de hoje. Carga so vale quando nao ha entrega.
        const diaDoChecklist = (c) => String(c.delivery_date || c.loading_date || '').slice(0, 10);
        const doDia = todos.filter((c) => diaDoChecklist(c) === data && !checklistCancelado(c));
        const erros = [];
        const lidos = await Promise.all(doDia.map(async (c) => {
            try {
                const detalhe = await deps.checklistApi(`/api/checklists/${c.id}`);
                const m = deps.mapearChecklistParaViagem(detalhe, '');
                return {
                    id: detalhe.id || c.id,
                    status: detalhe.status || c.status || null,
                    rota: detalhe.route_name || c.route_name || null,
                    placa: detalhe.vehicle_plate || c.vehicle_plate || null,
                    cancelado: checklistCancelado(detalhe),
                    paradas: (m.paradas || []).map((p) => ({
                        ...p,
                        chave_loja: chaveLoja(p.loja),
                        pes: p.pes === null || p.pes === undefined || p.pes === '' ? null : String(p.pes).trim(),
                    })),
                };
            } catch (err) {
                erros.push(`#${c.id}: ${err.message}`);
                return null;
            }
        }));
        return {
            // O detalhe pode dizer CANCELADO mesmo quando a listagem ainda nao dizia.
            lista: lidos.filter((c) => c && !c.cancelado),
            erro: erros.length ? `Não consegui ler ${erros.length} checklist(s) do dia (${erros.join('; ')}).` : null,
        };
    } catch (err) {
        return { lista: [], erro: `Checklist Expedição fora do ar (${err.message}). Volumes e materiais não foram puxados agora; a sincronização automática completa as viagens quando o Checklist voltar (não use "Importar do Checklist", que criaria outra viagem para a mesma rota).` };
    }
}

function origemViagem(v) {
    if (v.programacao && v.programacao.chave) return 'programacao';
    if (v.checklist_origem_id) return 'checklist';
    if (v.importacao_chave) return 'pedidos';
    return 'manual';
}

function resumoViagem(v) {
    return {
        id: v.id,
        codigo: v.codigo,
        rota_nome: v.rota_nome,
        motorista_nome: v.motorista_nome,
        placa: v.placa,
        status: v.status,
        origem: origemViagem(v),
        edicao_manual: !!v.programacao?.edicao_manual,
        checklist_origem_id: v.checklist_origem_id || null,
        paradas: (v.paradas || []).length,
    };
}

// ── planejamento ────────────────────────────────────────────────
// rotasRepetidas: chaves de rota que aparecem em MAIS de um bloco da planilha.
function resolverBloco(b, ctx, data, chavesUsadas, rotasRepetidas) {
    const avisos = [];

    const kRota = chaveRota(b.rota);
    const rotaAchada = kRota ? ctx.rotasPorChave.get(kRota) : null;
    const rota = b.rota
        ? { planilha: b.rota, sistema: rotaAchada ? rotaAchada.nome : b.rota.toUpperCase(), como: rotaAchada ? rotaAchada.origem : 'novo' }
        : null;
    if (!rota) avisos.push('Rota sem nome na planilha.');
    else if (rota.como === 'novo') avisos.push(`Rota "${b.rota}" não está no cadastro; será gravada como escrita na planilha.`);

    let placa = null;
    if (b.placa) {
        const cadastrada = ctx.placas.get(chavePlaca(b.placa));
        placa = { planilha: b.placa, sistema: cadastrada || chavePlaca(b.placa), como: cadastrada ? 'exato' : 'novo' };
        if (!cadastrada) avisos.push(`Placa ${placa.sistema} não está no cadastro.`);
    } else {
        avisos.push('Sem placa na planilha.');
    }

    // Chave estavel do bloco (reimportar reencontra a mesma viagem). Rota que se
    // repete na planilha leva a PLACA na chave, nao a posicao: com "#2" por ordem,
    // trocar a ordem das linhas cruzava as duas viagens na reimportacao.
    let chave = `${data}|${kRota || `bloco-${b.indice + 1}`}`;
    if (kRota && rotasRepetidas.has(kRota)) {
        chave = `${chave}|${placa ? placa.sistema : `bloco-${b.indice + 1}`}`;
        avisos.push('Há outra rota com o mesmo nome nesta planilha; elas viram viagens separadas (a placa diferencia).');
    }
    if (chavesUsadas.has(chave)) {
        let n = 2;
        while (chavesUsadas.has(`${chave}#${n}`)) n += 1;
        chave = `${chave}#${n}`;
        avisos.push('Duas rotas com o mesmo nome e a mesma placa nesta planilha.');
    }
    chavesUsadas.add(chave);

    const motorista = resolverPessoa(b.motorista, ctx.motoristas);
    if (!motorista) avisos.push('Sem motorista na planilha.');
    else if (motorista.como === 'novo') avisos.push(`Motorista "${motorista.planilha}" não está no cadastro.`);

    const ajudantes = b.ajudantes.map((a) => resolverPessoa(a, ctx.ajudantes)).filter(Boolean);
    const ajudantesNovos = ajudantes.filter((a) => a.como === 'novo').map((a) => a.planilha);
    if (ajudantesNovos.length) avisos.push(`Ajudante(s) fora do cadastro: ${ajudantesNovos.join(', ')}.`);

    const paradas = b.paradas.map((p) => {
        let loja = p.loja;
        let lojaComo = 'ok';
        if (!ctx.lojasConhecidas.has(chaveLoja(p.loja))) {
            const pelaPes = p.pes ? ctx.lojaPorPes.get(p.pes) : null;
            if (pelaPes) {
                loja = pelaPes;
                lojaComo = 'pes';
                avisos.push(`Loja "${p.loja}" reconhecida pelo PES ${p.pes} como ${pelaPes}.`);
            } else {
                lojaComo = 'desconhecida';
                avisos.push(`Loja "${p.loja}" não encontrada no cadastro.`);
            }
        }
        return { ...p, loja_sistema: loja, loja_como: lojaComo, chave_loja: chaveLoja(loja), checklist: null };
    });

    const vistas = new Set();
    paradas.forEach((p) => {
        if (vistas.has(p.chave_loja)) avisos.push(`Loja ${p.loja_sistema} aparece duas vezes nesta rota.`);
        vistas.add(p.chave_loja);
    });

    return {
        indice: b.indice,
        linha: b.linha,
        chave,
        chave_rota: kRota,
        rota_repetida: !!(kRota && rotasRepetidas.has(kRota)),
        rota,
        motorista,
        placa,
        ajudantes,
        hora_saida: b.hora_saida,
        paradas,
        avisos,
    };
}

function somar(lista, campo) {
    const valores = lista.map((x) => x[campo]).filter((v) => v !== null && v !== undefined && v !== '');
    return valores.length ? valores.reduce((a, v) => a + (Number(v) || 0), 0) : null;
}

// Pontua o quanto uma viagem existente "e" aquele bloco da planilha.
function pontuarViagem(bloco, v) {
    const lojasViagem = new Set((v.paradas || []).map((p) => chaveLoja(p.loja_nome)));
    const comuns = bloco.paradas.filter((p) => lojasViagem.has(p.chave_loja)).length;
    const kViagem = chaveRota(v.rota_nome);
    const mesmaPlaca = !!bloco.placa && chavePlaca(v.placa) === chavePlaca(bloco.placa.sistema);
    // A edicao manual mantem o vinculo de origem mesmo quando troca TODAS as
    // lojas/equipe/rota; a planilha antiga nao pode criar uma copia da viagem.
    // Nas demais viagens ainda exigimos loja em comum ou mesma placa.
    const mesmaChave = !!(v.programacao && v.programacao.chave === bloco.chave)
        && (comuns > 0 || mesmaPlaca || !!v.programacao.edicao_manual);
    const mesmaRota = !!bloco.chave_rota && kViagem === bloco.chave_rota;
    const mesmaBase = !!bloco.chave_rota && baseRota(kViagem) === baseRota(bloco.chave_rota);
    const mesmoMotorista = !!bloco.motorista && !vazio(v.motorista_nome)
        && chavePessoa(v.motorista_nome) === chavePessoa(bloco.motorista.sistema);

    let pontos;
    if (bloco.rota_repetida) {
        // Rota que aparece em mais de um bloco (mesmo nome, caminhoes diferentes):
        // aqui as LOJAS decidem. Chave e placa so desempatam — se as placas forem
        // trocadas entre os dois caminhoes, as lojas continuam na viagem certa.
        pontos = comuns * 30 + (mesmaChave && comuns > 0 ? 10 : 0) + (mesmaPlaca ? 5 : 0) + (mesmoMotorista ? 5 : 0);
    } else {
        pontos = comuns * 2 + (mesmaChave ? 100 : 0) + (mesmaPlaca ? 20 : 0) + (mesmoMotorista ? 15 : 0);
    }
    if (mesmaRota) pontos += 50;
    else if (mesmaBase) pontos += 10;
    if (mesmaChave && v.programacao?.edicao_manual) pontos += MAX_PARADAS * 30 + 200;

    // Viagem cancelada nao e candidata: a rota pode ser recriada pela planilha.
    const aceita = v.status !== 'Cancelada'
        && (mesmaChave || mesmaRota || (comuns > 0 && (mesmaPlaca || mesmoMotorista || mesmaBase)));
    const motivo = mesmaChave ? 'importada antes desta planilha'
        : mesmaRota ? 'mesma rota'
            : [mesmaPlaca && 'mesma placa', mesmoMotorista && 'mesmo motorista', mesmaBase && 'mesma rota-base', comuns && `${comuns} loja(s) em comum`]
                .filter(Boolean).join(', ');
    return { pontos, aceita, motivo };
}

// A loja da planilha e a do checklist sao a MESMA loja quando o nome canonico
// bate OU o PES bate (o checklist traz o PES de cada loja; o nome as vezes vem
// com outra grafia, ex. ITAGUAI x ITAGUAI I).
function mesmaLoja(pPlanilha, pChecklist) {
    if (pPlanilha.chave_loja && pPlanilha.chave_loja === pChecklist.chave_loja) return true;
    return !!pPlanilha.pes && !!pChecklist.pes && String(pPlanilha.pes) === String(pChecklist.pes);
}

// Mesmo criterio para achar o checklist do bloco.
function pontuarChecklist(bloco, c) {
    const comuns = bloco.paradas.filter((p) => c.paradas.some((x) => mesmaLoja(p, x))).length;
    const kCk = chaveRota(c.rota);
    const mesmaRota = !!bloco.chave_rota && kCk === bloco.chave_rota;
    const mesmaBase = !!bloco.chave_rota && baseRota(kCk) === baseRota(bloco.chave_rota);
    const mesmaPlaca = !!bloco.placa && !!c.placa && chavePlaca(c.placa) === chavePlaca(bloco.placa.sistema);
    let pontos = comuns * 3;
    if (mesmaRota) pontos += 50;
    else if (mesmaBase) pontos += 10;
    if (mesmaPlaca) pontos += 20;
    // Sem rota nem placa iguais, as lojas em comum precisam cobrir a maior parte
    // do bloco E do checklist: 1 loja em comum num bloco pequeno puxava o
    // checklist inteiro de outra rota.
    const coberturaDupla = comuns * 2 >= bloco.paradas.length && comuns * 2 >= c.paradas.length;
    const forte = mesmaRota || mesmaPlaca;
    const aceita = comuns > 0 && (forte || (mesmaBase && coberturaDupla) || coberturaDupla);
    const motivo = [mesmaRota ? 'mesma rota' : mesmaBase && 'mesma rota-base', mesmaPlaca && 'mesma placa', `${comuns} loja(s) em comum`]
        .filter(Boolean).join(', ');
    // Rota "compativel" para o vinculo automatico da sincronizacao: a mesma rota,
    // ou a mesma rota-base quando o CHECKLIST nao usa letra de desdobramento (ele
    // escreve "Z. NORTE II" para o (A) e o (B)) — ai precisa confirmar pela placa
    // ou pela maioria das lojas. Placa sozinha, com rota diferente, nao vincula.
    const ckSemLetra = /\|$/.test(kCk);
    const rotaCompativel = mesmaRota || (mesmaBase && ckSemLetra && (mesmaPlaca || coberturaDupla));
    return { pontos, aceita, motivo, forte, mesmaRota, coberturaDupla, rotaCompativel };
}

// Casamento guloso: pares do mais forte para o mais fraco, cada lado uma vez.
function casarGuloso(planos, candidatos, pontuar, reservados = new Set(), pular = () => false) {
    const pares = [];
    planos.forEach((p) => {
        if (pular(p)) return;
        candidatos.forEach((c) => {
            if (reservados.has(c.id)) return;
            const s = pontuar(p, c);
            if (s.aceita) pares.push({ p, c, ...s });
        });
    });
    pares.sort((a, b) => b.pontos - a.pontos || a.p.indice - b.p.indice || a.c.id - b.c.id);
    const usados = new Set(reservados);
    const casados = new Map();
    pares.forEach((par) => {
        if (casados.has(par.p.indice) || usados.has(par.c.id)) return;
        usados.add(par.c.id);
        casados.set(par.p.indice, {
            id: par.c.id, motivo: par.motivo, forte: par.forte !== false,
            mesmaRota: !!par.mesmaRota, coberturaDupla: !!par.coberturaDupla, rotaCompativel: !!par.rotaCompativel,
        });
    });
    return { casados, usados };
}

// Liga cada loja do bloco a uma parada JA existente da viagem. Duas passadas:
// 1) pelo nome canonico da planilha; 2) para as que sobraram, pelo nome da loja
// no checklist casado (a parada que veio do "Importar do Checklist" tem esse
// nome, ex. ITAGUAÍ I quando a planilha escreve ITAGUAI) e pelo PES. Sem a 2a
// passada a loja casada pelo PES virava parada NOVA e a carga contava 2 vezes.
function cruzarParadasViagem(bloco, v, pesPorChaveLoja = new Map()) {
    const livres = (v.paradas || []).map((p) => {
        const chave = chaveLoja(p.loja_nome);
        return { ...p, chave, pes: p.pes ? String(p.pes) : (pesPorChaveLoja.get(chave) || null) };
    });
    const tomar = (i, p) => {
        const existente = livres.splice(i, 1)[0];
        p.destino = 'atualiza';
        p.parada_id = existente.id;
    };
    bloco.paradas.forEach((p) => { p.destino = null; p.parada_id = null; });
    bloco.paradas.forEach((p) => {
        const i = livres.findIndex((x) => x.chave === p.chave_loja);
        if (i >= 0) tomar(i, p);
    });
    bloco.paradas.forEach((p) => {
        if (p.destino) return;
        const chaveCk = p.checklist && p.checklist.chave_loja_checklist;
        let i = chaveCk ? livres.findIndex((x) => x.chave === chaveCk) : -1;
        if (i < 0 && p.pes) i = livres.findIndex((x) => x.pes && x.pes === String(p.pes));
        if (i >= 0) tomar(i, p);
        else p.destino = 'nova';
    });
    return livres.map((p) => p.loja_nome);
}

// Lista legivel do que o checklist manda para a loja (a previa mostra item a
// item: "ALMOXARIFADO: 1 MANEQ MASC (1) — carregado"). Sacola zerada nao entra.
function itensDoChecklist(remessas) {
    if (!remessas) return [];
    const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v) || 0);
    const limpo = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const out = [];
    (remessas.materiais || []).forEach((m) => out.push({
        tipo: 'Material', texto: `${limpo(m.setor) ? `${limpo(m.setor)}: ` : ''}${limpo(m.descricao) || '-'}`, quantidade: n(m.quantidade), carregado: !!m.carregado,
    }));
    (remessas.campanha || []).forEach((c) => out.push({
        tipo: 'Campanha', texto: limpo(c.campanha) || 'Material de campanha', quantidade: n(c.total), carregado: !!c.carregado,
    }));
    (remessas.caixa_azul || []).forEach((c) => out.push({
        tipo: 'Caixa azul', texto: 'Caixa azul vazia', quantidade: n(c.quantidade), carregado: !!c.carregado,
    }));
    (remessas.plastico_bolha || []).forEach((b) => out.push({
        tipo: 'Plástico bolha', texto: limpo(b.material) || 'Plástico bolha', quantidade: null, carregado: !!b.carregado,
    }));
    (remessas.sacolas || []).forEach((s) => {
        const total = n(s.total) || ((n(s.p) || 0) + (n(s.m) || 0) + (n(s.g) || 0));
        if (!total) return;
        out.push({ tipo: 'Sacola', texto: `Sacola P ${n(s.p) || 0} / M ${n(s.m) || 0} / G ${n(s.g) || 0}`, quantidade: total, carregado: !!s.carregado });
    });
    return out;
}

function dadosChecklistDaLoja(c) {
    return {
        volumes_previstos: c.volumes_previstos ?? null,
        material_campanha: c.material_campanha ?? null,
        sacola_p: c.sacola_p ?? null,
        sacola_m: c.sacola_m ?? null,
        sacola_g: c.sacola_g ?? null,
        sacola: (Number(c.sacola_p) || 0) + (Number(c.sacola_m) || 0) + (Number(c.sacola_g) || 0) || null,
        remessas: c.remessas || null,
        observacao: c.observacao || null,
        itens: itensDoChecklist(c.remessas),
        loja_checklist: c.loja,
        chave_loja_checklist: c.chave_loja,
    };
}

// Encosta em cada loja da planilha o volume/materiais do checklist casado.
// Loja que so esta no checklist VIRA PARADA no fim da viagem: a carga dela esta
// no caminhao, e deixa-la de fora sumiria com volume e itens da loja.
// lojasDeOutrosBlocos(c): true quando a planilha poe essa loja do checklist em
// OUTRA rota. A planilha e a dona da loja: ela nao volta como extra aqui.
// incluirExtras: so quando o checklist e desta rota com certeza (mesma rota,
// mesma placa ou checklist de origem da viagem).
function cruzarParadasChecklist(bloco, ck, lojaEmOutroBloco, incluirExtras) {
    const livres = ck.paradas.slice();
    const semChecklist = [];
    const casar = (p, i) => {
        const c = livres.splice(i, 1)[0];
        p.checklist = dadosChecklistDaLoja(c);
        if (c.chave_loja !== p.chave_loja) p.checklist.casada_por = `PES ${c.pes} (no checklist: ${c.loja})`;
    };
    // 1a passada: TODAS as lojas pelo nome. 2a: as que sobraram pelo PES.
    // Numa passada so, uma loja anterior com PES errado roubava o checklist de
    // uma loja posterior que casaria pelo nome.
    bloco.paradas.forEach((p) => {
        const i = livres.findIndex((c) => c.chave_loja === p.chave_loja);
        if (i >= 0) casar(p, i);
    });
    bloco.paradas.forEach((p) => {
        if (p.checklist) return;
        const i = livres.findIndex((c) => mesmaLoja(p, c));
        if (i >= 0) casar(p, i);
        else semChecklist.push(p.loja_sistema);
    });
    const movidas = [];
    const naoEntram = [];
    const restantes = livres.filter((c) => {
        const outro = lojaEmOutroBloco(c);
        if (outro) { movidas.push({ loja: c.loja, rota: outro }); return false; }
        if (!incluirExtras) { naoEntram.push(c.loja); return false; }
        return true;
    });
    const extras = restantes.map((c) => ({
        atd: null,
        loja: c.loja,
        pes: c.pes || null,
        emp: null,
        hora_loja: null,
        rt: null,
        cx: null,
        linha: null,
        loja_sistema: c.loja,
        loja_como: 'checklist',
        chave_loja: c.chave_loja,
        origem: 'checklist',
        checklist: dadosChecklistDaLoja(c),
    }));
    return { semChecklist, extras, movidas, naoEntram };
}

function divergenciasCabecalho(bloco, v) {
    const out = [];
    if (bloco.motorista && !vazio(v.motorista_nome)
        && chavePessoa(v.motorista_nome) !== chavePessoa(bloco.motorista.sistema)) {
        out.push(`Motorista: viagem tinha ${v.motorista_nome}, vai ficar ${bloco.motorista.sistema} (da planilha).`);
    }
    if (bloco.placa && !vazio(v.placa) && chavePlaca(v.placa) !== chavePlaca(bloco.placa.sistema)) {
        out.push(`Placa: viagem tinha ${v.placa}, vai ficar ${bloco.placa.sistema} (da planilha).`);
    }
    const ajPlanilha = bloco.ajudantes.map((a) => chavePessoa(a.sistema)).sort().join('|');
    const ajViagem = String(v.ajudantes || '').split(/\s*,\s*/).filter(Boolean).map(chavePessoa).sort().join('|');
    if (ajPlanilha && ajViagem && ajPlanilha !== ajViagem) {
        out.push(`Ajudantes: viagem tinha ${v.ajudantes}, vão ficar ${bloco.ajudantes.map((a) => a.sistema).join(', ')} (da planilha).`);
    }
    return out;
}

// escolhas: [{ indice, acao: 'criar'|'atualizar'|'ignorar', alvo_id }]
async function planejar(q, payload, escolhasBrutas = [], deps = {}) {
    const data = dataValida(payload?.data_viagem);
    if (!data) throw erroCliente('Informe a data da viagem (AAAA-MM-DD).');
    const blocos = sanearBlocos(payload?.blocos);
    const [ctx, cks] = await Promise.all([carregarContexto(q, data), carregarChecklists(data, deps)]);

    const escolhas = new Map();
    (Array.isArray(escolhasBrutas) ? escolhasBrutas : []).forEach((e) => {
        const indice = Number(e?.indice);
        if (Number.isInteger(indice)) escolhas.set(indice, { acao: String(e?.acao || ''), alvo_id: Number(e?.alvo_id) || null });
    });

    const contagemRotas = new Map();
    blocos.forEach((b) => {
        const k = chaveRota(b.rota);
        if (k) contagemRotas.set(k, (contagemRotas.get(k) || 0) + 1);
    });
    const rotasRepetidas = new Set([...contagemRotas].filter(([, n]) => n > 1).map(([k]) => k));
    const chavesUsadas = new Set();
    const planos = blocos.map((b) => resolverBloco(b, ctx, data, chavesUsadas, rotasRepetidas));
    const viagemPorId = new Map(ctx.viagens.map((v) => [v.id, v]));

    // Alvos escolhidos a mao reservam a viagem antes do casamento automatico.
    const reservadas = new Set();
    planos.forEach((p) => {
        const e = escolhas.get(p.indice);
        if (e && e.acao === 'atualizar' && e.alvo_id) {
            if (!viagemPorId.has(e.alvo_id)) throw erroCliente(`A viagem escolhida para a rota ${p.rota?.planilha || p.indice + 1} não é deste dia.`);
            if (reservadas.has(e.alvo_id)) throw erroCliente('A mesma viagem foi escolhida para duas rotas da planilha.');
            reservadas.add(e.alvo_id);
            p.alvo_manual = e.alvo_id;
        }
    });

    // "Criar" explicito para uma rota que ja foi importada neste dia duplicaria
    // a viagem inteira (acontecia com previa velha: outra aba/usuario importou
    // no meio tempo). Recusa e pede previa nova. Nao vale para viagem Cancelada
    // (recriar a rota e legitimo) nem para viagem que outra rota da planilha
    // ja pegou por escolha manual.
    planos.forEach((p) => {
        const e = escolhas.get(p.indice);
        if (!e || e.acao !== 'criar') return;
        const ja = ctx.viagens.find((v) => v.programacao && v.programacao.chave === p.chave
            && v.status !== 'Cancelada' && !reservadas.has(v.id) && pontuarViagem(p, v).aceita);
        if (ja) throw erroCliente(`A rota ${p.rota?.sistema || p.indice + 1} já foi importada como ${ja.codigo}. Abra a prévia de novo e escolha "Atualizar".`);
    });
    const auto = casarGuloso(planos, ctx.viagens, pontuarViagem, reservadas, (p) => !!p.alvo_manual);

    planos.forEach((p) => {
        const e = escolhas.get(p.indice);
        const alvoId = p.alvo_manual || auto.casados.get(p.indice)?.id || null;
        const v = alvoId ? viagemPorId.get(alvoId) : null;
        p.sugestao = v
            ? { acao: 'atualizar', alvo_id: v.id, motivo: p.alvo_manual ? 'escolhida por você' : auto.casados.get(p.indice).motivo }
            : { acao: 'criar', alvo_id: null, motivo: 'nenhuma viagem deste dia bate com esta rota' };

        let acao = e && ['criar', 'atualizar', 'ignorar'].includes(e.acao) ? e.acao : p.sugestao.acao;
        if (acao === 'atualizar' && !v) acao = 'criar';
        p.acao = acao;
        p.alvo = acao === 'atualizar' && v ? resumoViagem(v) : null;
        p._viagem = p.alvo ? v : null;

        p.divergencias = [];
        if (p.alvo) {
            p.divergencias = divergenciasCabecalho(p, v);
            if (v.programacao?.edicao_manual) p.avisos.push(`A viagem ${v.codigo} foi editada no TMS; o planejamento manual será preservado.`);
            // Troca de motorista/placa nunca e "tudo verde" (a tela usa este flag).
            p.troca_equipe = p.divergencias.some((d) => /^(Motorista|Placa):/.test(d));
            if (['Finalizada', 'Cancelada'].includes(v.status)) p.avisos.push(`A viagem ${v.codigo} está ${v.status}.`);
            else if (p.troca_equipe && !['Planejada', 'Carregando'].includes(v.status)) {
                p.avisos.push(`A viagem ${v.codigo} já está "${v.status}": a planilha vai trocar motorista/placa de um caminhão que já saiu. Confira antes de importar.`);
            }
        } else {
            if (acao === 'criar' && v) {
                p.avisos.push(`A viagem ${v.codigo} parece ser esta rota (${p.sugestao.motivo}); criar outra pode duplicar.`);
            } else if (acao === 'criar') {
                const mesmaRota = ctx.viagens.filter((x) => p.chave_rota && chaveRota(x.rota_nome) === p.chave_rota && !auto.usados.has(x.id));
                if (mesmaRota.length) p.avisos.push(`Já existe viagem desta rota no dia (${mesmaRota.map((x) => x.codigo).join(', ')}); confira se não é a mesma.`);
            }
        }
    });

    // Checklist de cada bloco: primeiro o que a viagem-alvo ja veio (checklist_origem_id),
    // depois casamento por rota/placa/lojas entre os que sobraram.
    const ckPorId = new Map(cks.lista.map((c) => [c.id, c]));
    const ckReservados = new Set();
    planos.forEach((p) => {
        const id = p._viagem && p._viagem.checklist_origem_id;
        if (id && ckPorId.has(id) && !ckReservados.has(id)) {
            ckReservados.add(id);
            p._ck = { id, motivo: 'checklist de origem da viagem', forte: true };
        }
    });
    // Checklist que ja e de OUTRA viagem do dia (que nenhum bloco vai atualizar)
    // fica fora do casamento: dar a carga dele a um bloco novo contava os mesmos
    // volumes duas vezes no dia.
    // So entram checklists DESTE dia (ckPorId): viagem apontando para checklist de
    // outro dia/apagado derrubava a previa com 500 mais abaixo.
    const donoDoChecklist = new Map();
    ctx.viagens.forEach((v) => {
        const id = v.checklist_origem_id;
        if (id && ckPorId.has(id) && !ckReservados.has(id) && v.status !== 'Cancelada') donoDoChecklist.set(id, v);
    });
    const ckBloqueados = new Set([...ckReservados, ...donoDoChecklist.keys()]);

    // Onde a PLANILHA pos cada loja (nome canonico e PES -> bloco).
    const lojaNoBloco = new Map();
    planos.forEach((p) => p.paradas.forEach((x) => {
        if (x.chave_loja && !lojaNoBloco.has(`n:${x.chave_loja}`)) lojaNoBloco.set(`n:${x.chave_loja}`, p);
        if (x.pes && !lojaNoBloco.has(`p:${x.pes}`)) lojaNoBloco.set(`p:${x.pes}`, p);
    }));
    // Chave = o PROPRIO bloco (nao o nome da rota): com rota repetida os dois
    // blocos tem o mesmo nome e os avisos se misturavam.
    const movidasPorBloco = new Map();
    const rotulo = (b) => `${b.rota?.sistema || `rota ${b.indice + 1}`}${b.rota_repetida && b.placa ? ` (${b.placa.sistema})` : ''}`;

    // Blocos "ignorar" tambem casam: assim o checklist deles nao aparece como
    // "sem rota na planilha" so porque o usuario decidiu nao importar a rota.
    const ckAuto = casarGuloso(planos, cks.lista, pontuarChecklist, ckBloqueados, (p) => !!p._ck);
    // Checklist que ja tem viagem no dia nao e "sem rota": ele esta no TMS.
    const checklistsUsados = new Set(donoDoChecklist.keys());
    planos.forEach((p) => {
        const achado = p._ck || ckAuto.casados.get(p.indice) || null;
        const ck = achado ? ckPorId.get(achado.id) : null;
        p.checklist = ck ? { id: ck.id, status: ck.status, rota: ck.rota, placa: ck.placa, motivo: achado.motivo } : null;
        p.lojas_sem_checklist = [];
        p.lojas_so_no_checklist = [];
        if (ck) {
            checklistsUsados.add(ck.id);
            const emOutroBloco = (c) => {
                const outro = lojaNoBloco.get(`n:${c.chave_loja}`) || (c.pes ? lojaNoBloco.get(`p:${c.pes}`) : null);
                return outro && outro !== p ? outro : null;
            };
            const r = cruzarParadasChecklist(p, ck, emOutroBloco, !!achado.forte);
            p.lojas_sem_checklist = r.semChecklist;
            p.lojas_so_no_checklist = r.extras.map((x) => x.loja_sistema);
            r.extras.forEach((x) => { x.ordem = p.paradas.length + 1; p.paradas.push(x); });
            r.movidas.forEach((m) => {
                p.avisos.push(`${m.loja} está no checklist #${ck.id} desta rota, mas a planilha põe em ${rotulo(m.rota)}: fica onde a planilha manda.`);
                const lista = movidasPorBloco.get(m.rota) || [];
                lista.push(`${m.loja} (carregada no checklist #${ck.id}, rota ${rotulo(p)})`);
                movidasPorBloco.set(m.rota, lista);
            });
            if (r.naoEntram.length) {
                p.avisos.push(`O checklist #${ck.id} tem loja(s) fora da planilha que NÃO entram, porque o casamento foi só por lojas em comum: ${r.naoEntram.join(', ')}.`);
            }
            if (ck.placa && p.placa && chavePlaca(ck.placa) !== chavePlaca(p.placa.sistema)) {
                p.avisos.push(`Checklist #${ck.id} foi carregado na placa ${ck.placa}; a planilha diz ${p.placa.sistema}.`);
            }
        } else if (p.acao !== 'ignorar' && !cks.erro) {
            const deOutra = [...donoDoChecklist.entries()].find(([id]) => {
                const c = ckPorId.get(id);
                return c && pontuarChecklist(p, c).aceita;
            });
            p.avisos.push(deOutra
                ? `O checklist #${deOutra[0]} desta rota já é da viagem ${deOutra[1].codigo}: para não contar a carga duas vezes, esta rota fica sem volumes. Se for a mesma viagem, escolha "Atualizar ${deOutra[1].codigo}".`
                : 'Nenhum checklist de expedição deste dia bate com esta rota: volumes e materiais ficam em branco.');
        }

        // So agora (com as lojas extras do checklist) cruza com a viagem existente.
        p.lojas_so_na_viagem = [];
        if (p.alvo) {
            p.lojas_so_na_viagem = cruzarParadasViagem(p, p._viagem, ctx.pesPorChaveLoja);
        } else {
            p.paradas.forEach((x) => { x.destino = p.acao === 'criar' ? 'nova' : 'ignorada'; x.parada_id = null; });
        }
        p.totais = {
            lojas: p.paradas.length,
            cx: somar(p.paradas, 'cx'),
            rt: somar(p.paradas, 'rt'),
            volumes: somar(p.paradas.map((x) => x.checklist || {}), 'volumes_previstos'),
            material_campanha: somar(p.paradas.map((x) => x.checklist || {}), 'material_campanha'),
            sacolas: somar(p.paradas.map((x) => x.checklist || {}), 'sacola'),
        };
        delete p._ck;
    });
    planos.forEach((p) => {
        const movidas = movidasPorBloco.get(p);
        if (movidas && movidas.length) p.avisos.push(`A planilha trouxe para esta rota loja(s) que foram carregadas em outro caminhão: ${movidas.join('; ')}.`);
    });

    const blocosPublicos = planos.map((p) => {
        const { _viagem, alvo_manual, ...resto } = p;
        return resto;
    });
    return {
        data_viagem: data,
        checklist_erro: cks.erro,
        checklists_do_dia: cks.lista.map((c) => ({ id: c.id, status: c.status, rota: c.rota, placa: c.placa, lojas: c.paradas.length })),
        // Carga expedida para o dia que nao bateu com nenhuma rota da planilha.
        checklists_sem_rota: cks.lista.filter((c) => !checklistsUsados.has(c.id)).map((c) => ({
            id: c.id,
            status: c.status,
            rota: c.rota,
            placa: c.placa,
            lojas: c.paradas.map((x) => x.loja),
            volumes: c.paradas.reduce((s, x) => s + (Number(x.volumes_previstos) || 0), 0),
        })),
        blocos: blocosPublicos,
        viagens_do_dia: ctx.viagens.map(resumoViagem),
    };
}

// ── gravacao ────────────────────────────────────────────────────
function jsonViagem(p, payload, usuario) {
    return {
        fonte: 'planilha',
        chave: p.chave,
        arquivo: txt(payload?.arquivo, 200),
        aba: txt(payload?.aba, 120),
        linha: p.linha,
        importado_em: new Date().toISOString(),
        importado_por: usuario?.nome || null,
        rota_planilha: p.rota?.planilha || null,
        motorista_planilha: p.motorista?.planilha || null,
        placa_planilha: p.placa?.planilha || null,
        ajudantes_planilha: p.ajudantes.map((a) => a.planilha),
        hora_saida: p.hora_saida,
        checklist_id: p.checklist?.id || null,
        checklist_status: p.checklist?.status || null,
    };
}

function jsonParada(x) {
    return {
        origem: x.origem === 'checklist' ? 'checklist' : 'planilha',
        atd: x.atd,
        pes: x.pes,
        emp: x.emp,
        loja_planilha: x.origem === 'checklist' ? null : x.loja,
        rt: x.rt,
        cx: x.cx,
        linha: x.linha,
        checklist: !!x.checklist,
    };
}

// checklist_origem_id tem indice UNICO: so grava se nenhuma outra viagem ja o usa.
async function checklistLivre(client, checklistId, viagemId) {
    if (!checklistId) return null;
    const r = await client.query(
        'SELECT 1 FROM tms_viagens WHERE checklist_origem_id = $1 AND id IS DISTINCT FROM $2', [checklistId, viagemId]);
    return r.rowCount ? null : checklistId;
}

async function inserirParada(client, viagemId, ordem, x) {
    const c = x.checklist || {};
    await client.query(`
        INSERT INTO tms_paradas (
            viagem_id, ordem, loja_nome, hora_prevista, retirada_cx, retirada_rt,
            volumes_previstos, material_campanha, sacola, sacola_p, sacola_m, sacola_g,
            remessas, observacao, programacao
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15::jsonb)`,
    [viagemId, ordem, x.loja_sistema, x.hora_loja, x.cx ?? 0, x.rt ?? 0,
        c.volumes_previstos ?? null, c.material_campanha ?? null, c.sacola ?? null,
        c.sacola_p ?? null, c.sacola_m ?? null, c.sacola_g ?? null,
        c.remessas ? JSON.stringify(c.remessas) : null, c.observacao ?? null,
        JSON.stringify(jsonParada(x))]);
}

// Totais do cabecalho = soma das paradas (mesma regra do formulario do TMS).
async function recalcularTotaisViagem(client, viagemId) {
    await client.query(`
        UPDATE tms_viagens v SET
            volumes_previstos = s.vol, material_campanha = s.mat,
            sacola_p = s.sp, sacola_m = s.sm, sacola_g = s.sg, sacola = s.sac
          FROM (SELECT NULLIF(SUM(COALESCE(volumes_previstos, 0)), 0)::int AS vol,
                       NULLIF(SUM(COALESCE(material_campanha, 0)), 0)::int AS mat,
                       NULLIF(SUM(COALESCE(sacola_p, 0)), 0)::int AS sp,
                       NULLIF(SUM(COALESCE(sacola_m, 0)), 0)::int AS sm,
                       NULLIF(SUM(COALESCE(sacola_g, 0)), 0)::int AS sg,
                       NULLIF(SUM(COALESCE(sacola, 0)), 0)::int AS sac
                  FROM tms_paradas WHERE viagem_id = $1) s
         WHERE v.id = $1`, [viagemId]);
}

function observacaoOrigem(p, payload) {
    const arq = txt(payload?.arquivo, 120);
    return `Importado da programação${arq ? ` (${arq})` : ''}${p.checklist ? ` + Checklist Expedicao #${p.checklist.id}` : ''}`;
}

async function criarViagem(client, p, payload, usuario, data) {
    const ajudantes = p.ajudantes.map((a) => a.sistema).join(', ') || null;
    const ins = await client.query(`
        INSERT INTO tms_viagens (
            data_viagem, motorista_nome, placa, rota_nome, ajudantes,
            hora_saida_fabrica, status, observacao, programacao
        ) VALUES ($1, $2, $3, $4, $5, $6, 'Planejada', $7, $8::jsonb)
        RETURNING id`, [
        data,
        p.motorista?.sistema || null,
        p.placa?.sistema || null,
        p.rota?.sistema || null,
        ajudantes,
        p.hora_saida,
        observacaoOrigem(p, payload),
        JSON.stringify(jsonViagem(p, payload, usuario)),
    ]);
    const id = ins.rows[0].id;
    const codigo = `V-${data.replaceAll('-', '')}-${String(id).padStart(5, '0')}`;
    const ck = await checklistLivre(client, p.checklist?.id, id);
    await client.query('UPDATE tms_viagens SET codigo = $1, checklist_origem_id = $2 WHERE id = $3', [codigo, ck, id]);
    let ordem = 0;
    for (const x of p.paradas) {
        ordem += 1;
        await inserirParada(client, id, ordem, x);
    }
    await recalcularTotaisViagem(client, id);
    return { viagem_id: id, codigo, paradas_novas: p.paradas.length, paradas_atualizadas: 0, checklist_id: p.checklist?.id || null };
}

async function atualizarViagem(client, p, payload, usuario, opcoes = {}) {
    const atual = (await client.query('SELECT * FROM tms_viagens WHERE id = $1 FOR UPDATE', [p.alvo.id])).rows[0];
    if (!atual) throw new Error(`A viagem ${p.alvo.codigo} não existe mais.`);
    // Revalidar sob a mesma trava do formulario: a edicao pode ter sido salva
    // depois da previa. Planilha/Checklist nao substituem o planejamento manual.
    if (atual.programacao?.edicao_manual) {
        return { motivo: `${atual.codigo}: planejamento salvo manualmente no TMS.` };
    }
    if (opcoes.automatica && ['Finalizada', 'Cancelada'].includes(atual.status)) {
        return { motivo: `${atual.codigo}: histórico preservado (${atual.status}).` };
    }
    const trocaEquipe = (p.motorista?.sistema && atual.motorista_nome && chavePessoa(p.motorista.sistema) !== chavePessoa(atual.motorista_nome))
        || (p.placa?.sistema && atual.placa && chavePlaca(p.placa.sistema) !== chavePlaca(atual.placa));
    if (opcoes.automatica && trocaEquipe && !['Planejada', 'Carregando', 'Liberada'].includes(atual.status)) {
        return { motivo: `${atual.codigo}: confira a troca de motorista/placa de uma viagem que já saiu.` };
    }
    const ajudantes = p.ajudantes.map((a) => a.sistema).join(', ');
    // O vinculo acompanha o checklist que a carga veio agora (se ninguem mais o
    // usa). Sem checklist nesta importacao (API fora), fica o que ja estava.
    const ck = (p.checklist?.id ? await checklistLivre(client, p.checklist.id, atual.id) : null)
        || atual.checklist_origem_id || null;
    // Rascunho da propria planilha ainda sem saida acompanha campos apagados
    // (equipe transferida para outra rota). Viagem que ja saiu conserva a equipe.
    const limparPlanejada = atual.programacao?.fonte === 'planilha'
        && ['Planejada', 'Carregando'].includes(atual.status) && !atual.saida_real;
    await client.query(`
        UPDATE tms_viagens SET
            hora_saida_fabrica = CASE WHEN $8 THEN $2 ELSE COALESCE($2, hora_saida_fabrica) END,
            motorista_nome = CASE WHEN $8 THEN $3 ELSE COALESCE($3, motorista_nome) END,
            placa = CASE WHEN $8 THEN $4 ELSE COALESCE($4, placa) END,
            ajudantes = CASE WHEN $8 THEN $5 ELSE COALESCE($5, ajudantes) END,
            rota_nome = COALESCE($9, rota_nome),
            checklist_origem_id = $6,
            programacao = $7::jsonb,
            atualizado_em = NOW()
        WHERE id = $1`, [
        atual.id,
        p.hora_saida,
        p.motorista?.sistema || null,
        p.placa?.sistema || null,
        ajudantes || null,
        ck || null,
        // Checklist fora do ar nesta importacao: mantem o vinculo que a viagem ja
        // tinha, senao o card passava a dizer "sem checklist" numa viagem com checklist.
        JSON.stringify({
            ...atual.programacao,
            ...jsonViagem(p, payload, usuario),
            checklist_id: p.checklist?.id || atual.checklist_origem_id || atual.programacao?.checklist_id || null,
            checklist_status: p.checklist?.status || atual.programacao?.checklist_status || null,
        }),
        limparPlanejada,
        p.rota?.sistema || null,
    ]);

    const maxOrdem = (await client.query('SELECT COALESCE(MAX(ordem), 0)::int AS m FROM tms_paradas WHERE viagem_id = $1', [atual.id])).rows[0].m;
    let proxima = maxOrdem;
    let atualizadas = 0;
    let novas = 0;
    for (const x of p.paradas) {
        if (x.destino === 'atualiza' && x.parada_id) {
            const c = x.checklist;
            const r = await client.query(`
                UPDATE tms_paradas SET
                    hora_prevista = COALESCE($3, hora_prevista),
                    retirada_cx = COALESCE($4, retirada_cx),
                    retirada_rt = COALESCE($5, retirada_rt),
                    programacao = CASE WHEN $7 THEN $6::jsonb
                        ELSE $6::jsonb || jsonb_build_object('checklist', COALESCE((programacao->>'checklist')::boolean, false)) END,
                    volumes_previstos = CASE WHEN $7 THEN $8 ELSE volumes_previstos END,
                    material_campanha = CASE WHEN $7 THEN $9 ELSE material_campanha END,
                    sacola = CASE WHEN $7 THEN $10 ELSE sacola END,
                    sacola_p = CASE WHEN $7 THEN $11 ELSE sacola_p END,
                    sacola_m = CASE WHEN $7 THEN $12 ELSE sacola_m END,
                    sacola_g = CASE WHEN $7 THEN $13 ELSE sacola_g END,
                    remessas = CASE WHEN $7 THEN $14::jsonb ELSE remessas END,
                    observacao = COALESCE(observacao, $15),
                    atualizado_em = NOW()
                WHERE id = $1 AND viagem_id = $2 AND ocorrencia_id IS NULL
                  AND COALESCE(status, 'Pendente') IN ('Pendente', 'Em atendimento')
                  AND NOT EXISTS (SELECT 1 FROM ocorrencias o WHERE o.parada_id=tms_paradas.id AND o.excluida_em IS NULL)`,
            [x.parada_id, atual.id, x.hora_loja, x.cx, x.rt, JSON.stringify(jsonParada(x)),
                !!c, c?.volumes_previstos ?? null, c?.material_campanha ?? null, c?.sacola ?? null,
                c?.sacola_p ?? null, c?.sacola_m ?? null, c?.sacola_g ?? null,
                c?.remessas ? JSON.stringify(c.remessas) : null, c?.observacao ?? null]);
            atualizadas += r.rowCount;
        } else {
            proxima += 1;
            await inserirParada(client, atual.id, proxima, x);
            novas += 1;
        }
    }
    if (p.checklist) await recalcularTotaisViagem(client, atual.id);
    return { viagem_id: atual.id, codigo: atual.codigo, paradas_novas: novas, paradas_atualizadas: atualizadas, checklist_id: p.checklist?.id || ck || null };
}

// opcoes.pular(p) -> motivo (string) para NAO aplicar aquele bloco; usado pela
// sincronizacao automatica da planilha, que decide sobre o MESMO plano gravado.
async function importar(client, payload, escolhas, usuario, deps = {}, opcoes = {}) {
    // Uma importacao por vez: dois cliques juntos criariam a mesma viagem duas vezes.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('tms_programacao_importar'))");
    const plano = await planejar(client, payload, escolhas, deps);
    // opcoes.validarPlano(plano) -> lista de pendencias; qualquer uma aborta TUDO
    // antes de gravar (importacao automatica do dia so entra "toda verde").
    if (typeof opcoes.validarPlano === 'function') {
        const pendencias = opcoes.validarPlano(plano) || [];
        if (pendencias.length) throw Object.assign(new Error('Plano com pendências.'), { pendencias });
    }
    const resultado = {
        data_viagem: plano.data_viagem, checklist_erro: plano.checklist_erro,
        criadas: [], atualizadas: [], ignoradas: [], puladas: [],
        // chave de cada bloco (a sincronizacao guarda o que foi aplicado por chave).
        blocos: plano.blocos.map((p) => ({ indice: p.indice, chave: p.chave, acao: p.acao, rota: p.rota?.sistema || null })),
    };
    const antes = await reconciliacaoPlanilha.snapshot(client, plano.data_viagem);
    for (const p of plano.blocos) {
        const rotulo = p.rota?.sistema || `rota ${p.indice + 1}`;
        if (p.acao === 'ignorar' || p.paradas.length === 0) {
            resultado.ignoradas.push({ indice: p.indice, rota: rotulo, chave: p.chave });
            continue;
        }
        const motivo = typeof opcoes.pular === 'function' ? opcoes.pular(p) : null;
        if (motivo) {
            resultado.puladas.push({ indice: p.indice, rota: rotulo, chave: p.chave, motivo });
            continue;
        }
        const feito = p.acao === 'atualizar'
            ? await atualizarViagem(client, p, payload, usuario, opcoes)
            : await criarViagem(client, p, payload, usuario, plano.data_viagem);
        if (feito.motivo) {
            resultado.puladas.push({ indice: p.indice, rota: rotulo, chave: p.chave, motivo: feito.motivo });
            continue;
        }
        if (deps.preencherLojaIdDaViagem) await deps.preencherLojaIdDaViagem(client, feito.viagem_id);
        (p.acao === 'atualizar' ? resultado.atualizadas : resultado.criadas).push({
            indice: p.indice, rota: rotulo, chave: p.chave, lojas_so_na_viagem: p.lojas_so_na_viagem || [], ...feito,
        });
    }
    await reconciliacaoPlanilha.reconciliar(client, plano, resultado, antes);
    return resultado;
}

// ── sincronizacao automatica com o Checklist ────────────────────
// A cada TMS_SYNC_CHECKLIST_MIN minutos (padrao 5; 0 desliga) as viagens de HOJE
// e de AMANHA recebem do Checklist o que ele e dono: volume e materiais por loja
// (material de campanha, sacolas, remessas com o carregado ✅/⏳). Acaba com o
// "reimportar quando o Checklist mudar ou voltar do ar".
//   - viagem com checklist_origem_id: sincroniza com ele;
//   - viagem da PLANILHA ainda sem checklist (API estava fora na importacao):
//     ganha o checklist do dia da MESMA ROTA que nenhuma viagem (de nenhum dia) use;
//   - viagem Cancelada/Finalizada, viagem manual sem checklist e checklist
//     CANCELADO: nao mexe.
// Parada ja atendida (entregue/recusada/com ocorrencia) congela: nao e mais tocada.
// Loja que SAIU do checklist (parada pendente): a carga e limpa (volume/materiais)
// e a parada fica marcada programacao.saiu_do_checklist — a loja pode entrar na
// viagem certa no mesmo ciclo. Nunca apaga parada, nunca mexe em horario/RT/CX/
// equipe (dono: planilha), status, ocorrencia ou CTe. Loja nova no checklist vira
// parada no fim se nenhuma outra viagem do dia tem essa loja. So grava o que mudou.
const estadoSync = { rodando: false, ultima: null, intervaloMin: null, erroLogado: null };

function dataLocal(deslocDias = 0) {
    const d = new Date(Date.now() + deslocDias * 86400000);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
}

// JSON com chaves ordenadas: o jsonb do Postgres devolve as chaves em outra ordem.
function estavel(v) {
    if (Array.isArray(v)) return v.map(estavel);
    if (v && typeof v === 'object') return Object.keys(v).sort().reduce((o, k) => { o[k] = estavel(v[k]); return o; }, {});
    return v;
}
const mesmoJson = (a, b) => JSON.stringify(estavel(a ?? null)) === JSON.stringify(estavel(b ?? null));
// 0 e vazio sao a mesma coisa aqui (o "Importar do Checklist" grava vazio onde o
// checklist diz 0); sem isto a 1a sincronizacao regravaria o dia inteiro a toa.
const mesmoNumero = (a, b) => (Number(a) || 0) === (Number(b) || 0);

async function carregarViagensParaSync(q, data) {
    const r = await q.query(`
        SELECT v.id, v.codigo, v.rota_nome, v.placa, v.status, v.checklist_origem_id, v.programacao,
               COALESCE(json_agg(json_build_object(
                   'id', p.id, 'ordem', p.ordem, 'loja_nome', p.loja_nome, 'pes', p.programacao->>'pes',
                   'status', p.status, 'ocorrencia_id', p.ocorrencia_id,
                   'saiu', (p.programacao ? 'saiu_do_checklist'),
                   'volumes_previstos', p.volumes_previstos, 'material_campanha', p.material_campanha,
                   'sacola', p.sacola, 'sacola_p', p.sacola_p, 'sacola_m', p.sacola_m, 'sacola_g', p.sacola_g,
                   'remessas', p.remessas
               ) ORDER BY p.ordem, p.id) FILTER (WHERE p.id IS NOT NULL), '[]') AS paradas
          FROM tms_viagens v
          LEFT JOIN tms_paradas p ON p.viagem_id = v.id
         WHERE v.data_viagem = $1
         GROUP BY v.id
         ORDER BY v.id`, [data]);
    return r.rows;
}

// Parada ja atendida (entregue, recusada, com ocorrencia) CONGELA: o que foi
// entregue e historico e nao muda depois do fato.
const paradaCongelada = (p) => !!p.ocorrencia_id || !['Pendente', 'Em atendimento'].includes(p.status || 'Pendente');

// Parada que tem carga vinda do checklist (volume, material, sacola ou remessa).
const temCargaDoChecklist = (p) => [p.volumes_previstos, p.material_campanha, p.sacola, p.sacola_p, p.sacola_m, p.sacola_g]
    .some((v) => Number(v) > 0) || !!p.remessas;

// cks: resultado de carregarChecklists JA buscado (fora da transacao).
async function sincronizarDia(client, data, deps, cks) {
    const resumo = { data, erro: cks.erro, viagens: [], avisos: [] };
    // API fora e nada lido: nao da para concluir nada sobre o dia.
    if (cks.erro && !cks.lista.length) return resumo;
    // Todos os detalhes do dia foram lidos? So entao "checklist sumiu do dia" e fato
    // (cancelado/outra data) e nao falha de leitura de um detalhe.
    const listaCompleta = !cks.erro;

    const fretes = await client.query('SELECT loja_nome, pes FROM tms_fretes_loja');
    const pesPorChave = new Map();
    fretes.rows.forEach((f) => {
        const k = chaveLoja(f.loja_nome);
        if (f.pes && !pesPorChave.has(k)) pesPorChave.set(k, String(f.pes).trim());
    });
    const pesDa = (p) => (p.pes ? String(p.pes) : pesPorChave.get(chaveLoja(p.loja_nome)) || null);

    const viagens = await carregarViagensParaSync(client, data);
    const ativas = viagens.filter((v) => !['Cancelada', 'Finalizada'].includes(v.status));
    const ckPorId = new Map(cks.lista.map((c) => [c.id, c]));

    // Dono de cada checklist no BANCO INTEIRO (mesma regra do indice unico /
    // checklistLivre): checklist que ja e de viagem de outro dia ou de viagem
    // cancelada nao pode ir para uma viagem daqui — a carga contaria 2 vezes.
    const donos = new Map();
    (await client.query(
        `SELECT checklist_origem_id AS ck, id, codigo, to_char(data_viagem, 'YYYY-MM-DD') AS data, status
           FROM tms_viagens WHERE checklist_origem_id = ANY($1::int[])`, [[...ckPorId.keys()]]))
        .rows.forEach((r) => donos.set(r.ck, r));

    const pares = [];
    ativas.forEach((v) => {
        if (!v.checklist_origem_id) return;
        if (ckPorId.has(v.checklist_origem_id)) pares.push({ v, ck: ckPorId.get(v.checklist_origem_id), vincular: false });
    });
    // Viagens importadas da planilha que ficaram sem checklist: so vincula SOZINHO
    // com rota compativel (ver rotaCompativel em pontuarChecklist). Placa + 1 loja
    // em comum ligava a carga de outra rota do mesmo caminhao para sempre.
    // Entra tambem a viagem da planilha cujo checklist SAIU do dia (cancelado e
    // refeito com outro numero, ou com outra data de entrega): senao ela ficava
    // presa na carga velha para sempre.
    const ckSumiu = (v) => listaCompleta && v.checklist_origem_id && !ckPorId.has(v.checklist_origem_id);
    const semCk = ativas.filter((v) => (!v.checklist_origem_id || ckSumiu(v)) && v.programacao && v.programacao.chave);
    const pseudo = semCk.map((v, i) => ({
        indice: i,
        v,
        chave_rota: chaveRota(v.rota_nome),
        placa: v.placa ? { sistema: v.placa } : null,
        paradas: (v.paradas || []).map((p) => ({ chave_loja: chaveLoja(p.loja_nome), pes: pesDa(p) })),
    }));
    const livres = cks.lista.filter((c) => !donos.has(c.id));
    // So pares de rota compativel disputam o casamento: um candidato incompativel
    // com mais pontos (mesma placa, outra rota) nao pode tirar o lugar do certo.
    const soCompativel = (b, c) => {
        const s = pontuarChecklist(b, c);
        return { ...s, aceita: s.aceita && s.rotaCompativel };
    };
    const casados = casarGuloso(pseudo, livres, soCompativel).casados;
    pseudo.forEach((b) => {
        const m = casados.get(b.indice);
        if (m && m.rotaCompativel) pares.push({ v: b.v, ck: ckPorId.get(m.id), vincular: true });
    });

    // 1a fase: casa lojas de cada par (nome, depois PES) sem gravar nada, para
    // saber quais paradas SAIRAM do checklist delas neste ciclo.
    const planos = pares.map(({ v, ck, vincular }) => {
        const paradas = (v.paradas || []).map((p) => ({ ...p, chave: chaveLoja(p.loja_nome), pesEf: pesDa(p), c: null }));
        const sobra = ck.paradas.slice();
        paradas.forEach((p) => {
            const i = sobra.findIndex((c) => c.chave_loja === p.chave);
            if (i >= 0) p.c = sobra.splice(i, 1)[0];
        });
        paradas.forEach((p) => {
            if (p.c || !p.pesEf) return;
            const i = sobra.findIndex((c) => c.pes && c.pes === p.pesEf);
            if (i >= 0) p.c = sobra.splice(i, 1)[0];
        });
        return { v, ck, vincular, paradas, sobra };
    });
    // Parada pendente, com carga do checklist, cuja loja nao esta mais no checklist
    // da viagem: a carga saiu deste caminhao. Ela nao "segura" a loja: a loja pode
    // aparecer na viagem certa neste mesmo ciclo.
    const saiuDoChecklist = new Set();
    planos.forEach((pl) => pl.paradas.forEach((p) => {
        if (pl.v.programacao?.edicao_manual) return;
        if (!p.c && !paradaCongelada(p) && temCargaDoChecklist(p)) saiuDoChecklist.add(p.id);
    }));
    // Lojas ja presentes no dia (fora as que sairam), atualizado a cada insercao.
    const lojasDoDia = [];
    viagens.forEach((o) => {
        if (o.status === 'Cancelada') return;
        (o.paradas || []).forEach((p) => {
            // Parada pendente que ja saiu do checklist (neste ciclo ou num anterior)
            // nao segura a loja: se ela voltar em outro checklist, entra la.
            if (!o.programacao?.edicao_manual && (saiuDoChecklist.has(p.id) || (p.saiu && !paradaCongelada(p)))) return;
            lojasDoDia.push({ viagem: o.id, chave: chaveLoja(p.loja_nome), pes: pesDa(p) });
        });
    });
    const lojaEmOutraViagem = (c, viagemId) => lojasDoDia.some((l) => l.viagem !== viagemId
        && (l.chave === c.chave_loja || (c.pes && l.pes === c.pes)));

    for (const pl of planos) {
        const { v, ck, vincular } = pl;
        // Trava a viagem ANTES das paradas (mesma ordem do PUT /tms/viagens/:id,
        // evita impasse) e revalida: pode ter sido cancelada, finalizada ou
        // movida de dia depois do retrato acima.
        const atual = (await client.query(
            `SELECT status, to_char(data_viagem, 'YYYY-MM-DD') AS data, checklist_origem_id, programacao
               FROM tms_viagens WHERE id = $1 FOR UPDATE`, [v.id])).rows[0];
        if (!atual || atual.data !== data || ['Cancelada', 'Finalizada'].includes(atual.status)) continue;
        // Inclui a lista de lojas, cargas e totais. Nao recoloca lojas removidas
        // nem limpa campos manualmente corrigidos, mesmo com uma previa antiga.
        if (atual.programacao?.edicao_manual) continue;
        // Vincular: a viagem tem que continuar sem checklist (ou com o mesmo que sumiu
        // do dia) e o checklist novo tem que estar livre no banco inteiro.
        if (vincular && ((atual.checklist_origem_id && atual.checklist_origem_id !== v.checklist_origem_id)
            || !(await checklistLivre(client, ck.id, v.id)))) continue;

        let atualizadas = 0;
        let limpas = 0;
        for (const p of pl.paradas) {
            if (paradaCongelada(p)) continue;
            // As duas escritas repetem a trava "pendente e sem ocorrencia" no WHERE:
            // a parada pode ter virado Entregue entre o retrato e este UPDATE.
            if (!p.c) {
                if (!saiuDoChecklist.has(p.id)) continue;
                const r = await client.query(`
                    UPDATE tms_paradas SET volumes_previstos = NULL, material_campanha = NULL, sacola = NULL,
                        sacola_p = NULL, sacola_m = NULL, sacola_g = NULL, remessas = NULL,
                        programacao = COALESCE(programacao, '{}'::jsonb) || jsonb_build_object('saiu_do_checklist', $3::int),
                        atualizado_em = NOW()
                    WHERE id = $1 AND viagem_id = $2 AND ocorrencia_id IS NULL
                      AND COALESCE(status, 'Pendente') IN ('Pendente', 'Em atendimento')`, [p.id, v.id, ck.id]);
                limpas += r.rowCount;
                continue;
            }
            const n = dadosChecklistDaLoja(p.c);
            const igual = mesmoNumero(p.volumes_previstos, n.volumes_previstos)
                && mesmoNumero(p.material_campanha, n.material_campanha)
                && mesmoNumero(p.sacola, n.sacola) && mesmoNumero(p.sacola_p, n.sacola_p)
                && mesmoNumero(p.sacola_m, n.sacola_m) && mesmoNumero(p.sacola_g, n.sacola_g)
                && mesmoJson(p.remessas, n.remessas);
            if (igual) continue;
            const r = await client.query(`
                UPDATE tms_paradas SET
                    volumes_previstos = $3, material_campanha = $4, sacola = $5,
                    sacola_p = $6, sacola_m = $7, sacola_g = $8, remessas = $9::jsonb,
                    programacao = CASE WHEN programacao ? 'saiu_do_checklist' THEN programacao - 'saiu_do_checklist' ELSE programacao END,
                    atualizado_em = NOW()
                WHERE id = $1 AND viagem_id = $2 AND ocorrencia_id IS NULL
                  AND COALESCE(status, 'Pendente') IN ('Pendente', 'Em atendimento')`,
            [p.id, v.id, n.volumes_previstos, n.material_campanha, n.sacola,
                n.sacola_p, n.sacola_m, n.sacola_g, n.remessas ? JSON.stringify(n.remessas) : null]);
            atualizadas += r.rowCount;
        }

        const extras = pl.sobra.filter((c) => !lojaEmOutraViagem(c, v.id));
        let ordem = (v.paradas || []).reduce((m, p) => Math.max(m, Number(p.ordem) || 0), 0);
        for (const c of extras) {
            ordem += 1;
            await inserirParada(client, v.id, ordem, {
                atd: null, loja: c.loja, loja_sistema: c.loja, pes: c.pes || null, emp: null,
                hora_loja: null, rt: null, cx: null, linha: null, origem: 'checklist',
                checklist: dadosChecklistDaLoja(c),
            });
            // Uma loja nova so entra em UMA viagem por ciclo.
            lojasDoDia.push({ viagem: v.id, chave: c.chave_loja, pes: c.pes || null });
        }

        let vinculou = false;
        if (vincular) {
            await client.query(`
                UPDATE tms_viagens SET checklist_origem_id = $2,
                    programacao = COALESCE(programacao, '{}'::jsonb) || jsonb_build_object('checklist_id', $2::int, 'checklist_status', $3::text),
                    atualizado_em = NOW()
                WHERE id = $1`, [v.id, ck.id, ck.status || null]);
            vinculou = true;
        }

        if (atualizadas || limpas || extras.length || vinculou) {
            await recalcularTotaisViagem(client, v.id);
            if (extras.length && deps.preencherLojaIdDaViagem) await deps.preencherLojaIdDaViagem(client, v.id);
            resumo.viagens.push({
                viagem_id: v.id, codigo: v.codigo, rota: v.rota_nome, checklist_id: ck.id,
                paradas_atualizadas: atualizadas, paradas_novas: extras.length, paradas_sairam: limpas, vinculada: vinculou,
            });
        }
    }

    // Viagem cujo checklist sumiu do dia e nao achou substituto: avisa.
    const religadas = new Set(resumo.viagens.filter((x) => x.vinculada).map((x) => x.viagem_id));
    ativas.forEach((v) => {
        if (ckSumiu(v) && v.programacao && v.programacao.chave && !religadas.has(v.id)) {
            resumo.avisos.push(`${v.codigo}: checklist #${v.checklist_origem_id} não está mais no dia (cancelado ou com outra data de entrega); a viagem não é mais sincronizada.`);
        }
    });
    return resumo;
}

// Roda para as datas pedidas (padrao: hoje e amanha). A API do Checklist e
// lida FORA da transacao (uma listagem por ciclo); so depois abre a transacao
// com o mesmo advisory lock da importacao. Checklist lento nao prende o banco.
async function sincronizarChecklists(deps, datas, origem = 'automatica') {
    if (estadoSync.rodando) return { ocupado: true, ultima: estadoSync.ultima };
    estadoSync.rodando = true;
    const resultados = [];
    try {
        const lista = datas && datas.length ? datas : [dataLocal(0), dataLocal(1)];
        let todos = null;
        let erroLista = null;
        try {
            todos = await deps.checklistListarTodos();
        } catch (err) {
            erroLista = err;
        }
        for (const data of lista) {
            const cks = erroLista
                ? { lista: [], erro: `Checklist Expedição fora do ar (${erroLista.message}).`, origemErro: 'checklist' }
                : await carregarChecklists(data, deps, todos);
            if (cks.erro && !cks.origemErro) cks.origemErro = 'checklist';
            const client = await deps.db.connect();
            let r;
            try {
                await client.query('BEGIN');
                await client.query("SELECT pg_advisory_xact_lock(hashtext('tms_programacao_importar'))");
                r = await sincronizarDia(client, data, deps, cks);
                r.origemErro = cks.erro ? 'checklist' : null;
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK').catch(() => {});
                r = { data, erro: `Falha ao gravar a sincronização: ${err.message}`, origemErro: 'gravacao', viagens: [], avisos: [] };
            } finally {
                client.release();
            }
            resultados.push(r);
            if (deps.registrarAuditoria) {
                const req = { usuarioLogado: { id: null, nome: origem === 'automatica' ? 'Sincronização automática' : `Sincronização (${origem})` }, ip: null };
                for (const x of r.viagens) {
                    await deps.registrarAuditoria(req, 'SYNC_CHECKLIST', 'tms_viagens', x.viagem_id, { data_viagem: data, ...x });
                }
            }
        }
    } finally {
        estadoSync.rodando = false;
    }
    estadoSync.ultima = { em: new Date().toISOString(), origem, resultados };
    const mudou = resultados.reduce((s, r) => s + r.viagens.length, 0);
    const erro = resultados.map((r) => r.erro).filter(Boolean).join(' | ') || null;
    if (mudou) console.log(`[tms-sync] ${mudou} viagem(ns) atualizada(s) pelo Checklist: ${resultados.flatMap((r) => r.viagens.map((x) => x.codigo)).join(', ')}`);
    if (erro !== estadoSync.erroLogado) {
        if (erro) console.warn(`[tms-sync] ${erro}`);
        else if (estadoSync.erroLogado) console.log('[tms-sync] Checklist voltou a responder.');
        estadoSync.erroLogado = erro;
    }
    return estadoSync.ultima;
}


// ── planilha que se atualiza sozinha ────────────────────────────
// A planilha do dia fica na rede e varias pessoas mexem nela. A cada ciclo,
// para HOJE e AMANHA:
//   - so dias que JA foram importados a mao ao menos uma vez (tabela
//     tms_programacao_sync). A 1a importacao do dia e sempre de uma pessoa: a
//     planilha de amanha e montada ao longo do dia e criar viagem de rascunho
//     pela metade geraria lixo;
//   - le o arquivo so se a data de modificacao/tamanho mudou;
//   - aplica so a ROTA que mudou (hash do que foi aplicado por rota) e so em
//     viagem que ainda nao saiu (Planejada/Carregando). Viagem ja rodando,
//     rota marcada "Nao importar" e rota nova com cara de duplicata ficam de
//     fora e viram aviso no selo do TMS;
//   - nunca apaga: loja/rota que saiu da planilha continua na viagem (aviso).
// Volume e materiais seguem vindo do Checklist (sincronizarChecklists, logo depois).
const Parser = require('../public/js/tms-programacao-parser.js');
const crypto = require('crypto');
let xlsxCarregado;
function xlsxNode() {
    if (xlsxCarregado === undefined) {
        try { xlsxCarregado = require('xlsx'); } catch (_) { xlsxCarregado = null; }
    }
    return xlsxCarregado;
}

// Marca, em ignoradas, de dia importado antes da sincronizacao existir.
const SEM_CRIAR_SOZINHO = '*sem-criar-sozinho*';

// Hash do que a planilha diz de uma rota (depois do saneamento). Linha que so
// mudou de posicao nao conta como mudanca.
function hashBloco(b) {
    const essencial = {
        rota: b.rota, hora_saida: b.hora_saida, motorista: b.motorista, ajudantes: b.ajudantes, placa: b.placa,
        paradas: b.paradas.map((p) => ({ loja: p.loja, pes: p.pes, hora: p.hora_loja, rt: p.rt, cx: p.cx })),
    };
    return crypto.createHash('sha1').update(JSON.stringify(essencial)).digest('hex');
}

// Chamada depois do COMMIT da importacao manual: marca o dia como "importado"
// (liga a sincronizacao automatica dele) e guarda escolhas e hashes.
async function registrarImportacaoManual(q, payload, resultado) {
    try {
        const blocos = sanearBlocos(payload?.blocos);
        const hashes = {};
        const ignoradas = [];
        (resultado.blocos || []).forEach((b) => {
            const bl = blocos[b.indice];
            if (!bl || !b.chave) return;
            if (b.acao === 'ignorar') ignoradas.push(b.chave);
            else if (bl.paradas.length) hashes[b.chave] = hashBloco(bl);
        });
        await q.query(`
            INSERT INTO tms_programacao_sync (data, arquivo, aba, ignoradas, blocos_hash, arquivo_modificado, arquivo_tamanho, atualizado_em)
            VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, NULL, NULL, NOW())
            ON CONFLICT (data) DO UPDATE SET
                arquivo = EXCLUDED.arquivo, aba = EXCLUDED.aba, ignoradas = EXCLUDED.ignoradas,
                blocos_hash = tms_programacao_sync.blocos_hash || EXCLUDED.blocos_hash,
                arquivo_modificado = NULL, arquivo_tamanho = NULL, atualizado_em = NOW()`,
        [resultado.data_viagem, txt(payload?.arquivo, 200), txt(payload?.aba, 120), JSON.stringify(ignoradas), JSON.stringify(hashes)]);
    } catch (err) {
        console.warn('[tms-planilha] não consegui registrar a importação manual:', err.message);
    }
}

// Mesma regra da tela (melhorAba): a aba que a pessoa usou; senao a primeira
// com rotas trazendo PES/RT/CX; senao a primeira com rotas.
function lerAbasDaPlanilha(X, buf, abaPreferida) {
    const wb = X.read(buf, { type: 'buffer', cellDates: false });
    const abas = wb.SheetNames.map((nome) => {
        const ws = wb.Sheets[nome];
        if (!ws || !ws['!ref']) return { nome, blocos: [] };
        const inicio = X.utils.decode_range(ws['!ref']).s.r + 1;
        const matriz = X.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: true });
        return { nome, ...Parser.lerMatriz(matriz, { linhaInicial: inicio }) };
    });
    const preferida = abaPreferida && abas.find((a) => a.nome === abaPreferida && a.blocos.length);
    return preferida
        || abas.find((a) => a.blocos.some((b) => b.paradas.some((p) => p.pes || p.rt != null || p.cx != null)))
        || abas.find((a) => a.blocos.length)
        || null;
}

async function sincronizarPlanilhaDia(deps, linha, listagem, opcoes = {}) {
    const data = linha.data;
    const r = { data, arquivo: null, aplicadas: [], avisos: [], erro: null, sem_mudanca: false };
    const arquivo = listagem.arquivos.find((a) => a.data === data);
    if (!arquivo) { r.avisos.push(`A planilha de ${data.split('-').reverse().join('/')} não está na pasta.`); return r; }
    r.arquivo = arquivo.nome;
    const reconciliada = linha.blocos_hash?.__reconciliacao === VERSAO_RECONCILIACAO;
    if (!opcoes.forcar && reconciliada && arquivo.modificado && arquivo.modificado === linha.arquivo_modificado
        && String(arquivo.tamanho) === String(linha.arquivo_tamanho)) {
        r.sem_mudanca = true;
        return r;
    }
    if ((arquivo.tamanho || 0) > TAMANHO_MAX_ARQUIVO) { r.erro = `${arquivo.nome} é grande demais para ler sozinho.`; return r; }

    const buf = await lerConteudoArquivo(arquivo);
    let aba;
    try {
        aba = lerAbasDaPlanilha(xlsxNode(), buf, linha.aba);
    } catch (err) {
        // Excel salvando no meio da leitura: tenta de novo no proximo ciclo.
        r.erro = `Não consegui ler ${arquivo.nome} agora (${err.message}); tento no próximo ciclo.`;
        return r;
    }
    if (!aba) { r.erro = `${arquivo.nome}: nenhuma aba com rotas.`; return r; }

    const payload = { data_viagem: data, arquivo: arquivo.nome, aba: aba.nome, blocos: aba.blocos };
    const saneados = sanearBlocos(aba.blocos);
    const ignoradas = new Set(Array.isArray(linha.ignoradas) ? linha.ignoradas : []);
    const hashes = linha.blocos_hash && typeof linha.blocos_hash === 'object' ? linha.blocos_hash : {};
    const pular = (p) => {
        if (ignoradas.has(p.chave)) return 'ignorada';
        // Dia importado ANTES desta sincronizacao existir: nao se sabe o que a pessoa
        // deixou de fora naquela importacao, entao rota nova so entra pela mao.
        if (p.acao === 'criar' && ignoradas.has(SEM_CRIAR_SOZINHO)) return 'rota nova na planilha: importe à mão para incluir';
        if (!opcoes.forcar && reconciliada && hashes[p.chave] && hashes[p.chave] === hashBloco(saneados[p.indice])) return 'sem mudança';
        if (p.acao === 'atualizar' && p.alvo && ['Finalizada', 'Cancelada'].includes(p.alvo.status)) {
            return `a viagem ${p.alvo.codigo} está "${p.alvo.status}"; seu histórico foi preservado`;
        }
        if (p.acao === 'atualizar' && p.alvo && p.troca_equipe && !['Planejada', 'Carregando', 'Liberada'].includes(p.alvo.status)) {
            return `a viagem ${p.alvo.codigo} já saiu: confira a troca de motorista/placa antes de importar`;
        }
        if (p.acao === 'criar' && p.avisos.some((a) => /pode duplicar|Já existe viagem desta rota/.test(a))) {
            return 'rota nova parece repetir uma viagem do dia; importe à mão para conferir';
        }
        return null;
    };

    const client = await deps.db.connect();
    let res;
    try {
        await client.query('BEGIN');
        // Sem as funcoes do Checklist: aqui so entra o que e da planilha. Volume e
        // materiais chegam pela sincronizacao do Checklist, que roda em seguida.
        res = await importar(client, payload, [], { id: null, nome: 'Planilha (automático)' },
            { preencherLojaIdDaViagem: deps.preencherLojaIdDaViagem }, { pular, automatica: true });
        const novos = { __reconciliacao: VERSAO_RECONCILIACAO };
        [...res.criadas, ...res.atualizadas].forEach((x) => { novos[x.chave] = hashBloco(saneados[x.indice]); });
        const pendente = res.puladas.some(x => !['ignorada', 'sem mudança'].includes(x.motivo) && !/salvo manualmente/.test(x.motivo));
        await client.query(`
            UPDATE tms_programacao_sync SET arquivo = $2, aba = $3, arquivo_modificado = $4, arquivo_tamanho = $5,
                blocos_hash = blocos_hash || $6::jsonb, atualizado_em = NOW()
            WHERE data = $1`, [data, arquivo.nome, aba.nome, pendente ? null : arquivo.modificado, arquivo.tamanho, JSON.stringify(novos)]);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        r.erro = `Falha ao aplicar ${arquivo.nome}: ${err.message}`;
        return r;
    } finally {
        client.release();
    }

    r.aplicadas = [...res.criadas.map((x) => ({ ...x, operacao: 'criada' })), ...res.atualizadas.map((x) => ({ ...x, operacao: 'atualizada' }))];
    r.transferencias = res.transferencias || [];
    r.remocoes = res.remocoes || [];
    r.viagens_canceladas = res.viagens_canceladas || [];
    r.avisos.push(...(res.avisos || []));
    res.puladas.filter((x) => !['ignorada', 'sem mudança'].includes(x.motivo))
        .forEach((x) => r.avisos.push(`${x.rota}: ${x.motivo}.`));
    res.atualizadas.filter((x) => (x.lojas_so_na_viagem || []).length)
        .forEach((x) => r.avisos.push(`${x.rota}: ${x.lojas_so_na_viagem.join(', ')} saiu da planilha mas continua na viagem (não apago sozinho).`));
    if (deps.registrarAuditoria) {
        const req = { usuarioLogado: { id: null, nome: 'Planilha (automático)' }, ip: null };
        for (const x of r.aplicadas) {
            await deps.registrarAuditoria(req, 'SYNC_PLANILHA', 'tms_viagens', x.viagem_id, {
                data_viagem: data, arquivo: arquivo.nome, rota: x.rota, operacao: x.operacao,
                paradas_novas: x.paradas_novas, paradas_atualizadas: x.paradas_atualizadas,
                paradas_transferidas: x.paradas_transferidas || 0, paradas_removidas: x.paradas_removidas || 0,
            });
        }
        for (const x of r.viagens_canceladas) {
            await deps.registrarAuditoria(req, 'RECONCILIAR_PLANILHA', 'tms_viagens', x.id, {
                data_viagem: data, arquivo: arquivo.nome, motivo: 'Rota vazia após transferência das lojas pela planilha.'
            });
        }
    }
    return r;
}

// ── 1a importacao do dia, sozinha ───────────────────────────────
// Dia (hoje/amanha) que ninguem importou ainda entra sozinho quando a planilha
// esta "toda verde" — a MESMA regra da tela (sem aviso, toda rota com checklist,
// toda loja casada, sem troca de motorista/placa, nenhum checklist do dia sem
// rota) — e o arquivo esta parado ha TMS_AUTOIMPORT_ESTAVEL_MIN (padrao 10) min,
// para nao importar a planilha no meio da digitacao. Se algo impede, avisa no
// sino 🚨 (um alerta por dia, atualizado com o motivo) e tenta de novo no
// proximo ciclo; quando entrar, o alerta se resolve. TMS_AUTOIMPORT=0 desliga.
const autoImportLigado = () => String(process.env.TMS_AUTOIMPORT ?? '1') !== '0';

function pendenciasDoPlano(plano, avisosAba = []) {
    const out = [];
    if (plano.checklist_erro) out.push(`Checklist: ${plano.checklist_erro}`);
    (plano.checklists_sem_rota || []).forEach((c) => out.push(`Checklist #${c.id} (${c.rota || '-'}) sem rota na planilha`));
    avisosAba.forEach((a) => out.push(a));
    (plano.blocos || []).forEach((b) => {
        if (b.acao === 'ignorar' || b.alvo?.edicao_manual) return;
        const rota = b.rota?.sistema || `rota ${b.indice + 1}`;
        if (!b.paradas.length) out.push(`${rota}: sem lojas`);
        if (!b.motorista) out.push(`${rota}: sem motorista`);
        if (!b.placa) out.push(`${rota}: sem placa`);
        if (!b.checklist) out.push(`${rota}: sem checklist de expedição ainda`);
        if (b.troca_equipe) out.push(`${rota}: troca de motorista/placa numa viagem que já existe`);
        if ((b.lojas_sem_checklist || []).length) out.push(`${rota}: loja(s) sem volume no checklist (${b.lojas_sem_checklist.join(', ')})`);
        if ((b.lojas_so_no_checklist || []).length) out.push(`${rota}: loja(s) só no checklist (${b.lojas_so_no_checklist.join(', ')})`);
        if ((b.lojas_so_na_viagem || []).length) out.push(`${rota}: loja(s) só na viagem (${b.lojas_so_na_viagem.join(', ')})`);
        b.avisos.forEach((a) => out.push(`${rota}: ${a}`));
    });
    return [...new Set(out)];
}

async function avisarNoSino(deps, data, pendencias) {
    const chave = `planilha-pendente-${data}`;
    const dataBR = data.split('-').reverse().join('/');
    const detalhe = pendencias.slice(0, 12).join(' | ') + (pendencias.length > 12 ? ` | +${pendencias.length - 12}` : '');
    try {
        const r = await deps.db.query(`
            INSERT INTO alertas (chave, tipo, severidade, titulo, detalhe, aba, evento_em)
            VALUES ($1, 'planilha_pendente', 'media', $2, $3, 'tms', $4)
            ON CONFLICT (chave) DO UPDATE SET detalhe = EXCLUDED.detalhe
                WHERE alertas.resolvido_em IS NULL AND alertas.detalhe IS DISTINCT FROM EXCLUDED.detalhe
            RETURNING (xmax = 0) AS novo`,
        [chave, `Programação de ${dataBR} não entrou sozinha: confira e importe`, detalhe, data]);
        if (r.rows[0]?.novo && typeof deps.broadcastEvento === 'function') deps.broadcastEvento('alerta', { novos: 1 });
    } catch (err) {
        console.warn('[tms-planilha] alerta:', err.message);
    }
}

async function resolverAvisoDoSino(deps, data) {
    try {
        await deps.db.query(`UPDATE alertas SET resolvido_em = NOW() WHERE chave = $1 AND resolvido_em IS NULL`, [`planilha-pendente-${data}`]);
    } catch (_) { /* sem alerta aberto */ }
}

async function autoImportarDia(deps, data, listagem) {
    const r = { data, arquivo: null, aplicadas: [], avisos: [], erro: null, primeira_importacao: true };
    const arquivo = listagem.arquivos.find((a) => a.data === data);
    if (!arquivo) return null; // planilha do dia ainda nao existe: nada a fazer
    r.arquivo = arquivo.nome;
    const estavelMin = Number(process.env.TMS_AUTOIMPORT_ESTAVEL_MIN ?? 10);
    const parado = arquivo.modificado ? (Date.now() - Date.parse(arquivo.modificado)) / 60000 : Infinity;
    if (parado < estavelMin) {
        r.avisos.push(`Planilha ${arquivo.nome} foi mexida há ${Math.max(0, Math.floor(parado))} min; importo sozinho depois de ${estavelMin} min parada.`);
        return r;
    }
    if ((arquivo.tamanho || 0) > TAMANHO_MAX_ARQUIVO) { r.erro = `${arquivo.nome} é grande demais para ler sozinho.`; return r; }
    const buf = await lerConteudoArquivo(arquivo);
    let aba;
    try {
        aba = lerAbasDaPlanilha(xlsxNode(), buf, null);
    } catch (err) {
        r.erro = `Não consegui ler ${arquivo.nome} agora (${err.message}); tento no próximo ciclo.`;
        return r;
    }
    if (!aba || !aba.blocos.length) { r.avisos.push(`${arquivo.nome}: nenhuma rota lida ainda.`); return r; }

    const payload = { data_viagem: data, arquivo: arquivo.nome, aba: aba.nome, blocos: aba.blocos };
    const usuario = { id: null, nome: 'Planilha (automático)' };
    const client = await deps.db.connect();
    let res;
    try {
        await client.query('BEGIN');
        res = await importar(client, payload, [], usuario, deps, {
            validarPlano: (plano) => pendenciasDoPlano(plano, aba.avisos || []),
        });
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
        if (err.pendencias) {
            r.avisos.push(`Planilha de ${data.split('-').reverse().join('/')} não entrou sozinha (${err.pendencias.length} pendência(s)); importe à mão ou espere completar.`);
            await avisarNoSino(deps, data, err.pendencias);
            return r;
        }
        r.erro = `1ª importação automática falhou: ${err.message}`;
        return r;
    }
    client.release();
    await registrarImportacaoManual(deps.db, payload, res);
    await resolverAvisoDoSino(deps, data);
    r.aplicadas = [...res.criadas.map((x) => ({ ...x, operacao: 'criada' })), ...res.atualizadas.map((x) => ({ ...x, operacao: 'atualizada' }))];
    if (deps.registrarAuditoria) {
        const req = { usuarioLogado: usuario, ip: null };
        for (const x of r.aplicadas) {
            await deps.registrarAuditoria(req, 'IMPORT_PROGRAMACAO', 'tms_viagens', x.viagem_id, {
                data_viagem: data, rota: x.rota, arquivo: arquivo.nome, checklist_id: x.checklist_id,
                operacao: x.operacao, automatica: true, paradas_novas: x.paradas_novas, paradas_atualizadas: x.paradas_atualizadas,
            });
        }
    }
    return r;
}

async function sincronizarPlanilhas(deps, origem = 'automatica', opcoes = {}) {
    if (estadoSync.rodandoPlanilha) return estadoSync.planilha;
    if (!xlsxNode()) {
        estadoSync.planilha = { em: new Date().toISOString(), origem, resultados: [], erro: 'Biblioteca xlsx não instalada no servidor (npm install).' };
        return estadoSync.planilha;
    }
    estadoSync.rodandoPlanilha = true;
    const resultados = [];
    let erro = null;
    try {
        const datas = opcoes.datas?.length ? opcoes.datas : [dataLocal(0), dataLocal(1)];
        // Dia que ja tem viagem vinda da planilha (importada antes desta tabela
        // existir) entra na sincronizacao, mas SEM criar rota nova sozinho.
        await deps.db.query(`
            INSERT INTO tms_programacao_sync (data, ignoradas)
            SELECT DISTINCT v.data_viagem, $2::jsonb
              FROM tms_viagens v
             WHERE v.data_viagem = ANY($1::date[]) AND v.programacao ? 'chave'
            ON CONFLICT (data) DO NOTHING`, [datas, JSON.stringify([SEM_CRIAR_SOZINHO])]);
        const linhas = (await deps.db.query(
            `SELECT to_char(data, 'YYYY-MM-DD') AS data, arquivo, aba, arquivo_modificado, arquivo_tamanho, ignoradas, blocos_hash
               FROM tms_programacao_sync WHERE data = ANY($1::date[]) ORDER BY data`, [datas])).rows;
        const listagem = await listarArquivosDaPasta({ fresca: true });
        for (const linha of linhas) {
            try {
                resultados.push(await sincronizarPlanilhaDia(deps, linha, listagem, opcoes));
            } catch (err) {
                resultados.push({ data: linha.data, aplicadas: [], avisos: [], erro: err.message });
            }
        }
        // Dia ainda NAO importado: tenta a 1a importacao sozinho (so se "toda verde").
        if (autoImportLigado()) {
            const jaTem = new Set(linhas.map((l) => l.data));
            for (const data of datas.filter((d) => !jaTem.has(d))) {
                try {
                    const r = await autoImportarDia(deps, data, listagem);
                    if (r) resultados.push(r);
                } catch (err) {
                    resultados.push({ data, aplicadas: [], avisos: [], erro: `1ª importação automática: ${err.message}` });
                }
            }
        }
    } catch (err) {
        erro = `Pasta da programação indisponível (${err.message}).`;
    } finally {
        estadoSync.rodandoPlanilha = false;
    }
    estadoSync.planilha = { em: new Date().toISOString(), origem, resultados, erro };
    const aplicadas = resultados.flatMap((r) => r.aplicadas.map((x) => `${x.rota} (${x.operacao})`));
    if (aplicadas.length) console.log(`[tms-planilha] planilha -> TMS: ${aplicadas.join(', ')}`);
    const falhas = [erro, ...resultados.map((r) => r.erro)].filter(Boolean).join(' | ') || null;
    if (falhas !== estadoSync.erroPlanilhaLogado) {
        if (falhas) console.warn(`[tms-planilha] ${falhas}`);
        estadoSync.erroPlanilhaLogado = falhas;
    }
    return estadoSync.planilha;
}

// Um ciclo = planilha primeiro (equipe, horario, RT/CX, rotas novas) e depois o
// Checklist (volume e materiais), assim viagem criada pela planilha ja ganha carga.
async function cicloAutomatico(deps, origem = 'automatica', opcoes = {}) {
    // A listagem do Checklist (paginada) e baixada UMA vez por ciclo e dividida
    // entre a 1a importacao automatica e a sincronizacao de volume/materiais.
    let listaCiclo = null;
    const depsCiclo = typeof deps.checklistListarTodos === 'function'
        ? { ...deps, checklistListarTodos: () => { listaCiclo = listaCiclo || deps.checklistListarTodos(); return listaCiclo; } }
        : deps;
    await sincronizarPlanilhas(depsCiclo, origem, opcoes).catch((err) => console.warn('[tms-planilha] erro:', err.message));
    return sincronizarChecklists(depsCiclo, opcoes.datas || null, origem).catch((err) => { console.warn('[tms-sync] erro:', err.message); return estadoSync.ultima; });
}

function iniciarSincronizacao(deps) {
    const min = Number(process.env.TMS_SYNC_CHECKLIST_MIN ?? 5);
    if (!(min > 0)) {
        console.log('[tms-sync] sincronização automática (planilha + Checklist) DESLIGADA (TMS_SYNC_CHECKLIST_MIN=0).');
        return;
    }
    estadoSync.intervaloMin = min;
    const rodar = () => cicloAutomatico(deps);
    setTimeout(rodar, 30000);
    setInterval(rodar, min * 60000);
    console.log(`[tms-sync] planilha + Checklist -> TMS a cada ${min} min (viagens de hoje e amanhã)`);
}

// ── pasta ROTA COMPARTILHADA ────────────────────────────────────
// A operacao salva a programacao do dia como "DD.MM.AA.xlsx" na raiz da pasta do
// ano; dias passados vao para a subpasta do mes ("09 - SETEMBRO"). O modal lista
// daqui e ja abre o arquivo do proximo dia ainda nao importado.
// TMS_PROGRAMACAO_PASTA no .env troca o caminho ("{ANO}" vira o ano).
const PASTA_PADRAO = '\\\\empresa.local\\fileserver\\expedicao\\{ANO}\\ROTA COMPARTILHADA';
const MESES_PASTA = ['JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];

// O file server engasga as vezes: nunca deixa uma requisicao presa nele.
function comPrazo(promessa, ms, oque) {
    let t;
    return Promise.race([
        promessa,
        new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${oque}: sem resposta em ${ms / 1000}s`)), ms); }),
    ]).finally(() => clearTimeout(t));
}

function pastaDoAno(ano) {
    return String(process.env.TMS_PROGRAMACAO_PASTA || PASTA_PADRAO).replace(/\{ANO\}/g, String(ano));
}

function dataDoNomeArquivo(nome) {
    // (?=\D|$) e nao \b: "30.09.26_v2" tambem tem data.
    const m = String(nome).match(/^(\d{1,2})[.\-_](\d{1,2})[.\-_](\d{4}|\d{2})(?=\D|$)/);
    if (!m) return null;
    const ano = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return dataValida(`${ano}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`);
}

// Nome "limpo" DD.MM.AA(AA).xlsx: no empate de data (ex. "01.10.26 (1).xlsx"),
// ganha ele; depois o modificado mais recente.
const nomeCanonico = (nome) => /^\d{1,2}\.\d{1,2}\.(\d{2}|\d{4})\.xls[xm]?$/i.test(nome);

const TAMANHO_MAX_ARQUIVO = 30 * 1024 * 1024;
const listagemCache = { em: 0, valor: null, emVoo: null };

// Mesma ordem para as duas fontes: data mais recente; no mesmo dia o nome
// canonico (DD.MM.AA.xlsx) ganha; depois o modificado mais recente.
function ordenarArquivos(arquivos) {
    return arquivos.sort((a, b) => String(b.data || '').localeCompare(String(a.data || ''))
        || (nomeCanonico(b.nome) - nomeCanonico(a.nome))
        || String(b.modificado || '').localeCompare(String(a.modificado || ''))
        || a.caminho.localeCompare(b.caminho));
}

// Fonte da programacao: OnlyOffice (sala "Expedição") quando configurado no
// .env; se ele falhar, a pasta de rede de antes — e o rotulo da listagem diz
// isso, para a tela nao esconder que esta lendo da reserva.
async function lerListagemDaPasta() {
    if (!onlyoffice.configurado()) return lerListagemDoShare();
    try {
        const oo = await onlyoffice.listarPlanilhas();
        const arquivos = oo.arquivos.map((a) => ({
            ...a, caminho: `onlyoffice/${a.caminho}`, data: dataDoNomeArquivo(a.nome), fonte: 'onlyoffice',
        }));
        return { pasta: oo.pasta, arquivos: ordenarArquivos(arquivos) };
    } catch (err) {
        console.warn(`[tms-planilha] OnlyOffice falhou (${err.message}); lendo da pasta de rede.`);
        const share = await lerListagemDoShare();
        return { ...share, pasta: `${share.pasta} (reserva — OnlyOffice: ${err.message})` };
    }
}

// Conteudo do arquivo, venha de onde vier (OnlyOffice ou pasta de rede).
async function lerConteudoArquivo(arquivo) {
    if (arquivo._ooId) return comPrazo(onlyoffice.baixar(arquivo._ooId), 30000, arquivo.nome);
    return comPrazo(fs.promises.readFile(arquivo._completo), 20000, arquivo.nome);
}

async function lerListagemDoShare() {
    const hoje = dataLocal(0);
    const ano = Number(hoje.slice(0, 4));
    const mes = Number(hoje.slice(5, 7));
    // Pastas (ano, subpasta, prefixo do caminho). O ano atual nao tem prefixo; na
    // virada do ano tambem entra o ano vizinho (janeiro: dezembro do anterior;
    // dezembro: a pasta do ano seguinte, se ja criada).
    const alvos = [{ base: pastaDoAno(ano), sub: '', pre: '' }];
    [mes, mes === 1 ? null : mes - 1].filter(Boolean).forEach((m) => {
        alvos.push({ base: pastaDoAno(ano), sub: `${String(m).padStart(2, '0')} - ${MESES_PASTA[m - 1]}`, pre: '' });
    });
    if (mes === 1) {
        alvos.push({ base: pastaDoAno(ano - 1), sub: '', pre: `${ano - 1}/` });
        alvos.push({ base: pastaDoAno(ano - 1), sub: '12 - DEZEMBRO', pre: `${ano - 1}/` });
    }
    if (mes === 12) alvos.push({ base: pastaDoAno(ano + 1), sub: '', pre: `${ano + 1}/` });
    // Caminho sem {ANO} no .env: a pasta do "ano vizinho" e a mesma — nao lista 2 vezes.
    const vistos = new Set();
    const unicos = alvos.filter((a) => {
        const k = path.resolve(a.sub ? path.join(a.base, a.sub) : a.base).toLowerCase();
        if (vistos.has(k)) return false;
        vistos.add(k);
        return true;
    });

    const lerPasta = async ({ base, sub, pre }) => {
        const dir = sub ? path.join(base, sub) : base;
        const itens = await comPrazo(fs.promises.readdir(dir, { withFileTypes: true }), 10000, 'Pasta ROTA COMPARTILHADA');
        const arquivos = itens.filter((d) => d.isFile() && /\.xls[xm]?$/i.test(d.name) && !d.name.startsWith('~$'));
        // stat sequencial: poucos arquivos por pasta e nunca varias threads presas no share.
        const out = [];
        for (const d of arquivos) {
            const st = await comPrazo(fs.promises.stat(path.join(dir, d.name)), 10000, d.name).catch(() => null);
            out.push({
                caminho: `${pre}${sub ? `${sub}/` : ''}${d.name}`,
                nome: d.name,
                data: dataDoNomeArquivo(d.name),
                tamanho: st ? st.size : null,
                modificado: st ? st.mtime.toISOString() : null,
                _completo: path.join(dir, d.name),
            });
        }
        return out;
    };
    const arquivos = [];
    let leuAlguma = false;
    let ultimoErro = null;
    for (const a of unicos) {
        try {
            arquivos.push(...await lerPasta(a));
            leuAlguma = true;
        } catch (err) {
            ultimoErro = err; // pasta do ano novo ainda nao criada, subpasta ausente...
        }
    }
    if (!leuAlguma) throw ultimoErro || new Error('pasta indisponível');
    return { pasta: pastaDoAno(ano), arquivos: ordenarArquivos(arquivos.map((a) => ({ ...a, fonte: 'pasta' }))) };
}

// Uma leitura do share por vez (as outras requisicoes esperam a mesma) + cache
// curto. Pasta lenta/fora do ar nao enche o threadpool do Node de readdir presos
// (isso atrasava leitura de arquivo, DNS e ate o /health do servidor inteiro).
async function listarArquivosDaPasta({ fresca = false } = {}) {
    if (!fresca && listagemCache.valor && Date.now() - listagemCache.em < 60000) return listagemCache.valor;
    if (listagemCache.emVoo) return listagemCache.emVoo;
    listagemCache.emVoo = lerListagemDaPasta()
        .then((v) => { listagemCache.valor = v; listagemCache.em = Date.now(); return v; })
        .finally(() => { listagemCache.emVoo = null; });
    return listagemCache.emVoo;
}

// filename* conforme RFC 5987 (encodeURIComponent deixa ' ( ) * passarem).
const nomeParaHeader = (nome) => encodeURIComponent(nome).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const TIPOS_PLANILHA = {
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
    '.xls': 'application/vnd.ms-excel',
};

// ── rotas HTTP ──────────────────────────────────────────────────
// deps: { db, preencherLojaIdDaViagem, registrarAuditoria,
//         checklistListarTodos, checklistApi, mapearChecklistParaViagem, somenteAdm }
function registrarRotas(app, deps) {
    const { db } = deps;
    // Importar/sincronizar/abrir a pasta e coisa de ADM. O middleware global
    // deixa passar OPERADOR e CUSTOM pelo modulo "tms" (que libera todo /tms/),
    // entao a trava fica aqui na rota. Sem deps.somenteAdm (testes) nao trava.
    const adm = typeof deps.somenteAdm === 'function' ? deps.somenteAdm : (req, res, next) => next();

    app.post('/tms/programacao/previa', adm, async (req, res) => {
        try {
            res.status(200).json(await planejar(db, req.body, req.body?.escolhas, deps));
        } catch (err) {
            res.status(err.statusCliente || 500).json({ error: err.message });
        }
    });

    app.post('/tms/programacao/importar', adm, async (req, res) => {
        const client = await db.connect();
        let resultado;
        try {
            await client.query('BEGIN');
            resultado = await importar(client, req.body, req.body?.escolhas, req.usuarioLogado, deps);
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
            return res.status(err.statusCliente || 500).json({ error: err.statusCliente ? err.message : `Nada foi gravado: ${err.message}` });
        }
        client.release();
        // O dia passa a se atualizar sozinho pela planilha (com estas escolhas).
        await registrarImportacaoManual(db, req.body, resultado);
        await resolverAvisoDoSino(deps, resultado.data_viagem); // importou a mao: o aviso do sino perde o sentido
        if (deps.registrarAuditoria) {
            for (const item of [...resultado.criadas, ...resultado.atualizadas]) {
                await deps.registrarAuditoria(req, 'IMPORT_PROGRAMACAO', 'tms_viagens', item.viagem_id, {
                    data_viagem: resultado.data_viagem,
                    rota: item.rota,
                    arquivo: txt(req.body?.arquivo, 200),
                    checklist_id: item.checklist_id,
                    operacao: resultado.criadas.includes(item) ? 'criada' : 'atualizada',
                    paradas_novas: item.paradas_novas,
                    paradas_atualizadas: item.paradas_atualizadas,
                });
            }
        }
        res.status(200).json(resultado);
    });

    // Sincroniza agora (botao da tela). Sem data: hoje e amanha.
    app.post('/tms/programacao/sincronizar', adm, async (req, res) => {
        try {
            const data = req.body?.data ? dataValida(req.body.data) : null;
            if (req.body?.data && !data) return res.status(400).json({ error: 'Data inválida (AAAA-MM-DD).' });
            const origem = req.usuarioLogado?.nome || 'manual';
            const r = await cicloAutomatico(deps, origem, { forcar: true, datas: data ? [data] : undefined });
            res.status(200).json({ intervalo_min: estadoSync.intervaloMin, ...r, planilha: estadoSync.planilha || null });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // So leitura do estado (o selo da tela); nao expoe dado de viagem alem de codigo/rota.
    app.get('/tms/programacao/sincronizacao', (req, res) => {
        res.status(200).json({
            intervalo_min: estadoSync.intervaloMin, rodando: estadoSync.rodando, ultima: estadoSync.ultima,
            planilha: estadoSync.planilha || null,
        });
    });

    // Planilhas da pasta ROTA COMPARTILHADA + se a data ja foi importada.
    app.get('/tms/programacao/pasta', adm, async (req, res) => {
        try {
            const r = await listarArquivosDaPasta({ fresca: req.query.fresca === '1' });
            const datas = [...new Set(r.arquivos.map((a) => a.data).filter(Boolean))];
            const importadas = new Set();
            if (datas.length) {
                const q = await db.query(
                    `SELECT DISTINCT to_char(data_viagem, 'YYYY-MM-DD') AS d FROM tms_viagens
                      WHERE programacao IS NOT NULL AND data_viagem = ANY($1::date[])`, [datas]);
                q.rows.forEach((x) => importadas.add(x.d));
            }
            const arquivos = r.arquivos.slice(0, 40).map(({ _completo, _ooId, ...a }) => ({
                ...a,
                importada: !!(a.data && importadas.has(a.data)),
                grande: (a.tamanho || 0) > TAMANHO_MAX_ARQUIVO,
            }));
            res.status(200).json({ pasta: r.pasta, hoje: dataLocal(0), arquivos });
        } catch (err) {
            res.status(502).json({ error: `Não consegui abrir a pasta da programação: ${err.message}` });
        }
    });

    // Baixa UM arquivo da pasta. So aceita um caminho que esta na listagem (nada de
    // "..", caminho absoluto ou outra pasta). Vai em stream, com teto de tamanho e
    // prazo: share lento nao prende a requisicao nem a memoria do servidor.
    app.get('/tms/programacao/pasta/arquivo', adm, async (req, res) => {
        try {
            const pedido = String(req.query.caminho || '');
            let r = await listarArquivosDaPasta();
            let item = r.arquivos.find((a) => a.caminho === pedido);
            if (!item) {
                r = await listarArquivosDaPasta({ fresca: true });
                item = r.arquivos.find((a) => a.caminho === pedido);
            }
            if (!item) return res.status(404).json({ error: 'Arquivo não encontrado na pasta da programação.' });
            if ((item.tamanho || 0) > TAMANHO_MAX_ARQUIVO) {
                return res.status(413).json({ error: `Arquivo grande demais (${(item.tamanho / 1048576).toFixed(1)} MB; limite ${TAMANHO_MAX_ARQUIVO / 1048576} MB).` });
            }
            const ext = path.extname(item.nome).toLowerCase();
            // OnlyOffice: baixa pela API e entrega de uma vez (arquivo pequeno).
            if (item._ooId) {
                const buf = await lerConteudoArquivo(item);
                res.setHeader('Content-Type', TIPOS_PLANILHA[ext] || 'application/octet-stream');
                res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${nomeParaHeader(item.nome)}`);
                res.setHeader('Cache-Control', 'no-store');
                return res.status(200).send(buf);
            }
            const stream = fs.createReadStream(item._completo);
            let terminou = false;
            const falhar = (status, msg) => {
                if (terminou) return;
                terminou = true;
                if (!res.headersSent) {
                    ['Content-Type', 'Content-Disposition', 'Cache-Control'].forEach((h) => res.removeHeader(h));
                    res.status(status).json({ error: msg });
                } else {
                    res.destroy();
                }
            };
            // O prazo responde NA HORA: stream.destroy() espera o open/read pendurado
            // no SMB terminar, e a requisicao ficava presa pelo tempo do SO.
            const prazo = setTimeout(() => {
                falhar(504, 'Sem resposta do file server em 30s. Tente de novo ou escolha o arquivo do computador.');
                stream.destroy();
            }, 30000);
            stream.once('open', () => {
                if (terminou) return;
                res.setHeader('Content-Type', TIPOS_PLANILHA[ext] || 'application/octet-stream');
                res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${nomeParaHeader(item.nome)}`);
                res.setHeader('Cache-Control', 'no-store');
                res.status(200);
                stream.pipe(res);
            });
            stream.once('end', () => { terminou = true; clearTimeout(prazo); });
            stream.once('error', (err) => {
                clearTimeout(prazo);
                falhar(502, `Não consegui ler o arquivo: ${err.message}`);
            });
            stream.once('close', () => clearTimeout(prazo));
            res.once('close', () => { clearTimeout(prazo); stream.destroy(); });
        } catch (err) {
            if (!res.headersSent) res.status(502).json({ error: `Não consegui ler o arquivo: ${err.message}` });
        }
    });
}

module.exports = {
    registrarRotas, iniciarSincronizacao, sincronizarChecklists, sincronizarDia, listarArquivosDaPasta,
    sincronizarPlanilhas, cicloAutomatico, registrarImportacaoManual, hashBloco,
    planejar, importar, chaveRota, resolverPessoa, sanearBlocos, dataDoNomeArquivo, carregarChecklists,
};
