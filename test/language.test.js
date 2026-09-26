import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLanguage } from '../src/parsers/language.js';

const cases = [
  [{ title: 'Pelicula [BluRay 1080p][Castellano]' }, 'spanish'],
  [{ title: 'Pelicula 2020 1080p Latino' }, 'spanish'],
  [{ title: 'Serie S01E01 VOSE 1080p' }, 'spanish'],
  [{ title: 'Serie S01E01 Subtitulado' }, 'spanish'],
  [{ title: 'Movie.2020.1080p.DUAL.ESP-ENG' }, 'spanish'],
  [{ title: 'Serie [HDTV][Cap.101][www.DivxTotaL.com]' }, 'spanish'],
  [{ title: 'Movie 2020 1080p', audio: ['spa', 'eng'] }, 'spanish'],
  [{ title: 'Movie 2020 1080p', audio: ['eng'], subtitles: ['es'] }, 'spanish'], // subtitulado
  [{ title: 'Movie 2020 1080p', audio: '{es-419}' }, 'spanish'], // array Postgres como string
  [{ title: 'Movie.2020.1080p.BluRay.x264-GROUP' }, 'english'], // sin marcas → escena en inglés
  [{ title: '[SubsPlease] Frieren - 09 (1080p)' }, 'english'],
  [{ title: 'Movie 2020 1080p', audio: ['jpn'], subtitles: ['eng'] }, 'english'],
  [{ title: 'Movie 2020 MULTi 1080p' }, 'english'],
  [{ title: 'Cast Away 2000 1080p' }, 'english'], // "cast" no es "castellano"
  [{ title: 'La casa en llamas 2020 1080p' }, 'english'], // "en" no es marca de inglés; sin marcas
  [{ title: 'Film 2020 FRENCH 1080p' }, 'other'],
  [{ title: 'Anime - 01 VOSTFR' }, 'other'],
  [{ title: 'Filme 2020 Dublado' }, 'other'],
  [{ title: 'Movie 2020 1080p', audio: ['rus'] }, 'other'],
  [{ title: 'Movie 2020 1080p', audio: ['rus', 'eng'] }, 'english'],
  // Regresión: si `audio` guarda CÓDECS en vez de idiomas, no debe clasificarse como 'other'
  // (con DEDUPE_OTHER_LANGUAGES=delete eso borraría torrents válidos).
  [{ title: 'Movie.2020.1080p.BluRay.x264-GRP', audio: ['AAC', 'DTS-HD MA', 'AC3'] }, 'english'],
  [{ title: 'Pelicula 2020 [Castellano]', audio: ['AC3', 'DTS'] }, 'spanish'],
  [{ title: 'Movie 2020', audio: ['Atmos', '7.1'], subtitles: [] }, 'english'],
  [{ title: 'Movie 2020', audio: [], subtitles: [] }, 'english'], // DEFAULT '{}' de la tabla
];

for (const [input, expected] of cases) {
  test(`classifyLanguage: ${input.title} ${input.audio ? JSON.stringify(input.audio) : ''} → ${expected}`, () => {
    assert.equal(classifyLanguage(input), expected);
  });
}
