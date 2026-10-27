const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
import crypto from 'node:crypto';

export function loadConfig(env = process.env) {
  const prod = env.NODE_ENV === 'production';
  // Origins: explicit APP_ORIGIN (comma separated) plus the URLs Vercel provides automatically.
  const origins = [...(env.APP_ORIGIN || '').split(','), env.VERCEL_PROJECT_PRODUCTION_URL && `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`, env.VERCEL_URL && `https://${env.VERCEL_URL}`].map((x) => (x || '').trim().replace(/\/$/, '')).filter(Boolean);
  const supabaseUrl = (env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
  // Supabase's new API keys are named SUPABASE_SECRET_KEY (server) / SUPABASE_PUBLISHABLE_KEY (browser); older projects use SUPABASE_SERVICE_ROLE_KEY.
  const supabaseKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
  const cfg = {
    prod,
    appOrigin: origins[0] || (prod ? '' : 'http://localhost:5173'),
    allowedOrigins: origins.length ? [...new Set(origins)] : (prod ? [] : ['http://localhost:5173']),
    databaseUrl: env.DATABASE_URL || env.POSTGRES_URL || env.POSTGRES_PRISMA_URL || env.POSTGRES_URL_NON_POOLING || env.SUPABASE_DB_URL || '',      // POSTGRES_URL is set by Vercel's Supabase integration
    pgliteDir: env.PGLITE_DIR !== undefined ? env.PGLITE_DIR : (prod ? '' : '.data/pglite'),   // '' = in-memory
    sessionIdleMinutes: Number(env.SESSION_IDLE_MINUTES || 120),
    sessionMaxHours: Number(env.SESSION_MAX_HOURS || 12),
    cookieSecure: bool(env.COOKIE_SECURE, prod),
    selfRegistration: ['off', 'approval', 'open'].includes(env.SELF_REGISTRATION) ? env.SELF_REGISTRATION : 'approval',
    requireMfaForPrivileged: bool(env.REQUIRE_MFA_FOR_PRIVILEGED, false),
    saveGraceSeconds: Number(env.EXAM_SAVE_GRACE_SECONDS || 10),
    maxUploadMb: Number(env.MAX_UPLOAD_MB || 4),
    storage: env.STORAGE_DRIVER || (supabaseUrl && supabaseKey && prod ? 'supabase' : 'local'),
    uploadDir: env.UPLOAD_DIR || '.data/uploads',
    supabaseUrl, supabaseKey, supabaseBucket: env.SUPABASE_BUCKET || 'kellastech-private',
    fileSecret: env.FILE_SIGNING_SECRET || ((supabaseKey || env.SUPABASE_JWT_SECRET) ? crypto.createHash('sha256').update('kt-file-signing|' + (env.SUPABASE_JWT_SECRET || supabaseKey)).digest('hex') : ''),
    cronSecret: env.CRON_SECRET || '',
    resendKey: env.RESEND_API_KEY || '', mailFrom: env.MAIL_FROM || 'KellasTech <no-reply@kellastech.example>',
    exposeDevTokens: bool(env.EXPOSE_DEV_TOKENS, false) && !prod,
    allowSelfApproval: bool(env.QUESTION_SELF_APPROVAL, true),
    autoMigrate: bool(env.AUTO_MIGRATE, true),   // applies pending migrations on start (guarded by a database lock); set false to run `npm run migrate` yourself
    publicUrl: env.PUBLIC_URL || origins[0] || 'http://localhost:5173'
  };
  const problems = [];
  if (prod) {
    if (!cfg.databaseUrl) problems.push('No database connection string found. Add POSTGRES_URL (Supabase → Connect → Transaction pooler URI, with your database password) or DATABASE_URL in Vercel environment variables.');
    if (cfg.fileSecret.length < 32) problems.push('FILE_SIGNING_SECRET is missing (it is derived automatically when the Supabase integration is connected).');
    if (!cfg.allowedOrigins.length) problems.push('APP_ORIGIN is missing and Vercel did not provide a URL.');
    if (cfg.storage === 'local') problems.push('File storage is not configured: set SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY).');
  }
  if (!cfg.fileSecret) cfg.fileSecret = 'dev-only-' + Math.random().toString(36).slice(2).padEnd(24, 'x');
  cfg.problems = problems;
  cfg.warnings = [];
  if (prod && !cfg.cronSecret) cfg.warnings.push('CRON_SECRET not set: the scheduled sweeper is disabled (overdue attempts are still finalised when accessed).');
  return cfg;
}
