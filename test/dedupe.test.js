import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workKey, selectExcess } from '../src/steps/06-dedupe.js';

test('workKey: imdb/tmdb → (id, season, episode) como idx_torrents_stremio_imdb / idx_torrents_tmdb', () => {
  assert.equal(workKey({ imdb_id: 'tt1', tmdb_id: 5, season: 1, episode: 2 }), 'imdb:tt1|s1|e2');
  assert.equal(workKey({ tmdb_id: 5, type: 'movie' }), 'tmdb:movie:5|s-|e-');
  assert.equal(workKey({ tmdb_id: 5, type: 'series', season: 1, episode: 1 }), 'tmdb:tv:5|s1|e1');
});

test('workKey: anime → (id, episode, absolute_episode) sin season, como idx_torrents_kitsu/anilist/mal', () => {
  assert.equal(workKey({ anilist_id: 9, season: 1, episode: 1071, absolute_episode: 1071 }), 'anilist:9|e1071|a1071');
  assert.equal(workKey({ kitsu_id: 3, episode: 5 }), 'kitsu:3|e5|a-');
  assert.equal(workKey({ mal_id: 7, episode: 5 }), 'mal:7|e5|a-');
  // misma obra y episodio con distinta temporada almacenada → mismo grupo
  assert.equal(workKey({ kitsu_id: 3, season: 1, episode: 5 }), workKey({ kitsu_id: 3, season: null, episode: 5 }));
});

test('workKey: sin ningún id → null (nunca se deduplica)', () => {
  assert.equal(workKey({ title: 'sin ids' }), null);
});

const e = (id, seeders, lang, hash = `h${id}`, size = 1000) => ({ id, seeders, lang, hash, size });

test('selectExcess: conserva top 2 español + top 2 inglés por seeders', () => {
  const entries = [
    e(1, 10, 'spanish'), e(2, 50, 'spanish'), e(3, 30, 'spanish'), e(4, 5, 'spanish'),
    e(5, 100, 'english'), e(6, 1, 'english'), e(7, 70, 'english'),
  ];
  const { keep, remove } = selectExcess(entries, { keep: 2 });
  assert.deepEqual(keep.map((x) => x.id).sort(), [2, 3, 5, 7]);
  assert.deepEqual(remove.map((x) => x.id).sort(), [1, 4, 6]);
  assert.ok(remove.every((r) => r.reason.startsWith('excess_')));
});

test('selectExcess: grupos pequeños no pierden nada', () => {
  const { remove } = selectExcess([e(1, 1, 'spanish'), e(2, 1, 'english')], { keep: 2 });
  assert.equal(remove.length, 0);
});

test('selectExcess: info_hash duplicado se elimina (se queda el de más seeders)', () => {
  const { keep, remove } = selectExcess([e(1, 5, 'english', 'ABC'), e(2, 9, 'english', 'abc')], { keep: 2 });
  assert.deepEqual(keep.map((x) => x.id), [2]);
  assert.deepEqual(remove, [{ id: 1, reason: 'duplicate_hash' }]);
});

test('selectExcess: otros idiomas según política', () => {
  const entries = [e(1, 5, 'other'), e(2, 9, 'english')];
  assert.deepEqual(selectExcess(entries, { keep: 2, otherPolicy: 'delete' }).remove, [{ id: 1, reason: 'other_language' }]);
  assert.equal(selectExcess(entries, { keep: 2, otherPolicy: 'keep' }).remove.length, 0);
});

test('selectExcess: empate de seeders → gana el de mayor tamaño (determinista)', () => {
  const { keep } = selectExcess([e(1, 10, 'english', 'a', 100), e(2, 10, 'english', 'b', 900), e(3, 10, 'english', 'c', 500)], { keep: 2 });
  assert.deepEqual(keep.map((x) => x.id), [2, 3]);
});

test('selectExcess: empate de seeders → gana la mejor calidad antes que el tamaño', () => {
  const entries = [
    { id: 1, seeders: 10, lang: 'english', hash: 'a', size: 9000, qualityRank: 3 }, // 720p grande
    { id: 2, seeders: 10, lang: 'english', hash: 'b', size: 2000, qualityRank: 5 }, // 2160p
    { id: 3, seeders: 10, lang: 'english', hash: 'c', size: 4000, qualityRank: 4 }, // 1080p
  ];
  assert.deepEqual(selectExcess(entries, { keep: 2 }).keep.map((x) => x.id), [2, 3]);
});

test('selectExcess: seeders null cuentan como 0', () => {
  const { remove } = selectExcess([e(1, null, 'english'), e(2, 3, 'english'), e(3, 1, 'english')], { keep: 2 });
  assert.deepEqual(remove.map((r) => r.id), [1]);
});
