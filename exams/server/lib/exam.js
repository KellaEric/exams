// Examination engine. Every time decision uses ctx.now() (the SERVER clock) and deadlines stored in the database.
// The browser only ever *displays* a countdown derived from the server-issued deadline.
import crypto from 'node:crypto';
import { j } from '../db/index.js';
import { bad, conflict, forbidden, notFound } from './errors.js';
import { shuffle, randomToken, round2 } from './util.js';
import { gradeResponse, totalsFor } from './grading.js';
import { audit } from './audit.js';

const one = async (q, sql, p) => (await q.query(sql, p)).rows[0] || null;
const SAVE_MAX_BYTES = 200 * 1024;

// ---------- accommodations & timing windows ----------
async function accommodationFor(q, studentId, a) {
  const rows = (await q.query(
    `select * from accommodations where student_id=$1 and revoked_at is null and (assessment_id=$2 or (offering_id is not null and offering_id = $3))`,
    [studentId, a.id, a.offering_id])).rows;
  return {
    extraSeconds: Math.max(0, ...rows.map((r) => r.extra_minutes * 60)),
    allowLateUntil: rows.map((r) => r.allow_late_until).filter(Boolean).sort((x, y) => y - x)[0] || null,
    extraAttempts: rows.reduce((s, r) => s + r.extra_attempts, 0)
  };
}
function lateRule(a) {
  const l = a.settings?.late || {};
  return l.allowed && l.until ? { until: new Date(l.until), penalty: Number(l.penalty_pct || 0) } : null;
}

// ---------- student-safe question view (never includes keys, correctness flags, or hidden tests) ----------
export function studentQuestion(snap, a, optionOrder) {
  const base = { id: snap.id, type: snap.type, marks: snap.marks, stem: snap.stem, instructions: snap.instructions || null, attachment_file_id: snap.attachment_file_id || null };
  const cfg = { ...(snap.config || {}) };
  delete cfg.negative_fraction;
  base.config = cfg;
  if (snap.options?.length) {
    let opts = snap.options.map((o) => ({ id: o.id, text: o.text }));
    if (optionOrder) opts = optionOrder.map((id) => opts.find((o) => o.id === id)).filter(Boolean);
    base.options = opts;
  }
  if (a.settings?.show_rubric && snap.rubric?.length) base.rubric = snap.rubric;
  return base;
}

async function loadQuestions(q, assessmentId) {
  return (await q.query('select question_id, position, marks, snapshot from assessment_questions where assessment_id=$1 order by position', [assessmentId])).rows;
}

export function attemptHeader(att, a, now) {
  const remaining = att.status === 'in_progress' ? Math.max(0, Math.floor((att.deadline_at - now) / 1000)) : 0;
  return {
    id: att.id, assessment_id: att.assessment_id, attempt_no: att.attempt_no, status: att.status,
    started_at: att.started_at, deadline_at: att.deadline_at, submitted_at: att.submitted_at,
    server_now: now, remaining_seconds: remaining, late: att.late,
    receipt_code: att.status === 'in_progress' ? null : att.receipt_code
  };
}

async function buildView(ctx, q, att) {
  const a = await one(q, 'select * from assessments where id=$1', [att.assessment_id]);
  const rows = await loadQuestions(q, a.id);
  const byId = new Map(rows.map((r) => [r.question_id, r]));
  const order = att.question_order.length ? att.question_order : rows.map((r) => r.question_id);
  const questions = order.filter((id) => byId.has(id)).map((id) => studentQuestion({ ...byId.get(id).snapshot, marks: byId.get(id).marks }, a, att.option_orders?.[id]));
  const answers = {};
  for (const r of (await q.query('select question_id, response, flagged, seq, saved_at from answers where attempt_id=$1', [att.id])).rows)
    answers[r.question_id] = { response: r.response, flagged: r.flagged, seq: r.seq, saved_at: r.saved_at };
  return {
    attempt: attemptHeader(att, a, ctx.now()),
    assessment: { id: a.id, title: a.title, instructions: a.instructions, duration_minutes: a.duration_minutes, allow_navigation: a.allow_navigation, total_marks: a.total_marks, allowed_resources: a.settings?.allowed_resources || null, allowed_file_types: a.settings?.allowed_file_types || null },
    questions, answers
  };
}

