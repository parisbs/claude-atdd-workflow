// Second-review regressions for issue #64. The installed guard-tests entries
// read commands in real, offline repositories; none of those commands runs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { HOOKS, SETTINGS, runConfigured } from './claude-hooks.mjs';
import { writeExecutable } from './executables.mjs';

const TAG = 'oracle/feature/review-2';
const FROZEN = 'test/a.test.js';
const SESSIONS = [{ permission_mode: 'default' }, { agent_id: 'review-agent' }, { permission_mode: 'bypassPermissions' }];
const GUARD_TESTS = {
  hooks: { PreToolUse: SETTINGS.hooks.PreToolUse.filter((entry) => entry.hooks.some((hook) => hook.command.includes('guard-tests.mjs'))) },
};
let scratch;
let bin;
let dir;
let large;
let largePaths;
let scale;
let scalePaths;
let capped;
const git = (cwd, ...args) => {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
};
function put(dir, path, content = 'x\n') {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}
function repository(name, files, indexed = false) {
  const root = join(scratch, name);
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'feature/review-2');
  for (const [key, value] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.com', 'commit.gpgsign': 'false', 'tag.gpgsign': 'false' })) git(root, 'config', key, value);
  if (indexed) {
    // One working-tree file supplies the blob for the entire oracle inventory.
    put(root, files[0]);
    const blob = git(root, 'hash-object', '-w', files[0]);
    const run = spawnSync('git', ['update-index', '--index-info'], {
      cwd: root, encoding: 'utf8', input: files.map((path) => `100644 ${blob}\t${path}\n`).join(''),
    });
    assert.equal(run.status, 0, run.stderr);
  } else {
    for (const path of files) put(root, path);
    git(root, 'add', '.');
  }
  git(root, 'commit', '-qm', 'test: freeze second review fixture');
  git(root, 'tag', TAG);
  return root;
}
before(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'cw-review-2-')));
  bin = join(scratch, 'bin');
  mkdirSync(bin);
  writeExecutable(join(bin, 'gh'), '#!/bin/sh\n[ "$#" -gt 0 ] || exit 0\nexit 1\n');
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' });
  assert.equal(realGit.status, 0, realGit.stderr);
  writeExecutable(join(bin, 'git'), `#!/bin/sh
[ "$#" -gt 0 ] || exit 0
if [ -n "$REVIEW_2_LOG" ]; then printf '%s %s\\n' "$GIT_NO_LAZY_FETCH" "$*" >> "$REVIEW_2_LOG"; fi
if [ "$REVIEW_2_FAIL_TREE" = 1 ] && [ "$1" = ls-tree ] && [ "$2" = -rz ]; then exit 1; fi
if [ "$REVIEW_2_FAIL_PATHS" = 1 ] && [ "$1" = show ]; then echo 'unreadable test paths' >&2; exit 1; fi
exec '${realGit.stdout.trim().replaceAll("'", "'\\''")}' "$@"
`);
  dir = repository('repo', [FROZEN, 'test/nested/b.test.js', 'packages/a/test/c.js', 'package.json', 'tests/pytest.ini', 'README.md', 'src/script.js']);
  largePaths = [FROZEN, ...Array.from({ length: 5000 }, (_, i) => `src/${String(i).padStart(4, '0')}-${'f'.repeat(205)}.json`)];
  large = repository('large', largePaths, true);
  scalePaths = Array.from({ length: 5000 }, (_, i) => `test/${String(i).padStart(4, '0')}.json`);
  scale = repository('scale', scalePaths, true);
  capped = repository('capped', scalePaths.slice(0, 25), true);
});
after(() => rmSync(scratch, { recursive: true, force: true }));
function run(command, session = SESSIONS[0], cwd = dir, env = {}) {
  const result = runConfigured({ cwd, tool_name: 'Bash', tool_input: { command }, ...session }, {
    settings: GUARD_TESTS, env: { PATH: `${bin}${delimiter}${process.env.PATH}`, ...env },
  });
  assert.deepEqual(result.failures, [], result.stderr);
  return result;
}
function verdicts(command, path = FROZEN, cwd = dir) {
  for (const [i, session] of SESSIONS.entries()) {
    const result = run(command, session, cwd);
    assert.equal(result.decision, i === 0 ? 'ask' : 'deny', `${command}: ${result.reason} ${result.stderr}`);
    assert.ok(result.reason.includes(path), result.reason);
    assert.ok(result.reason.includes(TAG), result.reason);
    assert.equal(result.stderr, '', command);
  }
}

