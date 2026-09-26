import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTitleForSearch, similarity } from '../src/parsers/title-cleaner.js';

const cases = [
  ['[SubsPlease] Sousou no Frieren - 09 (1080p) [ABCD1234].mkv', 'Sousou no Frieren', null],
  ['The.Matrix.1999.1080p.BluRay.x264-GROUP', 'The Matrix', 1999],
  ['1917.2019.2160p.UHD.BluRay.x265', '1917', 2019],
  ['Blade Runner 2049 (2017) 1080p', 'Blade Runner 2049', 2017],
  ['Blade.Runner.2049.2017.1080p.BluRay', 'Blade Runner 2049', 2017],
  ['La Casa de Papel [HDTV 720p][Cap.209][AC3 5.1 Castellano]', 'La Casa de Papel', null],
  ['Breaking.Bad.S02E09.1080p.BluRay.x264-DEMAND', 'Breaking Bad', null],
  ['The Office US S05E01E02 720p WEB-DL', 'The Office US', null],
  ['[Erai-raws] Mushoku Tensei S2 - 09 [1080p]', 'Mushoku Tensei', null],
  ['[Judas] Kimetsu no Yaiba 2nd Season - 05 [1080p]', 'Kimetsu no Yaiba', null],
  ['Star Wars Episode 1 The Phantom Menace (1999) 1080p', 'Star Wars Episode 1 The Phantom Menace', 1999],
  ['Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.H.265', 'Dune Part Two', 2024],
  ['www.DivxTotaL.com - Peli Buena (2015) [BluRay 1080p]', 'Peli Buena', 2015],
  ['Narcos Temporada 2 [720p]', 'Narcos', null],
];

for (const [title, query, year] of cases) {
  test(`cleanTitleForSearch: ${title}`, () => {
    const res = cleanTitleForSearch(title);
    assert.equal(res.query, query);
    assert.equal(res.year, year);
  });
}

test('similarity: iguales ignorando artículos, tildes y puntuación', () => {
  assert.equal(similarity('The Matrix', 'Matrix'), 1);
  assert.equal(similarity('Pokémon: Detective Pikachu', 'Pokemon Detective Pikachu'), 1);
});

test('similarity: títulos parecidos puntúan alto, distintos bajo', () => {
  assert.ok(similarity('Sousou no Frieren', 'Frieren: Sousou no Frieren') > 0.72);
  assert.ok(similarity('Breaking Bad', 'Better Call Saul') < 0.3);
  assert.ok(similarity('Star Wars', 'Star Wars: Episode I - The Phantom Menace') < 0.72);
});
