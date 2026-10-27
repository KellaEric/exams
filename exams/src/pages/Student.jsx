import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Badge, Card, Empty, ErrorBox, Field, Loading, StatusBadge, Table, fmt, pct, useAction, useAsync, useForm, useUi } from '../ui.jsx';

const STATE_LABEL = { upcoming: 'Upcoming', available: 'Available', in_progress: 'In progress', submitted: 'Submitted', awaiting_grading: 'Awaiting grading', graded: 'Graded (results not released)', results_released: 'Results released', missed: 'Expired / missed' };
const State = ({ s }) => <StatusBadge value={s} />;

function AssessmentRow({ a }) {
  return <tr><td><Link to={`/assessments/${a.id}`}>{a.title}</Link><br /><small>{a.course_title} · {a.category}</small></td><td><State s={a.state} /></td><td>{fmt(a.opens_at)}</td><td>{fmt(a.closes_at)}</td><td>{a.duration_minutes ? `${a.duration_minutes} min` : 'Untimed'}</td>
    <td>{a.state === 'in_progress' ? <Link className="btn small" to={`/exam/${a.active_attempt_id}`}>Resume</Link> : a.can_start ? <Link className="btn small" to={`/assessments/${a.id}`}>Open</Link> : a.state === 'results_released' && a.attempts[0] ? <Link className="btn small ghost" to={`/results/${a.attempts[a.attempts.length - 1].id}`}>View result</Link> : null}</td></tr>;
}
const AList = ({ rows, empty }) => rows?.length ? <div className="table-wrap"><table><thead><tr><th>Assessment</th><th>Status</th><th>Opens</th><th>Closes</th><th>Time</th><th /></tr></thead><tbody>{rows.map((a) => <AssessmentRow key={a.id} a={a} />)}</tbody></table></div> : <Empty>{empty}</Empty>;

export function StudentDashboard() {
  const { user } = useAuth(); const { loading, data: d, error, reload } = useAsync(() => api.get('/api/me/dashboard'));
  if (loading) return <Loading />; if (error) return <ErrorBox error={error} retry={reload} />;
  return <div><h1>Welcome, {user.full_name.split(' ')[0]}</h1>
    {d.in_progress.length > 0 && <div className="alert warn" role="status"><b>You have an exam in progress.</b> {d.in_progress.map((a) => <Link key={a.id} className="btn small" style={{ marginLeft: 8 }} to={`/exam/${a.active_attempt_id}`}>Resume “{a.title}”</Link>)}</div>}
    <div className="grid"><div className="stat"><b>{d.courses.length}</b><span>Enrolled courses</span></div><div className="stat"><b>{d.available.length}</b><span>Available now</span></div><div className="stat"><b>{d.upcoming.length}</b><span>Upcoming</span></div><div className="stat"><b>{d.unread_announcements}</b><span><Link to="/announcements">Unread announcements</Link></span></div></div>
    <Card title="Available examinations & assignments"><AList rows={d.available} empty="Nothing is open for you right now." /></Card>
    <Card title="Upcoming"><AList rows={d.upcoming} empty="No upcoming assessments." /></Card>
    {d.deadlines.length > 0 && <Card title="Assignment deadlines"><Table cols={[{ h: 'Assignment', render: (a) => <Link to={`/assessments/${a.id}`}>{a.title}</Link> }, { h: 'Course', k: 'course_title' }, { h: 'Due', render: (a) => fmt(a.closes_at) }]} rows={d.deadlines} /></Card>}
    <Card title="Submitted work"><AList rows={d.awaiting} empty="No submissions waiting for results." /></Card>
    <Card title="Released results"><Table cols={[{ h: 'Assessment', render: (a) => a.title }, { h: 'Course', k: 'course_title' }, { h: 'Score', render: (a) => { const t = a.attempts[a.attempts.length - 1]; return t?.score != null ? `${t.score}/${t.max_score} (${t.percentage}%)` : '—'; } }, { h: 'Result', render: (a) => { const t = a.attempts[a.attempts.length - 1]; return t ? <><Badge tone={t.passed ? 'green' : 'red'}>{t.passed ? 'Pass' : 'Fail'}</Badge> <Link to={`/results/${t.id}`}>Details</Link></> : null; } }]} rows={d.released} empty="No released results yet." /></Card>
    <Card title="Progress by course"><Table cols={[{ h: 'Course', k: 'title' }, { h: 'Released results', k: 'results' }, { h: 'Average', render: (p) => p.average == null ? '—' : <div className="row"><div className="bar grow" aria-hidden="true"><i style={{ width: `${p.average}%` }} /></div>{pct(p.average)}</div> }]} rows={d.performance} rowKey={(p) => p.course_id} empty="You are not enrolled in a course yet." /></Card>
    {d.missed.length > 0 && <Card title="Expired or missed"><AList rows={d.missed} empty="" /></Card>}
  </div>;
}

