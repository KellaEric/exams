import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeWorld, setupCourse, approvedQuestion, mcq } from './helpers.js';
import { finalizeExpired } from '../lib/exam.js';

let w, ids, inst, admin, s1, s2, qs;
const mkAssessment = async (questions, over = {}) => {
  const r = await inst.post(`/api/courses/${ids.courseId}/assessments`, { category_key: 'quiz', title: 'Weekly Test 1', duration_minutes: 30, opens_at: w.iso(-3600), closes_at: w.iso(86400), max_attempts: 1, questions: questions.map((q) => ({ question_id: q.id })), ...over });
  if (r.status !== 201) throw new Error('mkAssessment ' + JSON.stringify(r.body));
  return r.body;
};
const publish = (a) => inst.post(`/api/assessments/${a.id}/actions/publish`, {});

beforeAll(async () => {
  w = await makeWorld(); ids = await setupCourse(w); inst = await w.login('inst'); admin = await w.login('admin'); s1 = await w.login('s1'); s2 = await w.login('s2');
  qs = {
    mcq: await approvedQuestion(inst, ids.courseId, mcq('What is 2 + 2?', 2)),
    multi: await approvedQuestion(inst, ids.courseId, { type: 'multi_select', stem: 'Pick the even numbers', marks: 3, options: [{ text: '2', is_correct: true }, { text: '3' }, { text: '4', is_correct: true }] }),
    tf: await approvedQuestion(inst, ids.courseId, { type: 'true_false', stem: 'Python is compiled only', marks: 1, correct: false }),
    num: await approvedQuestion(inst, ids.courseId, { type: 'numeric', stem: 'Value of pi to 2 d.p.?', marks: 2, value: 3.14, tolerance: 0.01 }),
    essay: await approvedQuestion(inst, ids.courseId, { type: 'essay', stem: 'Explain list comprehensions.', marks: 10, rubric: [{ criterion: 'Accuracy', max: 6 }, { criterion: 'Clarity', max: 4 }] })
  };
});

// Sessions legitimately expire when the fake clock jumps (idle timeout), so every test starts with fresh sign-ins.
beforeEach(async () => { inst = await w.login('inst'); admin = await w.login('admin'); s1 = await w.login('s1'); s2 = await w.login('s2'); });

const correctAnswers = async (view) => {
  // The test plays the student: finds option ids by their visible text only (no key access).
  const out = [];
  for (const q of view.questions) {
    if (q.type === 'mcq') out.push({ question_id: q.id, response: q.options.find((o) => o.text === '4').id, seq: 1 });
    if (q.type === 'multi_select') out.push({ question_id: q.id, response: q.options.filter((o) => ['2', '4'].includes(o.text)).map((o) => o.id), seq: 1 });
    if (q.type === 'true_false') out.push({ question_id: q.id, response: false, seq: 1 });
    if (q.type === 'numeric') out.push({ question_id: q.id, response: '3.141', seq: 1 });
    if (q.type === 'essay') out.push({ question_id: q.id, response: 'A list comprehension builds a list from an iterable in one expression.', seq: 1 });
  }
  return out;
};

