/**
 * EXTRACTOR DE METADATOS TÉCNICOS DEL TÍTULO
 * ------------------------------------------------------------------
 * Deduce del nombre del release las columnas técnicas de la tabla:
 *   quality       varchar(20)  → '2160p' | '1080p' | '720p' | '480p' | 'CAM'
 *   codec         varchar(20)  → 'HEVC' | 'AVC' | 'AV1' | 'VP9' | 'XviD' | 'DivX' | 'MPEG2'
 *   hdr_format    varchar(20)  → 'DV+HDR10' | 'DV' | 'HDR10+' | 'HDR10' | 'HDR' | 'HLG'
 *   channels      varchar(10)  → '7.1' | '5.1' | '2.0' | …
 *   release_group varchar(100) → 'SubsPlease', 'DEMAND', …
 * Función pura (sin I/O). Los valores se recortan a la longitud de cada columna.
 */

const LIMITS = { quality: 20, codec: 20, hdr_format: 20, channels: 10, release_group: 100 };
const cut = (value, field) => (value ? String(value).slice(0, LIMITS[field]) : null);

/** Ranking numérico de calidad (para desempates en el deduplicador). */
export const QUALITY_RANK = { '2160p': 5, '1080p': 4, '720p': 3, '480p': 2, CAM: 0 };

export function extractQuality(title) {
  const t = String(title || '');
  if (/(?<![a-z0-9])(?:2160p|4k|uhd)(?![a-z0-9])/i.test(t)) return '2160p';
  if (/(?<![a-z0-9])1080[pi](?![a-z0-9])/i.test(t)) return '1080p';
  if (/(?<![a-z0-9])720p(?![a-z0-9])/i.test(t)) return '720p';
  if (/(?<![a-z0-9])(?:576p|480p|360p)(?![a-z0-9])/i.test(t)) return '480p';
  if (/(?<![a-z0-9])(?:hd-?cam|cam-?rip|cam|hd-?ts|telesync|ts-?rip|tele-?cine|hdtc)(?![a-z0-9])/i.test(t)) return 'CAM';
  if (/(?<![a-z0-9])(?:dvd-?rip|xvid|divx|sd-?tv|dvd-?scr)(?![a-z0-9])/i.test(t)) return '480p';
  return null;
}

export function extractCodec(title) {
  const t = String(title || '');
  if (/(?<![a-z0-9])(?:[xh]\.?265|hevc)(?![a-z0-9])/i.test(t)) return 'HEVC';
  if (/(?<![a-z0-9])av1(?![a-z0-9])/i.test(t)) return 'AV1';
  if (/(?<![a-z0-9])vp9(?![a-z0-9])/i.test(t)) return 'VP9';
  if (/(?<![a-z0-9])(?:[xh]\.?264|avc)(?![a-z0-9])/i.test(t)) return 'AVC';
  if (/(?<![a-z0-9])xvid(?![a-z0-9])/i.test(t)) return 'XviD';
  if (/(?<![a-z0-9])divx(?![a-z0-9])/i.test(t)) return 'DivX';
  if (/(?<![a-z0-9])mpeg-?2(?![a-z0-9])/i.test(t)) return 'MPEG2';
  return null;
}

export function extractHdr(title) {
  const t = String(title || '');
  const dv = /(?<![a-z0-9])(?:dv|dovi|dolby[\s._-]?vision)(?![a-z0-9])/i.test(t);
  const hdr10plus = /(?<![a-z0-9])hdr10(?:\+|plus)(?![a-z0-9])/i.test(t);
  const hdr10 = /(?<![a-z0-9])hdr10(?![+a-z0-9])/i.test(t);
  const hdr = /(?<![a-z0-9])hdr(?![a-z0-9])/i.test(t);
  const hlg = /(?<![a-z0-9])hlg(?![a-z0-9])/i.test(t);
  if (dv && hdr10plus) return 'DV+HDR10+';
  if (dv && (hdr10 || hdr)) return 'DV+HDR10';
  if (dv) return 'DV';
  if (hdr10plus) return 'HDR10+';
  if (hdr10) return 'HDR10';
  if (hdr) return 'HDR';
  if (hlg) return 'HLG';
  return null;
}

export function extractChannels(title) {
  const t = String(title || '');
  // Tras un códec de audio: "DDP5.1", "AAC2.0", "DD+ 7.1", "[AC3 5.1 Castellano]", "DTS-HD MA 7.1"
  let m = t.match(/(?:DDP|DD\+?|E-?AC-?3|AC-?3|AAC|DTS(?:-?HD)?(?:[\s.-]?MA)?|TrueHD|Atmos|FLAC|OPUS|L?PCM)[\s.-]?([1-9])[.\s]([01])(?![0-9])/i);
  if (m) return `${m[1]}.${m[2]}`;
  // "5.1ch", "7.1 ch"
  m = t.match(/(?<![0-9.])([1-9])[.]([01])\s?ch(?![a-z])/i);
  if (m) return `${m[1]}.${m[2]}`;
  // "5.1" / "7.1" sueltos (no "2.0": choca con títulos tipo "Tron 2.0")
  m = t.match(/(?<![0-9.])([57])\.1(?![0-9])/);
  if (m) return `${m[1]}.1`;
  return null;
}

const NOT_A_GROUP = /^(?:x26[45]|h26[45]|hevc|avc|av1|\d{3,4}p|web|dl|rip|bluray|hdtv|aac|ac3|dts|mkv|mp4|avi|es|en|multi|dual|castellano|latino)$/i;

export function extractReleaseGroup(title) {
  const t = String(title || '').trim();
  // Anime: "[SubsPlease] Show - 01"
  const lead = t.match(/^\[([^\]]{2,60})\]/);
  if (lead && !/^(?:www\.|https?:)/i.test(lead[1]) && !/^\d{3,4}p$/i.test(lead[1])) return lead[1].trim();
  // Escena: "Show.S01E01.1080p.WEB.h264-GROUP[rarbg].mkv" → GROUP
  const tail = t
    .replace(/\.(mkv|mp4|avi|m4v|ts)$/i, '')
    .replace(/(?:\s*\[[^\]]*\])+$/g, '')
    .match(/-([A-Za-z0-9][A-Za-z0-9_]{1,30})$/);
  if (tail && !NOT_A_GROUP.test(tail[1]) && /[A-Za-z]/.test(tail[1])) return tail[1];
  return null;
}

/**
 * @param {string} title
 * @returns {{quality:string|null, codec:string|null, hdr_format:string|null, channels:string|null, release_group:string|null}}
 */
export function extractMetadata(title) {
  return {
    quality: cut(extractQuality(title), 'quality'),
    codec: cut(extractCodec(title), 'codec'),
    hdr_format: cut(extractHdr(title), 'hdr_format'),
    channels: cut(extractChannels(title), 'channels'),
    release_group: cut(extractReleaseGroup(title), 'release_group'),
  };
}

const isEmpty = (v) => v === null || v === undefined || v === '' || v === 'Unknown' || v === 'unknown';

/**
 * Patch con los metadatos que FALTAN en la fila (nunca sobrescribe valores existentes).
 * `quality` se considera vacía si vale 'Unknown' (el DEFAULT de la columna).
 */
export function computeMetadataPatch(row) {
  const meta = extractMetadata(row.title);
  const patch = {};
  for (const [field, value] of Object.entries(meta)) {
    if (value && isEmpty(row[field])) patch[field] = value;
  }
  return Object.keys(patch).length ? patch : null;
}
