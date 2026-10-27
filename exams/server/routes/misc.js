import { Router } from 'express';
import { z } from 'zod';
import { wrap, bad, notFound, forbidden } from '../lib/errors.js';
import { need, needRole, parse, staffOnly } from '../middleware.js';
import { needUuid, pageParams, toCsv } from '../lib/util.js';
import { requireCourse, courseIdsFor } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { j } from '../db/index.js';

const r = Router();

r.get('/categories', wrap(async (req, res) => res.json({ rows: (await req.ctx.db.query('select * from assessment_categories order by sort_order')).rows })));
r.put('/categories/:key', need('config.manage'), wrap(async (req, res) => {
  const b = parse(z.object({ enabled: z.boolean().optional(), requires_approval: z.boolean().optional(), timed_by_default: z.boolean().optional(), label: z.string().max(100).optional() }), req.body);
  const sets = [], p = [req.params.key]; for (const [k, v] of Object.entries(b)) { p.push(v); sets.push(`${k}=$${p.length}`); }
  if (!sets.length) throw bad('Nothing to change.');
  const row = (await req.ctx.db.query(`update assessment_categories set ${sets.join(',')} where key=$1 returning *`, p)).rows[0]; if (!row) throw notFound();
  await audit(req.ctx.db, req.ctx, { actor: req.user, action: 'config.category', entity: 'category', id: row.key, meta: b, req }); res.json(row);
}));
r.get('/grading-scales', staffOnly, wrap(async (req, res) => res.json({ rows: (await req.ctx.db.query('select * from grading_scales order by name')).rows })));
r.post('/grading-scales', need('config.manage'), wrap(async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(2).max(80), bands: z.array(z.object({ min: z.number().min(0).max(100), label: z.string().max(10) })).min(2).max(20), is_default: z.boolean().default(false) }), req.body);
  if (!b.bands.some((x) => x.min === 0)) throw bad('A band must start at 0.');
  const row = await req.ctx.db.tx(async (q) => { if (b.is_default) await q.query('update grading_scales set is_default=false'); const x = (await q.query('insert into grading_scales(name,bands,is_default) values($1,$2::jsonb,$3) returning *', [b.name, j(b.bands), b.is_default])).rows[0]; await audit(q, req.ctx, { actor: req.user, action: 'config.grading_scale', entity: 'grading_scale', id: x.id, req }); return x; });
  res.status(201).json(row);
}));
r.get('/config', staffOnly, wrap(async (req, res) => res.json(Object.fromEntries((await req.ctx.db.query('select key,value from system_config')).rows.map((x) => [x.key, x.value])))));
r.put('/config/:key', need('config.manage'), wrap(async (req, res) => {
  if (!['institution', 'policies'].includes(req.params.key)) throw bad('Unknown configuration key.');
  const value = parse(z.record(z.any()), req.body);
  await req.ctx.db.query('insert into system_config(key,value,updated_at) values($1,$2::jsonb,$3) on conflict (key) do update set value=excluded.value, updated_at=excluded.updated_at', [req.params.key, j(value), req.ctx.now()]);
  await audit(req.ctx.db, req.ctx, { actor: req.user, action: 'config.update', entity: 'config', id: req.params.key, req }); res.json(value);
}));

// ---------- announcements ----------
r.post('/courses/:cid/announcements', staffOnly, need('announcement.manage'), wrap(async (req, res) => {
  const { ctx } = req; const cid = needUuid(req.params.cid); await requireCourse(ctx, req.user, cid, { write: true });
  const b = parse(z.object({ title: z.string().trim().min(3).max(160), body: z.string().trim().min(3).max(5000), offering_id: z.string().uuid().optional() }), req.body);
  const row = (await ctx.db.query('insert into announcements(course_id,offering_id,title,body,author_id,published_at) values($1,$2,$3,$4,$5,$6) returning *', [cid, b.offering_id || null, b.title, b.body, req.user.id, ctx.now()])).rows[0];
  await audit(ctx.db, ctx, { actor: req.user, action: 'announcement.create', entity: 'announcement', id: row.id, req }); res.status(201).json(row);
}));
r.get('/announcements', wrap(async (req, res) => {
  const { ctx } = req; let rows;
  if (req.user.role_key === 'student') rows = (await ctx.db.query(`select an.id,an.title,an.body,an.published_at,c.title as course_title,u.full_name as author, (r.user_id is not null) as read from announcements an join courses c on c.id=an.course_id join users u on u.id=an.author_id
    left join announcement_reads r on r.announcement_id=an.id and r.user_id=$1
    where an.published_at <= $2 and (an.course_id in (select o.course_id from enrolments e join course_offerings o on o.id=e.offering_id where e.student_id=$1 and e.status='active')) and (an.offering_id is null or an.offering_id in (select offering_id from enrolments where student_id=$1 and status='active')) order by an.published_at desc limit 100`, [req.user.id, ctx.now()])).rows;
  else { const scope = await courseIdsFor(ctx.db, req.user); rows = (await ctx.db.query(`select an.id,an.title,an.body,an.published_at,c.title as course_title,u.full_name as author from announcements an join courses c on c.id=an.course_id join users u on u.id=an.author_id where ($1::uuid[] is null or an.course_id = any($1::uuid[])) order by an.published_at desc limit 100`, [scope])).rows; }
  res.json({ rows });
}));
r.post('/announcements/:id/read', needRole('student'), wrap(async (req, res) => { await req.ctx.db.query('insert into announcement_reads(announcement_id,user_id,read_at) values($1,$2,$3) on conflict do nothing', [needUuid(req.params.id), req.user.id, req.ctx.now()]); res.json({ ok: true }); }));

