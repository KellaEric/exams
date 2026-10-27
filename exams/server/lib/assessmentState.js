import { bad, conflict } from './errors.js';
import { AUTO_TYPES } from './grading.js';
import { round2 } from './util.js';

export const STATES = ['draft', 'pending_review', 'approved', 'scheduled', 'published', 'in_progress', 'closed', 'graded', 'results_released', 'archived'];
export const TRANSITIONS = {
  draft: ['pending_review', 'archived'],
  pending_review: ['approved', 'draft'],
  approved: ['scheduled', 'published', 'draft'],
  scheduled: ['published', 'approved'],
  published: ['in_progress', 'closed'],
  in_progress: ['closed'],
  closed: ['graded', 'archived'],
  graded: ['results_released', 'archived'],
  results_released: ['archived'],
  archived: []
};
export const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);
export function assertTransition(from, to) {
  if (!canTransition(from, to)) throw conflict(`An assessment cannot move from "${from}" to "${to}".`, 'invalid_transition', { from, to, allowed: TRANSITIONS[from] });
}
export const EDITABLE = new Set(['draft']);   // content (questions, marks, rules) is frozen once review starts

// Checks everything required before an assessment may leave draft. Returns a list of human-readable problems.
export function publishProblems(a, qs, category) {
  const p = [];
  if (!a.title?.trim()) p.push('Title is required.');
  if (!category?.enabled) p.push('The assessment category is disabled.');
  if (!qs.length) p.push('Add at least one question.');
  if (!a.closes_at) p.push('A closing date and time is required.');
  if (a.opens_at && a.closes_at && a.closes_at <= a.opens_at) p.push('The closing time must be after the opening time.');
  if (category?.timed_by_default && !a.duration_minutes && !['assignment', 'project'].includes(category.kind)) p.push('A duration in minutes is required for this assessment type.');
  if (a.duration_minutes && a.opens_at && a.closes_at && a.duration_minutes * 60000 > a.closes_at - a.opens_at) p.push('The duration is longer than the availability window.');
  if (!(a.pass_percentage >= 0 && a.pass_percentage <= 100)) p.push('Pass percentage must be between 0 and 100.');
  const total = round2(qs.reduce((s, q) => s + q.marks, 0));
  if (a.expected_total_marks != null && round2(a.expected_total_marks) !== total) p.push(`Total marks mismatch: expected ${a.expected_total_marks} but the questions add up to ${total}.`);
  for (const q of qs) {
    const label = `Question ${q.position + 1}`;
    if (q.status !== 'approved') p.push(`${label} is not approved (status: ${q.status}).`);
    if (!(q.marks > 0)) p.push(`${label} must have marks greater than 0.`);
    if (AUTO_TYPES.has(q.type)) {
      const k = q.answer_key || {};
      const ok = q.type === 'mcq' ? q.options.filter((o) => o.is_correct).length === 1
        : q.type === 'multi_select' ? q.options.some((o) => o.is_correct)
        : q.type === 'true_false' ? typeof k.value === 'boolean'
        : q.type === 'short_answer' ? k.accepted?.length > 0
        : q.type === 'fill_blank' ? k.blanks?.length > 0 && k.blanks.every((b) => b.accepted?.length)
        : q.type === 'numeric' ? Number.isFinite(k.value)
        : q.type === 'matching' ? Object.keys(k.pairs || {}).length >= 2
        : q.type === 'ordering' ? (k.order || []).length >= 2 : true;
      if (!ok) p.push(`${label} (${q.type}) has no valid answer key.`);
    }
    if (q.type === 'code' && (q.answer_key?.mode === 'static_checks') && !(q.answer_key.checks?.length)) p.push(`${label} uses pattern checks but defines none.`);
    if (q.rubric?.length && round2(q.rubric.reduce((s, r) => s + r.max, 0)) !== round2(q.marks)) p.push(`${label}: rubric marks do not add up to the question marks.`);
  }
  return p;
}
export function assertPublishable(a, qs, category) {
  const problems = publishProblems(a, qs, category);
  if (problems.length) throw bad('This assessment cannot be published yet.', { problems });
}
