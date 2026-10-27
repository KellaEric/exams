import { Router } from 'express';
import { z } from 'zod';
import { wrap, bad, notFound, forbidden, conflict, HttpError } from '../lib/errors.js';
import { need, needAny, parse, staffOnly } from '../middleware.js';
import { audit } from '../lib/audit.js';
import { needUuid, pageParams, normTitle, toCsv } from '../lib/util.js';
import { requireCourse } from '../lib/access.js';
import { normalizeQuestion, loadQuestion, writeOptions, saveVersion } from '../lib/questions.js';
import { parseCsv } from '../lib/catalogue.js';
import { j } from '../db/index.js';

const r = Router();

async function insertQuestion(q, ctx, n, courseId, userId) {
  const row = (await q.query(`insert into questions(course_id,topic,category_key,type,difficulty,marks,stem,instructions,attachment_file_id,config,answer_key,rubric,explanation,status,author_id,created_at,updated_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,'draft',$14,$15,$15) returning id`,
    [courseId, n.topic, n.category_key, n.type, n.difficulty, n.marks, n.stem, n.instructions, n.attachment_file_id, j(n.config), j(n.answer_key), j(n.rubric), n.explanation, userId, ctx.now()])).rows[0];
  await writeOptions(q, row.id, n.options);
  const full = await loadQuestion(q, row.id); await saveVersion(q, full, userId, 'created', ctx.now());
  return full;
}
const canAuthor = (req) => { if (!req.user.perms.has('question.author') && !req.user.perms.has('assessment.manage_all')) throw forbidden('You cannot author questions.'); };

r.get('/courses/:cid/questions', staffOnly, wrap(async (req, res) => {
  const { ctx } = req; const cid = needUuid(req.params.cid); await requireCourse(ctx, req.user, cid);
  const { limit, offset } = pageParams(req.query, 50); const w = ['q.course_id=$1'], p = [cid];
  for (const f of ['type', 'status', 'difficulty', 'topic']) if (req.query[f]) { p.push(req.query[f]); w.push(`q.${f}=$${p.length}`); }
  if (req.query.q) { p.push(`%${String(req.query.q).toLowerCase()}%`); w.push(`lower(q.stem) like $${p.length}`); }
  const where = 'where ' + w.join(' and ');
  const total = (await ctx.db.one(`select count(*)::int as n from questions q ${where}`, p)).n;
  const rows = (await ctx.db.query(`select q.id,q.type,q.topic,q.difficulty,q.marks,q.stem,q.status,q.version,q.author_id,u.full_name as author_name,q.updated_at from questions q join users u on u.id=q.author_id ${where} order by q.updated_at desc limit ${limit} offset ${offset}`, p)).rows;
  res.json({ total, rows });
}));

r.post('/courses/:cid/questions', staffOnly, wrap(async (req, res) => {
  const { ctx } = req; const cid = needUuid(req.params.cid); canAuthor(req); await requireCourse(ctx, req.user, cid, { write: true });
  const n = normalizeQuestion(req.body);
  const full = await ctx.db.tx(async (q) => { const f = await insertQuestion(q, ctx, n, cid, req.user.id); await audit(q, ctx, { actor: req.user, action: 'question.create', entity: 'question', id: f.id, meta: { type: n.type }, req }); return f; });
  res.status(201).json(full);
}));

r.get('/questions/:id', staffOnly, wrap(async (req, res) => {
  const qn = await loadQuestion(req.ctx.db, needUuid(req.params.id)); if (!qn) throw notFound('Question not found.');
  await requireCourse(req.ctx, req.user, qn.course_id); res.json(qn);
}));
r.get('/questions/:id/versions', staffOnly, wrap(async (req, res) => {
  const qn = await req.ctx.db.one('select course_id from questions where id=$1', [needUuid(req.params.id)]); if (!qn) throw notFound();
  await requireCourse(req.ctx, req.user, qn.course_id);
  res.json({ rows: (await req.ctx.db.query('select v.version, v.reason, v.created_at, u.full_name as changed_by from question_versions v left join users u on u.id=v.changed_by where v.question_id=$1 order by v.version desc', [req.params.id])).rows });
}));

