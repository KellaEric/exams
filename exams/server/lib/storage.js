// Private file storage. Files are never served from a public URL: access = authorisation check + short-lived HMAC-signed link.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function createStorage(config) {
  if (config.storage === 'supabase') {
    // Untested in this repo's CI: requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and a PRIVATE bucket (SUPABASE_BUCKET).
    const base = `${config.supabaseUrl}/storage/v1/object`;
    // New-style secret keys (sb_secret_…) are not JWTs: send them only in the apikey header. Legacy service_role JWTs use both. (Not verified against a live project.)
    const h = config.supabaseKey.startsWith('sb_') ? { apikey: config.supabaseKey } : { Authorization: `Bearer ${config.supabaseKey}`, apikey: config.supabaseKey };
    return {
      kind: 'supabase',
      async put(key, buf, mime) { const r = await fetch(`${base}/${config.supabaseBucket}/${key}`, { method: 'POST', headers: { ...h, 'Content-Type': mime, 'x-upsert': 'false' }, body: buf }); if (!r.ok) throw new Error(`storage put failed: ${r.status}`); },
      async get(key) { const r = await fetch(`${base}/${config.supabaseBucket}/${key}`, { headers: h }); if (!r.ok) throw new Error(`storage get failed: ${r.status}`); return Buffer.from(await r.arrayBuffer()); },
      async del(key) { await fetch(`${base}/${config.supabaseBucket}/${key}`, { method: 'DELETE', headers: h }); }
    };
  }
  const root = path.resolve(config.uploadDir);
  const safe = (key) => { const p = path.resolve(root, key); if (!p.startsWith(root + path.sep)) throw new Error('bad key'); return p; };
  return {
    kind: 'local',
    async put(key, buf) { const p = safe(key); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf, { flag: 'wx' }); },
    async get(key) { return fs.readFileSync(safe(key)); },
    async del(key) { try { fs.unlinkSync(safe(key)); } catch { /* ignore */ } }
  };
}
export const signLink = (config, fileId, expiresAtSec, userId) => crypto.createHmac('sha256', config.fileSecret).update(`${fileId}.${expiresAtSec}.${userId}`).digest('base64url');
export function verifyLink(config, fileId, expiresAtSec, userId, sig, nowMs) {
  if (!sig || !(Number(expiresAtSec) * 1000 > nowMs)) return false;
  const good = signLink(config, fileId, expiresAtSec, userId);
  return good.length === sig.length && crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig));
}
