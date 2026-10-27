import { Router } from 'express';
import { z } from 'zod';
import { wrap, bad, notFound, forbidden, conflict } from '../lib/errors.js';
import { parse, staffOnly } from '../middleware.js';
import { audit } from '../lib/audit.js';
import { needUuid, pageParams, round2 } from '../lib/util.js';
import { requireCourse, requireAssessmentAccess, courseIdsFor } from '../lib/access.js';
import { assertTransition, assertPublishable, publishProblems, EDITABLE } from '../lib/assessmentState.js';
import { loadQuestion, snapshotOf } from '../lib/questions.js';
import { studentQuestion, refreshAssessment, submitAttempt } from '../lib/exam.js';
import { j } from '../db/index.js';

const r = Router();
const dt = z.string().datetime({ offset: true }).nullable().optional();
const settingsSchema = z.object({
  allowed_resources: z.string().max(500).optional(), show_rubric: z.boolean().optional(),
  allowed_file_types: z.array(z.string().max(8)).max(15).optional(), max_file_mb: z.number().min(0.1).max(4).optional(),
  late: z.object({ allowed: z.boolean(), until: z.string().datetime({ offset: true }).optional(), penalty_pct: z.number().min(0).max(100).optional() }).optional(),
  submission_rules: z.string().max(1000).optional()
}).strict();
const fields = {
  title: z.string().trim().min(3).max(200), instructions: z.string().max(10000).nullable().optional(), offering_id: z.string().uuid().nullable().optional(),
  opens_at: dt, closes_at: dt, duration_minutes: z.number().int().min(1).max(600).nullable().optional(), max_attempts: z.number().int().min(1).max(50).nullable().optional(),
  pass_percentage: z.number().min(0).max(100).optional(), randomize_questions: z.boolean().optional(), randomize_options: z.boolean().optional(), allow_navigation: z.boolean().optional(),
  feedback_mode: z.enum(['none', 'score_only', 'marks_and_feedback', 'full']).optional(), results_release_at: dt, negative_marking: z.boolean().optional(),
  expected_total_marks: z.number().min(0).nullable().optional(), grading_scale_id: z.string().uuid().nullable().optional(), settings: settingsSchema.optional()
};
const items = z.array(z.object({ question_id: z.string().uuid(), marks: z.number().positive().max(1000).optional() })).max(200);
const toDate = (v) => (v ? new Date(v) : v === null ? null : undefined);

export async function loadFull(q, id) {
  const a = (await q.query('select * from assessments where id=$1', [id])).rows[0]; if (!a) return null;
  const rows = (await q.query(`select aq.position, aq.marks, aq.snapshot, qq.id as question_id, qq.type, qq.stem, qq.status, qq.answer_key, qq.config, qq.rubric, qq.topic, qq.difficulty, qq.marks as bank_marks
    from assessment_questions aq join questions qq on qq.id=aq.question_id where aq.assessment_id=$1 order by aq.position`, [id])).rows;
  for (const x of rows) x.options = (await q.query('select id,position,text,is_correct,feedback from question_options where question_id=$1 order by position', [x.question_id])).rows;
  return { ...a, questions: rows.map((x) => ({ ...x, id: x.question_id })) };
}
async function setQuestions(q, a, list, courseId) {
  await q.query('delete from assessment_questions where assessment_id=$1', [a.id]);
  const seen = new Set(); let pos = 0, total = 0;
  for (const it of list) {
    if (seen.has(it.question_id)) throw bad('A question was selected twice.'); seen.add(it.question_id);
    const qn = (await q.query('select course_id, marks, status from questions where id=$1', [it.question_id])).rows[0];
    if (!qn || qn.course_id !== courseId) throw bad('A selected question does not belong to this course.');
    if (qn.status === 'retired') throw bad('A selected question has been retired.');
    const marks = it.marks ?? qn.marks; total += marks;
    await q.query('insert into assessment_questions(assessment_id,question_id,position,marks) values($1,$2,$3,$4)', [a.id, it.question_id, pos++, marks]);
  }
  await q.query('update assessments set total_marks=$2 where id=$1', [a.id, round2(total)]);
}
// Freeze content (answer keys included) so later edits to the question bank cannot change a live exam.
async function freeze(q, a) {
  for (const row of (await q.query('select question_id, marks from assessment_questions where assessment_id=$1', [a.id])).rows) {
    const full = await loadQuestion(q, row.question_id);
    await q.query('update assessment_questions set snapshot=$3::jsonb where assessment_id=$1 and question_id=$2', [a.id, row.question_id, j(snapshotOf(full))]);
  }
}
const unfreeze = (q, a) => q.query('update assessment_questions set snapshot=null where assessment_id=$1', [a.id]);

