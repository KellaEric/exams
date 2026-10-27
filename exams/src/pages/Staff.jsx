import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Badge, Card, Empty, ErrorBox, Field, Loading, Pager, StatusBadge, Table, Tabs, fmt, useAction, useAsync, useForm, useUi } from '../ui.jsx';

export function StaffDashboard() {
  const { loading, data: d, error, reload } = useAsync(() => api.get('/api/instructor/dashboard'));
  if (loading) return <Loading />; if (error) return <ErrorBox error={error} retry={reload} />;
  return <div><h1>Instructor dashboard</h1>
    <div className="grid"><div className="stat"><b>{d.courses.length}</b><span>Assigned courses</span></div><div className="stat"><b>{d.drafts}</b><span>Draft / pending assessments</span></div><div className="stat"><b>{d.live}</b><span>Live or scheduled</span></div><div className="stat"><b>{d.active_sessions}</b><span>Active exam sessions</span></div><div className="stat"><b><Link to="/grading">{d.awaiting_grading}</Link></b><span>Awaiting grading</span></div></div>
    <Card title="My courses"><Table cols={[{ h: 'Course', render: (c) => <Link to={`/courses/${c.id}`}>{c.title}</Link> }, { h: 'Students', k: 'students' }, { h: 'Approved questions', k: 'approved_questions' }, { h: 'In review', k: 'questions_in_review' }]} rows={d.courses} empty="You have not been assigned to a course yet. Ask an administrator." /></Card></div>;
}

export function CourseList() {
  const f = useForm({ q: '' }); const [off, setOff] = useState(0); const { loading, data, error, reload } = useAsync(() => api.get(`/api/courses?limit=25&offset=${off}&q=${encodeURIComponent(f.v.q)}`), [off, f.v.q]);
  return <div><h1>Courses</h1><Card><div className="row no-print"><input aria-label="Search courses" placeholder="Search by title or code" style={{ maxWidth: 320 }} {...f.bind('q')} /></div>
    {loading ? <Loading /> : error ? <ErrorBox error={error} retry={reload} /> : <><Table cols={[{ h: 'Course', render: (c) => <Link to={`/courses/${c.id}`}>{c.title}</Link> }, { h: 'Level', k: 'level' }, { h: 'Import', render: (c) => <StatusBadge value={c.import_status} /> }, { h: 'Readiness', render: (c) => <StatusBadge value={c.readiness} /> }, { h: 'Students', k: 'students' }, { h: 'Questions', k: 'approved_questions' }]} rows={data.rows} empty="No courses match." /><Pager total={data.total} limit={25} offset={off} onChange={setOff} /></>}</Card></div>;
}