// ---------- incidents & disputes ----------
r.post('/incidents', needRole('student'), wrap(async (req, res) => {
  const { ctx } = req;
  const b = parse(z.object({ kind: z.enum(['technical', 'dispute', 'accessibility']).default('technical'), description: z.string().trim().min(10).max(3000), attempt_id: z.string().uuid().optional(), assessment_id: z.string().uuid().optional() }), req.body);
  let aid = b.assessment_id || null;
  if (b.attempt_id) { const t = await ctx.db.one('select assessment_id from attempts where id=$1 and student_id=$2', [b.attempt_id, req.user.id]); if (!t) throw notFound('Attempt not found.'); aid = t.assessment_id; }
  const row = (await ctx.db.query('insert into incidents(reporter_id,assessment_id,attempt_id,kind,description,created_at) values($1,$2,$3,$4,$5,$6) returning id,kind,status,created_at', [req.user.id, aid, b.attempt_id || null, b.kind, b.description, ctx.now()])).rows[0];
  if (b.attempt_id) await ctx.db.query("insert into attempt_events(attempt_id,type,meta,created_at) values($1,'incident_reported',$2::jsonb,$3)", [b.attempt_id, j({ incident_id: row.id }), ctx.now()]);
  await audit(ctx.db, ctx, { actor: req.user, action: 'incident.create', entity: 'incident', id: row.id, meta: { kind: b.kind }, req }); res.status(201).json(row);
}));
r.get('/me/incidents', needRole('student'), wrap(async (req, res) => res.json({ rows: (await req.ctx.db.query('select id,kind,status,description,resolution,created_at,resolved_at from incidents where reporter_id=$1 order by created_at desc', [req.user.id])).rows })));
r.get('/incidents', staffOnly, need('incident.manage'), wrap(async (req, res) => res.json({ rows: (await req.ctx.db.query(`select i.*, u.full_name as reporter, a.title as assessment_title from incidents i join users u on u.id=i.reporter_id left join assessments a on a.id=i.assessment_id where ($1::text is null or i.status=$1) order by i.created_at desc limit 200`, [req.query.status || null])).rows })));
r.patch('/incidents/:id', staffOnly, need('incident.manage'), wrap(async (req, res) => {
  const b = parse(z.object({ status: z.enum(['investigating', 'resolved', 'dismissed']), resolution: z.string().trim().max(3000).optional() }), req.body);
  if (['resolved', 'dismissed'].includes(b.status) && !(b.resolution?.length >= 5)) throw bad('Record the resolution (5+ characters).');
  const row = (await req.ctx.db.query('update incidents set status=$2, resolution=coalesce($3,resolution), resolved_by=$4, resolved_at=case when $2 in (\'resolved\',\'dismissed\') then $5 end where id=$1 returning *', [needUuid(req.params.id), b.status, b.resolution || null, req.user.id, req.ctx.now()])).rows[0]; if (!row) throw notFound();
  await audit(req.ctx.db, req.ctx, { actor: req.user, action: 'incident.update', entity: 'incident', id: row.id, meta: b, req }); res.json(row);
}));

// ---------- audit log ----------
r.get('/audit', staffOnly, need('audit.read'), wrap(async (req, res) => {
  const { ctx } = req; const { limit, offset } = pageParams(req.query, 50, 1000); const w = [], p = [];
  if (req.query.action) { p.push(`${req.query.action}%`); w.push(`action like $${p.length}`); }
  if (req.query.actor_id) { p.push(needUuid(req.query.actor_id)); w.push(`actor_id=$${p.length}`); }
  if (req.query.entity_id) { p.push(String(req.query.entity_id)); w.push(`entity_id=$${p.length}`); }
  const where = w.length ? 'where ' + w.join(' and ') : '';
  const rows = (await ctx.db.query(`select id,actor_label,action,entity_type,entity_id,meta,created_at from audit_events ${where} order by created_at desc limit ${limit} offset ${offset}`, p)).rows;
  if (req.query.format === 'csv') return res.type('text/csv').attachment('audit.csv').send(toCsv([['When', 'Actor', 'Action', 'Entity', 'Entity id', 'Details'], ...rows.map((x) => [x.created_at, x.actor_label, x.action, x.entity_type, x.entity_id, JSON.stringify(x.meta)])]));
  res.json({ rows, total: (await ctx.db.one(`select count(*)::int as n from audit_events ${where}`, p)).n });
}));

