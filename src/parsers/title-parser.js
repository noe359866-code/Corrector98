/**
 * PARSER DE TÍTULOS DE RELEASES
 * ------------------------------------------------------------------
 * Detecta tipo (movie/series/anime), temporada, episodio y episodio absoluto
 * a partir del nombre del torrent. Es una función pura (sin I/O) → testeable.
 *
 * Formatos soportados (entre otros):
 *   Series:  "Show.S02E09.1080p", "Show S02E09E10", "Show 2x09", "Show S02 - E09",
 *            "Serie [HDTV][Cap.209]" (formato de trackers españoles → T2 E09),
 *            "Serie Temporada 2", "Show Season 2 Complete", "Show S01-S05" (multi)
 *   Anime:   "[SubsPlease] Frieren - 09 (1080p) [ABCD1234].mkv",
 *            "[Erai-raws] Show S2 - 09 [1080p]", "[Group] Show 2nd Season - 09",
 *            "[Erai-raws] One Piece - 1071 [1080p]" (episodio absoluto)
 */

/** Grupos de release cuyo contenido es (casi) exclusivamente anime. */
export const ANIME_RELEASE_GROUPS = [
  'SubsPlease', 'Erai-raws', 'HorribleSubs', 'Judas', 'ASW', 'EMBER', 'Commie', 'Anime Time',
  'DKB', 'Tsundere-Raws', 'Yameii', 'NanDesuKa', 'Cleo', 'SSA', 'Moozzi2', 'Kaizoku', 'Golumpa',
  'GJM', 'Kametsu', 'Coalgirls', 'Doki', 'FFF', 'Underwater', 'UTW', 'Vivid', 'Kawaiika-Raws',
  'Ohys-Raws', 'Leopard-Raws', 'Reinforce', 'Beatrice-Raws', 'SallySubs', 'Chihiro', 'MTBB',
  'LostYears', 'Arid', 'Okay-Subs', 'YuiSubs', 'Nep_Blanc', 'Anime Land', 'AnimeRG', 'Kanjouteki',
  'Hi10', 'CBM', 'Mysteria', 'Some-Stuffs', 'Sokudo', 'Trix', 'NC-Raws', 'Lilith-Raws', 'VARYG',
  'Raze', 'Sakura', 'Nekomoe kissaten', 'LoliHouse', 'Skymoon-Raws', 'GST', 'Hakata Ramen',
  'Anime Chap', 'AnimeKaizoku', 'DB', 'df68', 'Breeze', 'Kosaka', 'ToonsHub-Anime', 'Tenrai-Sensei',
  'AkihitoSubs', 'Aergia', 'Vodes', 'smol', 'Seigyoku', 'Cyan', 'bonkai77', 'Bunny-Apocalypse',
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "[SubsPlease] ..." o "[Erai-raws] ..." al inicio del título.
const KNOWN_GROUP_RE = new RegExp(
  `^\\s*[\\[(【](?:${ANIME_RELEASE_GROUPS.map(escapeRe).join('|')})[\\])】]`, 'i',
);
// Heurística genérica: grupo al inicio cuyo nombre termina en -Raws / Subs / Fansub.
const GENERIC_FANSUB_RE = /^\s*\[[^\]]*(?:raws?|subs?|fansubs?|no[\s-]?fansub)\]/i;
// CRC32 al final de muchos releases de anime: "[A1B2C3D4]".
const CRC32_RE = /\[[0-9A-F]{8}\]/i;
const LEADING_GROUP_RE = /^\s*\[([^\]]+)\]/;

const YEAR_RE = /(?:^|[\s.([_-])((?:19|20)\d{2})(?=$|[\s.)\]_-])/;
const isYearLike = (n) => n >= 1900 && n <= 2099;

/**
 * Normaliza separadores (puntos y guiones bajos) a espacios manteniendo
 * decimales tipo "5.1" y "H.264" irrelevantes para la detección.
 */