r.post('/courses/:cid/assessments', staffOnly, wrap(async (req, res) => {
  const { ctx } = req; const cid = needUuid(req.params.cid);
  if (!req.user.perms.has('assessment.create') && !req.user.perms.has('assessment.manage_all')) throw forbidden();
  await requireCourse(ctx, req.user, cid, { write: true });
  const b = parse(z.object({ category_key: z.string(), ...fields, questions: items.optional() }), req.body);
  const cat = await ctx.db.one('select * from assessment_categories where key=$1', [b.category_key]); if (!cat?.enabled) throw bad('Unknown or disabled assessment category.');
  if (b.offering_id && !(await ctx.db.one('select 1 as x from course_offerings where id=$1 and course_id=$2', [b.offering_id, cid]))) throw bad('That offering does not belong to this course.');
  const out = await ctx.db.tx(async (q) => {
    const a = (await q.query(`insert into assessments(course_id,offering_id,category_key,title,instructions,opens_at,closes_at,duration_minutes,max_attempts,pass_percentage,randomize_questions,randomize_options,allow_navigation,feedback_mode,results_release_at,negative_marking,expected_total_marks,grading_scale_id,settings,created_by,created_at,updated_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,coalesce($18,(select id from grading_scales where is_default limit 1)),$19::jsonb,$20,$21,$21) returning *`,
      [cid, b.offering_id || null, b.category_key, b.title, b.instructions || null, toDate(b.opens_at) || null, toDate(b.closes_at) || null, b.duration_minutes ?? null, b.max_attempts ?? (cat.kind === 'exam' ? 1 : null),
        b.pass_percentage ?? 50, !!b.randomize_questions, !!b.randomize_options, b.allow_navigation ?? true, b.feedback_mode || 'marks_and_feedback', toDate(b.results_release_at) || null, !!b.negative_marking,
        b.expected_total_marks ?? null, b.grading_scale_id || null, j(b.settings || {}), req.user.id, ctx.now()])).rows[0];
    if (b.questions) await setQuestions(q, a, b.questions, cid);
    await audit(q, ctx, { actor: req.user, action: 'assessment.create', entity: 'assessment', id: a.id, meta: { title: a.title, category: a.category_key }, req });
    return a;
  });
  res.status(201).json(await loadFull(ctx.db, out.id));
}));

r.put('/assessments/:id', staffOnly, wrap(async (req, res) => {
  const { ctx } = req; const id = needUuid(req.params.id);
  const { a } = await requireAssessmentAccess(ctx, req.user, id, { write: true });
  if (!EDITABLE.has(a.status)) throw conflict('Only draft assessments can be edited. Return it to draft first.', 'not_editable');
  const b = parse(z.object({ ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])), questions: items.optional() }), req.body);
  await ctx.db.tx(async (q) => {
    const sets = [], p = [id];
    for (const [k, v] of Object.entries(b)) {
      if (k === 'questions' || v === undefined) continue;
      p.push(['opens_at', 'closes_at', 'results_release_at'].includes(k) ? toDate(v) : k === 'settings' ? j(v) : v); sets.push(k === 'settings' ? `settings=$${p.length}::jsonb` : `${k}=$${p.length}`);
    }
    p.push(ctx.now()); sets.push(`updated_at=$${p.length}`);
    await q.query(`update assessments set ${sets.join(',')} where id=$1`, p);
    if (b.questions) await setQuestions(q, a, b.questions, a.course_id);
    await audit(q, ctx, { actor: req.user, action: 'assessment.update', entity: 'assessment', id, meta: { fields: Object.keys(b) }, req });
  });
  res.json(await loadFull(ctx.db, id));
}));

r.delete('/assessments/:id', staffOnly, wrap(async (req, res) => {
  const { ctx } = req; const id = needUuid(req.params.id);
  const { a } = await requireAssessmentAccess(ctx, req.user, id, { write: true });
  if (a.status !== 'draft') throw conflict('Only drafts can be deleted. Archive others.');
  await ctx.db.query('delete from assessments where id=$1', [id]);
  await audit(ctx.db, ctx, { actor: req.user, action: 'assessment.delete', entity: 'assessment', id, meta: { title: a.title }, req }); res.json({ ok: true });
}));

