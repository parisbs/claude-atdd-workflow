// Common Bash writes read as words, never executed (ADR 0002, ADR 0033).
// Targets and find results are compared with the oracle inventory, never a
// recursive filesystem walk. What it does not read goes to options.unread, and
// a failure to options.error; the caller decides whether that names a frozen
// or configuration path (ADR 0034). A program it does not know is not a span,
// and a failed segment does not discard other findings. This is a safety net,
// not a shell interpreter.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { gitCommand, program } from './commands.mjs';
import { globToRegExp } from './oracle.mjs';
import { realPath } from './codex.mjs';

// The index of the character that closes the substitution opened at `start`
// (`$(` or a backtick), or -1. Parentheses nest; quotes, escapes and heredoc
// bodies are skipped.
function substitutionEnd(command, start) {
  if (command[start] === '`') {
    for (let i = start + 1; i < command.length; i += 1) {
      if (command[i] === '\\') i += 1;
      else if (command[i] === '`') return i;
    }
    return -1;
  }
  let depth = 1;
  const heredocs = [];
  const operator = /<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|()<>'"]+))/y;
  for (let i = start + 2; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === '\\') i += 1;
    else if (ch === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      operator.lastIndex = i;
      const match = operator.exec(command);
      if (match) {
        heredocs.push({ tabs: match[1] === '-', delimiter: match[2] ?? match[3] ?? match[4] });
        i += match[0].length - 1;
      } else i += 1;
    } else if (ch === '\n' && heredocs.length) {
      for (const { tabs, delimiter } of heredocs.splice(0)) {
        let cursor = i + 1;
        for (;;) {
          if (cursor > command.length) return -1;
          const end = command.indexOf('\n', cursor);
          const line = command.slice(cursor, end < 0 ? command.length : end);
          if ((tabs ? line.replace(/^\t+/, '') : line) === delimiter) {
            i = end < 0 ? command.length : end;
            break;
          }
          if (end < 0) return -1;
          cursor = end + 1;
        }
      }
    } else if (ch === "'") {
      i = command.indexOf("'", i + 1);
      if (i < 0) return -1;
    } else if (ch === '"') {
      for (i += 1; i < command.length && command[i] !== '"'; i += 1) if (command[i] === '\\') i += 1;
    } else if (ch === '(') depth += 1;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

// The text of each command substitution in an expanded heredoc body.
function substitutionsOf(body) {
  const inner = [];
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '\\') i += 1;
    else if (body[i] === '`' || (body[i] === '$' && body[i + 1] === '(' && body[i + 2] !== '(')) {
      const end = substitutionEnd(body, i);
      if (end < 0) break;
      inner.push(body.slice(i + (body[i] === '`' ? 1 : 2), end));
      i = end;
    }
  }
  return inner;
}

