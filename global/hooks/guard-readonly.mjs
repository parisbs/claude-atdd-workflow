#!/usr/bin/env node
// PreToolUse hook for the researcher's Bash calls. Pages and third-party files
// are untrusted input, so its shell accepts only known reads, never an unread
// form. Quotes preserve literal operators; substitutions, wrappers, writes and
// options that run code are denied. Reads print nothing, preserving permissions.
// The researcher's frontmatter fails closed if this hook cannot start or finish;
// an unread event or an evaluation error also denies the call here.
import { ghIsRead, gitSubcommand } from './commands.mjs';
import { readEvent, Verdict } from './lib.mjs';

// Read a small shell grammar rather than splitting quoted pipes and redirects.
// Expansions cannot be verified without running them, so they stay outside it.
function commands(command) {
  const parts = [];
  let words = [];
  let word = '';
  let started = false;
  let quote;
  let pending = false;
  const finishWord = () => {
    if (started) words.push(word);
    word = '';
    started = false;
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === quote) quote = undefined;
      else word += ch;
      continue;
    }
    if (ch === '\\') {
      const next = command[++i];
      if (next === undefined) throw new Error('unfinished escape');
      if (next === '\n') continue;
      if (quote && !['$', '`', '"', '\\'].includes(next)) word += '\\';
      word += next;
      started = true;
      continue;
    }
    // A trailing dollar is literal (for example a grep anchor), not an expansion.
    const next = command[i + 1];
    if (ch === '`' || (ch === '$' && !(next === undefined
      || (quote === '"' ? next === '"' : /[\s;|&]/.test(next))))) throw new Error('shell expansion');
    if (quote === '"') {
      if (ch === quote) quote = undefined;
      else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (!started && ch === '2' && /^2>(?:\s*\/dev\/null|&1)(?=$|[\s;|&])/.test(command.slice(i))) {
      const redirect = /^2>(?:\s*\/dev\/null|&1)/.exec(command.slice(i))[0];
      i += redirect.length - 1;
    } else if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') {
      finishWord();
      const doubled = (ch === '|' || ch === '&') && command[i + 1] === ch;
      if (ch === '&' && !doubled) throw new Error('background command');
      if (doubled) i += 1;
      if (words.length === 0 && (ch !== '\n' || pending)) throw new Error('empty command');
      if (words.length > 0) parts.push(words);
      words = [];
      pending = ch === '|' || ch === '&';
    } else if (/\s/.test(ch)) {
      finishWord();
    } else {
      // An attached rg glob keeps its -g prefix even after pathname expansion.
      const rgGlob = words[0] === 'rg' && word.startsWith('-g') && /[*?\[\]]/.test(ch);
      if (/[<>(){}#*?\[\]]/.test(ch) && !rgGlob) throw new Error('unsupported shell syntax');
      word += ch;
      started = true;
    }
  }
  if (quote) throw new Error('unfinished quote');
  finishWord();
  if (words.length > 0) parts.push(words);
  else if (pending) throw new Error('unfinished chain');
  if (parts.length === 0) throw new Error('empty command');
  return parts;
}

const GIT_READS = new Set(['log', 'show', 'diff', 'status', 'ls-files', 'rev-parse', 'grep', 'blame']);
const SIMPLE_READS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'cut', 'diff', 'echo', 'pwd', 'stat', 'cd']);

// Some parsers accept unambiguous long-option prefixes. Deny even ambiguous
// prefixes so adding an option cannot turn a denied spelling into a bypass.
function longOptionIs(arg, options) {
  return arg.startsWith('--') && arg !== '--'
    && options.some((option) => option.startsWith(arg.split('=')[0]));
}

function gitIsRead(args) {
  let i = 0;
  while (args[i]?.startsWith('-')) {
    if (args[i] === '-C' && args[i + 1]) i += 2;
    else if (args[i] === '--no-pager') i += 1;
    else return false;
  }
  const sub = gitSubcommand(args);
  if (!GIT_READS.has(sub)) return false;
  const rest = args.slice(i + 1);
  // Git resolves the exact read option --text before abbreviating --textconv.
  return !rest.some((arg) => (arg !== '--text' && longOptionIs(arg, ['--output', '--ext-diff', '--textconv', '--open-files-in-pager']))
    || (sub === 'grep' && /^-[^-]*O/.test(arg)));
}

