// Review regressions for issue #64. Run only the installed guard-tests entries,
// with offline gh first on PATH; the Bash commands are read, never executed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { HOOKS, SETTINGS, runConfigured } from './claude-hooks.mjs';

const FROZEN = 'test/a.test.js';
const ORACLE = 'oracle/feature/review';
const SESSIONS = [{ permission_mode: 'default' }, { agent_id: 'review-agent' }, { permission_mode: 'bypassPermissions' }];
const GUARD_TESTS = {
  hooks: { PreToolUse: SETTINGS.hooks.PreToolUse.filter((entry) => entry.hooks.some((hook) => hook.command.includes('guard-tests.mjs'))) },
};
let scratch;
let bin;
let dir;
const git = (cwd, ...args) => {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
};
function put(file, content = 'x\n') {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
}
before(() => {
  scratch = mkdtempSync(join(tmpdir(), 'cw-review-'));
  bin = join(scratch, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' });
  assert.equal(realGit.status, 0, realGit.stderr);
  writeFileSync(join(bin, 'git'), `#!/bin/sh
if [ -n "$REVIEW_GIT_LOG" ]; then printf '%s\\n' "$*" >> "$REVIEW_GIT_LOG"; fi
if [ -n "$REVIEW_FAIL_DIR" ] && [ "$PWD" = "$REVIEW_FAIL_DIR" ]; then exec sleep 30; fi
exec '${realGit.stdout.trim().replaceAll("'", "'\\''")}' "$@"
`, { mode: 0o755 });
  dir = join(scratch, 'repo');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'feature/review');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  put(FROZEN);
  put('test/b.test.js');
  put('package.json', '{}\n');
  put('src/a.js');
  put('README.md');
  mkdirSync(join(dir, 'stall'));
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: freeze review fixture');
  git(dir, 'tag', ORACLE);
  put('node_modules/dependency/test/untracked.test.js');
  put('node_modules/dependency/package.json', '{}\n');
  put('app/build/test/untracked.test.js');
  put('app/build/package.json', '{}\n');
});
after(() => rmSync(scratch, { recursive: true, force: true }));

function bash(command, session = SESSIONS[0], env = {}, cwd = dir) {
  const result = runConfigured({ cwd, tool_name: 'Bash', tool_input: { command }, ...session }, {
    settings: GUARD_TESTS, env: { PATH: `${bin}${delimiter}${process.env.PATH}`, ...env },
  });
  assert.deepEqual(result.failures, [], result.stderr);
  return result;
}
function verdicts(command, path = FROZEN, cwd = dir) {
  for (const [index, session] of SESSIONS.entries()) {
    const result = bash(command, session, {}, cwd);
    assert.equal(result.decision, index === 0 ? 'ask' : 'deny', `${command}: ${result.reason} ${result.stderr}`);
    assert.ok(result.reason.includes(path), `${command}: ${result.reason}`);
    assert.ok(result.reason.includes(ORACLE), result.reason);
    assert.equal(result.stderr, '', command);
    if (index === 2) assert.match(result.reason, /switch to a mode that shows permission prompts/);
  }
}
function silent(command) {
  for (const session of SESSIONS) {
    const result = bash(command, session);
    assert.equal(result.explicit, false, `${command}: ${result.reason}`);
    assert.equal(result.stderr, '', command);
  }
}

