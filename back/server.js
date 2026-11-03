const express = require('express');
// OPCIONAL de proposito. O deploy daqui e copia de arquivo (ver
// publicar-observacoes.ps1), NAO roda "npm install" em producao: se este
// require fosse direto, publicar o server.js antes de instalar o pacote
// derrubaria o servidor no boot, com a operacao inteira fora do ar por causa
// de uma otimizacao. Sem o pacote o sistema roda igual, so sem gzip.
let compression = null;
try {
    compression = require('compression');
} catch (_) {
    console.warn('[compression] pacote nao instalado — respostas sairao SEM gzip. '
        + 'Para ativar: npm install compression (aqui e em producao).');
}
const cors = require('cors');
const cookie = require('cookie');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { spawn } = require('child_process');
const db = require('./db');
const checklistWhatsApp = require('./checklist-whatsapp');
const agendamentoEngine = require('./agendamento-engine');
const { calcularMinutos, classificarSla } = require('./tempo');
const { canonizarLoja, chaveLoja } = require('./normalizar-loja');
// Relacao ocorrencia -> KPIs / In Full. Mesmo arquivo que o navegador carrega
// (<script src="/js/kpi-ocorrencia.js">), para tela e banco nunca divergirem.
const { classificarOcorrenciaKpi } = require('../public/js/kpi-ocorrencia.js');
// Importacao da planilha de PROGRAMACAO DE ROTAS no TMS (previa + gravacao).
const tmsProgramacao = require('./tms-programacao');
// Cadastro unico de loja pelo PES + km entre lojas + frete calculado.
const lojasPes = require('./lojas-pes');
// Ciclo da viagem (Chegou / Voltou) + status automatico.
const tmsCiclo = require('./tms-ciclo');
// Previsao de chegada por loja (sem GPS) + alertas de jornada/atraso/fechamento.
const previsaoTms = require('./previsao-tms');
// Rotas de viagem (pernoite): loja feita no dia seguinte, data = dia da viagem.
const pernoite = require('./pernoite');
// Rastreador (plataforma SRF/GPSWOX): posicao ao vivo + coordenadas das lojas.
const rastreador = require('./rastreador');
const rastreadorLojas = require('./rastreador-lojas');
// Eventos do GPS ao vivo (chegou/saiu de loja e fabrica, chegando, hotel).
const rastreadorAoVivo = require('./rastreador-ao-vivo');
const tmsStatusGps = require('./tms-status-gps');
const frota = require('./frota');
const frotaDiarioMod = require('./frota-diario');
const frotaAlertasMod = require('./frota-alertas');
// Indicador de uso do TMS (botoes na hora? registro logo apos a entrega?).
const usoTms = require('./uso-tms');
// Planilha "RETIRADA E ENVIO DE MATERIAL" da expedicao (formulario de ocorrencia).
const materiaisRota = require('./materiais-rota');
const relatorioSemanal = require('./relatorio-semanal');
const materialStatus = require('./material-status');
materialStatus.configurar({ db, lojasPes, chaveLoja });

// ================= REDE DE SEGURANCA (CRASH) =================
// Registra qualquer erro fatal com data/hora num arquivo proprio para termos
// historico (o out/error.log sao truncados a cada start). Numa excecao nao
// capturada o processo fica em estado indefinido: logamos e saimos com codigo
// 1 para o watchdog subir um processo novo e limpo (~1 min).
function _registrarCrash(tipo, err) {
    const linha = `[${new Date().toISOString()}] [${tipo}] ${err && err.stack ? err.stack : err}\n`;
    try { fs.appendFileSync(path.join(__dirname, '..', 'logs', 'crash.log'), linha); } catch (_) {}
    // console tambem pode ser o canal quebrado (ver abaixo): nunca deixar a
    // tentativa de RELATAR um crash virar o proximo crash.
    try { console.error(linha.trim()); } catch (_) {}
}

// Falhar ao ESCREVER log nao e motivo para derrubar a producao. Aqui os logs
// vao para um share de rede (o start-server.vbs redireciona para logs\out.log,
// que vive em \\empresa.local\fileserver): num blip de rede o writeSync por
// tras do console.log lanca UNKNOWN, cai no uncaughtException e mata o processo.
// Foi o que aconteceu em 13/07 e 14/07 — nos dois casos a chamada fatal era o
// console.log que anuncia o backup CONCLUIDO. O dump tinha dado certo; o
// servidor morreu ao contar isso.
const _CODIGOS_ESCRITA_LOG = new Set(['UNKNOWN', 'EPIPE', 'EIO', 'ENOSPC', 'EBADF', 'ENXIO']);
let _falhasEscritaLog = 0;
function _ehFalhaDeEscritaDeLog(err) {
    if (!err || !_CODIGOS_ESCRITA_LOG.has(err.code)) return false;
    const pilha = String(err.stack || '');
    return pilha.includes('node:internal/console/')
        || pilha.includes('sync_write_stream')
        || err.syscall === 'write';
}

process.on('unhandledRejection', (motivo) => {
    // Promise rejeitada sem catch: registra mas NAO derruba o servidor.
    _registrarCrash('unhandledRejection', motivo);
});
process.on('uncaughtException', (err) => {
    if (_ehFalhaDeEscritaDeLog(err)) {
        _falhasEscritaLog++;
        // Direto no arquivo, sem console: e o canal que acabou de falhar.
        try {
            fs.appendFileSync(
                path.join(__dirname, '..', 'logs', 'crash.log'),
                `[${new Date().toISOString()}] [escrita-de-log-ignorada #${_falhasEscritaLog}] ` +
                `${err.code} ${err.syscall || ''} — servidor segue no ar\n`
            );
        } catch (_) { /* se nem o arquivo aceita, seguir vivo e o que importa */ }
        return; // NAO derruba: perder uma linha de log << perder a producao
    }
    _registrarCrash('uncaughtException', err);
    process.exit(1); // watchdog reinicia limpo
});

const app = express();
// Nao divulga a tecnologia/framework usado pelo servidor.
app.disable('x-powered-by');
const publicDir = path.join(__dirname, '..', 'public');
const htmlDir = path.join(publicDir, 'html');

// ================= CABECALHOS DE SEGURANCA =================
// Espelha o modulo Java (ciberseguranca-java/SecurityHeaders).
// A CSP foi afinada ao front-end real desta app: ha 1 script inline, ~233
// handlers inline (onclick=) e ~707 estilos inline, por isso script/style
// precisam de 'unsafe-inline'; e libs vem de cdnjs e jsdelivr. Ainda assim a
// CSP restringe object/embed, framing, base-uri, form-action e quais hosts
// externos podem servir script.
const CSP_DIRETIVAS = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "form-action 'self'",
    // tile.openstreetmap.org: fundo do mapa da aba 🛰 Frota (so imagem).
    "img-src 'self' data: blob: https://tile.openstreetmap.org",
    "font-src 'self' data: https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
    "connect-src 'self'"
].join('; ');
// Modo da CSP: 'report' (so observa), 'enforce' (bloqueia) ou 'off'.
// O padrao e 'enforce'; 'report' fica disponivel para diagnostico controlado.
const CSP_MODE = String(process.env.CSP_MODE || 'enforce').toLowerCase();

// Registrado antes dos estaticos para valer em todas as respostas.
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    // geolocation=(self): a propria pagina PRECISA do GPS para capturar a
    // localizacao do comprovante de entrega (capturarLocalizacaoPOD). Com a
    // lista vazia o navegador bloqueia ate a origem atual, e o botao "capturar
    // localizacao" caia sempre no erro. microphone/camera seguem fechados: a
    // foto do POD usa <input type="file">, que nao depende de getUserMedia.
    res.setHeader('Permissions-Policy', 'geolocation=(self), microphone=(), camera=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    if (CSP_MODE === 'enforce') {
        res.setHeader('Content-Security-Policy', CSP_DIRETIVAS);
    } else if (CSP_MODE !== 'off') {
        res.setHeader('Content-Security-Policy-Report-Only', CSP_DIRETIVAS);
    }
    if (conexaoSegura(req)) {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
});

// ================= MIDDLEWARES =================
// COMPRESSAO (gzip). Tem de vir ANTES do express.static e das rotas: o
// middleware embrulha o res, entao so alcanca quem responde DEPOIS dele.
//
// Medido em 06/08/2026: GET /ocorrencias devolvia 2,13 MB de JSON -> 95 KB
// (23x), o conjunto de /js caiu 1,29 MB -> 365 KB e o index.html 260 KB -> 38 KB.
// Pesa principalmente para quem acessa de fora pelo Funnel.
//
// O filtro protege o SSE de /eventos: comprimir um stream faz o gzip segurar os
// bytes no buffer esperando mais dados, e o evento so chega ao navegador muito
// depois (ou nunca) — o "dados:mudou" pararia de atualizar as telas sozinho.
// O compression ja respeita o "Cache-Control: no-transform" que /eventos manda,
// mas nao dependemos so disso: quem mexer naquele cabecalho um dia nao vai
// lembrar que a compressao ia junto.
if (compression) {
    app.use(compression({
        filter: (req, res) => {
            const tipo = res.getHeader('Content-Type');
            if (tipo && String(tipo).includes('text/event-stream')) return false;
            return compression.filter(req, res);
        },
    }));
}

app.use('/js', express.static(path.join(publicDir, 'js'), { fallthrough: false }));
app.use('/css', express.static(path.join(publicDir, 'css'), { fallthrough: false }));
app.use('/img', express.static(path.join(publicDir, 'img'), { fallthrough: false }));
app.use(express.static(publicDir));
app.get('/', (req, res) => {
    res.sendFile(path.join(htmlDir, 'index.html'));
});
app.get('/index.html', (req, res) => {
    res.sendFile(path.join(htmlDir, 'index.html'));
});
app.get('/torre.html', (req, res) => {
    res.sendFile(path.join(htmlDir, 'torre.html'));
});
// CORS: nunca usar `origin: true` como fallback junto com credenciais. Isso
// refletia qualquer origem (ou produzia `*` + credentials), combinação que o
// navegador rejeita e que deixa a política de acesso ambígua. A aplicação
// principal é same-origin; origens extras precisam ser declaradas no .env,
// separadas por vírgula ou ponto e vírgula.
const CORS_ORIGENS_PERMITIDAS = new Set(
    String(process.env.ALLOWED_ORIGIN || '')
        .split(/[,;\s]+/)
        .map((origem) => origem.trim())
        .filter((origem) => origem && origem !== '*'),
);
if (String(process.env.ALLOWED_ORIGIN || '').includes('*')) {
    console.warn('[cors] wildcard ignorado: use origens explicitas em ALLOWED_ORIGIN.');
}
app.use(cors({
    origin: (origem, callback) => {
        // Navegador sem Origin (curl, health-check e chamadas same-origin)
        // continua funcionando normalmente.
        if (!origem || CORS_ORIGENS_PERMITIDAS.has(origem)) return callback(null, true);
        return callback(null, false);
    },
    credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// ================= UTILITÁRIOS =================
function vazioParaNull(valor) {
    return valor === undefined || valor === null || valor === '' ? null : valor;
}

function textoParaBoolean(valor) {
    if (valor === true) return true;
    if (valor === false) return false;

    const texto = String(valor || '').trim().toLowerCase();

    return texto === 'true' || texto === 'sim' || texto === 'feito' || texto === 'realizou';
}

// calcularMinutos: fonte unica em ./tempo.js (require no topo).

// Mescla linhas de ranking por loja que sao a MESMA loja em grafias diferentes
// (ex.: "AMERICAS"/"AMÉRICAS", "ITAGUAI I"/"ITAGUAÍ 1"), usando a mesma
// canonizacao do resto do sistema (canonizarLoja). Soma os campos numericos
// indicados e mantem o rotulo canonico. Assim os rankings agregados NO SERVIDOR
// nao mostram loja duplicada (o front ja unifica via rotuloLoja). NAO altera a
// gravacao — a loja continua guardada como a chave, que deriva rota/tolerancia.
function mesclarRankingPorLoja(linhas, campoLoja, camposSoma) {
    const mapa = new Map();
    for (const linha of linhas || []) {
        const bruto = linha[campoLoja];
        // Sentinelas tipo "(sem loja)" nao passam pela canonizacao.
        const canon = /^\(/.test(String(bruto ?? '')) ? bruto : (canonizarLoja(bruto) || bruto);
        const existente = mapa.get(canon);
        if (existente) {
            for (const c of camposSoma) existente[c] = (Number(existente[c]) || 0) + (Number(linha[c]) || 0);
        } else {
            mapa.set(canon, { ...linha, [campoLoja]: canon });
        }
    }
    return [...mapa.values()];
}

function numeroSeguro(valor) {
    const numero = Number(valor);
    return Number.isFinite(numero) ? numero : 0;
}

function indicadoresEntrega(dados) {
    const agendada = vazioParaNull(dados.hora_agendada_loja);
    const chegada = vazioParaNull(dados.hora_chegada);
    // IN FULL DERIVADO DA OCORRENCIA.
    // O campo "Entrega Completa?" vive numa secao escondida do formulario e
    // quase nunca vem preenchido. Antes, em branco virava FALSE e derrubava o
    // OTIF de entregas perfeitas. Agora: se veio informado, manda o informado;
    // se nao veio, a ocorrencia lancada decide (ver public/js/kpi-ocorrencia.js).
    // Entrega sem ocorrencia = completa. Ela ENTRA no KPI, e entra como boa.
    const informado = vazioParaNull(dados.entrega_completa);
    const relacaoKpi = classificarOcorrenciaKpi(dados);
    const completa = informado === null
        ? relacaoKpi.inFull
        : textoParaBoolean(informado);
    // Tolerancia de TOLERANCIA_ATRASO_MIN minutos aplicada dentro de
    // classificarSla() — ver back/tempo.js.
    const slaStatus = classificarSla(agendada, chegada);

    const otifStatus =
        slaStatus === 'No prazo' && completa
            ? 'Conforme'
            : slaStatus === 'Sem prazo'
              ? 'Sem SLA'
              : 'Nao conforme';
    // Custo so vira numero se ALGUM campo de custo veio; senao fica null, para
    // nao inflar a cobertura do painel de custo com zeros que ninguem digitou.
    const temCusto = ['km_real', 'custo_km', 'pedagio', 'custo_reentrega', 'custo_ocorrencia']
        .some((campo) => vazioParaNull(dados[campo]) !== null);
    const custoTotal = temCusto
        ? numeroSeguro(dados.km_real) * numeroSeguro(dados.custo_km) +
          numeroSeguro(dados.pedagio) +
          numeroSeguro(dados.custo_reentrega) +
          numeroSeguro(dados.custo_ocorrencia)
        : null;

    return { completa, slaStatus, otifStatus, custoTotal, relacaoKpi };
}

const tableColumnsCache = new Map();

async function obterColunasTabela(nomeTabela) {
    if (tableColumnsCache.has(nomeTabela)) {
        return tableColumnsCache.get(nomeTabela);
    }

    const result = await db.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
    `, [nomeTabela]);

    const colunas = new Set(result.rows.map((row) => row.column_name));
    tableColumnsCache.set(nomeTabela, colunas);
    return colunas;
}

async function paresComColunasExistentes(nomeTabela, dados) {
    const colunas = await obterColunasTabela(nomeTabela);

    return Object.entries(dados).filter(([campo, valor]) => (
        colunas.has(campo) &&
        valor !== undefined
    ));
}

async function inserirComColunasExistentes(nomeTabela, dados) {
    const pares = await paresComColunasExistentes(nomeTabela, dados);

    if (pares.length === 0) {
        throw new Error(`Nenhuma coluna valida encontrada para ${nomeTabela}.`);
    }

    const campos = pares.map(([campo]) => campo);
    const valores = pares.map(([, valor]) => valor);
    const parametros = campos.map((_, index) => `$${index + 1}`);

    const result = await db.query(`
        INSERT INTO ${nomeTabela} (${campos.join(', ')})
        VALUES (${parametros.join(', ')})
        RETURNING *;
    `, valores);

    return result.rows[0];
}

async function atualizarComColunasExistentes(nomeTabela, id, dados) {
    const pares = await paresComColunasExistentes(nomeTabela, dados);

    if (pares.length === 0) {
        throw new Error(`Nenhuma coluna valida encontrada para ${nomeTabela}.`);
    }

    const valores = pares.map(([, valor]) => valor);
    const sets = pares.map(([campo], index) => `${campo} = $${index + 1}`);

    const result = await db.query(`
        UPDATE ${nomeTabela} SET
            ${sets.join(',\n            ')}
        WHERE id = $${valores.length + 1}
        RETURNING *;
    `, [...valores, id]);

    return result;
}

// ================================================================
// SEED de cadastros — semeia a base canonica (motoristas, placas,
// ajudantes, rotas e lojas) na tabela `cadastros`, para que o BANCO seja
// a FONTE UNICA de verdade (antes a base ficava so hardcoded no front, em
// 5 arquivos, gerando divergencia). Byte-exato com as listas atuais.
// Idempotente: ON CONFLICT (tipo,valor) DO NOTHING — nunca sobrescreve
// nem apaga; preserva o que o usuario ocultou/adicionou. Seguro re-rodar a
// cada boot. As 12 pseudo-lojas de classificacao (rota "EXTRA-ENTREGA") NAO
// sao semeadas: continuam apenas no mapa lojasRotas do codigo (front).
// ================================================================
const SEED_CADASTROS = {
    motoristas: [
        "RENATO MORAES", "SILVIO RAMOS", "FABIO NUNES", "MAURO DIAS", "NELSON PRADO", "HUGO TAVARES",
        "TIAGO DE MELO", "GILSON REIS", "SAMUEL COSTA", "CELSO BRITO", "EDSON", "RUBENS LIMA",
        "IVAN MOTA", "OTAVIO CRUZ", "ANTONIO LUZ", "NILTON",
    ],
    placas: [
        "FKG6J16", "FKP2S22", "FKM0P20", "FKN1R21", "FKD3F13", "FKJ8M18",
        "FKA0C10", "FKF5H15", "FKB1D11", "FKC2E12", "FKE4G14", "FKO1007",
        "FKK9N19", "FKR3T23",
    ],
    ajudantes: [
        "JUNIOR", "ARTUR", "KLEBER", "YAGO", "NATAN", "OSCAR",
        "VICTOR D", "PEDRO A", "LUCAS C", "VICTOR HUGO", "DAVI FREITAS", "IAGO C",
        "WILSON JR", "ELIAS", "PEDRO LUCAS", "VALTER", "YURI (BALANÇO)", "CAIO L",
        "ENZO L", "LUCAS L", "PEDRO L", "MAYCON", "LUIZ V",
    ],
    rotas: [
        "BAIXADA III", "Z.NORTE I", "Z.NORTE II",
        "Z.OESTE I", "Z.OESTE II", "Z.OESTE IV",
        "ALTERNATIVA I", "CENTRO E Z.SUL", "BAIXADA II",
        "BAIXADA I+R.SERRENA", "R.LAGOS", "NORTE FLUMINENSE",
        "EXTRA-ENTREGA",
    ],
    // 93 lojas reais (valor = chave UPPER_SNAKE, extra.rota = grafia antiga).
    // As 12 pseudo-lojas EXTRA-ENTREGA ficam so no codigo (lojasRotas).
    lojas: [
        ["GUADALUPE", "BAIXADA III"], ["CARIOCA", "BAIXADA III"], ["VIA_BRASIL", "BAIXADA III"],
        ["GRANDE_RIO", "BAIXADA III"], ["VILAR_DOS_TELES_II", "BAIXADA III"], ["SAO_JOAO_I", "BAIXADA III"],
        ["MADUREIRA_II", "Z.NORTE I"], ["MADUREIRA_IV", "Z.NORTE I"], ["MADUREIRA_I", "Z.NORTE I"],
        ["TAQUARA_PLAZA", "Z.NORTE I"], ["TAQUARA", "Z.NORTE I"], ["CENTER", "Z.NORTE I"],
        ["FREGUESIA", "Z.NORTE I"], ["RIO_DAS_PEDRAS", "Z.NORTE I"], ["METROPOLITANO", "Z.NORTE I"],
        ["NOVA_AMERICA", "Z.NORTE II"], ["NORTE", "Z.NORTE II"], ["MEIER", "Z.NORTE II"],
        ["IGUATEMI", "Z.NORTE II"], ["TIJUCA_II", "Z.NORTE II"], ["DOWNTOWN", "Z.NORTE II"],
        ["AMERICAS", "Z.NORTE II"], ["RECREIO", "Z.NORTE II"], ["PONTAL", "Z.NORTE II"],
        ["SANTA_CRUZ_III", "Z.OESTE I"], ["SANTA_CRUZ_I", "Z.OESTE I"], ["SANTA_CRUZ_II", "Z.OESTE I"],
        ["ITAGUAI", "Z.OESTE I"], ["ITAGUAI_II", "Z.OESTE I"], ["ANGRA_DOS_REIS", "Z.OESTE I"],
        ["CAMPO_GRANDE_III", "Z.OESTE II"], ["PASSEIO", "Z.OESTE II"], ["BANGU_I", "Z.OESTE II"],
        ["BANGU_V", "Z.OESTE II"], ["BANGU_IV", "Z.OESTE II"], ["SULACAP", "Z.OESTE II"],
        ["PARK", "Z.OESTE IV"], ["OLINDA_ELLIS", "Z.OESTE IV"], ["WEST_III", "Z.OESTE IV"],
        ["MAX_SHOPPING", "Z.OESTE IV"], ["NITEROI_IV", "ALTERNATIVA I"], ["NITEROI_II", "ALTERNATIVA I"],
        ["SAO_GONÇALO_I", "ALTERNATIVA I"], ["SAO_GONÇALO_II", "ALTERNATIVA I"], ["SAO_GONÇALO_IV", "ALTERNATIVA I"],
        ["ALCANTARA", "ALTERNATIVA I"], ["ITABORAI_IV", "ALTERNATIVA I"], ["ITABORAI_III", "ALTERNATIVA I"],
        ["NOVA_FRIBURGO", "ALTERNATIVA I"], ["DJOFFER", "ALTERNATIVA I"], ["TERESOPOLIS", "ALTERNATIVA I"],
        ["COPACABANA_I", "CENTRO E Z.SUL"], ["COPACABANA_II", "CENTRO E Z.SUL"], ["CENTRO_I", "CENTRO E Z.SUL"],
        ["CENTRO_II", "CENTRO E Z.SUL"], ["ILHA", "CENTRO E Z.SUL"], ["BONSUCESSO_II", "CENTRO E Z.SUL"],
        ["PENHA", "CENTRO E Z.SUL"], ["CAXIAS_CENTRO", "BAIXADA II"], ["CAXIAS_I", "BAIXADA II"],
        ["OUTLET", "BAIXADA II"], ["MAGE_II", "BAIXADA II"], ["PIABETA", "BAIXADA II"],
        ["STA_CRUZ_DA_SERRA", "BAIXADA II"], ["LOTE_XV", "BAIXADA II"], ["NILOPOLIS_II", "BAIXADA I+R.SERRENA"],
        ["MESQUITA", "BAIXADA I+R.SERRENA"], ["N_IGUAÇU_I", "BAIXADA I+R.SERRENA"], ["N_IGUAÇU_III", "BAIXADA I+R.SERRENA"],
        ["TOP", "BAIXADA I+R.SERRENA"], ["N_IGUAÇU_II", "BAIXADA I+R.SERRENA"], ["QUEIMADOS", "BAIXADA I+R.SERRENA"],
        ["BARRA_MANSA", "BAIXADA I+R.SERRENA"], ["BARRA_DO_PIRAI", "BAIXADA I+R.SERRENA"], ["VALENCA", "BAIXADA I+R.SERRENA"],
        ["TRES_RIOS", "BAIXADA I+R.SERRENA"], ["MARICA_I", "R.LAGOS"], ["SAQUAREMA_II", "R.LAGOS"],
        ["ARARUAMA", "R.LAGOS"], ["IGUABA", "R.LAGOS"], ["SAO_P_ALDEIA", "R.LAGOS"],
        ["BUZIOS", "R.LAGOS"], ["CABO_FRIO_I", "R.LAGOS"], ["CABO_FRIO_III", "R.LAGOS"],
        ["ARRAIAL_DO_CABO", "R.LAGOS"], ["MARICA_II", "R.LAGOS"], ["RIO_BONITO_II", "NORTE FLUMINENSE"],
        ["RIO_DAS_OSTRAS", "NORTE FLUMINENSE"], ["MACAE_I", "NORTE FLUMINENSE"], ["MACAE_III", "NORTE FLUMINENSE"],
        ["CAMPOS_I", "NORTE FLUMINENSE"], ["CAMPOS_III", "NORTE FLUMINENSE"], ["ITAPERUNA_II", "NORTE FLUMINENSE"],
    ],
};

// Ramal telefonico de cada loja (chave do cadastro -> ramal do PABX). Fonte:
// portal de telefonia da TI (suporte.exemplo.com.br/telefonia/ramais/),
// filtrado por Setor = LOJA e casado com as 93 lojas do cadastro. Fica junto
// do SEED porque e atributo da loja, igual a rota: entra em cadastros.extra
// ({ rota, ramal }) e a UI edita de la em diante — esta lista e so a semente.
// 91 das 93 lojas tem ramal; so DJOFFER e ITABORAI_III nao constam no portal.
// MAX_SHOPPING aparece la como "KM 32" (confirmado pelo Transporte). Ramais que
// existem no portal mas nao sao loja do cadastro (BELFORD ROXO, RESENDE,
// FEIRAO MAGARCA, MEGA BAZAR MAGARCA, PE MAGARCA) ficam de fora de proposito:
// cadastrar loja nova aqui mudaria a classificacao por rota.
const SEED_RAMAIS_LOJA = {
    'ALCANTARA': '1821', 'AMERICAS': '1616', 'ANGRA_DOS_REIS': '1639', 'ARARUAMA': '1823',
    'ARRAIAL_DO_CABO': '1617', 'BANGU_I': '1622', 'BANGU_IV': '1623', 'BANGU_V': '1867',
    'BARRA_DO_PIRAI': '1587', 'BARRA_MANSA': '1640', 'BONSUCESSO_II': '1851', 'BUZIOS': '1608',
    'CABO_FRIO_I': '1609', 'CABO_FRIO_III': '1620', 'CAMPOS_I': '1641', 'CAMPOS_III': '1868',
    'CAMPO_GRANDE_III': '1830', 'CARIOCA': '1666', 'CAXIAS_CENTRO': '1676', 'CAXIAS_I': '1677',
    'CENTER': '1836', 'CENTRO_I': '1678', 'CENTRO_II': '1679', 'COPACABANA_I': '1810',
    'COPACABANA_II': '1846', 'DOWNTOWN': '1842', 'FREGUESIA': '1681', 'GRANDE_RIO': '1682',
    'GUADALUPE': '1850', 'IGUABA': '1619', 'IGUATEMI': '1684', 'ILHA': '1685',
    'ITABORAI_IV': '1633', 'ITAGUAI': '1686', 'ITAGUAI_II': '1582', 'ITAPERUNA_II': '1862',
    'LOTE_XV': '1864', 'MACAE_I': '1643', 'MACAE_III': '1875', 'MADUREIRA_I': '1661',
    'MADUREIRA_II': '1660', 'MADUREIRA_IV': '1872', 'MAGE_II': '1861', 'MARICA_I': '1645',
    'MARICA_II': '1855', 'MAX_SHOPPING': '1852', 'MEIER': '1656', 'MESQUITA': '1688',
    'METROPOLITANO': '1857',
    'NILOPOLIS_II': '1662', 'NITEROI_II': '1690', 'NITEROI_IV': '1871', 'NORTE': '1826',
    'NOVA_AMERICA': '1665', 'NOVA_FRIBURGO': '1646', 'N_IGUAÇU_I': '1669', 'N_IGUAÇU_II': '1691',
    'N_IGUAÇU_III': '1833', 'OLINDA_ELLIS': '1655', 'OUTLET': '1847', 'PARK': '1845',
    'PASSEIO': '1873', 'PENHA': '1694', 'PIABETA': '1664', 'PONTAL': '1869',
    'QUEIMADOS': '1695', 'RECREIO': '1831', 'RIO_BONITO_II': '1698', 'RIO_DAS_OSTRAS': '1600',
    'RIO_DAS_PEDRAS': '1699', 'SANTA_CRUZ_I': '1822', 'SANTA_CRUZ_II': '1583', 'SANTA_CRUZ_III': '1801',
    'SAO_GONÇALO_I': '1802', 'SAO_GONÇALO_II': '1663', 'SAO_GONÇALO_IV': '1840', 'SAO_JOAO_I': '1667',
    'SAO_P_ALDEIA': '1610', 'SAQUAREMA_II': '1870', 'STA_CRUZ_DA_SERRA': '1828', 'SULACAP': '1621',
    'TAQUARA': '1863', 'TAQUARA_PLAZA': '1865', 'TERESOPOLIS': '1866', 'TIJUCA_II': '1658',
    'TOP': '1803', 'TRES_RIOS': '1634', 'VALENCA': '1647', 'VIA_BRASIL': '1804',
    'VILAR_DOS_TELES_II': '1808', 'WEST_III': '1809',
};

async function seedCadastros() {
    try {
        const simples = [
            ['motorista', SEED_CADASTROS.motoristas],
            ['placa', SEED_CADASTROS.placas],
            ['ajudante', SEED_CADASTROS.ajudantes],
            ['rota', SEED_CADASTROS.rotas],
        ];
        for (const [tipo, valores] of simples) {
            if (!valores || !valores.length) continue;
            const params = [];
            const linhas = valores.map((v) => {
                params.push(tipo, v);
                return `($${params.length - 1}, $${params.length}, false)`;
            });
            await db.query(
                `INSERT INTO cadastros (tipo, valor, oculto) VALUES ${linhas.join(', ')}
                 ON CONFLICT (tipo, valor) DO NOTHING`,
                params,
            );
        }
        // lojas: valor = chave (UPPER_SNAKE), extra = { rota } (grafia antiga)
        if (SEED_CADASTROS.lojas && SEED_CADASTROS.lojas.length) {
            const params = [];
            const linhas = SEED_CADASTROS.lojas.map(([valor, rota]) => {
                const ramal = SEED_RAMAIS_LOJA[valor] || null;
                params.push(valor, JSON.stringify(ramal ? { rota, ramal } : { rota }));
                return `('loja', $${params.length - 1}, false, $${params.length}::jsonb)`;
            });
            await db.query(
                `INSERT INTO cadastros (tipo, valor, oculto, extra) VALUES ${linhas.join(', ')}
                 ON CONFLICT (tipo, valor) DO NOTHING`,
                params,
            );
        }
        console.log(`[seedCadastros] base de cadastros garantida (idempotente).`);
    } catch (err) {
        // NUNCA derruba o boot (evita loop de restart do watchdog).
        console.error(`[seedCadastros] falha (ignorada):`, err.message);
    }
}

async function prepararBanco() {
    await db.query(`
        ALTER TABLE ocorrencias
        ADD COLUMN IF NOT EXISTS ocorrencia_responsavel TEXT;

        ALTER TABLE ocorrencias
        ADD COLUMN IF NOT EXISTS viagem_id INTEGER;

        ALTER TABLE ocorrencias
        ADD COLUMN IF NOT EXISTS parada_id INTEGER;

        ALTER TABLE ocorrencias
        ADD COLUMN IF NOT EXISTS transferencia_problema TEXT;

        ALTER TABLE ocorrencias
        ADD COLUMN IF NOT EXISTS transferencia_relato TEXT;

        ALTER TABLE ocorrencias
        ADD COLUMN IF NOT EXISTS sacola_status TEXT;

        ALTER TABLE ocorrencias
        ADD COLUMN IF NOT EXISTS sacola_relato TEXT;

        -- Almoxerifado e Material de Envio existiam no formulario desde sempre
        -- (Secao 8), mas nao tinham coluna: o front mandava, o INSERT nao
        -- listava e o texto era descartado em silencio. Quem escrevia "faltou
        -- item X" perdia o relato no salvar. Corrigido em 04/08/2026 —
        -- registro antigo fica NULL, nao da para recuperar o que se perdeu.
        ALTER TABLE ocorrencias
        ADD COLUMN IF NOT EXISTS almoxerifado_status TEXT;

        ALTER TABLE ocorrencias
        ADD COLUMN IF NOT EXISTS almoxerifado_relato TEXT;

        ALTER TABLE ocorrencias
        ADD COLUMN IF NOT EXISTS material_envio_status TEXT;

        ALTER TABLE ocorrencias
        ADD COLUMN IF NOT EXISTS material_envio_relato TEXT;

        -- Conferencia do material RETIRADO da loja (planilha da expedicao),
        -- par do material_envio_*; usado pelo relatorio de material.
        ALTER TABLE ocorrencias
        ADD COLUMN IF NOT EXISTS material_retirada_status TEXT;

        ALTER TABLE ocorrencias
        ADD COLUMN IF NOT EXISTS material_retirada_relato TEXT;

        ALTER TABLE ocorrencias
        ADD COLUMN IF NOT EXISTS material_campanha_qtd INTEGER;

        -- Material de campanha detalhado: quantidade por tipo de peca e de qual
        -- campanha ela e. material_campanha_qtd continua sendo o total (vem do TMS).
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS campanha_banner_qtd INTEGER;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS campanha_banner_campanha TEXT;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS campanha_folder_qtd INTEGER;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS campanha_folder_campanha TEXT;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS campanha_adesivo_qtd INTEGER;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS campanha_adesivo_campanha TEXT;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS campanha_quadro_qtd INTEGER;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS campanha_quadro_campanha TEXT;

        ALTER TABLE ocorrencias
        ADD COLUMN IF NOT EXISTS sacola_qtd INTEGER;

        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS sacola_p INTEGER;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS sacola_m INTEGER;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS sacola_g INTEGER;

        -- Retiradas (CX = caixa, RT = rack) previsto/realizado/divergencia. Estas seis
        -- ja eram usadas pelo INSERT de POST /ocorrencias e pelo UPDATE de PUT
        -- /ocorrencias/:id, mas nunca tiveram migration: existiam so porque foram
        -- criadas na mao no banco de producao. Num banco novo (ou apos restore limpo)
        -- salvar ocorrencia quebrava. divergencia e assinado - realizada menor que a
        -- prevista da negativo.
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS retirada_cx_prevista INTEGER;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS retirada_cx_realizada INTEGER;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS retirada_cx_divergencia INTEGER;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS retirada_rt_prevista INTEGER;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS retirada_rt_realizada INTEGER;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS retirada_rt_divergencia INTEGER;

        ALTER TABLE ocorrencias
        ADD COLUMN IF NOT EXISTS permanencia_justificativa TEXT;

        -- Rota informada diretamente (usada na importacao do controle de rotas,
        -- quando nao ha loja para derivar a rota via lojasRotas).
        ALTER TABLE ocorrencias
        ADD COLUMN IF NOT EXISTS rota TEXT;

        ALTER TABLE ocorrencias
        ADD COLUMN IF NOT EXISTS problema_operacional_tipo TEXT;

        ALTER TABLE ocorrencias
        ADD COLUMN IF NOT EXISTS problema_operacional_relato TEXT;

        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS pedido_numero TEXT;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS nota_fiscal TEXT;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS romaneio_numero TEXT;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS valor_carga NUMERIC(12,2);
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS entrega_completa BOOLEAN;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS sla_status TEXT;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS otif_status TEXT;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS ocorrencia_severidade TEXT;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS ocorrencia_status TEXT;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS causa_raiz TEXT;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS acao_corretiva TEXT;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS prazo_solucao DATE;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS km_previsto NUMERIC(10,2);
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS km_real NUMERIC(10,2);
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS custo_km NUMERIC(10,2);
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS pedagio NUMERIC(10,2);
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS custo_reentrega NUMERIC(12,2);
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS custo_ocorrencia NUMERIC(12,2);
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS custo_total NUMERIC(12,2);
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS malote_status TEXT;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS malote_observacao TEXT;
        -- Secao 11 do formulario. Nota livre de ATENCAO, nao de problema: serve
        -- para o que nao se enquadra como ocorrencia mas alguem precisa saber
        -- (loja em obra, portao trocado, recebedor novo). De proposito NAO
        -- alimenta ranking de culpa, KPI de ocorrencia aberta nem alerta.
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS observacao TEXT;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS pod_status TEXT;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS pod_documento_recebedor TEXT;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS pod_foto TEXT;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS pod_canhoto TEXT;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS pod_assinatura TEXT;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS gps_latitude NUMERIC(10,7);
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS gps_longitude NUMERIC(10,7);
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS pod_confirmado_em TIMESTAMP;
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS ocorrencia_fotos TEXT;

        -- Lixeira: NULL = ocorrencia ativa; com data = na lixeira (exclusao
        -- "soft"). O excluir do app so preenche esta coluna; a remocao fisica
        -- so acontece em "excluir definitivamente". Permite recuperar.
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS excluida_em TIMESTAMP;
        CREATE INDEX IF NOT EXISTS idx_ocorrencias_excluida_em ON ocorrencias (excluida_em);

        -- SEM ESTE INDICE o LEFT JOIN LATERAL de buscarViagensTms varre a tabela
        -- ocorrencias INTEIRA uma vez POR PARADA. O filtro e
        -- "oc.id = p.ocorrencia_id OR oc.parada_id = p.id": o OR so vira BitmapOr
        -- (dois index scans) se AMBOS os lados tiverem indice — a pkey cobre o
        -- primeiro, este cobre o segundo. Medido em 06/08/2026 com 811 paradas e
        -- 1001 ocorrencias: 156ms -> 5.8ms, e o custo deixa de ser
        -- O(paradas x ocorrencias), que so piora com o tempo.
        -- Parcial em excluida_em IS NULL porque a consulta sempre filtra assim.
        CREATE INDEX IF NOT EXISTS idx_ocorrencias_parada
            ON ocorrencias (parada_id) WHERE excluida_em IS NULL;

        -- termino_descarga = horario em que a descarga TERMINA. ATENCAO: e diferente de
        -- fim_descarga, que por motivos historicos guarda a SAIDA DA LOJA (ver server.js
        -- campos obrigatorios). A permanencia continua sendo inicio_descarga -> fim_descarga.
        ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS termino_descarga TIME;

        -- Rotas de viagem (pernoite): a rota sai da fabrica, para no hotel (dia 1),
        -- sai do hotel e volta a fabrica (dia 2). saida = saida da fabrica (dia 1),
        -- retorno = chegada a fabrica (dia 2). data = dia 1 (saida da fabrica).
        ALTER TABLE rotas_registradas ADD COLUMN IF NOT EXISTS is_viagem BOOLEAN DEFAULT FALSE;
        ALTER TABLE rotas_registradas ADD COLUMN IF NOT EXISTS parada_hotel VARCHAR(10);
        ALTER TABLE rotas_registradas ADD COLUMN IF NOT EXISTS saida_hotel VARCHAR(10);

        -- Quem analisou a rota. O select existe no formulario desde sempre
        -- (index.html, "Responsavel pela analise da rota") e o front sempre
        -- mandou o campo, mas nao havia coluna nem entrada na whitelist de
        -- criarRotasCRUD: o INSERT so grava as colunas listadas, entao a chave
        -- extra era descartada e o POST respondia 201 como se tivesse gravado.
        -- Quem escolhia o responsavel todo dia perdia o dado em silencio.
        -- Corrigido em 19/08/2026 — registro antigo fica NULL, nao da para
        -- recuperar: a auditoria do POST guardava so { recurso }.
        -- ATENCAO: esta coluna e a entrada na whitelist (criarRotasCRUD de
        -- 'rotas-registradas') andam JUNTAS. Listar o campo sem criar a coluna
        -- derruba o INSERT com 500 e quebra o salvamento de rota, que funciona.
        ALTER TABLE rotas_registradas ADD COLUMN IF NOT EXISTS responsavel_analise TEXT;

        CREATE TABLE IF NOT EXISTS tms_motoristas (
            id SERIAL PRIMARY KEY,
            nome TEXT NOT NULL UNIQUE,
            cnh TEXT,
            telefone TEXT,
            ativo BOOLEAN NOT NULL DEFAULT TRUE,
            criado_em TIMESTAMP NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS tms_veiculos (
            id SERIAL PRIMARY KEY,
            placa TEXT NOT NULL UNIQUE,
            modelo TEXT,
            capacidade_volumes INTEGER,
            status TEXT NOT NULL DEFAULT 'Disponivel',
            criado_em TIMESTAMP NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS tms_rotas (
            id SERIAL PRIMARY KEY,
            nome TEXT NOT NULL UNIQUE,
            descricao TEXT,
            ativo BOOLEAN NOT NULL DEFAULT TRUE,
            criado_em TIMESTAMP NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS tms_lojas (
            id SERIAL PRIMARY KEY,
            codigo TEXT UNIQUE,
            nome TEXT NOT NULL,
            rota_id INTEGER REFERENCES tms_rotas(id) ON DELETE SET NULL,
            endereco TEXT,
            janela_recebimento TEXT,
            ativo BOOLEAN NOT NULL DEFAULT TRUE,
            criado_em TIMESTAMP NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS tms_viagens (
            id SERIAL PRIMARY KEY,
            codigo TEXT UNIQUE,
            data_viagem DATE NOT NULL,
            rota_id INTEGER REFERENCES tms_rotas(id) ON DELETE SET NULL,
            motorista_id INTEGER REFERENCES tms_motoristas(id) ON DELETE SET NULL,
            veiculo_id INTEGER REFERENCES tms_veiculos(id) ON DELETE SET NULL,
            ajudantes TEXT,
            volumes_previstos INTEGER,
            status TEXT NOT NULL DEFAULT 'Planejada',
            observacao TEXT,
            criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
            atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS tms_paradas (
            id SERIAL PRIMARY KEY,
            viagem_id INTEGER NOT NULL REFERENCES tms_viagens(id) ON DELETE CASCADE,
            ordem INTEGER NOT NULL,
            loja_id INTEGER REFERENCES tms_lojas(id) ON DELETE SET NULL,
            hora_prevista TIME,
            volumes_previstos INTEGER,
            status TEXT NOT NULL DEFAULT 'Pendente',
            observacao TEXT,
            ocorrencia_id INTEGER,
            criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
            atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_tms_viagens_data ON tms_viagens(data_viagem);
        CREATE INDEX IF NOT EXISTS idx_tms_paradas_viagem ON tms_paradas(viagem_id);

        ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS motorista_nome TEXT;
        ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS placa TEXT;
        ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS rota_nome TEXT;
        ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS material_campanha INTEGER;
        ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS sacola INTEGER;
        ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS sacola_p INTEGER;
        ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS sacola_m INTEGER;
        ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS sacola_g INTEGER;
        ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS responsavel_monitoramento TEXT;
        ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS hora_saida_fabrica TIME;
        -- Saida REAL da fabrica (botao "Saiu" do TMS). hora_saida_fabrica acima e
        -- o horario PLANEJADO (programacao); estes guardam o que aconteceu.
        -- origem: 'botao' = carimbo do servidor; 'ajuste' = horario digitado.
        ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS saida_real TIME;
        ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS saida_real_em TIMESTAMP;
        ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS saida_real_por TEXT;
        ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS saida_real_origem TEXT;
        -- Custos da viagem (lote Fiscal/CTE + custos). Tudo opcional; custo_total
        -- e derivado (frete+combustivel+pedagio+outros), calculado na leitura.
        ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS km_previsto NUMERIC(10,2);
        ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS km_real NUMERIC(10,2);
        ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS custo_frete NUMERIC(12,2);
        ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS custo_combustivel NUMERIC(12,2);
        ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS pedagio NUMERIC(12,2);
        ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS outros_custos NUMERIC(12,2);
        ALTER TABLE tms_paradas ADD COLUMN IF NOT EXISTS loja_nome TEXT;
        ALTER TABLE tms_paradas ADD COLUMN IF NOT EXISTS material_campanha INTEGER;
        ALTER TABLE tms_paradas ADD COLUMN IF NOT EXISTS sacola INTEGER;
        ALTER TABLE tms_paradas ADD COLUMN IF NOT EXISTS sacola_p INTEGER;
        ALTER TABLE tms_paradas ADD COLUMN IF NOT EXISTS sacola_m INTEGER;
        ALTER TABLE tms_paradas ADD COLUMN IF NOT EXISTS sacola_g INTEGER;
        -- Snapshot das secoes de remessa do Checklist Expedicao (por loja):
        -- materiais, plastico_bolha, caixa_azul, campanha e sacolas (com flag "carregado").
        ALTER TABLE tms_paradas ADD COLUMN IF NOT EXISTS remessas JSONB;
        -- Controle de emissao do CTE por LOJA/parada (aba "CTEs do dia").
        ALTER TABLE tms_paradas ADD COLUMN IF NOT EXISTS cte_concluido BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE tms_paradas ADD COLUMN IF NOT EXISTS cte_concluido_em TIMESTAMP;
        ALTER TABLE tms_paradas ADD COLUMN IF NOT EXISTS cte_concluido_por TEXT;
        ALTER TABLE tms_paradas ADD COLUMN IF NOT EXISTS prioridade INTEGER NOT NULL DEFAULT 2;
        ALTER TABLE tms_paradas ADD COLUMN IF NOT EXISTS retirada_cx INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE tms_paradas ADD COLUMN IF NOT EXISTS retirada_rt INTEGER NOT NULL DEFAULT 0;
        -- Pedidos importados de planilha/ERP ficam agrupados dentro da parada.
        -- JSONB preserva NF, pedido, volumes e outros campos sem quebrar o
        -- modelo atual de viagens criado manualmente ou pelo Checklist.
        ALTER TABLE tms_paradas ADD COLUMN IF NOT EXISTS pedidos JSONB;
        ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS importacao_chave TEXT;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tms_viagens_importacao_chave
            ON tms_viagens(importacao_chave)
            WHERE importacao_chave IS NOT NULL;

        -- Snapshot da planilha de PROGRAMACAO DE ROTAS (back/tms-programacao.js).
        -- Na viagem: rota/motorista/placa como vieram, saida, responsavel da
        -- fabrica, ref. do veiculo, codigo do rodape e a chave que faz a
        -- reimportacao reencontrar a mesma viagem. Na parada: PES/EMP, documentos
        -- (434/3386...), almoxarifado, sacola, carga WMS, frete e RT/CX da planilha.
        ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS programacao JSONB;
        ALTER TABLE tms_paradas ADD COLUMN IF NOT EXISTS programacao JSONB;
        -- Planilha de programacao que se atualiza sozinha (back/tms-programacao.js):
        -- uma linha por DIA que ja foi importado a mao. Guarda a aba usada, as rotas
        -- que o usuario mandou "Nao importar" (continuam fora) e o hash do que foi
        -- aplicado de cada rota (so rota que MUDOU e regravada a cada 5 min).
        CREATE TABLE IF NOT EXISTS tms_programacao_sync (
            data DATE PRIMARY KEY,
            arquivo TEXT,
            aba TEXT,
            arquivo_modificado TEXT,
            arquivo_tamanho BIGINT,
            ignoradas JSONB NOT NULL DEFAULT '[]'::jsonb,
            blocos_hash JSONB NOT NULL DEFAULT '{}'::jsonb,
            atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
        );

        ALTER TABLE tms_viagens ADD COLUMN IF NOT EXISTS checklist_origem_id INTEGER;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tms_viagens_checklist_origem
            ON tms_viagens(checklist_origem_id)
            WHERE checklist_origem_id IS NOT NULL;

        -- TABELA DE FRETE POR LOJA (ida/retorno) — usada na aba "CTEs do dia".
        -- A chave e o nome CANONICO da loja (chaveLoja), nao o loja_id: as
        -- paradas vem do Checklist Expedicao com loja_id nulo e so o nome, que
        -- aparece na base com e sem acento (MARICA/MARICÁ, N IGUAÇU/N.IGUAÇU).
        -- Populada por back/importar-fretes-loja.js (rode apos alterar precos).
        CREATE TABLE IF NOT EXISTS tms_fretes_loja (
            chave TEXT PRIMARY KEY,
            loja_nome TEXT NOT NULL,
            pes TEXT,
            emp TEXT,
            rota TEXT,
            frete_envio NUMERIC(12,2),
            frete_retorno NUMERIC(12,2),
            atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
        );
        -- na_conta = FALSE: parada que existe no TMS mas nao entra na conta de
        -- frete por decisao da operacao (ex.: DJOFFER). Diferente de "sem preco
        -- cadastrado" — sem essa distincao o total da rota avisaria "parcial"
        -- todo dia numa rota que na verdade esta fechada.
        ALTER TABLE tms_fretes_loja ADD COLUMN IF NOT EXISTS na_conta BOOLEAN NOT NULL DEFAULT TRUE;

        -- ROTEIRO PADRAO (analise de tempo de deslocamento):
        -- cada roteiro = uma rota com sua sequencia de paradas e horarios planejados.
        -- O tempo de deslocamento (fabrica->1a loja e loja->loja) e o tempo de
        -- descarga sao DERIVADOS dos horarios (calculados no front), nao armazenados.
        CREATE TABLE IF NOT EXISTS roteiros_padrao (
            id SERIAL PRIMARY KEY,
            rota_nome TEXT NOT NULL,
            descricao TEXT,
            dia_semana TEXT,
            hora_saida_fabrica TIME,
            ativo BOOLEAN NOT NULL DEFAULT TRUE,
            criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
            atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS roteiros_padrao_paradas (
            id SERIAL PRIMARY KEY,
            roteiro_id INTEGER NOT NULL REFERENCES roteiros_padrao(id) ON DELETE CASCADE,
            ordem INTEGER NOT NULL,
            loja_nome TEXT NOT NULL,
            km NUMERIC(10,2),
            hora_chegada TIME,
            hora_saida TIME,
            observacao TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_roteiros_paradas_roteiro
            ON roteiros_padrao_paradas(roteiro_id);

        CREATE TABLE IF NOT EXISTS sistema_usuarios (
            id SERIAL PRIMARY KEY,
            nome TEXT NOT NULL,
            usuario TEXT NOT NULL UNIQUE,
            senha_hash TEXT NOT NULL,
            senha_salt TEXT NOT NULL,
            perfil TEXT NOT NULL CHECK (perfil IN ('ADM', 'OPERADOR')),
            ativo BOOLEAN NOT NULL DEFAULT TRUE,
            criado_em TIMESTAMP NOT NULL DEFAULT NOW()
        );
        -- Controle de acesso por usuario/modulo (2026-07-17):
        --   super_adm  = o "adm universal" (rafael.mendes). SO ele gerencia usuarios
        --                e define permissoes. Ve e faz tudo.
        --   permissoes = lista JSON de chaves de modulo que um perfil CUSTOM enxerga.
        -- Presets: ADM => tudo; OPERADOR => whitelist legada; CUSTOM => so os
        -- modulos listados em permissoes (ex.: gean => ["controle-uber"]).
        ALTER TABLE sistema_usuarios DROP CONSTRAINT IF EXISTS sistema_usuarios_perfil_check;
        ALTER TABLE sistema_usuarios ADD CONSTRAINT sistema_usuarios_perfil_check CHECK (perfil IN ('ADM','OPERADOR','CUSTOM'));
        ALTER TABLE sistema_usuarios ADD COLUMN IF NOT EXISTS super_adm BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE sistema_usuarios ADD COLUMN IF NOT EXISTS permissoes JSONB NOT NULL DEFAULT '[]'::jsonb;

        CREATE TABLE IF NOT EXISTS sistema_sessoes (
            id SERIAL PRIMARY KEY,
            usuario_id INTEGER NOT NULL REFERENCES sistema_usuarios(id) ON DELETE CASCADE,
            token_hash TEXT NOT NULL UNIQUE,
            expira_em TIMESTAMP NOT NULL,
            criado_em TIMESTAMP NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_sistema_sessoes_token ON sistema_sessoes(token_hash);

        CREATE TABLE IF NOT EXISTS sistema_auditoria (
            id SERIAL PRIMARY KEY,
            usuario_id INTEGER,
            usuario_nome TEXT,
            acao TEXT NOT NULL,
            recurso TEXT NOT NULL,
            recurso_id TEXT,
            dados JSONB,
            ip TEXT,
            criado_em TIMESTAMP NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_auditoria_usuario ON sistema_auditoria(usuario_id);
        CREATE INDEX IF NOT EXISTS idx_auditoria_criado ON sistema_auditoria(criado_em DESC);

        CREATE TABLE IF NOT EXISTS sistema_config (
            chave TEXT PRIMARY KEY,
            valor JSONB NOT NULL,
            atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS docas (
            id SERIAL PRIMARY KEY,
            filial TEXT NOT NULL,
            loja TEXT NOT NULL,
            supervisor TEXT,
            carrinho_4_rodas TEXT,
            carrinho_2_rodas TEXT,
            sem_carrinho_apos_horario TEXT,
            horario TEXT,
            autorizacao_previa TEXT,
            observacao TEXT,
            criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
            atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_docas_filial ON docas (filial);
        CREATE INDEX IF NOT EXISTS idx_docas_loja ON docas (loja);

        CREATE TABLE IF NOT EXISTS ocorrencias_avulsas (
            id SERIAL PRIMARY KEY,
            data_ocorrencia DATE NOT NULL,
            titulo TEXT,
            descricao TEXT NOT NULL,
            culpa TEXT,
            status TEXT NOT NULL DEFAULT 'Aberta',
            criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
            atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_ocorrencias_avulsas_data ON ocorrencias_avulsas(data_ocorrencia DESC);

        ALTER TABLE ocorrencias_avulsas ADD COLUMN IF NOT EXISTS hora_ocorrencia TEXT;
        ALTER TABLE ocorrencias_avulsas ADD COLUMN IF NOT EXISTS escopo TEXT NOT NULL DEFAULT 'GERAL';
        ALTER TABLE ocorrencias_avulsas ADD COLUMN IF NOT EXISTS viagem_id INTEGER REFERENCES tms_viagens(id) ON DELETE SET NULL;
        ALTER TABLE ocorrencias_avulsas ADD COLUMN IF NOT EXISTS tipo_problema TEXT;
        ALTER TABLE ocorrencias_avulsas ADD COLUMN IF NOT EXISTS rota_nome TEXT;
        ALTER TABLE ocorrencias_avulsas ADD COLUMN IF NOT EXISTS motorista_nome TEXT;
        ALTER TABLE ocorrencias_avulsas ADD COLUMN IF NOT EXISTS loja TEXT;
        ALTER TABLE ocorrencias_avulsas ADD COLUMN IF NOT EXISTS fotos TEXT;
        ALTER TABLE ocorrencias_avulsas ADD COLUMN IF NOT EXISTS ajudante_culpado TEXT;
        -- Nota livre, separada da descricao: a descricao conta O QUE aconteceu
        -- (e obrigatoria); a observacao guarda o complemento de quem trata o
        -- caso (combinado com a loja, retorno do setor, numero de protocolo).
        ALTER TABLE ocorrencias_avulsas ADD COLUMN IF NOT EXISTS observacao TEXT;
        CREATE INDEX IF NOT EXISTS idx_ocorrencias_avulsas_viagem ON ocorrencias_avulsas(viagem_id);
        CREATE INDEX IF NOT EXISTS idx_ocorrencias_avulsas_escopo ON ocorrencias_avulsas(escopo);

        -- Registro de CONDUTA do motorista (setor Transporte): comportamento,
        -- conflito, recusa de demanda etc. NADA a ver com as ocorrencias de
        -- ENTREGA (tabela ocorrencias) nem com as avulsas operacionais. Dado
        -- sensivel de pessoas -> exposto APENAS a ADM (rota fora da whitelist de
        -- operador + aba data-adm-only no front).
        CREATE TABLE IF NOT EXISTS ocorrencias_motorista (
            id SERIAL PRIMARY KEY,
            data_ocorrencia DATE NOT NULL,
            hora TEXT,
            motorista TEXT NOT NULL,
            envolvidos TEXT,
            tipo TEXT,
            gravidade TEXT NOT NULL DEFAULT 'Leve',
            relato TEXT NOT NULL,
            providencia TEXT,
            status TEXT NOT NULL DEFAULT 'Aberta',
            registrado_por TEXT,
            criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
            atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_ocorrencias_motorista_data ON ocorrencias_motorista(data_ocorrencia DESC);
        CREATE INDEX IF NOT EXISTS idx_ocorrencias_motorista_mot ON ocorrencias_motorista(motorista);

        -- Responsaveis de Loja: quem responde por cada loja (gerente/contato).
        -- Cadastro simples (loja + nome + telefone); acessivel a qualquer logado
        -- (rota na whitelist de operador). Uma loja pode ter varios responsaveis.
        CREATE TABLE IF NOT EXISTS loja_responsaveis (
            id SERIAL PRIMARY KEY,
            loja TEXT NOT NULL,
            nome TEXT NOT NULL,
            telefone TEXT,
            criado_em TIMESTAMP NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_loja_responsaveis_loja ON loja_responsaveis(loja);

        -- Controle de UBER (setor Transporte): registro/ledger das corridas de
        -- Uber que o Transporte solicita em nome de outra pessoa/setor. Dado de
        -- despesa -> exposto APENAS a ADM (rota fora da whitelist de operador +
        -- aba data-adm-only no front). setor_solicitante default 'Transporte'.
        CREATE TABLE IF NOT EXISTS controle_uber (
            id SERIAL PRIMARY KEY,
            data DATE NOT NULL,
            setor_pessoa_requisitante TEXT NOT NULL,
            solicitante TEXT NOT NULL,
            setor_solicitante TEXT NOT NULL DEFAULT 'Transporte',
            origem TEXT NOT NULL,
            destino TEXT NOT NULL,
            motivo TEXT,
            valor NUMERIC(12,2),
            registrado_por TEXT,
            criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
            atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_controle_uber_data ON controle_uber(data DESC);
        ALTER TABLE controle_uber ADD COLUMN IF NOT EXISTS motivo TEXT;

        -- Status de CADA item da planilha "RETIRADA E ENVIO DE MATERIAL"
        -- (foi / nao foi / pendente), marcado no formulario ou no relatorio de
        -- material. A planilha nao tem id de linha: a chave e
        -- data|tipo|loja(codigo PES)|material|transacao (back/materiais-rota.js).
        -- status: 'ok' | 'nao' | 'pendente'. Pendente/nao volta na proxima visita;
        -- marcar 'ok' depois atualiza esta mesma linha (resolvido_em_data).
        CREATE TABLE IF NOT EXISTS material_item_status (
            id SERIAL PRIMARY KEY,
            chave TEXT NOT NULL UNIQUE,
            data DATE NOT NULL,
            tipo TEXT NOT NULL,
            loja_codigo TEXT NOT NULL,
            loja TEXT,
            loja_planilha TEXT,
            material TEXT NOT NULL,
            quantidade TEXT,
            transacao TEXT,
            status TEXT NOT NULL,
            observacao TEXT,
            resolvido_em_data DATE,
            ocorrencia_id INTEGER,
            usuario_id INTEGER,
            usuario_nome TEXT,
            atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
        );
        ALTER TABLE material_item_status ADD COLUMN IF NOT EXISTS manual BOOLEAN NOT NULL DEFAULT FALSE;
        CREATE INDEX IF NOT EXISTS idx_material_item_loja ON material_item_status(loja_codigo, data);
        CREATE INDEX IF NOT EXISTS idx_material_item_data ON material_item_status(data);

        -- WMS / Erro de Volume: planilha de divergencias de volume por pedido.
        -- Entrada livre pela aba WMS (uma linha por erro encontrado).
        -- ATENCAO: pedido e volume sao CODIGOS DE SERIE (texto), nao numeros.
        -- Nao somar, nao converter para inteiro — zeros a esquerda, letras e
        -- hifens sao significativos e precisam ser gravados como digitados.
        CREATE TABLE IF NOT EXISTS wms_erro_volume (
            id SERIAL PRIMARY KEY,
            data DATE NOT NULL,
            loja TEXT NOT NULL,
            pedido TEXT,
            volume TEXT,
            descricao TEXT,
            registrado_por TEXT,
            criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
            atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_wms_erro_volume_data ON wms_erro_volume(data DESC);
        -- A primeira versao criou volume como INTEGER (leitura errada do campo).
        -- Converte para TEXT onde ainda estiver inteiro; no-op depois disso.
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'wms_erro_volume'
                   AND column_name = 'volume'
                   AND data_type <> 'text'
            ) THEN
                ALTER TABLE wms_erro_volume ALTER COLUMN volume TYPE TEXT USING volume::text;
            END IF;
        END $$;

        -- Chat entre usuarios: destinatario_id NULL = sala geral; preenchido = mensagem direta.
        CREATE TABLE IF NOT EXISTS sistema_chat_mensagens (
            id SERIAL PRIMARY KEY,
            remetente_id INTEGER NOT NULL REFERENCES sistema_usuarios(id) ON DELETE CASCADE,
            remetente_nome TEXT NOT NULL,
            destinatario_id INTEGER REFERENCES sistema_usuarios(id) ON DELETE CASCADE,
            texto TEXT NOT NULL,
            criado_em TIMESTAMP NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_chat_geral ON sistema_chat_mensagens(id) WHERE destinatario_id IS NULL;
        CREATE INDEX IF NOT EXISTS idx_chat_destinatario ON sistema_chat_mensagens(destinatario_id, id);
        CREATE INDEX IF NOT EXISTS idx_chat_remetente ON sistema_chat_mensagens(remetente_id, id);

        -- Ponteiro de leitura por usuario e conversa ('geral' ou 'u:<id>').
        CREATE TABLE IF NOT EXISTS sistema_chat_leitura (
            usuario_id INTEGER NOT NULL REFERENCES sistema_usuarios(id) ON DELETE CASCADE,
            conversa TEXT NOT NULL,
            ultima_lida_id INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (usuario_id, conversa)
        );

        -- Base de conhecimento da IA ("treino"): fatos/regras que a equipe ensina.
        -- A IA le as entradas ativas e usa como contexto em toda resposta do
        -- assistente global. Editavel pela UI (balao 🤖 -> aba Conhecimento).
        CREATE TABLE IF NOT EXISTS ia_conhecimento (
            id SERIAL PRIMARY KEY,
            titulo TEXT NOT NULL,
            conteudo TEXT NOT NULL,
            tags TEXT,
            criado_por TEXT,
            ativo BOOLEAN NOT NULL DEFAULT TRUE,
            criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
            atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_ia_conhecimento_ativo ON ia_conhecimento(ativo);

        -- Historico do chat com a IA (assistente global), por usuario. Alimenta
        -- a memoria de curto prazo (ultimos turnos entram no prompt).
        CREATE TABLE IF NOT EXISTS ia_chat_mensagens (
            id SERIAL PRIMARY KEY,
            usuario_id INTEGER NOT NULL REFERENCES sistema_usuarios(id) ON DELETE CASCADE,
            papel TEXT NOT NULL,
            texto TEXT NOT NULL,
            tela TEXT,
            criado_em TIMESTAMP NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_ia_chat_usuario ON ia_chat_mensagens(usuario_id, id);

        -- Registro de Ocorrencias Operacionais ("erros de loja") importado de CSV.
        -- Tabela analitica/independente: NAO alimenta os graficos/ranking de
        -- ocorrencias (tabela ocorrencias). Guarda a planilha tratada como veio.
        -- chave_dedupe garante idempotencia ao reimportar o mesmo arquivo.
        CREATE TABLE IF NOT EXISTS ocorrencias_operacionais (
            id SERIAL PRIMARY KEY,
            id_externo INTEGER,
            chave_dedupe TEXT UNIQUE,
            data_registro TIMESTAMP,
            data_ocorrencia DATE,
            mes_ano TEXT,
            semana INTEGER,
            dias_ate_registro INTEGER,
            responsavel TEXT,
            area TEXT,
            tipo TEXT,
            macro_falha TEXT,
            ishikawa TEXT,
            motorista TEXT,
            ajudantes TEXT,
            ajudantes2 TEXT,
            colaborador TEXT,
            rota TEXT,
            loja TEXT,
            fornecedor TEXT,
            tempo_atraso TEXT,
            impacto TEXT,
            divergencia TEXT,
            retrabalho TEXT,
            observacao TEXT,
            classificacao_erro TEXT,
            gravidade TEXT,
            atraso_estimado_min NUMERIC(10,2),
            origem_erro TEXT,
            criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
            atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_ocorr_oper_data ON ocorrencias_operacionais(data_ocorrencia DESC);
        CREATE INDEX IF NOT EXISTS idx_ocorr_oper_mesano ON ocorrencias_operacionais(mes_ano);
        CREATE INDEX IF NOT EXISTS idx_ocorr_oper_area ON ocorrencias_operacionais(area);

        -- Cadastro dinamico de motoristas, ajudantes e placas gerenciado pela UI
        -- (botao "Cadastrar" no menu). Cada linha e um (tipo, valor) unico.
        --   oculto=false -> valor ADICIONADO a lista (aparece nos selects).
        --   oculto=true  -> valor da lista-base ESCONDIDO da selecao.
        -- A lista efetiva de cada tipo = (base do codigo + adicionados) - ocultos.
        CREATE TABLE IF NOT EXISTS cadastros (
            id SERIAL PRIMARY KEY,
            tipo TEXT NOT NULL,
            valor TEXT NOT NULL,
            oculto BOOLEAN NOT NULL DEFAULT FALSE,
            criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
            UNIQUE (tipo, valor)
        );
        CREATE INDEX IF NOT EXISTS idx_cadastros_tipo ON cadastros(tipo);
        -- coluna extra: metadados por cadastro (ex.: loja -> {"rota":"BAIXADA III"}).
        ALTER TABLE cadastros ADD COLUMN IF NOT EXISTS extra JSONB;

        -- Meta de horario-limite por loja. Alimenta o hora_agendada_loja das
        -- entregas (cobertura do SLA/OTIF): quem nao tem horario proprio herda o
        -- da loja. A chave e a loja normalizada (UPPER+TRIM) p/ casar sem ruido.
        CREATE TABLE IF NOT EXISTS metas_loja (
            loja_chave TEXT PRIMARY KEY,
            loja TEXT NOT NULL,
            hora_agendada TEXT NOT NULL,
            atualizado_em TIMESTAMP NOT NULL DEFAULT NOW(),
            criado_por TEXT
        );
        -- "Loja não trabalha com horário": marcador POSITIVO por loja. Uma loja
        -- marcada assim tem hora_agendada NULL + sem_horario TRUE; suas entregas
        -- com horário em branco são n/a LEGÍTIMO (fora do SLA/OTIF e da cobrança
        -- de qualidade), distinto de "operador esqueceu" (loja com meta ou não
        -- cadastrada). Por isso hora_agendada passa a aceitar NULL.
        ALTER TABLE metas_loja ADD COLUMN IF NOT EXISTS sem_horario BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE metas_loja ALTER COLUMN hora_agendada DROP NOT NULL;

        -- Alertas proativos: o motor avaliarAlertas() insere aqui (dedup por
        -- 'chave'); o sino 🚨 do header lista os abertos e um canal externo
        -- opcional (Telegram) empurra os recentes. resolvido_em some da lista.
        CREATE TABLE IF NOT EXISTS alertas (
            id SERIAL PRIMARY KEY,
            chave TEXT UNIQUE NOT NULL,
            tipo TEXT NOT NULL,
            severidade TEXT NOT NULL DEFAULT 'media',
            titulo TEXT NOT NULL,
            detalhe TEXT,
            aba TEXT,
            ocorrencia_id INTEGER,
            evento_em DATE,
            criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
            lido_em TIMESTAMP,
            resolvido_em TIMESTAMP,
            notificado_em TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_alertas_abertos ON alertas(resolvido_em, criado_em DESC);
    `);

    // Backfill UNICO do controle de acesso por modulo (2026-07-17). Roda so uma
    // vez (marcador em sistema_config); depois o rafael.mendes define tudo pela tela
    // e um restart nao sobrescreve as escolhas dele.
    await backfillPermissoesV1();

    // Semeia a base canonica de cadastros (idempotente). Depois do CREATE/ALTER.
    await seedCadastros();

    // Preenche o ramal telefonico das lojas que ja existiam (uma vez so).
    await backfillRamaisLojaV1();

    // Cadastro unico de loja (PES), km entre lojas e tipo de frete dos carros.
    // Os dados vem de `node back/importar-lojas-pes.js` ou POST /lojas-pes/importar.
    await lojasPes.garantirTabelas(db);

    // Ciclo da viagem: chegada na fabrica, retorno, finalizacao automatica.
    await tmsCiclo.garantirColunas(db);

    // Pernoite: ocorrencias.dia_seguinte + backfill unico dos casos certos.
    try { await rastreador.garantirTabelas(db); }
    catch (err) { console.warn('[rastreador] tabelas (segue o boot):', err.message); }
    try { await rastreadorAoVivo.garantirTabela(db); }
    catch (err) { console.warn('[gps ao vivo] tabela (segue o boot):', err.message); }
    try { await pernoite.garantirColunas(db); }
    catch (err) { console.warn('[pernoite] falha (segue o boot):', err.message); }

    // Ressincroniza a sequência do id das ocorrências com os dados reais.
    // O proximo id passa a ser (maior id existente + 1), sem saltos.
    // Os ids ja usados (inclusive os de registros excluidos) permanecem como
    // lacunas e nunca sao reaproveitados.
    await ressincronizarSequenciaId('ocorrencias', 'id');

    tableColumnsCache.delete('ocorrencias');
}

// Aplica UMA vez o estado inicial de acesso pedido pelo Transporte (2026-07-17):
//  - rafael.mendes  => super_adm (adm universal, unico que gerencia acessos)
//  - gean         => CUSTOM, ve so o modulo "controle-uber"
//  - raphael      => CUSTOM sem modulos (o joao libera depois pela tela)
// Guardado por um marcador em sistema_config; nao reverte edicoes futuras.
async function backfillPermissoesV1() {
    try {
        const j = await db.query("SELECT valor FROM sistema_config WHERE chave = 'permissoes_setup_v1'");
        if (j.rowCount) return; // ja aplicado
        await db.query("UPDATE sistema_usuarios SET super_adm = TRUE WHERE LOWER(usuario) = 'rafael.mendes'");
        await db.query("UPDATE sistema_usuarios SET perfil = 'CUSTOM', permissoes = '[\"controle-uber\"]'::jsonb WHERE LOWER(usuario) = 'gean'");
        await db.query("UPDATE sistema_usuarios SET perfil = 'CUSTOM', permissoes = '[]'::jsonb WHERE LOWER(usuario) = 'raphael'");
        await db.query("INSERT INTO sistema_config (chave, valor) VALUES ('permissoes_setup_v1', to_jsonb(TRUE)) ON CONFLICT (chave) DO NOTHING");
        console.log('[backfillPermissoesV1] rafael.mendes=super_adm; gean=CUSTOM([controle-uber]); raphael=CUSTOM([]).');
    } catch (err) {
        console.warn('[backfillPermissoesV1] falha (segue o boot):', err.message);
    }
}

// Backfill UNICO dos ramais de loja (2026-09-03). O seed acima so vale para
// linha NOVA (ON CONFLICT DO NOTHING); as 93 lojas ja existiam sem ramal, entao
// aqui mesclamos o ramal no extra que ja esta la (|| preserva a rota) e SO onde
// ainda nao ha ramal — quem editar pela tela depois nunca e sobrescrito.
async function backfillRamaisLojaV1() {
    try {
        const j = await db.query("SELECT valor FROM sistema_config WHERE chave = 'ramais_loja_v1'");
        if (j.rowCount) return; // ja aplicado
        const chaves = Object.keys(SEED_RAMAIS_LOJA);
        const r = await db.query(`
            UPDATE cadastros c
               SET extra = COALESCE(c.extra, '{}'::jsonb) || jsonb_build_object('ramal', m.ramal)
              FROM (SELECT UNNEST($1::text[]) AS valor, UNNEST($2::text[]) AS ramal) m
             WHERE c.tipo = 'loja' AND c.valor = m.valor
               AND NULLIF(TRIM(COALESCE(c.extra->>'ramal', '')), '') IS NULL
        `, [chaves, chaves.map((k) => SEED_RAMAIS_LOJA[k])]);
        await db.query("INSERT INTO sistema_config (chave, valor) VALUES ('ramais_loja_v1', to_jsonb(TRUE)) ON CONFLICT (chave) DO NOTHING");
        console.log(`[backfillRamaisLojaV1] ramal preenchido em ${r.rowCount} loja(s).`);
    } catch (err) {
        console.warn('[backfillRamaisLojaV1] falha (segue o boot):', err.message);
    }
}

async function ressincronizarSequenciaId(tabela, coluna = 'id') {
    try {
        await db.query(`
            SELECT setval(
                pg_get_serial_sequence($1, $2),
                GREATEST(COALESCE((SELECT MAX(${coluna}) FROM ${tabela}), 1), 1),
                (SELECT MAX(${coluna}) IS NOT NULL FROM ${tabela})
            )
        `, [tabela, coluna]);
    } catch (err) {
        console.warn(`[ressincronizarSequenciaId] Falha em ${tabela}.${coluna}:`, err.message);
    }
}

// ================= RATE LIMIT (login) =================
const _loginAttempts = new Map();
const LOGIN_WINDOW_MS = 60000;
const LOGIN_LIMIT_CLIENT = 10;
const LOGIN_LIMIT_CONNECTION = 60;
const LOGIN_BUCKET_MAX = 20000;
setInterval(() => {
    const now = Date.now();
    for (const [chave, entry] of _loginAttempts) {
        if (now >= entry.resetAt) _loginAttempts.delete(chave);
    }
}, 300000);

function rateLimitLogin(req, res, next) {
    const now = Date.now();
    const ipConexao = String(req.socket?.remoteAddress || 'unknown').trim() || 'unknown';
    // CF-Connecting-IP e X-Real-IP sao usados apenas como identidade do cliente.
    // O limite por conexao permanece ativo, impedindo bypass por header falsificado.
    const ipCliente = String(
        req.headers['cf-connecting-ip'] ||
        req.headers['x-real-ip'] ||
        req.ip ||
        ipConexao
    ).trim() || ipConexao;
    const limites = [
        { chave: `conexao:${ipConexao}`, limite: LOGIN_LIMIT_CONNECTION },
        { chave: `cliente:${ipCliente}`, limite: LOGIN_LIMIT_CLIENT },
    ];
    const buckets = [...new Map(limites.map((item) => [item.chave, item])).values()];

    for (const { chave, limite } of buckets) {
        const entry = _loginAttempts.get(chave);
        if (entry && now < entry.resetAt && entry.count >= limite) {
            return res.status(429).json({ error: 'Muitas tentativas de login. Aguarde 1 minuto.' });
        }
    }
    for (const { chave } of buckets) {
        const entry = _loginAttempts.get(chave);
        if (entry && now < entry.resetAt) {
            entry.count += 1;
        } else {
            _loginAttempts.set(chave, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
        }
    }
    if (_loginAttempts.size > LOGIN_BUCKET_MAX) {
        for (const [chave, entry] of _loginAttempts) {
            if (now >= entry.resetAt) _loginAttempts.delete(chave);
            if (_loginAttempts.size <= LOGIN_BUCKET_MAX) break;
        }
    }
    next();
}

// ================= AUDITORIA =================
async function registrarAuditoria(req, acao, recurso, recursoId = null, dados = null) {
    const usuario = req.usuarioLogado;
    await db.query(
        `INSERT INTO sistema_auditoria (usuario_id, usuario_nome, acao, recurso, recurso_id, dados, ip)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
            usuario?.id || null,
            usuario?.nome || null,
            acao,
            recurso,
            recursoId != null ? String(recursoId) : null,
            dados != null ? JSON.stringify(dados) : null,
            req.ip || null
        ]
    ).catch(() => {});
    // Tempo real: avisa todos os clientes conectados que este recurso mudou.
    try { broadcastAuditoria(recurso); } catch (_) {}
}

// ================= AUTENTICACAO E PERMISSOES =================
function hashSenha(senha, salt = crypto.randomBytes(16).toString('hex')) {
    return {
        hash: crypto.scryptSync(String(senha), salt, 64).toString('hex'),
        salt
    };
}

function tokenHash(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// ================= POLITICA DE FORCA DE SENHA =================
// Espelha o modulo Java (ciberseguranca-java/PasswordPolicy): nota 0..4 e
// aceitacao conservadora (>= 8 caracteres, nota >= 2, fora da lista de comuns,
// sem usar o nome/usuario). Mantem a app e o modulo Java alinhados.
const SENHA_MIN = 8;
const SENHAS_COMUNS = new Set([
    '123456', '1234567', '12345678', '123456789', '1234567890',
    'password', 'passw0rd', 'qwerty', 'qwerty123', 'abc123',
    '111111', '000000', '123123', '123321', '654321', '121212',
    'senha', 'senha123', 'senha@123', 'mudar123', 'admin', 'admin123',
    'root', 'master', 'login', 'usuario', 'iloveyou', 'letmein',
    'controle', 'entrega', 'controle123', '12345'
]);

function _semAcentos(texto) {
    return texto.normalize('NFD').replace(/\p{M}/gu, '');
}

function _temSequencia(valor) {
    if (valor.length < 4) return false;
    let asc = 1;
    let desc = 1;
    let rep = 1;
    for (let i = 1; i < valor.length; i++) {
        const diff = valor.charCodeAt(i) - valor.charCodeAt(i - 1);
        asc = diff === 1 ? asc + 1 : 1;
        desc = diff === -1 ? desc + 1 : 1;
        rep = diff === 0 ? rep + 1 : 1;
        if (asc >= 4 || desc >= 4 || rep >= 4) return true;
    }
    return false;
}

function avaliarForcaSenha(senha, ...contexto) {
    const feedback = [];
    if (!senha) {
        return { aceitavel: false, score: 0, feedback: ['Informe uma senha.'] };
    }
    const len = senha.length;
    const lower = senha.toLowerCase();
    const norm = _semAcentos(lower);
    const temMin = /[a-z]/.test(senha);
    const temMai = /[A-Z]/.test(senha);
    const temNum = /[0-9]/.test(senha);
    const temSimb = /[^A-Za-z0-9\s]/.test(senha);
    const classes = (temMin ? 1 : 0) + (temMai ? 1 : 0) + (temNum ? 1 : 0) + (temSimb ? 1 : 0);

    const comum = SENHAS_COMUNS.has(lower) || SENHAS_COMUNS.has(norm);
    const sequencia = _temSequencia(norm);
    const usaContexto = contexto.some((p) => {
        const w = _semAcentos(String(p || '').toLowerCase()).trim();
        return w.length >= 3 && norm.includes(w);
    });

    let score = 0;
    if (len >= SENHA_MIN) score++;
    if (len >= 12) score++;
    if (classes >= 3) score++;
    if (classes >= 4 || len >= 16) score++;

    if (len < SENHA_MIN) feedback.push(`Use ao menos ${SENHA_MIN} caracteres.`);
    if (!temMai || !temMin) feedback.push('Misture letras maiusculas e minusculas.');
    if (!temNum) feedback.push('Inclua ao menos um numero.');
    if (!temSimb) feedback.push('Inclua ao menos um simbolo (ex.: ! @ # $).');
    if (sequencia) { feedback.push('Evite sequencias ou caracteres repetidos.'); score--; }
    if (usaContexto) { feedback.push('Nao use seu nome ou usuario na senha.'); score = Math.min(score, 1); }
    if (comum) { feedback.push('Essa senha e muito comum e facil de adivinhar.'); score = 0; }

    score = Math.max(0, Math.min(4, score));
    const aceitavel = !comum && !usaContexto && len >= SENHA_MIN && score >= 2;
    return { aceitavel, score, feedback };
}

// Nome do cookie de sessao (HttpOnly). O token nao fica em storage do navegador;
// a sessao em si vive na tabela sistema_sessoes (banco).
// 2026-06-24: renomeado de 'ce_sessao' -> 'ce_sessao_h' ao migrar HTTPS->HTTP.
// O cookie antigo 'ce_sessao' ficou marcado Secure no navegador e, pela regra de
// "Leave Secure Cookies Alone", bloqueava o cookie novo vindo por HTTP (login dava
// 401 mesmo com senha certa). Nome novo evita a colisao sem ninguem limpar cookie.
const COOKIE_SESSAO = 'ce_sessao_h';

// Le o token da sessao: prioriza o cookie HttpOnly; mantem o cabecalho
// Authorization Bearer como compatibilidade.
function lerTokenSessao(req) {
    const cookies = cookie.parse(req.headers.cookie || '');
    if (cookies[COOKIE_SESSAO]) return String(cookies[COOKIE_SESSAO]).trim();
    const cabecalho = String(req.headers.authorization || '');
    return cabecalho.startsWith('Bearer ') ? cabecalho.slice(7).trim() : '';
}

function conexaoSegura(req) {
    return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

// Cookie de SESSAO (sem maxAge/expires): sobrevive a F5 e navegacao na mesma aba,
// mas e apagado quando o navegador e fechado -> logoff automatico ao sair.
function definirCookieSessao(req, res, token) {
    res.cookie(COOKIE_SESSAO, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: conexaoSegura(req),
        path: '/'
    });
}

function limparCookieSessao(req, res) {
    res.clearCookie(COOKIE_SESSAO, {
        httpOnly: true,
        sameSite: 'lax',
        secure: conexaoSegura(req),
        path: '/'
    });
}

// ================================================================
// MODULOS — fonte unica de acesso por area do sistema. Cada modulo junta:
//   abas   -> quais data-aba do front aquele modulo mostra (gating visual)
//   permite(req) -> quais rotas do back aquele modulo libera (gating REAL)
// Regras de acesso (middleware global): super_adm ve tudo; ADM (preset) ve tudo;
// OPERADOR mantem a whitelist legada (rotaPermitidaOperador); CUSTOM ve so os
// modulos listados em suas permissoes. O gating do front e' cosmetico — quem
// barra de verdade e' o permite() aqui.
const MODULOS = [
    { chave: 'ocorrencias', rotulo: 'Ocorrencias de Entrega', grupo: 'Operacao',
      abas: ['ocorrencias-entrega', 'ocorrencias-avulsas'],
      permite: (r) => (
          (r.method === 'GET' && r.path === '/ocorrencias') ||
          (['GET', 'PUT'].includes(r.method) && /^\/ocorrencias\/\d+$/.test(r.path)) ||
          (r.method === 'POST' && r.path === '/ocorrencias') ||
          (r.method === 'POST' && /^\/ocorrencias\/\d+\/marcar-atraso$/.test(r.path)) ||
          (r.method === 'PUT' && /^\/ocorrencias\/\d+\/(responsavel|checklist)$/.test(r.path)) ||
          (r.method === 'GET' && r.path === '/ocorrencias/backlog') ||
          (r.method === 'GET' && r.path === '/ocorrencias/responsavel-sugerido') ||
          (r.method === 'PUT' && r.path === '/ocorrencias/encerrar-lote') ||
          (['GET', 'POST'].includes(r.method) && r.path === '/ocorrencias-individuais') ||
          (['GET', 'PUT'].includes(r.method) && /^\/ocorrencias-individuais\/\d+$/.test(r.path)) ||
          (['GET', 'POST'].includes(r.method) && r.path === '/ocorrencias-avulsas') ||
          (r.method === 'PUT' && /^\/ocorrencias-avulsas\/\d+(\/(status|culpa))?$/.test(r.path)) ||
          (r.method === 'GET' && r.path === '/ocorrencias-operacionais') ||
          (r.method === 'GET' && /^\/materiais-rota(\/relatorio|\/status-planilha|\/lojas)?$/.test(r.path)) ||
          (r.method === 'PUT' && r.path === '/materiais-rota/item')
      ) },
    { chave: 'escalas', rotulo: 'Escalas / Checklists diarios', grupo: 'Operacao', abas: ['escalas'],
      permite: (r) => checklistWhatsApp.rotaPermitida(r) || (['GET', 'POST', 'DELETE'].includes(r.method) && /^\/(checklists-diarios|tacografos|diarios-bordo)(?:\/\d+)?$/.test(r.path)) },
    { chave: 'entregas', rotulo: 'Entregas do dia', grupo: 'Operacao', abas: ['entregas'],
      permite: (r) => ['GET', 'POST', 'DELETE'].includes(r.method) && /^\/entregas-dia(?:\/\d+)?$/.test(r.path) },
    { chave: 'cadastros', rotulo: 'Cadastro de motoristas/placas', grupo: 'Operacao', abas: [],
      permite: (r) => ['GET', 'POST', 'DELETE'].includes(r.method) && /^\/cadastros(?:\/\d+)?$/.test(r.path) },
    { chave: 'docas', rotulo: 'Horario das Docas', grupo: 'Operacao', abas: ['docas'],
      permite: (r) => r.method === 'GET' && /^\/docas(?:\/.*)?$/.test(r.path) },
    { chave: 'docs-motoristas', rotulo: 'Docs de Motoristas', grupo: 'Operacao', abas: ['docs-motoristas'],
      // A aba e um ranking de dados ja registrados nas escalas; nao existem
      // endpoints /docs-motoristas. Libera somente as leituras que a aba usa.
      permite: (r) => checklistWhatsApp.rotaPermitida(r, true) || (r.method === 'GET' && /^\/(checklists-diarios|tacografos|diarios-bordo)$/.test(r.path)) },
    { chave: 'tms', rotulo: 'TMS - Viagens / CTEs', grupo: 'Transporte', abas: ['tms', 'ctes'],
      // + relatorio de material (botao na barra do TMS).
      permite: (r) => /^\/tms\//.test(r.path) || (r.method === 'GET' && /^\/materiais-rota\/(relatorio|lojas)$/.test(r.path))
          || (r.method === 'PUT' && r.path === '/materiais-rota/item') },
    { chave: 'controle-uber', rotulo: 'Controle Uber', grupo: 'Transporte', abas: ['controle-uber'],
      permite: (r) => /^\/controle-uber(?:\/\d+)?$/.test(r.path) },
    // 🛰 Frota: so leitura (mapa, trajeto do dia, saude dos rastreadores).
    { chave: 'frota', rotulo: 'Frota (rastreadores / mapa)', grupo: 'Transporte', abas: ['frota'],
      permite: (r) => r.method === 'GET' && (/^\/frota\//.test(r.path) || r.path === '/tms/gps-eventos') },
    { chave: 'wms', rotulo: 'WMS - Erro de Volume', grupo: 'Operacao', abas: ['wms'],
      permite: (r) => /^\/wms\/erro-volume(?:\/(?:\d+|duplicados))?$/.test(r.path) },
    { chave: 'conduta-motorista', rotulo: 'Conduta do Motorista', grupo: 'Transporte', abas: ['ocorrencias-motorista'],
      permite: (r) => /^\/ocorrencias-motorista(?:\/\d+)?$/.test(r.path) },
    { chave: 'dashboard', rotulo: 'Dashboard / Paineis / OTIF', grupo: 'Gestao', abas: ['dashboard'],
      permite: (r) => (
          (r.method === 'GET' && /^\/painel\//.test(r.path)) ||
          (r.method === 'GET' && r.path === '/metas-loja') ||
          (r.method === 'GET' && r.path === '/rotas/uso') ||
          (r.method === 'GET' && r.path === '/alertas') ||
          (r.method === 'POST' && /^\/alertas\/(lidos|avaliar|\d+\/lido)$/.test(r.path)) ||
          (r.method === 'GET' && /^\/relatorio-semanal(\/arquivo\/[^/]+)?$/.test(r.path))
      ) },
    // (modulo 'ia' removido: assistente flutuante (ia-assistente.js) e aba IA
    //  Analitica (ia-analitica.js) descontinuados. As rotas /ia/ e /chat/ seguem
    //  liberadas a qualquer logado via rotaBaseLogado; o botao "Insights com IA"
    //  (gerarInsightsIA) continua funcionando por /ia/insights.)
    // Abas de leitura/analytics: o front mostra a aba; no back liberam as leituras
    // operacionais comuns (ocorrencias/paineis/alertas). Se uma dessas abas precisar
    // de um endpoint extra, e' so acrescentar aqui quando o modulo for concedido.
    ...['monitoramento', 'atrasos', 'tendencias', 'ranking', 'equipes',
        'deslocamento', 'historico-rotas', 'agendamento', 'saida-fabrica', 'veiculos', 'erros-loja'
    ].map((aba) => ({
        chave: aba,
        rotulo: 'Painel: ' + aba.replace(/-/g, ' '),
        grupo: 'Gestao',
        abas: [aba],
        permite: (r) => {
            const leituraBase = r.method === 'GET' && (
                r.path === '/ocorrencias' || /^\/ocorrencias\/\d+$/.test(r.path) ||
                r.path === '/ocorrencias-avulsas' || r.path === '/ocorrencias-operacionais' ||
                /^\/painel\//.test(r.path) || r.path === '/metas-loja' ||
                r.path === '/rotas/uso' || r.path === '/alertas'
            );
            if (leituraBase) return true;

            const crud = ['GET', 'POST', 'DELETE'].includes(r.method);
            // A aba Veiculos GRAVA em quatro recursos — os quatro controles que
            // ela tem (almoco, checklist diario, atraso na saida, rota) — e so
            // LE outros tres: aplicarFiltroVeiculos() re-renderiza tacografo e
            // diario de bordo, e o painel de avisos divide a tela.
            const veiculosEscreve = /^\/(almocos|checklists-diarios|atrasos-saida|rotas-registradas)(?:\/\d+)?$/.test(r.path);
            const veiculosSoLe = /^\/(avisos-monitoramento|tacografos|diarios-bordo)(?:\/\d+)?$/.test(r.path);

            // Esses sao os endpoints reais usados pela aba Veiculos e pelos
            // paineis Atrasos/Saida de fabrica.
            if (aba === 'monitoramento' && crud && /^\/avisos-monitoramento(?:\/\d+)?$/.test(r.path)) return true;
            if (['atrasos', 'saida-fabrica'].includes(aba) && crud && /^\/atrasos-saida(?:\/\d+)?$/.test(r.path)) return true;
            // Menor privilegio: antes esta linha era `crud && (legado || escalas)`,
            // que dava POST e DELETE nos SETE recursos — inclusive tacografo,
            // diario de bordo e avisos, que nenhuma tela desta aba grava.
            if (aba === 'veiculos' && checklistWhatsApp.rotaPermitida(r)) return true;
            if (aba === 'veiculos' && crud && veiculosEscreve) return true;
            if (aba === 'veiculos' && r.method === 'GET' && veiculosSoLe) return true;

            // Planejamento e comparativo de deslocamento.
            if (aba === 'deslocamento' && (
                (r.method === 'GET' && r.path === '/rotas-registradas') ||
                (['GET', 'POST', 'PUT', 'DELETE'].includes(r.method) && /^\/roteiros(?:\/\d+)?$/.test(r.path))
            )) return true;
            if (aba === 'historico-rotas' && r.method === 'GET' && r.path === '/rotas-registradas') return true;
            if (aba === 'agendamento' && r.method === 'GET' && r.path === '/agendamento/recomendacoes') return true;

            return false;
        },
    })),
];
const CHAVES_MODULOS = new Set(MODULOS.map((m) => m.chave));

// Limpa uma lista de permissoes recebida do cliente: so chaves de modulo validas,
// sem duplicatas. Blindagem contra lixo/injecao no JSON.
function sanitizarPermissoes(x) {
    if (!Array.isArray(x)) return [];
    return [...new Set(x.map((k) => String(k)).filter((k) => CHAVES_MODULOS.has(k)))];
}

// Chaves de modulo que um usuario enxerga (para o front montar as abas / marcar
// os checkboxes). ADM/super => todos; OPERADOR => preset legado; CUSTOM => os seus.
const MODULOS_OPERADOR = ['ocorrencias', 'escalas', 'entregas', 'cadastros', 'docas',
    'docs-motoristas', 'tms', 'dashboard', 'ia', 'monitoramento', 'atrasos', 'tendencias', 'veiculos', 'frota'];
function modulosDoUsuario(u) {
    if (!u) return [];
    if (u.super_adm === true || u.perfil === 'ADM') return MODULOS.map((m) => m.chave);
    if (u.perfil === 'OPERADOR') return MODULOS_OPERADOR.slice();
    return sanitizarPermissoes(u.permissoes);
}

// Abas (data-aba) liberadas para o usuario. null = "todas" (super/ADM); para
// OPERADOR tambem devolve null porque o cliente ja tem a lista legada propria.
function abasDoUsuario(u) {
    if (!u) return [];
    if (u.super_adm === true || u.perfil === 'ADM' || u.perfil === 'OPERADOR') return null;
    const chaves = new Set(sanitizarPermissoes(u.permissoes));
    const abas = new Set();
    for (const m of MODULOS) if (chaves.has(m.chave)) (m.abas || []).forEach((a) => abas.add(a));
    return [...abas];
}

// Rota liberada por ALGUM modulo que o usuario possui (gating REAL do back).
function rotaPermitidaPorModulos(req, u) {
    const chaves = new Set(modulosDoUsuario(u));
    for (const m of MODULOS) if (chaves.has(m.chave) && m.permite(req)) return true;
    return false;
}

// Base liberada a QUALQUER usuario logado (casca do app: tempo-real e leitura de
// config). Sem isso um CUSTOM nem carregaria o SSE/tolerancias.
function rotaBaseLogado(req) {
    if (req.method === 'GET' && req.path === '/eventos') return true;      // SSE
    if (req.method === 'GET' && req.path === '/health') return true;
    if (req.method === 'GET' && /^\/config\/[\w-]+$/.test(req.path)) return true;
    return false;
}

function usuarioPublico(usuario) {
    return {
        id: usuario.id,
        nome: usuario.nome,
        usuario: usuario.usuario,
        perfil: usuario.perfil,
        ativo: usuario.ativo,
        super_adm: usuario.super_adm === true,
        permissoes: sanitizarPermissoes(usuario.permissoes),
        modulos: modulosDoUsuario(usuario),
        abasPermitidas: abasDoUsuario(usuario)
    };
}

async function obterUsuarioSessao(req) {
    const token = lerTokenSessao(req);
    if (!token) return null;
    const result = await db.query(`
        SELECT u.*
        FROM sistema_sessoes s
        INNER JOIN sistema_usuarios u ON u.id = s.usuario_id
        WHERE s.token_hash = $1
          AND s.expira_em > NOW()
          AND u.ativo = TRUE
    `, [tokenHash(token)]);
    return result.rows[0] || null;
}

async function autenticar(req, res, next) {
    try {
        const usuario = await obterUsuarioSessao(req);
        if (!usuario) {
            if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html')) {
                return res.redirect('/index.html');
            }
            return res.status(401).json({ error: 'Login necessario.' });
        }
        req.usuarioLogado = usuario;
        next();
    } catch (err) {
        res.status(500).json({ error: 'Erro ao validar usuario.', detalhe: err.message });
    }
}

// Acesso administrativo OPERACIONAL (import/delete em massa etc.): preset ADM ou
// o super. Nao inclui a gestao de usuarios/permissoes — essa e' so do master.
function somenteAdm(req, res, next) {
    if (req.usuarioLogado.perfil !== 'ADM' && req.usuarioLogado.super_adm !== true) {
        return res.status(403).json({ error: 'Acesso permitido somente para administrador.' });
    }
    next();
}

// Gestao de usuarios e permissoes: SO o super_adm (o "adm universal", rafael.mendes).
// Nem um ADM comum entra aqui — foi a escolha "so o joao gerencia".
function somenteMaster(req, res, next) {
    if (req.usuarioLogado.super_adm !== true) {
        return res.status(403).json({ error: 'Apenas o administrador master pode gerenciar acessos.' });
    }
    next();
}

// ================================================================
// AUTO-CADASTRO (aba "Criar conta"): a pessoa preenche os dados + UM codigo de
// acesso. O codigo determina o PERFIL: codigo-ADM => cria ADM; codigo-OPERADOR
// => cria OPERADOR; nenhum bate => cadastro NEGADO. Sem codigo, sem conta.
// Os dois codigos ficam em sistema_config, so ADM le/grava, comparacao sempre
// no servidor (tempo-constante, case-sensitive). Cada codigo exige forca minima
// -- o codigo-ADM concede acesso total, entao tem que ser um segredo forte.
// ================================================================
const CADASTRO_CODIGO_ADM_CHAVE = 'cadastro_codigo_adm';
const CADASTRO_CODIGO_OP_CHAVE = 'cadastro_codigo_operador';
const CADASTRO_CODIGO_CHAVES = new Set([CADASTRO_CODIGO_ADM_CHAVE, CADASTRO_CODIGO_OP_CHAVE]);

async function lerConfigTexto(chave) {
    try {
        const r = await db.query('SELECT valor FROM sistema_config WHERE chave = $1', [chave]);
        if (!r.rowCount) return '';
        const v = r.rows[0].valor;
        return String(typeof v === 'string' ? v : (v ?? '')).trim();
    } catch (_) {
        return '';
    }
}
// Retorna { adm, operador } com os codigos configurados (string vazia = nao def.).
async function lerCadastroCodigos() {
    const [adm, operador] = await Promise.all([
        lerConfigTexto(CADASTRO_CODIGO_ADM_CHAVE),
        lerConfigTexto(CADASTRO_CODIGO_OP_CHAVE),
    ]);
    return { adm, operador };
}
// Dado o codigo digitado, resolve o perfil (ADM tem prioridade) ou null se nenhum bate.
function perfilDoCodigo(codigoDigitado, codigos) {
    const c = String(codigoDigitado || '').trim();
    if (!c) return null;
    if (codigos.adm && compararSegredo(c, codigos.adm)) return 'ADM';
    if (codigos.operador && compararSegredo(c, codigos.operador)) return 'OPERADOR';
    return null;
}

// Comparacao de segredo em tempo-constante e CASE-SENSITIVE (nao desperdica
// entropia com case-folding). O tamanho pode vazar pelo early-return, o que e
// aceitavel para este gate. Usada na verificacao do codigo de auto-cadastro.
function compararSegredo(a, b) {
    const ba = Buffer.from(String(a), 'utf8');
    const bb = Buffer.from(String(b), 'utf8');
    if (ba.length === 0 || ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

// Forca do codigo de auto-cadastro: reusa avaliarForcaSenha mas exige score
// >= 3 (mais forte que a senha comum, que aceita score >= 2). O codigo e um
// segredo compartilhado num endpoint publico e o codigo-ADM concede acesso
// total; score >= 3 obriga len >= 12 E >= 3 classes (ou len >= 16 com classe),
// barrando ate palavra de dicionario longa ('transportadora' -> score 2).
function validarCodigoCadastro(c) {
    const f = avaliarForcaSenha(String(c || ''));
    if (f.aceitavel && f.score >= 3) return { aceitavel: true, feedback: [] };
    const feedback = f.feedback.slice();
    if (f.aceitavel && f.score < 3) {
        feedback.push('Codigo muito simples: use pelo menos 12 caracteres misturando MAIUSCULAS, minusculas, numeros e um simbolo.');
    }
    return { aceitavel: false, feedback };
}

app.get('/auth/status', async (req, res) => {
    try {
        const result = await db.query('SELECT COUNT(*)::int AS total FROM sistema_usuarios');
        res.status(200).json({ possuiUsuarios: result.rows[0].total > 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/auth/bootstrap', async (req, res) => {
    try {
        const existente = await db.query('SELECT COUNT(*)::int AS total FROM sistema_usuarios');
        if (existente.rows[0].total > 0) {
            return res.status(403).json({ error: 'Administrador inicial ja foi cadastrado.' });
        }
        const { nome, usuario, senha } = req.body || {};
        if (!nome || !usuario || !senha) {
            return res.status(400).json({ error: 'Informe nome, usuario e senha.' });
        }
        const forca = avaliarForcaSenha(senha, usuario, nome);
        if (!forca.aceitavel) {
            return res.status(400).json({ error: 'Senha fraca.', motivos: forca.feedback });
        }
        const senhaSegura = hashSenha(senha);
        const result = await db.query(`
            INSERT INTO sistema_usuarios (nome, usuario, senha_hash, senha_salt, perfil)
            VALUES ($1, $2, $3, $4, 'ADM')
            RETURNING *
        `, [nome, String(usuario).trim().toLowerCase(), senhaSegura.hash, senhaSegura.salt]);
        res.status(201).json(usuarioPublico(result.rows[0]));
    } catch (err) {
        res.status(409).json({ error: 'Nao foi possivel criar o administrador inicial.', detalhe: err.message });
    }
});

app.post('/auth/login', rateLimitLogin, async (req, res) => {
    try {
        const { usuario, senha } = req.body || {};
        const result = await db.query(
            'SELECT * FROM sistema_usuarios WHERE usuario = $1 AND ativo = TRUE',
            [String(usuario || '').trim().toLowerCase()]
        );
        const conta = result.rows[0];
        // Calcula o hash mesmo sem conta (salt aleatorio) para nao vazar, pelo
        // tempo de resposta, se o usuario existe. Comparacao em tempo-constante.
        const salt = conta ? conta.senha_salt : crypto.randomBytes(16).toString('hex');
        const calc = hashSenha(senha || '', salt).hash;
        let senhaOk = false;
        if (conta) {
            const a = Buffer.from(calc, 'hex');
            const b = Buffer.from(conta.senha_hash, 'hex');
            senhaOk = a.length === b.length && crypto.timingSafeEqual(a, b);
        }
        if (!senhaOk) {
            return res.status(401).json({ error: 'Usuario ou senha invalidos.' });
        }
        const token = crypto.randomBytes(32).toString('hex');
        await db.query(`
            INSERT INTO sistema_sessoes (usuario_id, token_hash, expira_em)
            VALUES ($1, $2, NOW() + INTERVAL '12 hours')
        `, [conta.id, tokenHash(token)]);
        await db.query(
            `INSERT INTO sistema_auditoria (usuario_id, usuario_nome, acao, recurso, ip) VALUES ($1, $2, 'LOGIN', 'auth', $3)`,
            [conta.id, conta.nome, req.ip || null]
        ).catch(() => {});
        definirCookieSessao(req, res, token);
        res.status(200).json({ usuario: usuarioPublico(conta) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Publico: diz ao front se a aba "Criar conta" deve aparecer (nao vaza os codigos).
app.get('/auth/cadastro-habilitado', async (req, res) => {
    try {
        const c = await lerCadastroCodigos();
        res.status(200).json({ habilitado: !!(c.adm || c.operador) });
    } catch (err) {
        res.status(200).json({ habilitado: false });
    }
});

// Publico (com rate-limit): auto-cadastro. O CODIGO digitado define o perfil —
// codigo-ADM => ADM, codigo-OPERADOR => OPERADOR, nenhum => negado. O cliente
// NUNCA envia o perfil; ele e derivado do segredo no servidor.
app.post('/auth/registrar', rateLimitLogin, async (req, res) => {
    try {
        const { nome, usuario, senha, codigo } = req.body || {};
        // ORDEM IMPORTA (anti-oraculo): valida TODO o input que NAO depende do
        // codigo (presenca, formato do usuario, forca da senha) ANTES de tocar
        // no codigo. Assim, um payload invalido devolve sempre 400 sem revelar
        // se o codigo bate — o atacante nao consegue um oraculo limpo do codigo
        // com lixo nos demais campos. A checagem de usuario ja existente (409)
        // fica DEPOIS do codigo, pra enumeracao continuar exigindo codigo valido.
        if (!nome || !usuario || !senha || !codigo) {
            return res.status(400).json({ error: 'Informe nome, usuario, senha e o codigo de acesso.' });
        }
        const login = String(usuario).trim().toLowerCase();
        if (!/^[a-z0-9._-]{3,40}$/.test(login)) {
            return res.status(400).json({ error: 'Usuario deve ter de 3 a 40 caracteres: letras, numeros, ponto, hifen ou underline.' });
        }
        const forca = avaliarForcaSenha(senha, login, nome);
        if (!forca.aceitavel) {
            return res.status(400).json({ error: 'Senha fraca.', motivos: forca.feedback });
        }
        const codigos = await lerCadastroCodigos();
        if (!codigos.adm && !codigos.operador) {
            return res.status(403).json({ error: 'O auto-cadastro esta desativado. Peca a um administrador para gerar um codigo.' });
        }
        const perfil = perfilDoCodigo(codigo, codigos);
        if (!perfil) {
            return res.status(403).json({ error: 'Codigo de cadastro invalido. Peca o codigo atual ao administrador.' });
        }
        const existe = await db.query('SELECT 1 FROM sistema_usuarios WHERE usuario = $1', [login]);
        if (existe.rowCount) {
            return res.status(409).json({ error: 'Esse usuario ja existe. Escolha outro ou faca login.' });
        }
        const senhaSegura = hashSenha(senha);
        const result = await db.query(`
            INSERT INTO sistema_usuarios (nome, usuario, senha_hash, senha_salt, perfil, ativo)
            VALUES ($1, $2, $3, $4, $5, TRUE)
            RETURNING *
        `, [String(nome).trim(), login, senhaSegura.hash, senhaSegura.salt, perfil]);
        const conta = result.rows[0];
        // Auto-login (mesmo fluxo do /auth/login): sessao + cookie HttpOnly.
        const token = crypto.randomBytes(32).toString('hex');
        await db.query(
            `INSERT INTO sistema_sessoes (usuario_id, token_hash, expira_em) VALUES ($1, $2, NOW() + INTERVAL '12 hours')`,
            [conta.id, tokenHash(token)]
        );
        await db.query(
            `INSERT INTO sistema_auditoria (usuario_id, usuario_nome, acao, recurso, dados, ip) VALUES ($1, $2, 'REGISTRO', 'auth', $3, $4)`,
            [conta.id, conta.nome, JSON.stringify({ perfil }), req.ip || null]
        ).catch(() => {});
        definirCookieSessao(req, res, token);
        res.status(201).json({ usuario: usuarioPublico(conta) });
    } catch (err) {
        console.error('[POST /auth/registrar]', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/auth/me', autenticar, (req, res) => {
    res.status(200).json(usuarioPublico(req.usuarioLogado));
});

// ADM: le/define os codigos de auto-cadastro. Cada um vazio = aquele perfil
// nao pode ser criado por auto-cadastro. Ambos vazios = aba "Criar conta" some.
app.get('/auth/cadastro-codigo', autenticar, somenteMaster, async (req, res) => {
    const c = await lerCadastroCodigos();
    res.status(200).json({ adm: c.adm, operador: c.operador });
});
app.put('/auth/cadastro-codigo', autenticar, somenteMaster, async (req, res) => {
    try {
        const body = req.body || {};
        const codigoAdm = String(body.adm || '').trim();
        const codigoOp = String(body.operador || '').trim();
        // Se preenchido, exige senha-FORTE (o codigo e' a unica trava do
        // auto-cadastro num endpoint publico; o codigo-ADM concede acesso total).
        if (codigoAdm) {
            const f = validarCodigoCadastro(codigoAdm);
            if (!f.aceitavel) return res.status(400).json({ error: `Codigo ADM fraco. ${f.feedback.join(' ')} Deixe vazio para nao permitir auto-cadastro de ADM.` });
        }
        if (codigoOp) {
            const f = validarCodigoCadastro(codigoOp);
            if (!f.aceitavel) return res.status(400).json({ error: `Codigo Operador fraco. ${f.feedback.join(' ')} Deixe vazio para desativar.` });
        }
        // O codigo-ADM nao pode ser igual ao do operador (senao ambiguidade/erro).
        if (codigoAdm && codigoOp && codigoAdm === codigoOp) {
            return res.status(400).json({ error: 'Os codigos ADM e Operador precisam ser diferentes.' });
        }
        await db.query(`
            INSERT INTO sistema_config (chave, valor, atualizado_em) VALUES ($1, $2, NOW())
            ON CONFLICT (chave) DO UPDATE SET valor = $2, atualizado_em = NOW()
        `, [CADASTRO_CODIGO_ADM_CHAVE, JSON.stringify(codigoAdm)]);
        await db.query(`
            INSERT INTO sistema_config (chave, valor, atualizado_em) VALUES ($1, $2, NOW())
            ON CONFLICT (chave) DO UPDATE SET valor = $2, atualizado_em = NOW()
        `, [CADASTRO_CODIGO_OP_CHAVE, JSON.stringify(codigoOp)]);
        await registrarAuditoria(req, 'PUT', 'cadastro_codigo', null, { adm_definido: !!codigoAdm, operador_definido: !!codigoOp });
        res.status(200).json({ ok: true, habilitado: !!(codigoAdm || codigoOp), adm_definido: !!codigoAdm, operador_definido: !!codigoOp });
    } catch (err) {
        console.error('[PUT /auth/cadastro-codigo]', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/auth/logout', autenticar, async (req, res) => {
    const token = lerTokenSessao(req);
    await db.query('DELETE FROM sistema_sessoes WHERE token_hash = $1', [tokenHash(token)]);
    await db.query(
        `INSERT INTO sistema_auditoria (usuario_id, usuario_nome, acao, recurso, ip) VALUES ($1, $2, 'LOGOUT', 'auth', $3)`,
        [req.usuarioLogado.id, req.usuarioLogado.nome, req.ip || null]
    ).catch(() => {});
    limparCookieSessao(req, res);
    res.status(200).json({ ok: true });
});

// Sessao so era apagada no logout EXPLICITO. Quem fecha a aba (a maioria) deixa
// a linha para tras: em 06/08/2026 havia 110 sessoes, 109 ja expiradas. Nao e
// problema de espaco, e de crescimento sem teto numa tabela consultada a cada
// request autenticado. Expirada nao autentica ninguem, entao apagar nao desloga
// nada. De hora em hora e suficiente; a falha e ignorada de proposito porque
// limpeza nunca pode derrubar o servidor.
const LIMPEZA_SESSOES_MS = 60 * 60 * 1000;
async function limparSessoesExpiradas() {
    try {
        const r = await db.query('DELETE FROM sistema_sessoes WHERE expira_em < NOW()');
        if (r.rowCount > 0) console.log(`[sessoes] ${r.rowCount} sessao(oes) expirada(s) removida(s).`);
    } catch (err) {
        console.error('[sessoes] limpeza falhou (ignorado):', err.message);
    }
}
setInterval(limparSessoesExpiradas, LIMPEZA_SESSOES_MS).unref();
setTimeout(limparSessoesExpiradas, 60 * 1000).unref();

app.get('/auth/usuarios', autenticar, somenteMaster, async (req, res) => {
    const result = await db.query(`
        SELECT id, nome, usuario, perfil, ativo, super_adm, permissoes, criado_em
        FROM sistema_usuarios ORDER BY nome
    `);
    res.status(200).json(result.rows);
});

// Catalogo de modulos concedeveis (para a tela de permissoes montar os checkboxes).
app.get('/auth/modulos', autenticar, somenteMaster, (req, res) => {
    res.status(200).json({
        modulos: MODULOS.map((m) => ({ chave: m.chave, rotulo: m.rotulo, grupo: m.grupo, abas: m.abas }))
    });
});

app.post('/auth/usuarios', autenticar, somenteMaster, async (req, res) => {
    try {
        const { nome, usuario, senha, perfil } = req.body || {};
        if (!nome || !usuario || !senha || !['ADM', 'OPERADOR', 'CUSTOM'].includes(perfil)) {
            return res.status(400).json({ error: 'Preencha nome, usuario, perfil e senha.' });
        }
        const forca = avaliarForcaSenha(senha, usuario, nome);
        if (!forca.aceitavel) {
            return res.status(400).json({ error: 'Senha fraca.', motivos: forca.feedback });
        }
        // Modulos so fazem sentido no perfil CUSTOM; nos demais guardamos [] (o
        // preset ja define o acesso). super_adm NAO se cria por aqui (so no backfill).
        const permissoes = perfil === 'CUSTOM' ? sanitizarPermissoes(req.body.permissoes) : [];
        const senhaSegura = hashSenha(senha);
        const result = await db.query(`
            INSERT INTO sistema_usuarios (nome, usuario, senha_hash, senha_salt, perfil, permissoes)
            VALUES ($1, $2, $3, $4, $5, $6::jsonb)
            RETURNING *
        `, [nome, String(usuario).trim().toLowerCase(), senhaSegura.hash, senhaSegura.salt, perfil, JSON.stringify(permissoes)]);
        res.status(201).json(usuarioPublico(result.rows[0]));
    } catch (err) {
        res.status(409).json({ error: 'Nao foi possivel cadastrar usuario.', detalhe: err.message });
    }
});

app.put('/auth/usuarios/:id', autenticar, somenteMaster, async (req, res) => {
    try {
        const { nome, perfil, ativo, senha } = req.body || {};
        if (perfil && !['ADM', 'OPERADOR', 'CUSTOM'].includes(perfil)) {
            return res.status(400).json({ error: 'Perfil invalido.' });
        }
        const alvoResult = await db.query('SELECT * FROM sistema_usuarios WHERE id = $1', [req.params.id]);
        const alvo = alvoResult.rows[0];
        if (!alvo) return res.status(404).json({ error: 'Usuario nao encontrado.' });
        // Nao deixa sumir o ultimo ADM ativo: rebaixar para OPERADOR/CUSTOM ou desativar.
        const removerAdmAtivo = alvo.perfil === 'ADM' && alvo.ativo === true && (
            (perfil !== undefined && perfil !== 'ADM') || (ativo !== undefined && !textoParaBoolean(ativo))
        );
        if (removerAdmAtivo) {
            const outrosAdm = await db.query(`
                SELECT COUNT(*)::int AS total
                FROM sistema_usuarios
                WHERE perfil = 'ADM' AND ativo = TRUE AND id <> $1
            `, [req.params.id]);
            if (outrosAdm.rows[0].total === 0) {
                return res.status(400).json({ error: 'Mantenha ao menos um administrador ativo.' });
            }
        }
        const sets = [];
        const valores = [];
        const definir = (campo, valor) => {
            valores.push(valor);
            sets.push(`${campo} = $${valores.length}`);
        };
        if (nome !== undefined) definir('nome', nome);
        if (perfil !== undefined) definir('perfil', perfil);
        if (ativo !== undefined) definir('ativo', textoParaBoolean(ativo));
        // Modulos do CUSTOM (jsonb): so chaves validas. Aceita mesmo quando o perfil
        // nao vem no corpo (edicao so-das-permissoes de um usuario que ja e' CUSTOM).
        if (req.body.permissoes !== undefined) {
            valores.push(JSON.stringify(sanitizarPermissoes(req.body.permissoes)));
            sets.push(`permissoes = $${valores.length}::jsonb`);
        }
        if (senha) {
            const forca = avaliarForcaSenha(senha, alvo.usuario, nome || alvo.nome);
            if (!forca.aceitavel) {
                return res.status(400).json({ error: 'Senha fraca.', motivos: forca.feedback });
            }
            const senhaSegura = hashSenha(senha);
            definir('senha_hash', senhaSegura.hash);
            definir('senha_salt', senhaSegura.salt);
        }
        if (!sets.length) return res.status(400).json({ error: 'Nenhuma alteracao informada.' });
        valores.push(req.params.id);
        const result = await db.query(`
            UPDATE sistema_usuarios SET ${sets.join(', ')}
            WHERE id = $${valores.length}
            RETURNING *
        `, valores);
        if (!result.rowCount) return res.status(404).json({ error: 'Usuario nao encontrado.' });
        res.status(200).json(usuarioPublico(result.rows[0]));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/auth/usuarios/:id', autenticar, somenteMaster, async (req, res) => {
    try {
        const alvoId = Number(req.params.id);
        if (!Number.isInteger(alvoId) || alvoId <= 0) {
            return res.status(400).json({ error: 'Usuario invalido.' });
        }
        if (alvoId === req.usuarioLogado.id) {
            return res.status(400).json({ error: 'Nao e possivel excluir o proprio usuario logado.' });
        }

        const alvoResult = await db.query('SELECT * FROM sistema_usuarios WHERE id = $1', [alvoId]);
        const alvo = alvoResult.rows[0];
        if (!alvo) return res.status(404).json({ error: 'Usuario nao encontrado.' });

        if (alvo.perfil === 'ADM' && alvo.ativo === true) {
            const outrosAdm = await db.query(`
                SELECT COUNT(*)::int AS total
                FROM sistema_usuarios
                WHERE perfil = 'ADM' AND ativo = TRUE AND id <> $1
            `, [alvoId]);
            if (outrosAdm.rows[0].total === 0) {
                return res.status(400).json({ error: 'Mantenha ao menos um administrador ativo.' });
            }
        }

        const result = await db.query(
            'DELETE FROM sistema_usuarios WHERE id = $1 RETURNING id, nome, usuario, perfil',
            [alvoId]
        );
        await registrarAuditoria(req, 'DELETE', 'sistema_usuarios', alvoId, result.rows[0] || {}).catch(() => {});
        res.status(200).json({ deleted: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/auditoria', autenticar, somenteMaster, async (req, res) => {
    try {
        const limite = Math.min(parseInt(req.query.limite) || 200, 1000);
        const pagina = Math.max(parseInt(req.query.pagina) || 1, 1);
        const offset = (pagina - 1) * limite;
        const countResult = await db.query('SELECT COUNT(*)::int AS total FROM sistema_auditoria');
        const result = await db.query(
            `SELECT * FROM sistema_auditoria ORDER BY criado_em DESC LIMIT $1 OFFSET $2`,
            [limite, offset]
        );
        res.status(200).json({
            dados: result.rows,
            total: countResult.rows[0].total,
            pagina,
            limite
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Dispara um backup AGORA (mesmo dump do agendado das 17:28). Útil para
// testar/validar sem esperar o horário. Só ADM. Definido em executarBackupDiario.
app.post('/admin/backup-agora', autenticar, somenteMaster, async (req, res) => {
    try {
        const { arquivo, tamanhoMB } = await executarBackupDiario();
        await registrarAuditoria(req, 'BACKUP', 'banco', null, { arquivo, tamanhoMB });
        res.status(200).json({
            message: 'Backup gerado com sucesso.',
            arquivo: path.basename(arquivo),
            tamanhoMB
        });
    } catch (err) {
        res.status(500).json({ error: 'Falha ao gerar backup.', detalhe: err.message });
    }
});

// Reinicia o servidor sem ninguém precisar acessar a máquina. Encerra este
// processo e um relançador desacoplado (restart-server.vbs) sobe um node novo
// assim que a porta 3000 liberar. Se o relançador falhar por algum motivo, o
// watchdog (Tarefa Agendada, 1 min) reinicia assim mesmo. Só ADM.
app.post('/admin/reiniciar', autenticar, somenteMaster, async (req, res) => {
    await registrarAuditoria(req, 'REINICIAR', 'servidor', null, null);
    try {
        const relancador = path.join(__dirname, '..', 'restart-server.vbs');
        const filho = spawn('wscript.exe', [relancador], { detached: true, stdio: 'ignore' });
        filho.unref(); // desacopla: sobrevive ao process.exit abaixo
        console.log(`[reiniciar] relançador disparado por ${req.usuarioLogado?.nome || '?'}`);
    } catch (err) {
        console.error('[reiniciar] falha ao disparar relançador (watchdog assume):', err.message);
    }
    res.status(200).json({ ok: true, message: 'Servidor reiniciando. Aguarde alguns segundos.' });
    // Dá tempo da resposta ir embora antes de encerrar. O relançador (ou o
    // watchdog) sobe um processo limpo em seguida.
    setTimeout(() => process.exit(0), 800);
});

function rotaPermitidaOperador(req) {
    if (req.method === 'GET' && req.path === '/ocorrencias') return true;
    if (req.method === 'GET' && /^\/ocorrencias\/\d+$/.test(req.path)) return true;
    if (req.method === 'POST' && req.path === '/ocorrencias') return true;
    if (req.method === 'PUT' && /^\/ocorrencias\/\d+$/.test(req.path)) return true;
    if (req.method === 'POST' && /^\/ocorrencias\/\d+\/marcar-atraso$/.test(req.path)) return true;
    if (req.method === 'PUT' && /^\/ocorrencias\/\d+\/responsavel$/.test(req.path)) return true;
    if (req.method === 'PUT' && /^\/ocorrencias\/\d+\/checklist$/.test(req.path)) return true;
    // Operador ja pode editar e encerrar ocorrencia uma a uma; o lote e a mesma
    // acao em escala, e a auditoria registra quem fez, quantas e por que.
    if (req.method === 'PUT' && req.path === '/ocorrencias/encerrar-lote') return true;
    if (['GET', 'POST'].includes(req.method) && req.path === '/ocorrencias-individuais') return true;
    if (['GET', 'PUT'].includes(req.method) && /^\/ocorrencias-individuais\/\d+$/.test(req.path)) return true;
    if (['GET', 'POST'].includes(req.method) && req.path === '/ocorrencias-avulsas') return true;
    if (req.method === 'PUT' && /^\/ocorrencias-avulsas\/\d+$/.test(req.path)) return true;
    if (req.method === 'PUT' && /^\/ocorrencias-avulsas\/\d+\/status$/.test(req.path)) return true;
    if (req.method === 'PUT' && /^\/ocorrencias-avulsas\/\d+\/culpa$/.test(req.path)) return true;
    if (checklistWhatsApp.rotaPermitida(req)) return true;
    if (['GET', 'POST', 'DELETE'].includes(req.method) && /^\/(checklists-diarios|tacografos|diarios-bordo)(?:\/\d+)?$/.test(req.path)) return true;
    // A aba Veiculos e os paineis Atrasos/Saida de fabrica usam estes
    // endpoints legados. Sem eles o OPERADOR via a aba, mas recebia 403 ao
    // carregar, salvar ou excluir os registros.
    if (['GET', 'POST', 'DELETE'].includes(req.method) && /^\/(avisos-monitoramento|atrasos-saida|rotas-registradas|almocos)(?:\/\d+)?$/.test(req.path)) return true;
    if (['GET', 'POST', 'DELETE'].includes(req.method) && /^\/entregas-dia(?:\/\d+)?$/.test(req.path)) return true;
    // Cadastro de motoristas/ajudantes/placas: qualquer logado pode gerenciar.
    if (['GET', 'POST', 'DELETE'].includes(req.method) && /^\/cadastros(?:\/\d+)?$/.test(req.path)) return true;
    // Responsaveis de loja: cadastro operacional, qualquer logado pode gerenciar.
    if (['GET', 'POST', 'PUT', 'DELETE'].includes(req.method) && /^\/loja-responsaveis(?:\/\d+)?$/.test(req.path)) return true;
    if (req.method === 'GET' && req.path === '/docas') return true;
    if (req.method === 'GET' && req.path === '/tms/viagens') return true;
    if (req.method === 'GET' && req.path === '/tms/gps-eventos') return true;
    if (req.method === 'GET' && /^\/frota\//.test(req.path)) return true;
    // Cadastro de loja (PES/km/frete): leitura liberada; reimportar segue ADM.
    if (req.method === 'GET' && req.path === '/tms/lojas-pes') return true;
    if (req.method === 'GET' && req.path === '/tms/uso') return true;
    // Posicao dos caminhoes (so leitura). Aprender lojas fica so com ADM.
    if (req.method === 'GET' && /^\/tms\/rastreador\/(posicoes|lojas)$/.test(req.path)) return true;
    // Material de envio/retirada da planilha (formulario de ocorrencia): leitura.
    if (req.method === 'GET' && /^\/materiais-rota(\/relatorio|\/status-planilha|\/lojas)?$/.test(req.path)) return true;
    // Marcar item de material foi/nao foi/pendente (formulario e relatorio).
    if (req.method === 'PUT' && req.path === '/materiais-rota/item') return true;
    if (req.method === 'GET' && req.path === '/tms/checklist-expedicao/disponiveis') return true;
    if (req.method === 'PUT' && /^\/tms\/viagens\/\d+\/status$/.test(req.path)) return true;
    // Botao "Saiu" (saida real da fabrica): quem muda o status tambem registra a saida.
    if (req.method === 'POST' && /^\/tms\/viagens\/\d+\/(saida|chegada|retorno|hotel_chegada|hotel_saida)$/.test(req.path)) return true;
    if (req.method === 'PUT' && /^\/tms\/viagens\/\d+\/lacre$/.test(req.path)) return true;
    if (req.method === 'PUT' && /^\/tms\/paradas\/\d+\/cte$/.test(req.path)) return true;
    if (req.method === 'PUT' && /^\/tms\/viagens\/\d+\/ctes$/.test(req.path)) return true;
    if (req.method === 'PUT' && /^\/tms\/paradas\/\d+\/status$/.test(req.path)) return true;
    if (req.method === 'GET' && req.path === '/ocorrencias-operacionais') return true;
    // Painel "Agora" (resumo operacional + alertas): leitura liberada a operadores.
    if (req.method === 'GET' && req.path === '/painel/resumo') return true;
    // Fila "Resolver agora" (pendencias acionaveis, read-only): idem.
    if (req.method === 'GET' && req.path === '/painel/fila') return true;
    // Backlog de ocorrencias por faixa de idade (read-only): idem.
    if (req.method === 'GET' && req.path === '/ocorrencias/backlog') return true;
    if (req.method === 'GET' && req.path === '/ocorrencias/responsavel-sugerido') return true;
    // Relatorio semanal: baixar os ja gerados (gerar na hora segue ADM).
    if (req.method === 'GET' && /^\/relatorio-semanal(\/arquivo\/[^/]+)?$/.test(req.path)) return true;
    // Estado do modo manutencao: qualquer logado precisa ler para ver o aviso.
    if (req.method === 'GET' && req.path === '/manutencao') return true;
    // Digital da versao do front: qualquer logado compara para saber se a
    // pagina aberta ficou velha.
    if (req.method === 'GET' && req.path === '/versao-front') return true;
    // Risco preditivo de atraso (leitura, read-only): idem.
    if (req.method === 'GET' && req.path === '/painel/risco') return true;
    // Painel OTIF/SLA (leitura, read-only): idem.
    if (req.method === 'GET' && req.path === '/painel/otif') return true;
    // Metas de horario por loja: leitura liberada a qualquer logado; gravacao so ADM (checada na rota).
    if (req.method === 'GET' && req.path === '/metas-loja') return true;
    // Alertas proativos: qualquer logado le, marca como lido e reavalia (idempotente).
    if (req.method === 'GET' && req.path === '/alertas') return true;
    if (req.method === 'POST' && /^\/alertas\/(lidos|avaliar|\d+\/lido)$/.test(req.path)) return true;
    // Painel de qualidade de dado + preview do resumo (leitura, read-only): idem.
    if (req.method === 'GET' && req.path === '/painel/qualidade') return true;
    if (req.method === 'GET' && req.path === '/painel/digest') return true;
    // Rotas em uso (leitura p/ a ferramenta de juntar rotas): idem. Mesclar continua ADM.
    if (req.method === 'GET' && req.path === '/rotas/uso') return true;
    // Tempo real (SSE): qualquer logado pode ouvir o fluxo de eventos.
    if (req.method === 'GET' && req.path === '/eventos') return true;
    // IA analitica + assistente: leitura, perguntas e gestao da base de conhecimento.
    if (req.path.startsWith('/ia/') && ['GET', 'POST', 'DELETE'].includes(req.method)) return true;
    if (req.path.startsWith('/chat/') && ['GET', 'POST'].includes(req.method)) return true;
    // Leitura de configuracao (ex.: tolerancias) liberada a qualquer logado; gravacao continua so ADM.
    if (req.method === 'GET' && /^\/config\/[\w-]+$/.test(req.path)) return true;
    return false;
}

// ================= HEALTH CHECK =================
app.get('/health', async (req, res) => {
    try {
        await db.query('SELECT 1');
        res.status(200).json({ ok: true, ts: new Date().toISOString() });
    } catch (err) {
        res.status(503).json({ ok: false, error: err.message });
    }
});

// Avisa AGORA que saiu versao nova, sem esperar a proxima checagem. Chamado no
// fim do deploy: e o que tira a espera do caminho — o usuario recebe em ~1,5s
// em vez de ate 11s.
//
// Fica aqui em cima, junto do /health, porque nao passa pelo login: o deploy
// roda por script na propria maquina, sem sessao. Em troca, so aceita chamada
// de localhost — exposto para fora, seria um jeito barato de mandar todo mundo
// recarregar a pagina.
app.post('/versao-front/publicar', (req, res) => {
    const ip = String(req.ip || req.socket?.remoteAddress || '');
    const local = ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1';
    if (!local) return res.status(403).json({ error: 'So a partir do proprio servidor.' });

    const mudou = conferirVersaoFront();
    if (mudou) avisarVersaoNova();
    res.json({ avisou: mudou, digital: _digitalFront, clientes: sseClientes.size });
});

app.use(async (req, res, next) => {
    try {
        const usuario = await obterUsuarioSessao(req);
        if (!usuario) {
            if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html')) {
                return res.redirect('/index.html');
            }
            return res.status(401).json({ error: 'Login necessario.' });
        }
        req.usuarioLogado = usuario;
        // Ordem: master ve tudo; casca do app liberada a qualquer logado; ADM (preset)
        // ve tudo; OPERADOR mantem a whitelist legada; CUSTOM entra pelos seus modulos.
        if (usuario.super_adm === true) return next();
        if (rotaBaseLogado(req)) return next();
        if (usuario.perfil === 'ADM') return next();
        if (usuario.perfil === 'OPERADOR' && rotaPermitidaOperador(req)) return next();
        if (rotaPermitidaPorModulos(req, usuario)) return next();
        res.status(403).json({ error: 'Seu perfil nao possui permissao para esta acao.' });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao validar permissao.', detalhe: err.message });
    }
});

// ================= MODO MANUTENCAO =================
// Fecha o sistema para todo mundo enquanto o super_adm mexe nele, evitando que
// alguem grave em cima de uma migracao ou veja a tela pela metade.
//
// Duas regras que existem para NAO trancar quem esta trabalhando:
//   1. super_adm nunca e bloqueado — quem ligou continua usando normalmente;
//   2. o estado mora em memoria (carregado no boot e atualizado no PUT), entao
//      nao custa um SELECT por request. So ha uma instancia do servidor, entao
//      cache simples da conta.
//
// Leitura ainda passa: bloquear GET deixaria a tela de manutencao sem conseguir
// nem se desenhar. O que fica barrado e a ESCRITA (POST/PUT/PATCH/DELETE), que
// e o que realmente atrapalha durante manutencao.
let _manutencao = { ativa: false, mensagem: '', desde: null, por: null, previsao: null };

async function carregarManutencao() {
    try {
        const r = await db.query("SELECT valor FROM sistema_config WHERE chave = 'manutencao'");
        if (r.rows.length && r.rows[0].valor && typeof r.rows[0].valor === 'object') {
            _manutencao = { ..._manutencao, ...r.rows[0].valor };
        }
    } catch (_) { /* tabela ainda nao existe no primeiro boot: segue liberado */ }
}

function manutencaoBloqueia(req) {
    if (!_manutencao.ativa) return false;
    if (req.usuarioLogado?.super_adm === true) return false;   // quem esta mexendo
    if (req.method === 'GET') return false;                    // deixa a tela carregar
    if (req.path === '/auth/logout') return false;             // ninguem fica preso logado
    return true;
}

app.use((req, res, next) => {
    if (!manutencaoBloqueia(req)) return next();
    res.status(503).json({
        error: 'Sistema em manutencao. Nao e possivel gravar agora.',
        manutencao: true,
        mensagem: _manutencao.mensagem || '',
        desde: _manutencao.desde,
        previsao: _manutencao.previsao || null,
    });
});

// Estado atual. Liberado a qualquer logado: o front precisa saber para mostrar
// o aviso, inclusive para quem nao e master.
app.get('/manutencao', (req, res) => {
    res.json({
        ativa: _manutencao.ativa === true,
        mensagem: _manutencao.mensagem || '',
        desde: _manutencao.desde,
        previsao: _manutencao.previsao || null,
        por: _manutencao.por || null,
        sou_master: req.usuarioLogado?.super_adm === true,
    });
});

// Liga/desliga. So o super_adm (rafael.mendes).
app.put('/manutencao', autenticar, somenteMaster, async (req, res) => {
    try {
        const ativa = req.body?.ativa === true || req.body?.ativa === 'true';
        const mensagem = String(req.body?.mensagem || '').trim().slice(0, 300);
        const previsao = String(req.body?.previsao || '').trim().slice(0, 40) || null;

        const novo = {
            ativa,
            mensagem,
            previsao,
            desde: ativa ? (_manutencao.ativa ? _manutencao.desde : new Date().toISOString()) : null,
            por: ativa ? (req.usuarioLogado?.nome || req.usuarioLogado?.usuario || null) : null,
        };

        await db.query(
            `INSERT INTO sistema_config (chave, valor, atualizado_em)
             VALUES ('manutencao', $1::jsonb, NOW())
             ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = NOW()`,
            [JSON.stringify(novo)]
        );
        _manutencao = novo;

        await registrarAuditoria(req, ativa ? 'MANUTENCAO_ON' : 'MANUTENCAO_OFF', 'sistema_config', null, {
            mensagem, previsao,
        });
        console.log(`[manutencao] ${ativa ? 'LIGADA' : 'desligada'} por ${novo.por || '-'}`);
        res.json(novo);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ================= TEMPO REAL (SSE) — Fase 4 do roadmap de integracao =================
// Cada navegador logado abre um EventSource em /eventos. Quando QUALQUER usuario
// grava algo (hook em registrarAuditoria), empurramos um "dados:mudou" para todos
// os clientes; o front repassa ao window.Bus e a tela visivel se atualiza sozinha
// — inclusive em OUTRO PC. Reconexao e automatica (EventSource + "retry").
const sseClientes = new Set();

app.get('/eventos', (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write('retry: 5000\n\n');   // reconecta apos 5s se a conexao cair
    res.write(': conectado\n\n');
    const cliente = { res };
    sseClientes.add(cliente);
    // Ping periodico para manter a conexao viva (keep-alive de proxies/navegador).
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
    req.on('close', () => { clearInterval(ping); sseClientes.delete(cliente); });
});

// Envia um evento SSE a todos os clientes conectados (best-effort).
function broadcastEvento(origem, extra) {
    if (!sseClientes.size) return;
    const payload = JSON.stringify({ origem: origem || 'dados', ts: Date.now(), ...(extra || {}) });
    const linha = `data: ${payload}\n\n`;
    for (const cliente of sseClientes) {
        try { cliente.res.write(linha); } catch (_) { sseClientes.delete(cliente); }
    }
}

// ================= AVISO DE VERSAO NOVA DO FRONT =================
// O deploy aqui e copia manual de arquivo; sem isso, cada usuario so ve a
// versao nova quando lembra de dar F5 — e pode passar dias na antiga.
//
// A "impressao digital" e o hash do index.html. Parece pouco, mas e exatamente
// o certo: e la que moram todos os "?v=N", entao qualquer deploy de front muda
// esse arquivo. E se alguem trocar um .js SEM bumpar o ?v=, o navegador
// tambem nao pegaria a versao nova (o cache e por URL) — nao avisar, nesse
// caso, e coerente. Custo: ler UM arquivo, e nao os ~80 de public/, o que
// importa num file server que oscila.
const INDEX_HTML = path.join(__dirname, '..', 'public', 'html', 'index.html');
// 10s, e nao 60s, porque a checagem barata (abaixo) custa um stat e nao a
// leitura dos ~256 KB do arquivo. fs.watch resolveria isso na hora, mas num
// share SMB ele estoura "UNKNOWN: unknown error, watch" — testado aqui.
const VERSAO_CHECAGEM_MS = 10000;
let _digitalFront = null;
let _assinaturaArquivo = null; // mtime+tamanho: o "mudou?" barato

// Le o arquivo inteiro e devolve o hash. So chamada quando o stat indica
// mudanca — num file server que oscila, ler 256 KB de 10 em 10 segundos seria
// somar trafego a um ponto que ja e o gargalo.
function hashDoIndex() {
    try {
        return crypto.createHash('sha1').update(fs.readFileSync(INDEX_HTML)).digest('hex').slice(0, 12);
    } catch (_) {
        return null; // blip de rede: mantem a digital anterior
    }
}

// Confere pelo stat (mtime + tamanho) e so vai ao conteudo se algo mudou.
// Devolve true quando a digital efetivamente mudou.
function conferirVersaoFront() {
    let assinatura;
    try {
        const st = fs.statSync(INDEX_HTML);
        assinatura = `${st.mtimeMs}:${st.size}`;
    } catch (_) {
        return false;
    }
    if (assinatura === _assinaturaArquivo) return false;
    _assinaturaArquivo = assinatura;

    const nova = hashDoIndex();
    // mtime muda numa copia que nao altera o conteudo (o deploy e copia de
    // arquivo); o hash evita avisar todo mundo a toa nesse caso.
    if (!nova || nova === _digitalFront) return false;
    _digitalFront = nova;
    return true;
}

function avisarVersaoNova() {
    console.log(`[versao] front mudou (${_digitalFront}) — avisando ${sseClientes.size} cliente(s).`);
    broadcastEvento('versao', { digital: _digitalFront });
}

function vigiarVersaoFront() {
    conferirVersaoFront(); // primeira leitura, sem avisar ninguem
    setInterval(() => {
        if (conferirVersaoFront()) avisarVersaoNova();
    }, VERSAO_CHECAGEM_MS).unref();
}

app.get('/versao-front', (req, res) => {
    res.json({ digital: _digitalFront || hashDoIndex(), checagem_ms: VERSAO_CHECAGEM_MS });
});


// So tabelas operacionais viram broadcast (auth/config/usuarios ficam de fora).
const AUDITORIA_ORIGEM = {
    ocorrencias: 'ocorrencia',
    ocorrencias_avulsas: 'avulsa',
    ocorrencias_operacionais: 'ocorrencia',
    ocorrencias_motorista: 'ocorrencia',
    metas_loja: 'meta',
    tms_viagens: 'tms',
    tms_paradas: 'tms',
    avisos_monitoramento: 'monitoramento',
    checklists_diarios: 'checklist',
    atrasos_saida: 'saida-fabrica',
    rotas_registradas: 'deslocamento',
    almocos: 'almoco',
    tacografos: 'tacografo',
    diarios_bordo: 'diario-bordo',
    entregas_dia: 'entrega',
    docas: 'docas',
    loja_responsaveis: 'cadastro',
    roteiros_padrao: 'deslocamento',
    controle_uber: 'transporte',
    wms_erro_volume: 'wms',
};
function broadcastAuditoria(recurso) {
    const origem = AUDITORIA_ORIGEM[recurso];
    if (origem) broadcastEvento(origem, { remoto: true });
}

// ================================================================
// CONFIGURACOES CENTRALIZADAS (chave/valor em JSONB)
//   GET: qualquer usuario logado (operador inclusive).
//   PUT: somente ADM (bloqueado pelo middleware acima para operador).
// ================================================================
app.get('/config/:chave', async (req, res) => {
    try {
        // Os codigos de auto-cadastro sao segredo: so o master le (pelo endpoint dedicado).
        if (CADASTRO_CODIGO_CHAVES.has(req.params.chave) && req.usuarioLogado?.super_adm !== true) {
            return res.status(200).json({ valor: null });
        }
        const r = await db.query('SELECT valor FROM sistema_config WHERE chave = $1', [req.params.chave]);
        if (r.rowCount === 0) return res.status(200).json({ valor: null });
        res.status(200).json({ valor: r.rows[0].valor });
    } catch (err) {
        console.error('[GET /config]', err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/config/:chave', async (req, res) => {
    try {
        const valor = req.body ? req.body.valor : undefined;
        if (valor === undefined) {
            return res.status(400).json({ error: 'Campo "valor" e obrigatorio.' });
        }
        const r = await db.query(`
            INSERT INTO sistema_config (chave, valor, atualizado_em)
            VALUES ($1, $2, NOW())
            ON CONFLICT (chave) DO UPDATE SET valor = $2, atualizado_em = NOW()
            RETURNING *;
        `, [req.params.chave, JSON.stringify(valor)]);
        await registrarAuditoria(req, 'PUT', 'config', req.params.chave, { valor });
        res.status(200).json({ valor: r.rows[0].valor });
    } catch (err) {
        console.error('[PUT /config]', err);
        res.status(500).json({ error: err.message });
    }
});

// ================================================================
// PAINEL "AGORA" — RESUMO OPERACIONAL + ALERTAS (somente leitura)
//   Agrega indicadores do DIA a partir de dados que ja existem no sistema
//   (viagens/paradas do TMS, ocorrencias e ocorrencias avulsas). Cada bloco e
//   calculado de forma defensiva: se uma consulta falhar, os demais numeros
//   ainda voltam e o erro e listado em "erros" (o painel nunca derruba a tela).
//   Liberado a qualquer usuario logado (esta na whitelist do operador).
// ================================================================
function _hhmmParaMin(valor) {
    const m = String(valor || '').match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const min = Number(m[1]) * 60 + Number(m[2]);
    return Number.isFinite(min) ? min : null;
}

app.get('/painel/resumo', async (req, res) => {
    const erros = [];
    const ind = {
        viagens_hoje: 0, entregas_pendentes: 0, entregas_concluidas: 0,
        entregas_atrasadas: 0, entregas_perto_limite: 0, ocorrencias_abertas: 0,
        rotas_em_risco: 0, motoristas_sem_checklist: 0, saidas_atrasadas: 0,
        viagens_sem_cte: 0, entregas_visitadas_sem_registro: 0
    };
    const alertas = [];
    const agora = new Date();
    const nowMin = agora.getHours() * 60 + agora.getMinutes();

    // ---- Viagens e paradas de HOJE (TMS) ----
    const rotasRisco = new Set();
    try {
        const q = await db.query(`
            SELECT v.id AS viagem_id, v.status AS viagem_status,
                   COALESCE(v.rota_nome, r.nome, '(sem rota)') AS rota_nome,
                   p.id AS parada_id, p.status AS parada_status,
                   to_char(p.hora_prevista, 'HH24:MI') AS hora_prevista,
                   COALESCE(p.cte_concluido, FALSE) AS cte_concluido,
                   (p.remessas IS NOT NULL) AS tem_remessas,
                   COALESCE(p.loja_nome, l.nome) AS loja_nome,
                   o.ocorrencia_status,
                   -- O GPS ja viu o caminhao nesta loja (rastreador-ao-vivo.js):
                   -- pendente so de REGISTRO, nao e mais "atrasada".
                   EXISTS (SELECT 1 FROM rastreador_eventos_loja e
                            WHERE e.parada_id = p.id AND e.tipo IN ('chegou_loja','saiu_loja')) AS gps_visitada
            FROM tms_viagens v
            LEFT JOIN tms_rotas r ON r.id = v.rota_id
            LEFT JOIN tms_paradas p ON p.viagem_id = v.id
            LEFT JOIN tms_lojas l ON l.id = p.loja_id
            LEFT JOIN LATERAL (
                SELECT oc.ocorrencia_status
                FROM ocorrencias oc
                WHERE (oc.id = p.ocorrencia_id OR oc.parada_id = p.id) AND oc.excluida_em IS NULL
                ORDER BY (oc.id = p.ocorrencia_id) DESC, oc.id DESC LIMIT 1
            ) o ON TRUE
            WHERE v.data_viagem = CURRENT_DATE AND v.status <> 'Cancelada'
        `);
        const viagens = new Set();
        const semCte = new Set();
        const statusPend = new Set(['pendente', 'em atendimento']);
        const statusFeito = new Set(['entregue', 'entregue com ocorrencia', 'recusada']);
        const norm = (s) => String(s || '').trim().toLowerCase();
        let perto = 0;
        let atrasadasPrev = 0;
        for (const row of q.rows) {
            viagens.add(row.viagem_id);
            if (!row.parada_id) continue;
            const st = norm(row.parada_status);
            const pendente = statusPend.has(st);
            if (pendente) ind.entregas_pendentes += 1;
            if (pendente && row.gps_visitada) ind.entregas_visitadas_sem_registro += 1;
            if (statusFeito.has(st)) ind.entregas_concluidas += 1;
            const prevMin = _hhmmParaMin(row.hora_prevista);
            if (pendente && !row.gps_visitada && prevMin != null) {
                if (prevMin < nowMin) { atrasadasPrev += 1; rotasRisco.add(row.rota_nome); }
                else if (prevMin - nowMin <= 30) perto += 1;
            }
            if (norm(row.ocorrencia_status) === 'aberta') rotasRisco.add(row.rota_nome);
            const ativa = ['liberada', 'em rota', 'retorno', 'finalizada'].includes(norm(row.viagem_status));
            if (ativa && row.tem_remessas && !row.cte_concluido) semCte.add(row.viagem_id);
        }
        ind.viagens_hoje = viagens.size;
        ind.entregas_perto_limite = perto;
        ind.viagens_sem_cte = semCte.size;
        ind._atrasadasPrev = atrasadasPrev;
    } catch (err) { erros.push(`viagens: ${err.message}`); }

    // ---- Ocorrencias/entregas de HOJE: SLA, checklist e saida da fabrica ----
    try {
        const q = await db.query(`
            SELECT NULLIF(motorista, '') AS motorista, fez_checklist, sla_status,
                   hora_marcada_saida, hora_saida_fabrica,
                   COALESCE(NULLIF(rota, ''), '(sem rota)') AS rota
            FROM ocorrencias
            WHERE data_ocorrencia = CURRENT_DATE AND excluida_em IS NULL
        `);
        const semChecklist = new Set();
        const saidasAtraso = new Set();
        let slaAtrasadas = 0;
        for (const row of q.rows) {
            if (row.fez_checklist === false && row.motorista) semChecklist.add(row.motorista);
            if (String(row.sla_status || '').toLowerCase() === 'atrasada') { slaAtrasadas += 1; rotasRisco.add(row.rota); }
            const marc = _hhmmParaMin(row.hora_marcada_saida);
            const real = _hhmmParaMin(row.hora_saida_fabrica);
            if (marc != null && real != null && real > marc) {
                saidasAtraso.add(row.motorista || `rota:${row.rota}`);
                rotasRisco.add(row.rota);
            }
        }
        ind.motoristas_sem_checklist = semChecklist.size;
        ind.saidas_atrasadas = saidasAtraso.size;
        // "Atrasadas hoje" = pendentes que passaram do previsto + entregas com SLA atrasado.
        ind.entregas_atrasadas = (ind._atrasadasPrev || 0) + slaAtrasadas;
        ind._semChecklistNomes = [...semChecklist];
    } catch (err) { erros.push(`ocorrencias: ${err.message}`); }
    delete ind._atrasadasPrev;

    ind.rotas_em_risco = rotasRisco.size;

    // ---- Ocorrencias abertas e "sem responsavel" ----
    let semResp = 0;
    try {
        const q = await db.query(`
            SELECT
              (SELECT COUNT(*)::int FROM ocorrencias_avulsas WHERE status = 'Aberta') AS avulsas_abertas,
              (SELECT COUNT(*)::int FROM ocorrencias_avulsas WHERE status = 'Aberta' AND NULLIF(culpa, '') IS NULL) AS avulsas_sem_resp,
              (SELECT COUNT(*)::int FROM ocorrencias WHERE teve_ocorrencia = TRUE AND ocorrencia_status = 'Aberta' AND excluida_em IS NULL) AS oco_abertas,
              (SELECT COUNT(*)::int FROM ocorrencias WHERE teve_ocorrencia = TRUE AND ocorrencia_status = 'Aberta' AND excluida_em IS NULL AND NULLIF(ocorrencia_responsavel, '') IS NULL) AS oco_sem_resp
        `);
        const r = q.rows[0] || {};
        ind.ocorrencias_abertas = (r.avulsas_abertas || 0) + (r.oco_abertas || 0);
        semResp = (r.avulsas_sem_resp || 0) + (r.oco_sem_resp || 0);
    } catch (err) { erros.push(`ocorrencias_abertas: ${err.message}`); }

    // ---- Rotas com atraso recorrente (ultimos 7 dias) — melhor esforco ----
    let rotasRecorrentes = [];
    try {
        const q = await db.query(`
            SELECT NULLIF(rota, '') AS rota, COUNT(*)::int AS qtd
            FROM ocorrencias
            WHERE data_ocorrencia >= CURRENT_DATE - INTERVAL '7 days'
              AND excluida_em IS NULL AND sla_status = 'Atrasada'
              AND NULLIF(rota, '') IS NOT NULL
            GROUP BY 1 HAVING COUNT(*) >= 3 ORDER BY qtd DESC LIMIT 3
        `);
        rotasRecorrentes = q.rows;
    } catch (err) { erros.push(`rotas_recorrentes: ${err.message}`); }

    // ================= MONTA ALERTAS (acionaveis, sem spam) =================
    const add = (nivel, icone, titulo, detalhe, aba) => alertas.push({ nivel, icone, titulo, detalhe, aba });
    if (ind.entregas_atrasadas > 0)
        add('alto', '⏰', `${ind.entregas_atrasadas} entrega(s) atrasada(s) hoje`, 'Passaram do horário previsto ou chegaram fora do prazo.', 'tms');
    if (ind.entregas_perto_limite > 0)
        add('medio', '⏳', `${ind.entregas_perto_limite} entrega(s) perto do horário limite`, 'Previstas para os próximos 30 minutos.', 'tms');
    if (ind.saidas_atrasadas > 0)
        add('medio', '🏭', `${ind.saidas_atrasadas} saída(s) da fábrica atrasada(s)`, 'Motoristas saíram depois do horário marcado.', 'entregas');
    if (ind.motoristas_sem_checklist > 0)
        add('alto', '📋', `${ind.motoristas_sem_checklist} motorista(s) sem checklist`, (ind._semChecklistNomes || []).join(', ') || 'Checklist de chegada não registrado.', 'entregas');
    if (ind.viagens_sem_cte > 0)
        add('medio', '📄', `${ind.viagens_sem_cte} viagem(ns) sem CTE emitido`, 'Há paradas com remessa e CTE ainda pendente. Emita os CTEs do dia.', 'ctes');
    if (semResp > 0)
        add('medio', '❓', `${semResp} ocorrência(s) aberta(s) sem responsável`, 'Defina o responsável para dar andamento.', 'ocorrencias-avulsas');
    for (const rr of rotasRecorrentes)
        add('medio', '🔁', `Atraso recorrente: ${rr.rota}`, `${rr.qtd} atrasos nos últimos 7 dias.`, 'tendencias');

    delete ind._semChecklistNomes;
    res.status(200).json({
        atualizado_em: agora.toISOString(),
        indicadores: ind,
        alertas,
        erros
    });
});

// ================================================================
// FILA "RESOLVER AGORA" — worklist de pendencias ACIONAVEIS (read-only)
// ----------------------------------------------------------------
// Diferente de /painel/resumo (contadores + alertas), este endpoint devolve
// ITENS individuais que alguem precisa resolver, ja priorizados. Cada item
// carrega o suficiente para o front levar o usuario direto ao registro:
//   - ocorrencia_id -> abre a ocorrencia (editarOcorrencia no front)
//   - senao         -> navega para a aba indicada (irParaAba)
// Ordem: sem responsavel/alta prioridade primeiro. Nenhuma escrita aqui.
// ================================================================
// Prazo para uma ocorrencia sair do "Aberta". Serve de regua para a fila e para
// o resumo de backlog. Vale a IDADE e nao a severidade de proposito: em
// 29/07/2026 as 112 ocorrencias abertas tinham severidade em branco, entao
// qualquer regra baseada nela nasceria morta. Ajustavel por OCO_PRAZO_DIAS.
const OCO_PRAZO_DIAS = _intNoIntervalo(process.env.OCO_PRAZO_DIAS, 7, 365);

// Resumo do backlog de ocorrencias por faixa de idade, mais a lista das abertas
// da mais velha para a mais nova. Existe porque "112 abertas" num KPI nao diz
// se sao de ontem ou de dois meses atras — e, em 29/07/2026, 76 delas passavam
// de 30 dias. A faixa e o que transforma o numero em acao.
app.get('/ocorrencias/backlog', async (req, res) => {
    try {
        const resumo = await db.query(`
            SELECT
                COUNT(*)::int AS abertas,
                COUNT(*) FILTER (WHERE CURRENT_DATE - data_ocorrencia <= 7)::int  AS ate_7,
                COUNT(*) FILTER (WHERE CURRENT_DATE - data_ocorrencia BETWEEN 8 AND 30)::int AS de_8_a_30,
                COUNT(*) FILTER (WHERE CURRENT_DATE - data_ocorrencia > 30)::int  AS mais_30,
                COUNT(*) FILTER (WHERE CURRENT_DATE - data_ocorrencia > $1)::int  AS vencidas,
                COUNT(*) FILTER (WHERE NULLIF(TRIM(COALESCE(ocorrencia_responsavel,'')),'') IS NULL)::int AS sem_responsavel,
                COALESCE(MAX(CURRENT_DATE - data_ocorrencia), 0)::int AS mais_antiga_dias
            FROM ocorrencias
            WHERE excluida_em IS NULL AND ocorrencia_status = 'Aberta'
        `, [OCO_PRAZO_DIAS]);

        const lista = await db.query(`
            SELECT id,
                   to_char(data_ocorrencia, 'DD/MM/YYYY')            AS data,
                   (CURRENT_DATE - data_ocorrencia)::int             AS dias,
                   NULLIF(loja, '')                                  AS loja,
                   NULLIF(rota, '')                                  AS rota,
                   NULLIF(motorista, '')                             AS motorista,
                   NULLIF(tipo_problema, '')                         AS tipo,
                   NULLIF(TRIM(COALESCE(ocorrencia_responsavel,'')),'') AS responsavel
            FROM ocorrencias
            WHERE excluida_em IS NULL AND ocorrencia_status = 'Aberta'
            ORDER BY data_ocorrencia ASC, id ASC
            LIMIT 300
        `);

        res.json({ prazo_dias: OCO_PRAZO_DIAS, resumo: resumo.rows[0], itens: lista.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Encerra varias ocorrencias de uma vez. O backlog acumulado e em boa parte
// coisa ja resolvida na pratica que ninguem voltou para fechar; sem isso, a
// unica saida e abrir 76 registros um a um. Exige motivo: fechar em massa sem
// dizer por que so troca um problema (fila suja) por outro (historico mudo).
// Responsavel SUGERIDO por tipo de problema, aprendido do proprio historico:
// para cada tipo, quem foi marcado responsavel nas ocorrencias que tiveram SO
// aquele tipo (as de varios tipos nao dizem de quem era cada um). Sugere quem
// aparece em >= 50% delas, com no minimo 3 casos. O formulario pre-marca a
// sugestao quando ninguem escolheu responsavel ainda (sempre editavel).
// Em 02/10/2026: "Mercadoria a mais" -> EXPEDICAO em 25/25; "Atraso" ->
// EQUIPE DA ENTREGA em ~55% (e 144 atrasos sem responsavel nenhum).
let sugestaoResponsavelCache = { em: 0, valor: null };
app.get('/ocorrencias/responsavel-sugerido', async (req, res) => {
    try {
        if (sugestaoResponsavelCache.valor && Date.now() - sugestaoResponsavelCache.em < 10 * 60 * 1000) {
            return res.json(sugestaoResponsavelCache.valor);
        }
        const r = await db.query(`
            SELECT tipo_problema, ocorrencia_responsavel
              FROM ocorrencias
             WHERE excluida_em IS NULL AND teve_ocorrencia = TRUE
               AND NULLIF(TRIM(COALESCE(tipo_problema,'')),'') IS NOT NULL
               AND NULLIF(TRIM(COALESCE(ocorrencia_responsavel,'')),'') IS NOT NULL
               AND data_ocorrencia >= CURRENT_DATE - 365`);
        const separar = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
        const porTipo = new Map(); // tipo -> { casos, contagem: Map(resp -> n) }
        for (const row of r.rows) {
            const tipos = separar(row.tipo_problema);
            if (tipos.length !== 1) continue;
            const t = tipos[0];
            if (!porTipo.has(t)) porTipo.set(t, { casos: 0, contagem: new Map() });
            const alvo = porTipo.get(t);
            alvo.casos += 1;
            for (const resp of new Set(separar(row.ocorrencia_responsavel).map((x) => x.toUpperCase()))) {
                alvo.contagem.set(resp, (alvo.contagem.get(resp) || 0) + 1);
            }
        }
        const sugestoes = {};
        for (const [tipo, { casos, contagem }] of porTipo) {
            if (casos < 3) continue;
            const fortes = [...contagem.entries()]
                .map(([responsavel, n]) => ({ responsavel, n, pct: Math.round((n / casos) * 100) }))
                .filter((x) => x.pct >= 50)
                .sort((a, b) => b.n - a.n);
            if (fortes.length) sugestoes[tipo] = { casos, responsaveis: fortes };
        }
        const valor = { gerado_em: new Date().toISOString(), sugestoes };
        sugestaoResponsavelCache = { em: Date.now(), valor };
        res.json(valor);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/ocorrencias/encerrar-lote', async (req, res) => {
    try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
        const motivo = String(req.body?.motivo || '').trim();
        if (!ids.length) return res.status(400).json({ error: 'Selecione ao menos uma ocorrencia.' });
        if (ids.length > 300) return res.status(400).json({ error: 'Limite de 300 por vez.' });
        if (!motivo) return res.status(400).json({ error: 'Informe o motivo do encerramento.' });

        // So encerra o que esta ABERTA: evita reescrever tratativa ja concluida
        // se a tela do usuario estiver defasada.
        const result = await db.query(`
            UPDATE ocorrencias
            SET ocorrencia_status = 'Encerrada',
                acao_corretiva = CASE
                    WHEN NULLIF(TRIM(COALESCE(acao_corretiva,'')),'') IS NULL THEN $2
                    ELSE acao_corretiva || E'\\n' || $2
                END
            WHERE id = ANY($1::int[]) AND excluida_em IS NULL AND ocorrencia_status = 'Aberta'
            RETURNING id
        `, [ids, `[encerramento em lote] ${motivo}`]);

        const encerradas = result.rows.map((r) => r.id);
        await registrarAuditoria(req, 'ENCERRAR_LOTE', 'ocorrencias', null, {
            solicitadas: ids.length, encerradas: encerradas.length, motivo,
        });
        res.json({
            encerradas: encerradas.length,
            ignoradas: ids.length - encerradas.length, // ja nao estavam abertas
            ids: encerradas,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/painel/fila', async (req, res) => {
    const erros = [];
    const itens = [];
    const agora = new Date();

    // 1) Ocorrencias de parada/entrega ABERTAS.
    // A ordem e por IDADE (mais VELHA primeiro), nao por data mais recente.
    // Com o LIMIT abaixo, ordenar pelas recentes fazia o backlog antigo nunca
    // chegar na fila: em 29/07/2026 havia 76 abertas com mais de 30 dias (a mais
    // velha com 68) que ninguem via, justamente as que mais precisavam sair.
    try {
        const q = await db.query(`
            SELECT id,
                   NULLIF(ocorrencia_responsavel, '') AS resp,
                   NULLIF(tipo_problema, '')          AS tipo,
                   NULLIF(rota, '')                   AS rota,
                   NULLIF(motorista, '')              AS motorista,
                   to_char(data_ocorrencia, 'DD/MM')  AS data,
                   (CURRENT_DATE - data_ocorrencia)   AS dias
            FROM ocorrencias
            WHERE teve_ocorrencia = TRUE AND ocorrencia_status = 'Aberta' AND excluida_em IS NULL
            ORDER BY data_ocorrencia ASC, id ASC
            LIMIT 40
        `);
        for (const r of q.rows) {
            const semResp = !r.resp;
            const dias = Number(r.dias) || 0;
            const vencida = dias > OCO_PRAZO_DIAS;
            const ctx = [r.rota, r.motorista, r.data].filter(Boolean).join(' · ');
            const idade = dias === 0 ? 'hoje' : dias === 1 ? 'há 1 dia' : `há ${dias} dias`;
            itens.push({
                chave: `oco-${r.id}`,
                tipo: semResp ? 'ocorrencia_sem_resp' : vencida ? 'ocorrencia_vencida' : 'ocorrencia_aberta',
                // Vencida sobe para alta mesmo com responsavel definido: ter dono
                // e nao ter saido em OCO_PRAZO_DIAS e exatamente o caso a cobrar.
                prioridade: semResp || vencida ? 'alta' : 'media',
                icone: semResp ? '❓' : vencida ? '⏰' : '📌',
                titulo: `Ocorrência: ${r.tipo || 'sem tipo definido'}`,
                detalhe: (ctx ? ctx + ' — ' : '') + (semResp ? 'sem responsável' : `resp.: ${r.resp}`) +
                    ` · aberta ${idade}` + (vencida ? ` (passou de ${OCO_PRAZO_DIAS} dias)` : ''),
                aba: 'entregas',
                ocorrencia_id: r.id,
                dias_aberta: dias,
                vencida,
            });
        }
    } catch (err) { erros.push(`ocorrencias: ${err.message}`); }

    // 2) Ocorrencias AVULSAS abertas (sem culpado/responsavel primeiro).
    try {
        const q = await db.query(`
            SELECT id,
                   NULLIF(culpa, '')                                  AS culpa,
                   COALESCE(NULLIF(titulo, ''), LEFT(descricao, 60))  AS rotulo,
                   NULLIF(rota_nome, '')                              AS rota,
                   NULLIF(loja, '')                                   AS loja,
                   to_char(data_ocorrencia, 'DD/MM')                  AS data,
                   (CURRENT_DATE - data_ocorrencia)                   AS dias
            FROM ocorrencias_avulsas
            WHERE status = 'Aberta'
            ORDER BY data_ocorrencia ASC, id ASC
            LIMIT 40
        `);
        for (const r of q.rows) {
            const semResp = !r.culpa;
            const dias = Number(r.dias) || 0;
            const vencida = dias > OCO_PRAZO_DIAS;
            const ctx = [r.loja, r.rota, r.data].filter(Boolean).join(' · ');
            const idade = dias === 0 ? 'hoje' : dias === 1 ? 'há 1 dia' : `há ${dias} dias`;
            itens.push({
                chave: `avu-${r.id}`,
                tipo: semResp ? 'avulsa_sem_resp' : vencida ? 'avulsa_vencida' : 'avulsa_aberta',
                prioridade: semResp || vencida ? 'alta' : 'media',
                icone: semResp ? '❓' : vencida ? '⏰' : '📌',
                titulo: `Avulsa: ${r.rotulo || 'sem descrição'}`,
                detalhe: (ctx ? ctx + ' — ' : '') + (semResp ? 'sem responsável' : `resp.: ${r.culpa}`) +
                    ` · aberta ${idade}` + (vencida ? ` (passou de ${OCO_PRAZO_DIAS} dias)` : ''),
                aba: 'ocorrencias-avulsas',
                avulsa_id: r.id,
                dias_aberta: dias,
                vencida,
            });
        }
    } catch (err) { erros.push(`avulsas: ${err.message}`); }

    // 3) Checklists de chegada NAO registrados (motoristas de hoje).
    try {
        const q = await db.query(`
            SELECT id, NULLIF(motorista, '') AS motorista, NULLIF(rota, '') AS rota
            FROM ocorrencias
            WHERE data_ocorrencia = CURRENT_DATE AND excluida_em IS NULL
              AND fez_checklist = FALSE AND NULLIF(motorista, '') IS NOT NULL
            ORDER BY id DESC LIMIT 20
        `);
        for (const r of q.rows) {
            itens.push({
                chave: `chk-${r.id}`,
                tipo: 'sem_checklist',
                prioridade: 'alta',
                icone: '📋',
                titulo: `Checklist pendente: ${r.motorista}`,
                detalhe: (r.rota ? r.rota + ' — ' : '') + 'checklist de chegada não registrado',
                aba: 'entregas',
                ocorrencia_id: r.id,
            });
        }
    } catch (err) { erros.push(`checklist: ${err.message}`); }

    // 4) Viagens de hoje com paradas que tem remessa e ainda SEM CTE.
    try {
        const q = await db.query(`
            SELECT v.id AS viagem_id,
                   COALESCE(v.rota_nome, r.nome, '(sem rota)') AS rota,
                   COUNT(*) FILTER (WHERE p.remessas IS NOT NULL AND NOT COALESCE(p.cte_concluido, FALSE))::int AS pend
            FROM tms_viagens v
            LEFT JOIN tms_rotas r ON r.id = v.rota_id
            LEFT JOIN tms_paradas p ON p.viagem_id = v.id
            WHERE v.data_viagem = CURRENT_DATE AND v.status <> 'Cancelada'
              AND LOWER(v.status) IN ('liberada', 'em rota', 'retorno', 'finalizada')
            GROUP BY v.id, rota
            HAVING COUNT(*) FILTER (WHERE p.remessas IS NOT NULL AND NOT COALESCE(p.cte_concluido, FALSE)) > 0
            ORDER BY pend DESC LIMIT 20
        `);
        for (const r of q.rows) {
            itens.push({
                chave: `cte-${r.viagem_id}`,
                tipo: 'sem_cte',
                prioridade: 'media',
                icone: '📄',
                titulo: `CTE pendente: ${r.rota}`,
                detalhe: `${r.pend} parada(s) com remessa aguardando emissão de CTE`,
                aba: 'ctes',
                viagem_id: r.viagem_id,
            });
        }
    } catch (err) { erros.push(`cte: ${err.message}`); }

    // Ordena por prioridade (alta > media > baixa) mantendo a ordem interna.
    const peso = { alta: 0, media: 1, baixa: 2 };
    // Dentro da mesma prioridade, o mais VELHO primeiro: e o que estava parado
    // ha mais tempo que precisa sair, nao o que acabou de entrar. Itens sem
    // idade (checklist, CTE) contam como 0 e ficam depois dos envelhecidos.
    itens.sort((a, b) =>
        ((peso[a.prioridade] ?? 3) - (peso[b.prioridade] ?? 3)) ||
        ((b.dias_aberta || 0) - (a.dias_aberta || 0))
    );

    res.status(200).json({
        atualizado_em: agora.toISOString(),
        total: itens.length,
        itens: itens.slice(0, 60),
        erros,
    });
});

// ================================================================
// RISCO PREDITIVO DE ATRASO  (GET /painel/risco)
// ----------------------------------------------------------------
// "Quem tem mais chance de atrasar HOJE?" — cruza a escala do dia
// (tms_viagens de hoje) com o historico de cada motorista nos ultimos N
// dias. O score (0-100) e DETERMINISTICO e transparente: sai de tres sinais
// que ja existem — atraso na saida de fabrica, estouro de tempo de rota e
// ocorrencias. Nada de "chute" da IA no numero. A IA (Gemini, via
// chamarIaAnalitica) so entra por cima, escrevendo um briefing acionavel a
// partir desses numeros — e degrada de boa: sem chave/erro, os scores valem
// sozinhos. Sem escala hoje, vira uma watchlist geral dos piores.
// ================================================================
const RISCO_LOOKBACK_PADRAO = 60;   // dias de historico
const RISCO_RECENTE_DIAS = 14;      // janela "esta piorando?"
const RISCO_AMOSTRA_MIN = 3;        // menos que isso = dados insuficientes
const riscoCache = new Map();
const RISCO_TTL_MS = Number(process.env.PAINEL_RISCO_TTL_MS || 10 * 60 * 1000);

function riscoNorm(s) {
    return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
}
function riscoNivel(score, amostra) {
    if (amostra < RISCO_AMOSTRA_MIN) return 'insuficiente';
    if (score >= 60) return 'alto';
    if (score >= 30) return 'medio';
    return 'baixo';
}

// Combina os fatores de UM motorista num score 0-100 + fatores detalhados.
function riscoCalcular(a, b, c) {
    const saidaReg = a?.registros || 0;
    const saidaAtr = a?.atrasadas || 0;
    const saidaMedia = a?.media_min || 0;
    const rotaReg = b?.registros || 0;
    const rotaExc = b?.excedentes || 0;
    const ocoReg = c?.registros || 0;
    const ocoProb = c?.com_problema || 0;

    const taxaSaida = saidaReg ? saidaAtr / saidaReg : 0;             // % de saidas atrasadas
    const sevSaida = Math.min(saidaMedia / 30, 1);                    // gravidade (30min+ = teto)
    const taxaRota = rotaReg ? rotaExc / rotaReg : 0;                 // % de rotas que estouraram
    const taxaOco = ocoReg ? ocoProb / ocoReg : 0;                    // % de registros com ocorrencia

    const score = Math.round(100 * (
        0.40 * taxaSaida +
        0.15 * sevSaida +
        0.25 * taxaRota +
        0.20 * taxaOco
    ));

    // "Esta piorando": ultimos 14d pioraram vs. a media geral (>=2 amostras recentes).
    const recReg = a?.reg_recentes || 0;
    const recAtr = a?.atrasadas_recentes || 0;
    const taxaRecente = recReg ? recAtr / recReg : 0;
    const piorando = recReg >= 2 && taxaRecente > taxaSaida * 1.25 && taxaRecente > 0.3;

    const amostra = saidaReg + rotaReg + ocoReg;
    return {
        score: Math.max(0, Math.min(100, score)),
        nivel: riscoNivel(score, amostra),
        fatores: {
            saida: { registros: saidaReg, atrasadas: saidaAtr, pct: Math.round(taxaSaida * 100), media_min: saidaMedia },
            rota: { registros: rotaReg, excedentes: rotaExc, pct: Math.round(taxaRota * 100) },
            ocorrencia: { registros: ocoReg, com_problema: ocoProb, pct: Math.round(taxaOco * 100) },
            amostra,
            piorando,
        },
    };
}

// Frase-resumo humana pros fatores mais relevantes.
function riscoResumo(f) {
    const partes = [];
    if (f.saida.registros) partes.push(`${f.saida.atrasadas}/${f.saida.registros} saidas atrasadas${f.saida.media_min ? ` (med. ${f.saida.media_min}min)` : ''}`);
    if (f.rota.excedentes) partes.push(`${f.rota.excedentes} rota(s) estourou o tempo`);
    if (f.ocorrencia.com_problema) partes.push(`${f.ocorrencia.com_problema} ocorrencia(s)`);
    if (!partes.length) return f.amostra ? 'Historico limpo no periodo' : 'Sem historico no periodo';
    return partes.join(' · ');
}

async function montarRisco(dias) {
    const erros = [];
    const params = [dias];
    const porMotorista = new Map();  // chave normalizada -> { nome, a, b, c, rota, status, hoje }

    const bucket = (nomeExibicao) => {
        const chave = riscoNorm(nomeExibicao);
        if (!porMotorista.has(chave)) porMotorista.set(chave, { nome: nomeExibicao, a: null, b: null, c: null, rota: null, status: null, hoje: false });
        return porMotorista.get(chave);
    };

    // Sinal 1: atraso na saida de fabrica (peso maior) + janela recente.
    await iaConsulta(erros, 'atrasos_saida', async () => {
        const r = await db.query(`
            SELECT TRIM(motorista) AS motorista,
                   COUNT(*)::int AS registros,
                   COUNT(*) FILTER (WHERE COALESCE(NULLIF(atraso_min::text,'')::numeric,0) > 0)::int AS atrasadas,
                   COALESCE(ROUND(AVG(NULLIF(NULLIF(atraso_min::text,'')::numeric,0)))::int,0) AS media_min,
                   COUNT(*) FILTER (WHERE NULLIF(data::text,'')::date >= CURRENT_DATE - ${RISCO_RECENTE_DIAS})::int AS reg_recentes,
                   COUNT(*) FILTER (WHERE NULLIF(data::text,'')::date >= CURRENT_DATE - ${RISCO_RECENTE_DIAS}
                                      AND COALESCE(NULLIF(atraso_min::text,'')::numeric,0) > 0)::int AS atrasadas_recentes
            FROM atrasos_saida
            WHERE NULLIF(data::text,'')::date >= CURRENT_DATE - ($1::int * INTERVAL '1 day')
              AND NULLIF(TRIM(motorista),'') IS NOT NULL
            GROUP BY 1
        `, params);
        for (const row of r.rows) bucket(row.motorista).a = row;
    }, null);

    // Sinal 2: estouro de tempo de rota.
    await iaConsulta(erros, 'rotas_registradas', async () => {
        const r = await db.query(`
            SELECT TRIM(motorista) AS motorista,
                   COUNT(*)::int AS registros,
                   COUNT(*) FILTER (WHERE COALESCE(NULLIF(minutos_excedentes::text,'')::numeric,0) > 0)::int AS excedentes
            FROM rotas_registradas
            WHERE NULLIF(data::text,'')::date >= CURRENT_DATE - ($1::int * INTERVAL '1 day')
              AND NULLIF(TRIM(motorista),'') IS NOT NULL
            GROUP BY 1
        `, params);
        for (const row of r.rows) bucket(row.motorista).b = row;
    }, null);

    // Sinal 3: ocorrencias de entrega.
    await iaConsulta(erros, 'ocorrencias', async () => {
        const r = await db.query(`
            SELECT TRIM(motorista) AS motorista,
                   COUNT(*)::int AS registros,
                   COUNT(*) FILTER (WHERE teve_ocorrencia = TRUE)::int AS com_problema
            FROM ocorrencias
            WHERE data_ocorrencia >= CURRENT_DATE - ($1::int * INTERVAL '1 day')
              AND excluida_em IS NULL
              AND NULLIF(TRIM(motorista),'') IS NOT NULL
            GROUP BY 1
        `, params);
        for (const row of r.rows) bucket(row.motorista).c = row;
    }, null);

    // Escala de HOJE: quem realmente vai sair (define o universo do briefing).
    let temEscala = false;
    await iaConsulta(erros, 'escala_hoje', async () => {
        const r = await db.query(`
            SELECT TRIM(motorista_nome) AS motorista,
                   NULLIF(TRIM(rota_nome),'') AS rota,
                   status
            FROM tms_viagens
            WHERE data_viagem = CURRENT_DATE
              AND COALESCE(status,'') <> 'Cancelada'
              AND NULLIF(TRIM(motorista_nome),'') IS NOT NULL
            ORDER BY motorista_nome
        `);
        for (const row of r.rows) {
            const bkt = bucket(row.motorista);
            bkt.hoje = true;
            if (!bkt.rota) bkt.rota = row.rota;
            bkt.status = row.status;
            temEscala = true;
        }
    }, null);

    // Monta os itens com score.
    let itens = [];
    for (const m of porMotorista.values()) {
        const calc = riscoCalcular(m.a, m.b, m.c);
        itens.push({
            motorista: m.nome,
            rota: m.rota || null,
            escalado_hoje: m.hoje,
            status: m.status || null,
            score: calc.score,
            nivel: calc.nivel,
            fatores: calc.fatores,
            resumo: riscoResumo(calc.fatores),
        });
    }

    // Universo: se ha escala hoje, foca nela; senao, watchlist geral dos piores.
    if (temEscala) itens = itens.filter((i) => i.escalado_hoje);
    itens.sort((a, b) => b.score - a.score || (a.motorista > b.motorista ? 1 : -1));
    if (!temEscala) itens = itens.slice(0, 15);

    return { itens, temEscala, erros };
}

app.get('/painel/risco', async (req, res) => {
    const dias = Math.max(7, Math.min(180, Number(req.query.dias) || RISCO_LOOKBACK_PADRAO));
    const chaveCache = `risco:${dias}`;
    const cacheado = riscoCache.get(chaveCache);
    if (cacheado && Date.now() - cacheado.em < RISCO_TTL_MS) {
        return res.status(200).json({ ...cacheado.payload, cache: true });
    }

    let dados;
    try {
        dados = await montarRisco(dias);
    } catch (err) {
        console.error('[GET /painel/risco]', err);
        return res.status(500).json({ erro: 'Falha ao calcular o risco preditivo.' });
    }

    // Briefing da IA por cima dos scores (so pros de maior risco; degrada bem).
    let briefing = null;
    let briefingProvedor = null;
    const criticos = dados.itens.filter((i) => i.nivel === 'alto' || i.nivel === 'medio').slice(0, 5);
    if (criticos.length && iaProviderAtivo()) {
        try {
            const contexto = {
                data: 'hoje',
                janela_dias: dias,
                usando_escala_do_dia: dados.temEscala,
                motoristas_risco: criticos.map((i) => ({
                    motorista: i.motorista,
                    rota: i.rota,
                    score: i.score,
                    nivel: i.nivel,
                    saida_fabrica: `${i.fatores.saida.atrasadas}/${i.fatores.saida.registros} atrasos (media ${i.fatores.saida.media_min}min)`,
                    tempo_rota: `${i.fatores.rota.excedentes}/${i.fatores.rota.registros} estouros`,
                    ocorrencias: `${i.fatores.ocorrencia.com_problema}/${i.fatores.ocorrencia.registros}`,
                    piorando: i.fatores.piorando,
                })),
            };
            const pergunta = 'Voce e o briefing matinal da torre logistica. Com base nos motoristas de MAIOR risco de atraso HOJE, escreva um resumo curto e acionavel (no maximo 5 linhas, sem cabecalhos). Para cada motorista critico, cite em 1 frase o motivo principal e UMA acao concreta antes da saida (ex.: liberar 20 min mais cedo, reforcar conferencia da carga). Nao invente nomes nem numeros alem dos fornecidos.';
            const r = await chamarIaAnalitica(pergunta, contexto);
            if (r && r.texto) { briefing = r.texto; briefingProvedor = r.provider || null; }
        } catch (err) {
            dados.erros.push({ origem: 'briefing_ia', detalhe: iaErroAmigavel(err.message) });
        }
    }

    const payload = {
        atualizado_em: new Date().toISOString(),
        janela_dias: dias,
        usando_escala_do_dia: dados.temEscala,
        total: dados.itens.length,
        itens: dados.itens,
        briefing,
        briefing_provedor: briefingProvedor,
        erros: dados.erros,
    };
    riscoCache.set(chaveCache, { em: Date.now(), payload });
    res.status(200).json({ ...payload, cache: false });
});

// ================================================================
// PAINEL OTIF / SLA  (GET /painel/otif)
// ----------------------------------------------------------------
// Revela o KPI que a base ja calcula mas ninguem ve: pontualidade (SLA) e
// OTIF (On Time In Full). O status por entrega ja e gravado em sla_status/
// otif_status (indicadoresEntrega): a "meta" e o hora_agendada_loja. O
// gargalo hoje e COBERTURA — a maioria das entregas nao tem horario-meta,
// cai em "Sem prazo" e fica fora do indicador. O painel mostra os 3 numeros
// (pontualidade, OTIF, cobertura), a tendencia semanal e os piores por loja
// e rota. As "Metas por loja" (GET/POST /metas-loja) atacam a cobertura.
// ================================================================
const OTIF_TTL_MS = Number(process.env.PAINEL_OTIF_TTL_MS || 5 * 60 * 1000);
const otifCache = new Map();

function otifPct(n, d) { return d > 0 ? Math.round((100 * n / d) * 10) / 10 : null; }

async function montarOtif(dias) {
    const erros = [];
    const params = [dias];
    const filtro = `excluida_em IS NULL AND data_ocorrencia >= CURRENT_DATE - ($1::int * INTERVAL '1 day')`;

    const geral = await iaConsulta(erros, 'otif_geral', async () => {
        const r = await db.query(`
            SELECT COUNT(*)::int AS total,
                   COUNT(*) FILTER (WHERE sla_status IN ('No prazo','Atrasada'))::int AS com_meta,
                   COUNT(*) FILTER (WHERE sla_status = 'No prazo')::int AS no_prazo,
                   COUNT(*) FILTER (WHERE sla_status = 'Atrasada')::int AS atrasada,
                   COUNT(*) FILTER (WHERE otif_status = 'Conforme')::int AS conforme,
                   COUNT(*) FILTER (WHERE entrega_completa = TRUE)::int AS completas,
                   COUNT(*) FILTER (WHERE entrega_completa IS NOT NULL)::int AS com_info_completa
            FROM ocorrencias WHERE ${filtro}
        `, params);
        return r.rows[0] || {};
    }, {});

    // n/a LEGÍTIMO: entregas de lojas marcadas "sem horário" e com o agendado em
    // branco. Saem do DENOMINADOR de cobertura (não é lacuna nem atraso). NÃO
    // mexe nos numeradores de pontualidade/OTIF, que já excluem 'Sem prazo'.
    const naLeg = await iaConsulta(erros, 'otif_na_legitimo', async () => {
        const r = await db.query(`
            SELECT COUNT(*)::int AS n
            FROM ocorrencias o
            JOIN metas_loja m ON UPPER(TRIM(o.loja)) = m.loja_chave AND m.sem_horario = TRUE
            WHERE ${filtro} AND o.hora_agendada_loja IS NULL
        `, params);
        return (r.rows[0] || {}).n || 0;
    }, 0);

    const trend = await iaConsulta(erros, 'otif_trend', async () => {
        const r = await db.query(`
            SELECT to_char(date_trunc('week', data_ocorrencia), 'DD/MM') AS semana,
                   COUNT(*) FILTER (WHERE sla_status IN ('No prazo','Atrasada'))::int AS com_meta,
                   COUNT(*) FILTER (WHERE sla_status = 'No prazo')::int AS no_prazo
            FROM ocorrencias WHERE ${filtro}
            GROUP BY date_trunc('week', data_ocorrencia)
            ORDER BY date_trunc('week', data_ocorrencia)
        `, params);
        return r.rows;
    }, []);

    const lojas = await iaConsulta(erros, 'otif_lojas', async () => {
        const r = await db.query(`
            SELECT TRIM(loja) AS loja,
                   COUNT(*)::int AS entregas,
                   COUNT(*) FILTER (WHERE sla_status = 'Atrasada')::int AS atrasadas,
                   COUNT(*) FILTER (WHERE sla_status IN ('No prazo','Atrasada'))::int AS com_meta,
                   COUNT(*) FILTER (WHERE sla_status = 'Sem prazo' OR sla_status IS NULL)::int AS sem_prazo
            FROM ocorrencias
            WHERE ${filtro} AND NULLIF(TRIM(loja),'') IS NOT NULL
            GROUP BY 1
            ORDER BY atrasadas DESC, entregas DESC
            LIMIT 40
        `, params);
        // Mescla grafias da mesma loja antes de cortar o top 8 (senao "AMERICAS"
        // e "AMÉRICAS" ocupariam duas posicoes).
        return mesclarRankingPorLoja(r.rows, 'loja', ['entregas', 'atrasadas', 'com_meta', 'sem_prazo'])
            .sort((a, b) => b.atrasadas - a.atrasadas || b.entregas - a.entregas)
            .slice(0, 8);
    }, []);

    const rotas = await iaConsulta(erros, 'otif_rotas', async () => {
        const r = await db.query(`
            SELECT COALESCE(NULLIF(TRIM(rota),''),'(sem rota)') AS rota,
                   COUNT(*)::int AS entregas,
                   COUNT(*) FILTER (WHERE sla_status = 'Atrasada')::int AS atrasadas,
                   COUNT(*) FILTER (WHERE sla_status IN ('No prazo','Atrasada'))::int AS com_meta
            FROM ocorrencias WHERE ${filtro}
            GROUP BY 1
            HAVING COUNT(*) FILTER (WHERE sla_status = 'Atrasada') > 0
            ORDER BY atrasadas DESC, entregas DESC
            LIMIT 8
        `, params);
        return r.rows;
    }, []);

    // Tempo de deslocamento FÁBRICA → 1ª LOJA (tempo de estrada antes de qualquer
    // operação em loja). Por motorista+dia: a 1ª parada é a de menor hora_chegada;
    // subtraímos a saída da fábrica do dia. Descarta negativos/virada de meia-noite
    // (raro: saída >23h) e trechos > 10h (lixo de digitação). Mediana p/ ignorar
    // dias atípicos de trânsito. Reaproveita o mesmo CTE nas 3 agregações.
    const cteDesloc = `
        WITH base AS (
            SELECT data_ocorrencia,
                   NULLIF(TRIM(motorista),'') AS motorista,
                   COALESCE(NULLIF(TRIM(rota),''),'(sem rota)') AS rota,
                   hora_chegada, dia_seguinte,
                   MIN(hora_saida_fabrica) OVER (PARTITION BY data_ocorrencia, NULLIF(TRIM(motorista),'')) AS saida_fab,
                   -- dia_seguinte (pernoite) vem depois do 1o dia: a 1a parada e a do dia da saida
                   ROW_NUMBER() OVER (PARTITION BY data_ocorrencia, NULLIF(TRIM(motorista),'') ORDER BY dia_seguinte, hora_chegada ASC) AS rn
            FROM ocorrencias
            WHERE ${filtro}
              AND hora_saida_fabrica IS NOT NULL
              AND hora_chegada IS NOT NULL
              AND NULLIF(TRIM(motorista),'') IS NOT NULL
        ),
        valido AS (
            SELECT data_ocorrencia, motorista, rota,
                   EXTRACT(EPOCH FROM (hora_chegada - saida_fab)) / 60.0 AS minutos
            FROM base
            WHERE rn = 1 AND NOT dia_seguinte
              AND EXTRACT(EPOCH FROM (hora_chegada - saida_fab)) / 60.0 BETWEEN 1 AND 600
        )`;

    const deslGeral = await iaConsulta(erros, 'otif_desloc_geral', async () => {
        const r = await db.query(`${cteDesloc}
            SELECT COUNT(*)::int AS amostra,
                   ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY minutos))::int AS mediana_min,
                   ROUND(AVG(minutos))::int AS media_min
            FROM valido
        `, params);
        return r.rows[0] || {};
    }, {});

    const deslRotas = await iaConsulta(erros, 'otif_desloc_rota', async () => {
        const r = await db.query(`${cteDesloc}
            SELECT rota,
                   COUNT(*)::int AS amostra,
                   ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY minutos))::int AS mediana_min
            FROM valido
            GROUP BY rota
            HAVING COUNT(*) >= 3
            ORDER BY mediana_min DESC, amostra DESC
            LIMIT 8
        `, params);
        return r.rows;
    }, []);

    const deslMotoristas = await iaConsulta(erros, 'otif_desloc_motorista', async () => {
        const r = await db.query(`${cteDesloc}
            SELECT motorista,
                   COUNT(*)::int AS amostra,
                   ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY minutos))::int AS mediana_min
            FROM valido
            GROUP BY motorista
            HAVING COUNT(*) >= 3
            ORDER BY mediana_min DESC, amostra DESC
            LIMIT 8
        `, params);
        return r.rows;
    }, []);

    // Deslocamento por TRECHO (origem → destino): generaliza o fábrica→1ª loja
    // para QUALQUER perna do dia. Por motorista+dia ordenado por hora_chegada, a
    // origem da 1ª parada é a FÁBRICA (hora_saida_fabrica); das demais é a loja
    // anterior (fim_descarga = saída da loja, via LAG). Nomes de loja passam por
    // canonicalização (romano↔arábico, underscore→espaço) p/ não rachar baldes
    // (MADUREIRA 1 = MADUREIRA_I). fim_descarga tem cobertura ~100%, então a
    // corrente fecha inteira. Alimenta: por destino, por trecho e o lookup
    // (todos os trechos que chegam numa loja). Descarta <=0 / >600 min como no
    // fábrica→1ª loja. NÃO instala unaccent — os nomes já vêm sem acento.
    const canonLoja = (c) => `regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(UPPER(TRIM(regexp_replace(translate(${c},'_',' '),'[[:space:]]+',' ','g'))),' IV$',' 4'),' III$',' 3'),' II$',' 2'),' V$',' 5'),' I$',' 1')`;
    const cteTrechos = `
        WITH ordenado AS (
            SELECT data_ocorrencia,
                   NULLIF(TRIM(motorista),'') AS motorista,
                   ${canonLoja('loja')} AS destino,
                   hora_chegada, hora_saida_fabrica, dia_seguinte,
                   ROW_NUMBER() OVER w AS rn,
                   LAG(fim_descarga) OVER w AS prev_saida,
                   LAG(dia_seguinte) OVER w AS prev_dia_seguinte,
                   LAG(${canonLoja('loja')}) OVER w AS prev_loja
            FROM ocorrencias
            WHERE ${filtro}
              AND hora_chegada IS NOT NULL
              AND NULLIF(TRIM(motorista),'') IS NOT NULL
              AND NULLIF(TRIM(loja),'') IS NOT NULL
            WINDOW w AS (PARTITION BY data_ocorrencia, NULLIF(TRIM(motorista),'') ORDER BY dia_seguinte, hora_chegada ASC, id ASC)
        ),
        trechos AS (
            SELECT CASE WHEN rn = 1 THEN 'FÁBRICA' ELSE prev_loja END AS origem,
                   destino,
                   -- trecho que atravessa o hotel (pernoite) nao e estrada: fica de fora
                   CASE WHEN rn = 1 AND dia_seguinte THEN NULL
                        WHEN rn = 1 THEN hora_saida_fabrica
                        WHEN prev_dia_seguinte IS DISTINCT FROM dia_seguinte THEN NULL
                        ELSE prev_saida END AS saida_origem,
                   hora_chegada AS chegada
            FROM ordenado
        ),
        valido AS (
            SELECT origem, destino,
                   EXTRACT(EPOCH FROM (chegada - saida_origem)) / 60.0 AS minutos
            FROM trechos
            WHERE saida_origem IS NOT NULL AND origem IS NOT NULL
              AND EXTRACT(EPOCH FROM (chegada - saida_origem)) / 60.0 BETWEEN 1 AND 600
        )`;

    // Ranking FÁBRICA → loja (origem fixa na fábrica). Responde literalmente
    // "qual loja demora mais desde a fábrica" — sem misturar pernas do meio
    // (ex.: MADUREIRA 4 a 2min é pulo da vizinha, não da fábrica). Só entram
    // lojas que já foram 1ª parada (as demais aparecem no lookup/por_trecho).
    const trFabricaLoja = await iaConsulta(erros, 'otif_trecho_fabrica', async () => {
        const r = await db.query(`${cteTrechos}
            SELECT destino,
                   COUNT(*)::int AS amostra,
                   ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY minutos))::int AS mediana_min
            FROM valido WHERE origem = 'FÁBRICA' GROUP BY destino HAVING COUNT(*) >= 3
            ORDER BY mediana_min DESC, amostra DESC LIMIT 12
        `, params);
        return r.rows;
    }, []);

    const trPar = await iaConsulta(erros, 'otif_trecho_par', async () => {
        const r = await db.query(`${cteTrechos}
            SELECT origem, destino,
                   COUNT(*)::int AS amostra,
                   ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY minutos))::int AS mediana_min
            FROM valido GROUP BY origem, destino HAVING COUNT(*) >= 3
            ORDER BY mediana_min DESC, amostra DESC LIMIT 12
        `, params);
        return r.rows;
    }, []);

    const trTodos = await iaConsulta(erros, 'otif_trecho_todos', async () => {
        const r = await db.query(`${cteTrechos}
            SELECT origem, destino,
                   COUNT(*)::int AS amostra,
                   ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY minutos))::int AS mediana_min
            FROM valido GROUP BY origem, destino HAVING COUNT(*) >= 2
            ORDER BY destino ASC, mediana_min DESC LIMIT 600
        `, params);
        return r.rows;
    }, []);

    const g = geral;
    const naLegitimo = naLeg || 0;
    const avaliaveis = Math.max(0, (g.total || 0) - naLegitimo); // total menos as lojas sem horário (n/a legítimo)
    const resumo = {
        total: g.total || 0,
        com_meta: g.com_meta || 0,
        no_prazo: g.no_prazo || 0,
        atrasada: g.atrasada || 0,
        conforme: g.conforme || 0,
        completas: g.completas || 0,
        na_legitimo: naLegitimo,
        avaliaveis,
        pontualidade_pct: otifPct(g.no_prazo || 0, g.com_meta || 0),
        otif_pct: otifPct(g.conforme || 0, g.com_meta || 0),
        cobertura_pct: otifPct(g.com_meta || 0, avaliaveis),
        in_full_pct: otifPct(g.completas || 0, g.com_info_completa || 0),
    };

    return {
        resumo,
        trend: trend.map((t) => ({ semana: t.semana, com_meta: t.com_meta, no_prazo: t.no_prazo, pct: otifPct(t.no_prazo, t.com_meta) })),
        lojas: lojas.map((l) => ({ ...l, pct_atraso: otifPct(l.atrasadas, l.com_meta) })),
        rotas: rotas.map((r) => ({ ...r, pct_atraso: otifPct(r.atrasadas, r.com_meta) })),
        deslocamento_inicial: {
            amostra: deslGeral.amostra || 0,
            mediana_min: deslGeral.mediana_min ?? null,
            media_min: deslGeral.media_min ?? null,
            por_rota: deslRotas,
            por_motorista: deslMotoristas,
        },
        deslocamento_trechos: {
            fabrica_para_loja: trFabricaLoja,
            por_trecho: trPar,
            todos: trTodos,
        },
        erros,
    };
}

app.get('/painel/otif', async (req, res) => {
    const dias = Math.max(7, Math.min(365, Number(req.query.dias) || 90));
    const chave = `otif:${dias}`;
    const c = otifCache.get(chave);
    if (c && Date.now() - c.em < OTIF_TTL_MS) return res.status(200).json({ ...c.payload, cache: true });
    let dados;
    try { dados = await montarOtif(dias); }
    catch (err) { console.error('[GET /painel/otif]', err); return res.status(500).json({ erro: 'Falha ao montar OTIF/SLA.' }); }
    const payload = { atualizado_em: new Date().toISOString(), janela_dias: dias, ...dados };
    otifCache.set(chave, { em: Date.now(), payload });
    res.status(200).json({ ...payload, cache: false });
});

// ================================================================
// METAS DE HORARIO POR LOJA  (GET/POST /metas-loja + POST /metas-loja/aplicar)
// ----------------------------------------------------------------
// Ataca a COBERTURA do SLA/OTIF: hoje a maioria das entregas nao tem
// hora_agendada_loja e cai em "Sem prazo". Definindo um horario-limite por
// loja, toda entrega dessa loja ganha meta — o form ja preenche o campo
// (autofill via GET) e "aplicar ao historico" preenche as antigas VAZIAS e
// recalcula sla/otif com a mesma logica de producao. Leitura: qualquer
// logado; gravacao: so ADM (garantido pelo middleware global de permissao).
// ================================================================
function metaChaveLoja(loja) { return String(loja || '').trim().toUpperCase().replace(/\s+/g, ' '); }
function metaHoraValida(h) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(h || '').trim()); }

app.get('/metas-loja', async (req, res) => {
    try {
        const r = await db.query(`SELECT loja, hora_agendada, sem_horario, atualizado_em FROM metas_loja ORDER BY loja`);
        res.status(200).json({ metas: r.rows });
    } catch (err) {
        console.error('[GET /metas-loja]', err);
        res.status(500).json({ error: 'Falha ao listar metas.' });
    }
});

app.post('/metas-loja', async (req, res) => {
    const body = req.body || {};
    const loja = String(body.loja || '').trim();
    const hora = String(body.hora_agendada || '').trim();
    const semHorario = body.sem_horario === true || body.sem_horario === 'true' || body.sem_horario === 1;
    if (!loja) return res.status(400).json({ error: 'Loja obrigatória.' });
    const chave = metaChaveLoja(loja);
    try {
        if (semHorario) {
            // Marca a loja como "não trabalha com horário": hora_agendada NULL +
            // sem_horario TRUE. Entregas dessa loja em branco viram n/a legítimo.
            await db.query(`
                INSERT INTO metas_loja (loja_chave, loja, hora_agendada, sem_horario, atualizado_em, criado_por)
                VALUES ($1, $2, NULL, TRUE, NOW(), $3)
                ON CONFLICT (loja_chave) DO UPDATE
                    SET loja = EXCLUDED.loja, hora_agendada = NULL, sem_horario = TRUE, atualizado_em = NOW()
            `, [chave, loja, req.usuarioLogado?.nome || null]);
            await registrarAuditoria(req, 'META_LOJA_SEM_HORARIO', 'metas_loja', chave, { loja });
            return res.status(200).json({ ok: true, loja, sem_horario: true });
        }
        if (!hora) {
            await db.query('DELETE FROM metas_loja WHERE loja_chave = $1', [chave]);
            await registrarAuditoria(req, 'META_LOJA_REMOVER', 'metas_loja', chave, { loja });
            return res.status(200).json({ ok: true, removida: true });
        }
        if (!metaHoraValida(hora)) return res.status(400).json({ error: 'Horário inválido (use HH:MM, 00:00–23:59).' });
        await db.query(`
            INSERT INTO metas_loja (loja_chave, loja, hora_agendada, sem_horario, atualizado_em, criado_por)
            VALUES ($1, $2, $3, FALSE, NOW(), $4)
            ON CONFLICT (loja_chave) DO UPDATE
                SET loja = EXCLUDED.loja, hora_agendada = EXCLUDED.hora_agendada, sem_horario = FALSE, atualizado_em = NOW()
        `, [chave, loja, hora, req.usuarioLogado?.nome || null]);
        await registrarAuditoria(req, 'META_LOJA_SALVAR', 'metas_loja', chave, { loja, hora });
        res.status(200).json({ ok: true, loja, hora_agendada: hora });
    } catch (err) {
        console.error('[POST /metas-loja]', err);
        res.status(500).json({ error: 'Falha ao salvar meta.' });
    }
});

// Aplica as metas ao historico: preenche hora_agendada_loja das entregas que
// estao SEM horario (nunca sobrescreve um horario ja informado) e recalcula
// sla_status/otif_status. Mutacao explicita (botao com confirmacao no front).
app.post('/metas-loja/aplicar', async (req, res) => {
    try {
        // hora_agendada_loja / hora_chegada sao colunas TIME (nao texto): a
        // "vazia" e NULL, e a meta (texto 'HH:MM') entra com cast ::time.
        const upd = await db.query(`
            UPDATE ocorrencias o
               SET hora_agendada_loja = m.hora_agendada::time
              FROM metas_loja m
             WHERE UPPER(TRIM(o.loja)) = m.loja_chave
               AND m.hora_agendada IS NOT NULL
               AND m.sem_horario = FALSE
               AND o.excluida_em IS NULL
               AND o.hora_agendada_loja IS NULL
               AND o.hora_chegada IS NOT NULL
            RETURNING o.id, o.hora_agendada_loja::text AS hora_agendada_loja,
                      o.hora_chegada::text AS hora_chegada, o.entrega_completa,
                      o.teve_ocorrencia, o.tipo_problema, o.sacola_status,
                      o.almoxerifado_status, o.material_envio_status,
                      o.volume_divergencia
        `);
        let recalc = 0;
        for (const row of upd.rows) {
            // Passa a ocorrencia inteira: com entrega_completa em branco, o In
            // Full sai dela (ver indicadoresEntrega / kpi-ocorrencia.js).
            const ind = indicadoresEntrega(row);
            await db.query('UPDATE ocorrencias SET sla_status = $1, otif_status = $2 WHERE id = $3',
                [ind.slaStatus, ind.otifStatus, row.id]);
            recalc++;
        }
        otifCache.clear();
        riscoCache.clear();
        await registrarAuditoria(req, 'META_LOJA_APLICAR', 'ocorrencias', null, { atualizadas: recalc });
        res.status(200).json({ ok: true, atualizadas: recalc });
    } catch (err) {
        console.error('[POST /metas-loja/aplicar]', err);
        res.status(500).json({ error: 'Falha ao aplicar metas ao histórico.' });
    }
});

// ================================================================
// ALERTAS PROATIVOS  (motor + /alertas + Telegram opcional)
// ----------------------------------------------------------------
// Sai do "ver e prever" para o "avisar sozinho". avaliarAlertas() roda de
// tempos em tempos (scheduler) e a pedido; monta candidatos das regras,
// insere com dedup por 'chave' (ON CONFLICT DO NOTHING) e, para os NOVOS e
// recentes, dispara notificacao externa. O sino 🚨 do header consome
// GET /alertas. Canal externo (Telegram) e opcional: sem TELEGRAM_BOT_TOKEN/
// TELEGRAM_CHAT_ID, os alertas vivem so no app — nada quebra.
// ================================================================
// Canal Telegram compartilhado (alertas + digest). Sem token/chat no .env,
// vira no-op (retorna false) — nada quebra, tudo segue in-app.
async function enviarTelegram(texto) {
    const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
    const chatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();
    if (!token || !chatId || !String(texto || '').trim()) return false;
    try {
        const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: texto, disable_web_page_preview: true }),
        });
        if (!resp.ok) console.error('[telegram] HTTP', resp.status);
        return resp.ok;
    } catch (err) { console.error('[telegram]', err.message); return false; }
}

async function notificarExterno(alerta) {
    const emoji = alerta.severidade === 'alta' ? '🔴' : alerta.severidade === 'baixa' ? '🟢' : '🟡';
    const ok = await enviarTelegram(`${emoji} ${alerta.titulo}\n${alerta.detalhe || ''}`.trim());
    if (ok) { try { await db.query('UPDATE alertas SET notificado_em = NOW() WHERE id = $1', [alerta.id]); } catch (_) {} }
}

let alertasAvaliando = false;
async function avaliarAlertas() {
    if (alertasAvaliando) return { avaliados: 0, novos: 0, ocupado: true };
    alertasAvaliando = true;
    const candidatos = [];
    const semRespIds = [];
    try {
        // R1: ocorrencia aberta SEM responsavel (backlog permanente — o mais critico).
        try {
            const r = await db.query(`
                SELECT id, COALESCE(NULLIF(tipo_problema,''),'ocorrência') AS tp,
                       NULLIF(rota,'') AS rota, NULLIF(motorista,'') AS mot,
                       to_char(data_ocorrencia,'DD/MM') AS dia, data_ocorrencia AS de
                FROM ocorrencias
                WHERE teve_ocorrencia = TRUE AND ocorrencia_status = 'Aberta' AND excluida_em IS NULL
                  AND NULLIF(TRIM(ocorrencia_responsavel),'') IS NULL
                ORDER BY data_ocorrencia DESC LIMIT 100`);
            for (const o of r.rows) {
                semRespIds.push(o.id);
                candidatos.push({ chave: `oco-semresp-${o.id}`, tipo: 'ocorrencia_sem_resp', severidade: 'alta',
                    titulo: `Sem responsável: ${o.tp}`, detalhe: [o.rota, o.mot, o.dia].filter(Boolean).join(' · '),
                    aba: 'entregas', ocorrencia_id: o.id, evento_em: o.de });
            }
        } catch (e) { console.error('[alertas R1]', e.message); }

        // R2: entrega marcada como Atrasada (SLA) nos ultimos 7 dias.
        try {
            const r = await db.query(`
                SELECT id, NULLIF(loja,'') AS loja, NULLIF(rota,'') AS rota, NULLIF(motorista,'') AS mot,
                       to_char(data_ocorrencia,'DD/MM') AS dia, data_ocorrencia AS de
                FROM ocorrencias
                WHERE sla_status = 'Atrasada' AND excluida_em IS NULL AND data_ocorrencia >= CURRENT_DATE - 7
                ORDER BY data_ocorrencia DESC LIMIT 100`);
            for (const o of r.rows) candidatos.push({ chave: `oco-atraso-${o.id}`, tipo: 'entrega_atrasada', severidade: 'media',
                titulo: `Entrega atrasada: ${o.loja || o.rota || 'entrega'}`, detalhe: [o.rota, o.mot, o.dia].filter(Boolean).join(' · '),
                aba: 'entregas', ocorrencia_id: o.id, evento_em: o.de });
        } catch (e) { console.error('[alertas R2]', e.message); }

        // R3: saida de fabrica atrasada (> 30 min) nos ultimos 7 dias.
        try {
            const r = await db.query(`
                SELECT id, NULLIF(motorista,'') AS mot, NULLIF(rota,'') AS rota,
                       NULLIF(atraso_min::text,'')::numeric AS min,
                       to_char(NULLIF(data::text,'')::date,'DD/MM') AS dia, NULLIF(data::text,'')::date AS de
                FROM atrasos_saida
                WHERE COALESCE(NULLIF(atraso_min::text,'')::numeric,0) > 30
                  AND NULLIF(data::text,'')::date >= CURRENT_DATE - 7
                ORDER BY NULLIF(data::text,'')::date DESC LIMIT 100`);
            for (const o of r.rows) candidatos.push({ chave: `saidafab-${o.id}`, tipo: 'saida_fabrica', severidade: 'media',
                titulo: `Saída de fábrica atrasada: ${o.mot || 'motorista'}`,
                detalhe: `${Math.round(Number(o.min))} min${o.rota ? ' · ' + o.rota : ''} · ${o.dia}`,
                aba: null, ocorrencia_id: null, evento_em: o.de });
        } catch (e) { console.error('[alertas R3]', e.message); }

        // R4: motorista de RISCO ALTO escalado hoje (so avalia se houver escala hoje).
        try {
            const esc = await db.query(`
                SELECT COUNT(*)::int AS n, to_char(CURRENT_DATE,'YYYY-MM-DD') AS hoje
                FROM tms_viagens
                WHERE data_viagem = CURRENT_DATE AND COALESCE(status,'') <> 'Cancelada'
                  AND NULLIF(TRIM(motorista_nome),'') IS NOT NULL`);
            if ((esc.rows[0]?.n || 0) > 0) {
                const risco = await montarRisco(60);
                const hoje = esc.rows[0].hoje;
                for (const it of risco.itens.filter((i) => i.escalado_hoje && i.nivel === 'alto')) {
                    const ck = String(it.motorista).trim().toUpperCase().replace(/\s+/g, ' ');
                    candidatos.push({ chave: `risco-${ck}-${hoje}`, tipo: 'risco_alto', severidade: 'alta',
                        titulo: `Risco alto de atraso hoje: ${it.motorista}`, detalhe: it.resumo || `score ${it.score}`,
                        aba: 'dashboard', ocorrencia_id: null, evento_em: null });
                }
            }
        } catch (e) { console.error('[alertas R4]', e.message); }

        // R5: TMS do dia (back/previsao-tms.js) — jornada perto de 12h (ou
        // prevista acima), proxima loja com chegada prevista atrasada e, a
        // partir das 17h, viagem com loja sem registro. + 1 resumo diario das
        // viagens antigas com pendencia.
        let tmsVivos = null;
        try {
            const agora = previsaoTms.agoraSP();
            // Com pernoite: a viagem longa de ontem que segue hoje entra como "do dia"
            // (previsao/fechamento) e NAO conta como antiga esquecida.
            const viagensHoje = await buscarViagensTms(agora.data, { pernoite: true });
            const doDia = previsaoTms.alertasDoDia(viagensHoje, agora);
            const continuando = viagensHoje.filter((v) => v.continua_pernoite).map((v) => v.id);
            const antigas = await db.query(`
                SELECT COUNT(DISTINCT v.id)::int AS n FROM tms_viagens v JOIN tms_paradas p ON p.viagem_id = v.id
                 WHERE v.data_viagem < CURRENT_DATE AND v.data_viagem >= CURRENT_DATE - 30 AND v.status <> 'Cancelada'
                   AND v.id <> ALL($1::int[])
                   AND p.ocorrencia_id IS NULL AND p.status NOT IN ('Entregue','Entregue com ocorrencia','Recusada','Ocorrencia')
                   AND NOT EXISTS (SELECT 1 FROM ocorrencias o WHERE o.parada_id = p.id AND o.excluida_em IS NULL)`, [continuando]);
            if (antigas.rows[0].n > 0) {
                doDia.push({ chave: `fechamento-antigas-${agora.data}`, tipo: 'fechamento', severidade: 'baixa',
                    titulo: `${antigas.rows[0].n} viagem(ns) dos últimos 30 dias com loja sem registro`,
                    detalhe: 'Lance os registros pendentes ou marque a parada (ex.: Recusada) no TMS', aba: 'tms' });
            }
            candidatos.push(...doDia);
            tmsVivos = doDia.map((c) => c.chave);
        } catch (e) { console.error('[alertas R5]', e.message); }

        // R6: material da planilha (envio/retirada) para loja que NENHUMA viagem
        // do dia visita — hoje + 3 dias, so dias com viagem (back/material-status.js).
        let matVivos = null, matDatas = [];
        try {
            const r6 = await materialStatus.alertasForaDaRota();
            candidatos.push(...r6.candidatos);
            matVivos = r6.candidatos.map((c) => c.chave);
            matDatas = r6.datas;
        } catch (e) { console.error('[alertas R6]', e.message); }

        // R7: frota pelo GPS (back/frota-alertas.js) — parada longa fora de loja,
        // rastreador/plataforma mudos, area de risco, uso fora do horario,
        // jornada sem pausa, motor ligado parado, excesso de velocidade.
        let frotaVivos = null;
        try {
            const r7 = await frotaAlertas.candidatos();
            candidatos.push(...r7);
            frotaVivos = r7.map((c) => c.chave);
        } catch (e) { console.error('[alertas R7 frota]', e.message); }

        // Insere com dedup por 'chave' e coleta os NOVOS.
        const novos = [];
        for (const c of candidatos) {
            try {
                const r = await db.query(`
                    INSERT INTO alertas (chave, tipo, severidade, titulo, detalhe, aba, ocorrencia_id, evento_em)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                    ON CONFLICT (chave) DO NOTHING RETURNING id`,
                    [c.chave, c.tipo, c.severidade, c.titulo, c.detalhe, c.aba, c.ocorrencia_id, c.evento_em]);
                if (r.rows[0]) novos.push({ ...c, id: r.rows[0].id });
            } catch (e) { console.error('[alertas insert]', e.message); }
        }

        // Auto-resolve: ocorrencia "sem responsavel" que ja ganhou responsavel/foi fechada.
        try {
            if (semRespIds.length) {
                await db.query(`UPDATE alertas SET resolvido_em = NOW()
                    WHERE tipo = 'ocorrencia_sem_resp' AND resolvido_em IS NULL AND ocorrencia_id <> ALL($1::int[])`, [semRespIds]);
            } else {
                await db.query(`UPDATE alertas SET resolvido_em = NOW() WHERE tipo = 'ocorrencia_sem_resp' AND resolvido_em IS NULL`);
            }
        } catch (e) { console.error('[alertas resolve]', e.message); }

        // Auto-resolve do TMS: jornada/atraso/fechamento que deixou de valer
        // (caminhao voltou, loja registrada, previsao melhorou). So roda se a
        // R5 avaliou com sucesso — senao resolveria tudo por engano.
        try {
            if (tmsVivos) {
                await db.query(`UPDATE alertas SET resolvido_em = NOW()
                    WHERE tipo IN ('jornada','eta_atraso','fechamento') AND resolvido_em IS NULL
                      AND chave <> ALL($1::text[])`, [tmsVivos]);
            }
        } catch (e) { console.error('[alertas resolve TMS]', e.message); }

        // Auto-resolve R6: a loja entrou numa viagem, o item foi marcado "foi"
        // ou o dia ja passou. So mexe nos dias que a R6 conseguiu avaliar.
        try {
            if (matVivos) {
                await db.query(`UPDATE alertas SET resolvido_em = NOW()
                    WHERE tipo = 'material_fora_rota' AND resolvido_em IS NULL
                      AND (evento_em < CURRENT_DATE OR (evento_em = ANY($1::date[]) AND chave <> ALL($2::text[])))`,
                    [matDatas, matVivos]);
            }
        } catch (e) { console.error('[alertas resolve R6]', e.message); }

        // Auto-resolve R7: parada terminou, sinal voltou, saiu da area, plataforma voltou.
        try {
            if (frotaVivos) {
                await db.query(`UPDATE alertas SET resolvido_em = NOW()
                    WHERE tipo = ANY($1::text[]) AND resolvido_em IS NULL AND chave <> ALL($2::text[])`,
                    [frotaAlertas.TIPOS_VIVOS, frotaVivos]);
            }
        } catch (e) { console.error('[alertas resolve R7]', e.message); }

        // Notificacao externa: so alertas NOVOS e recentes (evento nas ultimas 24h).
        const limite = Date.now() - 24 * 3600 * 1000;
        for (const n of novos) {
            const recente = n.evento_em == null || new Date(n.evento_em).getTime() >= limite;
            if (recente && !n.semTelegram) await notificarExterno(n);
        }

        if (novos.length) broadcastEvento('alerta', { novos: novos.length });
        return { avaliados: candidatos.length, novos: novos.length };
    } finally {
        alertasAvaliando = false;
    }
}

app.get('/alertas', async (req, res) => {
    try {
        const r = await db.query(`
            SELECT id, tipo, severidade, titulo, detalhe, aba, ocorrencia_id,
                   to_char(criado_em, 'DD/MM HH24:MI') AS criado, (lido_em IS NOT NULL) AS lido
            FROM alertas WHERE resolvido_em IS NULL
            ORDER BY (lido_em IS NULL) DESC,
                     CASE severidade WHEN 'alta' THEN 0 WHEN 'media' THEN 1 ELSE 2 END,
                     criado_em DESC
            LIMIT 60`);
        const naoLidos = r.rows.filter((a) => !a.lido).length;
        res.status(200).json({ alertas: r.rows, nao_lidos: naoLidos, total: r.rows.length });
    } catch (err) {
        console.error('[GET /alertas]', err);
        res.status(500).json({ error: 'Falha ao listar alertas.' });
    }
});

app.post('/alertas/:id/lido', async (req, res) => {
    try {
        await db.query(`UPDATE alertas SET lido_em = COALESCE(lido_em, NOW()) WHERE id = $1`, [Number(req.params.id)]);
        res.status(200).json({ ok: true });
    } catch (err) { res.status(500).json({ error: 'Falha ao marcar como lido.' }); }
});

app.post('/alertas/lidos', async (req, res) => {
    try {
        await db.query(`UPDATE alertas SET lido_em = NOW() WHERE lido_em IS NULL AND resolvido_em IS NULL`);
        res.status(200).json({ ok: true });
    } catch (err) { res.status(500).json({ error: 'Falha ao marcar todos como lidos.' }); }
});

app.post('/alertas/avaliar', async (req, res) => {
    try {
        const r = await avaliarAlertas();
        res.status(200).json({ ok: true, ...r });
    } catch (err) {
        console.error('[POST /alertas/avaliar]', err);
        res.status(500).json({ error: 'Falha ao avaliar alertas.' });
    }
});

// Scheduler dos alertas: 1a avaliacao pouco depois de subir; depois periodica.
let alertasTimer = null;
function iniciarAlertas() {
    const ms = Number(process.env.ALERTAS_INTERVALO_MS || 3 * 60 * 1000);
    setTimeout(() => { avaliarAlertas().catch(() => {}); }, 8000);
    if (alertasTimer) clearInterval(alertasTimer);
    alertasTimer = setInterval(() => { avaliarAlertas().catch(() => {}); }, ms);
    console.log(`[alertas] motor ativo (a cada ${Math.round(ms / 1000)}s)`);
}

// ================================================================
// PAINEL QUALIDADE DE DADO  (GET /painel/qualidade)
// ----------------------------------------------------------------
// "O painel vale o que os inputs valem." Mede a completude dos campos que
// alimentam os KPIs — preenchido vs. em branco — por campo e por motorista.
// Campos CONDICIONAIS medem no subconjunto que se aplica (ex.: tipo_problema
// so quando houve ocorrencia). Indice = media dos essenciais + condicionais.
// ================================================================
const QUALIDADE_TTL_MS = Number(process.env.PAINEL_QUALIDADE_TTL_MS || 5 * 60 * 1000);
const qualidadeCache = new Map();

async function montarQualidade(dias) {
    const erros = [];
    const params = [dias];
    const filtro = `excluida_em IS NULL AND data_ocorrencia >= CURRENT_DATE - ($1::int * INTERVAL '1 day')`;

    const linha = await iaConsulta(erros, 'qualidade_campos', async () => {
        const r = await db.query(`
            SELECT
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE NULLIF(TRIM(loja),'') IS NOT NULL)::int AS loja,
              COUNT(*) FILTER (WHERE NULLIF(TRIM(motorista),'') IS NOT NULL)::int AS motorista,
              COUNT(*) FILTER (WHERE NULLIF(TRIM(placa),'') IS NOT NULL)::int AS placa,
              COUNT(*) FILTER (WHERE NULLIF(TRIM(rota),'') IS NOT NULL)::int AS rota,
              COUNT(*) FILTER (WHERE hora_chegada IS NOT NULL)::int AS hora_chegada,
              COUNT(*) FILTER (WHERE hora_agendada_loja IS NOT NULL)::int AS hora_agendada,
              COUNT(*) FILTER (WHERE hora_saida_fabrica IS NOT NULL)::int AS hora_saida,
              COUNT(*) FILTER (WHERE entrega_completa IS NOT NULL)::int AS entrega_completa,
              COUNT(*) FILTER (WHERE fez_checklist IS NOT NULL)::int AS fez_checklist,
              COUNT(*) FILTER (WHERE COALESCE(volume_fisico,0)>0 OR COALESCE(volume_gerencial,0)>0)::int AS volume,
              COUNT(*) FILTER (WHERE teve_ocorrencia=TRUE)::int AS com_ocorrencia,
              COUNT(*) FILTER (WHERE teve_ocorrencia=TRUE AND NULLIF(TRIM(tipo_problema),'') IS NOT NULL)::int AS oco_tipo,
              COUNT(*) FILTER (WHERE teve_ocorrencia=TRUE AND ocorrencia_status='Aberta')::int AS abertas,
              COUNT(*) FILTER (WHERE teve_ocorrencia=TRUE AND ocorrencia_status='Aberta' AND NULLIF(TRIM(ocorrencia_responsavel),'') IS NOT NULL)::int AS aberta_resp,
              COUNT(*) FILTER (WHERE COALESCE(NULLIF(custo_total::text,'')::numeric,0)>0)::int AS custo,
              COUNT(*) FILTER (WHERE teve_ocorrencia=TRUE AND NULLIF(TRIM(causa_raiz),'') IS NOT NULL)::int AS causa_raiz
            FROM ocorrencias WHERE ${filtro}
        `, params);
        return r.rows[0] || {};
    }, {});

    // Entregas de lojas marcadas "sem horário" com o agendado em branco: n/a
    // legítimo. Saem do denominador do campo hora_agendada_loja (não é lacuna).
    const naLegitimo = await iaConsulta(erros, 'qualidade_na_legitimo', async () => {
        const r = await db.query(`
            SELECT COUNT(*)::int AS n
            FROM ocorrencias o
            JOIN metas_loja m ON UPPER(TRIM(o.loja)) = m.loja_chave AND m.sem_horario = TRUE
            WHERE ${filtro} AND o.hora_agendada_loja IS NULL
        `, params);
        return (r.rows[0] || {}).n || 0;
    }, 0);

    const g = linha;
    const total = g.total || 0;
    const pc = (n, d) => (d > 0 ? Math.round((100 * n) / d) : null);
    const campos = [
        { campo: 'motorista', label: 'Motorista', grupo: 'essencial', ok: g.motorista, base: total },
        { campo: 'placa', label: 'Placa', grupo: 'essencial', ok: g.placa, base: total },
        { campo: 'loja', label: 'Loja', grupo: 'essencial', ok: g.loja, base: total },
        { campo: 'rota', label: 'Rota', grupo: 'essencial', ok: g.rota, base: total },
        { campo: 'hora_chegada', label: 'Hora de chegada', grupo: 'essencial', ok: g.hora_chegada, base: total },
        { campo: 'hora_agendada_loja', label: 'Horário agendado (meta SLA)', grupo: 'essencial', ok: g.hora_agendada, base: Math.max(0, total - naLegitimo), nota: naLegitimo ? 'lojas sem horário ficam de fora' : undefined },
        { campo: 'hora_saida_fabrica', label: 'Saída da fábrica', grupo: 'essencial', ok: g.hora_saida, base: total },
        { campo: 'entrega_completa', label: 'Entrega completa (In Full)', grupo: 'essencial', ok: g.entrega_completa, base: total },
        { campo: 'fez_checklist', label: 'Checklist', grupo: 'essencial', ok: g.fez_checklist, base: total },
        { campo: 'volume', label: 'Volume (físico/gerencial)', grupo: 'essencial', ok: g.volume, base: total },
        { campo: 'tipo_problema', label: 'Tipo do problema', grupo: 'condicional', ok: g.oco_tipo, base: g.com_ocorrencia || 0, nota: 'quando houve ocorrência' },
        { campo: 'ocorrencia_responsavel', label: 'Responsável da ocorrência', grupo: 'condicional', ok: g.aberta_resp, base: g.abertas || 0, nota: 'quando aberta' },
        { campo: 'causa_raiz', label: 'Causa raiz', grupo: 'avancado', ok: g.causa_raiz, base: g.com_ocorrencia || 0, nota: 'quando houve ocorrência' },
        { campo: 'custo_total', label: 'Custo da entrega', grupo: 'avancado', ok: g.custo, base: total },
    ].map((c) => ({ ...c, pct: pc(c.ok, c.base) }));

    const contam = campos.filter((c) => c.grupo !== 'avancado' && c.pct != null);
    const indice = contam.length ? Math.round(contam.reduce((s, c) => s + c.pct, 0) / contam.length) : null;

    const motoristas = await iaConsulta(erros, 'qualidade_motoristas', async () => {
        const r = await db.query(`
            SELECT TRIM(motorista) AS motorista, COUNT(*)::int AS entregas,
                   ROUND(100.0 * AVG((
                       (CASE WHEN NULLIF(TRIM(loja),'') IS NOT NULL THEN 1 ELSE 0 END) +
                       (CASE WHEN NULLIF(TRIM(placa),'') IS NOT NULL THEN 1 ELSE 0 END) +
                       (CASE WHEN NULLIF(TRIM(rota),'') IS NOT NULL THEN 1 ELSE 0 END) +
                       (CASE WHEN hora_agendada_loja IS NOT NULL
                                  OR EXISTS (SELECT 1 FROM metas_loja m
                                              WHERE m.loja_chave = UPPER(TRIM(ocorrencias.loja))
                                                AND m.sem_horario = TRUE)
                             THEN 1 ELSE 0 END) +
                       (CASE WHEN entrega_completa IS NOT NULL THEN 1 ELSE 0 END) +
                       (CASE WHEN fez_checklist IS NOT NULL THEN 1 ELSE 0 END)
                   )::numeric / 6))::int AS pct
            FROM ocorrencias
            WHERE ${filtro} AND NULLIF(TRIM(motorista),'') IS NOT NULL
            GROUP BY 1 HAVING COUNT(*) >= 5
            ORDER BY pct ASC, entregas DESC LIMIT 10
        `, params);
        return r.rows;
    }, []);

    return { indice, total, na_legitimo: naLegitimo, campos, motoristas, erros };
}

app.get('/painel/qualidade', async (req, res) => {
    const dias = Math.max(7, Math.min(365, Number(req.query.dias) || 90));
    const chave = `qual:${dias}`;
    const c = qualidadeCache.get(chave);
    if (c && Date.now() - c.em < QUALIDADE_TTL_MS) return res.status(200).json({ ...c.payload, cache: true });
    let dados;
    try { dados = await montarQualidade(dias); }
    catch (err) { console.error('[GET /painel/qualidade]', err); return res.status(500).json({ erro: 'Falha ao montar qualidade de dado.' }); }
    const payload = { atualizado_em: new Date().toISOString(), janela_dias: dias, ...dados };
    qualidadeCache.set(chave, { em: Date.now(), payload });
    res.status(200).json({ ...payload, cache: false });
});

// ================================================================
// PAINEL DE CUSTO  (GET /painel/custo)
// ----------------------------------------------------------------
// Custo por entrega / rota / motorista / loja + custo de FALHAS (reentrega +
// ocorrencia = dinheiro que vaza por problema). custo_total ja e' derivado no
// salvar (km_real*custo_km + pedagio + reentrega + ocorrencia). Aqui so
// AGREGA o que foi lancado; "cobertura" avisa quantas entregas tem custo
// preenchido, pra ninguem confundir "custo baixo" com "custo nao lancado".
// ================================================================
const CUSTO_TTL_MS = Number(process.env.PAINEL_CUSTO_TTL_MS || 5 * 60 * 1000);
const custoCache = new Map();

async function montarCusto(dias) {
    const erros = [];
    const params = [dias];
    const filtro = `excluida_em IS NULL AND data_ocorrencia >= CURRENT_DATE - ($1::int * INTERVAL '1 day')`;
    const numExpr = "COALESCE(NULLIF(custo_total::text,'')::numeric, 0)";
    const falhaExpr = "COALESCE(custo_reentrega,0) + COALESCE(custo_ocorrencia,0)";

    const resumo = await iaConsulta(erros, 'custo_resumo', async () => {
        const r = await db.query(`
            SELECT
              COUNT(*)::int AS total_entregas,
              COUNT(*) FILTER (WHERE ${numExpr} > 0)::int AS com_custo,
              ROUND(COALESCE(SUM(${numExpr}), 0), 2)::float8            AS total_gasto,
              ROUND(COALESCE(SUM(${falhaExpr}), 0), 2)::float8          AS total_falhas,
              ROUND(COALESCE(SUM(COALESCE(pedagio,0)), 0), 2)::float8   AS total_pedagio,
              ROUND(COALESCE(SUM(COALESCE(km_real,0)), 0), 2)::float8   AS total_km
            FROM ocorrencias WHERE ${filtro}
        `, params);
        return r.rows[0] || {};
    }, {});

    // Ranking generico por dimensao (rota / motorista / loja) — so quem tem custo.
    const ranking = async (nome, col, rotulo) => iaConsulta(erros, `custo_${nome}`, async () => {
        const r = await db.query(`
            SELECT COALESCE(NULLIF(TRIM(${col}), ''), '(sem ${rotulo})') AS chave,
                   COUNT(*) FILTER (WHERE ${numExpr} > 0)::int          AS entregas,
                   ROUND(COALESCE(SUM(${numExpr}), 0), 2)::float8       AS total,
                   ROUND(COALESCE(SUM(${falhaExpr}), 0), 2)::float8     AS falhas,
                   ROUND(AVG(${numExpr}) FILTER (WHERE ${numExpr} > 0), 2)::float8 AS media
            FROM ocorrencias
            WHERE ${filtro}
            GROUP BY 1
            HAVING SUM(${numExpr}) > 0
            ORDER BY total DESC
            LIMIT 10
        `, params);
        return r.rows;
    }, []);

    const [porRota, porMotorista, porLojaRaw] = await Promise.all([
        ranking('rota', 'rota', 'rota'),
        ranking('motorista', 'motorista', 'motorista'),
        ranking('loja', 'loja', 'loja'),
    ]);
    // Loja: mescla grafias da mesma loja (canonico) e recomputa a media = total/entregas.
    const porLoja = mesclarRankingPorLoja(porLojaRaw, 'chave', ['entregas', 'total', 'falhas'])
        .map((r) => ({ ...r, media: r.entregas ? Math.round((r.total / r.entregas) * 100) / 100 : r.media }))
        .sort((a, b) => b.total - a.total);

    const g = resumo;
    const totalEntregas = g.total_entregas || 0;
    const comCusto = g.com_custo || 0;
    const totalGasto = g.total_gasto || 0;
    const totalKm = g.total_km || 0;
    return {
        total_entregas: totalEntregas,
        com_custo: comCusto,
        cobertura: totalEntregas > 0 ? Math.round((100 * comCusto) / totalEntregas) : null,
        total_gasto: totalGasto,
        custo_medio_entrega: comCusto > 0 ? Math.round((totalGasto / comCusto) * 100) / 100 : null,
        custo_por_km: totalKm > 0 ? Math.round((totalGasto / totalKm) * 100) / 100 : null,
        total_falhas: g.total_falhas || 0,
        total_pedagio: g.total_pedagio || 0,
        total_km: totalKm,
        por_rota: porRota,
        por_motorista: porMotorista,
        por_loja: porLoja,
        // Frete CALCULADO das viagens do TMS (cadastro de lojas/PES), separado
        // do custo digitado na ocorrencia para os dois nao se somarem.
        frete_tms: await iaConsulta(erros, 'custo_frete_tms', () => lojasPes.custoFreteTms(db, dias), null),
        erros,
    };
}

app.get('/painel/custo', async (req, res) => {
    const dias = Math.max(7, Math.min(365, Number(req.query.dias) || 90));
    const chave = `custo:${dias}`;
    const c = custoCache.get(chave);
    if (c && Date.now() - c.em < CUSTO_TTL_MS) return res.status(200).json({ ...c.payload, cache: true });
    let dados;
    try { dados = await montarCusto(dias); }
    catch (err) { console.error('[GET /painel/custo]', err); return res.status(500).json({ erro: 'Falha ao montar painel de custo.' }); }
    const payload = { atualizado_em: new Date().toISOString(), janela_dias: dias, ...dados };
    custoCache.set(chave, { em: Date.now(), payload });
    res.status(200).json({ ...payload, cache: false });
});

// ================================================================
// DIGEST — resumo executivo empurrado (diario) via Telegram
// ----------------------------------------------------------------
// "Pra os numeros serem vistos e cobrados, nao so ficarem no painel." Junta
// qualidade de dado + pontualidade/OTIF + piores ofensores + alertas abertos
// num texto curto. Enviado no horario configurado (DIGEST_ATIVO=1 +
// DIGEST_HORA/MINUTO) e a pedido (POST /painel/digest/enviar). Preview sempre
// disponivel em GET /painel/digest. Reusa enviarTelegram (dormant sem config).
// ================================================================
async function montarDigestTexto() {
    const l = ['📊 Resumo — Controle de Entrega', ''];
    try {
        const q = await montarQualidade(30);
        if (q.indice != null) l.push(`• Qualidade de dado: ${q.indice}%`);
        const piorMot = (q.motoristas || [])[0];
        if (piorMot) l.push(`  pior preenchimento: ${piorMot.motorista} (${piorMot.pct}%)`);
    } catch (_) {}
    try {
        const o = await montarOtif(7);
        const r = o.resumo || {};
        if (r.total) {
            l.push(`• Pontualidade (7d): ${r.pontualidade_pct == null ? '—' : r.pontualidade_pct + '%'} no prazo · cobertura ${r.cobertura_pct == null ? '—' : r.cobertura_pct + '%'}`);
            const pl = (o.lojas || [])[0];
            if (pl) l.push(`  pior loja: ${String(pl.loja).replace(/_/g, ' ')} (${pl.pct_atraso == null ? '—' : pl.pct_atraso + '%'} atraso)`);
        }
    } catch (_) {}
    try {
        const a = await db.query(`SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE tipo='ocorrencia_sem_resp')::int AS sem_resp
            FROM alertas WHERE resolvido_em IS NULL`);
        const row = a.rows[0] || {};
        if (row.total) l.push(`• Alertas abertos: ${row.total} (${row.sem_resp || 0} sem responsável)`);
    } catch (_) {}
    return l.join('\n');
}

async function enviarDigest() {
    const texto = await montarDigestTexto();
    const enviado = await enviarTelegram(texto);
    return { enviado, texto };
}

app.get('/painel/digest', async (req, res) => {
    try { res.status(200).json({ texto: await montarDigestTexto() }); }
    catch (err) { console.error('[GET /painel/digest]', err); res.status(500).json({ error: 'Falha ao montar o resumo.' }); }
});

app.post('/painel/digest/enviar', async (req, res) => {
    try {
        const r = await enviarDigest();
        if (!r.enviado) return res.status(200).json({ ok: false, motivo: 'Canal externo (Telegram) não configurado — defina TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID.', texto: r.texto });
        await registrarAuditoria(req, 'DIGEST_ENVIAR', 'painel', null, null);
        res.status(200).json({ ok: true, ...r });
    } catch (err) { console.error('[POST /painel/digest/enviar]', err); res.status(500).json({ error: 'Falha ao enviar o resumo.' }); }
});

// Scheduler do digest: off por padrao (DIGEST_ATIVO=1 liga). Reagenda a cada dia.
function agendarDigestDiario() {
    if (!/^(1|true|sim|on)$/i.test(String(process.env.DIGEST_ATIVO || '').trim())) return;
    const hora = Number(process.env.DIGEST_HORA || 7);
    const minuto = Number(process.env.DIGEST_MINUTO || 30);
    const agora = new Date();
    const prox = new Date(agora);
    prox.setHours(hora, minuto, 0, 0);
    if (prox <= agora) prox.setDate(prox.getDate() + 1);
    const ms = prox - agora;
    console.log(`[digest] próximo resumo agendado para ${prox.toLocaleString('pt-BR')}`);
    setTimeout(() => { enviarDigest().catch(() => {}); agendarDigestDiario(); }, ms);
}

const IA_PERIODOS = {
    hoje: { dias: 0, label: 'hoje' },
    semana: { dias: 6, label: 'ultimos 7 dias' },
    mes: { dias: 29, label: 'ultimos 30 dias' },
    trimestre: { dias: 89, label: 'ultimos 90 dias' },
};

function iaPeriodo(valor) {
    const chave = String(valor || 'semana').toLowerCase();
    return IA_PERIODOS[chave] ? { chave, ...IA_PERIODOS[chave] } : { chave: 'semana', ...IA_PERIODOS.semana };
}

async function iaConsulta(erros, nome, fn, fallback) {
    try {
        return await fn();
    } catch (err) {
        erros.push({ origem: nome, detalhe: err.message });
        return fallback;
    }
}

async function montarContextoAnalitico(periodoParam) {
    const periodo = iaPeriodo(periodoParam);
    const erros = [];
    const params = [periodo.dias];
    const filtroData = `data_ocorrencia >= CURRENT_DATE - ($1::int * INTERVAL '1 day')`;

    const resumo = await iaConsulta(erros, 'resumo_ocorrencias', async () => {
        const r = await db.query(`
            SELECT
                COUNT(*)::int AS total_entregas,
                COUNT(*) FILTER (WHERE COALESCE(teve_ocorrencia, FALSE))::int AS entregas_com_ocorrencia,
                COUNT(*) FILTER (WHERE NOT COALESCE(teve_ocorrencia, FALSE))::int AS entregas_sem_ocorrencia,
                COUNT(*) FILTER (WHERE sla_status = 'Atrasada')::int AS entregas_atrasadas,
                COUNT(*) FILTER (WHERE fez_checklist = FALSE)::int AS sem_checklist,
                COUNT(DISTINCT NULLIF(motorista, ''))::int AS motoristas,
                COUNT(DISTINCT NULLIF(rota, ''))::int AS rotas,
                ROUND(
                    100.0 * COUNT(*) FILTER (WHERE sla_status = 'No prazo') / NULLIF(COUNT(*) FILTER (WHERE sla_status IN ('No prazo', 'Atrasada')), 0),
                    1
                ) AS pct_no_prazo
            FROM ocorrencias
            WHERE excluida_em IS NULL AND ${filtroData}
        `, params);
        const row = r.rows[0] || {};
        return {
            total_entregas: row.total_entregas || 0,
            entregas_com_ocorrencia: row.entregas_com_ocorrencia || 0,
            entregas_sem_ocorrencia: row.entregas_sem_ocorrencia || 0,
            entregas_atrasadas: row.entregas_atrasadas || 0,
            sem_checklist: row.sem_checklist || 0,
            motoristas: row.motoristas || 0,
            rotas: row.rotas || 0,
            pct_no_prazo: row.pct_no_prazo === null ? null : Number(row.pct_no_prazo),
        };
    }, {
        total_entregas: 0, entregas_com_ocorrencia: 0, entregas_sem_ocorrencia: 0,
        entregas_atrasadas: 0, sem_checklist: 0, motoristas: 0, rotas: 0, pct_no_prazo: null,
    });

    const abertas = await iaConsulta(erros, 'ocorrencias_abertas', async () => {
        const r = await db.query(`
            SELECT
              (SELECT COUNT(*)::int FROM ocorrencias_avulsas WHERE status = 'Aberta') AS avulsas_abertas,
              (SELECT COUNT(*)::int FROM ocorrencias_avulsas WHERE status = 'Aberta' AND NULLIF(culpa, '') IS NULL) AS avulsas_sem_responsavel,
              (SELECT COUNT(*)::int FROM ocorrencias WHERE teve_ocorrencia = TRUE AND ocorrencia_status = 'Aberta' AND excluida_em IS NULL) AS entregas_abertas,
              (SELECT COUNT(*)::int FROM ocorrencias WHERE teve_ocorrencia = TRUE AND ocorrencia_status = 'Aberta' AND excluida_em IS NULL AND NULLIF(ocorrencia_responsavel, '') IS NULL) AS entregas_sem_responsavel
        `);
        const row = r.rows[0] || {};
        return {
            total: (row.avulsas_abertas || 0) + (row.entregas_abertas || 0),
            sem_responsavel: (row.avulsas_sem_responsavel || 0) + (row.entregas_sem_responsavel || 0),
            avulsas_abertas: row.avulsas_abertas || 0,
            entregas_abertas: row.entregas_abertas || 0,
        };
    }, { total: 0, sem_responsavel: 0, avulsas_abertas: 0, entregas_abertas: 0 });

    const rotasCriticas = await iaConsulta(erros, 'rotas_criticas', async () => {
        const r = await db.query(`
            SELECT
                COALESCE(NULLIF(rota, ''), '(sem rota)') AS rota,
                COUNT(*)::int AS entregas,
                COUNT(*) FILTER (WHERE sla_status = 'Atrasada')::int AS atrasadas,
                COUNT(*) FILTER (WHERE COALESCE(teve_ocorrencia, FALSE))::int AS ocorrencias,
                ROUND(100.0 * COUNT(*) FILTER (WHERE sla_status = 'Atrasada') / NULLIF(COUNT(*), 0), 1) AS pct_atraso
            FROM ocorrencias
            WHERE excluida_em IS NULL AND ${filtroData}
            GROUP BY 1
            ORDER BY atrasadas DESC, ocorrencias DESC, entregas DESC
            LIMIT 8
        `, params);
        return r.rows;
    }, []);

    const lojasCriticas = await iaConsulta(erros, 'lojas_criticas', async () => {
        const r = await db.query(`
            SELECT
                COALESCE(NULLIF(loja, ''), '(sem loja)') AS loja,
                COALESCE(NULLIF(rota, ''), '(sem rota)') AS rota,
                COUNT(*)::int AS entregas,
                COUNT(*) FILTER (WHERE sla_status = 'Atrasada')::int AS atrasadas,
                COUNT(*) FILTER (WHERE COALESCE(teve_ocorrencia, FALSE))::int AS ocorrencias
            FROM ocorrencias
            WHERE excluida_em IS NULL AND ${filtroData}
            GROUP BY 1, 2
            ORDER BY ocorrencias DESC, atrasadas DESC, entregas DESC
            LIMIT 8
        `, params);
        return r.rows;
    }, []);

    const motoristasAtencao = await iaConsulta(erros, 'motoristas_atencao', async () => {
        const r = await db.query(`
            SELECT
                COALESCE(NULLIF(motorista, ''), '(sem motorista)') AS motorista,
                COUNT(*)::int AS entregas,
                COUNT(*) FILTER (WHERE sla_status = 'Atrasada')::int AS atrasadas,
                COUNT(*) FILTER (WHERE COALESCE(teve_ocorrencia, FALSE))::int AS ocorrencias,
                COUNT(*) FILTER (WHERE fez_checklist = FALSE)::int AS sem_checklist
            FROM ocorrencias
            WHERE excluida_em IS NULL AND ${filtroData}
            GROUP BY 1
            ORDER BY ocorrencias DESC, atrasadas DESC, sem_checklist DESC, entregas DESC
            LIMIT 8
        `, params);
        return r.rows;
    }, []);

    const tiposOcorrencia = await iaConsulta(erros, 'tipos_ocorrencia', async () => {
        const r = await db.query(`
            SELECT COALESCE(NULLIF(tipo_problema, ''), '(sem tipo)') AS tipo, COUNT(*)::int AS qtd
            FROM ocorrencias
            WHERE excluida_em IS NULL
              AND COALESCE(teve_ocorrencia, FALSE)
              AND ${filtroData}
            GROUP BY 1
            ORDER BY qtd DESC
            LIMIT 8
        `, params);
        return r.rows;
    }, []);

    const saidaFabrica = await iaConsulta(erros, 'saida_fabrica', async () => {
        const r = await db.query(`
            SELECT
                COUNT(*) FILTER (
                    WHERE hora_marcada_saida IS NOT NULL
                      AND hora_saida_fabrica IS NOT NULL
                      AND hora_saida_fabrica > hora_marcada_saida
                )::int AS saidas_atrasadas,
                COUNT(*) FILTER (WHERE hora_marcada_saida IS NOT NULL AND hora_saida_fabrica IS NOT NULL)::int AS saidas_comparaveis
            FROM ocorrencias
            WHERE excluida_em IS NULL AND ${filtroData}
        `, params);
        return r.rows[0] || { saidas_atrasadas: 0, saidas_comparaveis: 0 };
    }, { saidas_atrasadas: 0, saidas_comparaveis: 0 });

    const tmsHoje = await iaConsulta(erros, 'tms_hoje', async () => {
        const r = await db.query(`
            SELECT
                COUNT(DISTINCT v.id)::int AS viagens,
                COUNT(p.id)::int AS paradas,
                COUNT(p.id) FILTER (WHERE LOWER(COALESCE(p.status, '')) IN ('pendente', 'em atendimento'))::int AS paradas_pendentes,
                COUNT(p.id) FILTER (WHERE LOWER(COALESCE(p.status, '')) IN ('entregue', 'entregue com ocorrencia', 'recusada'))::int AS paradas_finalizadas,
                COUNT(DISTINCT v.id) FILTER (
                    WHERE LOWER(COALESCE(v.status, '')) IN ('liberada', 'em rota', 'retorno', 'finalizada')
                      AND p.remessas IS NOT NULL
                      AND COALESCE(p.cte_concluido, FALSE) = FALSE
                )::int AS viagens_sem_cte
            FROM tms_viagens v
            LEFT JOIN tms_paradas p ON p.viagem_id = v.id
            WHERE v.data_viagem = CURRENT_DATE
              AND COALESCE(v.status, '') <> 'Cancelada'
        `);
        return r.rows[0] || { viagens: 0, paradas: 0, paradas_pendentes: 0, paradas_finalizadas: 0, viagens_sem_cte: 0 };
    }, { viagens: 0, paradas: 0, paradas_pendentes: 0, paradas_finalizadas: 0, viagens_sem_cte: 0 });

    const errosOperacionais = await iaConsulta(erros, 'erros_operacionais', async () => {
        const r = await db.query(`
            SELECT
                COALESCE(NULLIF(area, ''), NULLIF(responsavel, ''), '(sem area)') AS area,
                COUNT(*)::int AS qtd,
                COUNT(*) FILTER (WHERE NULLIF(gravidade, '') IS NOT NULL)::int AS com_gravidade
            FROM ocorrencias_operacionais
            WHERE data_ocorrencia >= CURRENT_DATE - ($1::int * INTERVAL '1 day')
            GROUP BY 1
            ORDER BY qtd DESC
            LIMIT 6
        `, params);
        return r.rows;
    }, []);

    const contexto = {
        periodo: periodo.chave,
        periodo_label: periodo.label,
        gerado_em: new Date().toISOString(),
        resumo,
        ocorrencias_abertas: abertas,
        tms_hoje: tmsHoje,
        saida_fabrica: saidaFabrica,
        rankings: {
            rotas_criticas: rotasCriticas,
            lojas_criticas: lojasCriticas,
            motoristas_atencao: motoristasAtencao,
            tipos_ocorrencia: tiposOcorrencia,
            erros_operacionais: errosOperacionais,
        },
        erros,
    };

    return contexto;
}

function gerarInsightsLocais(ctx) {
    const insights = [];
    const acoes = [];
    const resumo = ctx.resumo || {};
    const abertas = ctx.ocorrencias_abertas || {};
    const tms = ctx.tms_hoje || {};
    const saida = ctx.saida_fabrica || {};
    const rankings = ctx.rankings || {};
    const topRota = (rankings.rotas_criticas || [])[0];
    const topLoja = (rankings.lojas_criticas || [])[0];
    const topMotorista = (rankings.motoristas_atencao || [])[0];

    if ((resumo.entregas_atrasadas || 0) > 0) {
        insights.push({
            nivel: 'alto',
            titulo: 'Atrasos concentrados no periodo',
            detalhe: `${resumo.entregas_atrasadas} entrega(s) com SLA atrasado em ${ctx.periodo_label}.`,
        });
        acoes.push('Priorizar rotas com mais atrasos e validar horarios de saida antes da proxima janela.');
    }
    if (topRota && (topRota.atrasadas > 0 || topRota.ocorrencias > 0)) {
        insights.push({
            nivel: topRota.atrasadas >= 3 ? 'alto' : 'medio',
            titulo: `Rota em atencao: ${topRota.rota}`,
            detalhe: `${topRota.atrasadas || 0} atraso(s), ${topRota.ocorrencias || 0} ocorrencia(s), ${topRota.entregas || 0} entrega(s).`,
        });
        acoes.push(`Revisar planejamento da rota ${topRota.rota} e comparar hora marcada x hora real.`);
    }
    if (topLoja && (topLoja.ocorrencias > 0 || topLoja.atrasadas > 0)) {
        insights.push({
            nivel: 'medio',
            titulo: `Loja critica: ${topLoja.loja}`,
            detalhe: `${topLoja.ocorrencias || 0} ocorrencia(s) e ${topLoja.atrasadas || 0} atraso(s) na rota ${topLoja.rota}.`,
        });
        acoes.push(`Checar recorrencia na loja ${topLoja.loja}: recebimento, janela, divergencia ou doca.`);
    }
    if (topMotorista && (topMotorista.ocorrencias > 0 || topMotorista.sem_checklist > 0)) {
        insights.push({
            nivel: topMotorista.ocorrencias >= 3 ? 'alto' : 'medio',
            titulo: `Motorista em acompanhamento: ${topMotorista.motorista}`,
            detalhe: `${topMotorista.ocorrencias || 0} ocorrencia(s), ${topMotorista.atrasadas || 0} atraso(s), ${topMotorista.sem_checklist || 0} checklist(s) pendente(s).`,
        });
        acoes.push(`Conversar com ${topMotorista.motorista} usando os registros do periodo como base objetiva.`);
    }
    if ((abertas.sem_responsavel || 0) > 0) {
        insights.push({
            nivel: 'medio',
            titulo: 'Ocorrencias abertas sem responsavel',
            detalhe: `${abertas.sem_responsavel} ocorrencia(s) ainda precisam de dono para tratamento.`,
        });
        acoes.push('Apontar responsavel nas ocorrencias abertas antes do fechamento do turno.');
    }
    if ((tms.viagens_sem_cte || 0) > 0) {
        insights.push({
            nivel: 'medio',
            titulo: 'Pendencia de CTE no TMS',
            detalhe: `${tms.viagens_sem_cte} viagem(ns) de hoje possuem remessas sem CTE concluido.`,
        });
        acoes.push('Abrir CTEs do dia e concluir pendencias antes da liberacao final.');
    }
    if ((saida.saidas_atrasadas || 0) > 0) {
        insights.push({
            nivel: 'medio',
            titulo: 'Saida da fabrica atrasando a operacao',
            detalhe: `${saida.saidas_atrasadas} saida(s) atrasada(s) entre ${saida.saidas_comparaveis || 0} comparavel(is).`,
        });
        acoes.push('Validar gargalos de carregamento e checklist antes da saida da fabrica.');
    }
    if (!insights.length) {
        insights.push({
            nivel: 'baixo',
            titulo: 'Operacao sem alerta forte no recorte',
            detalhe: 'Os indicadores agregados nao apontam concentracao critica no periodo selecionado.',
        });
        acoes.push('Manter acompanhamento de rotas, CTEs e ocorrencias abertas durante o dia.');
    }

    return { insights, acoes: [...new Set(acoes)].slice(0, 6) };
}

// Textos do prompt (system + user) compartilhados por todos os provedores de IA.
function textosPromptAnalitico(pergunta, contexto) {
    const objetivo = pergunta
        ? `Responda a pergunta do usuario: "${pergunta}".`
        : 'Gere uma leitura executiva dos indicadores.';
    const system = 'Voce e uma IA analitica de uma torre logistica. Use somente os dados agregados enviados. Nao invente registros, nomes ou causas. Quando sugerir causa, marque como hipotese. Seja direto, operacional e acionavel em portugues do Brasil.';
    const user = `${objetivo}\n\nFormato esperado:\n- Diagnostico em ate 4 bullets\n- Prioridades imediatas\n- Acoes recomendadas\n- Riscos ou dados insuficientes\n\nDados agregados:\n${JSON.stringify(contexto)}`;
    return { system, user };
}

// Formato da Responses API da OpenAI.
function montarPromptAnalitico(pergunta, contexto) {
    const { system, user } = textosPromptAnalitico(pergunta, contexto);
    return [
        { role: 'system', content: [{ type: 'input_text', text: system }] },
        { role: 'user', content: [{ type: 'input_text', text: user }] },
    ];
}

function extrairTextoOpenAI(body) {
    if (typeof body?.output_text === 'string') return body.output_text.trim();
    const partes = [];
    for (const item of body?.output || []) {
        for (const conteudo of item.content || []) {
            if (typeof conteudo.text === 'string') partes.push(conteudo.text);
            if (typeof conteudo.refusal === 'string') partes.push(conteudo.refusal);
        }
    }
    return partes.join('\n').trim();
}

async function chamarOpenAIAnalitica(pergunta, contexto) {
    const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
    if (!apiKey) return null;

    const model = String(process.env.OPENAI_MODEL || process.env.IA_MODEL || 'gpt-5.5').trim();
    // Em modelos de raciocinio os tokens de reasoning contam neste limite, entao
    // um teto baixo faz o raciocinio consumir tudo e sobrar texto vazio. 1500 da folga.
    const maxTokens = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 1500);
    // Timeout pra nao pendurar o /ia/insights se a OpenAI travar.
    const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || 30000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let resp;
    try {
        resp = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model,
                input: montarPromptAnalitico(pergunta, contexto),
                reasoning: { effort: 'low' },
                text: { verbosity: 'low' },
                max_output_tokens: maxTokens,
                store: false,
            }),
            signal: controller.signal,
        });
    } catch (err) {
        if (err.name === 'AbortError') throw new Error(`OpenAI nao respondeu em ${Math.round(timeoutMs / 1000)}s.`);
        throw new Error(`Falha ao contatar a OpenAI: ${err.message}`);
    } finally {
        clearTimeout(timer);
    }

    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        const detalhe = body?.error?.message || `HTTP ${resp.status}`;
        throw new Error(`Falha na OpenAI: ${detalhe}`);
    }

    const texto = extrairTextoOpenAI(body);
    if (!texto) {
        // Resposta sem texto: quase sempre e truncamento por max_output_tokens
        // (raciocinio consumiu o orcamento) ou uma recusa do modelo.
        if (body?.status === 'incomplete') {
            const motivo = body?.incomplete_details?.reason || 'resposta truncada';
            throw new Error(`OpenAI devolveu resposta incompleta (${motivo}). Aumente OPENAI_MAX_OUTPUT_TOKENS.`);
        }
        throw new Error('OpenAI retornou uma resposta vazia.');
    }

    return {
        modelo: model,
        texto,
        id: body.id || null,
    };
}

// Anthropic Claude (Messages API). Chave em console.anthropic.com (formato sk-ant-...).
// Junta os blocos de texto da resposta (content e um array de blocks).
function extrairTextoAnthropic(body) {
    return (body?.content || [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
        .trim();
}

async function chamarAnthropicAnalitica(pergunta, contexto) {
    const apiKey = String(process.env.ANTHROPIC_API_KEY || '').trim();
    if (!apiKey) return null;

    const model = String(process.env.ANTHROPIC_MODEL || process.env.IA_MODEL || 'claude-opus-4-8').trim();
    const maxTokens = Number(process.env.ANTHROPIC_MAX_OUTPUT_TOKENS || process.env.IA_MAX_OUTPUT_TOKENS || 1500);
    const timeoutMs = Number(process.env.IA_TIMEOUT_MS || 30000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const { system, user } = textosPromptAnalitico(pergunta, contexto);

    // system e um parametro de topo no Messages API; a pergunta vai como 1a msg do usuario.
    const corpo = JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
    });

    // 429 (cota/limite), 529 (overloaded) e 5xx sao transitorios: tenta com backoff.
    const transitorios = new Set([429, 500, 502, 503, 529]);
    const tentativas = Math.max(1, Number(process.env.IA_RETRIES || 4));
    let ultimoDetalhe = '';

    for (let i = 0; i < tentativas; i++) {
        let resp;
        try {
            resp = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json',
                },
                body: corpo,
                signal: controller.signal,
            });
        } catch (err) {
            clearTimeout(timer);
            if (err.name === 'AbortError') throw new Error(`Anthropic nao respondeu em ${Math.round(timeoutMs / 1000)}s.`);
            throw new Error(`Falha ao contatar a Anthropic: ${err.message}`);
        }

        const body = await resp.json().catch(() => ({}));

        if (!resp.ok) {
            ultimoDetalhe = body?.error?.message || `HTTP ${resp.status}`;
            if (transitorios.has(resp.status) && i < tentativas - 1) {
                await new Promise((r) => setTimeout(r, 700 * (i + 1)));
                continue;
            }
            clearTimeout(timer);
            throw new Error(`Falha na Anthropic: ${ultimoDetalhe}`);
        }

        clearTimeout(timer);
        const texto = extrairTextoAnthropic(body);
        if (!texto) {
            if (body?.stop_reason === 'max_tokens') throw new Error('Claude devolveu resposta truncada. Aumente ANTHROPIC_MAX_OUTPUT_TOKENS.');
            if (body?.stop_reason === 'refusal') throw new Error('Claude recusou a resposta por politica de seguranca.');
            throw new Error('Claude retornou uma resposta vazia.');
        }
        return { modelo: model, texto, id: body.id || null };
    }

    clearTimeout(timer);
    throw new Error(`Falha na Anthropic apos ${tentativas} tentativas: ${ultimoDetalhe}`);
}

// Google Gemini (camada gratuita, sem cartao). Chave gratuita em aistudio.google.com.
async function chamarGeminiAnalitica(pergunta, contexto) {
    const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) return null;

    const model = String(process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite').trim();
    const maxTokens = Number(process.env.IA_MAX_OUTPUT_TOKENS || process.env.GEMINI_MAX_OUTPUT_TOKENS || 1200);
    const timeoutMs = Number(process.env.IA_TIMEOUT_MS || 30000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const { system, user } = textosPromptAnalitico(pergunta, contexto);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

    // Modelos 2.5+ sao "thinking": sem limitar o raciocinio, ele consome o
    // orcamento de tokens e sobra texto vazio. thinkingBudget=0 pede resposta
    // direta. Defina GEMINI_THINKING_BUDGET=off para modelos que nao suportam.
    const generationConfig = { temperature: 0.4, maxOutputTokens: maxTokens };
    const thinkingRaw = String(process.env.GEMINI_THINKING_BUDGET ?? '0').trim().toLowerCase();
    if (thinkingRaw !== 'off' && thinkingRaw !== '') {
        generationConfig.thinkingConfig = { thinkingBudget: Number(thinkingRaw) || 0 };
    }

    const corpo = JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig,
    });

    // O free tier (e a propagacao de uma chave recem-criada) devolve erros
    // transitorios: 403 enquanto a API propaga, 429 por cota, 500/503 por
    // capacidade. Tenta algumas vezes com backoff antes de desistir.
    const transitorios = new Set([403, 429, 500, 502, 503, 504]);
    const tentativas = Math.max(1, Number(process.env.IA_RETRIES || 4));
    let ultimoDetalhe = '';

    for (let i = 0; i < tentativas; i++) {
        let resp;
        try {
            resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
                body: corpo,
                signal: controller.signal,
            });
        } catch (err) {
            clearTimeout(timer);
            if (err.name === 'AbortError') throw new Error(`Gemini nao respondeu em ${Math.round(timeoutMs / 1000)}s.`);
            throw new Error(`Falha ao contatar o Gemini: ${err.message}`);
        }

        const body = await resp.json().catch(() => ({}));

        if (!resp.ok) {
            ultimoDetalhe = body?.error?.message || `HTTP ${resp.status}`;
            if (transitorios.has(resp.status) && i < tentativas - 1) {
                await new Promise((r) => setTimeout(r, 700 * (i + 1)));
                continue;
            }
            clearTimeout(timer);
            throw new Error(`Falha no Gemini: ${ultimoDetalhe}`);
        }

        clearTimeout(timer);
        const cand = (body.candidates || [])[0];
        const texto = (cand?.content?.parts || []).map((p) => p.text || '').join('').trim();
        if (!texto) {
            const motivo = cand?.finishReason;
            if (motivo === 'MAX_TOKENS') throw new Error('Gemini devolveu resposta truncada. Aumente IA_MAX_OUTPUT_TOKENS.');
            if (motivo === 'SAFETY') throw new Error('Gemini bloqueou a resposta por politica de seguranca.');
            throw new Error('Gemini retornou uma resposta vazia.');
        }

        return { modelo: model, texto, id: body.responseId || null };
    }

    clearTimeout(timer);
    throw new Error(`Falha no Gemini apos ${tentativas} tentativas: ${ultimoDetalhe}`);
}

// Seletor de provedor de IA: Gemini (gratuito) tem prioridade; OpenAI como alternativa.
// Sem nenhuma chave, retorna null e o sistema usa apenas o motor local.
function iaProviderAtivo() {
    return iaProvidersOrdenados()[0] || null;
}

// Provedores com chave, na ordem de preferencia: Gemini (gratuito) primeiro,
// OpenAI como fallback pago. A cadeia so cai no motor local se TODOS falharem.
function iaProvidersOrdenados() {
    // IA_FORCAR_LOCAL=1 -> usa SO o motor de regras local (IA propria, sem LLM externo).
    if (/^(1|true|sim|local|on)$/i.test(String(process.env.IA_FORCAR_LOCAL || '').trim())) return [];
    const list = [];
    // Anthropic (Claude) tem prioridade quando configurada; Gemini (gratuito) e
    // OpenAI ficam como fallback. Ajuste a ordem aqui se quiser free-first.
    if (String(process.env.ANTHROPIC_API_KEY || '').trim()) list.push('anthropic');
    if (String(process.env.GEMINI_API_KEY || '').trim()) list.push('gemini');
    if (String(process.env.OPENAI_API_KEY || '').trim()) list.push('openai');
    return list;
}

// Tenta cada provedor em ordem; retorna o 1o que responder, anotando qual foi.
// Se o Gemini estoura cota (429), cai pra OpenAI em vez de ir direto pro local.
async function chamarComFallback(fnPorProvedor) {
    const provedores = iaProvidersOrdenados();
    let ultimoErro = null;
    for (const prov of provedores) {
        try {
            const r = await fnPorProvedor(prov);
            if (r) return { ...r, provider: prov };
        } catch (err) {
            ultimoErro = err;
            console.error(`[IA] provedor ${prov} falhou, tentando o proximo:`, err.message);
        }
    }
    if (ultimoErro) throw ultimoErro;
    return null;
}

// Traduz o erro cru da IA online numa explicacao honesta pro usuario final.
// O free tier do Gemini estoura cota (429) com facilidade; nesse caso o painel
// cai no motor local e esta funcao explica o porque, sem culpar chave errada.
function iaErroAmigavel(msg) {
    const m = String(msg || '');
    if (/quota|resource_exhausted|429|exceeded|cota/i.test(m)) {
        return 'A cota gratuita do Gemini foi atingida agora - respondendo com analise local. Tente de novo em ~1 minuto.';
    }
    if (/timeout|nao respondeu|abort/i.test(m)) {
        return 'A IA do Gemini demorou para responder - respondendo com analise local. Tente de novo.';
    }
    return 'A IA online esta indisponivel no momento - respondendo com analise local.';
}

// Cache em memoria do /ia/insights: o painel dispara essa rota a cada abertura,
// e cada chamada gasta 1 requisicao do free tier do Gemini. Guarda o resultado
// por periodo. Sucesso segura mais tempo; quando cai no local (cota/erro) usa um
// TTL curto pra reencostar no Gemini assim que a janela de cota resetar.
const insightsCache = new Map();
const INSIGHTS_TTL_OK = Number(process.env.IA_INSIGHTS_TTL_MS || 5 * 60 * 1000);
const INSIGHTS_TTL_FALLBACK = Number(process.env.IA_INSIGHTS_TTL_FALLBACK_MS || 60 * 1000);

async function chamarIaAnalitica(pergunta, contexto) {
    return chamarComFallback((prov) =>
        prov === 'anthropic' ? chamarAnthropicAnalitica(pergunta, contexto)
        : prov === 'gemini' ? chamarGeminiAnalitica(pergunta, contexto)
        : prov === 'openai' ? chamarOpenAIAnalitica(pergunta, contexto)
        : null);
}

// ================================================================
// MOTOR LOCAL DE REGRAS ("IA propria", sem LLM externo)
// Responde a partir dos dados ja agregados em `contexto` + base de
// conhecimento. Deterministico: nunca inventa. Tambem reconhece comandos de
// cadastro e emite o bloco de acao (mesmo protocolo do card de confirmacao).
// ================================================================
function iaNorm(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function iaTem(q, termos) {
    return termos.some((t) => q.includes(t));
}
function iaLimpaValor(s) {
    return String(s || '').trim().replace(/^["'“”]+/, '').replace(/["'“”.!?]+$/, '').replace(/\s+/g, ' ').trim();
}
function iaLista(lista, fmt, vazio, n = 5) {
    if (!Array.isArray(lista) || !lista.length) return vazio;
    return lista.slice(0, n).map((x, i) => `- ${i + 1}. ${fmt(x)}`).join('\n');
}

// Detecta comando de cadastro na frase e devolve { ferramenta, args } ou null.
function iaDetectarAcao(pergunta) {
    const q = iaNorm(pergunta);
    if (!/(cadastr|adicion|inclu|criar|cria |registr)/.test(q)) return null;
    const V = '(?:cadastr\\w*|adicion\\w*|inclu\\w*|registr\\w*|criar?|cria)';
    let m;
    if ((m = pergunta.match(new RegExp(V + '\\s+(?:a\\s+)?loja\\s+(.+?)(?:\\s+na\\s+rota\\s+(.+))?[.!?]*$', 'i')))) {
        const args = { nome: iaLimpaValor(m[1]) };
        if (m[2]) args.rota = iaLimpaValor(m[2]);
        return args.nome ? { ferramenta: 'cadastrar_loja', args } : null;
    }
    if ((m = pergunta.match(new RegExp(V + '\\s+(?:o\\s+)?motorista\\s+(.+?)[.!?]*$', 'i')))) {
        const nome = iaLimpaValor(m[1]);
        return nome ? { ferramenta: 'cadastrar_motorista', args: { nome } } : null;
    }
    if ((m = pergunta.match(new RegExp(V + '\\s+(?:o\\s+)?ajudante\\s+(.+?)[.!?]*$', 'i')))) {
        const nome = iaLimpaValor(m[1]);
        return nome ? { ferramenta: 'cadastrar_ajudante', args: { nome } } : null;
    }
    if ((m = pergunta.match(new RegExp(V + '\\s+(?:a\\s+)?placa\\s+([A-Za-z0-9-]{5,8})', 'i')))) {
        return { ferramenta: 'cadastrar_placa', args: { placa: iaLimpaValor(m[1]).toUpperCase() } };
    }
    if (/(atraso.*saida|saida.*fabrica|retorno.*rota|tempo.*rota)/.test(q)) {
        return { ferramenta: '_form', args: {} };
    }
    return null;
}

function iaRespostaAcao(acao) {
    if (acao.ferramenta === '_form') {
        return 'Para registrar **atraso de saída** ou **retorno de rota** é mais seguro pelo formulário (tem cálculo de minutos e validação). Abra a aba, clique em "➕ Registrar" e me diga os dados que eu confiro.';
    }
    const verbo = {
        cadastrar_loja: 'cadastrar a loja',
        cadastrar_motorista: 'cadastrar o motorista',
        cadastrar_ajudante: 'cadastrar o ajudante',
        cadastrar_placa: 'cadastrar a placa',
    }[acao.ferramenta] || 'executar a ação';
    const alvo = acao.args.nome || acao.args.placa || '';
    const extra = acao.args.rota ? ` na rota **${acao.args.rota}**` : '';
    return `Certo! Vou ${verbo} **${alvo}**${extra}. Confirme abaixo.\n\n\`\`\`acao\n${JSON.stringify(acao)}\n\`\`\``;
}

// Busca na base de conhecimento pelos termos relevantes da pergunta.
function iaBuscarConhecimento(q, conhecimento) {
    if (!Array.isArray(conhecimento) || !conhecimento.length) return null;
    const termos = q.split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    if (!termos.length) return null;
    const hits = conhecimento.filter((k) => {
        const t = iaNorm(`${k.titulo} ${k.conteudo} ${k.tags || ''}`);
        return termos.some((w) => t.includes(w));
    });
    if (!hits.length) return null;
    return 'Segundo o que me ensinaram:\n' + hits.slice(0, 4).map((k) => `- **${k.titulo}**: ${k.conteudo}`).join('\n');
}

function iaMenuAjuda() {
    return [
        'Sou a **IA local** do Controle de Entrega — funciono sem internet, direto sobre os dados do sistema. Posso responder, por exemplo:',
        '- **Panorama**: "como está a operação?"',
        '- **Atrasos / SLA**: "quais rotas mais atrasam?"',
        '- **Rotas, lojas e motoristas** que merecem atenção',
        '- **Ocorrências** abertas e tipos de problema',
        '- **TMS**: viagens, paradas e CTE de hoje',
        '- **Saída de fábrica** e **tempo/retorno de rota**',
        '- **Cadastros**: "quantas lojas temos?", "existe o motorista João?"',
        '- **Cadastrar**: "cadastrar loja X na rota Y" (peço confirmação antes)',
        '- **Ensinar**: `/ensinar <fato>` pra eu passar a lembrar',
        '',
        'Dica: use o seletor de período no topo do chat pra mudar a janela dos números.',
    ].join('\n');
}

function iaResumoGeral(r, ab, tms, per) {
    return [
        `**Panorama — ${per}:**`,
        `- Entregas: ${r.total_entregas || 0} · atrasadas: ${r.entregas_atrasadas || 0} · no prazo: ${r.pct_no_prazo ?? '-'}%`,
        `- Ocorrências em entregas: ${r.entregas_com_ocorrencia || 0} · sem checklist: ${r.sem_checklist || 0}`,
        `- Ocorrências abertas: ${ab.total || 0} (${ab.sem_responsavel || 0} sem responsável)`,
        `- TMS hoje: ${tms.viagens || 0} viagem(ns) · ${tms.paradas_pendentes || 0} parada(s) pendente(s) · ${tms.viagens_sem_cte || 0} sem CTE`,
    ].join('\n');
}

function iaRespostaCadastros(q, pergunta, cad) {
    const tipos = ['loja', 'motorista', 'ajudante', 'placa', 'rota'];
    let tipo = null;
    for (const t of tipos) { if (q.includes(t)) { tipo = t; break; } }
    if (!tipo) return null;
    const querListar = /(quant\w+|lista|listar|liste|quais|todas|todos|mostr)/.test(q);
    const querExiste = /(existe|ja tem|tem o |tem a |tem um |tem uma |cadastrad|possui|conhece)/.test(q);
    if (!querListar && !querExiste) return null;
    const info = cad[tipo] || { total: 0, valores: [] };
    if (querExiste) {
        const m = pergunta.match(new RegExp(tipo + '\\s+(.+?)[?.!]*$', 'i'));
        const alvo = m ? iaLimpaValor(m[1]) : '';
        if (alvo && !/^(cadastrad|existe)/i.test(alvo)) {
            const achou = (info.valores || []).find((v) => iaNorm(v) === iaNorm(alvo) || iaNorm(v).includes(iaNorm(alvo)));
            return achou
                ? `Sim, **${achou}** já está cadastrado(a) como ${tipo}.`
                : `Não encontrei **${alvo}** entre os ${info.total || 0} ${tipo}(s) cadastrados. Quer cadastrar? Diga: "cadastrar ${tipo} ${alvo}".`;
        }
    }
    const amostra = (info.valores || []).slice(0, 40);
    const cab = `Temos **${info.total || 0}** ${tipo}(s) cadastrado(s)`;
    if (!amostra.length) return cab + '.';
    return `${cab}${info.total > amostra.length ? ` (mostrando ${amostra.length})` : ''}:\n` + amostra.map((v) => `- ${v}`).join('\n');
}

// Motor principal: casa a pergunta com uma intencao e responde com dados reais.
// permitirAcoes=true (so no chat) habilita a deteccao de comandos de cadastro.
function respostaLocalPergunta(pergunta, contexto, locais, nota, conhecimento, permitirAcoes) {
    const cabecalho = nota ? nota + '\n\n' : '';
    const q = iaNorm(pergunta);
    const r = contexto.resumo || {};
    const ab = contexto.ocorrencias_abertas || {};
    const tms = contexto.tms_hoje || {};
    const sf = contexto.saida_fabrica || {};
    const rk = contexto.rankings || {};
    const cad = contexto.cadastros || {};
    const atr = contexto.atraso_saida_registros || [];
    const rr = contexto.rotas_registradas || {};
    const per = contexto.periodo_label || 'período';

    if (permitirAcoes) {
        const acao = iaDetectarAcao(pergunta);
        if (acao) return iaRespostaAcao(acao);
    }
    if (iaTem(q, ['ajuda', 'o que voce faz', 'o que vc faz', 'o que voce sabe', 'menu', 'como usar', 'o que pode fazer', 'pra que serve'])
        || /^(oi|ola|opa|bom dia|boa tarde|boa noite|e ai|eae|salve)\b/.test(q)) {
        return cabecalho + iaMenuAjuda();
    }
    const rc = iaRespostaCadastros(q, pergunta, cad);
    if (rc) return cabecalho + rc;

    if (q.includes('saida') || (q.includes('fabrica') && q.includes('atras'))) {
        const linhas = [`**Saída de fábrica — ${per}:**`,
            `- Saídas atrasadas: ${sf.saidas_atrasadas || 0} de ${sf.saidas_comparaveis || 0} comparáveis`];
        const top = iaLista(atr, (a) => `${a.motorista}: ${a.atrasadas || 0} atraso(s), média ${a.media_min || 0} min (maior ${a.maior_min || 0})`, '');
        if (top) linhas.push('', '**Quem mais atrasa a saída:**', top);
        return cabecalho + linhas.join('\n');
    }
    if (iaTem(q, ['tempo de rota', 'retorno', 'excedente', 'hora extra', 'horas extra'])) {
        return cabecalho + [`**Tempo/retorno de rota — ${per}:**`,
            `- Registros: ${rr.registros || 0}`,
            `- Com minutos excedentes: ${rr.com_excedente || 0}`,
            `- Total de minutos excedentes: ${rr.total_excedente_min || 0}`,
            `- Duração média: ${rr.media_total_min || 0} min`].join('\n');
    }
    if (iaTem(q, ['tms', 'viagem', 'viagens', 'parada', 'paradas', 'cte', 'transporte'])) {
        return cabecalho + [`**TMS — hoje:**`,
            `- Viagens: ${tms.viagens || 0}`,
            `- Paradas: ${tms.paradas || 0} (pendentes: ${tms.paradas_pendentes || 0}, finalizadas: ${tms.paradas_finalizadas || 0})`,
            `- Viagens com remessa sem CTE: ${tms.viagens_sem_cte || 0}`].join('\n');
    }
    if (iaTem(q, ['checklist', 'check list'])) {
        return cabecalho + `No período (${per}), **${r.sem_checklist || 0}** entrega(s) ficaram **sem checklist**, de ${r.total_entregas || 0} no total.`;
    }
    if (q.includes('tipo')) {
        const t = iaLista(rk.tipos_ocorrencia, (x) => `${x.tipo}: ${x.qtd}`, '_Sem ocorrências classificadas no período._');
        return cabecalho + `**Tipos de problema — ${per}:**\n${t}`;
    }
    if (iaTem(q, ['aberta', 'abertas', 'pendencia', 'sem responsavel', 'sem dono', 'em aberto', 'tratar'])) {
        return cabecalho + [`**Ocorrências abertas:**`,
            `- Total: ${ab.total || 0} (sem responsável: ${ab.sem_responsavel || 0})`,
            `- Em entregas: ${ab.entregas_abertas || 0} · avulsas: ${ab.avulsas_abertas || 0}`].join('\n');
    }
    if (q.includes('erro') || q.includes('setor') || (q.includes('area') && !q.includes('rota'))) {
        const e = iaLista(rk.erros_operacionais, (x) => `${x.area}: ${x.qtd}${x.com_gravidade ? ` (${x.com_gravidade} c/ gravidade)` : ''}`, '_Sem erros operacionais no período._');
        return cabecalho + `**Erros operacionais por área — ${per}:**\n${e}`;
    }
    if (q.includes('rota')) {
        const l = iaLista(rk.rotas_criticas, (x) => `${x.rota}: ${x.atrasadas || 0} atraso(s), ${x.ocorrencias || 0} ocorrência(s), ${x.entregas || 0} entrega(s)`, '_Sem rotas com volume relevante no período._');
        return cabecalho + `**Rotas em atenção — ${per}:**\n${l}`;
    }
    if (q.includes('loja')) {
        const l = iaLista(rk.lojas_criticas, (x) => `${x.loja} (${x.rota}): ${x.ocorrencias || 0} ocorrência(s), ${x.atrasadas || 0} atraso(s)`, '_Sem lojas críticas no período._');
        return cabecalho + `**Lojas em atenção — ${per}:**\n${l}`;
    }
    if (iaTem(q, ['motorista', 'condutor'])) {
        let out = `**Motoristas em atenção — ${per}:**\n` +
            iaLista(rk.motoristas_atencao, (x) => `${x.motorista}: ${x.ocorrencias || 0} oco., ${x.atrasadas || 0} atraso(s), ${x.sem_checklist || 0} sem checklist`, '_Sem motoristas com recorrência no período._');
        const top = iaLista(atr, (a) => `${a.motorista}: ${a.atrasadas || 0} atraso(s) de saída, média ${a.media_min || 0} min`, '');
        if (top) out += '\n\n**Mais atrasam a saída da fábrica:**\n' + top;
        return cabecalho + out;
    }
    if (iaTem(q, ['atraso', 'atrasad', 'sla', 'prazo', 'pontualidade', 'no prazo'])) {
        const l = iaLista(rk.rotas_criticas, (x) => `${x.rota}: ${x.atrasadas || 0} atraso(s) em ${x.entregas || 0} entrega(s)`, '');
        return cabecalho + [`**Atrasos — ${per}:**`,
            `- Entregas atrasadas: ${r.entregas_atrasadas || 0} · no prazo: ${r.pct_no_prazo ?? '-'}%`,
            l ? `\n**Rotas que mais atrasam:**\n${l}` : ''].filter(Boolean).join('\n');
    }
    if (iaTem(q, ['resumo', 'panorama', 'visao geral', 'situacao', 'como esta', 'como estamos', 'geral', 'overview', 'status'])) {
        return cabecalho + iaResumoGeral(r, ab, tms, per);
    }

    const kb = iaBuscarConhecimento(q, conhecimento);
    if (kb) return cabecalho + kb;
    return cabecalho + iaResumoGeral(r, ab, tms, per) +
        '\n\n_Não peguei exatamente o que você quer. Digite "ajuda" pra ver tudo que eu respondo._';
}

app.get('/ia/insights', async (req, res) => {
    try {
        const cacheKey = String(req.query.periodo || 'semana');
        const cache = insightsCache.get(cacheKey);
        if (cache && (Date.now() - cache.ts) < cache.ttl) {
            return res.status(200).json({ ...cache.payload, cache: true });
        }

        const contexto = await montarContextoAnalitico(req.query.periodo);
        const locais = gerarInsightsLocais(contexto);
        let ia = null;
        let iaErro = null;
        const provider = iaProviderAtivo();
        if (provider) {
            try {
                ia = await chamarIaAnalitica('', contexto);
            } catch (err) {
                iaErro = err.message;
            }
        }
        const payload = {
            contexto,
            insights: locais.insights,
            acoes: locais.acoes,
            ia_configurada: !!provider,
            ia_provider: (ia && ia.provider) || provider,
            analise_ia: ia,
            ia_erro: iaErro,
        };
        // Cacheia sempre; sucesso segura por INSIGHTS_TTL_OK, fallback (sem IA ou
        // erro de cota) por um TTL curto pra reencostar no Gemini logo depois.
        const ttl = (provider && ia && !iaErro) ? INSIGHTS_TTL_OK : INSIGHTS_TTL_FALLBACK;
        insightsCache.set(cacheKey, { ts: Date.now(), ttl, payload });
        res.status(200).json(payload);
    } catch (err) {
        console.error('[GET /ia/insights]', err);
        res.status(500).json({ error: 'Erro ao gerar insights analiticos.', detalhe: err.message });
    }
});

app.post('/ia/perguntar', async (req, res) => {
    try {
        const pergunta = String(req.body?.pergunta || '').trim();
        if (!pergunta) return res.status(400).json({ error: 'Informe uma pergunta.' });
        if (pergunta.length > 800) return res.status(400).json({ error: 'Pergunta muito longa.' });

        const contexto = await montarContextoAnalitico(req.body?.periodo);
        const locais = gerarInsightsLocais(contexto);
        const provider = iaProviderAtivo();
        if (!provider) {
            return res.status(200).json({
                origem: 'local',
                resposta: respostaLocalPergunta(pergunta, contexto, locais, 'A IA online (Gemini) nao esta configurada - respondendo com analise local.'),
                contexto,
            });
        }

        try {
            const ia = await chamarIaAnalitica(pergunta, contexto);
            return res.status(200).json({
                origem: ia.provider || provider,
                resposta: ia.texto,
                modelo: ia.modelo,
                contexto,
            });
        } catch (iaErr) {
            // IA configurada mas falhou (timeout, truncamento, cota...):
            // responde com o motor local em vez de estourar 500 pro usuario.
            console.error(`[POST /ia/perguntar] ${provider}:`, iaErr.message);
            return res.status(200).json({
                origem: 'local',
                resposta: respostaLocalPergunta(pergunta, contexto, locais, iaErroAmigavel(iaErr.message)),
                ia_erro: iaErr.message,
                contexto,
            });
        }
    } catch (err) {
        console.error('[POST /ia/perguntar]', err);
        res.status(500).json({ error: 'Erro ao consultar IA analitica.', detalhe: err.message });
    }
});

// ================================================================
// ASSISTENTE DE IA CONVERSACIONAL (chat com memoria + base de conhecimento)
// Reusa montarContextoAnalitico() e a selecao de provedor (Gemini/OpenAI).
// Diferente do /ia/perguntar (stateless), aqui entram: historico da conversa,
// a base de conhecimento ensinada pela equipe e a tela em que o usuario esta.
// ================================================================

async function carregarConhecimentoIa() {
    try {
        const r = await db.query(
            'SELECT titulo, conteudo, tags FROM ia_conhecimento WHERE ativo = TRUE ORDER BY atualizado_em DESC LIMIT 100'
        );
        return r.rows;
    } catch {
        return [];
    }
}

function blocoConhecimento(lista) {
    if (!lista || !lista.length) return '';
    const itens = lista
        .map((k, i) => `${i + 1}. ${k.titulo}: ${k.conteudo}${k.tags ? ` [${k.tags}]` : ''}`)
        .join('\n');
    return `Base de conhecimento ensinada pela equipe (trate como verdade e priorize sobre suposicoes):\n${itens}`;
}

function blocoFerramentas(hoje) {
    return [
        'VOCE PODE EXECUTAR ACOES NO SISTEMA (cadastros e registros). Quando o usuario pedir para CADASTRAR ou REGISTRAR algo, faca duas coisas:',
        '1) Escreva UMA frase curta confirmando o que vai fazer.',
        '2) Logo em seguida, inclua UM unico bloco de acao exatamente neste formato, sem nenhum texto depois dele:',
        '```acao',
        '{"ferramenta":"<nome>","args":{ ... }}',
        '```',
        'Ferramentas disponiveis (use os nomes EXATOS das chaves de args):',
        '- cadastrar_motorista {"nome"}',
        '- cadastrar_ajudante {"nome"}',
        '- cadastrar_placa {"placa"}',
        '- cadastrar_loja {"nome","rota"?}',
        '- registrar_atraso_saida {"data"(YYYY-MM-DD),"motorista","placa","rota"?,"horaMarcada"(HH:MM),"horaReal"(HH:MM),"justificativa"?}',
        '- registrar_retorno_rota {"data"(YYYY-MM-DD),"motorista","placa","rotaFeita","horaSaida"(HH:MM),"horaRetorno"(HH:MM),"responsavel"?,"obs"?}',
        `Regras: no maximo UMA acao por resposta. Se faltar algum dado OBRIGATORIO, NAO gere o bloco: pergunte o que falta primeiro. Nunca invente nomes, placas ou horarios; use apenas o que o usuario informou. Quando o usuario disser "hoje", use ${hoje || 'a data atual'}. Se a mensagem for apenas uma pergunta (sem intencao de cadastrar/registrar), responda normalmente, sem bloco de acao.`,
    ].join('\n');
}

function systemAssistente(contexto, conhecimento, tela, hoje) {
    return [
        'Voce e a assistente de IA do sistema Controle de Entrega, uma torre de controle logistica. Responda em portugues do Brasil, de forma direta, operacional e acionavel. Pode manter conversa e lembrar do que foi dito antes nesta conversa.',
        'Use somente os dados agregados e a base de conhecimento fornecidos. Nao invente registros, nomes ou numeros. Quando sugerir uma causa, marque explicitamente como hipotese.',
        'Os numeros agregados cobrem o periodo indicado em "periodo_label"; se o usuario pedir outro intervalo, diga qual periodo voce esta analisando. A secao "cadastros" traz motoristas, ajudantes, placas, rotas e lojas JA cadastrados: consulte-a antes de cadastrar algo novo e avise se o item ja existe (evite duplicar).',
        tela ? `O usuario esta agora na tela: "${tela}". Leve esse contexto em conta ao responder.` : '',
        blocoFerramentas(hoje),
        blocoConsultas(),
        blocoConhecimento(conhecimento),
        `Dados agregados atuais do sistema (JSON):\n${JSON.stringify(contexto)}`,
    ].filter(Boolean).join('\n\n');
}

// ================================================================
// FERRAMENTA DE LEITURA DA IA: buscar_entregas
// ----------------------------------------------------------------
// A IA NUNCA escreve SQL. Ela so escolhe filtros de uma lista fechada; o
// SELECT abaixo e' fixo e 100% parametrizado ($1, $2...). Somente leitura,
// LIMIT fixo e excluida_em IS NULL. Honra a filosofia do sistema "a IA nao
// chuta numero": todo dado vem de uma consulta real, nunca inventado.
// ================================================================
const IA_BUSCA_LIMITE = 50;

// Traduz o "periodo" pedido pela IA em numero de dias-para-tras (a data
// exata "hoje"/"ontem" e' tratada a parte em buscarEntregasIa).
function iaBuscaDias(periodo) {
    const p = iaNorm(periodo);
    if (/trimestre|90/.test(p)) return 89;
    if (/mes|30/.test(p)) return 29;
    if (/quinzena|15/.test(p)) return 14;
    if (/semana|7/.test(p)) return 6;
    const n = parseInt(p, 10);
    return Number.isFinite(n) && n > 0 && n <= 365 ? n - 1 : 6;
}

async function buscarEntregasIa(args = {}) {
    const cond = ['o.excluida_em IS NULL'];
    const params = [];
    const p = (v) => { params.push(v); return `$${params.length}`; };

    const periodo = iaNorm(args.periodo || 'semana');
    if (/ontem/.test(periodo)) cond.push('o.data_ocorrencia = CURRENT_DATE - 1');
    else if (/hoje|agora|^dia$/.test(periodo)) cond.push('o.data_ocorrencia = CURRENT_DATE');
    else cond.push(`o.data_ocorrencia >= CURRENT_DATE - (${p(iaBuscaDias(periodo))}::int)`);

    // Filtros de texto: busca parcial, SEMPRE parametrizada (nada concatenado).
    if (args.motorista) cond.push(`o.motorista ILIKE '%' || ${p(String(args.motorista).slice(0, 80))} || '%'`);
    if (args.loja)      cond.push(`o.loja ILIKE '%' || ${p(String(args.loja).slice(0, 80))} || '%'`);
    if (args.rota)      cond.push(`o.rota ILIKE '%' || ${p(String(args.rota).slice(0, 80))} || '%'`);

    // Flags booleanas de uma lista fechada (a IA nao inventa colunas).
    if (args.apenas_atrasadas === true)      cond.push(`o.sla_status = 'Atrasada'`);
    if (args.apenas_com_ocorrencia === true) cond.push('o.teve_ocorrencia = TRUE');
    if (args.apenas_abertas === true)        cond.push(`o.ocorrencia_status = 'Aberta'`);

    const sql = `
        SELECT to_char(o.data_ocorrencia, 'YYYY-MM-DD')          AS data,
               NULLIF(o.motorista, '')                           AS motorista,
               NULLIF(o.loja, '')                                AS loja,
               NULLIF(o.rota, '')                                AS rota,
               NULLIF(o.sla_status, '')                          AS sla,
               NULLIF(o.otif_status, '')                         AS otif,
               o.teve_ocorrencia                                 AS teve_ocorrencia,
               NULLIF(o.tipo_problema, '')                       AS tipo_problema,
               NULLIF(o.ocorrencia_status, '')                   AS status,
               NULLIF(o.ocorrencia_responsavel, '')              AS responsavel,
               to_char(o.hora_agendada_loja, 'HH24:MI')          AS hora_agendada,
               to_char(o.fim_descarga, 'HH24:MI')                AS saida_loja
        FROM ocorrencias o
        WHERE ${cond.join(' AND ')}
        ORDER BY o.data_ocorrencia DESC, o.id DESC
        LIMIT ${IA_BUSCA_LIMITE}`;

    const r = await db.query(sql, params);
    return r.rows;
}

// Instrucao no system prompt: ensina a IA a PEDIR uma consulta de leitura
// (bloco ```consulta) quando a pergunta exige registros que nao estao nos
// dados agregados. O executor roda no servidor e devolve os dados pra ela.
function blocoConsultas() {
    return [
        'VOCE PODE CONSULTAR OS REGISTROS REAIS DE ENTREGAS quando a pergunta exigir dados que NAO estao no JSON agregado acima (ex.: "mostra as entregas atrasadas de ontem", "o que aconteceu na rota 12 hoje", "entregas do Joao com ocorrencia essa semana").',
        'Nesse caso, responda com UM unico bloco EXATAMENTE neste formato, sem nenhum texto depois dele:',
        '```consulta',
        '{"ferramenta":"buscar_entregas","args":{ ... }}',
        '```',
        'args de buscar_entregas (todos OPCIONAIS; inclua so os que a pergunta pedir):',
        '- periodo: "hoje" | "ontem" | "semana" | "quinzena" | "mes" | "trimestre" | numero de dias',
        '- motorista | loja | rota: texto (busca parcial, nao precisa ser exato)',
        '- apenas_atrasadas: true  (so entregas com SLA Atrasada)',
        '- apenas_com_ocorrencia: true  (so entregas que tiveram ocorrencia)',
        '- apenas_abertas: true  (so ocorrencias com status Aberta)',
        'Eu executo a consulta e te devolvo os dados; ai voce responde ao usuario em portugues, de forma direta. Se os dados agregados que voce JA tem ja respondem, NAO use o bloco de consulta. Nunca invente registros: se precisar de detalhe de entrega, peca a consulta.',
    ].join('\n');
}

// Extrai o bloco ```consulta {json} ``` da resposta da IA (ou null).
function extrairConsultaIa(texto) {
    const m = String(texto || '').match(/```consulta\s*([\s\S]*?)```/i);
    if (!m) return null;
    try {
        const obj = JSON.parse(m[1].trim());
        if (obj && obj.ferramenta === 'buscar_entregas') {
            return { ferramenta: 'buscar_entregas', args: obj.args || {} };
        }
    } catch (_) { /* json malformado -> ignora, trata como texto normal */ }
    return null;
}

// Executa a consulta de leitura pedida pela IA e devolve um envelope com os
// dados (ou { erro }). Ponto unico de despacho — facil somar outras leituras.
async function executarConsultaIa(consulta) {
    if (!consulta || consulta.ferramenta !== 'buscar_entregas') return null;
    try {
        const linhas = await buscarEntregasIa(consulta.args || {});
        return { ferramenta: 'buscar_entregas', total: linhas.length, limite: IA_BUSCA_LIMITE, linhas };
    } catch (err) {
        return { ferramenta: 'buscar_entregas', erro: err.message };
    }
}

// Gemini multi-turno: system_instruction + historico como contents.
// imagens (opcional): [{ mime, dados(base64) }] -> partes inlineData (visao).
async function chamarGeminiChat(system, historico, pergunta, imagens) {
    const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) return null;

    const model = String(process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite').trim();
    const maxTokens = Number(process.env.IA_MAX_OUTPUT_TOKENS || process.env.GEMINI_MAX_OUTPUT_TOKENS || 1200);
    const timeoutMs = Number(process.env.IA_TIMEOUT_MS || 30000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

    const generationConfig = { temperature: 0.4, maxOutputTokens: maxTokens };
    const thinkingRaw = String(process.env.GEMINI_THINKING_BUDGET ?? '0').trim().toLowerCase();
    if (thinkingRaw !== 'off' && thinkingRaw !== '') {
        generationConfig.thinkingConfig = { thinkingBudget: Number(thinkingRaw) || 0 };
    }

    const contents = [];
    for (const m of historico) {
        contents.push({ role: m.papel === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.texto || '') }] });
    }
    const partesFinais = [{ text: pergunta }];
    for (const img of (imagens || [])) {
        partesFinais.push({ inlineData: { mimeType: img.mime || 'image/jpeg', data: img.dados } });
    }
    contents.push({ role: 'user', parts: partesFinais });

    const corpo = JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents,
        generationConfig,
    });

    const transitorios = new Set([403, 429, 500, 502, 503, 504]);
    const tentativas = Math.max(1, Number(process.env.IA_RETRIES || 4));
    let ultimoDetalhe = '';

    for (let i = 0; i < tentativas; i++) {
        let resp;
        try {
            resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
                body: corpo,
                signal: controller.signal,
            });
        } catch (err) {
            clearTimeout(timer);
            if (err.name === 'AbortError') throw new Error(`Gemini nao respondeu em ${Math.round(timeoutMs / 1000)}s.`);
            throw new Error(`Falha ao contatar o Gemini: ${err.message}`);
        }

        const body = await resp.json().catch(() => ({}));

        if (!resp.ok) {
            ultimoDetalhe = body?.error?.message || `HTTP ${resp.status}`;
            if (transitorios.has(resp.status) && i < tentativas - 1) {
                await new Promise((r) => setTimeout(r, 700 * (i + 1)));
                continue;
            }
            clearTimeout(timer);
            throw new Error(`Falha no Gemini: ${ultimoDetalhe}`);
        }

        clearTimeout(timer);
        const cand = (body.candidates || [])[0];
        const texto = (cand?.content?.parts || []).map((p) => p.text || '').join('').trim();
        if (!texto) {
            const motivo = cand?.finishReason;
            if (motivo === 'MAX_TOKENS') throw new Error('Gemini devolveu resposta truncada. Aumente IA_MAX_OUTPUT_TOKENS.');
            if (motivo === 'SAFETY') throw new Error('Gemini bloqueou a resposta por politica de seguranca.');
            throw new Error('Gemini retornou uma resposta vazia.');
        }

        return { modelo: model, texto, id: body.responseId || null };
    }

    clearTimeout(timer);
    throw new Error(`Falha no Gemini apos ${tentativas} tentativas: ${ultimoDetalhe}`);
}

// OpenAI multi-turno (Responses API): system + historico + pergunta (+ imagens).
async function chamarOpenAIChat(system, historico, pergunta, imagens) {
    const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
    if (!apiKey) return null;

    const model = String(process.env.OPENAI_MODEL || process.env.IA_MODEL || 'gpt-5.5').trim();
    const maxTokens = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 1500);
    const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || 30000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const input = [{ role: 'system', content: [{ type: 'input_text', text: system }] }];
    for (const m of historico) {
        const ehIa = m.papel === 'assistant';
        input.push({
            role: ehIa ? 'assistant' : 'user',
            content: [{ type: ehIa ? 'output_text' : 'input_text', text: String(m.texto || '') }],
        });
    }
    const conteudoFinal = [{ type: 'input_text', text: pergunta }];
    for (const img of (imagens || [])) {
        conteudoFinal.push({ type: 'input_image', image_url: `data:${img.mime || 'image/jpeg'};base64,${img.dados}` });
    }
    input.push({ role: 'user', content: conteudoFinal });

    let resp;
    try {
        resp = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                input,
                reasoning: { effort: 'low' },
                text: { verbosity: 'low' },
                max_output_tokens: maxTokens,
                store: false,
            }),
            signal: controller.signal,
        });
    } catch (err) {
        if (err.name === 'AbortError') throw new Error(`OpenAI nao respondeu em ${Math.round(timeoutMs / 1000)}s.`);
        throw new Error(`Falha ao contatar a OpenAI: ${err.message}`);
    } finally {
        clearTimeout(timer);
    }

    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        const detalhe = body?.error?.message || `HTTP ${resp.status}`;
        throw new Error(`Falha na OpenAI: ${detalhe}`);
    }

    const texto = extrairTextoOpenAI(body);
    if (!texto) {
        if (body?.status === 'incomplete') {
            const motivo = body?.incomplete_details?.reason || 'resposta truncada';
            throw new Error(`OpenAI devolveu resposta incompleta (${motivo}). Aumente OPENAI_MAX_OUTPUT_TOKENS.`);
        }
        throw new Error('OpenAI retornou uma resposta vazia.');
    }

    return { modelo: model, texto, id: body.id || null };
}

// Anthropic multi-turno (Messages API): system + historico + pergunta (+ imagens).
// imagens (opcional): [{ mime, dados(base64) }] -> blocks type image (visao).
async function chamarAnthropicChat(system, historico, pergunta, imagens) {
    const apiKey = String(process.env.ANTHROPIC_API_KEY || '').trim();
    if (!apiKey) return null;

    const model = String(process.env.ANTHROPIC_MODEL || process.env.IA_MODEL || 'claude-opus-4-8').trim();
    const maxTokens = Number(process.env.ANTHROPIC_MAX_OUTPUT_TOKENS || process.env.IA_MAX_OUTPUT_TOKENS || 1500);
    const timeoutMs = Number(process.env.IA_TIMEOUT_MS || 30000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const messages = [];
    for (const m of historico) {
        messages.push({ role: m.papel === 'assistant' ? 'assistant' : 'user', content: String(m.texto || '') });
    }
    const conteudoFinal = [{ type: 'text', text: pergunta }];
    for (const img of (imagens || [])) {
        conteudoFinal.push({ type: 'image', source: { type: 'base64', media_type: img.mime || 'image/jpeg', data: img.dados } });
    }
    messages.push({ role: 'user', content: conteudoFinal });

    const corpo = JSON.stringify({ model, max_tokens: maxTokens, system, messages });

    const transitorios = new Set([429, 500, 502, 503, 529]);
    const tentativas = Math.max(1, Number(process.env.IA_RETRIES || 4));
    let ultimoDetalhe = '';

    for (let i = 0; i < tentativas; i++) {
        let resp;
        try {
            resp = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json',
                },
                body: corpo,
                signal: controller.signal,
            });
        } catch (err) {
            clearTimeout(timer);
            if (err.name === 'AbortError') throw new Error(`Anthropic nao respondeu em ${Math.round(timeoutMs / 1000)}s.`);
            throw new Error(`Falha ao contatar a Anthropic: ${err.message}`);
        }

        const body = await resp.json().catch(() => ({}));

        if (!resp.ok) {
            ultimoDetalhe = body?.error?.message || `HTTP ${resp.status}`;
            if (transitorios.has(resp.status) && i < tentativas - 1) {
                await new Promise((r) => setTimeout(r, 700 * (i + 1)));
                continue;
            }
            clearTimeout(timer);
            throw new Error(`Falha na Anthropic: ${ultimoDetalhe}`);
        }

        clearTimeout(timer);
        const texto = extrairTextoAnthropic(body);
        if (!texto) {
            if (body?.stop_reason === 'max_tokens') throw new Error('Claude devolveu resposta truncada. Aumente ANTHROPIC_MAX_OUTPUT_TOKENS.');
            if (body?.stop_reason === 'refusal') throw new Error('Claude recusou a resposta por politica de seguranca.');
            throw new Error('Claude retornou uma resposta vazia.');
        }
        return { modelo: model, texto, id: body.id || null };
    }

    clearTimeout(timer);
    throw new Error(`Falha na Anthropic apos ${tentativas} tentativas: ${ultimoDetalhe}`);
}

async function chamarIaChat(system, historico, pergunta, imagens) {
    return chamarComFallback((prov) =>
        prov === 'anthropic' ? chamarAnthropicChat(system, historico, pergunta, imagens)
        : prov === 'gemini' ? chamarGeminiChat(system, historico, pergunta, imagens)
        : prov === 'openai' ? chamarOpenAIChat(system, historico, pergunta, imagens)
        : null);
}

// Detecta o periodo a partir do texto da pergunta ("no mes", "hoje", "90 dias").
// Retorna null se nada casar (o chamador cai pro padrao 'semana').
function detectarPeriodoDaPergunta(texto) {
    const q = String(texto || '').toLowerCase();
    if (/(trimestre|90 dias|noventa dias|3 meses|tres meses|3 ultimos meses)/.test(q)) return 'trimestre';
    if (/(no mes|do mes|mensal|30 dias|trinta dias|ultimo mes|mes passado|neste mes|este mes|mês)/.test(q)) return 'mes';
    if (/(hoje|agora|do dia|neste momento)/.test(q)) return 'hoje';
    if (/(semana|7 dias|sete dias|semanal)/.test(q)) return 'semana';
    return null;
}

// Fontes ADICIONAIS que so o assistente conversacional usa (nao pesam o painel
// analitico): listas de cadastro + registros de atraso de saida e de rota.
// Tudo agregado e com casts defensivos; iaConsulta absorve erros de tipo.
async function extrasAssistente(periodoParam) {
    const periodo = iaPeriodo(periodoParam);
    const params = [periodo.dias];
    const erros = [];
    const filtroData = `NULLIF(data::text, '')::date >= CURRENT_DATE - ($1::int * INTERVAL '1 day')`;

    const cadastros = await iaConsulta(erros, 'cadastros', async () => {
        const r = await db.query(`SELECT tipo, valor FROM cadastros WHERE oculto = FALSE ORDER BY tipo, valor`);
        const mapa = {};
        for (const row of r.rows) (mapa[row.tipo] ||= []).push(row.valor);
        const saida = {};
        for (const tipo of Object.keys(mapa)) {
            saida[tipo] = { total: mapa[tipo].length, valores: mapa[tipo].slice(0, 80) };
        }
        return saida;
    }, {});

    const atrasoSaida = await iaConsulta(erros, 'atraso_saida_registros', async () => {
        const r = await db.query(`
            SELECT
                COALESCE(NULLIF(motorista, ''), '(sem motorista)') AS motorista,
                COUNT(*)::int AS registros,
                COUNT(*) FILTER (WHERE COALESCE(NULLIF(atraso_min::text, '')::numeric, 0) > 0)::int AS atrasadas,
                COALESCE(ROUND(AVG(NULLIF(NULLIF(atraso_min::text, '')::numeric, 0)))::int, 0) AS media_min,
                COALESCE(MAX(NULLIF(atraso_min::text, '')::numeric), 0)::int AS maior_min
            FROM atrasos_saida
            WHERE ${filtroData}
            GROUP BY 1
            ORDER BY atrasadas DESC, media_min DESC
            LIMIT 8
        `, params);
        return r.rows;
    }, []);

    const rotas = await iaConsulta(erros, 'rotas_registradas', async () => {
        const r = await db.query(`
            SELECT
                COUNT(*)::int AS registros,
                COUNT(*) FILTER (WHERE COALESCE(NULLIF(minutos_excedentes::text, '')::numeric, 0) > 0)::int AS com_excedente,
                COALESCE(SUM(NULLIF(minutos_excedentes::text, '')::numeric), 0)::int AS total_excedente_min,
                COALESCE(ROUND(AVG(NULLIF(NULLIF(total_min::text, '')::numeric, 0)))::int, 0) AS media_total_min
            FROM rotas_registradas
            WHERE ${filtroData}
        `, params);
        return r.rows[0] || { registros: 0, com_excedente: 0, total_excedente_min: 0, media_total_min: 0 };
    }, { registros: 0, com_excedente: 0, total_excedente_min: 0, media_total_min: 0 });

    return { cadastros, atraso_saida_registros: atrasoSaida, rotas_registradas: rotas, erros };
}

// Historico do chat com a IA (do proprio usuario).
app.get('/ia/chat/historico', async (req, res) => {
    try {
        const me = req.usuarioLogado.id;
        const r = await db.query(
            `SELECT id, papel, texto, tela, criado_em FROM ia_chat_mensagens
             WHERE usuario_id = $1 ORDER BY id DESC LIMIT 80`,
            [me]
        );
        res.status(200).json(r.rows.reverse());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Limpa o historico do chat com a IA (do proprio usuario).
app.post('/ia/chat/limpar', async (req, res) => {
    try {
        await db.query('DELETE FROM ia_chat_mensagens WHERE usuario_id = $1', [req.usuarioLogado.id]);
        res.status(200).json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Processa os anexos recebidos: separa texto (vira contexto) de imagens (visao).
// Limita tamanho total pra nao estourar o contexto do modelo nem o corpo HTTP.
function processarAnexosIa(bruto) {
    const lista = Array.isArray(bruto) ? bruto.slice(0, 8) : [];
    const MAX_TEXTO = 30000; // chars somados de todos os arquivos de texto
    const MAX_IMAGENS = 4;
    const MAX_IMG_CHARS = 4 * 1024 * 1024; // ~4MB de base64 por imagem
    let blocoTexto = '';
    let totalTexto = 0;
    const imagens = [];
    const nomes = [];

    for (const a of lista) {
        const nome = String(a?.nome || 'arquivo').slice(0, 120);
        if (a?.tipo === 'imagem' && a?.dados) {
            const dados = String(a.dados);
            if (imagens.length >= MAX_IMAGENS || dados.length > MAX_IMG_CHARS) continue;
            imagens.push({ mime: String(a.mime || 'image/jpeg').slice(0, 40), dados });
            nomes.push(nome);
        } else if (a?.conteudo) {
            if (totalTexto >= MAX_TEXTO) continue;
            let conteudo = String(a.conteudo);
            const restante = MAX_TEXTO - totalTexto;
            if (conteudo.length > restante) conteudo = conteudo.slice(0, restante) + '\n...[conteudo truncado]';
            totalTexto += conteudo.length;
            blocoTexto += `\n\n--- Arquivo: ${nome} ---\n${conteudo}`;
            nomes.push(nome);
        }
    }
    return { blocoTexto, imagens, nomes };
}

// Envia uma mensagem para a IA. body: { pergunta, tela?, periodo?, hoje?, anexos? }
app.post('/ia/chat', async (req, res) => {
    try {
        const me = req.usuarioLogado;
        let pergunta = String(req.body?.pergunta || '').trim();
        if (pergunta.length > 2000) return res.status(400).json({ error: 'Mensagem muito longa (max 2000).' });
        const { blocoTexto, imagens, nomes } = processarAnexosIa(req.body?.anexos);
        if (!pergunta && !nomes.length) return res.status(400).json({ error: 'Escreva uma mensagem ou anexe um arquivo.' });
        if (!pergunta) pergunta = 'Analise o(s) arquivo(s) anexado(s) e me diga o que for relevante.';
        const tela = String(req.body?.tela || '').trim().slice(0, 120) || null;
        // Periodo: 1) o que o usuario fixou no seletor; 2) detectado no texto; 3) semana.
        const periodo = String(req.body?.periodo || '').trim()
            || detectarPeriodoDaPergunta(pergunta)
            || 'semana';
        // Data "de hoje" do cliente (respeita o fuso do usuario); cai pra data local do servidor.
        const hoje = String(req.body?.hoje || '').trim().match(/^\d{4}-\d{2}-\d{2}$/)
            ? req.body.hoje
            : new Date().toLocaleDateString('en-CA');

        // Historico ANTES de gravar a nova pergunta (ultimos turnos = memoria curta).
        const histRows = await db.query(
            `SELECT papel, texto FROM ia_chat_mensagens WHERE usuario_id = $1 ORDER BY id DESC LIMIT 12`,
            [me.id]
        );
        const historico = histRows.rows.reverse();

        const contexto = await montarContextoAnalitico(periodo);
        // Anexa as fontes extras (cadastros + atraso de saida + rotas registradas).
        const extras = await extrasAssistente(periodo);
        contexto.cadastros = extras.cadastros;
        contexto.atraso_saida_registros = extras.atraso_saida_registros;
        contexto.rotas_registradas = extras.rotas_registradas;
        if (extras.erros?.length) contexto.erros = [...(contexto.erros || []), ...extras.erros];
        const conhecimento = await carregarConhecimentoIa();
        const system = systemAssistente(contexto, conhecimento, tela, hoje);
        const provider = iaProviderAtivo();

        // Pergunta enviada ao modelo: pergunta do usuario + conteudo dos arquivos de texto.
        const perguntaIa = blocoTexto
            ? `${pergunta}\n\nConteudo dos arquivos anexados (use como fonte e cite o arquivo quando relevante):${blocoTexto}`
            : pergunta;

        let resposta;
        let origem;
        let modelo = null;
        let iaErro = null;

        if (!provider) {
            // Modo local e primario (IA propria de regras) — sem nota de "Gemini".
            const locais = gerarInsightsLocais(contexto);
            const aviso = nomes.length ? 'No modo local (sem LLM) não interpreto arquivos/imagens, mas respondo com os dados do sistema.\n\n' : '';
            resposta = respostaLocalPergunta(pergunta, contexto, locais, aviso || null, conhecimento, true);
            origem = 'local';
        } else {
            try {
                const ia = await chamarIaChat(system, historico, perguntaIa, imagens);
                resposta = ia.texto;
                origem = ia.provider || provider;
                modelo = ia.modelo;
            } catch (err) {
                console.error(`[POST /ia/chat] ${provider}:`, err.message);
                const locais = gerarInsightsLocais(contexto);
                resposta = respostaLocalPergunta(pergunta, contexto, locais, iaErroAmigavel(err.message), conhecimento, true);
                origem = 'local';
                iaErro = err.message;
            }
        }

        // TOOL-LOOP DE LEITURA: se a IA pediu uma consulta (```consulta), executa
        // no servidor e devolve os dados pra ela responder de fato. Sem card de
        // confirmacao (leitura nao muda dado). No maximo 2 rodadas e so no modo
        // LLM — o modo local nunca emite bloco de consulta.
        if (provider && origem !== 'local') {
            const histLoop = [...historico, { papel: 'user', texto: perguntaIa }];
            let consulta = extrairConsultaIa(resposta);
            let voltas = 0;
            while (consulta && voltas < 2) {
                voltas += 1;
                const dados = await executarConsultaIa(consulta);
                histLoop.push({ papel: 'assistant', texto: resposta });
                const feedback = [
                    `Resultado da consulta ${consulta.ferramenta} (JSON abaixo). Responda ao usuario em portugues, de forma direta, usando SOMENTE estes dados.`,
                    'Se "linhas" vier vazio, diga que nao encontrei registros nesse filtro/periodo. Se "total" bater no "limite", avise que mostrei so os mais recentes.',
                    'NAO gere outro bloco de consulta, a menos que precise de um filtro diferente.',
                    JSON.stringify(dados),
                ].join('\n\n');
                try {
                    const ia2 = await chamarIaChat(system, histLoop, feedback, []);
                    resposta = ia2.texto;
                    origem = ia2.provider || origem;
                    modelo = ia2.modelo;
                } catch (err) {
                    console.error('[POST /ia/chat] tool-loop:', err.message);
                    resposta = 'Consegui buscar os registros, mas falhei ao redigir a resposta final. Tente perguntar de novo.';
                    break;
                }
                consulta = extrairConsultaIa(resposta);
            }
            // Remove qualquer bloco ```consulta residual antes de exibir/salvar.
            resposta = resposta.replace(/```consulta[\s\S]*?```/gi, '').trim();
        }

        // No historico guarda so a pergunta + nota dos anexos (nao o conteudo bruto).
        const textoUser = nomes.length ? `${pergunta} [anexos: ${nomes.slice(0, 6).join(', ')}]` : pergunta;

        // Persiste os dois turnos (pergunta do usuario + resposta da IA).
        await db.query(
            'INSERT INTO ia_chat_mensagens (usuario_id, papel, texto, tela) VALUES ($1, $2, $3, $4)',
            [me.id, 'user', textoUser, tela]
        );
        await db.query(
            'INSERT INTO ia_chat_mensagens (usuario_id, papel, texto, tela) VALUES ($1, $2, $3, $4)',
            [me.id, 'assistant', resposta, tela]
        );

        res.status(200).json({ resposta, origem, modelo, ia_erro: iaErro });
    } catch (err) {
        console.error('[POST /ia/chat]', err);
        res.status(500).json({ error: 'Erro ao consultar o assistente de IA.', detalhe: err.message });
    }
});

// ---- Base de conhecimento da IA (CRUD) ----
app.get('/ia/conhecimento', async (req, res) => {
    try {
        const r = await db.query(
            `SELECT id, titulo, conteudo, tags, criado_por, ativo, criado_em, atualizado_em
             FROM ia_conhecimento ORDER BY atualizado_em DESC`
        );
        res.status(200).json(r.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/ia/conhecimento', async (req, res) => {
    try {
        const conteudo = String(req.body?.conteudo || '').trim();
        if (!conteudo) return res.status(400).json({ error: 'Informe o que a IA deve aprender.' });
        if (conteudo.length > 4000) return res.status(400).json({ error: 'Conteudo muito longo (max 4000).' });
        const titulo = String(req.body?.titulo || '').trim() || conteudo.slice(0, 60);
        const tags = String(req.body?.tags || '').trim() || null;

        // Se vier id, atualiza a entrada existente; senao, insere nova.
        const id = Number(req.body?.id);
        if (Number.isInteger(id) && id > 0) {
            const r = await db.query(
                `UPDATE ia_conhecimento SET titulo = $1, conteudo = $2, tags = $3, atualizado_em = NOW()
                 WHERE id = $4 RETURNING *`,
                [titulo, conteudo, tags, id]
            );
            if (!r.rowCount) return res.status(404).json({ error: 'Conhecimento nao encontrado.' });
            return res.status(200).json(r.rows[0]);
        }

        const r = await db.query(
            `INSERT INTO ia_conhecimento (titulo, conteudo, tags, criado_por)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [titulo, conteudo, tags, req.usuarioLogado?.nome || null]
        );
        res.status(201).json(r.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/ia/conhecimento/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'ID invalido.' });
        await db.query('DELETE FROM ia_conhecimento WHERE id = $1', [id]);
        res.status(200).json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function normalizarDocaPayload(body = {}) {
    return {
        filial: vazioParaNull(body.filial),
        loja: vazioParaNull(body.loja),
        supervisor: vazioParaNull(body.supervisor),
        carrinho_4_rodas: vazioParaNull(body.carrinho_4_rodas),
        carrinho_2_rodas: vazioParaNull(body.carrinho_2_rodas),
        sem_carrinho_apos_horario: vazioParaNull(body.sem_carrinho_apos_horario),
        horario: vazioParaNull(body.horario),
        autorizacao_previa: vazioParaNull(body.autorizacao_previa),
        observacao: vazioParaNull(body.observacao)
    };
}

app.get('/docas', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT *
            FROM docas
            ORDER BY filial NULLS LAST, loja NULLS LAST, id DESC
        `);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('Erro ao buscar docas:', err);
        res.status(500).json({ error: 'Erro ao buscar horarios das docas.', detalhe: err.message });
    }
});

app.post('/docas', async (req, res) => {
    try {
        const dados = normalizarDocaPayload(req.body);
        if (!dados.filial || !dados.loja) {
            return res.status(400).json({ error: 'Filial e loja sao obrigatorias.' });
        }

        const result = await db.query(`
            INSERT INTO docas (
                filial, loja, supervisor, carrinho_4_rodas, carrinho_2_rodas,
                sem_carrinho_apos_horario, horario, autorizacao_previa, observacao
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *
        `, [
            dados.filial,
            dados.loja,
            dados.supervisor,
            dados.carrinho_4_rodas,
            dados.carrinho_2_rodas,
            dados.sem_carrinho_apos_horario,
            dados.horario,
            dados.autorizacao_previa,
            dados.observacao
        ]);

        await registrarAuditoria(req, 'POST', 'docas', result.rows[0].id, dados);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Erro ao salvar doca:', err);
        res.status(500).json({ error: 'Erro ao salvar horario da doca.', detalhe: err.message });
    }
});

app.put('/docas/:id', async (req, res) => {
    try {
        const dados = normalizarDocaPayload(req.body);
        if (!dados.filial || !dados.loja) {
            return res.status(400).json({ error: 'Filial e loja sao obrigatorias.' });
        }

        const result = await db.query(`
            UPDATE docas
            SET filial = $1,
                loja = $2,
                supervisor = $3,
                carrinho_4_rodas = $4,
                carrinho_2_rodas = $5,
                sem_carrinho_apos_horario = $6,
                horario = $7,
                autorizacao_previa = $8,
                observacao = $9,
                atualizado_em = NOW()
            WHERE id = $10
            RETURNING *
        `, [
            dados.filial,
            dados.loja,
            dados.supervisor,
            dados.carrinho_4_rodas,
            dados.carrinho_2_rodas,
            dados.sem_carrinho_apos_horario,
            dados.horario,
            dados.autorizacao_previa,
            dados.observacao,
            req.params.id
        ]);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Horario de doca nao encontrado.' });
        }

        await registrarAuditoria(req, 'PUT', 'docas', req.params.id, dados);
        res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error('Erro ao atualizar doca:', err);
        res.status(500).json({ error: 'Erro ao atualizar horario da doca.', detalhe: err.message });
    }
});

app.delete('/docas/:id', async (req, res) => {
    try {
        const result = await db.query('DELETE FROM docas WHERE id = $1 RETURNING *', [req.params.id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Horario de doca nao encontrado.' });
        }

        await registrarAuditoria(req, 'DELETE', 'docas', req.params.id, result.rows[0]);
        res.status(200).json({ message: 'Horario de doca excluido.', deleted: result.rows[0] });
    } catch (err) {
        console.error('Erro ao excluir doca:', err);
        res.status(500).json({ error: 'Erro ao excluir horario da doca.', detalhe: err.message });
    }
});

// ============================================================
// OCORRENCIAS OPERACIONAIS ("erros de loja" importados de CSV)
// Tabela analitica/independente: nao mexe nos graficos de `ocorrencias`.
// ============================================================
function ooTxt(v) {
    const t = v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim();
    return t === '' ? null : t;
}
function ooInt(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
}
function ooNum(v) {
    if (v === null || v === undefined || v === '') return null;
    // aceita "45,0" / "1.234,5" / "45.0"
    let s = String(v).trim();
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    s = s.replace(/[^\d.-]/g, '');
    const n = Number(s);
    return Number.isFinite(n) && s !== '' ? n : null;
}
function ooChave(item) {
    const idExt = ooInt(item.id_externo);
    if (idExt !== null) return 'id:' + idExt;
    const base = [item.data_ocorrencia, item.loja, item.motorista, item.observacao]
        .map((x) => ooTxt(x) || '')
        .join('|');
    return 'h:' + crypto.createHash('sha1').update(base).digest('hex');
}

const OO_COLUNAS = [
    'id_externo', 'chave_dedupe', 'data_registro', 'data_ocorrencia', 'mes_ano',
    'semana', 'dias_ate_registro', 'responsavel', 'area', 'tipo', 'macro_falha',
    'ishikawa', 'motorista', 'ajudantes', 'ajudantes2', 'colaborador', 'rota',
    'loja', 'fornecedor', 'tempo_atraso', 'impacto', 'divergencia', 'retrabalho',
    'observacao', 'classificacao_erro', 'gravidade', 'atraso_estimado_min', 'origem_erro',
];

app.post('/ocorrencias-operacionais/importar', autenticar, somenteAdm, async (req, res) => {
    const itens = Array.isArray(req.body?.itens) ? req.body.itens : [];
    if (itens.length === 0) {
        return res.status(400).json({ error: 'Nenhuma linha para importar.' });
    }

    const params = OO_COLUNAS.map((_, i) => `$${i + 1}`).join(', ');
    const updates = OO_COLUNAS
        .filter((c) => c !== 'chave_dedupe')
        .map((c) => `${c} = EXCLUDED.${c}`)
        .join(', ');
    const sql = `
        INSERT INTO ocorrencias_operacionais (${OO_COLUNAS.join(', ')})
        VALUES (${params})
        ON CONFLICT (chave_dedupe) DO UPDATE SET ${updates}, atualizado_em = NOW()
        RETURNING (xmax = 0) AS inserido
    `;

    const client = await db.connect();
    let inseridos = 0;
    let atualizados = 0;
    let ignorados = 0;
    try {
        await client.query('BEGIN');
        for (const it of itens) {
            const item = it || {};
            const valores = {
                id_externo: ooInt(item.id_externo),
                chave_dedupe: ooChave(item),
                data_registro: ooTxt(item.data_registro),
                data_ocorrencia: ooTxt(item.data_ocorrencia),
                mes_ano: ooTxt(item.mes_ano),
                semana: ooInt(item.semana),
                dias_ate_registro: ooInt(item.dias_ate_registro),
                responsavel: ooTxt(item.responsavel),
                area: ooTxt(item.area),
                tipo: ooTxt(item.tipo),
                macro_falha: ooTxt(item.macro_falha),
                ishikawa: ooTxt(item.ishikawa),
                motorista: ooTxt(item.motorista),
                ajudantes: ooTxt(item.ajudantes),
                ajudantes2: ooTxt(item.ajudantes2),
                colaborador: ooTxt(item.colaborador),
                rota: ooTxt(item.rota),
                loja: ooTxt(item.loja),
                fornecedor: ooTxt(item.fornecedor),
                tempo_atraso: ooTxt(item.tempo_atraso),
                impacto: ooTxt(item.impacto),
                divergencia: ooTxt(item.divergencia),
                retrabalho: ooTxt(item.retrabalho),
                observacao: ooTxt(item.observacao),
                classificacao_erro: ooTxt(item.classificacao_erro),
                gravidade: ooTxt(item.gravidade),
                atraso_estimado_min: ooNum(item.atraso_estimado_min),
                origem_erro: ooTxt(item.origem_erro),
            };

            // pula linha sem nenhum conteudo util
            const temConteudo =
                valores.id_externo !== null || valores.observacao || valores.loja ||
                valores.tipo || valores.data_ocorrencia || valores.motorista;
            if (!temConteudo) {
                ignorados += 1;
                continue;
            }

            const r = await client.query(sql, OO_COLUNAS.map((c) => valores[c]));
            if (r.rows[0] && r.rows[0].inserido) inseridos += 1;
            else atualizados += 1;
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
        return res.status(500).json({ error: 'Falha ao importar.', detalhe: err.message });
    }
    client.release();

    await registrarAuditoria(req, 'IMPORT_CSV', 'ocorrencias_operacionais', null, {
        inseridos, atualizados, ignorados, total: itens.length,
    });
    res.status(200).json({ inseridos, atualizados, ignorados, total: itens.length });
});

app.get('/ocorrencias-operacionais', autenticar, async (req, res) => {
    try {
        const where = [];
        const params = [];
        const push = (val) => {
            params.push(val);
            return `$${params.length}`;
        };
        if (req.query.mes_ano) where.push(`mes_ano = ${push(req.query.mes_ano)}`);
        if (req.query.area) where.push(`area = ${push(req.query.area)}`);
        if (req.query.gravidade) where.push(`gravidade = ${push(req.query.gravidade)}`);
        if (req.query.origem) where.push(`origem_erro = ${push(req.query.origem)}`);
        if (req.query.inicio) where.push(`data_ocorrencia >= ${push(req.query.inicio)}`);
        if (req.query.fim) where.push(`data_ocorrencia <= ${push(req.query.fim)}`);
        if (req.query.q) {
            const p = push(`%${String(req.query.q).toLowerCase()}%`);
            where.push(`(
                LOWER(COALESCE(observacao,'')) LIKE ${p} OR
                LOWER(COALESCE(loja,'')) LIKE ${p} OR
                LOWER(COALESCE(motorista,'')) LIKE ${p} OR
                LOWER(COALESCE(tipo,'')) LIKE ${p} OR
                LOWER(COALESCE(rota,'')) LIKE ${p}
            )`);
        }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const limite = Math.min(parseInt(req.query.limite) || 2000, 10000);

        const result = await db.query(
            `SELECT *,
                    TO_CHAR(data_ocorrencia, 'YYYY-MM-DD') AS data_ocorrencia_fmt,
                    TO_CHAR(data_registro, 'YYYY-MM-DD HH24:MI') AS data_registro_fmt
             FROM ocorrencias_operacionais ${whereSql}
             ORDER BY data_ocorrencia DESC NULLS LAST, id_externo DESC NULLS LAST, id DESC
             LIMIT ${limite}`,
            params
        );
        const totalResult = await db.query(
            `SELECT COUNT(*)::int AS total FROM ocorrencias_operacionais ${whereSql}`,
            params
        );
        res.status(200).json({ total: totalResult.rows[0].total, registros: result.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/ocorrencias-operacionais', autenticar, somenteAdm, async (req, res) => {
    try {
        const r = await db.query('DELETE FROM ocorrencias_operacionais RETURNING id');
        await registrarAuditoria(req, 'DELETE_ALL', 'ocorrencias_operacionais', null, { removidos: r.rowCount });
        res.status(200).json({ removidos: r.rowCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/ocorrencias-operacionais/:id', autenticar, somenteAdm, async (req, res) => {
    try {
        const r = await db.query('DELETE FROM ocorrencias_operacionais WHERE id = $1 RETURNING *', [req.params.id]);
        if (r.rowCount === 0) return res.status(404).json({ error: 'Registro nao encontrado.' });
        await registrarAuditoria(req, 'DELETE', 'ocorrencias_operacionais', req.params.id, null);
        res.status(200).json({ removido: r.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Colunas da listagem de ocorrencias, SEM a coluna de fotos (pesada, ver o
// comentario dentro do GET). Descoberto do schema uma vez e guardado: coluna
// criada depois entra sozinha no proximo boot, sem ninguem lembrar de editar
// uma lista aqui.
let _colunasListagem = null;
async function colunasDaListagem() {
    if (_colunasListagem) return _colunasListagem;
    const r = await db.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'ocorrencias'
          ORDER BY ordinal_position`
    );
    const fora = new Set(['ocorrencia_fotos']);
    const nomes = r.rows
        .map((x) => x.column_name)
        .filter((n) => !fora.has(n));
    if (!nomes.length) throw new Error('Nao foi possivel ler as colunas de ocorrencias.');
    _colunasListagem = nomes.map((n) => `o."${n}"`).join(', ');
    return _colunasListagem;
}

app.get('/ocorrencias', async (req, res) => {
    try {
        const limite = req.query.limite ? Math.min(parseInt(req.query.limite) || 500, 2000) : null;
        const pagina = Math.max(parseInt(req.query.pagina) || 1, 1);

        // A COLUNA DE FOTOS NAO SAI DAQUI — de proposito.
        //
        // O front (script-1-core.js) chama /ocorrencias SEM limite e guarda a
        // base inteira em memoria para filtrar. As fotos sao data-URIs em
        // base64: se viessem junto, abrir a tela baixaria todas as fotos de
        // todas as ocorrencias ja registradas. Com poucos meses de uso isso
        // vira dezenas de MB por carregamento — e, uma vez que o habito de
        // trafegar isso se instala, e caro voltar atras.
        //
        // A lista de colunas e descoberta do proprio schema (e cacheada), em
        // vez de escrita a mao: sao ~84 colunas e coluna nova entra sozinha.
        //
        // NAO usar `to_jsonb(o) - 'ocorrencia_fotos'` aqui, embora seja mais
        // curto: to_jsonb muda os TIPOS do JSON. Com SELECT normal o driver
        // devolve timestamp como Date e numeric como string; com to_jsonb
        // viram string ISO sem timezone e numero. Isso mudaria como o front
        // inteiro le data e valor — risco grande para ganho nenhum.
        //
        // No lugar do conteudo vai so a CONTAGEM, que e o que o card precisa
        // para escrever "3 fotos"; o conteudo vem sob demanda por
        // GET /ocorrencias/:id/fotos.
        //
        // O left(btrim(...)) = '[' evita que um valor legado que nao seja JSON
        // derrube a listagem inteira no cast para jsonb.
        const colunas = await colunasDaListagem();
        const SELECT_REGISTRO = `
            SELECT ${colunas},
                   CASE WHEN left(btrim(coalesce(o.ocorrencia_fotos, '')), 1) = '['
                        THEN jsonb_array_length(o.ocorrencia_fotos::jsonb)
                        ELSE 0 END AS fotos_qtd
            FROM ocorrencias o
            WHERE o.excluida_em IS NULL
            ORDER BY o.id DESC`;

        let rows;
        if (limite) {
            const offset = (pagina - 1) * limite;
            const countResult = await db.query('SELECT COUNT(*)::int AS total FROM ocorrencias WHERE excluida_em IS NULL');
            const result = await db.query(
                `${SELECT_REGISTRO} LIMIT $1 OFFSET $2`,
                [limite, offset]
            );
            res.setHeader('X-Total-Count', countResult.rows[0].total);
            rows = result.rows;
        } else {
            const result = await db.query(SELECT_REGISTRO);
            rows = result.rows;
        }

        res.status(200).json(rows);
    } catch (err) {
        console.error('Erro ao buscar ocorrências:', err);

        res.status(500).json({
            error: 'Erro ao buscar ocorrências no banco de dados.',
            detalhe: err.message
        });
    }
});

// ================= GET — BUSCAR OCORRÊNCIA POR ID =================
app.get('/ocorrencias/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const result = await db.query(`
            SELECT *
            FROM ocorrencias
            WHERE id = $1
        `, [id]);

        if (result.rowCount === 0) {
            return res.status(404).json({
                error: 'Ocorrência não encontrada.'
            });
        }

        res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error('Erro ao buscar ocorrência por ID:', err);

        res.status(500).json({
            error: 'Erro ao buscar ocorrência no banco de dados.',
            detalhe: err.message
        });
    }
});

// ================= POST — CRIAR NOVA OCORRÊNCIA =================
// Mapa loja -> rota (do cadastro extra.rota), cacheado. A ocorrencia nao tem
// campo de rota no form: derivamos da LOJA (fonte canonica; as 93 lojas tem
// rota no cadastro) pra rota nunca ficar em branco e os KPIs por rota valerem.
const _rotaLojaMapa = new Map();
let _rotaLojaEm = 0;
async function rotaDaLoja(loja) {
    const chave = String(loja || '').trim().toUpperCase();
    if (!chave) return null;
    if (Date.now() - _rotaLojaEm > 60000) {
        try {
            const r = await db.query(`
                SELECT UPPER(TRIM(valor)) AS loja, NULLIF(TRIM(extra->>'rota'),'') AS rota
                FROM cadastros WHERE tipo = 'loja' AND NULLIF(TRIM(extra->>'rota'),'') IS NOT NULL`);
            _rotaLojaMapa.clear();
            for (const row of r.rows) _rotaLojaMapa.set(row.loja, row.rota);
            _rotaLojaEm = Date.now();
        } catch (_) { /* mantem o cache anterior */ }
    }
    return _rotaLojaMapa.get(chave) || null;
}

// Backfill: preenche a rota (pela loja) das ocorrencias que ficaram sem — so
// vazias, nunca sobrescreve. Corrige o historico de uma vez. ADM (middleware).
app.post('/ocorrencias/derivar-rotas', async (req, res) => {
    try {
        const r = await db.query(`
            UPDATE ocorrencias o SET rota = c.rota
            FROM (
                SELECT UPPER(TRIM(valor)) AS loja, NULLIF(TRIM(extra->>'rota'),'') AS rota
                FROM cadastros WHERE tipo = 'loja' AND NULLIF(TRIM(extra->>'rota'),'') IS NOT NULL
            ) c
            WHERE UPPER(TRIM(o.loja)) = c.loja AND o.excluida_em IS NULL
              AND NULLIF(TRIM(o.rota),'') IS NULL
        `);
        try { qualidadeCache.clear(); custoCache.clear(); } catch (_) {}
        await registrarAuditoria(req, 'DERIVAR_ROTAS', 'ocorrencias', null, { atualizadas: r.rowCount });
        res.status(200).json({ ok: true, atualizadas: r.rowCount });
    } catch (err) {
        console.error('[POST /ocorrencias/derivar-rotas]', err);
        res.status(500).json({ error: 'Falha ao derivar rotas.' });
    }
});

// ================================================================
// JUNTAR ROTAS  (GET /rotas/uso, POST /rotas/mesclar)
// ----------------------------------------------------------------
// Unifica grafias diferentes da MESMA rota (ex.: "ZONA NORTE 1" -> "Z.NORTE I")
// pra os KPIs por rota nao ficarem em baldes duplicados. GET lista as rotas em
// uso + contagem; POST mescla um conjunto de grafias num destino. So ADM.
// ================================================================
app.get('/rotas/uso', async (req, res) => {
    try {
        const r = await db.query(`
            SELECT TRIM(rota) AS rota, COUNT(*)::int AS n
            FROM ocorrencias
            WHERE excluida_em IS NULL AND NULLIF(TRIM(rota),'') IS NOT NULL
            GROUP BY 1 ORDER BY 2 DESC, 1`);
        res.status(200).json({ rotas: r.rows });
    } catch (err) {
        console.error('[GET /rotas/uso]', err);
        res.status(500).json({ error: 'Falha ao listar rotas em uso.' });
    }
});

app.post('/rotas/mesclar', async (req, res) => {
    const body = req.body || {};
    const para = String(body.para || '').trim();
    const de = Array.isArray(body.de) ? body.de.map((x) => String(x || '').trim()).filter(Boolean) : [];
    if (!para) return res.status(400).json({ error: 'Informe a rota de destino (para).' });
    const origens = de.filter((d) => d !== para);
    if (!origens.length) return res.status(400).json({ error: 'Selecione ao menos uma rota de origem diferente do destino.' });
    try {
        const r = await db.query(
            `UPDATE ocorrencias SET rota = $1 WHERE excluida_em IS NULL AND TRIM(rota) = ANY($2::text[])`,
            [para, origens]);
        try { qualidadeCache.clear(); custoCache.clear(); } catch (_) {}
        await registrarAuditoria(req, 'MESCLAR_ROTAS', 'ocorrencias', null, { de: origens, para, atualizadas: r.rowCount });
        res.status(200).json({ ok: true, atualizadas: r.rowCount, para });
    } catch (err) {
        console.error('[POST /rotas/mesclar]', err);
        res.status(500).json({ error: 'Falha ao mesclar rotas.' });
    }
});

app.post('/ocorrencias', async (req, res) => {
    try {
        const {
            loja,
            motorista,
            placa,
            ajudantes,
            recebedor,
            cargo,
            data_ocorrencia,
            hora_chegada,
            inicio_descarga,
            fim_descarga,
            termino_descarga,
            tipo_problema,
            ocorrencia_responsavel,
            ocorrenciaResponsavel,
            descricao,
            protocolo_imprevisto,
            hora_recebedor,
            hora_marcada_saida,
            hora_saida_fabrica,
            hora_agendada_loja,
            fez_checklist,
            retirada_cx_prevista,
            retirada_cx_realizada,
            retirada_cx_divergencia,
            retirada_rt_prevista,
            retirada_rt_realizada,
            retirada_rt_divergencia,
            volume_gerencial,
            volume_fisico,
            volume_divergencia,
            transferencia_problema,
            transferencia_relato,
            sacola_status,
            sacola_relato,
            almoxerifado_status,
            almoxerifado_relato,
            material_envio_status,
            material_envio_relato,
            material_retirada_status,
            material_retirada_relato,
            material_campanha_qtd,
            campanha_banner_qtd,
            campanha_banner_campanha,
            campanha_folder_qtd,
            campanha_folder_campanha,
            campanha_adesivo_qtd,
            campanha_adesivo_campanha,
            campanha_quadro_qtd,
            campanha_quadro_campanha,
            sacola_qtd,
            sacola_p,
            sacola_m,
            sacola_g,
            problema_operacional_tipo,
            problema_operacional_relato,
            viagem_id,
            parada_id,
            pedido_numero,
            nota_fiscal,
            romaneio_numero,
            valor_carga,
            entrega_completa,
            ocorrencia_severidade,
            ocorrencia_status,
            causa_raiz,
            acao_corretiva,
            prazo_solucao,
            km_previsto,
            km_real,
            custo_km,
            pedagio,
            custo_reentrega,
            custo_ocorrencia,
            pod_status,
            pod_documento_recebedor,
            pod_foto,
            pod_canhoto,
            pod_assinatura,
            gps_latitude,
            gps_longitude,
            pod_confirmado_em,
            ocorrencia_fotos,
            permanencia_justificativa,
            malote_status,
            malote_observacao,
            observacao
        } = req.body;

        const camposObrigatorios = [
            ['hora_chegada', hora_chegada, 'Hora de chegada na rota'],
            ['inicio_descarga', inicio_descarga, 'Início da descarga'],
            ['fim_descarga', fim_descarga, 'Saída da loja']
        ];
        const campoFaltante = camposObrigatorios.find(([, valor]) => !vazioParaNull(valor));

        if (campoFaltante) {
            return res.status(400).json({
                error: `${campoFaltante[2]} é obrigatório.`,
                detalhe: `Campo obrigatório ausente: ${campoFaltante[0]}.`
            });
        }

        const permanencia = calcularMinutos(inicio_descarga, fim_descarga);
        const teveOcorrencia = !!(tipo_problema && String(tipo_problema).trim() !== '');
        const modulosFuturosPreenchidos = [
            pedido_numero, nota_fiscal, romaneio_numero, valor_carga, entrega_completa,
            ocorrencia_severidade, ocorrencia_status, causa_raiz, acao_corretiva, prazo_solucao,
            km_previsto, km_real, custo_km, pedagio, custo_reentrega, custo_ocorrencia,
            pod_status, pod_documento_recebedor, pod_foto, pod_canhoto, pod_assinatura,
            gps_latitude, gps_longitude, pod_confirmado_em
        ].some((valor) => vazioParaNull(valor) !== null);
        // SLA/OTIF sao SEMPRE calculados. Antes ficavam nulos quando nenhum
        // campo "de modulo futuro" vinha preenchido — e a entrega sumia dos
        // indicadores. Sao valores derivados de dados que a entrega ja tem
        // (horario agendado, chegada e a ocorrencia lancada); sem horario o
        // proprio classificarSla devolve 'Sem prazo', que e' a resposta honesta.
        const indicadores = indicadoresEntrega({
            hora_agendada_loja,
            hora_chegada,
            entrega_completa,
            teve_ocorrencia: teveOcorrencia,
            tipo_problema,
            sacola_status,
            almoxerifado_status,
            material_envio_status,
            volume_divergencia,
            km_real,
            custo_km,
            pedagio,
            custo_reentrega,
            custo_ocorrencia
        });
        const confirmadoEm =
            pod_status === 'Confirmado'
                ? vazioParaNull(pod_confirmado_em) || new Date()
                : vazioParaNull(pod_confirmado_em);

        const queryText = `
            INSERT INTO ocorrencias (
                loja,
                motorista,
                placa,
                ajudantes,
                recebedor,
                cargo,
                data_ocorrencia,
                hora_chegada,
                inicio_descarga,
                fim_descarga,
                tipo_problema,
                ocorrencia_responsavel,
                descricao,
                protocolo_imprevisto,
                permanencia_minutos,
                teve_ocorrencia,
                hora_recebedor,
                hora_marcada_saida,
                hora_saida_fabrica,
                hora_agendada_loja,
                fez_checklist,
                retirada_cx_prevista,
                retirada_cx_realizada,
                retirada_cx_divergencia,
                retirada_rt_prevista,
                retirada_rt_realizada,
                retirada_rt_divergencia,
                volume_gerencial,
                volume_fisico,
                volume_divergencia,
                transferencia_problema,
                transferencia_relato,
                sacola_status,
                sacola_relato,
                problema_operacional_tipo,
                problema_operacional_relato,
                viagem_id,
                parada_id,
                pedido_numero,
                nota_fiscal,
                romaneio_numero,
                valor_carga,
                entrega_completa,
                sla_status,
                otif_status,
                ocorrencia_severidade,
                ocorrencia_status,
                causa_raiz,
                acao_corretiva,
                prazo_solucao,
                km_previsto,
                km_real,
                custo_km,
                pedagio,
                custo_reentrega,
                custo_ocorrencia,
                custo_total,
                pod_status,
                pod_documento_recebedor,
                pod_foto,
                pod_canhoto,
                pod_assinatura,
                gps_latitude,
                gps_longitude,
                pod_confirmado_em,
                material_campanha_qtd,
                sacola_qtd,
                sacola_p,
                sacola_m,
                sacola_g,
                ocorrencia_fotos,
                permanencia_justificativa,
                termino_descarga,
                malote_status,
                malote_observacao,
                observacao,
                campanha_banner_qtd,
                campanha_banner_campanha,
                campanha_folder_qtd,
                campanha_folder_campanha,
                campanha_adesivo_qtd,
                campanha_adesivo_campanha,
                campanha_quadro_qtd,
                campanha_quadro_campanha,
                almoxerifado_status,
                almoxerifado_relato,
                material_envio_status,
                material_envio_relato,
                material_retirada_status,
                material_retirada_relato
            ) VALUES (
                $1, $2, $3, $4, $5,
                $6, $7, $8, $9, $10,
                $11, $12, $13, $14, $15,
                $16, $17, $18, $19, $20,
                $21, $22, $23, $24, $25,
                $26, $27, $28, $29, $30,
                $31, $32, $33, $34, $35,
                $36, $37, $38, $39, $40,
                $41, $42, $43, $44, $45,
                $46, $47, $48, $49, $50,
                $51, $52, $53, $54, $55,
                $56, $57, $58, $59, $60,
                $61, $62, $63, $64, $65,
                $66, $67, $68, $69, $70,
                $71, $72, $73, $74, $75,
                $76, $77, $78, $79, $80,
                $81, $82, $83, $84, $85,
                $86, $87, $88, $89, $90
            )
            RETURNING *;
        `;

        const values = [
            vazioParaNull(loja),
            vazioParaNull(motorista),
            vazioParaNull(placa),
            vazioParaNull(ajudantes),
            vazioParaNull(recebedor),
            vazioParaNull(cargo),
            vazioParaNull(data_ocorrencia),
            vazioParaNull(hora_chegada),
            vazioParaNull(inicio_descarga),
            vazioParaNull(fim_descarga),
            vazioParaNull(tipo_problema),
            vazioParaNull(ocorrencia_responsavel || ocorrenciaResponsavel),
            vazioParaNull(descricao),
            vazioParaNull(protocolo_imprevisto),
            permanencia,
            teveOcorrencia,
            vazioParaNull(hora_recebedor),
            vazioParaNull(hora_marcada_saida),
            vazioParaNull(hora_saida_fabrica),
            vazioParaNull(hora_agendada_loja),
            textoParaBoolean(fez_checklist),
            vazioParaNull(retirada_cx_prevista),
            vazioParaNull(retirada_cx_realizada),
            vazioParaNull(retirada_cx_divergencia),
            vazioParaNull(retirada_rt_prevista),
            vazioParaNull(retirada_rt_realizada),
            vazioParaNull(retirada_rt_divergencia),
            vazioParaNull(volume_gerencial),
            vazioParaNull(volume_fisico),
            vazioParaNull(volume_divergencia),
            vazioParaNull(transferencia_problema),
            vazioParaNull(transferencia_relato),
            vazioParaNull(sacola_status),
            vazioParaNull(sacola_relato),
            vazioParaNull(problema_operacional_tipo),
            vazioParaNull(problema_operacional_relato),
            vazioParaNull(viagem_id),
            vazioParaNull(parada_id),
            vazioParaNull(pedido_numero),
            vazioParaNull(nota_fiscal),
            vazioParaNull(romaneio_numero),
            vazioParaNull(valor_carga),
            indicadores.completa,
            indicadores.slaStatus,
            indicadores.otifStatus,
            vazioParaNull(ocorrencia_severidade),
            modulosFuturosPreenchidos
                ? vazioParaNull(ocorrencia_status) || (teveOcorrencia ? 'Aberta' : 'Nao se aplica')
                : null,
            vazioParaNull(causa_raiz),
            vazioParaNull(acao_corretiva),
            vazioParaNull(prazo_solucao),
            vazioParaNull(km_previsto),
            vazioParaNull(km_real),
            vazioParaNull(custo_km),
            vazioParaNull(pedagio),
            vazioParaNull(custo_reentrega),
            vazioParaNull(custo_ocorrencia),
            indicadores.custoTotal,
            vazioParaNull(pod_status),
            vazioParaNull(pod_documento_recebedor),
            vazioParaNull(pod_foto),
            vazioParaNull(pod_canhoto),
            vazioParaNull(pod_assinatura),
            vazioParaNull(gps_latitude),
            vazioParaNull(gps_longitude),
            confirmadoEm,
            vazioParaNull(material_campanha_qtd),
            vazioParaNull(sacola_qtd),
            vazioParaNull(sacola_p),
            vazioParaNull(sacola_m),
            vazioParaNull(sacola_g),
            vazioParaNull(ocorrencia_fotos),
            vazioParaNull(permanencia_justificativa),
            vazioParaNull(termino_descarga),
            vazioParaNull(malote_status),
            vazioParaNull(malote_observacao),
            vazioParaNull(observacao),
            vazioParaNull(campanha_banner_qtd),
            vazioParaNull(campanha_banner_campanha),
            vazioParaNull(campanha_folder_qtd),
            vazioParaNull(campanha_folder_campanha),
            vazioParaNull(campanha_adesivo_qtd),
            vazioParaNull(campanha_adesivo_campanha),
            vazioParaNull(campanha_quadro_qtd),
            vazioParaNull(campanha_quadro_campanha),
            vazioParaNull(almoxerifado_status),
            vazioParaNull(almoxerifado_relato),
            vazioParaNull(material_envio_status),
            vazioParaNull(material_envio_relato),
            vazioParaNull(material_retirada_status),
            vazioParaNull(material_retirada_relato)
        ];

        const result = await db.query(queryText, values);

        if (parada_id) {
            await db.query(`
                UPDATE tms_paradas
                SET ocorrencia_id = $1,
                    status = $2,
                    atualizado_em = NOW()
                WHERE id = $3
            `, [result.rows[0].id, teveOcorrencia ? 'Entregue com ocorrencia' : 'Entregue', parada_id]);
        }

        // Rota nunca em branco: deriva da loja (fonte canonica) quando ficou vazia.
        try {
            const rl = await rotaDaLoja(loja);
            if (rl) await db.query(
                `UPDATE ocorrencias SET rota = $1 WHERE id = $2 AND NULLIF(TRIM(rota),'') IS NULL`,
                [rl, result.rows[0].id]);
        } catch (_) { /* nao bloqueia o save */ }

        // Rota de viagem: loja feita no dia seguinte (pernoite). Depois da rota
        // derivada, que entra na deducao.
        try { await pernoite.gravarDiaSeguinte(db, result.rows[0].id, req.body); }
        catch (err) { console.warn('[pernoite] POST:', err.message); }

        await registrarAuditoria(req, 'POST', 'ocorrencias', result.rows[0].id, { loja, motorista, placa });
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Erro ao salvar ocorrência:', err);

        res.status(500).json({
            error: 'Erro ao processar ocorrência no servidor.',
            detalhe: err.message
        });
    }
});



// ================= DELETE — EXCLUIR OCORRÊNCIA POR ID =================
// Exclusao "soft": NAO apaga do banco — manda para a LIXEIRA marcando
// excluida_em. A ocorrencia some das listas/graficos, mas pode ser
// recuperada em GET /ocorrencias-lixeira -> POST /ocorrencias/:id/restaurar.
// A remocao fisica so acontece via DELETE /ocorrencias/:id/permanente.
// A parada do TMS NAO e desvinculada aqui (as joins ja ignoram itens na
// lixeira), para que restaurar volte tudo ao estado anterior.
app.delete('/ocorrencias/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const result = await db.query(`
            UPDATE ocorrencias
            SET excluida_em = NOW()
            WHERE id = $1 AND excluida_em IS NULL
            RETURNING *
        `, [id]);

        if (result.rowCount === 0) {
            return res.status(404).json({
                error: 'Ocorrência não encontrada.'
            });
        }

        await registrarAuditoria(req, 'LIXEIRA', 'ocorrencias', id, result.rows[0]);
        res.status(200).json({
            message: 'Ocorrência movida para a lixeira.',
            deleted: result.rows[0]
        });
    } catch (err) {
        console.error('Erro ao mover ocorrência para a lixeira:', err);

        res.status(500).json({
            error: 'Erro ao mover ocorrência para a lixeira.',
            detalhe: err.message
        });
    }
});

// ================= LIXEIRA — listar ocorrências excluídas =================
app.get('/ocorrencias-lixeira', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT * FROM ocorrencias
            WHERE excluida_em IS NOT NULL
            ORDER BY excluida_em DESC
        `);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('Erro ao listar a lixeira:', err);
        res.status(500).json({
            error: 'Erro ao listar a lixeira.',
            detalhe: err.message
        });
    }
});

// ================= LIXEIRA — restaurar ocorrência =================
app.post('/ocorrencias/:id/restaurar', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db.query(`
            UPDATE ocorrencias
            SET excluida_em = NULL
            WHERE id = $1 AND excluida_em IS NOT NULL
            RETURNING *
        `, [id]);

        if (result.rowCount === 0) {
            return res.status(404).json({
                error: 'Ocorrência não encontrada na lixeira.'
            });
        }

        await registrarAuditoria(req, 'RESTAURAR', 'ocorrencias', id, null);
        res.status(200).json({
            message: 'Ocorrência restaurada.',
            restored: result.rows[0]
        });
    } catch (err) {
        console.error('Erro ao restaurar ocorrência:', err);
        res.status(500).json({
            error: 'Erro ao restaurar ocorrência.',
            detalhe: err.message
        });
    }
});

// ============ LIXEIRA — excluir DEFINITIVAMENTE (remoção física) ============
// Só remove de verdade do banco. Guarda os dados completos na auditoria
// antes de apagar, como última rede de segurança.
app.delete('/ocorrencias/:id/permanente', async (req, res) => {
    try {
        const { id } = req.params;

        const result = await db.query(`
            DELETE FROM ocorrencias
            WHERE id = $1
            RETURNING *
        `, [id]);

        if (result.rowCount === 0) {
            return res.status(404).json({
                error: 'Ocorrência não encontrada.'
            });
        }

        await db.query(`
            UPDATE tms_paradas
            SET ocorrencia_id = NULL,
                status = 'Pendente',
                atualizado_em = NOW()
            WHERE ocorrencia_id = $1 OR id = $2
        `, [id, result.rows[0].parada_id]);

        await registrarAuditoria(req, 'DELETE', 'ocorrencias', id, result.rows[0]);
        res.status(200).json({
            message: 'Ocorrência excluída definitivamente.',
            deleted: result.rows[0]
        });
    } catch (err) {
        console.error('Erro ao excluir ocorrência definitivamente:', err);
        res.status(500).json({
            error: 'Erro ao excluir ocorrência no banco de dados.',
            detalhe: err.message
        });
    }
});

// ================= POST — MARCAR ATRASO DE SLA MANUALMENTE =================
// Usado pelo botao do card quando a chegada na rota foi depois do agendado
// na loja. Grava sla_status/otif_status direto (o PUT padrao recalcula esses
// campos e ignoraria o valor enviado), refletindo no KPI OTIF do painel.
app.post('/ocorrencias/:id/marcar-atraso', async (req, res) => {
    try {
        const { id } = req.params;

        const result = await db.query(`
            UPDATE ocorrencias
            SET sla_status = 'Atrasada',
                otif_status = 'Nao conforme'
            WHERE id = $1
            RETURNING *;
        `, [id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Ocorrência não encontrada.' });
        }

        await registrarAuditoria(req, 'MARCAR_ATRASO', 'ocorrencias', id, { sla_status: 'Atrasada' });
        res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error('Erro ao marcar atraso de SLA:', err);

        res.status(500).json({
            error: 'Erro ao registrar atraso no banco de dados.',
            detalhe: err.message
        });
    }
});

// Fotos de UMA ocorrencia, sob demanda.
// A listagem (GET /ocorrencias) devolve so a contagem — ver o comentario la.
// O conteudo pesado sai por aqui, um registro por vez, quando o usuario
// realmente abre as fotos daquele card.
app.get('/ocorrencias/:id/fotos', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });

        const result = await db.query(
            'SELECT ocorrencia_fotos FROM ocorrencias WHERE id = $1 AND excluida_em IS NULL',
            [id]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Ocorrência não encontrada.' });

        const bruto = result.rows[0].ocorrencia_fotos;
        let fotos = [];
        try {
            const lido = JSON.parse(bruto || '[]');
            if (Array.isArray(lido)) fotos = lido;
        } catch (_) {
            // Valor legado que nao e JSON: trata como "sem foto" em vez de
            // estourar 500 numa tela que so queria mostrar imagem.
            fotos = [];
        }

        res.status(200).json({ fotos });
    } catch (err) {
        console.error('Erro ao buscar fotos da ocorrência:', err);
        res.status(500).json({ error: 'Erro ao buscar fotos.' });
    }
});

// ===== Acoes de 1 clique da fila "Resolver agora" (updates minimos e focados) =====
// Cada uma altera UM campo, sem tocar no resto da linha (diferente do PUT completo).

// Atribui o responsavel de uma ocorrencia de parada/entrega.
app.put('/ocorrencias/:id/responsavel', async (req, res) => {
    try {
        const resp = String(req.body && req.body.responsavel || '').trim();
        if (!resp) return res.status(400).json({ error: 'Informe o responsável.' });
        if (resp.length > 100) return res.status(400).json({ error: 'Responsável inválido.' });
        const result = await db.query(
            `UPDATE ocorrencias SET ocorrencia_responsavel = $1 WHERE id = $2 RETURNING id, ocorrencia_responsavel`,
            [resp, req.params.id]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Ocorrência não encontrada.' });
        await registrarAuditoria(req, 'DEFINIR_RESPONSAVEL', 'ocorrencias', req.params.id, { ocorrencia_responsavel: resp });
        res.status(200).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Erro ao definir responsável.', detalhe: err.message });
    }
});

// Marca o checklist de chegada como realizado.
app.put('/ocorrencias/:id/checklist', async (req, res) => {
    try {
        const result = await db.query(
            `UPDATE ocorrencias SET fez_checklist = TRUE WHERE id = $1 RETURNING id, fez_checklist`,
            [req.params.id]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Ocorrência não encontrada.' });
        await registrarAuditoria(req, 'MARCAR_CHECKLIST', 'ocorrencias', req.params.id, { fez_checklist: true });
        res.status(200).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Erro ao marcar checklist.', detalhe: err.message });
    }
});

// ================= POST — CRIAR NOVA OCORRÊNCIA INDIVIDUAL =================
app.post('/ocorrencias-individuais', async (req, res) => {
    try {
        const d = req.body;

        const queryText = `
            INSERT INTO ocorrencias_individuais (
                data_evento,
                responsavel,
                motorista_envolvido,
                ajudantes_envolvidos,
                envolvido_formatado,
                tipo_ocorrencia,
                relato
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7
            )
            RETURNING *;
        `;

        const values = [
            vazioParaNull(d.data_ocorrencia_individual),
            vazioParaNull(d.responsavel_ocorrencia_individual),
            vazioParaNull(d.motorista_ocorrencia_individual),
            vazioParaNull(d.ajudantes_ocorrencia_individual),
            vazioParaNull(d.envolvido_ocorrencia_individual),
            vazioParaNull(d.tipo_ocorrencia_individual),
            vazioParaNull(d.relato_ocorrencia_individual)
        ];

        const result = await db.query(queryText, values);

        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Erro ao salvar na tabela individual:', err);

        res.status(500).json({
            error: 'Erro interno ao salvar ocorrência individual.',
            detalhe: err.message
        });
    }
});

// ================= PUT — EDITAR OCORRÊNCIA EXISTENTE =================
app.put('/ocorrencias/:id', async (req, res) => {
    try {
        const { id } = req.params;

        console.log('==============================');
        console.log('[PUT /ocorrencias/:id]');
        console.log('ID recebido:', id);
        console.log('Body recebido:', req.body);
        console.log('==============================');

        // 1. Buscar registro atual
        const atualResult = await db.query(
            'SELECT * FROM ocorrencias WHERE id = $1',
            [id]
        );

        if (atualResult.rowCount === 0) {
            return res.status(404).json({
                error: 'Ocorrência não encontrada.'
            });
        }

        const atual = atualResult.rows[0];

        // 2. Juntar dados atuais com dados novos
        const d = {
            ...atual,
            ...req.body
        };

        // 3. Funções auxiliares
        function valorOuNull(valor) {
            if (valor === undefined || valor === '') return null;
            return valor;
        }

        function valorOuAtual(campo) {
            if (req.body[campo] === undefined) {
                return atual[campo];
            }

            if (req.body[campo] === '') {
                return null;
            }

            return req.body[campo];
        }

        function booleanSeguro(valor) {
            if (valor === true) return true;
            if (valor === false) return false;

            const texto = String(valor || '').trim().toLowerCase();

            return (
                texto === 'true' ||
                texto === 'sim' ||
                texto === 'feito' ||
                texto === 'realizou' ||
                texto === 'x'
            );
        }

        const permanencia = calcularMinutos(
            valorOuAtual('inicio_descarga'),
            valorOuAtual('fim_descarga')
        );

        const tipoProblemaFinal = valorOuAtual('tipo_problema');

        const teveOcorrencia = !!(
            tipoProblemaFinal &&
            String(tipoProblemaFinal).trim() !== ''
        );
        const modulosFuturosAlterados = [
            'pedido_numero', 'nota_fiscal', 'romaneio_numero', 'valor_carga',
            'entrega_completa', 'ocorrencia_severidade', 'ocorrencia_status',
            'causa_raiz', 'acao_corretiva', 'prazo_solucao', 'km_previsto',
            'km_real', 'custo_km', 'pedagio', 'custo_reentrega',
            'custo_ocorrencia', 'pod_status', 'pod_documento_recebedor',
            'pod_foto', 'pod_canhoto', 'pod_assinatura', 'gps_latitude',
            'gps_longitude', 'pod_confirmado_em'
        ].some((campo) => Object.prototype.hasOwnProperty.call(req.body, campo));
        // Igual ao POST: os indicadores sao SEMPRE recalculados. Como o In Full
        // e' derivado da ocorrencia, editar o tipo da ocorrencia tem de mexer no
        // OTIF — por isso o entrega_completa so e' respeitado quando vem
        // EXPLICITO no corpo; ausente, deixa a ocorrencia decidir de novo (o
        // valor guardado pode ser o `false` errado da versao anterior).
        const entregaCompletaInformada =
            Object.prototype.hasOwnProperty.call(req.body, 'entrega_completa')
                ? req.body.entrega_completa
                : null;
        const indicadores = indicadoresEntrega({
            hora_agendada_loja: valorOuAtual('hora_agendada_loja'),
            hora_chegada: valorOuAtual('hora_chegada'),
            entrega_completa: entregaCompletaInformada,
            teve_ocorrencia: teveOcorrencia,
            tipo_problema: tipoProblemaFinal,
            sacola_status: valorOuAtual('sacola_status'),
            almoxerifado_status: valorOuAtual('almoxerifado_status'),
            material_envio_status: valorOuAtual('material_envio_status'),
            volume_divergencia: valorOuAtual('volume_divergencia'),
            km_real: valorOuAtual('km_real'),
            custo_km: valorOuAtual('custo_km'),
            pedagio: valorOuAtual('pedagio'),
            custo_reentrega: valorOuAtual('custo_reentrega'),
            custo_ocorrencia: valorOuAtual('custo_ocorrencia')
        });

        // ATRASO MARCADO NA MAO e' decisao humana, nao calculo: o botao
        // "REGISTRAR ATRASO SLA" (POST /ocorrencias/:id/marcar-atraso) grava
        // 'Atrasada' sem mexer nos horarios. Como agora TODO PUT recalcula, uma
        // edicao qualquer desfaria a marcacao em silencio. So consultamos a
        // auditoria no caso raro em que o recalculo discordaria dela.
        if (atual.sla_status === 'Atrasada' && indicadores.slaStatus !== 'Atrasada') {
            const marcadoNaMao = await db.query(`
                SELECT 1 FROM sistema_auditoria
                 WHERE acao = 'MARCAR_ATRASO' AND recurso = 'ocorrencias'
                   AND recurso_id = $1
                 LIMIT 1
            `, [String(id)]);
            if (marcadoNaMao.rowCount > 0) {
                indicadores.slaStatus = 'Atrasada';
                indicadores.otifStatus = 'Nao conforme';
            }
        }

        const podStatus = valorOuAtual('pod_status');
        const podConfirmadoEm =
            podStatus === 'Confirmado'
                ? valorOuAtual('pod_confirmado_em') || atual.pod_confirmado_em || new Date()
                : valorOuAtual('pod_confirmado_em');

        const queryText = `
            UPDATE ocorrencias SET
                loja = $1,
                motorista = $2,
                placa = $3,
                ajudantes = $4,
                recebedor = $5,
                cargo = $6,
                data_ocorrencia = $7,
                hora_chegada = $8,
                inicio_descarga = $9,
                fim_descarga = $10,
                tipo_problema = $11,
                ocorrencia_responsavel = $12,
                descricao = $13,
                protocolo_imprevisto = $14,
                permanencia_minutos = $15,
                teve_ocorrencia = $16,
                hora_recebedor = $17,
                hora_marcada_saida = $18,
                hora_saida_fabrica = $19,
                hora_agendada_loja = $20,
                fez_checklist = $21,
                retirada_cx_prevista = $22,
                retirada_cx_realizada = $23,
                retirada_cx_divergencia = $24,
                retirada_rt_prevista = $25,
                retirada_rt_realizada = $26,
                retirada_rt_divergencia = $27,
                volume_gerencial = $28,
                volume_fisico = $29,
                volume_divergencia = $30,
                transferencia_problema = $31,
                transferencia_relato = $32,
                sacola_status = $33,
                sacola_relato = $34,
                problema_operacional_tipo = $35,
                problema_operacional_relato = $36,
                pedido_numero = $37,
                nota_fiscal = $38,
                romaneio_numero = $39,
                valor_carga = $40,
                entrega_completa = $41,
                sla_status = $42,
                otif_status = $43,
                ocorrencia_severidade = $44,
                ocorrencia_status = $45,
                causa_raiz = $46,
                acao_corretiva = $47,
                prazo_solucao = $48,
                km_previsto = $49,
                km_real = $50,
                custo_km = $51,
                pedagio = $52,
                custo_reentrega = $53,
                custo_ocorrencia = $54,
                custo_total = $55,
                pod_status = $56,
                pod_documento_recebedor = $57,
                pod_foto = $58,
                pod_canhoto = $59,
                pod_assinatura = $60,
                gps_latitude = $61,
                gps_longitude = $62,
                pod_confirmado_em = $63,
                material_campanha_qtd = $64,
                sacola_qtd = $65,
                sacola_p = $66,
                sacola_m = $67,
                sacola_g = $68,
                permanencia_justificativa = $69,
                termino_descarga = $70,
                malote_status = $71,
                malote_observacao = $72,
                observacao = $73,
                campanha_banner_qtd = $74,
                campanha_banner_campanha = $75,
                campanha_folder_qtd = $76,
                campanha_folder_campanha = $77,
                campanha_adesivo_qtd = $78,
                campanha_adesivo_campanha = $79,
                campanha_quadro_qtd = $80,
                campanha_quadro_campanha = $81,
                ocorrencia_fotos = $82,
                almoxerifado_status = $83,
                almoxerifado_relato = $84,
                material_envio_status = $85,
                material_envio_relato = $86,
                material_retirada_status = $87,
                material_retirada_relato = $88
            WHERE id = $89
            RETURNING *;
        `;

        const values = [
            valorOuAtual('loja'),
            valorOuAtual('motorista'),
            valorOuAtual('placa'),
            valorOuAtual('ajudantes'),
            valorOuAtual('recebedor'),
            valorOuAtual('cargo'),
            valorOuAtual('data_ocorrencia'),
            valorOuAtual('hora_chegada'),
            valorOuAtual('inicio_descarga'),
            valorOuAtual('fim_descarga'),
            valorOuAtual('tipo_problema'),
            valorOuAtual('ocorrencia_responsavel') || valorOuAtual('ocorrenciaResponsavel'),
            valorOuAtual('descricao'),
            valorOuAtual('protocolo_imprevisto'),
            permanencia,
            teveOcorrencia,
            valorOuAtual('hora_recebedor'),
            valorOuAtual('hora_marcada_saida'),
            valorOuAtual('hora_saida_fabrica'),
            valorOuAtual('hora_agendada_loja'),
            booleanSeguro(valorOuAtual('fez_checklist')),
            valorOuAtual('retirada_cx_prevista'),
            valorOuAtual('retirada_cx_realizada'),
            valorOuAtual('retirada_cx_divergencia'),
            valorOuAtual('retirada_rt_prevista'),
            valorOuAtual('retirada_rt_realizada'),
            valorOuAtual('retirada_rt_divergencia'),
            valorOuAtual('volume_gerencial'),
            valorOuAtual('volume_fisico'),
            valorOuAtual('volume_divergencia'),
            valorOuAtual('transferencia_problema'),
            valorOuAtual('transferencia_relato'),
            valorOuAtual('sacola_status'),
            valorOuAtual('sacola_relato'),
            valorOuAtual('problema_operacional_tipo'),
            valorOuAtual('problema_operacional_relato'),
            valorOuAtual('pedido_numero'),
            valorOuAtual('nota_fiscal'),
            valorOuAtual('romaneio_numero'),
            valorOuAtual('valor_carga'),
            indicadores.completa,
            indicadores.slaStatus,
            indicadores.otifStatus,
            valorOuAtual('ocorrencia_severidade'),
            modulosFuturosAlterados
                ? valorOuAtual('ocorrencia_status') || (teveOcorrencia ? 'Aberta' : 'Nao se aplica')
                : atual.ocorrencia_status,
            valorOuAtual('causa_raiz'),
            valorOuAtual('acao_corretiva'),
            valorOuAtual('prazo_solucao'),
            valorOuAtual('km_previsto'),
            valorOuAtual('km_real'),
            valorOuAtual('custo_km'),
            valorOuAtual('pedagio'),
            valorOuAtual('custo_reentrega'),
            valorOuAtual('custo_ocorrencia'),
            indicadores.custoTotal,
            podStatus,
            valorOuAtual('pod_documento_recebedor'),
            valorOuAtual('pod_foto'),
            valorOuAtual('pod_canhoto'),
            valorOuAtual('pod_assinatura'),
            valorOuAtual('gps_latitude'),
            valorOuAtual('gps_longitude'),
            podConfirmadoEm,
            valorOuAtual('material_campanha_qtd'),
            valorOuAtual('sacola_qtd'),
            valorOuAtual('sacola_p'),
            valorOuAtual('sacola_m'),
            valorOuAtual('sacola_g'),
            valorOuAtual('permanencia_justificativa'),
            valorOuAtual('termino_descarga'),
            valorOuAtual('malote_status'),
            valorOuAtual('malote_observacao'),
            valorOuAtual('observacao'),
            valorOuAtual('campanha_banner_qtd'),
            valorOuAtual('campanha_banner_campanha'),
            valorOuAtual('campanha_folder_qtd'),
            valorOuAtual('campanha_folder_campanha'),
            valorOuAtual('campanha_adesivo_qtd'),
            valorOuAtual('campanha_adesivo_campanha'),
            valorOuAtual('campanha_quadro_qtd'),
            valorOuAtual('campanha_quadro_campanha'),
            // valorOuAtual: se o front nao mandar o campo, mantem as fotos que
            // ja estavam la. Editar uma ocorrencia sem mexer em foto nao pode
            // apagar o que foi anexado antes.
            valorOuAtual('ocorrencia_fotos'),
            valorOuAtual('almoxerifado_status'),
            valorOuAtual('almoxerifado_relato'),
            valorOuAtual('material_envio_status'),
            valorOuAtual('material_envio_relato'),
            valorOuAtual('material_retirada_status'),
            valorOuAtual('material_retirada_relato'),
            id
        ];

        const result = await db.query(queryText, values);

        if (result.rows[0].parada_id) {
            await db.query(`
                UPDATE tms_paradas
                SET ocorrencia_id = $1,
                    status = $2,
                    atualizado_em = NOW()
                WHERE id = $3
            `, [
                result.rows[0].id,
                teveOcorrencia ? 'Entregue com ocorrencia' : 'Entregue',
                result.rows[0].parada_id
            ]);
        }

        try { await pernoite.gravarDiaSeguinte(db, id, req.body); }
        catch (err) { console.warn('[pernoite] PUT:', err.message); }

        await registrarAuditoria(req, 'PUT', 'ocorrencias', id, { loja: d.loja, motorista: d.motorista });
        res.status(200).json(result.rows[0]);

    } catch (err) {
        console.error('Erro ao editar ocorrência:', err);

        res.status(500).json({
            error: 'Erro ao editar ocorrência no servidor.',
            detalhe: err.message,
            codigo: err.code || null
        });
    }
});

// ================= GET — LISTAR TODAS AS OCORRÊNCIAS INDIVIDUAIS =================
app.get('/ocorrencias-individuais', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT *
            FROM ocorrencias_individuais
            ORDER BY id DESC
        `);

        res.status(200).json(result.rows);
    } catch (err) {
        console.error('Erro ao buscar individuais:', err);

        res.status(500).json({
            error: 'Erro ao buscar ocorrências individuais.',
            detalhe: err.message
        });
    }
});

// ================= PUT — EDITAR OCORRÊNCIA INDIVIDUAL EXISTENTE =================
app.put('/ocorrencias-individuais/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const atualResult = await db.query(
            'SELECT * FROM ocorrencias_individuais WHERE id = $1',
            [id]
        );

        if (atualResult.rowCount === 0) {
            return res.status(404).json({ error: 'Ocorrência individual não encontrada.' });
        }

        const atual = atualResult.rows[0];
        const d = req.body;

        function valorOuAtual(campoBody, campoDb) {
            const novoValor = d[campoBody] ?? d[campoDb];
            if (novoValor === undefined) return atual[campoDb];
            if (novoValor === '') return null;
            return novoValor;
        }

        const queryText = `
            UPDATE ocorrencias_individuais SET
                data_evento = $1,
                responsavel = $2,
                motorista_envolvido = $3,
                ajudantes_envolvidos = $4,
                envolvido_formatado = $5,
                tipo_ocorrencia = $6,
                relato = $7
            WHERE id = $8
            RETURNING *;
        `;

        const values = [
            valorOuAtual('data_ocorrencia_individual', 'data_evento'),
            valorOuAtual('responsavel_ocorrencia_individual', 'responsavel'),
            valorOuAtual('motorista_ocorrencia_individual', 'motorista_envolvido'),
            valorOuAtual('ajudantes_ocorrencia_individual', 'ajudantes_envolvidos'),
            valorOuAtual('envolvido_ocorrencia_individual', 'envolvido_formatado'),
            valorOuAtual('tipo_ocorrencia_individual', 'tipo_ocorrencia'),
            valorOuAtual('relato_ocorrencia_individual', 'relato'),
            id
        ];

        const result = await db.query(queryText, values);

        res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error('Erro ao editar ocorrência individual:', err);

        res.status(500).json({
            error: 'Erro ao editar ocorrência individual.',
            detalhe: err.message,
            codigo: err.code || null
        });
    }
});

// ================= GET — BUSCAR OCORRÊNCIA INDIVIDUAL POR ID =================
app.get('/ocorrencias-individuais/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const result = await db.query(`
            SELECT *
            FROM ocorrencias_individuais
            WHERE id = $1
        `, [id]);

        if (result.rowCount === 0) {
            return res.status(404).json({
                error: 'Ocorrência individual não encontrada.'
            });
        }

        res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error('Erro ao buscar ocorrência individual por ID:', err);

        res.status(500).json({
            error: 'Erro ao buscar ocorrência individual.',
            detalhe: err.message
        });
    }
});

// ================= DELETE — EXCLUIR OCORRÊNCIA INDIVIDUAL =================
app.delete('/ocorrencias-individuais/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const result = await db.query(`
            DELETE FROM ocorrencias_individuais
            WHERE id = $1
            RETURNING *
        `, [id]);

        if (result.rowCount === 0) {
            return res.status(404).json({
                error: 'Registro não encontrado.'
            });
        }

        res.status(200).json({
            message: 'Ocorrência individual excluída com sucesso.',
            deleted: result.rows[0]
        });
    } catch (err) {
        console.error('Erro ao excluir individual:', err);

        res.status(500).json({
            error: 'Erro ao excluir no banco de dados.',
            detalhe: err.message
        });
    }
});

// ================================================================
// ROTAS GENÉRICAS — VEÍCULOS / MONITORAMENTO (7 NOVAS ENTIDADES)
// ================================================================
//
// Cria GET / POST / DELETE pra cada recurso usando o mesmo padrão.
// As entidades aqui são as que antes ficavam só no localStorage:
//   avisos, checklists, atrasos, rotas, almoços, tacógrafos, diários.
// ================================================================

function criarRotasCRUD(recurso, tabela, campos) {
    // ---- GET — lista tudo (mais recentes primeiro) ----
    app.get(`/${recurso}`, async (req, res) => {
        try {
            const r = await db.query(`SELECT * FROM ${tabela} ORDER BY id DESC`);
            res.status(200).json(r.rows);
        } catch (err) {
            console.error(`[GET /${recurso}]`, err);
            res.status(500).json({ error: err.message });
        }
    });

    // ---- POST — insere novo registro ----
    app.post(`/${recurso}`, async (req, res) => {
        try {
            const body = req.body || {};

            // gera id se não vier (Date.now() em milissegundos)
            const idRecebido = Number(body.id);
            const id = Number.isInteger(idRecebido) && idRecebido > 0
                ? idRecebido % 2147483647
                : Date.now() % 2147483647;

            const colunas = ['id', ...campos];
            const valores = [id, ...campos.map((c) => {
                const v = body[c];
                if (v === undefined || v === '') return null;
                // converte arrays/objetos pra JSON string (campos JSONB)
                if (Array.isArray(v) || (typeof v === 'object' && v !== null)) {
                    return JSON.stringify(v);
                }
                return v;
            })];

            const placeholders = colunas.map((_, i) => `$${i + 1}`).join(', ');
            const sql = `
                INSERT INTO ${tabela} (${colunas.join(', ')})
                VALUES (${placeholders})
                ON CONFLICT (id) DO NOTHING
                RETURNING *;
            `;

            const r = await db.query(sql, valores);

            // se houve conflito de ID, devolve o registro existente
            if (r.rowCount === 0) {
                const existente = await db.query(`SELECT * FROM ${tabela} WHERE id = $1`, [id]);
                return res.status(200).json(existente.rows[0]);
            }

            await registrarAuditoria(req, 'POST', tabela, r.rows[0].id, { recurso, registro: r.rows[0] });
            res.status(201).json(r.rows[0]);
        } catch (err) {
            console.error(`[POST /${recurso}]`, err);
            res.status(500).json({ error: err.message });
        }
    });

    // ---- DELETE — exclui por id ----
    app.delete(`/${recurso}/:id`, async (req, res) => {
        try {
            const { id } = req.params;
            const r = await db.query(
                `DELETE FROM ${tabela} WHERE id = $1 RETURNING *`,
                [id]
            );
            if (r.rowCount === 0) {
                return res.status(404).json({ error: 'Registro não encontrado.' });
            }
            // Guarda a LINHA apagada, nao so o nome do recurso. O DELETE aqui e
            // fisico e nao ha lixeira: sem o registro na auditoria, desfazer uma
            // exclusao por engano dependia de restaurar o pg_dump diario — que
            // nao cobre o que foi criado e apagado no mesmo dia. O RETURNING *
            // ja traz a linha de graca. Mesmo padrao de docas e ocorrencias.
            await registrarAuditoria(req, 'DELETE', tabela, id, { recurso, registro: r.rows[0] });
            res.status(200).json({ deleted: r.rows[0] });
        } catch (err) {
            console.error(`[DELETE /${recurso}/:id]`, err);
            res.status(500).json({ error: err.message });
        }
    });
}

// ---- registra as 7 entidades — uma linha por recurso ----

criarRotasCRUD('avisos-monitoramento', 'avisos_monitoramento', [
    'data', 'hora', 'motorista', 'placa', 'rota', 'tipos', 'status', 'justificativa'
]);

// Checklist feito pela presença do remetente no grupo; placa e rota vêm do TMS.
const checklistWaRotas = checklistWhatsApp.criarRotas({ db, registrarAuditoria });
app.post('/checklists-diarios/whatsapp/previa', express.raw({ type: 'application/zip', limit: '30mb' }), checklistWaRotas.previa);
app.post('/checklists-diarios/whatsapp/confirmar', checklistWaRotas.confirmar);
app.get('/checklists-diarios/whatsapp/envios', checklistWaRotas.listar);
app.get('/checklists-diarios/whatsapp/previa/:token/foto/:grupo/:foto', checklistWaRotas.fotoPrevia);
app.get('/checklists-diarios/whatsapp/fotos/:id', checklistWaRotas.foto);
criarRotasCRUD('checklists-diarios', 'checklists_diarios', [
    'data', 'motorista', 'placa', 'rota', 'itens', 'total_itens', 'obs'
]);

criarRotasCRUD('atrasos-saida', 'atrasos_saida', [
    'data', 'motorista', 'placa', 'rota',
    'hora_marcada', 'hora_real', 'atraso_min', 'atraso_formatado', 'justificativa'
]);

criarRotasCRUD('rotas-registradas', 'rotas_registradas', [
    'data', 'motorista', 'placa', 'rota_feita',
    'saida', 'retorno', 'total_min', 'horas', 'minutos',
    'minutos_normais', 'minutos_extras_permitidos', 'minutos_excedentes',
    'valor_extra_aprox', 'obs',
    'is_viagem', 'parada_hotel', 'saida_hotel',
    // Depende do ALTER em prepararBanco (rotas_registradas). Nao listar antes
    // de a coluna existir: o INSERT quebraria com 500. Aqui a lista NAO e
    // posicional (criarRotasCRUD monta colunas e valores da mesma lista), ao
    // contrario de /ocorrencias — a posicao nao importa.
    'responsavel_analise'
]);

criarRotasCRUD('almocos', 'almocos', [
    'data', 'motorista',
    'prev_inicio', 'prev_fim', 'real_inicio', 'real_fim',
    'obs', 'tempo_prev', 'tempo_real', 'diferenca', 'status'
]);

criarRotasCRUD('tacografos', 'tacografos', [
    'data', 'motorista', 'placa', 'status', 'obs'
]);

criarRotasCRUD('diarios-bordo', 'diarios_bordo', [
    'data', 'motorista', 'placa', 'status', 'obs'
]);

criarRotasCRUD('entregas-dia', 'entregas_dia', [
    'data', 'rota', 'motorista', 'placa', 'ajudantes', 'obs'
]);

// ================================================================
// CADASTROS — motoristas, ajudantes e placas gerenciados pela UI.
//   GET  /cadastros        -> lista todas as linhas (popula os selects).
//   POST /cadastros        -> upsert por (tipo, valor); grava/atualiza oculto.
//   DELETE /cadastros/:id  -> remove a linha (desfaz um "ocultar" ou apaga
//                             um valor adicionado).
// Liberado a qualquer usuario logado (ver rotaPermitidaOperador).
// ================================================================
const CADASTRO_TIPOS = ['motorista', 'ajudante', 'placa', 'rota', 'loja'];

app.get('/cadastros', async (req, res) => {
    try {
        const r = await db.query('SELECT * FROM cadastros ORDER BY tipo, valor');
        res.status(200).json(r.rows);
    } catch (err) {
        console.error('[GET /cadastros]', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/cadastros', async (req, res) => {
    try {
        const tipo = String(req.body?.tipo || '').trim().toLowerCase();
        const valor = String(req.body?.valor || '').trim();
        const oculto = req.body?.oculto === true || req.body?.oculto === 'true';
        const extra = req.body?.extra && typeof req.body.extra === 'object' ? req.body.extra : null;

        if (!CADASTRO_TIPOS.includes(tipo)) {
            return res.status(400).json({ error: 'Tipo invalido. Use motorista, ajudante, placa, rota ou loja.' });
        }
        if (!valor) {
            return res.status(400).json({ error: 'Informe o nome/placa/valor.' });
        }

        // Loja NOVA que e outra grafia de uma loja ja cadastrada (mesmo PES:
        // "PARK SHOPPING" x "PARK", "S. P. ALDEIA" x "S.P. ALDEIA") nao entra.
        // Regravar a mesma (ex.: mudar ramal/rota) segue livre.
        if (tipo === 'loja') {
            const jaExiste = await db.query('SELECT 1 FROM cadastros WHERE tipo = $1 AND valor = $2', [tipo, valor]);
            const idx = jaExiste.rowCount ? null : await lojasPes.carregarIndice(db);
            const loja = idx && idx.resolver(valor);
            if (loja) {
                const lojas = await db.query("SELECT valor FROM cadastros WHERE tipo = 'loja'");
                const mesma = lojas.rows.find((c) => idx.resolver(c.valor)?.codigo === loja.codigo);
                if (mesma) {
                    return res.status(409).json({
                        error: `Essa loja já está cadastrada como "${mesma.valor}"${loja.pes ? ` (PES ${loja.pes})` : ''}. Use esse nome para não duplicar.`,
                        existente: mesma.valor, pes: loja.pes,
                    });
                }
            }
        }

        const r = await db.query(`
            INSERT INTO cadastros (tipo, valor, oculto, extra)
            VALUES ($1, $2, $3, $4::jsonb)
            ON CONFLICT (tipo, valor) DO UPDATE SET oculto = EXCLUDED.oculto,
                -- MESCLA (nao substitui): o front manda so a chave que mudou
                -- ({rota} ou {ramal}); substituir apagaria a outra.
                extra = CASE WHEN EXCLUDED.extra IS NULL THEN cadastros.extra
                             ELSE COALESCE(cadastros.extra, '{}'::jsonb) || EXCLUDED.extra END
            RETURNING *;
        `, [tipo, valor, oculto, extra ? JSON.stringify(extra) : null]);

        res.status(200).json(r.rows[0]);
    } catch (err) {
        console.error('[POST /cadastros]', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/cadastros/:id', async (req, res) => {
    try {
        const r = await db.query('DELETE FROM cadastros WHERE id = $1 RETURNING *', [req.params.id]);
        if (r.rowCount === 0) {
            return res.status(404).json({ error: 'Registro nao encontrado.' });
        }
        res.status(200).json({ deleted: r.rows[0] });
    } catch (err) {
        console.error('[DELETE /cadastros/:id]', err);
        res.status(500).json({ error: err.message });
    }
});

// ================================================================
// ROTEIRO PADRAO - ANALISE DE TEMPO DE DESLOCAMENTO
//   Cada roteiro guarda a sequencia planejada de paradas (loja, km,
//   hora de chegada e de saida) e a hora de saida da fabrica. O tempo de
//   deslocamento (fabrica->1a loja e loja->loja) e o tempo de descarga
//   sao DERIVADOS dos horarios (calculados no front), nao armazenados.
//   O comparativo "planejado x real" tambem e feito no front, cruzando
//   por nome de loja com as ocorrencias ja carregadas.
// ================================================================

function montarParadasRoteiro(linhas) {
    return (Array.isArray(linhas) ? linhas : [])
        .map((p, i) => ({
            ordem: i + 1,
            loja_nome: String(p.loja_nome || p.loja || '').trim(),
            km: vazioParaNull(p.km),
            hora_chegada: vazioParaNull(p.hora_chegada),
            hora_saida: vazioParaNull(p.hora_saida),
            observacao: vazioParaNull(p.observacao)
        }))
        .filter((p) => p.loja_nome);
}

async function gravarParadasRoteiro(client, roteiroId, paradas) {
    for (const p of paradas) {
        await client.query(`
            INSERT INTO roteiros_padrao_paradas
                (roteiro_id, ordem, loja_nome, km, hora_chegada, hora_saida, observacao)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [roteiroId, p.ordem, p.loja_nome, p.km, p.hora_chegada, p.hora_saida, p.observacao]);
    }
}

async function roteiroComParadas(id) {
    const rot = await db.query('SELECT * FROM roteiros_padrao WHERE id = $1', [id]);
    if (rot.rowCount === 0) return null;
    const paradas = await db.query(
        'SELECT * FROM roteiros_padrao_paradas WHERE roteiro_id = $1 ORDER BY ordem',
        [id]
    );
    return { ...rot.rows[0], paradas: paradas.rows };
}

// ================= ASSISTENTE DE AGENDAMENTO =================
// Recomenda, por rota e loja, o melhor horário de agendamento para o
// caminhão chegar no prazo, a partir do histórico real de entregas.
// Toda a estatística fica em agendamento-engine.js (funções puras).
//   GET /agendamento/recomendacoes?rota=&de=YYYY-MM-DD&ate=YYYY-MM-DD&alvo=0.8
app.get('/agendamento/recomendacoes', async (req, res) => {
    try {
        const { rota, de, ate } = req.query;
        let alvo = Number(req.query.alvo);
        if (!Number.isFinite(alvo) || alvo <= 0 || alvo >= 1) alvo = 0.8;

        const filtros = ['excluida_em IS NULL', 'hora_chegada IS NOT NULL'];
        const params = [];
        if (de) { params.push(de); filtros.push(`data_ocorrencia >= $${params.length}`); }
        if (ate) { params.push(ate); filtros.push(`data_ocorrencia <= $${params.length}`); }

        const result = await db.query(
            `SELECT loja, rota, data_ocorrencia, hora_chegada, inicio_descarga,
                    fim_descarga, hora_agendada_loja, hora_saida_fabrica, descricao
             FROM ocorrencias
             WHERE ${filtros.join(' AND ')}`,
            params
        );

        let saida = agendamentoEngine.recomendacoesPorRota(result.rows, { alvo });

        // filtro opcional por rota (o front envia o nome canônico recebido
        // deste mesmo endpoint, então a comparação direta basta).
        if (rota && String(rota).trim()) {
            const alvoRota = String(rota).trim();
            saida = { ...saida, rotas: saida.rotas.filter((r) => r.rota === alvoRota) };
        }

        res.status(200).json(saida);
    } catch (err) {
        console.error('[GET /agendamento/recomendacoes]', err);
        res.status(500).json({ error: 'Erro ao calcular recomendações de agendamento.', detalhe: err.message });
    }
});

// GET lista (cabecalhos + qtd de paradas + total de km)
app.get('/roteiros', async (req, res) => {
    try {
        const r = await db.query(`
            SELECT rp.*,
                   COUNT(pp.id)::int AS qtd_paradas,
                   COALESCE(SUM(pp.km), 0) AS total_km
            FROM roteiros_padrao rp
            LEFT JOIN roteiros_padrao_paradas pp ON pp.roteiro_id = rp.id
            GROUP BY rp.id
            ORDER BY rp.rota_nome
        `);
        res.status(200).json(r.rows);
    } catch (err) {
        console.error('[GET /roteiros]', err);
        res.status(500).json({ error: err.message });
    }
});

// GET um roteiro completo (com paradas ordenadas)
app.get('/roteiros/:id', async (req, res) => {
    try {
        const roteiro = await roteiroComParadas(req.params.id);
        if (!roteiro) return res.status(404).json({ error: 'Roteiro nao encontrado.' });
        res.status(200).json(roteiro);
    } catch (err) {
        console.error('[GET /roteiros/:id]', err);
        res.status(500).json({ error: err.message });
    }
});

// POST cria roteiro + paradas (transacao)
app.post('/roteiros', async (req, res) => {
    const client = await db.connect();
    try {
        const body = req.body || {};
        const rotaNome = String(body.rota_nome || '').trim();
        if (!rotaNome) return res.status(400).json({ error: 'Informe o nome da rota.' });
        const paradas = montarParadasRoteiro(body.paradas);

        await client.query('BEGIN');
        const ins = await client.query(`
            INSERT INTO roteiros_padrao (rota_nome, descricao, dia_semana, hora_saida_fabrica, ativo)
            VALUES ($1, $2, $3, $4, COALESCE($5, TRUE))
            RETURNING *
        `, [
            rotaNome,
            vazioParaNull(body.descricao),
            vazioParaNull(body.dia_semana),
            vazioParaNull(body.hora_saida_fabrica),
            body.ativo === undefined ? null : textoParaBoolean(body.ativo)
        ]);
        const roteiro = ins.rows[0];
        await gravarParadasRoteiro(client, roteiro.id, paradas);
        await client.query('COMMIT');
        await registrarAuditoria(req, 'POST', 'roteiros_padrao', roteiro.id, { rota_nome: rotaNome, paradas: paradas.length });
        res.status(201).json(await roteiroComParadas(roteiro.id));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[POST /roteiros]', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// PUT atualiza roteiro + substitui as paradas (transacao)
app.put('/roteiros/:id', async (req, res) => {
    const client = await db.connect();
    try {
        const id = Number(req.params.id);
        const body = req.body || {};
        const rotaNome = String(body.rota_nome || '').trim();
        if (!rotaNome) return res.status(400).json({ error: 'Informe o nome da rota.' });
        const paradas = montarParadasRoteiro(body.paradas);

        await client.query('BEGIN');
        const upd = await client.query(`
            UPDATE roteiros_padrao SET
                rota_nome = $1, descricao = $2, dia_semana = $3,
                hora_saida_fabrica = $4,
                ativo = COALESCE($5, ativo),
                atualizado_em = NOW()
            WHERE id = $6
            RETURNING *
        `, [
            rotaNome,
            vazioParaNull(body.descricao),
            vazioParaNull(body.dia_semana),
            vazioParaNull(body.hora_saida_fabrica),
            body.ativo === undefined ? null : textoParaBoolean(body.ativo),
            id
        ]);
        if (upd.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Roteiro nao encontrado.' });
        }
        await client.query('DELETE FROM roteiros_padrao_paradas WHERE roteiro_id = $1', [id]);
        await gravarParadasRoteiro(client, id, paradas);
        await client.query('COMMIT');
        await registrarAuditoria(req, 'PUT', 'roteiros_padrao', id, { rota_nome: rotaNome, paradas: paradas.length });
        res.status(200).json(await roteiroComParadas(id));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[PUT /roteiros/:id]', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// DELETE roteiro (cascade remove as paradas)
app.delete('/roteiros/:id', async (req, res) => {
    try {
        const r = await db.query('DELETE FROM roteiros_padrao WHERE id = $1 RETURNING *', [req.params.id]);
        if (r.rowCount === 0) return res.status(404).json({ error: 'Roteiro nao encontrado.' });
        await registrarAuditoria(req, 'DELETE', 'roteiros_padrao', req.params.id, {});
        res.status(200).json({ deleted: r.rows[0] });
    } catch (err) {
        console.error('[DELETE /roteiros/:id]', err);
        res.status(500).json({ error: err.message });
    }
});

// ================================================================
// TMS - CADASTROS, VIAGENS E PARADAS
// ================================================================

const cadastrosTms = {
    motoristas: {
        tabela: 'tms_motoristas',
        campos: ['nome', 'cnh', 'telefone', 'ativo'],
        obrigatorio: 'nome'
    },
    veiculos: {
        tabela: 'tms_veiculos',
        campos: ['placa', 'modelo', 'capacidade_volumes', 'status'],
        obrigatorio: 'placa'
    },
    rotas: {
        tabela: 'tms_rotas',
        campos: ['nome', 'descricao', 'ativo'],
        obrigatorio: 'nome'
    },
    lojas: {
        tabela: 'tms_lojas',
        campos: ['codigo', 'nome', 'rota_id', 'endereco', 'janela_recebimento', 'ativo'],
        obrigatorio: 'nome'
    }
};

function dadosCadastroTms(config, body) {
    return Object.fromEntries(config.campos.map((campo) => {
        let valor = body[campo];
        if (campo === 'ativo') valor = valor === undefined ? true : textoParaBoolean(valor);
        if (campo === 'status' && config.tabela === 'tms_veiculos' && !valor) valor = 'Disponivel';
        if (campo === 'capacidade_volumes' && valor !== undefined && valor !== '') valor = Number(valor);
        return [campo, vazioParaNull(valor)];
    }));
}

Object.entries(cadastrosTms).forEach(([recurso, config]) => {
    app.get(`/tms/${recurso}`, async (req, res) => {
        try {
            const result = await db.query(`SELECT * FROM ${config.tabela} ORDER BY id DESC`);
            res.status(200).json(result.rows);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post(`/tms/${recurso}`, async (req, res) => {
        try {
            if (!vazioParaNull(req.body[config.obrigatorio])) {
                return res.status(400).json({ error: `${config.obrigatorio} e obrigatorio.` });
            }
            const salvo = await inserirComColunasExistentes(config.tabela, dadosCadastroTms(config, req.body));
            res.status(201).json(salvo);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.put(`/tms/${recurso}/:id`, async (req, res) => {
        try {
            const result = await atualizarComColunasExistentes(
                config.tabela,
                req.params.id,
                dadosCadastroTms(config, req.body)
            );
            if (result.rowCount === 0) return res.status(404).json({ error: 'Cadastro nao encontrado.' });
            res.status(200).json(result.rows[0]);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.delete(`/tms/${recurso}/:id`, async (req, res) => {
        try {
            const result = await db.query(`DELETE FROM ${config.tabela} WHERE id = $1 RETURNING *`, [req.params.id]);
            if (result.rowCount === 0) return res.status(404).json({ error: 'Cadastro nao encontrado.' });
            res.status(200).json({ deleted: result.rows[0] });
        } catch (err) {
            res.status(409).json({ error: 'Cadastro esta em uso ou nao pode ser excluido.', detalhe: err.message });
        }
    });
});

// De-para de frete (ida/retorno) por loja, indexado pelo nome canonico.
// Nao da para fazer esse JOIN em SQL: a parada guarda so o NOME da loja
// (loja_id vem nulo do Checklist) e o mesmo nome aparece em varias grafias,
// entao a chave precisa passar pelo chaveLoja do normalizar-loja.js.
async function mapaFretesLoja() {
    try {
        const r = await db.query('SELECT chave, frete_envio, frete_retorno, na_conta FROM tms_fretes_loja');
        return new Map(r.rows.map((f) => [f.chave, f]));
    } catch (err) {
        // Tabela ainda nao criada/populada: a tela segue funcionando sem o valor.
        console.error('[tms_fretes_loja] nao foi possivel ler a tabela de frete:', err.message);
        return new Map();
    }
}

// Preenche tms_paradas.loja_id das paradas de uma viagem a partir do loja_nome
// que acabou de ser gravado.
//
// Fica FORA do INSERT de proposito: os quatro pontos que criam parada usam
// parametros posicionais, e acrescentar uma coluna em cada um deles e o jeito
// classico de gravar na coluna errada sem ninguem perceber. Aqui o diff em
// cada ponto e uma linha so.
//
// Usa chaveLoja() — o MESMO de-para do resto do sistema (normalizar-loja.js).
// Se usasse outra regra, a gravacao discordaria do que a tela mostra.
// Loja sem correspondente fica NULL: parada sem vinculo e melhor que parada
// vinculada a loja errada.
async function preencherLojaIdDaViagem(client, viagemId) {
    const { rows } = await client.query(
        'SELECT id, loja_nome FROM tms_paradas WHERE viagem_id = $1 AND loja_id IS NULL',
        [viagemId]);
    if (!rows.length) return 0;

    const lojas = (await client.query('SELECT id, codigo, nome FROM tms_lojas')).rows;
    const porChave = new Map(lojas.map((l) => [chaveLoja(l.codigo || l.nome), l.id]));

    let ligadas = 0;
    for (const parada of rows) {
        const lojaId = porChave.get(chaveLoja(parada.loja_nome));
        if (!lojaId) continue;
        await client.query('UPDATE tms_paradas SET loja_id = $1 WHERE id = $2', [lojaId, parada.id]);
        ligadas += 1;
    }
    return ligadas;
}

// opcoes.pernoite: alem das viagens do dia, traz a viagem de ROTA DE VIAGEM
// de dia(s) anterior(es) que ainda tem loja pendente — o caminhao dormiu fora
// e esta fazendo o resto hoje (back/pernoite.js). Vem com continua_pernoite.
async function buscarViagensTms(data, opcoes = {}) {
    const comPernoite = !!(data && opcoes.pernoite);
    const filtro = !data ? '' : !comPernoite ? 'WHERE v.data_viagem = $1' : `
        WHERE v.data_viagem = $1::date
           OR (v.data_viagem < $1::date AND v.data_viagem >= $1::date - $2::int
               AND v.status NOT IN ('Finalizada', 'Cancelada') AND v.retorno_real IS NULL
               AND ${pernoite.sqlEhRotaViagem('COALESCE(v.rota_nome, r.nome)')}
               AND (EXISTS (
                   SELECT 1 FROM tms_paradas pp
                    WHERE pp.viagem_id = v.id AND pp.ocorrencia_id IS NULL
                      AND pp.status NOT IN ('Entregue','Entregue com ocorrencia','Recusada','Ocorrencia')
                      AND NOT EXISTS (SELECT 1 FROM ocorrencias oo WHERE oo.parada_id = pp.id AND oo.excluida_em IS NULL))
                    -- lojas todas feitas, mas dormiu fora e ainda nao voltou: o 🏁 Voltou e hoje
                    OR (v.saida_real IS NOT NULL AND (v.hotel_chegada IS NOT NULL OR v.hotel_saida IS NOT NULL
                        OR EXISTS (SELECT 1 FROM ocorrencias od WHERE od.viagem_id = v.id AND od.dia_seguinte AND od.excluida_em IS NULL)))))`;
    const valores = !data ? [] : comPernoite ? [data, pernoite.DIAS_CONTINUA] : [data];
    const viagens = await db.query(`
        SELECT v.*,
               ${data ? '(v.data_viagem <> $1::date)' : 'FALSE'} AS continua_pernoite,
               to_char(v.data_viagem, 'YYYY-MM-DD') AS data_viagem,
               COALESCE(v.rota_nome, r.nome) AS rota_nome,
               COALESCE(v.motorista_nome, m.nome) AS motorista_nome,
               COALESCE(v.placa, ve.placa) AS placa
        FROM tms_viagens v
        LEFT JOIN tms_rotas r ON r.id = v.rota_id
        LEFT JOIN tms_motoristas m ON m.id = v.motorista_id
        LEFT JOIN tms_veiculos ve ON ve.id = v.veiculo_id
        ${filtro}
        ORDER BY v.data_viagem DESC, v.id DESC
    `, valores);

    if (viagens.rowCount === 0) return [];
    const ids = viagens.rows.map((viagem) => viagem.id);
    const paradas = await db.query(`
        SELECT p.*,
               COALESCE(p.loja_nome, l.nome) AS loja_nome,
               l.codigo AS loja_codigo,
               o.id AS ocorrencia_id,
               o.teve_ocorrencia AS ocorrencia_teve_problema,
               o.tipo_problema AS ocorrencia_tipo,
               o.descricao AS ocorrencia_descricao,
               o.ocorrencia_status AS ocorrencia_status,
               o.ocorrencia_severidade AS ocorrencia_severidade,
               o.volume_fisico AS ocorrencia_volume_fisico,
               o.volume_gerencial AS ocorrencia_volume_gerencial,
               o.sacola_qtd AS ocorrencia_sacola_qtd,
               o.sacola_p AS ocorrencia_sacola_p,
               o.sacola_m AS ocorrencia_sacola_m,
               o.sacola_g AS ocorrencia_sacola_g,
               to_char(o.hora_saida_fabrica, 'HH24:MI') AS ocorrencia_saida_fabrica,
               to_char(o.inicio_descarga, 'HH24:MI') AS ocorrencia_inicio_descarga,
               to_char(o.termino_descarga, 'HH24:MI') AS ocorrencia_termino_descarga,
               to_char(o.hora_chegada, 'HH24:MI') AS ocorrencia_hora_chegada,
               to_char(o.fim_descarga, 'HH24:MI') AS ocorrencia_saida_loja,
               o.dia_seguinte AS ocorrencia_dia_seguinte
        FROM tms_paradas p
        LEFT JOIN tms_lojas l ON l.id = p.loja_id
        LEFT JOIN LATERAL (
            SELECT oc.*
            FROM ocorrencias oc
            WHERE (oc.id = p.ocorrencia_id OR oc.parada_id = p.id)
              AND oc.excluida_em IS NULL
            ORDER BY (oc.id = p.ocorrencia_id) DESC, oc.id DESC
            LIMIT 1
        ) o ON TRUE
        WHERE p.viagem_id = ANY($1::int[])
        ORDER BY p.viagem_id, p.ordem, p.id
    `, [ids]);

    const fretes = await mapaFretesLoja();
    const paradasComFrete = paradas.rows.map((parada) => {
        const frete = fretes.get(chaveLoja(parada.loja_nome));
        return {
            ...parada,
            frete_envio: frete ? frete.frete_envio : null,
            frete_retorno: frete ? frete.frete_retorno : null,
            // false = fora da conta de proposito; true = tem (ou deveria ter) preco.
            frete_na_conta: frete ? frete.na_conta !== false : true
        };
    });

    const resultado = viagens.rows.map((viagem) => ({
        ...viagem,
        paradas: paradasComFrete.filter((parada) => parada.viagem_id === viagem.id)
    }));
    // PES/EMP da loja, horario previsto vindo do cadastro (so quando a parada
    // nao tem), km previsto da viagem e frete calculado pelo tipo do caminhao.
    const idxLojas = await lojasPes.carregarIndice(db);
    lojasPes.enriquecerViagens(resultado, idxLojas);
    // Lojas por onde o GPS ja viu o caminhao passar (gps_chegou_em/gps_saiu_em
    // por parada, saida/volta da fabrica por viagem). Vem antes da previsao:
    // para ROTEIRO (proxima, ETA, avisos) loja visitada conta como feita, mesmo
    // sem o registro lancado — back/rastreador-ao-vivo.js anexarVisitas.
    try { await rastreadorAoVivo.anexarVisitas(db, resultado); }
    catch (err) { console.error('[gps visitas]', err.message); }
    // Posicao do caminhao agora (rastreador, pela placa) — antes da previsao,
    // que parte dela quando esta fresca.
    let coordsLojas = null;
    if (rastreador.configurado()) {
        try {
            await rastreador.anexarEmViagens(db, resultado);
            coordsLojas = await rastreador.coordenadas(db);
        } catch (err) { console.error('[rastreador] viagens:', err.message); }
    }
    // Previsao de chegada nas lojas pendentes (so viagens de hoje ja saidas).
    if (idxLojas) {
        try {
            const tempos = await previsaoTms.carregarTempos(db, idxLojas);
            previsaoTms.preverViagens(resultado, idxLojas, { ...tempos, coordenadas: coordsLojas });
        } catch (err) {
            console.error('[previsao-tms]', err.message);
        }
    }
    return resultado;
}

// Material a ENVIAR / RETIRAR numa loja num dia, da planilha "RETIRADA E ENVIO
// DE MATERIAL" (back/materiais-rota.js). Mostrado no formulario de ocorrencia.
// A loja casa pelo cadastro de lojas/PES ("Bangu 4" = "BANGU IV").
app.get('/materiais-rota', async (req, res) => {
    const data = String(req.query.data || '').slice(0, 10);
    const loja = String(req.query.loja || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !loja) {
        return res.status(400).json({ error: 'Informe data (AAAA-MM-DD) e loja.' });
    }
    try {
        // Itens do dia (com marcacao foi/nao foi/pendente) + o que ficou de visitas anteriores.
        res.status(200).json(await materialStatus.materialDaLoja(data, loja));
    } catch (err) {
        res.status(502).json({ error: `Não consegui ler a planilha de envio e retirada: ${err.message}` });
    }
});

// Material de VARIAS lojas num dia (capa da frente e card do TMS): ?data=&lojas=A|B|C
// (ate 40). `resumo` traz so as contagens; ?completo=1 traz os itens.
app.get('/materiais-rota/lojas', async (req, res) => {
    const data = String(req.query.data || '').slice(0, 10);
    const lojas = [...new Set(String(req.query.lojas || '').split('|').map((x) => x.trim()).filter(Boolean))].slice(0, 40);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !lojas.length) {
        return res.status(400).json({ error: 'Informe data (AAAA-MM-DD) e lojas.' });
    }
    const completo = req.query.completo === '1';
    const porLoja = {};
    try {
        for (const loja of lojas) {
            const m = await materialStatus.materialDaLoja(data, loja);
            porLoja[loja] = completo ? { ...m, resumo: materialStatus.resumir(m) } : { loja: m.loja, resumo: materialStatus.resumir(m) };
        }
        res.json({ data, lojas: porLoja });
    } catch (err) {
        res.status(502).json({ error: `Não consegui ler a planilha de envio e retirada: ${err.message}` });
    }
});

// Relatorio "material foi ou nao foi" num periodo: cada item da planilha com a
// situacao (conferencia da loja na ocorrencia > status escrito na planilha).
app.get('/materiais-rota/relatorio', async (req, res) => {
    const de = String(req.query.de || '').slice(0, 10);
    const ate = String(req.query.ate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate) || de > ate) {
        return res.status(400).json({ error: 'Informe o período (de/até em AAAA-MM-DD).' });
    }
    if ((new Date(ate) - new Date(de)) / 86400000 > 92) {
        return res.status(400).json({ error: 'Período máximo de 3 meses.' });
    }
    try {
        const r = await materialStatus.relatorioPeriodo(de, ate, { incluirAnteriores: req.query.anteriores !== '0' });
        res.status(200).json({ de, ate, ...r });
    } catch (err) {
        console.error('[GET /materiais-rota/relatorio]', err.message);
        res.status(502).json({ error: `Não consegui montar o relatório de material: ${err.message}` });
    }
});

// Marca UM item da planilha de material: foi ('ok') / nao foi ('nao') /
// pendente; status vazio desmarca. Atualiza sozinho a planilha
// "STATUS DO MATERIAL - <MES>" no OnlyOffice (back/material-status.js).
app.put('/materiais-rota/item', async (req, res) => {
    try {
        const r = await materialStatus.marcar(req.body, req.usuarioLogado);
        await registrarAuditoria(req, 'MATERIAL_ITEM_STATUS', 'material_item_status', r.chave, {
            status: req.body?.status || null, material: req.body?.material, loja: req.body?.loja, data: req.body?.data,
        });
        res.json(r);
    } catch (err) {
        if ([400, 409].includes(err.status)) return res.status(err.status).json({ error: err.message });
        console.error('[PUT /materiais-rota/item]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Estado da planilha de status no OnlyOffice + "atualizar agora" (ADM).
app.get('/materiais-rota/status-planilha', (req, res) => res.json(materialStatus.estado()));
app.post('/materiais-rota/status-planilha/sincronizar', async (req, res) => {
    try {
        if (!materialStatus.estado().ativo) {
            return res.status(409).json({ error: 'Envio ao OnlyOffice desligado (MATERIAL_STATUS_ONLYOFFICE=1 no .env liga).' });
        }
        const hoje = new Date();
        const r = await materialStatus.sincronizarMes(hoje.getFullYear(), hoje.getMonth() + 1, { forcar: true });
        await registrarAuditoria(req, 'MATERIAL_STATUS_SINCRONIZAR', 'material_item_status', null, r);
        res.json(r);
    } catch (err) {
        console.error('[material-status sincronizar]', err.message);
        res.status(502).json({ error: err.message });
    }
});

// Relatorio semanal (back/relatorio-semanal.js): lista, download e "gerar agora".
app.get('/relatorio-semanal', async (req, res) => {
    try {
        res.json({ arquivos: await relatorioSemanal.listar(), proxima: relatorioSemanal.semanaAnterior() });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/relatorio-semanal/arquivo/:nome', (req, res) => {
    const caminho = relatorioSemanal.caminhoArquivo(req.params.nome);
    if (!caminho || !fs.existsSync(caminho)) return res.status(404).json({ error: 'Relatório não encontrado.' });
    res.download(caminho, req.params.nome);
});

// Gera agora (ADM): semana anterior por padrao, ou de/ate (ate 31 dias).
app.post('/relatorio-semanal/gerar', async (req, res) => {
    try {
        let periodo = relatorioSemanal.semanaAnterior();
        const de = String(req.body?.de || '').slice(0, 10), ate = String(req.body?.ate || '').slice(0, 10);
        if (de || ate) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate) || de > ate
                || (new Date(ate) - new Date(de)) / 86400000 > 31) {
                return res.status(400).json({ error: 'Período inválido (de/até em AAAA-MM-DD, no máximo 31 dias).' });
            }
            periodo = { de, ate };
        }
        const r = await relatorioSemanal.gerar({ db, materiaisRota, lojasPes, chaveLoja }, periodo);
        await registrarAuditoria(req, 'RELATORIO_SEMANAL_GERAR', 'relatorio-semanal', r.nome, { rede: !!r.rede, telegram: r.telegram });
        res.json(r);
    } catch (err) {
        console.error('[POST /relatorio-semanal/gerar]', err);
        res.status(500).json({ error: err.message });
    }
});

// "O time esta usando?" — botoes do ciclo e atraso do registro (back/uso-tms.js).
app.get('/tms/uso', async (req, res) => {
    try {
        const dias = Math.max(7, Math.min(90, Number(req.query.dias) || 30));
        res.status(200).json(await usoTms.montarUsoTms(db, dias));
    } catch (err) {
        console.error('[GET /tms/uso]', err);
        res.status(500).json({ error: err.message });
    }
});

// Cadastro unico de loja (PES) com km da fabrica e frete calculado por tipo de caminhao.
app.get('/tms/lojas-pes', async (req, res) => {
    try {
        const idx = await lojasPes.carregarIndice(db, { forcar: true });
        if (!idx) return res.status(200).json({ lojas: [], parametros: lojasPes.PARAMETROS_PADRAO, importado: false });
        const { ccd, cc } = idx.parametros;
        const lojas = idx.lojas.map((l) => {
            const km = idx.dist.get(`${lojasPes.FABRICA}|${l.codigo}`);
            const volta = idx.dist.get(`${l.codigo}|${lojasPes.FABRICA}`);
            const frete = {};
            if (km != null && l.na_conta) for (const t of Object.keys(cc)) frete[t] = Math.round((km * ccd + cc[t]) * 100) / 100;
            return { ...l, km_fabrica_loja: km ?? null, km_loja_fabrica: volta ?? null, frete };
        }).sort((a, b) => String(a.rota || '~').localeCompare(String(b.rota || '~')) || (a.ordem_rota || 0) - (b.ordem_rota || 0));
        res.status(200).json({ lojas, parametros: idx.parametros, rotulos: lojasPes.ROTULO_TIPO, importado: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Reimporta das planilhas da expedicao (ROTAS ATUALIZADAS, VALOR DE FRETE,
// GUIA EXPEDICAO). body: { dry: true } so confere.
app.post('/tms/lojas-pes/importar', async (req, res) => {
    const client = await db.connect();
    try {
        const dry = req.body?.dry === true || req.body?.dry === 'true';
        const r = await lojasPes.importar(client, { dry, log: () => {} });
        lojasPes.limparCacheIndice();
        if (!dry) await registrarAuditoria(req, 'IMPORTAR', 'lojas_pes', null, {
            lojas: r.relatorio.lojas, distancias: r.relatorio.distancias, carros: r.relatorio.carros,
        });
        res.status(200).json({ gravado: r.gravado, relatorio: r.relatorio });
    } catch (err) {
        console.error('[POST /tms/lojas-pes/importar]', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.get('/tms/viagens', async (req, res) => {
    try {
        res.status(200).json(await buscarViagensTms(req.query.data, { pernoite: req.query.pernoite === '1' }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/tms/viagens', async (req, res) => {
    const client = await db.connect();
    try {
        const body = req.body || {};
        const paradas = Array.isArray(body.paradas) ? body.paradas : [];
        if (!body.data_viagem || !body.motorista || !body.placa || paradas.length === 0) {
            return res.status(400).json({ error: 'Informe data, motorista, placa e ao menos uma parada.' });
        }

        await client.query('BEGIN');
        const viagemResult = await client.query(`
            INSERT INTO tms_viagens (
                data_viagem, motorista_nome, placa, rota_nome, ajudantes,
                volumes_previstos, material_campanha, sacola, status, observacao,
                sacola_p, sacola_m, sacola_g, responsavel_monitoramento,
                hora_saida_fabrica, km_previsto, km_real, custo_frete, custo_combustivel, pedagio, outros_custos
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Planejada', $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
            RETURNING *
        `, [
            body.data_viagem,
            body.motorista,
            body.placa,
            vazioParaNull(body.rota),
            vazioParaNull(body.ajudantes),
            vazioParaNull(body.volumes_previstos),
            vazioParaNull(body.material_campanha),
            vazioParaNull(body.sacola),
            vazioParaNull(body.observacao),
            vazioParaNull(body.sacola_p),
            vazioParaNull(body.sacola_m),
            vazioParaNull(body.sacola_g),
            vazioParaNull(body.responsavel_monitoramento),
            vazioParaNull(body.hora_saida_fabrica),
            vazioParaNull(body.km_previsto),
            vazioParaNull(body.km_real),
            vazioParaNull(body.custo_frete),
            vazioParaNull(body.custo_combustivel),
            vazioParaNull(body.pedagio),
            vazioParaNull(body.outros_custos)
        ]);
        const viagem = viagemResult.rows[0];
        const codigo = `V-${String(body.data_viagem).replaceAll('-', '')}-${String(viagem.id).padStart(5, '0')}`;
        await client.query('UPDATE tms_viagens SET codigo = $1 WHERE id = $2', [codigo, viagem.id]);

        for (let index = 0; index < paradas.length; index += 1) {
            const parada = paradas[index];
            if (!parada.loja) throw new Error('Toda parada precisa de uma loja.');
            await client.query(`
                INSERT INTO tms_paradas (
                    viagem_id, ordem, loja_nome, hora_prevista, volumes_previstos,
                    material_campanha, sacola, observacao,
                    sacola_p, sacola_m, sacola_g, prioridade, retirada_cx, retirada_rt
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            `, [
                viagem.id,
                index + 1,
                parada.loja,
                vazioParaNull(parada.hora_prevista),
                vazioParaNull(parada.volumes_previstos),
                vazioParaNull(parada.material_campanha),
                vazioParaNull(parada.sacola),
                vazioParaNull(parada.observacao),
                vazioParaNull(parada.sacola_p),
                vazioParaNull(parada.sacola_m),
                vazioParaNull(parada.sacola_g),
                Math.min(4, Math.max(1, Number(parada.prioridade) || 2)),
                Math.max(0, Number(parada.retirada_cx) || 0),
                Math.max(0, Number(parada.retirada_rt) || 0)
            ]);
        }

        await preencherLojaIdDaViagem(client, viagem.id);

        await client.query('COMMIT');
        const viagemCriada = (await buscarViagensTms()).find((item) => item.id === viagem.id);
        await registrarAuditoria(req, 'POST', 'tms_viagens', viagem.id, { motorista: body.motorista, placa: body.placa, data_viagem: body.data_viagem });
        res.status(201).json(viagemCriada);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.put('/tms/viagens/:id', async (req, res) => {
    const client = await db.connect();
    try {
        const id = Number(req.params.id);
        const body = req.body || {};
        const paradas = Array.isArray(body.paradas) ? body.paradas : [];
        if (!id || !body.data_viagem || !body.motorista || !body.placa || paradas.length === 0) {
            return res.status(400).json({ error: 'Informe data, motorista, placa e ao menos uma parada.' });
        }

        await client.query('BEGIN');
        const atual = await client.query('SELECT * FROM tms_viagens WHERE id = $1 FOR UPDATE', [id]);
        if (atual.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Viagem nao encontrada.' });
        }

        const codigo = `V-${String(body.data_viagem).replaceAll('-', '')}-${String(id).padStart(5, '0')}`;
        await client.query(`
            UPDATE tms_viagens SET
                codigo = $1,
                data_viagem = $2,
                motorista_nome = $3,
                placa = $4,
                rota_nome = $5,
                ajudantes = $6,
                volumes_previstos = $7,
                material_campanha = $8,
                sacola = $9,
                observacao = $10,
                sacola_p = $12,
                sacola_m = $13,
                sacola_g = $14,
                responsavel_monitoramento = $15,
                hora_saida_fabrica = $16,
                km_previsto = $17,
                km_real = $18,
                custo_frete = $19,
                custo_combustivel = $20,
                pedagio = $21,
                outros_custos = $22,
                programacao = COALESCE(programacao, '{}'::jsonb) ||
                    jsonb_build_object('edicao_manual', jsonb_build_object('salva_em', NOW())),
                atualizado_em = NOW()
            WHERE id = $11
        `, [
            codigo,
            body.data_viagem,
            body.motorista,
            body.placa,
            vazioParaNull(body.rota),
            vazioParaNull(body.ajudantes),
            vazioParaNull(body.volumes_previstos),
            vazioParaNull(body.material_campanha),
            vazioParaNull(body.sacola),
            vazioParaNull(body.observacao),
            id,
            vazioParaNull(body.sacola_p),
            vazioParaNull(body.sacola_m),
            vazioParaNull(body.sacola_g),
            vazioParaNull(body.responsavel_monitoramento),
            vazioParaNull(body.hora_saida_fabrica),
            vazioParaNull(body.km_previsto),
            vazioParaNull(body.km_real),
            vazioParaNull(body.custo_frete),
            vazioParaNull(body.custo_combustivel),
            vazioParaNull(body.pedagio),
            vazioParaNull(body.outros_custos)
        ]);

        const existentes = await client.query(`
            SELECT p.id, p.ocorrencia_id,
                   EXISTS (SELECT 1 FROM ocorrencias o WHERE o.parada_id = p.id AND o.excluida_em IS NULL) AS possui_ocorrencia
            FROM tms_paradas p
            WHERE p.viagem_id = $1
        `, [id]);
        const idsExistentes = new Set(existentes.rows.map((parada) => parada.id));
        const idsRecebidos = new Set();

        for (let index = 0; index < paradas.length; index += 1) {
            const parada = paradas[index];
            if (!parada.loja) throw new Error('Toda parada precisa de uma loja.');
            const paradaId = Number(parada.id) || null;
            if (paradaId) {
                if (!idsExistentes.has(paradaId)) throw new Error('Parada invalida para esta viagem.');
                if (idsRecebidos.has(paradaId)) throw new Error('Parada duplicada na edicao.');
                idsRecebidos.add(paradaId);
                await client.query(`
                    UPDATE tms_paradas SET
                        ordem = $1,
                        loja_id = CASE WHEN loja_nome IS DISTINCT FROM $2 THEN NULL ELSE loja_id END,
                        programacao = CASE WHEN loja_nome IS DISTINCT FROM $2
                            THEN COALESCE(programacao, '{}'::jsonb) - 'pes' - 'saiu_do_checklist'
                            ELSE programacao END,
                        loja_nome = $2,
                        hora_prevista = $3,
                        volumes_previstos = $4,
                        material_campanha = $5,
                        sacola = $6,
                        observacao = CASE WHEN $16 THEN $7 ELSE observacao END,
                        sacola_p = $10,
                        sacola_m = $11,
                        sacola_g = $12,
                        prioridade = $13,
                        retirada_cx = $14,
                        retirada_rt = $15,
                        atualizado_em = NOW()
                    WHERE id = $8 AND viagem_id = $9
                `, [
                    index + 1,
                    parada.loja,
                    vazioParaNull(parada.hora_prevista),
                    vazioParaNull(parada.volumes_previstos),
                    vazioParaNull(parada.material_campanha),
                    vazioParaNull(parada.sacola),
                    vazioParaNull(parada.observacao),
                    paradaId,
                    id,
                    vazioParaNull(parada.sacola_p),
                    vazioParaNull(parada.sacola_m),
                    vazioParaNull(parada.sacola_g),
                    Math.min(4, Math.max(1, Number(parada.prioridade) || 2)),
                    Math.max(0, Number(parada.retirada_cx) || 0),
                    Math.max(0, Number(parada.retirada_rt) || 0),
                    Object.prototype.hasOwnProperty.call(parada, 'observacao')
                ]);
            } else {
                await client.query(`
                    INSERT INTO tms_paradas (
                        viagem_id, ordem, loja_nome, hora_prevista, volumes_previstos,
                        material_campanha, sacola, observacao,
                        sacola_p, sacola_m, sacola_g, prioridade, retirada_cx, retirada_rt
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                `, [
                    id,
                    index + 1,
                    parada.loja,
                    vazioParaNull(parada.hora_prevista),
                    vazioParaNull(parada.volumes_previstos),
                    vazioParaNull(parada.material_campanha),
                    vazioParaNull(parada.sacola),
                    vazioParaNull(parada.observacao),
                    vazioParaNull(parada.sacola_p),
                    vazioParaNull(parada.sacola_m),
                    vazioParaNull(parada.sacola_g),
                    Math.min(4, Math.max(1, Number(parada.prioridade) || 2)),
                    Math.max(0, Number(parada.retirada_cx) || 0),
                    Math.max(0, Number(parada.retirada_rt) || 0)
                ]);
            }
        }

        const removidas = existentes.rows.filter((parada) => !idsRecebidos.has(parada.id));
        if (removidas.some((parada) => parada.ocorrencia_id || parada.possui_ocorrencia)) {
            throw new Error('Nao e possivel remover uma parada que possui registro de ocorrencia.');
        }
        const idsRemover = removidas.map((parada) => parada.id);
        if (idsRemover.length) {
            await client.query('DELETE FROM tms_paradas WHERE viagem_id = $1 AND id = ANY($2::int[])', [id, idsRemover]);
        }

        await preencherLojaIdDaViagem(client, id);

        await client.query('COMMIT');
        const viagemAtualizada = (await buscarViagensTms()).find((item) => item.id === id);
        await registrarAuditoria(req, 'PUT', 'tms_viagens', id, {
            motorista: body.motorista,
            placa: body.placa,
            data_viagem: body.data_viagem
        });
        res.status(200).json(viagemAtualizada);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// ================= DIVIDIR VIAGEM =================
// Separa uma viagem em DUAS OU MAIS, repartindo as paradas que ja existem.
// O grupo 1 fica na viagem original (mantem id, codigo, custos e km — ninguem
// sabe ratear custo sem chutar); cada grupo seguinte vira uma viagem nova, com
// motorista/placa/ajudantes proprios e custo/km em branco para o usuario
// preencher depois pelo "Editar" de sempre.
//
// As paradas NAO sao recriadas: so o viagem_id delas muda. Assim ocorrencia,
// remessas, pedidos, CTE, status e historico seguem junto com a parada. A
// ocorrencia ligada tem o viagem_id reapontado (senao o registro ficaria
// apontando para a viagem errada); motorista/placa da ocorrencia NAO sao
// tocados — eles sao o retrato de quem entregou de fato.
//
// Body: { grupos: [ { paradas: [id, ...] },                          <- grupo 1, fica
//                   { paradas: [...], motorista, placa, ajudantes,   <- viagem nova
//                     hora_saida_fabrica, responsavel_monitoramento,
//                     observacao, rota } ] }
// Toda parada da viagem precisa aparecer em EXATAMENTE um grupo; a ordem
// dentro da lista vira a ordem das paradas na viagem resultante.
app.post('/tms/viagens/:id/dividir', async (req, res) => {
    const client = await db.connect();
    // Erro de validacao -> 400 (culpa do pedido). Sem isto todo throw viraria
    // 500 e o usuario veria "erro interno" para um dado que ele pode corrigir.
    const erro400 = (msg) => Object.assign(new Error(msg), { statusCliente: 400 });
    try {
        const id = Number(req.params.id);
        const grupos = Array.isArray(req.body?.grupos) ? req.body.grupos : [];
        if (!id) throw erro400('Viagem invalida.');
        if (grupos.length < 2) throw erro400('Informe ao menos dois grupos: o que fica e o que vira viagem nova.');
        if (grupos.length > 6) throw erro400('Divida em no maximo 6 viagens de uma vez.');

        await client.query('BEGIN');
        const atual = await client.query(
            `SELECT *, to_char(data_viagem, 'YYYY-MM-DD') AS data_iso
               FROM tms_viagens WHERE id = $1 FOR UPDATE`, [id]);
        if (atual.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Viagem nao encontrada.' });
        }
        const viagem = atual.rows[0];

        const daViagem = await client.query('SELECT id FROM tms_paradas WHERE viagem_id = $1', [id]);
        const idsValidos = new Set(daViagem.rows.map((p) => p.id));
        if (idsValidos.size < 2) throw erro400('Viagem com menos de duas paradas nao tem como ser dividida.');

        // Toda parada em exatamente um grupo, nenhum grupo vazio. Sem esta
        // checagem daria para "perder" parada (nao vai pra lugar nenhum) ou
        // duplicar (dois UPDATEs no mesmo id, ultimo ganha, silenciosamente).
        const vistos = new Set();
        const listas = grupos.map((grupo, i) => {
            const lista = (Array.isArray(grupo?.paradas) ? grupo.paradas : [])
                .map(Number).filter((n) => Number.isInteger(n) && n > 0);
            if (!lista.length) throw erro400(`A viagem ${i + 1} ficou sem nenhuma parada.`);
            lista.forEach((pid) => {
                if (!idsValidos.has(pid)) throw erro400('Ha parada que nao pertence a esta viagem.');
                if (vistos.has(pid)) throw erro400('A mesma parada foi colocada em duas viagens.');
                vistos.add(pid);
            });
            return lista;
        });
        if (vistos.size !== idsValidos.size) throw erro400('Toda parada precisa ficar em alguma viagem.');

        // Reordena o grupo que fica (1..n) na sequencia escolhida.
        const reordenar = async (lista) => {
            for (let k = 0; k < lista.length; k += 1) {
                await client.query('UPDATE tms_paradas SET ordem = $1, atualizado_em = NOW() WHERE id = $2', [k + 1, lista[k]]);
            }
        };

        // Totais do cabecalho da viagem sao SOMA das paradas (o front ja faz
        // assim em tmsRecalcularTotais). Depois de mover paradas eles ficariam
        // mentindo, entao recalculamos dos dois lados.
        const recalcularTotais = async (viagemId) => {
            await client.query(`
                UPDATE tms_viagens v SET
                    volumes_previstos = t.volumes,
                    material_campanha = t.material,
                    sacola_p = t.p, sacola_m = t.m, sacola_g = t.g,
                    sacola = t.p + t.m + t.g,
                    atualizado_em = NOW()
                FROM (
                    SELECT COALESCE(SUM(volumes_previstos), 0) AS volumes,
                           COALESCE(SUM(material_campanha), 0) AS material,
                           COALESCE(SUM(sacola_p), 0) AS p,
                           COALESCE(SUM(sacola_m), 0) AS m,
                           COALESCE(SUM(sacola_g), 0) AS g
                      FROM tms_paradas WHERE viagem_id = $1
                ) t
                WHERE v.id = $1`, [viagemId]);
        };

        const criadas = [];
        for (let i = 1; i < grupos.length; i += 1) {
            const grupo = grupos[i] || {};
            const motorista = String(grupo.motorista || '').trim();
            const placa = String(grupo.placa || '').trim();
            if (!motorista || !placa) throw erro400(`Informe motorista e placa da viagem ${i + 1}.`);

            const nova = await client.query(`
                INSERT INTO tms_viagens (
                    data_viagem, motorista_nome, placa, rota_nome, ajudantes,
                    status, observacao, responsavel_monitoramento, hora_saida_fabrica
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                RETURNING id`, [
                viagem.data_iso,
                motorista,
                placa,
                vazioParaNull(grupo.rota) || viagem.rota_nome,
                vazioParaNull(grupo.ajudantes),
                // Herda o status: dividir uma viagem "Em rota" gera outra "Em
                // rota", nao uma "Planejada" que sumiria dos paineis do dia.
                viagem.status,
                vazioParaNull(grupo.observacao),
                vazioParaNull(grupo.responsavel_monitoramento) || viagem.responsavel_monitoramento,
                vazioParaNull(grupo.hora_saida_fabrica) || viagem.hora_saida_fabrica
            ]);
            const novaId = nova.rows[0].id;
            const codigo = `V-${String(viagem.data_iso).replaceAll('-', '')}-${String(novaId).padStart(5, '0')}`;
            await client.query('UPDATE tms_viagens SET codigo = $1 WHERE id = $2', [codigo, novaId]);

            await client.query(
                'UPDATE tms_paradas SET viagem_id = $1, atualizado_em = NOW() WHERE id = ANY($2::int[])',
                [novaId, listas[i]]);
            await reordenar(listas[i]);

            // Reaponta a ocorrencia da parada (as duas amarracoes possiveis:
            // ocorrencias.parada_id e tms_paradas.ocorrencia_id, que convivem).
            await client.query(`
                UPDATE ocorrencias o SET viagem_id = $1
                  FROM tms_paradas p
                 WHERE p.id = ANY($2::int[])
                   AND (o.parada_id = p.id OR o.id = p.ocorrencia_id)
                   AND o.excluida_em IS NULL`, [novaId, listas[i]]);

            await preencherLojaIdDaViagem(client, novaId);
            await recalcularTotais(novaId);
            criadas.push({ id: novaId, codigo, motorista, placa, paradas: listas[i].length });
        }

        await reordenar(listas[0]);
        await recalcularTotais(id);

        await client.query('COMMIT');
        await registrarAuditoria(req, 'DIVIDIR', 'tms_viagens', id, {
            codigo_origem: viagem.codigo,
            ficaram: listas[0].length,
            criadas
        });
        const todas = await buscarViagensTms();
        const alvo = new Set([id, ...criadas.map((c) => c.id)]);
        res.status(200).json({
            ok: true,
            origem: id,
            criadas,
            viagens: todas.filter((v) => alvo.has(v.id))
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (!err.statusCliente) console.error('[POST /tms/viagens/:id/dividir]', err);
        res.status(err.statusCliente || 500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// ================= MOVER LOJAS (ordem das paradas) =================
// Muda SO a sequencia das lojas da viagem (setas/arrastar no card do TMS), sem
// passar pelo PUT completo — que regrava todos os campos de todas as paradas.
// Body: { paradas: [id, ...] } com TODAS as paradas da viagem, cada uma uma
// vez, na ordem nova. Lista diferente da do banco = alguem mexeu na viagem
// enquanto isso; recusamos em vez de adivinhar onde encaixar o que sobrou.
// ETA, km e retorno previstos saem da ordem no proximo GET /tms/viagens.
app.put('/tms/viagens/:id/ordem', async (req, res) => {
    const client = await db.connect();
    const erro400 = (msg) => Object.assign(new Error(msg), { statusCliente: 400 });
    try {
        const id = Number(req.params.id);
        if (!id) throw erro400('Viagem invalida.');
        const lista = (Array.isArray(req.body?.paradas) ? req.body.paradas : []).map(Number);

        await client.query('BEGIN');
        const viagem = await client.query('SELECT id FROM tms_viagens WHERE id = $1 FOR UPDATE', [id]);
        if (viagem.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Viagem nao encontrada.' });
        }
        const atuais = await client.query(
            'SELECT id, loja_nome FROM tms_paradas WHERE viagem_id = $1 ORDER BY ordem, id', [id]);
        const validos = new Set(atuais.rows.map((p) => p.id));
        if (lista.length !== validos.size || new Set(lista).size !== lista.length
            || lista.some((pid) => !validos.has(pid))) {
            throw erro400('As lojas desta viagem mudaram enquanto voce mexia. Atualize o TMS e tente de novo.');
        }

        await client.query(`
            UPDATE tms_paradas p SET ordem = n.ordem, atualizado_em = NOW()
              FROM unnest($1::int[]) WITH ORDINALITY AS n(id, ordem)
             WHERE p.id = n.id AND p.viagem_id = $2 AND p.ordem IS DISTINCT FROM n.ordem`, [lista, id]);
        await client.query(`UPDATE tms_viagens SET atualizado_em = NOW(),
            programacao = COALESCE(programacao, '{}'::jsonb) || jsonb_build_object('ordem_manual', true)
            WHERE id = $1`, [id]);
        await client.query('COMMIT');

        const lojaPorId = new Map(atuais.rows.map((p) => [p.id, p.loja_nome]));
        await registrarAuditoria(req, 'REORDENAR', 'tms_viagens', id, {
            antes: atuais.rows.map((p) => p.loja_nome),
            depois: lista.map((pid) => lojaPorId.get(pid))
        });
        res.status(200).json({ ok: true, paradas: lista.map((pid, i) => ({ id: pid, ordem: i + 1 })) });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (!err.statusCliente) console.error('[PUT /tms/viagens/:id/ordem]', err);
        res.status(err.statusCliente || 500).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.delete('/tms/viagens/:id', async (req, res) => {
    try {
        const result = await db.query('DELETE FROM tms_viagens WHERE id = $1 RETURNING *', [req.params.id]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Viagem nao encontrada.' });
        await registrarAuditoria(req, 'DELETE', 'tms_viagens', req.params.id, {
            codigo: result.rows[0].codigo,
            data_viagem: result.rows[0].data_viagem
        });
        res.status(200).json({ deleted: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const statusViagemPermitidos = ['Planejada', 'Carregando', 'Liberada', 'Em rota', 'Retorno', 'Finalizada', 'Cancelada'];
const statusParadaPermitidos = ['Pendente', 'Em atendimento', 'Entregue', 'Entregue com ocorrencia', 'Recusada', 'Ocorrencia'];

function statusTmsCanonico(status, permitidos) {
    const normalizar = (valor) => String(valor || '')
        .trim()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .toLowerCase();
    const normalizado = normalizar(status);
    return permitidos.find((permitido) => normalizar(permitido) === normalizado) || null;
}

app.put('/tms/viagens/:id/status', async (req, res) => {
    try {
        const status = statusTmsCanonico(req.body.status, statusViagemPermitidos);
        if (!status) {
            return res.status(400).json({ error: 'Status de viagem invalido.' });
        }
        const result = await db.query(`
            UPDATE tms_viagens SET status = $1, atualizado_em = NOW()
            WHERE id = $2 RETURNING *
        `, [status, req.params.id]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Viagem nao encontrada.' });
        await registrarAuditoria(req, 'PUT_STATUS', 'tms_viagens', req.params.id, { status });
        res.status(200).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// "🚚 Saiu" do TMS: grava a saida REAL da fabrica com a hora do servidor (ou um
// horario corrigido em body.hora = 'HH:MM'). Uma acao so alimenta os 3 lugares
// que ja leem a saida, para ninguem redigitar nem copiar o horario marcado:
//   1. tms_viagens.saida_real (+ status "Em rota" se ainda nao tinha saido);
//   2. atrasos_saida — o registro "Saida de fabrica" do dia, de onde o
//      formulario de ocorrencia e a entrega rapida puxam a saida;
//   3. ocorrencias ja lancadas para as paradas desta viagem no mesmo dia.
const STATUS_ANTES_DA_SAIDA = ['Planejada', 'Carregando', 'Liberada'];
const placaSemMascara = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const PLACA_SQL = (col) => `regexp_replace(UPPER(COALESCE(${col}, '')), '[^A-Z0-9]', '', 'g')`;

// Com nome: o "Completar dias pendentes" do rastreador (rastreador-eventos.js)
// chama o mesmo caminho com req.origemInterna = 'rastreador' — nesse modo so
// PREENCHE o que esta vazio (saida do dia e das ocorrencias), nunca troca.
async function registrarSaidaFabrica(req, res) {
    const horaInformada = String(req.body?.hora || '').trim();
    const doRastreador = req.origemInterna === 'rastreador';
    if (horaInformada && !/^([01]\d|2[0-3]):[0-5]\d$/.test(horaInformada)) {
        return res.status(400).json({ error: 'Horario invalido (use HH:MM).' });
    }
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const v = await client.query(`
            SELECT v.id, to_char(v.data_viagem, 'YYYY-MM-DD') AS data_iso,
                   (v.data_viagem = CURRENT_DATE) AS eh_hoje,
                   COALESCE(v.motorista_nome, m.nome) AS motorista,
                   COALESCE(v.placa, ve.placa) AS placa,
                   COALESCE(v.rota_nome, r.nome) AS rota,
                   v.status, v.saida_real_origem, v.retorno_real,
                   to_char(v.saida_real, 'HH24:MI') AS saida_atual,
                   to_char(v.hora_saida_fabrica, 'HH24:MI') AS marcada,
                   to_char(LOCALTIME, 'HH24:MI') AS agora
              FROM tms_viagens v
              LEFT JOIN tms_rotas r ON r.id = v.rota_id
              LEFT JOIN tms_motoristas m ON m.id = v.motorista_id
              LEFT JOIN tms_veiculos ve ON ve.id = v.veiculo_id
             WHERE v.id = $1
               FOR UPDATE OF v`, [req.params.id]);
        if (v.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Viagem nao encontrada.' });
        }
        const viagem = v.rows[0];
        // A leitura travada protege contra ajuste manual entre o ciclo GPS e a gravacao.
        if (doRastreador) {
            const substituir = String(req.substituirHora || '');
            const podeCorrigir = substituir && viagem.saida_real_origem === 'rastreador'
                && viagem.saida_atual === substituir;
            const completarEncerrada = req.completarHorarioEncerrada === true && viagem.status === 'Finalizada' && !viagem.saida_atual && !substituir;
            if ((!completarEncerrada && (viagem.retorno_real || viagem.status === 'Finalizada')) || viagem.status === 'Cancelada'
                || (viagem.saida_atual && !podeCorrigir)
                || (substituir && !podeCorrigir)) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'A viagem ja foi ajustada ou encerrada; o GPS preservou o registro.' });
            }
        }
        if (!horaInformada && !viagem.eh_hoje) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Esta viagem nao e de hoje: informe o horario em que o carro saiu.' });
        }
        if (!String(viagem.motorista || '').trim()) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Viagem sem motorista: preencha o motorista antes de registrar a saida.' });
        }
        const hora = horaInformada || viagem.agora;
        const origem = doRastreador ? 'rastreador' : horaInformada ? 'ajuste' : 'botao';
        const placaNorm = placaSemMascara(viagem.placa);

        // 2. Registro "Saida de fabrica" do dia (mesmo match do front: data +
        //    motorista, preferindo a mesma placa).
        const existente = await client.query(`
            SELECT id, hora_marcada, hora_real FROM atrasos_saida
             WHERE data = $1 AND UPPER(TRIM(motorista)) = UPPER(TRIM($2))
               AND ($3 = '' OR ${PLACA_SQL('placa')} IN ($3, ''))
             ORDER BY (${PLACA_SQL('placa')} = $3) DESC, id DESC
             LIMIT 1`, [viagem.data_iso, viagem.motorista, placaNorm]);
        // Meta: a digitada no registro do dia prevalece; senao a da programacao.
        // 00:00 vem da planilha quando ela nao tinha horario — nao e meta.
        const marcadaTms = viagem.marcada && viagem.marcada !== '00:00' ? viagem.marcada : null;
        const marcada = String(existente.rows[0]?.hora_marcada || '').slice(0, 5) || marcadaTms;
        const paraMin = (h) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
        const atrasoMin = marcada ? Math.max(0, paraMin(hora) - paraMin(marcada)) : null;
        const atrasoFormatado = atrasoMin == null ? null
            : atrasoMin === 0 ? '0min'
            : atrasoMin >= 60 ? `${Math.floor(atrasoMin / 60)}h ${atrasoMin % 60}min` : `${atrasoMin}min`;

        let atrasoId;
        if (doRastreador && existente.rowCount && existente.rows[0].hora_real) {
            // Alguem ja lancou a saida real do dia: o rastreador nao troca.
            atrasoId = existente.rows[0].id;
        } else if (existente.rowCount) {
            atrasoId = existente.rows[0].id;
            await client.query(`
                UPDATE atrasos_saida SET hora_real = $1, hora_marcada = $2,
                       atraso_min = $3, atraso_formatado = $4,
                       placa = COALESCE(NULLIF(placa, ''), $5),
                       rota = COALESCE(NULLIF(rota, ''), $6)
                 WHERE id = $7`,
                [hora, marcada, atrasoMin, atrasoFormatado, viagem.placa, viagem.rota, atrasoId]);
        } else {
            atrasoId = Date.now() % 2147483647;
            await client.query(`
                INSERT INTO atrasos_saida (id, data, motorista, placa, rota, hora_marcada, hora_real, atraso_min, atraso_formatado)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [atrasoId, viagem.data_iso, viagem.motorista, viagem.placa, viagem.rota, marcada, hora, atrasoMin, atrasoFormatado]);
        }

        // 1. A propria viagem.
        const atualizada = await client.query(`
            UPDATE tms_viagens SET saida_real = $1, saida_real_em = NOW(), saida_real_por = $2,
                   saida_real_origem = $3,
                   status = CASE WHEN status = ANY($4::text[]) THEN 'Em rota' ELSE status END,
                   atualizado_em = NOW()
             WHERE id = $5 RETURNING *`,
            [hora, req.usuarioLogado?.nome || null, origem, STATUS_ANTES_DA_SAIDA, viagem.id]);

        // 3. Ocorrencias ja lancadas desta viagem (as duas amarracoes que
        //    convivem: ocorrencias.parada_id/viagem_id e tms_paradas.ocorrencia_id).
        //    So o dia da viagem: no 2o dia de pernoite a saida e do hotel.
        const ocs = await client.query(`
            UPDATE ocorrencias o SET hora_saida_fabrica = CASE WHEN $5::boolean THEN COALESCE(o.hora_saida_fabrica, $1::time) ELSE $1::time END,
                   hora_marcada_saida = COALESCE(o.hora_marcada_saida, $2::time)
             WHERE o.excluida_em IS NULL
               AND o.data_ocorrencia = $3::date
               AND (o.viagem_id = $4
                    OR o.parada_id IN (SELECT id FROM tms_paradas WHERE viagem_id = $4)
                    OR o.id IN (SELECT ocorrencia_id FROM tms_paradas
                                 WHERE viagem_id = $4 AND ocorrencia_id IS NOT NULL))
            RETURNING o.id`,
            [hora, marcada, viagem.data_iso, viagem.id, doRastreador]);

        await client.query('COMMIT');
        const ocorrenciaIds = ocs.rows.map((r) => r.id);
        await registrarAuditoria(req, 'SAIDA_FABRICA', 'tms_viagens', viagem.id, {
            hora, origem, marcada, atraso_min: atrasoMin, atrasos_saida_id: atrasoId, ocorrencias: ocorrenciaIds,
        });
        broadcastAuditoria('atrasos_saida');
        res.status(200).json({
            viagem: atualizada.rows[0], hora, marcada, atraso_min: atrasoMin,
            atrasos_saida_id: atrasoId, ocorrencias_atualizadas: ocorrenciaIds.length,
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[POST /tms/viagens/:id/saida]', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
}
app.post('/tms/viagens/:id/saida', registrarSaidaFabrica);

// 🧑 Chegou na fabrica e 🏁 Voltou (back/tms-ciclo.js).
const rotasCicloTms = tmsCiclo.criarRotas({ db, registrarAuditoria });
app.post('/tms/viagens/:id/chegada', rotasCicloTms.chegada);
app.post('/tms/viagens/:id/retorno', rotasCicloTms.retorno);
// 🏨 Pernoite (rota de viagem): equipe parou no hotel / saiu do hotel.
app.post('/tms/viagens/:id/hotel_chegada', rotasCicloTms.hotelChegada);
app.post('/tms/viagens/:id/hotel_saida', rotasCicloTms.hotelSaida);
app.put('/tms/viagens/:id/lacre', rotasCicloTms.lacre);

// 🛰 Rastreador (back/rastreador.js): frota agora + coordenadas aprendidas.
const rotasRastreador = rastreador.criarRotas({ db });
app.get('/tms/rastreador/posicoes', rotasRastreador.posicoes);
app.get('/tms/rastreador/lojas', rotasRastreador.lojas);
// Consultas da API T4S: passam pelo login e pela permissao de leitura da Frota.
const rotasT4sApi = require('./t4s-api-rotas').criar({ rastreador });
app.get('/frota/t4s/status', rotasT4sApi.status);
app.get('/frota/t4s/rotas', rotasT4sApi.rotas);
app.get('/frota/t4s/alertas', rotasT4sApi.alertas);
app.get('/frota/t4s/status-alertas', rotasT4sApi.statusAlertas);
// T4S: trocar o login pela tela (cola os cookies do navegador; testa antes de
// adotar, vale na hora, sem restart). ADM: fora da whitelist do OPERADOR.
app.get('/tms/rastreador/t4s-sessao', (req, res) => res.json(require('./rastreador-t4s').infoSessao()));
app.post('/tms/rastreador/t4s-reconectar', async (req, res) => {
    try {
        const quem = req.usuarioLogado?.usuario || req.usuarioLogado?.nome || '';
        const r = await require('./rastreador-t4s').reconectar(req.body?.cookie, quem);
        await registrarAuditoria(req, 'RECONECTAR', 'rastreador_t4s', null, { aparelhos: r.aparelhos });
        res.json({ ok: true, ...r });
    } catch (err) {
        if (!err.statusCliente) console.error('[POST /tms/rastreador/t4s-reconectar]', err.message);
        res.status(err.statusCliente || 500).json({ error: err.message });
    }
});
// Sat (Satfleet, 3a fonte): mesmo esquema do T4S — cola o cookie do navegador,
// testa antes de adotar, vale na hora sem restart.
app.get('/tms/rastreador/sat-sessao', (req, res) => res.json(require('./rastreador-satfleet').infoSessao()));
app.post('/tms/rastreador/sat-reconectar', async (req, res) => {
    try {
        const quem = req.usuarioLogado?.usuario || req.usuarioLogado?.nome || '';
        const r = await require('./rastreador-satfleet').reconectar(req.body?.cookie, quem);
        await registrarAuditoria(req, 'RECONECTAR', 'rastreador_sat', null, { aparelhos: r.aparelhos });
        res.json({ ok: true, ...r });
    } catch (err) {
        if (!err.statusCliente) console.error('[POST /tms/rastreador/sat-reconectar]', err.message);
        res.status(err.statusCliente || 500).json({ error: err.message });
    }
});
// Eventos do GPS do dia (?data=AAAA-MM-DD&placa=) — tela do TMS e formulario.
app.get('/tms/gps-eventos', async (req, res) => {
    try {
        const data = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.data || '')) ? req.query.data : previsaoTms.agoraSP().data;
        const placa = req.query.placa ? rastreador.placaMercosul(req.query.placa) : null;
        const lista = await rastreadorAoVivo.listar(db, data, {placa});
        res.json(lista);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
// 🛰 Aba Frota (back/frota.js): resumo do dia por veiculo + trajeto/paradas.
const rotasFrota = frota.criarRotas({ db, buscarViagensTms, agoraSP: previsaoTms.agoraSP });
app.get('/frota/painel', rotasFrota.painel);
app.get('/frota/trajeto', rotasFrota.trajeto);
const historicoFrota = require('./frota-historico').criar({db,agoraSP:previsaoTms.agoraSP});
app.get('/frota/historico/veiculos',historicoFrota.catalogo);
app.get('/frota/historico',historicoFrota.historico);
app.get('/frota/posicoes',require('./frota-posicoes').criar({db,rastreador,agoraSP:previsaoTms.agoraSP}).posicoes);
// 🛰 Frota: resumo diario + relatorios, areas de risco, manutencao, alertas e
// resumo do dia no Telegram (back/frota-diario.js, back/frota-alertas.js).
// Leitura: quem tem a aba Frota. Gravar area/manutencao e enviar resumo: so ADM
// (fora da whitelist do operador e do modulo, que liberam so GET).
const frotaDiario = frotaDiarioMod.criar({ db, buscarViagensTms, agoraSP: previsaoTms.agoraSP, ehRotaViagem: pernoite.ehRotaViagem });
const frotaOperacao = require('./frota-operacao').criar({db,diario:frotaDiario,buscarViagensTms,agoraSP:previsaoTms.agoraSP,registrarAuditoria});
app.get('/frota/operacao',frotaOperacao.rotas.painel);
app.post('/frota/operacao/config',frotaOperacao.rotas.salvarConfig);
const frotaAlertas = frotaAlertasMod.criar({ db, diario: frotaDiario, agoraSP: previsaoTms.agoraSP, enviarTelegram, operacao:frotaOperacao });
// KM real da viagem finalizada pelo GPS (so preenche km_real vazio) — back/km-real-viagem.js.
require('./km-real-viagem').iniciar({ db, diario: frotaDiario, agoraSP: previsaoTms.agoraSP, ehRotaViagem: pernoite.ehRotaViagem, registrarAuditoria });
app.get('/frota/relatorio', frotaDiario.rotas.relatorio);
// Cercas: as areas daqui <-> as cercas do SRF (back/frota-cercas-srf.js).
// Trazer/enviar/apagar la: so por clique de ADM (POST/PUT/DELETE em /frota).
const cercasSrf = require('./frota-cercas-srf').criar({ db, garantirBase: frotaDiario.garantir, registrarAuditoria });
app.get('/frota/areas', cercasSrf.rotas.listar);
app.get('/frota/areas/srf', cercasSrf.rotas.previa);
app.post('/frota/areas/srf/importar', cercasSrf.rotas.importar);
app.post('/frota/areas/srf/enviar', cercasSrf.rotas.enviarTodas);
app.post('/frota/areas/:id/srf', cercasSrf.rotas.enviar);
app.put('/frota/areas/:id', cercasSrf.rotas.editar);
app.post('/frota/areas', frotaDiario.rotas.criarArea);
app.delete('/frota/areas/:id', cercasSrf.rotas.apagar(frotaDiario.rotas.apagarArea));
// 🧭 Calcular rota: km e tempo de um veiculo (ou lugar) ate 1+ destinos, com
// melhor ordem — back/frota-calcular-rota.js. So GET (quem tem a aba Frota).
const calcularRota = require('./frota-calcular-rota').criar({ db });
app.get('/frota/rota', calcularRota.rotas.calcular);
app.get('/frota/rota/veiculos', calcularRota.rotas.veiculos);
app.get('/frota/rota/endereco', calcularRota.rotas.endereco);
app.get('/frota/manutencao', frotaDiario.rotas.manutencao);
app.post('/frota/manutencao', frotaDiario.rotas.criarManutencao);
app.delete('/frota/manutencao/:id', frotaDiario.rotas.apagarManutencao);
const ajustesGps = require('./rastreador-ajustes').criarRotas({db,rastreador,registrarAuditoria,invalidarCache:rotasFrota.invalidarCache});
app.get('/frota/precisao',ajustesGps.diagnostico);
app.post('/frota/precisao/pontos',somenteAdm,ajustesGps.criarPonto);
app.post('/frota/precisao/lojas/:codigo',ajustesGps.salvarArea);
app.post('/frota/precisao/aparelho',ajustesGps.salvarAparelho);
app.post('/frota/precisao/bloqueio',ajustesGps.bloquearFonte);
app.get('/frota/fonte-preferida', frotaDiario.rotas.fontePreferida);
app.post('/frota/fonte-preferida', frotaDiario.rotas.salvarFontePreferida);
app.get('/frota/resumo', frotaAlertas.rotas.resumoTexto);
app.post('/frota/resumo/enviar', frotaAlertas.rotas.resumoEnviar);
app.get('/frota/limites', frotaAlertas.rotas.limites);
// Historico dos resumos (60 dias) em segundo plano, devagar, 3 min depois de subir.
setTimeout(() => { frotaDiario.preencherHistorico().catch((e) => console.warn('[frota-diario]', e.message)); }, 180000);
frotaAlertas.agendarResumo();
// Aprende onde cada loja fica cruzando registros x paradas do rastreador.
// Demora (1 consulta de historico por caminhao/dia): roda em segundo plano;
// GET devolve o andamento/resultado. So ADM (fora da whitelist do operador).
const aprendizadoLojas = { rodando: false, inicio: null, fim: null, resultado: null, erro: null, log: [] };
app.post('/tms/rastreador/aprender-lojas', async (req, res) => {
    if (aprendizadoLojas.rodando) return res.status(409).json({ error: 'Ja esta rodando.', ...aprendizadoLojas });
    const dias = Math.min(365, Math.max(7, Number(req.body?.dias) || 90));
    Object.assign(aprendizadoLojas, { rodando: true, inicio: new Date(), fim: null, resultado: null, erro: null, log: [] });
    const log = (m) => { aprendizadoLojas.log.push(m); if (aprendizadoLojas.log.length > 50) aprendizadoLojas.log.shift(); };
    rastreadorLojas.aprender(db, { dias, gravar: true, log })
        .then((r) => { aprendizadoLojas.resultado = { ...r, lojas: undefined, total: r.lojas.length }; })
        .catch((err) => { aprendizadoLojas.erro = err.message; })
        .finally(() => { aprendizadoLojas.rodando = false; aprendizadoLojas.fim = new Date(); });
    await registrarAuditoria(req, 'APRENDER_LOJAS_RASTREADOR', 'loja_coordenadas', null, { dias });
    res.status(202).json({ iniciado: true, dias });
});
app.get('/tms/rastreador/aprender-lojas', (req, res) => res.json(aprendizadoLojas));

// ⏪ Completar dias pendentes: chegada/saida/hotel/retorno das viagens antigas
// sem horario, achados no historico do rastreador (rastreador-eventos.js).
// {gravar:false} = previa; {gravar:true} = aplica pelos mesmos handlers dos
// botoes em modo "so preenche vazio". So ADM. Roda em segundo plano.
const rastreadorEventos = require('./rastreador-eventos');
const completarDias = { rodando: false, modo: null, inicio: null, fim: null, plano: null, aplicado: null, erro: null };
app.post('/tms/rastreador/completar', async (req, res) => {
    if (completarDias.rodando) return res.status(409).json({ error: 'Ja esta rodando.' });
    const dias = Math.min(120, Math.max(1, Number(req.body?.dias) || 45));
    const gravar = req.body?.gravar === true;
    Object.assign(completarDias, { rodando: true, modo: gravar ? 'gravar' : 'previa', inicio: new Date(), fim: null, plano: null, aplicado: null, erro: null });
    (async () => {
        const plano = await rastreadorEventos.planejar(db, { dias });
        completarDias.plano = plano;
        if (gravar) {
            completarDias.aplicado = await rastreadorEventos.aplicar(plano, {
                handlers: {
                    chegada: rotasCicloTms.chegada, saida: registrarSaidaFabrica,
                    hotelChegada: rotasCicloTms.hotelChegada, hotelSaida: rotasCicloTms.hotelSaida, retorno: rotasCicloTms.retorno,
                },
                usuario: `🛰 rastreador (${req.usuarioLogado?.nome || 'ADM'})`,
            });
            broadcastAuditoria('tms_viagens');
        }
    })()
        .catch((err) => { completarDias.erro = err.message; })
        .finally(() => { completarDias.rodando = false; completarDias.fim = new Date(); });
    await registrarAuditoria(req, gravar ? 'COMPLETAR_DIAS_RASTREADOR' : 'PREVIA_COMPLETAR_DIAS', 'tms_viagens', null, { dias });
    res.status(202).json({ iniciado: true, dias, gravar });
});
app.get('/tms/rastreador/completar', (req, res) => res.json(completarDias));

// Marca/desmarca a emissao do CTE de uma LOJA/parada (aba "CTEs do dia").
app.put('/tms/paradas/:id/cte', async (req, res) => {
    try {
        const concluido = textoParaBoolean(req.body.concluido);
        const usuario = req.usuarioLogado?.nome || null;
        const result = await db.query(`
            UPDATE tms_paradas SET
                cte_concluido = $1,
                cte_concluido_em = CASE WHEN $1 THEN NOW() ELSE NULL END,
                cte_concluido_por = CASE WHEN $1 THEN $2 ELSE NULL END,
                atualizado_em = NOW()
            WHERE id = $3 RETURNING *
        `, [concluido, usuario, req.params.id]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Parada nao encontrada.' });
        await registrarAuditoria(req, 'PUT_CTE', 'tms_paradas', req.params.id, { cte_concluido: concluido });
        res.status(200).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Emissao de CTE em LOTE: marca (ou desmarca) todas as paradas de uma viagem de
// uma vez. body: { concluido=true, somente_com_remessa=false }. Com somente_com_
// remessa, mexe so nas lojas que tem carga (mesmo criterio da fila "Resolver agora").
app.put('/tms/viagens/:id/ctes', async (req, res) => {
    try {
        const concluido = req.body.concluido === undefined ? true : textoParaBoolean(req.body.concluido);
        const usuario = req.usuarioLogado?.nome || null;
        const filtroRemessa = textoParaBoolean(req.body.somente_com_remessa) ? 'AND remessas IS NOT NULL' : '';
        const result = await db.query(`
            UPDATE tms_paradas SET
                cte_concluido = $1,
                cte_concluido_em = CASE WHEN $1 THEN NOW() ELSE NULL END,
                cte_concluido_por = CASE WHEN $1 THEN $2 ELSE NULL END,
                atualizado_em = NOW()
            WHERE viagem_id = $3 AND cte_concluido IS DISTINCT FROM $1 ${filtroRemessa}
            RETURNING id
        `, [concluido, usuario, req.params.id]);
        await registrarAuditoria(req, 'PUT_CTE_LOTE', 'tms_viagens', req.params.id, { cte_concluido: concluido, afetadas: result.rowCount });
        res.status(200).json({ viagem_id: Number(req.params.id), afetadas: result.rowCount, cte_concluido: concluido });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/tms/paradas/:id/status', async (req, res) => {
    try {
        const status = statusTmsCanonico(req.body.status, statusParadaPermitidos);
        if (!status) {
            return res.status(400).json({ error: 'Status de parada invalido.' });
        }
        const result = await db.query(`
            UPDATE tms_paradas SET status = $1, atualizado_em = NOW()
            WHERE id = $2 RETURNING *
        `, [status, req.params.id]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Parada nao encontrada.' });
        await registrarAuditoria(req, 'PUT_STATUS', 'tms_paradas', req.params.id, { status });
        res.status(200).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ================= INTEGRACAO CHECKLIST EXPEDICAO =================
const CHECKLIST_API_URL = (process.env.CHECKLIST_API_URL || 'http://192.0.2.30:3040').replace(/\/$/, '');
const CHECKLIST_USER = process.env.CHECKLIST_USER || '';
const CHECKLIST_PASS = process.env.CHECKLIST_PASS || '';

const checklistAuthCache = { token: null, expMs: 0 };
const CHECKLIST_TIMEOUT_MS = Number(process.env.CHECKLIST_TIMEOUT_MS || 8000);

// fetch com timeout para o sistema externo do Checklist Expedicao. Sem isto, um
// host inalcancavel (ex.: apos mudar de endereco/porta) poderia deixar a
// requisicao pendurada. Traduz erro de rede numa mensagem clara e acionavel.
async function fetchChecklist(caminho, opcoes = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), CHECKLIST_TIMEOUT_MS);
    try {
        const resp = await fetch(`${CHECKLIST_API_URL}${caminho}`, { signal: ctrl.signal, ...opcoes });
        // O corpo tambem fica dentro do prazo: antes o clearTimeout rodava antes do
        // resp.json() do chamador e um corpo travado segurava a requisicao por minutos.
        const corpo = await resp.text();
        // 204/205/304 nao podem ter corpo no construtor do Response.
        const semCorpo = [204, 205, 304].includes(resp.status);
        return new Response(semCorpo ? null : corpo, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
    } catch (err) {
        const motivo = err.name === 'AbortError' ? `sem resposta em ${CHECKLIST_TIMEOUT_MS}ms` : err.message;
        throw new Error(
            `Checklist Expedicao indisponivel (${CHECKLIST_API_URL}): ${motivo}. ` +
            `Confirme o endereco no .env (CHECKLIST_API_URL) e reinicie o servidor.`
        );
    } finally {
        clearTimeout(t);
    }
}

async function checklistRenovarToken() {
    if (!CHECKLIST_USER || !CHECKLIST_PASS) {
        throw new Error('Configure CHECKLIST_USER e CHECKLIST_PASS no .env para usar a integracao.');
    }
    const resp = await fetchChecklist('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: CHECKLIST_USER, password: CHECKLIST_PASS })
    });
    if (!resp.ok) {
        throw new Error(`Falha ao autenticar no Checklist Expedicao (HTTP ${resp.status}).`);
    }
    const data = await resp.json();
    if (!data.token) throw new Error('Resposta do login sem token.');
    let expMs = Date.now() + 60 * 60 * 1000;
    try {
        const payload = JSON.parse(Buffer.from(data.token.split('.')[1], 'base64').toString('utf8'));
        if (payload.exp) expMs = payload.exp * 1000;
    } catch { /* fallback ja definido */ }
    checklistAuthCache.token = data.token;
    checklistAuthCache.expMs = expMs - 60 * 1000;
}

async function checklistApi(caminho) {
    if (!checklistAuthCache.token || Date.now() >= checklistAuthCache.expMs) {
        await checklistRenovarToken();
    }
    let resp = await fetchChecklist(caminho, {
        headers: { 'Authorization': `Bearer ${checklistAuthCache.token}` }
    });
    if (resp.status === 401) {
        await checklistRenovarToken();
        resp = await fetchChecklist(caminho, {
            headers: { 'Authorization': `Bearer ${checklistAuthCache.token}` }
        });
    }
    if (!resp.ok) {
        throw new Error(`Checklist API ${caminho}: HTTP ${resp.status}`);
    }
    return resp.json();
}

// A API de checklists agora responde paginada ({ rows, pagination }) com perPage fixo.
// Itera por todas as paginas e devolve a lista completa de checklists.
async function checklistListarTodos() {
    const todos = [];
    let page = 1;
    let totalPages = 1;
    do {
        const resp = await checklistApi(`/api/checklists?page=${page}`);
        const rows = Array.isArray(resp) ? resp : (resp?.rows || []);
        todos.push(...rows);
        totalPages = resp?.pagination?.totalPages || 1;
        page += 1;
    } while (page <= totalPages);
    return todos;
}

function mapearChecklistParaViagem(detalhe, motoristaNome, override = {}) {
    const isoToDateOnly = (s) => String(s || '').slice(0, 10);
    const dataViagem = isoToDateOnly(detalhe.delivery_date) || isoToDateOnly(detalhe.loading_date);

    // SOMA por loja: uma loja pode ter mais de um lancamento de sacola no mesmo
    // checklist (ex.: MADUREIRA II no #200 tem um de 0 e outro de 400). Antes o
    // Map.set guardava so o ULTIMO e a loja podia ficar com 0 sacolas.
    const bagsByStore = new Map();
    (detalhe.bag_shipments || []).forEach((b) => {
        const cur = bagsByStore.get(b.store_id) || { quantity_p: 0, quantity_m: 0, quantity_g: 0 };
        cur.quantity_p += Number(b.quantity_p) || 0;
        cur.quantity_m += Number(b.quantity_m) || 0;
        cur.quantity_g += Number(b.quantity_g) || 0;
        bagsByStore.set(b.store_id, cur);
    });

    const campaignByStore = new Map();
    (detalhe.campaign_material_shipments || []).forEach((c) => {
        const cur = campaignByStore.get(c.store_id) || 0;
        campaignByStore.set(c.store_id, cur + (Number(c.quantity_total) || 0));
    });

    // Agrupa cada secao de remessa do checklist por loja (store_id).
    const agruparPorLoja = (lista, fn) => {
        const mapa = new Map();
        (lista || []).forEach((item) => {
            const arr = mapa.get(item.store_id) || [];
            arr.push(fn(item));
            mapa.set(item.store_id, arr);
        });
        return mapa;
    };
    const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
    const materiaisByStore = agruparPorLoja(detalhe.material_shipments, (m) => ({
        setor: m.sector || '', descricao: m.description || '', quantidade: num(m.quantity), carregado: !!m.loaded
    }));
    const bolhaByStore = agruparPorLoja(detalhe.bubble_wrap_shipments, (b) => ({
        material: b.material || '', carregado: !!b.loaded
    }));
    const caixaAzulByStore = agruparPorLoja(detalhe.empty_blue_box_shipments, (c) => ({
        quantidade: num(c.quantity), carregado: !!c.loaded
    }));
    const campanhaByStore = agruparPorLoja(detalhe.campaign_material_shipments, (c) => ({
        campanha: c.campaign_name || '', adesivo: num(c.quantity_adesivo), banner: num(c.quantity_banner),
        folder: num(c.quantity_folder), total: num(c.quantity_total), carregado: !!c.loaded
    }));
    const sacolasByStore = agruparPorLoja(detalhe.bag_shipments, (b) => ({
        tamanho: b.size || '', p: num(b.quantity_p), m: num(b.quantity_m), g: num(b.quantity_g),
        total: num(b.quantity), carregado: !!b.loaded
    }));

    const stores = (detalhe.stores || [])
        .slice()
        .sort((a, b) => (a.load_order || 0) - (b.load_order || 0));

    const paradas = stores.map((s) => {
        const volumes = (s.transactions || [])
            .reduce((acc, t) => acc + (Number(t.volume) || 0), 0);
        const bag = bagsByStore.get(s.store_id);
        const remessas = {
            materiais: materiaisByStore.get(s.store_id) || [],
            plastico_bolha: bolhaByStore.get(s.store_id) || [],
            caixa_azul: caixaAzulByStore.get(s.store_id) || [],
            campanha: campanhaByStore.get(s.store_id) || [],
            sacolas: sacolasByStore.get(s.store_id) || []
        };
        const temRemessas = Object.values(remessas).some((arr) => arr.length > 0);
        return {
            loja: s.store_name,
            hora_prevista: null,
            volumes_previstos: volumes || null,
            material_campanha: campaignByStore.get(s.store_id) || null,
            sacola_p: bag ? (Number(bag.quantity_p) || 0) : 0,
            sacola_m: bag ? (Number(bag.quantity_m) || 0) : 0,
            sacola_g: bag ? (Number(bag.quantity_g) || 0) : 0,
            observacao: s.atd_code ? `ATD: ${s.atd_code}` : null,
            // PES da loja no checklist: casa com a planilha de programacao mesmo
            // quando a grafia do nome difere.
            pes: s.pes === null || s.pes === undefined ? null : String(s.pes).trim(),
            remessas: temRemessas ? remessas : null
        };
    });

    const somar = (chave) => paradas.reduce((acc, p) => acc + (Number(p[chave]) || 0), 0);
    const totalSacolaP = somar('sacola_p');
    const totalSacolaM = somar('sacola_m');
    const totalSacolaG = somar('sacola_g');

    return {
        data_viagem: dataViagem,
        motorista: motoristaNome,
        placa: (override.placa && String(override.placa).trim()) || detalhe.vehicle_plate,
        rota: detalhe.route_name,
        ajudantes: (override.ajudantes && String(override.ajudantes).trim())
            || (detalhe.team || []).map((t) => t.member_name).filter(Boolean).join(', '),
        volumes_previstos: somar('volumes_previstos') || null,
        material_campanha: somar('material_campanha') || null,
        sacola_p: totalSacolaP,
        sacola_m: totalSacolaM,
        sacola_g: totalSacolaG,
        sacola: totalSacolaP + totalSacolaM + totalSacolaG,
        observacao: `Importado do Checklist Expedicao #${detalhe.id} (status: ${detalhe.status})`,
        paradas,
        checklist_origem_id: detalhe.id
    };
}

app.get('/tms/checklist-expedicao/disponiveis', async (req, res) => {
    try {
        const lista = await checklistListarTodos();
        const dataFiltro = req.query.data;
        const filtrada = dataFiltro
            ? lista.filter((c) =>
                String(c.delivery_date || '').slice(0, 10) === dataFiltro
                || String(c.loading_date || '').slice(0, 10) === dataFiltro
            )
            : lista;

        const ids = filtrada.map((c) => c.id);
        const importadosMap = new Map();
        if (ids.length > 0) {
            const r = await db.query(
                'SELECT checklist_origem_id, id, codigo FROM tms_viagens WHERE checklist_origem_id = ANY($1::int[])',
                [ids]
            );
            r.rows.forEach((row) => importadosMap.set(row.checklist_origem_id, row));
        }

        const resposta = filtrada.map((c) => {
            const importada = importadosMap.get(c.id);
            return {
                id: c.id,
                status: c.status,
                loading_date: c.loading_date,
                delivery_date: c.delivery_date,
                vehicle_plate: c.vehicle_plate,
                route_name: c.route_name,
                store_count: c.store_count,
                created_by_name: c.created_by_name,
                ja_importado: !!importada,
                viagem_id: importada?.id || null,
                viagem_codigo: importada?.codigo || null
            };
        });
        res.status(200).json(resposta);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/tms/checklist-expedicao/importar', async (req, res) => {
    const itens = Array.isArray(req.body?.itens) ? req.body.itens : [];
    if (itens.length === 0) {
        return res.status(400).json({ error: 'Informe pelo menos um item a importar.' });
    }

    const importadas = [];
    const erros = [];

    for (const item of itens) {
        const checklistId = Number(item.checklist_id);
        const motorista = String(item.motorista || '').trim();
        if (!checklistId || !motorista) {
            erros.push({ checklist_id: checklistId || null, error: 'checklist_id e motorista sao obrigatorios.' });
            continue;
        }

        const client = await db.connect();
        try {
            const dup = await client.query(
                'SELECT id, codigo FROM tms_viagens WHERE checklist_origem_id = $1',
                [checklistId]
            );
            if (dup.rowCount > 0) {
                erros.push({ checklist_id: checklistId, error: `Ja importado como viagem ${dup.rows[0].codigo || dup.rows[0].id}.` });
                client.release();
                continue;
            }

            const detalhe = await checklistApi(`/api/checklists/${checklistId}`);
            const body = mapearChecklistParaViagem(detalhe, motorista, {
                placa: item.placa,
                ajudantes: item.ajudantes,
            });

            if (!body.placa || !body.data_viagem || body.paradas.length === 0) {
                erros.push({ checklist_id: checklistId, error: 'Checklist sem placa, data ou lojas - nao foi possivel importar.' });
                client.release();
                continue;
            }

            await client.query('BEGIN');
            const viagemResult = await client.query(`
                INSERT INTO tms_viagens (
                    data_viagem, motorista_nome, placa, rota_nome, ajudantes,
                    volumes_previstos, material_campanha, sacola, status, observacao,
                    sacola_p, sacola_m, sacola_g, checklist_origem_id
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Planejada', $9, $10, $11, $12, $13)
                RETURNING *
            `, [
                body.data_viagem, body.motorista, body.placa,
                vazioParaNull(body.rota), vazioParaNull(body.ajudantes),
                vazioParaNull(body.volumes_previstos), vazioParaNull(body.material_campanha),
                vazioParaNull(body.sacola), vazioParaNull(body.observacao),
                vazioParaNull(body.sacola_p), vazioParaNull(body.sacola_m), vazioParaNull(body.sacola_g),
                body.checklist_origem_id
            ]);
            const viagem = viagemResult.rows[0];
            const codigo = `V-${String(body.data_viagem).replaceAll('-', '')}-${String(viagem.id).padStart(5, '0')}`;
            await client.query('UPDATE tms_viagens SET codigo = $1 WHERE id = $2', [codigo, viagem.id]);

            for (let i = 0; i < body.paradas.length; i += 1) {
                const p = body.paradas[i];
                const sacolaTotal = (Number(p.sacola_p) || 0) + (Number(p.sacola_m) || 0) + (Number(p.sacola_g) || 0);
                await client.query(`
                    INSERT INTO tms_paradas (
                        viagem_id, ordem, loja_nome, hora_prevista, volumes_previstos,
                        material_campanha, sacola, observacao,
                        sacola_p, sacola_m, sacola_g, remessas
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                `, [
                    viagem.id, i + 1, p.loja,
                    vazioParaNull(p.hora_prevista), vazioParaNull(p.volumes_previstos),
                    vazioParaNull(p.material_campanha), vazioParaNull(sacolaTotal || null),
                    vazioParaNull(p.observacao),
                    vazioParaNull(p.sacola_p || null), vazioParaNull(p.sacola_m || null), vazioParaNull(p.sacola_g || null),
                    p.remessas ? JSON.stringify(p.remessas) : null
                ]);
            }

            await preencherLojaIdDaViagem(client, viagem.id);

            await client.query('COMMIT');
            await registrarAuditoria(req, 'IMPORT_CHECKLIST', 'tms_viagens', viagem.id, {
                checklist_origem_id: checklistId,
                placa: body.placa,
                rota: body.rota,
                data_viagem: body.data_viagem
            });
            importadas.push({ checklist_id: checklistId, viagem_id: viagem.id, codigo });
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            erros.push({ checklist_id: checklistId, error: err.message });
        } finally {
            client.release();
        }
    }

    res.status(200).json({ importadas, erros });
});

// ================= IMPORTACAO DE PEDIDOS (CSV/ERP) =================
// Recebe linhas ja lidas pelo front e agrupa automaticamente por viagem
// (data + rota + motorista + placa) e por loja. Reimportar o mesmo conjunto
// atualiza somente viagens criadas por este importador e nao duplica pedidos.
function pedidoTexto(v, limite = 500) {
    const texto = v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim();
    return texto ? texto.slice(0, limite) : null;
}

function pedidoNumeroValor(v) {
    if (v === null || v === undefined || v === '') return null;
    let texto = String(v).trim().replace(/[^\d,.-]/g, '');
    if (texto.includes(',')) texto = texto.replace(/\./g, '').replace(',', '.');
    const numero = Number(texto);
    return Number.isFinite(numero) ? numero : null;
}

function pedidoData(v) {
    const texto = pedidoTexto(v, 30);
    if (!texto) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) return texto;
    const br = texto.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
    if (br) return `${br[3]}-${String(br[2]).padStart(2, '0')}-${String(br[1]).padStart(2, '0')}`;
    return null;
}

function pedidoHora(v) {
    const texto = pedidoTexto(v, 20);
    const m = texto && texto.match(/^(\d{1,2}):(\d{2})/);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
    return `${String(m[1]).padStart(2, '0')}:${m[2]}`;
}

function pedidoChaveTexto(v) {
    return String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toUpperCase().replace(/\s+/g, ' ').trim();
}

app.post('/tms/pedidos/importar', async (req, res) => {
    const itens = Array.isArray(req.body?.itens) ? req.body.itens : [];
    if (!itens.length) return res.status(400).json({ error: 'Nenhum pedido para importar.' });
    if (itens.length > 5000) return res.status(413).json({ error: 'Importe no maximo 5.000 pedidos por vez.' });

    const grupos = new Map();
    const erros = [];
    itens.forEach((item, indice) => {
        const data = pedidoData(item?.data_viagem || item?.data || item?.data_entrega);
        const loja = pedidoTexto(item?.loja_nome || item?.loja || item?.destino);
        if (!data || !loja) {
            erros.push({ linha: indice + 2, error: 'Data e loja sao obrigatorias.' });
            return;
        }
        const rota = pedidoTexto(item?.rota_nome || item?.rota);
        const motorista = pedidoTexto(item?.motorista_nome || item?.motorista);
        const placa = pedidoTexto(item?.placa || item?.veiculo, 20);
        const chaveGrupoTexto = [data, rota || '(sem rota)', motorista || '(sem motorista)', placa || '(sem placa)']
            .map(pedidoChaveTexto).join('|');
        const chaveGrupo = crypto.createHash('sha256').update(chaveGrupoTexto).digest('hex');
        let grupo = grupos.get(chaveGrupo);
        if (!grupo) {
            grupo = {
                chave: chaveGrupo,
                data, rota, motorista, placa,
                lojas: new Map(),
            };
            grupos.set(chaveGrupo, grupo);
        }
        const lojaChave = pedidoChaveTexto(loja);
        let parada = grupo.lojas.get(lojaChave);
        if (!parada) {
            parada = { loja, pedidos: new Map(), ordem: grupo.lojas.size + 1 };
            grupo.lojas.set(lojaChave, parada);
        }
        const pedidoNumero = pedidoTexto(item?.pedido_numero || item?.pedido || item?.numero_pedido, 120);
        const pedido = {
            pedido_numero: pedidoNumero,
            nota_fiscal: pedidoTexto(item?.nota_fiscal || item?.nf || item?.nota, 120),
            volumes: pedidoNumeroValor(item?.volumes || item?.volume || item?.quantidade),
            hora_prevista: pedidoHora(item?.hora_prevista || item?.hora || item?.horario),
            observacao: pedidoTexto(item?.observacao || item?.obs),
        };
        const chavePedido = pedidoChaveTexto([
            pedido.pedido_numero || '', pedido.nota_fiscal || '', lojaChave,
            pedido.volumes ?? '', pedido.hora_prevista || '', pedido.observacao || ''
        ].join('|'));
        if (!parada.pedidos.has(chavePedido)) parada.pedidos.set(chavePedido, pedido);
    });

    const importadas = [];
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        for (const grupo of grupos.values()) {
            const paradas = [...grupo.lojas.values()].map((p) => ({
                ...p,
                pedidos: [...p.pedidos.values()],
            }));
            const volumesTotal = paradas.reduce((soma, p) => soma + p.pedidos.reduce((s, pedido) => s + (pedido.volumes || 0), 0), 0);
            const codigo = `IMP-${grupo.chave.slice(0, 16)}`;
            const existente = await client.query(
                'SELECT id, status FROM tms_viagens WHERE importacao_chave = $1 FOR UPDATE',
                [grupo.chave]
            );
            let viagem;
            let operacao;
            // Colunas digitadas no TMS (ou gravadas por outro fluxo) que NAO vem da
            // planilha, preservadas quando as paradas sao recriadas mais abaixo.
            // Chave = loja canonizada.
            const paradasAnteriores = new Map();
            if (existente.rowCount) {
                const bloqueada = await client.query(
                    `SELECT COUNT(*)::int AS total FROM tms_paradas WHERE viagem_id = $1 AND LOWER(COALESCE(status, 'pendente')) <> 'pendente'`,
                    [existente.rows[0].id]
                );
                if (Number(bloqueada.rows[0]?.total || 0) > 0) {
                    erros.push({ grupo: codigo, error: 'Viagem ja iniciada; importacao ignorada para nao apagar status de entrega.' });
                    continue;
                }
                const atualizado = await client.query(`
                    UPDATE tms_viagens
                    SET data_viagem = $1, rota_nome = $2, motorista_nome = $3, placa = $4,
                        volumes_previstos = $5, atualizado_em = NOW()
                    WHERE id = $6 RETURNING *
                `, [grupo.data, grupo.rota, grupo.motorista, grupo.placa, volumesTotal || null, existente.rows[0].id]);
                viagem = atualizado.rows[0];
                operacao = 'atualizada';
                // Nada aqui vem da planilha de pedidos: retirada, prioridade, sacola e
                // campanha sao digitadas no TMS depois, e o CTe e gravado por outro fluxo.
                // Sem guardar, o DELETE abaixo devolvia todas ao DEFAULT a cada
                // reimportacao da mesma viagem. O CTe e o mais sensivel por ser controle
                // fiscal: PUT /tms/paradas/:id/cte grava sem mexer no status, entao a
                // guarda de "viagem ja iniciada" logo acima nao barra a reimportacao.
                // Casa por loja canonizada porque a grafia da planilha pode divergir da
                // que ficou gravada na parada (ver normalizar-loja.js).
                const anteriores = await client.query(`
                    SELECT loja_nome, retirada_cx, retirada_rt, prioridade,
                           material_campanha, sacola, sacola_p, sacola_m, sacola_g,
                           cte_concluido, cte_concluido_em, cte_concluido_por, remessas
                    FROM tms_paradas WHERE viagem_id = $1 ORDER BY ordem
                `, [viagem.id]);
                // ORDER BY + "a primeira vence": se duas paradas antigas colidirem na
                // grafia canonica, o desempate e a ordem da viagem, e nao a ordem
                // arbitraria em que o banco devolveu as linhas.
                anteriores.rows.forEach((linha) => {
                    const chave = canonizarLoja(linha.loja_nome);
                    if (!paradasAnteriores.has(chave)) paradasAnteriores.set(chave, linha);
                });
                await client.query('DELETE FROM tms_paradas WHERE viagem_id = $1', [viagem.id]);
            } else {
                const criada = await client.query(`
                    INSERT INTO tms_viagens (
                        codigo, data_viagem, rota_nome, motorista_nome, placa,
                        volumes_previstos, status, observacao, importacao_chave
                    ) VALUES ($1, $2, $3, $4, $5, $6, 'Planejada', $7, $8)
                    RETURNING *
                `, [codigo, grupo.data, grupo.rota, grupo.motorista, grupo.placa,
                    volumesTotal || null, 'Importada de pedidos', grupo.chave]);
                viagem = criada.rows[0];
                operacao = 'inserida';
            }
            for (const parada of paradas) {
                const horas = parada.pedidos.map((p) => p.hora_prevista).filter(Boolean).sort();
                const observacoes = parada.pedidos.map((p) => p.observacao).filter(Boolean);
                const volumes = parada.pedidos.reduce((soma, p) => soma + (p.volumes || 0), 0);
                const chaveAnterior = canonizarLoja(parada.loja);
                const anterior = paradasAnteriores.get(chaveAnterior) || {};
                // Consome a chave: se duas lojas da planilha canonizarem para a mesma
                // grafia (ex. SANTA CRUZ 3 e SANTA_CRUZ_III), o que estava gravado vai
                // para a primeira parada em vez de ser replicado em todas elas.
                paradasAnteriores.delete(chaveAnterior);
                // Os fallbacks abaixo reproduzem exatamente os DEFAULT das colunas
                // (retirada 0, prioridade 2, cte_concluido false, o resto NULL), para
                // que parada nova pela planilha nasca igual ao que nascia antes.
                await client.query(`
                    INSERT INTO tms_paradas (
                        viagem_id, ordem, loja_nome, hora_prevista, volumes_previstos,
                        status, observacao, pedidos,
                        retirada_cx, retirada_rt, prioridade,
                        material_campanha, sacola, sacola_p, sacola_m, sacola_g,
                        cte_concluido, cte_concluido_em, cte_concluido_por, remessas
                    ) VALUES ($1, $2, $3, $4, $5, 'Pendente', $6, $7::jsonb,
                              $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb)
                `, [viagem.id, parada.ordem, parada.loja, horas[0] || null,
                    volumes || null, observacoes.join(' | ') || null, JSON.stringify(parada.pedidos),
                    Number(anterior.retirada_cx) || 0,
                    Number(anterior.retirada_rt) || 0,
                    Number(anterior.prioridade) || 2,
                    anterior.material_campanha ?? null,
                    anterior.sacola ?? null,
                    anterior.sacola_p ?? null,
                    anterior.sacola_m ?? null,
                    anterior.sacola_g ?? null,
                    anterior.cte_concluido === true,
                    anterior.cte_concluido_em ?? null,
                    anterior.cte_concluido_por ?? null,
                    anterior.remessas ? JSON.stringify(anterior.remessas) : null]);
            }
            await preencherLojaIdDaViagem(client, viagem.id);
            importadas.push({ codigo, viagem_id: viagem.id, operacao, pedidos: paradas.reduce((s, p) => s + p.pedidos.length, 0) });
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        return res.status(500).json({ error: 'Falha ao importar pedidos.', detalhe: err.message });
    } finally {
        client.release();
    }

    for (const item of importadas) {
        await registrarAuditoria(req, 'IMPORT_PEDIDOS', 'tms_viagens', item.viagem_id, item);
    }
    res.status(200).json({ importadas, erros, total: itens.length, grupos: grupos.size });
});


// ================= IMPORTACAO DA PROGRAMACAO DE ROTAS (planilha) =================
// Planilha (loja, PES, horarios, RT, CX, motorista, ajudantes, placa) +
// Checklist Expedicao (volume e materiais). Logica em back/tms-programacao.js.
//   POST /tms/programacao/previa   -> so planeja, nao grava
//   POST /tms/programacao/importar -> grava tudo ou nada
// Fora da whitelist do OPERADOR de proposito, igual as outras importacoes.
tmsProgramacao.registrarRotas(app, {
    db, preencherLojaIdDaViagem, registrarAuditoria,
    // Volume e materiais por loja vem do Checklist Expedicao (mesma integracao do "Importar do Checklist").
    checklistListarTodos, checklistApi, mapearChecklistParaViagem,
    // O modulo "tms" libera todo /tms/ para OPERADOR/CUSTOM; importar e ADM.
    somenteAdm,
    // Sino 🚨 em tempo real quando a planilha do dia nao entra sozinha.
    broadcastEvento,
});

// ================= OCORRENCIAS AVULSAS (nao ligadas a entrega) =================
const statusAvulsaPermitidos = ['Aberta', 'Em análise', 'Resolvida'];
const escoposAvulsaPermitidos = ['GERAL', 'ENTREGA'];

function escopoAvulsaCanonico(v) {
    const t = String(v || '').trim().toUpperCase();
    return escoposAvulsaPermitidos.includes(t) ? t : 'GERAL';
}

// Quando a ocorrencia eh do escopo ENTREGA, copia rota/motorista/data da viagem TMS
// para snapshot - assim os graficos por rota/dia funcionam mesmo sem JOIN.
async function snapshotViagemParaAvulsa(viagemId) {
    if (!viagemId) return { rota_nome: null, motorista_nome: null, data_viagem: null };
    const r = await db.query(`
        SELECT to_char(v.data_viagem, 'YYYY-MM-DD') AS data_viagem,
               COALESCE(v.rota_nome, r.nome) AS rota_nome,
               COALESCE(v.motorista_nome, m.nome) AS motorista_nome
        FROM tms_viagens v
        LEFT JOIN tms_rotas r ON r.id = v.rota_id
        LEFT JOIN tms_motoristas m ON m.id = v.motorista_id
        WHERE v.id = $1
    `, [viagemId]);
    return r.rows[0] || { rota_nome: null, motorista_nome: null, data_viagem: null };
}

app.get('/ocorrencias-avulsas', async (req, res) => {
    try {
        const { inicio, fim, escopo } = req.query;
        const condicoes = [];
        const valores = [];
        if (inicio) { valores.push(inicio); condicoes.push(`oa.data_ocorrencia >= $${valores.length}`); }
        if (fim) { valores.push(fim); condicoes.push(`oa.data_ocorrencia <= $${valores.length}`); }
        if (escopo) { valores.push(escopoAvulsaCanonico(escopo)); condicoes.push(`oa.escopo = $${valores.length}`); }
        const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
        const result = await db.query(
            `SELECT oa.*, v.codigo AS viagem_codigo, to_char(v.data_viagem, 'YYYY-MM-DD') AS viagem_data
             FROM ocorrencias_avulsas oa
             LEFT JOIN tms_viagens v ON v.id = oa.viagem_id
             ${where}
             ORDER BY oa.data_ocorrencia DESC, oa.id DESC`,
            valores
        );
        res.status(200).json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/ocorrencias-avulsas', async (req, res) => {
    try {
        const body = req.body || {};
        const escopo = escopoAvulsaCanonico(body.escopo);
        const viagemId = escopo === 'ENTREGA' ? Number(body.viagem_id) || null : null;
        if (!body.data_ocorrencia && escopo !== 'ENTREGA') {
            return res.status(400).json({ error: 'Informe a data da ocorrencia.' });
        }
        const status = statusTmsCanonico(body.status, statusAvulsaPermitidos) || 'Aberta';
        const snap = await snapshotViagemParaAvulsa(viagemId);
        const dataOco = body.data_ocorrencia || snap.data_viagem;
        const fotos = Array.isArray(body.fotos) ? JSON.stringify(body.fotos) : vazioParaNull(body.fotos);
        if (!dataOco) {
            return res.status(400).json({ error: 'Informe a data da ocorrencia.' });
        }
        const result = await db.query(`
            INSERT INTO ocorrencias_avulsas (
                data_ocorrencia, hora_ocorrencia, titulo, descricao, culpa, status,
                escopo, viagem_id, tipo_problema, rota_nome, motorista_nome, loja, fotos,
                ajudante_culpado, observacao
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *
        `, [
            dataOco,
            vazioParaNull(body.hora_ocorrencia),
            vazioParaNull(body.titulo),
            vazioParaNull(body.descricao),
            vazioParaNull(body.culpa),
            status,
            escopo,
            viagemId,
            vazioParaNull(body.tipo_problema),
            vazioParaNull(body.rota_nome || snap.rota_nome),
            vazioParaNull(body.motorista_nome || snap.motorista_nome),
            vazioParaNull(body.loja),
            fotos,
            vazioParaNull(body.ajudante_culpado),
            vazioParaNull(body.observacao)
        ]);
        await registrarAuditoria(req, 'POST', 'ocorrencias_avulsas', result.rows[0].id, {
            escopo, viagem_id: viagemId, tipo_problema: body.tipo_problema, culpa: body.culpa
        });
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/ocorrencias-avulsas/:id', async (req, res) => {
    try {
        const body = req.body || {};
        const escopo = escopoAvulsaCanonico(body.escopo);
        const viagemId = escopo === 'ENTREGA' ? Number(body.viagem_id) || null : null;
        const status = statusTmsCanonico(body.status, statusAvulsaPermitidos) || 'Aberta';
        const snap = await snapshotViagemParaAvulsa(viagemId);
        const dataOco = body.data_ocorrencia || snap.data_viagem;
        const fotos = Array.isArray(body.fotos) ? JSON.stringify(body.fotos) : vazioParaNull(body.fotos);
        if (!dataOco) {
            return res.status(400).json({ error: 'Informe a data da ocorrencia.' });
        }
        const result = await db.query(`
            UPDATE ocorrencias_avulsas SET
                data_ocorrencia = $1, hora_ocorrencia = $2, titulo = $3, descricao = $4,
                culpa = $5, status = $6, escopo = $7, viagem_id = $8,
                tipo_problema = $9, rota_nome = $10, motorista_nome = $11, loja = $12,
                fotos = $13, ajudante_culpado = $14, observacao = $15, atualizado_em = NOW()
            WHERE id = $16 RETURNING *
        `, [
            dataOco,
            vazioParaNull(body.hora_ocorrencia),
            vazioParaNull(body.titulo),
            vazioParaNull(body.descricao),
            vazioParaNull(body.culpa),
            status,
            escopo,
            viagemId,
            vazioParaNull(body.tipo_problema),
            vazioParaNull(body.rota_nome || snap.rota_nome),
            vazioParaNull(body.motorista_nome || snap.motorista_nome),
            vazioParaNull(body.loja),
            fotos,
            vazioParaNull(body.ajudante_culpado),
            vazioParaNull(body.observacao),
            req.params.id
        ]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Ocorrencia nao encontrada.' });
        await registrarAuditoria(req, 'PUT', 'ocorrencias_avulsas', req.params.id, {
            escopo, viagem_id: viagemId, tipo_problema: body.tipo_problema, culpa: body.culpa
        });
        res.status(200).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/ocorrencias-avulsas/:id/status', async (req, res) => {
    try {
        const status = statusTmsCanonico(req.body.status, statusAvulsaPermitidos);
        if (!status) return res.status(400).json({ error: 'Status invalido.' });
        const result = await db.query(`
            UPDATE ocorrencias_avulsas SET status = $1, atualizado_em = NOW()
            WHERE id = $2 RETURNING *
        `, [status, req.params.id]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Ocorrencia nao encontrada.' });
        await registrarAuditoria(req, 'PUT_STATUS', 'ocorrencias_avulsas', req.params.id, { status });
        res.status(200).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Acao de 1 clique da fila: define o setor culpado de uma ocorrencia avulsa.
app.put('/ocorrencias-avulsas/:id/culpa', async (req, res) => {
    try {
        const culpa = String(req.body && req.body.culpa || '').trim();
        if (!culpa) return res.status(400).json({ error: 'Informe o setor culpado.' });
        if (culpa.length > 100) return res.status(400).json({ error: 'Setor inválido.' });
        const result = await db.query(
            `UPDATE ocorrencias_avulsas SET culpa = $1, atualizado_em = NOW() WHERE id = $2 RETURNING id, culpa`,
            [culpa, req.params.id]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Ocorrencia nao encontrada.' });
        await registrarAuditoria(req, 'DEFINIR_CULPA', 'ocorrencias_avulsas', req.params.id, { culpa });
        res.status(200).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Erro ao definir setor culpado.', detalhe: err.message });
    }
});

app.delete('/ocorrencias-avulsas/:id', async (req, res) => {
    try {
        const result = await db.query('DELETE FROM ocorrencias_avulsas WHERE id = $1 RETURNING *', [req.params.id]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Ocorrencia nao encontrada.' });
        await registrarAuditoria(req, 'DELETE', 'ocorrencias_avulsas', req.params.id, {});
        res.status(200).json({ deleted: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ================================================================
// OCORRENCIAS DE MOTORISTA — registro de CONDUTA (setor Transporte)
// ----------------------------------------------------------------
// CRUD de um log disciplinar/comportamental por motorista. ADM-ONLY: nenhuma
// destas rotas esta na whitelist rotaPermitidaOperador, entao o middleware
// global ja bloqueia OPERADOR (403). Nao mistura com ocorrencias de entrega.
// ================================================================
const OMOT_GRAVIDADES = ['Leve', 'Média', 'Grave'];
const OMOT_STATUS = ['Aberta', 'Em análise', 'Resolvida'];
const omotCanon = (valor, permitidos, padrao) => {
    const v = String(valor || '').trim();
    const achado = permitidos.find((p) => p.toLowerCase() === v.toLowerCase());
    return achado || padrao;
};

app.get('/ocorrencias-motorista', async (req, res) => {
    try {
        const cond = [];
        const params = [];
        const add = (sql, val) => { params.push(val); return sql.replace('$?', `$${params.length}`); };
        if (req.query.inicio) cond.push(add('data_ocorrencia >= $?', req.query.inicio));
        if (req.query.fim) cond.push(add('data_ocorrencia <= $?', req.query.fim));
        if (req.query.motorista) cond.push(add("motorista ILIKE '%' || $? || '%'", String(req.query.motorista).slice(0, 80)));
        if (req.query.status) cond.push(add('status = $?', omotCanon(req.query.status, OMOT_STATUS, null)));
        const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
        const lista = await db.query(
            `SELECT * FROM ocorrencias_motorista ${where} ORDER BY data_ocorrencia DESC, id DESC LIMIT 500`, params
        );
        // Contagem por motorista (reincidencia) — sobre TODO o historico, nao so o filtro.
        const contagem = await db.query(`
            SELECT motorista,
                   COUNT(*)::int AS total,
                   COUNT(*) FILTER (WHERE status <> 'Resolvida')::int AS abertas,
                   COUNT(*) FILTER (WHERE gravidade = 'Grave')::int   AS graves
            FROM ocorrencias_motorista
            GROUP BY motorista
            ORDER BY total DESC, graves DESC
            LIMIT 20
        `);
        res.status(200).json({ lista: lista.rows, contagem: contagem.rows });
    } catch (err) {
        console.error('[GET /ocorrencias-motorista]', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/ocorrencias-motorista', async (req, res) => {
    try {
        const b = req.body || {};
        const motorista = String(b.motorista || '').trim();
        const relato = String(b.relato || '').trim();
        if (!b.data_ocorrencia) return res.status(400).json({ error: 'Informe a data da ocorrência.' });
        if (!motorista) return res.status(400).json({ error: 'Informe o motorista.' });
        if (!relato) return res.status(400).json({ error: 'Descreva o que aconteceu (relato).' });
        const r = await db.query(`
            INSERT INTO ocorrencias_motorista
                (data_ocorrencia, hora, motorista, envolvidos, tipo, gravidade, relato, providencia, status, registrado_por)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *
        `, [
            b.data_ocorrencia,
            vazioParaNull(b.hora),
            motorista,
            vazioParaNull(b.envolvidos),
            vazioParaNull(b.tipo),
            omotCanon(b.gravidade, OMOT_GRAVIDADES, 'Leve'),
            relato,
            vazioParaNull(b.providencia),
            omotCanon(b.status, OMOT_STATUS, 'Aberta'),
            req.usuarioLogado?.nome || null,
        ]);
        await registrarAuditoria(req, 'POST', 'ocorrencias_motorista', r.rows[0].id, { motorista, gravidade: r.rows[0].gravidade });
        res.status(201).json(r.rows[0]);
    } catch (err) {
        console.error('[POST /ocorrencias-motorista]', err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/ocorrencias-motorista/:id', async (req, res) => {
    try {
        const b = req.body || {};
        const motorista = String(b.motorista || '').trim();
        const relato = String(b.relato || '').trim();
        if (!b.data_ocorrencia) return res.status(400).json({ error: 'Informe a data da ocorrência.' });
        if (!motorista) return res.status(400).json({ error: 'Informe o motorista.' });
        if (!relato) return res.status(400).json({ error: 'Descreva o que aconteceu (relato).' });
        const r = await db.query(`
            UPDATE ocorrencias_motorista SET
                data_ocorrencia = $1, hora = $2, motorista = $3, envolvidos = $4, tipo = $5,
                gravidade = $6, relato = $7, providencia = $8, status = $9, atualizado_em = NOW()
            WHERE id = $10 RETURNING *
        `, [
            b.data_ocorrencia,
            vazioParaNull(b.hora),
            motorista,
            vazioParaNull(b.envolvidos),
            vazioParaNull(b.tipo),
            omotCanon(b.gravidade, OMOT_GRAVIDADES, 'Leve'),
            relato,
            vazioParaNull(b.providencia),
            omotCanon(b.status, OMOT_STATUS, 'Aberta'),
            req.params.id,
        ]);
        if (r.rowCount === 0) return res.status(404).json({ error: 'Registro não encontrado.' });
        await registrarAuditoria(req, 'PUT', 'ocorrencias_motorista', req.params.id, { motorista });
        res.status(200).json(r.rows[0]);
    } catch (err) {
        console.error('[PUT /ocorrencias-motorista/:id]', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/ocorrencias-motorista/:id', async (req, res) => {
    try {
        const r = await db.query('DELETE FROM ocorrencias_motorista WHERE id = $1 RETURNING *', [req.params.id]);
        if (r.rowCount === 0) return res.status(404).json({ error: 'Registro não encontrado.' });
        await registrarAuditoria(req, 'DELETE', 'ocorrencias_motorista', req.params.id, {});
        res.status(200).json({ deleted: r.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ================================================================
// RESPONSAVEIS DE LOJA — cadastro de quem responde por cada loja.
// Cadastro simples (loja + nome + telefone). Acessivel a qualquer logado
// (rota na whitelist de operador). Segue o padrao de ocorrencias-motorista.
// ================================================================
app.get('/loja-responsaveis', async (req, res) => {
    try {
        const lista = await db.query('SELECT * FROM loja_responsaveis ORDER BY loja, nome');
        res.status(200).json(lista.rows);
    } catch (err) {
        console.error('[GET /loja-responsaveis]', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/loja-responsaveis', async (req, res) => {
    try {
        const b = req.body || {};
        const loja = String(b.loja || '').trim();
        const nome = String(b.nome || '').trim();
        if (!loja) return res.status(400).json({ error: 'Informe a loja.' });
        if (!nome) return res.status(400).json({ error: 'Informe o nome do responsável.' });
        const r = await db.query(
            'INSERT INTO loja_responsaveis (loja, nome, telefone) VALUES ($1, $2, $3) RETURNING *',
            [loja, nome, vazioParaNull(b.telefone)]
        );
        await registrarAuditoria(req, 'POST', 'loja_responsaveis', r.rows[0].id, { loja, nome });
        res.status(201).json(r.rows[0]);
    } catch (err) {
        console.error('[POST /loja-responsaveis]', err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/loja-responsaveis/:id', async (req, res) => {
    try {
        const b = req.body || {};
        const loja = String(b.loja || '').trim();
        const nome = String(b.nome || '').trim();
        if (!loja) return res.status(400).json({ error: 'Informe a loja.' });
        if (!nome) return res.status(400).json({ error: 'Informe o nome do responsável.' });
        const r = await db.query(
            'UPDATE loja_responsaveis SET loja = $1, nome = $2, telefone = $3 WHERE id = $4 RETURNING *',
            [loja, nome, vazioParaNull(b.telefone), req.params.id]
        );
        if (r.rowCount === 0) return res.status(404).json({ error: 'Registro não encontrado.' });
        await registrarAuditoria(req, 'PUT', 'loja_responsaveis', req.params.id, { loja, nome });
        res.status(200).json(r.rows[0]);
    } catch (err) {
        console.error('[PUT /loja-responsaveis/:id]', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/loja-responsaveis/:id', async (req, res) => {
    try {
        const r = await db.query('DELETE FROM loja_responsaveis WHERE id = $1 RETURNING *', [req.params.id]);
        if (r.rowCount === 0) return res.status(404).json({ error: 'Registro não encontrado.' });
        await registrarAuditoria(req, 'DELETE', 'loja_responsaveis', req.params.id, {});
        res.status(200).json({ deleted: r.rows[0] });
    } catch (err) {
        console.error('[DELETE /loja-responsaveis/:id]', err);
        res.status(500).json({ error: err.message });
    }
});

// ================================================================
// CONTROLE DE UBER — ledger de corridas solicitadas pelo Transporte.
// ADM-only: nenhuma destas rotas está na whitelist rotaPermitidaOperador,
// então o middleware global de perfil bloqueia operador (403). Prefixo uber*.
// ================================================================
const uberValorNumerico = (v) => {
    if (v === undefined || v === null || v === '') return null;
    // Aceita "1.234,56", "1234.56", "R$ 50,00" etc.
    let s = String(v).trim().replace(/[R$\s]/gi, '');
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
};

app.get('/controle-uber', async (req, res) => {
    try {
        const cond = [];
        const params = [];
        const add = (sql, val) => { params.push(val); return sql.replace('$?', `$${params.length}`); };
        if (req.query.inicio) cond.push(add('data >= $?', req.query.inicio));
        if (req.query.fim) cond.push(add('data <= $?', req.query.fim));
        if (req.query.busca) {
            const termo = `%${String(req.query.busca).slice(0, 80)}%`;
            params.push(termo);
            const p = `$${params.length}`;
            cond.push(`(setor_pessoa_requisitante ILIKE ${p} OR solicitante ILIKE ${p} OR origem ILIKE ${p} OR destino ILIKE ${p})`);
        }
        const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
        const lista = await db.query(
            `SELECT * FROM controle_uber ${where} ORDER BY data DESC, id DESC LIMIT 500`, params
        );
        res.status(200).json({ lista: lista.rows });
    } catch (err) {
        console.error('[GET /controle-uber]', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/controle-uber', async (req, res) => {
    try {
        const b = req.body || {};
        const requisitante = String(b.setor_pessoa_requisitante || '').trim();
        const solicitante = String(b.solicitante || '').trim();
        const origem = String(b.origem || '').trim();
        const destino = String(b.destino || '').trim();
        if (!b.data) return res.status(400).json({ error: 'Informe a data.' });
        if (!requisitante) return res.status(400).json({ error: 'Informe o setor/pessoa requisitante.' });
        if (!solicitante) return res.status(400).json({ error: 'Informe o solicitante.' });
        if (!origem) return res.status(400).json({ error: 'Informe a origem.' });
        if (!destino) return res.status(400).json({ error: 'Informe o destino.' });
        const r = await db.query(`
            INSERT INTO controle_uber
                (data, setor_pessoa_requisitante, solicitante, setor_solicitante, origem, destino, motivo, valor, registrado_por)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *
        `, [
            b.data,
            requisitante,
            solicitante,
            String(b.setor_solicitante || '').trim() || 'Transporte',
            origem,
            destino,
            String(b.motivo || '').trim() || null,
            uberValorNumerico(b.valor),
            req.usuarioLogado?.nome || null,
        ]);
        await registrarAuditoria(req, 'POST', 'controle_uber', r.rows[0].id, { valor: r.rows[0].valor });
        res.status(201).json(r.rows[0]);
    } catch (err) {
        console.error('[POST /controle-uber]', err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/controle-uber/:id', async (req, res) => {
    try {
        const b = req.body || {};
        const requisitante = String(b.setor_pessoa_requisitante || '').trim();
        const solicitante = String(b.solicitante || '').trim();
        const origem = String(b.origem || '').trim();
        const destino = String(b.destino || '').trim();
        if (!b.data) return res.status(400).json({ error: 'Informe a data.' });
        if (!requisitante) return res.status(400).json({ error: 'Informe o setor/pessoa requisitante.' });
        if (!solicitante) return res.status(400).json({ error: 'Informe o solicitante.' });
        if (!origem) return res.status(400).json({ error: 'Informe a origem.' });
        if (!destino) return res.status(400).json({ error: 'Informe o destino.' });
        const r = await db.query(`
            UPDATE controle_uber SET
                data = $1, setor_pessoa_requisitante = $2, solicitante = $3, setor_solicitante = $4,
                origem = $5, destino = $6, motivo = $7, valor = $8, atualizado_em = NOW()
            WHERE id = $9 RETURNING *
        `, [
            b.data,
            requisitante,
            solicitante,
            String(b.setor_solicitante || '').trim() || 'Transporte',
            origem,
            destino,
            String(b.motivo || '').trim() || null,
            uberValorNumerico(b.valor),
            req.params.id,
        ]);
        if (r.rowCount === 0) return res.status(404).json({ error: 'Registro não encontrado.' });
        await registrarAuditoria(req, 'PUT', 'controle_uber', req.params.id, { valor: r.rows[0].valor });
        res.status(200).json(r.rows[0]);
    } catch (err) {
        console.error('[PUT /controle-uber/:id]', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/controle-uber/:id', async (req, res) => {
    try {
        const r = await db.query('DELETE FROM controle_uber WHERE id = $1 RETURNING *', [req.params.id]);
        if (r.rowCount === 0) return res.status(404).json({ error: 'Registro não encontrado.' });
        await registrarAuditoria(req, 'DELETE', 'controle_uber', req.params.id, {});
        res.status(200).json({ deleted: r.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ================= WMS · ERRO DE VOLUME =================
// Planilha de divergencias de volume: DATA | LOJA | PEDIDO | VOLUME | DESCRICAO.
// A tela (public/js/wms.js) edita celula a celula e salva no blur, entao o PUT
// recebe o registro inteiro a cada alteracao — mesmo contrato do POST.

// pedido e volume sao CODIGOS DE SERIE: guarda o texto como veio (so aparando
// espaco das pontas). Nada de Number() aqui — "007" e "0" sao codigos
// diferentes e converter destruiria zeros a esquerda, letras e hifens.
const wmsCodigo = (v) => {
    const s = String(v === null || v === undefined ? '' : v).trim();
    return s === '' ? null : s;
};

function wmsCamposValidos(b) {
    if (!b.data) return 'Informe a data.';
    // Valida a data aqui: sem isto "31/02/2026" chegava crua no Postgres e o
    // usuario via um 500 com "date/time field value out of range".
    const d = String(b.data).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T12:00:00Z`))) {
        return 'Data invalida (use o formato AAAA-MM-DD).';
    }
    if (!String(b.loja || '').trim()) return 'Informe a loja.';
    return null;
}

// :id vem da URL: se nao for inteiro, responde 404 em vez de deixar o Postgres
// estourar 500 com "invalid input syntax for type integer".
function wmsIdValido(id) {
    return /^\d+$/.test(String(id));
}

app.get('/wms/erro-volume', async (req, res) => {
    try {
        const cond = [];
        const params = [];
        if (req.query.inicio) { params.push(req.query.inicio); cond.push(`data >= $${params.length}`); }
        if (req.query.fim) { params.push(req.query.fim); cond.push(`data <= $${params.length}`); }
        if (req.query.busca) {
            params.push(`%${String(req.query.busca).slice(0, 80)}%`);
            const p = `$${params.length}`;
            // volume entra na busca: e codigo de serie, o jeito natural de
            // conferir se um erro ja foi lancado antes de relancar duplicado.
            cond.push(`(loja ILIKE ${p} OR pedido ILIKE ${p} OR volume ILIKE ${p} OR descricao ILIKE ${p})`);
        }
        const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
        // Busca LIMITE+1 so para saber se sobrou coisa de fora. Sem isso a tela
        // mostraria "1000 registro(s)" como se fosse o total: o aviso de codigo
        // repetido e o CSV sairiam incompletos sem ninguem perceber.
        const LIMITE = 1000;
        const lista = await db.query(
            `SELECT id, data::text AS data, loja, pedido, volume, descricao, registrado_por
               FROM wms_erro_volume ${where}
              ORDER BY data DESC, id DESC LIMIT ${LIMITE + 1}`, params
        );
        const truncado = lista.rows.length > LIMITE;
        res.status(200).json({ lista: lista.rows.slice(0, LIMITE), truncado, limite: LIMITE });
    } catch (err) {
        console.error('[GET /wms/erro-volume]', err);
        res.status(500).json({ error: err.message });
    }
});

// Checa duplicidade por LOJA + VOLUME em qualquer data (case-insensitive), para
// o front avisar antes de gravar. Nao bloqueia nada: so devolve o que ja existe.
app.get('/wms/erro-volume/duplicados', async (req, res) => {
    try {
        const loja = wmsCodigo(req.query.loja);
        const volume = wmsCodigo(req.query.volume);
        if (!loja || !volume) return res.json([]);
        const r = await db.query(`
            SELECT id, data::text AS data, loja, pedido, volume, descricao, registrado_por
              FROM wms_erro_volume
             WHERE LOWER(TRIM(loja)) = LOWER($1)
               AND LOWER(TRIM(volume)) = LOWER($2)
             ORDER BY data DESC, id DESC
             LIMIT 5
        `, [loja, volume]);
        res.json(r.rows);
    } catch (err) {
        console.error('[GET /wms/erro-volume/duplicados]', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/wms/erro-volume', async (req, res) => {
    try {
        const b = req.body || {};
        const erro = wmsCamposValidos(b);
        if (erro) return res.status(400).json({ error: erro });
        const r = await db.query(`
            INSERT INTO wms_erro_volume (data, loja, pedido, volume, descricao, registrado_por)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, data::text AS data, loja, pedido, volume, descricao, registrado_por
        `, [
            b.data,
            String(b.loja).trim(),
            wmsCodigo(b.pedido),
            wmsCodigo(b.volume),
            String(b.descricao || '').trim() || null,
            req.usuarioLogado?.nome || null,
        ]);
        await registrarAuditoria(req, 'POST', 'wms_erro_volume', r.rows[0].id, { loja: r.rows[0].loja });
        res.status(201).json(r.rows[0]);
    } catch (err) {
        console.error('[POST /wms/erro-volume]', err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/wms/erro-volume/:id', async (req, res) => {
    try {
        if (!wmsIdValido(req.params.id)) return res.status(404).json({ error: 'Registro não encontrado.' });
        const b = req.body || {};
        const erro = wmsCamposValidos(b);
        if (erro) return res.status(400).json({ error: erro });
        const r = await db.query(`
            UPDATE wms_erro_volume
               SET data = $1, loja = $2, pedido = $3, volume = $4, descricao = $5, atualizado_em = NOW()
             WHERE id = $6
            RETURNING id, data::text AS data, loja, pedido, volume, descricao, registrado_por
        `, [
            b.data,
            String(b.loja).trim(),
            wmsCodigo(b.pedido),
            wmsCodigo(b.volume),
            String(b.descricao || '').trim() || null,
            req.params.id,
        ]);
        if (r.rowCount === 0) return res.status(404).json({ error: 'Registro não encontrado.' });
        await registrarAuditoria(req, 'PUT', 'wms_erro_volume', req.params.id, { loja: r.rows[0].loja });
        res.status(200).json(r.rows[0]);
    } catch (err) {
        console.error('[PUT /wms/erro-volume/:id]', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/wms/erro-volume/:id', async (req, res) => {
    try {
        if (!wmsIdValido(req.params.id)) return res.status(404).json({ error: 'Registro não encontrado.' });
        const r = await db.query('DELETE FROM wms_erro_volume WHERE id = $1 RETURNING id', [req.params.id]);
        if (r.rowCount === 0) return res.status(404).json({ error: 'Registro não encontrado.' });
        await registrarAuditoria(req, 'DELETE', 'wms_erro_volume', req.params.id, {});
        res.status(200).json({ deleted: r.rows[0] });
    } catch (err) {
        console.error('[DELETE /wms/erro-volume/:id]', err);
        res.status(500).json({ error: err.message });
    }
});


// ================= CHAT ENTRE USUARIOS =================
// Conversa: 'geral' (sala unica, destinatario_id IS NULL) ou id numerico do
// outro usuario (mensagem direta). Chave de leitura: 'geral' ou 'u:<id>'.
function chatChaveLeitura(conversa) {
    if (conversa === 'geral') return 'geral';
    const outro = Number(conversa);
    return Number.isInteger(outro) && outro > 0 ? `u:${outro}` : null;
}

async function chatMarcarLido(usuarioId, chave, ultimaId) {
    await db.query(
        `INSERT INTO sistema_chat_leitura (usuario_id, conversa, ultima_lida_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (usuario_id, conversa)
         DO UPDATE SET ultima_lida_id = GREATEST(sistema_chat_leitura.ultima_lida_id, EXCLUDED.ultima_lida_id)`,
        [usuarioId, chave, ultimaId]
    );
}

// Usuarios ativos (exceto o proprio) para escolher destinatario das diretas.
app.get('/chat/contatos', autenticar, async (req, res) => {
    try {
        const r = await db.query(
            'SELECT id, nome, usuario, perfil FROM sistema_usuarios WHERE ativo = TRUE AND id <> $1 ORDER BY nome',
            [req.usuarioLogado.id]
        );
        res.status(200).json(r.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Mensagens de uma conversa. ?conversa=geral|<idUsuario>  &after=<id opcional>
app.get('/chat/mensagens', autenticar, async (req, res) => {
    try {
        const me = req.usuarioLogado.id;
        const conversa = String(req.query.conversa || 'geral');
        const chave = chatChaveLeitura(conversa);
        if (!chave) return res.status(400).json({ error: 'Conversa invalida.' });
        const after = Number(req.query.after) || 0;

        let where, params;
        if (chave === 'geral') {
            where = 'destinatario_id IS NULL';
            params = [];
        } else {
            const outro = Number(conversa);
            where = '((remetente_id = $1 AND destinatario_id = $2) OR (remetente_id = $2 AND destinatario_id = $1))';
            params = [me, outro];
        }

        let rows;
        if (after > 0) {
            const r = await db.query(
                `SELECT id, remetente_id, remetente_nome, destinatario_id, texto, criado_em
                 FROM sistema_chat_mensagens
                 WHERE ${where} AND id > $${params.length + 1}
                 ORDER BY id ASC LIMIT 500`,
                [...params, after]
            );
            rows = r.rows;
        } else {
            const r = await db.query(
                `SELECT * FROM (
                    SELECT id, remetente_id, remetente_nome, destinatario_id, texto, criado_em
                    FROM sistema_chat_mensagens
                    WHERE ${where}
                    ORDER BY id DESC LIMIT 100
                 ) t ORDER BY id ASC`,
                params
            );
            rows = r.rows;
        }
        res.status(200).json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Envia mensagem. body: { texto, destinatario_id? }
app.post('/chat/mensagens', autenticar, async (req, res) => {
    try {
        const me = req.usuarioLogado;
        const texto = String(req.body?.texto || '').trim();
        if (!texto) return res.status(400).json({ error: 'Mensagem vazia.' });
        if (texto.length > 2000) return res.status(400).json({ error: 'Mensagem muito longa (max 2000).' });

        let destinatarioId = null;
        const destBruto = req.body?.destinatario_id;
        if (destBruto !== undefined && destBruto !== null && destBruto !== '') {
            destinatarioId = Number(destBruto);
            if (!Number.isInteger(destinatarioId) || destinatarioId <= 0) {
                return res.status(400).json({ error: 'Destinatario invalido.' });
            }
            const alvo = await db.query('SELECT id FROM sistema_usuarios WHERE id = $1 AND ativo = TRUE', [destinatarioId]);
            if (alvo.rowCount === 0) return res.status(404).json({ error: 'Destinatario nao encontrado.' });
        }

        const r = await db.query(
            `INSERT INTO sistema_chat_mensagens (remetente_id, remetente_nome, destinatario_id, texto)
             VALUES ($1, $2, $3, $4)
             RETURNING id, remetente_id, remetente_nome, destinatario_id, texto, criado_em`,
            [me.id, me.nome, destinatarioId, texto]
        );
        const msg = r.rows[0];
        await chatMarcarLido(me.id, destinatarioId ? `u:${destinatarioId}` : 'geral', msg.id);
        res.status(201).json(msg);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Marca conversa como lida ate a ultima mensagem. body: { conversa }
app.post('/chat/ler', autenticar, async (req, res) => {
    try {
        const me = req.usuarioLogado.id;
        const conversa = String(req.body?.conversa || 'geral');
        const chave = chatChaveLeitura(conversa);
        if (!chave) return res.status(400).json({ error: 'Conversa invalida.' });

        let maxRow;
        if (chave === 'geral') {
            maxRow = await db.query('SELECT COALESCE(MAX(id), 0) AS m FROM sistema_chat_mensagens WHERE destinatario_id IS NULL');
        } else {
            const outro = Number(conversa);
            maxRow = await db.query(
                `SELECT COALESCE(MAX(id), 0) AS m FROM sistema_chat_mensagens
                 WHERE (remetente_id = $1 AND destinatario_id = $2) OR (remetente_id = $2 AND destinatario_id = $1)`,
                [me, outro]
            );
        }
        const maxId = maxRow.rows[0].m;
        await chatMarcarLido(me, chave, maxId);
        res.status(200).json({ conversa: chave, ultima_lida_id: maxId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Resumo de nao-lidas para os badges (sala geral + por contato).
app.get('/chat/resumo', autenticar, async (req, res) => {
    try {
        const me = req.usuarioLogado.id;
        const geral = await db.query(
            `SELECT COUNT(*)::int AS qtd FROM sistema_chat_mensagens m
             LEFT JOIN sistema_chat_leitura l ON l.usuario_id = $1 AND l.conversa = 'geral'
             WHERE m.destinatario_id IS NULL AND m.remetente_id <> $1 AND m.id > COALESCE(l.ultima_lida_id, 0)`,
            [me]
        );
        const diretas = await db.query(
            `SELECT m.remetente_id AS usuario_id, u.nome, COUNT(*)::int AS qtd
             FROM sistema_chat_mensagens m
             INNER JOIN sistema_usuarios u ON u.id = m.remetente_id
             LEFT JOIN sistema_chat_leitura l ON l.usuario_id = $1 AND l.conversa = 'u:' || m.remetente_id
             WHERE m.destinatario_id = $1 AND m.id > COALESCE(l.ultima_lida_id, 0)
             GROUP BY m.remetente_id, u.nome`,
            [me]
        );
        const geralQtd = geral.rows[0].qtd;
        const totalDiretas = diretas.rows.reduce((acc, row) => acc + row.qtd, 0);
        res.status(200).json({ geral: geralQtd, diretas: diretas.rows, total: geralQtd + totalDiretas });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ================= BACKUP DIÁRIO AUTOMÁTICO =================
// Gera um pg_dump completo do banco todo dia no horário configurado, salvo em
// backups/diario/ com data/hora no nome, e mantém os últimos 30 dias.
// Embutido no app: ativa sozinho quando o servidor sobe (não precisa do
// Agendador do Windows). Só roda se o pg_dump estiver no PATH — se não estiver,
// defina PG_DUMP_PATH no .env apontando para o pg_dump.exe do PostgreSQL.
//
// O horário é configurável no .env porque ele depende do expediente: um
// agendamento perto do fim do dia simplesmente não acontece se a máquina for
// desligada antes. Já custou 5 dias úteis sem backup com o horário em 17:28,
// com a máquina sendo desligada entre 17:26 e 17:28. Mantenha uma folga
// confortável (>1h) entre BACKUP_HORA e o fim do expediente.
// Lê um inteiro do .env caindo no padrão quando ausente, vazio ou fora da
// faixa. O teste de string vazia vem antes do Number() de propósito:
// Number('') é 0 (e não NaN), o que faria "variável ausente" virar zero.
function _intNoIntervalo(valor, padrao, max) {
    const bruto = String(valor ?? '').trim();
    if (bruto === '') return padrao;
    const n = Number(bruto);
    return Number.isInteger(n) && n >= 0 && n <= max ? n : padrao;
}
const BACKUP_HORA = _intNoIntervalo(process.env.BACKUP_HORA, 16, 23);
const BACKUP_MINUTO = _intNoIntervalo(process.env.BACKUP_MINUTO, 0, 59);
const BACKUP_DIR = path.join(__dirname, '..', 'backups', 'diario');
const BACKUP_RETENCAO_DIAS = 30;

// Rede de segurança do agendamento: se ao subir o servidor o dump mais recente
// for mais velho que isso, roda um backup na hora. Cobre o dia em que a máquina
// foi desligada antes do horário marcado, feriados e a máquina passar dias
// desligada — situações em que o setTimeout diário nunca chega a disparar.
const BACKUP_IDADE_MAXIMA_H = _intNoIntervalo(process.env.BACKUP_IDADE_MAXIMA_H, 20, 720);
// Espera antes do backup de recuperação, para não disputar disco com a subida
// do servidor nem rodar durante uma rajada de restarts do watchdog.
const BACKUP_RECUPERACAO_ATRASO_MS = 90 * 1000;

// Cópias FORA da máquina (proteção contra perda do disco/PC — o banco e o
// backup local vivem no mesmo host). Lista de pastas separadas por ";" no .env.
// Cada backup diário é copiado para todas elas logo após ser gerado. Pode ser
// um HD/pen drive fixo (ex.: E:\backups-controle), um share de rede
// (\\servidor\backups) ou uma pasta sincronizada com nuvem (OneDrive/Drive).
// Vazio = recurso desligado (só backup local). Usa ";" e não "," porque os
// caminhos do Windows já contêm ":" (letra de unidade).
const BACKUP_DESTINOS_EXTERNOS = String(process.env.BACKUP_DESTINO_EXTERNO || '')
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);

function _doisDig(n) { return String(n).padStart(2, '0'); }

// Resolve o caminho do pg_dump. Ordem: (1) PG_DUMP_PATH do .env se existir no
// disco; (2) instalacoes padrao do PostgreSQL no Windows (maior versao primeiro);
// (3) 'pg_dump' cru, deixando o SO procurar no PATH. Cacheia o resultado.
// Objetivo: o backup funcionar mesmo sem PG_DUMP_PATH configurado, evitando o
// erro "spawn pg_dump ENOENT" quando o pg_dump nao esta no PATH do servico.
let _pgDumpResolvido;
function resolverCaminhoPgDump() {
    if (_pgDumpResolvido !== undefined) return _pgDumpResolvido;

    const configurado = String(process.env.PG_DUMP_PATH || '').trim();
    if (configurado) {
        if (fs.existsSync(configurado)) { _pgDumpResolvido = configurado; return _pgDumpResolvido; }
        console.warn(`[backup] PG_DUMP_PATH aponta para um arquivo inexistente: ${configurado}. Tentando autodetectar.`);
    }

    // Varre C:\Program Files\PostgreSQL\<versao>\bin\pg_dump.exe e escolhe a maior versao.
    const bases = [
        process.env.ProgramFiles || 'C:\\Program Files',
        process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    ];
    const candidatos = [];
    for (const base of bases) {
        const raiz = path.join(base, 'PostgreSQL');
        try {
            for (const versao of fs.readdirSync(raiz)) {
                const exe = path.join(raiz, versao, 'bin', 'pg_dump.exe');
                if (fs.existsSync(exe)) candidatos.push({ versao: parseInt(versao, 10) || 0, exe });
            }
        } catch (_) { /* pasta nao existe: ignora */ }
    }
    if (candidatos.length) {
        candidatos.sort((a, b) => b.versao - a.versao);
        _pgDumpResolvido = candidatos[0].exe;
        return _pgDumpResolvido;
    }

    // Ultimo recurso: nome cru (funciona se o pg_dump estiver no PATH).
    _pgDumpResolvido = 'pg_dump';
    return _pgDumpResolvido;
}

// Avisa no startup se o backup esta mal configurado (nao encontra o pg_dump).
// So loga: nunca lanca nem impede o servidor de subir.
function validarConfigBackup() {
    const caminho = resolverCaminhoPgDump();
    if (caminho === 'pg_dump') {
        console.warn(
            '[backup] ATENCAO: pg_dump nao encontrado nas instalacoes padrao do PostgreSQL. ' +
            'O backup diario so funcionara se o pg_dump estiver no PATH. Se nao estiver, ' +
            'defina PG_DUMP_PATH no .env (ex.: C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe).'
        );
    } else {
        console.log(`[backup] pg_dump localizado: ${caminho}`);
    }
    console.log(`[backup] horário diário: ${_doisDig(BACKUP_HORA)}:${_doisDig(BACKUP_MINUTO)} (ajuste com BACKUP_HORA/BACKUP_MINUTO no .env).`);
    if (BACKUP_DESTINOS_EXTERNOS.length === 0) {
        console.warn('[backup] sem BACKUP_DESTINO_EXTERNO no .env: havera apenas copia local (mesmo disco do banco).');
    }
}

// Trava simples contra dois pg_dump ao mesmo tempo. Sem ela, o backup agendado
// e o de recuperação podem se sobrepor e disputar disco à toa.
let _backupEmAndamento = false;

// Resolve com { arquivo, tamanhoMB } em sucesso; rejeita com Error em falha.
function executarBackupDiario() {
    return new Promise((resolve, reject) => {
        if (_backupEmAndamento) {
            console.warn('[backup] já há um backup em andamento; ignorando este disparo.');
            reject(new Error('backup já em andamento'));
            return;
        }
        _backupEmAndamento = true;
        const liberar = () => { _backupEmAndamento = false; };

        try {
            if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

            const agora = new Date();
            const stamp =
                `${agora.getFullYear()}-${_doisDig(agora.getMonth() + 1)}-${_doisDig(agora.getDate())}` +
                `_${_doisDig(agora.getHours())}-${_doisDig(agora.getMinutes())}-${_doisDig(agora.getSeconds())}`;
            const nomeBanco = process.env.DB_NAME || 'ControleDeEntregas';
            const arquivo = path.join(BACKUP_DIR, `${nomeBanco}_${stamp}.sql`);

            const pgDump = resolverCaminhoPgDump();
            const args = [
                '-h', process.env.DB_HOST || 'localhost',
                '-p', String(process.env.DB_PORT || 5432),
                '-U', process.env.DB_USER || 'postgres',
                '-d', nomeBanco,
                '-f', arquivo,
            ];

            console.log(`[backup] iniciando -> ${arquivo}`);
            const proc = spawn(pgDump, args, {
                env: { ...process.env, PGPASSWORD: process.env.DB_PASSWORD || '' },
            });

            let erro = '';
            proc.stderr.on('data', (d) => { erro += d.toString(); });
            proc.on('error', (e) => {
                liberar();
                const msg = `falha ao executar pg_dump: ${e.message}. ` +
                    `Garanta o pg_dump no PATH ou defina PG_DUMP_PATH no .env.`;
                console.error(`[backup] ${msg}`);
                reject(new Error(msg));
            });
            proc.on('close', (code) => {
                liberar();
                if (code === 0) {
                    let tamanhoMB = 0;
                    try { tamanhoMB = +(fs.statSync(arquivo).size / 1048576).toFixed(2); } catch (_) {}
                    console.log(`[backup] OK (${tamanhoMB} MB)`);
                    limparBackupsAntigos();
                    copiarBackupParaExternos(arquivo);
                    resolve({ arquivo, tamanhoMB });
                } else {
                    const msg = `pg_dump terminou com código ${code}. ${erro.trim()}`;
                    console.error(`[backup] ${msg}`);
                    reject(new Error(msg));
                }
            });
        } catch (err) {
            liberar();
            console.error('[backup] erro inesperado:', err.message);
            reject(err);
        }
    });
}

// mtime (ms) do dump mais recente em BACKUP_DIR, ou 0 se não houver nenhum.
function ultimoBackupMs(dir = BACKUP_DIR) {
    let maisRecente = 0;
    try {
        for (const nome of fs.readdirSync(dir)) {
            if (!nome.endsWith('.sql')) continue;
            const m = fs.statSync(path.join(dir, nome)).mtimeMs;
            if (m > maisRecente) maisRecente = m;
        }
    } catch (_) { /* pasta ainda não existe: trata como "sem backup" */ }
    return maisRecente;
}

// Roda no startup: se o backup mais recente for velho demais, dispara um agora.
// É o que garante o backup do dia quando a máquina é desligada antes do horário
// agendado — o setTimeout diário morre junto com o processo, sem deixar rastro.
function backupDeRecuperacao() {
    const ultimo = ultimoBackupMs();
    const idadeH = ultimo ? (Date.now() - ultimo) / 3600000 : Infinity;
    if (idadeH <= BACKUP_IDADE_MAXIMA_H) {
        console.log(`[backup] último backup tem ${idadeH.toFixed(1)}h — dentro do limite de ${BACKUP_IDADE_MAXIMA_H}h.`);
        return;
    }

    const motivo = ultimo
        ? `o mais recente tem ${idadeH.toFixed(1)}h`
        : 'nenhum backup encontrado em backups/diario';
    console.warn(`[backup] recuperação: ${motivo} (limite ${BACKUP_IDADE_MAXIMA_H}h). Rodando um backup agora.`);
    setTimeout(() => {
        executarBackupDiario().catch(() => {}); // erro já foi logado
    }, BACKUP_RECUPERACAO_ATRASO_MS).unref();
}

function limparBackupsAntigos(dir = BACKUP_DIR) {
    try {
        const limite = Date.now() - BACKUP_RETENCAO_DIAS * 24 * 60 * 60 * 1000;
        for (const nome of fs.readdirSync(dir)) {
            if (!nome.endsWith('.sql')) continue;
            const completo = path.join(dir, nome);
            if (fs.statSync(completo).mtimeMs < limite) {
                fs.unlinkSync(completo);
                console.log(`[backup] removido (>${BACKUP_RETENCAO_DIAS}d): ${completo}`);
            }
        }
    } catch (err) {
        console.error('[backup] erro ao limpar antigos:', err.message);
    }
}

// Copia um backup recém-gerado para cada destino externo configurado. Nunca
// lança: uma falha num destino (pen drive removido, share offline, sem
// permissão) é apenas registrada e não afeta o backup local nem os demais
// destinos. Aplica a mesma retenção de 30 dias em cada destino.
function copiarBackupParaExternos(arquivoOrigem) {
    if (BACKUP_DESTINOS_EXTERNOS.length === 0) {
        console.log('[backup] sem destino externo — defina BACKUP_DESTINO_EXTERNO no .env para guardar uma cópia fora da máquina.');
        return;
    }
    const nomeArquivo = path.basename(arquivoOrigem);
    for (const destino of BACKUP_DESTINOS_EXTERNOS) {
        try {
            if (!fs.existsSync(destino)) fs.mkdirSync(destino, { recursive: true });
            const alvo = path.join(destino, nomeArquivo);
            fs.copyFileSync(arquivoOrigem, alvo);
            let tamanhoMB = 0;
            try { tamanhoMB = +(fs.statSync(alvo).size / 1048576).toFixed(2); } catch (_) {}
            console.log(`[backup] copiado p/ externo (${tamanhoMB} MB): ${alvo}`);
            limparBackupsAntigos(destino);
        } catch (err) {
            console.error(`[backup] FALHA ao copiar para "${destino}": ${err.message}`);
        }
    }
}

// Agenda o próximo disparo às BACKUP_HORA:BACKUP_MINUTO e se re-agenda sozinho
// para o dia seguinte (recalcula a partir da hora atual, então não acumula drift).
function agendarBackupDiario() {
    const agora = new Date();
    const proximo = new Date(agora);
    proximo.setHours(BACKUP_HORA, BACKUP_MINUTO, 0, 0);
    if (proximo <= agora) proximo.setDate(proximo.getDate() + 1);
    const ms = proximo - agora;
    console.log(`[backup] próximo backup agendado para ${proximo.toLocaleString('pt-BR')}`);
    setTimeout(() => {
        executarBackupDiario().catch(() => {}); // erro já foi logado
        agendarBackupDiario();
    }, ms);
}

// ================= SERVIDOR =================
prepararBanco()
    .then(() => checklistWhatsApp.garantirTabela(db))
    .catch((err) => {
        console.error('Erro ao preparar banco:', err);
    })
    .finally(() => {
        // HTTPS quando houver certificado em back/certs; senao cai pra HTTP.
        // Reverter para HTTP = remover/renomear a pasta back/certs e reiniciar.
        const certDir = path.join(__dirname, 'certs');
        const keyPath = path.join(certDir, 'server.key');
        const crtPath = path.join(certDir, 'server.crt');
        const PORT = Number(process.env.PORT) || 3000;
        const aoSubir = (proto) => () => {
            console.log(`Controle de Entrega rodando na porta ${PORT} (${proto})`);
            validarConfigBackup();
            agendarBackupDiario();
            backupDeRecuperacao();
            // Manutencao sobrevive a restart: o watchdog reinicia o servidor
            // sozinho, e voltar liberado no meio de uma migracao seria o oposto
            // do que o modo existe para evitar.
            carregarManutencao().then(() => {
                if (_manutencao.ativa) {
                    console.warn(`[manutencao] LIGADA desde ${_manutencao.desde} (por ${_manutencao.por || '-'}). ` +
                        'So o super_adm grava ate desligar.');
                }
            });
            iniciarAlertas();
            // Volume e materiais do Checklist Expedicao entram sozinhos nas viagens
            // de hoje/amanha (back/tms-programacao.js; TMS_SYNC_CHECKLIST_MIN=0 desliga).
            tmsProgramacao.iniciarSincronizacao({
                db, preencherLojaIdDaViagem, registrarAuditoria,
                checklistListarTodos, checklistApi, mapearChecklistParaViagem,
                broadcastEvento,
            });
            agendarDigestDiario();
            vigiarVersaoFront();
            // Em rota com tudo entregue -> Retorno; dia anterior fechado -> Finalizada.
            tmsCiclo.iniciar({ db, registrarAuditoria });
            // Posicoes das plataformas a cada 5 s por padrao — back/rastreador.js.
            // Sessao do T4S guardada no banco (renovada pelo proprio T4S ou pelo
            // "Reconectar T4S") entra ANTES do 1o ciclo de coleta.
            // Sessoes do T4S e da Sat guardadas no banco entram ANTES do 1o ciclo.
            Promise.allSettled([require('./rastreador-t4s').carregarSessao(db), require('./rastreador-satfleet').carregarSessao(db)])
                .finally(() => rastreador.iniciar({ db }));
            // Eventos ao vivo pelo GPS (back/rastreador-ao-vivo.js): so registra e avisa.
            if (rastreador.configurado() || require('./rastreador-t4s').configurado() || require('./rastreador-satfleet').configurado()) {
                const statusGps = tmsStatusGps.criar({ db, rastreador,
                    handlers: { saida: registrarSaidaFabrica, retorno: rotasCicloTms.retorno },
                    registrarAuditoria, broadcastAuditoria, broadcastEvento });
                const historicoT4s = require('./rastreador-t4s-historico').criar({ db, rastreador,
                    broadcastEvento: (tipo, dados) => { rotasFrota.invalidarCache(); broadcastEvento(tipo, dados); } });
                const historicoSalvo = require('./rastreador-recuperacao').criar({ db, rastreador,
                    broadcastEvento: (tipo, dados) => { rotasFrota.invalidarCache(); broadcastEvento(tipo, dados); } });
                rastreadorAoVivo.iniciar({ db, rastreador, buscarViagensTms, agoraSP: previsaoTms.agoraSP,
                    recuperarHistorico: async (viagens) => {
                        const resultados = await Promise.allSettled([historicoSalvo.rodar(), historicoT4s.rodar(viagens)]);
                        for (const r of resultados) if (r.status === 'rejected') console.error('[gps recuperação]', r.reason.message);
                    },
                    ehRotaViagem: pernoite.ehRotaViagem,
                    broadcastEvento: (tipo, dados) => { rotasFrota.invalidarCache(); broadcastEvento(tipo, dados); },
                    aplicarStatus: (viagens) => statusGps.aplicar(viagens) });
            }
            // Segunda 07:00: planilha da semana anterior (local + file server + Telegram).
            relatorioSemanal.iniciar({ db, materiaisRota, lojasPes, chaveLoja });
            // Planilha "STATUS DO MATERIAL - <MES>" no OnlyOffice (foi/nao foi/pendente por item).
            materialStatus.iniciar({ db, lojasPes, chaveLoja });
        };
        if (fs.existsSync(keyPath) && fs.existsSync(crtPath)) {
            const https = require('https');
            const credenciais = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(crtPath) };
            https.createServer(credenciais, app).listen(PORT, '0.0.0.0', aoSubir('HTTPS'));
        } else {
            app.listen(PORT, '0.0.0.0', aoSubir('HTTP'));
        }
    });
