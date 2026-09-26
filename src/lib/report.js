/**
 * INFORME DE SALUD DE LA TABLA
 * Toma una "foto" con conteos clave al inicio y al final de la ejecución para
 * ver el impacto del mantenimiento (se muestra en el log y en el Job Summary).
 * Cada conteo es tolerante a fallos: si el exacto hace timeout usa el estimado.
 */

const METRICS = [
  ['total', 'Total de torrents', (q) => q],
  ['movie', 'Películas', (q) => q.eq('type', 'movie')],
  ['series', 'Series', (q) => q.eq('type', 'series')],
  ['anime', 'Anime', (q) => q.eq('type', 'anime')],
  ['dead', 'Sin seeders (seeders = 0)', (q) => q.eq('seeders', 0)],
  ['orphans', 'Huérfanos (sin ningún ID)', (q) => q.is('imdb_id', null).is('tmdb_id', null).is('kitsu_id', null).is('anilist_id', null).is('mal_id', null)],
  ['no_imdb', 'Sin imdb_id', (q) => q.is('imdb_id', null)],
  ['unknown_quality', "quality = 'Unknown'", (q) => q.eq('quality', 'Unknown')],
];

export async function takeSnapshot(db) {
  const results = await Promise.all(METRICS.map(([, , f]) => db.safeCount(f)));
  return Object.fromEntries(METRICS.map(([key], i) => [key, results[i]]));
}

const fmt = (r) => (r?.count === null || r?.count === undefined ? 'n/d' : `${r.count.toLocaleString('es')}${r.mode === 'planned' ? ' (≈)' : ''}`);

/** Filas [métrica, antes, después, diferencia] listas para imprimir. */
export function compareSnapshots(before, after) {
  return METRICS.map(([key, label]) => {
    const b = before?.[key];
    const a = after?.[key];
    const diff = b?.count != null && a?.count != null ? a.count - b.count : null;
    return [label, fmt(b), after ? fmt(a) : '—', diff === null ? '—' : `${diff > 0 ? '+' : ''}${diff.toLocaleString('es')}`];
  });
}