// ---------- start ----------
export async function startAttempt(ctx, user, assessmentId, { startKey } = {}) {
  await refreshAssessment(ctx, assessmentId);
  try {
    return await ctx.db.tx(async (q) => {
      await q.query('select id from users where id=$1 for update', [user.id]);    // serialise starts per student
      const now = ctx.now();
      const a = await one(q, 'select * from assessments where id=$1 for update', [assessmentId]);
      if (!a) throw notFound('Assessment not found.');
      const enrolled = await one(q, `select 1 as x from enrolments e join course_offerings o on o.id=e.offering_id
        where e.student_id=$1 and e.status='active' and o.course_id=$2 and ($3::uuid is null or o.id=$3)`, [user.id, a.course_id, a.offering_id]);
      if (!enrolled) throw notFound('Assessment not found.');                      // do not reveal assessments outside the student's courses

      // Idempotent: the same start request (or a second tab) returns the live attempt instead of creating another.
      const live = await one(q, "select * from attempts where assessment_id=$1 and student_id=$2 and status='in_progress' for update", [a.id, user.id]);
      if (live) {
        if (live.deadline_at.getTime() + ctx.config.saveGraceSeconds * 1000 >= now.getTime()) {
          await q.query("insert into attempt_events(attempt_id,type,meta,created_at) values($1,'reconnect','{}'::jsonb,$2)", [live.id, now]);
          return { ...(await buildView(ctx, q, live)), resumed: true };
        }
        await finalizeInTx(ctx, q, live, { auto: true });
      }
      if (startKey) {
        const dup = await one(q, 'select * from attempts where assessment_id=$1 and student_id=$2 and start_key=$3', [a.id, user.id, startKey]);
        if (dup) return { ...(await buildView(ctx, q, dup)), resumed: true };
      }
      if (!['published', 'in_progress'].includes(a.status)) throw conflict(a.status === 'scheduled' ? 'This assessment has not opened yet.' : 'This assessment is not available.', 'not_available');
      const acc = await accommodationFor(q, user.id, a);
      if (a.opens_at && now < a.opens_at) throw conflict('This assessment has not opened yet.', 'not_open', { opens_at: a.opens_at });
      const lr = lateRule(a);
      let effectiveClose = a.closes_at, late = false, penalty = 0;
      if (now > a.closes_at) {
        const ext = [acc.allowLateUntil, lr?.until].filter(Boolean).sort((x, y) => y - x)[0];
        if (!ext || now > ext) throw conflict('This assessment has closed.', 'closed', { closes_at: a.closes_at });
        effectiveClose = ext; late = true; penalty = acc.allowLateUntil && now <= acc.allowLateUntil ? 0 : (lr?.penalty || 0);
      } else if (acc.allowLateUntil && acc.allowLateUntil > a.closes_at) effectiveClose = acc.allowLateUntil;
      else if (lr && lr.until > a.closes_at) effectiveClose = lr.until;

      const count = (await one(q, 'select count(*)::int as n from attempts where assessment_id=$1 and student_id=$2', [a.id, user.id])).n;
      if (a.max_attempts != null && count >= a.max_attempts + acc.extraAttempts) throw conflict('You have used all your attempts for this assessment.', 'attempt_limit');

      const rows = await loadQuestions(q, a.id);
      if (!rows.length) throw conflict('This assessment has no questions.', 'not_available');
      const ids = rows.map((r) => r.question_id);
      const order = a.randomize_questions ? shuffle(ids) : ids;
      const optionOrders = {};
      if (a.randomize_options) for (const r of rows) if (r.snapshot.options?.length) optionOrders[r.question_id] = shuffle(r.snapshot.options.map((o) => o.id));
      const deadline = a.duration_minutes
        ? new Date(Math.min(now.getTime() + (a.duration_minutes * 60 + acc.extraSeconds) * 1000, effectiveClose.getTime() + acc.extraSeconds * 1000))
        : effectiveClose;
      const att = await one(q, `insert into attempts(assessment_id,student_id,attempt_no,status,started_at,deadline_at,extra_seconds,late,late_penalty_pct,question_order,option_orders,start_key,created_at)
        values($1,$2,$3,'in_progress',$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$4) returning *`,
        [a.id, user.id, count + 1, now, deadline, acc.extraSeconds, late, penalty, j(order), j(optionOrders), startKey || null]);
      await q.query("insert into attempt_events(attempt_id,type,meta,created_at) values($1,'start',$2::jsonb,$3)", [att.id, j({ attempt_no: att.attempt_no, deadline_at: deadline }), now]);
      if (a.status === 'published') await q.query("update assessments set status='in_progress', updated_at=$2 where id=$1", [a.id, now]);
      return { ...(await buildView(ctx, q, att)), resumed: false };
    });
  } catch (e) {
    if (e.code === '23505' && /attempts_one_active_uq/.test(String(e.message + e.constraint))) {   // lost a race: return the winner's attempt
      const live = await ctx.db.one("select id from attempts where assessment_id=$1 and student_id=$2 and status='in_progress'", [assessmentId, user.id]);
      if (live) return { ...(await getAttemptView(ctx, user, live.id)), resumed: true };
    }
    throw e;
  }
}

