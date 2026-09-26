/** Barreras operativas: una variable DRY_RUN=false no basta para autorizar escrituras. */
export function assertApplyAuthorized(config) {
  if (config.dryRun) throw new Error('Escritura bloqueada en DRY_RUN');
  if (config.applyConfirmation !== `APPLY:${config.table}`) {
    throw new Error(`APPLY_CONFIRMATION debe ser APPLY:${config.table} para autorizar cambios.`);
  }
  for (const [name, value] of [['CHANGE_TICKET', config.changeTicket], ['BACKUP_REFERENCE', config.backupReference]]) {
    if (typeof value !== 'string' || value.trim().length < 3 || value.length > 200 || /[\r\n]/.test(value)) {
      throw new Error(`${name} debe identificar el cambio aprobado y el respaldo verificado (3..200 caracteres, una línea).`);
    }
  }
}
