import { describe, it, expect } from 'vitest';
import { gradeResponse, totalsFor } from '../lib/grading.js';
import { runStaticChecks } from '../lib/pycheck.js';
import { normalizeQuestion } from '../lib/questions.js';
import { inspectUpload } from '../lib/filetype.js';
import { readFileSync } from 'node:fs';

const opts = (...c) => c.map((x, i) => ({ id: 'o' + i, text: 'x', is_correct: x }));
describe('objective grading', () => {
  it('mcq: right, wrong, blank, negative marking only when enabled', () => {
    const q = { type: 'mcq', marks: 4, options: opts(false, true, false), config: {}, answer_key: {} };
    expect(gradeResponse(q, 'o1').marks).toBe(4);
    expect(gradeResponse(q, 'o0').marks).toBe(0);
    expect(gradeResponse(q, null)).toMatchObject({ marks: 0, status: 'auto' });
    expect(gradeResponse(q, 'o0', { negative: true }).marks).toBe(-1);
  });
  it('multi-select: partial credit, wrong picks subtract, floor at 0, all-or-nothing option', () => {
    const q = { type: 'multi_select', marks: 6, options: opts(true, true, true, false), config: { partial: true }, answer_key: {} };
    expect(gradeResponse(q, ['o0', 'o1', 'o2']).marks).toBe(6);
    expect(gradeResponse(q, ['o0']).marks).toBe(2);
    expect(gradeResponse(q, ['o0', 'o3']).marks).toBe(0);
    expect(gradeResponse({ ...q, config: { partial: false } }, ['o0', 'o1']).marks).toBe(0);
  });
  it('true/false, short answer normalisation, review queue', () => {
    expect(gradeResponse({ type: 'true_false', marks: 1, answer_key: { value: false } }, 'false').marks).toBe(1);
    const sa = { type: 'short_answer', marks: 2, answer_key: { accepted: ['Accra'] } };
    expect(gradeResponse(sa, '  accra. ').marks).toBe(2);
    expect(gradeResponse(sa, 'Kumasi').marks).toBe(0);
    expect(gradeResponse({ ...sa, answer_key: { accepted: ['Accra'], review_unmatched: true } }, 'Kumasi').status).toBe('needs_review');
  });
  it('numeric tolerance (absolute and percent) and non-numbers', () => {
    const n = (key) => ({ type: 'numeric', marks: 3, answer_key: key });
    expect(gradeResponse(n({ value: 3.14, tolerance: 0.01, tolerance_type: 'absolute' }), '3.145').marks).toBe(3);
    expect(gradeResponse(n({ value: 3.14, tolerance: 0.001, tolerance_type: 'absolute' }), '3.15').marks).toBe(0);
    expect(gradeResponse(n({ value: 200, tolerance: 5, tolerance_type: 'percent' }), '209').marks).toBe(3);
    expect(gradeResponse(n({ value: 200, tolerance: 5, tolerance_type: 'percent' }), '211').marks).toBe(0);
    expect(gradeResponse(n({ value: 1, tolerance: 0 }), 'abc').marks).toBe(0);
  });
  it('fill blank, matching, ordering partial marks', () => {
    expect(gradeResponse({ type: 'fill_blank', marks: 4, answer_key: { blanks: [{ accepted: ['a'] }, { accepted: ['b'] }] } }, ['a', 'x']).marks).toBe(2);
    expect(gradeResponse({ type: 'matching', marks: 3, answer_key: { pairs: { l1: 'r1', l2: 'r2', l3: 'r3' } } }, { l1: 'r1', l2: 'r3', l3: 'r3' }).marks).toBe(2);
    const o = { type: 'ordering', marks: 4, config: { partial: true }, answer_key: { order: ['a', 'b', 'c', 'd'] } };
    expect(gradeResponse(o, ['a', 'b', 'd', 'c']).marks).toBe(2);
    expect(gradeResponse({ ...o, config: { partial: false } }, ['a', 'b', 'd', 'c']).marks).toBe(0);
  });
  it('essay/practical/file go to manual grading, but blank ones are final zero', () => {
    expect(gradeResponse({ type: 'essay', marks: 10 }, 'my essay').status).toBe('pending_manual');
    expect(gradeResponse({ type: 'essay', marks: 10 }, '')).toMatchObject({ status: 'final', marks: 0 });
  });
  it('totals: rounding, pass mark, late penalty, awaiting manual', () => {
    const g = [{ max_marks: 3, final_marks: 1, status: 'auto' }, { max_marks: 3, final_marks: 2, status: 'auto' }, { max_marks: 4, final_marks: null, status: 'pending_manual' }];
    expect(totalsFor(g, { passPercentage: 50 })).toMatchObject({ score: 3, max_score: 10, percentage: 30, grading_status: 'awaiting_manual', passed: false });
    g[2] = { max_marks: 4, final_marks: 3.333, status: 'final' };
    expect(totalsFor(g, { passPercentage: 50 })).toMatchObject({ score: 6.33, percentage: 63.3, passed: true, grading_status: 'graded' });
    expect(totalsFor(g, { passPercentage: 50, latePenaltyPct: 10 }).score).toBe(5.7);
    expect(totalsFor([{ max_marks: 2, final_marks: -1, status: 'auto' }], { passPercentage: 50 }).score).toBe(0);
  });
});

