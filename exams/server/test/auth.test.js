import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { makeWorld, setupCourse, PW } from './helpers.js';

let w;
beforeAll(async () => { w = await makeWorld(); });

describe('authentication', () => {
  it('logs in with valid credentials and sets an httpOnly session cookie', async () => {
    const r = await request(w.app).post('/api/auth/login').send({ email: w.users.s1.email, password: PW });
    expect(r.status).toBe(200);
    const cookie = r.headers['set-cookie'].join(';');
    expect(cookie).toMatch(/kt_session=/); expect(cookie).toMatch(/HttpOnly/); expect(cookie).toMatch(/SameSite=Lax/);
    expect(r.body.user.role_key).toBe('student'); expect(JSON.stringify(r.body)).not.toMatch(/password|hash/i);
  });
  it('rejects wrong password and unknown users with the same message', async () => {
    const a = await request(w.app).post('/api/auth/login').send({ email: w.users.s2.email, password: 'nope-nope-1' });
    const b = await request(w.app).post('/api/auth/login').send({ email: 'ghost@test.kellastech.example', password: 'nope-nope-1' });
    expect(a.status).toBe(401); expect(b.status).toBe(401); expect(a.body.error.message).toBe(b.body.error.message);
  });
  it('throttles repeated failures, then recovers after the lock window', async () => {
    const email = w.users.s3.email; let last;
    for (let i = 0; i < 6; i++) last = await request(w.app).post('/api/auth/login').send({ email, password: 'bad-bad-bad1' });
    expect(last.status).toBe(429); expect(last.headers['retry-after']).toBeTruthy();
    const still = await request(w.app).post('/api/auth/login').send({ email, password: PW });
    expect(still.status).toBe(429);                       // even the right password is refused while locked
    w.advance(16 * 60);
    expect((await request(w.app).post('/api/auth/login').send({ email, password: PW })).status).toBe(200);
  });
  it('requires a session and a CSRF token for state changes', async () => {
    expect((await request(w.app).get('/api/me/courses')).status).toBe(401);
    const agent = request.agent(w.app); await agent.post('/api/auth/login').send({ email: w.users.admin.email, password: PW });
    const noCsrf = await agent.post('/api/departments').send({ name: 'Computing' });
    expect(noCsrf.status).toBe(403); expect(noCsrf.body.error.code).toBe('forbidden');
  });
  it('suspension revokes live sessions immediately and blocks new logins', async () => {
    const admin = await w.login('admin'); const stu = await w.login('s2');
    expect((await stu.get('/api/me/courses')).status).toBe(200);
    expect((await admin.patch(`/api/users/${w.users.s2.id}`, { status: 'suspended' })).status).toBe(200);
    expect((await stu.get('/api/me/courses')).status).toBe(401);
    expect((await request(w.app).post('/api/auth/login').send({ email: w.users.s2.email, password: PW })).status).toBe(403);
    await admin.patch(`/api/users/${w.users.s2.id}`, { status: 'active' });
  });
  it('sessions expire after the idle timeout', async () => {
    const s = await w.login('s1'); expect((await s.get('/api/me/courses')).status).toBe(200);
    w.advance(121 * 60); expect((await s.get('/api/me/courses')).status).toBe(401);
  });
  it('password reset: one-time token, old password stops working, sessions revoked', async () => {
    const f = await request(w.app).post('/api/auth/forgot-password').send({ email: w.users.s1.email });
    expect(f.status).toBe(200); const token = f.body.dev_token; expect(token).toBeTruthy();
    const weak = await request(w.app).post('/api/auth/reset-password').send({ token, password: 'short' }); expect(weak.status).toBe(400);
    const ok = await request(w.app).post('/api/auth/reset-password').send({ token, password: 'Brand-New-Pass-77' }); expect(ok.status).toBe(200);
    expect((await request(w.app).post('/api/auth/reset-password').send({ token, password: 'Another-Pass-88' })).status).toBe(400);   // single use
    expect((await request(w.app).post('/api/auth/login').send({ email: w.users.s1.email, password: PW })).status).toBe(401);
    expect((await request(w.app).post('/api/auth/login').send({ email: w.users.s1.email, password: 'Brand-New-Pass-77' })).status).toBe(200);
    const unknown = await request(w.app).post('/api/auth/forgot-password').send({ email: 'nobody@test.kellastech.example' });
    expect(unknown.status).toBe(200); expect(unknown.body.dev_token).toBeUndefined();   // no account enumeration
  });
  it('self-registration creates a pending account that cannot sign in until approved', async () => {
    const r = await request(w.app).post('/api/auth/register').send({ email: 'new.student@test.kellastech.example', full_name: 'New Student', password: 'Valid-Passw0rd' });
    expect(r.status).toBe(201);
    const l = await request(w.app).post('/api/auth/login').send({ email: 'new.student@test.kellastech.example', password: 'Valid-Passw0rd' });
    expect(l.status).toBe(403); expect(l.body.error.message).toMatch(/approval/);
    const admin = await w.login('admin'); const u = (await admin.get('/api/users?status=pending')).body.rows[0];
    await admin.patch(`/api/users/${u.id}`, { status: 'active' });
    expect((await request(w.app).post('/api/auth/login').send({ email: 'new.student@test.kellastech.example', password: 'Valid-Passw0rd' })).status).toBe(200);
  });
  it('MFA: required code after enabling', async () => {
    const { code } = await import('../lib/totp.js');
    const inst = await w.login('inst2'); const setup = await inst.post('/api/auth/mfa/setup', {});
    const now = w.now().getTime();
    expect((await inst.post('/api/auth/mfa/enable', { code: code(setup.body.secret, now) })).status).toBe(200);
    const bare = await request(w.app).post('/api/auth/login').send({ email: w.users.inst2.email, password: PW });
    expect(bare.status).toBe(401); expect(bare.body.error.code).toBe('mfa_required');
    expect((await request(w.app).post('/api/auth/login').send({ email: w.users.inst2.email, password: PW, mfa_code: code(setup.body.secret, now) })).status).toBe(200);
    expect((await request(w.app).post('/api/auth/login').send({ email: w.users.inst2.email, password: PW, mfa_code: '000000' })).status).toBe(401);
  });
});