test('AC-2/AC-3 (F1) keeps verdicts before and after a segment error and reports it', () => {
  for (const [index, session] of SESSIONS.entries()) {
    const result = bash(`echo x > ${FROZEN}; cd missing-directory; rm test/b.test.js`, session);
    assert.equal(result.decision, index === 0 ? 'ask' : 'deny', result.reason);
    assert.ok(result.reason.includes(FROZEN), `${result.reason} ${result.stderr}`);
    assert.ok(result.reason.includes('test/b.test.js'), result.reason);
    assert.match(result.stderr, /guard-tests: could not evaluate.*ENOENT/);
  }
});
test('AC-2/AC-3 (F1) keeps an ask or deny when a later git read times out', () => {
  for (const [index, session] of SESSIONS.entries()) {
    const result = bash(`echo x > ${FROZEN}; git -C stall restore .`, session, {
      REVIEW_FAIL_DIR: spawnSync('pwd', ['-P'], { cwd: join(dir, 'stall'), encoding: 'utf8' }).stdout.trim(),
    });
    assert.equal(result.decision, index === 0 ? 'ask' : 'deny', result.reason);
    assert.ok(result.reason.includes(FROZEN), result.reason);
    assert.match(result.stderr, /guard-tests: could not evaluate.*ETIMEDOUT/);
  }
});
test('AC-2 (F1) retains a deny before an inline division expression', () => {
  const result = bash(`echo x > ${FROZEN}; python3 -c "print(1 / 2)"`, SESSIONS[1]);
  assert.equal(result.decision, 'deny', result.reason);
  assert.equal(result.stderr, '');
});
test('AC-9 (F2) reads the oracle tree once and bounds git calls independently of 3000 dependency files', () => {
  for (let i = 0; i < 3000; i += 1) put(`node_modules/dependency/files/${i}.js`);
  for (const command of ['rm -rf node_modules', 'git restore .', 'git checkout -- .', 'find ~ -name foo | head']) {
    const log = join(scratch, 'git-calls');
    writeFileSync(log, '');
    const result = bash(command, SESSIONS[0], { REVIEW_GIT_LOG: log });
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.ok(calls.length <= 12, `${command}: ${calls.join('\n')}`);
    assert.equal(calls.filter((call) => call.startsWith('ls-tree -rz --name-only ')).length, 1, calls.join('\n'));
    assert.equal(result.explicit, command.startsWith('git '), result.reason);
    assert.equal(result.stderr, '');
  }
});

for (const [label, command] of [
  ['python3 -c with a multiplication', 'python3 -c "print(2 * 3)"'],
  ['node -e reading dot', `node -e "require('fs').readdirSync('.')"`],
  ['node -e reading slash', `node -e "require('fs').readdirSync('/')"`],
  ['deleting untracked dependency tests', 'rm -rf node_modules'],
  ['deleting untracked build tests', 'rm -rf app/build'],
  ['xargs -I{} copying from tests', "find test -name '*.js' | xargs -I{} cp {} /tmp/out/"],
  ['perl -Mstrict without in-place editing', `perl -Mstrict -e 'print 1' ${FROZEN}`],
  ['find selecting only empty directories', 'find . -type d -empty -delete'],
]) test(`AC-9 (F3) gives no verdict for ${label}`, () => silent(command));

test('AC-6 (F3) inline scripts name an exact frozen path relative to cwd or the repository', () => {
  verdicts(`python3 -c "open('a.test.js').read()"`, FROZEN, join(dir, 'test'));
  verdicts(`node -e "require('fs').readFileSync('${FROZEN}')"`, FROZEN, join(dir, 'src'));
});
for (const command of ['cp README.md', 'install -m 644 README.md', 'ln -sf README.md']) {
  for (const redirect of ['2>/dev/null', '2>&1', '1>/dev/null', '&>/dev/null', '>&/dev/null']) {
    test(`AC-5 (F4) protects ${command} onto a frozen test followed by ${redirect}`, () => verdicts(`${command} ${FROZEN} ${redirect}`));
  }
}
for (const redirect of [`1>${FROZEN}`, `&>${FROZEN}`, `>& ${FROZEN}`]) {
  test(`AC-4 (F4/F6) protects output through ${redirect}`, () => verdicts(`echo x ${redirect}`));
}
for (const [label, command] of [
  ['an unterminated heredoc', `cat <<'EOF'\nbody\nrm ${FROZEN}`],
  ['a here-string', `cat <<< x; rm ${FROZEN}`],
  ['process substitution input', `cat <(echo x); rm ${FROZEN}`],
  ['process substitution output', `cat >(cat); rm ${FROZEN}`],
  ['a read-write redirect', `cat <> README.md; rm ${FROZEN}`],
  ['arithmetic shifts followed by a newline', `echo $((1<<2))\nrm ${FROZEN}`],
]) {
  test(`AC-7 (F5) reads later writes after ${label}`, () => {
    for (const [index, session] of SESSIONS.entries()) {
      const result = bash(command, session);
      assert.equal(result.decision, index === 0 ? 'ask' : 'deny', `${command}: ${result.stderr}`);
      assert.ok(result.reason.includes(FROZEN), result.reason);
      if (label === 'an unterminated heredoc') assert.match(result.stderr, /unterminated heredoc/);
      else assert.equal(result.stderr, '');
    }
  });
}

