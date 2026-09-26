import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuditLog } from '../src/lib/audit.js';
import { runPipeline } from '../src/lib/pipeline.js';
import { redact } from '../src/lib/logger.js';

async function auditFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'corrector-audit-'));
  const audit = await AuditLog.open(directory);
  t.after(async () => { await audit.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return audit;
}

test('auditoría: JSONL versionado, secuencial y ordenado con llamadas concurrentes', async (t) => {
  const audit = await auditFixture(t);
  await Promise.all(Array.from({ length: 20 }, (_, i) => audit.record('test', { index: i })));
  const entries = (await fs.readFile(audit.file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(entries.length, 20);
  assert.deepEqual(entries.map((e) => e.sequence), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.ok(entries.every((e) => e.schemaVersion === 1 && e.runId === audit.runId && e.timestamp));
  assert.equal((await fs.stat(audit.file)).mode & 0o777, 0o600);
});

test('auditoría: un fallo de fsync es persistente y no permite continuar', async () => {
  let writes = 0;
  const audit = new AuditLog({ writeFile: async () => { writes++; }, sync: async () => { throw new Error('disco lleno'); } }, 'test');
  await assert.rejects(audit.record('first'), /auditoría/);
  await assert.rejects(audit.record('second'), /bloqueada/);
  assert.equal(audit.failed, true);
  assert.equal(writes, 1);
});

test('redacción: elimina secretos conocidos, claves en URLs y bearer tokens', (t) => {
  const previous = process.env.TMDB_API_KEY;
  process.env.TMDB_API_KEY = 'secret-test-value';
  t.after(() => { if (previous === undefined) delete process.env.TMDB_API_KEY; else process.env.TMDB_API_KEY = previous; });
  const text = redact('error secret-test-value https://example.com?api_key=unknown-secret&query=movie Bearer abc.def.ghi');
  assert.equal(text.includes('secret-test-value'), false);
  assert.equal(text.includes('unknown-secret'), false);
  assert.equal(text.includes('abc.def.ghi'), false);
  assert.ok(text.includes('query=movie'));
});

test('auditoría: la redacción conserva JSON válido', async (t) => {
  const audit = await auditFixture(t);
  const previous = process.env.TEST_SECRET;
  process.env.TEST_SECRET = 'sensitive-"value';
  t.after(() => { if (previous === undefined) delete process.env.TEST_SECRET; else process.env.TEST_SECRET = previous; });
  await audit.record('test', { reference: process.env.TEST_SECRET });
  const entry = JSON.parse(await fs.readFile(audit.file, 'utf8'));
  assert.equal(entry.reference, '[REDACTED]');
});

for (const failure of ['throw', 'failed', 'errors', 'audit']) {
  test(`pipeline: fallo ${failure} impide ejecutar pasos dependientes`, async () => {
    const called = [];
    const db = { writesBlocked: false };
    const pipeline = [
      { id: 'normalize', title: 'Normalizar', run: async () => {
        called.push('normalize');
        if (failure === 'throw') throw new Error('fallo');
        return { [failure]: 1 };
      } },
      { id: 'dedupe', title: 'Deduplicar', run: async () => { called.push('dedupe'); return {}; } },
    ];
    const audit = { record: async () => { if (failure === 'audit') throw new Error('disco lleno'); } };
    const results = await runPipeline(pipeline, { steps: ['normalize', 'dedupe'] }, db, audit);
    assert.deepEqual(called, failure === 'audit' ? [] : ['normalize']);
    assert.equal(results[0].status, '❌');
    assert.equal(results[1].status, '⛔ bloqueado');
    assert.equal(db.writesBlocked, true);
  });
}

test('pipeline: omitir un paso no bloquea los siguientes; registra métricas', async () => {
  const events = [];
  const audit = { record: async (event, data) => { events.push({ event, ...data }); } };
  const results = await runPipeline([
    { id: 'adult', title: 'Adult', run: async () => { throw new Error('no debe ejecutarse'); } },
    { id: 'dead', title: 'Dead', run: async () => ({ deleted: 3 }) },
  ], { steps: ['dead'] }, { writesBlocked: false }, audit);
  assert.deepEqual(results.map((r) => r.status), ['⏭️ omitido', '✅']);
  assert.equal(events.at(-1).metrics.deleted, 3);
});

test('concurrencia: drena escrituras en vuelo y no inicia más trabajo tras un fallo', async () => {
  const { mapPool } = await import('../src/lib/utils.js');
  const { setImmediate: tick } = await import('node:timers/promises');
  let release;
  const inFlight = new Promise((resolve) => { release = resolve; });
  const started = [];
  let settled = false;
  const pending = mapPool([0, 1, 2, 3], 2, async (item) => {
    started.push(item);
    if (item === 0) throw new Error('falló la primera escritura');
    await inFlight;
  });
  pending.catch(() => { settled = true; });
  await tick();
  assert.deepEqual(started, [0, 1]);
  assert.equal(settled, false, 'no cerrar el paso con escrituras pendientes');
  release();
  await assert.rejects(pending, /primera escritura/);
  assert.deepEqual(started, [0, 1]);
});

test('concurrencia: conserva orden de resultados y valida límites', async () => {
  const { mapPool } = await import('../src/lib/utils.js');
  assert.deepEqual(await mapPool([1, 2, 3], 2, async (n) => n * 2), [2, 4, 6]);
  assert.deepEqual(await mapPool([], 2, async () => {}), []);
  await assert.rejects(mapPool([1], 0, async () => {}), /concurrencia/);
});
