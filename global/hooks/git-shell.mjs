// A small shell reader for guard-git. Keep raw spellings beside dequoted words:
// the gate trigger can see a program even when its form cannot be evaluated.
import { program } from './commands.mjs';

function substitutionEnd(text, start) {
  let depth = 1;
  let quote;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\\' && quote !== "'") { i += 1; continue; }
    if (quote) {
      if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth += 1;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return text.length;
}

// Only quoted-delimiter heredocs written to a file by cat/tee are proven data.
function withoutFileHeredocs(command) {
  const lines = command.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const header = lines[i];
    const match = /<<(-?)\s*(['"])([^'"\n]+)\2/.exec(header);
    if (!match || !/^\s*(?:cat\b.*>\s*\S+|tee\s+[^<\s-]\S*)/.test(header)) continue;
    let end = i + 1;
    while (end < lines.length && (match[1] ? lines[end].replace(/^\t+/, '') : lines[end]) !== match[3]) end += 1;
    if (end === lines.length) continue;
    lines[i] = header.replace(match[0], '');
    for (let j = i + 1; j <= end; j += 1) lines[j] = '';
    i = end;
  }
  return lines.join('\n');
}

export function shellParts(command) {
  const text = withoutFileHeredocs(command).replace(/\\\r?\n/g, '');
  const parts = [];
  let tokens = [];
  let structures = [];
  let background = false;
  let heredoc;
  const finish = (operator) => {
    if (tokens.length) parts.push({ tokens, issue: structures[0] || heredoc || (background || operator === '&' ? 'background &' : undefined) });
    tokens = [];
    background = operator === '&';
  };
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '\n' || ';|&'.includes(c)) {
      const operator = text[i + 1] === c && c !== ';' ? c + c : c;
      finish(operator);
      i += operator.length;
      continue;
    }
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '#') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if ('(){}'.includes(c)) {
      if (c === '(' || c === '{') structures.push(c === '(' ? 'subshell or function body (' : 'brace group or function body {');
      // Record the context on a closing segment before dropping it.
      else if (tokens.length) { finish(); structures.pop(); }
      else structures.pop();
      i += 1;
      continue;
    }
    const start = i;
    let value = '';
    let quote;
    const substitutions = [];
    while (i < text.length) {
      const ch = text[i];
      if (!quote && (/\s/.test(ch) || ';|&(){}'.includes(ch))) break;
      if (ch === '\\' && quote !== "'" && i + 1 < text.length) {
        value += text[i + 1]; i += 2; continue;
      }
      if (ch === '$' && text[i + 1] === '(' && quote !== "'") {
        const end = substitutionEnd(text, i + 2);
        substitutions.push({ text: text.slice(i + 2, end - 1), issue: 'command substitution $(' });
        value += text.slice(i, end); i = end; continue;
      }
      if (ch === '`' && quote !== "'") {
        let end = i + 1;
        while (end < text.length && text[end] !== '`') { if (text[end] === '\\') end += 1; end += 1; }
        substitutions.push({ text: text.slice(i + 1, end), issue: 'backtick substitution `' });
        value += text.slice(i, end + 1); i = Math.min(end + 1, text.length); continue;
      }
      if (ch === '"' || ch === "'") {
        if (!quote) { quote = ch; i += 1; continue; }
        if (quote === ch) { quote = undefined; i += 1; continue; }
      }
      value += ch; i += 1;
    }
    const raw = text.slice(start, i);
    tokens.push({ value, raw, substitutions });
    if (raw.startsWith('<<')) heredoc = 'heredoc <<';
  }
  finish();
  return parts;
}

const DATA_PROGRAMS = new Set(['echo', 'printf', 'grep', 'rg', 'which', 'type', 'man', 'npm']);
const INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'ksh', 'dash', 'eval', 'python', 'python3', 'node']);
const GATE_PROGRAMS = new Set(['git', 'gh', 'supabase']);
const assignment = (token) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value);

export function commandWords(tokens) {
  let at = 0;
  while (tokens[at] && assignment(tokens[at])) at += 1;
  return { assignments: tokens.slice(0, at), tokens: tokens.slice(at) };
}

