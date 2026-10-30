// Issue #77: exercise the installed frozen-test gate in offline repositories.
// Commands are hook input only; they are never executed. Measurement (AC-21)
// and amending the earlier oracle (AC-22) are separate.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { SETTINGS, runConfigured } from './claude-hooks.mjs';
import { writeExecutable } from './executables.mjs';

const TAG = 'oracle/feature/x';
const FILE = 'tests/a.test.mjs';
const SESSIONS = [
  ['main', { permission_mode: 'default' }],
  ['subagent', { permission_mode: 'default', agent_id: 'issue-77' }],
  ['bypass', { permission_mode: 'bypassPermissions' }],
];
const SETTINGS_TESTS = { hooks: { PreToolUse: SETTINGS.hooks.PreToolUse
  .filter((entry) => entry.hooks.some((hook) => hook.command.includes('guard-tests.mjs'))) } };
let scratch, bin, dir, commit, realGit;
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
function git(cwd, ...args) {
  const r = spawnSync(realGit ?? 'git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, `fixture git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function put(root, path, content = 'x\n') {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
function repository(name, files = [FILE, 'tests/unit/b.test.mjs', 'package.json', 'src/x.js'], branch = 'feature/x') {
  const root = join(scratch, name);
  mkdirSync(root);
  git(root, 'init', '-q', '-b', branch);
  for (const [key, value] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.com', 'commit.gpgsign': 'false', 'tag.gpgsign': 'false' })) git(root, 'config', key, value);
  for (const file of files) put(root, file);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'test: freeze consequence gate fixture');
  git(root, 'tag', `oracle/${branch}`);
  return root;
}
before(() => {
  assert.notEqual(process.platform, 'win32', 'These hook integration tests require POSIX');
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'cw-consequence-')));
  bin = join(scratch, 'bin');
  mkdirSync(bin);
  const which = spawnSync('which', ['git'], { encoding: 'utf8' });
  assert.equal(which.status, 0, which.stderr);
  realGit = which.stdout.trim();
  writeExecutable(join(bin, 'gh'), '#!/bin/sh\n[ "$#" -gt 0 ] || exit 0\nexit 1\n');
  // Node is already available; the wrapper needs no extra runtime or packages.
  // Stalled descendants also have a finite lifetime if an assertion fails.
  writeExecutable(join(bin, 'git-case'), `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
if (!args.length) process.exit(0);
if (args[0] === 'ls-tree' && args.includes('-rz')) {
  if (process.env.CONSEQUENCE_TREE === 'fail') process.exit(1);
  if (process.env.CONSEQUENCE_TREE === 'oversized') {
    process.stdout.write(Buffer.alloc(65 * 1024 * 1024, 120));
    return;
  }
  if (process.env.CONSEQUENCE_TREE === 'stall') {
    fs.writeFileSync(process.env.CONSEQUENCE_PID, String(process.pid));
    process.on('SIGTERM', () => {});
    setTimeout(() => process.exit(0), 18000);
    return;
  }
  if (process.env.CONSEQUENCE_TREE === 'grandchild') {
    const child = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 18000)'], { stdio: ['ignore', 1, 2] });
    fs.writeFileSync(process.env.CONSEQUENCE_PID, String(child.pid));
    child.unref();
    process.exit(0);
  }
}
const r = cp.spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
`);
  writeExecutable(join(bin, 'git'), `#!/bin/sh
[ "$#" -gt 0 ] || exit 0
if [ -n "$CONSEQUENCE_LOG" ]; then printf '%s\\n' "$*" >> "$CONSEQUENCE_LOG"; fi
if [ "$1" = ls-tree ] && [ "$2" = -rz ] && [ -n "$CONSEQUENCE_TREE" ]; then
  exec ${quote(join(bin, 'git-case'))} "$@"
fi
exec ${quote(realGit)} "$@"
`);
  dir = repository('repo');
  commit = git(dir, 'rev-parse', TAG);
});
after(() => rmSync(scratch, { recursive: true, force: true }));
function run(command, session, { cwd = dir, env = {}, tool = 'Bash', input } = {}) {
  return runConfigured({ cwd, tool_name: tool, tool_input: input ?? { command }, ...session }, {
    settings: SETTINGS_TESTS, env: { PATH: `${bin}${delimiter}${process.env.PATH}`, ...env },
  });
}
// Keep the configured hook timeout unchanged. This outer watchdog also owns
// descendants, since killing /bin/sh alone need not close inherited pipes.
async function bounded(command, session, options = {}) {
  const event = { cwd: options.cwd ?? dir, tool_name: 'Bash', tool_input: { command }, ...session };
  const settings = { settings: SETTINGS_TESTS, env: { PATH: `${bin}${delimiter}${process.env.PATH}`, ...options.env } };
  const source = `import { runConfigured } from ${JSON.stringify(new URL('./claude-hooks.mjs', import.meta.url).href)};
process.stdout.write(JSON.stringify(runConfigured(${JSON.stringify(event)}, ${JSON.stringify(settings)})));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', expired = false;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } };
    const timer = setTimeout(() => { expired = true; kill(); }, 14000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      kill();
      if (expired) resolve({ failures: ['no verdict before the 14 s outer watchdog killed the process group'], stderr, ran: [] });
      else if (code !== 0) reject(new Error(`configured runner exited ${code}: ${stderr}`));
      else { try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); } }
    });
  });
}
function healthy(r) {
  assert.deepEqual(r.failures, [], `hook failed: ${r.failures.join('; ')} ${r.stderr}`);
  assert.ok(r.ran.some((s) => s.includes('guard-tests.mjs')), 'configured guard-tests entry ran');
}
function silent(r, visibleFailure = false) {
  healthy(r);
  assert.equal(r.explicit, false, r.reason);
  if (visibleFailure === true) assert.match(r.stderr, /could not evaluate|budget|injected/i);
  else if (visibleFailure !== 'optional') assert.equal(r.stderr, '');
}
function verdict(r, index, { path = FILE, tag = TAG, hash = commit, unread = false } = {}) {
  healthy(r);
  assert.equal(r.decision, index === 0 ? 'ask' : 'deny', `${r.reason} ${r.stderr}`);
  assert.ok(r.reason.includes(path), r.reason);
  assert.ok(r.reason.includes(tag), r.reason);
  assert.ok(r.reason.includes(hash), r.reason);
  if (index === 2) assert.match(r.reason, /switch to a mode that shows permission prompts/i);
  if (unread) {
    assert.match(r.reason, /(?:^|\s)Unread command at the frozen tests gate:/);
    assert.match(r.reason, /Canonical form:/);
  }
}
function rule(id, label, command, control, options = {}) {
  test(`${id} ${label}`, { timeout: 120000 }, async (t) => {
    for (const [i, [name, session]] of SESSIONS.entries()) {
      await t.test(`${id} ${name} rule`, () => verdict(run(command, session, options), i, { ...options, unread: options.unread ?? true }));
      await t.test(`${id} ${name} control`, () => silent(run(control, session, options), options.visibleFailure));
    }
  });
}
function known(id, label, command, options = {}) {
  test(`${id} ${label}`, { timeout: 120000 }, async (t) => {
    for (const [i, [name, session]] of SESSIONS.entries()) {
      await t.test(`${id} ${name}`, () => {
        const r = run(command, session, options);
        verdict(r, i, options);
        assert.equal(r.stderr, '', 'a supported form must not throw');
        assert.ok(r.reason.startsWith(`${options.path ?? FILE} would be`), r.reason);
      });
    }
  });
}

for (const command of [
  'cat tests/a.test.mjs', 'grep -rn x $(git ls-files tests)', 'node --test tests/',
  'git log -- tests/a.test.mjs', 'npm test 2>/dev/null',
  'echo "$(cat tests/a.test.mjs)" | wc -l', 'rg -n "tests/a.test.mjs" global',
  'myscript tests/a.test.mjs', 'prettier --write tests/a.test.mjs', 'npm run fix -- tests/a.test.mjs',
]) {
  const id = /^(myscript|prettier|npm run)/.test(command) ? 'AC-10' : 'AC-1';
  test(`${id} keeps ${command} silent`, async (t) => {
    for (const [name, session] of SESSIONS) await t.test(`${id} ${name}`, () => silent(run(command, session)));
  });
}
for (const [label, command] of [
  ['quoted path', 'eval \'rm "tests/a.test.mjs"\''],
  ['assignment value', 'T=tests/a.test.mjs; rm "$T"'],
  ['option value', 'eval rm --target=tests/a.test.mjs'],
  ['expansion suffix', 'rm "$ROOT/tests/a.test.mjs"'],
  ['directory', 'eval rm -rf tests'],
  ['configuration', 'eval rm package.json'],
]) rule('AC-2', `matches ${label} as a word`, command, command.replaceAll('tests/a.test.mjs', 'src/x.js').replace(/\btests\b/g, 'src').replaceAll('package.json', 'src/x.js'), { path: label === 'configuration' ? 'package.json' : FILE });
for (const command of [
  "cat > src/out <<'EOF'\nrm tests/a.test.mjs\nEOF",
  "tee src/out <<'EOF'\nrm tests/a.test.mjs\nEOF",
  ...['-m', '--message', '-t', '--title', '-b', '--body'].map((flag) => `echo ${flag} 'tests/a.test.mjs'`),
  'find . -type d -empty -delete',
]) test(`AC-2 excludes proven data and the repository root: ${command.split('\n')[0]}`, async (t) => {
  for (const [name, session] of SESSIONS) await t.test(`AC-2 ${name}`, () => silent(run(command, session)));
});
// After a deciding exception the trigger reads the whole command, so data must still not trigger.
for (const command of [
  "cat > src/out <<'EOF'\nrm tests/a.test.mjs\nEOF",
  ...['-m', '--message'].map((flag) => `git commit ${flag} 'fix tests/a.test.mjs'`),
  ...['-t', '--title', '-b', '--body'].map((flag) => `gh pr create ${flag} 'fix tests/a.test.mjs'`),
]) test(`AC-2/AC-3 excludes proven data after an exception: ${command.split('\n')[0]}`, async (t) => {
  for (const [name, session] of SESSIONS) await t.test(`AC-2 ${name}`, () => silent(run(command, session, { env: { GUARD_TESTS_TEST_THROW: '1' } }), true));
});
for (const [label, env] of [
  ['injected deciding exception', { GUARD_TESTS_TEST_THROW: '1' }],
  ['CPU exhaustion', { GUARD_TESTS_CPU_BUDGET_MS: '1' }],
  ['read deadline exhaustion', { GUARD_TESTS_GIT_BUDGET_MS: '1' }],
]) rule('AC-3 (H6/H12)', label, 'echo first; rm tests/a.test.mjs', 'echo first; echo hi > src/out', { env, visibleFailure: true });
for (const mode of ['fail', 'oversized']) {
  // A literal write to package.json is a read form that asks in every session (ADR 0033), so the
  // configuration case uses an unread form.
  for (const target of ['tests', FILE, 'package.json']) rule('AC-4 (H6)', `${mode} inventory protects ${target}`, `${target === 'package.json' ? 'eval ' : ''}rm -rf ${target}`, 'echo hi > /tmp/issue-77-out', {
    env: { CONSEQUENCE_TREE: mode }, path: target, unread: target !== FILE,
  });
}
const nested = (path) => {
  let command = `echo x > ${path}`;
  for (let i = 0; i < 10; i++) command = `bash -c ${quote(command)}`;
  return command;
};
for (const [label, make] of [
  ['substitution', (p) => `cat > "$(echo ${p})" <<< x`],
  ['backticks', (p) => `echo x > \`echo ${p}\``],
  ['eval', (p) => `eval 'echo x > ${p}'`],
  ['here-string interpreter', (p) => `python3 - <<< 'open("${p}","w")'`],
  ['depth limit', nested],
  ['unterminated quote', (p) => `echo 'unfinished; rm ${p}`],
  ['unterminated heredoc', (p) => `python3 - <<EOF\nopen('${p}', 'w')`],
  ['brace range', (p) => `rm ${p.replace('a.test', '{a..b}.test')}`],
]) rule('AC-5', `protects ${label}`, make(FILE), make('src/a.testless'), { visibleFailure: label.startsWith('unterminated') ? 'optional' : false });
for (const make of [
  (p) => `echo x > "$PWD/${p}"`, (p) => `T=${p}; echo x > "$T"`,
  ...['cp src/x.js', 'mv src/x.js', 'rm', 'tee', 'install src/x.js', 'ln src/x.js', 'truncate -s 0', 'touch', 'sed -i s/a/b/', 'perl -i -pe s/a/b/', 'ruby -i -pe gsub', 'git checkout --', 'git restore', 'git rm', 'git mv'].map((writer) => (p) => `${writer} "$PWD/${p}"${writer === 'git mv' ? ' src/out' : ''}`),
  (p) => `find "$PWD/${p}" -delete`,
]) rule('AC-6', `protects non-literal operand: ${make(FILE)}`, make(FILE), make('src/x.js'));
test('AC-6 keeps a read source with an unknown output silent', async (t) => {
  for (const [name, session] of SESSIONS) await t.test(`AC-6 ${name}`, () => silent(run('cat tests/a.test.mjs > "$OUT"', session)));
});
for (const prefix of ['cd "$D" &&', 'pushd "$D" &&', 'cd missing-directory &&', 'git -C "$R" checkout --', 'git --git-dir=.git checkout --', 'git --work-tree=. checkout --', 'GIT_DIR=.git git checkout --', 'GIT_WORK_TREE=. git checkout --']) {
  const make = (p) => `${prefix} ${prefix.endsWith('&&') ? 'rm ' : ''}${p}`;
  rule('AC-7 (H9)', `protects uncertain context: ${prefix}`, make(FILE), make('src/x.js'));
}
for (const expression of ['-newer src/x.js', '-type d -empty', '-path tests/a.test.mjs', '-name a.test.mjs -o -name b.test.mjs']) {
  rule('AC-8', `protects unsupported find ${expression}`, `find tests ${expression} -delete`, `find src ${expression.replaceAll('tests/a.test.mjs', 'src/x.js')} -delete`);
}
rule('AC-8', 'protects unsupported xargs option', 'echo tests/a.test.mjs | xargs --process-slot-var=SLOT rm', 'echo src/x.js | xargs --process-slot-var=SLOT rm');
rule('AC-9', 'retains collected verdicts and adds the unread remainder', 'echo x > tests/a.test.mjs; rm tests/unit/b.test.mjs', 'echo x > src/x.js; rm src/out', { env: { GUARD_TESTS_TEST_THROW: '1' }, visibleFailure: true });
test('AC-9 retains the first frozen reason as well as the unread second path', () => {
  const r = run('echo x > tests/a.test.mjs; rm tests/unit/b.test.mjs', SESSIONS[1][1], { env: { GUARD_TESTS_TEST_THROW: '1' } });
  verdict(r, 1);
  assert.match(r.reason, /a\.test\.mjs would be amended/);
  assert.match(r.reason, /Unread command at the frozen tests gate:/);
  assert.match(r.reason, /tests\/unit\/b\.test\.mjs/);
});
test('AC-11 configured Bash entry has no if and delivers the rule verdict', () => {
  const entries = SETTINGS_TESTS.hooks.PreToolUse.filter((e) => new RegExp(`^(?:${e.matcher})$`).test('Bash'));
  assert.ok(entries.length > 0);
  for (const entry of entries) for (const hook of entry.hooks) assert.equal(hook.if, undefined);
  verdict(run('eval "rm tests/a.test.mjs"', SESSIONS[0][1]), 0, { unread: true });
});
for (const command of ['echo hi > /dev/null', 'echo hi > /tmp/issue-77-out', 'echo hi >&2', 'echo hi > src/out']) {
  test(`AC-12 (H5) does not load inventory for ${command}`, () => {
    const log = join(scratch, 'lazy-log');
    writeFileSync(log, '');
    silent(run(command, SESSIONS[0][1], { env: { CONSEQUENCE_TREE: 'fail', CONSEQUENCE_LOG: log } }));
    const calls = readFileSync(log, 'utf8');
    assert.doesNotMatch(calls, /ls-tree -rz/);
  });
}
test('AC-12 (H5) does not load inventory for an ordinary Edit', () => {
  const log = join(scratch, 'edit-log');
  writeFileSync(log, '');
  silent(run('', SESSIONS[0][1], { tool: 'Edit', input: { file_path: join(dir, 'src/x.js'), old_string: 'x', new_string: 'y' }, env: { CONSEQUENCE_TREE: 'fail', CONSEQUENCE_LOG: log } }));
  assert.doesNotMatch(readFileSync(log, 'utf8'), /ls-tree -rz/);
});
test('AC-13 (H7) puts the frozen deny before 22 configuration reasons and counts omissions', () => {
  const configs = Array.from({ length: 22 }, (_, i) => `packages/p${i}/package.json`);
  const r = run(`touch ${configs.join(' ')} ${FILE}`, SESSIONS[1][1]);
  verdict(r, 1);
  assert.ok(r.reason.indexOf(FILE) < r.reason.indexOf('package.json'), r.reason);
  assert.match(r.reason, /3 more paths/);
});
test('AC-14 (H8) six wildcards against a 200-character frozen name finish with a verdict', { timeout: 30000 }, async () => {
  const root = repository('glob', [`tests/${'a'.repeat(200)}`, 'tests/aaaaab']);
  const started = performance.now();
  const r = await bounded('rm tests/*a*a*a*a*a*b', SESSIONS[0][1], { cwd: root });
  assert.ok(performance.now() - started < 14000, 'verdict must arrive within the 10 s deadline plus margin');
  verdict(r, 0, { path: 'tests/aaaaab', hash: git(root, 'rev-parse', TAG) });
});
known('AC-15 (H9)', 'mkdir -pv tracks missing parents', 'mkdir -pv tests/new/deep && cd tests/new/deep && printf x > c.test.mjs', { path: 'tests/new/deep/c.test.mjs' });
known('AC-15 (H9)', 'cd - restores the prior directory', 'cd src; cd -; rm tests/a.test.mjs');
rule('AC-15 (H9)', 'unknown prior directory is unread', 'cd -; rm tests/a.test.mjs', 'cd -; rm src/x.js');
known('AC-15 (H9)', 'subshell pushd leaves the outer stack intact', 'pushd tests; (pushd unit); popd; rm tests/a.test.mjs');
known('AC-16 (H10)', 'reads ANSI-C quoting and keeps the later rm', "echo $'it\\'s'; rm tests/a.test.mjs");
for (const mode of ['stall', 'grandchild']) {
  test(`AC-17 (H8/H12) ${mode} cannot hold the hook past its deadline`, { timeout: 90000 }, async (t) => {
    for (const [i, [name, session]] of SESSIONS.entries()) await t.test(`AC-17 ${name} ${mode}`, async () => {
      const pidFile = join(scratch, `pid-${name}-${mode}`);
      const started = performance.now();
      let r;
      try {
        r = await bounded('rm tests/a.test.mjs', session, { env: { CONSEQUENCE_TREE: mode, CONSEQUENCE_PID: pidFile, GUARD_TESTS_GIT_TIMEOUT_MS: '1000', GUARD_TESTS_GIT_BUDGET_MS: '2000' } });
        assert.ok(existsSync(pidFile), 'the stalled git fixture was reached');
        assert.ok(performance.now() - started < 14000, 'hook exceeded deadline plus margin');
        if (mode === 'stall') assert.throws(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0), { code: 'ESRCH' }, 'git ignoring SIGTERM must be killed');
        verdict(r, i);
      } finally {
        if (existsSync(pidFile)) {
          try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
        }
      }
    });
  });
}
test('AC-18 (H14) linked-worktree lookup uses a small constant number of git calls for 1 and 300 tags', { timeout: 60000 }, async (t) => {
  const root = repository('many-tags');
  const linked = join(scratch, 'linked');
  git(root, 'worktree', 'add', '-q', '--detach', linked, 'HEAD');
  const hash = git(root, 'rev-parse', TAG);
  for (const count of [1, 300]) {
    if (count === 300) {
      const input = Array.from({ length: 299 }, (_, i) => `create refs/tags/oracle/z${String(i).padStart(3, '0')} ${hash}\n`).join('');
      const update = spawnSync(realGit, ['update-ref', '--stdin'], { cwd: root, input, encoding: 'utf8' });
      assert.equal(update.status, 0, update.stderr);
    }
    await t.test(`AC-18 ${count} tags`, () => {
      const log = join(scratch, `tags-${count}.log`);
      writeFileSync(log, '');
      const started = performance.now();
      const r = run('rm tests/a.test.mjs', SESSIONS[0][1], { cwd: linked, env: { CONSEQUENCE_LOG: log } });
      const calls = readFileSync(log, 'utf8').trim().split('\n');
      assert.ok(calls.length <= 20, `${count} tags caused ${calls.length} git calls; expected <= 20`);
      assert.ok(performance.now() - started < 14000, 'decision exceeded deadline plus margin');
      verdict(r, 0, { hash });
    });
  }
});
for (const command of ['rm tests/a.test.mjs', 'git rm tests/a.test.mjs', 'find tests -name a.test.mjs -delete', 'mv tests/a.test.mjs src/out']) {
  // find needs the inventory to name its candidates, so it has no unreadable-inventory case.
  for (const fail of command.startsWith('find') ? [false] : [false, true]) test(`AC-19 (H6) labels ${command} deleted${fail ? ' without inventory' : ''}`, async (t) => {
    for (const [i, [name, session]] of SESSIONS.entries()) await t.test(`AC-19 ${name}`, () => {
      const r = run(command, session, { env: fail ? { CONSEQUENCE_TREE: 'fail' } : {} });
      verdict(r, i);
      assert.match(r.reason, /tests\/a\.test\.mjs[^.]*deleted/);
      assert.doesNotMatch(r.reason, /would be changed/);
    });
  });
}
test('AC-20 (G4) resolves each cross-repository target against its own oracle', { timeout: 120000 }, async (t) => {
  const other = repository('other', [FILE], 'feature/other');
  symlinkSync(other, join(dir, 'other-link'));
  const hash = git(other, 'rev-parse', 'HEAD');
  for (const command of [
    `rm -rf ${quote(other)}/tests`, 'rm -rf ../other/tests', 'rm -rf other-link/tests',
    `find ${quote(other)}/tests -delete`, `python3 -c "open('${other}/${FILE}', 'w')"`,
  ]) for (const [i, [name, session]] of SESSIONS.entries()) await t.test(`AC-20 ${name} ${command}`, () => {
    verdict(run(command, session), i, { tag: 'oracle/feature/other', hash });
  });
  const linked = join(dir, '.claude/worktrees/x');
  git(dir, 'worktree', 'add', '-qb', 'feature/nested', linked, 'HEAD');
  put(linked, 'src/nested.js');
  git(linked, 'add', '.');
  git(linked, 'commit', '-qm', 'test: distinct nested oracle');
  git(linked, 'tag', 'oracle/feature/nested');
  const nestedHash = git(linked, 'rev-parse', 'HEAD');
  for (const [i, [name, session]] of SESSIONS.entries()) await t.test(`AC-20 ${name} nested linked worktree`, () => {
    verdict(run('rm -rf .claude/worktrees/x/tests', session), i, { tag: 'oracle/feature/nested', hash: nestedHash });
  });
});

