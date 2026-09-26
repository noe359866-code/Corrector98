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
import { AuditLog } from './lib/audit.js';
import { runPipeline } from './lib/pipeline.js';
import { Db } from './lib/db.js';
import { log, redact } from './lib/logger.js';
import { takeSnapshot, compareSnapshots } from './lib/report.js';
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
    case 'normalize': return `${r.updated} actualizados de ${r.scanned} analizados; ${r.failed} fallidos`;
    case 'enrich': return `${r.resolved}/${r.groups} obras resueltas (${r.local} locales); ${Object.entries(r.filled).map(([k, v]) => `${k}:${v}`).join(' ')}`;
    case 'dedupe': return `${r.deleted} eliminados en ${r.groupsTrimmed} grupos`;
    default: return JSON.stringify(r);
  }
}

const markdownCell = (value) => redact(value).replace(/[\r\n]/g, ' ').replace(/[|`<>]/g, ' ');

async function writeStepSummary(config, results, initial, final, reportRows) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const lines = [
    `## 🧹 Mantenimiento de \`${config.table}\`${config.dryRun ? ' — DRY RUN (sin cambios)' : ''}`,
    '',
    '| Paso | Estado | Resultado | Duración |',
    '|---|---|---|---|',
    ...results.map((r) => `| ${r.title} | ${r.status} | ${r.error ? `\`${markdownCell(r.error).slice(0, 120)}\`` : describe(r.id, r.result)} | ${r.seconds}s |`),
    '',
    `**Filas:** ${initial} → ${final ?? 'n/d'}`,
  ];
  if (reportRows) {
    lines.push('', '### 📊 Salud de la tabla', '', '| Métrica | Antes | Después | Δ |', '|---|---:|---:|---:|');
    for (const row of reportRows) lines.push(`| ${row.join(' | ')} |`);
  }
  const scanSucceeded = results.every((result) => result.status !== '❌' && result.status !== '⛔ bloqueado');
  const repository = process.env.GITHUB_REPOSITORY;
  if (config.dryRun && scanSucceeded && repository) {
    const server = (process.env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/$/, '');
    const applyWorkflow = `${server}/${repository}/actions/workflows/apply.yml`;
    lines.push(
      '',
      '### Siguiente paso — revisión manual',
      '',
      'El análisis terminó sin errores. Revisa los resultados y el artefacto de auditoría de esta ejecución. Si apruebas el plan, inicia manualmente el workflow protegido:',
      '',
      `[Abrir «Aplicar mantenimiento aprobado»](${applyWorkflow})`,
      '',
      'Este enlace no inicia ni autoriza cambios. La aplicación requiere confirmación, ticket, respaldo verificado y las aprobaciones configuradas.',
    );
  }
  await fs.appendFile(file, `${lines.join('\n')}\n`);
}

async function main() {
  const started = Date.now();
  const config = loadConfig();
  const audit = await AuditLog.open(config.auditDir);
  let db;
  try {
    db = new Db(config, null, audit);
    await audit.record('run.start', { database: new URL(config.supabaseUrl).origin, table: config.table, dryRun: config.dryRun, steps: config.steps,
      maxDeleteRatio: config.maxDeleteRatio, maxDeleteRows: config.maxDeleteRows,
      changeTicket: config.changeTicket, backupReference: config.backupReference,
      actor: process.env.GITHUB_ACTOR || 'local', commit: process.env.GITHUB_SHA || null });
    log.info(`Auditoría: ${audit.file} · ejecución ${audit.runId}`);

    log.info(`Corrector98 · tabla "${config.table}" · pasos: ${config.steps.join(', ')}${config.dryRun ? ' · DRY RUN' : ''}`);
    db.initialRowCount = await db.countTotal();
    log.info(`Filas iniciales: ${db.initialRowCount}`);
    const before = config.report ? await takeSnapshot(db) : null;

    const results = await runPipeline(PIPELINE, config, db, audit);

    const finalCount = config.dryRun ? null : await db.countTotal().catch(() => null);
    // En dry-run nada cambia: el "después" sería idéntico, así que solo se muestra el "antes".
    const after = config.report && !config.dryRun ? await takeSnapshot(db) : null;
    const reportRows = before ? compareSnapshots(before, after) : null;

    log.info('\n══════════════ RESUMEN ══════════════');
    for (const r of results) {
      log.info(`${r.status.padEnd(2)} ${r.title.padEnd(50)} ${r.error ? `ERROR: ${r.error}` : describe(r.id, r.result)}`);
    }
    log.info(`Filas: ${db.initialRowCount} → ${finalCount ?? (config.dryRun ? `(dry-run: ${db.totalDeleted} se borrarían)` : 'no disponible')}`);
    if (reportRows) {
      log.info('\n──────── Salud de la tabla (antes → después) ────────');
      for (const [label, b, a, d] of reportRows) log.info(`${label.padEnd(28)} ${b.padStart(12)} → ${a.padStart(12)}   ${d}`);
    }
    log.info(`Tiempo total: ${((Date.now() - started) / 1000).toFixed(1)}s`);

    await writeStepSummary(config, results, db.initialRowCount, finalCount, reportRows);

    const failed = results.some((r) => r.status === '❌') || (!config.dryRun && finalCount === null);
    await audit.record('run.end', { status: failed ? 'failed' : 'success', initialCount: db.initialRowCount,
      finalCount, deleted: db.totalDeleted, dryRun: config.dryRun, seconds: (Date.now() - started) / 1000 });
    if (failed) process.exitCode = 1;
  } catch (error) {
    await audit.record('run.end', { status: 'failed', deleted: db?.totalDeleted ?? 0 }).catch(() => {});
    throw error;
  } finally {
    await audit.close();
  }
}

main().catch((err) => {
  log.error(err.message);
  log.debug(err.stack);
  process.exitCode = 1;
});