export function StudentCourses() {
  const mine = useAsync(() => api.get('/api/me/courses')); const open = useAsync(() => api.get('/api/offerings/open')); const { run } = useAction();
  return <div><h1>My courses</h1><Card title="Enrolled">{mine.loading ? <Loading /> : <Table rowKey={(r) => r.offering_id} cols={[{ h: 'Course', k: 'title' }, { h: 'Level', k: 'level' }, { h: 'Instructor', render: (r) => (r.instructors || []).join(', ') || '—' }, { h: 'Status', render: (r) => <StatusBadge value={r.enrolment_status === 'requested' ? 'pending' : r.enrolment_status} /> }]} rows={mine.data?.rows} empty="You are not enrolled in any course." />}</Card>
    <Card title="Request enrolment">{open.loading ? <Loading /> : <Table rowKey={(r) => r.offering_id} cols={[{ h: 'Course', k: 'title' }, { h: 'Term', k: 'term_name' }, { h: '', render: (r) => <button className="btn small" onClick={async () => { await run(() => api.post(`/api/offerings/${r.offering_id}/enrol-request`), 'Request sent.'); open.reload(); mine.reload(); }}>Request</button> }]} rows={open.data?.rows} empty="No open courses to request." />}</Card></div>;
}

export function StudentAssessments() {
  const { loading, data, error, reload } = useAsync(() => api.get('/api/me/assessments'));
  if (loading) return <Loading />; if (error) return <ErrorBox error={error} retry={reload} />;
  return <div><h1>Assessments</h1><Card><AList rows={data.rows} empty="No assessments have been published for your courses yet." /></Card></div>;
}

export function AssessmentIntro() {
  const { id } = useParams(); const nav = useNavigate(); const { loading, data: a, error, reload } = useAsync(() => api.get(`/api/assessments/${id}/student`), [id]); const { run, busy } = useAction();
  if (loading) return <Loading />; if (error) return <ErrorBox error={error} retry={reload} />;
  const start = async () => { const r = await run(() => api.post(`/api/assessments/${id}/start`)); if (r) nav(`/exam/${r.attempt.id}`); };
  return <div style={{ maxWidth: 820 }}><h1>{a.title}</h1>
    <Card><dl className="kv"><dt>Course</dt><dd>{a.course_title}</dd><dt>Type</dt><dd>{a.category}</dd><dt>Status</dt><dd><State s={a.state} /></dd><dt>Opens</dt><dd>{fmt(a.opens_at)}</dd><dt>Closes</dt><dd>{fmt(a.closes_at)}</dd><dt>Time allowed</dt><dd>{a.duration_minutes ? `${a.duration_minutes} minutes from the moment you start` : 'No time limit (deadline applies)'}</dd><dt>Total marks</dt><dd>{a.total_marks}</dd><dt>Attempts</dt><dd>{a.attempts_used} used of {a.attempts_allowed ?? 'unlimited'}</dd>{a.allowed_resources && <><dt>Allowed resources</dt><dd>{a.allowed_resources}</dd></>}{a.late_policy?.allowed && <><dt>Late submissions</dt><dd>Until {fmt(a.late_policy.until)} with {a.late_policy.penalty_pct || 0}% penalty</dd></>}</dl></Card>
    <Card title="Instructions"><p style={{ whiteSpace: 'pre-wrap' }}>{a.instructions || 'Read each question carefully and answer all questions.'}</p>
      <ul style={{ margin: '12px 0 0 20px' }}><li>The countdown is controlled by the server. Refreshing the page, using another tab or changing your device clock does not change it.</li><li>Your answers save automatically. A “Saved” label shows when the server has confirmed them.</li><li>If you lose connection, keep working; answers will be sent when you reconnect. Reopen this page to resume before the time ends.</li><li>When time ends your saved answers are submitted automatically.</li><li>Switching tabs or windows is recorded as a signal only. It is not treated as proof of misconduct; a person reviews any concern.</li></ul></Card>
    {a.attempts.length > 0 && <Card title="Your attempts"><Table cols={[{ h: '#', k: 'attempt_no' }, { h: 'Status', render: (t) => <StatusBadge value={t.status} /> }, { h: 'Submitted', render: (t) => fmt(t.submitted_at) }, { h: 'Receipt', k: 'receipt_code' }, { h: '', render: (t) => a.state === 'results_released' ? <Link to={`/results/${t.id}`}>View result</Link> : t.status === 'in_progress' ? <Link to={`/exam/${t.id}`}>Resume</Link> : null }]} rows={a.attempts} /></Card>}
    <div className="row">{a.state === 'in_progress' ? <Link className="btn" to={`/exam/${a.active_attempt_id}`}>Resume attempt</Link> : a.can_start ? <button className="btn" disabled={busy} onClick={start}>Start {a.attempts_used ? 'new attempt' : 'now'}</button> : <span className="alert info">{a.state === 'upcoming' ? `Opens ${fmt(a.opens_at)}.` : a.state === 'missed' ? 'This assessment has closed.' : 'You cannot start this assessment right now.'}</span>}<Link className="btn ghost" to="/assessments">Back</Link></div></div>;
}

