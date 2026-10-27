// Course catalogue import: parse -> validate -> reconcile -> (dry-run | apply). Idempotent and non-destructive (never deletes).
import { j } from '../db/index.js';
import { normTitle, slugify } from './util.js';
import { bad } from './errors.js';
import { audit } from './audit.js';

const REQUIRED = ['title', 'description', 'category', 'level'];
const LEVELS = new Set(['beginner', 'intermediate', 'advanced', 'all levels']);

export function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((x) => x.trim()));
  if (!head) return [];
  const keys = head.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

// Accepts an array of records or {courses:[...]} (the shape of a JSON export) and maps common field aliases.
export function normalizeRecords(raw) {
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.courses) ? raw.courses : null;
  if (!arr) throw bad('Expected a JSON array of courses (or {"courses":[...]}).');
  return arr.map((r, i) => {
    const title = String(r.title ?? r.name ?? r.course_title ?? '').trim();
    const level = String(r.level ?? r.course_level ?? '').trim();
    return {
      row: i + 1, title, norm: normTitle(title),
      code: (r.code ?? r.course_code ?? '').toString().trim() || null,
      description: String(r.description ?? r.summary ?? '').trim() || null,
      category: String(r.category ?? r.track ?? '').trim() || null,
      level: level || null,
      instructor_name: String(r.instructor ?? r.instructor_name ?? '').trim() || null,
      source_ref: (r.id ?? r.source_ref ?? r.slug ?? '').toString().trim() || null,
      verified: r.verified === true || r.verified === 'true'
    };
  });
}

const bigrams = (s) => { const a = new Set(); for (let i = 0; i < s.length - 1; i++) a.add(s.slice(i, i + 2)); return a; };
export const similarity = (a, b) => { if (!a || !b) return 0; if (a === b) return 1; const x = bigrams(a), y = bigrams(b); let n = 0; for (const g of x) if (y.has(g)) n++; return (2 * n) / (x.size + y.size || 1); };

export const missingFields = (r) => REQUIRED.filter((f) => !r[f]);

// existing: rows from courses. Returns the reconciliation report (pure; no writes).
export function reconcile(existing, incoming, { source }) {
  const report = { discovered: incoming.length, matched: [], to_add: [], duplicates_in_input: [], possible_duplicates: [], invalid: [], incomplete: [], needs_confirmation: [] };
  const byRef = new Map(existing.filter((c) => c.source === source && c.source_ref).map((c) => [c.source_ref, c]));
  const byCode = new Map(existing.filter((c) => c.code).map((c) => [c.code.toLowerCase(), c]));
  const byNorm = new Map(existing.map((c) => [c.norm_title, c]));
  const seen = new Map();
  for (const r of incoming) {
    if (!r.title) { report.invalid.push({ row: r.row, reason: 'Missing title' }); continue; }
    if (r.level && !LEVELS.has(r.level.toLowerCase())) report.invalid.push({ row: r.row, title: r.title, reason: `Unrecognised level "${r.level}" (kept as provided)`, warning: true });
    const dupKey = r.source_ref ? `ref:${r.source_ref}` : `t:${r.norm}`;
    if (seen.has(dupKey) || seen.has(`t:${r.norm}`)) { report.duplicates_in_input.push({ row: r.row, title: r.title, duplicate_of_row: (seen.get(dupKey) || seen.get(`t:${r.norm}`)).row }); continue; }
    seen.set(dupKey, r); seen.set(`t:${r.norm}`, r);
    const miss = missingFields(r);
    if (miss.length) report.incomplete.push({ row: r.row, title: r.title, missing: miss });
    if (!r.verified) report.needs_confirmation.push({ row: r.row, title: r.title });
    const hit = (r.source_ref && byRef.get(r.source_ref)) || (r.code && byCode.get(r.code.toLowerCase())) || byNorm.get(r.norm);
    if (hit) { report.matched.push({ row: r.row, title: r.title, course_id: hit.id, by: r.source_ref && byRef.get(r.source_ref) ? 'source_ref' : r.code && byCode.get(r.code.toLowerCase()) ? 'code' : 'title', record: r }); continue; }
    const near = existing.map((c) => ({ c, s: similarity(r.norm, c.norm_title) })).filter((x) => x.s >= 0.85).sort((a, b) => b.s - a.s)[0];
    if (near) { report.possible_duplicates.push({ row: r.row, title: r.title, similar_to: { id: near.c.id, title: near.c.title }, similarity: Math.round(near.s * 100) / 100 }); continue; }   // never auto-created: needs a human decision
    report.to_add.push({ row: r.row, title: r.title, record: r });
  }
  return report;
}

