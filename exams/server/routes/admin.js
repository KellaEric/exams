import { Router } from 'express';
import { z } from 'zod';
import { wrap, bad, forbidden, notFound, conflict } from '../lib/errors.js';
import { need, needAny, parse, staffOnly } from '../middleware.js';
import { PERMISSIONS, ROLES } from '../lib/permissions.js';
import { audit } from '../lib/audit.js';
import { randomToken, sha256, needUuid, pageParams, slugify } from '../lib/util.js';
import { sendMail } from '../lib/mailer.js';
import { j } from '../db/index.js';
import { requireCourse } from '../lib/access.js';

const r = Router();
const email = z.string().trim().toLowerCase().email().max(200);
const userCols = 'id,email,full_name,role_key,status,student_number,phone,last_login_at,created_at,mfa_enabled';

// ---------------- Users ----------------
r.get('/users', need('user.read'), wrap(async (req, res) => {
  const { limit, offset } = pageParams(req.query); const w = [], p = [];
  if (req.query.role) { p.push(req.query.role); w.push(`role_key=$${p.length}`); }
  if (req.query.status) { p.push(req.query.status); w.push(`status=$${p.length}`); }
  if (req.query.q) { p.push(`%${String(req.query.q).toLowerCase()}%`); w.push(`(lower(full_name) like $${p.length} or lower(email) like $${p.length} or lower(coalesce(student_number,'')) like $${p.length})`); }
  const where = w.length ? 'where ' + w.join(' and ') : '';
  const total = (await req.ctx.db.one(`select count(*)::int as n from users ${where}`, p)).n;
  const rows = (await req.ctx.db.query(`select ${userCols} from users ${where} order by created_at desc limit ${limit} offset ${offset}`, p)).rows;
  res.json({ total, rows });
}));

async function issueToken(ctx, userId, purpose, hours) {
  const token = randomToken(32);
  await ctx.db.query('insert into auth_tokens(user_id,purpose,token_hash,expires_at,created_at) values($1,$2,$3,$4,$5)', [userId, purpose, sha256(token), new Date(ctx.now().getTime() + hours * 3600000), ctx.now()]);
  return token;
}

r.post('/users', need('user.manage'), wrap(async (req, res) => {
  const { ctx } = req;
  const b = parse(z.object({ email, full_name: z.string().trim().min(2).max(120), role_key: z.string(), student_number: z.string().trim().max(40).optional(), phone: z.string().trim().max(30).optional() }), req.body);
  if (!ROLES[b.role_key]) throw bad('Unknown role.');
  if (['admin', 'super_admin'].includes(b.role_key) && !req.user.perms.has('role.manage')) throw forbidden('Only a super administrator can create administrator accounts.');
  const u = (await ctx.db.query("insert into users(email,full_name,role_key,status,student_number,phone,created_by,created_at,updated_at) values($1,$2,$3,'invited',$4,$5,$6,$7,$7) returning " + userCols, [b.email, b.full_name, b.role_key, b.student_number || null, b.phone || null, req.user.id, ctx.now()])).rows[0];
  const token = await issueToken(ctx, u.id, 'invite', 72);
  const link = `${ctx.config.publicUrl}/accept-invite?token=${token}`;
  await sendMail(ctx, { to: u.email, subject: 'You have been invited to the KellasTech Examination Portal', body: `Hello ${u.full_name},\n\nSet your password here (valid 72 hours): ${link}\n` });
  await audit(ctx.db, ctx, { actor: req.user, action: 'user.create', entity: 'user', id: u.id, meta: { role: u.role_key }, req });
  res.status(201).json({ user: u, setup_link: link });      // shown once to the admin so they can deliver it if email is not configured
}));

