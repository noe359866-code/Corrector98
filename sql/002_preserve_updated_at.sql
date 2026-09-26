-- ============================================================================
-- OPCIONAL (muy recomendado): que el mantenimiento NO "rejuvenezca" los torrents
-- ============================================================================
-- Problema: los triggers BEFORE UPDATE ponen updated_at = now() en CUALQUIER
-- cambio. Cuando el script corrige un título o rellena un ID, el torrent parece
-- "recién actualizado" y el purgador de muertos (seeders = 0 y updated_at > 30
-- días) tarda otros 30 días en poder eliminarlo.
--
-- Solución: el script envía la cabecera HTTP `x-preserve-updated-at: true`.
-- PostgREST expone las cabeceras en current_setting('request.headers'), y esta
-- versión de la función conserva el updated_at anterior SOLO en ese caso. Tu
-- scraper y cualquier otro cliente siguen funcionando exactamente igual.
--
-- ⚠️ Antes de aplicar, comprueba que tu función actual solo hace
--    `NEW.updated_at = now()`:
--      SELECT pg_get_functiondef('public.update_torrents_updated_at'::regproc);
--    Si hace algo más, añade esa lógica en el bloque ELSE.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.update_torrents_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  req_headers json;
BEGIN
  BEGIN
    req_headers := nullif(current_setting('request.headers', true), '')::json;
  EXCEPTION WHEN others THEN
    req_headers := NULL; -- fuera de PostgREST (psql, cron…) no hay cabeceras
  END;

  IF coalesce(req_headers ->> 'x-preserve-updated-at', '') = 'true' THEN
    NEW.updated_at := OLD.updated_at;   -- cambio de mantenimiento: no cuenta como actividad
  ELSE
    NEW.updated_at := now();            -- comportamiento original
  END IF;

  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- Tu tabla tiene DOS triggers que ejecutan la misma función en cada UPDATE
-- (trg_torrents_updated_at y update_torrents_updated_at). Es redundante: el
-- resultado es idéntico con uno solo y cada UPDATE se ahorra una ejecución.
-- Descomenta para eliminar el duplicado:
-- DROP TRIGGER IF EXISTS update_torrents_updated_at ON public.torrents;
-- ----------------------------------------------------------------------------
