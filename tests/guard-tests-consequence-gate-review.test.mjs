// Issue #77, review round 1: regression tests for the defects R1-F1 to R1-F12 that a review found in
// the frozen tests gate (global/hooks/guard-tests.mjs, shell-writes.mjs, frozen-trigger.mjs, oracle.mjs).
// ADR 0034 ("What not read means") asks in the main session and denies for a subagent and in
// bypassPermissions when the reader fails or skips a span that names a frozen test path or a
// test-configuration path. Inside an unread span, a path under the test paths that is not frozen yet
// (an addition) triggers the rule too, as the read form asks for additions (decided 2026-10-30).
// Commands are hook input only; they are never executed. Offline, POSIX only, Node built-ins only.
// The cases marked "passes today" pin behaviour that must stay: a fix must not break them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
const THROW = { GUARD_TESTS_TEST_THROW: '1' };
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
function commitFile(root, path, message = `add ${path}`) {
  put(root, path);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', message);
}
before(() => {
  assert.notEqual(process.platform, 'win32', 'These hook integration tests require POSIX');
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'cw-review-')));
  bin = join(scratch, 'bin');
  mkdirSync(bin);
  const which = spawnSync('which', ['git'], { encoding: 'utf8' });
  assert.equal(which.status, 0, which.stderr);
  realGit = which.stdout.trim();
  writeExecutable(join(bin, 'gh'), '#!/bin/sh\n[ "$#" -gt 0 ] || exit 0\nexit 1\n');
  // The wrapper logs every call, can fail the recursive file list and can fail merge-base.
  writeExecutable(join(bin, 'git'), `#!/bin/sh
[ "$#" -gt 0 ] || exit 0
if [ -n "$REVIEW_LOG" ]; then printf '%s\\n' "$*" >> "$REVIEW_LOG"; fi
if [ "$1" = ls-tree ] && [ "$2" = -rz ] && [ "$REVIEW_TREE" = fail ]; then exit 1; fi
if [ "$1" = merge-base ] && [ -n "$REVIEW_MERGE_BASE_FAILS" ]; then exit 1; fi
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
// The rule: an unread command that names a frozen, new or configuration path, and a control of the
// same form that names none and stays silent. options.visibleFailure is the stderr rule of the control.
function rule(id, label, command, control, options = {}) {
  test(`${id} ${label}`, { timeout: 120000 }, async (t) => {
    for (const [i, [name, session]] of SESSIONS.entries()) {
      await t.test(`${id} ${name} rule`, () => verdict(run(command, session, options), i, { ...options, unread: options.unread ?? true }));
      await t.test(`${id} ${name} control`, () => silent(run(control, session, options), options.visibleFailure));
    }
  });
}
// A read form keeps its own reason: "<rel> would be amended|added|deleted against the test oracle ...".
function readForm(id, label, command, options = {}) {
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

// R1-F1: a glob, or an addition, after an unresolved directory is matched against the oracle, not dropped.
for (const [label, make, path] of [
  ['names a glob of frozen tests', (p) => `cd "$D" && rm ${p}/*.test.mjs`, FILE],
  ['after a missing directory names a glob of frozen tests', (p) => `cd missing-directory && rm -rf ${p}/*`, FILE],
  ['after cd - with no prior directory names a glob of frozen tests', (p) => `cd - && rm ${p}/*.mjs`, FILE],
  ['after an unresolved cd names an addition', (p) => `cd "$D" && echo x > ${p === 'tests' ? 'tests/new.test.mjs' : 'src/new.js'}`, 'tests/new.test.mjs'],
  ['with an unresolved git -C names an addition', (p) => `git -C "$R" checkout -- ${p === 'tests' ? 'tests/new.test.mjs' : 'src/new.js'}`, 'tests/new.test.mjs'],
]) {
  const command = make('tests');
  const control = make('src').replace('src/*.test.mjs', 'src/*.js');
  rule('AC-7 (R1-F1)', `rule ${label}`, command, control, { path });
}

// R1-F2: a glob in an unread span, and a find rooted at the repository, name what they can reach.
rule('AC-5 (R1-F2)', 'rule for eval of a glob of frozen tests', "eval 'rm tests/*'", "eval 'rm src/*'");
rule('AC-4 (R1-F2)', 'rule for a glob when the oracle file list cannot be read', 'rm tests/*.test.mjs', 'rm src/*.js', {
  env: { REVIEW_TREE: 'fail' }, path: 'tests/', visibleFailure: 'optional',
});
rule('AC-3 (R1-F2)', 'rule for a glob when the CPU budget is exhausted', 'rm tests/*.mjs', 'rm src/*.js', {
  env: { GUARD_TESTS_CPU_BUDGET_MS: '1' }, path: 'tests/', visibleFailure: true,
});
rule('AC-8 (R1-F2)', 'rule for a find from the repository root with an unsupported predicate',
  "find . -newer src/x.js -name '*.test.mjs' -delete", "find src -newer src/x.js -name '*.test.mjs' -delete");

// R1-F3: the unread span is resolved in the directory the reader had reached.
rule('AC-2 (R1-F3)', 'rule for eval after a cd into the frozen directory', "cd tests && eval 'rm a.test.mjs'", "cd src && eval 'rm x.js'");
rule('AC-2 (R1-F3)', 'rule for $PWD after a cd into the frozen directory', 'cd tests && rm "$PWD/a.test.mjs"', 'cd src && rm "$PWD/x.js"');
rule('AC-2 (R1-F3)', 'rule for an assigned relative name after a cd', 'cd tests && T=a.test.mjs; rm "$T"', 'cd src && T=x.js; rm "$T"');
rule('AC-2 (R1-F3)', 'rule for a substitution after a cd', 'cd tests && echo x > "$(echo a.test.mjs)"', 'cd src && echo x > "$(echo x.js)"');

// R1-F4: a variable bound by for, export or declare carries the words it was bound to.
rule('AC-6 (R1-F4)', 'rule for a for loop variable', 'for f in tests/a.test.mjs; do rm "$f"; done', 'for f in src/x.js; do rm "$f"; done');
rule('AC-6 (R1-F4)', 'rule for a while read variable fed by find', "find tests -name '*.mjs' | while read f; do rm \"$f\"; done",
  "find src -name '*.js' | while read f; do rm \"$f\"; done");
rule('AC-6 (R1-F4)', 'rule for an exported variable', 'export T=tests/a.test.mjs; echo x > "$T"', 'export T=src/x.js; echo x > "$T"');
rule('AC-6 (R1-F4)', 'rule for a declared variable', 'declare T=tests/a.test.mjs; echo x > "$T"', 'declare T=src/x.js; echo x > "$T"');

// R1-F5: the body of a heredoc with an unquoted delimiter is expanded, so a substitution in it runs.
test('AC-5 (R1-F5) an unquoted heredoc body is read for command substitutions', { timeout: 120000 }, async (t) => {
  for (const [i, [name, session]] of SESSIONS.entries()) {
    await t.test(`AC-5 (R1-F5) ${name} unquoted delimiter gives a verdict`, () => {
      verdict(run('cat > /tmp/issue-77-x <<EOF\n$(rm tests/a.test.mjs)\nEOF', session), i);
    });
    await t.test(`AC-5 (R1-F5) ${name} unquoted delimiter control`, () => {
      silent(run('cat > /tmp/issue-77-x <<EOF\n$(rm src/x.js)\nEOF', session));
    });
    await t.test(`AC-5 (R1-F5) ${name} quoted delimiter is data (passes today)`, () => {
      silent(run("cat > /tmp/issue-77-x <<'EOF'\n$(rm tests/a.test.mjs)\nEOF", session));
    });
  }
});

// R1-F6: find and xargs stay silent when nothing is written or deleted, and rule when it is.
for (const command of [
  'find tests -type d | xargs ls',
  "find tests -name '*.mjs' -newer src/x.js -exec grep -l foo {} +",
  "find tests -type f -not -path '*/x/*' | xargs grep foo",
  'find tests -type d | grep xargs',
]) {
  test(`AC-8 (R1-F6) keeps ${command} silent`, { timeout: 120000 }, async (t) => {
    for (const [name, session] of SESSIONS) await t.test(`AC-8 (R1-F6) ${name}`, () => silent(run(command, session)));
  });
}
rule('AC-8 (R1-F6)', 'rule for a find with an unsupported predicate piped into xargs rm (passes today)',
  'find tests -newer src/x.js | xargs rm', 'find src -newer src/x.js | xargs rm');
rule('AC-8 (R1-F6)', 'rule for a find with an unsupported predicate and -exec rm (passes today)',
  'find tests -newer src/x.js -exec rm {} +', 'find src -newer src/x.js -exec rm {} +');

// R1-F7: a directory of frozen tests that is missing from the working tree is still a frozen path.
test('AC-20 (R1-F7) a restore or copy into a removed directory of frozen tests gives the read verdict', { timeout: 120000 }, async (t) => {
  const path = 'src/components/Button.test.tsx';
  const root = repository('button', [path, 'package.json', 'src/x.js']);
  const hash = git(root, 'rev-parse', TAG);
  rmSync(join(root, 'src/components'), { recursive: true });
  for (const command of ['git restore src/components', 'cp -r /tmp/issue-77-bk src/components']) {
    for (const [i, [name, session]] of SESSIONS.entries()) {
      await t.test(`AC-20 (R1-F7) ${name} ${command}`, () => {
        const r = run(command, session, { cwd: root });
        verdict(r, i, { path, hash });
        assert.equal(r.stderr, '');
        assert.ok(r.reason.startsWith(`${path} would be`), r.reason);
      });
    }
  }
  await t.test('AC-12 (R1-F7) a write outside any test path still loads no inventory (passes today)', () => {
    const log = join(scratch, 'button-log');
    writeFileSync(log, '');
    silent(run('echo hi > src/out', SESSIONS[0][1], { cwd: root, env: { REVIEW_LOG: log } }));
    assert.doesNotMatch(readFileSync(log, 'utf8'), /ls-tree -rz/);
  });
});

// R1-F8: words past the 4000th still count when the whole command is the span.
rule('AC-3 (R1-F8)', 'rule names a path after 4500 words when the reader fails',
  `echo first; echo ${Array.from({ length: 4500 }, (_, i) => `w${i}`).join(' ')}; rm tests/a.test.mjs`,
  `echo first; echo ${Array.from({ length: 4500 }, (_, i) => `w${i}`).join(' ')}; rm src/x.js`, { env: THROW, visibleFailure: true });

// R1-F11: only the message of git commit is data; -m means something else for other subcommands.
rule('AC-2 (R1-F11)', 'rule for git checkout -m after a deciding exception', 'echo first; git checkout -m tests/a.test.mjs',
  'echo first; git checkout -m src/x.js', { env: THROW, visibleFailure: true });
test('AC-2/AC-3 (R1-F11) git commit -m stays data after a deciding exception (passes today)', { timeout: 120000 }, async (t) => {
  for (const [name, session] of SESSIONS) {
    await t.test(`AC-2 (R1-F11) ${name}`, () => silent(run("echo first; git commit -m 'fix tests/a.test.mjs'", session, { env: THROW }), true));
  }
});

// R1-F12: the nearest oracle tag of a linked worktree, for a tag of a tag and for a failed merge-base.
// Passes today with the installed Git 2.56.0: for-each-ref peels %(*objectname) all the way to the
// commit, so a tag of a tag does not crash the lookup. The case stays as a pin for the verdict and for
// the empty stderr, in case a fix changes how the peeled commit is read.
test('AC-18 (R1-F12) a linked worktree on a detached HEAD is bound by an annotated tag of an annotated tag (passes today)',{ timeout: 120000 }, async (t) => {
  const root = repository('nested-tag', undefined, 'feature/base');
  commitFile(root, 'src/later.js');
  git(root, 'tag', '-a', 'inner', '-m', 'i', 'HEAD');
  git(root, 'tag', '-a', 'oracle/feature/nested-tag', '-m', 'o', 'inner');
  assert.match(git(root, 'cat-file', '-p', 'oracle/feature/nested-tag'), /^type tag$/m, 'the oracle tag points at another tag');
  const hash = git(root, 'rev-parse', 'oracle/feature/nested-tag^{commit}');
  const linked = join(scratch, 'linked-nested-tag');
  git(root, 'worktree', 'add', '-q', '--detach', linked, 'HEAD');
  for (const [i, [name, session]] of SESSIONS.entries()) {
    await t.test(`AC-18 (R1-F12) ${name} reads the nearest tag`, () => {
      const r = run('rm tests/a.test.mjs', session, { cwd: linked });
      verdict(r, i, { tag: 'oracle/feature/nested-tag', hash });
      assert.equal(r.stderr, '', 'no crash on a tag of a tag');
    });
    await t.test(`AC-18 (R1-F12) ${name} control`, () => silent(run('rm src/x.js', session, { cwd: linked })));
  }
});
test('AC-18 (R1-F12) a failed merge-base falls back to the nearest of two independent oracle tags', { timeout: 120000 }, async (t) => {
  // Base B (tag oracle/feature/base); side a: two commits, tag oracle/z-near at the second; side b: one
  // commit, tag oracle/a-far. HEAD is their merge: z-near is 2 commits from HEAD, a-far is 3, and z-near
  // sorts last, so neither the sort order nor the tag at B decides.
  const root = repository('merged-tags', undefined, 'feature/base');
  git(root, 'checkout', '-q', '-b', 'side-a');
  commitFile(root, 'src/a1.js');
  commitFile(root, 'src/a2.js');
  git(root, 'tag', 'oracle/z-near');
  git(root, 'checkout', '-q', 'feature/base');
  git(root, 'checkout', '-q', '-b', 'side-b');
  commitFile(root, 'src/b1.js');
  git(root, 'tag', 'oracle/a-far');
  git(root, 'checkout', '-q', '--detach', 'side-a');
  git(root, 'merge', '-q', '--no-ff', '-m', 'merge', 'side-b');
  const linked = join(scratch, 'linked-merged-tags');
  git(root, 'worktree', 'add', '-q', '--detach', linked, 'HEAD');
  git(root, 'checkout', '-q', 'feature/base');
  const hash = git(root, 'rev-parse', 'oracle/z-near^{commit}');
  for (const [i, [name, session]] of SESSIONS.entries()) {
    await t.test(`AC-18 (R1-F12) ${name} merge-base working binds the nearest tag (passes today)`, () => {
      verdict(run('rm tests/a.test.mjs', session, { cwd: linked }), i, { tag: 'oracle/z-near', hash });
    });
    await t.test(`AC-18 (R1-F12) ${name} merge-base failing still binds the nearest tag`, () => {
      const r = run('rm tests/a.test.mjs', session, { cwd: linked, env: { REVIEW_MERGE_BASE_FAILS: '1' } });
      verdict(r, i, { tag: 'oracle/z-near', hash });
    });
  }
});
