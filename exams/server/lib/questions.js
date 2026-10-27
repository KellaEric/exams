import { j } from '../db/index.js';
import { bad } from './errors.js';
import { round2 } from './util.js';
import { patternProblem } from './pycheck.js';

export const TYPES = ['mcq', 'multi_select', 'true_false', 'short_answer', 'fill_blank', 'essay', 'numeric', 'matching', 'ordering', 'code', 'file_upload', 'practical'];
const str = (v, name, { min = 0, max = 20000 } = {}) => { const s = typeof v === 'string' ? v.trim() : ''; if (s.length < min) throw bad(`${name} is required.`); if (s.length > max) throw bad(`${name} is too long.`); return s; };
const list = (v, name, min = 0, max = 50) => { if (!Array.isArray(v) || v.length < min) throw bad(`${name}: provide at least ${min}.`); if (v.length > max) throw bad(`${name}: too many entries.`); return v; };
const accepted = (v, name) => list(v, name, 1, 30).map((x) => str(String(x), name, { min: 1, max: 500 }));

// Turns author-friendly input into the stored shape: {config, answer_key, options, rubric}. Throws 400 with a clear message on invalid input.
export function normalizeQuestion(input) {
  const type = input.type;
  if (!TYPES.includes(type)) throw bad(`Unsupported question type "${type}". Supported: ${TYPES.join(', ')}.`);
  const marks = Number(input.marks);
  if (!(marks > 0 && marks <= 1000)) throw bad('Marks must be a number greater than 0.');
  const out = {
    type, marks: round2(marks), stem: str(input.stem, 'Question text', { min: 3 }),
    topic: input.topic ? str(input.topic, 'Topic', { max: 200 }) : null,
    difficulty: ['easy', 'medium', 'hard'].includes(input.difficulty) ? input.difficulty : 'medium',
    instructions: input.instructions ? str(input.instructions, 'Instructions') : null,
    explanation: input.explanation ? str(input.explanation, 'Explanation') : null,
    category_key: input.category_key || null, attachment_file_id: input.attachment_file_id || null,
    config: {}, answer_key: {}, options: [], rubric: []
  };
  const rubric = Array.isArray(input.rubric) ? input.rubric.map((r) => ({ criterion: str(r.criterion, 'Rubric criterion', { min: 1, max: 300 }), max: round2(Number(r.max)), description: r.description ? str(r.description, 'Rubric description') : '' })) : [];
  if (rubric.some((r) => !(r.max > 0))) throw bad('Every rubric criterion needs marks greater than 0.');
  if (rubric.length && round2(rubric.reduce((s, r) => s + r.max, 0)) !== out.marks) throw bad(`Rubric marks (${round2(rubric.reduce((s, r) => s + r.max, 0))}) must add up to the question marks (${out.marks}).`);
  out.rubric = rubric;
  const opts = () => list(input.options, 'Options', 2, 12).map((o, i) => ({ position: i, text: str(o.text, `Option ${i + 1}`, { min: 1, max: 1000 }), is_correct: !!o.is_correct, feedback: o.feedback ? str(o.feedback, 'Option feedback') : null }));
  switch (type) {
    case 'mcq': { out.options = opts(); if (out.options.filter((o) => o.is_correct).length !== 1) throw bad('A multiple-choice question needs exactly one correct option.'); break; }
    case 'multi_select': { out.options = opts(); if (!out.options.some((o) => o.is_correct)) throw bad('Mark at least one correct option.'); out.config.partial = input.partial !== false; break; }
    case 'true_false': { if (typeof input.correct !== 'boolean') throw bad('Say whether the statement is true or false (correct: true/false).'); out.answer_key = { value: input.correct }; break; }
    case 'short_answer': out.answer_key = { accepted: accepted(input.accepted, 'Accepted answers'), case_sensitive: !!input.case_sensitive, review_unmatched: !!input.review_unmatched }; break;
    case 'fill_blank': {
      const blanks = list(input.blanks, 'Blanks', 1, 20).map((b, i) => ({ accepted: accepted(b.accepted, `Blank ${i + 1} accepted answers`) }));
      const markers = (out.stem.match(/_{3,}/g) || []).length;
      if (markers !== blanks.length) throw bad(`The question text has ${markers} blank marker(s) (___) but you defined ${blanks.length} blank answer(s).`);
      out.answer_key = { blanks, case_sensitive: !!input.case_sensitive }; out.config.blanks = blanks.length; break;
    }
    case 'numeric': {
      const value = Number(input.value); const tol = Number(input.tolerance ?? 0);
      if (!Number.isFinite(value)) throw bad('Provide the correct numeric value.');
      if (!(tol >= 0)) throw bad('Tolerance must be 0 or more.');
      out.answer_key = { value, tolerance: tol, tolerance_type: input.tolerance_type === 'percent' ? 'percent' : 'absolute' }; out.config.unit = input.unit ? str(input.unit, 'Unit', { max: 40 }) : null; break;
    }
    case 'matching': {
      const pairs = list(input.pairs, 'Pairs', 2, 12).map((p) => ({ left: str(p.left, 'Left item', { min: 1, max: 300 }), right: str(p.right, 'Right item', { min: 1, max: 300 }) }));
      const left = pairs.map((p, i) => ({ id: `l${i + 1}`, text: p.left })), right = pairs.map((p, i) => ({ id: `r${i + 1}`, text: p.right }));
      out.config = { left, right: [...right].sort((a, b) => a.text.localeCompare(b.text)) };   // sorted alphabetically so the order does not leak the key
      out.answer_key = { pairs: Object.fromEntries(left.map((l, i) => [l.id, right[i].id])) }; break;
    }
    case 'ordering': {
      const items = list(input.items, 'Items (in the correct order)', 2, 12).map((t, i) => ({ id: `o${i + 1}`, text: str(String(t), `Item ${i + 1}`, { min: 1, max: 300 }) }));
      out.config = { items: [...items].sort((a, b) => a.text.localeCompare(b.text)), partial: input.partial !== false };
      out.answer_key = { order: items.map((i) => i.id) }; break;
    }
    case 'essay': out.config = { max_words: Number(input.max_words) > 0 ? Math.floor(Number(input.max_words)) : null }; break;
    case 'file_upload': out.config = { allowed_types: Array.isArray(input.allowed_types) ? input.allowed_types.map(String).slice(0, 12) : ['pdf', 'png', 'jpg', 'zip'], max_files: Math.min(Number(input.max_files) || 1, 10) }; break;
    case 'practical': {
      if (!rubric.length) throw bad('Practical tasks need a marking rubric.');
      out.config = { steps: Array.isArray(input.steps) ? input.steps.map((s) => str(String(s), 'Step', { min: 1 })).slice(0, 30) : [], evidence_required: input.evidence_required !== false };
      break;
    }
    case 'code': {
      const mode = input.mode === 'static_checks' ? 'static_checks' : 'manual';
      out.config = { language: str(input.language || 'python', 'Language', { max: 30 }), starter_code: input.starter_code ? str(input.starter_code, 'Starter code') : '' };
      out.answer_key = { mode };
      if (mode === 'static_checks') {
        const checks = list(input.checks, 'Checks', 1, 30);
        let total = 0;
        const probs = [];
        const validate = (c, path) => {
          if (['all', 'any'].includes(c.type)) return list(c.checks, `${path}.checks`, 1, 10).forEach((s, i) => validate(s, `${path}.${i}`));
          if (c.type === 'regex') { const p = patternProblem(c.pattern); if (p) probs.push(`${path}: ${p}`); for (const [f] of c.replace || []) { const p2 = patternProblem(f); if (p2) probs.push(`${path}.replace: ${p2}`); } }
          else if (!['fexpr', 'minLength'].includes(c.type)) probs.push(`${path}: unknown check type "${c.type}".`);
        };
        out.answer_key.checks = checks.map((c, i) => { validate(c, `check ${i + 1}`); const pts = Number(c.points); if (!(pts > 0)) throw bad(`Check ${i + 1} needs points > 0.`); total += pts; return { ...c, name: str(c.name, `Check ${i + 1} name`, { min: 1, max: 200 }), points: pts }; });
        if (probs.length) throw bad('Invalid check definitions.', { problems: probs });
        if (round2(total) !== out.marks) throw bad(`Check points (${round2(total)}) must add up to the question marks (${out.marks}).`);
        out.answer_key.confirm_by_instructor = !!input.confirm_by_instructor;
      }
      break;
    }
  }
  return out;
}

