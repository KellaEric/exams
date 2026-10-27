import { loadConfig } from '../server/config.js';
import { createDb, migrate } from '../server/db/index.js';
import { seedReference } from '../server/lib/permissions.js';
export async function boot({ migrateFirst = true } = {}) {
  const config = loadConfig();
  if (config.problems.length) { console.error('Configuration problems:\n - ' + config.problems.join('\n - ')); process.exit(1); }
  const db = await createDb({ url: config.databaseUrl || undefined, dataDir: config.pgliteDir || undefined });
  if (migrateFirst) { await migrate(db, (m) => console.log(m)); await seedReference(db); }
  return { db, config, ctx: { db, config, now: () => new Date() } };
}
export const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? def : (process.argv[i + 1]?.startsWith('--') || i + 1 >= process.argv.length ? true : process.argv[i + 1]); };
