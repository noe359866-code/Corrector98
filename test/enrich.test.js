import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDueForRetry, sanitizeIds, pickLocalIds, groupKeyFor, titleKey } from '../src/steps/05-enrich.js';

const H = 3_600_000;
const now = Date.parse('2026-09-25T12:00:00Z');
const opts = { baseHours: 24, maxDays: 30 };
const checked = (hoursAgo, attempts) => ({ ids_checked_at: new Date(now - hoursAgo * H).toISOString(), ids_attempts: attempts });

test('backoff: nunca comprobado → toca', () => {
  assert.equal(isDueForRetry({ ids_checked_at: null }, now, opts), true);
});

test('backoff exponencial: 24h, 48h, 96h…', () => {
  assert.equal(isDueForRetry(checked(23, 1), now, opts), false);
  assert.equal(isDueForRetry(checked(25, 1), now, opts), true);
  assert.equal(isDueForRetry(checked(47, 2), now, opts), false);
  assert.equal(isDueForRetry(checked(49, 2), now, opts), true);
  assert.equal(isDueForRetry(checked(95, 3), now, opts), false);
  assert.equal(isDueForRetry(checked(97, 3), now, opts), true);
});

test('backoff: tope en ENRICH_RETRY_MAX_DAYS', () => {
  assert.equal(isDueForRetry(checked(30 * 24 - 1, 20), now, opts), false);
  assert.equal(isDueForRetry(checked(30 * 24 + 1, 20), now, opts), true);
});

test('sanitizeIds: respeta el CHECK de imdb y los bigint', () => {
  assert.deepEqual(
    sanitizeIds({ imdb_id: 'tt0133093', tmdb_id: 603, kitsu_id: '46474', anilist_id: 0, mal_id: -3 }),
    { imdb_id: 'tt0133093', tmdb_id: 603, kitsu_id: 46474 },
  );
  assert.deepEqual(sanitizeIds({ imdb_id: '' }), {});
  assert.deepEqual(sanitizeIds({ imdb_id: 'nm0000206' }), {}); // id de persona, no de título
  assert.deepEqual(sanitizeIds({ imdb_id: 'tt123 ' }), {});
});

const sets = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, new Set(v)]));

test('pickLocalIds: donantes coherentes → copia', () => {
  assert.deepEqual(pickLocalIds(sets({ imdb_id: ['tt1'], tmdb_id: ['5'], anilist_id: [], kitsu_id: [], mal_id: [] })), { imdb_id: 'tt1', tmdb_id: '5' });
});

test('pickLocalIds: obras homónimas (ids distintos) → no copia nada', () => {
  assert.equal(pickLocalIds(sets({ imdb_id: ['tt1', 'tt2'], tmdb_id: ['5'] })), null);
});

test('groupKeyFor: ids exactos antes que título', () => {
  assert.equal(groupKeyFor({ imdb_id: 'tt1' }, 'movie', 'X', 2020), 'movie|imdb:tt1');
  assert.equal(groupKeyFor({ anilist_id: 9 }, 'anime', 'X', null), 'anime|anilist:9');
  assert.equal(groupKeyFor({}, 'movie', 'The Matrix', 1999), titleKey('movie', 'Matrix', 1999));
});
