// Common Bash writes read as words, never executed (ADR 0002, ADR 0033).
// Targets and find results are compared with the oracle inventory, never a
// recursive filesystem walk. Unread forms pass; a failed segment does not
// discard other findings. This is a safety net, not a shell interpreter.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { gitCommand, program } from './commands.mjs';
import { globToRegExp } from './oracle.mjs';

// Keep quoted scripts literal and attach heredoc bodies to their input
// operator. An unread input must not swallow later command segments.
function tokens(command, error) {
  const result = [];
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
    } else if (quote === '"') {
      if (ch === quote) quote = undefined;
      else word += ch;
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

function braces(path) {
  const match = /\{([^{}]*,[^{}]*)\}/.exec(path);
  return match ? match[1].split(',').flatMap((part) => braces(path.slice(0, match.index) + part + path.slice(match.index + match[0].length))) : [path];
}

const absolute = (cwd, path) => resolve(cwd, path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path);
const beneath = (dir, path) => path === dir || path.startsWith(`${dir}${sep}`);
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

function scriptOf(args, flags) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (flags.includes(arg)) return args[i + 1];
    const long = flags.find((flag) => flag.startsWith('--') && arg.startsWith(`${flag}=`));
    if (long) return arg.slice(long.length + 1);
    // Script-taking short flags end a cluster: -pe SCRIPT, -we SCRIPT,
    // -lc SCRIPT. The rest, when present, is the script itself.
    if (/^-[^-]/.test(arg) && !/^-[MIF]/.test(arg)) {
      const at = [...arg].findIndex((ch, index) => index > 0 && flags.includes(`-${ch}`));
      if (at > 0) {
        const tail = arg.slice(at + 1);
        return tail && ![...tail].every((ch) => flags.includes(`-${ch}`)) ? tail : args[i + 1];
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

function unwrap(words) {
  for (;;) {
    const cmd = program(words[0]);
    if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(words[0] ?? '') || ['then', 'do', 'else', '{', '!', 'time'].includes(cmd)) words.shift();
    else if (['sudo', 'nohup', 'exec', 'command', 'env'].includes(cmd)) {
      words.shift();
      const values = cmd === 'sudo' ? ['-u', '-g', '-h', '-p'] : cmd === 'env' ? ['-u', '--unset', '-C', '--chdir'] : [];
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

// Each result is an absolute candidate path. The caller supplies the oracle
// inventory and records each write immediately, before later work can fail.
export function shellWrites(command, cwd, options = {}, depth = 0) {
  if (depth > 8) return [];
  cwd = realpathSync(cwd);
  const results = [];
  const error = options.error ?? (() => {});
  const inventory = (dir = cwd) => options.files?.(dir) ?? [];
  const emit = (path, action) => {
    results.push(path);
    options.write?.(path, action);
  };
  const expand = (path, dir = cwd) => {
    if (!path || /[$`]/.test(path)) return [];
    return braces(path).flatMap((part) => {
      const target = absolute(dir, part);
      return /[*?]/.test(target)
        ? inventory(dir).filter((file) => globToRegExp(target).test(file.path)).map((file) => file.path)
        : [target];
    });
  };
  const add = (path, action = 'changed', dir = cwd) => {
    for (const target of expand(path, dir)) {
      const files = inventory(dir).filter((file) => beneath(target, file.path));
      if (files.length) files.forEach((file) => emit(file.path, action));
      else if (!existsSync(target) || !statSync(target).isDirectory()) emit(target, action);
    }
  };
  const nested = (script, dir = cwd) => results.push(...shellWrites(script, dir, options, depth + 1));
  const inline = (script) => {
    const names = script.split(/[\s'"`(){}\[\],;=]+/).filter((name) => name && name !== '.' && !/[*?$`]/.test(name));
    for (const file of inventory()) {
      if (file.test && names.some((name) => absolute(cwd, name) === file.path || absolute(file.root, name) === file.path)) emit(file.path, 'changed');
    }
  };
  const stack = [];
  let words = [];
  let redirects = [];
  let bodies = [];
  let piped;
  const read = (pipe) => {
    const current = unwrap(words);
    const outputs = redirects;
    const stdin = bodies;
    words = [];
    redirects = [];
    bodies = [];
    for (const path of outputs) add(path);
    const cmd = program(current[0]);
    const args = current.slice(1);
    let found = piped;
    if (cmd === 'cd' && args.length === 1 && !/[$`]/.test(args[0])) cwd = realpathSync(absolute(cwd, args[0]));
    else if (['bash', 'sh', 'zsh'].includes(cmd)) {
      const script = scriptOf(args, ['-c']);
      if (script !== undefined) nested(script);
      stdin.forEach((body) => nested(body));
    } else if (cmd === 'find') {
      const start = args.findIndex((arg) => arg.startsWith('-') || arg === '(' || arg === '!');
      const roots = args.slice(0, start < 0 ? args.length : start);
      const exec = args.findIndex((arg) => arg === '-exec' || arg === '-execdir');
      const predicates = args.slice(start < 0 ? args.length : start, exec < 0 ? undefined : exec);
      // Unsupported predicates are a named gap, rather than an overestimate
      // that could turn a directory-only search into a frozen-file deletion.
      let supported = true;
      let name;
      for (let i = 0; i < predicates.length; i += 1) {
        const arg = predicates[i];
        if (arg === '-name') name = predicates[++i];
        else if (arg === '-type') supported &&= predicates[++i] === 'f';
        else if (!['-delete', '-print', '-print0', '-depth'].includes(arg)) supported = false;
      }
      found = supported && (pipe || exec >= 0 || args.includes('-delete'))
        ? inventory().filter((file) => (roots.length ? roots : ['.']).some((root) => beneath(absolute(cwd, root), file.path))
          && (!name || globToRegExp(name).test(basename(file.path)))).map((file) => file.path) : [];
      if (args.includes('-delete')) found.forEach((path) => emit(path, 'deleted'));
      if (exec >= 0) {
        const rest = args.slice(exec + 1);
        const end = rest.findIndex((arg) => arg === ';' || arg === '+');
        for (const path of found) {
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
        else if (arg.startsWith('-I')) replacement = arg.slice(2);
        else if (arg.startsWith('--replace=')) replacement = arg.slice('--replace='.length);
        else if (['-n', '-L', '-P', '-s', '-E', '-d', '-a', '--max-args', '--max-lines', '--max-procs', '--max-chars', '--eof', '--delimiter', '--arg-file'].includes(arg)) i += 1;
      }
      if (!piped) nested(args.slice(i).map(quoteWord).join(' '));
      for (const path of piped ?? []) {
        const invocation = args.slice(i);
        nested((replacement ? invocation.map((arg) => arg.replaceAll(replacement, path)) : [...invocation, path]).map(quoteWord).join(' '));
      }
    } else if (cmd === 'git') {
      const { subcommand, rest, directories } = gitCommand(args);
      const dir = directories.reduce((base, path) => absolute(base, path), cwd);
      const separator = rest.indexOf('--');
      if (subcommand === 'checkout') {
        const paths = separator >= 0 ? rest.slice(separator + 1) : operands(rest);
        // A branch checkout is not a path write. Only an exact frozen path
        // without -- is read; switching branches remains a known gap.
        paths.filter((path) => separator >= 0 || inventory(dir).some((file) => file.path === absolute(dir, path))).forEach((path) => add(path, 'changed', dir));
      } else if (['restore', 'rm'].includes(subcommand)) {
        operands(rest, ['--source', '-s', '--pathspec-from-file']).forEach((path) => add(path, subcommand === 'rm' ? 'deleted' : 'changed', dir));
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
              for (const source of sources.flatMap((path) => expand(path))) {
                add(resolve(dest, basename(source)));
                for (const file of inventory().filter((file) => beneath(source, file.path))) add(resolve(dest, basename(source), relative(source, file.path)));
              }
            } else add(dest);
          }
        }
        if (cmd === 'mv') sources.forEach((path) => add(path, 'deleted'));
      } else paths.forEach((path) => add(path, cmd === 'rm' ? 'deleted' : 'changed'));
    }
    if (['node', 'python', 'perl', 'ruby'].includes(cmd) || /^python\d+(?:\.\d+)*$/.test(cmd)) {
      const script = scriptOf(args, cmd === 'node' ? ['-e', '--eval', '-p', '--print'] : cmd.startsWith('python') ? ['-c'] : ['-e']);
      if (script !== undefined) inline(script);
      stdin.forEach(inline);
    }
    piped = pipe ? found : undefined;
  };
  const safeRead = (pipe) => {
    try { read(pipe); } catch (failure) {
      error(failure);
      words = [];
      redirects = [];
      bodies = [];
      piped = undefined;
    }
  };
  const parts = tokens(command, error);
  for (let i = 0; i < parts.length; i += 1) {
    const token = parts[i];
    if (typeof token === 'string') words.push(token);
    else if (['>', '>>', '&>', '&>>', '>|', '<', '<<', '<<-', '<<<', '<>', '>&', '<&'].includes(token.op)) {
      const path = parts[i + 1];
      if (typeof path === 'string') {
        i += 1;
        if (['>', '>>', '&>', '&>>', '>|', '<>'].includes(token.op) || (token.op === '>&' && !/^(?:\d+|-)$/.test(path))) redirects.push(path);
        if (token.body !== undefined) bodies.push(token.body);
      }
    } else {
      safeRead(token.op === '|');
      if (token.op === '(') stack.push(cwd);
      if (token.op === ')' && stack.length) cwd = stack.pop();
    }
  }
  safeRead(false);
  return [...new Set(results)];
}
