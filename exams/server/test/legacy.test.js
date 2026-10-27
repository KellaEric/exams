import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeWorld, setupCourse, approvedQuestion } from './helpers.js';

const legacy = JSON.parse(readFileSync(new URL('../../data/legacy-python-lab-questions.json', import.meta.url), 'utf8'));
const model = [
  'name = input("Enter your name: ")\nage = int(input("Enter your age: "))\nprint(f"Hello {name}, you are {age} years old")',
  'a = float(input())\nb = float(input())\nprint(a + b, a - b, a * b, a / b, a // b, a % b, a ** b)',
  'text = input("Enter text: ")\nprint(text[0])\nprint(text[-1])\nprint(text[::-1])\nprint(text.upper())',
  'num = float(input())\nif num > 0:\n    print("Positive")\nelif num < 0:\n    print("Negative")\nelse:\n    print("Zero")',
  'for i in range(1, 11):\n    print(i)\nn = 10\nwhile n >= 1:\n    print(n)\n    n -= 1'
];

describe('original Python Laboratory Exam on the new server pipeline', () => {
  it('students get auto-graded server-side (unlimited attempts, scores hidden until release, code never executed)', async () => {
    const w = await makeWorld(); const ids = await setupCourse(w, { title: 'Python Programming', enrol: ['s1'] });
    const inst = await w.login('inst'), admin = await w.login('admin'); let s1 = await w.login('s1');
    const qs = [];
    for (const lq of legacy.questions) qs.push(await approvedQuestion(inst, ids.courseId, { type: 'code', stem: `${lq.title}\n${lq.stem}`, marks: lq.marks, instructions: lq.hint, language: 'python', mode: 'static_checks', checks: lq.checks }));
    const a = (await inst.post(`/api/courses/${ids.courseId}/assessments`, { category_key: 'coding', title: 'Python Laboratory Exam', duration_minutes: 90, opens_at: w.iso(-60), closes_at: w.iso(86400), max_attempts: null, questions: qs.map((q) => ({ question_id: q.id })) })).body;
    expect(a.total_marks).toBe(40);
    expect((await inst.post(`/api/assessments/${a.id}/actions/publish`, {})).status).toBe(200);

    const run = async (codes) => {
      const v = (await s1.post(`/api/assessments/${a.id}/start`)).body;
      expect(JSON.stringify(v)).not.toMatch(/checks|pattern|answer_key/);                         // hidden tests never reach the browser
      const answers = v.questions.map((q) => ({ question_id: q.id, response: codes[qs.findIndex((x) => x.id === q.id)], seq: 1 }));
      await s1.put(`/api/attempts/${v.attempt.id}/answers`, { answers });
      await s1.post(`/api/attempts/${v.attempt.id}/submit`);
      return v.attempt.id;
    };
    const first = await run(['print("hello world, this is long enough text")', '', '', '', '']);     // weak attempt
    const second = await run(model);                                                                     // second attempt allowed (unlimited)
    const g1 = (await inst.get(`/api/attempts/${first}/grading`)).body.attempt, g2 = (await inst.get(`/api/attempts/${second}/grading`)).body.attempt;
    expect(g1.score).toBeLessThanOrEqual(1); expect(g2).toMatchObject({ score: 40, percentage: 100, grading_status: 'graded', passed: true });
    expect((await inst.get(`/api/attempts/${second}/grading`)).body.questions[0].grade.details.method).toMatch(/not executed/);
    expect((await s1.get(`/api/attempts/${second}/result`)).status).toBe(403);
    w.advance(86400 + 120); admin.csrf; const admin2 = await w.login('admin'); s1 = await w.login('s1');
    expect((await admin2.post(`/api/assessments/${a.id}/release`)).status).toBe(200);
    const res = (await s1.get(`/api/attempts/${second}/result`)).body; expect(res.result).toMatchObject({ score: 40, grade: 'A+' });
  });
});
