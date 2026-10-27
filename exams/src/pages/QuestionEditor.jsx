import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Card, ErrorBox, Field, Loading, StatusBadge, Table, fmt, useAction, useAsync, useForm, useUi } from '../ui.jsx';

const TYPES = [['mcq', 'Multiple choice (one answer)'], ['multi_select', 'Multiple select'], ['true_false', 'True / false'], ['short_answer', 'Short answer'], ['fill_blank', 'Fill in the blank'], ['numeric', 'Numerical (with tolerance)'], ['matching', 'Matching'], ['ordering', 'Ordering / sequencing'], ['essay', 'Essay / long answer'], ['code', 'Code writing'], ['file_upload', 'File upload'], ['practical', 'Practical task']];
const blank = { type: 'mcq', stem: '', marks: 1, topic: '', difficulty: 'medium', instructions: '', explanation: '', options: [{ text: '', is_correct: true }, { text: '', is_correct: false }], correct: true, accepted: '', case_sensitive: false, review_unmatched: false, blanks: [''], value: '', tolerance: 0, tolerance_type: 'absolute', unit: '', pairs: [{ left: '', right: '' }, { left: '', right: '' }], items: ['', ''], partial: true, max_words: '', rubric: [], language: 'python', starter_code: '', mode: 'manual', checks: '[]', confirm_by_instructor: false, allowed_types: 'pdf, png, jpg, zip', steps: '' };

function fromServer(q) {
  const c = q.config || {}, k = q.answer_key || {};
  return { ...blank, type: q.type, stem: q.stem, marks: q.marks, topic: q.topic || '', difficulty: q.difficulty, instructions: q.instructions || '', explanation: q.explanation || '', rubric: q.rubric || [],
    options: q.options?.length ? q.options.map((o) => ({ text: o.text, is_correct: o.is_correct, feedback: o.feedback })) : blank.options, partial: c.partial !== false,
    correct: k.value ?? true, accepted: (k.accepted || []).join('\n'), case_sensitive: !!k.case_sensitive, review_unmatched: !!k.review_unmatched,
    blanks: (k.blanks || [{ accepted: [''] }]).map((b) => (b.accepted ? b.accepted.join('|') : b)), value: k.value ?? '', tolerance: k.tolerance ?? 0, tolerance_type: k.tolerance_type || 'absolute', unit: c.unit || '',
    pairs: c.left ? c.left.map((l) => ({ left: l.text, right: c.right.find((r) => r.id === k.pairs[l.id])?.text || '' })) : blank.pairs,
    items: k.order ? k.order.map((id) => c.items.find((i) => i.id === id)?.text) : blank.items, max_words: c.max_words || '', language: c.language || 'python', starter_code: c.starter_code || '', mode: k.mode || 'manual', checks: JSON.stringify(k.checks || [], null, 1), confirm_by_instructor: !!k.confirm_by_instructor,
    allowed_types: (c.allowed_types || []).join(', ') || blank.allowed_types, steps: (c.steps || []).join('\n') };
}
function toServer(f) {
  const b = { type: f.type, stem: f.stem, marks: Number(f.marks), topic: f.topic || undefined, difficulty: f.difficulty, instructions: f.instructions || undefined, explanation: f.explanation || undefined, rubric: f.rubric.map((r) => ({ criterion: r.criterion, max: Number(r.max), description: r.description })) };
  const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  switch (f.type) {
    case 'mcq': case 'multi_select': b.options = f.options; b.partial = f.partial; break;
    case 'true_false': b.correct = f.correct === true || f.correct === 'true'; break;
    case 'short_answer': Object.assign(b, { accepted: lines(f.accepted), case_sensitive: f.case_sensitive, review_unmatched: f.review_unmatched }); break;
    case 'fill_blank': Object.assign(b, { blanks: f.blanks.map((x) => ({ accepted: x.split('|').map((y) => y.trim()).filter(Boolean) })), case_sensitive: f.case_sensitive }); break;
    case 'numeric': Object.assign(b, { value: Number(f.value), tolerance: Number(f.tolerance), tolerance_type: f.tolerance_type, unit: f.unit || undefined }); break;
    case 'matching': b.pairs = f.pairs; break;
    case 'ordering': Object.assign(b, { items: f.items, partial: f.partial }); break;
    case 'essay': b.max_words = Number(f.max_words) || undefined; break;
    case 'code': Object.assign(b, { language: f.language, starter_code: f.starter_code || undefined, mode: f.mode, confirm_by_instructor: f.confirm_by_instructor }); if (f.mode === 'static_checks') b.checks = JSON.parse(f.checks); break;
    case 'file_upload': b.allowed_types = f.allowed_types.split(',').map((x) => x.trim()).filter(Boolean); break;
    case 'practical': b.steps = lines(f.steps); break;
  }
  return b;
}
const Rows = ({ list, set, render, add, addLabel, min = 1 }) => <div className="stack">{list.map((x, i) => <div key={i} className="row">{render(x, (v) => set(list.map((y, j) => (j === i ? v : y))), i)}{list.length > min && <button type="button" className="btn small ghost" aria-label="Remove row" onClick={() => set(list.filter((_, j) => j !== i))}>✕</button>}</div>)}<button type="button" className="btn small ghost" onClick={() => set([...list, add])}>+ {addLabel}</button></div>;