r.patch('/users/:id', needAny('user.manage', 'user.approve'), wrap(async (req, res) => {
  const { ctx } = req; const id = needUuid(req.params.id);
  const b = parse(z.object({ full_name: z.string().trim().min(2).max(120).optional(), phone: z.string().max(30).nullable().optional(), student_number: z.string().max(40).nullable().optional(), status: z.enum(['active', 'suspended', 'deactivated']).optional(), role_key: z.string().optional() }), req.body);
  const u = await ctx.db.one('select * from users where id=$1', [id]);
  if (!u) throw notFound('User not found.');
  const isAdminAcct = ['admin', 'super_admin'].includes(u.role_key);
  if (isAdminAcct && !req.user.perms.has('role.manage')) throw forbidden('Only a super administrator can change administrator accounts.');
  const changes = { ...b };
  if (b.status && !req.user.perms.has('user.approve')) throw forbidden();
  if ((b.full_name || b.phone !== undefined || b.student_number !== undefined) && !req.user.perms.has('user.manage')) throw forbidden();
  if (b.status && id === req.user.id) throw bad('You cannot change your own status.');
  if (b.role_key && b.role_key !== u.role_key) {
    if (!req.user.perms.has('role.manage')) throw forbidden('Only a super administrator can change roles.');
    if (!ROLES[b.role_key]) throw bad('Unknown role.');
    if (id === req.user.id) throw bad('You cannot change your own role.');
    if (u.role_key === 'super_admin' && (await ctx.db.one("select count(*)::int as n from users where role_key='super_admin' and status='active'")).n <= 1) throw conflict('You cannot remove the last super administrator.');
  }
  await ctx.db.tx(async (q) => {
    const sets = [], p = [id]; for (const [k, v] of Object.entries(changes)) { if (v === undefined) continue; p.push(v); sets.push(`${k}=$${p.length}`); }
    if (!sets.length) return;
    p.push(ctx.now()); sets.push(`updated_at=$${p.length}`);
    await q.query(`update users set ${sets.join(', ')} where id=$1`, p);
    if (b.status && b.status !== 'active' || (b.role_key && b.role_key !== u.role_key)) await q.query('update sessions set revoked_at=$2 where user_id=$1 and revoked_at is null', [id, ctx.now()]);   // access revoked immediately
    await audit(q, ctx, { actor: req.user, action: b.status ? `user.${b.status === 'active' ? 'activate' : b.status}` : b.role_key ? 'user.role_change' : 'user.update', entity: 'user', id, meta: { before: { status: u.status, role: u.role_key }, changes }, req });
  });
  res.json({ user: await ctx.db.one(`select ${userCols} from users where id=$1`, [id]) });
}));

r.post('/users/:id/reset-link', need('user.manage'), wrap(async (req, res) => {
  const { ctx } = req; const id = needUuid(req.params.id);
  const u = await ctx.db.one('select * from users where id=$1', [id]); if (!u) throw notFound('User not found.');
  if (['admin', 'super_admin'].includes(u.role_key) && !req.user.perms.has('role.manage')) throw forbidden();
  const token = await issueToken(ctx, u.id, u.status === 'invited' ? 'invite' : 'reset', u.status === 'invited' ? 72 : 1);
  await audit(ctx.db, ctx, { actor: req.user, action: 'user.reset_link_issued', entity: 'user', id, req });
  res.json({ link: `${ctx.config.publicUrl}/${u.status === 'invited' ? 'accept-invite' : 'reset'}?token=${token}` });
}));

// ---------------- Roles & permissions ----------------
r.get('/roles', staffOnly, wrap(async (req, res) => {
  const roles = (await req.ctx.db.query('select key,label from roles order by key')).rows;
  const rp = (await req.ctx.db.query('select role_key, permission_key from role_permissions')).rows;
  res.json({ roles: roles.map((x) => ({ ...x, permissions: rp.filter((y) => y.role_key === x.key).map((y) => y.permission_key).sort() })), catalogue: PERMISSIONS });
}));
r.put('/roles/:key/permissions', need('role.manage'), wrap(async (req, res) => {
  const { ctx } = req; const b = parse(z.object({ permissions: z.array(z.string()).max(60) }), req.body);
  if (req.params.key === 'super_admin') throw forbidden('The super administrator role is fixed.');
  if (!(await ctx.db.one('select 1 as x from roles where key=$1', [req.params.key]))) throw notFound('Unknown role.');
  const bad1 = b.permissions.filter((p) => !PERMISSIONS[p]); if (bad1.length) throw bad(`Unknown permissions: ${bad1.join(', ')}`);
  await ctx.db.tx(async (q) => {
    await q.query('delete from role_permissions where role_key=$1', [req.params.key]);
    for (const p of b.permissions) await q.query('insert into role_permissions(role_key,permission_key) values($1,$2)', [req.params.key, p]);
    await audit(q, ctx, { actor: req.user, action: 'role.permissions_changed', entity: 'role', id: req.params.key, meta: { permissions: b.permissions }, req });
  });
  res.json({ ok: true });
}));