test('AC-17 (H12) exact lookups fit a CPU budget exhausted by repeated scans of the same inventory', { timeout: 60000 }, async (t) => {
  const root = repository('lookup');
  const blob = git(root, 'hash-object', '-w', FILE);
  const paths = Array.from({ length: 20000 }, (_, i) => `tests/scale/${String(i).padStart(5, '0')}.test.mjs`);
  const indexed = spawnSync(realGit, ['update-index', '--index-info'], {
    cwd: root, encoding: 'utf8', input: paths.map((p) => `100644 ${blob}\t${p}\n`).join(''),
  });
  assert.equal(indexed.status, 0, indexed.stderr);
  git(root, 'commit', '-qm', 'test: large indexed inventory');
  git(root, 'checkout', '-qb', 'feature/lookup');
  git(root, 'tag', 'oracle/feature/lookup');
  const options = { cwd: root, env: { GUARD_TESTS_CPU_BUDGET_MS: '1000' } };
  const evidence = { tag: 'oracle/feature/lookup', hash: git(root, 'rev-parse', 'HEAD') };
  await t.test('AC-17 exact lookup', async () => {
    const r = await bounded(`rm ${FILE}`, SESSIONS[1][1], options);
    verdict(r, 1, evidence);
    assert.equal(r.stderr, '', 'exact lookup must finish without exhausting the budget');
    assert.doesNotMatch(r.reason, /Unread command/);
  });
  await t.test('AC-17 scan exhaustion', async () => {
    const r = await bounded(`rm ${Array.from({ length: 2000 }, (_, i) => `tests/scale/*${i}*.test.mjs`).join(' ')} ${FILE}`, SESSIONS[1][1], options);
    healthy(r);
    assert.equal(r.decision, 'deny', r.reason + r.stderr);
    assert.match(r.stderr + r.reason, /budget.*exhaust|exhaust.*budget/i);
    assert.match(r.reason, /Unread command at the frozen tests gate:/);
    assert.ok(r.reason.includes(evidence.tag), r.reason);
    assert.ok(r.reason.includes(evidence.hash), r.reason);
  });
});
