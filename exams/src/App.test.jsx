// UI integration test: the real React app talking to the real Express API (embedded Postgres), no mocks of business logic.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import request from 'supertest';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import App from './App.jsx';
import { AuthProvider } from './auth.jsx';
import { UiProvider } from './ui.jsx';
import { setCsrf } from './api.js';
import { makeWorld, setupCourse, approvedQuestion, mcq, PW } from '../server/test/helpers.js';

let w, agent, ids, quiz;
function installFetch() {
  agent = request.agent(w.app);
  globalThis.fetch = async (url, opts = {}) => {
    const m = (opts.method || 'GET').toLowerCase(); let r = agent[m === 'delete' ? 'delete' : m](url);
    for (const [k, v] of Object.entries(opts.headers || {})) r = r.set(k, v);
    if (opts.body) r = r.send(JSON.parse(opts.body));
    const res = await r;
    return { ok: res.status < 400, status: res.status, headers: { get: (h) => res.headers[h.toLowerCase()] || null }, json: async () => res.body, text: async () => res.text };
  };
}
const mount = (path = '/') => render(<MemoryRouter initialEntries={[path]}><UiProvider><AuthProvider><App /></AuthProvider></UiProvider></MemoryRouter>);

beforeAll(async () => {
  // PGlite's loader needs Node's Blob (jsdom's lacks arrayBuffer); swap it only while the embedded database boots.
  const saved = { Blob: globalThis.Blob, File: globalThis.File }; globalThis.Blob = NodeBlob; globalThis.File = NodeFile;
  try { w = await makeWorld(); } finally { Object.assign(globalThis, saved); }
  ids = await setupCourse(w, { enrol: ['s1'] });
  const inst = await w.login('inst');
  const q1 = await approvedQuestion(inst, ids.courseId, mcq('What is 2 + 2?', 2)); const q2 = await approvedQuestion(inst, ids.courseId, { type: 'true_false', stem: 'The sky is green', marks: 1, correct: false });
  quiz = (await inst.post(`/api/courses/${ids.courseId}/assessments`, { category_key: 'quiz', title: 'UI Quiz', duration_minutes: 20, opens_at: w.iso(-60), closes_at: w.iso(86400), questions: [{ question_id: q1.id }, { question_id: q2.id }] })).body;
  await inst.post(`/api/assessments/${quiz.id}/actions/publish`, {});
});
afterEach(() => { cleanup(); setCsrf(null); });

describe('browser UI against the real API', () => {
  it('rejects bad credentials with a clear message, then a student signs in and sees only their assessment', async () => {
    installFetch(); const user = userEvent.setup(); mount('/');
    await screen.findByRole('heading', { name: /Examination Portal/i });
    await user.type(screen.getByLabelText(/^Email/), w.users.s1.email); await user.type(screen.getByLabelText(/^Password/), 'wrong-password-1'); await user.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/incorrect/i);
    await user.clear(screen.getByLabelText(/^Password/)); await user.type(screen.getByLabelText(/^Password/), PW); await user.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByText(/Welcome, Stu/)).toBeInTheDocument();
    expect(await screen.findByText('UI Quiz')).toBeInTheDocument();
    expect(screen.queryByText(/Users & roles/)).not.toBeInTheDocument();             // no admin navigation for students
  });
  it('student starts the exam, answers autosave to the server, a reload restores them, and submitting gives a receipt', async () => {
    installFetch(); const user = userEvent.setup();
    const login = await agent.post('/api/auth/login').send({ email: w.users.s1.email, password: PW }); setCsrf(login.body.csrf);
    mount(`/assessments/${quiz.id}`);
    await user.click(await screen.findByRole('button', { name: /start now/i }));
    expect(await screen.findByRole('timer')).toBeInTheDocument();
    expect(screen.queryByText(/is_correct/)).not.toBeInTheDocument();
    const radios = await screen.findAllByRole('radio'); await user.click(screen.getByLabelText('4'));
    await waitFor(async () => { const at = await w.db.one("select id from attempts where status='in_progress'"); const n = await w.db.one('select count(*)::int as n from answers where attempt_id=$1', [at.id]); expect(n.n).toBe(1); }, { timeout: 4000 });
    const attemptId = (await w.db.one("select id from attempts where status='in_progress'")).id;
    cleanup(); setCsrf(login.body.csrf); mount(`/exam/${attemptId}`);                       // "refresh"
    await screen.findByRole('timer'); expect(await screen.findByLabelText('4')).toBeChecked();
    await user.click(screen.getByRole('button', { name: /review & submit/i })); await user.click(await screen.findByRole('button', { name: /submit final answers/i }));
    await waitFor(async () => expect((await w.db.one('select status, receipt_code from attempts where id=$1', [attemptId])).status).toBe('submitted'), { timeout: 4000 });
    expect((await w.db.one('select score from attempts where id=$1', [attemptId])).score).toBe(2);
  });
  it('a student cannot open staff screens (server refuses; UI redirects home)', async () => {
    installFetch(); const login = await agent.post('/api/auth/login').send({ email: w.users.s1.email, password: PW }); setCsrf(login.body.csrf);
    mount('/admin/users'); expect(await screen.findByText(/Welcome, Stu/)).toBeInTheDocument();
    expect((await agent.get('/api/users')).status).toBe(403);
  });
  it('an administrator sees the admin dashboard with real counts', async () => {
    installFetch(); const login = await agent.post('/api/auth/login').send({ email: w.users.admin.email, password: PW }); setCsrf(login.body.csrf);
    mount('/'); expect(await screen.findByRole('heading', { name: 'Administration' })).toBeInTheDocument();
    const card = (await screen.findByText('Active students')).closest('.stat'); expect(within(card).getByText('3')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Users & roles' })).toBeInTheDocument();
  });
});
