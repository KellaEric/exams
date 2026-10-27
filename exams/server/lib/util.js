import crypto from 'node:crypto';
import { bad } from './errors.js';

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
export const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export const needUuid = (v, what = 'id') => { if (!isUuid(v)) throw bad(`Invalid ${what}.`); return v; };
export const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
export const normTitle = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\b(the|a|an|course|to|of|for|in)\b/g, ' ').replace(/\s+/g, ' ').trim();
export const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 64);

// Unbiased Fisher-Yates using crypto randomness.
export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const k = crypto.randomInt(i + 1); [a[i], a[k]] = [a[k], a[i]]; }
  return a;
}

// CSV with formula-injection protection (keeps the legacy portal's behaviour).
export const csvCell = (v) => {
  let s = v instanceof Date ? v.toISOString() : String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
};
export const toCsv = (rows) => '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

export function pageParams(q, def = 25, max = 200) {
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || def, 1), max);
  const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
  return { limit, offset };
}
