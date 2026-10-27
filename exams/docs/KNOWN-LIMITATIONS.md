# Known limitations and unverified items
**Not done / not verified (be explicit before go-live)**
1. **Not deployed.** No Vercel or Supabase environment was available; deployment instructions are untested end-to-end.
2. **Supabase Storage driver, Resend email, Supabase catalogue reader are implemented but never run** against the real services.
3. **Course catalogue not imported** (could not be read) — see COURSE-IMPORT.md.
4. **No single sign-on with the main site**; portal accounts are separate.
5. **No code execution sandbox.** Programming answers are graded manually or by static pattern checks (which can be fooled by code that "looks right"); hidden test-case execution is not available. Adding a sandbox (e.g. a dedicated isolated runner service) is future work.
6. **Group assignments and oral examinations** exist as disabled categories (enable in Configuration) but have no dedicated group/rubric-panel workflow; they use the individual assessment engine.
7. **"No going back" navigation** is enforced by the UI only, not by the server.
8. **Practical sessions:** structured tasks, evidence upload and rubric grading exist; scheduled lab "session" records beyond the assessment window/attempt events do not.
9. **Rate limits:** IP-based limits trust `X-Forwarded-For` (correct behind Vercel; spoofable on a bare server). Per-account throttling is unaffected.
10. **No malware scanning** of uploads; **no virus/AV or content moderation.**
11. **Browser support/accessibility:** built with semantic HTML, labels, live regions and keyboard operation, but no formal WCAG audit or screen-reader test was performed. Ordering questions use arrow buttons (no drag).
12. **Load testing** has not been done. Expect to rehearse with your cohort size.
13. **Legacy browser data** (old localStorage records) is not migrated.
14. Email verification tokens exist in the schema/API but there is no UI flow to request one.
15. PGlite (dev/test) is single-connection; concurrency behaviour was additionally verified on PostgreSQL 16 with the production `pg` driver, but not on Supabase's pooler.
