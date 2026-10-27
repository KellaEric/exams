# KellasTech Examination Portal

Secure examination and assessment platform for KellasTech: courses → offerings → enrolments → assessments → questions → timed attempts → grades → released results.
It extends the original browser-only *Lab Portal* (Python Laboratory Exam), whose exam content and grading rules are preserved (see `data/legacy-python-lab-questions.json`).

**Status (honest summary):** built and tested locally; **not deployed**. See `docs/TEST-REPORT.md` for exactly what was run, and `docs/KNOWN-LIMITATIONS.md` for what is not done or not verified.

## What changed from the original project
The original app kept accounts, answers, hidden test patterns, grading and results in the browser (localStorage), so anyone could read or alter them, and its README published the administrator password. That design cannot meet the security requirements, so the grading and storage moved to a server:

| Layer | Stack |
|---|---|
| Frontend | React 18 + Vite + React Router (same stack and branding as before) |
| API | Node 20+/Express (`server/`), deployed on Vercel as one function (`api/index.js`) or stand-alone (`npm start`) |
| Database | PostgreSQL (Supabase in production). Embedded PGlite (real Postgres in WASM) for local dev and tests |
| Files | Private storage (Supabase Storage bucket, or local disk off-Vercel) + signed, expiring, user-bound links |

> **Security notice:** the old README contained a real admin password, and its hash lived in the shipped JavaScript. Treat that password as compromised everywhere it was ever used, and purge it from git history if the repo was ever pushed. This version has no default accounts.

## Quick start (local, no database needed)
```bash
npm install
cp .env.example .env        # optional for local dev
npm run seed:dev            # DEV ONLY demo users; prints a random password once
npm run dev                 # API :3001 + web :5173
npm test                    # 76 tests (API on embedded Postgres + UI integration)
```
Real PostgreSQL: set `DATABASE_URL`, run `npm run migrate`. To run the API tests on a real server: `TEST_DATABASE_URL=postgresql://user:pw@localhost/postgres npm run test:api`.

## First administrator (production)
There is no default account. Set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` in Vercel's environment variables; the first start creates that super administrator (only while none exists). Sign in, enable MFA, then delete the password variable. Alternative: `npm run admin:create`. See `docs/DEPLOYMENT.md`.

## Load the courses
`npm run catalogue:import -- --file data/catalogue.json --verified` (dry run) → add `--apply`. See `docs/COURSE-IMPORT.md`: the live catalogue could not be read from the build environment, so **no courses are pre-loaded as verified**.

## Load the original Python Lab Exam
`npm run seed:legacy-python -- --course "Python Programming" --by instructor@example.com` creates the 5 approved questions (40 marks) and a draft assessment.

## Documents
`docs/AUDIT-AND-ARCHITECTURE.md` · `docs/DEPLOYMENT.md` · `docs/USER-GUIDES.md` · `docs/SECURITY.md` · `docs/COURSE-IMPORT.md` · `docs/TROUBLESHOOTING.md` · `docs/KNOWN-LIMITATIONS.md` · `docs/TEST-REPORT.md`