export async function loadQuestion(q, id) {
  const row = (await q.query('select * from questions where id=$1', [id])).rows[0];
  if (!row) return null;
  row.options = (await q.query('select id, position, text, is_correct, feedback from question_options where question_id=$1 order by position', [id])).rows;
  return row;
}
export async function writeOptions(q, questionId, options) {
  await q.query('delete from question_options where question_id=$1', [questionId]);
  for (const o of options) await q.query('insert into question_options(question_id,position,text,is_correct,feedback) values($1,$2,$3,$4,$5)', [questionId, o.position, o.text, o.is_correct, o.feedback]);
}
export async function saveVersion(q, questionRow, userId, reason, now) {
  await q.query('insert into question_versions(question_id,version,snapshot,changed_by,reason,created_at) values($1,$2,$3::jsonb,$4,$5,$6) on conflict (question_id,version) do nothing',
    [questionRow.id, questionRow.version, j(questionRow), userId, reason || null, now]);
}
export const snapshotOf = (row) => ({
  id: row.id, type: row.type, stem: row.stem, instructions: row.instructions, explanation: row.explanation, attachment_file_id: row.attachment_file_id,
  config: row.config, answer_key: row.answer_key, rubric: row.rubric, options: row.options.map((o) => ({ id: o.id, position: o.position, text: o.text, is_correct: o.is_correct, feedback: o.feedback })), version: row.version
});
// Staff-facing representation (with keys). Never send this to students.
export const staffView = (row) => row;
