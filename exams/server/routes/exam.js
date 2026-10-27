import { Router } from 'express';
import { z } from 'zod';
import { wrap, bad, notFound, forbidden, conflict } from '../lib/errors.js';
import { needRole, parse } from '../middleware.js';
import { needUuid } from '../lib/util.js';
import { startAttempt, getAttemptView, saveAnswers, submitAttempt, refreshAssessment, studentQuestion } from '../lib/exam.js';
import { letterFor } from '../lib/permissions.js';
import { j } from '../db/index.js';

const r = Router();
const student = needRole('student');
const VISIBLE = "('scheduled','published','in_progress','closed','graded','results_released')";

const enrolledSql = (p) => `exists (select 1 from enrolments e join course_offerings o on o.id=e.offering_id where e.student_id=${p} and e.status='active' and o.course_id=a.course_id and (a.offering_id is null or o.id=a.offering_id))`;
export const isReleased = (a) => !!a.results_released_at || a.status === 'results_released';

export function studentState(a, attempts, now, extraAttempts = 0) {
  const live = attempts.find((t) => t.status === 'in_progress');
  const done = attempts.filter((t) => t.status !== 'in_progress');
  const windowOpen = ['published', 'in_progress'].includes(a.status) && (!a.opens_at || now >= a.opens_at) && now <= a.closes_at;
  const left = a.max_attempts == null ? Infinity : a.max_attempts + extraAttempts - attempts.length;
  const can_start = !live && windowOpen && left > 0;
  let state;
  if (live) state = 'in_progress';
  else if (done.length) state = isReleased(a) ? 'results_released' : done.some((t) => t.grading_status === 'awaiting_manual') ? 'awaiting_grading' : done.every((t) => t.grading_status === 'graded') ? 'graded' : 'submitted';
  else if (a.status === 'scheduled' || (a.opens_at && now < a.opens_at)) state = 'upcoming';
  else if (windowOpen) state = 'available';
  else state = 'missed';
  return { state, can_start, attempts_used: attempts.length, attempts_allowed: a.max_attempts == null ? null : a.max_attempts + extraAttempts };
}

async function myAssessments(ctx, user) {
  const rows = (await ctx.db.query(`select a.id,a.title,a.course_id,c.title as course_title,k.label as category,k.kind,a.status,a.opens_at,a.closes_at,a.duration_minutes,a.max_attempts,a.total_marks,a.results_released_at,a.instructions
    from assessments a join courses c on c.id=a.course_id join assessment_categories k on k.key=a.category_key where a.status in ${VISIBLE} and ${enrolledSql('$1')} order by coalesce(a.opens_at,a.created_at) desc`, [user.id])).rows;
  const atts = (await ctx.db.query('select id,assessment_id,attempt_no,status,grading_status,deadline_at,submitted_at,receipt_code,percentage,score,max_score,passed from attempts where student_id=$1 order by attempt_no', [user.id])).rows;
  const acc = (await ctx.db.query('select assessment_id, offering_id, extra_attempts from accommodations where student_id=$1 and revoked_at is null', [user.id])).rows;
  const now = ctx.now();
  return rows.map((a) => {
    const mine = atts.filter((t) => t.assessment_id === a.id);
    const extra = acc.filter((x) => x.assessment_id === a.id).reduce((s, x) => s + x.extra_attempts, 0);
    const s = studentState(a, mine, now, extra);
    const released = isReleased(a);
    return { ...a, ...s, active_attempt_id: mine.find((t) => t.status === 'in_progress')?.id || null,
      attempts: mine.map((t) => ({ id: t.id, attempt_no: t.attempt_no, status: t.status, submitted_at: t.submitted_at, receipt_code: t.receipt_code, grading_status: t.grading_status,
        ...(released ? { score: t.score, max_score: t.max_score, percentage: t.percentage, passed: t.passed } : {}) })) };
  });
}

r.get('/me/assessments', student, wrap(async (req, res) => {
  const { ctx } = req;
  const due = (await ctx.db.query(`select a.id from assessments a where a.status in ('scheduled','published','in_progress') and ${enrolledSql('$1')}`, [req.user.id])).rows;
  for (const d of due) await refreshAssessment(ctx, d.id, { skipFinalize: true });
  res.json({ rows: await myAssessments(ctx, req.user) });
}));

