-- Coleta exclusiva do projeto seuprojetosupabase. Sem acesso de navegador.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;

CREATE TABLE public.cloud_gps_posicoes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fonte TEXT NOT NULL CHECK (fonte IN ('srf','t4s','sat')),
  device_id INTEGER NOT NULL CHECK (device_id > 0),
  placa TEXT NOT NULL CHECK (placa ~ '^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$'),
  nome TEXT, lat DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng DOUBLE PRECISION NOT NULL CHECK (lng BETWEEN -180 AND 180),
  velocidade NUMERIC(6,1) NOT NULL CHECK (velocidade BETWEEN 0 AND 220),
  rumo INTEGER, motor TEXT, online TEXT, parado_seg INTEGER,
  posicao_em TIMESTAMPTZ NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (lat <> 0 OR lng <> 0),
  UNIQUE (fonte,device_id,posicao_em)
);
CREATE INDEX cloud_gps_posicoes_recebidas ON public.cloud_gps_posicoes(criado_em,id);
CREATE INDEX cloud_gps_posicoes_horario ON public.cloud_gps_posicoes(posicao_em);
CREATE TABLE public.cloud_gps_estado (
  fonte TEXT PRIMARY KEY CHECK (fonte IN ('srf','t4s','sat')),
  tentativa_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), sucesso_em TIMESTAMPTZ,
  aparelhos INTEGER NOT NULL DEFAULT 0, rejeitados INTEGER NOT NULL DEFAULT 0, erro TEXT
);
CREATE TABLE public.cloud_gps_sessoes (
  fonte TEXT PRIMARY KEY CHECK (fonte IN ('t4s','sat')),
  cookie_cifrado TEXT NOT NULL, origem_hash TEXT NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE public.cloud_gps_trava (
  id INTEGER PRIMARY KEY CHECK (id=1), dono UUID, ate TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO public.cloud_gps_trava(id) VALUES (1);

ALTER TABLE public.cloud_gps_posicoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_gps_estado ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_gps_sessoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_gps_trava ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cloud_gps_posicoes,public.cloud_gps_estado,public.cloud_gps_sessoes,public.cloud_gps_trava FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.cloud_gps_posicoes,public.cloud_gps_estado,public.cloud_gps_sessoes,public.cloud_gps_trava TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.cloud_gps_posicoes_id_seq TO service_role;

CREATE FUNCTION public.gps_tentar_coleta(p_dono UUID) RETURNS BOOLEAN
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  WITH tomada AS (
    UPDATE public.cloud_gps_trava SET dono=p_dono,ate=clock_timestamp()+INTERVAL '120 seconds'
    WHERE id=1 AND ate < clock_timestamp() RETURNING id
  ) SELECT EXISTS(SELECT 1 FROM tomada);
$$;
CREATE FUNCTION public.gps_liberar_coleta(p_dono UUID) RETURNS VOID
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  UPDATE public.cloud_gps_trava SET dono=NULL,ate=clock_timestamp() WHERE id=1 AND dono=p_dono;
$$;
CREATE FUNCTION public.gps_salvar_sinais(p_fonte TEXT,p_lista JSONB) RETURNS INTEGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE n INTEGER;
BEGIN
  INSERT INTO public.cloud_gps_posicoes(fonte,device_id,placa,nome,lat,lng,velocidade,rumo,motor,online,parado_seg,posicao_em)
  SELECT p_fonte,p.device_id,p.placa,p.nome,p.lat,p.lng,p.velocidade,p.rumo,p.motor,p.online,p.parado_seg,p.posicao_em
  FROM jsonb_to_recordset(p_lista) AS p(device_id INTEGER,placa TEXT,nome TEXT,lat FLOAT8,lng FLOAT8,
    velocidade NUMERIC,rumo INTEGER,motor TEXT,online TEXT,parado_seg INTEGER,posicao_em TIMESTAMPTZ)
  ON CONFLICT(fonte,device_id,posicao_em) DO NOTHING;
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.gps_tentar_coleta(UUID),public.gps_liberar_coleta(UUID),public.gps_salvar_sinais(TEXT,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.gps_tentar_coleta(UUID),public.gps_liberar_coleta(UUID),public.gps_salvar_sinais(TEXT,JSONB) TO service_role;

-- A coleta sera agendada SOMENTE depois de configurar/testar a funcao e os segredos.
SELECT cron.schedule('gps-retencao','25 3 * * *',
  $$DELETE FROM public.cloud_gps_posicoes WHERE posicao_em < NOW()-INTERVAL '7 days';$$);
SELECT cron.schedule('gps-limpeza-agendamentos','35 3 * * *',
  $$DELETE FROM cron.job_run_details WHERE end_time < NOW()-INTERVAL '7 days';$$);
COMMIT;
