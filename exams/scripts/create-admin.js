// Secure administrator provisioning. No default accounts or passwords exist anywhere in this project.
//   npm run admin:create -- --email you@example.com --name "Your Name" [--role super_admin|admin]
// The password is read from a hidden prompt (or from ADMIN_PASSWORD for automation). It is never printed or logged.
import readline from 'node:readline';
import { boot, arg } from './_boot.js';
import { hashPassword, passwordProblem } from '../server/lib/password.js';

const email = String(arg('email', '')).trim().toLowerCase(), name = String(arg('name', '')).trim(), role = arg('role', 'super_admin');
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || name.length < 2 || !['super_admin', 'admin'].includes(role)) { console.error('Usage: npm run admin:create -- --email you@example.com --name "Your Name" [--role super_admin|admin]'); process.exit(1); }

function ask(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); };   // hide typed characters
    rl.question(q, (a) => { rl.close(); console.log(); resolve(a); });
  });
}
let pw = process.env.ADMIN_PASSWORD;
if (!pw) { pw = await ask('Password (12+ characters): '); if (pw !== await ask('Repeat password: ')) { console.error('Passwords do not match.'); process.exit(1); } }
const problem = passwordProblem(pw, { privileged: true, email }); if (problem) { console.error(problem); process.exit(1); }

const { db } = await boot();
if (await db.one('select 1 as x from users where lower(email)=$1', [email])) { console.error('A user with that email already exists.'); process.exit(1); }
const u = await db.one("insert into users(email,password_hash,full_name,role_key,status,email_verified_at) values($1,$2,$3,$4,'active',now()) returning id", [email, await hashPassword(pw), name, role]);
await db.query("insert into audit_events(actor_label,action,entity_type,entity_id,meta) values('cli','user.create','user',$1,$2::jsonb)", [u.id, JSON.stringify({ role, via: 'create-admin script' })]);
console.log(`Created ${role} ${email}. Sign in, then enable multi-factor authentication.`);
await db.close();
