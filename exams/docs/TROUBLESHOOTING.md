# Troubleshooting
| Symptom | Likely cause / fix |
|---|---|
| API returns 503 "Service is not ready" | Config problem or pending migrations. Check Vercel function logs. Run `npm run migrate`. Production requires `DATABASE_URL`, `FILE_SIGNING_SECRET`, `CRON_SECRET`, `APP_ORIGIN`, `STORAGE_DRIVER=supabase`. |
| Every POST says "Missing or invalid CSRF token" | Page loaded before a deploy/login; reload. Also check `APP_ORIGIN` equals the exact site origin (scheme + host). |
| Users can't sign in after the site moves to a new domain | Update `APP_ORIGIN` and `PUBLIC_URL`. |
| "Too many attempts" | Throttle (5 failures/15 min per email). Wait, or an admin issues a reset link. |
| Student says the timer "reset" or exam vanished | It cannot reset; open the assessment page → *Resume*. If the deadline passed, the saved answers were auto-submitted (receipt on the page). Admin may reopen with a reason. |
| Overdue attempts show in System health | Sweeper not running. Check `CRON_SECRET` and Vercel Cron; lazy finalisation still happens when anyone opens the assessment. |
| Upload rejected | Type not allowed for that assignment, content doesn't match extension, or file larger than limit (≤ 4 MB on Vercel). |
| Emails not arriving | No `RESEND_API_KEY` ⇒ messages sit in `outbox`; use Users → "Reset / invite link". |
| Supabase "too many connections" | Use the transaction pooler URL, keep `DB_POOL_MAX` small (default 5). |
| Local dev data corrupt | Delete `.data/` (embedded database + uploads). |
