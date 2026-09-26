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

import { createClient } from '@supabase/supabase-js';
import { chunk, mapPool } from './utils.js';
import { log } from './logger.js';

export class Db {
  constructor(config) {
    this.config = config;
    this.table = config.table;
    this.client = createClient(config.supabaseUrl, config.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
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
  }

  /** Query builder base sobre la tabla configurada. */
  from() {
    return this.client.from(this.table);
  }

  /** Cuenta filas (opcionalmente filtradas) sin descargar datos. */
  async count(applyFilters = (q) => q) {
    const { count, error } = await applyFilters(
      this.from().select('id', { count: 'exact', head: true }),
    );
    if (error) throw new Error(`Error contando filas: ${error.message}`);
    return count ?? 0;
  }

  /** Conteo que nunca lanza: exacto y, si hace timeout, estimado por el planner; null si ambos fallan. */
  async safeCount(applyFilters = (q) => q) {
    for (const mode of ['exact', 'planned']) {
      const { count, error } = await applyFilters(this.from().select('id', { count: mode, head: true }));
      if (!error && count !== null) return { count, mode };
    }
    return { count: null, mode: null };
  }

  /** Total de filas: exacto si es posible; estimado (pg_class) si el exacto hace timeout. */
  async countTotal() {
    for (const mode of ['exact', 'estimated']) {
      const { count, error } = await this.from().select('id', { count: mode, head: true });
      if (!error && count !== null) return count;
      log.debug(`count(${mode}) falló: ${error?.message}`);
    }
    throw new Error(`No se pudo contar la tabla "${this.table}". ¿Existe y la key tiene permisos?`);
  }

  /**
   * Generador asíncrono que recorre la tabla por páginas usando keyset pagination.
   * @param {string} columns  Columnas a seleccionar (debe incluir `id`).
   * @param {(q) => q} applyFilters  Callback para añadir filtros PostgREST.
   * @yields {object[]} página de filas
   */
  async *scan(columns, applyFilters = (q) => q) {
    let lastId = null;
    for (;;) {
      let query = this.from().select(columns).order('id', { ascending: true }).limit(this.config.pageSize);
      if (lastId !== null) query = query.gt('id', lastId);
      query = applyFilters(query);

      const { data, error } = await query;
      if (error) throw new Error(`Error leyendo ${this.table}: ${error.message}`);
      if (!data || data.length === 0) return;

      yield data;
      lastId = data[data.length - 1].id;
      if (data.length < this.config.pageSize) return;
    }
  }

  /**
   * Borra filas por id en lotes. En DRY_RUN solo informa.
   * @param {Array<string|number>} ids
   * @param {string} reason  Etiqueta para el log.
   * @returns {Promise<number>} filas borradas (o que se borrarían en dry-run)
   */
  async deleteByIds(ids, reason) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return 0;

    // Freno de emergencia: ningún paso debe borrar más de X% de la tabla.
    if (this.initialRowCount) {
      const ratio = (this.totalDeleted + unique.length) / this.initialRowCount;
      if (ratio > this.config.maxDeleteRatio) {
        throw new Error(
          `[${reason}] Abortado por seguridad: se borraría el ${(ratio * 100).toFixed(1)}% de la tabla ` +
          `(límite MAX_DELETE_RATIO=${this.config.maxDeleteRatio}). Revisa con DRY_RUN=true.`,
        );
      }
    }

    if (this.config.dryRun) {
      log.info(`  [dry-run] ${reason}: se borrarían ${unique.length} filas`);
      this.totalDeleted += unique.length;
      return unique.length;
    }

    let deleted = 0;
    for (const batch of chunk(unique, this.config.deleteChunkSize)) {
      const { error, count } = await this.from().delete({ count: 'exact' }).in('id', batch);
      if (error) throw new Error(`[${reason}] Error borrando lote: ${error.message}`);
      deleted += count ?? batch.length;
    }
    this.totalDeleted += deleted;
    return deleted;
  }

  /**
   * Aplica actualizaciones individuales `{ id, patch }` con concurrencia limitada.
   * Los errores por fila (p. ej. violación de UNIQUE) se registran y no detienen el proceso.
   * @returns {Promise<{updated:number, failed:number}>}
   */
  async updateMany(updates, reason) {
    if (updates.length === 0) return { updated: 0, failed: 0 };
    if (this.config.dryRun) {
      log.info(`  [dry-run] ${reason}: se actualizarían ${updates.length} filas`);
      return { updated: updates.length, failed: 0 };
    }

    let updated = 0;
    let failed = 0;
    await mapPool(updates, this.config.updateConcurrency, async ({ id, patch }) => {
      const { error } = await this.from().update(patch).eq('id', id);
      if (error) {
        failed++;
        log.debug(`[${reason}] id=${id} no actualizado: ${error.message}`);
      } else {
        updated++;
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
  async updateByIds(patch, ids, reason) {
    if (!ids.length) return { updated: 0, failed: 0 };
    if (this.config.dryRun) return { updated: ids.length, failed: 0 };

    let updated = 0;
    let failed = 0;
    for (const batch of chunk(ids, this.config.deleteChunkSize)) {
      const { error, count } = await this.from().update(patch, { count: 'exact' }).in('id', batch);
      if (!error) {
        updated += count ?? batch.length;
        continue;
      }
      log.debug(`[${reason}] lote fallido (${error.message}); reintentando fila a fila`);
      const res = await this.updateMany(batch.map((id) => ({ id, patch })), reason);
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
      const { error, count } = await this.from()
        .update({ [column]: value }, { count: 'exact' })
        .in('id', batch)
        .is(column, null);
      if (error) {
        log.debug(`fillNullColumn(${column}) falló: ${error.message}`);
        continue;
      }
      total += count ?? 0;
    }
    return total;
  }
}
