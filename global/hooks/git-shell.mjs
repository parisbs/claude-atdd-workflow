// A small shell reader for guard-git. Keep raw spellings beside dequoted words:
// the gate trigger can see a program even when its form cannot be evaluated.
import { program } from './commands.mjs';

// Heredoc bodies start after the header's newline, including inside $(...).
function heredocAt(text, at) {
  const match = /^<<(-?)[ \t]*((?:'[^'\n]*'|"[^"\n]*"|\\[^\s]|[^\s;|&()<>'"])+)/.exec(text.slice(at));
  if (!match) return undefined;
  return { end: at + match[0].length, delimiter: match[2].replace(/['"\\]/g, ''),
    quoted: /['"\\]/.test(match[2]), tabs: match[1] === '-' };
}

function heredocBody(text, start, doc) {
  let at = start;
  while (at < text.length) {
    const newline = text.indexOf('\n', at);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(at, end);
    if ((doc.tabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) {
      return { text: text.slice(start, at), end: newline < 0 ? end : end + 1 };
    }
    at = newline < 0 ? end : end + 1;
  }
  return { text: text.slice(start), end: text.length, issue: 'unclosed heredoc <<' };
}

function substitutionEnd(text, start) {
  let depth = 1;
  let quote;
  const docs = [];
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\\' && quote !== "'") { i += 1; continue; }
    if (quote !== "'" && text.startsWith('$(', i)) {
      const end = substitutionEnd(text, i + 2);
      if (!end) return undefined;
      i = end - 1;
      continue;
    }
    if (quote !== "'" && c === '`') {
      i += 1;
      while (i < text.length && text[i] !== '`') { if (text[i] === '\\') i += 1; i += 1; }
      if (i === text.length) return undefined;
      continue;
    }
    if (!quote && c === '<' && text[i + 1] === '<') {
      const doc = heredocAt(text, i);
      if (doc) { docs.push(doc); i = doc.end - 1; continue; }
    }
    if (!quote && c === '\n' && docs.length) {
      let at = i + 1;
      for (const doc of docs.splice(0)) at = heredocBody(text, at, doc).end;
      i = at - 1;
      continue;
    }
    if (quote) {
      if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth += 1;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return undefined;
}

// In unquoted heredocs only substitutions run; prose and quotes are body data.
function bodySubstitutions(text) {
  const substitutions = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\') { i += 1; continue; }
    if (text.startsWith('$(', i)) {
      const end = substitutionEnd(text, i + 2);
      substitutions.push({ text: text.slice(i + 2, end ? end - 1 : undefined), issue: 'heredoc command substitution $(' });
      i = (end ?? text.length) - 1;
    } else if (text[i] === '`') {
      let end = i + 1;
      while (end < text.length && text[end] !== '`') { if (text[end] === '\\') end += 1; end += 1; }
      substitutions.push({ text: text.slice(i + 1, end), issue: 'heredoc backtick substitution `' });
      i = end;
    }
  }
  return substitutions;
}

export function shellParts(command) {
  const text = command.replace(/\\\r?\n/g, '');
  const parts = [];
  let tokens = [];
  const structures = [];
  let background = false;
  let issue;
  let redirectTarget = false;
  let pendingDoc;
  const docs = [];
  const finish = (operator) => {
    if (redirectTarget) issue = 'unclosed redirection';
    if (tokens.length) parts.push({ tokens, operator, issue: issue || structures[0] || (background || operator === '&' ? 'background &' : undefined) });
    tokens = [];
    issue = undefined;
    redirectTarget = false;
    pendingDoc = undefined;
    background = operator === '&';
  };
  for (let i = 0; i < text.length;) {
    const c = text[i];
    const redirect = /^(?:[0-9]*(?:<<<|<<-?|>>|<>|<&|>&|>\||[<>])|&>>?)/.exec(text.slice(i));
    if (redirect) {
      const raw = redirect[0];
      const token = { value: raw, raw, substitutions: [], redirect: true };
      tokens.push(token);
      if (/^[0-9]*<<-?$/.test(raw)) pendingDoc = { ...heredocAt(text, i + raw.search(/</)), token, header: tokens };
      redirectTarget = true;
      i += raw.length;
      continue;
    }
    if (c === '\n' || ';|&'.includes(c)) {
      const operator = text[i + 1] === c && c !== ';' ? c + c : c;
      finish(operator);
      i += operator.length;
      if (c === '\n') {
        for (const doc of docs.splice(0)) {
          const body = heredocBody(text, i, doc);
          let at = parts.findIndex((part) => part.tokens.includes(doc.token));
          let pipedInterpreter = false;
          while (at >= 0 && parts[at]?.operator === '|') {
            at += 1;
            pipedInterpreter ||= INTERPRETERS.has(program(commandWords(parts[at]?.tokens ?? []).tokens[0]?.value));
          }
          doc.token.heredoc = { ...body, quoted: doc.quoted, header: doc.header, pipedInterpreter };
          i = body.end;
        }
      }
      continue;
    }
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '#') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if ('(){}'.includes(c)) {
      if (c === '(' || c === '{') structures.push(c === '(' ? 'subshell or function body (' : 'brace group or function body {');
      else if (tokens.length) { finish(); structures.pop(); }
      else structures.pop();
      i += 1;
      continue;
    }
    const start = i;
    let value = '';
    let quote;
    let ansiNul = false;
    const substitutions = [];
    while (i < text.length) {
      const ch = text[i];
      if (!quote && (/\s/.test(ch) || ';|&(){}<>'.includes(ch))) break;
      // Decode ANSI-C words for the trigger; their raw spellings stay unread.
      if (!quote && ch === '$' && text[i + 1] === "'") { quote = 'ansi'; ansiNul = false; i += 2; continue; }
      if (quote === 'ansi') {
        if (ch === "'") { quote = undefined; i += 1; continue; }
        if (ch === '\\' && i + 1 < text.length) {
          const escape = /^\\(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|([0-7]{1,3})|c(.)|(.))/.exec(text.slice(i));
          if (escape) {
            const hex = escape[1] ?? escape[2] ?? escape[3];
            const code = hex ? parseInt(hex, 16) : escape[4] ? parseInt(escape[4], 8)
              : escape[5] ? escape[5].toUpperCase().charCodeAt(0) & 31 : undefined;
            const decoded = code !== undefined ? code <= 0x10ffff ? String.fromCodePoint(code) : escape[0]
              : ({ a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
                '\\': '\\', "'": "'", '"': '"', '?': '?' }[escape[6]] ?? escape[0]);
            if (!ansiNul) value += decoded.split('\0')[0];
            ansiNul ||= decoded.includes('\0');
            i += escape[0].length; continue;
          }
        }
        if (!ansiNul) value += ch;
        i += 1; continue;
      }
      if (ch === '\\' && quote !== "'" && i + 1 < text.length) {
        value += text[i + 1]; i += 2; continue;
      }
      if (ch === '$' && text[i + 1] === '(' && quote !== "'") {
        const end = substitutionEnd(text, i + 2);
        substitutions.push({ text: text.slice(i + 2, end ? end - 1 : undefined), issue: end ? 'command substitution $(' : 'unclosed command substitution $(' });
        if (!end) issue = 'unclosed command substitution $(';
        value += text.slice(i, end); i = end ?? text.length; continue;
      }
      if (ch === '`' && quote !== "'") {
        let end = i + 1;
        while (end < text.length && text[end] !== '`') { if (text[end] === '\\') end += 1; end += 1; }
        substitutions.push({ text: text.slice(i + 1, end), issue: 'backtick substitution `' });
        if (end === text.length) issue = 'unclosed backtick substitution `';
        value += text.slice(i, end + 1); i = Math.min(end + 1, text.length); continue;
      }
      if (ch === '"' || ch === "'") {
        if (!quote) { quote = ch; i += 1; continue; }
        if (quote === ch) { quote = undefined; i += 1; continue; }
      }
      value += ch; i += 1;
    }
    const raw = text.slice(start, i);
    if (quote) issue = 'unclosed quote';
    tokens.push({ value, raw, substitutions, redirect: redirectTarget });
    redirectTarget = false;
    if (pendingDoc) { docs.push(pendingDoc); pendingDoc = undefined; }
  }
  finish();
  return parts;
}

const DATA_PROGRAMS = new Set(['echo', 'printf', 'grep', 'rg', 'which', 'type', 'man', 'npm']);
const INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'ksh', 'dash', 'eval', 'python', 'python3', 'node']);
const GATE_PROGRAMS = new Set(['git', 'gh', 'supabase']);
const assignment = (token) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value);

export function commandWords(tokens) {
  tokens = tokens.filter((token) => !token.redirect);
  let at = 0;
  while (tokens[at] && assignment(tokens[at])) at += 1;
  return { assignments: tokens.slice(0, at), tokens: tokens.slice(at) };
}

// Message text is data; its shell substitutions still execute.
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
      if (value.includes('=')) result[i] = { value: value.split('=')[0] + '=message', raw: value.split('=')[0] + '=message', substitutions: result[i].substitutions };
      else if (result[i + 1]) { i += 1; result[i] = { ...result[i], value: 'message', raw: 'message' }; }
    } else if (/^-[^-]/.test(value)) {
      for (let k = 1; k < value.length; k += 1) {
        if (messageFlags.includes(value[k])) {
          if (k + 1 < value.length) result[i] = { value: value.slice(0, k + 1) + 'message', raw: value.slice(0, k + 1) + 'message', substitutions: result[i].substitutions };
          else if (result[i + 1]) { i += 1; result[i] = { ...result[i], value: 'message', raw: 'message' }; }
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
  const tokens = withoutMessages(original);
  const result = [];
  const issue = inherited || part.issue;
  const nested = (text, reason) => {
    for (const child of shellParts(text)) result.push(...gateCommands(child, reason, depth + 1));
  };
  const executableText = (text, reason) => {
    nested(text, reason);
    // Interpreters may carry a shell string inside a language string.
    for (const match of text.matchAll(/(['"])([\s\S]*?)\1/g)) nested(match[2], reason);
  };
  if (/unclosed/.test(part.issue ?? '')) result.push(...rawGateCommands(part.tokens.map((t) => t.raw).join(' '), part.issue));
  for (const token of part.tokens) {
    const doc = token.heredoc;
    if (doc) {
      const header = commandWords(doc.header).tokens;
      const interpreter = INTERPRETERS.has(program(header[0]?.value))
        || doc.pipedInterpreter;
      if (interpreter) executableText(doc.text, doc.issue || 'interpreter heredoc <<');
      else if (doc.issue) nested(doc.text, doc.issue);
      else if (!doc.quoted) {
        for (const sub of bodySubstitutions(doc.text)) nested(sub.text, sub.issue);
      }
    }
  }
  for (const token of part.tokens.filter((t) => t.redirect).concat(assignments, tokens)) {
    for (const sub of token.substitutions ?? []) nested(sub.text, sub.issue);
  }
  let at = 0;
  const first = program(tokens[0]?.value);
  if (first === 'command' && tokens[1]?.value === '-v') return result;
  if (DATA_PROGRAMS.has(first)) return result;
  if (INTERPRETERS.has(first)) {
    for (const token of tokens.slice(1)) {
      if (token.value.startsWith('-')) continue;
      executableText(token.value, issue || `interpreter ${first}`);
    }
    return result;
  }
  const runner = supabaseIndex(tokens);
  if (runner !== undefined) at = runner;
  else if (!GATE_PROGRAMS.has(first)) {
    at = 1;
    while (tokens[at] && (tokens[at].value.startsWith('-') || /^\d+$/.test(tokens[at].value))) at += 1;
    const wrapped = supabaseIndex(tokens.slice(at));
    if (wrapped !== undefined) at += wrapped;
  }
  if (GATE_PROGRAMS.has(program(tokens[at]?.value))) {
    const runnerIssue = runner !== undefined && tokens.slice(0, at).map((token, i) => nonliteral(token, i === 0)).find(Boolean);
    result.push({ tokens: tokens.slice(at), assignments,
      issue: [issue, runnerIssue, at && !['npx', 'bunx'].includes(first) ? `prefix ${first}` : undefined].filter(Boolean).join('; ') || undefined,
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

// The decision loop uses the same program forms as the trigger reader.
export function supabaseIndex(tokens) {
  const first = program(tokens[0]?.value);
  if (first === 'supabase') return 0;
  if (!['npx', 'bunx'].includes(first)) return undefined;
  let at = 1;
  while (tokens[at]?.value.startsWith('-')) {
    at += ['-p', '--package'].includes(tokens[at].value) ? 2 : 1;
  }
  return program(tokens[at]?.value) === 'supabase' ? at : undefined;
}

// Last resort only: a failed reader cannot prove that raw trigger words are data.
export function rawGateCommands(text, issue = 'shell reader exception') {
  const words = text.match(/[^\s'"`;|&(){}<>]+/g) ?? [];
  const result = [];
  const assignments = words.filter((word) => /^(?:GIT_|GH_|HUSKY)/.test(word) && word.includes('='))
    .map((value) => ({ value, raw: value }));
  for (let i = 0; i < words.length; i += 1) {
    if (!GATE_PROGRAMS.has(program(words[i]))) continue;
    const end = words.findIndex((word, at) => at > i && GATE_PROGRAMS.has(program(word)));
    const tokens = words.slice(i, end < 0 ? undefined : end).map((value) => ({ value, raw: value }));
    result.push({ tokens, assignments, issue });
  }
  return result;
}