export async function getAttemptView(ctx, user, attemptId) {
  const att0 = await ctx.db.one('select * from attempts where id=$1', [attemptId]);
  if (!att0 || att0.student_id !== user.id) throw notFound('Attempt not found.');
  if (att0.status === 'in_progress' && att0.deadline_at.getTime() + ctx.config.saveGraceSeconds * 1000 < ctx.now().getTime()) await submitAttempt(ctx, user, attemptId, { auto: true });
  return ctx.db.tx(async (q) => buildView(ctx, q, await one(q, 'select * from attempts where id=$1', [attemptId])));
}

// ---------- autosave ----------
export async function saveAnswers(ctx, user, attemptId, items) {
  if (!Array.isArray(items) || !items.length || items.length > 100) throw bad('Send between 1 and 100 answers.');
  const result = await ctx.db.tx(async (q) => {
    const att = await one(q, 'select * from attempts where id=$1 for update', [attemptId]);
    if (!att || att.student_id !== user.id) throw notFound('Attempt not found.');
    const now = ctx.now();
    if (att.status !== 'in_progress') throw conflict('This attempt has already been submitted.', 'attempt_closed', { receipt_code: att.receipt_code, status: att.status });
    if (now.getTime() > att.deadline_at.getTime() + ctx.config.saveGraceSeconds * 1000) return { expired: true };
    const valid = new Set((await q.query('select question_id from assessment_questions where assessment_id=$1', [att.assessment_id])).rows.map((r) => r.question_id));
    const saved = [];
    for (const it of items) {
      if (!valid.has(it.question_id)) throw bad('Unknown question for this assessment.');
      const bytes = Buffer.byteLength(JSON.stringify(it.response ?? null));
      if (bytes > SAVE_MAX_BYTES) throw bad('Answer is too large.');
      const seq = Number.isInteger(it.seq) ? it.seq : 0;
      if (it.response && typeof it.response === 'object' && Array.isArray(it.response.file_ids)) {
        for (const fid of it.response.file_ids) {
          const f = await one(q, "select 1 as x from files where id=$1 and owner_id=$2 and purpose='answer_upload'", [fid, user.id]);
          if (!f) throw bad('One of the uploaded files does not belong to you.');
        }
      }
      const r = await q.query(`insert into answers(attempt_id,question_id,response,flagged,seq,saved_at) values($1,$2,$3::jsonb,$4,$5,$6)
        on conflict (attempt_id,question_id) do update set response=excluded.response, flagged=excluded.flagged, seq=excluded.seq, saved_at=excluded.saved_at
        where answers.seq < excluded.seq returning saved_at`, [att.id, it.question_id, j(it.response ?? null), !!it.flagged, seq, now]);
      saved.push({ question_id: it.question_id, saved: r.rowCount > 0, stale: r.rowCount === 0, saved_at: now });
    }
    await q.query("insert into attempt_events(attempt_id,type,meta,created_at) values($1,'save',$2::jsonb,$3)", [att.id, j({ questions: saved.length }), now]);
    return { saved, server_now: now, deadline_at: att.deadline_at, remaining_seconds: Math.max(0, Math.floor((att.deadline_at - now) / 1000)) };
  });
  if (result.expired) {
    const fin = await submitAttempt(ctx, user, attemptId, { auto: true });
    throw conflict('Time is up. Your saved answers were submitted automatically.', 'time_expired', fin);
  }
  return result;
}