describe('end-to-end: admin -> instructor -> student -> grading -> release', () => {
  let a, attemptId, view, deadline;
  it('steps 1-6: course imported, offering/staff/enrolment set up, bank built, timed exam published', async () => {
    const course = (await admin.get(`/api/courses/${ids.courseId}`)).body;
    expect(course.import_status).toBe('imported_verified'); expect(course.readiness).toBe('ready');
    a = await mkAssessment(Object.values(qs));
    expect(a.total_marks).toBe(18); expect(a.status).toBe('draft');
    const p = await publish(a); expect(p.status).toBe(200); expect(p.body.status).toBe('published');
  });
  it('step 7: student sees it, starts it, and gets a server deadline; the payload contains no answer keys', async () => {
    const list = (await s1.get('/api/me/assessments')).body.rows; expect(list.find((x) => x.id === a.id)).toMatchObject({ state: 'available', can_start: true });
    const r = await s1.post(`/api/assessments/${a.id}/start`); expect(r.status).toBe(201);
    view = r.body; attemptId = view.attempt.id; deadline = new Date(view.attempt.deadline_at);
    expect(deadline.getTime() - w.now().getTime()).toBe(30 * 60 * 1000);
    expect(view.attempt.remaining_seconds).toBe(1800); expect(view.questions).toHaveLength(5);
    const raw = JSON.stringify(view); expect(raw).not.toMatch(/is_correct|answer_key|accepted|"value":3\.14|explanation/);
  });
  it('steps 8-10: answers autosave; after a refresh they are restored and the timer continues from the original deadline', async () => {
    const ans = await correctAnswers(view);
    const save = await s1.put(`/api/attempts/${attemptId}/answers`, { answers: ans }); expect(save.status).toBe(200); expect(save.body.saved.every((x) => x.saved)).toBe(true);
    w.advance(600);                                                       // 10 minutes pass
    const again = (await s1.get(`/api/attempts/${attemptId}`)).body;      // "refresh"
    expect(new Date(again.attempt.deadline_at).getTime()).toBe(deadline.getTime());
    expect(again.attempt.remaining_seconds).toBe(1200);
    expect(Object.keys(again.answers)).toHaveLength(5);
    expect(again.answers[qs.tf.id].response).toBe(false);
    const restart = await s1.post(`/api/assessments/${a.id}/start`);      // second tab / repeated start
    expect(restart.status).toBe(200); expect(restart.body.resumed).toBe(true); expect(restart.body.attempt.id).toBe(attemptId); expect(restart.body.attempt.remaining_seconds).toBe(1200);
  });
  it('step 11-13: submit once; objective questions graded; essay queued for manual grading; result hidden', async () => {
    const sub = await s1.post(`/api/attempts/${attemptId}/submit`); expect(sub.status).toBe(200); expect(sub.body.receipt_code).toMatch(/^KT-[0-9A-F]{10}$/); expect(sub.body.already_submitted).toBe(false);
    const again = await s1.post(`/api/attempts/${attemptId}/submit`); expect(again.body.already_submitted).toBe(true); expect(again.body.receipt_code).toBe(sub.body.receipt_code);
    const late = await s1.put(`/api/attempts/${attemptId}/answers`, { answers: [{ question_id: qs.tf.id, response: true, seq: 9 }] });
    expect(late.status).toBe(409); expect(late.body.error.code).toBe('attempt_closed');
    const g = (await inst.get(`/api/attempts/${attemptId}/grading`)).body;
    expect(g.attempt).toMatchObject({ score: 8, max_score: 18, grading_status: 'awaiting_manual' });
    expect((await s1.get(`/api/attempts/${attemptId}/result`)).status).toBe(403);
    const dash = (await s1.get('/api/me/dashboard')).body; expect(dash.awaiting.map((x) => x.id)).toContain(a.id);
    expect((await inst.get('/api/grading/queue')).body.rows).toHaveLength(1);
  });
  it('step 14: instructor grades the essay with the rubric and the attempt becomes graded', async () => {
    const r = await inst.put(`/api/attempts/${attemptId}/grades/${qs.essay.id}`, { rubric_scores: [{ criterion: 'Accuracy', marks: 5 }, { criterion: 'Clarity', marks: 3 }], feedback: 'Good, add an example.' });
    expect(r.status).toBe(200); expect(r.body.totals).toMatchObject({ score: 16, percentage: 88.89, passed: true, grading_status: 'graded' });
    const tooMuch = await inst.put(`/api/attempts/${attemptId}/grades/${qs.essay.id}`, { rubric_scores: [{ criterion: 'Accuracy', marks: 7 }, { criterion: 'Clarity', marks: 3 }], reason: 'regrade attempt' });
    expect(tooMuch.status).toBe(400);
    const change = await inst.put(`/api/attempts/${attemptId}/grades/${qs.essay.id}`, { marks: 9, reason: 'Second marking agreed 9/10' }); expect(change.status).toBe(200);
    const noReason = await inst.put(`/api/attempts/${attemptId}/grades/${qs.essay.id}`, { marks: 8 }); expect(noReason.status).toBe(400);
    const hist = (await inst.get(`/api/attempts/${attemptId}/grading`)).body.grade_history; expect(hist).toHaveLength(1); expect(hist[0]).toMatchObject({ old_marks: 8, new_marks: 9, reason: 'Second marking agreed 9/10' });
  });
  it('step 15: results stay private until an authorised person releases them (after the window closes and everything is graded)', async () => {
    expect((await inst.post(`/api/assessments/${a.id}/release`)).status).toBe(403);       // instructors lack results.release by default
    expect((await admin.post(`/api/assessments/${a.id}/release`)).status).toBe(409);      // still open/not graded
    w.advance(86400 + 60);                                                                  // window closes
    admin = await w.login('admin'); s1 = await w.login('s1');                              // sessions idled out while the clock jumped
    expect((await admin.get(`/api/assessments/${a.id}`)).body.status).toBe('graded');
    expect((await s1.get(`/api/attempts/${attemptId}/result`)).status).toBe(403);
    expect((await admin.post(`/api/assessments/${a.id}/release`)).status).toBe(200);
  });
  it('step 16: student sees the released result with feedback but no answer key (feedback mode: marks_and_feedback)', async () => {
    const r = await s1.get(`/api/attempts/${attemptId}/result`); expect(r.status).toBe(200);
    expect(r.body.result).toMatchObject({ score: 17, max_score: 18, percentage: 94.44, passed: true, grade: 'A+' });
    expect(r.body.questions.find((x) => x.question.id === qs.essay.id).feedback).toBe('Good, add an example.');
    expect(JSON.stringify(r.body)).not.toMatch(/is_correct|answer_key|correct_option_ids|explanation/);
    expect((await s2.get(`/api/attempts/${attemptId}/result`)).status).toBe(404);          // someone else's attempt
    const list = (await s1.get('/api/me/assessments')).body.rows.find((x) => x.id === a.id); expect(list.state).toBe('results_released');
  });
  it('step 17: the audit log records the key events', async () => {
    const log = (await (await w.login('super')).get('/api/audit?limit=1000')).body.rows.map((x) => x.action);
    for (const act of ['catalogue.sync', 'offering.create', 'staff.assign', 'enrolment.create', 'question.create', 'question.approve', 'assessment.create', 'assessment.pending_review', 'assessment.approved', 'assessment.published', 'grade.manual', 'results.release', 'assessment.auto_transition'])
      expect(log, act).toContain(act);
    const ev = await w.db.query('select type from attempt_events where attempt_id=$1 order by created_at', [attemptId]);
    expect(ev.rows.map((x) => x.type)).toEqual(expect.arrayContaining(['start', 'save', 'reconnect', 'submit']));
  });
});

