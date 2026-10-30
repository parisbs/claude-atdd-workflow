// Common Bash writes read as words, never executed (ADR 0002, ADR 0033).
// Targets and find results are compared with the oracle inventory, never a
// recursive filesystem walk. What it does not read goes to options.unread, and
// a failure to options.error; the caller decides whether that names a frozen
// or configuration path (ADR 0034). A program it does not know is not a span,
// and a failed segment does not discard other findings. This is a safety net,
// not a shell interpreter.
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { gitCommand, program } from './commands.mjs';
import { globToRegExp } from './oracle.mjs';
import { realPath } from './codex.mjs';

// The index of the character that closes the substitution opened at `start`
// (`$(` or a backtick), or -1. Parentheses nest; quotes and escapes are skipped.
function substitutionEnd(command, start) {
  if (command[start] === '`') {
    for (let i = start + 1; i < command.length; i += 1) {
      if (command[i] === '\\') i += 1;
      else if (command[i] === '`') return i;
    }
    return -1;
  }
  let depth = 1;
  for (let i = start + 2; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === '\\') i += 1;
    else if (ch === "'") {
      i = command.indexOf("'", i + 1);
      if (i < 0) return -1;
    } else if (ch === '"') {
      for (i += 1; i < command.length && command[i] !== '"'; i += 1) if (command[i] === '\\') i += 1;
    } else if (ch === '(') depth += 1;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

// Keep quoted scripts literal and attach heredoc bodies to their input
// operator. An unread input must not swallow later command segments. A command
// substitution stays whole inside its word; `result.substitutions` maps the
// index of that word to the text of each substitution in it.
function tokens(command, error, check) {
  const result = [];
  result.substitutions = new Map();
  let word = '';
  let started = false;
  let quote;
  let heredoc;
  const pending = [];
  const finish = () => {
    if (started) {
      result.push(word);
      if (heredoc) pending.push({ token: heredoc, delimiter: word });
      heredoc = undefined;
    }
    word = '';
    started = false;
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
      if (j >= command.length) error(new Error('unterminated shell quote'));
      i = j;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
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
        for (const { token: input, delimiter } of pending.splice(0)) {
          const start = i + 1;
          let cursor = start;
          let found = false;
          while (cursor < command.length) {
            const end = command.indexOf('\n', cursor);
            const line = command.slice(cursor, end < 0 ? command.length : end);
            if ((input.op === '<<-' ? line.replace(/^\t+/, '') : line) === delimiter) {
              input.body = command.slice(start, cursor);
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

// Each result is an absolute candidate path. The caller supplies the oracle
// inventory and records each write immediately, before later work can fail.
// Text it does not read goes to options.unread(span, part), silently.
export function shellWrites(command, cwd, options = {}, depth = 0, unknown = false) {
  const unread = (span, part) => options.unread?.(span, part);
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
  let unknownCwd = unknown;
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
      if (!reading) unread(spanOf(path), 'a non-literal write target');
      return [];
    }
    if (!reading && BRACE_RANGE.test(path)) {
      unread(path, 'a brace range');
      return [];
    }
    if (!reading && unknownCwd && dir === cwd && !isAbsolute(path) && path !== '~' && !path.startsWith('~/')) {
      unread(path, 'a write after a cd to a directory the guard cannot resolve');
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
        unread(path, 'the oracle file list could not be read');
        return [];
      }
      const candidates = [...(files.byDirectory?.keys() ?? []), ...(files.byPath?.keys() ?? [])];
      return candidates.filter((path) => { check(); return re.test(path); });
    });
  };
  // The inventory is consulted for a directory, and for a target that does not exist and
  // can hold tests; any other target is recorded by its path.
  const add = (path, action = 'changed', dir = cwd) => {
    for (const target of expand(path, dir)) {
      const exists = existsSync(target);
      const directory = exists && statSync(target).isDirectory();
      const files = directory || (!exists && options.mayHoldTests?.(target)) ? under(target) : [];
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
  const read = (pipe, toXargs) => {
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
          // A relative operand cannot be resolved against a directory that is unknown.
          if (!resolvable || (unknownCwd && !isAbsolute(operand) && operand !== '~' && !operand.startsWith('~/'))) unknownCwd = true;
          else {
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
      for (let i = 0; i < predicates.length; i += 1) {
        const arg = predicates[i];
        if (arg === '-name') name = predicates[++i];
        else if (arg === '-type') supported &&= predicates[++i] === 'f';
        else if (!['-delete', '-print', '-print0', '-depth'].includes(arg)) supported = false;
      }
      const writes = exec >= 0 || args.includes('-delete');
      if (!supported && (writes || toXargs)) unread([...roots, ...predicates].join(' '), 'a find expression the guard does not read');
      const namePattern = name && globToRegExp(name);
      const candidates = new Map();
      if (supported && (pipe || writes)) {
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
          unread(path, 'the oracle file list could not be read');
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
        paths.filter((path) => separator >= 0 || known(path)).forEach((path) => add(path, 'changed', dir));
      } else if (['restore', 'rm'].includes(subcommand)) {
        const flags = separator >= 0 ? rest.slice(0, separator) : rest;
        const staged = flags.some((arg) => arg === '--staged' || /^-[^-]*S/.test(arg));
        const worktree = flags.some((arg) => arg === '--worktree' || /^-[^-]*W/.test(arg));
        if (subcommand !== 'restore' || !staged || worktree) {
          operands(rest, ['--source', '-s', '--pathspec-from-file']).forEach((path) => add(path, subcommand === 'rm' ? 'deleted' : 'changed', dir));
        }
      } else if (subcommand === 'mv') nested(['mv', ...rest].map(quoteWord).join(' '), dir);
    } else if (['tee', 'cp', 'mv', 'install', 'ln', 'rm', 'truncate', 'touch'].includes(cmd) || inPlace(cmd, args)) {
      const paths = writeOperands(cmd, args);
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
            } else add(dest);
          }
        }
        if (cmd === 'mv') sources.forEach((path) => add(path, 'deleted'));
      } else paths.forEach((path) => add(path, cmd === 'rm' ? 'deleted' : 'changed'));
    }
    if (['node', 'python', 'perl', 'ruby'].includes(cmd) || /^python\d+(?:\.\d+)*$/.test(cmd)) {
      const values = cmd === 'node' ? ['-r', '--require', '--import'] : cmd.startsWith('python') ? ['-W', '-X'] : ['-I'];
      const script = scriptOf(args, cmd === 'node' ? ['-e', '--eval', '-p', '--print'] : cmd.startsWith('python') ? ['-c'] : ['-e'], values);
      if (script !== undefined) inline(script);
      stdin.forEach(inline);
    }
    piped = pipe ? found : undefined;
  };
  const safeRead = (pipe, toXargs) => {
    try { read(pipe, toXargs); } catch (failure) {
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
  // Whether a pipe from here reaches xargs before the next command separator.
  const feedsXargs = (from) => {
    for (let j = from; j < parts.length; j += 1) {
      if (typeof parts[j] === 'string') {
        if (program(parts[j]) === 'xargs') return true;
      } else if (parts[j].op !== '|' && !REDIRECTS.includes(parts[j].op)) return false;
    }
    return false;
  };
  let segments = 0;
  const segment = (pipe, toXargs) => {
    safeRead(pipe, toXargs);
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
      }
    } else {
      segment(token.op === '|', token.op === '|' && feedsXargs(i + 1));
      if (token.op === '(') stack.push({ cwd, previous, unknownCwd, directoryStack: [...directoryStack] });
      if (token.op === ')' && stack.length) ({ cwd, previous, unknownCwd, directoryStack } = stack.pop());
    }
  }
  segment(false, false);
  return [...new Set(results)];
}