// Values of message options are data, including the usual $(cat <<'EOF') message.
export function withoutMessages(tokens) {
  const name = program(tokens[0]?.value);
  const gitMessage = name === 'git' && tokens.some((t) => ['commit', 'tag'].includes(t.value));
  const ghMessage = name === 'gh';
  if (!gitMessage && !ghMessage) return tokens;
  const result = [...tokens];
  const ghMerge = ghMessage && tokens[1]?.value === 'pr' && tokens[2]?.value === 'merge';
  const messageFlags = ghMessage ? ghMerge ? 'tb' : 'mtb' : 'm';
  const valueFlags = ghMessage ? 'RFAHBqfXL' : 'FCctu';
  const message = (value) => /^(?:--message|--subject)(?:=|$)/.test(value)
    || (ghMessage && /^(?:--title|--body)(?:=|$)/.test(value));
  for (let i = 1; i < result.length; i += 1) {
    const value = result[i].value;
    if (message(value)) {
      if (value.includes('=')) result[i] = { value: value.split('=')[0] + '=message', raw: value.split('=')[0] + '=message', substitutions: [] };
      else if (result[i + 1]) result[++i] = { value: 'message', raw: 'message', substitutions: [] };
    } else if (/^-[^-]/.test(value)) {
      for (let k = 1; k < value.length; k += 1) {
        if (messageFlags.includes(value[k])) {
          if (k + 1 < value.length) result[i] = { value: value.slice(0, k + 1) + 'message', raw: value.slice(0, k + 1) + 'message', substitutions: [] };
          else if (result[i + 1]) result[++i] = { value: 'message', raw: 'message', substitutions: [] };
          break;
        }
        // A value ends the option cluster; its letters are never flags.
        if (valueFlags.includes(value[k])) {
          if (k === value.length - 1) i += 1;
          break;
        }
        if (value[k + 1] === '=') break;
      }
    }
  }
  return result;
}

// Find commands behind unknown prefixes and inside executable strings without
// mistaking quoted arguments of readers for commands. Nested findings are always unread.
export function gateCommands(part, inherited, depth = 0) {
  if (depth > 20) throw new Error('shell reader nesting budget exhausted');
  const { assignments, tokens: original } = commandWords(part.tokens);
  const tokens = withoutMessages(original).filter((token, i, all) => {
    if (/^(?:[0-9]*>>?|[0-9]*>[^>])/.test(token.value)) return false;
    return !/^[0-9]*>>?$/.test(all[i - 1]?.value ?? '');
  });
  const result = [];
  const issue = inherited || part.issue;
  const nested = (text, reason) => {
    for (const child of shellParts(text)) result.push(...gateCommands(child, reason, depth + 1));
  };
  for (const token of [...assignments, ...tokens]) {
    for (const sub of token.substitutions ?? []) nested(sub.text, sub.issue);
  }
  let at = 0;
  const first = program(tokens[0]?.value);
  if (first === 'command' && tokens[1]?.value === '-v') return result;
  if (DATA_PROGRAMS.has(first)) return result;
  if (INTERPRETERS.has(first)) {
    for (const token of tokens.slice(1)) {
      if (token.value.startsWith('-')) continue;
      nested(token.value, issue || `interpreter ${first}`);
      // Interpreters may carry a shell string inside a language string.
      for (const match of token.value.matchAll(/(['"])(.*?)\1/g)) nested(match[2], issue || `interpreter ${first}`);
    }
    return result;
  }
  if ((first === 'npx' || first === 'bunx') && program(tokens[1]?.value) === 'supabase') at = 1;
  else if (!GATE_PROGRAMS.has(first)) {
    at = 1;
    while (tokens[at] && (tokens[at].value.startsWith('-') || /^\d+$/.test(tokens[at].value))) at += 1;
  }
  if (['npx', 'bunx'].includes(program(tokens[at]?.value)) && program(tokens[at + 1]?.value) === 'supabase') at += 1;
  if (GATE_PROGRAMS.has(program(tokens[at]?.value))) {
    result.push({ tokens: tokens.slice(at), assignments,
      issue: [issue, at && !['npx', 'bunx'].includes(first) ? `prefix ${first}` : undefined].filter(Boolean).join('; ') || undefined,
      direct: at === 0 || first === 'npx' || first === 'bunx' });
  }
  return result;
}

export function nonliteral(token, isProgram = false) {
  if (!token) return undefined;
  if (isProgram && token.raw !== token.value) return `escaped or quoted program ${token.raw}`;
  if (/[$`*?\[]/.test(token.raw)) return `non-literal word ${token.raw} (expansion or glob)`;
  const unquoted = /^(['"])[\s\S]*\1$/.test(token.raw) ? token.raw.slice(1, -1) : token.raw;
  if (/["';|&<>\n]/.test(unquoted)) return `quote or operator in word ${token.raw}`;
  return undefined;
}
