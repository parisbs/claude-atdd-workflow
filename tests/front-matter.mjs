// Issue #66: a minimal reader of MADR 4 front matter for the tests, written apart from scripts/check-adrs.mjs
// so the tests do not inherit its reading. Front matter opens with "---" on line 1 and closes at the next
// "---" line; its lines are flat "key: value" pairs, and a quoted value loses its quotes. Not a module of
// tests itself: the name has no .test, so node --test does not run it.

function unquote(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

// { fields, keys, rest } or null when the text has no closed front matter starting on line 1. keys keeps
// every key in order, repeats included; rest is the text after the closing "---" line.
export function frontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;
  const fields = {};
  const keys = [];
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][\w-]*):(?:\s+(.*))?$/.exec(line);
    if (!match) continue;
    keys.push(match[1]);
    fields[match[1]] = unquote((match[2] ?? '').trim());
  }
  return { fields, keys, rest: lines.slice(end + 1).join('\n') };
}

// The front matter status, or '' when there is none.
export const frontStatus = (text) => frontMatter(text)?.fields.status ?? '';

// A legacy line as #28 read it, or as codex-subagent-mcp writes it.
export const LEGACY_LINE = /^(?:- Status:|- Date:|Status:)/;

// The mechanical migration of a legacy record: the front matter lines given, then every line of the record
// except the legacy status and date lines, unchanged.
export const migrated = (text, fields) =>
  ['---', ...fields, '---', ...text.split('\n').filter((line) => !LEGACY_LINE.test(line))].join('\n');
