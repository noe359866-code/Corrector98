import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/lib/db.js';
import { chunk } from '../src/lib/utils.js';
import { runDeadPurge } from '../src/steps/03-dead-purge.js';
import { runNormalize } from '../src/steps/04-normalize.js';
import { runSizeFilter } from '../src/steps/02-size-filter.js';

// Simula el contrato PostgREST, incluidos max_rows y mutaciones entre páginas.
function fixture({ rows = [], config = {}, cap = Infinity, intercept } = {}) {
  const state = { rows: structuredClone(rows), queries: [], audit: [] };
  const execute = (q) => {
    let selected = state.rows.filter((row) => q.filters.every(([op, key, value]) => {
      const a = key === 'id' ? BigInt(row[key]) : row[key];
      const b = key === 'id' && op !== 'in' ? BigInt(value) : value;
      if (op === 'in') return value.some((id) => String(id) === String(row[key]));
      if (op === 'eq') return a === b;
      if (op === 'is') return (a ?? null) === b;
      if (op === 'lt') return a < b;
      if (op === 'lte') return a <= b;
      if (op === 'gt') return a > b;
      throw new Error(`Filtro no soportado: ${op}`);
    }));
    if (q.op === 'delete') {
      const ids = new Set(selected.map((r) => r.id));
      state.rows = state.rows.filter((row) => !ids.has(row.id));
      return { error: null, count: selected.length };
    }
    if (q.op === 'update') {
      selected.forEach((row) => Object.assign(row, q.patch));
      return { error: null, count: selected.length };
    }
    if (q.head) return { count: selected.length, error: null };
    selected.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1) * (q.ascending ? 1 : -1));
    return { data: structuredClone(selected.slice(0, Math.min(cap, q.limitValue))), error: null };
  };
  const client = {
    from() {
      const q = {
        op: 'select', filters: [], limitValue: Infinity, ascending: true,
        select(columns, opts = {}) { this.columns = columns; Object.assign(this, opts); return this; },
        order(_, { ascending }) { this.ascending = ascending; return this; },
        limit(value) { this.limitValue = value; return this; },
        delete() { this.op = 'delete'; return this; },
        update(patch) { this.op = 'update'; this.patch = patch; return this; },
        then(resolve, reject) {
          state.queries.push(this);
          return Promise.resolve().then(() => intercept?.(this, state, execute) ?? execute(this)).then(resolve, reject);
        },
      };
      for (const op of ['eq', 'lt', 'lte', 'gt', 'in', 'is']) {
        q[op] = (key, value) => { q.filters.push([op, key, value]); return q; };
      }
      return q;
    },
  };
  const db = new Db({ table: 'torrents', applyConfirmation: 'APPLY:torrents', changeTicket: 'TEST-123', backupReference: 'backup-test', pageSize: 5, dryRun: false, deleteChunkSize: 2, maxDeleteRatio: 1, dbReadRetries: 0, updateConcurrency: 2, ...config }, client, { record: async (event, data) => { state.audit.push({ event, ...data }); } });
  db.initialRowCount = rows.length;
  return { db, state };
}

async function scanIds(db) {
  const ids = [];
  for await (const page of db.scan('id')) ids.push(...page.map((r) => r.id));
  return ids;
}
const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));

test('scan: continúa con páginas cortas por max_rows del servidor', async () => {
  const { db } = fixture({ rows: rows(7), cap: 2 });
  assert.deepEqual(await scanIds(db), [1, 2, 3, 4, 5, 6, 7]);
});

test('scan: límite inicial excluye inserciones nuevas y tolera borrados entre páginas', async () => {
  const { db, state } = fixture({ rows: rows(6), cap: 2 });
  const seen = [];
  for await (const page of db.scan('id')) {
    seen.push(...page.map((r) => r.id));
    state.rows = state.rows.filter((r) => !page.some((p) => p.id === r.id));
    state.rows.push({ id: 100 + seen.length });
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6]);
});

test('scan: bigint en string mantiene precisión', async () => {
  const input = ['9007199254740992', '9007199254740993', '9007199254740994'];
  const { db } = fixture({ rows: input.map((id) => ({ id })), cap: 1 });
  assert.deepEqual(await scanIds(db), input);
});

test('scan: rechaza bigint redondeados y cursores que no avanzan', async () => {
  const unsafe = fixture({ rows: [{ id: Number.MAX_SAFE_INTEGER + 1 }] });
  await assert.rejects(scanIds(unsafe.db), /precisión segura/);
  const stuck = fixture({ rows: rows(2), intercept(q) {
    if (q.ascending) return { data: [{ id: 1 }] };
  } });
  await assert.rejects(scanIds(stuck.db), /cursor/);
});

