import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { Badge, Card, ErrorBox, Loading, useUi } from '../ui.jsx';

const fmtClock = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return `${h ? h + ':' : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(x).padStart(2, '0')}`; };

function Answer({ q, value, onChange, attemptId, disabled }) {
  const { fail } = useUi(); const set = (v) => onChange(v);
  switch (q.type) {
    case 'mcq': return <div role="radiogroup" aria-label="Choose one">{q.options.map((o) => <label key={o.id} className={`opt ${value === o.id ? 'sel' : ''}`}><input type="radio" name={q.id} checked={value === o.id} onChange={() => set(o.id)} disabled={disabled} /><span>{o.text}</span></label>)}</div>;
    case 'multi_select': { const cur = value || []; return <div role="group" aria-label="Choose all that apply">{q.options.map((o) => <label key={o.id} className={`opt ${cur.includes(o.id) ? 'sel' : ''}`}><input type="checkbox" checked={cur.includes(o.id)} onChange={() => set(cur.includes(o.id) ? cur.filter((x) => x !== o.id) : [...cur, o.id])} disabled={disabled} /><span>{o.text}</span></label>)}</div>; }
    case 'true_false': return <div role="radiogroup" aria-label="True or false">{[true, false].map((b) => <label key={String(b)} className={`opt ${value === b ? 'sel' : ''}`}><input type="radio" name={q.id} checked={value === b} onChange={() => set(b)} disabled={disabled} /><span>{b ? 'True' : 'False'}</span></label>)}</div>;
    case 'short_answer': return <input aria-label="Your answer" value={value || ''} onChange={(e) => set(e.target.value)} disabled={disabled} maxLength={500} />;
    case 'numeric': return <div className="row"><input aria-label="Your numeric answer" inputMode="decimal" style={{ maxWidth: 220 }} value={value ?? ''} onChange={(e) => set(e.target.value)} disabled={disabled} />{q.config.unit && <span>{q.config.unit}</span>}</div>;
    case 'fill_blank': { const arr = value || []; return <div className="stack">{Array.from({ length: q.config.blanks }, (_, i) => <input key={i} aria-label={`Blank ${i + 1}`} placeholder={`Blank ${i + 1}`} value={arr[i] || ''} onChange={(e) => { const n = [...arr]; n[i] = e.target.value; set(n); }} disabled={disabled} />)}</div>; }
    case 'matching': { const cur = value || {}; return <div className="stack">{q.config.left.map((l) => <div key={l.id} className="two" style={{ alignItems: 'center' }}><span>{l.text}</span><select aria-label={`Match for ${l.text}`} value={cur[l.id] || ''} onChange={(e) => set({ ...cur, [l.id]: e.target.value })} disabled={disabled}><option value="">Choose…</option>{q.config.right.map((r) => <option key={r.id} value={r.id}>{r.text}</option>)}</select></div>)}</div>; }
    case 'ordering': { const items = value?.length ? value.map((id) => q.config.items.find((i) => i.id === id)).filter(Boolean) : q.config.items; const move = (i, d) => { const n = items.map((x) => x.id); [n[i], n[i + d]] = [n[i + d], n[i]]; set(n); };
      return <ol className="stack" aria-label="Put in order, first at top">{items.map((it, i) => <li key={it.id} className="row opt" style={{ cursor: 'default' }}><span className="grow">{it.text}</span><button type="button" className="btn small ghost" aria-label={`Move ${it.text} up`} disabled={disabled || i === 0} onClick={() => move(i, -1)}>↑</button><button type="button" className="btn small ghost" aria-label={`Move ${it.text} down`} disabled={disabled || i === items.length - 1} onClick={() => move(i, 1)}>↓</button></li>)}{!value && <small>Drag-free ordering: use the arrows, then your order is saved.</small>}</ol>; }
    case 'essay': return <><textarea aria-label="Your answer" style={{ minHeight: 220 }} value={value || ''} onChange={(e) => set(e.target.value)} disabled={disabled} />{q.config.max_words && <small>Maximum {q.config.max_words} words · {(value || '').trim().split(/\s+/).filter(Boolean).length} used</small>}</>;
    case 'code': return <><textarea className="code" spellCheck="false" aria-label={`Your ${q.config.language || ''} code`} value={value ?? q.config.starter_code ?? ''} onChange={(e) => set(e.target.value)} disabled={disabled} onKeyDown={(e) => { if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); const t = e.target, s = t.selectionStart; set(t.value.slice(0, s) + '    ' + t.value.slice(t.selectionEnd)); requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = s + 4; }); } }} /><small>Language: {q.config.language}. Press Tab to indent. Your code is checked automatically or by an instructor; it is not run on your machine here.</small></>;
    case 'file_upload': case 'practical': {
      const cur = value && typeof value === 'object' ? value : { file_ids: [] }; const files = cur.files || [];
      const upload = async (e) => { const f = e.target.files[0]; if (!f) return; try { const r = await api.upload(`/api/files?purpose=answer_upload&attempt_id=${attemptId}`, f); set({ ...cur, file_ids: [...(cur.file_ids || []), r.id], files: [...files, { id: r.id, name: r.original_name }] }); } catch (x) { fail(x); } e.target.value = ''; };
      return <div className="stack">{q.type === 'practical' && <><ol>{(q.config.steps || []).map((s, i) => <li key={i}>{s}</li>)}</ol><textarea aria-label="Notes and observations" placeholder="Notes, observations, results…" value={cur.text || ''} onChange={(e) => set({ ...cur, text: e.target.value })} disabled={disabled} /></>}
        <input type="file" aria-label="Upload a file" onChange={upload} disabled={disabled} /><ul>{files.map((f) => <li key={f.id}>{f.name} <button type="button" className="btn small ghost" disabled={disabled} onClick={() => set({ ...cur, file_ids: cur.file_ids.filter((x) => x !== f.id), files: files.filter((x) => x.id !== f.id) })}>Remove</button></li>)}</ul></div>; }
    default: return <p>Unsupported question type.</p>;
  }
}
const answered = (v) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) && !(typeof v === 'object' && v.file_ids && !v.file_ids.length && !v.text);

