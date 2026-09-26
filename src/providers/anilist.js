/**
 * Cliente AniList (GraphQL público, sin API key).
 * Docs: https://docs.anilist.co/  — Rate limit nominal: 90 req/min (a veces degradado a 30).
 */

import { fetchJson, createRateLimiter } from '../lib/http.js';
import { bestSimilarity } from '../parsers/title-cleaner.js';

const MEDIA_FIELDS = `
  id
  idMal
  format
  seasonYear
  startDate { year }
  title { romaji english native userPreferred }
  synonyms
`;

const SEARCH_QUERY = `
  query ($search: String) {
    Page(perPage: 8) {
      media(search: $search, type: ANIME, sort: SEARCH_MATCH) { ${MEDIA_FIELDS} }
    }
  }
`;

const BY_MAL_QUERY = `
  query ($idMal: Int) {
    Media(idMal: $idMal, type: ANIME) { ${MEDIA_FIELDS} }
  }
`;

const BY_ID_QUERY = `
  query ($id: Int) {
    Media(id: $id, type: ANIME) { ${MEDIA_FIELDS} }
  }
`;

export class AniListClient {
  constructor({ apiUrl, rpm, matchThreshold }) {
    this.apiUrl = apiUrl;
    this.limiter = createRateLimiter(rpm);
    this.matchThreshold = matchThreshold;
  }

  async #graphql(query, variables) {
    const json = await fetchJson(this.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
      limiter: this.limiter,
    });
    // AniList devuelve 404 + errors cuando Media(idMal) no existe → fetchJson devuelve null.
    return json?.data ?? null;
  }

  static #toResult(media, score) {
    return {
      anilistId: media.id,
      malId: media.idMal ?? null,
      format: media.format ?? null,
      year: media.seasonYear ?? media.startDate?.year ?? null,
      titles: [media.title?.english, media.title?.romaji, media.title?.userPreferred, media.title?.native, ...(media.synonyms || [])].filter(Boolean),
      score,
    };
  }

  /** Búsqueda precisa por id de MyAnimeList. */
  async findByMalId(malId) {
    const data = await this.#graphql(BY_MAL_QUERY, { idMal: Number(malId) });
    return data?.Media ? AniListClient.#toResult(data.Media, 1) : null;
  }

  /** Datos de un anime a partir de su id de AniList (para obtener idMal). */
  async findById(anilistId) {
    const data = await this.#graphql(BY_ID_QUERY, { id: Number(anilistId) });
    return data?.Media ? AniListClient.#toResult(data.Media, 1) : null;
  }

  /**
   * Busca por título y valida el resultado por similitud (+ bonus por año).
   * @returns {Promise<null|{anilistId:number, malId:number|null, format:string, year:number|null, titles:string[], score:number}>}
   */
  async search(query, year = null) {
    if (!query) return null;
    const data = await this.#graphql(SEARCH_QUERY, { search: query });
    const list = data?.Page?.media || [];

    let best = null;
    for (const media of list) {
      const result = AniListClient.#toResult(media, 0);
      let score = bestSimilarity(query, result.titles);
      if (year && result.year) score += Math.abs(result.year - year) <= 1 ? 0.08 : -0.15;
      if (!best || score > best.score) best = { ...result, score };
    }
    return best && best.score >= this.matchThreshold ? best : null;
  }
}