for (const prefix of ['then', 'do', 'else', '{', '!', 'time', 'sudo', 'sudo -u root', 'nohup', 'timeout 2', 'exec', 'command', 'env', 'env FOO=1', 'FOO=1 env BAR=2 sudo']) {
  test(`AC-5/AC-7 (F6) protects a frozen deletion after ${prefix}`, () => verdicts(`${prefix} rm ${FROZEN}`));
}
test('AC-5 (F6) reads fixed xargs operands with options', () => verdicts(`xargs -n 1 rm ${FROZEN}`));
for (const flag of ['-Ei', '-ri', '-ni', '-i.bak']) {
  test(`AC-4 (F6) protects sed ${flag}`, () => verdicts(`sed ${flag} s/a/b/ ${FROZEN}`));
}
for (const shell of ['bash -lc', 'sh -ec', 'zsh -c']) {
  test(`AC-6 (F6) reads ${shell} as nested commands`, () => verdicts(`${shell} 'rm ${FROZEN}'`));
}
for (const interpreter of ['node -pe', 'perl -we', 'perl -pie', 'python3.13 -c']) {
  test(`AC-6 (F6) protects ${interpreter} naming a frozen path`, () => verdicts(`${interpreter} "'${FROZEN}'"`));
}
for (const interpreter of ['python3 -', 'node']) {
  test(`AC-6 (F6) protects ${interpreter} scripts on stdin`, () => verdicts(`${interpreter} <<'EOF'\nopen('${FROZEN}', 'w')\nEOF`));
}
test('AC-6 (F6) reads a bash heredoc as nested commands', () => verdicts(`bash <<'EOF'\nrm ${FROZEN}\nEOF`));
test('AC-9 (F6) gives no verdict for a bash heredoc that only reads tests', () => silent(`bash <<'EOF'\ncat ${FROZEN}\nEOF`));
for (const command of [
  `git mv ${FROZEN} src/moved.js`,
  `git checkout ${FROZEN}`,
  `touch ${FROZEN}`,
  `ln -s README.md ${FROZEN}`,
  'rm {test,src}/a.test.js',
  "find test -type f -name '*.js' | sort | xargs -0 -n 1 rm",
  "find test -name '*.js' | sort | xargs -I {} rm {}",
  "find test -name '*.js' | xargs --replace={} rm {}",
]) test(`AC-5/AC-7/AC-8 (F6) protects ${command}`, () => verdicts(command));

test('AC-9 (F9) empty or unparsable stdin exits silently', () => {
  for (const input of ['', '  ', '{bad json']) {
    const result = spawnSync(process.execPath, [join(HOOKS, 'guard-tests.mjs')], {
      input, encoding: 'utf8', env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});
for (const command of [`rm ${FROZEN}`, `git rm ${FROZEN}`, `mv ${FROZEN} src/moved.js`, `git mv ${FROZEN} src/moved.js`, "find test -name 'a.test.js' -delete"]) {
  test(`AC-1/AC-5/AC-8 (F10) reports deleted for ${command}`, () => {
    const result = bash(command);
    assert.equal(result.decision, 'ask', result.reason);
    assert.match(result.reason, /test\/a\.test\.js would be deleted/);
    assert.doesNotMatch(result.reason, /test\/a\.test\.js would be amended/);
  });
}
test('AC-1/AC-5 (F10) truncate is amended and Edit/Write keep amended or added', () => {
  assert.match(bash(`truncate -s 0 ${FROZEN}`).reason, /would be amended/);
  for (const [tool_name, file_path, change] of [['Edit', FROZEN, 'amended'], ['Write', 'test/new.test.js', 'added']]) {
    const result = runConfigured({ cwd: dir, tool_name, tool_input: { file_path } }, {
      settings: GUARD_TESTS, env: { PATH: `${bin}${delimiter}${process.env.PATH}` },
    });
    assert.equal(result.decision, 'ask', result.reason);
    assert.ok(result.reason.includes(`would be ${change}`), result.reason);
  }
});