// ---------------- Organisation: departments, programmes, terms, cohorts ----------------
const simple = (table, schema, extra = '') => {
  r.get(`/${table}`, staffOnly, wrap(async (req, res) => res.json({ rows: (await req.ctx.db.query(`select * from ${table} ${extra} order by 1 limit 500`)).rows })));
  r.post(`/${table}`, need('org.manage'), wrap(async (req, res) => {
    const b = parse(schema, req.body); const cols = Object.keys(b);
    if (['departments', 'programmes'].includes(table)) { cols.push('slug'); b.slug = slugify(b.name); }
    const row = (await req.ctx.db.query(`insert into ${table}(${cols.join(',')}) values(${cols.map((_, i) => `$${i + 1}`).join(',')}) returning *`, cols.map((c) => b[c]))).rows[0];
    await audit(req.ctx.db, req.ctx, { actor: req.user, action: `${table}.create`, entity: table, id: row.id, meta: b, req });
    res.status(201).json(row);
  }));
};
const optUuid = z.string().uuid().nullable().optional();
simple('departments', z.object({ name: z.string().trim().min(2).max(120), description: z.string().max(500).optional() }));
simple('programmes', z.object({ name: z.string().trim().min(2).max(120), department_id: optUuid, description: z.string().max(500).optional() }));
simple('terms', z.object({ name: z.string().trim().min(1).max(80), academic_year: z.string().trim().min(4).max(20), starts_on: z.string().optional(), ends_on: z.string().optional() }));
simple('cohorts', z.object({ name: z.string().trim().min(1).max(120), programme_id: optUuid, term_id: optUuid }));

// ---------------- Offerings, staff, enrolments ----------------
r.get('/offerings', staffOnly, wrap(async (req, res) => {
  const { ctx } = req; const w = [], p = [];
  if (!req.user.perms.has('course.read_all')) { p.push(req.user.id); w.push(`o.id in (select offering_id from offering_staff where user_id=$${p.length})`); }
  if (req.query.course_id) { p.push(needUuid(req.query.course_id)); w.push(`o.course_id=$${p.length}`); }
  const rows = (await ctx.db.query(`select o.*, c.title as course_title, t.name as term_name, t.academic_year, ch.name as cohort_name,
    (select count(*)::int from enrolments e where e.offering_id=o.id and e.status='active') as students,
    (select coalesce(json_agg(json_build_object('user_id',u.id,'name',u.full_name,'staff_role',s.staff_role)),'[]'::json) from offering_staff s join users u on u.id=s.user_id where s.offering_id=o.id) as staff
    from course_offerings o join courses c on c.id=o.course_id left join terms t on t.id=o.term_id left join cohorts ch on ch.id=o.cohort_id ${w.length ? 'where ' + w.join(' and ') : ''} order by o.created_at desc limit 500`, p)).rows;
  res.json({ rows });
}));
r.post('/offerings', need('org.manage'), wrap(async (req, res) => {
  const b = parse(z.object({ course_id: z.string().uuid(), term_id: optUuid, cohort_id: optUuid, label: z.string().max(120).optional() }), req.body);
  if (!(await req.ctx.db.one('select 1 as x from courses where id=$1', [b.course_id]))) throw notFound('Course not found.');
  const row = (await req.ctx.db.query('insert into course_offerings(course_id,term_id,cohort_id,label,created_at) values($1,$2,$3,$4,$5) returning *', [b.course_id, b.term_id || null, b.cohort_id || null, b.label || null, req.ctx.now()])).rows[0];
  await audit(req.ctx.db, req.ctx, { actor: req.user, action: 'offering.create', entity: 'offering', id: row.id, meta: b, req });
  res.status(201).json(row);
}));
r.post('/offerings/:id/staff', need('staff.assign'), wrap(async (req, res) => {
  const { ctx } = req; const id = needUuid(req.params.id);
  const b = parse(z.object({ user_id: z.string().uuid(), staff_role: z.enum(['instructor', 'teaching_assistant']) }), req.body);
  const u = await ctx.db.one('select role_key,status from users where id=$1', [b.user_id]); if (!u) throw notFound('User not found.');
  if (u.status !== 'active') throw bad('The user account is not active.');
  if (!['instructor', 'teaching_assistant', 'admin', 'super_admin'].includes(u.role_key)) throw bad('Only staff accounts can be assigned.');
  if (b.staff_role === 'instructor' && u.role_key === 'teaching_assistant') throw bad('A teaching assistant account cannot be assigned as instructor.');
  await ctx.db.query('insert into offering_staff(offering_id,user_id,staff_role) values($1,$2,$3) on conflict (offering_id,user_id) do update set staff_role=excluded.staff_role', [id, b.user_id, b.staff_role]);
  await audit(ctx.db, ctx, { actor: req.user, action: 'staff.assign', entity: 'offering', id, meta: b, req }); res.status(201).json({ ok: true });
}));
r.delete('/offerings/:id/staff/:userId', need('staff.assign'), wrap(async (req, res) => {
  await req.ctx.db.query('delete from offering_staff where offering_id=$1 and user_id=$2', [needUuid(req.params.id), needUuid(req.params.userId)]);
  await audit(req.ctx.db, req.ctx, { actor: req.user, action: 'staff.unassign', entity: 'offering', id: req.params.id, meta: { user_id: req.params.userId }, req }); res.json({ ok: true });
}));
r.post('/offerings/:id/enrolments', need('enrolment.manage'), wrap(async (req, res) => {
  const { ctx } = req; const id = needUuid(req.params.id);
  const b = parse(z.object({ student_ids: z.array(z.string().uuid()).max(500).optional(), student_emails: z.array(email).max(500).optional() }), req.body);
  if (!(await ctx.db.one("select 1 as x from course_offerings where id=$1 and status in ('planned','open')", [id]))) throw notFound('Open offering not found.');
  const ids = [...(b.student_ids || [])];
  const missing = [];
  for (const e of b.student_emails || []) { const u = await ctx.db.one("select id from users where lower(email)=$1 and role_key='student'", [e]); if (u) ids.push(u.id); else missing.push(e); }
  let enrolled = 0;
  await ctx.db.tx(async (q) => {
    for (const sid of new Set(ids)) {
      const ok = (await q.query("select 1 from users where id=$1 and role_key='student' and status='active'", [sid])).rowCount;
      if (!ok) { missing.push(sid); continue; }
      await q.query("insert into enrolments(offering_id,student_id,status,enrolled_at) values($1,$2,'active',$3) on conflict (offering_id,student_id) do update set status='active'", [id, sid, ctx.now()]); enrolled++;
    }
    await audit(q, ctx, { actor: req.user, action: 'enrolment.create', entity: 'offering', id, meta: { enrolled, missing }, req });
  });
  res.status(201).json({ enrolled, not_found_or_inactive: missing });
}));
r.patch('/enrolments/:id', need('enrolment.manage'), wrap(async (req, res) => {
  const b = parse(z.object({ status: z.enum(['active', 'withdrawn', 'completed']) }), req.body);
  const row = (await req.ctx.db.query('update enrolments set status=$2 where id=$1 returning *', [needUuid(req.params.id), b.status])).rows[0]; if (!row) throw notFound();
  await audit(req.ctx.db, req.ctx, { actor: req.user, action: 'enrolment.update', entity: 'enrolment', id: row.id, meta: b, req }); res.json(row);
}));
r.get('/enrolments/requests', need('enrolment.manage'), wrap(async (req, res) => res.json({ rows: (await req.ctx.db.query(`select e.id, e.enrolled_at, u.full_name, u.email, c.title as course_title, e.offering_id from enrolments e join users u on u.id=e.student_id join course_offerings o on o.id=e.offering_id join courses c on c.id=o.course_id where e.status='requested' order by e.enrolled_at`)).rows })));

