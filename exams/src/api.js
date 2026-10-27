// Thin fetch wrapper. Session = httpOnly cookie (JS cannot read it). CSRF token is sent as a header on writes.
let csrf = null;
export const setCsrf = (t) => { csrf = t; };
export class ApiError extends Error { constructor(status, body) { super(body?.error?.message || `Request failed (${status})`); this.status = status; this.code = body?.error?.code; this.details = body?.error?.details; } }

async function request(method, url, body, extra = {}) {
  const headers = { ...(extra.headers || {}) };
  if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
  let payload;
  if (body !== undefined && !extra.raw) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); } else if (extra.raw) payload = body;
  let res;
  try { res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' }); }
  catch { throw new ApiError(0, { error: { message: 'Cannot reach the server. Check your connection.', code: 'network' } }); }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json().catch(() => null) : extra.text ? await res.text() : null;
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
export const api = {
  get: (u) => request('GET', u), post: (u, b = {}) => request('POST', u, b), put: (u, b) => request('PUT', u, b),
  patch: (u, b) => request('PATCH', u, b), del: (u) => request('DELETE', u),
  upload: (u, file) => request('POST', u, file, { raw: true, headers: { 'X-File-Name': file.name, 'Content-Type': 'application/octet-stream' } }),
  text: (u) => request('GET', u, undefined, { text: true })
};
