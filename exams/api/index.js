// Vercel serverless entry. The Express app is created once per warm instance.
import { createApp } from '../server/app.js';
let appPromise;
export default async function handler(req, res) {
  try {
    appPromise ||= createApp();
    const app = await appPromise;
    return app(req, res);
  } catch (e) {
    appPromise = undefined;                         // allow retry on the next request (e.g. DB was briefly unreachable)
    console.error('[boot]', e.message);
    // Safe diagnostics: setting NAMES / error codes only, never values or connection strings.
    const details = e.problems ? { problems: e.problems }
      : /pending migrations/.test(e.message) ? { problems: [e.message] }
      : { problems: [`Could not start (${e.code || e.name}). ${e.code === 'ENOTFOUND' ? 'The database host name was not found: check the connection string.' : e.code === '28P01' ? 'Database password was rejected: check the password in the connection string.' : e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT' ? 'The database could not be reached: use the Supabase Transaction pooler URL (IPv4).' : 'See the Vercel function logs for details.'}`] };
    res.statusCode = 503; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { message: 'The portal is not ready yet.', code: 'not_ready', details } }));
  }
}
