/**
 * PASO 5 — ENRIQUECEDOR DE IDs
 * ------------------------------------------------------------------
 * Para torrents VIVOS (seeders >= ENRICH_MIN_SEEDERS) con IDs faltantes:
 *
 *  A) Propagación local (gratis): si otro torrent ya identificado tiene el mismo
 *     título limpio + año + tipo, se copian sus IDs. Si los "donantes" no
 *     coinciden entre sí (p. ej. dos obras homónimas) no se copia nada.
 *  B) APIs públicas, una consulta por OBRA (no por fila):
 *     - Anime: AniList (GraphQL) → anilist_id + mal_id; Kitsu por mapping MAL
 *       (exacto) o por texto → kitsu_id; TMDB opcional.
 *     - Películas/series (requiere TMDB_API_KEY): /find si hay imdb_id,
 *       /external_ids si hay tmdb_id, o /search validado → tmdb_id + imdb_id.
 *
 *  - Los resultados se validan por similitud de título (+ año) y contra los
 *    CHECK de la tabla (imdb_id ~ '^tt[0-9]+$', ids bigint > 0).
 *  - Nunca se sobrescriben IDs existentes (UPDATE … WHERE columna IS NULL).
 *  - Estado persistente en la propia tabla: ids_checked_at, ids_attempts,
 *    ids_source, ids_confidence → reintentos con backoff exponencial
 *    (24 h, 48 h, 96 h… hasta ENRICH_RETRY_MAX_DAYS) sin cachés externas.
 */

import { log } from '../lib/logger.js';
import { HttpError } from '../lib/http.js';
import { cleanTitleForSearch, normalizeForCompare } from '../parsers/title-cleaner.js';
import { parseTitle } from '../parsers/title-parser.js';
import { AniListClient } from '../providers/anilist.js';
import { KitsuClient } from '../providers/kitsu.js';
import { TmdbClient } from '../providers/tmdb.js';

const COLUMNS = 'id,title,title_text,type,seeders,imdb_id,tmdb_id,anilist_id,kitsu_id,mal_id,ids_checked_at,ids_attempts';
const DONOR_COLUMNS = 'id,title,title_text,type,imdb_id,tmdb_id,anilist_id,kitsu_id,mal_id';
const ID_FIELDS = ['imdb_id', 'tmdb_id', 'anilist_id', 'kitsu_id', 'mal_id'];
const isNil = (v) => v === null || v === undefined || v === '';

// ---------------------------------------------------------------------------
// Utilidades puras (exportadas para tests)
// ---------------------------------------------------------------------------

/** ¿Toca reintentar esta fila? Backoff exponencial sobre ids_checked_at / ids_attempts. */
export function isDueForRetry(row, now, { baseHours, maxDays }) {
  if (!row.ids_checked_at) return true;
  const attempts = Math.max(0, Number(row.ids_attempts) || 0);
  const delayHours = Math.min(baseHours * 2 ** Math.max(0, attempts - 1), maxDays * 24);
  return now - new Date(row.ids_checked_at).getTime() >= delayHours * 3_600_000;
}

/** Valida los IDs contra los CHECK/tipos de la tabla; descarta lo inválido. */
export function sanitizeIds(found) {
  const out = {};
  for (const [field, value] of Object.entries(found)) {
    if (field === 'imdb_id') {
      if (typeof value === 'string' && /^tt[0-9]+$/.test(value)) out.imdb_id = value;
    } else if (ID_FIELDS.includes(field)) {
      const n = Number(value);
      if (Number.isSafeInteger(n) && n > 0) out[field] = n;
    }
  }
  return out;
}

function resolveKind(row) {
  if (row.type === 'anime' || row.type === 'movie' || row.type === 'series') return row.type;
  return parseTitle(row.title).type || 'movie';
}

/** Texto a usar para buscar: title_text (título "efectivo") si existe, si no el nombre del release. */
function searchInfo(row) {
  const primary = cleanTitleForSearch(row.title_text || row.title);
  if (primary.query) {
    if (!primary.year && row.title_text) primary.year = cleanTitleForSearch(row.title).year;
    return primary;
  }
  return cleanTitleForSearch(row.title);
}

export const titleKey = (kind, query, year) => `${kind}|q:${normalizeForCompare(query)}|${year ?? ''}`;

/** Clave de grupo: identificadores exactos primero; si no hay, título + año. */
export function groupKeyFor(row, kind, query, year) {
  if (kind === 'anime') {
    if (!isNil(row.anilist_id)) return `anime|anilist:${row.anilist_id}`;
    if (!isNil(row.mal_id)) return `anime|mal:${row.mal_id}`;
    return titleKey(kind, query, year);
  }
  if (!isNil(row.imdb_id)) return `${kind}|imdb:${row.imdb_id}`;
  if (!isNil(row.tmdb_id)) return `${kind}|tmdb:${row.tmdb_id}`;
  return titleKey(kind, query, year);
}

