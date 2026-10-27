// DEVELOPMENT ONLY. Creates demo accounts with a random password printed once. Refuses to run in production.
import crypto from 'node:crypto';
import { boot } from './_boot.js';
import { hashPassword } from '../server/lib/password.js';
if (process.env.NODE_ENV === 'production') { console.error('seed-dev refuses to run with NODE_ENV=production.'); process.exit(1); }
const { db, config } = await boot();
if (config.databaseUrl && !/localhost|127\.0\.0\.1/.test(config.databaseUrl) && process.env.ALLOW_REMOTE_SEED !== 'yes') { console.error('DATABASE_URL looks remote. Set ALLOW_REMOTE_SEED=yes only for a throwaway database.'); process.exit(1); }
const pw = process.env.DEV_SEED_PASSWORD || `Dev-${crypto.randomBytes(6).toString('hex')}-1`;
const hash = await hashPassword(pw);
const demo = [['super@dev.local', 'Dev Super Admin', 'super_admin'], ['admin@dev.local', 'Dev Exam Officer', 'admin'], ['instructor@dev.local', 'Dev Instructor', 'instructor'], ['student1@dev.local', 'Dev Student One', 'student'], ['student2@dev.local', 'Dev Student Two', 'student']];
for (const [email, name, role] of demo) await db.query("insert into users(email,password_hash,full_name,role_key,status) values($1,$2,$3,$4,'active') on conflict do nothing", [email, hash, name, role]);
console.log(`Demo users created (existing ones untouched). Password for new accounts: ${pw}\nThese are development-only accounts. Never use them in production.`);
await db.close();
