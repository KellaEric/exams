import { Router } from 'express';
import { z } from 'zod';
import { wrap, bad, notFound, forbidden, conflict } from '../lib/errors.js';
import { need, parse, staffOnly } from '../middleware.js';
import { audit } from '../lib/audit.js';
import { needUuid, round2, pageParams } from '../lib/util.js';
import { requireCourse, courseIdsFor } from '../lib/access.js';
import { recomputeAttempt, refreshAssessment, extendAttempt, reopenAttempt } from '../lib/exam.js';
import { assertTransition } from '../lib/assessmentState.js';
import { j } from '../db/index.js';

const r = Router();

async function attemptAccess(ctx, user, attemptId) {
  const att = await ctx.db.one('select t.*, a.course_id, a.status as a_status, a.title, a.feedback_mode from attempts t join assessments a on a.id=t.assessment_id where t.id=$1', [attemptId]);
  if (!att) throw notFound('Attempt not found.');
  await requireCourse(ctx, user, att.course_id);
  return att;
}

r.get('/grading/queue', staffOnly, need('grading.grade'), wrap(async (req, res) => {
  const { ctx } = req; const { limit, offset } = pageParams(req.query, 50); const p = [], w = ["g.status in ('pending_manual','needs_review')", "t.status<>'in_progress'"];
  const scope = await courseIdsFor(ctx.db, req.user); if (scope) { if (!scope.length) return res.json({ rows: [] }); p.push(scope); w.push(`a.course_id = any($${p.length}::uuid[])`); }
  if (req.query.assessment_id) { p.push(needUuid(req.query.assessment_id)); w.push(`a.id=$${p.length}`); }
  if (req.query.course_id) { p.push(needUuid(req.query.course_id)); w.push(`a.course_id=$${p.length}`); }
  const rows = (await ctx.db.query(`select g.attempt_id, g.question_id, g.status, g.max_marks, t.submitted_at, u.full_name, u.student_number, a.id as assessment_id, a.title, c.title as course_title, substr(q.stem,1,120) as stem, q.type
    from answer_grades g join attempts t on t.id=g.attempt_id join assessments a on a.id=t.assessment_id join courses c on c.id=a.course_id join users u on u.id=t.student_id join questions q on q.id=g.question_id
    where ${w.join(' and ')} order by t.submitted_at limit ${limit} offset ${offset}`, p)).rows;
  res.json({ rows });
}));

// Full grading view for one attempt: the student's answers next to the marking key and rubric (staff only).
r.get('/attempts/:id/grading', staffOnly, need('grading.grade'), wrap(async (req, res) => {
  const { ctx } = req; const id = needUuid(req.params.id); const att = await attemptAccess(ctx, req.user, id);
  if (att.status === 'in_progress') throw conflict('This attempt is still in progress.');
  const student = await ctx.db.one('select id,full_name,student_number,email from users where id=$1', [att.student_id]);
  const rows = (await ctx.db.query('select question_id, position, marks, snapshot from assessment_questions where assessment_id=$1 order by position', [att.assessment_id])).rows;
  const answers = new Map((await ctx.db.query('select question_id, response, saved_at from answers where attempt_id=$1', [id])).rows.map((x) => [x.question_id, x]));
  const grades = new Map((await ctx.db.query('select * from answer_grades where attempt_id=$1', [id])).rows.map((x) => [x.question_id, x]));
  const history = (await ctx.db.query('select gc.*, u.full_name as changed_by_name from grade_changes gc join users u on u.id=gc.changed_by where gc.attempt_id=$1 order by gc.created_at', [id])).rows;
  const events = (await ctx.db.query('select type, meta, created_at from attempt_events where attempt_id=$1 order by created_at', [id])).rows;
  res.json({
    attempt: { id: att.id, status: att.status, attempt_no: att.attempt_no, started_at: att.started_at, submitted_at: att.submitted_at, deadline_at: att.deadline_at, score: att.score, max_score: att.max_score, percentage: att.percentage, passed: att.passed, grading_status: att.grading_status, late: att.late, late_penalty_pct: att.late_penalty_pct, receipt_code: att.receipt_code },
    assessment: { id: att.assessment_id, title: att.title, status: att.a_status }, student,
    questions: rows.map((x) => ({ question_id: x.question_id, position: x.position, marks: x.marks, type: x.snapshot.type, stem: x.snapshot.stem, config: x.snapshot.config, options: x.snapshot.options, answer_key: x.snapshot.answer_key, rubric: x.snapshot.rubric,
      response: answers.get(x.question_id)?.response ?? null, grade: grades.get(x.question_id) || null })),
    grade_history: history, events
  });
}));

