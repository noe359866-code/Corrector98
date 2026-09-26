/**
 * LIMPIEZA DE TÍTULOS PARA BÚSQUEDA EN APIS + SIMILITUD DE CADENAS
 * ------------------------------------------------------------------
 * "[SubsPlease] Sousou no Frieren - 09 (1080p) [ABCD1234].mkv" → "Sousou no Frieren"
 * "The.Matrix.1999.1080p.BluRay.x264-GROUP"                    → "The Matrix" (1999)
 * "1917.2019.2160p.UHD.BluRay"                                 → "1917" (2019)
 * "Casa de Papel [HDTV 720p][Cap.209][AC3 5.1 Castellano]"     → "Casa de Papel"
 */

// Tokens a partir de los cuales el resto del título es "ruido" técnico.
const STOP_TOKENS = [
  '(?:19|20)\\d{2}', // año
  '\\d{3,4}p', '4k', '8k', 'uhd', 'fhd', 'hd', 'sd',
  'blu-?ray', 'bd-?rip', 'br-?rip', 'bd-?remux', 'remux', 'web-?dl', 'web-?rip', 'web', 'hdtv', 'pdtv',
  'dvd-?rip', 'dvd-?scr', 'dvd', 'hd-?rip', 'micro-?hd', 'hd-?cam', 'cam-?rip', 'cam', 'ts', 'telesync',
  'screener', 'hdtc', 'tc', 'amzn', 'nf', 'dsnp', 'hmax', 'atvp', 'hulu',
  'x\\.?26[45]', 'h\\.?26[45]', 'hevc', 'avc', 'xvid', 'divx', '10-?bit', '8-?bit', 'hdr(?:10)?', 'dv', 'dolby',
  'aac', 'ac3', 'e-?ac3', 'ddp?(?:5|7)?', 'dts(?:-?hd)?', 'truehd', 'atmos', 'flac', 'opus',
  'castellano', 'espa[ñn]ol', 'spanish', 'latino', 'dual', 'multi', 'vose', 'vostfr', 'subs?', 'sub-?esp',
  'french', 'truefrench', 'german', 'ita', 'english', 'eng',
  'proper', 'repack', 'extended', 'unrated', 'remastered', 'director\'?s[\\s.]cut', 'imax',
  'complete', 'completa', 'batch', 'integral',
  // Marcadores de temporada / episodio
  's\\d{1,2}(?:[\\s.-]?e\\d{1,4})*', '\\d{1,2}x\\d{2,3}', 'cap(?:[ií]tulo)?\\.?\\s?\\d+', 'temporada', 'season', 'saison',
  '\\d{1,2}(?:st|nd|rd|th)\\s+season',
];
// "Episode N" solo es marcador de corte en series; en películas forma parte del
// título ("Star Wars Episode 1 The Phantom Menace (1999)").
const EPISODE_TOKENS = ['episod(?:e|io)', 'ep\\s?\\d+'];
const buildStopRe = (tokens) => new RegExp(`(?:^|[\\s.\\-_\\[(])(${tokens.join('|')})(?=$|[\\s.\\-_\\])])`, 'gi');
const STOP_RE_SERIES = buildStopRe([...STOP_TOKENS, ...EPISODE_TOKENS]);
const STOP_RE_MOVIE = buildStopRe(STOP_TOKENS);
const YEAR_TOKEN_RE = /^(?:19|20)\d{2}$/;

/**
 * Limpia un título para usarlo como query en AniList/Kitsu/TMDB.
 * @param {string} rawTitle
 * @returns {{query: string, year: number|null}}
 */
