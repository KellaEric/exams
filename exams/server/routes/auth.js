import { Router } from 'express';
import { z } from 'zod';
import { wrap, bad, unauthorized, forbidden } from '../lib/errors.js';
import { hashPassword, verifyPassword, passwordProblem } from '../lib/password.js';
import { randomToken, sha256, clientIp } from '../lib/util.js';
import { throttleCheck, throttleHit, throttleClear } from '../lib/throttle.js';
import { audit } from '../lib/audit.js';
import { sendMail } from '../lib/mailer.js';
import * as totp from '../lib/totp.js';
import { PRIVILEGED } from '../lib/permissions.js';
import { authenticate, csrf, parse, setSessionCookie, clearSessionCookie, COOKIE, parseCookies } from '../middleware.js';

const r = Router();
const email = z.string().trim().toLowerCase().email().max(200);
const DUMMY = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

export const publicUser = (u) => ({ id: u.id, email: u.email, full_name: u.full_name, role_key: u.role_key, student_number: u.student_number, status: u.status, mfa_enabled: u.mfa_enabled });

async function createSession(ctx, req, res, user) {
  const token = randomToken(32), csrfToken = randomToken(24), now = ctx.now();
  await ctx.db.query('insert into sessions(user_id,token_hash,csrf_token,ip,user_agent,created_at,expires_at) values($1,$2,$3,$4,$5,$6,$7)',
    [user.id, sha256(token), csrfToken, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 200), now, new Date(now.getTime() + ctx.config.sessionIdleMinutes * 60000)]);
  setSessionCookie(ctx, res, token, ctx.config.sessionIdleMinutes * 60);
  return csrfToken;
}
const permsOf = async (db, role) => (await db.query('select permission_key from role_permissions where role_key=$1 order by 1', [role])).rows.map((x) => x.permission_key);

r.post('/login', wrap(async (req, res) => {
  const { ctx } = req;
  const b = parse(z.object({ email, password: z.string().min(1).max(200), mfa_code: z.string().max(10).optional() }), req.body);
  const ip = clientIp(req), kE = `login:e:${b.email}`, kI = `login:ip:${ip}`;
  await throttleCheck(ctx, kE); await throttleCheck(ctx, kI);
  const user = await ctx.db.one('select * from users where lower(email)=$1', [b.email]);
  const ok = await verifyPassword(b.password, user?.password_hash || DUMMY);   // constant-ish work whether or not the account exists
  if (!user || !ok) {
    await throttleHit(ctx, kE, { max: 5 }); await throttleHit(ctx, kI, { max: 40 });
    await audit(ctx.db, ctx, { action: 'auth.login_failed', entity: 'user', id: user?.id, meta: { email: b.email, actor_label: 'anonymous' }, req: { ip_addr: ip } });
    throw unauthorized('Email or password is incorrect.');
  }
  if (user.status !== 'active') {
    const msg = { pending: 'Your account is waiting for administrator approval.', invited: 'Use the invitation link you were sent to set your password.', suspended: 'This account has been suspended. Contact an administrator.', deactivated: 'This account has been deactivated.' }[user.status];
    throw forbidden(msg);
  }
  if (user.mfa_enabled) {
    if (!b.mfa_code) throw Object.assign(unauthorized('Enter your authentication code.'), { code: 'mfa_required' });
    if (!totp.verify(user.mfa_secret, b.mfa_code, ctx.now().getTime())) { await throttleHit(ctx, kE, { max: 5 }); throw Object.assign(unauthorized('That authentication code is not valid.'), { code: 'mfa_invalid' }); }
  }
  await throttleClear(ctx, kE);
  const csrfToken = await createSession(ctx, req, res, user);
  await ctx.db.query('update users set last_login_at=$2 where id=$1', [user.id, ctx.now()]);
  await audit(ctx.db, ctx, { actor: user, action: 'auth.login', entity: 'user', id: user.id, req: { ip_addr: ip } });
  const perms = await permsOf(ctx.db, user.role_key);
  res.json({ user: publicUser(user), csrf: csrfToken, permissions: perms, mfa_setup_required: ctx.config.requireMfaForPrivileged && PRIVILEGED.has(user.role_key) && !user.mfa_enabled });
}));

