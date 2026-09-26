/**
 * PASO 6 — DEDUPLICADOR INTELIGENTE (TOP 2 ESPAÑOL / TOP 2 INGLÉS)
 * ------------------------------------------------------------------
 *  1) Agrupa por obra: (imdb_id | tmdb_id) + season + episode, o
 *     (anilist_id | kitsu_id | mal_id) + episode + absolute_episode (como consulta el addon).
 *     Las filas sin ningún id de obra NO se tocan (no hay forma segura de agruparlas).
 *  2) Clasifica cada torrent en 'spanish' / 'english' / 'other' (título + audio + subtítulos).
 *  3) Ordena por seeders DESC (desempate: calidad, tamaño, id → resultado determinista).
 *  4) Elimina duplicados exactos de info_hash dentro del grupo.
 *  5) REGLA ESTRICTA: conserva los N mejores de 'spanish' y los N mejores de 'english'
 *     (N = DEDUPE_KEEP_PER_LANGUAGE, 2 por defecto) y elimina el resto.
 *     Los de 'other' se eliminan (DEDUPE_OTHER_LANGUAGES=delete) o se conservan (=keep).
 *
 * Memoria: por fila solo se guarda una tupla compacta {id, seeders, size, lang, hash};
 * el título y los arrays se descartan tras clasificar.
 */

import { log } from '../lib/logger.js';
import { classifyLanguage } from '../parsers/language.js';
import { parseTitle } from '../parsers/title-parser.js';
import { QUALITY_RANK, extractQuality } from '../parsers/metadata.js';

const COLUMNS = 'id,imdb_id,tmdb_id,anilist_id,kitsu_id,mal_id,type,season,episode,absolute_episode,title,audio,subtitles,seeders,size_bytes,info_hash,quality,file_index';

/** Ranking de calidad desde la columna `quality` o, si es 'Unknown', desde el título. */
function qualityRank(row) {
  const q = row.quality && row.quality !== 'Unknown' ? String(row.quality) : extractQuality(row.title);
  const normalized = /2160|4k|uhd/i.test(q || '') ? '2160p' : /1080/.test(q || '') ? '1080p' : /720/.test(q || '') ? '720p' : /480|576|sd/i.test(q || '') ? '480p' : /\b(?:cam|ts|tc)\b/i.test(q || '') ? 'CAM' : null;
  return normalized ? QUALITY_RANK[normalized] : 1;
}
const validId = (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) ||
  (typeof v === 'string' && /^[1-9]\d*$/.test(v));
const coordinate = (v) => Number.isSafeInteger(v) && v >= 0;

/**
 * Clave única de obra + episodio, alineada con los índices de consulta del addon:
 *   imdb / tmdb  → (id, season, episode)            idx_torrents_stremio_imdb / idx_torrents_tmdb
 *   anilist / kitsu / mal → (id, episode, absolute) idx_torrents_anilist / _kitsu / _mal
 *     (en anime cada temporada tiene su propio id, por eso no entra `season`)
 * `null` si la fila no tiene ningún id → nunca se deduplica.
 * Nota: los ids de TMDB se repiten entre películas y series → se incluye el tipo.
 */
export function workKey(row) {
  const parsed = parseTitle(row.title);
  // No comparar packs enteros con episodios ni agrupar episodios desconocidos.
  // Un pack solo es comparable cuando la fila identifica un archivo/episodio.
  if (parsed.isPack && (!coordinate(row.file_index) || !coordinate(row.episode))) return null;
  if (row.type === 'series' && (!coordinate(row.season) || !coordinate(row.episode))) return null;
  if (row.type === 'anime' && !coordinate(row.episode) && !coordinate(row.absolute_episode)) return null;
  if (parsed.episode !== null && !parsed.isPack && row.episode !== parsed.episode) return null;
  if (parsed.explicitSeason && !parsed.isMultiSeason && row.season !== parsed.season) return null;
  if (row.type === 'movie' && (parsed.type === 'series' || parsed.type === 'anime')) return null;

  const se = `s${row.season ?? '-'}|e${row.episode ?? '-'}`;
  const anime = `e${row.episode ?? '-'}|a${row.absolute_episode ?? '-'}`;
  const sceneCoordinates = row.type !== 'anime' || (coordinate(row.season) && coordinate(row.episode));
  if (sceneCoordinates && /^tt[0-9]+$/.test(row.imdb_id ?? '')) return `imdb:${row.imdb_id}|${se}`;
  if (sceneCoordinates && validId(row.tmdb_id)) return `tmdb:${row.type === 'movie' ? 'movie' : 'tv'}:${row.tmdb_id}|${se}`;
  if (validId(row.anilist_id)) return `anilist:${row.anilist_id}|${anime}`;
  if (validId(row.kitsu_id)) return `kitsu:${row.kitsu_id}|${anime}`;
  if (validId(row.mal_id)) return `mal:${row.mal_id}|${anime}`;
  return null;
}

