const { Pool } = require("pg");
// override: o .env cifrado e a fonte da verdade. Sem isto, uma variavel de
// ambiente perdida na maquina (ex.: setx antigo de CHECKLIST_API_URL) vence o
// .env silenciosamente e o valor novo "nao pega" mesmo apos restart.
require('@dotenvx/dotenvx').config({ quiet: true, override: true });

const pool = new Pool(require('./db-config').configurarBanco());

// CRITICO: sem este handler, um erro numa conexao OCIOSA (ex.: o Postgres
// reinicia, timeout, blip de rede) vira excecao nao capturada e DERRUBA o
// processo inteiro. Era a causa do "servidor caindo toda hora". Aqui apenas
// logamos; o pool descarta a conexao ruim e cria outra sozinho.
pool.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] [db] erro em conexao ociosa do pool (ignorado, pool se recupera):`, err.message);
});

module.exports = {
    query: (text, params) => pool.query(text, params),
    connect: () => pool.connect(),
    pool,
};
