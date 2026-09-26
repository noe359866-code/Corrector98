/**
 * PASO 4 — ANALIZADOR Y NORMALIZADOR DE TÍTULOS
 * Recorre la tabla, analiza cada `title` con el parser y corrige:
 *   - type (movie / series / anime) según patrones y grupos de release
 *   - season / episode (S02E09, 2x09, S2 - 09, [Cap.209], "2nd Season - 09"…)
 *   - absolute_episode para anime con numeración absoluta ("One Piece - 1071")
 *   - (FILL_METADATA) quality, codec, hdr_format, channels y release_group vacíos
 *     o 'Unknown', deducidos del título. Nunca sobrescribe valores existentes.
 *
 * Optimización: las filas con un patch idéntico (p. ej. {type:'anime'}) se
 * actualizan juntas con UPDATE ... WHERE id IN (...), en lugar de una a una.
 */

import { log } from '../lib/logger.js';
import { mapPool } from '../lib/utils.js';
import { computeNormalization } from '../parsers/title-parser.js';
import { computeMetadataPatch } from '../parsers/metadata.js';

const COLUMNS = 'id,title,type,season,episode,absolute_episode,anilist_id,kitsu_id,mal_id,quality,codec,hdr_format,channels,release_group';

export async function runNormalize(db, config) {
  const fieldCounts = { type: 0, season: 0, episode: 0, absolute_episode: 0, quality: 0, codec: 0, hdr_format: 0, channels: 0, release_group: 0 };
  let scanned = 0;
  let changedRows = 0;
  let patchBatches = 0;
  let updated = 0;
  let failed = 0;
  const samples = [];

  for await (const page of db.scan(COLUMNS)) {
    scanned += page.length;
    const byPatch = new Map();
    for (const row of page) {
      const structural = computeNormalization(row);
      const metadata = config.fillMetadata ? computeMetadataPatch(row) : null;
      if (!structural && !metadata) continue;
      const patch = { ...structural, ...metadata };

      changedRows++;
      for (const field of Object.keys(patch)) fieldCounts[field] = (fieldCounts[field] || 0) + 1;
      if (samples.length < 5) samples.push(`"${String(row.title).slice(0, 60)}" → ${JSON.stringify(patch)}`);

      // Compare-and-set: solo escribir si los campos conservan su valor leído.
      // Evita sobrescribir metadatos rellenados por el scraper mientras escaneamos.
      const expected = Object.fromEntries(Object.keys(patch).map((field) => [field, row[field] ?? null]));
      const key = JSON.stringify({ patch, expected });
      if (!byPatch.has(key)) byPatch.set(key, { patch, expected, ids: [] });
      byPatch.get(key).ids.push(row.id);
    }
    patchBatches += byPatch.size;
    if (config.dryRun) {
      updated += [...byPatch.values()].reduce((sum, group) => sum + group.ids.length, 0);
      continue;
    }
    // Memoria acotada a PAGE_SIZE, no al número total de correcciones.
    await mapPool([...byPatch.values()], config.updateConcurrency, async ({ patch, expected, ids }) => {
      const guard = (query) => Object.entries(expected).reduce(
        (q, [field, value]) => value === null ? q.is(field, null) : q.eq(field, value), query,
      );
      const res = await db.updateByIds(patch, ids, 'normalize', guard);
      updated += res.updated;
      failed += res.failed;
    });
  }

  if (config.logSamples) samples.forEach((s) => log.info(`  Ej: ${s}`));
  log.info(
    `  Analizadas ${scanned} filas; ${changedRows} requieren corrección ` +
    `en ${patchBatches} grupos de actualización por página → ` +
    Object.entries(fieldCounts).filter(([, n]) => n).map(([k, n]) => `${k}: ${n}`).join(', '),
  );

  log.info(`  ${config.dryRun ? '[dry-run] Se actualizarían' : 'Actualizadas'}: ${updated}${failed ? `, fallidas: ${failed}` : ''}`);
  return { scanned, updated, failed, fieldCounts };
}