/** Orden: más seeders; desempate por calidad (2160p > 1080p > …), tamaño e id. */
export function compareEntries(a, b) {
  return (
    (b.seeders ?? 0) - (a.seeders ?? 0) ||
    (b.qualityRank ?? 1) - (a.qualityRank ?? 1) ||
    (b.size ?? 0) - (a.size ?? 0) ||
    String(a.id).localeCompare(String(b.id), undefined, { numeric: true })
  );
}

/**
 * Decide qué torrents de un grupo sobran.
 * @param {Array<{id, seeders:number, size:number, lang:'spanish'|'english'|'other', hash:string|null}>} entries
 * @param {{keep:number, otherPolicy:'delete'|'keep'}} opts
 * @returns {{keep: Array, remove: Array<{id, reason:string}>}}
 */
export function selectExcess(entries, { keep = 2, otherPolicy = 'delete' } = {}) {
  if (!Number.isSafeInteger(keep) || keep < 1 || !['delete', 'keep'].includes(otherPolicy)) {
    throw new Error('Política de deduplicación inválida');
  }
  const sorted = [...entries].sort(compareEntries);
  const kept = [];
  const remove = [];
  const seenHashes = new Set();
  const perLang = { spanish: 0, english: 0 };

  for (const entry of sorted) {
    const hash = entry.hash ? `${String(entry.hash).trim().toLowerCase()}|f${entry.fileIndex ?? '-'}` : null;
    if (hash && seenHashes.has(hash)) {
      remove.push({ id: entry.id, reason: 'duplicate_hash' });
      continue;
    }

    if (entry.lang === 'spanish' || entry.lang === 'english') {
      if (perLang[entry.lang] < keep) {
        perLang[entry.lang]++;
        kept.push(entry);
        if (hash) seenHashes.add(hash);
      } else {
        remove.push({ id: entry.id, reason: `excess_${entry.lang}` });
      }
    } else if (otherPolicy === 'keep') {
      kept.push(entry);
      if (hash) seenHashes.add(hash);
    } else {
      remove.push({ id: entry.id, reason: 'other_language' });
    }
  }
  return { keep: kept, remove };
}

export async function runDedupe(db, config) {
  /** @type {Map<string, Array>} */
  const groups = new Map();
  let scanned = 0;
  let skippedUnsafe = 0;
  const langCount = { spanish: 0, english: 0, other: 0 };

  for await (const page of db.scan(COLUMNS)) {
    scanned += page.length;
    for (const row of page) {
      const key = workKey(row);
      if (!key) {
        skippedUnsafe++;
        continue;
      }
      const lang = classifyLanguage(row);
      langCount[lang]++;
      const entry = { id: row.id, seeders: row.seeders ?? 0, size: row.size_bytes ?? 0, lang, hash: row.info_hash || null, fileIndex: row.file_index, qualityRank: qualityRank(row) };
      const list = groups.get(key);
      if (list) list.push(entry);
      else groups.set(key, [entry]);
    }
  }

  const reasons = { duplicate_hash: 0, excess_spanish: 0, excess_english: 0, other_language: 0 };
  const idsToDelete = [];
  let groupsTrimmed = 0;
  const opts = { keep: config.keepPerLanguage, otherPolicy: config.dedupeOtherLanguages };

  for (const entries of groups.values()) {
    if (entries.length <= 1 && entries[0]?.lang !== 'other') continue; // nada que hacer
    const { remove } = selectExcess(entries, opts);
    if (!remove.length) continue;
    groupsTrimmed++;
    for (const r of remove) {
      reasons[r.reason]++;
      idsToDelete.push(r.id);
    }
  }

  log.info(`  Filas analizadas: ${scanned} (sin identidad/episodio seguro, preservadas: ${skippedUnsafe})`);
  log.info(`  Idiomas → spanish: ${langCount.spanish}, english: ${langCount.english}, other: ${langCount.other}`);
  log.info(`  Grupos (obra+temporada+episodio): ${groups.size}; grupos recortados: ${groupsTrimmed}`);
  log.info(
    `  Excedentes → hash duplicado: ${reasons.duplicate_hash}, spanish: ${reasons.excess_spanish}, ` +
    `english: ${reasons.excess_english}, otros idiomas: ${reasons.other_language} (política: ${config.dedupeOtherLanguages})`,
  );

  const deleted = await db.deleteByIds(idsToDelete, 'dedupe');
  log.info(`  Eliminados: ${deleted}`);
  return { scanned, skippedUnsafe, groups: groups.size, groupsTrimmed, deleted, reasons, langCount };
}
