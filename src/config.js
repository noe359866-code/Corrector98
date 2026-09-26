/**
 * Configuración centralizada. TODO se lee desde process.env para que las
 * credenciales nunca vivan en el código (en GitHub Actions llegan vía Secrets).
 */

import { assertApplyAuthorized } from './lib/policy.js';

const MB = 1024 * 1024;

/** Lee un booleano de entorno ("true", "1", "yes", "on"). */
function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'si', 'sí'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(`La variable ${name} debe ser un booleano válido (recibido: "${raw}")`);
}

/** Lee un entero de entorno, validando que sea numérico. */
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!/^[+-]?\d+$/.test(raw.trim()) || !Number.isSafeInteger(n)) throw new Error(`La variable ${name} debe ser un entero (recibido: "${raw}")`);
  return n;
}

/** Lee una lista separada por comas. */
function envList(name, fallback = []) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export const ALL_STEPS = ['adult', 'size', 'dead', 'normalize', 'enrich', 'dedupe'];

export function loadConfig() {
  const steps = envList('STEPS', ALL_STEPS).map((s) => s.toLowerCase());
  const unknown = steps.filter((s) => !ALL_STEPS.includes(s));
  if (unknown.length) {
    throw new Error(`STEPS contiene pasos desconocidos: ${unknown.join(', ')}. Válidos: ${ALL_STEPS.join(', ')}`);
  }

  const dryRun = envBool('DRY_RUN', true);
  const config = {
    // --- Credenciales -------------------------------------------------------
    supabaseUrl: process.env.SUPABASE_URL,
    // Service role: necesaria para DELETE/UPDATE saltando RLS. Nunca exponerla en frontend.
    supabaseKey: dryRun ? process.env.SUPABASE_READ_KEY : process.env.SUPABASE_SERVICE_ROLE_KEY,
    // Opcional: API key v3 o "API Read Access Token" v4 (JWT) de TMDB.
    tmdbApiKey: process.env.TMDB_API_KEY || '',

    // --- Ejecución ------------------------------------------------------------
    table: process.env.TORRENTS_TABLE || 'torrents',
    dryRun,
    applyConfirmation: process.env.APPLY_CONFIRMATION || '',
    changeTicket: process.env.CHANGE_TICKET || '',
    backupReference: process.env.BACKUP_REFERENCE || '',
    auditDir: process.env.AUDIT_DIR || 'audit',
    maxDeleteRows: envInt('MAX_DELETE_ROWS', 1000),
    steps,
    pageSize: envInt('PAGE_SIZE', 1000), // filas por página (PostgREST limita a 1000 por defecto)
    deleteChunkSize: envInt('DELETE_CHUNK_SIZE', 200), // ids por DELETE ... IN (...)
    updateConcurrency: envInt('UPDATE_CONCURRENCY', 8),
    dbTimeoutMs: envInt('DB_TIMEOUT_MS', 30_000),
    dbReadRetries: envInt('DB_READ_RETRIES', 3),
    // Evita desastres: si un paso intenta borrar más de este % de la tabla, aborta.
    maxDeleteRatio: Number(process.env.MAX_DELETE_RATIO ?? 0.1),

    // Envía la cabecera x-preserve-updated-at para que el trigger (ver
    // sql/002_preserve_updated_at.sql) NO actualice updated_at en los cambios de
    // este script. Sin la migración la cabecera se ignora sin efectos secundarios.
    preserveUpdatedAt: envBool('PRESERVE_UPDATED_AT', true),
    // Informe de salud de la tabla (conteos) al inicio y al final.
    report: envBool('REPORT', true),
    logSamples: envBool('LOG_SAMPLES', false),

    // --- 1. Contenido adulto ------------------------------------------------
    adultExtraKeywords: envList('ADULT_EXTRA_KEYWORDS'),

    // --- 2. Anti-fakes por tamaño --------------------------------------------
    minMovieBytes: envInt('MIN_MOVIE_MB', 150) * MB,
    minSeriesBytes: envInt('MIN_SERIES_MB', 30) * MB,
    // size_bytes = 0 suele significar "tamaño desconocido" (scraper sin metadata).
    sizeFilterIncludeZero: envBool('SIZE_FILTER_INCLUDE_ZERO', false),

    // --- 3. Torrents muertos ------------------------------------------------
    deadAfterDays: envInt('DEAD_AFTER_DAYS', 30),

    // --- 4. Normalizador ---------------------------------------------------------
    // Rellena quality/codec/hdr_format/channels/release_group vacíos desde el título.
    fillMetadata: envBool('FILL_METADATA', true),

    // --- 5. Enriquecimiento ---------------------------------------------------
    enrichMaxTitles: envInt('ENRICH_MAX_TITLES', 0), // 0 = sin límite de títulos únicos por ejecución
    anilistRpm: envInt('ANILIST_RPM', 30), // AniList: 90 rpm nominal, a veces degradado a 30
    kitsuRpm: envInt('KITSU_RPM', 60),
    tmdbRpm: envInt('TMDB_RPM', 180), // TMDB tolera ~50 req/s; vamos holgados
    kitsuApiUrl: process.env.KITSU_API_URL || 'https://kitsu.app/api/edge',
    anilistApiUrl: process.env.ANILIST_API_URL || 'https://graphql.anilist.co',
    tmdbApiUrl: process.env.TMDB_API_URL || 'https://api.themoviedb.org/3',
    matchThreshold: Number(process.env.MATCH_THRESHOLD ?? 0.72), // similitud mínima título↔resultado
    // Solo se enriquecen torrents vivos: gastar cuota de API en muertos no aporta nada.
    enrichMinSeeders: envInt('ENRICH_MIN_SEEDERS', 1),
    // Reintentos con backoff exponencial usando ids_checked_at / ids_attempts de la tabla:
    // 1er reintento tras BASE horas, luego 2×, 4×… hasta un máximo de MAX días.
    enrichRetryBaseHours: envInt('ENRICH_RETRY_BASE_HOURS', 24),
    enrichRetryMaxDays: envInt('ENRICH_RETRY_MAX_DAYS', 30),
    // Presupuesto de tiempo del paso (se detiene limpiamente antes del timeout de Actions).
    enrichMaxMinutes: envInt('ENRICH_MAX_MINUTES', 45),
    // Copia IDs de torrents ya identificados con el mismo título+año (sin llamar a APIs).
    enrichLocalPropagation: envBool('ENRICH_LOCAL_PROPAGATION', true),

    // --- 6. Deduplicador ----------------------------------------------------
    keepPerLanguage: envInt('DEDUPE_KEEP_PER_LANGUAGE', 2),
    // 'delete' = regla estricta (solo sobreviven top-N español + top-N inglés).
    // 'keep'   = los torrents en otros idiomas (francés, ruso…) no se tocan.
    dedupeOtherLanguages: (process.env.DEDUPE_OTHER_LANGUAGES || 'keep').toLowerCase(),
  };

  if (!config.supabaseUrl || !config.supabaseKey) {
    throw new Error(`Faltan SUPABASE_URL y/o ${dryRun ? 'SUPABASE_READ_KEY' : 'SUPABASE_SERVICE_ROLE_KEY'} en las variables de entorno.`);
  }
  try {
    const url = new URL(config.supabaseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
  } catch {
    throw new Error('SUPABASE_URL debe ser una URL HTTPS sin credenciales ni parámetros.');
  }
  if (!['delete', 'keep'].includes(config.dedupeOtherLanguages)) {
    throw new Error('DEDUPE_OTHER_LANGUAGES debe ser "delete" o "keep".');
  }
  if (!(config.maxDeleteRatio > 0 && config.maxDeleteRatio <= 1)) {
    throw new Error('MAX_DELETE_RATIO debe estar en el rango (0, 1].');
  }
  const ranges = [
    ['MAX_DELETE_ROWS', config.maxDeleteRows, 1, Number.MAX_SAFE_INTEGER],
    ['PAGE_SIZE', config.pageSize, 1, 10_000],
    ['DELETE_CHUNK_SIZE', config.deleteChunkSize, 1, 200],
    ['UPDATE_CONCURRENCY', config.updateConcurrency, 1, 64],
    ['DB_TIMEOUT_MS', config.dbTimeoutMs, 1, 300_000],
    ['DB_READ_RETRIES', config.dbReadRetries, 0, 10],
    ['MIN_MOVIE_MB', config.minMovieBytes / MB, 0, Number.MAX_SAFE_INTEGER / MB],
    ['MIN_SERIES_MB', config.minSeriesBytes / MB, 0, Number.MAX_SAFE_INTEGER / MB],
    ['DEAD_AFTER_DAYS', config.deadAfterDays, 1, 365_000],
    ['DEDUPE_KEEP_PER_LANGUAGE', config.keepPerLanguage, 1, Number.MAX_SAFE_INTEGER],
    ['ENRICH_MAX_TITLES', config.enrichMaxTitles, 0, Number.MAX_SAFE_INTEGER],
    ['ENRICH_MIN_SEEDERS', config.enrichMinSeeders, 0, Number.MAX_SAFE_INTEGER],
    ['ENRICH_RETRY_BASE_HOURS', config.enrichRetryBaseHours, 1, 876_000],
    ['ENRICH_RETRY_MAX_DAYS', config.enrichRetryMaxDays, 1, 365_000],
    ['ENRICH_MAX_MINUTES', config.enrichMaxMinutes, 1, 10_080],
    ['ANILIST_RPM', config.anilistRpm, 1, 60_000],
    ['KITSU_RPM', config.kitsuRpm, 1, 60_000],
    ['TMDB_RPM', config.tmdbRpm, 1, 60_000],
  ];
  for (const [name, value, min, max] of ranges) {
    if (value < min || value > max) throw new Error(`${name} debe estar en el rango [${min}, ${max}].`);
  }
  if (!Number.isFinite(config.matchThreshold) || config.matchThreshold <= 0 || config.matchThreshold > 1) {
    throw new Error('MATCH_THRESHOLD debe estar en el rango (0, 1].');
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(config.table)) throw new Error('TORRENTS_TABLE debe ser un identificador SQL simple.');
  if (!config.dryRun) {
    assertApplyAuthorized(config);
    if (!process.env.STEPS?.trim() || !steps.length) throw new Error('STEPS debe indicarse explícitamente para aplicar cambios.');
  }
  return config;
}