test('AC-1 (G1) protects Edit, Write and NotebookEdit with an oracle inventory exceeding 1 MiB', () => {
  const listing = git(large, 'ls-tree', '-rz', '--name-only', TAG);
  assert.ok(Buffer.byteLength(listing) > 1024 * 1024);
  for (const tool_name of ['Edit', 'Write', 'NotebookEdit']) {
    for (const [i, session] of SESSIONS.entries()) {
      const result = runConfigured({ cwd: large, tool_name, tool_input: { file_path: largePaths[0], notebook_path: largePaths[0] }, ...session }, {
        settings: GUARD_TESTS, env: { PATH: `${bin}${delimiter}${process.env.PATH}` },
      });
      assert.deepEqual(result.failures, [], result.stderr);
      assert.equal(result.decision, i === 0 ? 'ask' : 'deny', result.reason + result.stderr);
      assert.match(result.reason, /would be amended/);
      assert.equal(result.stderr, '');
    }
  }
});
test('AC-1 (G1) retains each session verdict when inventory labels cannot be read', () => {
  for (const tool_name of ['Edit', 'Write', 'NotebookEdit']) {
    for (const [i, session] of SESSIONS.entries()) {
      const result = runConfigured({ cwd: dir, tool_name, tool_input: { file_path: FROZEN, notebook_path: FROZEN }, ...session }, {
        settings: GUARD_TESTS, env: { PATH: `${bin}${delimiter}${process.env.PATH}`, REVIEW_2_FAIL_TREE: '1' },
      });
      assert.deepEqual(result.failures, [], result.stderr);
      assert.equal(result.decision, i === 0 ? 'ask' : 'deny', result.reason + result.stderr);
      assert.match(result.reason, /change label could not be read/);
      assert.match(result.stderr, /change label could not be read/);
      if (i === 2) assert.match(result.reason, /switch to a mode that shows permission prompts/);
    }
  }
});
test('AC-2 (G2) indexes 5000 find-exec and xargs candidates once and reads inline names by lookup', () => {
  for (const [command, cwd] of [
    ["find test -name '*.json' -exec sed -i s/a/b/ {} \\;", scale],
    ["find test -name '*.json' | xargs sed -i s/a/b/", scale],
    [`python3 - <<'EOF'\n${Array.from({ length: 300 }, (_, i) => `print('word${i}')`).join('\n')}\nopen('${largePaths[0]}', 'w')\nEOF`, large],
  ]) {
    const log = join(scratch, 'large-git-log');
    writeFileSync(log, '');
    const result = run(command, SESSIONS[1], cwd, { REVIEW_2_LOG: log });
    assert.equal(result.decision, 'deny', result.reason + result.stderr);
    assert.equal(result.stderr, '');
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.ok(calls.length <= 12, calls.join('\n'));
    assert.equal(calls.filter((call) => call.startsWith('1 ls-tree -rz ')).length, 1);
    assert.ok(calls.every((call) => call.startsWith('1 ')), 'lazy fetch stays disabled');
    if (command.startsWith('find')) assert.match(result.reason, /4980 more paths/);
  }
});
for (const command of ['rm -rf packages/*/test', 'rm -rf *', 'mv test/* /tmp/', 'find packages/*/test -delete', 'rm -rf test/**']) {
  test(`AC-3 (G3/G8) covers directory and recursive glob ${command}`, () => verdicts(command, command.includes('packages') ? 'packages/a/test/c.js' : FROZEN));
}
test('AC-4 (G4) discovers linked worktree, external, symlinked and home directory targets', () => {
  const linked = join(dir, '.claude/worktrees/x');
  git(dir, 'worktree', 'add', '-q', '--detach', linked, 'HEAD');
  verdicts('rm -rf .claude/worktrees/x/test');
  verdicts('node -e "open(\'.claude/worktrees/x/test/a.test.js\')"');
  const external = repository('other', [FROZEN]);
  const alias = join(scratch, 'alias');
  symlinkSync(external, alias);
  for (const command of [`rm -rf ${alias}/test`, `rm -rf ${alias}/t*`, `find ${alias}/test -name '*.js' -delete`, `node -e "open('${alias}/${FROZEN}')"`]) verdicts(command, FROZEN, tmpdir());
  verdicts('find ../other/test -name "*.js" -delete', FROZEN);
  verdicts(`rm -rf ${external}/test`, FROZEN, tmpdir());
  // Set HOME after the harness chooses its hook installation directory.
  const settings = structuredClone(GUARD_TESTS);
  for (const entry of settings.hooks.PreToolUse) {
    for (const hook of entry.hooks) hook.command = `HOME='${scratch}' node '${join(HOOKS, 'guard-tests.mjs')}'`;
  }
  for (const [i, session] of SESSIONS.entries()) {
    const result = runConfigured({ cwd: tmpdir(), tool_name: 'Bash', tool_input: { command: 'rm -rf ~/other/test' }, ...session }, {
      settings, env: { PATH: `${bin}${delimiter}${process.env.PATH}` },
    });
    assert.deepEqual(result.failures, [], result.stderr);
    assert.equal(result.decision, i === 0 ? 'ask' : 'deny', result.reason + result.stderr);
    assert.ok(result.reason.includes(FROZEN));
    assert.equal(result.stderr, '');
  }
});
for (const prefix of ['if', 'elif', 'while', 'until', 'nice', 'nice -n 5', 'doas', 'doas -u root', 'stdbuf -oL']) {
  test(`AC-5 (G5) unwraps ${prefix}`, () => verdicts(`${prefix} cp README.md ${FROZEN}; then echo ok; fi`));
}
test('AC-5 (G5) follows pushd and popd', () => verdicts('pushd src; popd; until rm test/a.test.js; do sleep 1; done'));
for (const flag of ['', '-P ', '-- ']) {
  test(`AC-6 (G6) follows cd ${flag}into a preceding mkdir target`, () => {
    verdicts(`mkdir -p test/unit && cd ${flag}test/unit && cat > a.test.js <<EOF\nx\nEOF`, 'test/unit/a.test.js');
    const result = run(`mkdir -p build && cd ${flag}build && cmake ..`);
    assert.equal(result.explicit, false, result.reason);
    assert.equal(result.stderr, '');
  });
}
test('AC-8 (G8) inline configuration paths ask and arbitrary pipeline stages retain find candidates', () => {
  for (const session of SESSIONS) {
    const result = run('node -e "fs.writeFileSync(\'package.json\', \'{}\')"', session);
    assert.equal(result.decision, 'ask', result.reason);
    assert.match(result.reason, /package\.json/);
  }
  verdicts("find test -name '*.js' | grep -v a.test | xargs rm");
});
for (const command of ['git checkout .', 'git checkout test/', "bash -ce 'rm test/a.test.js'", "sh -cx 'rm test/a.test.js'"]) {
  test(`AC-8 (G8) reads ${command}`, () => verdicts(command));
}
for (const shell of ['bash -euo pipefail -c', 'bash -o pipefail -c', 'sh -O extglob -c']) {
  test(`AC-6 (H1) reads ${shell} as a nested command`, () => verdicts(`${shell} 'rm ${FROZEN}'`));
}
for (const interpreter of [
  'python3 -W ignore -c', 'python3 -X dev -c',
  'node -r dotenv/config -e', 'node --require x -e', 'node --import x -e',
  'perl -I lib -e', 'ruby -I lib -e',
  'python3 -Wignore -c', 'python3 -Xdev -c', 'node -rdotenv/config -e',
  'node --require=x -e', 'node --import=x -e', 'perl -Ilib -e', 'ruby -Ilib -e',
]) {
  test(`AC-6 (H1) reads ${interpreter} naming a frozen path`, () => verdicts(`${interpreter} "open('${FROZEN}', 'w')"`));
}
for (const command of [
  'python3 -W ignore -m pytest -c tests/pytest.ini',
  'node -r dotenv/config src/script.js -e test/a.test.js',
]) {
  test(`AC-9 (H1) stops at module and script operands in ${command}`, () => {
    for (const session of SESSIONS) {
      const result = run(command, session);
      assert.equal(result.explicit, false, result.reason);
      assert.equal(result.stderr, '');
    }
  });
}
for (const command of ['git restore --staged .', `git restore -S ${FROZEN}`, `git restore --staged -- ${FROZEN}`]) {
  test(`AC-9 (H4) gives no verdict for ${command}`, () => {
    for (const session of SESSIONS) {
      const result = run(command, session);
      assert.equal(result.explicit, false, result.reason);
      assert.equal(result.stderr, '');
    }
  });
}
for (const command of [
  `git restore --staged --worktree ${FROZEN}`, `git restore -SW ${FROZEN}`,
  `git restore -S -W ${FROZEN}`, `git restore ${FROZEN}`,
]) {
  test(`AC-5 (H4) protects worktree changes in ${command}`, () => verdicts(command));
}
for (const command of ['python3 -m pytest -c tests/pytest.ini', 'python -m module -c test/a.test.js', 'node src/script.js -e test/a.test.js', 'python3 src/script.js -c test/a.test.js']) {
  test(`AC-9 (G9) gives no verdict for interpreter arguments in ${command}`, () => {
    for (const session of SESSIONS) {
      const result = run(command, session);
      assert.equal(result.explicit, false, result.reason);
      assert.equal(result.stderr, '');
    }
  });
}
for (const flag of ['-i{}', '-i']) {
  test(`AC-9 (G9) reads xargs ${flag} replacement without treating a cp source as its target`, () => {
    for (const session of SESSIONS) {
      const result = run(`find test -name '*.js' | xargs ${flag} cp {} /tmp/out/`, session);
      assert.equal(result.explicit, false, result.reason);
      assert.equal(result.stderr, '');
    }
    verdicts(`find test -name '*.js' | xargs ${flag} rm {}`);
  });
}
test('AC-10 (G10) lists at most 20 paths and retains tag, commit and labels', () => {
  const result = run('git restore .', SESSIONS[0], capped);
  assert.equal(result.decision, 'ask', result.reason);
  assert.equal((result.reason.match(/would be amended/g) ?? []).length, 20);
  assert.ok(result.reason.includes(TAG));
  assert.ok(result.reason.includes(git(capped, 'rev-parse', TAG)));
  assert.match(result.reason, /5 more paths/);
});
test('AC-11 (G11) codex-integrate applies nothing and keeps its worktree when the oracle test paths cannot be read', () => {
  const root = repository('integrate', ['README.md', '.atdd/test-paths', 'acceptance/case.txt']);
  put(root, '.atdd/test-paths', 'acceptance/**\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'test: declare acceptance paths');
  // Give this fixture its own branch oracle without rewriting the original tag.
  git(root, 'checkout', '-qb', 'feature/integrate');
  git(root, 'tag', 'oracle/feature/integrate');
  const codexHome = join(scratch, 'codex-home');
  const tree = join(codexHome, 'worktrees', 'one', 'repo');
  mkdirSync(dirname(tree), { recursive: true });
  git(root, 'worktree', 'add', '-q', '--detach', tree, 'HEAD');
  put(tree, 'README.md', 'codex change\n');
  const before = git(root, 'status', '--porcelain');
  const result = spawnSync(process.execPath, [join(HOOKS, 'codex-integrate.mjs'), tree], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, CODEX_HOME: codexHome, REVIEW_2_FAIL_PATHS: '1' },
  });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /could not read the oracle test paths.*unreadable test paths/);
  assert.equal(git(root, 'status', '--porcelain'), before);
  assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), 'x\n');
  assert.equal(existsSync(tree), true);
  assert.equal(readFileSync(join(tree, 'README.md'), 'utf8'), 'codex change\n');
});
