/**
 * Cliente HTTP con:
 *  - Rate limiter por API (token bucket simple basado en intervalo mínimo).
 *  - Reintentos con backoff exponencial ante 429 / 5xx / errores de red.
 *  - Respeto de la cabecera Retry-After.
 *  - Timeout por petición.
 * Usa el `fetch` nativo de Node >= 18.
 */

import { sleep } from './utils.js';
import { log } from './logger.js';

/**
 * Crea un limitador que garantiza como máximo `rpm` peticiones por minuto,
 * serializando las llamadas (seguro aunque se invoque de forma concurrente).
 */
export function createRateLimiter(rpm) {
  const minInterval = Math.ceil(60_000 / Math.max(1, rpm));
  let next = 0;
  return async function acquire() {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + minInterval;
    if (wait > 0) await sleep(wait);
  };
}

export class HttpError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

/**
 * fetch + JSON con reintentos.
 * @param {string} url
 * @param {RequestInit & {limiter?: Function, retries?: number, timeoutMs?: number}} options
 * @returns {Promise<any|null>} JSON parseado, o null si la respuesta es 404.
 */
export async function fetchJson(url, options = {}) {
  const { limiter, retries = 4, timeoutMs = 15_000, ...init } = options;

  for (let attempt = 0; ; attempt++) {
    if (limiter) await limiter();
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });

      if (res.status === 404) return null;

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(60_000, 1000 * 2 ** attempt);
        if (attempt >= retries) {
          throw new HttpError(`HTTP ${res.status} tras ${attempt + 1} intentos: ${url}`, res.status);
        }
        log.debug(`HTTP ${res.status} en ${new URL(url).host}; reintento en ${delay} ms`);
        await sleep(delay);
        continue;
      }

      const text = await res.text();
      if (!res.ok) throw new HttpError(`HTTP ${res.status}: ${text.slice(0, 200)}`, res.status, text);
      return text ? JSON.parse(text) : null;
    } catch (err) {
      // Errores HTTP 4xx definitivos: no se reintentan.
      if (err instanceof HttpError) throw err;
      // Errores de red / timeout: reintento con backoff.
      if (attempt >= retries) throw err;
      const delay = Math.min(30_000, 1000 * 2 ** attempt);
      log.debug(`Error de red (${err.message}); reintento en ${delay} ms`);
      await sleep(delay);
    }
  }
}
