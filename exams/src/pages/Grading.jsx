import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { Badge, Card, ErrorBox, Field, Loading, StatusBadge, Table, fmt, useAction, useAsync, useUi } from '../ui.jsx';

export function GradingQueue() {
  const { loading, data, error, reload } = useAsync(() => api.get('/api/grading/queue?limit=200'));
  if (loading) return <Loading />; if (error) return <ErrorBox error={error} retry={reload} />;
  return <div><h1>Grading queue</h1><Card><Table rowKey={(r) => r.attempt_id + r.question_id} cols={[{ h: 'Student', render: (r) => `${r.full_name}${r.student_number ? ` (${r.student_number})` : ''}` }, { h: 'Assessment', render: (r) => `${r.title} · ${r.course_title}` }, { h: 'Question', render: (r) => <><Badge>{r.type}</Badge> {r.stem}</> }, { h: 'Status', render: (r) => <StatusBadge value={r.status} /> }, { h: 'Submitted', render: (r) => fmt(r.submitted_at) }, { h: '', render: (r) => <Link className="btn small" to={`/grading/${r.attempt_id}`}>Grade</Link> }]} rows={data.rows} empty="Nothing is waiting to be graded." /></Card></div>;
}
const resp = (q, r) => { if (r == null || r === '') return <em>No answer</em>; if (q.options?.length) { const ids = Array.isArray(r) ? r : [r]; return ids.map((id) => q.options.find((o) => o.id === id)?.text || id).join(', '); } if (q.type === 'code' || typeof r === 'string') return <pre className="code">{String(r)}</pre>; if (r.file_ids) return <><p style={{ whiteSpace: 'pre-wrap' }}>{r.text}</p><FileLinks ids={r.file_ids} names={r.files} /></>; return <code>{JSON.stringify(r)}</code>; };
function FileLinks({ ids, names = [] }) { return <ul>{ids.map((fid) => <li key={fid}><button className="btn small ghost" onClick={async () => { const l = await api.get(`/api/files/${fid}/link`); window.open(l.url, '_blank', 'noopener'); }}>Download {names.find((n) => n.id === fid)?.name || 'file'}</button></li>)}</ul>; }

function QGrade({ attemptId, q, reload }) {
  const g = q.grade; const [marks, setMarks] = useState(g?.final_marks ?? ''); const [fb, setFb] = useState(g?.feedback || ''); const [rs, setRs] = useState(Object.fromEntries((g?.rubric_scores || []).map((x) => [x.criterion, x.marks]))); const [reason, setReason] = useState(''); const { run, busy } = useAction(); const hasRub = q.rubric?.length > 0;
  const sugg = g?.details?.suggested_marks;
  const save = async () => { const body = { feedback: fb || null, reason: reason || undefined }; if (hasRub) body.rubric_scores = q.rubric.map((r) => ({ criterion: r.criterion, marks: Number(rs[r.criterion] || 0) })); else body.marks = Number(marks); if (await run(() => api.put(`/api/attempts/${attemptId}/grades/${q.question_id}`, body), 'Grade saved.')) reload(); };
  return <Card title={`Question ${q.position + 1} · ${q.type}`} actions={<><StatusBadge value={g?.status} /> <Badge>{g?.final_marks ?? '—'} / {q.marks}</Badge></>}>
    <p className="stem">{q.stem}</p><h4>Student answer</h4>{resp(q, q.response)}
    {q.answer_key && Object.keys(q.answer_key).length > 0 && <details><summary>Marking key (staff only)</summary><pre className="code">{JSON.stringify(q.answer_key, null, 1)}</pre></details>}
    {g?.details?.results && <><h4>Automatic pattern checks <small>({g.details.method})</small></h4><ul>{g.details.results.map((r) => <li key={r.name}>{r.passed ? '✔' : '✘'} {r.name} ({r.points})</li>)}</ul></>}
    {sugg !== undefined && g.status === 'needs_review' && <p className="alert info">Suggested marks from checks: {sugg}</p>}
    {hasRub ? <div className="stack">{q.rubric.map((r) => <Field key={r.criterion} label={`${r.criterion} (max ${r.max})`}><input type="number" min="0" max={r.max} step="0.5" value={rs[r.criterion] ?? ''} onChange={(e) => setRs({ ...rs, [r.criterion]: e.target.value })} /></Field>)}</div> : <Field label={`Marks (0–${q.marks})`}><input type="number" min="0" max={q.marks} step="0.5" value={marks} onChange={(e) => setMarks(e.target.value)} /></Field>}
    <Field label="Feedback to student"><textarea value={fb} onChange={(e) => setFb(e.target.value)} /></Field>
    {g?.final_marks != null && <Field label="Reason for changing an existing mark" hint="Required when the mark changes; recorded in the grade history."><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
    <button className="btn" disabled={busy} onClick={save}>Save grade</button></Card>;
}
export function Grader() {
  const { attemptId } = useParams(); const { loading, data: d, error, reload } = useAsync(() => api.get(`/api/attempts/${attemptId}/grading`), [attemptId]);
  if (loading) return <Loading />; if (error) return <ErrorBox error={error} retry={reload} />;
  const t = d.attempt;
  return <div style={{ maxWidth: 960 }}><p><Link to={`/manage/assessments/${d.assessment.id}`}>← {d.assessment.title}</Link></p><h1>{d.student.full_name} <small>{d.student.student_number}</small></h1>
    <Card><div className="grid"><div className="stat"><b>{t.score ?? '—'}/{t.max_score ?? '—'}</b><span>Score (provisional until fully graded)</span></div><div className="stat"><b>{t.percentage ?? '—'}%</b><span>Percentage</span></div><div className="stat"><b><StatusBadge value={t.grading_status} /></b><span>Grading</span></div><div className="stat"><b>{t.status.replace('_', ' ')}</b><span>Attempt {t.attempt_no} · {fmt(t.submitted_at)}</span></div></div>{t.late && <p className="alert warn">Submitted late; penalty {t.late_penalty_pct}% applies.</p>}<small>Receipt {t.receipt_code}. Assessment status: {d.assessment.status.replace(/_/g, ' ')}.</small></Card>
    {d.questions.map((q) => <QGrade key={q.question_id + (q.grade?.graded_at || '')} attemptId={attemptId} q={q} reload={reload} />)}
    <Card title="Grade change history"><Table rowKey={(r) => r.id} cols={[{ h: 'When', render: (r) => fmt(r.created_at) }, { h: 'By', k: 'changed_by_name' }, { h: 'Old', k: 'old_marks' }, { h: 'New', k: 'new_marks' }, { h: 'Reason', k: 'reason' }]} rows={d.grade_history} empty="No changes after first grading." /></Card>
    <Card title="Session record (signals are not proof of misconduct)"><Table rowKey={(r) => r.created_at + r.type} cols={[{ h: 'When', render: (r) => fmt(r.created_at) }, { h: 'Event', k: 'type' }]} rows={d.events.filter((e) => e.type !== 'save').slice(0, 60)} empty="No events." /></Card></div>;
}
