// Issue #77, review round 2: regression tests for the defects R2-G1 to R2-G9 that a second review and
// a measurement found in the frozen tests gate (global/hooks/guard-tests.mjs, shell-writes.mjs,
// frozen-trigger.mjs, oracle.mjs), written at commit 8d1efc8 and before the fix.
// ADR 0034 ("What not read means") asks in the main session and denies for a subagent and in
// bypassPermissions when the reader fails or skips a span that names a frozen test path, a new path
// under the test paths (decided 2026-10-30) or a test-configuration path. A program the reader does not
// know stays allowed. A read form keeps its own reason "<rel> would be amended|added|deleted ...".
// Commands are hook input only; they are never executed. Offline, POSIX only, Node built-ins only.
// The cases marked "passes today" pin behaviour that must stay: a fix must not break them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
let scratch, bin, dir, out, commit, realGit;
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
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'cw-review2-')));
  bin = join(scratch, 'bin');
  mkdirSync(bin);
  // An existing directory outside the repository: the destination of the copies that must stay silent.
  out = join(scratch, 'out');
  mkdirSync(out);
  const which = spawnSync('which', ['git'], { encoding: 'utf8' });
  assert.equal(which.status, 0, which.stderr);
  realGit = which.stdout.trim();
  writeExecutable(join(bin, 'gh'), '#!/bin/sh\n[ "$#" -gt 0 ] || exit 0\nexit 1\n');
  // The wrapper logs every call when asked and runs the real Git.
  writeExecutable(join(bin, 'git'), `#!/bin/sh
[ "$#" -gt 0 ] || exit 0
if [ -n "$REVIEW_LOG" ]; then printf '%s\\n' "$*" >> "$REVIEW_LOG"; fi
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
function healthy(r) {
  assert.deepEqual(r.failures, [], `hook failed: ${r.failures.join('; ')} ${r.stderr}`);
  assert.ok(r.ran.some((s) => s.includes('guard-tests.mjs')), 'configured guard-tests entry ran');
}
function silent(r) {
  healthy(r);
  assert.equal(r.explicit, false, r.reason);
  assert.equal(r.stderr, '');
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
// The rule: an unread command that names a frozen, new or configuration path, and a control of the
// same form that names none and stays silent.
function rule(id, label, command, control, options = {}) {
  test(`${id} ${label}`, { timeout: 120000 }, async (t) => {
    for (const [i, [name, session]] of SESSIONS.entries()) {
      await t.test(`${id} ${name} rule`, () => verdict(run(command, session, options), i, { ...options, unread: true }));
      await t.test(`${id} ${name} control`, () => silent(run(control, session, options)));
    }
  });
}
// Commands that write nothing under the test paths: no verdict and an empty stderr in every session.
function quiet(id, label, commands) {
  test(`${id} ${label}`, { timeout: 120000 }, async (t) => {
    for (const command of commands) {
      for (const [name, session] of SESSIONS) await t.test(`${id} ${name} ${command}`, () => silent(run(command, session)));
    }
  });
}

// R2-G1: find -path and -regex reach what the pattern matches from the repository root.
rule('AC-8 (R2-G1)', 'rule for find -path from the repository root',
  'find . -path tests/a.test.mjs -delete', 'find . -path src/x.js -delete');
rule('AC-8 (R2-G1)', 'rule for find -path with a glob of the test directory from the repository root',
  "find . -path './tests/*' -delete", "find . -path './src/*' -delete");
rule('AC-8 (R2-G1)', 'rule for find -regex from the repository root',
  "find . -regex '.*test.*' -delete", "find . -regex '.*src.*' -delete");
quiet('AC-8 (R2-G1)', 'find -delete without a name test of the paths is silent (passes today)', ['find . -type d -empty -delete']);

// R2-G2: a variable that holds a command is run by eval and by bash -c, so what it holds is read.
rule('AC-5 (R2-G2)', 'rule for eval of a variable that holds a command',
  `T='rm tests/a.test.mjs'; eval "$T"`, `T='rm src/x.js'; eval "$T"`);
rule('AC-6 (R2-G2)', 'rule for bash -c of a variable that holds a command',
  `T='rm tests/a.test.mjs'; bash -c "$T"`, `T='rm src/x.js'; bash -c "$T"`);

// R2-G3: a find with an unsupported predicate and an -exec that copies or moves names the destination
// and, for a move from the repository root, the files it can reach.
rule('AC-8 (R2-G3)', 'rule for find -exec cp to a new test path',
  'find src -newer src/x.js -exec cp {} tests/new.test.mjs \\;', `find src -newer src/x.js -exec cp {} ${quote(`${out}/`)} \\;`,
  { path: 'tests/new.test.mjs' });
rule('AC-8 (R2-G3)', 'rule for find -exec mv into the test directory from the repository root',
  'find . -newer src/x.js -exec mv {} tests/ \\;', `find . -newer src/x.js -exec mv {} ${quote(`${out}/`)} \\;`);

// R2-G4: an arithmetic expansion can hold a command substitution, so it is read, not dropped.
test('AC-5 (R2-G4) a command substitution inside an arithmetic expansion gives a verdict', { timeout: 120000 }, async (t) => {
  for (const [i, [name, session]] of SESSIONS.entries()) {
    await t.test(`AC-5 (R2-G4) ${name} gives a verdict`, () => verdict(run('echo $(( $(rm tests/a.test.mjs) ))', session), i));
    await t.test(`AC-5 (R2-G4) ${name} control`, () => silent(run('echo $(( $(rm src/x.js) ))', session)));
    await t.test(`AC-5 (R2-G4) ${name} plain arithmetic is silent (passes today)`, () => silent(run('echo $((1 + 2))', session)));
  }
});

// R2-G5: a loop or an assignment that only reads a frozen file, and copies it out, is not a write.
quiet('AC-6 (R2-G5)', 'a loop or an assignment that copies frozen tests out of the repository is silent', [
  `for f in tests/*.test.mjs; do cp "$f" ${quote(`${out}/`)}; done`,
  `T=tests/a.test.mjs; cp "$T" ${quote(`${out}/`)}`,
]);
rule('AC-6 (R2-G5)', 'rule for a loop that copies into the test directory',
  'for f in src/*.js; do cp "$f" tests/; done', `for f in src/*.js; do cp "$f" ${quote(`${out}/`)}; done`, { path: 'tests/' });

// R2-G6: find that lists, or hands the files to a program that does not write, is silent; one that
// hands them to a program that writes or deletes is not.
quiet('AC-8 (R2-G6)', 'find over the test directory with a reader after it is silent', [
  `find tests -newer src/x.js | tee ${quote(`${out}/list.txt`)}`,
  'find tests -mtime -1 -exec git log -1 {} \\;',
  'find tests -newer src/x.js | xargs git diff',
]);
rule('AC-8 (R2-G6)', 'rule for find piped into xargs git rm',
  'find tests -newer src/x.js | xargs git rm', 'find src -newer src/x.js | xargs git rm');
rule('AC-8 (R2-G6)', 'rule for find -exec git checkout',
  'find tests -newer src/x.js -exec git checkout -- {} \\;', 'find src -newer src/x.js -exec git checkout -- {} \\;');

// R2-G9: after a directory the reader cannot resolve, a write of the whole tree names the frozen files
// of the oracle of the event cwd.
rule('AC-7 (R2-G9)', 'rule for git checkout of the whole tree after an unresolved cd',
  'cd "$D"; git checkout -q -- .', 'cd "$D"; git checkout -q -- src');
rule('AC-7 (R2-G9)', 'rule for git restore of the whole tree after an unresolved cd',
  'cd "$D"; git restore .', 'cd "$D"; git restore src');
rule('AC-7 (R2-G9)', 'rule for rm -rf * after an unresolved cd',
  'cd "$D" && rm -rf *', 'cd "$D" && rm -rf src');
test('AC-7 (R2-G9) git checkout of the whole tree without a cd asks with the read reasons (passes today)', { timeout: 120000 }, () => {
  const r = run('git checkout -q -- .', SESSIONS[0][1]);
  verdict(r, 0);
  assert.ok(r.reason.includes(`${FILE} would be`), r.reason);
});
