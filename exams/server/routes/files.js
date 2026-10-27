import { Router } from 'express';
import express from 'express';
import crypto from 'node:crypto';
import { wrap, bad, notFound, forbidden, conflict } from '../lib/errors.js';
import { parse, staffOnly, needRole } from '../middleware.js';
import { needUuid, sha256 } from '../lib/util.js';
import { inspectUpload, DEFAULT_ALLOWED } from '../lib/filetype.js';
import { staffLevel, requireCourse } from '../lib/access.js';
import { signLink, verifyLink } from '../lib/storage.js';
import { audit } from '../lib/audit.js';

const r = Router();
const PURPOSES = ['question_attachment', 'answer_upload', 'course_resource', 'assignment_brief'];

r.post('/files', (req, res, next) => express.raw({ type: () => true, limit: `${req.ctx.config.maxUploadMb}mb` })(req, res, next), wrap(async (req, res) => {
  const { ctx } = req; const purpose = String(req.query.purpose || '');
  if (!PURPOSES.includes(purpose)) throw bad('Unknown upload purpose.');
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const name = String(req.headers['x-file-name'] || '').replace(/[\\/\0]/g, '_').slice(0, 200);
  let courseId, allowed = DEFAULT_ALLOWED, maxBytes = ctx.config.maxUploadMb * 1024 * 1024;
  if (purpose === 'answer_upload') {
    if (req.user.role_key !== 'student') throw forbidden();
    const att = await ctx.db.one("select t.id, t.deadline_at, a.course_id, a.settings from attempts t join assessments a on a.id=t.assessment_id where t.id=$1 and t.student_id=$2 and t.status='in_progress'", [needUuid(req.query.attempt_id, 'attempt_id'), req.user.id]);
    if (!att) throw notFound('Active attempt not found.');
    if (ctx.now() > new Date(att.deadline_at.getTime() + ctx.config.saveGraceSeconds * 1000)) throw conflict('Time is up for this attempt.', 'time_expired');
    courseId = att.course_id;
    if (att.settings?.allowed_file_types?.length) allowed = att.settings.allowed_file_types.map((x) => x.toLowerCase());
    if (att.settings?.max_file_mb) maxBytes = Math.min(maxBytes, att.settings.max_file_mb * 1024 * 1024);
  } else {
    if (req.user.role_key === 'student') throw forbidden();
    courseId = needUuid(req.query.course_id, 'course_id'); await requireCourse(ctx, req.user, courseId, { write: true });
  }
  if (buf.length > maxBytes) throw new (await import('../lib/errors.js')).HttpError(413, `File is too large (limit ${Math.floor(maxBytes / 1048576 * 10) / 10} MB).`, 'too_large');
  const info = inspectUpload(name, buf, allowed); if (info.error) throw bad(info.error);
  const key = `${courseId}/${crypto.randomUUID()}.${info.ext}`;         // storage key is random: the user-supplied name is never used on disk
  await ctx.storage.put(key, buf, info.mime);
  const row = (await ctx.db.query('insert into files(owner_id,course_id,purpose,original_name,mime,size_bytes,sha256,storage_key,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id,original_name,mime,size_bytes,purpose,created_at',
    [req.user.id, courseId, purpose, name, info.mime, buf.length, sha256(buf), key, ctx.now()])).rows[0];
  await audit(ctx.db, ctx, { actor: req.user, action: 'file.upload', entity: 'file', id: row.id, meta: { purpose, size: buf.length }, req });
  res.status(201).json(row);
}));

async function canRead(ctx, user, f) {
  if (f.owner_id === user.id) return true;
  if (user.role_key !== 'student') return !!(await staffLevel(ctx.db, user, f.course_id));
  if (f.purpose === 'answer_upload') return false;
  return !!(await ctx.db.one(`select 1 as x from enrolments e join course_offerings o on o.id=e.offering_id where e.student_id=$1 and e.status='active' and o.course_id=$2`, [user.id, f.course_id]));
}
r.get('/files/:id/link', wrap(async (req, res) => {
  const { ctx } = req; const f = await ctx.db.one('select * from files where id=$1', [needUuid(req.params.id)]);
  if (!f || !(await canRead(ctx, req.user, f))) throw notFound('File not found.');
  const exp = Math.floor(ctx.now().getTime() / 1000) + 300;
  res.json({ url: `/api/files/${f.id}/download?exp=${exp}&sig=${signLink(ctx.config, f.id, exp, req.user.id)}`, expires_in: 300, name: f.original_name });
}));
r.get('/files/:id/download', wrap(async (req, res) => {
  const { ctx } = req; const f = await ctx.db.one('select * from files where id=$1', [needUuid(req.params.id)]);
  if (!f || !(await canRead(ctx, req.user, f))) throw notFound('File not found.');
  if (!verifyLink(ctx.config, f.id, req.query.exp, req.user.id, String(req.query.sig || ''), ctx.now().getTime())) throw forbidden('This download link is invalid or has expired.');
  const buf = await ctx.storage.get(f.storage_key);
  res.set({ 'Content-Type': f.mime, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.original_name)}`, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
  res.send(buf);
}));
export default r;