test('scan: una respuesta inválida o con error no se trata como fin de tabla', async () => {
  for (const response of [{ data: null }, { error: { message: 'permiso denegado' }, status: 403 }]) {
    const { db } = fixture({ rows: rows(2), intercept(q) { if (q.ascending) return response; } });
    await assert.rejects(scanIds(db), /inválida|permiso denegado/);
  }
});

test('scan: reintenta una lectura transitoria sin duplicar páginas', async () => {
  let failed = false;
  const { db, state } = fixture({ rows: rows(2), config: { dbReadRetries: 1 }, intercept(q) {
    if (q.ascending && !failed) { failed = true; return { error: { message: 'ocupado' }, status: 503 }; }
  } });
  assert.deepEqual(await scanIds(db), [1, 2]);
  assert.equal(state.queries.filter((q) => q.ascending && !q.filters.some(([op]) => op === 'gt')).length, 2);
});

test('scan: no reintenta errores permanentes', async () => {
  const { db, state } = fixture({ config: { dbReadRetries: 3 }, intercept() {
    return { error: { message: 'sin permisos' }, status: 403 };
  } });
  await assert.rejects(scanIds(db), /sin permisos/);
  assert.equal(state.queries.length, 1);
});

test('conteo: nunca usa estimaciones ni cero como sustituto de un error', async () => {
  const { db, state } = fixture({ intercept() { return { count: null, error: null }; } });
  await assert.rejects(db.countTotal(), /exacto no disponible/);
  assert.equal(state.queries.length, 1);
  assert.equal(state.queries[0].count, 'exact');
});

test('delete: verifica el presupuesto completo antes del primer lote', async () => {
  const { db, state } = fixture({ rows: rows(10), config: { maxDeleteRatio: 0.5 } });
  await assert.rejects(db.deleteByIds([1, 2, 3, 4, 5, 6], 'test'), /seguridad/);
  assert.equal(state.queries.length, 0);
  assert.equal(db.totalDeleted, 0);
});

test('delete: conteo inicial desconocido o cero no desactiva el freno', async () => {
  for (const initial of [null, undefined, NaN, 0]) {
    const { db, state } = fixture();
    db.initialRowCount = initial;
    await assert.rejects(db.deleteByIds([1], 'test'), /conteo inicial|seguridad/);
    assert.equal(state.queries.length, 0);
  }
});

test('delete: deduplica ids numéricos/string y rechaza ids inseguros', async () => {
  const { db } = fixture({ rows: rows(3) });
  assert.equal(await db.deleteByIds([1, '1', '01'], 'test'), 1);
  assert.equal(db.totalDeleted, 1);
  await assert.rejects(db.deleteByIds([Number.MAX_SAFE_INTEGER + 1], 'test'), /precisión segura/);
});

test('delete: cuenta lotes parciales y bloquea nuevos borrados tras un fallo', async () => {
  let writes = 0;
  const { db } = fixture({ rows: rows(8), intercept(q) {
    if (q.op === 'delete' && ++writes === 2) return { error: { message: 'timeout' }, status: 504 };
  } });
  await assert.rejects(db.deleteByIds([1, 2, 3, 4], 'test'), /2 confirmados/);
  assert.equal(db.totalDeleted, 2);
  await assert.rejects(db.deleteByIds([5], 'siguiente'), /bloqueados/);
  assert.equal(writes, 2);
});

test('delete: respuestas sin count bloquean el borrado; no se inventan éxitos', async () => {
  const { db } = fixture({ rows: rows(2), intercept(q) { if (q.op === 'delete') return { count: null }; } });
  await assert.rejects(db.deleteByIds([1], 'test'), /conteo de borrado/);
  assert.equal(db.totalDeleted, 0);
  assert.equal(db.deletionBlocked, true);
});

