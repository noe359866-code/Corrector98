import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('ENRICH_MAX_TITLES: sin límite por defecto o con 0, tope positivo y rechazo de negativos', () => {
  const original = { ...process.env };
  try {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';
    delete process.env.ENRICH_MAX_TITLES;
    assert.equal(loadConfig().enrichMaxTitles, 0);
    process.env.ENRICH_MAX_TITLES = '0';
    assert.equal(loadConfig().enrichMaxTitles, 0);
    process.env.ENRICH_MAX_TITLES = '400';
    assert.equal(loadConfig().enrichMaxTitles, 400);
    process.env.ENRICH_MAX_TITLES = '-1';
    assert.throws(() => loadConfig(), /ENRICH_MAX_TITLES/);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) delete process.env[key];
    }
    Object.assign(process.env, original);
  }
});