/**
 * Decide qué IDs copiar a partir de los donantes locales.
 * @param {Record<string, Set>} donorValues  valores distintos por campo
 * @returns {object|null} ids a copiar, o null si hay conflicto
 */
export function pickLocalIds(donorValues) {
  for (const field of ['imdb_id', 'tmdb_id', 'anilist_id', 'kitsu_id', 'mal_id']) {
    if (donorValues[field]?.size > 1) return null; // obras homónimas → ambiguo
  }
  const out = {};
  for (const field of ID_FIELDS) if (donorValues[field]?.size === 1) out[field] = [...donorValues[field]][0];
  return out;
}

// ---------------------------------------------------------------------------
// Paso principal
// ---------------------------------------------------------------------------

export async function runEnrich(db, config) {
  const startedAt = Date.now();
  const deadline = startedAt + config.enrichMaxMinutes * 60_000;
  const tmdbEnabled = Boolean(config.tmdbApiKey);
  if (!tmdbEnabled) log.info('  TMDB_API_KEY no configurada → solo se enriquecerá anime (AniList + Kitsu).');

  const anilist = new AniListClient({ apiUrl: config.anilistApiUrl, rpm: config.anilistRpm, matchThreshold: config.matchThreshold });
  const kitsu = new KitsuClient({ apiUrl: config.kitsuApiUrl, rpm: config.kitsuRpm, matchThreshold: config.matchThreshold });
  const tmdb = tmdbEnabled
    ? new TmdbClient({ apiKey: config.tmdbApiKey, apiUrl: config.tmdbApiUrl, rpm: config.tmdbRpm, matchThreshold: config.matchThreshold })
    : null;

  // --- 1) Candidatos ---------------------------------------------------------
  const animeMissing = 'and(type.eq.anime,or(anilist_id.is.null,kitsu_id.is.null))';
  const missingFilter = tmdbEnabled ? `tmdb_id.is.null,imdb_id.is.null,${animeMissing}` : animeMissing;
  const retryCutoff = new Date(startedAt - config.enrichRetryBaseHours * 3_600_000).toISOString();
  const backoff = { baseHours: config.enrichRetryBaseHours, maxDays: config.enrichRetryMaxDays };

  const groups = new Map();
  let candidates = 0;
  let notDue = 0;

  const candidateFilters = (q) => q
    .or(missingFilter)
    .gte('seeders', config.enrichMinSeeders)
    .or(`ids_checked_at.is.null,ids_checked_at.lt.${retryCutoff}`);

  for await (const page of db.scan(COLUMNS, candidateFilters)) {
    for (const row of page) {
      const kind = resolveKind(row);
      if (!tmdbEnabled && kind !== 'anime') continue;
      if (!isDueForRetry(row, startedAt, backoff)) {
        notDue++;
        continue;
      }
      const { query, year } = searchInfo(row);
      if (!query || query.length < 2) continue;
      candidates++;

      const key = groupKeyFor(row, kind, query, year);
      let g = groups.get(key);
      if (!g) {
        g = {
          key, kind, query, year, rows: [],
          imdbId: null, tmdbId: null, anilistId: null, malId: null,
          need: { tmdb_id: false, imdb_id: false, anilist_id: false, kitsu_id: false, mal_id: false },
        };
        groups.set(key, g);
      }
      g.rows.push({ id: row.id, attempts: Number(row.ids_attempts) || 0 });
      g.imdbId ||= row.imdb_id || null;
      g.tmdbId ||= row.tmdb_id || null;
      g.anilistId ||= row.anilist_id || null;
      g.malId ||= row.mal_id || null;
      if (tmdbEnabled && isNil(row.tmdb_id)) g.need.tmdb_id = true;
      if (tmdbEnabled && isNil(row.imdb_id)) g.need.imdb_id = true;
      if (kind === 'anime') {
        if (isNil(row.anilist_id)) g.need.anilist_id = true;
        if (isNil(row.kitsu_id)) g.need.kitsu_id = true;
        if (isNil(row.mal_id)) g.need.mal_id = true;
      }
    }
  }

  const pending = [...groups.values()].filter((g) => Object.values(g.need).some(Boolean));
  log.info(`  ${candidates} filas vivas con IDs faltantes en ${pending.length} obras (${notDue} esperando su turno de reintento)`);

  const stats = {
    groups: pending.length, local: 0, api: 0, resolved: 0, notFound: 0, errors: 0, skippedByLimit: 0,
    filled: { tmdb_id: 0, imdb_id: 0, anilist_id: 0, kitsu_id: 0, mal_id: 0 },
  };
  const nowIso = new Date().toISOString();

  // --- 2) Propagación local ----------------------------------------------------
  const resolvedLocally = new Set();
  if (config.enrichLocalPropagation) {
    const byTitle = new Map(pending.filter((g) => g.key.includes('|q:')).map((g) => [g.key, g]));
    if (byTitle.size) {
      const donors = new Map();
      const donorFilter = (q) => q.or('imdb_id.not.is.null,tmdb_id.not.is.null,anilist_id.not.is.null,kitsu_id.not.is.null,mal_id.not.is.null');
      for await (const page of db.scan(DONOR_COLUMNS, donorFilter)) {
        for (const row of page) {
          const { query, year } = searchInfo(row);
          if (!query) continue;
          const key = titleKey(resolveKind(row), query, year);
          if (!byTitle.has(key)) continue;
          let d = donors.get(key);
          if (!d) donors.set(key, (d = Object.fromEntries(ID_FIELDS.map((f) => [f, new Set()]))));
          for (const f of ID_FIELDS) if (!isNil(row[f])) d[f].add(String(row[f]));
        }
      }

      for (const [key, donorValues] of donors) {
        const g = byTitle.get(key);
        const ids = pickLocalIds(donorValues);
        if (!ids) continue;
        const found = {};
        for (const [field, value] of Object.entries(ids)) if (g.need[field]) found[field] = value;
        const clean = sanitizeIds(found);
        if (!Object.keys(clean).length) continue;
        await persist(db, g, clean, { sources: ['local'], scores: [0.9] }, nowIso, stats);
        resolvedLocally.add(key);
        stats.local++;
        stats.resolved++;
      }
      log.info(`  Propagación local: ${stats.local} obras identificadas copiando IDs de torrents ya conocidos (0 llamadas a APIs)`);
    }
  }

  // --- 3) APIs públicas ----------------------------------------------------------
  const queue = selectEnrichmentQueue(pending, resolvedLocally, config.enrichMaxTitles);
  stats.skippedByLimit = pending.length - resolvedLocally.size - queue.length;
  log.info(`  Consultando APIs para ${queue.length} obras (límite ENRICH_MAX_TITLES=${config.enrichMaxTitles === 0 ? 'sin límite' : config.enrichMaxTitles}, tiempo máx. ${config.enrichMaxMinutes} min)`);

  let tmdbDisabled = false;
  for (const [index, g] of queue.entries()) {
    if (Date.now() > deadline) {
      log.warn(`Enriquecedor: presupuesto de ${config.enrichMaxMinutes} min agotado; ${queue.length - index} obras quedan para la próxima ejecución.`);
      stats.skippedByLimit += queue.length - index;
      break;
    }

    const found = {};
    const meta = { sources: [], scores: [] };
    try {
      if (g.kind === 'anime') {
        await resolveAnime(g, found, meta, { anilist, kitsu, tmdb: tmdbDisabled ? null : tmdb });
      } else if (tmdb && !tmdbDisabled) {
        await resolveMovieOrSeries(g, found, meta, tmdb);
      }
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403) && tmdb) {
        tmdbDisabled = true;
        log.warn('TMDB respondió 401/403: revisa TMDB_API_KEY. Se desactiva TMDB en esta ejecución.');
      } else {
        log.debug(`Error enriqueciendo "${g.query}": ${err.message}`);
      }
      stats.errors++;
      continue; // sin marcar ids_checked_at: un fallo de red no debe penalizar a la obra
    }

    const clean = sanitizeIds(found);
    await persist(db, g, clean, meta, nowIso, stats);
    stats.api++;
    if (Object.keys(clean).length) {
      stats.resolved++;
      log.debug(`  ✓ [${g.kind}] "${g.query}" → ${JSON.stringify(clean)}`);
    } else {
      stats.notFound++;
      log.debug(`  ✗ Sin coincidencia: [${g.kind}] "${g.query}" (${g.year ?? 's/año'})`);
    }
    if ((index + 1) % 50 === 0) log.info(`  … ${index + 1}/${queue.length} obras consultadas`);
  }

  const f = stats.filled;
  log.info(
    `  Obras resueltas: ${stats.resolved} (local: ${stats.local}), sin coincidencia: ${stats.notFound}, errores: ${stats.errors}, ` +
    `pendientes para otra ejecución: ${stats.skippedByLimit}. Filas completadas → tmdb_id: ${f.tmdb_id}, imdb_id: ${f.imdb_id}, ` +
    `anilist_id: ${f.anilist_id}, kitsu_id: ${f.kitsu_id}, mal_id: ${f.mal_id}` +
    (config.dryRun ? ' (dry-run: estimado)' : ''),
  );
  return stats;
}