function rgIsRead(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (longOptionIs(arg, ['--pre', '--hostname-bin', '--search-zip'])) return false;
    if (!/^-[^-]/.test(arg)) continue;
    for (let j = 1; j < arg.length; j += 1) {
      const flag = arg[j];
      if (flag === 'z') return false;
      // A value-taking flag ends the cluster: the z in -tzig is data.
      if ('ABCEMdefgjmrtT'.includes(flag)) {
        if (j + 1 === arg.length && args[++i] === undefined) return false;
        break;
      }
    }
  }
  return true;
}

// Only sed's explicit print form is needed for research. Script files and other
// commands could hide execution or writes even when -n is present.
function sedIsRead(args) {
  let quiet = false;
  const scripts = [];
  let positional = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (/^-[nEr]+$/.test(arg)) quiet ||= arg.includes('n');
    else if (arg === '-e') scripts.push(args[++i]);
    else if (arg.startsWith('-e')) scripts.push(arg.slice(2));
    else if (arg.startsWith('-')) return false;
    else {
      if (!positional && scripts.length === 0) scripts.push(arg);
      positional = true;
    }
  }
  const address = String.raw`(?:\d+|\$|/(?:\\.|[^/\\])*/)`;
  const print = `\\s*(?:${address}(?:,${address})?)?p\\s*`;
  const prints = new RegExp(`^${print}(?:;${print})*$`);
  return quiet && scripts.length > 0 && scripts.every((script) => typeof script === 'string' && prints.test(script));
}

// curl has many ways to write files or send bodies. Accept known GET/HEAD options
// instead of trying to enumerate every writing option and its abbreviations.
function curlIsRead(args) {
  let url = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (/^https?:\/\//.test(arg)) url = true;
    else if (/^-[sSLfivqI]+$/.test(arg)) continue;
    else if (['--silent', '--show-error', '--location', '--fail', '--include', '--verbose', '--disable', '--head'].includes(arg)) continue;
    else if (arg === '-X' || arg === '--request') {
      if (args[++i] !== 'GET') return false;
    } else if (arg === '-XGET' || arg === '--request=GET') continue;
    else if (['-H', '--header', '-A', '--user-agent', '--connect-timeout', '--max-time'].includes(arg)) {
      if (args[++i] === undefined) return false;
    } else return false;
  }
  return url;
}

function isRead(words) {
  const name = words[0];
  // A path could name a repository's executable; an assignment is not a program.
  if (name.includes('/') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(name)) return false;
  const args = words.slice(1);
  if (SIMPLE_READS.has(name)) return true;
  if (name === 'git') return gitIsRead(args);
  if (name === 'gh') return ghIsRead(args) && !args.some((arg) => longOptionIs(arg, ['--web', '--cache']) || /^-[^-]*w/.test(arg));
  if (name === 'curl') return curlIsRead(args);
  if (name === 'sed') return sedIsRead(args);
  if (name === 'find') return !args.some((arg) => /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(arg));
  if (name === 'rg') return rgIsRead(args);
  if (name === 'sort') return !args.some((arg) => longOptionIs(arg, ['--output', '--compress-program']) || /^-[^-]*o/.test(arg));
  if (name === 'jq') return !args.some((arg) => longOptionIs(arg, ['--run-tests', '--in-place']));
  if (name === 'uniq') {
    // A second operand names an output file, unlike the other text readers.
    let operands = 0;
    for (let i = 0; i < args.length; i += 1) {
      if (['-f', '-s', '-w', '--skip-fields', '--skip-chars', '--check-chars'].includes(args[i])) i += 1;
      else if (!args[i].startsWith('-')) operands += 1;
      else if (!/^(?:-[cduiDz]+|-[fsw]\d+|--(?:count|repeated|unique|ignore-case)|--all-repeated(?:=(?:none|prepend|separate))?|--(?:skip-fields|skip-chars|check-chars)=\d+)$/.test(args[i])) return false;
    }
    return operands <= 1;
  }
  return false;
}

const verdict = new Verdict();
try {
  const event = readEvent();
  if (event?.tool_name !== 'Bash' || typeof event?.tool_input?.command !== 'string') {
    throw new Error('unreadable Bash event');
  }
  for (const words of commands(event.tool_input.command)) {
    if (!isRead(words)) throw new Error('command or option outside the read-only list');
  }
} catch (error) {
  verdict.add('deny', `The researcher only reads: ${error.message}.`);
}
verdict.emit();
