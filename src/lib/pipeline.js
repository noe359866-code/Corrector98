import { log, redact } from './logger.js';

/** Fail-fast: no deduplicar después de una normalización/enriquecimiento fallido. */
export async function runPipeline(pipeline, config, db, audit) {
  const results = [];
  let halted = false;
  for (const step of pipeline) {
    if (!config.steps.includes(step.id) || halted) {
      results.push({ id: step.id, title: step.title, status: halted ? '⛔ bloqueado' : '⏭️ omitido', seconds: 0 });
      continue;
    }
    log.group(step.title);
    const started = Date.now();
    let entry;
    try {
      await audit.record('step.start', { step: step.id });
      const result = await step.run(db, config);
      const failed = (result?.failed ?? 0) > 0 || (result?.errors ?? 0) > 0 || db.writesBlocked;
      entry = { id: step.id, title: step.title, status: failed ? '❌' : '✅', result };
      await audit.record('step.end', { step: step.id, status: failed ? 'failed' : 'success', metrics: result });
      halted = failed;
    } catch (error) {
      halted = true;
      log.error(`${step.title}: ${error.message}`);
      entry = { id: step.id, title: step.title, status: '❌', error: redact(error.message) };
      // No volcamos respuestas del servidor en el registro de auditoría.
      await audit.record('step.end', { step: step.id, status: 'failed' }).catch(() => {});
    } finally {
      if (halted) db.writesBlocked = true;
      log.groupEnd();
    }
    results.push({ ...entry, seconds: ((Date.now() - started) / 1000).toFixed(1) });
  }
  return results;
}
