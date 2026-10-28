// Issue #57 (ADR 0030): the merge decision of guard-git compares the pull request with the ATDD oracle.
//
// Before an agent merge, guard-git reads `oracle/<head branch>` from the remote of the pull request's base
// repository with a bounded `git ls-remote`, and compares the tag's commit with the pull request's head
// commit (`headRefOid`) over the test paths of global/hooks/oracle.mjs as recorded in the oracle commit. A
// changed test path, the label `atdd` without a tag, or an oracle that cannot be read is a reason: the main
// session asks, showing the tag, its commit and the changed files, and bypassPermissions denies. With neither
// a tag nor the label the oracle adds no reason and the explicit allow says that nothing was checked; with a
// clean oracle it names the tag and its commit.
//
// Each case runs the Bash entries of global/settings.json through claude-hooks.mjs with the real hooks. A
// fake `gh` and a fake `git` stand first on PATH: gh answers from a scenario; git answers `ls-remote` from a
// scenario and logs its arguments, and runs the real git (by absolute path) for everything else. The
// repositories are temporary clones of https://github.com/o/r.git, so no case touches the network. The
// fixtures repeat those of guard-git-local-work.test.mjs: a test file cannot import another without running
// its suites.
//
// The comparison is strict, like `oracle-check`: a branch updated from main after freezing, where main
// touched a test path, lists that file and asks. That is the accepted behaviour of ADR 0030.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { runConfigured } from './claude-hooks.mjs';
import { writeExecutable } from './executables.mjs';

// Git answers in the language of the machine and reads its user configuration; the fixtures and the hook
// get neither, and a developer's signing configuration cannot reach the commits.
const GIT_ENV = {
  LC_ALL: 'C',
  LANG: 'C',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

// The real git, by absolute path, resolved before the fake one is put on PATH.
const REAL_GIT = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();

function sh(cwd, ...args) {
  const r = spawnSync(REAL_GIT, args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

// A fake `gh` stands in for GitHub; it answers from a scenario.
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_GH, 'utf8'));
const args = process.argv.slice(2);
const kind = args[0] === 'pr' ? 'view' : args[0] === 'api'
  ? args.some((arg) => arg === 'user' || arg === '/user') ? 'user' : 'api' : 'other';
const step = scenario[kind] || { exit: 1, stderr: 'fake gh: unexpected call' };
if (step.stderr) process.stderr.write(step.stderr);
if (step.stdout !== undefined) process.stdout.write(typeof step.stdout === 'string' ? step.stdout : JSON.stringify(step.stdout));
process.exit(step.exit === undefined ? 0 : step.exit);
`;

// A fake `git` first on PATH. It hands every `ls-remote` to FAKE_LS_REMOTE and runs the real git for the
// rest. The hook spawns git by name, so PATH order decides.
const FAKE_GIT = String.raw`#!/bin/sh
case " $* " in
  *" ls-remote "*) exec node "$FAKE_LS_REMOTE" "$@" ;;
