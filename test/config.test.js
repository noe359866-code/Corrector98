import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('ENRICH_MAX_TITLES: sin límite por defecto o con 0, tope positivo y rechazo de negativos', () => {
  const original = { ...process.env };
  try {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';
    process.env.SUPABASE_READ_KEY = 'read-only-test';
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

function withEnv(values, fn) {
  const original = { ...process.env };
  try {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';
    process.env.SUPABASE_READ_KEY = 'read-only-test';
    process.env.APPLY_CONFIRMATION = 'APPLY:torrents';
    process.env.CHANGE_TICKET = 'TEST-123';
    process.env.BACKUP_REFERENCE = 'backup-test';
    process.env.STEPS = 'dead';
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  }
}

test('DRY_RUN: simulación por defecto y booleanos estrictos', () => {
  withEnv({ DRY_RUN: undefined }, () => assert.equal(loadConfig().dryRun, true));
  for (const value of ['true', '1', 'yes', ' sí ', 'on']) {
    withEnv({ DRY_RUN: value }, () => assert.equal(loadConfig().dryRun, true));
  }
  for (const value of ['false', '0', 'no', 'off']) {
    withEnv({ DRY_RUN: value }, () => assert.equal(loadConfig().dryRun, false));
  }
  withEnv({ DRY_RUN: 'tru' }, () => assert.throws(() => loadConfig(), /DRY_RUN/));
});

test('config: enteros estrictos (sin sufijos, decimales ni pérdida de precisión)', () => {
  for (const value of ['20ms', '1.5', '1e3', ' ', '9007199254740993']) {
    withEnv({ PAGE_SIZE: value }, () => assert.throws(() => loadConfig(), /PAGE_SIZE/));
  }
});

test('config: rechaza rangos peligrosos antes de conectar', () => {
  const invalid = {
    PAGE_SIZE: ['0', '-1', '10001'], DELETE_CHUNK_SIZE: ['0', '201'],
    UPDATE_CONCURRENCY: ['0', '65'], DB_TIMEOUT_MS: ['0'], DB_READ_RETRIES: ['-1', '11'],
    MIN_MOVIE_MB: ['-1'], MIN_SERIES_MB: ['-1'], DEAD_AFTER_DAYS: ['0', '-1'],
    DEDUPE_KEEP_PER_LANGUAGE: ['0', '-2'], ENRICH_MIN_SEEDERS: ['-1'],
    ENRICH_RETRY_BASE_HOURS: ['0'], ENRICH_RETRY_MAX_DAYS: ['0'], ENRICH_MAX_MINUTES: ['0'],
    ANILIST_RPM: ['0'], KITSU_RPM: ['-1'], TMDB_RPM: ['0'],
    MAX_DELETE_RATIO: ['0', '1.1', 'NaN'], MATCH_THRESHOLD: ['0', '1.1', 'NaN', 'Infinity'],
  };
  for (const [name, values] of Object.entries(invalid)) {
    for (const value of values) withEnv({ [name]: value }, () => assert.throws(() => loadConfig(), new RegExp(name)));
  }
});

test('operación: faltan confirmación, ticket o respaldo -> no se autoriza aplicar', () => {
  for (const [key, value] of [['APPLY_CONFIRMATION', undefined], ['APPLY_CONFIRMATION', 'APPLY:otra_tabla'],
    ['CHANGE_TICKET', undefined], ['BACKUP_REFERENCE', undefined], ['BACKUP_REFERENCE', 'una\nlinea']]) {
    withEnv({ DRY_RUN: 'false', [key]: value }, () => assert.throws(() => loadConfig(), new RegExp(key)));
  }
});

test('operación: credenciales separadas sin fallback a service-role en simulación', () => {
  withEnv({ DRY_RUN: 'true', SUPABASE_READ_KEY: undefined }, () => assert.throws(() => loadConfig(), /SUPABASE_READ_KEY/));
  withEnv({ DRY_RUN: 'true' }, () => assert.equal(loadConfig().supabaseKey, 'read-only-test'));
  withEnv({ DRY_RUN: 'false', SUPABASE_SERVICE_ROLE_KEY: undefined }, () => assert.throws(() => loadConfig(), /SUPABASE_SERVICE_ROLE_KEY/));
});

test('operación: valores conservadores y validación de destino/tope absoluto', () => {
  withEnv({ MAX_DELETE_RATIO: undefined, MAX_DELETE_ROWS: undefined, DEDUPE_OTHER_LANGUAGES: undefined }, () => {
    assert.equal(loadConfig().maxDeleteRatio, 0.1);
    assert.equal(loadConfig().maxDeleteRows, 1000);
    assert.equal(loadConfig().dedupeOtherLanguages, 'keep');
  });
  for (const value of ['0', '-1', '1.5']) withEnv({ MAX_DELETE_ROWS: value }, () => assert.throws(() => loadConfig(), /MAX_DELETE_ROWS/));
  withEnv({ TORRENTS_TABLE: 'torrents; DROP' }, () => assert.throws(() => loadConfig(), /TORRENTS_TABLE/));
  for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com?key=secret']) {
    withEnv({ SUPABASE_URL: url }, () => assert.throws(() => loadConfig(), /HTTPS/));
  }
});

test('operación: aplicar requiere pasos explícitos y no vacíos', () => {
  for (const steps of [undefined, '', ' ', ',,']) {
    withEnv({ DRY_RUN: 'false', STEPS: steps }, () => assert.throws(() => loadConfig(), /STEPS/));
  }
});