r.put('/questions/:id', staffOnly, wrap(async (req, res) => {
  const { ctx } = req; const id = needUuid(req.params.id); canAuthor(req);
  const pre = await ctx.db.one('select course_id from questions where id=$1', [id]); if (!pre) throw notFound('Question not found.');
  await requireCourse(ctx, req.user, pre.course_id, { write: true });     // scope check BEFORE opening the transaction
  const full = await ctx.db.tx(async (q) => {
    const cur = await loadQuestion(q, id); if (!cur) throw notFound('Question not found.');
    if (cur.status === 'retired') throw conflict('Retired questions cannot be edited. Duplicate it instead.');
    const n = normalizeQuestion({ ...req.body, type: cur.type });          // a question's type cannot change after creation
    await saveVersion(q, cur, req.user.id, req.body.change_reason || 'edited', ctx.now());
    await q.query(`update questions set topic=$2,category_key=$3,difficulty=$4,marks=$5,stem=$6,instructions=$7,attachment_file_id=$8,config=$9::jsonb,answer_key=$10::jsonb,rubric=$11::jsonb,explanation=$12,
      status='draft', reviewer_id=null, approved_by=null, approved_at=null, version=version+1, updated_at=$13 where id=$1`,
      [id, n.topic, n.category_key, n.difficulty, n.marks, n.stem, n.instructions, n.attachment_file_id, j(n.config), j(n.answer_key), j(n.rubric), n.explanation, ctx.now()]);
    await writeOptions(q, id, n.options);
    const f = await loadQuestion(q, id); await saveVersion(q, f, req.user.id, 'current', ctx.now());
    await audit(q, ctx, { actor: req.user, action: 'question.update', entity: 'question', id, meta: { version: f.version }, req });
    return f;
  });
  res.json(full);
}));

r.post('/questions/:id/duplicate', staffOnly, wrap(async (req, res) => {
  const { ctx } = req; canAuthor(req);
  const cur = await loadQuestion(ctx.db, needUuid(req.params.id)); if (!cur) throw notFound();
  await requireCourse(ctx, req.user, cur.course_id, { write: true });
  const n = { ...cur, stem: `${cur.stem} (copy)`, options: cur.options.map((o) => ({ position: o.position, text: o.text, is_correct: o.is_correct, feedback: o.feedback })) };
  const full = await ctx.db.tx((q) => insertQuestion(q, ctx, n, cur.course_id, req.user.id));
  await audit(ctx.db, ctx, { actor: req.user, action: 'question.duplicate', entity: 'question', id: full.id, meta: { from: cur.id }, req }); res.status(201).json(full);
}));

// Workflow: draft -> in_review -> approved (or back to draft) ; approved -> retired.
r.post('/questions/:id/:action(submit|approve|reject|retire)', staffOnly, wrap(async (req, res) => {
  const { ctx } = req; const id = needUuid(req.params.id); const action = req.params.action;
  const pre = await ctx.db.one('select course_id from questions where id=$1', [id]); if (!pre) throw notFound('Question not found.');
  await requireCourse(ctx, req.user, pre.course_id, { write: true });
  const out = await ctx.db.tx(async (q) => {
    const cur = (await q.query('select * from questions where id=$1 for update', [id])).rows[0]; if (!cur) throw notFound('Question not found.');
    let to;
    if (action === 'submit') { if (cur.status !== 'draft') throw conflict('Only draft questions can be submitted for review.'); if (!req.user.perms.has('question.author')) throw forbidden(); to = 'in_review'; }
    else if (action === 'approve') {
      if (cur.status !== 'in_review') throw conflict('Only questions in review can be approved.');
      if (!req.user.perms.has('question.approve')) throw forbidden('You cannot approve questions.');
      if (cur.author_id === req.user.id && !ctx.config.allowSelfApproval && req.user.role_key !== 'super_admin') throw forbidden('Questions must be approved by someone other than the author.');
      to = 'approved';
    } else if (action === 'reject') { if (cur.status !== 'in_review') throw conflict('Only questions in review can be returned.'); if (!req.user.perms.has('question.review')) throw forbidden(); to = 'draft'; }
    else { if (!req.user.perms.has('question.approve')) throw forbidden(); to = 'retired'; }
    await q.query('update questions set status=$2, reviewer_id=$3, approved_by=$4, approved_at=$5, updated_at=$6 where id=$1',
      [id, to, ['approve', 'reject'].includes(action) ? req.user.id : cur.reviewer_id, to === 'approved' ? req.user.id : null, to === 'approved' ? ctx.now() : null, ctx.now()]);
    await audit(q, ctx, { actor: req.user, action: `question.${action}`, entity: 'question', id, meta: { from: cur.status, to, note: req.body?.note || null }, req });
    return { id, status: to };
  });
  res.json(out);
}));