/**
 * Guarda los IDs encontrados (solo en columnas NULL) y el estado de la comprobación:
 * ids_checked_at = ahora, ids_attempts + 1, y ids_source / ids_confidence si hubo resultado.
 */
async function persist(db, g, found, meta, nowIso, stats) {
  const ids = g.rows.map((r) => r.id);
  for (const [column, value] of Object.entries(found)) {
    stats.filled[column] += await db.fillNullColumn(ids, column, value);
  }

  const hasResult = Object.keys(found).length > 0;
  const byAttempts = new Map();
  for (const r of g.rows) {
    if (!byAttempts.has(r.attempts)) byAttempts.set(r.attempts, []);
    byAttempts.get(r.attempts).push(r.id);
  }
  for (const [attempts, rowIds] of byAttempts) {
    const patch = { ids_checked_at: nowIso, ids_attempts: attempts + 1 };
    if (hasResult) {
      patch.ids_source = [...new Set(meta.sources)].join('+') || 'unknown';
      patch.ids_confidence = meta.scores.length ? Number(Math.min(...meta.scores, 1).toFixed(3)) : null;
    }
    await db.updateByIds(patch, rowIds, 'enrich-state');
  }
}

// ---------------------------------------------------------------------------
// Resolutores
// ---------------------------------------------------------------------------

