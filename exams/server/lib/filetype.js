// Validates uploads by CONTENT (magic bytes), not by the file name or the browser-supplied MIME type.
const sig = (buf, hex, off = 0) => buf.length >= off + hex.length / 2 && buf.subarray(off, off + hex.length / 2).toString('hex') === hex;
const isText = (buf) => { if (buf.includes(0)) return false; try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch { return false; } };
export const TYPES = {
  pdf: { mime: 'application/pdf', test: (b) => sig(b, '25504446') },
  png: { mime: 'image/png', test: (b) => sig(b, '89504e470d0a1a0a') },
  jpg: { mime: 'image/jpeg', test: (b) => sig(b, 'ffd8ff') },
  gif: { mime: 'image/gif', test: (b) => sig(b, '474946383761') || sig(b, '474946383961') },
  webp: { mime: 'image/webp', test: (b) => sig(b, '52494646') && sig(b, '57454250', 8) },
  zip: { mime: 'application/zip', test: (b) => sig(b, '504b0304') },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', test: (b) => sig(b, '504b0304') },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', test: (b) => sig(b, '504b0304') },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', test: (b) => sig(b, '504b0304') },
  txt: { mime: 'text/plain', test: isText }, py: { mime: 'text/plain', test: isText }, js: { mime: 'text/plain', test: isText }, java: { mime: 'text/plain', test: isText },
  csv: { mime: 'text/csv', test: isText }, json: { mime: 'application/json', test: (b) => { if (!isText(b)) return false; try { JSON.parse(b.toString('utf8')); return true; } catch { return false; } } },
  md: { mime: 'text/plain', test: isText }, ipynb: { mime: 'application/json', test: isText }
};
export const DEFAULT_ALLOWED = ['pdf', 'png', 'jpg', 'txt', 'py', 'zip', 'docx', 'csv', 'md', 'ipynb'];
// Returns {ext, mime} when the extension is allowed AND the bytes match that type; otherwise {error}.
export function inspectUpload(name, buf, allowed = DEFAULT_ALLOWED) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name || '');
  const ext = m ? m[1].toLowerCase() : '';
  if (!ext || !allowed.includes(ext) || !TYPES[ext]) return { error: `File type ".${ext || '?'}" is not allowed. Allowed: ${allowed.join(', ')}.` };
  if (!buf.length) return { error: 'The file is empty.' };
  if (!TYPES[ext].test(buf)) return { error: `The file content does not match its ".${ext}" extension.` };
  return { ext, mime: TYPES[ext].mime };
}
