# Security design and checklist

## Controls implemented (and tested unless noted)
* **AuthN:** scrypt password hashing; generic login errors; DB-backed throttling (per email and per IP) that survives serverless instances; opaque random session tokens (only the SHA-256 is stored); `HttpOnly`, `SameSite=Lax`, `Secure` (prod) cookie; idle (120 min) + absolute (12 h) expiry; suspension/role change revokes sessions at once; password reset/invite tokens are one-time, hashed, expiring; optional TOTP MFA (mandatory for admins when `REQUIRE_MFA_FOR_PRIVILEGED=true`); no default credentials; reset requests do not reveal whether an account exists.
* **AuthZ:** every route checks permission *and* scope on the server; other courses return 404. Students cannot reach staff/admin endpoints, other students' attempts, answer keys, hidden checks or unreleased results (tests assert these over direct API calls).
* **CSRF/origin:** per-session CSRF token header + `Origin` check on all state changes.
* **Injection/XSS:** parameterised SQL everywhere; zod validation; React escapes output; API responses are JSON with `nosniff`; strict CSP in `vercel.json`.
* **Uploads:** extension allow-list + magic-byte check, size cap, random storage keys, private bucket, 5-minute HMAC links bound to the requesting user, `Content-Disposition: attachment`, sandbox CSP on downloads. **No malware scanning** is performed.
* **Integrity:** transactions + unique constraints for attempts, idempotent submit, frozen question snapshots, immutable grade-change history, audit log for sensitive actions.
* **Code:** student code is **never executed**; regex check patterns are length-limited and rejected if they contain nested quantifiers.
* **Secrets:** only via environment; `.env*` git-ignored; none in logs/audit.

## Pre-launch checklist
- [ ] Rotate/disable the old Lab Portal admin password everywhere; purge from git history.
- [ ] Separate Supabase project for production; RLS enabled on all tables with no public policies; service-role key only in Vercel env.
- [ ] `FILE_SIGNING_SECRET`, `CRON_SECRET` set (32+ random chars); `APP_ORIGIN`/`PUBLIC_URL` exact; `NODE_ENV=production` (server refuses to start with unsafe config).
- [ ] `REQUIRE_MFA_FOR_PRIVILEGED=true`; all admins enrolled.
- [ ] `SELF_REGISTRATION` set deliberately (default: admin approval).
- [ ] Backups configured and a restore rehearsed.
- [ ] Rehearsal exam on staging incl. a deliberate network drop and an expiry.
- [ ] Review role permissions (Users & roles → Roles) against your policy; decide `QUESTION_SELF_APPROVAL`.
- [ ] Publish an exam-integrity and dispute policy to students (the portal provides the incident workflow, not the policy).
- [ ] Independent penetration test before high-stakes use.

## Not guaranteed
A browser exam cannot prevent collaboration, second devices or lookup of answers. Focus-change events are weak signals, never proof.