test('delete: solicitudes concurrentes no exceden el límite acumulado', async () => {
  const { db, state } = fixture({ rows: rows(6), config: { maxDeleteRatio: 0.5 } });
  const results = await Promise.allSettled([db.deleteByIds([1, 2], 'a'), db.deleteByIds([3, 4], 'b')]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected']);
  assert.equal(db.totalDeleted, 2);
  assert.equal(state.rows.length, 4);
});

test('dry-run: no escribe, no cuenta dos veces y omite filas borradas virtualmente', async () => {
  const { db, state } = fixture({ rows: rows(6), cap: 2, config: { dryRun: true } });
  assert.equal(await db.deleteByIds([1, 2], 'a'), 2);
  assert.equal(await db.deleteByIds(['2', 3], 'b'), 1);
  assert.deepEqual(await scanIds(db), [4, 5, 6]);
  assert.equal(db.totalDeleted, 3);
  assert.equal(state.queries.some((q) => q.op !== 'select'), false);
  assert.equal(state.rows.length, 6);
});

test('dead: revalida seeders y fecha al borrar; conserva torrents recuperados', async () => {
  const { db, state } = fixture({ rows: rows(3).map((r) => ({ ...r, seeders: 0, updated_at: '2000-01-01' })), intercept(q, state) {
    if (q.op === 'delete') {
      const alive = state.rows.find((r) => r.id === 1);
      if (alive) alive.seeders = 10;
      const fresh = state.rows.find((r) => r.id === 2);
      if (fresh) fresh.updated_at = '2999-01-01';
    }
  } });
  const result = await runDeadPurge(db, { deadAfterDays: 30 });
  assert.equal(result.deleted, 1);
  assert.deepEqual(state.rows.map((r) => r.id), [1, 2]);
});

test('size: revalida tipo y tamaño y mantiene películas mal tipadas como episodios', async () => {
  const input = rows(5).map((r) => ({ ...r, type: 'movie', title: 'A movie', size_bytes: 10 }));
  input[2].title = 'A show S01E02';
  input[3].size_bytes = 0;
  const { db, state } = fixture({ rows: input, intercept(q, state) {
    if (q.op === 'delete') {
      state.rows.find((r) => r.id === 1).size_bytes = 1000;
      state.rows.find((r) => r.id === 2).type = 'anime';
    }
  } });
  const result = await runSizeFilter(db, { minMovieBytes: 100, minSeriesBytes: 50, sizeFilterIncludeZero: false });
  assert.equal(result.deleted, 1);
  assert.equal(result.skippedMistyped, 1);
  assert.deepEqual(state.rows.map((r) => r.id), [1, 2, 3, 4]);
});

test('chunk: rechaza tamaños que provocarían bucles infinitos', () => {
  for (const size of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => chunk([1], size), /entero positivo/);
});

test('normalize: actualiza por página y respeta metadatos rellenados concurrentemente', async () => {
  const { db, state } = fixture({ rows: rows(3).map((r) => ({ ...r, title: 'Movie (2024) 1080p', type: 'movie', quality: 'Unknown' })), cap: 2, intercept(q, state) {
    if (q.op === 'update') state.rows[0].quality = '2160p';
    if (q.op === 'select' && q.filters.some(([op]) => op === 'gt')) {
      assert.equal(state.rows[1].quality, '1080p', 'la primera página debe escribirse antes de pedir otra');
    }
  } });
  const result = await runNormalize(db, { dryRun: false, fillMetadata: true, updateConcurrency: 2 });
  assert.equal(result.updated, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual(state.rows.map((r) => r.quality), ['2160p', '1080p', '1080p']);
});

test('updates: fallback individual conserva filtros y cuenta solo filas modificadas', async () => {
  let batches = 0;
  const { db, state } = fixture({ rows: rows(2).map((r) => ({ ...r, codec: null })), intercept(q, state) {
    if (q.op === 'update' && q.filters.some(([op]) => op === 'in')) {
      batches++;
      state.rows[0].codec = 'AV1';
      return { error: { message: 'conflicto del lote', code: '23505' } };
    }
  } });
  const result = await db.updateByIds({ codec: 'HEVC' }, [1, 2], 'test', (q) => q.is('codec', null));
  assert.deepEqual(result, { updated: 1, failed: 0 });
  assert.equal(batches, 1);
  assert.deepEqual(state.rows.map((r) => r.codec), ['AV1', 'HEVC']);
});

test('dry-run: todas las rutas de actualización evitan escrituras', async () => {
  const { db, state } = fixture({ rows: rows(1), config: { dryRun: true } });
  await db.updateMany([{ id: 1, patch: { codec: 'AV1' } }], 'test');
  await db.updateByIds({ codec: 'AV1' }, [1], 'test');
  await db.fillNullColumn([1], 'codec', 'AV1');
  assert.equal(state.queries.length, 0);
});

test('contrato Supabase real: paginación, timeout, count exacto y filtros de DELETE', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input);
    requests.push({ url, init });
    assert.ok(init.signal instanceof AbortSignal);
    const headers = { 'content-type': 'application/json' };
    if (init.method === 'HEAD') {
      headers['content-range'] = '*/3';
      return new Response(null, { headers });
    }
    if (init.method === 'DELETE') {
      assert.equal(url.searchParams.get('seeders'), 'eq.0');
      assert.equal(url.searchParams.get('id'), 'in.(1,2)');
      assert.match(new Headers(init.headers).get('prefer'), /count=exact/);
      headers['content-range'] = '*/2';
      return new Response(null, { status: 204, headers });
    }
    if (url.searchParams.get('order') === 'id.desc') return Response.json([{ id: 3 }]);
    const after = url.searchParams.getAll('id').find((filter) => filter.startsWith('gt.'));
    const id = after ? Number(after.slice(3)) + 1 : 1;
    assert.ok(url.searchParams.getAll('id').includes('lte.3'));
    return Response.json(id <= 3 ? [{ id }] : []);
  });
  const db = new Db({ supabaseUrl: 'https://example.supabase.co', supabaseKey: 'test-only', table: 'torrents', pageSize: 1000,
    dbTimeoutMs: 1000, dbReadRetries: 0, deleteChunkSize: 2, maxDeleteRatio: 1, dryRun: false,
    applyConfirmation: 'APPLY:torrents', changeTicket: 'TEST-123', backupReference: 'backup-test' }, null, { record: async () => {} });
  db.initialRowCount = await db.countTotal();
  assert.deepEqual(await scanIds(db), [1, 2, 3]);
  assert.equal(await db.deleteByIds([1, 2], 'contract', (q) => q.eq('seeders', 0)), 2);
  assert.equal(db.totalDeleted, 2);
  assert.equal(requests.filter(({ init }) => init.method === 'DELETE').length, 1);
});

