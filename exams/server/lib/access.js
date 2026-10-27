import { forbidden, notFound } from './errors.js';
// Staff scope: super/admin-style roles with course.read_all see everything; instructors/TAs only the courses they are assigned to.
export async function staffLevel(db, user, courseId) {
  if (user.perms.has('course.read_all')) return 'all';
  const r = await db.one(`select s.staff_role from offering_staff s join course_offerings o on o.id=s.offering_id where s.user_id=$1 and o.course_id=$2 order by (s.staff_role='instructor') desc limit 1`, [user.id, courseId]);
  return r ? r.staff_role : null;
}
// opts.write: must be able to change content (instructor or admin); TAs are read/grade only.
export async function requireCourse(ctx, user, courseId, { write = false } = {}) {
  const lvl = await staffLevel(ctx.db, user, courseId);
  if (!lvl) throw notFound('Course not found.');            // 404 rather than 403: do not reveal other courses
  if (write && lvl === 'teaching_assistant') throw forbidden('Teaching assistants cannot change course content.');
  return lvl;
}
export const requireAssessmentAccess = async (ctx, user, assessmentId, opts) => {
  const a = await ctx.db.one('select * from assessments where id=$1', [assessmentId]);
  if (!a) throw notFound('Assessment not found.');
  const lvl = await requireCourse(ctx, user, a.course_id, opts);
  return { a, lvl };
};
export const courseIdsFor = async (db, user) => user.perms.has('course.read_all') ? null
  : (await db.query('select distinct o.course_id from offering_staff s join course_offerings o on o.id=s.offering_id where s.user_id=$1', [user.id])).rows.map((r) => r.course_id);