const listSql = `select a.id,a.title,a.status,a.category_key,k.label as category,a.course_id,c.title as course_title,a.opens_at,a.closes_at,a.duration_minutes,a.total_marks,a.max_attempts,a.results_released_at,
  (select count(*)::int from attempts t where t.assessment_id=a.id) as attempts,
  (select count(*)::int from attempts t where t.assessment_id=a.id and t.status='in_progress') as in_progress,
  (select count(*)::int from attempts t where t.assessment_id=a.id and t.status<>'in_progress' and t.grading_status<>'graded') as awaiting_grading
  from assessments a join courses c on c.id=a.course_id join assessment_categories k on k.key=a.category_key`;
r.get('/assessments', staffOnly, wrap(async (req, res) => {
  const { ctx } = req; const { limit, offset } = pageParams(req.query, 50); const w = [], p = [];
  const scope = await courseIdsFor(ctx.db, req.user); if (scope) { if (!scope.length) return res.json({ total: 0, rows: [] }); p.push(scope); w.push(`a.course_id = any($${p.length}::uuid[])`); }
  for (const [k, col] of [['course_id', 'a.course_id'], ['status', 'a.status'], ['category', 'a.category_key']]) if (req.query[k]) { p.push(req.query[k]); w.push(`${col}=$${p.length}`); }
  const where = w.length ? 'where ' + w.join(' and ') : '';
  const total = (await ctx.db.one(`select count(*)::int as n from assessments a ${where}`, p)).n;
  res.json({ total, rows: (await ctx.db.query(`${listSql} ${where} order by coalesce(a.opens_at,a.created_at) desc limit ${limit} offset ${offset}`, p)).rows });
}));

r.get('/assessments/:id', staffOnly, wrap(async (req, res) => {
  const { ctx } = req; const id = needUuid(req.params.id);
  await requireAssessmentAccess(ctx, req.user, id);
  await refreshAssessment(ctx, id);
  const a = await loadFull(ctx.db, id);
  const cat = await ctx.db.one('select * from assessment_categories where key=$1', [a.category_key]);
  res.json({ ...a, category: cat, problems: a.status === 'draft' || a.status === 'pending_review' ? publishProblems(a, a.questions, cat) : [] });
}));
r.get('/assessments/:id/preview', staffOnly, wrap(async (req, res) => {
  const { ctx } = req; const id = needUuid(req.params.id); await requireAssessmentAccess(ctx, req.user, id);
  const a = await loadFull(ctx.db, id);
  res.json({ title: a.title, instructions: a.instructions, duration_minutes: a.duration_minutes, total_marks: a.total_marks, preview: true,
    questions: a.questions.map((x) => studentQuestion({ ...(x.snapshot || { id: x.question_id, type: x.type, stem: x.stem, config: x.config, rubric: x.rubric, options: x.options }), marks: x.marks }, a)) });
}));

// ---------- lifecycle actions ----------
async function setStatus(q, ctx, req, a, to, extra = {}) {
  assertTransition(a.status, to);
  const sets = ['status=$2', 'updated_at=$3'], p = [a.id, to, ctx.now()];
  for (const [k, v] of Object.entries(extra)) { p.push(v); sets.push(`${k}=$${p.length}`); }
  await q.query(`update assessments set ${sets.join(',')} where id=$1`, p);
  await audit(q, ctx, { actor: req.user, action: `assessment.${to}`, entity: 'assessment', id: a.id, meta: { from: a.status, to, ...(req.body?.reason ? { reason: req.body.reason } : {}) }, req });
  a.status = to;
}