export function History() {
  const { loading, data, error } = useAsync(() => api.get('/api/me/attempts')); if (loading) return <Loading />; if (error) return <ErrorBox error={error} />;
  return <div><h1>Examination history</h1><Card><Table cols={[{ h: 'Assessment', k: 'title' }, { h: 'Course', k: 'course_title' }, { h: 'Attempt', k: 'attempt_no' }, { h: 'Status', render: (r) => <StatusBadge value={r.status} /> }, { h: 'Submitted', render: (r) => fmt(r.submitted_at) }, { h: 'Receipt', k: 'receipt_code' }, { h: 'Result', render: (r) => r.percentage != null ? <><Badge tone={r.passed ? 'green' : 'red'}>{r.percentage}%</Badge> <Link to={`/results/${r.id}`}>Details</Link></> : <small>Not released</small> }]} rows={data.rows} empty="You have not attempted anything yet." /></Card></div>;
}

export function Announcements() {
  const { loading, data, error, reload } = useAsync(() => api.get('/api/announcements')); const { isStudent } = useAuth();
  if (loading) return <Loading />; if (error) return <ErrorBox error={error} />;
  return <div><h1>Announcements</h1>{data.rows.length === 0 && <Empty>No announcements.</Empty>}{data.rows.map((a) => <Card key={a.id} title={a.title} actions={isStudent && !a.read ? <button className="btn small ghost" onClick={async () => { await api.post(`/api/announcements/${a.id}/read`); reload(); }}>Mark read</button> : null}><small>{a.course_title} · {a.author} · {fmt(a.published_at)}</small><p style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{a.body}</p></Card>)}</div>;
}

export function ReportIssue() {
  const f = useForm({ kind: 'technical', description: '' }); const { run, busy } = useAction(); const list = useAsync(() => api.get('/api/me/incidents'));
  return <div style={{ maxWidth: 760 }}><h1>Report an issue</h1><Card title="Technical problem, accessibility need or result dispute"><p className="alert info">Describe what happened, which assessment, and when. Examination officers review every report.</p>
    <Field label="Type"><select {...f.bind('kind')}><option value="technical">Technical problem</option><option value="accessibility">Accessibility need</option><option value="dispute">Dispute a result</option></select></Field>
    <Field label="Details"><textarea {...f.bind('description')} /></Field>
    <button className="btn" disabled={busy || f.v.description.trim().length < 10} onClick={async () => { if (await run(() => api.post('/api/incidents', f.v), 'Report sent.')) { f.setV({ kind: 'technical', description: '' }); list.reload(); } }}>Send report</button></Card>
    <Card title="Your reports"><Table cols={[{ h: 'Sent', render: (r) => fmt(r.created_at) }, { h: 'Type', k: 'kind' }, { h: 'Status', render: (r) => <StatusBadge value={r.status} /> }, { h: 'Outcome', render: (r) => r.resolution || '—' }]} rows={list.data?.rows} empty="No reports." /></Card></div>;
}