// ---------- finalisation (submit / auto-submit) + grading ----------
export async function gradeAttemptInTx(ctx, q, att, a) {
  const rows = await loadQuestions(q, a.id);
  const answers = new Map((await q.query('select question_id, response from answers where attempt_id=$1', [att.id])).rows.map((r) => [r.question_id, r.response]));
  const now = ctx.now();
  await q.query('delete from answer_grades where attempt_id=$1', [att.id]);
  for (const r of rows) {
    const snap = { ...r.snapshot, marks: r.marks };
    const g = gradeResponse(snap, answers.get(r.question_id), { negative: a.negative_marking });
    await q.query(`insert into answer_grades(attempt_id,question_id,max_marks,auto_marks,final_marks,status,details,graded_at)
      values($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`, [att.id, r.question_id, r.marks, g.marks, g.status === 'pending_manual' || g.status === 'needs_review' ? null : g.marks, g.status, j(g.details), g.status === 'pending_manual' || g.status === 'needs_review' ? null : now]);
  }
  return recomputeAttempt(ctx, q, att.id);
}

export async function recomputeAttempt(ctx, q, attemptId) {
  const att = await one(q, 'select * from attempts where id=$1', [attemptId]);
  const a = await one(q, 'select pass_percentage from assessments where id=$1', [att.assessment_id]);
  const grades = (await q.query('select max_marks, final_marks, status from answer_grades where attempt_id=$1', [attemptId])).rows;
  const t = totalsFor(grades, { passPercentage: a.pass_percentage, latePenaltyPct: att.late_penalty_pct });
  await q.query('update attempts set score=$2, max_score=$3, percentage=$4, passed=$5, grading_status=$6, graded_at=$7 where id=$1',
    [attemptId, t.score, t.max_score, t.percentage, t.passed, t.grading_status, t.grading_status === 'graded' ? ctx.now() : null]);
  return t;
}

async function finalizeInTx(ctx, q, att, { auto, reason }) {
  if (att.status !== 'in_progress') return att;
  const now = ctx.now();
  const expired = now.getTime() > att.deadline_at.getTime();
  const status = auto || expired ? 'auto_submitted' : 'submitted';
  const submittedAt = expired ? att.deadline_at : now;                                  // evidence of when the work stopped counting
  const receipt = 'KT-' + crypto.createHash('sha256').update(`${att.id}|${submittedAt.toISOString()}|${randomToken(8)}`).digest('hex').slice(0, 10).toUpperCase();
  const a = await one(q, 'select * from assessments where id=$1', [att.assessment_id]);
  await q.query('update attempts set status=$2, submitted_at=$3, receipt_code=$4 where id=$1', [att.id, status, submittedAt, receipt]);
  await q.query("insert into attempt_events(attempt_id,type,meta,created_at) values($1,$2,$3::jsonb,$4)", [att.id, status === 'submitted' ? 'submit' : 'timeout_submit', j({ reason: reason || null }), now]);
  const fresh = await one(q, 'select * from attempts where id=$1', [att.id]);
  await gradeAttemptInTx(ctx, q, fresh, a);
  return one(q, 'select * from attempts where id=$1', [att.id]);
}

