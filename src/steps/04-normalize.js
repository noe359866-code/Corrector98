/**
 * PASO 4 — ANALIZADOR Y NORMALIZADOR DE TÍTULOS
 * Recorre la tabla, analiza cada `title` con el parser y corrige:
 *   - type (movie / series / anime) según patrones y grupos de release
 *   - season / episode (S02E09, 2x09, S2 - 09, [Cap.209], "2nd Season - 09"…)
 *   - absolute_episode para anime con numeración absoluta ("One Piece - 1071")
 *
 * Optimización: las filas con un patch idéntico (p. ej. {type:'anime'}) se
 * actualizan juntas con UPDATE ... WHERE id IN (...), en lugar de una a una.
 */

import { log } from '../lib/logger.js';
import { mapPool } from '../lib/utils.js';
import { computeNormalization } from '../parsers/title-parser.js';

const COLUMNS = 'id,title,type,season,episode,absolute_episode,anilist_id,kitsu_id,mal_id';

export async function runNormalize(db, config) {
  /** @type {Map<string, {patch: object, ids: Array}>} */
  const byPatch = new Map();
  const fieldCounts = { type: 0, season: 0, episode: 0, absolute_episode: 0 };
  let scanned = 0;
  let changedRows = 0;
  const samples = [];

  for await (const page of db.scan(COLUMNS)) {
    scanned += page.length;
    for (const row of page) {
      const patch = computeNormalization(row);
      if (!patch) continue;

      changedRows++;
      for (const field of Object.keys(patch)) fieldCounts[field] = (fieldCounts[field] || 0) + 1;
      if (samples.length < 5) samples.push(`"${String(row.title).slice(0, 60)}" → ${JSON.stringify(patch)}`);

      const key = JSON.stringify(patch, Object.keys(patch).sort());
      if (!byPatch.has(key)) byPatch.set(key, { patch, ids: [] });
      byPatch.get(key).ids.push(row.id);
    }
  }

  samples.forEach((s) => log.info(`  Ej: ${s}`));
  log.info(
    `  Analizadas ${scanned} filas; ${changedRows} requieren corrección ` +
    `(type: ${fieldCounts.type}, season: ${fieldCounts.season}, episode: ${fieldCounts.episode}, ` +
    `absolute_episode: ${fieldCounts.absolute_episode}) en ${byPatch.size} patches distintos`,
  );

  if (config.dryRun) {
    log.info(`  [dry-run] se actualizarían ${changedRows} filas`);
    return { scanned, updated: changedRows, failed: 0, fieldCounts };
  }

  let updated = 0;
  let failed = 0;
  // Patches distintos en paralelo (concurrencia limitada); cada uno se aplica por lotes.
  await mapPool([...byPatch.values()], config.updateConcurrency, async ({ patch, ids }) => {
    const res = await db.updateByIds(patch, ids, 'normalize');
    updated += res.updated;
    failed += res.failed;
  });

  log.info(`  Actualizadas: ${updated}${failed ? `, fallidas: ${failed}` : ''}`);
  return { scanned, updated, failed, fieldCounts };
}
