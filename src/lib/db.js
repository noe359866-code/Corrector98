/**
 * Capa de acceso a datos sobre @supabase/supabase-js.
 *
 * Decisiones de diseño:
 *  - Paginación KEYSET (WHERE id > último ORDER BY id) en lugar de OFFSET:
 *    es O(n) total, no se degrada en tablas grandes y es estable aunque se
 *    borren filas mientras se recorre la tabla.
 *  - Los DELETE se hacen por lotes de ids (`id IN (...)`) para no chocar con el
 *    statement_timeout de Supabase ni con el límite de longitud de URL.
 *  - Todo borrado pasa por `deleteByIds`, que respeta DRY_RUN y un tope de
 *    seguridad (MAX_DELETE_RATIO) para evitar vaciar la tabla por un bug.
 */

import { randomUUID } from 'node:crypto';
import { assertApplyAuthorized } from './policy.js';
import { createClient } from '@supabase/supabase-js';
import { chunk, mapPool, sleep } from './utils.js';
import { log } from './logger.js';

// Postgres bigint no se puede redondear: es preferible abortar a borrar otro id.
function idKey(id) {
  if ((typeof id === 'number' && Number.isSafeInteger(id)) ||
      (typeof id === 'string' && /^-?\d+$/.test(id))) return BigInt(id).toString();
  throw new Error(`ID inválido o fuera de la precisión segura: ${String(id)}`);
}

