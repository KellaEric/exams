import express from 'express';
import { loadConfig } from './config.js';
import { createDb, migrate, pendingMigrations } from './db/index.js';
import { seedReference } from './lib/permissions.js';
import { bootstrapAdmin } from './lib/bootstrap.js';
import { createStorage } from './lib/storage.js';
import { HttpError } from './lib/errors.js';
import { securityHeaders, authenticate, csrf, rateLimit } from './middleware.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import courseRoutes from './routes/courses.js';
import questionRoutes from './routes/questions.js';
import assessmentRoutes from './routes/assessments.js';
import examRoutes from './routes/exam.js';
import gradingRoutes from './routes/grading.js';
import reportRoutes from './routes/reports.js';
import fileRoutes from './routes/files.js';
import miscRoutes from './routes/misc.js';
import { finalizeExpired, refreshAllDue } from './lib/exam.js';

export async function createApp({ env = process.env, db, now = () => new Date(), clock } = {}) {
  const config = loadConfig(env);
  if (config.problems.length) throw Object.assign(new Error('Configuration problems:\n - ' + config.problems.join('\n - ')), { problems: config.problems });
  db = db || await createDb({ url: config.databaseUrl || undefined, dataDir: config.pgliteDir || undefined });
  if (config.autoMigrate) { const applied = await migrate(db); if (applied.length || !(await db.one('select 1 as x from roles limit 1'))) await seedReference(db); }
  else { const pending = await pendingMigrations(db); if (pending.length) throw new Error(`Database has pending migrations (${pending.join(', ')}). Run: npm run migrate`); }
  const ctx = { db, config, now: clock || now, storage: createStorage(config) };
  for (const w of config.warnings) console.warn('[config]', w);
  await bootstrapAdmin(ctx, env);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((req, res, next) => { req.ctx = ctx; next(); });
  app.use(securityHeaders);
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', rateLimit({ max: 600 }));

  app.get('/api/health', async (req, res) => { try { await db.query('select 1'); res.json({ ok: true, time: ctx.now() }); } catch { res.status(503).json({ ok: false }); } });

  // Cron / sweeper (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`). Closes expired attempts and advances assessment lifecycles.
  app.all('/api/internal/sweep', async (req, res, next) => {
    try {
      if (!config.cronSecret || req.headers.authorization !== `Bearer ${config.cronSecret}`) throw new HttpError(401, 'Unauthorized', 'unauthorized');
      const attempts = await finalizeExpired(ctx); const assessments = await refreshAllDue(ctx);
      res.json({ finalized_attempts: attempts, assessments_checked: assessments });
    } catch (e) { next(e); }
  });

  app.use('/api/auth', authRoutes);
  app.use('/api', authenticate(true), csrf);
  // Optional policy: privileged accounts must enrol in MFA before using anything else.
  app.use('/api', (req, res, next) => (config.requireMfaForPrivileged && req.user.privileged && !req.user.mfa_enabled ? next(new HttpError(403, 'Set up multi-factor authentication to continue.', 'mfa_setup_required')) : next()));
  for (const r of [adminRoutes, courseRoutes, questionRoutes, assessmentRoutes, examRoutes, gradingRoutes, reportRoutes, fileRoutes, miscRoutes]) app.use('/api', r);
  app.use('/api', (req, res) => res.status(404).json({ error: { message: 'Not found.', code: 'not_found' } }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') err = new HttpError(413, 'Request body is too large.', 'too_large');
    if (err.type === 'entity.parse.failed') err = new HttpError(400, 'Invalid JSON body.', 'bad_json');
    if (err instanceof HttpError) {
      if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
      return res.status(err.status).json({ error: { message: err.message, code: err.code, details: err.details } });
    }
    if (err.code === '23505') return res.status(409).json({ error: { message: 'That record already exists.', code: 'duplicate' } });
    if (err.code === '23503') return res.status(409).json({ error: { message: 'That record is still referenced by other data.', code: 'in_use' } });
    if (err.code === '22P02') return res.status(400).json({ error: { message: 'Invalid identifier or value.', code: 'bad_request' } });
    console.error('[error]', req.method, req.path, err);    // never echo internals to the client
    res.status(500).json({ error: { message: 'Something went wrong on the server.', code: 'server_error' } });
  });
  app.ctx = ctx;
  return app;
}
