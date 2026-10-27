# Course import and reconciliation report

## Result of the catalogue audit
| Item | Finding |
|---|---|
| Source inspected | https://kellastech.vercel.app/courses |
| What was retrievable | Only the HTML shell (title/meta). The course list is rendered client-side from the site's backend (the site uses Supabase), so **no course titles, descriptions, levels or instructors could be read** from the build environment. Web search also returned nothing from the site. |
| Courses discovered / verified | **0 verified** |
| Existing courses in the supplied project | None (the Lab Portal had a single hard-coded exam, "Python Laboratory Exam") |
| Duplicates / conflicts | None possible yet |
| Manual confirmation needed | Everything. `data/catalogue.candidates.json` lists 8 *unverified* programme titles you can compare against the live site; importing it without `--verified` marks them **needs confirmation** |

No course, instructor, code or enrolment was invented, and the portal contains no pre-loaded courses.

## How to import the real catalogue (three ways)
1. **File:** export or copy the catalogue into `data/catalogue.json` (shape in `data/catalogue.template.json`: `id`, `title`, `description`, `category`, `level`, optional `code`, `instructor`). `npm run catalogue:import -- --file data/catalogue.json --verified` (dry run) then `--apply`. CSV is also accepted (`title,description,category,level,code,id`).
2. **Admin UI:** Catalogue & courses → Catalogue import → paste JSON/CSV → *Dry run* → *Apply*.
3. **Direct from the site's Supabase (untested):** set `SUPABASE_URL` + a read-only `SUPABASE_ANON_KEY` (and `SUPABASE_COURSES_TABLE` if not `courses`), then use `--supabase` or the UI source option. Column names are mapped by common aliases (`title|name|course_title`, `description|summary`, `category|track`, `level|course_level`, `id|slug`); adjust `normalizeRecords` in `server/lib/catalogue.js` if the real columns differ. The table's RLS must allow anon reads.

## Rules the importer follows
Match by catalogue id → course code → normalised title; near-duplicates (≥ 85 % similar) are **reported, never auto-created** (tick them in the UI to confirm); repeated imports create nothing new (tested); only gaps are filled, existing text is never blanked; **nothing is ever deleted**; enrolments/assessments are untouched; every run is stored in *Sync history*; dry-run is the default in the CLI.
Course statuses: *imported verified* / *imported incomplete* / *needs confirmation*, plus readiness: *awaiting offering → awaiting instructor → awaiting question bank → ready*.
