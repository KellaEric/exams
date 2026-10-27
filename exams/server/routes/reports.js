import { Router } from 'express';
import { wrap, notFound } from '../lib/errors.js';
import { need, staffOnly } from '../middleware.js';
import { needUuid, round2, toCsv } from '../lib/util.js';
import { requireCourse, requireAssessmentAccess, courseIdsFor } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { letterFor } from '../lib/permissions.js';

const r = Router();
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const avg = (a) => (a.length ? round2(a.reduce((s, x) => s + x, 0) / a.length) : null);

// Best attempt per student for an assessment (graded attempts only count towards statistics).
const BEST = `select distinct on (t.student_id) t.* from attempts t where t.assessment_id=$1 and t.status<>'in_progress' and t.grading_status='graded' order by t.student_id, t.percentage desc, t.attempt_no`;

r.get('/assessments/:id/report', staffOnly, need('report.view'), wrap(async (req, res) => {
  const { ctx } = req; const id = needUuid(req.params.id); const { a } = await requireAssessmentAccess(ctx, req.user, id);
  const best = (await ctx.db.query(BEST, [id])).rows;
  const enrolled = (await ctx.db.one(`select count(distinct e.student_id)::int as n from enrolments e join course_offerings o on o.id=e.offering_id where e.status='active' and o.course_id=$1 and ($2::uuid is null or o.id=$2)`, [a.course_id, a.offering_id])).n;
  const started = (await ctx.db.one('select count(distinct student_id)::int as n from attempts where assessment_id=$1', [id])).n;
  const pcts = best.map((x) => x.percentage);
  const buckets = Array.from({ length: 10 }, (_, i) => ({ range: `${i * 10}-${i === 9 ? 100 : i * 10 + 9}`, count: 0 }));
  for (const p of pcts) buckets[Math.min(9, Math.floor(p / 10))].count++;
  const missing = (await ctx.db.query(`select u.id, u.full_name, u.student_number from enrolments e join course_offerings o on o.id=e.offering_id join users u on u.id=e.student_id where e.status='active' and o.course_id=$1 and ($2::uuid is null or o.id=$2)
    and not exists (select 1 from attempts t where t.assessment_id=$3 and t.student_id=u.id and t.status<>'in_progress') order by u.full_name`, [a.course_id, a.offering_id, id])).rows;
  const questions = (await ctx.db.query(`select g.question_id, substr(aq.snapshot->>'stem',1,100) as stem, aq.snapshot->>'type' as type, aq.marks, count(*)::int as answered, avg(g.final_marks/nullif(g.max_marks,0))*100 as avg_pct,
    count(*) filter (where g.final_marks is not null and g.final_marks < g.max_marks)::int as not_full
    from answer_grades g join attempts t on t.id=g.attempt_id join assessment_questions aq on aq.assessment_id=t.assessment_id and aq.question_id=g.question_id
    where t.assessment_id=$1 and t.status<>'in_progress' group by g.question_id, aq.snapshot, aq.marks, aq.position order by avg(g.final_marks/nullif(g.max_marks,0)) nulls last`, [id])).rows;
  res.json({
    assessment: { id: a.id, title: a.title, status: a.status, total_marks: a.total_marks, pass_percentage: a.pass_percentage },
    participation: { enrolled, started, completed: best.length, completion_rate: enrolled ? round2(best.length / enrolled * 100) : null },
    scores: { average: avg(pcts), median: median(pcts), highest: pcts.length ? Math.max(...pcts) : null, lowest: pcts.length ? Math.min(...pcts) : null, pass_rate: best.length ? round2(best.filter((x) => x.passed).length / best.length * 100) : null, passed: best.filter((x) => x.passed).length, failed: best.filter((x) => !x.passed).length },
    distribution: buckets, missing_submissions: missing,
    questions: questions.map((x) => ({ ...x, avg_pct: x.avg_pct == null ? null : round2(x.avg_pct) })), frequently_missed: questions.filter((x) => x.avg_pct != null && x.avg_pct < 50).map((x) => x.question_id)
  });
}));

