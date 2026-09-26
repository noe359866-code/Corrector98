/**
 * Cliente TMDB v3.
 * Acepta tanto la "API Key" v3 (query ?api_key=) como el "API Read Access
 * Token" v4 (JWT → cabecera Authorization: Bearer). Se detecta automáticamente.
 *
 *  - findByImdbId(): /find/{imdb_id} → tmdb_id exacto cuando ya tenemos imdb_id.
 *  - search():       /search/{movie|tv} validado por similitud + año, y luego
 *                    /{movie|tv}/{id}/external_ids para extraer el imdb_id.
 */

import { fetchJson, createRateLimiter } from '../lib/http.js';
import { bestSimilarity } from '../parsers/title-cleaner.js';

export class TmdbClient {
  constructor({ apiKey, apiUrl, rpm, matchThreshold }) {
    this.apiKey = apiKey;
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.isBearer = apiKey.startsWith('eyJ'); // los tokens v4 son JWT
    this.limiter = createRateLimiter(rpm);
    this.matchThreshold = matchThreshold;
  }

  #get(path, params = {}) {
    const url = new URL(`${this.apiUrl}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
    const headers = { Accept: 'application/json' };
    if (this.isBearer) headers.Authorization = `Bearer ${this.apiKey}`;
    else url.searchParams.set('api_key', this.apiKey);
    return fetchJson(url.toString(), { headers, limiter: this.limiter });
  }

  /** tmdb_id a partir de un imdb_id. `kind`: 'movie' | 'tv' | null (cualquiera). */
  async findByImdbId(imdbId, kind = null) {
    const json = await this.#get(`/find/${encodeURIComponent(imdbId)}`, { external_source: 'imdb_id' });
    if (!json) return null;
    const movie = json.movie_results?.[0];
    // Si el imdb_id es de un episodio, TMDB devuelve la serie en tv_episode_results[].show_id
    const episode = json.tv_episode_results?.[0];
    const tv = json.tv_results?.[0] || (episode?.show_id ? { id: episode.show_id } : null);
    if (kind === 'movie' && movie) return { tmdbId: movie.id, imdbId, kind: 'movie' };
    if (kind === 'tv' && tv) return { tmdbId: tv.id, imdbId, kind: 'tv' };
    if (!kind && (movie || tv)) return movie ? { tmdbId: movie.id, imdbId, kind: 'movie' } : { tmdbId: tv.id, imdbId, kind: 'tv' };
    return null;
  }

  /** imdb_id asociado a un tmdb_id. */
  async getImdbId(tmdbId, kind) {
    const json = await this.#get(`/${kind}/${tmdbId}/external_ids`);
    return json?.imdb_id || null;
  }

  #pickBest(results, query, year, kind) {
    let best = null;
    for (const r of results || []) {
      const titles = kind === 'movie' ? [r.title, r.original_title] : [r.name, r.original_name];
      const date = kind === 'movie' ? r.release_date : r.first_air_date;
      const rYear = date ? Number(date.slice(0, 4)) : null;
      let score = bestSimilarity(query, titles);
      if (year && rYear) {
        const diff = Math.abs(rYear - year);
        // En series el año del release puede ser el de una temporada posterior → penalizamos menos.
        score += diff <= 1 ? 0.1 : kind === 'movie' ? -0.25 : -0.05;
      }
      // Desempate leve por popularidad.
      score += Math.min(0.03, (r.popularity || 0) / 10_000);
      if (!best || score > best.score) best = { tmdbId: r.id, score };
    }
    return best && best.score >= this.matchThreshold ? best : null;
  }

  /**
   * Busca por título. Primero en inglés; si no hay coincidencia válida, en
   * español (los trackers hispanos usan títulos traducidos: "El Padrino").
   * @param {'movie'|'tv'} kind
   * @returns {Promise<null|{tmdbId:number, imdbId:string|null, kind:string, score:number}>}
   */
  async search(query, year, kind) {
    if (!query) return null;
    const yearParam = kind === 'movie' ? 'year' : 'first_air_date_year';

    for (const language of ['en-US', 'es-ES']) {
      // Con año primero (más preciso); si no hay resultados, sin año.
      let json = await this.#get(`/search/${kind}`, { query, language, include_adult: false, [yearParam]: year });
      if (year && !json?.results?.length) {
        json = await this.#get(`/search/${kind}`, { query, language, include_adult: false });
      }
      const best = this.#pickBest(json?.results, query, year, kind);
      if (best) {
        const imdbId = await this.getImdbId(best.tmdbId, kind);
        return { ...best, imdbId, kind };
      }
    }
    return null;
  }
}
