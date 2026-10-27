// Database adapter. Production: PostgreSQL via `pg` (e.g. Supabase). Local dev and tests: PGlite (real Postgres compiled to WASM).
// Both expose the same tiny API so every query is plain Postgres SQL.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const j = (v) => JSON.stringify(v ?? null);   // always stringify JSON params explicitly (pg would turn arrays into PG arrays)

export async function createDb({ url, dataDir } = {}) {
  let db;
  if (url) {
    const pg = (await import('pg')).default;
    const mode = process.env.DATABASE_SSL || 'require';
    const ssl = mode === 'disable' ? false
      : mode === 'verify' ? { rejectUnauthorized: true, ca: process.env.DATABASE_CA || undefined }
      : { rejectUnauthorized: false };   // 'require': encrypted but certificate not verified (document + prefer 'verify' with DATABASE_CA)
    const u = new URL(url); ['sslmode', 'supa', 'pgbouncer'].forEach((k) => u.searchParams.delete(k));   // connection-string ssl flags would override the ssl option below
    const pool = new pg.Pool({ connectionString: u.toString(), ssl, max: Number(process.env.DB_POOL_MAX || 5), idleTimeoutMillis: 10000 });
    db = {
      kind: 'pg',
      query: async (sql, params = []) => { const r = await pool.query(sql, params); return { rows: r.rows, rowCount: r.rowCount }; },
      exec: async (sql) => { await pool.query(sql); },
      tx: async (fn) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const out = await fn({ query: async (sql, p = []) => { const r = await c.query(sql, p); return { rows: r.rows, rowCount: r.rowCount }; }, exec: async (sql) => { await c.query(sql); } });
          await c.query('COMMIT');
          return out;
        } catch (e) { try { await c.query('ROLLBACK'); } catch { /* ignore */ } throw e; } finally { c.release(); }
      },
      close: () => pool.end()
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    if (dataDir) fs.mkdirSync(path.dirname(path.resolve(dataDir)), { recursive: true });
    const lite = dataDir ? new PGlite(dataDir) : new PGlite();
    await lite.waitReady;
    db = {
      kind: 'pglite',
      query: async (sql, params = []) => { const r = await lite.query(sql, params); return { rows: r.rows, rowCount: r.rows.length || r.affectedRows || 0 }; },
      exec: async (sql) => { await lite.exec(sql); },
      tx: (fn) => lite.transaction(async (t) => fn({ query: async (sql, p = []) => { const r = await t.query(sql, p); return { rows: r.rows, rowCount: r.rows.length || r.affectedRows || 0 }; } })),
      close: () => lite.close()
    };
  }
  db.one = async (sql, p) => (await db.query(sql, p)).rows[0] || null;
  return db;
}

export async function pendingMigrations(db) {
  const files = fs.readdirSync(path.join(here, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  let done = [];
  try { done = (await db.query('select name from schema_migrations')).rows.map((r) => r.name); } catch { /* table missing: everything pending */ }
  return files.filter((f) => !done.includes(f));
}

export async function migrate(db, log = () => {}) {
  const ddl = 'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())';
  if (db.kind === 'pg') await db.tx(async (q) => { await q.query('select pg_advisory_xact_lock(727274)'); await q.exec(ddl); });   // concurrent cold starts must not race on creating the table
  else await db.exec(ddl);
  const dir = path.join(here, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied = [];
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const apply = async (q, exec) => {
      if ((await q.query('select 1 from schema_migrations where name=$1', [f])).rows.length) return;
      await exec(sql); await q.query('insert into schema_migrations(name) values ($1)', [f]); applied.push(f); log(`applied ${f}`);
    };
    if (db.kind === 'pg') {
      // One transaction per migration, serialised across concurrent cold starts with an advisory lock; all-or-nothing.
      await db.tx(async (q) => { await q.query('select pg_advisory_xact_lock(727274)'); await apply(q, (x) => q.exec(x)); });
    } else await apply(db, (x) => db.exec(x));
  }
  return applied;
}
