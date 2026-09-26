/**
 * PASO 5 — ENRIQUECEDOR DE IDs CON APIS PÚBLICAS
 * ------------------------------------------------------------------
 * Para torrents con IDs faltantes (tmdb_id / imdb_id / anilist_id / kitsu_id):
 *
 *  - Agrupa las filas por obra (id conocido o título limpio + año) → UNA consulta
 *    a la API por obra, no por fila.
 *  - Anime: AniList (GraphQL) → anilist_id + mal_id; Kitsu vía mapping MAL
 *    (exacto) o búsqueda por texto → kitsu_id; TMDB opcional.
 *  - Películas/series (requiere TMDB_API_KEY): /find por imdb_id si existe,
 *    /external_ids si ya hay tmdb_id, o /search + validación → tmdb_id + imdb_id.
 *  - Todos los resultados se validan por similitud de título (+ año) para no
 *    asignar IDs erróneos, y NUNCA se sobrescriben valores existentes
 *    (UPDATE ... WHERE columna IS NULL).
 *  - Caché de "no encontrados" (ENRICH_CACHE_FILE) para no repetir búsquedas
 *    fallidas en cada ejecución; en GitHub Actions se persiste con actions/cache.
 */

import fs from 'node:fs/promises';
import { log } from '../lib/logger.js';
import { HttpError } from '../lib/http.js';
import { cleanTitleForSearch, normalizeForCompare } from '../parsers/title-cleaner.js';
import { parseTitle } from '../parsers/title-parser.js';
import { AniListClient } from '../providers/anilist.js';
import { KitsuClient } from '../providers/kitsu.js';
import { TmdbClient } from '../providers/tmdb.js';

const COLUMNS = 'id,title,type,imdb_id,tmdb_id,anilist_id,kitsu_id,mal_id';
const isNil = (v) => v === null || v === undefined || v === '';

// ---------------------------------------------------------------------------
// Caché de búsquedas fallidas
// ---------------------------------------------------------------------------
async function loadMissCache(file, ttlDays) {
  try {
    const json = JSON.parse(await fs.readFile(file, 'utf8'));
    const minTs = Date.now() - ttlDays * 86_400_000;
    return new Map(Object.entries(json).filter(([, ts]) => ts >= minTs));
  } catch {
    return new Map();
  }
}

