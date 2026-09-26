/**
 * Cliente Kitsu (JSON:API público, sin API key).
 * Docs: https://kitsu.docs.apiary.io/  — Dominio actual: kitsu.app (antes kitsu.io).
 *
 * Estrategia:
 *   1) Si conocemos el id de MyAnimeList (de la fila o de AniList) usamos el
 *      endpoint de mappings → resultado exacto, sin ambigüedad.
 *   2) Si no, búsqueda por texto validada por similitud de título.
 */

import { fetchJson, createRateLimiter } from '../lib/http.js';
import { bestSimilarity } from '../parsers/title-cleaner.js';

const HEADERS = {
  Accept: 'application/vnd.api+json',
  'Content-Type': 'application/vnd.api+json',
};

export class KitsuClient {
  constructor({ apiUrl, rpm, matchThreshold }) {
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.limiter = createRateLimiter(rpm);
    this.matchThreshold = matchThreshold;
  }

  #get(path, params) {
    const url = new URL(`${this.apiUrl}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    return fetchJson(url.toString(), { headers: HEADERS, limiter: this.limiter });
  }

  /** Id de Kitsu a partir del id de MyAnimeList (mapping exacto). */
  async findByMalId(malId) {
    const json = await this.#get('/mappings', {
      'filter[externalSite]': 'myanimelist/anime',
      'filter[externalId]': malId,
      include: 'item',
      'fields[anime]': 'canonicalTitle',
    });
    const item = json?.data?.[0]?.relationships?.item?.data;
    if (item?.type === 'anime' && item.id) return { kitsuId: Number(item.id), score: 1 };
    return null;
  }

  /** Búsqueda por texto validada por similitud. */
  async search(query, year = null) {
    if (!query) return null;
    const json = await this.#get('/anime', {
      'filter[text]': query,
      'page[limit]': 8,
      'fields[anime]': 'canonicalTitle,titles,abbreviatedTitles,startDate,subtype',
    });

    let best = null;
    for (const item of json?.data || []) {
      const a = item.attributes || {};
      const titles = [a.canonicalTitle, ...Object.values(a.titles || {}), ...(a.abbreviatedTitles || [])].filter(Boolean);
      let score = bestSimilarity(query, titles);
      const itemYear = a.startDate ? Number(String(a.startDate).slice(0, 4)) : null;
      if (year && itemYear) score += Math.abs(itemYear - year) <= 1 ? 0.08 : -0.15;
      if (!best || score > best.score) best = { kitsuId: Number(item.id), score };
    }
    return best && best.score >= this.matchThreshold ? best : null;
  }
}
