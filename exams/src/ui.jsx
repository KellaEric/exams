import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ApiError } from './api.js';

const TZ = 'Africa/Accra';
const dtf = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' });
export const fmt = (d) => (d ? dtf.format(new Date(d)) : '—');
// Ghana is GMT+0 all year (no DST), so a datetime-local value in Africa/Accra is the same clock reading in UTC.
export const toIso = (local) => (local ? new Date(local + ':00Z').toISOString() : null);
export const toLocalInput = (iso) => (iso ? new Date(iso).toISOString().slice(0, 16) : '');
export const pct = (n) => (n == null ? '—' : `${n}%`);

export function useAsync(fn, deps = []) {
  const [s, setS] = useState({ loading: true, data: null, error: null });
  const run = useCallback(() => { setS((x) => ({ ...x, loading: true, error: null })); return fn().then((data) => setS({ loading: false, data, error: null }), (error) => setS({ loading: false, data: null, error })); }, deps); // eslint-disable-line
  useEffect(() => { run(); }, [run]);
  return { ...s, reload: run };
}
export const Loading = ({ text = 'Loading…' }) => <div className="loading" role="status" aria-live="polite">{text}</div>;
export const ErrorBox = ({ error, retry }) => error ? <div className="alert error" role="alert">{error.message || String(error)}{error.details?.problems && <ul>{error.details.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}{error.details?.fields && <ul>{error.details.fields.map((p, i) => <li key={i}>{p.path}: {p.message}</li>)}</ul>}{retry && <button className="btn small" onClick={retry}>Try again</button>}</div> : null;
export const Empty = ({ children }) => <div className="empty">{children}</div>;
export const Badge = ({ tone = 'gray', children }) => <span className={`badge ${tone}`}>{children}</span>;
const TONES = { published: 'green', in_progress: 'blue', graded: 'green', results_released: 'green', closed: 'gray', draft: 'gray', pending_review: 'amber', approved: 'blue', scheduled: 'amber', archived: 'gray', active: 'green', pending: 'amber', suspended: 'red', invited: 'blue', deactivated: 'gray', open: 'amber', resolved: 'green', ready: 'green', available: 'green', upcoming: 'amber', missed: 'red', submitted: 'blue', awaiting_grading: 'amber', imported_verified: 'green', imported_incomplete: 'amber', needs_confirmation: 'amber', in_review: 'amber', retired: 'gray' };
export const StatusBadge = ({ value }) => <Badge tone={TONES[value] || 'gray'}>{String(value || '').replace(/_/g, ' ')}</Badge>;

export function Card({ title, actions, children, className = '' }) {
  return <section className={`card ${className}`}>{(title || actions) && <header className="card-h"><h2>{title}</h2><div className="row">{actions}</div></header>}{children}</section>;
}
export function Field({ label, hint, error, children }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}{error && <small className="err">{error}</small>}</label>;
}
export function Table({ cols, rows, empty = 'Nothing to show yet.', rowKey = (r) => r.id }) {
  if (!rows?.length) return <Empty>{empty}</Empty>;
  return <div className="table-wrap"><table><thead><tr>{cols.map((c) => <th key={c.h} scope="col">{c.h}</th>)}</tr></thead><tbody>{rows.map((r, i) => <tr key={rowKey(r, i) ?? i}>{cols.map((c) => <td key={c.h}>{c.render ? c.render(r) : r[c.k]}</td>)}</tr>)}</tbody></table></div>;
}
export function Tabs({ tabs, value, onChange }) {
  return <div className="tabs" role="tablist">{tabs.map(([k, label]) => <button key={k} role="tab" aria-selected={value === k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>{label}</button>)}</div>;
}

// ---- toasts + confirm dialogs ----
const UiCtx = createContext(null);
export const useUi = () => useContext(UiCtx);
export function UiProvider({ children }) {
  const [toasts, setToasts] = useState([]); const [dlg, setDlg] = useState(null); const id = useRef(0);
  const toast = useCallback((text, type = 'ok') => { const n = ++id.current; setToasts((t) => [...t, { n, text, type }]); setTimeout(() => setToasts((t) => t.filter((x) => x.n !== n)), 5000); }, []);
  const confirm = useCallback((message, { okLabel = 'Confirm', danger = false, ask } = {}) => new Promise((res) => setDlg({ message, okLabel, danger, ask, res })), []);
  const fail = useCallback((e) => toast(e instanceof ApiError || e?.message ? e.message : 'Something went wrong.', 'error'), [toast]);
  const [val, setVal] = useState('');
  const close = (v) => { dlg.res(v); setDlg(null); setVal(''); };
  return <UiCtx.Provider value={{ toast, confirm, fail }}>
    {children}
    <div className="toasts" aria-live="polite">{toasts.map((t) => <div key={t.n} className={`toast ${t.type}`} role={t.type === 'error' ? 'alert' : 'status'}>{t.text}</div>)}</div>
    {dlg && <div className="modal-bg" role="dialog" aria-modal="true"><div className="modal"><p>{dlg.message}</p>
      {dlg.ask && <input autoFocus aria-label={dlg.ask} placeholder={dlg.ask} value={val} onChange={(e) => setVal(e.target.value)} />}
      <div className="row end"><button className="btn ghost" onClick={() => close(null)}>Cancel</button><button className={`btn ${dlg.danger ? 'danger' : ''}`} onClick={() => close(dlg.ask ? val : true)}>{dlg.okLabel}</button></div></div></div>}
  </UiCtx.Provider>;
}
// Runs an async action; shows a toast only AFTER the server confirmed success.
export function useAction() {
  const { toast, fail } = useUi(); const [busy, setBusy] = useState(false);
  const run = async (fn, okMsg) => { setBusy(true); try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { fail(e); return undefined; } finally { setBusy(false); } };
  return { busy, run };
}
export function useForm(initial) {
  const [v, setV] = useState(initial);
  const bind = (k) => ({ value: v[k] ?? '', onChange: (e) => setV((s) => ({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })) });
  const check = (k) => ({ checked: !!v[k], onChange: (e) => setV((s) => ({ ...s, [k]: e.target.checked })) });
  return { v, setV, bind, check };
}
export function Pager({ total, limit, offset, onChange }) {
  if (!total || total <= limit) return null;
  return <div className="row pager"><button className="btn small ghost" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>Previous</button><span>{offset + 1}–{Math.min(total, offset + limit)} of {total}</span><button className="btn small ghost" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>Next</button></div>;
}
