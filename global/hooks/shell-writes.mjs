// Common Bash writes read as words, never executed (ADR 0002, ADR 0033).
// This is a safety net, not a shell: unread forms and computed paths are gaps.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, parse, relative, resolve } from 'node:path';
import { gitCommand, program } from './commands.mjs';
import { globToRegExp } from './oracle.mjs';

// Quotes keep operators inside scripts and filenames literal. Heredoc bodies
// are data; only their command line can name an output redirection.
function tokens(command) {
  const result = [];
  let word = '';
  let started = false;
  let quote;
  let heredoc = false;
  const delimiters = [];
  const finish = () => {
    if (started) {
      result.push(word);
      if (heredoc) delimiters.push(word);
      heredoc = false;
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
      if (next === undefined) return [];
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
    } else if (ch === '#' && !started) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i += 1;
    } else if (/[;&|()< >\n]/.test(ch) && ch !== ' ') {
      finish();
      const op = /^(?:&>>|&>|>&|<&|>>|>\||<<-?|&&|\|\||[;&|()<>\n])/.exec(command.slice(i))?.[0];
      if (!op) return [];
      result.push({ op });
      i += op.length - 1;
      if (op.startsWith('<<')) heredoc = true;
      if (op === '\n') {
        for (const delimiter of delimiters.splice(0)) {
          let found = false;
          while (i + 1 < command.length) {
            const end = command.indexOf('\n', i + 1);
            const line = command.slice(i + 1, end < 0 ? command.length : end);
            i = end < 0 ? command.length : end;
            if (line.replace(/^\t+/, '') === delimiter) {
              found = true;
              break;
            }
          }
          if (!found) return [];
        }
      }
    } else if (/\s/.test(ch)) finish();
    else {
      word += ch;
      started = true;
    }
  }
  if (quote) return [];
  finish();
  return result;
}

function entries(path) {
  return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.name !== '.git');
}

