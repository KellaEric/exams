# Phase 1–2: Audit and architecture

## Audit of the uploaded project (`kellastech-lab-portal.zip`)
* Vite 5 + React 18 single-page app, deployed to Vercel (static). ~20 files, 12 unit tests (all passing before changes).
* **No backend or database.** Accounts, sessions, questions, grading and results were in `localStorage`.
* Grading was static source-pattern checking of Python (regex over code with strings/comments stripped); code was never executed. Five questions, 40 marks, letter-grade scale A+…F.
* **Findings that blocked the new requirements:** admin password in README and its SHA-256 hash in client code; test patterns and answers shipped to every browser; results editable by the user; no roles, enrolment, timers, audit trail or release control.
* **Preserved:** React/Vite/Vercel stack, branding (indigo/purple), the 5 questions and their scoring rules (ported to declarative server-side checks with parity tests), the grade scale, CSV formula-injection guard, `logo.png`.
* **Removed:** the browser-only auth/storage/grader modules and their tests (superseded by the server and its tests). Old browser data cannot be migrated automatically; export CSVs from the old *Records* screen first if you need history.

## Architecture
```
Browser (React SPA) ──HTTPS──> Vercel: /api/* -> api/index.js -> Express (server/app.js)
                                        │                       ├─ routes/*  (auth, admin, courses, questions, assessments, exam, grading, reports, files, misc)
                                        │                       └─ lib/*     (exam engine, grading, state machine, catalogue, storage…)
                                        ├─ PostgreSQL (Supabase)  <- pg pool; migrations in server/db/migrations
                                        └─ Private file bucket    <- signed 5-minute links
Vercel Cron -> /api/internal/sweep (Bearer CRON_SECRET): finalises overdue attempts, advances assessment lifecycles
```
**Hierarchy:** institution (system_config) → departments → programmes → courses → course_offerings (course × term × cohort) → enrolments → assessments → assessment_questions (frozen snapshots) → attempts → answers → answer_grades → released results. One course record serves many offerings.

**Assessments are one engine.** Weekly tests, quizzes, exams, assignments, practicals and projects are `assessment_categories` rows (configurable: enabled, needs-approval, timed). Assignments are untimed assessments whose deadline is `closes_at` with file-upload/essay questions; "submissions" are submitted attempts.

**Lifecycle** (enforced in `server/lib/assessmentState.js`): draft → pending_review → approved → scheduled → published → in_progress → closed → graded → results_released → archived. Time-driven moves (scheduled→published, →closed, →graded, scheduled release) run lazily on access and from the cron sweeper. Content freezes at review; question snapshots (with keys) are stored at approval so later bank edits never change a live paper.

**Examination engine guarantees**
* Deadline = `min(server start + duration + accommodation, closing time)`, stored in the DB. The browser only displays `deadline_at − server_now` (monotonic clock, re-synced on every autosave); client-sent times are ignored.
* One live attempt per student per assessment: partial unique index + per-student row lock; repeated/concurrent starts return the same attempt (tested with 5 parallel requests on both PGlite and PostgreSQL 16).
* Autosave with per-question sequence numbers (out-of-order saves cannot overwrite newer answers); 10 s server-side grace for the last in-flight save.
* Submission is idempotent (same receipt on repeat); expiry auto-submits saved answers (lazily on access and via sweeper); finalised attempts cannot be edited. Reopen / extra time are admin-only, reasoned and audited.
* Grading runs server-side inside the submit transaction; subjective answers stay `pending_manual` until a person grades them.

## Roles
`super_admin`, `admin` (exam officer), `instructor`, `teaching_assistant`, `student`. Permissions live in `role_permissions` (editable by a super admin). Staff scope is checked per course/offering assignment; unrelated courses return 404.
Defaults of note: instructors can author/approve questions and publish non-restricted assessments; restricted categories (mid-sem, final, practical lab, oral) need an admin approval (different person); only admins release results, extend time and reopen attempts.
