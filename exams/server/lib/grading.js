// Deterministic, server-side grading. Pure functions: (question snapshot, response) -> {status, marks, details}
// status: 'auto' (final automatic mark) | 'needs_review' (auto-grading unreliable; instructor decides) | 'pending_manual' | 'final' (nothing to grade)
import { round2 } from './util.js';
import { runStaticChecks } from './pycheck.js';

export const AUTO_TYPES = new Set(['mcq', 'multi_select', 'true_false', 'short_answer', 'fill_blank', 'numeric', 'matching', 'ordering']);
export const MANUAL_TYPES = new Set(['essay', 'file_upload', 'practical']);

const empty = (r) => r === null || r === undefined || r === '' || (Array.isArray(r) && r.length === 0) || (typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length === 0);
export const norm = (s, cs = false) => { let t = String(s ?? '').normalize('NFKC').trim().replace(/\s+/g, ' '); if (!cs) t = t.toLowerCase(); return t.replace(/[.\s]+$/, ''); };
const matchesAny = (resp, accepted = [], cs = false) => { const r = norm(resp, cs); return accepted.some((a) => norm(a, cs) === r); };

export function gradeResponse(q, response, { negative = false } = {}) {
  const max = q.marks;
  const key = q.answer_key || {};
  const cfg = q.config || {};
  const done = (marks, details = {}) => ({ status: 'auto', marks: round2(marks), details });

  if (MANUAL_TYPES.has(q.type) || (q.type === 'code' && (key.mode || 'manual') === 'manual')) {
    if (empty(response)) return { status: 'final', marks: 0, details: { note: 'No answer submitted.' } };
    return { status: 'pending_manual', marks: null, details: {} };
  }
  if (empty(response)) return done(0, { note: 'Unanswered' });

  switch (q.type) {
    case 'mcq': {
      const correct = (q.options || []).filter((o) => o.is_correct).map((o) => o.id);
      if (correct.includes(response)) return done(max);
      return done(negative ? -max * (cfg.negative_fraction ?? 0.25) : 0);
    }
    case 'multi_select': {
      const correct = new Set((q.options || []).filter((o) => o.is_correct).map((o) => o.id));
      const picked = [...new Set(Array.isArray(response) ? response : [])];
      const right = picked.filter((p) => correct.has(p)).length, wrong = picked.length - right;
      if (cfg.partial === false) return done(right === correct.size && wrong === 0 ? max : 0);
      const frac = Math.max(0, (right - wrong) / correct.size);
      if (frac === 0 && negative && wrong > 0) return done(-max * (cfg.negative_fraction ?? 0.25));
      return done(max * frac, { right, wrong });
    }
    case 'true_false': {
      const v = typeof response === 'string' ? response.toLowerCase() === 'true' : !!response;
      return done(v === !!key.value ? max : (negative ? -max * (cfg.negative_fraction ?? 0.25) : 0));
    }
    case 'short_answer': {
      if (matchesAny(response, key.accepted, !!key.case_sensitive)) return done(max);
      if (key.review_unmatched) return { status: 'needs_review', marks: null, details: { note: 'Did not match an accepted answer; needs review.' } };
      return done(0);
    }
    case 'fill_blank': {
      const blanks = key.blanks || [];
      const resp = Array.isArray(response) ? response : [];
      const right = blanks.filter((b, i) => matchesAny(resp[i], b.accepted, !!key.case_sensitive)).length;
      return done(max * right / (blanks.length || 1), { right, of: blanks.length });
    }
    case 'numeric': {
      const n = Number(String(response).replace(/[,\s]/g, ''));
      if (!Number.isFinite(n)) return done(0, { note: 'Not a number' });
      const tol = key.tolerance_type === 'percent' ? Math.abs(key.value) * (key.tolerance || 0) / 100 : (key.tolerance || 0);
      return done(Math.abs(n - key.value) <= tol + 1e-12 ? max : 0);
    }
    case 'matching': {
      const pairs = key.pairs || {}; const ids = Object.keys(pairs);
      const resp = typeof response === 'object' && !Array.isArray(response) ? response : {};
      const right = ids.filter((l) => resp[l] === pairs[l]).length;
      return done(max * right / (ids.length || 1), { right, of: ids.length });
    }
    case 'ordering': {
      const order = key.order || [];
      const resp = Array.isArray(response) ? response : [];
      const right = order.filter((id, i) => resp[i] === id).length;
      if (cfg.partial === false) return done(right === order.length && resp.length === order.length ? max : 0);
      return done(max * right / (order.length || 1), { right, of: order.length });
    }
    case 'code': { // mode 'static_checks'
      const run = runStaticChecks(key.checks || [], typeof response === 'string' ? response : response?.code);
      const marks = run.total ? max * run.earned / run.total : 0;
      return { status: key.confirm_by_instructor ? 'needs_review' : 'auto', marks: key.confirm_by_instructor ? null : round2(marks),
        details: { method: 'static_pattern_check (code is not executed)', results: run.results, suggested_marks: round2(marks) } };
    }
    default: return { status: 'pending_manual', marks: null, details: {} };
  }
}

// Combine per-question grade rows into attempt totals.
export function totalsFor(grades, { passPercentage, latePenaltyPct = 0 }) {
  const max = round2(grades.reduce((s, g) => s + g.max_marks, 0));
  const open = grades.some((g) => g.status === 'pending_manual' || g.status === 'needs_review');
  const raw = grades.reduce((s, g) => s + (g.final_marks ?? 0), 0);
  const afterPenalty = Math.max(0, raw) * (1 - latePenaltyPct / 100);
  const score = round2(afterPenalty);
  const percentage = max ? round2(score / max * 100) : 0;
  return { score, max_score: max, percentage, passed: percentage >= passPercentage, grading_status: open ? 'awaiting_manual' : 'graded' };
}
