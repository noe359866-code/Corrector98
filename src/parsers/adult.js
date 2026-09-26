/**
 * DETECTOR DE CONTENIDO ADULTO
 * ------------------------------------------------------------------
 * Dos fases:
 *   1) Pre-filtro barato en Postgres con ILIKE (reduce el volumen descargado).
 *   2) Verificación precisa en JS con límites de palabra + lista blanca, para
 *      evitar falsos positivos (p. ej. la saga "xXx" de Vin Diesel o el anime
 *      "Hentai Ouji to Warawanai Neko", que no son contenido adulto).
 *
 * Se evitan a propósito términos ambiguos como "sex" o "hardcore"
 * ("Sex Education", "Hardcore Henry"...). Se pueden añadir más términos con
 * la variable de entorno ADULT_EXTRA_KEYWORDS (separados por comas).
 */

// Un '*' final indica prefijo: 'porn*' cubre porno, pornhub, porntube…
export const DEFAULT_ADULT_KEYWORDS = [
  'porn*', 'pornograf*', 'xxx', 'nsfw', 'hentai', 'brazzers', 'onlyfans', 'bangbros',
  'reality kings', 'naughty america', 'blacked raw', 'blackedraw', 'tushy', 'evil angel',
  'digital playground', 'fakehub', 'fake taxi', 'teamskeet', 'pervmom', 'jav uncensored',
  'jav censored', 'sexo explicito', 'sexo explícito', 'xvideos', 'xhamster', 'youporn', 'redtube',
  'rule34',
]

/** Excepciones: títulos legítimos que contienen palabras clave. */
const WHITELIST = [
  /\bxXx\b/, // estilizado así (sensible a mayúsculas) = saga de Vin Diesel
  /^\s*xxx[\s._:-]+(?:(?:19|20)\d{2}\b|return[\s._]of[\s._]xander[\s._]cage|state[\s._]of[\s._]the[\s._]union|reactivated)/i,
  /hentai[\s._-]+(?:ouji|prince)/i, // "Hentai Prince and the Stony Cat" (anime apto)
  /xxxtentacion/i, // documental sobre el rapero
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Construye la regex de detección con límites de palabra flexibles (., _, -, espacios). */
export function buildAdultRegex(keywords) {
  const parts = keywords.map((k) => {
    const prefix = k.trim().endsWith('*');
    const body = k.trim().replace(/\*$/, '').split(/\s+/).map(escapeRe).join('[\\s._-]*');
    return prefix ? `${body}[a-záéíóúñ]*` : body;
  });
  // (?<![a-z0-9]) / (?![a-z]) = límites de palabra que también funcionan con "." y "_"
  return new RegExp(`(?<![a-z0-9])(?:${parts.join('|')})(?![a-z])`, 'i');
}

/**
 * Patrones ILIKE para el pre-filtro en PostgREST (`title.ilike.%porn%`).
 * Espacios y separadores → comodín '%'.
 */
export function buildIlikePatterns(keywords) {
  const set = new Set();
  for (const k of keywords) {
    const core = k.trim().toLowerCase().replace(/\*$/, '').replace(/[^a-z0-9ñáéíóú]+/g, '%');
    if (core.length >= 3) set.add(core);
  }
  // Quita patrones redundantes: '%porn%' ya cubre '%pornograf%'.
  const cores = [...set];
  return cores
    .filter((c) => !cores.some((other) => other !== c && c.includes(other)))
    .map((c) => `%${c}%`);
}

/**
 * @param {string} title
 * @param {RegExp} regex  Regex construida con buildAdultRegex
 * @returns {boolean}
 */
export function isAdultTitle(title, regex) {
  if (!title) return false;
  if (!regex.test(title)) return false;
  return !WHITELIST.some((re) => re.test(title));
}
