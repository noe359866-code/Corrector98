/**
 * PASO 6 — DEDUPLICADOR INTELIGENTE (TOP 2 ESPAÑOL / TOP 2 INGLÉS)
 * ------------------------------------------------------------------
 *  1) Agrupa por obra: (imdb_id | tmdb_id | anilist_id | kitsu_id) + season + episode.
 *     Las filas sin ningún id de obra NO se tocan (no hay forma segura de agruparlas).
 *  2) Clasifica cada torrent en 'spanish' / 'english' / 'other' (título + audio + subtítulos).
 *  3) Ordena por seeders DESC (desempate: tamaño DESC, id ASC → resultado determinista).
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

const COLUMNS = 'id,imdb_id,tmdb_id,anilist_id,kitsu_id,type,season,episode,absolute_episode,title,audio,subtitles,seeders,size_bytes,info_hash';
const has = (v) => v !== null && v !== undefined && v !== '';

/**
 * Clave única de obra + temporada + episodio. `null` si la fila no tiene ningún id.
 * Nota: los ids de TMDB se repiten entre películas y series → se incluye el tipo.
 */
export function workKey(row) {
  let base = null;
  if (has(row.imdb_id)) base = `imdb:${row.imdb_id}`;
  else if (has(row.tmdb_id)) base = `tmdb:${row.type === 'movie' ? 'movie' : 'tv'}:${row.tmdb_id}`;
  else if (has(row.anilist_id)) base = `anilist:${row.anilist_id}`;
  else if (has(row.kitsu_id)) base = `kitsu:${row.kitsu_id}`;
  if (!base) return null;

  const season = row.season ?? '-';
  const episode = row.episode ?? row.absolute_episode ?? '-';
  return `${base}|s${season}|e${episode}`;
}

/** Orden: más seeders primero; desempate por tamaño (mayor calidad) y por id. */
export function compareEntries(a, b) {
  return (
    (b.seeders ?? 0) - (a.seeders ?? 0) ||
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
  const sorted = [...entries].sort(compareEntries);
  const kept = [];
  const remove = [];
  const seenHashes = new Set();
  const perLang = { spanish: 0, english: 0 };

  for (const entry of sorted) {
    const hash = entry.hash ? String(entry.hash).toLowerCase() : null;
    if (hash && seenHashes.has(hash)) {
      remove.push({ id: entry.id, reason: 'duplicate_hash' });
      continue;
    }
    if (hash) seenHashes.add(hash);

    if (entry.lang === 'spanish' || entry.lang === 'english') {
      if (perLang[entry.lang] < keep) {
        perLang[entry.lang]++;
        kept.push(entry);
      } else {
        remove.push({ id: entry.id, reason: `excess_${entry.lang}` });
      }
    } else if (otherPolicy === 'keep') {
      kept.push(entry);
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
  let withoutId = 0;
  const langCount = { spanish: 0, english: 0, other: 0 };

  for await (const page of db.scan(COLUMNS)) {
    scanned += page.length;
    for (const row of page) {
      const key = workKey(row);
      if (!key) {
        withoutId++;
        continue;
      }
      const lang = classifyLanguage(row);
      langCount[lang]++;
      const entry = { id: row.id, seeders: row.seeders ?? 0, size: row.size_bytes ?? 0, lang, hash: row.info_hash || null };
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

  log.info(`  Filas analizadas: ${scanned} (sin id de obra, ignoradas: ${withoutId})`);
  log.info(`  Idiomas → spanish: ${langCount.spanish}, english: ${langCount.english}, other: ${langCount.other}`);
  log.info(`  Grupos (obra+temporada+episodio): ${groups.size}; grupos recortados: ${groupsTrimmed}`);
  log.info(
    `  Excedentes → hash duplicado: ${reasons.duplicate_hash}, spanish: ${reasons.excess_spanish}, ` +
    `english: ${reasons.excess_english}, otros idiomas: ${reasons.other_language} (política: ${config.dedupeOtherLanguages})`,
  );

  const deleted = await db.deleteByIds(idsToDelete, 'dedupe');
  log.info(`  Eliminados: ${deleted}`);
  return { scanned, groups: groups.size, groupsTrimmed, deleted, reasons, langCount };
}
