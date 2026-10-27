# Deployment: GitHub → Vercel (+ Supabase integration)

Status: written from the code and verified pieces (PostgreSQL 16 via `pg`, concurrent cold-start migration, derived configuration, bootstrap admin). **Not yet run on a real Vercel/Supabase account** — treat the first deploy as a staging run.

## Steps
1. **GitHub:** push this repo.
2. **Vercel:** *Add New → Project →* import the repo (framework Vite is auto-detected; `vercel.json` already routes `/api/*`). Deploy once.
3. **Supabase:** in the Vercel project open **Storage → Create / Connect → Supabase** and create a **new** project (not the one behind your marketing site). Vercel adds variables to the project automatically. **Check Settings → Environment Variables:** you need a Postgres connection string (`POSTGRES_URL`) and `SUPABASE_URL` + `SUPABASE_SECRET_KEY`. If `POSTGRES_URL` is missing, add it yourself: Supabase → *Connect* → *Transaction pooler* → copy the URI and replace `[YOUR-PASSWORD]` with your database password (Project Settings → Database → reset password if unknown).
4. **Private file bucket:** Supabase dashboard → Storage → *New bucket* → name `kellastech-private` → **leave "Public" OFF**.
5. **First admin:** Vercel → Settings → Environment Variables → add `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` (12+ chars, letter + number, must not contain the email's name). **Redeploy** (Deployments → ⋯ → Redeploy) so the new variables apply.
6. Open the site, **sign in** with that email/password, enable MFA (Profile prompt / `REQUIRE_MFA_FOR_PRIVILEGED=true`), then **delete `BOOTSTRAP_ADMIN_PASSWORD`** from Vercel.

On the first request the app applies the database migrations itself (guarded by a Postgres lock so simultaneous cold starts are safe), seeds roles/permissions/categories, and creates your admin if no super administrator exists. If something is missing, the API returns "Service is not ready" and the Vercel function log names the missing setting.

## Database setup alternatives
* Automatic (default): the first request creates all tables and turns on row-level security.
* Manual: paste `supabase/setup.sql` into the Supabase SQL editor and run it once; the app then skips those migrations.

## (Now automatic) Lock down the database
Migration `002_row_level_security.sql` does this for you; the snippet below is kept for reference.
The API talks to Postgres directly and does its own authorisation. In the Supabase SQL editor, enable row-level security on every table so the public Supabase API (anon key) cannot read student data:
```sql
do $$ declare t record; begin
  for t in select tablename from pg_tables where schemaname='public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop; end $$;
```
(With no policies defined, the anon/authenticated API roles get no access; the server's database role is unaffected.) Verified on local PostgreSQL only, not on Supabase.

## Custom domain / preview deployments
* Custom domain: add `APP_ORIGIN=https://your.domain` (the vercel.app URLs stay allowed).
* **Previews:** deployments from other branches use the same database unless you enable Supabase branching. Do not test with real student data on previews.

## Cron (optional)
`vercel.json` schedules a daily sweep. It only works if you set `CRON_SECRET` (random 32+ chars); without it the endpoint stays disabled. Correctness does not depend on it: overdue attempts are finalised when anyone opens the assessment. On Vercel Pro you may change the schedule to every minute.

## Operations
* **Backups:** Supabase backups (paid plans) plus your own `pg_dump "$POSTGRES_URL_NON_POOLING" -Fc -f kt-$(date +%F).dump`; back up the storage bucket too. **Restore:** empty database → `pg_restore --no-owner -d <url> file.dump` → set the URL → redeploy. Rehearse once.
* **Health:** Admin → System health. **Email:** without `RESEND_API_KEY`, use Users → "Reset / invite link".
* **Manual commands** (optional): `npm run migrate`, `npm run admin:create`, `npm run catalogue:import` read `DATABASE_URL`; use `node --env-file=.env.local scripts/<name>.js` with the non-pooled URL.
* Before term: rehearsal exam with ~30 test students on staging.