r.get('/me/dashboard', student, wrap(async (req, res) => {
  const { ctx } = req; const all = await myAssessments(ctx, req.user);
  const courses = (await ctx.db.query(`select c.id,c.title,o.id as offering_id from enrolments e join course_offerings o on o.id=e.offering_id join courses c on c.id=o.course_id where e.student_id=$1 and e.status='active' order by c.title`, [req.user.id])).rows;
  const perf = courses.map((c) => { const rel = all.filter((a) => a.course_id === c.id && a.state === 'results_released').flatMap((a) => a.attempts.filter((t) => t.percentage != null)); return { course_id: c.id, title: c.title, results: rel.length, average: rel.length ? Math.round(rel.reduce((s, t) => s + t.percentage, 0) / rel.length * 10) / 10 : null }; });
  const unread = (await ctx.db.one(`select count(*)::int as n from announcements an where (an.published_at <= $2) and (an.course_id in (select o.course_id from enrolments e join course_offerings o on o.id=e.offering_id where e.student_id=$1 and e.status='active') or an.offering_id in (select offering_id from enrolments where student_id=$1 and status='active'))
    and not exists (select 1 from announcement_reads r where r.announcement_id=an.id and r.user_id=$1)`, [req.user.id, ctx.now()])).n;
  const by = (s) => all.filter((a) => a.state === s);
  res.json({
    profile: { id: req.user.id, full_name: req.user.full_name, email: req.user.email, student_number: req.user.student_number },
    courses, performance: perf, unread_announcements: unread,
    upcoming: by('upcoming'), available: by('available'), in_progress: by('in_progress'),
    awaiting: all.filter((a) => ['submitted', 'awaiting_grading', 'graded'].includes(a.state)), released: by('results_released').slice(0, 10), missed: by('missed'),
    deadlines: all.filter((a) => a.kind !== 'exam' && ['available', 'in_progress'].includes(a.state)).sort((x, y) => x.closes_at - y.closes_at)
  });
}));

// Pre-start details (instructions) – no questions are revealed before the attempt starts.
r.get('/assessments/:id/student', student, wrap(async (req, res) => {
  const { ctx } = req; const id = needUuid(req.params.id);
  await refreshAssessment(ctx, id, { skipFinalize: true });
  const a = (await myAssessments(ctx, req.user)).find((x) => x.id === id); if (!a) throw notFound('Assessment not found.');
  const meta = await ctx.db.one('select allow_navigation, randomize_questions, settings, feedback_mode from assessments where id=$1', [id]);
  res.json({ ...a, allow_navigation: meta.allow_navigation, allowed_resources: meta.settings?.allowed_resources || null, submission_rules: meta.settings?.submission_rules || null, allowed_file_types: meta.settings?.allowed_file_types || null, late_policy: meta.settings?.late || null, server_now: ctx.now() });
}));

r.post('/assessments/:id/start', student, wrap(async (req, res) => {
  const startKey = req.headers['idempotency-key'] ? String(req.headers['idempotency-key']).slice(0, 80) : null;
  const out = await startAttempt(req.ctx, req.user, needUuid(req.params.id), { startKey });
  res.status(out.resumed ? 200 : 201).json(out);
}));
r.get('/attempts/:id', student, wrap(async (req, res) => res.json(await getAttemptView(req.ctx, req.user, needUuid(req.params.id)))));
r.put('/attempts/:id/answers', student, wrap(async (req, res) => {
  const b = parse(z.object({ answers: z.array(z.object({ question_id: z.string().uuid(), response: z.any(), flagged: z.boolean().optional(), seq: z.number().int().min(0) })).min(1).max(100) }), req.body);
  res.json(await saveAnswers(req.ctx, req.user, needUuid(req.params.id), b.answers));
}));
r.post('/attempts/:id/submit', student, wrap(async (req, res) => res.json(await submitAttempt(req.ctx, req.user, needUuid(req.params.id)))));

