/**
 * PASO 1 — FILTRO DE CONTENIDO ADULTO
 * Elimina los registros cuyo `title` o `title_text` contiene palabras clave de contenido adulto.
 *
 *  1) Pre-filtro en Postgres: title ILIKE ANY(patrones) → solo descargamos candidatos.
 *  2) Verificación en JS con límites de palabra + lista blanca (sin falsos positivos
 *     del tipo "Javier" por "jav", o la saga "xXx").
 */

import { log } from '../lib/logger.js';
import { DEFAULT_ADULT_KEYWORDS, buildAdultRegex, buildIlikePatterns, isAdultTitle } from '../parsers/adult.js';

export async function runAdultFilter(db, config) {
  const keywords = [...DEFAULT_ADULT_KEYWORDS, ...config.adultExtraKeywords];
  const regex = buildAdultRegex(keywords);
  // Se revisan `title` (nombre del release) y `title_text` (título efectivo).
  const ilikeFilter = buildIlikePatterns(keywords)
    .flatMap((p) => [`title.ilike.${p}`, `title_text.ilike.${p}`])
    .join(',');

  let candidates = 0;
  const ids = [];
  const samples = [];

  for await (const page of db.scan('id,title,title_text', (q) => q.or(ilikeFilter))) {
    candidates += page.length;
    for (const row of page) {
      if (isAdultTitle(row.title, regex) || isAdultTitle(row.title_text, regex)) {
        ids.push(row.id);
        if (samples.length < 5) samples.push(row.title);
      }
    }
  }

  if (samples.length) log.info(`  Ejemplos: ${samples.map((s) => `"${s.slice(0, 70)}"`).join(' | ')}`);
  const deleted = await db.deleteByIds(ids, 'adult');
  log.info(`  Candidatos ILIKE: ${candidates} → confirmados y eliminados: ${deleted}`);
  return { deleted, candidates };
}