export class Db {
  constructor(config, client = null, audit = null) {
    this.config = config;
    this.audit = audit;
    this.writesBlocked = false;
    this.table = config.table;
    this.client = client ?? createClient(config.supabaseUrl, config.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (input, init = {}) => {
          const timeout = AbortSignal.timeout(config.dbTimeoutMs ?? 30_000);
          return fetch(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
        },
        headers: {
          'x-application-name': 'corrector98-maintenance',
          // Leída por el trigger de updated_at (sql/002_preserve_updated_at.sql) vía
          // current_setting('request.headers'): los cambios de mantenimiento no deben
          // "rejuvenecer" los torrents (el purgador de muertos depende de updated_at).
          ...(config.preserveUpdatedAt ? { 'x-preserve-updated-at': 'true' } : {}),
        },
      },
    });
    this.initialRowCount = null;
    this.totalDeleted = 0;
    this.simulatedDeleted = new Set();
    this.deleteQueue = Promise.resolve();
    this.deletionBlocked = false;
  }

  /** Query builder base sobre la tabla configurada. */
  from() {
    return this.client.from(this.table);
  }

  /** Única puerta para mutaciones: autorización + intención durable + recibo. */
  async write(makeQuery, { operation, ids, reason, fields = [] }) {
    assertApplyAuthorized(this.config);
    if (!this.audit || this.audit.failed || this.writesBlocked) {
      throw new Error('Escrituras bloqueadas: falta auditoría o hubo un fallo anterior');
    }
    const operationId = randomUUID();
    const details = { operationId, operation, table: this.table, ids: ids.map(idKey), reason, fields };
    try {
      await this.audit.record('mutation.intent', details);
      // Otra operación concurrente pudo fallar mientras se persistía la intención.
      if (this.writesBlocked || this.audit.failed) throw new Error('Escrituras bloqueadas');
      const result = await makeQuery();
      const validCount = Number.isSafeInteger(result.count) && result.count >= 0 && result.count <= ids.length;
      if (!result.error && !validCount) throw new Error('El servidor no devolvió un conteo de borrado/actualización válido');
      if (!result.error && operation === 'delete') this.totalDeleted += result.count;
      // Solo las violaciones SQL de integridad garantizan rollback y permiten
      // aislar filas del lote. Un timeout o error de transporte es ambiguo.
      if (result.error && !/^23[0-9A-Z]{3}$/.test(result.error.code ?? '')) this.writesBlocked = true;
      await this.audit.record('mutation.result', { operationId,
        outcome: result.error ? (this.writesBlocked ? 'unknown' : 'rejected') : 'confirmed',
        count: result.error ? null : result.count,
        errorCode: /^[0-9A-Z]{5}$/.test(result.error?.code ?? '') ? result.error.code : null });
      return result;
    } catch (error) {
      this.writesBlocked = true;
      // No se presume rollback: una intención sin recibo exige reconciliación.
      throw error;
    }
  }

  /** Solo reintentamos lecturas: un DELETE con timeout puede haberse confirmado. */
  async read(makeQuery) {
    const retries = this.config.dbReadRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      let result;
      try {
        result = await makeQuery();
      } catch (error) {
        result = { error: { message: error.message }, status: 0 };
      }
      const transient = result.error && (
        result.status === 0 || [408, 429, 500, 502, 503, 504].includes(result.status) ||
        ['57014', '40001', '40P01'].includes(result.error.code)
      );
      if (!transient || attempt >= retries) return result;
      const delay = Math.min(10_000, 500 * 2 ** attempt);
      log.debug(`Lectura ${this.table}: reintento ${attempt + 1} en ${delay} ms`);
      await sleep(delay);
    }
  }

  /** Cuenta filas exactamente. Un conteo desconocido nunca equivale a cero. */
  async count(applyFilters = (q) => q) {
    const { count, error } = await this.read(() => applyFilters(
      this.from().select('id', { count: 'exact', head: true }),
    ));
    if (error || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Error contando filas: ${error?.message ?? 'conteo exacto no disponible'}`);
    }
    return count;
  }

  /** Las estimaciones solo sirven para informes, nunca como presupuesto de borrado. */
  async safeCount(applyFilters = (q) => q) {
    for (const mode of ['exact', 'planned']) {
      const { count, error } = await this.read(() => applyFilters(this.from().select('id', { count: mode, head: true })));
      if (!error && Number.isSafeInteger(count) && count >= 0) return { count, mode };
    }
    return { count: null, mode: null };
  }

  async countTotal() {
    return this.count();
  }

  /**
   * Keyset acotado al id máximo inicial: las inserciones posteriores se dejan
   * para el próximo escaneo. Una página corta NO implica fin (max_rows de
   * PostgREST puede ser menor que PAGE_SIZE). Solo termina con página vacía.
   * No es una instantánea transaccional: otras columnas pueden cambiar.
   */
  async *scan(columns, applyFilters = (q) => q) {
    const { data: ceiling, error: ceilingError } = await this.read(() =>
      this.from().select('id').order('id', { ascending: false }).limit(1));
    if (ceilingError) throw new Error(`Error iniciando escaneo ${this.table}: ${ceilingError.message}`);
    if (!Array.isArray(ceiling)) throw new Error('Respuesta de escaneo inválida');
    if (!ceiling.length) return;
    const maxId = idKey(ceiling[0].id);
    let lastId = null;
    for (;;) {
      const { data, error } = await this.read(() => {
        let query = this.from().select(columns).order('id', { ascending: true })
          .limit(this.config.pageSize).lte('id', maxId);
        if (lastId !== null) query = query.gt('id', lastId);
        return applyFilters(query);
      });
      if (error) {
        const detail = error.message ?? 'error desconocido';
        const isStatementTimeout = error.code === '57014' || /statement timeout/i.test(detail);
        const hint = isStatementTimeout
          ? ' PostgreSQL alcanzó statement_timeout (no se corrige con DB_TIMEOUT_MS). Si es el escaneo adulto por ILIKE, comprueba/aplica sql/001_recommended_indexes.sql para los índices pg_trgm de title/title_text.'
          : '';
        throw new Error(`Error leyendo ${this.table}: ${detail}.${hint}`);
      }
      if (!Array.isArray(data)) throw new Error('Respuesta de escaneo inválida');
      if (!data.length) return;

      // Valida ANTES de entregar la página; evita bucles y bigint redondeados.
      for (const row of data) {
        const id = idKey(row.id);
        if ((lastId !== null && BigInt(id) <= BigInt(lastId)) || BigInt(id) > BigInt(maxId)) {
          throw new Error('El cursor del escaneo no avanza o excede el límite inicial');
        }
        lastId = id;
      }
      const visible = this.config.dryRun
        ? data.filter((row) => !this.simulatedDeleted.has(idKey(row.id)))
        : data;
      if (visible.length) yield visible;
    }
  }

  /** Serializa borrados para que llamadas concurrentes compartan el mismo tope. */
  deleteByIds(ids, reason, applyFilters = (q) => q) {
    const task = this.deleteQueue.then(() => this.deleteIds(ids, reason, applyFilters));
    this.deleteQueue = task.catch(() => {});
    return task;
  }

  /**
   * Valida todo el plan antes del primer lote. Cada lote confirmado se suma
   * inmediatamente. Ante un error de escritura se bloquean los siguientes
   * borrados: la respuesta fallida podría ocultar un commit ya realizado.
   * applyFilters revalida las condiciones en el propio DELETE (muertos/tamaño).
   */
  async deleteIds(ids, reason, applyFilters) {
    const unique = [...new Set(ids.map(idKey))]
      .filter((id) => !this.simulatedDeleted.has(id));
    if (!unique.length) return 0;
    if (this.deletionBlocked) throw new Error(`[${reason}] Borrados bloqueados tras un error anterior.`);
    const initial = this.initialRowCount;
    const limit = this.config.maxDeleteRatio;
    if (!Number.isSafeInteger(initial) || initial < 0 || !(limit > 0 && limit <= 1)) {
      throw new Error(`[${reason}] Se requiere un conteo inicial exacto y un límite válido antes de borrar.`);
    }
    const absoluteLimit = this.config.maxDeleteRows ?? 1000;
    if (!Number.isSafeInteger(absoluteLimit) || absoluteLimit < 1) throw new Error('MAX_DELETE_ROWS inválido');
    const budget = Math.min(Math.floor(initial * limit), absoluteLimit);
    await this.audit?.record('delete.plan', { reason, candidates: unique.length, budget, alreadyDeleted: this.totalDeleted,
      allowed: this.totalDeleted + unique.length <= budget });
    if (this.totalDeleted + unique.length > budget) {
      throw new Error(
        `[${reason}] Abortado por seguridad: ${this.totalDeleted + unique.length} filas superarían ` +
        `el límite de ${budget} (MAX_DELETE_RATIO=${limit}). Revisa con DRY_RUN=true.`,
      );
    }
    if (this.config.dryRun) {
      log.info(`  [dry-run] ${reason}: se borrarían ${unique.length} filas`);
      unique.forEach((id) => this.simulatedDeleted.add(id));
      this.totalDeleted += unique.length;
      return unique.length;
    }

    let deleted = 0;
    for (const batch of chunk(unique, this.config.deleteChunkSize)) {
      try {
        const { error, count } = await this.write(
          () => applyFilters(this.from().delete({ count: 'exact' }).in('id', batch)),
          { operation: 'delete', ids: batch, reason },
        );
        if (error) throw new Error(error.message);
        if (!Number.isSafeInteger(count) || count < 0 || count > batch.length) {
          throw new Error('El servidor no devolvió un conteo de borrado válido');
        }
        deleted += count;
      } catch (error) {
        this.deletionBlocked = true;
        throw new Error(`[${reason}] Error borrando lote (${deleted} confirmados): ${error.message}. Borrados posteriores bloqueados.`);
      }
    }
    return deleted;
  }

  /**
   * Aplica actualizaciones individuales `{ id, patch }` con concurrencia limitada.
   * Los errores por fila (p. ej. violación de UNIQUE) se registran y no detienen el proceso.
   * @returns {Promise<{updated:number, failed:number}>}
   */
  async updateMany(updates, reason, applyFilters = (q) => q) {
    if (updates.length === 0) return { updated: 0, failed: 0 };
    if (this.config.dryRun) {
      log.info(`  [dry-run] ${reason}: se actualizarían ${updates.length} filas`);
      return { updated: updates.length, failed: 0 };
    }

    let updated = 0;
    let failed = 0;
    await mapPool(updates, this.config.updateConcurrency, async ({ id, patch }) => {
      try {
        const { error, count } = await this.write(
          () => applyFilters(this.from().update(patch, { count: 'exact' }).eq('id', id)),
          { operation: 'update', ids: [id], reason, fields: Object.keys(patch) },
        );
        if (error) throw new Error(error.message);
        if (!Number.isSafeInteger(count) || count < 0 || count > 1) throw new Error('Conteo de actualización inválido');
        updated += count;
      } catch (error) {
        failed++;
        log.debug(`[${reason}] id=${id} no actualizado: ${error.message}`);
      }
    });
    if (failed) log.warn(`[${reason}] ${failed} filas no se pudieron actualizar (ver DEBUG=1).`);
    return { updated, failed };
  }

  /**
   * Aplica el MISMO patch a muchas filas con `UPDATE ... WHERE id IN (...)` por lotes.
   * Si un lote falla (p. ej. una fila viola un UNIQUE), se reintenta fila a fila
   * para aislar el problema sin perder el resto del lote.
   * @returns {Promise<{updated:number, failed:number}>}
   */
  async updateByIds(patch, ids, reason, applyFilters = (q) => q) {
    if (!ids.length) return { updated: 0, failed: 0 };
    if (this.config.dryRun) return { updated: ids.length, failed: 0 };

    let updated = 0;
    let failed = 0;
    for (const batch of chunk(ids, this.config.deleteChunkSize)) {
      const { error, count } = await this.write(
        () => applyFilters(this.from().update(patch, { count: 'exact' }).in('id', batch)),
        { operation: 'update', ids: batch, reason, fields: Object.keys(patch) },
      );
      if (!error) {
        if (Number.isSafeInteger(count) && count >= 0 && count <= batch.length) updated += count;
        else failed += batch.length;
        continue;
      }
      if (this.writesBlocked) throw new Error(`[${reason}] Escritura fallida con resultado incierto; ejecución detenida`);
      log.debug(`[${reason}] lote fallido (${error.message}); reintentando fila a fila`);
      const res = await this.updateMany(batch.map((id) => ({ id, patch })), reason, applyFilters);
      updated += res.updated;
      failed += res.failed;
    }
    return { updated, failed };
  }

  /**
   * Rellena `column = value` SOLO en las filas de `ids` donde la columna es NULL
   * (nunca sobrescribe datos existentes). Una query por lote.
   */
  async fillNullColumn(ids, column, value) {
    if (!ids.length || value === null || value === undefined) return 0;
    if (this.config.dryRun) return ids.length;
    let total = 0;
    for (const batch of chunk(ids, this.config.deleteChunkSize)) {
      const { error, count } = await this.write(
        () => this.from().update({ [column]: value }, { count: 'exact' }).in('id', batch).is(column, null),
        { operation: 'update', ids: batch, reason: 'enrich-fill', fields: [column] },
      );
      if (error) {
        throw new Error(`fillNullColumn(${column}) falló; no se marcará la obra como completada.`);
      }
      total += count ?? 0;
    }
    return total;
  }
}