// ---------------- Accommodations ----------------
r.get('/accommodations', need('accommodation.manage'), wrap(async (req, res) => res.json({ rows: (await req.ctx.db.query(`select a.*, u.full_name as student_name from accommodations a join users u on u.id=a.student_id where a.revoked_at is null order by a.created_at desc limit 300`)).rows })));
r.post('/accommodations', need('accommodation.manage'), wrap(async (req, res) => {
  const { ctx } = req;
  const b = parse(z.object({ student_id: z.string().uuid(), assessment_id: optUuid, offering_id: optUuid, extra_minutes: z.number().int().min(0).max(600).default(0), allow_late_until: z.string().datetime().optional(), extra_attempts: z.number().int().min(0).max(5).default(0), reason: z.string().trim().min(5).max(500) }), req.body);
  if (!b.assessment_id && !b.offering_id) throw bad('Choose an assessment or an offering.');
  const row = (await ctx.db.query('insert into accommodations(student_id,assessment_id,offering_id,extra_minutes,allow_late_until,extra_attempts,reason,approved_by,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *',
    [b.student_id, b.assessment_id || null, b.offering_id || null, b.extra_minutes, b.allow_late_until ? new Date(b.allow_late_until) : null, b.extra_attempts, b.reason, req.user.id, ctx.now()])).rows[0];
  await audit(ctx.db, ctx, { actor: req.user, action: 'accommodation.create', entity: 'accommodation', id: row.id, meta: { ...b }, req }); res.status(201).json(row);
}));
r.delete('/accommodations/:id', need('accommodation.manage'), wrap(async (req, res) => {
  await req.ctx.db.query('update accommodations set revoked_at=$2 where id=$1', [needUuid(req.params.id), req.ctx.now()]);
  await audit(req.ctx.db, req.ctx, { actor: req.user, action: 'accommodation.revoke', entity: 'accommodation', id: req.params.id, req }); res.json({ ok: true });
}));
export default r;
