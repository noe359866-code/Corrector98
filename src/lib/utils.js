/** Utilidades genéricas sin dependencias. */

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Divide un array en trozos de tamaño `size`. */
export function chunk(array, size) {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('El tamaño de lote debe ser un entero positivo');
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

/**
 * Ejecuta `worker(item)` sobre todos los items con un máximo de `concurrency`
 * promesas simultáneas. Devuelve los resultados en el mismo orden.
 */
export async function mapPool(items, concurrency, worker) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('La concurrencia debe ser un entero positivo');
  const results = new Array(items.length);
  let cursor = 0;
  let failed = false;
  let failure;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed && cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  });
  // Drenar peticiones ya enviadas antes de cerrar la auditoría o salir del paso.
  // Promise.all sobre workers que rechazan dejaría mutaciones en segundo plano.
  await Promise.all(runners);
  if (failed) throw failure;
  return results;
}

/** Formatea bytes a una cadena legible. */
export function formatBytes(bytes) {
  if (bytes == null) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes);
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}
