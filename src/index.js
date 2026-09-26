#!/usr/bin/env node
/**
 * CORRECTOR98 — Mantenimiento de la tabla `torrents` en Supabase
 * ==================================================================
 * Pipeline (en este orden, cada paso se puede activar/desactivar con STEPS):
 *
 *   1. adult      Filtro de contenido adulto
 *   2. size       Filtro anti-fakes por tamaño (movie < 150 MB, series < 30 MB)
 *   3. dead       Purgador de torrents muertos (seeders = 0 y > 30 días sin actualizar)
 *   4. normalize  Analizador/normalizador de títulos (type, season, episode)
 *   5. enrich     Enriquecedor de IDs (AniList, Kitsu, TMDB → imdb_id)
 *   6. dedupe     Deduplicador: top 2 español + top 2 inglés por obra/episodio
 *
 * Los borrados baratos van primero para que los pasos costosos (APIs,
 * deduplicación) trabajen sobre menos filas; el deduplicador va al final para
 * aprovechar los IDs recién enriquecidos al agrupar.
 *
 * Uso:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node src/index.js
 *   DRY_RUN=true STEPS=adult,dedupe node src/index.js
 */

import fs from 'node:fs/promises';
import { loadConfig } from './config.js';
import { Db } from './lib/db.js';
import { log } from './lib/logger.js';
import { runAdultFilter } from './steps/01-adult-filter.js';
import { runSizeFilter } from './steps/02-size-filter.js';
import { runDeadPurge } from './steps/03-dead-purge.js';
import { runNormalize } from './steps/04-normalize.js';
import { runEnrich } from './steps/05-enrich.js';
import { runDedupe } from './steps/06-dedupe.js';

const PIPELINE = [
  { id: 'adult', title: '1. Filtro de contenido adulto', run: runAdultFilter },
  { id: 'size', title: '2. Filtro anti-fakes por tamaño', run: runSizeFilter },
  { id: 'dead', title: '3. Purgador de torrents muertos', run: runDeadPurge },
  { id: 'normalize', title: '4. Analizador y normalizador de títulos', run: runNormalize },
  { id: 'enrich', title: '5. Enriquecedor de IDs (AniList / Kitsu / TMDB)', run: runEnrich },
  { id: 'dedupe', title: '6. Deduplicador (top 2 español / top 2 inglés)', run: runDedupe },
];

/** Resumen legible de las métricas de cada paso para la tabla final. */
function describe(id, r) {
  if (!r) return '—';
  switch (id) {
    case 'adult': return `${r.deleted} eliminados (de ${r.candidates} candidatos)`;
    case 'size': return `${r.deleted} eliminados (${r.skippedMistyped} mal tipados preservados)`;
    case 'dead': return `${r.deleted} eliminados`;
    case 'normalize': return `${r.updated} actualizados de ${r.scanned} analizados`;
    case 'enrich': return `${r.resolved}/${r.groups} obras resueltas; ${Object.entries(r.filled).map(([k, v]) => `${k}:${v}`).join(' ')}`;
    case 'dedupe': return `${r.deleted} eliminados en ${r.groupsTrimmed} grupos`;
    default: return JSON.stringify(r);
  }
}

async function writeStepSummary(config, results, initial, final) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const lines = [
    `## 🧹 Mantenimiento de \`${config.table}\`${config.dryRun ? ' — DRY RUN (sin cambios)' : ''}`,
    '',
    '| Paso | Estado | Resultado | Duración |',
    '|---|---|---|---|',
    ...results.map((r) => `| ${r.title} | ${r.status} | ${r.error ? `\`${r.error.slice(0, 120)}\`` : describe(r.id, r.result)} | ${r.seconds}s |`),
    '',
    `**Filas:** ${initial} → ${final ?? 'n/d'}`,
  ];
  await fs.appendFile(file, `${lines.join('\n')}\n`);
}

async function main() {
  const started = Date.now();
  const config = loadConfig();
  const db = new Db(config);

  log.info(`Corrector98 · tabla "${config.table}" · pasos: ${config.steps.join(', ')}${config.dryRun ? ' · DRY RUN' : ''}`);
  db.initialRowCount = await db.countTotal();
  log.info(`Filas iniciales: ${db.initialRowCount}`);

  const results = [];
  for (const step of PIPELINE) {
    if (!config.steps.includes(step.id)) {
      results.push({ ...step, status: '⏭️ omitido', seconds: 0 });
      continue;
    }
    log.group(step.title);
    const t0 = Date.now();
    try {
      const result = await step.run(db, config);
      results.push({ ...step, status: '✅', result, seconds: ((Date.now() - t0) / 1000).toFixed(1) });
    } catch (err) {
      // Un paso fallido no impide ejecutar los siguientes (son independientes),
      // pero el proceso terminará con código de error para que Actions lo marque.
      log.error(`${step.title}: ${err.message}`);
      log.debug(err.stack);
      results.push({ ...step, status: '❌', error: err.message, seconds: ((Date.now() - t0) / 1000).toFixed(1) });
    } finally {
      log.groupEnd();
    }
  }

  const finalCount = config.dryRun ? null : await db.countTotal().catch(() => null);

  log.info('\n══════════════ RESUMEN ══════════════');
  for (const r of results) {
    log.info(`${r.status.padEnd(2)} ${r.title.padEnd(50)} ${r.error ? `ERROR: ${r.error}` : describe(r.id, r.result)}`);
  }
  log.info(`Filas: ${db.initialRowCount} → ${finalCount ?? `(dry-run: ${db.totalDeleted} se borrarían)`}`);
  log.info(`Tiempo total: ${((Date.now() - started) / 1000).toFixed(1)}s`);

  await writeStepSummary(config, results, db.initialRowCount, finalCount);

  if (results.some((r) => r.status === '❌')) process.exitCode = 1;
}

main().catch((err) => {
  log.error(err.message);
  log.debug(err.stack);
  process.exit(1);
});
