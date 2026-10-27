import request from 'supertest';
import pg from 'pg';
import { createApp } from '../app.js';

let dbCounter = 0;
// TEST_DATABASE_URL=postgresql://user:pw@localhost/postgres  -> run the suite on a real PostgreSQL server via the production `pg` driver.
async function freshDatabaseEnv() {
  const admin = process.env.TEST_DATABASE_URL; if (!admin) return { PGLITE_DIR: '' };
  const name = `kt_test_${process.pid}_${Date.now()}_${dbCounter++}`;
  const c = new pg.Client({ connectionString: admin }); await c.connect(); await c.query(`create database ${name}`); await c.end();
  const u = new URL(admin); u.pathname = '/' + name;
  return { DATABASE_URL: u.toString(), DATABASE_SSL: 'disable', DB_POOL_MAX: '8' };
}
import { hashPassword } from '../lib/password.js';

export const PW = 'Correct-Horse-9';
export async function makeWorld() {
  let t = new Date('2026-11-02T09:00:00.000Z');
  const clock = () => new Date(t);
  const advance = (sec) => { t = new Date(t.getTime() + sec * 1000); };
  const app = await createApp({ env: { NODE_ENV: 'test', ...(await freshDatabaseEnv()), EXPOSE_DEV_TOKENS: 'true', SELF_REGISTRATION: 'approval', UPLOAD_DIR: '.data/test-uploads-' + process.pid }, clock });
  const { db } = app.ctx;
  const hash = await hashPassword(PW);
  const users = {};
  const mk = async (key, role, name, extra = {}) => {
    const email = `${key}@test.kellastech.example`;
    const u = (await db.query("insert into users(email,password_hash,full_name,role_key,status,student_number,created_at,updated_at) values($1,$2,$3,$4,'active',$5,$6,$6) returning *", [email, hash, name, role, extra.student_number || null, clock()])).rows[0];
    users[key] = { ...u, email };
    return users[key];
  };
  await mk('super', 'super_admin', 'Sam Super'); await mk('admin', 'admin', 'Ada Admin');
  await mk('inst', 'instructor', 'Ivy Instructor'); await mk('inst2', 'instructor', 'Ian Other'); await mk('ta', 'teaching_assistant', 'Tia Assistant');
  await mk('s1', 'student', 'Stu One', { student_number: 'KT-001' }); await mk('s2', 'student', 'Stu Two', { student_number: 'KT-002' }); await mk('s3', 'student', 'Stu Three', { student_number: 'KT-003' });

  // returns a client that keeps its cookie jar and CSRF token
  const login = async (key, password = PW) => {
    const agent = request.agent(app);
    const r = await agent.post('/api/auth/login').send({ email: users[key].email, password });
    if (r.status !== 200) throw new Error(`login ${key} failed: ${r.status} ${JSON.stringify(r.body)}`);
    const csrf = r.body.csrf;
    const wrapM = (m) => (url, body) => { const q = agent[m](url).set('X-CSRF-Token', csrf); return body === undefined ? q : q.send(body); };
    return { agent, csrf, user: r.body.user, get: (u) => agent.get(u), post: wrapM('post'), put: wrapM('put'), patch: wrapM('patch'), del: wrapM('delete') };
  };
  return { app, db, ctx: app.ctx, users, login, clock, advance, now: () => new Date(t), iso: (offsetSec = 0) => new Date(t.getTime() + offsetSec * 1000).toISOString() };
}

// Builds: course (via catalogue import) + term + offering + staff + enrolments. Returns ids.
export async function setupCourse(w, { enrol = ['s1', 's2'], title = 'Python Programming', staff = 'inst' } = {}) {
  const admin = await w.login('admin');
  const sync = await admin.post('/api/catalogue/sync', { source: 'test', verified: true, dry_run: false, data: [{ id: `c-${title}`, title, description: 'desc', category: 'Programming', level: 'Beginner' }] });
  if (sync.status !== 200) throw new Error(JSON.stringify(sync.body));
  const course = (await admin.get(`/api/courses?q=${encodeURIComponent(title)}`)).body.rows[0];
  const term = (await w.db.one("select * from terms limit 1")) || (await admin.post('/api/terms', { name: 'Semester 1', academic_year: '2026/2027' })).body;
  const off = (await admin.post('/api/offerings', { course_id: course.id, term_id: term.id })).body;
  await admin.post(`/api/offerings/${off.id}/staff`, { user_id: w.users[staff].id, staff_role: 'instructor' });
  await admin.post(`/api/offerings/${off.id}/enrolments`, { student_ids: enrol.map((k) => w.users[k].id) });
  return { courseId: course.id, offeringId: off.id };
}
export const mcq = (stem = 'What is 2 + 2?', marks = 2) => ({ type: 'mcq', stem, marks, options: [{ text: '3' }, { text: '4', is_correct: true }, { text: '5' }] });
export async function approvedQuestion(inst, courseId, body) {
  const c = await inst.post(`/api/courses/${courseId}/questions`, body); if (c.status !== 201) throw new Error('create q: ' + JSON.stringify(c.body));
  await inst.post(`/api/questions/${c.body.id}/submit`, {}); const a = await inst.post(`/api/questions/${c.body.id}/approve`, {}); if (a.status !== 200) throw new Error('approve q: ' + JSON.stringify(a.body));
  return c.body;
}