test('gobierno: el límite absoluto se respeta aunque el porcentaje permita más', async () => {
  const { db, state } = fixture({ rows: rows(10), config: { maxDeleteRows: 2 } });
  await assert.rejects(db.deleteByIds([1, 2, 3], 'test'), /límite de 2/);
  assert.equal(state.queries.length, 0);
});

test('gobierno: no hay ninguna ruta de escritura sin autorización', async () => {
  const { db, state } = fixture({ rows: rows(3), config: { applyConfirmation: '' } });
  await assert.rejects(db.deleteByIds([1], 'test'), /APPLY_CONFIRMATION/);
  await assert.rejects(db.updateByIds({ codec: 'AV1' }, [1], 'test'), /APPLY_CONFIRMATION/);
  await assert.rejects(db.fillNullColumn([1], 'codec', 'AV1'), /APPLY_CONFIRMATION/);
  assert.equal((await db.updateMany([{ id: 1, patch: { codec: 'AV1' } }], 'test')).failed, 1);
  assert.equal(state.queries.length, 0);
});

test('auditoría: intención durable antes de mutar y recibo después', async () => {
  const { db, state } = fixture({ rows: rows(2), intercept(q, state) {
    if (q.op !== 'select') assert.equal(state.audit.at(-1).event, 'mutation.intent');
  } });
  await db.deleteByIds([1], 'test');
  await db.fillNullColumn([2], 'codec', 'AV1');
  const events = state.audit.filter((event) => event.event.startsWith('mutation.'));
  assert.deepEqual(events.map((event) => event.event), ['mutation.intent', 'mutation.result', 'mutation.intent', 'mutation.result']);
  assert.equal(events[0].operationId, events[1].operationId);
  assert.equal(events[1].outcome, 'confirmed');
  assert.equal(events[1].count, 1);
  assert.deepEqual(events[2].fields, ['codec']);
  assert.equal(JSON.stringify(events).includes('AV1'), false, 'el registro no almacena valores del patch');
});

test('auditoría: sin diario o con fallo al guardar intención no se toca la BD', async () => {
  for (const audit of [null, { record: async () => { throw new Error('disco lleno'); } }]) {
    const { db, state } = fixture({ rows: rows(2) });
    db.audit = audit;
    await assert.rejects(db.updateByIds({ codec: 'AV1' }, [1], 'test'));
    assert.equal(state.queries.length, 0);
  }
});

test('auditoría: fallo del recibo tras commit mantiene conteo y bloquea nuevas escrituras', async () => {
  const { db, state } = fixture({ rows: rows(3) });
  db.audit = { record: async (event) => { if (event === 'mutation.result') throw new Error('disco lleno'); } };
  await assert.rejects(db.deleteByIds([1], 'test'), /disco lleno/);
  assert.equal(db.totalDeleted, 1);
  assert.equal(db.writesBlocked, true);
  await assert.rejects(db.updateByIds({ codec: 'AV1' }, [2], 'test'), /bloqueadas/);
  assert.equal(state.queries.length, 1);
});

test('escrituras: error ambiguo de UPDATE no se reintenta ni permite DELETE', async () => {
  const { db, state } = fixture({ rows: rows(3), intercept(q) {
    if (q.op === 'update') return { error: { message: 'timeout' }, status: 504 };
  } });
  await assert.rejects(db.updateByIds({ codec: 'AV1' }, [1, 2], 'test'), /incierto/);
  await assert.rejects(db.deleteByIds([3], 'test'), /bloqueadas/);
  assert.equal(state.queries.length, 1);
  assert.equal(state.audit.find((event) => event.event === 'mutation.result').outcome, 'unknown');
});