function normalizeSeparators(title) {
  return title.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const toInt = (v) => (v === undefined || v === null ? null : Number.parseInt(v, 10));

/**
 * @typedef {Object} ParsedTitle
 * @property {'movie'|'series'|'anime'|null} type  Tipo detectado.
 * @property {'high'|'medium'|'low'|null} confidence  Confianza de la detección de tipo.
 * @property {number|null} season
 * @property {number|null} episode   Solo si el título identifica UN episodio concreto.
 * @property {number|null} absoluteEpisode
 * @property {boolean} isPack        Pack de temporada / rango de episodios.
 * @property {boolean} isMultiSeason Pack de varias temporadas (S01-S05, "Complete Series").
 * @property {boolean} explicitSeason La temporada aparece explícitamente en el título.
 * @property {number|null} year
 * @property {string|null} releaseGroup
 */

/**
 * Analiza un título de release.
 * @param {string} rawTitle
 * @returns {ParsedTitle}
 */
export function parseTitle(rawTitle) {
  const result = {
    type: null,
    confidence: null,
    season: null,
    episode: null,
    absoluteEpisode: null,
    isPack: false,
    isMultiSeason: false,
    explicitSeason: false,
    year: null,
    releaseGroup: null,
  };
  if (!rawTitle || typeof rawTitle !== 'string') return result;

  const title = normalizeSeparators(rawTitle);
  const groupMatch = rawTitle.match(LEADING_GROUP_RE);
  if (groupMatch) result.releaseGroup = groupMatch[1].trim();

  // Preferimos el año entre paréntesis/corchetes: "Blade Runner 2049 (2017)" → 2017.
  const parenYear = rawTitle.match(/[([]((?:19|20)\d{2})[)\]]/);
  const yearMatch = parenYear || title.match(YEAR_RE);
  if (yearMatch) result.year = Number(yearMatch[1]);

  const knownAnimeGroup = KNOWN_GROUP_RE.test(rawTitle);
  const fansubGroup = GENERIC_FANSUB_RE.test(rawTitle);
  const hasCrc = CRC32_RE.test(rawTitle);
  const hasLeadingGroup = Boolean(groupMatch);

  let m;

  // ---------------------------------------------------------------------------
  // 1) Multi-temporada: "S01-S05", "S01-05", "Temporadas 1-3", "Complete Series"
  // ---------------------------------------------------------------------------
  if (
    // "S01-S05" / "S01 - S05" / "S01-05" (sin espacios: " - 09" con espacios es episodio de anime)
    /\bS(\d{1,2})(?:\s?-\s?S(\d{1,2})|-(\d{1,2}))\b(?!\s?E\d)/i.test(title) ||
    /\b(?:Seasons|Temporadas)\s?\d{1,2}\s?(?:-|a|to|al)\s?\d{1,2}\b/i.test(title) ||
    /\b(?:Complete\s+Series|Serie\s+Completa|Series\s+Completa|All\s+Seasons|Todas\s+las\s+Temporadas)\b/i.test(title)
  ) {
    result.isMultiSeason = true;
    result.isPack = true;
    result.type = 'series';
    result.confidence = 'high';
  }

  // ---------------------------------------------------------------------------
  // 2) Episodios estilo "scene": S02E09, S02 E09, S02.E09, S02E09E10, S02E09-E12
  // ---------------------------------------------------------------------------
  if (!result.isMultiSeason && (m = title.match(/\bS(\d{1,2})\s?-?\s?E(\d{1,4})(?:\s?-?\s?E?(\d{1,4}))?\b/i))) {
    result.season = toInt(m[1]);
    result.explicitSeason = true;
    const first = toInt(m[2]);
    const last = m[3] ? toInt(m[3]) : null;
    if (last !== null && last !== first) {
      result.isPack = true; // rango de episodios → no corresponde a un único episodio
    } else {
      result.episode = first;
    }
    result.type = 'series';
    result.confidence = 'high';
  }
  // 3) Formato "2x09" (evita resoluciones como 1920x1080 o códecs x264)
  else if (!result.isMultiSeason && (m = title.match(/(?:^|\s|\[)(\d{1,2})x(\d{2,3})(?![\dp])/i))) {
    result.season = toInt(m[1]);
    result.episode = toInt(m[2]);
    result.explicitSeason = true;
    result.type = 'series';
    result.confidence = 'high';
  }
  // 4) Trackers españoles: "[Cap.209]" = T2E09, "[Cap.1012]" = T10E12, "[Cap.101_110]" = pack T1
  else if (!result.isMultiSeason && (m = title.match(/\bCap(?:[ií]tulo)?\s?(\d{3,4})(?:\s?[-_\s]\s?(\d{3,4}))?\b/i))) {
    const code = m[1];
    const season = toInt(code.slice(0, code.length - 2));
    const episode = toInt(code.slice(-2));
    if (season > 0) {
      result.season = season;
      result.explicitSeason = true;
      if (m[2] && m[2] !== m[1]) result.isPack = true;
      else if (episode > 0) result.episode = episode;
      result.type = 'series';
      result.confidence = 'high';
    }
  }

  // ---------------------------------------------------------------------------
  // 5) Anime: "S2 - 09", "2nd Season - 09", "Season 2 - 09", " - 09", " - 1071"
  // ---------------------------------------------------------------------------
  if (result.episode === null && !result.isPack) {
    const animeSeasonEp =
      title.match(/\bS(\d{1,2})\s-\s(\d{1,4})(?:v\d)?(?=$|[\s[(])/i) ||
      title.match(/\b(\d{1,2})(?:st|nd|rd|th)\sSeason\s-\s(\d{1,4})(?:v\d)?(?=$|[\s[(])/i) ||
      title.match(/\bSeason\s(\d{1,2})\s-\s(\d{1,4})(?:v\d)?(?=$|[\s[(])/i);

    if (animeSeasonEp) {
      result.season = toInt(animeSeasonEp[1]);
      result.episode = toInt(animeSeasonEp[2]);
      result.explicitSeason = true;
    } else if ((m = title.match(/\s-\s(\d{1,4})(?:v\d)?(?:\s?END)?(?=$|[\s[(])/i))) {
      const ep = toInt(m[1]);
      // " - 2019" suele ser un año, no un episodio. Solo aceptamos el patrón si hay
      // indicios de anime (grupo al inicio) o si el título no contiene año.
      if (!isYearLike(ep) && ep > 0 && (hasLeadingGroup || !result.year)) {
        result.episode = ep;
        result.absoluteEpisode = ep; // sin temporada explícita → numeración absoluta
      }
    }

    if (result.episode !== null) {
      if (knownAnimeGroup || fansubGroup || hasCrc || hasLeadingGroup) {
        result.type = 'anime';
        result.confidence = knownAnimeGroup || fansubGroup ? 'high' : 'medium';
      } else if (!result.type) {
        result.type = 'series';
        result.confidence = 'medium';
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 6) "Episode 5", "Episodio 5", "Ep 05", "Capitulo 5"
  //    (ignorado si hay año y no hay temporada: "Star Wars Episode 1 (1999)")
  // ---------------------------------------------------------------------------
  if (result.episode === null && !result.isPack && (m = title.match(/\b(?:Episode|Episodio|Ep|Cap[ií]tulo|Cap)\s?(\d{1,4})\b/i))) {
    if (!result.year || result.explicitSeason) {
      result.episode = toInt(m[1]);
      if (!result.type) {
        result.type = 'series';
        result.confidence = 'medium';
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 7) Solo temporada (pack): "S02", "Season 2", "Temporada 2", "2ª Temporada", "2nd Season"
  // ---------------------------------------------------------------------------
  if (result.season === null && !result.isMultiSeason) {
    const seasonOnly =
      title.match(/\bS(\d{1,2})\b(?!\s?E\d)/i) ||
      title.match(/\b(?:Season|Temporada|Saison|Staffel)\s?(\d{1,2})\b/i) ||
      title.match(/\b(\d{1,2})\s?(?:ª|a|º)?\s?Temporada\b/i) ||
      title.match(/\b(\d{1,2})(?:st|nd|rd|th)\sSeason\b/i);
    if (seasonOnly) {
      result.season = toInt(seasonOnly[1]);
      result.explicitSeason = true;
      if (result.episode === null) result.isPack = true;
      if (!result.type) {
        result.type = 'series';
        result.confidence = 'high';
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 8) Grupos de anime conocidos sin patrón de episodio (batches, películas anime)
  // ---------------------------------------------------------------------------
  if (knownAnimeGroup || fansubGroup) {
    result.type = 'anime';
    result.confidence = 'high';
  } else if (result.type === 'series' && hasCrc && hasLeadingGroup) {
    // "[Grupo] Show S01E01 [ABCD1234]" → fuertemente anime
    result.type = 'anime';
    result.confidence = 'medium';
  }

  // ---------------------------------------------------------------------------
  // 9) Película: año presente y ningún marcador de temporada/episodio
  // ---------------------------------------------------------------------------
  if (!result.type && result.year) {
    result.type = 'movie';
    result.confidence = 'low';
  }

  return result;
}

/**
 * Calcula el "patch" de normalización para una fila de la BD comparando lo
 * almacenado con lo que se deduce del título. Reglas conservadoras:
 *  - El tipo solo se cambia con confianza alta/media y nunca se degrada un
 *    'anime' a 'series' (muchos animes usan SxxEyy) ni una serie a 'movie'.
 *  - El episodio solo se corrige si el título identifica UN episodio concreto:
 *    en packs (S01 completa, S01E01-E10) cada fila suele mapear un archivo
 *    distinto del torrent y tocarlo rompería ese mapeo.
 *  - En packs multi-temporada no se toca ni temporada ni episodio.
 *
 * @param {object} row  Fila con {title,type,season,episode,absolute_episode,anilist_id,kitsu_id,mal_id}
 * @returns {object|null} patch con los campos a actualizar, o null si no hay cambios
 */
export function computeNormalization(row) {
  const parsed = parseTitle(row.title);
  const patch = {};
  const hasAnimeIds = Boolean(row.anilist_id || row.kitsu_id || row.mal_id);

  // --- Tipo -------------------------------------------------------------------
  let finalType = row.type;
  if (parsed.type === 'anime' && row.type !== 'anime') {
    if (parsed.confidence === 'high' || (parsed.confidence === 'medium' && row.type !== 'series')) {
      finalType = 'anime';
    }
  } else if (parsed.type === 'series' && parsed.confidence !== 'low' && (!row.type || row.type === 'movie')) {
    finalType = hasAnimeIds ? 'anime' : 'series';
  } else if (!row.type && parsed.type) {
    finalType = parsed.type;
  }
  if (finalType !== row.type) patch.type = finalType;

  // --- Temporada / episodio ---------------------------------------------------
  if (finalType === 'series' || finalType === 'anime') {
    if (!parsed.isMultiSeason) {
      if (parsed.explicitSeason && parsed.season !== null && parsed.season !== row.season) {
        patch.season = parsed.season;
      }
      if (!parsed.isPack && parsed.episode !== null && parsed.episode !== row.episode) {
        patch.episode = parsed.episode;
      }
      // Anime con numeración absoluta ("One Piece - 1071"): temporada 1 por defecto
      // y rellenamos absolute_episode si está vacío.
      if (finalType === 'anime' && parsed.absoluteEpisode !== null) {
        if (row.season === null || row.season === undefined) patch.season = 1;
        if (row.absolute_episode === null || row.absolute_episode === undefined) {
          patch.absolute_episode = parsed.absoluteEpisode;
        }
      }
    }
  } else if (finalType === 'movie' && parsed.type !== 'series' && parsed.type !== 'anime') {
    // Una película no debería tener temporada/episodio.
    if (row.season !== null && row.season !== undefined) patch.season = null;
    if (row.episode !== null && row.episode !== undefined) patch.episode = null;
  }

  return Object.keys(patch).length ? patch : null;
}