r.post('/assessments/:id/actions/:action', staffOnly, wrap(async (req, res) => {
  const { ctx } = req; const id = needUuid(req.params.id); const action = req.params.action;
  const { a: a0 } = await requireAssessmentAccess(ctx, req.user, id, { write: true });
  await refreshAssessment(ctx, id);
  const perms = req.user.perms; const now = ctx.now();
  const manageAll = perms.has('assessment.manage_all');
  const out = await ctx.db.tx(async (q) => {
    const a = await loadFull(q, id);
    const cat = (await q.query('select * from assessment_categories where key=$1', [a.category_key])).rows[0];
    const gate = () => { assertPublishable(a, a.questions, cat); };
    const approve = async (auto) => {
      gate();
      if (!auto) {
        if (!perms.has('assessment.approve')) throw forbidden('You cannot approve assessments.');
        if (a.created_by === req.user.id && req.user.role_key !== 'super_admin') throw forbidden('Restricted assessments must be approved by someone other than their author.');
      }
      await freeze(q, a); await setStatus(q, ctx, req, a, 'approved', { approved_by: req.user.id });
    };
    const publish = async () => {
      if (!perms.has('assessment.publish')) throw forbidden('You cannot publish assessments.');
      gate();
      const future = a.opens_at && a.opens_at > now;
      await setStatus(q, ctx, req, a, future ? 'scheduled' : 'published', { published_at: future ? null : now });
    };
    switch (action) {
      case 'submit_review':
        if (a.created_by !== req.user.id && !manageAll) throw forbidden();
        gate(); await setStatus(q, ctx, req, a, 'pending_review');
        if (!cat.requires_approval) await approve(true);
        break;
      case 'approve': await approve(false); break;
      case 'reject': if (!perms.has('assessment.approve')) throw forbidden(); await setStatus(q, ctx, req, a, 'draft'); await unfreeze(q, a); break;
      case 'back_to_draft': if (!['approved', 'scheduled'].includes(a.status)) throw conflict('Only approved or scheduled assessments can return to draft.'); if (a.status === 'scheduled') await setStatus(q, ctx, req, a, 'approved'); await setStatus(q, ctx, req, a, 'draft'); await unfreeze(q, a); break;
      case 'publish':
        if (a.status === 'draft') { if (cat.requires_approval) throw conflict('This category requires approval before publication. Submit it for review first.', 'approval_required'); gate(); await setStatus(q, ctx, req, a, 'pending_review'); await approve(true); }
        if (a.status === 'pending_review') throw conflict('Waiting for approval.', 'approval_required');
        await publish(); break;
      case 'unschedule': await setStatus(q, ctx, req, a, 'approved'); break;
      case 'close': {
        if (!perms.has('assessment.publish')) throw forbidden();
        if (!['published', 'in_progress'].includes(a.status)) throw conflict('Only live assessments can be closed.');
        const live = (await q.query("select id from attempts where assessment_id=$1 and status='in_progress'", [id])).rows;
        if (live.length && !(req.body?.reason?.length >= 5)) throw bad(`${live.length} attempt(s) are in progress. Give a reason to close and auto-submit them.`);
        await setStatus(q, ctx, req, a, 'closed'); a.__live = live; break;
      }
      case 'archive': if (!perms.has('assessment.publish') && !manageAll) throw forbidden(); await setStatus(q, ctx, req, a, 'archived'); break;
      case 'extend_window': {
        if (!perms.has('assessment.publish')) throw forbidden();
        const b = parse(z.object({ closes_at: z.string().datetime({ offset: true }), reason: z.string().trim().min(5) }), req.body);
        if (!['scheduled', 'published', 'in_progress'].includes(a.status)) throw conflict('Only live or scheduled assessments can be extended.');
        const to = new Date(b.closes_at); if (to <= a.closes_at) throw bad('The new closing time must be later than the current one.');
        await q.query('update assessments set closes_at=$2, updated_at=$3 where id=$1', [id, to, now]);
        await audit(q, ctx, { actor: req.user, action: 'assessment.extend_window', entity: 'assessment', id, meta: { from: a.closes_at, to, reason: b.reason }, req }); break;
      }
      default: throw notFound('Unknown action.');
    }
    return a;
  });
  if (action === 'close') for (const l of out.__live || []) await submitAttempt(ctx, null, l.id, { auto: true });
  if (action === 'close') await refreshAssessment(ctx, id, { skipFinalize: true });
  const fresh = await loadFull(ctx.db, id);
  res.json({ id, status: fresh.status, total_marks: fresh.total_marks });
}));

r.get('/assessments/:id/attempts', staffOnly, wrap(async (req, res) => {
  const { ctx } = req; const id = needUuid(req.params.id); await requireAssessmentAccess(ctx, req.user, id);
  const rows = (await ctx.db.query(`select t.id,t.attempt_no,t.status,t.started_at,t.submitted_at,t.deadline_at,t.score,t.max_score,t.percentage,t.passed,t.grading_status,t.late,t.reopened_count,u.id as student_id,u.full_name,u.student_number,u.email
    from attempts t join users u on u.id=t.student_id where t.assessment_id=$1 order by u.full_name, t.attempt_no`, [id])).rows;
  res.json({ rows });
}));
export default r;
