import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { ErrorBox, Field, useForm, useAction, useUi } from '../ui.jsx';

const Frame = ({ title, sub, children }) => <div className="auth-bg"><main className="auth-card"><img src="/logo.png" alt="KellasTech" /><h1>{title}</h1>{sub && <p className="sub">{sub}</p>}{children}</main></div>;

export function Login() {
  const { login, user } = useAuth(); const nav = useNavigate(); const loc = useLocation();
  const f = useForm({ email: '', password: '', mfa: '' }); const [err, setErr] = useState(null); const [needMfa, setNeedMfa] = useState(false); const { busy, run } = useAction();
  if (user) return <Navigate to={loc.state?.from || '/'} replace />;
  const submit = async (e) => {
    e.preventDefault(); setErr(null);
    try { await login(f.v.email, f.v.password, f.v.mfa); nav(loc.state?.from || '/', { replace: true }); }
    catch (x) { if (x.code === 'mfa_required') setNeedMfa(true); else setErr(x); }
  };
  return <Frame title="KellasTech Examination Portal" sub="Sign in with your portal account.">
    <form onSubmit={submit} noValidate><ErrorBox error={err} />
      <Field label="Email"><input type="email" autoComplete="username" required {...f.bind('email')} /></Field>
      <Field label="Password"><input type="password" autoComplete="current-password" required {...f.bind('password')} /></Field>
      {needMfa && <Field label="Authentication code" hint="6 digits from your authenticator app"><input inputMode="numeric" autoComplete="one-time-code" autoFocus {...f.bind('mfa')} /></Field>}
      <button className="btn" style={{ width: '100%' }} disabled={busy}>Sign in</button>
    </form>
    <p style={{ marginTop: 16 }} className="row"><Link to="/forgot">Forgot password?</Link><Link to="/register">Create a student account</Link></p>
  </Frame>;
}
export function Register() {
  const f = useForm({ full_name: '', email: '', student_number: '', password: '' }); const [err, setErr] = useState(null); const [done, setDone] = useState(null);
  const submit = async (e) => { e.preventDefault(); setErr(null); try { setDone((await api.post('/api/auth/register', { ...f.v, student_number: f.v.student_number || undefined })).message); } catch (x) { setErr(x); } };
  if (done) return <Frame title="Account created"><p className="alert info">{done}</p><Link to="/login">Back to sign in</Link></Frame>;
  return <Frame title="Create student account" sub="New accounts may need administrator approval before you can sign in.">
    <form onSubmit={submit}><ErrorBox error={err} />
      <Field label="Full name"><input required {...f.bind('full_name')} /></Field><Field label="Email"><input type="email" required {...f.bind('email')} /></Field>
      <Field label="Student ID (optional)"><input {...f.bind('student_number')} /></Field>
      <Field label="Password" hint="At least 10 characters, with a letter and a number."><input type="password" autoComplete="new-password" required {...f.bind('password')} /></Field>
      <button className="btn" style={{ width: '100%' }}>Create account</button></form><p style={{ marginTop: 14 }}><Link to="/login">Already registered? Sign in</Link></p></Frame>;
}
export function Forgot() {
  const f = useForm({ email: '' }); const [msg, setMsg] = useState(null); const [err, setErr] = useState(null);
  const submit = async (e) => { e.preventDefault(); setErr(null); try { setMsg((await api.post('/api/auth/forgot-password', f.v)).message); } catch (x) { setErr(x); } };
  return <Frame title="Reset password" sub="We will email a reset link if the account exists. If email is not set up at your institution, ask an administrator for a reset link.">
    <form onSubmit={submit}><ErrorBox error={err} />{msg && <p className="alert info">{msg}</p>}<Field label="Email"><input type="email" required {...f.bind('email')} /></Field><button className="btn" style={{ width: '100%' }}>Send reset link</button></form><p style={{ marginTop: 14 }}><Link to="/login">Back to sign in</Link></p></Frame>;
}
function SetPassword({ endpoint, title, sub }) {
  const [q] = useSearchParams(); const f = useForm({ password: '', again: '' }); const [err, setErr] = useState(null); const [ok, setOk] = useState(false);
  const submit = async (e) => { e.preventDefault(); setErr(null); if (f.v.password !== f.v.again) return setErr(new Error('The two passwords do not match.')); try { await api.post(endpoint, { token: q.get('token'), password: f.v.password }); setOk(true); } catch (x) { setErr(x); } };
  if (ok) return <Frame title="Password saved"><p className="alert info">You can now sign in.</p><Link className="btn" to="/login">Sign in</Link></Frame>;
  return <Frame title={title} sub={sub}><form onSubmit={submit}><ErrorBox error={err} />
    <Field label="New password" hint="At least 10 characters (12 for administrators), with a letter and a number."><input type="password" autoComplete="new-password" required {...f.bind('password')} /></Field>
    <Field label="Repeat password"><input type="password" autoComplete="new-password" required {...f.bind('again')} /></Field><button className="btn" style={{ width: '100%' }}>Save password</button></form></Frame>;
}
export const ResetPassword = () => <SetPassword endpoint="/api/auth/reset-password" title="Choose a new password" />;
export const AcceptInvite = () => <SetPassword endpoint="/api/auth/accept-invite" title="Welcome to KellasTech" sub="Set a password to activate your account." />;

export function MfaSetup() {
  const [info, setInfo] = useState(null); const f = useForm({ code: '' }); const { run, busy } = useAction(); const nav = useNavigate(); const { toast } = useUi();
  return <div className="stack" style={{ maxWidth: 560 }}><h1>Set up multi-factor authentication</h1>
    <div className="card stack"><p>Use an authenticator app (Google Authenticator, Microsoft Authenticator, Authy…). Add a new account with this key, then enter the 6-digit code.</p>
      {!info ? <button className="btn" disabled={busy} onClick={async () => setInfo(await run(() => api.post('/api/auth/mfa/setup')))}>Generate key</button> : <>
        <p>Key: <code>{info.secret}</code></p><p><small>Or open on your phone: {info.otpauth_url}</small></p>
        <Field label="Code from the app"><input inputMode="numeric" {...f.bind('code')} /></Field>
        <button className="btn" disabled={busy} onClick={async () => { if (await run(() => api.post('/api/auth/mfa/enable', { code: f.v.code }), 'MFA enabled.')) { toast('Sign in again to continue.'); window.location.assign('/login'); } }}>Enable</button></>}</div></div>;
}