r.post('/register', wrap(async (req, res) => {
  const { ctx } = req;
  if (ctx.config.selfRegistration === 'off') throw forbidden('Self-registration is disabled. Ask an administrator for an invitation.');
  const b = parse(z.object({ email, full_name: z.string().trim().min(2).max(120), password: z.string(), student_number: z.string().trim().max(40).optional() }), req.body);
  await throttleCheck(ctx, `reg:ip:${clientIp(req)}`); await throttleHit(ctx, `reg:ip:${clientIp(req)}`, { max: 10, windowSec: 3600, lockSec: 3600 });
  const p = passwordProblem(b.password, { email: b.email }); if (p) throw bad(p);
  const exists = await ctx.db.one('select id from users where lower(email)=$1', [b.email]);
  const status = ctx.config.selfRegistration === 'open' ? 'active' : 'pending';
  if (!exists) {
    const hash = await hashPassword(b.password);
    try {
      const u = (await ctx.db.query("insert into users(email,password_hash,full_name,role_key,status,student_number,created_at,updated_at) values($1,$2,$3,'student',$4,$5,$6,$6) returning *", [b.email, hash, b.full_name, status, b.student_number || null, ctx.now()])).rows[0];
      await audit(ctx.db, ctx, { actor: u, action: 'auth.register', entity: 'user', id: u.id, meta: { status }, req: { ip_addr: clientIp(req) } });
    } catch (e) { if (e.code !== '23505') throw e; }           // duplicate student number etc.: same generic reply
  } else await sendMail(ctx, { to: b.email, subject: 'KellasTech account', body: 'Someone tried to register with this email, but an account already exists. If this was you, sign in or use "Forgot password".' });
  res.status(201).json({ ok: true, message: status === 'active' ? 'Account created. You can sign in.' : 'Account created. An administrator must approve it before you can sign in.' });
}));

r.post('/forgot-password', wrap(async (req, res) => {
  const { ctx } = req;
  const b = parse(z.object({ email }), req.body);
  await throttleCheck(ctx, `fp:e:${b.email}`); await throttleHit(ctx, `fp:e:${b.email}`, { max: 5, windowSec: 3600, lockSec: 3600 });
  const u = await ctx.db.one("select * from users where lower(email)=$1 and status in ('active','pending')", [b.email]);
  let dev;
  if (u) {
    const token = randomToken(32);
    await ctx.db.query("insert into auth_tokens(user_id,purpose,token_hash,expires_at,created_at) values($1,'reset',$2,$3,$4)", [u.id, sha256(token), new Date(ctx.now().getTime() + 3600000), ctx.now()]);
    await sendMail(ctx, { to: u.email, subject: 'Reset your KellasTech password', body: `Use this link within 1 hour: ${ctx.config.publicUrl}/reset?token=${token}\nIf you did not ask for this, ignore this message.` });
    if (ctx.config.exposeDevTokens) dev = token;
  }
  res.json({ ok: true, message: 'If that email has an account, a reset link has been sent.', ...(dev ? { dev_token: dev } : {}) });
}));

async function consumeToken(ctx, token, purposes) {
  const row = await ctx.db.one('select * from auth_tokens where token_hash=$1 and used_at is null and expires_at > $2', [sha256(String(token || '')), ctx.now()]);
  if (!row || !purposes.includes(row.purpose)) throw bad('This link is invalid or has expired.');
  return row;
}
const setPasswordFlow = (purpose) => wrap(async (req, res) => {
  const { ctx } = req;
  const b = parse(z.object({ token: z.string().min(10).max(200), password: z.string() }), req.body);
  const t = await consumeToken(ctx, b.token, purpose === 'reset' ? ['reset'] : ['invite']);
  const u = await ctx.db.one('select * from users where id=$1', [t.user_id]);
  const p = passwordProblem(b.password, { privileged: PRIVILEGED.has(u.role_key), email: u.email }); if (p) throw bad(p);
  const hash = await hashPassword(b.password);
  await ctx.db.tx(async (q) => {
    await q.query("update users set password_hash=$2, status=case when status in ('invited','pending') and $3 = 'invite' then 'active' else status end, email_verified_at=coalesce(email_verified_at,$4), updated_at=$4 where id=$1", [u.id, hash, purpose, ctx.now()]);
    await q.query('update auth_tokens set used_at=$2 where id=$1', [t.id, ctx.now()]);
    await q.query('update sessions set revoked_at=$2 where user_id=$1 and revoked_at is null', [u.id, ctx.now()]);
    await audit(q, ctx, { actor: u, action: purpose === 'reset' ? 'auth.password_reset' : 'auth.invite_accepted', entity: 'user', id: u.id, req: { ip_addr: clientIp(req) } });
  });
  res.json({ ok: true });
});
r.post('/reset-password', setPasswordFlow('reset'));
r.post('/accept-invite', setPasswordFlow('invite'));