// ---------- dashboards (real metrics only) ----------
r.get('/admin/dashboard', staffOnly, need('course.read_all'), wrap(async (req, res) => {
  const { ctx } = req; const c = async (sql, p = []) => (await ctx.db.one(sql, p)).n; const now = ctx.now();
  res.json({
    courses: await c("select count(*)::int as n from courses where status='active'"),
    active_students: await c("select count(*)::int as n from users where role_key='student' and status='active'"),
    active_instructors: await c("select count(*)::int as n from users where role_key in ('instructor','teaching_assistant') and status='active'"),
    pending_accounts: await c("select count(*)::int as n from users where status='pending'"),
    enrolments: await c("select count(*)::int as n from enrolments where status='active'"),
    enrolment_requests: await c("select count(*)::int as n from enrolments where status='requested'"),
    upcoming_exams: await c("select count(*)::int as n from assessments where status in ('scheduled','published') and opens_at > $1", [now]),
    ongoing_sessions: await c("select count(*)::int as n from attempts where status='in_progress' and deadline_at > $1", [now]),
    completed_assessments: await c("select count(*)::int as n from assessments where status in ('closed','graded','results_released')"),
    awaiting_grading: await c("select count(*)::int as n from attempts where status<>'in_progress' and grading_status='awaiting_manual'"),
    awaiting_release: await c("select count(*)::int as n from assessments where status='graded'"),
    pending_approvals: await c("select count(*)::int as n from assessments where status='pending_review'"),
    open_incidents: await c("select count(*)::int as n from incidents where status in ('open','investigating')"),
    recent_activity: (await ctx.db.query('select actor_label, action, entity_type, created_at from audit_events order by created_at desc limit 12')).rows
  });
}));
r.get('/instructor/dashboard', staffOnly, wrap(async (req, res) => {
  const { ctx } = req; const scope = await courseIdsFor(ctx.db, req.user); const now = ctx.now();
  const p = [scope];
  const courses = (await ctx.db.query(`select c.id,c.title,(select count(distinct e.student_id)::int from enrolments e join course_offerings o on o.id=e.offering_id where o.course_id=c.id and e.status='active') as students,
    (select count(*)::int from questions q where q.course_id=c.id and q.status='approved') as approved_questions,(select count(*)::int from questions q where q.course_id=c.id and q.status='in_review') as questions_in_review
    from courses c where $1::uuid[] is null or c.id = any($1::uuid[]) order by c.title`, p)).rows;
  const sc = scope ? 'a.course_id = any($1::uuid[])' : '$1::uuid[] is null';
  res.json({
    courses,
    drafts: (await ctx.db.one(`select count(*)::int as n from assessments a where ${sc} and a.status in ('draft','pending_review','approved')`, p)).n,
    live: (await ctx.db.one(`select count(*)::int as n from assessments a where ${sc} and a.status in ('scheduled','published','in_progress')`, p)).n,
    active_sessions: (await ctx.db.one(`select count(*)::int as n from attempts t join assessments a on a.id=t.assessment_id where ${sc} and t.status='in_progress' and t.deadline_at > $2`, [scope, now])).n,
    awaiting_grading: (await ctx.db.one(`select count(*)::int as n from attempts t join assessments a on a.id=t.assessment_id where ${sc} and t.status<>'in_progress' and t.grading_status='awaiting_manual'`, p)).n
  });
}));
r.get('/admin/health', staffOnly, need('system.health'), wrap(async (req, res) => {
  const { ctx } = req; const stale = new Date(ctx.now().getTime() - ctx.config.saveGraceSeconds * 1000);
  res.json({
    database: ctx.db.kind, storage: ctx.storage.kind, time: ctx.now(), timezone: 'Africa/Accra',
    migrations: (await ctx.db.query('select name from schema_migrations order by name')).rows.map((x) => x.name),
    expired_unfinalized_attempts: (await ctx.db.one("select count(*)::int as n from attempts where status='in_progress' and deadline_at < $1", [stale])).n,
    failed_emails: (await ctx.db.one("select count(*)::int as n from outbox where status='failed'")).n, queued_emails: (await ctx.db.one("select count(*)::int as n from outbox where status='queued'")).n,
    mail_provider: ctx.config.resendKey ? 'resend' : 'none (links must be delivered manually)', mfa_required_for_admins: ctx.config.requireMfaForPrivileged, self_registration: ctx.config.selfRegistration
  });
}));
r.get('/admin/outbox', need('config.manage'), wrap(async (req, res) => res.json({ rows: (await req.ctx.db.query('select id,to_email,subject,body,status,error,created_at from outbox order by created_at desc limit 100')).rows })));
export default r;
