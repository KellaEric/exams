import { Router } from 'express';
import { z } from 'zod';
import { wrap, bad, notFound, conflict } from '../lib/errors.js';
import { need, needRole, parse, staffOnly } from '../middleware.js';
import { audit } from '../lib/audit.js';
import { needUuid, pageParams, slugify, normTitle } from '../lib/util.js';
import { requireCourse } from '../lib/access.js';
import { parseCsv, normalizeRecords, runSync, fetchSupabaseCourses } from '../lib/catalogue.js';

const r = Router();
const optUuid = z.string().uuid().nullable().optional();

// readiness = what is still needed before assessments can be created for the course
const READINESS = `case
  when not exists (select 1 from course_offerings o where o.course_id=c.id) then 'awaiting_offering'
  when not exists (select 1 from offering_staff s join course_offerings o on o.id=s.offering_id where o.course_id=c.id and s.staff_role='instructor') then 'awaiting_instructor'
  when not exists (select 1 from questions qq where qq.course_id=c.id and qq.status='approved') then 'awaiting_question_bank'
  else 'ready' end`;

r.get('/courses', staffOnly, wrap(async (req, res) => {
  const { ctx } = req; const { limit, offset } = pageParams(req.query, 50); const w = [], p = [];
  if (!req.user.perms.has('course.read_all')) { p.push(req.user.id); w.push(`c.id in (select o.course_id from offering_staff s join course_offerings o on o.id=s.offering_id where s.user_id=$${p.length})`); }
  if (req.query.status) { p.push(req.query.status); w.push(`c.status=$${p.length}`); }
  if (req.query.q) { p.push(`%${String(req.query.q).toLowerCase()}%`); w.push(`(lower(c.title) like $${p.length} or lower(coalesce(c.code,'')) like $${p.length})`); }
  const where = w.length ? 'where ' + w.join(' and ') : '';
  const total = (await ctx.db.one(`select count(*)::int as n from courses c ${where}`, p)).n;
  const rows = (await ctx.db.query(`select c.id,c.code,c.title,c.slug,c.category,c.level,c.status,c.import_status,c.verified,c.missing_fields,c.last_synced_at, ${READINESS} as readiness,
    (select count(*)::int from course_offerings o where o.course_id=c.id) as offerings,
    (select count(distinct e.student_id)::int from enrolments e join course_offerings o on o.id=e.offering_id where o.course_id=c.id and e.status='active') as students,
    (select count(*)::int from questions qq where qq.course_id=c.id and qq.status='approved') as approved_questions
    from courses c ${where} order by c.title limit ${limit} offset ${offset}`, p)).rows;
  res.json({ total, rows });
}));

r.post('/courses', need('course.manage'), wrap(async (req, res) => {
  const { ctx } = req;
  const b = parse(z.object({ title: z.string().trim().min(3).max(200), code: z.string().trim().max(30).optional(), description: z.string().max(4000).optional(), category: z.string().max(100).optional(), level: z.string().max(40).optional(), department_id: optUuid, programme_id: optUuid }), req.body);
  const norm = normTitle(b.title); let slug = slugify(b.title) || 'course', n = 1;
  while ((await ctx.db.query('select 1 from courses where slug=$1', [slug])).rowCount) slug = `${slugify(b.title)}-${++n}`;
  if (await ctx.db.one('select 1 as x from courses where norm_title=$1', [norm])) throw conflict('A course with this title already exists.', 'duplicate');
  const row = (await ctx.db.query(`insert into courses(code,title,slug,norm_title,description,category,level,department_id,programme_id,source,verified,import_status,created_at,updated_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual',true,'manual',$10,$10) returning *`, [b.code || null, b.title, slug, norm, b.description || null, b.category || null, b.level || null, b.department_id || null, b.programme_id || null, ctx.now()])).rows[0];
  await audit(ctx.db, ctx, { actor: req.user, action: 'course.create', entity: 'course', id: row.id, meta: { title: b.title }, req });
  res.status(201).json(row);
}));

r.get('/courses/:id', staffOnly, wrap(async (req, res) => {
  const { ctx } = req; const id = needUuid(req.params.id); const level = await requireCourse(ctx, req.user, id);
  const c = await ctx.db.one(`select c.*, ${READINESS} as readiness from courses c where c.id=$1`, [id]);
  const offerings = (await ctx.db.query(`select o.*, t.name as term_name, ch.name as cohort_name from course_offerings o left join terms t on t.id=o.term_id left join cohorts ch on ch.id=o.cohort_id where o.course_id=$1`, [id])).rows;
  res.json({ ...c, offerings, access_level: level });
}));
r.patch('/courses/:id', need('course.manage'), wrap(async (req, res) => {
  const { ctx } = req; const id = needUuid(req.params.id);
  const b = parse(z.object({ title: z.string().trim().min(3).max(200).optional(), code: z.string().max(30).nullable().optional(), description: z.string().max(4000).nullable().optional(), category: z.string().max(100).nullable().optional(), level: z.string().max(40).nullable().optional(), status: z.enum(['active', 'inactive', 'archived']).optional(), department_id: optUuid, programme_id: optUuid }), req.body);
  const sets = [], p = [id]; for (const [k, v] of Object.entries(b)) { p.push(v); sets.push(`${k}=$${p.length}`); }
  if (b.title) { p.push(normTitle(b.title)); sets.push(`norm_title=$${p.length}`); }
  if (!sets.length) throw bad('Nothing to update.');
  p.push(ctx.now()); sets.push(`updated_at=$${p.length}`);
  const row = (await ctx.db.query(`update courses set ${sets.join(',')} where id=$1 returning *`, p)).rows[0]; if (!row) throw notFound('Course not found.');
  await audit(ctx.db, ctx, { actor: req.user, action: b.status ? `course.${b.status}` : 'course.update', entity: 'course', id, meta: b, req }); res.json(row);
}));