export function cleanTitleForSearch(rawTitle) {
  if (!rawTitle) return { query: '', year: null };
  let t = String(rawTitle);

  t = t.replace(/\.(mkv|mp4|avi|m4v|ts|wmv)$/i, ''); // extensión
  t = t.replace(/(?:www\.)?[a-z0-9-]+\.(?:com|net|org|to|tv|me|cc|es|info|ws|biz|lat|app)\b/gi, ' '); // dominios
  t = t.replace(/^\s*(?:[[(【][^\])】]*[\])】]\s*)+/, ''); // [Grupo] inicial(es)

  // Año entre paréntesis = año de estreno; todo lo posterior es metadata.
  // Así "Blade Runner 2049 (2017) 1080p" → "Blade Runner 2049" (2017).
  let year = null;
  const parenYear = t.match(/[([]((?:19|20)\d{2})[)\]]/);
  if (parenYear) {
    year = Number(parenYear[1]);
    t = t.slice(0, parenYear.index);
  }

  // El resto de corchetes/paréntesis son metadatos (calidad, CRC, idioma…).
  t = t.replace(/[[(【][^\])】]*[\])】]/g, ' ');
  t = t.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Anime: " - 09" marca el fin del nombre de la serie.
  const animeDash = t.match(/\s-\s\d{1,4}(?:v\d)?(?:\s|$)/);
  if (animeDash) t = t.slice(0, animeDash.index);

  // Corta en el primer stop-token que NO esté al inicio (así "1917 2019" → "1917").
  const looksLikeMovie = /(?:^|\s)(?:19|20)\d{2}(?:\s|$)/.test(t) || year !== null;
  const hasEpisodeMarker = /\bS\d{1,2}\s?E\d{1,4}\b|\b\d{1,2}x\d{2,3}\b/i.test(t);
  const STOP_RE = looksLikeMovie && !hasEpisodeMarker ? STOP_RE_MOVIE : STOP_RE_SERIES;
  STOP_RE.lastIndex = 0;
  let match;
  while ((match = STOP_RE.exec(t)) !== null) {
    const tokenStart = match.index + match[0].indexOf(match[1]);
    if (tokenStart === 0) continue;
    // Con año entre paréntesis ya recortado, cualquier otro año es parte del título.
    if (parenYear && YEAR_TOKEN_RE.test(match[1])) continue;
    // Dos años seguidos ("Blade Runner 2049 2017"): el primero es parte del título.
    if (YEAR_TOKEN_RE.test(match[1]) && /^[\s.]+(?:19|20)\d{2}(?:\s|$)/.test(t.slice(tokenStart + 4))) continue;
    if (!year && YEAR_TOKEN_RE.test(match[1])) year = Number(match[1]);
    t = t.slice(0, tokenStart);
    break;
  }
  // Si el corte no fue en un año, puede quedar un año más adelante en el título original.
  if (!year) {
    const y = String(rawTitle).match(/(?:^|[\s.([_-])((?:19|20)\d{2})(?=$|[\s.)\]_-])/g);
    if (y && y.length) {
      const candidates = y.map((s) => Number(s.replace(/\D/g, ''))).filter((n) => String(n) !== t.trim());
      if (candidates.length) year = candidates[0];
    }
  }

  const query = t
    .replace(/^[\s\-–:|,;]+/, '')
    .replace(/[-–:|,;]+\s*$/g, '')
    .replace(/\s+-\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { query, year };
}

/** Normaliza para comparar: minúsculas, sin tildes, solo alfanumérico. */
export function normalizeForCompare(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(?:the|a|an|el|la|los|las)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bigrams(s) {
  const clean = s.replace(/\s+/g, '');
  const map = new Map();
  for (let i = 0; i < clean.length - 1; i++) {
    const bg = clean.slice(i, i + 2);
    map.set(bg, (map.get(bg) || 0) + 1);
  }
  return map;
}

/**
 * Similitud de Sørensen–Dice sobre bigramas (0..1). Robusta ante diferencias
 * menores de puntuación, artículos, tildes y orden parcial.
 */
export function similarity(a, b) {
  const x = normalizeForCompare(a);
  const y = normalizeForCompare(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.replace(/\s/g, '').length < 2 || y.replace(/\s/g, '').length < 2) return 0;

  const bx = bigrams(x);
  const by = bigrams(y);
  let overlap = 0;
  let total = 0;
  for (const [bg, n] of bx) {
    overlap += Math.min(n, by.get(bg) || 0);
    total += n;
  }
  for (const n of by.values()) total += n;
  return (2 * overlap) / total;
}

/** Mejor similitud entre una query y una lista de títulos alternativos. */
export function bestSimilarity(query, candidates) {
  let best = 0;
  for (const c of candidates) {
    if (!c) continue;
    const s = similarity(query, c);
    if (s > best) best = s;
  }
  return best;
}
