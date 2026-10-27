import { describe, it, expect, beforeAll } from 'vitest';
import { makeWorld } from './helpers.js';
import { reconcile, normalizeRecords, similarity } from '../lib/catalogue.js';

let w, admin;
beforeAll(async () => { w = await makeWorld(); admin = await w.login('admin'); });
const data = () => [
  { id: 'py', title: 'Python Programming', description: 'Learn Python', category: 'Programming', level: 'Beginner' },
  { id: 'da', title: 'Data Analytics', description: 'Excel and Power BI', category: 'Data', level: 'Intermediate' },
  { id: 'nt', title: 'Networking Essentials' }                              // incomplete metadata
];
const sync = (body) => admin.post('/api/catalogue/sync', { source: 'test-catalogue', ...body });

describe('catalogue import', () => {
  it('dry run reports but writes nothing', async () => {
    const r = await sync({ data: data(), dry_run: true, verified: true });
    expect(r.status).toBe(200); expect(r.body.report.to_add).toHaveLength(3); expect(r.body.report.incomplete.map((x) => x.title)).toEqual(['Networking Essentials']);
    expect((await admin.get('/api/courses')).body.total).toBe(0);
  });
  it('apply creates courses with the right import status and a readiness state', async () => {
    const r = await sync({ data: data(), dry_run: false, verified: true });
    expect(r.body.summary).toMatchObject({ created: 3, discovered: 3 });
    const rows = (await admin.get('/api/courses')).body.rows; const by = Object.fromEntries(rows.map((x) => [x.title, x]));
    expect(by['Python Programming'].import_status).toBe('imported_verified'); expect(by['Networking Essentials'].import_status).toBe('imported_incomplete');
    expect(by['Python Programming'].readiness).toBe('awaiting_offering');
  });
  it('is idempotent: repeating the import creates no duplicates and keeps enrolments/assessments', async () => {
    const c = (await admin.get('/api/courses?q=python')).body.rows[0];
    const off = (await admin.post('/api/offerings', { course_id: c.id })).body;
    await admin.post(`/api/offerings/${off.id}/enrolments`, { student_ids: [w.users.s1.id] });
    const again = await sync({ data: data(), dry_run: false, verified: true });
    expect(again.body.summary.created).toBe(0); expect(again.body.summary.matched).toBe(3);
    expect((await admin.get('/api/courses')).body.total).toBe(3);
    expect((await admin.get(`/api/courses/${c.id}/roster`)).body.rows).toHaveLength(1);
  });
  it('never deletes courses missing from a later (partial) response, and fills gaps without blanking data', async () => {
    const r = await sync({ data: [{ id: 'nt', title: 'Networking Essentials', description: 'Cisco basics', category: 'Networking', level: 'Beginner' }], dry_run: false, verified: true });
    expect(r.body.summary.updated).toBe(1);
    const rows = (await admin.get('/api/courses')).body.rows; expect(rows).toHaveLength(3);
    expect(rows.find((x) => x.title === 'Networking Essentials').import_status).toBe('imported_verified');
    await sync({ data: [{ id: 'py', title: 'Python Programming' }], dry_run: false, verified: true });
    const py = (await admin.get(`/api/courses/${rows.find((x) => x.title === 'Python Programming').id}`)).body; expect(py.description).toBe('Learn Python');
  });
  it('flags duplicates inside the file, near-duplicates, and bad rows; near-duplicates need explicit confirmation', async () => {
    const r = await sync({ data: [{ title: 'Python Programing' }, { title: 'Data Analytics' }, { title: 'Data Analytics' }, { description: 'no title' }, { title: 'Cyber Security', description: 'd', category: 'c', level: 'Beginner' }], dry_run: false, verified: true });
    expect(r.body.report.possible_duplicates[0]).toMatchObject({ title: 'Python Programing', similar_to: { title: 'Python Programming' } });
    expect(r.body.report.duplicates_in_input).toHaveLength(1); expect(r.body.report.invalid.some((x) => x.reason === 'Missing title')).toBe(true);
    expect(r.body.summary.created).toBe(1); expect((await admin.get('/api/courses')).body.total).toBe(4);
    const forced = await sync({ data: [{ title: 'Python Programing' }], dry_run: false, verified: true, confirm_create: [1] });
    expect(forced.body.summary.created).toBe(1);
  });
  it('unverified imports are marked as needing confirmation', async () => {
    const r = await sync({ data: [{ title: 'Mystery Course', description: 'd', category: 'c', level: 'Beginner' }], dry_run: false, verified: false });
    expect(r.body.report.needs_confirmation).toHaveLength(1);
    expect((await admin.get('/api/courses?q=mystery')).body.rows[0].import_status).toBe('needs_confirmation');
  });
  it('CSV format and sync history', async () => {
    const r = await sync({ format: 'csv', csv: 'Title,Description,Category,Level\n"Web, Basics","HTML & CSS",Web,Beginner\n', dry_run: false, verified: true });
    expect(r.body.summary.created).toBe(1); expect((await admin.get('/api/catalogue/syncs')).body.rows.length).toBeGreaterThan(5);
  });
  it('similarity helper sanity', () => { expect(similarity('python programming', 'python programing')).toBeGreaterThan(0.9); expect(similarity('python', 'java')).toBeLessThan(0.4); });
});