function record(meta, source, score) {
  meta.sources.push(source);
  if (typeof score === 'number') meta.scores.push(Math.min(1, score));
}

async function resolveAnime(g, found, meta, { anilist, kitsu, tmdb }) {
  // AniList: por id (para obtener idMal) > por MAL > por título.
  let al = null;
  if (g.anilistId) {
    if (g.need.kitsu_id || g.need.mal_id || g.need.tmdb_id) al = await anilist.findById(g.anilistId);
  } else if (g.malId) {
    al = await anilist.findByMalId(g.malId);
  } else {
    al = await anilist.search(g.query, g.year);
  }

  if (al) {
    let used = false;
    if (g.need.anilist_id && !g.anilistId) { found.anilist_id = al.anilistId; used = true; }
    if (g.need.mal_id && !g.malId && al.malId) { found.mal_id = al.malId; used = true; }
    if (used) record(meta, 'anilist', al.score);
  }

  // Kitsu: mapping exacto por MAL si es posible; si no, búsqueda por texto.
  if (g.need.kitsu_id) {
    const malId = g.malId || al?.malId;
    let k = malId ? await kitsu.findByMalId(malId) : null;
    if (!k) k = await kitsu.search(g.query, g.year);
    if (k) {
      found.kitsu_id = k.kitsuId;
      record(meta, 'kitsu', k.score);
    }
  }

  // TMDB (opcional): los animes suelen estar como TV (o movie si el formato es MOVIE).
  if (tmdb && g.need.tmdb_id && !g.tmdbId) {
    const kind = al?.format === 'MOVIE' ? 'movie' : 'tv';
    const year = al?.year || g.year;
    const queries = [...new Set([al?.titles?.[0], g.query].filter(Boolean))];
    for (const q of queries) {
      const t = await tmdb.search(q, year, kind);
      if (t) {
        found.tmdb_id = t.tmdbId;
        if (g.need.imdb_id && t.imdbId) found.imdb_id = t.imdbId;
        record(meta, 'tmdb', t.score);
        break;
      }
    }
  } else if (tmdb && g.need.imdb_id && g.tmdbId) {
    const imdbId = await tmdb.getImdbId(g.tmdbId, al?.format === 'MOVIE' ? 'movie' : 'tv');
    if (imdbId) {
      found.imdb_id = imdbId;
      record(meta, 'tmdb', 1);
    }
  }
}

async function resolveMovieOrSeries(g, found, meta, tmdb) {
  const kind = g.kind === 'movie' ? 'movie' : 'tv';

  if (g.imdbId) {
    if (g.need.tmdb_id) {
      const r = await tmdb.findByImdbId(g.imdbId, kind);
      if (r) {
        found.tmdb_id = r.tmdbId;
        record(meta, 'tmdb', 1);
      }
    }
    return;
  }

  if (g.tmdbId) {
    if (g.need.imdb_id) {
      const imdbId = await tmdb.getImdbId(g.tmdbId, kind);
      if (imdbId) {
        found.imdb_id = imdbId;
        record(meta, 'tmdb', 1);
      }
    }
    return;
  }

  const r = await tmdb.search(g.query, g.year, kind);
  if (r) {
    found.tmdb_id = r.tmdbId;
    if (r.imdbId) found.imdb_id = r.imdbId;
    record(meta, 'tmdb', r.score);
  }
}

/** Prioriza las obras con más filas; 0 permite consultar todas las pendientes. */
export function selectEnrichmentQueue(pending, resolvedLocally, maxTitles) {
  return pending
    .filter((g) => !resolvedLocally.has(g.key))
    .sort((a, b) => b.rows.length - a.rows.length)
    .slice(0, maxTitles === 0 ? undefined : maxTitles);
}