function Questions({ courseId, level }) {
  const nav = useNavigate(); const f = useForm({ type: '', status: '', q: '' }); const [off, setOff] = useState(0); const [imp, setImp] = useState(false);
  const qs = new URLSearchParams({ limit: 25, offset: off, ...Object.fromEntries(Object.entries(f.v).filter(([, v]) => v)) }).toString();
  const { loading, data, error, reload } = useAsync(() => api.get(`/api/courses/${courseId}/questions?${qs}`), [courseId, qs]);
  return <div><div className="row no-print"><select aria-label="Type" style={{ maxWidth: 170 }} {...f.bind('type')}><option value="">All types</option>{['mcq', 'multi_select', 'true_false', 'short_answer', 'fill_blank', 'numeric', 'matching', 'ordering', 'essay', 'code', 'file_upload', 'practical'].map((t) => <option key={t}>{t}</option>)}</select><select aria-label="Status" style={{ maxWidth: 150 }} {...f.bind('status')}><option value="">Any status</option>{['draft', 'in_review', 'approved', 'retired'].map((t) => <option key={t}>{t}</option>)}</select><input aria-label="Search questions" placeholder="Search text" style={{ maxWidth: 240 }} {...f.bind('q')} /><span className="grow" />
    {level !== 'teaching_assistant' && <><button className="btn ghost" onClick={() => setImp(!imp)}>Bulk import</button><button className="btn" onClick={() => nav(`/questions/new?course=${courseId}`)}>New question</button></>}</div>
    {imp && <Import courseId={courseId} done={() => { setImp(false); reload(); }} />}
    {loading ? <Loading /> : error ? <ErrorBox error={error} /> : <><Table cols={[{ h: 'Question', render: (q) => <Link to={`/questions/${q.id}`}>{q.stem.slice(0, 90)}</Link> }, { h: 'Type', k: 'type' }, { h: 'Topic', k: 'topic' }, { h: 'Marks', k: 'marks' }, { h: 'Status', render: (q) => <StatusBadge value={q.status} /> }, { h: 'v', k: 'version' }, { h: 'Author', k: 'author_name' }]} rows={data.rows} empty="No questions yet. Create the first one." /><Pager total={data.total} limit={25} offset={off} onChange={setOff} /></>}</div>;
}
function Import({ courseId, done }) {
  const f = useForm({ format: 'json', text: '' }); const [rep, setRep] = useState(null); const { run, busy } = useAction();
  const body = (dry) => f.v.format === 'csv' ? { format: 'csv', csv: f.v.text, dry_run: dry } : { format: 'json', data: JSON.parse(f.v.text || '[]'), dry_run: dry };
  const go = async (dry) => { let b; try { b = body(dry); } catch { return setRep({ errors: [{ row: 0, error: 'That is not valid JSON.' }] }); } const r = await run(() => api.post(`/api/courses/${courseId}/questions/import`, b), dry ? undefined : 'Questions imported.'); if (r) { setRep(r); if (!dry) done(); } };
  return <Card title="Bulk import questions"><p><small>CSV columns: type, stem, marks, topic, difficulty, option_a…option_f, correct (e.g. B or A;C or true), accepted (a|b), value, tolerance. JSON accepts every type (same fields as the editor). Validation runs first; nothing is saved until you confirm.</small></p>
    <Field label="Format"><select {...f.bind('format')}><option value="json">JSON array</option><option value="csv">CSV</option></select></Field><Field label="Data"><textarea className="code" {...f.bind('text')} /></Field>
    <div className="row"><button className="btn ghost" disabled={busy} onClick={() => go(true)}>Validate only</button><button className="btn" disabled={busy || !rep || rep.errors?.length || !rep.valid} onClick={() => go(false)}>Import {rep?.valid || 0} valid rows</button></div>
    {rep && <div style={{ marginTop: 10 }}><p>{rep.total} rows · <b>{rep.valid}</b> valid · {rep.duplicates?.length || 0} duplicates skipped · {rep.errors?.length || 0} errors</p>{rep.errors?.map((e, i) => <p key={i} className="alert error">Row {e.row}: {e.error} {e.details?.join('; ')}</p>)}{rep.duplicates?.map((e, i) => <p key={i} className="alert warn">Row {e.row} duplicates an existing question: {e.stem}</p>)}</div>}</Card>;
}
function Assessments({ courseId, level }) {
  const nav = useNavigate(); const { loading, data, error } = useAsync(() => api.get(`/api/assessments?course_id=${courseId}&limit=100`), [courseId]);
  return <div>{level !== 'teaching_assistant' && <p className="row end"><button className="btn" onClick={() => nav(`/assessments/new/edit?course=${courseId}`)}>New assessment</button></p>}{loading ? <Loading /> : error ? <ErrorBox error={error} /> : <Table cols={[{ h: 'Title', render: (a) => <Link to={`/manage/assessments/${a.id}`}>{a.title}</Link> }, { h: 'Type', k: 'category' }, { h: 'Status', render: (a) => <StatusBadge value={a.status} /> }, { h: 'Opens', render: (a) => fmt(a.opens_at) }, { h: 'Closes', render: (a) => fmt(a.closes_at) }, { h: 'Marks', k: 'total_marks' }, { h: 'Attempts', k: 'attempts' }, { h: 'To grade', k: 'awaiting_grading' }]} rows={data.rows} empty="No assessments yet." />}</div>;
}
function Gradebook({ courseId }) {
  const { can } = useAuth(); const { loading, data, error } = useAsync(() => api.get(`/api/courses/${courseId}/gradebook`), [courseId]); const rep = useAsync(() => api.get(`/api/courses/${courseId}/report`), [courseId]);
  if (loading) return <Loading />; if (error) return <ErrorBox error={error} />;
  return <div>{rep.data && <Card title="Course summary"><p>{rep.data.enrolled} enrolled students.</p><Table cols={[{ h: 'Assessment', render: (a) => <Link to={`/manage/assessments/${a.id}`}>{a.title}</Link> }, { h: 'Status', render: (a) => <StatusBadge value={a.status} /> }, { h: 'Submitted', k: 'submitted' }, { h: 'Average %', k: 'average' }, { h: 'Pass rate %', k: 'pass_rate' }]} rows={rep.data.assessments} /></Card>}
    <div className="row end no-print">{can('report.export') && <a className="btn ghost" href={`/api/courses/${courseId}/gradebook?format=csv`}>Download CSV</a>}<button className="btn ghost" onClick={() => window.print()}>Print</button></div>
    <Table rowKey={(r) => r.attempt_id} cols={[{ h: 'Student', k: 'full_name' }, { h: 'ID', k: 'student_number' }, { h: 'Assessment', k: 'title' }, { h: 'Att.', k: 'attempt_no' }, { h: 'Marks', render: (r) => `${r.score ?? '—'}/${r.max_score ?? '—'}` }, { h: '%', k: 'percentage' }, { h: 'Grade', k: 'grade' }, { h: 'Result', render: (r) => r.grading_status === 'graded' ? <Badge tone={r.passed ? 'green' : 'red'}>{r.passed ? 'Pass' : 'Fail'}</Badge> : <Badge tone="amber">{r.grading_status.replace('_', ' ')}</Badge> }, { h: 'Released', render: (r) => (r.released ? 'Yes' : 'No') }, { h: '', render: (r) => <Link to={`/grading/${r.attempt_id}`}>Open</Link> }]} rows={data.rows} empty="No submissions yet." /></div>;
}
function Announce({ courseId, level }) {
  const f = useForm({ title: '', body: '' }); const { run, busy } = useAction(); const { data, reload } = useAsync(() => api.get('/api/announcements'));
  return <div>{level !== 'teaching_assistant' && <Card title="Post an announcement"><Field label="Title"><input {...f.bind('title')} /></Field><Field label="Message"><textarea {...f.bind('body')} /></Field><button className="btn" disabled={busy} onClick={async () => { if (await run(() => api.post(`/api/courses/${courseId}/announcements`, f.v), 'Announcement posted.')) { f.setV({ title: '', body: '' }); reload(); } }}>Post</button></Card>}
    {(data?.rows || []).filter((a) => a.course_title).map((a) => <Card key={a.id} title={a.title}><small>{a.course_title} · {fmt(a.published_at)}</small><p style={{ whiteSpace: 'pre-wrap' }}>{a.body}</p></Card>)}</div>;
}
export function CourseWorkspace() {
  const { id } = useParams(); const [tab, setTab] = useState('overview'); const { loading, data: c, error, reload } = useAsync(() => api.get(`/api/courses/${id}`), [id]); const roster = useAsync(() => api.get(`/api/courses/${id}/roster`), [id]);
  if (loading) return <Loading />; if (error) return <ErrorBox error={error} retry={reload} />;
  const level = c.access_level;
  return <div><h1>{c.title}</h1><p className="row"><StatusBadge value={c.import_status} /><StatusBadge value={c.readiness} />{c.code && <Badge>{c.code}</Badge>}{c.level && <Badge>{c.level}</Badge>}</p>
    <Tabs value={tab} onChange={setTab} tabs={[['overview', 'Overview'], ['students', 'Students'], ['questions', 'Question bank'], ['assessments', 'Assessments'], ['gradebook', 'Gradebook & reports'], ['announcements', 'Announcements']]} />
    {tab === 'overview' && <Card title="About"><p style={{ whiteSpace: 'pre-wrap' }}>{c.description || 'No description yet.'}</p>{c.missing_fields?.length > 0 && <p className="alert warn">Missing catalogue details: {c.missing_fields.join(', ')}</p>}<h3>Offerings</h3><Table cols={[{ h: 'Offering', render: (o) => o.label || `${o.term_name || 'No term'}${o.cohort_name ? ' · ' + o.cohort_name : ''}` }, { h: 'Status', render: (o) => <StatusBadge value={o.status} /> }]} rows={c.offerings} empty="No offerings yet." /></Card>}
    {tab === 'students' && <Card title="Enrolled students">{roster.loading ? <Loading /> : <Table rowKey={(r) => r.id + r.offering_id} cols={[{ h: 'Name', render: (r) => r.full_name }, { h: 'Student ID', k: 'student_number' }, { h: 'Email', k: 'email' }, { h: 'Status', render: (r) => <StatusBadge value={r.status} /> }]} rows={roster.data?.rows} empty="No students enrolled." />}</Card>}
    {tab === 'questions' && <Card><Questions courseId={id} level={level} /></Card>}
    {tab === 'assessments' && <Card><Assessments courseId={id} level={level} /></Card>}
    {tab === 'gradebook' && <Gradebook courseId={id} />}
    {tab === 'announcements' && <Announce courseId={id} level={level} />}</div>;
}
