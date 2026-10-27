// Permission catalogue and default role matrix. The matrix is seeded into the database and can be edited by a super administrator.
export const PERMISSIONS = {
  'user.read': 'View user accounts', 'user.manage': 'Create and edit users (non-admin roles)', 'user.approve': 'Approve, suspend and reactivate accounts',
  'role.manage': 'Edit roles and permissions', 'course.read_all': 'See every course and offering', 'course.manage': 'Create and edit courses',
  'catalogue.import': 'Import and reconcile the course catalogue', 'org.manage': 'Manage departments, programmes, terms, cohorts and offerings',
  'enrolment.manage': 'Enrol students and approve enrolment requests', 'staff.assign': 'Assign instructors and assistants to offerings',
  'question.author': 'Author questions in assigned courses', 'question.review': 'Review questions', 'question.approve': 'Approve questions for use in assessments',
  'assessment.create': 'Create assessments in assigned courses', 'assessment.manage_all': 'Manage assessments in every course',
  'assessment.approve': 'Approve restricted assessments', 'assessment.publish': 'Publish, schedule and close assessments',
  'grading.grade': 'Grade submissions', 'grade.override': 'Change finalised grades', 'results.release': 'Release results to students',
  'report.view': 'View reports', 'report.export': 'Export reports and gradebooks', 'attempt.extend': 'Grant extra time / reopen attempts',
  'accommodation.manage': 'Approve accommodations', 'incident.manage': 'Handle incidents and disputes', 'announcement.manage': 'Post announcements',
  'audit.read': 'Read audit logs', 'config.manage': 'Change system configuration', 'system.health': 'View system health'
};
const ALL = Object.keys(PERMISSIONS);
export const ROLES = {
  super_admin: { label: 'Super Administrator', perms: ALL },
  admin: { label: 'Administrator / Examination Officer', perms: ALL.filter((p) => !['role.manage', 'config.manage'].includes(p)) },
  instructor: { label: 'Instructor', perms: ['question.author', 'question.review', 'question.approve', 'assessment.create', 'assessment.publish', 'grading.grade', 'report.view', 'report.export', 'announcement.manage'] },
  teaching_assistant: { label: 'Teaching Assistant / Practical Examiner', perms: ['grading.grade'] },
  student: { label: 'Student', perms: [] }
};
export const PRIVILEGED = new Set(['super_admin', 'admin']);
export const STAFF_ROLES = new Set(['super_admin', 'admin', 'instructor', 'teaching_assistant']);

export const CATEGORIES = [
  ['weekly_test', 'Weekly test', 'exam', false, true], ['topic_test', 'Topic test', 'exam', false, true], ['quiz', 'Quiz', 'exam', false, true],
  ['assignment', 'Individual assignment', 'assignment', false, false], ['group_assignment', 'Group assignment', 'assignment', false, false],
  ['midsem', 'Mid-semester examination', 'exam', true, true], ['final_exam', 'Final examination', 'exam', true, true],
  ['practical_lab', 'Practical laboratory examination', 'practical', true, true], ['coding', 'Programming / coding assessment', 'practical', false, true],
  ['project', 'Project / capstone', 'project', false, false], ['oral', 'Oral / manually assessed examination', 'oral', true, false]
];
// group_assignment and oral are "if enabled": seeded disabled.
export const DISABLED_BY_DEFAULT = new Set(['group_assignment', 'oral']);
// Legacy scale from the original Lab Portal (preserved).
export const LEGACY_SCALE = [[90, 'A+'], [85, 'A'], [80, 'A-'], [75, 'B+'], [70, 'B'], [65, 'B-'], [60, 'C+'], [55, 'C'], [50, 'C-'], [0, 'F']].map(([min, label]) => ({ min, label }));

export async function seedReference(db) {
  for (const [key, desc] of Object.entries(PERMISSIONS)) await db.query('insert into permissions(key,description) values($1,$2) on conflict (key) do update set description=excluded.description', [key, desc]);
  for (const [key, r] of Object.entries(ROLES)) {
    const had = await db.one('select 1 as x from roles where key=$1', [key]);
    await db.query('insert into roles(key,label) values($1,$2) on conflict (key) do update set label=excluded.label', [key, r.label]);
    if (!had) for (const p of r.perms) await db.query('insert into role_permissions(role_key,permission_key) values($1,$2) on conflict do nothing', [key, p]);
  }
  let i = 0;
  for (const [key, label, kind, req, timed] of CATEGORIES)
    await db.query('insert into assessment_categories(key,label,kind,requires_approval,timed_by_default,enabled,sort_order) values($1,$2,$3,$4,$5,$6,$7) on conflict (key) do nothing', [key, label, kind, req, timed, !DISABLED_BY_DEFAULT.has(key), i++]);
  if (!(await db.one('select 1 as x from grading_scales limit 1')))
    await db.query('insert into grading_scales(name,bands,is_default) values($1,$2::jsonb,true) on conflict (name) do nothing', ['Kellastech standard', JSON.stringify(LEGACY_SCALE)]);
  await db.query("insert into system_config(key,value) values('institution',$1::jsonb) on conflict (key) do nothing", [JSON.stringify({ name: 'KellasTech', timezone: 'Africa/Accra', currency: 'GHS', website: 'https://kellastech.vercel.app/' })]);
}
export const letterFor = (bands, pct) => ([...bands].sort((a, b) => b.min - a.min).find((b) => pct >= b.min) || { label: '' }).label;
