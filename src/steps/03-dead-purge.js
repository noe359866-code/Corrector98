/**
 * PASO 3 — PURGADOR DE TORRENTS MUERTOS
 * Elimina torrents con seeders = 0 cuya última actualización (updated_at) tiene
 * más de DEAD_AFTER_DAYS días (30 por defecto).
 */

import { log } from '../lib/logger.js';

export async function runDeadPurge(db, config) {
  const cutoff = new Date(Date.now() - config.deadAfterDays * 24 * 60 * 60 * 1000).toISOString();

  const applyFilters = (q) => q.eq('seeders', 0).lt('updated_at', cutoff);
  const ids = [];
  for await (const page of db.scan('id', applyFilters)) {
    for (const row of page) ids.push(row.id);
  }

  const deleted = await db.deleteByIds(ids, 'dead', applyFilters);
  log.info(`  seeders = 0 y updated_at < ${cutoff.slice(0, 10)}: ${deleted} eliminados`);
  return { deleted, cutoff };
}