export default function QuestionEditor() {
  const { id } = useParams(); const [sp] = useSearchParams(); const nav = useNavigate(); const { can, user } = useAuth(); const { confirm } = useUi();
  const isNew = id === 'new'; const [courseId, setCourseId] = useState(sp.get('course')); const f = useForm(blank); const [meta, setMeta] = useState(null); const [err, setErr] = useState(null); const { run, busy } = useAction();
  const load = async () => { const q = await api.get(`/api/questions/${id}`); setCourseId(q.course_id); setMeta(q); f.setV(fromServer(q)); };
  useEffect(() => { if (!isNew) load().catch(setErr); }, [id]);   // eslint-disable-line
  const versions = useAsync(() => (isNew ? Promise.resolve({ rows: [] }) : api.get(`/api/questions/${id}/versions`)), [id, meta?.version]);
  const set = (k) => (v) => f.setV((s) => ({ ...s, [k]: v })); const v = f.v;
  const save = async () => {
    let body; try { body = toServer(v); } catch { return setErr(new Error('The pattern checks are not valid JSON.')); }
    setErr(null);
    try { if (isNew) { const q = await api.post(`/api/courses/${courseId}/questions`, body); nav(`/questions/${q.id}`, { replace: true }); } else { body.change_reason = 'edited in editor'; setMeta(await api.put(`/api/questions/${id}`, body)); f.setV(fromServer(await api.get(`/api/questions/${id}`))); } } catch (e) { setErr(e); }
  };
  const act = async (a) => { if (a === 'retire' && !(await confirm('Retire this question? It can no longer be added to new assessments.', { danger: true, okLabel: 'Retire' }))) return; if (await run(() => api.post(`/api/questions/${id}/${a}`, {}), 'Done.')) load(); };
  if (!isNew && !meta && !err) return <Loading />;
  const locked = meta?.status === 'retired';
  return <div style={{ maxWidth: 900 }}><p><Link to={courseId ? `/courses/${courseId}` : '/courses'}>← Back to course</Link></p><h1>{isNew ? 'New question' : 'Edit question'} {meta && <StatusBadge value={meta.status} />}</h1><ErrorBox error={err} />
    {meta?.status === 'approved' && <p className="alert info">Saving changes returns this question to draft and creates version {meta.version + 1}. Assessments already approved keep the version they were frozen with.</p>}
    <Card>
      <div className="two"><Field label="Question type"><select value={v.type} disabled={!isNew} onChange={(e) => set('type')(e.target.value)}>{TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field><div className="two"><Field label="Marks"><input type="number" min="0.5" step="0.5" value={v.marks} onChange={(e) => set('marks')(e.target.value)} /></Field><Field label="Difficulty"><select value={v.difficulty} onChange={(e) => set('difficulty')(e.target.value)}>{['easy', 'medium', 'hard'].map((d) => <option key={d}>{d}</option>)}</select></Field></div></div>
      <Field label="Question text" hint={v.type === 'fill_blank' ? 'Use ___ (three underscores) where each blank goes.' : undefined}><textarea value={v.stem} onChange={(e) => set('stem')(e.target.value)} /></Field>
      <div className="two"><Field label="Topic / module"><input value={v.topic} onChange={(e) => set('topic')(e.target.value)} /></Field><Field label="Instructions for students (optional)"><input value={v.instructions} onChange={(e) => set('instructions')(e.target.value)} /></Field></div>

      {['mcq', 'multi_select'].includes(v.type) && <Field label={v.type === 'mcq' ? 'Options (select the single correct one)' : 'Options (tick every correct one)'}><Rows list={v.options} set={set('options')} min={2} add={{ text: '', is_correct: false }} addLabel="Add option" render={(o, up) => <><input type={v.type === 'mcq' ? 'radio' : 'checkbox'} aria-label="Correct" name="correct" checked={!!o.is_correct} onChange={(e) => v.type === 'mcq' ? set('options')(v.options.map((x) => ({ ...x, is_correct: x === o }))) : up({ ...o, is_correct: e.target.checked })} /><input className="grow" aria-label="Option text" value={o.text} onChange={(e) => up({ ...o, text: e.target.value })} /></>} />{v.type === 'multi_select' && <label className="row"><input type="checkbox" checked={v.partial} onChange={(e) => set('partial')(e.target.checked)} /> Award partial credit</label>}</Field>}
      {v.type === 'true_false' && <Field label="Correct answer"><select value={String(v.correct)} onChange={(e) => set('correct')(e.target.value === 'true')}><option value="true">True</option><option value="false">False</option></select></Field>}
      {v.type === 'short_answer' && <><Field label="Accepted answers (one per line)"><textarea value={v.accepted} onChange={(e) => set('accepted')(e.target.value)} /></Field><label className="row"><input type="checkbox" checked={v.case_sensitive} onChange={(e) => set('case_sensitive')(e.target.checked)} /> Case sensitive</label><label className="row"><input type="checkbox" checked={v.review_unmatched} onChange={(e) => set('review_unmatched')(e.target.checked)} /> Send non-matching answers to an instructor for review</label></>}
      {v.type === 'fill_blank' && <Field label="Accepted answers per blank (separate alternatives with |)"><Rows list={v.blanks} set={set('blanks')} add="" addLabel="Add blank" render={(b, up, i) => <><span>#{i + 1}</span><input className="grow" value={b} onChange={(e) => up(e.target.value)} /></>} /></Field>}
      {v.type === 'numeric' && <div className="two"><Field label="Correct value"><input type="number" step="any" value={v.value} onChange={(e) => set('value')(e.target.value)} /></Field><Field label="Tolerance"><div className="row"><input type="number" min="0" step="any" value={v.tolerance} onChange={(e) => set('tolerance')(e.target.value)} /><select value={v.tolerance_type} onChange={(e) => set('tolerance_type')(e.target.value)}><option value="absolute">± absolute</option><option value="percent">± percent</option></select></div></Field><Field label="Unit (display only)"><input value={v.unit} onChange={(e) => set('unit')(e.target.value)} /></Field></div>}
      {v.type === 'matching' && <Field label="Pairs (left item → its correct match)"><Rows list={v.pairs} set={set('pairs')} min={2} add={{ left: '', right: '' }} addLabel="Add pair" render={(p, up) => <><input className="grow" aria-label="Left" value={p.left} onChange={(e) => up({ ...p, left: e.target.value })} /><span>→</span><input className="grow" aria-label="Right" value={p.right} onChange={(e) => up({ ...p, right: e.target.value })} /></>} /></Field>}
      {v.type === 'ordering' && <Field label="Items in the CORRECT order (students see them shuffled)"><Rows list={v.items} set={set('items')} min={2} add="" addLabel="Add item" render={(t, up, i) => <><span>{i + 1}.</span><input className="grow" value={t} onChange={(e) => up(e.target.value)} /></>} /><label className="row"><input type="checkbox" checked={v.partial} onChange={(e) => set('partial')(e.target.checked)} /> Partial credit for items in the right position</label></Field>}
      {v.type === 'essay' && <Field label="Word limit (optional)"><input type="number" min="1" value={v.max_words} onChange={(e) => set('max_words')(e.target.value)} /></Field>}
      {v.type === 'code' && <><div className="two"><Field label="Language"><input value={v.language} onChange={(e) => set('language')(e.target.value)} /></Field><Field label="Grading"><select value={v.mode} onChange={(e) => set('mode')(e.target.value)}><option value="manual">Manual (instructor grades the code)</option><option value="static_checks">Automatic pattern checks (code is NOT executed)</option></select></Field></div><Field label="Starter code (optional)"><textarea className="code" style={{ minHeight: 90 }} value={v.starter_code} onChange={(e) => set('starter_code')(e.target.value)} /></Field>
        {v.mode === 'static_checks' && <><Field label="Checks (JSON)" hint='Each check: {"name":"Uses input()","points":2,"type":"regex","pattern":"\\binput\\s*\\("}. Types: regex, fexpr, minLength, all, any. Points must add up to the question marks. Hidden from students.'><textarea className="code" value={v.checks} onChange={(e) => set('checks')(e.target.value)} /></Field><label className="row"><input type="checkbox" checked={v.confirm_by_instructor} onChange={(e) => set('confirm_by_instructor')(e.target.checked)} /> An instructor must confirm the marks before they count</label><p className="alert warn">Pattern checks look for code structure only; they cannot prove a program works. Students’ code is never run on this server.</p></>}</>}
      {v.type === 'file_upload' && <Field label="Allowed file types (comma separated)"><input value={v.allowed_types} onChange={(e) => set('allowed_types')(e.target.value)} /></Field>}
      {v.type === 'practical' && <Field label="Practical steps (one per line)"><textarea value={v.steps} onChange={(e) => set('steps')(e.target.value)} /></Field>}

      {['essay', 'code', 'file_upload', 'practical'].includes(v.type) && <Field label={v.type === 'practical' ? 'Marking rubric (required; must total the question marks)' : 'Marking rubric (optional; must total the question marks)'}><Rows list={v.rubric} min={0} set={set('rubric')} add={{ criterion: '', max: 1, description: '' }} addLabel="Add criterion" render={(r, up) => <><input className="grow" aria-label="Criterion" placeholder="Criterion" value={r.criterion} onChange={(e) => up({ ...r, criterion: e.target.value })} /><input aria-label="Marks" type="number" step="0.5" min="0.5" style={{ width: 90 }} value={r.max} onChange={(e) => up({ ...r, max: e.target.value })} /></>} /><small>Total: {v.rubric.reduce((s, r) => s + Number(r.max || 0), 0)} / {v.marks}</small></Field>}
      <Field label="Explanation / learning feedback (shown after results, if the assessment allows)"><textarea value={v.explanation} onChange={(e) => set('explanation')(e.target.value)} /></Field>
      <div className="row"><button className="btn" disabled={busy || locked} onClick={save}>{isNew ? 'Create question' : 'Save changes'}</button>
        {meta?.status === 'draft' && <button className="btn ghost" onClick={() => act('submit')}>Submit for review</button>}
        {meta?.status === 'in_review' && <>{can('question.approve') && <button className="btn ok" onClick={() => act('approve')}>Approve</button>}{can('question.review') && <button className="btn ghost" onClick={() => act('reject')}>Return to draft</button>}</>}
        {meta && !locked && can('question.approve') && <button className="btn danger" onClick={() => act('retire')}>Retire</button>}
        {meta && <button className="btn ghost" onClick={async () => { const q = await run(() => api.post(`/api/questions/${id}/duplicate`, {}), 'Duplicated.'); if (q) nav(`/questions/${q.id}`); }}>Duplicate</button>}</div></Card>
    {!isNew && <Card title="Version history"><Table rowKey={(r) => r.version} cols={[{ h: 'Version', k: 'version' }, { h: 'When', render: (r) => fmt(r.created_at) }, { h: 'By', k: 'changed_by' }, { h: 'Note', k: 'reason' }]} rows={versions.data?.rows} /></Card>}</div>;
}
