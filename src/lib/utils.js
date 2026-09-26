/** Utilidades genéricas sin dependencias. */

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Divide un array en trozos de tamaño `size`. */
export function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

/**
 * Ejecuta `worker(item)` sobre todos los items con un máximo de `concurrency`
 * promesas simultáneas. Devuelve los resultados en el mismo orden.
 */
export async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
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
