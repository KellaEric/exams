// Imports/reconciles the official course catalogue.
//   npm run catalogue:import -- --file data/catalogue.json --source official-catalogue --verified --dry-run
//   npm run catalogue:import -- --supabase --verified          (reads SUPABASE_URL + SUPABASE_ANON_KEY; see docs)
// Default is a DRY RUN. Add --apply to write. Nothing is ever deleted.
import fs from 'node:fs';
import { boot, arg } from './_boot.js';
import { parseCsv, normalizeRecords, runSync, fetchSupabaseCourses } from '../server/lib/catalogue.js';

const apply = process.argv.includes('--apply'), verified = process.argv.includes('--verified'), source = arg('source', 'official-catalogue');
let raw;
if (process.argv.includes('--supabase')) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) { console.error('Set SUPABASE_URL and SUPABASE_ANON_KEY.'); process.exit(1); }
  raw = await fetchSupabaseCourses({ url: process.env.SUPABASE_URL, anonKey: process.env.SUPABASE_ANON_KEY, table: process.env.SUPABASE_COURSES_TABLE || 'courses' });
} else {
  const file = arg('file'); if (!file || file === true) { console.error('Provide --file <json|csv> or --supabase'); process.exit(1); }
  const text = fs.readFileSync(file, 'utf8'); raw = file.endsWith('.csv') ? parseCsv(text) : JSON.parse(text);
}
const records = normalizeRecords(raw).map((r) => ({ ...r, verified: verified || r.verified }));
const { ctx } = await boot();
const out = await runSync(ctx, null, { records, source, dryRun: !apply });
console.log(JSON.stringify({ mode: apply ? 'APPLIED' : 'DRY RUN', summary: out.summary, to_add: out.report.to_add.map((x) => x.title), possible_duplicates: out.report.possible_duplicates, incomplete: out.report.incomplete, invalid: out.report.invalid, needs_confirmation: out.report.needs_confirmation.length }, null, 2));
if (!apply) console.log('\nDry run only. Re-run with --apply to write.');
await ctx.db.close();
