// Outbound mail. Messages are always written to the `outbox` table. If RESEND_API_KEY is set they are also sent via Resend's HTTP API.
// (The Resend path is implemented but NOT verified in this repo: no account/key was available. Without it, admins deliver links manually.)
export async function sendMail(ctx, { to, subject, body }) {
  const row = (await ctx.db.query('insert into outbox(to_email,subject,body,created_at) values($1,$2,$3,$4) returning id', [to, subject, body, ctx.now()])).rows[0];
  if (!ctx.config.resendKey) return { queued: true, sent: false };
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${ctx.config.resendKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: ctx.config.mailFrom, to, subject, text: body }) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    await ctx.db.query("update outbox set status='sent', sent_at=$2 where id=$1", [row.id, ctx.now()]);
    return { queued: true, sent: true };
  } catch (e) {
    await ctx.db.query("update outbox set status='failed', error=$2 where id=$1", [row.id, String(e.message).slice(0, 300)]);
    return { queued: true, sent: false, error: e.message };
  }
}
