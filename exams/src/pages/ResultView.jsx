import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { Badge, Card, ErrorBox, Loading, useAsync } from '../ui.jsx';

const show = (q, r) => { if (r == null) return <em>No answer</em>; if (q.options) { const ids = Array.isArray(r) ? r : [r]; return ids.map((id) => q.options.find((o) => o.id === id)?.text || id).join(', '); } if (typeof r === 'object' && !Array.isArray(r)) return r.text || (r.files || []).map((f) => f.name).join(', ') || JSON.stringify(r); return q.type === 'code' ? <pre className="code">{String(r)}</pre> : String(Array.isArray(r) ? r.join(' | ') : r); };
export default function ResultView() {
  const { attemptId } = useParams(); const { loading, data: d, error } = useAsync(() => api.get(`/api/attempts/${attemptId}/result`), [attemptId]);
  if (loading) return <Loading />; if (error) return <div><ErrorBox error={error} /><Link to="/assessments">Back</Link></div>;
  return <div style={{ maxWidth: 900 }}><h1>{d.assessment.title}</h1>
    <Card title="Your result">{d.message ? <p>{d.message}</p> : <div className="grid"><div className="stat"><b>{d.result.score}/{d.result.max_score}</b><span>Marks</span></div><div className="stat"><b>{d.result.percentage}%</b><span>Percentage</span></div><div className="stat"><b>{d.result.grade || '—'}</b><span>Grade</span></div><div className="stat"><b><Badge tone={d.result.passed ? 'green' : 'red'}>{d.result.passed ? 'Pass' : 'Fail'}</Badge></b><span>Outcome</span></div></div>}
      {d.result?.late_penalty_pct > 0 && <p className="alert warn">A late penalty of {d.result.late_penalty_pct}% was applied.</p>}<small>Attempt {d.attempt.attempt_no} · receipt {d.attempt.receipt_code}</small></Card>
    {d.questions?.map((x, i) => <Card key={x.question.id} title={`Question ${i + 1}`} actions={<Badge tone={x.awarded === x.max_marks ? 'green' : x.awarded > 0 ? 'amber' : 'red'}>{x.awarded ?? '—'} / {x.max_marks}</Badge>}>
      <p className="stem">{x.question.stem}</p><p><b>Your answer:</b> {show(x.question, x.response)}</p>{x.feedback && <p className="alert info"><b>Feedback:</b> {x.feedback}</p>}
      {x.correct && <p><b>Correct answer:</b> <code>{JSON.stringify(x.correct.correct_option_ids ? x.question.options.filter((o) => x.correct.correct_option_ids.includes(o.id)).map((o) => o.text) : x.correct)}</code></p>}{x.explanation && <p><b>Explanation:</b> {x.explanation}</p>}</Card>)}
    <div className="row no-print"><button className="btn ghost" onClick={() => window.print()}>Print</button><Link className="btn ghost" to="/history">Back to history</Link></div></div>;
}