describe('legacy Python lab exam parity (static pattern checks)', () => {
  const legacy = JSON.parse(readFileSync(new URL('../../data/legacy-python-lab-questions.json', import.meta.url), 'utf8'));
  const solutions = [
    'name = input("Enter your name: ")\nage = int(input("Enter your age: "))\nprint(f"Hello {name}, you are {age} years old")',
    'a = float(input("First number: "))\nb = float(input("Second number: "))\nprint("Sum:", a + b)\nprint("Difference:", a - b)\nprint("Product:", a * b)\nprint("Division:", a / b)\nprint("Floor division:", a // b)\nprint("Modulus:", a % b)\nprint("Power:", a ** b)',
    'text = input("Enter text: ")\nprint("First:", text[0])\nprint("Last:", text[-1])\nprint("Reversed:", text[::-1])\nprint("Upper:", text.upper())',
    'num = float(input("Enter a number: "))\nif num > 0:\n    print("Positive")\nelif num < 0:\n    print("Negative")\nelse:\n    print("Zero")',
    'for i in range(1, 11):\n    print(i)\nn = 10\nwhile n >= 1:\n    print(n)\n    n -= 1'
  ];
  const score = (i, code) => runStaticChecks(legacy.questions[i].checks, code).earned;
  it('has the original 5 questions worth 40 marks, check points matching each question', () => {
    expect(legacy.questions).toHaveLength(5);
    legacy.questions.forEach((q) => expect(q.checks.reduce((s, c) => s + c.points, 0)).toBe(q.marks));
    expect(legacy.questions.reduce((s, q) => s + q.marks, 0)).toBe(40);
  });
  it('model solutions score full marks', () => solutions.forEach((s, i) => expect(score(i, s)).toBe(8)));
  it('does not reward print(), comments or blank code (same as the browser version)', () => {
    expect(score(0, 'print("hello world, this is long enough text")')).toBeLessThanOrEqual(1);
    expect(score(0, '# int( input( f"{x}"\nprint("hello")')).toBeLessThanOrEqual(1);
    expect(score(3, 'x = 5\n\n\n\nprint(x)')).toBe(0);
  });
  it('accepts alternative valid styles', () => {
    expect(score(4, 'for i in range(1,11):\n    print(i)\ni = 10\nwhile i > 0:\n    print(i)\n    i = i - 1')).toBe(8);
    expect(score(1, 'num1 = int(input())\nnum2 = int(input())\nprint(f"{num1 + num2} {num1 - num2} {num1 * num2} {num1 / num2} {num1 // num2} {num1 % num2} {num1 ** num2}")')).toBe(8);
    expect(score(0, 'n = input("Name: ")\na = int(input("Age: "))\nprint(f"It\'s {n}, aged {a}")')).toBe(8);
  });
});

describe('question authoring validation', () => {
  it('rejects bad mcq, mismatched rubric and unsafe regex checks', () => {
    expect(() => normalizeQuestion({ type: 'mcq', stem: 'Pick one', marks: 1, options: [{ text: 'a' }, { text: 'b' }] })).toThrow(/exactly one correct/);
    expect(() => normalizeQuestion({ type: 'essay', stem: 'Discuss', marks: 10, rubric: [{ criterion: 'A', max: 4 }] })).toThrow(/add up/);
    expect(() => normalizeQuestion({ type: 'code', stem: 'Write', marks: 2, mode: 'static_checks', checks: [{ name: 'x', points: 2, type: 'regex', pattern: '(a+)+$' }] })).toThrow(/Invalid check/);
    expect(() => normalizeQuestion({ type: 'fill_blank', stem: 'The ___ is ___', marks: 2, blanks: [{ accepted: ['a'] }] })).toThrow(/blank marker/);
    expect(() => normalizeQuestion({ type: 'hologram', stem: 'x', marks: 1 })).toThrow(/Unsupported/);
  });
  it('matching/ordering lists do not leak the answer order', () => {
    const m = normalizeQuestion({ type: 'ordering', stem: 'Order these', marks: 3, items: ['Zebra', 'Mango', 'Apple'] });
    expect(m.config.items.map((i) => i.text)).toEqual(['Apple', 'Mango', 'Zebra']);
    expect(m.answer_key.order).toEqual(['o1', 'o2', 'o3']);
  });
});

describe('upload inspection', () => {
  it('checks content, not just the extension', () => {
    expect(inspectUpload('a.pdf', Buffer.from('%PDF-1.4 x')).ext).toBe('pdf');
    expect(inspectUpload('evil.pdf', Buffer.from('<html><script>alert(1)</script>')).error).toMatch(/does not match/);
    expect(inspectUpload('x.exe', Buffer.from('MZ')).error).toMatch(/not allowed/);
    expect(inspectUpload('x.svg', Buffer.from('<svg/>')).error).toMatch(/not allowed/);
    expect(inspectUpload('a.png', Buffer.from('89504e470d0a1a0a00', 'hex')).ext).toBe('png');
    expect(inspectUpload('bin.py', Buffer.from([1, 0, 2])).error).toMatch(/does not match/);
  });
});