async function gradebookRows(ctx, courseId) {
  return (await ctx.db.query(`select u.id as student_id, u.full_name, u.student_number, a.id as assessment_id, a.title, k.label as category, a.total_marks, a.status as assessment_status, (a.results_released_at is not null) as released, a.pass_percentage, sc.bands,
    t.attempt_no, t.submitted_at, t.score, t.max_score, t.percentage, t.passed, t.grading_status, t.id as attempt_id,
    (select string_agg(g.feedback, ' | ') from answer_grades g where g.attempt_id=t.id and g.feedback is not null) as feedback
    from attempts t join assessments a on a.id=t.assessment_id join users u on u.id=t.student_id join assessment_categories k on k.key=a.category_key left join grading_scales sc on sc.id=a.grading_scale_id
    where a.course_id=$1 and t.status<>'in_progress' order by u.full_name, a.created_at, t.attempt_no`, [courseId])).rows;
}
r.get('/courses/:cid/gradebook', staffOnly, need('report.view'), wrap(async (req, res) => {
  const { ctx } = req; const cid = needUuid(req.params.cid); await requireCourse(ctx, req.user, cid);
  const rows = (await gradebookRows(ctx, cid)).map(({ bands, ...x }) => ({ ...x, grade: x.grading_status === 'graded' && bands ? letterFor(bands, x.percentage) : null }));
  if (req.query.format === 'csv') {
    if (!req.user.perms.has('report.export')) return res.status(403).json({ error: { message: 'You cannot export reports.', code: 'forbidden' } });
    await audit(ctx.db, ctx, { actor: req.user, action: 'report.export', entity: 'course', id: cid, meta: { kind: 'gradebook', rows: rows.length }, req });
    const head = ['Student', 'Student ID', 'Assessment', 'Type', 'Attempt', 'Submitted', 'Marks', 'Max', 'Percentage', 'Grade', 'Pass/Fail', 'Grading status', 'Results released', 'Feedback'];
    return res.type('text/csv').attachment('gradebook.csv').send(toCsv([head, ...rows.map((x) => [x.full_name, x.student_number, x.title, x.category, x.attempt_no, x.submitted_at, x.score, x.max_score, x.percentage, x.grade, x.grading_status === 'graded' ? (x.passed ? 'Pass' : 'Fail') : '', x.grading_status, x.released ? 'Yes' : 'No', x.feedback])]));
  }
  res.json({ rows });
}));

r.get('/courses/:cid/report', staffOnly, need('report.view'), wrap(async (req, res) => {
  const { ctx } = req; const cid = needUuid(req.params.cid); await requireCourse(ctx, req.user, cid);
  const rows = (await ctx.db.query(`select a.id, a.title, a.status, a.total_marks, (select count(distinct student_id)::int from attempts t where t.assessment_id=a.id and t.status<>'in_progress') as submitted,
    (select round(avg(percentage)::numeric,2)::float from attempts t where t.assessment_id=a.id and t.grading_status='graded') as average,
    (select round((100.0*count(*) filter (where passed)/nullif(count(*),0))::numeric,2)::float from attempts t where t.assessment_id=a.id and t.grading_status='graded') as pass_rate
    from assessments a where a.course_id=$1 and a.status not in ('draft','archived') order by a.created_at`, [cid])).rows;
  const enrolled = (await ctx.db.one(`select count(distinct e.student_id)::int as n from enrolments e join course_offerings o on o.id=e.offering_id where o.course_id=$1 and e.status='active'`, [cid])).n;
  res.json({ enrolled, assessments: rows });
}));

r.get('/students/:id/report', staffOnly, need('report.view'), wrap(async (req, res) => {
  const { ctx } = req; const sid = needUuid(req.params.id);
  const scope = await courseIdsFor(ctx.db, req.user);
  const stu = await ctx.db.one("select id,full_name,student_number,email from users where id=$1 and role_key='student'", [sid]); if (!stu) throw notFound('Student not found.');
  const p = [sid]; let w = ''; if (scope) { p.push(scope); w = 'and a.course_id = any($2::uuid[])'; }
  const rows = (await ctx.db.query(`select c.title as course_title, a.title, a.id as assessment_id, t.attempt_no, t.submitted_at, t.score, t.max_score, t.percentage, t.passed, t.grading_status from attempts t join assessments a on a.id=t.assessment_id join courses c on c.id=a.course_id
    where t.student_id=$1 and t.status<>'in_progress' ${w} order by t.submitted_at desc`, p)).rows;
  if (scope && !rows.length) throw notFound('Student not found.');
  res.json({ student: stu, attempts: rows });
}));
export default r;
