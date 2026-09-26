-- ============================================================================
-- Índices que COMPLEMENTAN los que ya existen en public.torrents
-- (idx_torrents_unique_hash, idx_torrents_stremio_imdb, torrents_type_idx, …).
-- Ejecutar UNA vez en Supabase → SQL Editor. Son idempotentes (IF NOT EXISTS).
-- CONCURRENTLY no bloquea la tabla, pero no admite transacción: si el editor
-- se queja, ejecuta cada sentencia por separado.
-- ============================================================================

-- Paso 1 (adultos): ILIKE '%palabra%' sobre title / title_text → índices trigram.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX CONCURRENTLY IF NOT EXISTS torrents_title_trgm_idx
  ON public.torrents USING gin (title gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS torrents_title_text_trgm_idx
  ON public.torrents USING gin (title_text gin_trgm_ops)
  WHERE title_text IS NOT NULL;

-- Paso 2 (tamaño): filtro por tipo + tamaño (torrents_type_idx solo cubre `type`).
CREATE INDEX CONCURRENTLY IF NOT EXISTS torrents_type_size_idx
  ON public.torrents (type, size_bytes);

-- Paso 3 (muertos): índice parcial muy pequeño.
CREATE INDEX CONCURRENTLY IF NOT EXISTS torrents_dead_idx
  ON public.torrents (updated_at)
  WHERE seeders = 0;

-- Paso 5 (enriquecedor): torrents vivos con IDs faltantes. Indexado por `id` porque
-- el script pagina con keyset (WHERE id > x ORDER BY id LIMIT n).
CREATE INDEX CONCURRENTLY IF NOT EXISTS torrents_enrich_candidates_idx
  ON public.torrents (id)
  WHERE seeders > 0
    AND (tmdb_id IS NULL OR imdb_id IS NULL
         OR (type = 'anime' AND (anilist_id IS NULL OR kitsu_id IS NULL)));

-- La paginación keyset (WHERE id > x ORDER BY id) usa la PRIMARY KEY: no requiere índice extra.