// Expand only on-disk globs, without invoking a shell or following directory
// symlinks during a recursive walk.
function expand(cwd, path) {
  if (!path || /[$`]/.test(path)) return [];
  const absolute = resolve(cwd, path);
  if (!/[*?]/.test(absolute)) return [absolute];
  let paths = [parse(absolute).root];
  for (const part of absolute.slice(parse(absolute).root.length).split('/')) {
    paths = paths.flatMap((dir) => {
      if (!/[*?]/.test(part)) return [join(dir, part)].filter(existsSync);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
      const matcher = globToRegExp(part);
      return entries(dir).filter((entry) => matcher.test(entry.name)).map((entry) => join(dir, entry.name));
    });
  }
  return paths;
}

function descendants(path) {
  if (!existsSync(path) || !statSync(path).isDirectory()) return [path];
  return entries(path).flatMap((entry) => entry.isDirectory()
    ? descendants(join(path, entry.name)) : [join(path, entry.name)]);
}

// Positional operands of the common writers, with their value-taking options.
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
    if (flags.includes(args[i])) return args[i + 1];
    const flag = flags.find((f) => args[i].startsWith(`${f}=`));
    if (flag) return args[i].slice(flag.length + 1);
  }
  return undefined;
}

function inPlace(cmd, args) {
  if (cmd === 'sed') return args.some((a) => /^-i|^--in-place(?:=|$)/.test(a));
  return ['perl', 'ruby'].includes(cmd) && args.some((a) => /^-[^-]*i/.test(a));
}

function writer(cmd, args) {
  return ['tee', 'cp', 'mv', 'install', 'rm', 'truncate'].includes(cmd)
    || (cmd === 'ln' && args.some((a) => a === '--force' || /^-[^-]*f/.test(a)))
    || inPlace(cmd, args);
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
      if (/^-[^-]*e$/.test(arg)) i += 1;
      else if (!arg.startsWith('-')) files.push(arg);
    }
    return files;
  }
  const values = cmd === 'install' ? ['-m', '--mode', '-o', '--owner', '-g', '--group', '-t', '--target-directory']
    : cmd === 'truncate' ? ['-s', '--size', '-r', '--reference']
      : ['cp', 'mv', 'ln'].includes(cmd) ? ['-t', '--target-directory', '-S', '--suffix'] : [];
  return operands(args, values);
}

// Each result is an absolute candidate path. Repository and oracle binding
// belong to the caller, including commands that cd or use git -C elsewhere.
export function shellWrites(command, cwd, depth = 0) {
  if (depth > 8) return [];
  const results = [];
  const stack = [];
  let words = [];
  let redirects = [];
  let piped;
  const add = (path, dir = cwd) => {
    for (const expanded of expand(dir, path)) results.push(...descendants(expanded));
  };
  const read = (pipe) => {
    for (const path of redirects) add(path);
    redirects = [];
    while (/^[A-Za-z_][A-Za-z_0-9]*=/.test(words[0] ?? '')) words.shift();
    if (['command', 'env'].includes(program(words[0]))) words.shift();
    const cmd = program(words[0]);
    const args = words.slice(1);
    words = [];
    let found;
    if (cmd === 'cd' && args.length === 1 && !/[$`]/.test(args[0])) cwd = resolve(cwd, args[0]);
    else if (['bash', 'sh'].includes(cmd)) {
      const script = scriptOf(args, ['-c']);
      if (script !== undefined) results.push(...shellWrites(script, cwd, depth + 1));
    } else if (cmd === 'find') {
      const start = args.findIndex((a) => a.startsWith('-') || a === '(' || a === '!');
      const roots = args.slice(0, start < 0 ? args.length : start);
      const exec = args.findIndex((a) => a === '-exec' || a === '-execdir');
      if (args.includes('-delete') || exec >= 0 || pipe) {
        found = (roots.length ? roots : ['.']).flatMap((path) => expand(cwd, path).flatMap(descendants));
        const name = args.indexOf('-name');
        if (name >= 0 && args[name + 1]) found = found.filter((path) => globToRegExp(args[name + 1]).test(basename(path)));
        if (args.includes('-delete')) results.push(...found);
        if (exec >= 0) {
          const nested = args.slice(exec + 1);
          const end = nested.findIndex((a) => a === ';' || a === '+');
          for (const path of found) {
            const dir = args[exec] === '-execdir' ? dirname(path) : cwd;
            const replacement = args[exec] === '-execdir' ? `./${basename(path)}` : path;
            results.push(...shellWrites((end < 0 ? nested : nested.slice(0, end))
              .map((a) => `'${a.replaceAll('{}', replacement).replaceAll("'", "'\\''")}'`).join(' '), dir, depth + 1));
          }
        }
      }
    } else if (cmd === 'xargs' && piped) {
      const at = args.findIndex((a, i) => writer(program(a), args.slice(i + 1)));
      if (at >= 0) {
        for (const path of piped) results.push(...shellWrites([...args.slice(at), path]
          .map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(' '), cwd, depth + 1));
      }
    } else if (cmd === 'git') {
      const { subcommand, rest, directories } = gitCommand(args);
      const dir = directories.reduce((base, path) => resolve(base, path), cwd);
      const separator = rest.indexOf('--');
      if (subcommand === 'checkout' && separator >= 0) rest.slice(separator + 1).forEach((path) => add(path, dir));
      else if (['restore', 'rm'].includes(subcommand)) {
        operands(rest, ['--source', '-s', '--pathspec-from-file']).forEach((path) => add(path, dir));
      }
    } else if (writer(cmd, args)) {
      const paths = writeOperands(cmd, args);
      if (['cp', 'mv', 'install', 'ln'].includes(cmd)) {
        const targetAt = args.findIndex((a) => a === '-t' || a === '--target-directory' || a.startsWith('--target-directory='));
        const target = targetAt < 0 ? paths.at(-1) : args[targetAt].split('=')[1] ?? args[targetAt + 1];
        if (target) {
          for (const dest of expand(cwd, target)) {
            if (existsSync(dest) && statSync(dest).isDirectory()) {
              for (const source of paths.slice(0, targetAt < 0 ? -1 : undefined)) {
                for (const file of expand(cwd, source)) {
                  for (const child of descendants(file)) add(join(dest, basename(file), relative(file, child)));
                }
              }
            } else add(dest);
          }
        }
        if (cmd === 'mv') paths.slice(0, -1).forEach((path) => add(path));
      } else paths.forEach((path) => add(path));
    }
    if (['node', 'python', 'python3', 'perl', 'ruby'].includes(cmd)) {
      const script = scriptOf(args, cmd === 'node' ? ['-e', '--eval', '-p', '--print'] : cmd.startsWith('python') ? ['-c'] : ['-e']);
      if (script !== undefined) {
        // An inline script naming a path asks even if it only reads (ADR 0033).
        for (const path of script.split(/[\s'"`(){}\[\],;=]+/)) add(path);
      }
    }
    piped = pipe ? found : undefined;
  };
  const parts = tokens(command);
  for (let i = 0; i < parts.length; i += 1) {
    const token = parts[i];
    if (typeof token === 'string') words.push(token);
    else if (['>', '>>', '&>', '&>>', '>|', '<', '<<', '<<-', '>&', '<&'].includes(token.op)) {
      const path = parts[++i];
      if (typeof path !== 'string') return results;
      if (['>', '>>', '&>', '&>>', '>|'].includes(token.op)) redirects.push(path);
    } else {
      read(token.op === '|');
      if (token.op === '(') stack.push(cwd);
      if (token.op === ')' && stack.length) cwd = stack.pop();
    }
  }
  read(false);
  return [...new Set(results)];
}