// Keep quoted scripts literal and attach heredoc bodies to their input
// operator. An unread input must not swallow later command segments. A command
// substitution stays whole inside its word; `result.substitutions` maps the
// index of that word to the text of each substitution in it. The body of a heredoc
// whose delimiter is unquoted is expanded, so its substitutions are listed in `inner`.
function tokens(command, error, check) {
  const result = [];
  result.substitutions = new Map();
  let word = '';
  let started = false;
  let quoted = false;
  let quote;
  let heredoc;
  const pending = [];
  const finish = () => {
    if (started) {
      result.push(word);
      if (heredoc) pending.push({ token: heredoc, delimiter: word, quoted });
      heredoc = undefined;
    }
    word = '';
    started = false;
    quoted = false;
  };
  for (let i = 0; i < command.length; i += 1) {
    if (i % 1024 === 0) check();
    const ch = command[i];
    if (quote === "'") {
      if (ch === quote) quote = undefined;
      else word += ch;
    } else if (ch === '\\') {
      const next = command[++i];
      if (next === undefined) break;
      if (next !== '\n') {
        if (quote && !['$', '`', '"', '\\'].includes(next)) word += '\\';
        word += next;
        started = true;
        quoted = true;
      }
    } else if (ch === '`' || (ch === '$' && command[i + 1] === '(' && command[i + 2] !== '(')) {
      const end = substitutionEnd(command, i);
      word += command.slice(i, end < 0 ? command.length : end + 1);
      started = true;
      if (end < 0) {
        i = command.length;
        error(new Error('unterminated command substitution'));
      } else {
        const at = result.length;
        result.substitutions.set(at, [...(result.substitutions.get(at) ?? []), command.slice(i + (ch === '`' ? 1 : 2), end)]);
        i = end;
      }
    } else if (quote === '"') {
      if (ch === quote) quote = undefined;
      else word += ch;
    } else if (ch === '$' && command[i + 1] === "'") {
      // ANSI-C quoting: a backslash takes the next character literally, so \' does not end it.
      let j = i + 2;
      for (; j < command.length && command[j] !== "'"; j += 1) {
        if (command[j] === '\\') j += 1;
        word += command[j] ?? '';
      }
      started = true;
      quoted = true;
      if (j >= command.length) error(new Error('unterminated shell quote'));
      i = j;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      quoted = true;
    } else if (command.startsWith('$((', i)) {
      const end = command.indexOf('))', i + 3);
      word += command.slice(i, end < 0 ? command.length : end + 2);
      started = true;
      i = end < 0 ? command.length : end + 1;
    } else if (ch === '#' && !started) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i += 1;
    } else if (/[;&|()<>\n]/.test(ch)) {
      const op = /^(?:&>>|&>|>&|<&|<>|<<<|<<-?|>>|>\||&&|\|\||[;&|()<>\n])/.exec(command.slice(i))[0];
      if (/[<>]/.test(op) && /^\d+$/.test(word)) {
        word = '';
        started = false;
      }
      finish();
      const token = { op };
      result.push(token);
      i += op.length - 1;
      if (op === '<<' || op === '<<-') heredoc = token;
      if (op === '\n') {
        for (const { token: input, delimiter, quoted: literal } of pending.splice(0)) {
          const start = i + 1;
          let cursor = start;
          let found = false;
          while (cursor < command.length) {
            const end = command.indexOf('\n', cursor);
            const line = command.slice(cursor, end < 0 ? command.length : end);
            if ((input.op === '<<-' ? line.replace(/^\t+/, '') : line) === delimiter) {
              input.body = command.slice(start, cursor);
              if (!literal) input.inner = substitutionsOf(input.body);
              i = end < 0 ? command.length : end;
              found = true;
              break;
            }
            cursor = end < 0 ? command.length : end + 1;
          }
          if (!found) error(new Error(`unterminated heredoc ${delimiter}`));
        }
      }
    } else if (/\s/.test(ch)) finish();
    else {
      word += ch;
      started = true;
    }
  }
  finish();
  if (quote) error(new Error('unterminated shell quote'));
  return result;
}

function braces(path, check) {
  check();
  const match = /\{([^{}]*,[^{}]*)\}/.exec(path);
  return match ? match[1].split(',').flatMap((part) => braces(path.slice(0, match.index) + part + path.slice(match.index + match[0].length), check)) : [path];
}

const absolute = (cwd, path) => resolve(cwd, path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path);
const quoteWord = (word) => `'${word.replaceAll("'", "'\\''")}'`;

// Positional operands of common writers, with their value-taking options.
function operands(args, values = []) {
  const out = [];
  let literal = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (literal || !arg.startsWith('-') || arg === '-') out.push(arg);
    else if (arg === '--') literal = true;
    else if (values.includes(arg)) i += 1;
  }
  return out;
}

function scriptOf(args, flags, values = [], shell = false) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('-') || arg === '-' || arg === '-m') return undefined;
    if (values.includes(arg) || (shell && /^-[^-]*[oO]$/.test(arg))) {
      i += 1;
      continue;
    }
    if (values.some((flag) => arg.startsWith(flag.startsWith('--') ? `${flag}=` : flag))) continue;
    if (flags.includes(arg)) return args[i + 1];
    const long = flags.find((flag) => flag.startsWith('--') && arg.startsWith(`${flag}=`));
    if (long) return arg.slice(long.length + 1);
    // Script-taking short flags end a cluster: -pe SCRIPT, -we SCRIPT,
    // -lc SCRIPT. The rest, when present, is the script itself.
    if (/^-[^-]/.test(arg) && !/^-[MIF]/.test(arg)) {
      const at = [...arg].findIndex((ch, index) => index > 0 && flags.includes(`-${ch}`));
      if (at > 0) {
        const tail = arg.slice(at + 1);
        return !shell && tail && ![...tail].every((ch) => flags.includes(`-${ch}`)) ? tail : args[i + 1];
      }
    }
  }
  return undefined;
}