r.put('/attempts/:id/grades/:qid', staffOnly, need('grading.grade'), wrap(async (req, res) => {
  const { ctx } = req; const id = needUuid(req.params.id), qid = needUuid(req.params.qid);
  const b = parse(z.object({ marks: z.number().min(0).max(1000).optional(), feedback: z.string().max(5000).nullable().optional(), rubric_scores: z.array(z.object({ criterion: z.string().max(300), marks: z.number().min(0) })).max(30).optional(), reason: z.string().trim().max(500).optional() }), req.body);
  const att = await attemptAccess(ctx, req.user, id);
  if (att.status === 'in_progress') throw conflict('Cannot grade an attempt that is still in progress.');
  const out = await ctx.db.tx(async (q) => {
    const g = (await q.query('select * from answer_grades where attempt_id=$1 and question_id=$2 for update', [id, qid])).rows[0]; if (!g) throw notFound('Question not found in this attempt.');
    const snap = (await q.query('select snapshot, marks from assessment_questions where assessment_id=$1 and question_id=$2', [att.assessment_id, qid])).rows[0];
    let marks = b.marks;
    if (b.rubric_scores) {
      const rub = snap.snapshot.rubric || [];
      for (const s of b.rubric_scores) { const c = rub.find((x) => x.criterion === s.criterion); if (!c) throw bad(`Unknown rubric criterion "${s.criterion}".`); if (s.marks > c.max) throw bad(`"${s.criterion}" is worth at most ${c.max}.`); }
      const sum = round2(b.rubric_scores.reduce((s, x) => s + x.marks, 0));
      if (marks !== undefined && round2(marks) !== sum) throw bad(`Marks (${marks}) do not match the rubric total (${sum}).`);
      marks = sum;
    }
    if (marks === undefined) throw bad('Provide marks (or rubric scores).');
    if (marks > g.max_marks) throw bad(`Marks cannot exceed ${g.max_marks}.`);
    marks = round2(marks);
    const released = ['results_released', 'archived'].includes(att.a_status);
    const prev = g.final_marks;
    if (released && !req.user.perms.has('grade.override')) throw forbidden('Results are released. Changing a grade now needs the grade-override permission.');
    if (prev !== null && prev !== marks && !(b.reason && b.reason.length >= 5)) throw bad('Give a reason (5+ characters) when changing an existing mark.');
    if (released && !(b.reason && b.reason.length >= 5)) throw bad('A reason is required to change a released grade.');
    await q.query("update answer_grades set final_marks=$3, status='final', feedback=coalesce($4,feedback), rubric_scores=coalesce($5::jsonb,rubric_scores), grader_id=$6, graded_at=$7 where attempt_id=$1 and question_id=$2",
      [id, qid, marks, b.feedback ?? null, b.rubric_scores ? j(b.rubric_scores) : null, req.user.id, ctx.now()]);
    if (prev !== null && prev !== marks) await q.query('insert into grade_changes(attempt_id,question_id,old_marks,new_marks,reason,changed_by,created_at) values($1,$2,$3,$4,$5,$6,$7)', [id, qid, prev, marks, b.reason, req.user.id, ctx.now()]);
    await audit(q, ctx, { actor: req.user, action: 'grade.manual', entity: 'attempt', id, meta: { question_id: qid, old: prev, new: marks, reason: b.reason || null }, req });
    return recomputeAttempt(ctx, q, id);
  });
  await refreshAssessment(ctx, att.assessment_id, { skipFinalize: true });
  res.json({ totals: out });
}));

r.post('/assessments/:id/release', staffOnly, need('results.release'), wrap(async (req, res) => {
  const { ctx } = req; const id = needUuid(req.params.id);
  const a0 = await ctx.db.one('select course_id from assessments where id=$1', [id]); if (!a0) throw notFound();
  await requireCourse(ctx, req.user, a0.course_id, { write: true });
  await refreshAssessment(ctx, id);
  await ctx.db.tx(async (q) => {
    const a = (await q.query('select * from assessments where id=$1 for update', [id])).rows[0];
    if (a.status !== 'graded') throw conflict(a.status === 'results_released' ? 'Results are already released.' : `Results can only be released once every submission is graded (status is "${a.status}").`, 'not_ready');
    assertTransition(a.status, 'results_released');
    await q.query("update assessments set status='results_released', results_released_at=$2, updated_at=$2 where id=$1", [id, ctx.now()]);
    await audit(q, ctx, { actor: req.user, action: 'results.release', entity: 'assessment', id, meta: { title: a.title }, req });
  });
  res.json({ ok: true, status: 'results_released' });
}));

r.post('/attempts/:id/extend', staffOnly, need('attempt.extend'), wrap(async (req, res) => {
  const att = await attemptAccess(req.ctx, req.user, needUuid(req.params.id));
  if (!req.user.perms.has('course.read_all')) throw forbidden();
  res.json(await extendAttempt(req.ctx, req.user, att.id, parse(z.object({ minutes: z.number().int(), reason: z.string() }), req.body), req));
}));
r.post('/attempts/:id/reopen', staffOnly, need('attempt.extend'), wrap(async (req, res) => {
  const att = await attemptAccess(req.ctx, req.user, needUuid(req.params.id));
  if (!req.user.perms.has('course.read_all')) throw forbidden();
  res.json(await reopenAttempt(req.ctx, req.user, att.id, parse(z.object({ minutes: z.number().int(), reason: z.string() }), req.body), req));
}));
export default r;