export default function ExamRunner() {
  const { attemptId } = useParams(); const nav = useNavigate(); const { confirm, fail } = useUi();
  const [view, setView] = useState(null); const [error, setError] = useState(null);
  const [answers, setAnswers] = useState({}); const [flags, setFlags] = useState({}); const [cur, setCur] = useState(0);
  const [remaining, setRemaining] = useState(null); const [online, setOnline] = useState(navigator.onLine); const [confirmed, setConfirmed] = useState({});   // question_id -> seq confirmed by server
  const seqs = useRef({}); const dirty = useRef(new Set()); const sending = useRef(false); const sync = useRef({ t0: 0, remaining: 0 }); const done = useRef(false);

  const finish = useCallback((r) => { done.current = true; nav(`/assessments/${view?.assessment.id || ''}`, { replace: true, state: { receipt: r?.receipt_code } }); }, [nav, view]);
  const resync = (secs) => { sync.current = { t0: performance.now(), remaining: secs }; setRemaining(secs); };   // monotonic clock: unaffected by changing the device clock

  useEffect(() => { let live = true; api.get(`/api/attempts/${attemptId}`).then((v) => { if (!live) return;
    if (v.attempt.status !== 'in_progress') { nav(`/assessments/${v.assessment.id}`, { replace: true }); return; }
    setView(v); const a = {}, fl = {}, c = {}; for (const [qid, x] of Object.entries(v.answers)) { a[qid] = x.response; fl[qid] = x.flagged; seqs.current[qid] = x.seq; c[qid] = x.seq; } setAnswers(a); setFlags(fl); setConfirmed(c); resync(v.attempt.remaining_seconds); }).catch((e) => live && setError(e)); return () => { live = false; }; }, [attemptId]);   // eslint-disable-line

  const flush = useCallback(async () => {
    if (sending.current || done.current || !dirty.current.size) return; sending.current = true;
    const ids = [...dirty.current]; const payload = ids.map((qid) => ({ question_id: qid, response: answers[qid] ?? null, flagged: !!flags[qid], seq: seqs.current[qid] }));
    try { const r = await api.put(`/api/attempts/${attemptId}/answers`, { answers: payload }); setOnline(true); resync(r.remaining_seconds);
      ids.forEach((qid) => { if (seqs.current[qid] === payload.find((p) => p.question_id === qid).seq) dirty.current.delete(qid); }); setConfirmed((c) => ({ ...c, ...Object.fromEntries(payload.map((p) => [p.question_id, p.seq])) }));
    } catch (e) { if (e.code === 'time_expired' || e.code === 'attempt_closed') { done.current = true; finish(e.details); } else if (e.status === 0) setOnline(false); else fail(e); }
    finally { sending.current = false; }
  }, [answers, flags, attemptId, fail, finish]);

  useEffect(() => { const t = setTimeout(flush, 700); return () => clearTimeout(t); }, [answers, flags, flush]);          // debounce autosave after changes
  useEffect(() => { const t = setInterval(flush, 5000); return () => clearInterval(t); }, [flush]);                    // retry unsent answers (reconnect)
  useEffect(() => { const on = () => { setOnline(true); flush(); }, off = () => setOnline(false); window.addEventListener('online', on); window.addEventListener('offline', off); return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); }; }, [flush]);
  useEffect(() => { const h = (e) => { if (dirty.current.size) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', h); return () => window.removeEventListener('beforeunload', h); }, []);
  useEffect(() => { const sig = (type) => () => api.post(`/api/attempts/${attemptId}/events`, { type }).catch(() => {}); const b = sig('blur'), f = sig('focus'); window.addEventListener('blur', b); window.addEventListener('focus', f); return () => { window.removeEventListener('blur', b); window.removeEventListener('focus', f); }; }, [attemptId]);

  const submit = useCallback(async (auto) => {
    if (done.current) return; await flush();
    try { const r = await api.post(`/api/attempts/${attemptId}/submit`); done.current = true; finish(r); } catch (e) { fail(e); }
  }, [attemptId, flush, finish, fail]);

  useEffect(() => { if (remaining === null) return; const t = setInterval(() => { const left = Math.max(0, Math.round(sync.current.remaining - (performance.now() - sync.current.t0) / 1000)); setRemaining(left); if (left <= 0 && !done.current) submit(true); }, 500); return () => clearInterval(t); }, [remaining === null, submit]);   // eslint-disable-line

  const qs = view?.questions || []; const q = qs[cur];
  const change = (qid, v) => { seqs.current[qid] = (seqs.current[qid] || 0) + 1; dirty.current.add(qid); setAnswers((a) => ({ ...a, [qid]: v })); };
  const toggleFlag = (qid) => { seqs.current[qid] = (seqs.current[qid] || 0) + 1; dirty.current.add(qid); setFlags((f) => ({ ...f, [qid]: !f[qid] })); if (!(qid in answers)) setAnswers((a) => ({ ...a, [qid]: null })); };
  const unsaved = dirty.current.size > 0 || Object.keys(seqs.current).some((k) => seqs.current[k] !== confirmed[k]);
  const stem = useMemo(() => q?.stem, [q]);
  if (error) return <ErrorBox error={error} />; if (!view || !q) return <Loading text="Loading your attempt…" />;
  const nAnswered = qs.filter((x) => answered(answers[x.id])).length; const low = remaining !== null && remaining <= 300;
  const trySubmit = async () => { await flush(); const un = qs.length - qs.filter((x) => answered(answers[x.id])).length; const fl = Object.values(flags).filter(Boolean).length;
    if (await confirm(`Submit now? ${un ? `${un} question(s) are unanswered. ` : ''}${fl ? `${fl} question(s) are flagged. ` : ''}You cannot change your answers after submitting.`, { okLabel: 'Submit final answers' })) submit(false); };
  return <div>
    <div className="exam-bar" role="region" aria-label="Exam status">
      <strong className="grow">{view.assessment.title}</strong>
      <span className={`timer ${low ? 'low' : ''}`} role="timer" aria-label="Time remaining">{fmtClock(remaining ?? 0)}</span>
      <span className={`save-ind ${!online ? 'offline' : unsaved ? 'unsaved' : 'saved'}`} role="status" aria-live="polite">{!online ? 'Offline — answers kept, will retry' : unsaved ? 'Saving…' : 'All answers saved'}</span>
      <button className="btn ok" onClick={trySubmit}>Review & submit</button>
    </div>
    {low && <div className="alert warn" role="alert">Less than 5 minutes remain. Your saved answers will be submitted automatically at zero.</div>}
    <div className="exam">
      <Card><div className="row" style={{ justifyContent: 'space-between' }}><b>Question {cur + 1} of {qs.length}</b><span><Badge>{q.marks} mark{q.marks === 1 ? '' : 's'}</Badge></span></div>
        <div className="stem" style={{ marginTop: 10 }}>{q.type === 'fill_blank' ? stem : stem}</div>{q.instructions && <p className="alert info">{q.instructions}</p>}
        {q.rubric && <details><summary>Marking criteria</summary><ul>{q.rubric.map((r) => <li key={r.criterion}>{r.criterion} ({r.max})</li>)}</ul></details>}
        {q.attachment_file_id && <p><button className="btn small ghost" onClick={async () => { const l = await api.get(`/api/files/${q.attachment_file_id}/link`); window.open(l.url, '_blank', 'noopener'); }}>Open attachment</button></p>}
        <Answer q={q} value={answers[q.id]} onChange={(v) => change(q.id, v)} attemptId={attemptId} />
        <div className="row" style={{ marginTop: 18 }}><button className="btn ghost" disabled={cur === 0 || view.assessment.allow_navigation === false} onClick={() => setCur(cur - 1)}>Previous</button><button className="btn ghost" disabled={cur === qs.length - 1} onClick={() => setCur(cur + 1)}>Next</button><label className="row"><input type="checkbox" checked={!!flags[q.id]} onChange={() => toggleFlag(q.id)} /> Flag for review</label></div></Card>
      <aside><Card title="Questions"><div className="qnav" role="navigation" aria-label="Question navigator">{qs.map((x, i) => <button key={x.id} aria-label={`Question ${i + 1}${answered(answers[x.id]) ? ', answered' : ''}${flags[x.id] ? ', flagged' : ''}`} aria-current={i === cur} disabled={view.assessment.allow_navigation === false && i < cur} className={`${answered(answers[x.id]) ? 'done' : ''} ${i === cur ? 'cur' : ''} ${flags[x.id] ? 'flag' : ''}`} onClick={() => setCur(i)}>{i + 1}</button>)}</div>
        <div className="legend"><span>■ answered</span><span>⚑ flagged</span></div><p style={{ marginTop: 10 }}>{nAnswered} of {qs.length} answered</p>{view.assessment.allow_navigation === false && <small>This exam only moves forward.</small>}</Card></aside>
    </div></div>;
}