function inPlace(cmd, args) {
  if (cmd === 'sed') return args.some((arg) => /^-[Enr]*i|^--in-place(?:=|$)/.test(arg));
  return ['perl', 'ruby'].includes(cmd) && args.some((arg) => /^-[npwWa0-9]*i/.test(arg));
}

function writeOperands(cmd, args) {
  if (cmd === 'sed') {
    const files = [];
    let expression = false;
    let literal = false;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (!literal && arg === '--') literal = true;
      else if (!literal && ['-e', '-f', '--expression', '--file'].includes(arg)) {
        expression = true;
        i += 1;
      } else if (!literal && /^(?:-[ef].+|--(?:expression|file)=)/.test(arg)) expression = true;
      else if (!literal && arg === '-i' && args[i + 1] === '') i += 1;
      else if (!literal && arg.startsWith('-')) continue;
      else if (!expression) expression = true;
      else files.push(arg);
    }
    return files;
  }
  if (['perl', 'ruby'].includes(cmd)) {
    const files = [];
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (/^-[npwi]*e$/.test(arg)) i += 1;
      else if (!arg.startsWith('-')) files.push(arg);
    }
    return files;
  }
  const values = cmd === 'install' ? ['-m', '--mode', '-o', '--owner', '-g', '--group', '-t', '--target-directory']
    : cmd === 'truncate' ? ['-s', '--size', '-r', '--reference']
      : ['cp', 'mv', 'ln'].includes(cmd) ? ['-t', '--target-directory', '-S', '--suffix'] : [];
  return operands(args, values);
}

// Strips what precedes the program; each assignment word goes to `assign`.
function unwrap(words, assign) {
  for (;;) {
    const cmd = program(words[0]);
    if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(words[0] ?? '')) assign(words.shift());
    else if (['if', 'elif', 'while', 'until', 'then', 'do', 'else', '{', '!', 'time'].includes(cmd)) words.shift();
    else if (['sudo', 'doas', 'nice', 'stdbuf', 'nohup', 'exec', 'command', 'env'].includes(cmd)) {
      words.shift();
      const values = ['sudo', 'doas'].includes(cmd) ? ['-u', '-g', '-h', '-p']
        : cmd === 'env' ? ['-u', '--unset', '-C', '--chdir']
          : cmd === 'nice' ? ['-n', '--adjustment'] : cmd === 'stdbuf' ? ['-i', '-o', '-e', '--input', '--output', '--error'] : [];
      while (words[0]?.startsWith('-')) {
        const arg = words.shift();
        if (values.includes(arg)) words.shift();
      }
    } else if (cmd === 'timeout') {
      words.shift();
      while (words[0]?.startsWith('-')) {
        if (['-s', '--signal', '-k', '--kill-after'].includes(words.shift())) words.shift();
      }
      words.shift();
    } else return words;
  }
}