async function saveMissCache(file, cache) {
  try {
    await fs.writeFile(file, JSON.stringify(Object.fromEntries(cache)), 'utf8');
  } catch (err) {
    log.warn(`No se pudo guardar la caché de enriquecimiento (${file}): ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Agrupación de filas por obra
// ---------------------------------------------------------------------------
function resolveKind(row) {
  if (row.type === 'anime' || row.type === 'movie' || row.type === 'series') return row.type;
  return parseTitle(row.title).type || 'movie';
}

/**
 * Construye la clave de grupo priorizando identificadores exactos sobre el título.
 * Exportada para tests.
 */
export function groupKeyFor(row, kind, query, year) {
  if (kind === 'anime') {
    if (!isNil(row.anilist_id)) return `anime|anilist:${row.anilist_id}`;
    if (!isNil(row.mal_id)) return `anime|mal:${row.mal_id}`;
    return `anime|q:${normalizeForCompare(query)}|${year ?? ''}`;
  }
  if (!isNil(row.imdb_id)) return `${kind}|imdb:${row.imdb_id}`;
  if (!isNil(row.tmdb_id)) return `${kind}|tmdb:${row.tmdb_id}`;
  return `${kind}|q:${normalizeForCompare(query)}|${year ?? ''}`;
}

export async function runEnrich(db, config) {
  const tmdbEnabled = Boolean(config.tmdbApiKey);
  if (!tmdbEnabled) log.info('  TMDB_API_KEY no configurada → solo se enriquecerá anime (AniList + Kitsu).');

  const anilist = new AniListClient({ apiUrl: config.anilistApiUrl, rpm: config.anilistRpm, matchThreshold: config.matchThreshold });
  const kitsu = new KitsuClient({ apiUrl: config.kitsuApiUrl, rpm: config.kitsuRpm, matchThreshold: config.matchThreshold });
  const tmdb = tmdbEnabled
    ? new TmdbClient({ apiKey: config.tmdbApiKey, apiUrl: config.tmdbApiUrl, rpm: config.tmdbRpm, matchThreshold: config.matchThreshold })
    : null;

  // --- 1) Candidatos -------------------------------------------------------
  const animeMissing = 'and(type.eq.anime,or(anilist_id.is.null,kitsu_id.is.null))';
  const filter = tmdbEnabled
    ? `tmdb_id.is.null,imdb_id.is.null,${animeMissing}`
    : animeMissing;

  /** @type {Map<string, any>} */
  const groups = new Map();
  let candidates = 0;

  for await (const page of db.scan(COLUMNS, (q) => q.or(filter))) {
    for (const row of page) {
      const kind = resolveKind(row);
      // Sin TMDB, las películas/series no se pueden enriquecer.
      if (!tmdbEnabled && kind !== 'anime') continue;

      const { query, year } = cleanTitleForSearch(row.title);
      if (!query || query.length < 2) continue;
      candidates++;

      const key = groupKeyFor(row, kind, query, year);
      let g = groups.get(key);
      if (!g) {
        g = {
          key, kind, query, year, ids: [],
          imdbId: row.imdb_id || null, tmdbId: row.tmdb_id || null,
          anilistId: row.anilist_id || null, malId: row.mal_id || null,
          need: { tmdb: false, imdb: false, anilist: false, kitsu: false, mal: false },
        };
        groups.set(key, g);
      }
      g.ids.push(row.id);
      g.imdbId ||= row.imdb_id || null;
      g.tmdbId ||= row.tmdb_id || null;
      g.anilistId ||= row.anilist_id || null;
      g.malId ||= row.mal_id || null;
      if (tmdbEnabled && isNil(row.tmdb_id)) g.need.tmdb = true;
      if (tmdbEnabled && isNil(row.imdb_id)) g.need.imdb = true;
      if (kind === 'anime') {
        if (isNil(row.anilist_id)) g.need.anilist = true;
        if (isNil(row.kitsu_id)) g.need.kitsu = true;
        if (isNil(row.mal_id)) g.need.mal = true;
      }
    }
  }

  // --- 2) Priorización + caché ------------------------------------------------
  const missCache = await loadMissCache(config.enrichCacheFile, config.enrichMissTtlDays);
  const queue = [...groups.values()]
    .filter((g) => Object.values(g.need).some(Boolean))
    .filter((g) => !missCache.has(g.key))
    .sort((a, b) => b.ids.length - a.ids.length) // más filas afectadas primero
    .slice(0, config.enrichMaxTitles);

  log.info(`  ${candidates} filas candidatas en ${groups.size} obras; se consultarán ${queue.length} (límite ENRICH_MAX_TITLES=${config.enrichMaxTitles}, en caché de fallos: ${missCache.size})`);

  // --- 3) Resolución ----------------------------------------------------------
  const stats = { groups: queue.length, resolved: 0, notFound: 0, errors: 0, filled: { tmdb_id: 0, imdb_id: 0, anilist_id: 0, kitsu_id: 0, mal_id: 0 } };
  let tmdbDisabled = false;

  for (const [index, g] of queue.entries()) {
    const found = {};
    try {
      if (g.kind === 'anime') {
        await resolveAnime(g, found, { anilist, kitsu, tmdb: tmdbDisabled ? null : tmdb });
      } else if (tmdb && !tmdbDisabled) {
        await resolveMovieOrSeries(g, found, tmdb);
      }
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403) && tmdb) {
        tmdbDisabled = true;
        log.warn('TMDB respondió 401/403: revisa TMDB_API_KEY. Se desactiva TMDB en esta ejecución.');
      } else {
        log.debug(`Error enriqueciendo "${g.query}": ${err.message}`);
      }
      stats.errors++;
      continue;
    }

    if (Object.keys(found).length === 0) {
      stats.notFound++;
      missCache.set(g.key, Date.now());
      log.debug(`  ✗ Sin coincidencia: [${g.kind}] "${g.query}" (${g.year ?? 's/año'})`);
      continue;
    }

    stats.resolved++;
    log.debug(`  ✓ [${g.kind}] "${g.query}" → ${JSON.stringify(found)}`);
    for (const [column, value] of Object.entries(found)) {
      stats.filled[column] += await db.fillNullColumn(g.ids, column, value);
    }

    if ((index + 1) % 50 === 0) log.info(`  … ${index + 1}/${queue.length} obras procesadas`);
  }

  await saveMissCache(config.enrichCacheFile, missCache);

  const f = stats.filled;
  log.info(
    `  Obras resueltas: ${stats.resolved}, sin coincidencia: ${stats.notFound}, errores: ${stats.errors}. ` +
    `Filas completadas → tmdb_id: ${f.tmdb_id}, imdb_id: ${f.imdb_id}, anilist_id: ${f.anilist_id}, kitsu_id: ${f.kitsu_id}, mal_id: ${f.mal_id}` +
    (config.dryRun ? ' (dry-run: filas que se completarían, estimado)' : ''),
  );
  return stats;
}

// ---------------------------------------------------------------------------
// Resolutores
// ---------------------------------------------------------------------------

async function resolveAnime(g, found, { anilist, kitsu, tmdb }) {
  // AniList: por id (para obtener idMal) > por MAL > por título.
  let al = null;
  if (g.anilistId) {
    if (g.need.kitsu || g.need.mal || g.need.tmdb) al = await anilist.findById(g.anilistId);
  } else if (g.malId) {
    al = await anilist.findByMalId(g.malId);
  } else {
    al = await anilist.search(g.query, g.year);
  }

  if (al) {
    if (g.need.anilist && !g.anilistId) found.anilist_id = al.anilistId;
    if (g.need.mal && !g.malId && al.malId) found.mal_id = al.malId;
  }

  // Kitsu: mapping exacto por MAL si es posible; si no, búsqueda por texto.
  if (g.need.kitsu) {
    const malId = g.malId || al?.malId;
    let k = malId ? await kitsu.findByMalId(malId) : null;
    if (!k) k = await kitsu.search(g.query, g.year);
    if (k) found.kitsu_id = k.kitsuId;
  }

  // TMDB (opcional): los animes suelen estar como TV (o movie si el formato es MOVIE).
  if (tmdb && g.need.tmdb && !g.tmdbId) {
    const kind = al?.format === 'MOVIE' ? 'movie' : 'tv';
    const year = al?.year || g.year;
    const queries = [...new Set([al?.titles?.[0], g.query].filter(Boolean))];
    for (const q of queries) {
      const t = await tmdb.search(q, year, kind);
      if (t) {
        found.tmdb_id = t.tmdbId;
        if (g.need.imdb && t.imdbId) found.imdb_id = t.imdbId;
        break;
      }
    }
  } else if (tmdb && g.need.imdb && g.tmdbId) {
    const imdbId = await tmdb.getImdbId(g.tmdbId, al?.format === 'MOVIE' ? 'movie' : 'tv');
    if (imdbId) found.imdb_id = imdbId;
  }
}

async function resolveMovieOrSeries(g, found, tmdb) {
  const kind = g.kind === 'movie' ? 'movie' : 'tv';

  if (g.imdbId) {
    // Tenemos imdb_id → tmdb_id exacto con /find.
    if (g.need.tmdb) {
      const r = await tmdb.findByImdbId(g.imdbId, kind);
      if (r) found.tmdb_id = r.tmdbId;
    }
    return;
  }

  if (g.tmdbId) {
    // Tenemos tmdb_id → imdb_id con /external_ids.
    if (g.need.imdb) {
      const imdbId = await tmdb.getImdbId(g.tmdbId, kind);
      if (imdbId) found.imdb_id = imdbId;
    }
    return;
  }

  // Huérfano total → búsqueda por título limpio + año.
  const r = await tmdb.search(g.query, g.year, kind);
  if (r) {
    found.tmdb_id = r.tmdbId;
    if (r.imdbId) found.imdb_id = r.imdbId;
  }
}
