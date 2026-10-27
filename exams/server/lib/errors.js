export class HttpError extends Error {
  constructor(status, message, code, details) { super(message); this.status = status; this.code = code; this.details = details; }
}
export const bad = (m, d) => new HttpError(400, m, 'bad_request', d);
export const unauthorized = (m = 'Sign in required.') => new HttpError(401, m, 'unauthorized');
export const forbidden = (m = 'You do not have permission to do that.') => new HttpError(403, m, 'forbidden');
export const notFound = (m = 'Not found.') => new HttpError(404, m, 'not_found');
export const conflict = (m, code = 'conflict', d) => new HttpError(409, m, code, d);
export const tooMany = (m, retryAfter) => Object.assign(new HttpError(429, m, 'rate_limited'), { retryAfter });
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