r.post('/verify-email', wrap(async (req, res) => {
  const { ctx } = req; const b = parse(z.object({ token: z.string().min(10) }), req.body);
  const t = await consumeToken(ctx, b.token, ['verify']);
  await ctx.db.query('update users set email_verified_at=$2 where id=$1', [t.user_id, ctx.now()]); await ctx.db.query('update auth_tokens set used_at=$2 where id=$1', [t.id, ctx.now()]);
  res.json({ ok: true });
}));

// ---- authenticated ----
const authed = [authenticate(true), csrf];
r.post('/logout', authenticate(false), wrap(async (req, res) => {
  const { ctx } = req;
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) await ctx.db.query('update sessions set revoked_at=$2 where token_hash=$1', [sha256(token), ctx.now()]);
  if (req.user) await audit(ctx.db, ctx, { actor: req.user, action: 'auth.logout', entity: 'user', id: req.user.id, req });
  clearSessionCookie(ctx, res); res.json({ ok: true });
}));
r.get('/me', authed, wrap(async (req, res) => {
  const u = await req.ctx.db.one('select * from users where id=$1', [req.user.id]);
  res.json({ user: publicUser(u), csrf: req.session.csrf, permissions: [...req.user.perms].sort(), mfa_setup_required: req.ctx.config.requireMfaForPrivileged && req.user.privileged && !u.mfa_enabled });
}));
r.post('/change-password', authed, wrap(async (req, res) => {
  const { ctx } = req; const b = parse(z.object({ current_password: z.string(), password: z.string() }), req.body);
  const u = await ctx.db.one('select * from users where id=$1', [req.user.id]);
  await throttleCheck(ctx, `cp:${u.id}`);
  if (!(await verifyPassword(b.current_password, u.password_hash))) { await throttleHit(ctx, `cp:${u.id}`, { max: 5 }); throw bad('Current password is incorrect.'); }
  const p = passwordProblem(b.password, { privileged: req.user.privileged, email: u.email }); if (p) throw bad(p);
  await ctx.db.query('update users set password_hash=$2, updated_at=$3 where id=$1', [u.id, await hashPassword(b.password), ctx.now()]);
  await ctx.db.query('update sessions set revoked_at=$2 where user_id=$1 and id<>$3 and revoked_at is null', [u.id, ctx.now(), req.session.id]);
  await audit(ctx.db, ctx, { actor: req.user, action: 'auth.password_changed', entity: 'user', id: u.id, req });
  res.json({ ok: true });
}));
r.post('/mfa/setup', authed, wrap(async (req, res) => {
  const secret = totp.newSecret();
  await req.ctx.db.query('update users set mfa_secret=$2 where id=$1 and mfa_enabled=false', [req.user.id, secret]);
  res.json({ secret, otpauth_url: totp.otpauthUrl(secret, req.user.email) });
}));
r.post('/mfa/enable', authed, wrap(async (req, res) => {
  const { ctx } = req; const b = parse(z.object({ code: z.string().min(6).max(8) }), req.body);
  const u = await ctx.db.one('select * from users where id=$1', [req.user.id]);
  if (!u.mfa_secret || !totp.verify(u.mfa_secret, b.code, ctx.now().getTime())) throw bad('That code is not valid. Check your authenticator app clock.');
  await ctx.db.query('update users set mfa_enabled=true where id=$1', [u.id]);
  await audit(ctx.db, ctx, { actor: req.user, action: 'auth.mfa_enabled', entity: 'user', id: u.id, req }); res.json({ ok: true });
}));
r.post('/mfa/disable', authed, wrap(async (req, res) => {
  const { ctx } = req; const b = parse(z.object({ password: z.string(), code: z.string().min(6).max(8) }), req.body);
  const u = await ctx.db.one('select * from users where id=$1', [req.user.id]);
  if (ctx.config.requireMfaForPrivileged && req.user.privileged) throw forbidden('MFA is mandatory for administrator accounts.');
  if (!(await verifyPassword(b.password, u.password_hash)) || !totp.verify(u.mfa_secret, b.code, ctx.now().getTime())) throw bad('Password or code is incorrect.');
  await ctx.db.query('update users set mfa_enabled=false, mfa_secret=null where id=$1', [u.id]);
  await audit(ctx.db, ctx, { actor: req.user, action: 'auth.mfa_disabled', entity: 'user', id: u.id, req }); res.json({ ok: true });
}));
export default r;
