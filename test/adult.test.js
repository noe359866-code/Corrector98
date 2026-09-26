import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ADULT_KEYWORDS, buildAdultRegex, buildIlikePatterns, isAdultTitle } from '../src/parsers/adult.js';

const re = buildAdultRegex(DEFAULT_ADULT_KEYWORDS);

const adult = [
  'Some.Scene.XXX.1080p.MP4',
  'Pornhub.Compilation.2020',
  'Video Porno Casero',
  '[NSFW] Pack',
  'Hentai Collection Vol 3',
  'Brazzers.20.01.01.Scene',
  'Naughty.America.Scene.1080p',
  'OnlyFans SiteRip',
];
const safe = [
  'xXx.2002.1080p.BluRay',
  'XXX.State.of.the.Union.2005.1080p',
  'xXx Return of Xander Cage 2017',
  'Look At Me XXXTentacion 2022',
  'Hentai.Ouji.to.Warawanai.Neko.S01E01',
  'Sex Education S01E01',
  'Hardcore Henry 2015',
  'Javier y los Javis 2020', // "jav" solo se detecta como "jav uncensored/censored"
  'Expornstar Documentary',
];

for (const t of adult) test(`adulto: ${t}`, () => assert.equal(isAdultTitle(t, re), true));
for (const t of safe) test(`seguro: ${t}`, () => assert.equal(isAdultTitle(t, re), false));

test('keywords extra con ADULT_EXTRA_KEYWORDS', () => {
  const custom = buildAdultRegex([...DEFAULT_ADULT_KEYWORDS, 'mi palabra']);
  assert.equal(isAdultTitle('Algo.Mi.Palabra.2020', custom), true);
});

test('patrones ILIKE sin redundancias y con comodines en separadores', () => {
  const patterns = buildIlikePatterns(DEFAULT_ADULT_KEYWORDS);
  assert.ok(patterns.includes('%porn%'));
  assert.ok(!patterns.includes('%pornograf%')); // cubierto por %porn%
  assert.ok(patterns.includes('%naughty%america%'));
});

test('keywords: lista vacía no detecta nada y comodines solos se rechazan', () => {
  assert.equal(isAdultTitle('Una película', buildAdultRegex([])), false);
  for (const keyword of ['', '*', '***', '%', '...']) {
    assert.throws(() => buildAdultRegex([keyword]), /letras o números/);
    assert.throws(() => buildIlikePatterns([keyword]), /letras o números/);
  }
});

test('keywords: términos personalizados cortos también entran en el prefiltro', () => {
  assert.ok(buildIlikePatterns(['ab']).includes('%ab%'));
});

test('lista blanca no oculta otras señales adultas del mismo título', () => {
  assert.equal(isAdultTitle('xXx.2002.Brazzers.Scene', re), true);
  assert.equal(isAdultTitle('Hentai Ouji NSFW collection', re), true);
});
