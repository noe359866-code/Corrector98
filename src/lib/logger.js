/**
 * Logger minimalista compatible con GitHub Actions:
 *  - Usa ::group:: / ::endgroup:: para plegar cada paso en la UI de Actions.
 *  - Usa ::warning:: / ::error:: para que aparezcan como anotaciones.
 */

const IS_GHA = process.env.GITHUB_ACTIONS === 'true';

const ts = () => new Date().toISOString().slice(11, 19);

export const log = {
  info: (...args) => console.log(`[${ts()}]`, ...args),
  debug: (...args) => {
    if (process.env.DEBUG) console.log(`[${ts()}] [debug]`, ...args);
  },
  warn: (msg) => console.warn(IS_GHA ? `::warning::${msg}` : `[${ts()}] ⚠️  ${msg}`),
  error: (msg) => console.error(IS_GHA ? `::error::${msg}` : `[${ts()}] ❌ ${msg}`),
  group: (title) => console.log(IS_GHA ? `::group::${title}` : `\n━━━ ${title} ━━━`),
  groupEnd: () => {
    if (IS_GHA) console.log('::endgroup::');
  },
};
