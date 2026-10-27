import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';

const base = { NODE_ENV: 'test', PGLITE_DIR: '' };
describe('first-admin bootstrap from environment variables', () => {
  it('creates a super administrator who can sign in, only when none exists, and never overwrites', async () => {
    const env = { ...base, BOOTSTRAP_ADMIN_EMAIL: 'Owner@Kellastech.example', BOOTSTRAP_ADMIN_PASSWORD: 'Zebra-Lantern-Pass-1', BOOTSTRAP_ADMIN_NAME: 'Kella Owner' };
    const app = await createApp({ env });
    const login = await request(app).post('/api/auth/login').send({ email: 'owner@kellastech.example', password: 'Zebra-Lantern-Pass-1' });
    expect(login.status).toBe(200); expect(login.body.user).toMatchObject({ role_key: 'super_admin', full_name: 'Kella Owner' });
    expect(login.body.permissions).toContain('role.manage');
    // a second start (cold start of another instance) with a different password must not create or change anything
    const { bootstrapAdmin } = await import('../lib/bootstrap.js');
    expect(await bootstrapAdmin(app.ctx, { ...env, BOOTSTRAP_ADMIN_EMAIL: 'other@kellastech.example', BOOTSTRAP_ADMIN_PASSWORD: 'Another-Strong-Pass-2' })).toBeNull();
    expect((await app.ctx.db.one('select count(*)::int as n from users')).n).toBe(1);
    expect((await request(app).post('/api/auth/login').send({ email: 'owner@kellastech.example', password: 'Another-Strong-Pass-2' })).status).toBe(401);
    const audit = await app.ctx.db.one("select actor_label, meta from audit_events where action='user.create'");
    expect(audit.actor_label).toBe('bootstrap'); expect(JSON.stringify(audit)).not.toContain('Zebra-Lantern-Pass-1');
  });
  it('refuses a weak password or bad email and creates nothing', async () => {
    const weak = await createApp({ env: { ...base, BOOTSTRAP_ADMIN_EMAIL: 'a@b.example', BOOTSTRAP_ADMIN_PASSWORD: 'short' } });
    expect((await weak.ctx.db.one('select count(*)::int as n from users')).n).toBe(0);
    const bad = await createApp({ env: { ...base, BOOTSTRAP_ADMIN_EMAIL: 'not-an-email', BOOTSTRAP_ADMIN_PASSWORD: 'Long-Enough-Pass-1' } });
    expect((await bad.ctx.db.one('select count(*)::int as n from users')).n).toBe(0);
  });
  it('does nothing without the variables (no default account exists)', async () => {
    const app = await createApp({ env: base }); expect((await app.ctx.db.one('select count(*)::int as n from users')).n).toBe(0);
  });
});

describe('configuration derived from Vercel + Supabase integration variables', () => {
  const vercel = { NODE_ENV: 'production', POSTGRES_URL: 'postgres://u:p@h:6543/db', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k'.repeat(40), VERCEL_PROJECT_PRODUCTION_URL: 'portal.vercel.app', VERCEL_URL: 'portal-abc123.vercel.app' };
  it('needs no manual settings once Supabase is connected', () => {
    const c = loadConfig(vercel);
    expect(c.problems).toEqual([]); expect(c.databaseUrl).toBe(vercel.POSTGRES_URL); expect(c.storage).toBe('supabase');
    expect(c.allowedOrigins).toEqual(['https://portal.vercel.app', 'https://portal-abc123.vercel.app']); expect(c.fileSecret).toHaveLength(64); expect(c.warnings[0]).toMatch(/CRON_SECRET/);
  });
  it('reports clear problems when nothing is connected, and a custom domain can be added', () => {
    const none = loadConfig({ NODE_ENV: 'production' }); expect(none.problems.join(' ')).toMatch(/No database/); expect(none.problems.join(' ')).toMatch(/File storage/);
    expect(loadConfig({ ...vercel, APP_ORIGIN: 'https://exams.kellastech.com/' }).allowedOrigins[0]).toBe('https://exams.kellastech.com');
  });
  it('accepts the new Supabase key names and any of the Postgres URL variables', () => {
    const c = loadConfig({ NODE_ENV: 'production', POSTGRES_URL_NON_POOLING: 'postgres://u:p@h:5432/db', SUPABASE_URL: 'https://abc.supabase.co/', SUPABASE_SECRET_KEY: 'sb_secret_' + 'x'.repeat(30), SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x', VERCEL_URL: 'portal.vercel.app' });
    expect(c.problems).toEqual([]); expect(c.storage).toBe('supabase'); expect(c.supabaseUrl).toBe('https://abc.supabase.co'); expect(c.databaseUrl).toMatch(/postgres:\/\//);
  });
  it('names exactly what is missing (setting names only) when the portal cannot start', async () => {
    const { default: handler } = await import('../../api/index.js');
    const saved = { ...process.env }; for (const k of Object.keys(process.env)) if (/^(POSTGRES|DATABASE|SUPABASE|NEXT_PUBLIC_SUPABASE|VERCEL)/.test(k)) delete process.env[k];
    process.env.NODE_ENV = 'production'; let body = '', status;
    await handler({}, { setHeader() {}, end: (b) => { body = b; }, set statusCode(v) { status = v; } });
    Object.assign(process.env, saved); process.env.NODE_ENV = 'test';
    const j = JSON.parse(body); expect(status).toBe(503); expect(j.error.details.problems.join(' ')).toMatch(/POSTGRES_URL/); expect(j.error.details.problems.join(' ')).toMatch(/SUPABASE_SECRET_KEY/);
  });
});