export async function submitAttempt(ctx, user, attemptId, { auto = false } = {}) {
  const out = await ctx.db.tx(async (q) => {
    const att = await one(q, 'select * from attempts where id=$1 for update', [attemptId]);
    if (!att || (user && att.student_id !== user.id)) throw notFound('Attempt not found.');
    if (att.status !== 'in_progress') return { already_submitted: true, status: att.status, receipt_code: att.receipt_code, submitted_at: att.submitted_at };
    const done = await finalizeInTx(ctx, q, att, { auto });
    return { already_submitted: false, status: done.status, receipt_code: done.receipt_code, submitted_at: done.submitted_at, expired: done.status === 'auto_submitted' };
  });
  await refreshAssessmentSafe(ctx, attemptId);
  return out;
}
const refreshAssessmentSafe = async (ctx, attemptId) => { const r = await ctx.db.one('select assessment_id from attempts where id=$1', [attemptId]); if (r) await refreshAssessment(ctx, r.assessment_id, { skipFinalize: true }); };

// Sweeper: finalises every attempt whose deadline (+ save grace) has passed. Run by cron and lazily on access.
export async function finalizeExpired(ctx, { limit = 200 } = {}) {
  const cutoff = new Date(ctx.now().getTime() - ctx.config.saveGraceSeconds * 1000);
  const rows = (await ctx.db.query("select id from attempts where status='in_progress' and deadline_at < $1 order by deadline_at limit $2", [cutoff, limit])).rows;
  for (const r of rows) await submitAttempt(ctx, null, r.id, { auto: true });
  return rows.length;
}

// ---------- time-driven assessment lifecycle ----------
export async function refreshAssessment(ctx, assessmentId, { skipFinalize = false } = {}) {
  if (!skipFinalize) {
    const cutoff = new Date(ctx.now().getTime() - ctx.config.saveGraceSeconds * 1000);
    const stale = (await ctx.db.query("select id from attempts where assessment_id=$1 and status='in_progress' and deadline_at < $2", [assessmentId, cutoff])).rows;
    for (const r of stale) await submitAttempt(ctx, null, r.id, { auto: true });
  }
  await ctx.db.tx(async (q) => {
    const a = await one(q, 'select * from assessments where id=$1 for update', [assessmentId]);
    if (!a) return;
    const now = ctx.now();
    const move = async (to) => { await q.query('update assessments set status=$2, updated_at=$3 where id=$1', [a.id, to, now]); await audit(q, ctx, { action: 'assessment.auto_transition', entity: 'assessment', id: a.id, meta: { from: a.status, to } }); a.status = to; };
    if (a.status === 'scheduled' && a.opens_at && now >= a.opens_at) { await q.query('update assessments set published_at=$2 where id=$1', [a.id, now]); await move('published'); }
    if (['published', 'in_progress'].includes(a.status) && now > a.closes_at) {
      const live = (await one(q, "select count(*)::int as n from attempts where assessment_id=$1 and status='in_progress'", [a.id])).n;
      const lr = lateRule(a);
      const lateOpen = lr && now <= lr.until;
      if (!live && !lateOpen) await move('closed');
    }
    if (a.status === 'closed') {
      const open = (await one(q, "select count(*)::int as n from attempts where assessment_id=$1 and status<>'in_progress' and grading_status<>'graded'", [a.id])).n;
      const live = (await one(q, "select count(*)::int as n from attempts where assessment_id=$1 and status='in_progress'", [a.id])).n;
      if (!open && !live) await move('graded');
    }
    if (a.status === 'graded' && a.results_release_at && now >= a.results_release_at) {
      await q.query('update assessments set results_released_at=$2 where id=$1', [a.id, now]); await move('results_released');
    }
  });
}
export async function refreshAllDue(ctx) {
  const rows = (await ctx.db.query("select id from assessments where status in ('scheduled','published','in_progress','closed','graded')")).rows;
  for (const r of rows) await refreshAssessment(ctx, r.id, { skipFinalize: true });
  return rows.length;
}

