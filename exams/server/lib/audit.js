import { j } from '../db/index.js';
// Writes an audit event. Pass the transaction handle `q` to make the log atomic with the change it describes.
export async function audit(q, ctx, { actor, action, entity, id, meta, req }) {
  await q.query('insert into audit_events(actor_id,actor_label,action,entity_type,entity_id,meta,ip,created_at) values($1,$2,$3,$4,$5,$6::jsonb,$7,$8)',
    [actor?.id || null, actor ? `${actor.full_name} <${actor.email}>` : (meta?.actor_label || 'system'), action, entity || null, id ? String(id) : null, j(meta || {}), req?.ip_addr || null, ctx.now()]);
}