const nonliteral = (word) => /[$`]/.test(word);
const BRACE_RANGE = /\{[^{}]*\.\.[^{}]*\}/;
const REDIRECTS = ['>', '>>', '&>', '&>>', '>|', '<', '<<', '<<-', '<<<', '<>', '>&', '<&'];
const interpreter = (cmd) => ['bash', 'sh', 'zsh', 'node', 'python', 'python3', 'perl', 'ruby'].includes(cmd) || /^python\d+(?:\.\d+)*$/.test(cmd);
const XARGS_VALUES = ['-n', '-L', '-P', '-s', '-E', '-d', '-a', '--max-args', '--max-lines', '--max-procs', '--max-chars', '--eof', '--delimiter', '--arg-file'];
const xargsKnown = (arg) => /^-[0rtpxo]+$/.test(arg) || /^-[nLPsEda]./.test(arg)
  || /^--(?:max-args|max-lines|max-procs|max-chars|eof|delimiter|arg-file)=/.test(arg)
  || ['--null', '--no-run-if-empty', '--verbose', '--interactive', '--exit', '--open-tty'].includes(arg);
// Programs that write what they are given; the rest read, or are unknown and stay allowed.
const WRITERS = new Set(['rm', 'rmdir', 'mv', 'cp', 'install', 'ln', 'tee', 'truncate', 'touch', 'dd', 'rsync', 'patch', 'git', 'bash', 'sh', 'zsh', 'eval']);
// Whether a command, given as words, writes; `xargs` writes when the command it runs does.
function writes(words) {
  const current = unwrap([...words], () => {});
  const cmd = program(current[0]);
  if (cmd === 'xargs') {
    let i = 1;
    for (; i < current.length && current[i].startsWith('-'); i += 1) {
      if (current[i] === '--') { i += 1; break; }
      if (current[i] === '-I' || XARGS_VALUES.includes(current[i])) i += 1;
    }
    return i < current.length && writes(current.slice(i));
  }
  return WRITERS.has(cmd) || inPlace(cmd, current.slice(1));
}

// Each result is an absolute candidate path. The caller supplies the oracle
// inventory and records each write immediately, before later work can fail.
// Text it does not read goes to options.unread(span, part, cause, dir), silently; `dir` is the
// directory the reader had reached there, or undefined when it did not know.
export function shellWrites(command, cwd, options = {}, depth = 0, unknown = false) {
  let unknownCwd = unknown;
  // The span is resolved in the directory the reader had reached, or in none when it lost track.
  const unread = (span, part, cause, at = cwd) => options.unread?.(span, part, cause, unknownCwd && at === cwd ? undefined : at);
  if (depth > 8) {
    unread(command, 'nesting beyond depth 8');
    return [];
  }
  cwd = realPath(cwd);
  const results = [];
  const error = options.error ?? (() => {});
  const check = options.check ?? (() => {});
  const inventories = options.inventories ??= new Map();
  const directories = options.directories ??= new Set();
  const assigned = options.assigned ??= new Map();
  const inventory = (dir = cwd) => {
    check();
    if (!inventories.has(dir)) inventories.set(dir, options.files?.(dir) ?? []);
    return inventories.get(dir);
  };
  // An unreadable file list leaves the target undecided, which is a span for the caller.
  const under = (target) => {
    const files = inventory(target);
    if (files.unreadable) {
      unread(target, 'the oracle file list could not be read');
      return [];
    }
    const exact = files.byPath?.get(target);
    return exact ? [exact] : files.byDirectory?.get(target) ?? [];
  };
  // The word and the values assigned earlier to the variables it uses, and theirs in turn.
  const spanOf = (word) => {
    const parts = [word];
    const used = new Set();
    for (let i = 0; i < parts.length && parts.length < 20; i += 1) {
      for (const [, name] of parts[i].matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) {
        if (used.has(name) || !assigned.get(name)) continue;
        used.add(name);
        parts.push(assigned.get(name));
      }
    }
    return parts.join(' ');
  };
  let previous;
  const emit = (path, action) => {
    check();
    results.push(path);
    options.write?.(path, action);
  };
  // A write position: a word the reader cannot resolve is a span, not a path.
  const expand = (path, dir = cwd, reading = false) => {
    if (!path) return [];
    if (nonliteral(path)) {
      if (!reading) unread(spanOf(path), 'a non-literal write target', undefined, dir);
      return [];
    }
    if (!reading && BRACE_RANGE.test(path)) {
      unread(path, 'a brace range', undefined, dir);
      return [];
    }
    if (!reading && unknownCwd && dir === cwd && !isAbsolute(path) && path !== '~' && !path.startsWith('~/')) {
      unread(path, 'a write after a cd to a directory the guard cannot resolve', unknownCwd instanceof Error ? unknownCwd : undefined);
      return [];
    }
    return braces(path, check).flatMap((part) => {
      const target = absolute(dir, part);
      if (!/[*?]/.test(target)) return [realPath(target)];
      const prefix = target.slice(0, target.search(/[*?]/));
      const base = prefix.endsWith(sep) ? prefix : dirname(prefix);
      const anchor = realPath(base);
      const pattern = resolve(anchor, relative(base, target));
      const re = globToRegExp(pattern);
      const files = inventory(anchor);
      if (files.unreadable) {
        unread(path, 'the oracle file list could not be read', undefined, dir);
        return [];
      }
      const candidates = [...(files.byDirectory?.keys() ?? []), ...(files.byPath?.keys() ?? [])];
      return candidates.filter((path) => { check(); return re.test(path); });
    });
  };
  // The inventory is consulted for a directory, and for a target that does not exist and
  // can hold tests; any other target is recorded by its path. `writesDirectory` is set when the
  // writer can write a directory, so a missing one may have held frozen tests of any name.
  const add = (path, action = 'changed', dir = cwd, writesDirectory = false) => {
    for (const target of expand(path, dir)) {
      const exists = existsSync(target);
      const directory = exists && statSync(target).isDirectory();
      const files = directory || (!exists && (writesDirectory || options.mayHoldTests?.(target))) ? under(target) : [];
      if (files.length) files.forEach((file) => emit(file.path, action));
      else if (!directory) emit(target, action);
    }
  };
  const nested = (script, dir = cwd) => results.push(...shellWrites(script, dir, options, depth + 1, unknownCwd && dir === cwd));
  const inline = (script) => {
    const names = new Set(script.split(/[\s'"`(){}\[\],;=]+/).filter((name) => name && name !== '.' && !/[*?$`]/.test(name)));
    const root = options.rootOf?.(cwd);
    for (const name of names) {
      check();
      const paths = new Set([absolute(cwd, name), ...(root ? [absolute(root, name)] : [])]);
      for (const path of paths) {
        if (!options.mayHoldTests?.(path)) continue;
        const target = realPath(path);
        const files = inventory(target);
        if (files.unreadable) unread(name, 'the oracle file list could not be read');
        else {
          const file = files.byPath?.get(target);
          if (file) emit(file.path, 'changed');
        }
      }
    }
  };
  const stack = [];
  let directoryStack = [];
  let words = [];
  let redirects = [];
  let bodies = [];
  let strings = [];
  let substitutions = [];
  let piped;
  const read = (pipe, toWriter) => {
    const env = new Map();
    const current = unwrap(words, (word) => {
      const at = word.indexOf('=');
      env.set(word.slice(0, at), word.slice(at + 1));
      assigned.set(word.slice(0, at), word.slice(at + 1));
    });
    const outputs = redirects;
    const stdin = bodies;
    const hereStrings = strings;
    const inner = substitutions;
    words = [];
    redirects = [];
    bodies = [];
    strings = [];
    substitutions = [];
    inner.forEach((script) => nested(script));
    for (const path of outputs) add(path);
    const cmd = program(current[0]);
    const args = current.slice(1);
    let found = piped;
    if (interpreter(cmd)) hereStrings.forEach((word) => unread(word, 'a here-string script'));
    if (['cd', 'pushd'].includes(cmd)) {
      const paths = operands(args);
      if (paths.length <= 1 && !(cmd === 'pushd' && !paths.length)) {
        const operand = paths[0] ?? '~';
        const before = unknownCwd ? undefined : cwd;
        if (cmd === 'pushd') directoryStack.push({ cwd, unknownCwd });
        if (operand === '-') {
          if (previous === undefined) unknownCwd = true;
          else {
            cwd = previous;
            unknownCwd = false;
          }
        } else {
          const dir = nonliteral(operand) ? undefined : realPath(absolute(cwd, operand));
          const resolvable = dir !== undefined && (existsSync(dir) ? statSync(dir).isDirectory() : directories.has(dir));
          // A relative operand cannot be resolved against a directory that is unknown. The
          // error of a missing directory travels with the span, so the caller can say why.
          if (!resolvable || (unknownCwd && !isAbsolute(operand) && operand !== '~' && !operand.startsWith('~/'))) {
            let cause = unknownCwd || true;
            if (dir !== undefined && !existsSync(dir) && !directories.has(dir)) {
              try { realpathSync(absolute(cwd, operand)); } catch (failure) { cause = failure; }
            }
            unknownCwd = cause;
          } else {
            cwd = dir;
            unknownCwd = false;
          }
        }
        previous = before;
      }
    } else if (cmd === 'popd') {
      if (directoryStack.length) {
        const top = directoryStack.pop();
        previous = unknownCwd ? undefined : cwd;
        ({ cwd, unknownCwd } = top);
      }
    } else if (cmd === 'mkdir') {
      const parents = args.includes('--parents') || args.some((arg) => /^-[^-]*p/.test(arg));
      for (const path of operands(args, ['-m', '--mode'])) {
        const target = realPath(absolute(cwd, path));
        directories.add(target);
        if (parents) {
          let parent = dirname(target);
          while (!existsSync(parent)) { check(); directories.add(parent); parent = dirname(parent); }
        }
      }
    } else if (['export', 'declare', 'typeset', 'local', 'readonly'].includes(cmd)) {
      for (const word of args) if (!word.startsWith('-') && /^[A-Za-z_][A-Za-z_0-9]*=/.test(word)) assigned.set(word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1));
    } else if (cmd === 'for' && args[1] === 'in') {
      assigned.set(args[0], args.slice(2).join(' '));
    } else if (cmd === 'read') {
      // Its value comes from a producer the reader cannot follow: the whole command stands for it.
      const names = [];
      for (let i = 0; i < args.length; i += 1) {
        if (['-d', '-p', '-n', '-N', '-t', '-u', '-a'].includes(args[i])) i += 1;
        else if (!args[i].startsWith('-')) names.push(args[i]);
      }
      for (const name of names.length ? names : ['REPLY']) assigned.set(name, command);
    } else if (cmd === 'eval') {
      unread(args.join(' '), 'eval');
    } else if (['bash', 'sh', 'zsh'].includes(cmd)) {
      const script = scriptOf(args, ['-c'], ['-o', '-O'], true);
      if (script !== undefined) nested(script);
      stdin.forEach((body) => nested(body));
    } else if (cmd === 'find') {
      const start = args.findIndex((arg) => arg.startsWith('-') || arg === '(' || arg === '!');
      const roots = args.slice(0, start < 0 ? args.length : start);
      const exec = args.findIndex((arg) => arg === '-exec' || arg === '-execdir');
      const predicates = args.slice(start < 0 ? args.length : start, exec < 0 ? undefined : exec);
      // Unsupported predicates are a named gap, rather than an overestimate
      // that could turn a directory-only search into a frozen-file deletion.
      // They are a span when the find writes.
      let supported = true;
      let name;
      const patterns = [];
      for (let i = 0; i < predicates.length; i += 1) {
        const arg = predicates[i];
        if (arg === '-name') patterns.push(name = predicates[++i]);
        else if (arg === '-type') supported &&= predicates[++i] === 'f';
        else if (!['-delete', '-print', '-print0', '-depth'].includes(arg)) supported = false;
      }
      // A find writes when it deletes, when a command it runs writes, or when a writer reads its output.
      const executes = [];
      args.forEach((arg, at) => {
        if (['-exec', '-execdir', '-ok', '-okdir'].includes(arg)) {
          const rest = args.slice(at + 1);
          const end = rest.findIndex((word) => word === ';' || word === '+');
          executes.push(end < 0 ? rest : rest.slice(0, end));
        }
      });
      const writing = exec >= 0 || args.includes('-delete');
      if (!supported && (args.includes('-delete') || executes.some((words) => words.length && writes(words)) || toWriter?.())) {
        // The frozen files its roots can reach, not the root words, which name no file themselves.
        const span = [];
        for (const root of roots.length ? roots : ['.']) {
          span.push(root);
          // The whole repository without a name is not a frozen-file deletion the guard can tell.
          const target = nonliteral(root) ? undefined : absolute(cwd, root);
          if (!patterns.length && target !== undefined && options.rootOf?.(target) === target) continue;
          for (const found of expand(root)) {
            for (const file of under(found)) {
              check();
              if (!patterns.length || patterns.some((pattern) => globToRegExp(pattern).test(basename(file.path)))) span.push(file.path);
            }
          }
        }
        unread(span.join(' '), 'a find expression the guard does not read');
      }
      const namePattern = name && globToRegExp(name);
      const candidates = new Map();
      if (supported && (pipe || writing)) {
        // The candidates of a find come from the oracle of the directory it runs in as well.
        inventory(cwd);
        for (const root of roots.length ? roots : ['.']) {
          for (const target of expand(root)) {
            for (const file of under(target)) {
              check();
              if (!namePattern || namePattern.test(basename(file.path))) candidates.set(file.path, file);
            }
          }
        }
      }
      found = [...candidates.keys()];
      if (args.includes('-delete')) found.forEach((path) => emit(path, 'deleted'));
      if (exec >= 0) {
        const rest = args.slice(exec + 1);
        const end = rest.findIndex((arg) => arg === ';' || arg === '+');
        for (const path of found) {
          check();
          const dir = args[exec] === '-execdir' ? dirname(path) : cwd;
          const replacement = args[exec] === '-execdir' ? `./${basename(path)}` : path;
          nested((end < 0 ? rest : rest.slice(0, end)).map((arg) => quoteWord(arg.replaceAll('{}', replacement))).join(' '), dir);
        }
      }
    } else if (cmd === 'xargs') {
      let i = 0;
      let replacement;
      for (; i < args.length && args[i].startsWith('-'); i += 1) {
        const arg = args[i];
        if (arg === '--') { i += 1; break; }
        if (arg === '-I') replacement = args[++i];
        else if (arg === '-i' || arg === '--replace') replacement = '{}';
        else if (arg.startsWith('-I') || arg.startsWith('-i')) replacement = arg.slice(2);
        else if (arg.startsWith('--replace=')) replacement = arg.slice('--replace='.length);
        else if (XARGS_VALUES.includes(arg)) i += 1;
        else if (!xargsKnown(arg)) unread(command, 'an xargs option the guard does not read');
      }
      if (!piped) nested(args.slice(i).map(quoteWord).join(' '));
      for (const path of piped ?? []) {
        check();
        const invocation = args.slice(i);
        nested((replacement ? invocation.map((arg) => arg.replaceAll(replacement, path)) : [...invocation, path]).map(quoteWord).join(' '));
      }
    } else if (cmd === 'git') {
      const { subcommand, rest, directories: contexts } = gitCommand(args);
      const dir = contexts.reduce((base, path) => absolute(base, path), cwd);
      const separator = rest.indexOf('--');
      const globals = args.slice(0, args.length - rest.length - 1);
      // Where the git command runs is not known: the paths it writes are spans.
      const uncertain = contexts.some(nonliteral) || globals.some((arg) => /^--(?:git-dir|work-tree)(?:=|$)/.test(arg))
        || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'].some((name) => env.has(name))
        || (unknownCwd && contexts.length > 0 && !contexts.some((path) => isAbsolute(path) || path === '~' || path.startsWith('~/')));
      const known = (path) => {
        const target = realPath(absolute(dir, path));
        if (existsSync(target) && statSync(target).isDirectory()) return true;
        if (!options.mayHoldTests?.(target)) return false;
        const files = inventory(target);
        if (files.unreadable) {
          unread(path, 'the oracle file list could not be read', undefined, dir);
          return false;
        }
        return files.byPath?.has(target);
      };
      if (uncertain && ['checkout', 'restore', 'rm', 'mv'].includes(subcommand)) {
        const paths = subcommand === 'checkout' && separator >= 0 ? rest.slice(separator + 1) : operands(rest, ['--source', '-s', '--pathspec-from-file']);
        paths.forEach((path) => unread(path, 'a git context the guard does not resolve'));
      } else if (subcommand === 'checkout') {
        const paths = separator >= 0 ? rest.slice(separator + 1) : operands(rest);
        // Existing directories and exact frozen files are path writes; a
        // branch checkout remains a known gap.
        paths.filter((path) => separator >= 0 || known(path)).forEach((path) => add(path, 'changed', dir, true));
      } else if (['restore', 'rm'].includes(subcommand)) {
        const flags = separator >= 0 ? rest.slice(0, separator) : rest;
        const staged = flags.some((arg) => arg === '--staged' || /^-[^-]*S/.test(arg));
        const worktree = flags.some((arg) => arg === '--worktree' || /^-[^-]*W/.test(arg));
        if (subcommand !== 'restore' || !staged || worktree) {
          const recursive = subcommand === 'restore' || flags.some((arg) => arg === '--recursive' || /^-[^-]*r/.test(arg));
          operands(rest, ['--source', '-s', '--pathspec-from-file']).forEach((path) => add(path, subcommand === 'rm' ? 'deleted' : 'changed', dir, recursive));
        }
      } else if (subcommand === 'mv') nested(['mv', ...rest].map(quoteWord).join(' '), dir);
    } else if (['tee', 'cp', 'mv', 'install', 'ln', 'rm', 'truncate', 'touch'].includes(cmd) || inPlace(cmd, args)) {
      const paths = writeOperands(cmd, args);
      const flags = args.slice(0, args.indexOf('--') < 0 ? undefined : args.indexOf('--'));
      // Whether the writer can write a directory, so a missing target may have held frozen tests.
      const directory = cmd === 'mv' || (cmd === 'rm' && flags.some((arg) => arg === '--recursive' || /^-[^-]*[rR]/.test(arg)))
        || (cmd === 'cp' && flags.some((arg) => ['--recursive', '--archive'].includes(arg) || /^-[^-]*[rRa]/.test(arg)))
        || (cmd === 'install' && flags.some((arg) => arg === '--directory' || /^-[^-]*d/.test(arg)));
      if (['cp', 'mv', 'install', 'ln'].includes(cmd)) {
        const targetAt = args.findIndex((arg) => arg === '-t' || arg === '--target-directory' || arg.startsWith('--target-directory='));
        const target = targetAt < 0 ? paths.at(-1) : args[targetAt].split('=')[1] ?? args[targetAt + 1];
        const sources = paths.slice(0, targetAt < 0 ? -1 : undefined);
        if (target) {
          for (const dest of expand(target)) {
            if (existsSync(dest) && statSync(dest).isDirectory()) {
              for (const original of sources) {
                // The name written in a directory comes from the source.
                if (nonliteral(original)) {
                  unread(`${target} ${spanOf(original)}`, 'a non-literal source copied into a directory');
                  continue;
                }
                for (const source of expand(original, cwd, true)) {
                  add(resolve(dest, basename(source)));
                  for (const file of under(source)) add(resolve(dest, basename(source), relative(source, file.path)));
                }
              }
            } else add(dest, 'changed', cwd, directory);
          }
        }
        if (cmd === 'mv') sources.forEach((path) => add(path, 'deleted', cwd, true));
      } else paths.forEach((path) => add(path, cmd === 'rm' ? 'deleted' : 'changed', cwd, directory));
    }
    if (['node', 'python', 'perl', 'ruby'].includes(cmd) || /^python\d+(?:\.\d+)*$/.test(cmd)) {
      const values = cmd === 'node' ? ['-r', '--require', '--import'] : cmd.startsWith('python') ? ['-W', '-X'] : ['-I'];
      const script = scriptOf(args, cmd === 'node' ? ['-e', '--eval', '-p', '--print'] : cmd.startsWith('python') ? ['-c'] : ['-e'], values);
      if (script !== undefined) inline(script);
      stdin.forEach(inline);
    }
    piped = pipe ? found : undefined;
  };
  const safeRead = (pipe, toWriter) => {
    try { read(pipe, toWriter); } catch (failure) {
      error(failure);
      words = [];
      redirects = [];
      bodies = [];
      strings = [];
      substitutions = [];
      piped = undefined;
    }
  };
  const parts = tokens(command, error, check);
  const note = (index) => { substitutions.push(...(parts.substitutions.get(index) ?? [])); };
  // Whether a pipe from here reaches a command that writes before the next command separator.
  const feedsWriter = (from) => {
    let words = [];
    for (let j = from; j <= parts.length; j += 1) {
      const part = parts[j];
      if (typeof part === 'string') words.push(part);
      else if (part && REDIRECTS.includes(part.op)) j += 1;
      else {
        if (words.length && writes(words)) return true;
        if (part?.op !== '|') return false;
        words = [];
      }
    }
    return false;
  };
  let segments = 0;
  const segment = (pipe, toWriter) => {
    safeRead(pipe, toWriter);
    // Test-only knob (GUARD_TESTS_TEST_THROW): a deciding exception after the first segment.
    if (options.testThrow && depth === 0 && (segments += 1) === 1) throw new Error('injected deciding exception (GUARD_TESTS_TEST_THROW)');
  };
  for (let i = 0; i < parts.length; i += 1) {
    check();
    const token = parts[i];
    if (typeof token === 'string') {
      words.push(token);
      note(i);
    } else if (REDIRECTS.includes(token.op)) {
      const path = parts[i + 1];
      if (typeof path === 'string') {
        i += 1;
        note(i);
        if (['>', '>>', '&>', '&>>', '>|', '<>'].includes(token.op) || (token.op === '>&' && !/^(?:\d+|-)$/.test(path))) redirects.push(path);
        if (token.op === '<<<') strings.push(path);
        if (token.body !== undefined) bodies.push(token.body);
        if (token.inner) substitutions.push(...token.inner);
      }
    } else {
      segment(token.op === '|', token.op === '|' ? () => feedsWriter(i + 1) : undefined);
      if (token.op === '(') stack.push({ cwd, previous, unknownCwd, directoryStack: [...directoryStack] });
      if (token.op === ')' && stack.length) ({ cwd, previous, unknownCwd, directoryStack } = stack.pop());
    }
  }
  segment(false);
  return [...new Set(results)];
}
