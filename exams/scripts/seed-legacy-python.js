// Loads the original Python Laboratory Exam (5 questions, 40 marks) into a course's question bank and creates a DRAFT assessment.
//   npm run seed:legacy-python -- --course "Python Programming" --by instructor@example.com
// The instructor must still set the opening/closing times (and duration) and publish it.
import fs from 'node:fs';
import { boot, arg } from './_boot.js';
import { normalizeQuestion, loadQuestion, writeOptions, saveVersion } from '../server/lib/questions.js';
import { j } from '../server/db/index.js';

const title = arg('course'), by = String(arg('by', '')).toLowerCase();
if (!title || title === true || !by) { console.error('Usage: --course "<course title or id>" --by <author email>'); process.exit(1); }
const { db } = await boot();
const course = await db.one('select id,title from courses where id::text=$1 or lower(title)=lower($1)', [title]);
const author = await db.one("select id from users where lower(email)=$1 and status='active'", [by]);
if (!course || !author) { console.error(!course ? 'Course not found.' : 'Author not found or not active.'); process.exit(1); }
if (await db.one("select 1 as x from assessments where course_id=$1 and title='Python Laboratory Exam'", [course.id])) { console.error('This course already has a "Python Laboratory Exam" assessment.'); process.exit(1); }
const legacy = JSON.parse(fs.readFileSync(new URL('../data/legacy-python-lab-questions.json', import.meta.url), 'utf8'));
await db.tx(async (q) => {
  const ids = [];
  for (const [i, lq] of legacy.questions.entries()) {
    const n = normalizeQuestion({ type: 'code', stem: `${lq.title}\n\n${lq.stem}`, instructions: lq.hint, marks: lq.marks, topic: lq.title, language: 'python', mode: 'static_checks', checks: lq.checks });
    const row = (await q.query(`insert into questions(course_id,topic,type,difficulty,marks,stem,instructions,config,answer_key,rubric,status,author_id,approved_by,approved_at) values($1,$2,'code','medium',$3,$4,$5,$6::jsonb,$7::jsonb,'[]'::jsonb,'approved',$8,$8,now()) returning id`,
      [course.id, n.topic, n.marks, n.stem, n.instructions, j(n.config), j(n.answer_key), author.id])).rows[0];
    await saveVersion(q, await loadQuestion(q, row.id), author.id, 'imported from Lab Portal', new Date()); ids.push(row.id);
  }
  const a = (await q.query(`insert into assessments(course_id,category_key,title,instructions,status,max_attempts,pass_percentage,total_marks,created_by,grading_scale_id,settings)
    values($1,'coding','Python Laboratory Exam','Write a Python program for each task. Marks are awarded by automatic pattern checks of your source code; your code is not executed. An instructor may review any result.','draft',null,50,$2,$3,(select id from grading_scales where is_default limit 1),'{"show_rubric":false}'::jsonb) returning id`, [course.id, legacy.total_marks, author.id])).rows[0];
  for (const [i, id] of ids.entries()) await q.query('insert into assessment_questions(assessment_id,question_id,position,marks) values($1,$2,$3,$4)', [a.id, id, i, legacy.questions[i].marks]);
  await q.query("insert into audit_events(actor_label,action,entity_type,entity_id,meta) values('cli','assessment.create','assessment',$1,'{\"via\":\"seed-legacy-python\"}'::jsonb)", [a.id]);
});
console.log(`Created 5 approved questions and a draft "Python Laboratory Exam" (40 marks, unlimited attempts as in the original) in "${course.title}". Set its dates and duration, then publish.`);
await db.close();