describe('role-based access control (server-side)', () => {
  it('students cannot reach staff or admin endpoints', async () => {
    const s = await w.login('s3');
    for (const url of ['/api/users', '/api/audit', '/api/admin/dashboard', '/api/courses', '/api/grading/queue', '/api/incidents', '/api/admin/health', '/api/accommodations'])
      expect([401, 403]).toContain((await s.get(url)).status);
    expect((await s.post('/api/courses', { title: 'Hack course' })).status).toBe(403);
    expect((await s.post('/api/catalogue/sync', { data: [], dry_run: false })).status).toBe(403);
  });
  it('instructors cannot use admin powers; admins cannot change roles or create admins; only super admin can', async () => {
    const i = await w.login('inst'); expect((await i.get('/api/users')).status).toBe(403); expect((await i.get('/api/audit')).status).toBe(403);
    expect((await i.put('/api/roles/student/permissions', { permissions: ['user.read'] })).status).toBe(403);
    const a = await w.login('admin');
    expect((await a.post('/api/users', { email: 'x@test.kellastech.example', full_name: 'X Admin', role_key: 'admin' })).status).toBe(403);
    expect((await a.patch(`/api/users/${w.users.inst.id}`, { role_key: 'admin' })).status).toBe(403);
    const sup = await w.login('super');
    const c = await sup.post('/api/users', { email: 'x2@test.kellastech.example', full_name: 'X Two', role_key: 'admin' });
    expect(c.status).toBe(201); expect(c.body.setup_link).toMatch(/accept-invite\?token=/);
    expect((await sup.patch(`/api/users/${w.users.super.id}`, { role_key: 'student' })).status).toBe(400);   // cannot demote yourself
  });
  it('permission changes take effect on the next request', async () => {
    const sup = await w.login('super'); const i = await w.login('inst');
    expect((await i.get('/api/grading-scales')).status).toBe(200);
    const roles = (await sup.get('/api/roles')).body.roles.find((r) => r.key === 'instructor').permissions;
    await sup.put('/api/roles/instructor/permissions', { permissions: roles.filter((p) => p !== 'announcement.manage') });
    const { courseId } = await setupCourse(w, { title: 'Perm Test Course' });
    expect((await i.post(`/api/courses/${courseId}/announcements`, { title: 'Hello', body: 'Welcome all' })).status).toBe(403);
    await sup.put('/api/roles/instructor/permissions', { permissions: roles });
    expect((await i.post(`/api/courses/${courseId}/announcements`, { title: 'Hello', body: 'Welcome all' })).status).toBe(201);
  });
  it('writes audit events for authentication and admin actions', async () => {
    const sup = await w.login('super'); const log = (await sup.get('/api/audit?limit=500')).body.rows.map((x) => x.action);
    for (const a of ['auth.login', 'auth.login_failed', 'auth.password_reset', 'user.suspended', 'role.permissions_changed']) expect(log).toContain(a);
    expect(JSON.stringify((await sup.get('/api/audit?limit=500')).body)).not.toContain(PW);   // no secrets in the log
  });
});