describe('timed engine: server authority, concurrency, expiry', () => {
  it('concurrent start requests create exactly one attempt', async () => {
    const a = await mkAssessment([qs.mcq, qs.tf], { title: 'Concurrent start' }); await publish(a);
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => s2.post(`/api/assessments/${a.id}/start`)));
    expect(rs.every((r) => [200, 201].includes(r.status))).toBe(true);
    expect(new Set(rs.map((r) => r.body.attempt.id)).size).toBe(1);
    expect((await w.db.one('select count(*)::int as n from attempts where assessment_id=$1', [a.id])).n).toBe(1);
  });
  it('the client cannot choose or extend the deadline (time-like fields are ignored)', async () => {
    const a = await mkAssessment([qs.mcq], { title: 'No client time' }); await publish(a);
    const r = await s1.post(`/api/assessments/${a.id}/start`, { deadline_at: '2099-01-01T00:00:00Z', duration_minutes: 9999, started_at: '2020-01-01T00:00:00Z' });
    expect(new Date(r.body.attempt.deadline_at).getTime()).toBe(w.now().getTime() + 30 * 60000);
    const save = await s1.put(`/api/attempts/${r.body.attempt.id}/answers`, { answers: [{ question_id: qs.mcq.id, response: null, seq: 1 }], deadline_at: '2099-01-01T00:00:00Z' });
    expect(new Date(save.body.deadline_at).getTime()).toBe(w.now().getTime() + 30 * 60000);
  });
  it('time expiry auto-submits saved answers; later saves are rejected; the deadline caps submitted_at', async () => {
    const a = await mkAssessment([qs.mcq, qs.tf], { title: 'Expiry' }); await publish(a);
    const r = (await s2.post(`/api/assessments/${a.id}/start`)).body; const mc = r.questions.find((q) => q.type === 'mcq');
    await s2.put(`/api/attempts/${r.attempt.id}/answers`, { answers: [{ question_id: mc.id, response: mc.options.find((o) => o.text === '4').id, seq: 1 }] });
    w.advance(30 * 60 + 5);                                                       // inside the 10s save grace window: still accepted
    expect((await s2.put(`/api/attempts/${r.attempt.id}/answers`, { answers: [{ question_id: mc.id, response: mc.options.find((o) => o.text === '4').id, seq: 2 }] })).status).toBe(200);
    w.advance(30);                                                                // now beyond grace
    const late = await s2.put(`/api/attempts/${r.attempt.id}/answers`, { answers: [{ question_id: mc.id, response: mc.options[0].id, seq: 3 }] });
    expect(late.status).toBe(409); expect(late.body.error.code).toBe('time_expired'); expect(late.body.error.details.receipt_code).toMatch(/^KT-/);
    const row = await w.db.one('select * from attempts where id=$1', [r.attempt.id]);
    expect(row.status).toBe('auto_submitted'); expect(row.submitted_at.getTime()).toBe(new Date(r.attempt.deadline_at).getTime()); expect(row.score).toBe(2);
  });
  it('the sweeper finalises abandoned attempts without any student request', async () => {
    const a = await mkAssessment([qs.mcq], { title: 'Sweep me' }); await publish(a);
    const r = (await s1.post(`/api/assessments/${a.id}/start`)).body;
    w.advance(31 * 60);
    expect(await finalizeExpired(w.ctx)).toBeGreaterThanOrEqual(1);
    const row = await w.db.one('select status, grading_status from attempts where id=$1', [r.attempt.id]); expect(row).toMatchObject({ status: 'auto_submitted', grading_status: 'graded' });
  });
  it('the cron endpoint requires its secret', async () => {
    expect((await (await import('supertest')).default(w.app).post('/api/internal/sweep')).status).toBe(401);
  });
  it('attempt limits, then an approved accommodation grants extra time and an extra attempt', async () => {
    const a = await mkAssessment([qs.tf], { title: 'Limits', max_attempts: 1, duration_minutes: 10 }); await publish(a);
    const first = (await s1.post(`/api/assessments/${a.id}/start`)).body; await s1.post(`/api/attempts/${first.attempt.id}/submit`);
    const blocked = await s1.post(`/api/assessments/${a.id}/start`); expect(blocked.status).toBe(409); expect(blocked.body.error.code).toBe('attempt_limit');
    const acc = await admin.post('/api/accommodations', { student_id: w.users.s1.id, assessment_id: a.id, extra_minutes: 5, extra_attempts: 1, reason: 'Approved extra time (documented)' }); expect(acc.status).toBe(201);
    const second = await s1.post(`/api/assessments/${a.id}/start`); expect(second.status).toBe(201);
    expect(second.body.attempt.remaining_seconds).toBe(15 * 60); expect(second.body.attempt.attempt_no).toBe(2);
    expect((await s2.post(`/api/assessments/${a.id}/start`)).body.attempt.remaining_seconds).toBe(10 * 60);   // other students unaffected
  });
  it('authorised extra time and reopen are explicit, reasoned, and audited', async () => {
    const a = await mkAssessment([qs.tf], { title: 'Recovery', duration_minutes: 10 }); await publish(a);
    const at = (await s2.post(`/api/assessments/${a.id}/start`)).body.attempt;
    expect((await inst.post(`/api/attempts/${at.id}/extend`, { minutes: 5, reason: 'power cut' })).status).toBe(403);     // instructor lacks attempt.extend
    expect((await admin.post(`/api/attempts/${at.id}/extend`, { minutes: 5, reason: '' })).status).toBe(400);
    const ext = await admin.post(`/api/attempts/${at.id}/extend`, { minutes: 5, reason: 'Power cut in lab 2' }); expect(ext.status).toBe(200);
    expect((await s2.get(`/api/attempts/${at.id}`)).body.attempt.remaining_seconds).toBe(15 * 60);
    await s2.post(`/api/attempts/${at.id}/submit`);
    const re = await admin.post(`/api/attempts/${at.id}/reopen`, { minutes: 10, reason: 'Submitted by mistake, approved by exams officer' }); expect(re.status).toBe(200);
    expect((await s2.get(`/api/attempts/${at.id}`)).body.attempt.status).toBe('in_progress');
    const log = (await (await w.login('super')).get('/api/audit?limit=1000')).body.rows.map((x) => x.action); expect(log).toEqual(expect.arrayContaining(['attempt.extend', 'attempt.reopen']));
  });
  it('out-of-order autosaves cannot overwrite newer answers', async () => {
    const a = await mkAssessment([qs.tf], { title: 'Seq' }); await publish(a);
    const at = (await s1.post(`/api/assessments/${a.id}/start`)).body.attempt;
    await s1.put(`/api/attempts/${at.id}/answers`, { answers: [{ question_id: qs.tf.id, response: true, seq: 5 }] });
    const stale = await s1.put(`/api/attempts/${at.id}/answers`, { answers: [{ question_id: qs.tf.id, response: false, seq: 4 }] });
    expect(stale.body.saved[0]).toMatchObject({ saved: false, stale: true });
    expect((await s1.get(`/api/attempts/${at.id}`)).body.answers[qs.tf.id].response).toBe(true);
  });
  it('randomisation is stored per attempt and survives refresh', async () => {
    const a = await mkAssessment(Object.values(qs), { title: 'Random', randomize_questions: true, randomize_options: true }); await publish(a);
    const v1 = (await s1.post(`/api/assessments/${a.id}/start`)).body; const v2 = (await s1.get(`/api/attempts/${v1.attempt.id}`)).body;
    expect(v2.questions.map((q) => q.id)).toEqual(v1.questions.map((q) => q.id));
    expect(v2.questions.find((q) => q.type === 'mcq').options.map((o) => o.id)).toEqual(v1.questions.find((q) => q.type === 'mcq').options.map((o) => o.id));
  });
});