// ---------- bulk import (validate first; `dry_run:true` saves nothing) ----------
const csvToQuestion = (row) => {
  const type = row.type;
  const base = { type, stem: row.stem, marks: row.marks, topic: row.topic, difficulty: row.difficulty, instructions: row.instructions, explanation: row.explanation };
  const correct = String(row.correct || '').split(/[;|]/).map((x) => x.trim().toUpperCase()).filter(Boolean);
  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  if (type === 'mcq' || type === 'multi_select') base.options = letters.map((l) => row[`option_${l.toLowerCase()}`] ? { text: row[`option_${l.toLowerCase()}`], is_correct: correct.includes(l) } : null).filter(Boolean);
  else if (type === 'true_false') base.correct = String(row.correct).toLowerCase() === 'true';
  else if (type === 'short_answer') base.accepted = String(row.accepted || '').split('|').map((x) => x.trim()).filter(Boolean);
  else if (type === 'numeric') Object.assign(base, { value: row.value, tolerance: row.tolerance || 0, tolerance_type: row.tolerance_type });
  else if (!['essay'].includes(type)) throw new HttpError(400, `CSV import does not support "${type}" questions; use JSON for that type.`);
  return base;
};
r.post('/courses/:cid/questions/import', staffOnly, wrap(async (req, res) => {
  const { ctx } = req; const cid = needUuid(req.params.cid); canAuthor(req); await requireCourse(ctx, req.user, cid, { write: true });
  const b = parse(z.object({ format: z.enum(['json', 'csv']).default('json'), data: z.array(z.any()).max(1000).optional(), csv: z.string().max(2_000_000).optional(), dry_run: z.boolean().default(true) }), req.body);
  const rows = b.format === 'csv' ? parseCsv(b.csv || '') : (b.data || []);
  const existing = new Set((await ctx.db.query('select type, stem from questions where course_id=$1 and status<>$2', [cid, 'retired'])).rows.map((x) => `${x.type}|${normTitle(x.stem)}`));
  const report = { total: rows.length, valid: 0, errors: [], duplicates: [], created: 0 };
  const good = [];
  rows.forEach((row, i) => {
    try {
      const n = normalizeQuestion(b.format === 'csv' ? csvToQuestion(row) : row);
      const k = `${n.type}|${normTitle(n.stem)}`;
      if (existing.has(k)) { report.duplicates.push({ row: i + 1, stem: n.stem.slice(0, 80) }); return; }
      existing.add(k); good.push(n); report.valid++;
    } catch (e) { report.errors.push({ row: i + 1, error: e.message, details: e.details?.problems }); }
  });
  if (!b.dry_run) {
    if (report.errors.length) throw bad('Fix the invalid rows before importing (nothing was saved).', report);
    await ctx.db.tx(async (q) => { for (const n of good) await insertQuestion(q, ctx, n, cid, req.user.id); report.created = good.length; await audit(q, ctx, { actor: req.user, action: 'question.import', entity: 'course', id: cid, meta: { created: good.length }, req }); });
  }
  res.json({ dry_run: b.dry_run, ...report });
}));

r.get('/courses/:cid/questions/export', staffOnly, need('report.export'), wrap(async (req, res) => {
  const { ctx } = req; const cid = needUuid(req.params.cid); await requireCourse(ctx, req.user, cid, { write: true });
  const rows = (await ctx.db.query('select * from questions where course_id=$1 order by created_at', [cid])).rows;
  for (const row of rows) row.options = (await ctx.db.query('select position,text,is_correct,feedback from question_options where question_id=$1 order by position', [row.id])).rows;
  await audit(ctx.db, ctx, { actor: req.user, action: 'question.export', entity: 'course', id: cid, meta: { count: rows.length }, req });
  if (req.query.format === 'csv') {
    res.type('text/csv').attachment('questions.csv').send(toCsv([['type', 'topic', 'difficulty', 'marks', 'status', 'stem'], ...rows.map((x) => [x.type, x.topic, x.difficulty, x.marks, x.status, x.stem])]));
  } else res.attachment('questions.json').json(rows.map(({ id, author_id, reviewer_id, approved_by, course_id, ...x }) => x));
}));
export default r;
