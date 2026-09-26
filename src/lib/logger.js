/**
 * Logger minimalista compatible con GitHub Actions:
 *  - Usa ::group:: / ::endgroup:: para plegar cada paso en la UI de Actions.
 *  - Usa ::warning:: / ::error:: para que aparezcan como anotaciones.
 */

const IS_GHA = process.env.GITHUB_ACTIONS === 'true';

const ts = () => new Date().toISOString().slice(11, 19);

/** Defensa adicional: nunca registrar credenciales ni query strings de APIs. */
export function redact(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  text = text ?? String(value);
  for (const [name, secret] of Object.entries(process.env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD/i.test(name) && secret?.length >= 6) {
      text = text.split(secret).join('[REDACTED]');
      text = text.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]');
      text = text.split(encodeURIComponent(secret)).join('[REDACTED]');
    }
  }
  return text.replace(/([?&](?:api_key|apikey|access_token|token)=)[^&\s"<>]+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
}

const safe = (msg) => redact(msg).replace(/[\r\n]/g, ' ');
const annotation = (msg) => safe(msg).replace(/%/g, '%25');
export const log = {
  info: (...args) => console.log(`[${ts()}]`, ...args.map(safe)),
  debug: (...args) => {
    if (['1', 'true'].includes(process.env.DEBUG)) console.log(`[${ts()}] [debug]`, ...args.map(safe));
  },
  warn: (msg) => console.warn(IS_GHA ? `::warning::${annotation(msg)}` : `[${ts()}] ⚠️  ${safe(msg)}`),
  error: (msg) => console.error(IS_GHA ? `::error::${annotation(msg)}` : `[${ts()}] ❌ ${safe(msg)}`),
  group: (title) => console.log(IS_GHA ? `::group::${annotation(title)}` : `\n━━━ ${safe(title)} ━━━`),
  groupEnd: () => {
    if (IS_GHA) console.log('::endgroup::');
  },
};
