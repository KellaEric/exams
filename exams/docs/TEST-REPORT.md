# Test report

Executed on 2026-10-27 in the build sandbox (Node 22, PostgreSQL 16.13 server, embedded PGlite). Results below are the actual outputs of `npx vitest run`.

| Run | Database | Result |
|---|---|---|
| `npm test` (API + UI) | PGlite (embedded Postgres) | **7 files, 76 tests passed, 0 failed** |
| `TEST_DATABASE_URL=… npm run test:api` | **PostgreSQL 16 via the production `pg` driver** (fresh database per suite, pooled connections) | **6 files, 72 tests passed, 0 failed** |

Also executed manually and confirmed: **8 simultaneous cold starts on an empty PostgreSQL database** (migrations, seeding and admin bootstrap race-free after two bugs found by this test were fixed); `npm run migrate`, `admin:create` (incl. rejecting a short password), `seed:dev` (refuses `NODE_ENV=production`), `catalogue:import` dry-run and apply, `seed:legacy-python`; boot with `AUTO_MIGRATE=false` refusing an unmigrated DB then succeeding after migrate (on PostgreSQL); `npm run build`; stand-alone server serving the SPA with security headers.

## Coverage by requirement area (test names are the evidence)
* **Authentication** (`auth.test.js`): valid/invalid login, identical errors, throttling and recovery, CSRF, suspension revoking live sessions, idle expiry, password reset (single-use, revokes old password, no enumeration), self-registration approval, MFA.
* **RBAC / security** (`auth.test.js`, `exam.test.js`): students blocked from staff/admin routes, instructors/admins limited, role-permission edits applying immediately, cross-course isolation (students and staff), other students' attempts/answers/grading views, TA scope, SQL-injection strings, stored-XSS payload inertness, malformed/oversize payloads, upload validation + signed/expiring/user-bound links, CSV formula neutralisation, audit log content.
* **Courses** (`catalogue.test.js`): dry run writes nothing, apply, idempotent re-import preserving enrolments, no deletion, gap-filling without blanking, in-file duplicates, near-duplicates requiring confirmation, unverified marking, CSV, history.
* **Assessments** (`exam.test.js`): publication blockers (unapproved question, mark mismatch, no close time), invalid transitions, content freeze + snapshot isolation from later bank edits, restricted-category approval by a different person, scheduling→automatic opening, preview without keys.
* **Timer / submission** (`exam.test.js`): server deadline, refresh keeps deadline, second-tab resume, 5 concurrent starts → 1 attempt, client-sent times ignored, grace window then auto-submit at the deadline, sweeper, attempt limits + accommodation, extra time and reopen (reasoned + audited), out-of-order autosave, stored randomisation.
* **Grading** (`grading.test.js`, `exam.test.js`, `legacy.test.js`): all objective types, partial credit, negative marking only when enabled, numeric tolerances, blank answers, essay rubric, rounding, pass/fail, late penalty, grade-change history with reasons, rubric mismatch rejection.
* **Legacy parity:** the original five-question Python lab exam scores 40/40 on model solutions through the full server pipeline, with the same rules for comments/strings/alternative styles as the browser version.
* **UI** (`App.test.jsx`, real React app ↔ real API): failed then successful sign-in, student navigation, starting an exam, autosave reaching the database, reload restoring the saved answer, submit with receipt and grading, student redirected from admin routes, admin dashboard counts.
* **User-acceptance workflow** (`exam.test.js` "end-to-end"): the 17-step admin → instructor → student → grading → release → audit scenario passes (step 1's import is by catalogue sync).

* **Bootstrap/config** (`bootstrap.test.js`): admin created from environment variables only when no super admin exists, weak password/bad email refused, no default account, settings derived from Vercel + Supabase variables, clear error messages when nothing is connected.

## Not tested (see KNOWN-LIMITATIONS.md)
Real Supabase/Vercel/Resend, load/stress, browser matrix, formal accessibility audit, penetration test.

## Verbose list (PGlite run)
```
✓ server/test/exam.test.js > end-to-end: admin -> instructor -> student -> grading -> release > steps 1-6: course imported, offering/staff/enrolment set up, bank built, timed exam published
✓ server/test/exam.test.js > end-to-end: admin -> instructor -> student -> grading -> release > step 7: student sees it, starts it, and gets a server deadline; the payload contains no answer keys
✓ server/test/exam.test.js > end-to-end: admin -> instructor -> student -> grading -> release > steps 8-10: answers autosave; after a refresh they are restored and the timer continues from the original deadline
✓ server/test/exam.test.js > end-to-end: admin -> instructor -> student -> grading -> release > step 11-13: submit once; objective questions graded; essay queued for manual grading; result hidden 303ms
✓ server/test/exam.test.js > end-to-end: admin -> instructor -> student -> grading -> release > step 14: instructor grades the essay with the rubric and the attempt becomes graded
✓ server/test/exam.test.js > end-to-end: admin -> instructor -> student -> grading -> release > step 15: results stay private until an authorised person releases them (after the window closes and everything is graded) 363ms
✓ server/test/exam.test.js > end-to-end: admin -> instructor -> student -> grading -> release > step 16: student sees the released result with feedback but no answer key (feedback mode: marks_and_feedback)
✓ server/test/exam.test.js > end-to-end: admin -> instructor -> student -> grading -> release > step 17: the audit log records the key events
✓ server/test/exam.test.js > timed engine: server authority, concurrency, expiry > concurrent start requests create exactly one attempt 303ms
✓ server/test/exam.test.js > timed engine: server authority, concurrency, expiry > the client cannot choose or extend the deadline (time-like fields are ignored) 311ms
✓ server/test/exam.test.js > timed engine: server authority, concurrency, expiry > time expiry auto-submits saved answers; later saves are rejected; the deadline caps submitted_at 319ms
✓ server/test/exam.test.js > timed engine: server authority, concurrency, expiry > the sweeper finalises abandoned attempts without any student request 326ms
✓ server/test/exam.test.js > timed engine: server authority, concurrency, expiry > the cron endpoint requires its secret
✓ server/test/exam.test.js > timed engine: server authority, concurrency, expiry > attempt limits, then an approved accommodation grants extra time and an extra attempt 351ms
✓ server/test/exam.test.js > timed engine: server authority, concurrency, expiry > authorised extra time and reopen are explicit, reasoned, and audited 345ms
✓ server/test/exam.test.js > timed engine: server authority, concurrency, expiry > out-of-order autosaves cannot overwrite newer answers
✓ server/test/exam.test.js > timed engine: server authority, concurrency, expiry > randomisation is stored per attempt and survives refresh
✓ server/test/exam.test.js > assessment lifecycle and validation > blocks publication with missing keys, unapproved questions and total-mark mismatches
✓ server/test/exam.test.js > assessment lifecycle and validation > enforces valid state transitions and freezes content after review starts 316ms
✓ server/test/exam.test.js > assessment lifecycle and validation > restricted categories need a different person to approve; scheduling opens automatically 380ms
✓ server/test/exam.test.js > assessment lifecycle and validation > preview shows the whole paper to staff without an attempt and without keys
✓ server/test/exam.test.js > security: isolation and secrecy > students only see assessments for courses they are enrolled in 407ms
✓ server/test/exam.test.js > security: isolation and secrecy > a student can never read another student's attempt, answers or grading view; students cannot grade
✓ server/test/exam.test.js > security: isolation and secrecy > teaching assistants can grade assigned courses but cannot edit content; unassigned TAs see nothing 321ms
✓ server/test/exam.test.js > security: isolation and secrecy > treats injection attempts as data: SQL in filters is harmless, scripts are stored inert as JSON text
✓ server/test/exam.test.js > security: isolation and secrecy > rejects malformed answer payloads and oversize bodies
✓ server/test/exam.test.js > security: isolation and secrecy > uploads: content-checked, stored privately, link is signed + expiring + bound to the user, others cannot fetch it 450ms
✓ server/test/exam.test.js > security: isolation and secrecy > gradebook, reports and CSV export respect scope and neutralise spreadsheet formulas
✓ server/test/exam.test.js > security: isolation and secrecy > dashboards use real counts
✓ server/test/auth.test.js > authentication > logs in with valid credentials and sets an httpOnly session cookie
✓ server/test/auth.test.js > authentication > rejects wrong password and unknown users with the same message
✓ server/test/auth.test.js > authentication > throttles repeated failures, then recovers after the lock window 316ms
✓ server/test/auth.test.js > authentication > requires a session and a CSRF token for state changes
✓ server/test/auth.test.js > authentication > suspension revokes live sessions immediately and blocks new logins
✓ server/test/auth.test.js > authentication > sessions expire after the idle timeout
✓ server/test/auth.test.js > authentication > password reset: one-time token, old password stops working, sessions revoked
✓ server/test/auth.test.js > authentication > self-registration creates a pending account that cannot sign in until approved
✓ server/test/auth.test.js > authentication > MFA: required code after enabling
✓ server/test/auth.test.js > role-based access control (server-side) > students cannot reach staff or admin endpoints
✓ server/test/auth.test.js > role-based access control (server-side) > instructors cannot use admin powers; admins cannot change roles or create admins; only super admin can
✓ server/test/auth.test.js > role-based access control (server-side) > permission changes take effect on the next request
✓ server/test/auth.test.js > role-based access control (server-side) > writes audit events for authentication and admin actions
✓ server/test/grading.test.js > objective grading > mcq: right, wrong, blank, negative marking only when enabled
✓ server/test/grading.test.js > objective grading > multi-select: partial credit, wrong picks subtract, floor at 0, all-or-nothing option
✓ server/test/grading.test.js > objective grading > true/false, short answer normalisation, review queue
✓ server/test/grading.test.js > objective grading > numeric tolerance (absolute and percent) and non-numbers
✓ server/test/grading.test.js > objective grading > fill blank, matching, ordering partial marks
✓ server/test/grading.test.js > objective grading > essay/practical/file go to manual grading, but blank ones are final zero
✓ server/test/grading.test.js > objective grading > totals: rounding, pass mark, late penalty, awaiting manual
✓ server/test/grading.test.js > legacy Python lab exam parity (static pattern checks) > has the original 5 questions worth 40 marks, check points matching each question
✓ server/test/grading.test.js > legacy Python lab exam parity (static pattern checks) > model solutions score full marks
✓ server/test/grading.test.js > legacy Python lab exam parity (static pattern checks) > does not reward print(), comments or blank code (same as the browser version)
✓ server/test/grading.test.js > legacy Python lab exam parity (static pattern checks) > accepts alternative valid styles
✓ server/test/grading.test.js > question authoring validation > rejects bad mcq, mismatched rubric and unsafe regex checks
✓ server/test/grading.test.js > question authoring validation > matching/ordering lists do not leak the answer order
✓ server/test/grading.test.js > upload inspection > checks content, not just the extension
✓ server/test/catalogue.test.js > catalogue import > dry run reports but writes nothing
✓ server/test/catalogue.test.js > catalogue import > apply creates courses with the right import status and a readiness state
✓ server/test/catalogue.test.js > catalogue import > is idempotent: repeating the import creates no duplicates and keeps enrolments/assessments
✓ server/test/catalogue.test.js > catalogue import > never deletes courses missing from a later (partial) response, and fills gaps without blanking data
✓ server/test/catalogue.test.js > catalogue import > flags duplicates inside the file, near-duplicates, and bad rows; near-duplicates need explicit confirmation
✓ server/test/catalogue.test.js > catalogue import > unverified imports are marked as needing confirmation
✓ server/test/catalogue.test.js > catalogue import > CSV format and sync history
✓ server/test/catalogue.test.js > catalogue import > similarity helper sanity
✓ server/test/bootstrap.test.js > first-admin bootstrap from environment variables > creates a super administrator who can sign in, only when none exists, and never overwrites 4496ms
✓ server/test/bootstrap.test.js > first-admin bootstrap from environment variables > refuses a weak password or bad email and creates nothing 5638ms
✓ server/test/bootstrap.test.js > first-admin bootstrap from environment variables > does nothing without the variables (no default account exists) 2996ms
✓ server/test/bootstrap.test.js > configuration derived from Vercel + Supabase integration variables > needs no manual settings once Supabase is connected
✓ server/test/bootstrap.test.js > configuration derived from Vercel + Supabase integration variables > reports clear problems when nothing is connected, and a custom domain can be added
✓ server/test/bootstrap.test.js > configuration derived from Vercel + Supabase integration variables > accepts the new Supabase key names and any of the Postgres URL variables
✓ server/test/bootstrap.test.js > configuration derived from Vercel + Supabase integration variables > names exactly what is missing (setting names only) when the portal cannot start
✓ server/test/legacy.test.js > original Python Laboratory Exam on the new server pipeline > students get auto-graded server-side (unlimited attempts, scores hidden until release, code never executed) 5478ms
✓ src/App.test.jsx > browser UI against the real API > rejects bad credentials with a clear message, then a student signs in and sees only their assessment 770ms
✓ src/App.test.jsx > browser UI against the real API > student starts the exam, answers autosave to the server, a reload restores them, and submitting gives a receipt 1181ms
✓ src/App.test.jsx > browser UI against the real API > a student cannot open staff screens (server refuses; UI redirects home)
✓ src/App.test.jsx > browser UI against the real API > an administrator sees the admin dashboard with real counts
Test Files  7 passed (7)
Tests  76 passed (76)
```
