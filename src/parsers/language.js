/**
 * CLASIFICADOR DE IDIOMA
 * ------------------------------------------------------------------
 * Agrupa cada torrent en:
 *   'spanish' → Castellano, Latino, Dual ES/EN, Subtitulado / VOSE (subs en español)
 *   'english' → Inglés (y releases sin marcas de idioma: la escena internacional
 *               publica en inglés sin indicarlo; lo mismo los fansubs de anime)
 *   'other'   → Idioma distinto explícito (francés, alemán, ruso…) sin inglés.
 *
 * Señales usadas (en orden de prioridad): array `audio`, array `subtitles`, título.
 */

const SPANISH_CODES = new Set([
  'es', 'spa', 'esp', 'spanish', 'español', 'espanol', 'castellano', 'castilian',
  'latino', 'lat', 'latam', 'es-es', 'es-419', 'es-mx', 'es-la', 'es-ar', 'es_es', 'es_mx',
  'spanish (latin america)', 'spanish (spain)', 'latin american spanish',
]);
const ENGLISH_CODES = new Set(['en', 'eng', 'english', 'inglés', 'ingles', 'en-us', 'en-gb', 'en_us', 'en_gb']);
// Japonés/chino/coreano: audio original habitual en anime/asiático → no cuenta como "otro".
const NEUTRAL_CODES = new Set(['ja', 'jp', 'jpn', 'japanese', 'japonés', 'japones', 'zh', 'chi', 'zho', 'ko', 'kor', 'und', 'unknown', 'mul']);

// Marcas en el título que indican español (audio o subtítulos).
const SPANISH_TITLE_RE = new RegExp(
  [
    'castellano', 'espa[ñn]ol', 'spanish', 'latino', 'latam',
    '(?<![a-z])(?:lat|spa|esp)(?![a-z])', '\\[cast(?:ellano)?\\]',
    'vose', '(?<![a-z])vos(?![a-z])', 'subtitulad[oa]', 'subs?[\\s._-]*(?:esp|spa|es)(?![a-z])',
    'esp[\\s._-]*eng', 'spa[\\s._-]*eng', 'eng[\\s._-]*(?:esp|spa)(?![a-z])',
    // Trackers/sitios españoles cuyos releases siempre son en castellano/latino
    'divxtotal', 'newpct', 'dontorrent', 'mejortorrent', 'elitetorrent', 'grantorrent',
    'wolfmax4k', 'todotorrents', 'pctfenix', 'pctmix', 'atomixhq', 'cinecalidad',
  ].join('|'),
  'i',
);

// Nota: no usamos "en" suelto porque es una palabra española muy común.
const ENGLISH_TITLE_RE = /(?<![a-z])(?:english|eng)(?![a-z])|\bdual[\s._-]*audio\b|\bmulti\b/i;

// Idiomas "otros" explícitos. VOSTFR = francés con subtítulos, Legendado/Dublado = pt-BR.
const OTHER_TITLE_RE = new RegExp(
  [
    'truefrench', 'french', 'vostfr', 'subfrench', 'vff', 'vfq', '(?<![a-z])vf(?![a-z])',
    'german', 'deutsch', 'italian', '(?<![a-z])ita(?![a-z])', 'russian', '(?<![a-z])rus(?![a-z])',
    'dublado', 'legendado', 'portugu[eê]s', '(?<![a-z])pt-?br(?![a-z])', 'polish', 'hindi',
    'turkish', 'arabic', 'korean', 'chinese', 'dutch', 'swedish', 'czech', 'hungarian',
  ].join('|'),
  'i',
);

const normalizeCode = (value) => String(value ?? '').trim().toLowerCase();

/** Convierte un campo array (o string JSON/CSV) en array de códigos normalizados. */
function toCodes(field) {
  if (!field) return [];
  if (Array.isArray(field)) return field.map(normalizeCode).filter(Boolean);
  if (typeof field === 'string') {
    try {
      const parsed = JSON.parse(field);
      if (Array.isArray(parsed)) return parsed.map(normalizeCode).filter(Boolean);
    } catch {
      /* no es JSON: lo tratamos como lista separada por comas o "{a,b}" de Postgres */
    }
    return field.replace(/[{}"]/g, '').split(/[,|;/]/).map(normalizeCode).filter(Boolean);
  }
  return [];
}

/**
 * @param {{title?:string, audio?:string[]|string, subtitles?:string[]|string}} torrent
 * @returns {'spanish'|'english'|'other'}
 */
export function classifyLanguage({ title = '', audio, subtitles } = {}) {
  const audioCodes = toCodes(audio);
  const subCodes = toCodes(subtitles);
  const t = String(title || '');

  // 1) Español: audio, subtítulos (VOSE) o marcas en el título.
  if (
    audioCodes.some((c) => SPANISH_CODES.has(c)) ||
    subCodes.some((c) => SPANISH_CODES.has(c)) ||
    SPANISH_TITLE_RE.test(t)
  ) {
    return 'spanish';
  }

  // 2) Inglés explícito.
  const englishAudio = audioCodes.some((c) => ENGLISH_CODES.has(c));
  const englishSubs = subCodes.some((c) => ENGLISH_CODES.has(c));
  if (englishAudio || ENGLISH_TITLE_RE.test(t)) return 'english';

  // 3) Otro idioma explícito (audio no neutro o marca en el título) sin inglés.
  const otherAudio = audioCodes.some(
    (c) => !SPANISH_CODES.has(c) && !ENGLISH_CODES.has(c) && !NEUTRAL_CODES.has(c),
  );
  if ((otherAudio && !englishSubs) || OTHER_TITLE_RE.test(t)) return 'other';

  // 4) Sin marcas de idioma → escena internacional / fansub en inglés.
  return 'english';
}