esac
exec "$REAL_GIT" "$@"
`;

// Logs the arguments of one ls-remote call (one JSON line) and answers from the scenario in
// FAKE_GIT_SCENARIO: stdout lines, stderr, an exit code, or a hang (`sleep`, in ms).
const FAKE_LS_REMOTE = String.raw`const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\n');
const step = JSON.parse(fs.readFileSync(process.env.FAKE_GIT_SCENARIO, 'utf8'));
const finish = () => {
  if (step.stderr) process.stderr.write(step.stderr);
  if (step.stdout) process.stdout.write(step.stdout);
  process.exit(step.exit === undefined ? 0 : step.exit);
};
if (step.sleep) setTimeout(finish, step.sleep); else finish();
`;

const NOT_FOUND = { exit: 1, stderr: 'gh: Not Found (HTTP 404)' };
const PASSED = { __typename: 'CheckRun', name: 'Test', status: 'COMPLETED', conclusion: 'SUCCESS' };

// A pull request that meets every other condition of the merge decision.
function green(rest = {}) {
  return {
    number: 12,
    state: 'OPEN',
    isDraft: false,
    labels: [],
    baseRefName: 'main',
    url: 'https://github.com/o/r/pull/12',
    author: { login: 'me', is_bot: false },
    isCrossRepository: false,
    headRepositoryOwner: { login: 'o' },
    headRepository: { name: 'r' },
    files: [{ path: 'src/app.ts' }],
    changedFiles: 1,
    statusCheckRollup: [PASSED],
    headRefName: 'feature/x',
    ...rest,
  };
}

const SQUASH = 'gh pr merge 12 --squash --delete-branch';
const ABSENT = { stdout: '' };
const label = (name) => ({ name });
const REASON_ABSENT = /missing|absent|not found|does not exist/i;
// What a reason says when something could not be read.
const REASON_UNREADABLE = /could not|cannot|can't|unable|failed|unknown|unreadable|not (?:found|available|present)|unavailable|missing/i;
const NO_ORACLE_CHECKED = /no oracle|not checked|nothing (?:was )?checked/i;

// The repository a remote, given by name or by URL, stands for: host/owner/repo in lower case.
function repository(dir, remote) {
  const url = /[:/]/.test(remote) ? remote : sh(dir, 'remote', 'get-url', remote);
  const match = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[/:](?:\d+\/)?([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
  assert.ok(match, `cannot read the remote ${url}`);
  return `${match[1]}/${match[2]}/${match[3]}`.toLowerCase();
}

describe('guard-git merge decision with the ATDD oracle (#57)', () => {
  let scratch;
  let bin;
  let counter = 0;
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cw-oracle-gate-'));
    bin = join(scratch, 'bin');
    mkdirSync(bin);
    writeExecutable(join(bin, 'gh'), FAKE_GH);
    writeExecutable(join(bin, 'git'), FAKE_GIT);
    writeFileSync(join(scratch, 'ls-remote.js'), FAKE_LS_REMOTE);
  });
  after(() => rmSync(scratch, { recursive: true, force: true }));

  // One commit with the given files (a null content deletes the file); returns its sha.
  function commit(dir, changes, subject) {
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) {
        rmSync(join(dir, path));
      } else {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
      }
    }
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-q', '-m', subject);
    return sh(dir, 'rev-parse', 'HEAD');
  }

  // A clone of o/r on github.com, left on `branch` with a clean working tree. main holds `base`; the branch
  // starts with one commit that adds `frozen`: the oracle commit, whose sha is what ls-remote answers. The
  // test then adds the commits after it, and the last one is the pull request's head.
  function clone({
    remote = 'https://github.com/o/r.git',
    remotes = {},
    branch = 'feature/x',
    base = {},
    frozen = { 'tests/login.test.mjs': 'one\n', 'tests/old.test.mjs': 'old\n' },
  } = {}) {
    const dir = mkdtempSync(join(scratch, 'clone-'));
    sh(dir, 'init', '-q', '-b', 'main');
    sh(dir, 'config', 'user.email', 'test@example.com');
    sh(dir, 'config', 'user.name', 'Test');
    sh(dir, 'config', 'commit.gpgsign', 'false');
    sh(dir, 'config', 'tag.gpgsign', 'false');
    sh(dir, 'remote', 'add', 'origin', remote);
    for (const [name, url] of Object.entries(remotes)) sh(dir, 'remote', 'add', name, url);
    commit(dir, { 'README.md': 'x\n', 'src/app.ts': 'app\n', ...base }, 'chore: init');
    sh(dir, 'checkout', '-q', '-b', branch);
    const oracle = commit(dir, frozen, 'test: add the acceptance tests');
    return { dir, branch, oracle, short: oracle.slice(0, 7) };
  }

  const headOf = (fx) => sh(fx.dir, 'rev-parse', 'HEAD');
  const tagAt = (fx, sha = fx.oracle) => ({ stdout: `${sha}\trefs/tags/oracle/${fx.branch}\n` });

  // The merge decision for the pull request of `fx`, through every entry of global/settings.json.
  // `lsRemote` is what `git ls-remote` answers; `pr` overrides fields of the pull request.
  function decide(fx, { lsRemote = tagAt(fx), labels = [], pr = {}, extra = {}, env = {}, command = SQUASH, timeoutMs } = {}) {
    counter += 1;
    const gh = join(scratch, `gh-${counter}.json`);
    const git = join(scratch, `git-${counter}.json`);
    const log = join(scratch, `git-${counter}.log`);
    const view = green({ headRefName: fx.branch, headRefOid: fx.head ?? headOf(fx), labels: labels.map(label), ...pr });
    writeFileSync(gh, JSON.stringify({ view: { stdout: view }, api: NOT_FOUND, user: { stdout: { login: 'me' } } }));
    writeFileSync(git, JSON.stringify(lsRemote));
    const result = runConfigured({ cwd: fx.dir, tool_name: 'Bash', tool_input: { command }, ...extra }, {
      timeoutMs,
      env: {
        ...GIT_ENV,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        FAKE_GH: gh,
        FAKE_GIT_SCENARIO: git,
        FAKE_GIT_LOG: log,
        FAKE_LS_REMOTE: join(scratch, 'ls-remote.js'),
        REAL_GIT,
        ...env,
      },
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    return { ...result, calls };
  }

  const wellRun = (result, name) => assert.deepEqual(result.failures, [], `${name}: ${result.stderr}`);
  const asks = (result, name, ...needles) => {
    wellRun(result, name);
    assert.equal(result.decision, 'ask', `${name}: ${result.reason}`);
    for (const needle of needles) {
      if (needle instanceof RegExp) assert.match(result.reason, needle, name);
      else assert.ok(result.reason.includes(needle), `${name}: the reason must include ${needle}: ${result.reason}`);
    }
  };
  const denies = (result, name, ...needles) => {
    wellRun(result, name);
    assert.equal(result.decision, 'deny', `${name}: ${result.reason}`);
    for (const needle of needles) {
      if (needle instanceof RegExp) assert.match(result.reason, needle, name);
      else assert.ok(result.reason.includes(needle), `${name}: the reason must include ${needle}: ${result.reason}`);
    }
  };
  const allowsExplicitly = (result, name, ...needles) => {
    wellRun(result, name);
    assert.equal(result.decision, 'allow', `${name}: ${result.reason}`);
    assert.equal(result.explicit, true, `${name}: the explicit allow of a clean merge was expected`);
    for (const needle of needles) {
      if (needle instanceof RegExp) assert.match(result.reason, needle, name);
      else assert.ok(result.reason.includes(needle), `${name}: the reason must include ${needle}: ${result.reason}`);
    }
  };
  const notExplicitAllow = (result, name) => {
    assert.ok(!(result.decision === 'allow' && result.explicit), `${name}: the explicit allow was given: ${result.reason}`);
  };
  // The tag refs a call of ls-remote asked for, without the peeling suffix.
  const askedRefs = (call) => [...new Set(call.args.filter((arg) => /oracle/.test(arg)).map((arg) => arg.replace(/\^\{\}$/, '')))];

  // AC-1: a test path differs between the oracle commit and the head.
  test('AC-1 (#57) asks, naming the tag, its commit and the file, when a frozen test was modified after the oracle', () => {
    const fx = clone();
    commit(fx.dir, { 'tests/login.test.mjs': 'two\n', 'src/app.ts': 'app2\n' }, 'fix: weaken a frozen test');
    const r = decide(fx);
    asks(r, 'modified test', `oracle/${fx.branch}`, fx.short, 'tests/login.test.mjs');
    notExplicitAllow(r, 'modified test');
  });

  test('AC-1 (#57) asks, naming the tag, its commit and the file, when a frozen test was deleted after the oracle', () => {
    const fx = clone();
    commit(fx.dir, { 'tests/old.test.mjs': null }, 'fix: drop a frozen test');
    asks(decide(fx), 'deleted test', `oracle/${fx.branch}`, fx.short, 'tests/old.test.mjs');
  });

  test('AC-1 (#57) asks, naming the tag, its commit and the file, when a test file was added after the oracle', () => {
    const fx = clone();
    commit(fx.dir, { 'tests/extra.test.mjs': 'extra\n' }, 'test: add a test after the oracle');
    asks(decide(fx), 'added test', `oracle/${fx.branch}`, fx.short, 'tests/extra.test.mjs');
  });

  test('AC-1 (#57) lists every changed test file, one for each kind of change, across several commits', () => {
    const fx = clone();
    commit(fx.dir, { 'tests/login.test.mjs': 'two\n' }, 'fix: modify');
    commit(fx.dir, { 'tests/old.test.mjs': null }, 'fix: delete');
    commit(fx.dir, { 'tests/extra.test.mjs': 'extra\n', 'src/app.ts': 'app2\n' }, 'feat: add');
    asks(decide(fx), 'three kinds', `oracle/${fx.branch}`, fx.short, 'tests/login.test.mjs', 'tests/old.test.mjs', 'tests/extra.test.mjs');
  });

  test('AC-1 (#57) asks for a changed test whether or not the pull request carries the label atdd', () => {
    for (const labels of [[], ['atdd'], ['ATDD', 'bug']]) {
      const fx = clone();
      commit(fx.dir, { 'tests/login.test.mjs': 'two\n' }, 'fix: weaken a frozen test');
      const r = decide(fx, { labels });
      asks(r, `labels ${labels}`, `oracle/${fx.branch}`, fx.short, 'tests/login.test.mjs');
      notExplicitAllow(r, `labels ${labels}`);
    }
  });

  test('AC-1 (#57) reads the tag of a branch with two slashes, asking the remote for exactly that ref', () => {
    const fx = clone({ branch: 'feature/a/b' });
    commit(fx.dir, { 'tests/login.test.mjs': 'two\n' }, 'fix: weaken a frozen test');
    const r = decide(fx);
    asks(r, 'two slashes', 'oracle/feature/a/b', fx.short, 'tests/login.test.mjs');
    assert.ok(r.calls.length > 0, 'git ls-remote was not called');
    for (const call of r.calls) assert.deepEqual(askedRefs(call), ['refs/tags/oracle/feature/a/b'], JSON.stringify(call.args));
  });

  test('AC-1 (#57) asks the remote for refs/tags/oracle/<head branch> and for nothing else about oracles', () => {
    const fx = clone();
    commit(fx.dir, { 'tests/login.test.mjs': 'two\n' }, 'fix: weaken a frozen test');
    const r = decide(fx);
    assert.ok(r.calls.length > 0, 'git ls-remote was not called');
    for (const call of r.calls) assert.deepEqual(askedRefs(call), ['refs/tags/oracle/feature/x'], JSON.stringify(call.args));
  });

  test('AC-1 (#57) compares the test paths the oracle commit declares in .atdd/test-paths, and asks for a change there', () => {
    const fx = clone({ frozen: { '.atdd/test-paths': 'spec/**\n', 'spec/a_spec.rb': 'one\n', 'tests/own.test.mjs': 'own\n' } });
    commit(fx.dir, { 'spec/a_spec.rb': 'two\n' }, 'fix: weaken a frozen spec');
    asks(decide(fx), 'declared glob', `oracle/${fx.branch}`, fx.short, 'spec/a_spec.rb');
  });

  test('AC-1 (#57) asks for a later edit to .atdd/test-paths itself, whatever it says', () => {
    const fx = clone({ frozen: { '.atdd/test-paths': 'spec/**\n', 'spec/a_spec.rb': 'one\n' } });
    commit(fx.dir, { '.atdd/test-paths': 'spec/**\nsrc/**\n' }, 'chore: widen what may change');
    asks(decide(fx), 'test-paths edit', `oracle/${fx.branch}`, fx.short, '.atdd/test-paths');
  });

  test('AC-6 (#57) does not count a file outside the paths the oracle commit declares as a test', () => {
    // The declaration in the oracle commit replaces the defaults, so tests/own.test.mjs is not a test path here.
    const fx = clone({ frozen: { '.atdd/test-paths': 'spec/**\n', 'spec/a_spec.rb': 'one\n', 'tests/own.test.mjs': 'own\n' } });
    commit(fx.dir, { 'tests/own.test.mjs': 'changed\n', 'src/app.ts': 'app2\n' }, 'feat: change what is not a test here');
    allowsExplicitly(decide(fx), 'outside the declared paths', `oracle/${fx.branch}`, fx.short);
  });

  test('AC-1 (#57) lists a test path that main changed after the freezing and the branch merged in (the strict comparison of ADR 0030)', () => {
    const fx = clone({ base: { 'tests/shared.test.mjs': 'one\n' } });
    sh(fx.dir, 'checkout', '-q', 'main');
    commit(fx.dir, { 'tests/shared.test.mjs': 'two\n' }, 'test: main changes a shared test');
    sh(fx.dir, 'checkout', '-q', fx.branch);
    sh(fx.dir, 'merge', '-q', '--no-edit', 'main');
    commit(fx.dir, { 'src/app.ts': 'app2\n' }, 'feat: production code after the update');
    asks(decide(fx), 'updated from main', `oracle/${fx.branch}`, fx.short, 'tests/shared.test.mjs');
  });

  // AC-2: the label atdd promises an oracle.
  test('AC-2 (#57) asks, saying the oracle tag is missing, when the label atdd is there and the remote has no tag', () => {
    for (const labels of [['atdd'], ['ATDD'], ['bug', 'Atdd']]) {
      const fx = clone();
      commit(fx.dir, { 'src/app.ts': 'app2\n' }, 'feat: code');
      const r = decide(fx, { lsRemote: ABSENT, labels });
      asks(r, `labels ${labels}`, `oracle/${fx.branch}`, REASON_ABSENT);
      notExplicitAllow(r, `labels ${labels}`);
      assert.ok(r.calls.length > 0, 'git ls-remote was not called');
    }
  });

  // AC-3: neither a tag nor the label.
  test('AC-3 (#57) adds no reason, and the explicit allow says that no oracle was checked, without a tag or the label atdd', () => {
    const fx = clone();
    commit(fx.dir, { 'src/app.ts': 'app2\n' }, 'feat: code');
    const r = decide(fx, { lsRemote: ABSENT });
    allowsExplicitly(r, 'no oracle', /oracle/i, NO_ORACLE_CHECKED);
    assert.ok(r.calls.length > 0, 'git ls-remote was not called');
  });

  // Merging from a directory that is not a clone of the pull request's repository does not skip the oracle:
  // the hook asks the base repository's URL for the tag. A clone of another repository, a repository with no
  // remote, and a directory that is not a repository (a merge with -R o/r) all count. The tag's commit and the
  // head cannot be in such a directory, so a tag that exists cannot be compared and the human is asked.
  const ELSEWHERE = ['a clone of another repository', 'a repository with no remote', 'a directory that is not a repository'];
  const ELSEWHERE_MERGE = 'gh pr merge 12 --squash -R o/r';
  function elsewhere(kind) {
    const dir = mkdtempSync(join(scratch, 'elsewhere-'));
    if (kind !== ELSEWHERE[2]) {
      sh(dir, 'init', '-q', '-b', 'main');
      sh(dir, 'config', 'user.email', 'test@example.com');
      sh(dir, 'config', 'user.name', 'Test');
      sh(dir, 'config', 'commit.gpgsign', 'false');
      if (kind === ELSEWHERE[0]) sh(dir, 'remote', 'add', 'origin', 'https://github.com/other/thing.git');
      commit(dir, { 'README.md': 'other\n' }, 'chore: init');
    }
    // Commits the directory does not hold.
    return { dir, branch: 'feature/x', oracle: 'd'.repeat(40), short: 'd'.repeat(7), head: 'e'.repeat(40) };
  }
  // Every ls-remote call of `r` was aimed at the base repository, by remote name or by URL.
  const asksBaseRepository = (r, dir, name) => {
    assert.ok(r.calls.length > 0, `${name}: git ls-remote was not called`);
    for (const call of r.calls) {
      const at = call.args.indexOf('ls-remote');
      const target = call.args.slice(at + 1).filter((arg) => arg !== '--' && !arg.startsWith('-') && !/oracle/.test(arg))[0];
      assert.ok(target, `${name}: no remote in ${JSON.stringify(call.args)}`);
      assert.equal(repository(dir, target), 'github.com/o/r', `${name}: ls-remote was pointed at ${target}`);
    }
  };

  for (const kind of ELSEWHERE) {
    test(`AC-3 (#57) reads the tag from the base repository, and says no oracle was checked when there is none, from ${kind}`, () => {
      const fx = elsewhere(kind);
      const r = decide(fx, { lsRemote: ABSENT, command: ELSEWHERE_MERGE });
      allowsExplicitly(r, kind, /oracle/i, NO_ORACLE_CHECKED);
      asksBaseRepository(r, fx.dir, kind);
    });

    test(`AC-2 (#57) asks, saying the oracle tag is missing, when the label atdd is there and the base repository has none, from ${kind}`, () => {
      const fx = elsewhere(kind);
      const r = decide(fx, { lsRemote: ABSENT, labels: ['atdd'], command: ELSEWHERE_MERGE });
      asks(r, kind, `oracle/${fx.branch}`, REASON_ABSENT);
      asksBaseRepository(r, fx.dir, kind);
    });

    test(`AC-4 (#57) asks, saying the oracle could not be compared, when the tag exists and the commits are not here, from ${kind}`, () => {
      const fx = elsewhere(kind);
      const r = decide(fx, { command: ELSEWHERE_MERGE });
      asks(r, kind, /oracle/i, REASON_UNREADABLE);
      notExplicitAllow(r, kind);
      asksBaseRepository(r, fx.dir, kind);
    });
  }

  test('AC-4 (#57) asks, saying the oracle could not be read, when the tag does not point to a commit', () => {
    // The comparison cannot run against a blob; ls-remote answers the sha of one the clone holds.
    const fx = clone();
    commit(fx.dir, { 'src/app.ts': 'app2\n' }, 'feat: code');
    const blob = spawnSync(REAL_GIT, ['hash-object', '-w', '--stdin'], {
      cwd: fx.dir, input: 'not a commit\n', encoding: 'utf8', env: { ...process.env, ...GIT_ENV },
    }).stdout.trim();
    assert.match(blob, /^[0-9a-f]{40}$/);
    const r = decide(fx, { lsRemote: tagAt(fx, blob) });
    asks(r, 'tag on a blob', /oracle/i, REASON_UNREADABLE);
    notExplicitAllow(r, 'tag on a blob');
  });

  // AC-4: an oracle that cannot be read is never a pass.
  test('AC-4 (#57) asks, saying the oracle could not be read, when git ls-remote fails', () => {
    const fx = clone();
    commit(fx.dir, { 'src/app.ts': 'app2\n' }, 'feat: code');
    const r = decide(fx, { lsRemote: { exit: 128, stderr: 'fatal: unable to access the remote\n' } });
    asks(r, 'ls-remote fails', /oracle/i, REASON_UNREADABLE);
    notExplicitAllow(r, 'ls-remote fails');
  });

  test('AC-4 (#57) asks within the time budget, saying the oracle could not be read, when git ls-remote hangs', () => {
    const fx = clone();
    commit(fx.dir, { 'src/app.ts': 'app2\n' }, 'feat: code');
    const started = Date.now();
    // The hook shares one budget between gh and ls-remote; the entry itself would wait 30 s. The harness
    // gives the run 20 s so that a hook that does not stop waiting fails here rather than hanging the suite.
    const r = decide(fx, {
      lsRemote: { sleep: 60000, stdout: `${fx.oracle}\trefs/tags/oracle/${fx.branch}\n` },
      env: { GUARD_GIT_GH_BUDGET_MS: '4000', GUARD_GIT_GH_TIMEOUT_MS: '1000' },
      timeoutMs: 20000,
    });
    assert.ok(Date.now() - started < 18000, `the merge decision took ${Date.now() - started} ms`);
    asks(r, 'ls-remote hangs', /oracle/i, /timed out|time budget|timeout|time out/i);
    notExplicitAllow(r, 'ls-remote hangs');
  });

  test('AC-4 (#57) asks, saying the oracle could not be read, when the tag\'s commit is not in the local clone', () => {
    const fx = clone();
    commit(fx.dir, { 'src/app.ts': 'app2\n' }, 'feat: code');
    const r = decide(fx, { lsRemote: tagAt(fx, 'd'.repeat(40)) });
    asks(r, 'tag commit absent', /oracle/i, REASON_UNREADABLE);
    notExplicitAllow(r, 'tag commit absent');
  });

  test('AC-4 (#57) asks, saying the oracle could not be read, when the head commit is not in the local clone', () => {
    // No local branch of the pull request exists, so the local work check (#53) has nothing to say.
    const fx = clone();
    commit(fx.dir, { 'src/app.ts': 'app2\n' }, 'feat: code');
    sh(fx.dir, 'checkout', '-q', '--detach');
    sh(fx.dir, 'branch', '-q', '-D', fx.branch);
    const r = decide(fx, { pr: { headRefOid: 'c'.repeat(40) } });
    asks(r, 'head commit absent', /oracle/i, REASON_UNREADABLE);
    notExplicitAllow(r, 'head commit absent');
  });

  // AC-5: bypassPermissions shows no prompt, so a question about the oracle becomes a denial.
  test('AC-5 (#57) denies in bypassPermissions when a frozen test changed, the oracle tag is missing, or the oracle cannot be read', () => {
    const changed = clone();
    commit(changed.dir, { 'tests/login.test.mjs': 'two\n' }, 'fix: weaken a frozen test');
    denies(decide(changed, { extra: { permission_mode: 'bypassPermissions' } }), 'changed test', /oracle/i);

    const missing = clone();
    commit(missing.dir, { 'src/app.ts': 'app2\n' }, 'feat: code');
    denies(decide(missing, { lsRemote: ABSENT, labels: ['atdd'], extra: { permission_mode: 'bypassPermissions' } }), 'missing tag', /oracle/i);

    const unreadable = clone();
    commit(unreadable.dir, { 'src/app.ts': 'app2\n' }, 'feat: code');
    denies(decide(unreadable, {
      lsRemote: { exit: 128, stderr: 'fatal: unable to access the remote\n' },
      extra: { permission_mode: 'bypassPermissions' },
    }), 'unreadable', /oracle/i);
  });

  test('AC-5 (#57) still asks, and does not deny, for the same situations in a mode that shows prompts', () => {
    const fx = clone();
    commit(fx.dir, { 'tests/login.test.mjs': 'two\n' }, 'fix: weaken a frozen test');
    for (const permission_mode of ['default', 'acceptEdits']) {
      asks(decide(fx, { extra: { permission_mode } }), permission_mode, `oracle/${fx.branch}`);
    }
  });

  // AC-6: a clean oracle.
  test('AC-6 (#57) gives the explicit allow, naming the tag and its commit, when only production code changed after the oracle', () => {
    const fx = clone();
    commit(fx.dir, { 'src/app.ts': 'app2\n' }, 'feat: first');
    commit(fx.dir, { 'src/extra.ts': 'extra\n' }, 'feat: second');
    allowsExplicitly(decide(fx), 'clean', `oracle/${fx.branch}`, fx.short);
  });

  test('AC-6 (#57) gives the explicit allow, naming the tag and its commit, when the label atdd is there and the oracle is clean', () => {
    const fx = clone();
    commit(fx.dir, { 'src/app.ts': 'app2\n' }, 'feat: code');
    allowsExplicitly(decide(fx, { labels: ['atdd'] }), 'clean with label', `oracle/${fx.branch}`, fx.short);
  });

  test('AC-6 (#57) gives the explicit allow for a head that is the oracle commit itself', () => {
    const fx = clone();
    allowsExplicitly(decide(fx), 'head is the oracle', `oracle/${fx.branch}`, fx.short);
  });

  // AC-8: a merge-method flag with a value, or another method, is never verified as a squash.
  test('AC-8 (#57) never gives the explicit allow for a merge-method flag with a value, --merge or --rebase', () => {
    const fx = clone();
    commit(fx.dir, { 'src/app.ts': 'app2\n' }, 'feat: code');
    for (const command of [
      'gh pr merge 12 --squash=false --merge',
      'gh pr merge 12 --squash=false',
      'gh pr merge 12 --squash=true',
      'gh pr merge 12 --squash --merge',
      'gh pr merge 12 --squash --rebase',
      'gh pr merge 12 -s -m',
      'gh pr merge 12 --squash -r',
    ]) {
      const r = decide(fx, { lsRemote: ABSENT, command });
      wellRun(r, command);
      notExplicitAllow(r, command);
    }
  });

  test('AC-8 (#57) still gives the explicit allow for the plain squash merge that the other cases are measured against', () => {
    const fx = clone();
    commit(fx.dir, { 'src/app.ts': 'app2\n' }, 'feat: code');
    allowsExplicitly(decide(fx, { lsRemote: ABSENT, command: 'gh pr merge 12 --squash' }), 'plain squash');
    allowsExplicitly(decide(fx, { lsRemote: ABSENT, command: 'gh pr merge 12 -s --delete-branch' }), 'short squash');
  });

  // The oracle of a pull request from a fork must be on the base repository.
  test('AC-1 (#57) reads the oracle tag from the base repository, never from the fork of a cross-repository pull request', () => {
    const fx = clone({ remotes: { fork: 'https://github.com/forker/r.git' } });
    commit(fx.dir, { 'src/app.ts': 'app2\n' }, 'feat: code');
    const r = decide(fx, {
      pr: { isCrossRepository: true, headRepositoryOwner: { login: 'forker' }, headRepository: { name: 'r' } },
    });
    wellRun(r, 'fork');
    asksBaseRepository(r, fx.dir, 'fork');
  });
});
