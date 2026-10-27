// First-admin bootstrap from environment variables. NOTHING is stored in the code or the repository.
// Active only while NO super administrator exists; afterwards the variables are ignored (and should be deleted).
import { hashPassword, passwordProblem } from './password.js';
import { audit } from './audit.js';

export async function bootstrapAdmin(ctx, env) {
  const email = String(env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase(), pw = env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !pw) return null;
  if (await ctx.db.one("select 1 as x from users where role_key='super_admin' limit 1")) return null;
  const problem = !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? 'BOOTSTRAP_ADMIN_EMAIL is not a valid email.' : passwordProblem(pw, { privileged: true, email });
  if (problem) { console.error(`[bootstrap] First admin NOT created: ${problem}`); return null; }
  try {
    const u = await ctx.db.one("insert into users(email,password_hash,full_name,role_key,status,email_verified_at,created_at,updated_at) values($1,$2,$3,'super_admin','active',$4,$4,$4) returning id,email,full_name",
      [email, await hashPassword(pw), String(env.BOOTSTRAP_ADMIN_NAME || 'Administrator').slice(0, 120), ctx.now()]);
    await audit(ctx.db, ctx, { action: 'user.create', entity: 'user', id: u.id, meta: { role: 'super_admin', via: 'environment bootstrap', actor_label: 'bootstrap' } });
    console.log(`[bootstrap] Created first super administrator ${email}. Remove BOOTSTRAP_ADMIN_PASSWORD from your environment now.`);
    return u;
  } catch (e) { if (e.code === '23505') return null; throw e; }       // another instance won the race
}
