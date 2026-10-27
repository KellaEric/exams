import { z } from 'zod';
import { bad, forbidden, unauthorized, tooMany } from './lib/errors.js';
import { sha256, safeEqual, clientIp } from './lib/util.js';
import { PRIVILEGED } from './lib/permissions.js';

export const COOKIE = 'kt_session';
export const parseCookies = (h = '') => Object.fromEntries(h.split(';').map((c) => { const i = c.indexOf('='); return i < 0 ? [] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())]; }).filter((x) => x.length));

export function setSessionCookie(ctx, res, token, maxAgeSec) {
  const parts = [`${COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (ctx.config.cookieSecure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
export const clearSessionCookie = (ctx, res) => setSessionCookie(ctx, res, '', 0);

export function securityHeaders(req, res, next) {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'same-origin' });
  next();
}

// Resolves the session cookie to req.user (with a Set of permissions). Sliding idle timeout capped by an absolute lifetime.
export const authenticate = (required = true) => async (req, res, next) => {
  try {
    const { ctx } = req;
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) { if (required) throw unauthorized(); return next(); }
    const row = await ctx.db.one(`select s.id as sid, s.csrf_token, s.expires_at, s.created_at as s_created, u.* from sessions s join users u on u.id=s.user_id where s.token_hash=$1 and s.revoked_at is null`, [sha256(token)]);
    const now = ctx.now();
    if (!row || row.expires_at <= now) { clearSessionCookie(ctx, res); if (required) throw unauthorized('Your session has expired. Please sign in again.'); return next(); }
    if (row.status !== 'active') { await ctx.db.query('update sessions set revoked_at=$2 where user_id=$1 and revoked_at is null', [row.id, now]); throw unauthorized('This account is not active.'); }
    const hardStop = new Date(row.s_created.getTime() + ctx.config.sessionMaxHours * 3600000);
    const target = new Date(Math.min(now.getTime() + ctx.config.sessionIdleMinutes * 60000, hardStop.getTime()));
    if (target.getTime() - row.expires_at.getTime() > 60000) await ctx.db.query('update sessions set expires_at=$2 where id=$1', [row.sid, target]);
    const perms = new Set((await ctx.db.query('select permission_key from role_permissions where role_key=$1', [row.role_key])).rows.map((r) => r.permission_key));
    const { password_hash, mfa_secret, sid, csrf_token, expires_at, s_created, ...user } = row;
    req.user = { ...user, perms, privileged: PRIVILEGED.has(user.role_key) };
    req.session = { id: sid, csrf: csrf_token };
    req.ip_addr = clientIp(req);
    next();
  } catch (e) { next(e); }
};

// CSRF: state-changing requests must (a) come from our own origin when an Origin header is present and (b) carry the session's token.
export const csrf = (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin; const allowed = req.ctx.config.allowedOrigins;
  if (origin && allowed.length && !allowed.includes(origin)) return next(forbidden('Cross-origin request rejected.'));
  if (req.session && !safeEqual(req.headers['x-csrf-token'] || '', req.session.csrf)) return next(forbidden('Missing or invalid CSRF token. Reload the page and try again.'));
  next();
};

export const need = (...perms) => (req, res, next) => (perms.every((p) => req.user.perms.has(p)) ? next() : next(forbidden()));
export const needAny = (...perms) => (req, res, next) => (perms.some((p) => req.user.perms.has(p)) ? next() : next(forbidden()));
export const needRole = (...roles) => (req, res, next) => (roles.includes(req.user.role_key) ? next() : next(forbidden()));
export const staffOnly = (req, res, next) => (req.user.role_key !== 'student' ? next() : next(forbidden()));

export const parse = (schema, data) => {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw bad('Please check the highlighted fields.', { fields: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return r.data;
};

// Simple per-process limiter for general API abuse (login/reset use the DB-backed throttle which is cluster-safe).
export function rateLimit({ windowMs = 60000, max = 120 } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const key = clientIp(req) + '|' + (req.user?.id || ''); const t = Date.now();
    const h = (hits.get(key) || []).filter((x) => t - x < windowMs); h.push(t); hits.set(key, h);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < windowMs)) hits.delete(k);
    if (h.length > max) return next(tooMany('Too many requests. Slow down.', Math.ceil(windowMs / 1000)));
    next();
  };
}
export { z };