export async function runSync(ctx, actor, { records, source, dryRun, confirmCreate = [] }, req) {
  const existing = (await ctx.db.query('select id, code, title, norm_title, source, source_ref from courses')).rows;
  const report = reconcile(existing, records, { source });
  const confirm = new Set(confirmCreate.map(Number));
  const toCreate = [...report.to_add.map((x) => x.record), ...report.possible_duplicates.filter((d) => confirm.has(d.row)).map((d) => records.find((r) => r.row === d.row))];
  const summary = { discovered: report.discovered, matched: report.matched.length, created: 0, updated: 0, skipped_duplicates: report.duplicates_in_input.length, possible_duplicates: report.possible_duplicates.length - confirm.size, invalid: report.invalid.filter((x) => !x.warning).length, incomplete: report.incomplete.length, needs_confirmation: report.needs_confirmation.length };
  let outcome = 'ok';
  if (!dryRun) {
    await ctx.db.tx(async (q) => {
      const now = ctx.now();
      const importStatus = (r) => (!r.verified ? 'needs_confirmation' : missingFields(r).length ? 'imported_incomplete' : 'imported_verified');
      for (const r of toCreate) {
        let slug = slugify(r.title) || 'course', n = 1;
        while ((await q.query('select 1 from courses where slug=$1', [slug])).rowCount) slug = `${slugify(r.title)}-${++n}`;
        await q.query(`insert into courses(code,title,slug,norm_title,description,category,level,instructor_name,source,source_ref,verified,import_status,missing_fields,last_synced_at,created_at,updated_at)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$14,$14)`,
          [r.code, r.title, slug, r.norm, r.description, r.category, r.level, r.instructor_name, source, r.source_ref, r.verified, importStatus(r), j(missingFields(r)), now]);
        summary.created++;
      }
      // Existing courses: only FILL gaps or refresh verified metadata; never blank out fields, never touch enrolments/assessments.
      for (const m of report.matched) {
        const c = (await q.query('select * from courses where id=$1 for update', [m.course_id])).rows[0];
        const r = m.record;
        const next = { description: c.description || r.description, category: c.category || r.category, level: c.level || r.level, instructor_name: c.instructor_name || r.instructor_name, code: c.code || r.code };
        if (r.verified) Object.assign(next, { description: r.description || next.description, category: r.category || next.category, level: r.level || next.level, instructor_name: r.instructor_name || next.instructor_name });
        const verified = c.verified || r.verified;
        const merged = { ...next, title: c.title, verified };
        const status = !verified ? 'needs_confirmation' : missingFields(merged).length ? 'imported_incomplete' : 'imported_verified';
        const changed = ['description', 'category', 'level', 'instructor_name', 'code'].some((k) => next[k] !== c[k]) || verified !== c.verified || status !== c.import_status;
        await q.query(`update courses set description=$2, category=$3, level=$4, instructor_name=$5, code=$6, verified=$7, import_status=$8, missing_fields=$9::jsonb, last_synced_at=$10, updated_at=$10,
          source_ref = coalesce(source_ref, $11), source = case when source_ref is null and $11 is not null then $12 else source end where id=$1`,
          [c.id, next.description, next.category, next.level, next.instructor_name, next.code, verified, status, j(missingFields(merged)), now, r.source_ref, source]);
        if (changed) summary.updated++;
      }
      if (summary.invalid) outcome = 'partial';
      await q.query('insert into catalogue_syncs(mode,source,outcome,summary,report,started_by,created_at) values($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)', ['apply', source, outcome, j(summary), j({ ...report, matched: report.matched.map(({ record, ...x }) => x), to_add: report.to_add.map(({ record, ...x }) => x) }), actor?.id || null, now]);
      await audit(q, ctx, { actor, action: 'catalogue.sync', entity: 'catalogue', meta: { source, ...summary, actor_label: actor ? undefined : 'cli' }, req });
    });
  } else {
    await ctx.db.query('insert into catalogue_syncs(mode,source,outcome,summary,report,started_by,created_at) values($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)', ['dry_run', source, 'ok', j(summary), j({ ...report, matched: report.matched.map(({ record, ...x }) => x), to_add: report.to_add.map(({ record, ...x }) => x) }), actor?.id || null, ctx.now()]);
  }
  return { dry_run: !!dryRun, outcome, summary, report: { ...report, matched: report.matched.map(({ record, ...x }) => x), to_add: report.to_add.map(({ record, ...x }) => x) } };
}

// Optional: read the live site's Supabase `courses` table (the site uses Supabase). Needs SUPABASE_URL + a READ-ONLY anon key.
// Column names are unknown to this repo, so mapping goes through normalizeRecords' aliases. NOT verified against the live project.
export async function fetchSupabaseCourses({ url, anonKey, table = 'courses' }) {
  const r = await fetch(`${url}/rest/v1/${table}?select=*`, { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } });
  if (!r.ok) throw new Error(`Supabase returned HTTP ${r.status}`);
  return (await r.json()).map((x) => ({ ...x, verified: true }));
}
