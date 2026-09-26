/**
 * PASO 2 — FILTRO ANTI-FAKES POR TAMAÑO
 *  - type = 'movie'  AND size_bytes < MIN_MOVIE_MB  (150 MB por defecto)
 *  - type = 'series' AND size_bytes < MIN_SERIES_MB (30 MB por defecto)
 *
 * Protecciones:
 *  - size_bytes NULL nunca se borra (Postgres: NULL < x es NULL → no entra).
 *  - size_bytes = 0 se considera "desconocido" y se conserva salvo
 *    SIZE_FILTER_INCLUDE_ZERO=true.
 *  - Una "película" cuyo título es claramente un episodio (S01E05, "[SubsPlease] X - 05")
 *    está mal tipada: NO se borra aquí; el paso 4 (normalizador) la re-tipará y en la
 *    próxima ejecución se evaluará con el umbral correcto.
 */

import { log } from '../lib/logger.js';
import { formatBytes } from '../lib/utils.js';
import { parseTitle } from '../parsers/title-parser.js';

export async function runSizeFilter(db, config) {
  const rules = [
    { type: 'movie', minBytes: config.minMovieBytes },
    { type: 'series', minBytes: config.minSeriesBytes },
  ];

  const stats = { deleted: 0, skippedMistyped: 0 };

  for (const { type, minBytes } of rules) {
    const ids = [];
    const applyFilters = (q) => {
      let query = q.eq('type', type).lt('size_bytes', minBytes);
      if (!config.sizeFilterIncludeZero) query = query.gt('size_bytes', 0);
      return query;
    };

    for await (const page of db.scan('id,title,size_bytes', applyFilters)) {
      for (const row of page) {
        if (type === 'movie') {
          const parsed = parseTitle(row.title);
          const looksLikeEpisode =
            (parsed.type === 'series' || parsed.type === 'anime') &&
            parsed.confidence !== 'low' &&
            (parsed.episode !== null || parsed.isPack);
          if (looksLikeEpisode) {
            stats.skippedMistyped++;
            continue;
          }
        }
        ids.push(row.id);
      }
    }

    const deleted = await db.deleteByIds(ids, `size:${type}`);
    stats.deleted += deleted;
    log.info(`  ${type.padEnd(6)} < ${formatBytes(minBytes)}: ${deleted} eliminados`);
  }

  if (stats.skippedMistyped) {
    log.info(`  ${stats.skippedMistyped} "películas" pequeñas parecen episodios mal tipados → se conservan para el normalizador`);
  }
  return stats;
}