describe('assessment lifecycle and validation', () => {
  it('blocks publication with missing keys, unapproved questions and total-mark mismatches', async () => {
    const draftQ = (await inst.post(`/api/courses/${ids.courseId}/questions`, mcq('Draft question here', 1))).body;
    const a = await mkAssessment([qs.mcq, draftQ], { title: 'Invalid', expected_total_marks: 99 });
    const r = await publish(a); expect(r.status).toBe(400);
    const problems = r.body.error.details.problems.join(' | ');
    expect(problems).toMatch(/not approved/); expect(problems).toMatch(/Total marks mismatch/);
    const noClose = await inst.post(`/api/courses/${ids.courseId}/assessments`, { category_key: 'quiz', title: 'No close', duration_minutes: 5, questions: [{ question_id: qs.mcq.id }] });
    expect((await publish(noClose.body)).body.error.details.problems.join()).toMatch(/closing date/);
  });
  it('enforces valid state transitions and freezes content after review starts', async () => {
    const a = await mkAssessment([qs.mcq], { title: 'Frozen' });
    expect((await inst.post(`/api/assessments/${a.id}/actions/close`, {})).status).toBe(409);
    expect((await inst.post(`/api/assessments/${a.id}/actions/unschedule`, {})).status).toBe(409);
    await publish(a);
    expect((await inst.put(`/api/assessments/${a.id}`, { title: 'Changed after publish' })).status).toBe(409);
    // editing the bank question afterwards must not change the live exam
    await inst.put(`/api/questions/${qs.mcq.id}`, { ...mcq('What is 2 + 2? (edited)', 2), options: [{ text: '3', is_correct: true }, { text: '4' }] });
    const live = (await s2.post(`/api/assessments/${a.id}/start`)).body; expect(live.questions[0].stem).toBe('What is 2 + 2?');
    // restore + re-approve the bank question for later tests
    await inst.put(`/api/questions/${qs.mcq.id}`, mcq('What is 2 + 2?', 2)); await inst.post(`/api/questions/${qs.mcq.id}/submit`, {}); await inst.post(`/api/questions/${qs.mcq.id}/approve`, {});
  });
  it('restricted categories need a different person to approve; scheduling opens automatically', async () => {
    const a = await mkAssessment([qs.mcq], { title: 'Final Exam', category_key: 'final_exam', opens_at: w.iso(7200), closes_at: w.iso(7200 + 7200), duration_minutes: 60 });
    const direct = await publish(a); expect(direct.status).toBe(409); expect(direct.body.error.code).toBe('approval_required');
    expect((await inst.post(`/api/assessments/${a.id}/actions/submit_review`, {})).body.status).toBe('pending_review');
    expect((await inst.post(`/api/assessments/${a.id}/actions/approve`, {})).status).toBe(403);
    expect((await admin.post(`/api/assessments/${a.id}/actions/approve`, {})).body.status).toBe('approved');
    expect((await inst.post(`/api/assessments/${a.id}/actions/publish`, {})).body.status).toBe('scheduled');
    expect((await s1.post(`/api/assessments/${a.id}/start`)).status).toBe(409);        // not open yet
    w.advance(7300); s1 = await w.login('s1');
    expect((await s1.get('/api/me/assessments')).body.rows.find((x) => x.id === a.id).state).toBe('available');
    expect((await s1.post(`/api/assessments/${a.id}/start`)).status).toBe(201);
  });
  it('preview shows the whole paper to staff without an attempt and without keys', async () => {
    const a = await mkAssessment([qs.mcq, qs.essay], { title: 'Preview me' });
    const p = await inst.get(`/api/assessments/${a.id}/preview`); expect(p.status).toBe(200); expect(p.body.questions).toHaveLength(2); expect(JSON.stringify(p.body)).not.toMatch(/is_correct|answer_key/);
  });
});