// ---------- administrative recovery ----------
export async function extendAttempt(ctx, actor, attemptId, { minutes, reason }, req) {
  if (!(minutes > 0 && minutes <= 240)) throw bad('Extra time must be between 1 and 240 minutes.');
  if (!reason || reason.trim().length < 5) throw bad('A reason is required.');
  return ctx.db.tx(async (q) => {
    const att = await one(q, 'select * from attempts where id=$1 for update', [attemptId]);
    if (!att) throw notFound('Attempt not found.');
    if (att.status !== 'in_progress') throw conflict('Only in-progress attempts can be extended. Use reopen for submitted attempts.');
    const deadline = new Date(att.deadline_at.getTime() + minutes * 60000);
    await q.query('update attempts set deadline_at=$2, extra_seconds=extra_seconds+$3 where id=$1', [att.id, deadline, minutes * 60]);
    await q.query("insert into attempt_events(attempt_id,type,meta,created_at) values($1,'extra_time',$2::jsonb,$3)", [att.id, j({ minutes, reason, by: actor.id }), ctx.now()]);
    await audit(q, ctx, { actor, action: 'attempt.extend', entity: 'attempt', id: att.id, meta: { minutes, reason }, req });
    return { deadline_at: deadline };
  });
}
export async function reopenAttempt(ctx, actor, attemptId, { minutes, reason }, req) {
  if (!(minutes > 0 && minutes <= 240)) throw bad('Minutes must be between 1 and 240.');
  if (!reason || reason.trim().length < 5) throw bad('A reason is required.');
  return ctx.db.tx(async (q) => {
    const att = await one(q, 'select * from attempts where id=$1 for update', [attemptId]);
    if (!att) throw notFound('Attempt not found.');
    if (att.status === 'in_progress') throw conflict('The attempt is already in progress.');
    const a = await one(q, 'select status from assessments where id=$1', [att.assessment_id]);
    if (['results_released', 'archived'].includes(a.status)) throw conflict('Results were already released; reopening is not allowed.');
    const other = await one(q, "select 1 as x from attempts where assessment_id=$1 and student_id=$2 and status='in_progress'", [att.assessment_id, att.student_id]);
    if (other) throw conflict('The student already has another attempt in progress.');
    const now = ctx.now(); const deadline = new Date(now.getTime() + minutes * 60000);
    await q.query("update attempts set status='in_progress', deadline_at=$2, submitted_at=null, reopened_count=reopened_count+1, grading_status='not_graded', score=null, percentage=null, passed=null where id=$1", [att.id, deadline]);
    await q.query('delete from answer_grades where attempt_id=$1', [att.id]);
    await q.query("insert into attempt_events(attempt_id,type,meta,created_at) values($1,'reopened',$2::jsonb,$3)", [att.id, j({ minutes, reason, by: actor.id, previous_receipt: att.receipt_code }), now]);
    if (['closed', 'graded'].includes(a.status)) await q.query("update assessments set status='in_progress' where id=$1", [att.assessment_id]);
    await audit(q, ctx, { actor, action: 'attempt.reopen', entity: 'attempt', id: att.id, meta: { minutes, reason }, req });
    return { deadline_at: deadline };
  });
}
export { round2 };
