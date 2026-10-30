// What guard-tests asks about text it did not read (ADR 0034): which words of it
// can name a path, which text is proven data, and what the reason says. The words
// are matched against the oracle in guard-tests.mjs. The tokenizer here is simple
// and cheap on purpose: it runs only for an unread span or a reader failure.

// Fragments that can name a path: quotes, operators, braces, '=' and expansions split words.
// A tail is the text that followed an expansion, as in "$ROOT/tests/a.test.mjs". Fragments are
// deduplicated, not capped, so a word late in a long command still counts.
export function fragments(text) {
  const marked = text
    .replace(/\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@*#?$!-]/g, ' \u0001')
    .replace(/\$\(/g, ' ');
  const seen = new Set();
  return marked.split(/[\s'"`;&|()<>{}=,\\]+/).flatMap((word) => {
    if (!word) return [];
    const tail = word.startsWith('\u0001');
    const value = word.replaceAll('\u0001', '');
    if (!value || value === '.' || value === '/' || value.startsWith('-')) return [];
    // A glob word is kept: the trigger matches it against the oracle.
    const key = `${tail ? 1 : 0}${value}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ text: value, tail, glob: /[*?[]/.test(value) }];
  });
}

// The command split on unquoted ; & | and newlines, as [text, separator] pairs.
function segments(text) {
  const out = [];
  let current = '';
  let quote;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"') current += text[++i] ?? '';
      else if (ch === quote) quote = undefined;
    } else if (ch === '\\') current += ch + (text[++i] ?? '');
    else if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (';&|\n'.includes(ch)) {
      out.push([current, ch]);
      current = '';
    } else current += ch;
  }
  out.push([current, '']);
  return out;
}

const firstWord = (segment) => segment.replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, '').split(/\s+/)[0].split('/').pop();
const VALUE = String.raw`(?:'[^']*'|"(?:[^"\\]|\\.)*"|\S+)`;
const MESSAGES = {
  git: new RegExp(String.raw`(^|\s)(?:--message(?:=|\s+)|-m\s*)${VALUE}`, 'g'),
  gh: new RegExp(String.raw`(^|\s)(?:--title(?:=|\s+)|--body(?:=|\s+)|-t\s*|-b\s*)${VALUE}`, 'g'),
};
// Only these git subcommands take a message with -m; elsewhere -m is another option
// (git checkout -m merges, git restore -m is not a message), so its words are kept.
const MESSAGE_COMMANDS = new Set(['commit', 'tag', 'notes', 'stash', 'merge']);
const GIT_VALUES = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
const gitSubcommand = (segment) => {
  const words = segment.trim().split(/\s+/);
  let i = words.findIndex((word) => word.split('/').pop() === 'git') + 1;
  if (i === 0) return undefined;
  while (words[i]?.startsWith('-')) i += GIT_VALUES.has(words[i]) ? 2 : 1;
  return words[i];
};

// The body of a heredoc with a quoted delimiter that cat or tee writes to a file is data.
function withoutHeredocData(text) {
  const lines = text.split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i += 1) {
    kept.push(lines[i]);
    const match = /<<(-?)\s*(?:'([^']+)'|"([^"]+)"|\\(\w+))/.exec(lines[i]);
    if (!match) continue;
    const delimiter = match[2] ?? match[3] ?? match[4];
    const before = segments(lines[i].slice(0, match.index)).at(-1)[0];
    const after = segments(lines[i].slice(match.index + match[0].length))[0][0];
    const segment = `${before} ${after}`;
    const program = firstWord(segment);
    const writes = program === 'cat' ? /(?:^|[^<>&])(?:\d?>>?|&>>?)\s*[^\s&>]/.test(segment)
      : program === 'tee' ? segment.trim().split(/\s+/).slice(1).some((word) => !word.startsWith('-')) : false;
    if (!writes) continue;
    let end = i + 1;
    while (end < lines.length && (match[1] ? lines[end].replace(/^\t+/, '') : lines[end]) !== delimiter) end += 1;
    if (end >= lines.length) continue;
    i = end - 1;
  }
  return kept.join('\n');
}

// The command without the text the reader proves to be data: heredoc bodies that cat or tee
// write to a file, and the message of git commit and its kin or the title and body of gh.
export function withoutData(command) {
  return segments(withoutHeredocData(command)).map(([body, separator]) => {
    const program = firstWord(body);
    const pattern = program === 'git' && !MESSAGE_COMMANDS.has(gitSubcommand(body)) ? undefined : MESSAGES[program];
    return (pattern ? body.replace(pattern, '$1') : body) + separator;
  }).join('');
}

export const SUFFIX = {
  subagent: 'A subagent must not change frozen tests; return to the main session for human approval.',
  bypass: 'Changing frozen tests is denied in bypassPermissions; switch to a mode that shows permission prompts.',
  main: 'Confirm the human approves this amendment; it belongs in its own commit.',
};
const CANONICAL = 'Edit or Write on the file, or a literal redirect, cp, mv, rm, sed -i or git checkout -- <path>';

export function sessionOf(event) {
  if (typeof event.agent_id === 'string' && event.agent_id.length > 0) return 'subagent';
  return event.permission_mode === 'bypassPermissions' ? 'bypass' : 'main';
}

// One reason per oracle and span. `names` are repository-relative paths.
export function unreadReason({ part, span, names, tag, commit, session }) {
  const text = span === undefined ? part : `${part}: ${span.replace(/\s+/g, ' ').trim().slice(0, 120)}`;
  const listed = names.length > 10 ? `${names.slice(0, 10).join(', ')} and ${names.length - 10} more` : names.join(', ');
  return `Unread command at the frozen tests gate: ${text}. It names ${listed} against the test oracle ${tag} (${commit}). Canonical form: ${CANONICAL}. ${SUFFIX[session]}`;
}