describe('security: isolation and secrecy', () => {
  it('students only see assessments for courses they are enrolled in', async () => {
    const other = await setupCourse(w, { title: 'Secret Course', enrol: ['s3'], staff: 'inst2' });
    const inst2 = await w.login('inst2'); const q = await approvedQuestion(inst2, other.courseId, mcq('Other course question', 1));
    const oa = (await inst2.post(`/api/courses/${other.courseId}/assessments`, { category_key: 'quiz', title: 'Other quiz', duration_minutes: 10, closes_at: w.iso(86400), questions: [{ question_id: q.id }] })).body;
    expect((await inst2.post(`/api/assessments/${oa.id}/actions/publish`, {})).status).toBe(200);
    expect((await s1.get('/api/me/assessments')).body.rows.find((x) => x.id === oa.id)).toBeUndefined();
    expect((await s1.post(`/api/assessments/${oa.id}/start`)).status).toBe(404);
    expect((await s1.get(`/api/assessments/${oa.id}/student`)).status).toBe(404);
    // staff isolation: inst cannot read or grade course B; inst2 cannot read course A
    expect((await inst.get(`/api/assessments/${oa.id}`)).status).toBe(404); expect((await inst.get(`/api/courses/${other.courseId}/questions`)).status).toBe(404);
    expect((await inst.post(`/api/courses/${other.courseId}/questions`, mcq('Injected', 1))).status).toBe(404);
    expect((await inst2.get(`/api/assessments/${(await w.db.one("select id from assessments where title='Weekly Test 1'")).id}`)).status).toBe(404);
    expect((await inst.get('/api/assessments')).body.rows.some((x) => x.id === oa.id)).toBe(false);
  });
  it("a student can never read another student's attempt, answers or grading view; students cannot grade", async () => {
    const a = await mkAssessment([qs.tf], { title: 'Privacy' }); await publish(a);
    const at = (await s1.post(`/api/assessments/${a.id}/start`)).body.attempt;
    expect((await s2.get(`/api/attempts/${at.id}`)).status).toBe(404);
    expect((await s2.put(`/api/attempts/${at.id}/answers`, { answers: [{ question_id: qs.tf.id, response: true, seq: 1 }] })).status).toBe(404);
    expect((await s2.post(`/api/attempts/${at.id}/submit`)).status).toBe(404);
    expect((await s1.get(`/api/attempts/${at.id}/grading`)).status).toBe(403);
    expect((await s1.put(`/api/attempts/${at.id}/grades/${qs.tf.id}`, { marks: 1 })).status).toBe(403);
    expect((await s1.get(`/api/assessments/${a.id}`)).status).toBe(403);
    expect((await s1.get(`/api/questions/${qs.tf.id}`)).status).toBe(403);
    expect((await s1.get(`/api/courses/${ids.courseId}/questions`)).status).toBe(403);
  });
  it('teaching assistants can grade assigned courses but cannot edit content; unassigned TAs see nothing', async () => {
    const ta = await w.login('ta');
    expect((await ta.get(`/api/courses/${ids.courseId}/questions`)).status).toBe(404);
    const off = (await admin.get(`/api/offerings?course_id=${ids.courseId}`)).body.rows[0];
    await admin.post(`/api/offerings/${off.id}/staff`, { user_id: w.users.ta.id, staff_role: 'teaching_assistant' });
    expect((await ta.get(`/api/courses/${ids.courseId}/questions`)).status).toBe(200);
    expect((await ta.post(`/api/courses/${ids.courseId}/questions`, mcq('TA question', 1))).status).toBe(403);
    expect((await ta.post(`/api/courses/${ids.courseId}/assessments`, { category_key: 'quiz', title: 'TA quiz' })).status).toBe(403);
    expect((await ta.get('/api/grading/queue')).status).toBe(200);
  });
  it('treats injection attempts as data: SQL in filters is harmless, scripts are stored inert as JSON text', async () => {
    const r = await inst.get(`/api/courses/${ids.courseId}/questions?q=${encodeURIComponent("' OR 1=1; DROP TABLE users;--")}`); expect(r.status).toBe(200); expect(r.body.rows).toHaveLength(0);
    expect((await admin.get(`/api/users?q=${encodeURIComponent("%' UNION SELECT * FROM users--")}`)).status).toBe(200);
    expect((await w.db.one('select count(*)::int as n from users')).n).toBeGreaterThan(5);
    const xss = await inst.post(`/api/courses/${ids.courseId}/questions`, { type: 'essay', stem: '<img src=x onerror=alert(1)> explain', marks: 1 });
    expect(xss.status).toBe(201); expect(xss.headers['content-type']).toMatch(/application\/json/); expect(xss.headers['x-content-type-options']).toBe('nosniff');
    expect((await admin.get('/api/users/not-a-uuid/reset-link')).status).toBe(404);
    expect((await admin.patch('/api/users/not-a-uuid', { status: 'active' })).status).toBe(400);
  });
  it('rejects malformed answer payloads and oversize bodies', async () => {
    const a = await mkAssessment([qs.tf], { title: 'Malformed' }); await publish(a);
    const at = (await s1.post(`/api/assessments/${a.id}/start`)).body.attempt;
    expect((await s1.put(`/api/attempts/${at.id}/answers`, { answers: [{ question_id: '00000000-0000-4000-8000-000000000000', response: 1, seq: 1 }] })).status).toBe(400);
    expect((await s1.put(`/api/attempts/${at.id}/answers`, { answers: 'nope' })).status).toBe(400);
    expect((await s1.put(`/api/attempts/${at.id}/answers`, { answers: [{ question_id: qs.tf.id, response: 'x'.repeat(250 * 1024), seq: 1 }] })).status).toBe(400);
  });
  it('uploads: content-checked, stored privately, link is signed + expiring + bound to the user, others cannot fetch it', async () => {
    const fq = await approvedQuestion(inst, ids.courseId, { type: 'file_upload', stem: 'Upload your report', marks: 5, rubric: [{ criterion: 'Completeness', max: 5 }] });
    const a = await mkAssessment([fq], { title: 'Assignment 1', category_key: 'assignment', duration_minutes: null, settings: { allowed_file_types: ['pdf', 'txt'], max_file_mb: 1 } }); await publish(a);
    const at = (await s1.post(`/api/assessments/${a.id}/start`)).body.attempt;
    const up = (name, body) => s1.agent.post(`/api/files?purpose=answer_upload&attempt_id=${at.id}`).set('X-CSRF-Token', s1.csrf).set('X-File-Name', name).set('Content-Type', 'application/octet-stream').send(body);
    expect((await up('report.pdf', Buffer.from('<html>not a pdf</html>'))).status).toBe(400);
    expect((await up('shell.sh', Buffer.from('#!/bin/sh'))).status).toBe(400);
    expect((await up('image.png', Buffer.from('89504e470d0a1a0a00', 'hex'))).status).toBe(400);        // allowed by default, but not by this assignment
    const ok = await up('report.pdf', Buffer.from('%PDF-1.4 hello')); expect(ok.status).toBe(201); expect(ok.body).not.toHaveProperty('storage_key');
    const link = await s1.get(`/api/files/${ok.body.id}/link`); expect(link.status).toBe(200);
    expect((await s1.get(link.body.url)).status).toBe(200);
    expect((await s2.get(`/api/files/${ok.body.id}/link`)).status).toBe(404);
    expect((await s2.get(link.body.url)).status).toBe(404);
    expect((await s1.get(link.body.url.replace(/sig=.{5}/, 'sig=AAAAA'))).status).toBe(403);
    w.advance(301); expect((await s1.get(link.body.url)).status).toBe(403);                              // expired
    expect((await inst.get(`/api/files/${ok.body.id}/link`)).status).toBe(200);                          // course staff can open it
    expect((await (await w.login('inst2')).get(`/api/files/${ok.body.id}/link`)).status).toBe(404);
    // attach to the answer; someone else's file cannot be attached
    const mine = await s1.put(`/api/attempts/${at.id}/answers`, { answers: [{ question_id: fq.id, response: { file_ids: [ok.body.id] }, seq: 1 }] }); expect(mine.status).toBe(200);
    const sub = await s1.post(`/api/attempts/${at.id}/submit`); expect(sub.status).toBe(200);
    expect((await inst.get('/api/grading/queue')).body.rows.some((x) => x.assessment_id === a.id)).toBe(true);
  });
  it('gradebook, reports and CSV export respect scope and neutralise spreadsheet formulas', async () => {
    const gb = await inst.get(`/api/courses/${ids.courseId}/gradebook`); expect(gb.status).toBe(200); expect(gb.body.rows.length).toBeGreaterThan(3);
    await w.db.query("update users set full_name='=HYPERLINK(\"http://evil\")' where id=$1", [w.users.s1.id]);
    const csv = await inst.get(`/api/courses/${ids.courseId}/gradebook?format=csv`); expect(csv.status).toBe(200); expect(csv.text).toContain(`"'=HYPERLINK`); expect(csv.text).not.toMatch(/^"?=HYPERLINK/m);
    expect((await (await w.login('inst2')).get(`/api/courses/${ids.courseId}/gradebook`)).status).toBe(404);
    expect((await s1.get(`/api/courses/${ids.courseId}/gradebook`)).status).toBe(403);
    const a = (await w.db.one("select id from assessments where title='Weekly Test 1'")).id;
    const rep = (await inst.get(`/api/assessments/${a}/report`)).body;
    expect(rep.participation).toMatchObject({ enrolled: 2, completed: 1 }); expect(rep.scores.pass_rate).toBe(100); expect(rep.distribution[9].count).toBe(1); expect(rep.questions.length).toBe(5);
  });
  it('dashboards use real counts', async () => {
    const d = (await admin.get('/api/admin/dashboard')).body;
    expect(d.active_students).toBe(3); expect(d.courses).toBe(2); expect(d.completed_assessments).toBeGreaterThanOrEqual(1);
    expect(d.ongoing_sessions).toBe((await w.db.one("select count(*)::int as n from attempts where status='in_progress' and deadline_at > $1", [w.now()])).n);
  });
});
