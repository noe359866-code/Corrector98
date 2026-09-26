import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTitle, computeNormalization } from '../src/parsers/title-parser.js';

const cases = [
  // [título, {campos esperados}]
  ['Breaking.Bad.S02E09.1080p.BluRay.x264-DEMAND', { type: 'series', season: 2, episode: 9, isPack: false }],
  ['Friends 2x09 HDTV', { type: 'series', season: 2, episode: 9 }],
  ['The Office US S05E01E02 720p', { type: 'series', season: 5, episode: null, isPack: true }],
  ['Game of Thrones S08E01-E06 2160p', { type: 'series', season: 8, episode: null, isPack: true }],
  ['La Casa de Papel [HDTV 720p][Cap.209][AC3 5.1 Castellano]', { type: 'series', season: 2, episode: 9 }],
  ['Serie [HDTV][Cap.1012][Español Castellano]', { type: 'series', season: 10, episode: 12 }],
  ['Merlí [HDTV][Cap.101_110][Castellano]', { type: 'series', season: 1, episode: null, isPack: true }],
  ['Narcos Temporada 2 [720p]', { type: 'series', season: 2, episode: null, isPack: true }],
  ['The Wire Season 3 Complete 720p', { type: 'series', season: 3, isPack: true }],
  ['Breaking Bad S01-S05 Complete 1080p', { type: 'series', isMultiSeason: true, season: null }],
  ['Arcane Temporada 2 Capitulo 5 1080p', { type: 'series', season: 2, episode: 5 }],
  ['[SubsPlease] Sousou no Frieren - 09 (1080p) [ABCD1234].mkv', { type: 'anime', confidence: 'high', season: null, episode: 9, absoluteEpisode: 9 }],
  ['[Erai-raws] Mushoku Tensei S2 - 09 [1080p][Multiple Subtitle]', { type: 'anime', season: 2, episode: 9, isMultiSeason: false }],
  ['[Judas] Kimetsu no Yaiba 2nd Season - 05 [1080p]', { type: 'anime', season: 2, episode: 5 }],
  ['[Erai-raws] One Piece - 1071 [1080p][ABCDEF12]', { type: 'anime', episode: 1071, absoluteEpisode: 1071 }],
  ['[SomeGroup] Chainsaw Man - 12 END [1080p]', { type: 'anime', confidence: 'medium', episode: 12 }],
  ['[Tsundere-Raws] Bocchi the Rock! (BD 1080p) [Batch]', { type: 'anime', confidence: 'high', episode: null }],
  ['The.Matrix.1999.1080p.BluRay.x264-GROUP', { type: 'movie', confidence: 'low', season: null, episode: null }],
  ['Blade Runner 2049 (2017) 1080p', { type: 'movie', year: 2017 }],
  ['Star Wars Episode 1 The Phantom Menace (1999) 1080p', { type: 'movie', episode: null }],
  ['Toy Story 4 - 2019 1080p', { type: 'movie', episode: null }],
  ['Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.H.265', { type: 'movie', episode: null }],
  ['Movie.2020.1920x1080.x264', { type: 'movie', season: null, episode: null }],
];

for (const [title, expected] of cases) {
  test(`parseTitle: ${title}`, () => {
    const parsed = parseTitle(title);
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(parsed[key], value, `${key} → esperado ${value}, obtenido ${parsed[key]}`);
    }
  });
}

test('parseTitle tolera entradas vacías', () => {
  assert.equal(parseTitle(null).type, null);
  assert.equal(parseTitle('').type, null);
});

// ---------------------------------------------------------------------------
// computeNormalization
// ---------------------------------------------------------------------------
test('normaliza: película mal tipada que es un episodio → series + S/E', () => {
  const patch = computeNormalization({ title: 'Show.S02E09.720p', type: 'movie', season: null, episode: null });
  assert.deepEqual(patch, { type: 'series', season: 2, episode: 9 });
});

test('normaliza: grupo de anime conocido → anime + temporada 1 + absoluto', () => {
  const patch = computeNormalization({ title: '[SubsPlease] Frieren - 09 (1080p)', type: 'series', season: null, episode: null, absolute_episode: null });
  assert.deepEqual(patch, { type: 'anime', episode: 9, season: 1, absolute_episode: 9 });
});

test('normaliza: corrige temporada/episodio erróneos', () => {
  const patch = computeNormalization({ title: 'Show S03E04 1080p', type: 'series', season: 1, episode: 1 });
  assert.deepEqual(patch, { season: 3, episode: 4 });
});

test('normaliza: no degrada anime a series aunque use SxxEyy', () => {
  const patch = computeNormalization({ title: 'Attack on Titan S04E01 1080p', type: 'anime', season: 4, episode: 1 });
  assert.equal(patch, null);
});

test('normaliza: en packs NO toca el episodio (mapeo por archivo)', () => {
  const patch = computeNormalization({ title: 'Show S02 1080p WEB-DL', type: 'series', season: 2, episode: 7 });
  assert.equal(patch, null);
  const patch2 = computeNormalization({ title: 'Show S02E01-E10 1080p', type: 'series', season: 2, episode: 7 });
  assert.equal(patch2, null);
});

test('normaliza: pack de temporada corrige la temporada si difiere', () => {
  const patch = computeNormalization({ title: 'Show S02 1080p WEB-DL', type: 'series', season: 1, episode: 7 });
  assert.deepEqual(patch, { season: 2 });
});

test('normaliza: multi-temporada no toca season/episode', () => {
  const patch = computeNormalization({ title: 'Breaking Bad S01-S05 1080p', type: 'series', season: 3, episode: 2 });
  assert.equal(patch, null);
});

test('normaliza: película con season/episode basura → null', () => {
  const patch = computeNormalization({ title: 'The Matrix 1999 1080p', type: 'movie', season: 1, episode: 1 });
  assert.deepEqual(patch, { season: null, episode: null });
});

test('normaliza: película correcta → sin cambios', () => {
  assert.equal(computeNormalization({ title: 'The Matrix 1999 1080p', type: 'movie', season: null, episode: null }), null);
});

test('normaliza: episodio con ids de anime → anime (no series)', () => {
  const patch = computeNormalization({ title: 'Frieren S01E09 1080p', type: 'movie', season: null, episode: null, kitsu_id: 123 });
  assert.equal(patch.type, 'anime');
});
