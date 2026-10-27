// RFC 6238 TOTP (SHA-1, 6 digits, 30s) with ±1 step tolerance. Used for optional MFA on privileged accounts.
import crypto from 'node:crypto';
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const newSecret = () => { const b = crypto.randomBytes(20); let bits = '', out = ''; for (const x of b) bits += x.toString(2).padStart(8, '0'); for (let i = 0; i + 5 <= bits.length; i += 5) out += ALPHA[parseInt(bits.slice(i, i + 5), 2)]; return out; };
const decode = (s) => { let bits = ''; for (const c of s.replace(/=+$/, '')) bits += ALPHA.indexOf(c).toString(2).padStart(5, '0'); const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); };
export function code(secret, atMs = Date.now()) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30000)));
  const h = crypto.createHmac('sha1', decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1000000)).padStart(6, '0');
}
export const verify = (secret, token, atMs = Date.now()) => [-1, 0, 1].some((d) => code(secret, atMs + d * 30000) === String(token).trim());
export const otpauthUrl = (secret, email) => `otpauth://totp/KellasTech:${encodeURIComponent(email)}?secret=${secret}&issuer=KellasTech`;
