import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redact } from './logger.js';

/** Diario local durable. No reemplaza backups ni almacenamiento inmutable externo. */
export class AuditLog {
  constructor(handle, runId, file) {
    this.handle = handle;
    this.runId = runId;
    this.file = file;
    this.sequence = 0;
    this.queue = Promise.resolve();
    this.failed = false;
  }

  static async open(directory) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const runId = randomUUID();
    const file = path.join(directory, `${runId}.jsonl`);
    const handle = await fs.open(file, 'wx', 0o600);
    return new AuditLog(handle, runId, file);
  }

  record(event, data = {}) {
    const task = this.queue.then(async () => {
      if (this.failed) throw new Error('Auditoría no disponible: operación bloqueada');
      try {
        const entry = { ...data, schemaVersion: 1, runId: this.runId, sequence: ++this.sequence,
          timestamp: new Date().toISOString(), event };
        await this.handle.writeFile(`${redact(JSON.stringify(entry))}\n`);
        await this.handle.sync(); // La intención debe quedar guardada ANTES de escribir en Supabase.
      } catch (error) {
        this.failed = true;
        throw new Error('No se pudo persistir la auditoría: operación bloqueada', { cause: error });
      }
    });
    this.queue = task.catch(() => {});
    return task;
  }

  async close() {
    await this.queue;
    await this.handle.close();
  }
}
