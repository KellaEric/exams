// Server-side port of the Lab Portal's Python source scanner + declarative checks.
// IMPORTANT: this is a *static pattern check*, not code execution. Student code is never run by this server.
export function scanPython(src) {
  const re = /(#[^\n]*)|(?:\b([rRuUbBfF]{1,2}))?("""|'''|"|')/g;
  let out = '', last = 0, fExpr = false, m;
  while ((m = re.exec(src)) !== null) {
    out += src.slice(last, m.index);
    if (m[1] !== undefined) { last = re.lastIndex; continue; }
    const isF = (m[2] || '').toLowerCase().includes('f');
    const q = m[3];
    let j = re.lastIndex, body = '';
    while (j < src.length) {
      if (src[j] === '\\') { body += src.substr(j, 2); j += 2; continue; }
      if (src.startsWith(q, j)) break;
      if (q.length === 1 && src[j] === '\n') break;
      body += src[j++];
    }
    out += '""';
    if (isF) {
      const parts = body.replace(/\{\{|\}\}/g, '').match(/\{[^{}]*\}/g) || [];
      parts.forEach((p) => {
        let depth = 0, expr = '';
        for (const ch of p.slice(1, -1)) {
          if ('([{'.includes(ch)) depth++; else if (')]}'.includes(ch)) depth--;
          else if ((ch === ':' || ch === '!') && depth === 0) break;
          expr += ch;
        }
        if (expr.trim()) { fExpr = true; out += ' ' + expr + ' '; }
      });
    }
    last = src.startsWith(q, j) ? j + q.length : j;
    re.lastIndex = last;
  }
  out += src.slice(last);
  return { clean: out, fExpr };
}

export const MAX_CODE_CHARS = 20000;
// Reject patterns that are long or have nested quantifiers (catastrophic backtracking risk) — used at authoring time AND before running.
export function patternProblem(p) {
  if (typeof p !== 'string' || !p.length) return 'Pattern is empty.';
  if (p.length > 200) return 'Pattern is longer than 200 characters.';
  if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test(p)) return 'Pattern has nested quantifiers (risk of slow matching).';
  try { new RegExp(p); } catch (e) { return `Invalid pattern: ${e.message}`; }
  return null;
}

export function runCheck(chk, scan) {
  switch (chk.type) {
    case 'fexpr': return scan.fExpr;
    case 'minLength': return scan.clean.replace(/\s/g, '').length >= (chk.chars || 1);
    case 'all': return (chk.checks || []).every((c) => runCheck(c, scan));
    case 'any': return (chk.checks || []).some((c) => runCheck(c, scan));
    case 'regex': {
      if (patternProblem(chk.pattern)) return false;
      let text = scan.clean;
      for (const [from, to] of chk.replace || []) text = text.replace(new RegExp(from, 'g'), to);
      const flags = (chk.flags || '').replace(/[^imsu]/g, '') + (chk.min > 1 ? 'g' : '');
      const re = new RegExp(chk.pattern, flags);
      return chk.min > 1 ? (text.match(re) || []).length >= chk.min : re.test(text);
    }
    default: return false;
  }
}

// checks: [{name, points, ...check}] -> {earned, total, results:[{name, points, passed}]}
export function runStaticChecks(checks, code) {
  const src = String(code || '').slice(0, MAX_CODE_CHARS);
  const scan = scanPython(src);
  const results = checks.map((c) => ({ name: c.name, points: c.points, passed: !!runCheck(c, scan) }));
  return { earned: results.reduce((s, r) => s + (r.passed ? r.points : 0), 0), total: checks.reduce((s, c) => s + c.points, 0), results };
}