r.get('/courses/:id/roster', staffOnly, wrap(async (req, res) => {
  const { ctx } = req; const id = needUuid(req.params.id); await requireCourse(ctx, req.user, id);
  const rows = (await ctx.db.query(`select u.id, u.full_name, u.email, u.student_number, e.status, e.offering_id, e.enrolled_at from enrolments e join course_offerings o on o.id=e.offering_id join users u on u.id=e.student_id where o.course_id=$1 order by u.full_name`, [id])).rows;
  res.json({ rows });
}));

// ---------------- Catalogue import ----------------
r.post('/catalogue/sync', need('catalogue.import'), wrap(async (req, res) => {
  const { ctx } = req;
  const b = parse(z.object({ source: z.string().trim().min(2).max(80).default('official-catalogue'), format: z.enum(['json', 'csv', 'supabase']).default('json'), data: z.any().optional(), csv: z.string().max(2_000_000).optional(), dry_run: z.boolean().default(true), verified: z.boolean().default(false), confirm_create: z.array(z.number().int()).max(500).default([]) }), req.body);
  let raw;
  if (b.format === 'csv') raw = parseCsv(b.csv || '');
  else if (b.format === 'supabase') {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) throw bad('SUPABASE_URL and SUPABASE_ANON_KEY are not configured on the server.');
    try { raw = await fetchSupabaseCourses({ url: process.env.SUPABASE_URL, anonKey: process.env.SUPABASE_ANON_KEY, table: process.env.SUPABASE_COURSES_TABLE || 'courses' }); } catch (e) { throw bad(`Could not read the catalogue: ${e.message}`); }
  } else raw = b.data;
  const records = normalizeRecords(raw).map((x) => ({ ...x, verified: b.verified || x.verified }));
  res.json(await runSync(ctx, req.user, { records, source: b.source, dryRun: b.dry_run, confirmCreate: b.confirm_create }, req));
}));
r.get('/catalogue/syncs', need('catalogue.import'), wrap(async (req, res) => res.json({ rows: (await req.ctx.db.query('select id,mode,source,outcome,summary,created_at from catalogue_syncs order by created_at desc limit 50')).rows })));
r.get('/catalogue/syncs/:id', need('catalogue.import'), wrap(async (req, res) => { const row = await req.ctx.db.one('select * from catalogue_syncs where id=$1', [needUuid(req.params.id)]); if (!row) throw notFound(); res.json(row); }));

// ---------------- Student: my courses, open offerings, enrolment requests ----------------
r.get('/me/courses', needRole('student'), wrap(async (req, res) => {
  const rows = (await req.ctx.db.query(`select c.id, c.title, c.code, c.description, c.category, c.level, o.id as offering_id, e.status as enrolment_status, t.name as term_name,
    (select coalesce(json_agg(u.full_name),'[]'::json) from offering_staff s join users u on u.id=s.user_id where s.offering_id=o.id and s.staff_role='instructor') as instructors
    from enrolments e join course_offerings o on o.id=e.offering_id join courses c on c.id=o.course_id left join terms t on t.id=o.term_id where e.student_id=$1 and e.status in ('active','requested','completed') order by c.title`, [req.user.id])).rows;
  res.json({ rows });
}));
r.get('/offerings/open', needRole('student'), wrap(async (req, res) => {
  const rows = (await req.ctx.db.query(`select o.id as offering_id, c.id as course_id, c.title, c.description, c.level, t.name as term_name from course_offerings o join courses c on c.id=o.course_id left join terms t on t.id=o.term_id
    where o.status='open' and c.status='active' and not exists (select 1 from enrolments e where e.offering_id=o.id and e.student_id=$1) order by c.title`, [req.user.id])).rows;
  res.json({ rows });
}));
r.post('/offerings/:id/enrol-request', needRole('student'), wrap(async (req, res) => {
  const id = needUuid(req.params.id);
  if (!(await req.ctx.db.one("select 1 as x from course_offerings where id=$1 and status='open'", [id]))) throw notFound('Offering not found.');
  await req.ctx.db.query("insert into enrolments(offering_id,student_id,status,enrolled_at) values($1,$2,'requested',$3) on conflict (offering_id,student_id) do nothing", [id, req.user.id, req.ctx.now()]);
  await audit(req.ctx.db, req.ctx, { actor: req.user, action: 'enrolment.requested', entity: 'offering', id, req });
  res.status(201).json({ ok: true, message: 'Request sent. An administrator will review it.' });
}));
export default r;
