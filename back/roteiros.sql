-- ============================================================
-- Tabelas da feature "Análise de Tempo de Deslocamento"
-- (aba ⏱️ Deslocamento). Idêntico ao que o servidor cria sozinho
-- no prepararBanco() ao subir — com IF NOT EXISTS, é seguro rodar.
--
-- Rodar NA MÁQUINA DO SERVIDOR (192.0.2.10), pois DB_HOST=localhost:
--   psql -U postgres -d ControleDeEntregas -f "Z:\CONTROLE DE ENTREGA\back\roteiros.sql"
-- ============================================================

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
