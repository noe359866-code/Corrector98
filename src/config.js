/**
 * Configuración centralizada. TODO se lee desde process.env para que las
 * credenciales nunca vivan en el código (en GitHub Actions llegan vía Secrets).
 */

const MB = 1024 * 1024;

/** Lee un booleano de entorno ("true", "1", "yes", "on"). */
function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'si', 'sí'].includes(String(raw).trim().toLowerCase());
}

/** Lee un entero de entorno, validando que sea numérico. */
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`La variable ${name} debe ser un entero (recibido: "${raw}")`);
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

  const config = {
    // --- Credenciales -------------------------------------------------------
    supabaseUrl: process.env.SUPABASE_URL,
    // Service role: necesaria para DELETE/UPDATE saltando RLS. Nunca exponerla en frontend.
    supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY,
    // Opcional: API key v3 o "API Read Access Token" v4 (JWT) de TMDB.
    tmdbApiKey: process.env.TMDB_API_KEY || '',

    // --- Ejecución ------------------------------------------------------------
    table: process.env.TORRENTS_TABLE || 'torrents',
    dryRun: envBool('DRY_RUN', false),
    steps,
    pageSize: envInt('PAGE_SIZE', 1000), // filas por página (PostgREST limita a 1000 por defecto)
    deleteChunkSize: envInt('DELETE_CHUNK_SIZE', 200), // ids por DELETE ... IN (...)
    updateConcurrency: envInt('UPDATE_CONCURRENCY', 8),
    // Evita desastres: si un paso intenta borrar más de este % de la tabla, aborta.
    maxDeleteRatio: Number(process.env.MAX_DELETE_RATIO ?? 0.5),

    // Envía la cabecera x-preserve-updated-at para que el trigger (ver
    // sql/002_preserve_updated_at.sql) NO actualice updated_at en los cambios de
    // este script. Sin la migración la cabecera se ignora sin efectos secundarios.
    preserveUpdatedAt: envBool('PRESERVE_UPDATED_AT', true),
    // Informe de salud de la tabla (conteos) al inicio y al final.
    report: envBool('REPORT', true),

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
    dedupeOtherLanguages: (process.env.DEDUPE_OTHER_LANGUAGES || 'delete').toLowerCase(),
  };

  if (!config.supabaseUrl || !config.supabaseKey) {
    throw new Error('Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY en las variables de entorno.');
  }
  if (!['delete', 'keep'].includes(config.dedupeOtherLanguages)) {
    throw new Error('DEDUPE_OTHER_LANGUAGES debe ser "delete" o "keep".');
  }
  if (!(config.maxDeleteRatio > 0 && config.maxDeleteRatio <= 1)) {
    throw new Error('MAX_DELETE_RATIO debe estar en el rango (0, 1].');
  }
  if (config.enrichMaxTitles < 0) {
    throw new Error('ENRICH_MAX_TITLES debe ser 0 (sin límite) o un entero positivo.');
  }
  return config;
}
