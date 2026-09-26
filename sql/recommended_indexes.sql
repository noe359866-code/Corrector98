-- ============================================================================
-- Índices recomendados para que el mantenimiento sea rápido en tablas grandes.
-- Ejecutar UNA vez en Supabase → SQL Editor. Son idempotentes (IF NOT EXISTS).
-- CONCURRENTLY evita bloquear la tabla mientras se crean (no admite transacción:
-- ejecútalos de uno en uno si el editor se queja).
-- ============================================================================

-- Paso 1: ILIKE '%palabra%' sobre title → índice trigram.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX CONCURRENTLY IF NOT EXISTS torrents_title_trgm_idx
  ON public.torrents USING gin (title gin_trgm_ops);

-- Paso 2: filtro por tipo + tamaño.
CREATE INDEX CONCURRENTLY IF NOT EXISTS torrents_type_size_idx
  ON public.torrents (type, size_bytes);

-- Paso 3: torrents muertos (índice parcial, muy pequeño).
CREATE INDEX CONCURRENTLY IF NOT EXISTS torrents_dead_idx
  ON public.torrents (updated_at)
  WHERE seeders = 0;

-- Paso 5: huérfanos sin IDs (índices parciales).
CREATE INDEX CONCURRENTLY IF NOT EXISTS torrents_missing_tmdb_idx
  ON public.torrents (id)
  WHERE tmdb_id IS NULL OR imdb_id IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS torrents_anime_missing_ids_idx
  ON public.torrents (id)
  WHERE type = 'anime' AND (anilist_id IS NULL OR kitsu_id IS NULL);

-- La paginación keyset (WHERE id > x ORDER BY id) usa la PRIMARY KEY: no requiere índice extra.
