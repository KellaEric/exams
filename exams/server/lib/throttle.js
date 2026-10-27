import { tooMany } from './errors.js';
// DB-backed throttle so it works across serverless instances. Locks `key` for lockSec after `max` hits inside windowSec.
export async function throttleCheck(ctx, key) {
  const row = await ctx.db.one('select * from auth_throttle where key=$1', [key]);
  const now = ctx.now();
  if (row?.locked_until && row.locked_until > now) throw tooMany('Too many attempts. Please wait and try again.', Math.ceil((row.locked_until - now) / 1000));
}
export async function throttleHit(ctx, key, { max = 5, windowSec = 900, lockSec = 900 } = {}) {
  const now = ctx.now();
  await ctx.db.tx(async (q) => {
    const row = (await q.query('select * from auth_throttle where key=$1 for update', [key])).rows[0];
    if (!row || (now - row.window_started) / 1000 > windowSec) {
      await q.query('insert into auth_throttle(key,count,window_started,locked_until) values($1,1,$2,null) on conflict (key) do update set count=1, window_started=$2, locked_until=null', [key, now]);
    } else {
      const count = row.count + 1;
      await q.query('update auth_throttle set count=$2, locked_until=$3 where key=$1', [key, count, count >= max ? new Date(now.getTime() + lockSec * 1000) : null]);
    }
  });
}
export const throttleClear = (ctx, key) => ctx.db.query('delete from auth_throttle where key=$1', [key]);