// Limited, transparent integrity *signals* (not proof of misconduct). Whitelisted types, capped volume.
r.post('/attempts/:id/events', student, wrap(async (req, res) => {
  const { ctx } = req; const b = parse(z.object({ type: z.enum(['blur', 'focus', 'offline', 'online', 'fullscreen_exit']) }), req.body);
  const att = await ctx.db.one('select id,student_id,status from attempts where id=$1', [needUuid(req.params.id)]);
  if (!att || att.student_id !== req.user.id) throw notFound();
  if (att.status === 'in_progress' && (await ctx.db.one('select count(*)::int as n from attempt_events where attempt_id=$1', [att.id])).n < 1000)
    await ctx.db.query("insert into attempt_events(attempt_id,type,meta,created_at) values($1,$2,'{\"signal\":true}'::jsonb,$3)", [att.id, `signal_${b.type}`, ctx.now()]);
  res.json({ ok: true });
}));

// ---- results (only after release) ----
function revealKey(s) {
  switch (s.type) {
    case 'mcq': case 'multi_select': return { correct_option_ids: s.options.filter((o) => o.is_correct).map((o) => o.id) };
    case 'true_false': return { correct: s.answer_key.value };
    case 'short_answer': return { accepted: s.answer_key.accepted };
    case 'fill_blank': return { blanks: s.answer_key.blanks.map((b) => b.accepted) };
    case 'numeric': return { value: s.answer_key.value, tolerance: s.answer_key.tolerance };
    case 'matching': return { pairs: s.answer_key.pairs };
    case 'ordering': return { order: s.answer_key.order };
    default: return null;
  }
}
r.get('/attempts/:id/result', student, wrap(async (req, res) => {
  const { ctx } = req; const id = needUuid(req.params.id);
  const att = await ctx.db.one('select * from attempts where id=$1', [id]); if (!att || att.student_id !== req.user.id) throw notFound('Attempt not found.');
  const a = await ctx.db.one('select a.*, s.bands from assessments a left join grading_scales s on s.id=a.grading_scale_id where a.id=$1', [att.assessment_id]);
  if (att.status === 'in_progress') throw conflict('This attempt is still in progress.');
  if (!isReleased(a)) throw forbidden('Results have not been released yet.');
  const base = { assessment: { id: a.id, title: a.title }, attempt: { id: att.id, attempt_no: att.attempt_no, submitted_at: att.submitted_at, receipt_code: att.receipt_code, status: att.status, late: att.late } };
  if (a.feedback_mode === 'none') return res.json({ ...base, message: 'Your submission was recorded. Feedback for this assessment is not published.' });
  const result = { score: att.score, max_score: att.max_score, percentage: att.percentage, passed: att.passed, grade: a.bands ? letterFor(a.bands, att.percentage) : null, late_penalty_pct: att.late_penalty_pct || 0 };
  if (a.feedback_mode === 'score_only') return res.json({ ...base, result });
  const rows = (await ctx.db.query('select aq.question_id, aq.position, aq.marks, aq.snapshot from assessment_questions aq where aq.assessment_id=$1 order by aq.position', [a.id])).rows;
  const grades = new Map((await ctx.db.query('select * from answer_grades where attempt_id=$1', [id])).rows.map((g) => [g.question_id, g]));
  const answers = new Map((await ctx.db.query('select question_id, response from answers where attempt_id=$1', [id])).rows.map((x) => [x.question_id, x.response]));
  const questions = rows.map((x) => {
    const g = grades.get(x.question_id); const s = { ...x.snapshot, marks: x.marks };
    const out = { question: studentQuestion(s, a), response: answers.get(x.question_id) ?? null, max_marks: x.marks, awarded: g?.final_marks ?? null, status: g?.status || null, feedback: g?.feedback || null };
    if (a.feedback_mode === 'full') { out.correct = revealKey(x.snapshot); out.explanation = x.snapshot.explanation || null; }
    return out;
  });
  res.json({ ...base, result, questions });
}));

r.get('/me/attempts', student, wrap(async (req, res) => {
  const rows = (await req.ctx.db.query(`select t.id,t.attempt_no,t.status,t.submitted_at,t.receipt_code,t.grading_status,a.title,c.title as course_title,
    case when a.results_released_at is not null or a.status='results_released' then t.percentage end as percentage, case when a.results_released_at is not null or a.status='results_released' then t.passed end as passed
    from attempts t join assessments a on a.id=t.assessment_id join courses c on c.id=a.course_id where t.student_id=$1 order by t.created_at desc limit 200`, [req.user.id])).rows;
  res.json({ rows });
}));
export default r;
