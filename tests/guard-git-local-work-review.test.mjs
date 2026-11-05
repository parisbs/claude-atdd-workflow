// Issue #72 review: run the configured entries with real hooks, isolated repositories and fake
// gh/git/ssh first on PATH. Local git stays real; remote reads never reach the network. POSIX-only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { hookBudget } from './hook-budget.mjs';
import { handlersFor, runConfigured } from './claude-hooks.mjs';
import { writeExecutable } from './executables.mjs';
import { fixtureGit, GIT_ENV } from './git-fixture.mjs';

const posix = process.platform === 'win32' ? 'the hook tests are POSIX-only' : false;
const REAL_GIT = posix ? '' : spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const SQUASH = 'gh pr merge 12 --squash --delete-branch';
const NOT_FOUND = { exit: 1, stderr: 'gh: Not Found (HTTP 404)' };

function sh(cwd, ...args) {
  const r = fixtureGit(cwd, ...args);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
if (!process.env.FAKE_GH) process.exit(0);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH + '.calls', JSON.stringify(args) + '\n');
const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_GH, 'utf8'));
const kind = args[0] === 'pr' ? 'view' : args[0] === 'api'
  ? args.some((arg) => arg === 'user' || arg === '/user') ? 'user' : 'api' : 'other';
const step = scenario[kind] || { exit: 1, stderr: 'fake gh: unexpected call' };
const finish = () => {
  if (step.stderr) process.stderr.write(step.stderr);
  if (step.stdout !== undefined) process.stdout.write(typeof step.stdout === 'string' ? step.stdout : JSON.stringify(step.stdout));
  process.exit(step.exit === undefined ? 0 : step.exit);
};
finish();
`;

const FAKE_GIT = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
if (!process.env.REAL_GIT) process.exit(0);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify({ cwd: process.cwd(), args }) + '\n');
if (args.includes('ls-remote')) {
  if (process.env.ORACLE_COMMIT) process.stdout.write(process.env.ORACLE_COMMIT + '\trefs/tags/oracle/feature/x\n');
  process.exit(0);
}
if (process.env.OLD_GIT === '1' && args.includes('worktree') && args.includes('list') && args.includes('-z')) {
  process.stderr.write('error: unknown switch ' + String.fromCharCode(96) + 'z' + String.fromCharCode(39) + '\n');
  process.exit(129);
}
const finish = () => {
  const r = spawnSync(process.env.REAL_GIT, args, { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
};
finish();
`;

// OpenSSH uses the passwd home; fake -G makes alias resolution independent of the developer's config.
const FAKE_SSH = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
if (!process.env.FAKE_SSH_LOG) process.exit(0);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(args) + '\n');
if (!args.includes('-G') || !args.includes('gh-work')) {
  process.stderr.write('fake ssh: unexpected call\n');
  process.exit(1);
}
process.stdout.write('hostname github.com\n');
`;

function green(headRefOid) {
  return {
    number: 12, state: 'OPEN', isDraft: false, labels: [], baseRefName: 'main',
    url: 'https://github.com/o/r/pull/12', author: { login: 'me', is_bot: false },
    isCrossRepository: false, headRepositoryOwner: { login: 'o' }, headRepository: { name: 'r' },
    files: [{ path: 'src/app.ts' }], changedFiles: 1,
    statusCheckRollup: [{ __typename: 'CheckRun', name: 'Test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    headRefName: 'feature/x', headRefOid,
  };
}

function lines(path) {
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : [];
}

const allowed = (r) => {
  assert.deepEqual(r.failures, [], r.stderr);
  assert.equal(r.decision, 'allow', r.reason);
  assert.equal(r.explicit, true, 'the clean pull request must get an explicit allow');
};
const asks = (r, ...needles) => {
  assert.deepEqual(r.failures, [], r.stderr);
  assert.equal(r.decision, 'ask', r.reason);
  for (const needle of needles) assert.ok(r.reason.includes(needle), `the reason must include ${needle}: ${r.reason}`);
};

describe('guard-git local-work review (#72)', { skip: posix }, () => {
  let scratch;
  let bin;
  let scenarios = 0;
  before(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'cw-local-review-')));
    bin = join(scratch, 'bin');
    mkdirSync(bin);
    writeExecutable(join(bin, 'gh'), FAKE_GH);
    writeExecutable(join(bin, 'git'), FAKE_GIT);
    writeExecutable(join(bin, 'ssh'), FAKE_SSH);
  });
  after(() => rmSync(scratch, { recursive: true, force: true }));

  function clone(remote = 'https://github.com/o/r.git') {
    const dir = mkdtempSync(join(scratch, 'clone-'));
    sh(dir, 'init', '-q', '-b', 'main');
    sh(dir, 'config', 'user.name', 'Test');
    sh(dir, 'config', 'user.email', 'test@example.com');
    sh(dir, 'remote', 'add', 'origin', remote);
    writeFileSync(join(dir, 'app.txt'), 'base\n');
    mkdirSync(join(dir, 'tests'));
    writeFileSync(join(dir, 'tests', 'app.test.mjs'), '// Frozen test fixture.\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'chore: init');
    sh(dir, 'checkout', '-q', '-b', 'feature/x');
    writeFileSync(join(dir, 'app.txt'), 'first\n');
    sh(dir, 'commit', '-q', '-am', 'feat: first');
    const head = sh(dir, 'rev-parse', 'HEAD');
    sh(dir, 'checkout', '-q', 'main');
    return { dir, head };
  }

  function worktree(dir, { detached = false, quoted = false } = {}) {
    const wt = mkdtempSync(join(scratch, quoted ? '"wt-' : 'wt-'));
    sh(dir, 'worktree', 'add', '-q', ...(detached ? ['--detach'] : []), wt, 'feature/x');
    return wt;
  }

  function extraCommit(dir) {
    sh(dir, 'checkout', '-q', 'feature/x');
    writeFileSync(join(dir, 'app.txt'), 'local amendment\n');
    sh(dir, 'commit', '-q', '-am', 'fix: local amendment');
    const extra = sh(dir, 'rev-parse', 'HEAD');
    sh(dir, 'checkout', '-q', 'main');
    return extra;
  }

  function decide(dir, head, { env = {}, command = SQUASH, entry, budget = hookBudget() } = {}) {
    budget.require('guard-git', { PATH: `${bin}${delimiter}${process.env.PATH}` });
    const file = join(scratch, `scenario-${++scenarios}.json`);
    writeFileSync(file, JSON.stringify({ view: { stdout: green(head) }, user: { stdout: { login: 'me' } }, api: NOT_FOUND }));
    // R1 checks one configured entry; only the harness watchdog is enlarged for virtual time.
    const settings = entry ? {
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: handlersFor('Bash').filter((h) =>
        h.command.includes('guard-git.mjs') && h.command.includes(` --${entry}`)) }] },
    } : undefined;
    const started = performance.now();
    const r = runConfigured({ cwd: dir, permission_mode: 'default', tool_name: 'Bash', tool_input: { command } }, {
      settings, timeoutMs: 120000,
      env: {
        ...GIT_ENV, PATH: `${bin}${delimiter}${process.env.PATH}`, REAL_GIT,
        FAKE_GH: file, FAKE_GIT_LOG: `${file}.git`, FAKE_SSH_LOG: `${file}.ssh`,
        GIT_SSH_COMMAND: 'ssh', GIT_SSH_VARIANT: 'ssh',
        ORACLE_COMMIT: '', OLD_GIT: '',
        GUARD_GIT_GH_TIMEOUT_MS: '6000', GUARD_GIT_GH_BUDGET_MS: '10000', ...budget.env, ...env,
      },
    });
    budget.active('guard-git');
    return {
      ...r, elapsed: performance.now() - started,
      gh: lines(`${file}.calls`).map(JSON.parse), git: lines(`${file}.git`).map(JSON.parse),
      ssh: lines(`${file}.ssh`).map(JSON.parse),
    };
  }

  test('AC-2 (#84) R1 F1 two slow merge segments ask inside the logical merge deadline', () => {
    const { dir, head } = clone();
    sh(dir, 'tag', 'oracle/feature/x', head);
    const [entry] = handlersFor('Bash').filter((h) => h.command.includes(' --merge-only'));
    assert.equal(entry.timeout, 30);
    assert.equal(entry.onFailure, 'block', 'a timed-out merge decision must still block');
    const budget = hookBudget({ steps: [
      ...[1, 2].map((occurrence) => ({ program: 'git', args: ['worktree', 'list'], occurrence, elapsedMs: 5000 })),
      ...[1, 2].map((occurrence) => ({ program: 'gh', args: ['pr', 'view'], occurrence, elapsedMs: 600 })),
    ] });
    const r = decide(dir, head, { budget,
      command: `${SQUASH} && gh pr merge 13 --squash --delete-branch`, entry: 'merge-only',
      env: { ORACLE_COMMIT: head },
    });
    assert.equal(budget.charged('guard-git', 4).filter((event) => event.timedOut).length, 2);
    assert.ok(budget.events().filter((event) => event.type === 'charge').every((event) => event.nowMs < 27000));
    assert.equal(r.ran.length, 1, 'measure only the configured merge entry');
    assert.equal(r.gh.filter((args) => args[0] === 'pr').length, 2, 'both merge segments must be evaluated');
    assert.ok(r.git.some(({ args }) => args.includes('ls-remote')), 'the oracle lookup must be exercised');
    asks(r);
    assert.doesNotMatch(r.reason, /blocking because|timed out after 30000 ms/);
  });

  test('AC-2 (#84) R1 F10 a slow oracle forced push asks inside the logical every-Bash deadline', () => {
    const { dir, head } = clone();
    sh(dir, 'tag', 'oracle/feature/x', head);
    const [entry] = handlersFor('Bash').filter((h) => h.command.includes(' --skip-merge'));
    assert.equal(entry.timeout, 15);
    const budget = hookBudget({ steps: [{ program: 'git', args: ['branch', '--show-current'], occurrence: 1, elapsedMs: 12000 }] });
    const r = decide(dir, head, { budget,
      command: 'git push -f origin oracle/feature/x', entry: 'skip-merge',
      env: { ORACLE_COMMIT: head, GUARD_GIT_DECISION_BUDGET_MS: '20000' },
    });
    const [charge] = budget.charged('guard-git');
    assert.equal(charge.timedOut, true);
    assert.equal(charge.timeoutMs, 12000, 'the process deadline must cap a larger decision budget');
    assert.equal(r.ran.length, 1, 'measure only the configured every-Bash entry');
    assert.ok(r.git.length > 0, 'slow local git must run');
    asks(r);
  });

  test('R2 F2 oracle discovery resolves the clone SSH alias and compares through its remote', () => {
    const { dir, head } = clone('git@gh-work:o/r.git');
    sh(dir, 'tag', 'oracle/feature/x', head);
    const r = decide(dir, head, { env: { ORACLE_COMMIT: head } });
    const lookups = r.git.filter(({ args }) => args.includes('ls-remote'));
    assert.ok(r.ssh.some((args) => args.includes('-G') && args.includes('gh-work')), 'resolve the SSH alias');
    assert.ok(lookups.length > 0, 'read the remote oracle');
    assert.doesNotMatch(r.reason, /no local clone of the base repository holds/);
    assert.ok(lookups.every(({ args }) => args.includes('origin') || args.includes('git@gh-work:o/r.git')),
      `ls-remote must use the alias remote: ${JSON.stringify(lookups)}`);
    assert.ok(!lookups.some(({ args }) => args.includes('https://github.com/o/r')), 'do not fall back to HTTPS');
    allowed(r);
    assert.match(r.reason, /test paths unchanged/);
    assert.ok(r.git.some(({ args }) => args.includes('diff') && args.includes(head)), 'compare the committed oracle trees');
  });

  test('R3 F5 a detached non-rebasing worktree adds no local-work reason', () => {
    const { dir, head } = clone();
    const wt = worktree(dir, { detached: true });
    assert.equal(fixtureGit(wt, 'symbolic-ref', '-q', 'HEAD').status, 1);
    const gitdir = sh(wt, 'rev-parse', '--absolute-git-dir');
    assert.ok(!existsSync(join(gitdir, 'rebase-merge')) && !existsSync(join(gitdir, 'rebase-apply')));
    writeFileSync(join(wt, 'app.txt'), 'unrelated detached work\n');
    const r = decide(dir, head);
    allowed(r);
    assert.ok(!r.reason.includes(wt), r.reason);
    assert.doesNotMatch(r.reason, /Uncommitted changes|Rebase in progress|Could not read the local/);
  });

  test('R3 F4 a locked detached worktree whose directory is gone adds no local-work reason', () => {
    const { dir, head } = clone();
    const wt = worktree(dir, { detached: true });
    sh(dir, 'worktree', 'lock', '--reason', 'offline detached checkout', wt);
    rmSync(wt, { recursive: true, force: true });
    const record = sh(dir, 'worktree', 'list', '--porcelain', '-z').split('\0\0')
      .find((entry) => entry.includes(`worktree ${wt}\0`));
    assert.ok(record, 'the missing worktree must remain registered');
    assert.ok(record.includes('\0detached\0') && record.includes('\0locked '), record);
    assert.ok(!record.includes('\0prunable'), 'locking keeps the missing worktree from being prunable');
    const r = decide(dir, head);
    allowed(r);
    assert.ok(!r.reason.includes(wt), r.reason);
    assert.doesNotMatch(r.reason, /Could not read the local/);
  });

  test('R3 F5 a stash made on another branch adds no local-work reason', () => {
    const { dir, head } = clone();
    sh(dir, 'checkout', '-q', '-b', 'feature/other');
    writeFileSync(join(dir, 'app.txt'), 'other branch work\n');
    sh(dir, 'stash', 'push');
    assert.match(sh(dir, 'stash', 'list', '--format=%gs'), /^WIP on feature\/other:/);
    assert.equal(sh(dir, 'status', '--porcelain'), '');
    sh(dir, 'checkout', '-q', 'main');
    const r = decide(dir, head);
    allowed(r);
    assert.doesNotMatch(r.reason, /Stashed local work|stash@/);
  });

  for (const remote of ['me@gh-work:o/r.git', 'gh-work:o/r.git']) {
    test(`R4 F8 local work is checked for the scp remote ${remote}`, () => {
      const { dir, head } = clone();
      const extra = extraCommit(dir);
      asks(decide(dir, head), extra.slice(0, 7), 'fix: local amendment');
      sh(dir, 'remote', 'set-url', 'origin', remote);
      const r = decide(dir, head);
      asks(r, extra.slice(0, 7), 'fix: local amendment');
      assert.ok(r.ssh.some((args) => args.includes('-G') && args.includes('gh-work')), 'resolve the scp host alias');
    });
  }

  test('R5 F3 old-git porcelain reads a worktree directory name starting with a double quote', () => {
    const { dir, head } = clone();
    const wt = worktree(dir, { quoted: true });
    assert.ok(basename(wt).startsWith('"'));
    writeFileSync(join(wt, 'app.txt'), 'uncommitted\n');
    const porcelain = sh(dir, '-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain');
    assert.ok(porcelain.split('\n').includes(`worktree ${wt}`), 'real git prints the path without quoting');
    const r = decide(dir, head, { env: { OLD_GIT: '1' } });
    assert.ok(r.git.some(({ args }) => args.includes('worktree') && args.includes('-z')), 'exercise the old-git rejection');
    assert.ok(r.git.some(({ args }) => args.includes('core.quotePath=false') && args.includes('worktree')), 'use the porcelain fallback');
    asks(r, 'Uncommitted changes', wt, 'app.txt');
    assert.ok(r.git.some(({ cwd, args }) => cwd === wt && args.includes('status')), 'read status at the real worktree path');
    assert.doesNotMatch(r.reason, /Could not read a quoted path|Could not read the local/);
  });

  test('R6 F-A names a detached rebasing worktree whose gitdir uses a relative path', (t) => {
    const version = sh(scratch, '--version');
    const match = /^git version (\d+)\.(\d+)/.exec(version);
    assert.ok(match, version);
    if (Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 48)) {
      t.skip('relative worktree paths require Git 2.48 or newer');
      return;
    }
    const { dir, head } = clone();
    writeFileSync(join(dir, 'app.txt'), 'main change\n');
    sh(dir, 'commit', '-q', '-am', 'feat: conflicting main');
    const wt = mkdtempSync(join(scratch, 'wt-'));
    sh(dir, '-c', 'worktree.useRelativePaths=true', 'worktree', 'add', '-q', wt, 'feature/x');
    const gitdir = sh(wt, 'rev-parse', '--absolute-git-dir');
    const target = readFileSync(join(gitdir, 'gitdir'), 'utf8').trim();
    assert.ok(!isAbsolute(target), 'the linked worktree gitdir must hold a relative path');
    assert.equal(resolve(gitdir, target), join(wt, '.git'));
    const rebase = fixtureGit(wt, 'rebase', '--merge', 'main');
    assert.equal(rebase.status, 1, rebase.stderr);
    assert.match(rebase.stdout + rebase.stderr, /CONFLICT/);
    assert.equal(readFileSync(join(gitdir, 'rebase-merge', 'head-name'), 'utf8').trim(), 'refs/heads/feature/x');
    assert.equal(fixtureGit(wt, 'symbolic-ref', '-q', 'HEAD').status, 1, 'the rebase worktree must be detached');
    assert.equal(sh(dir, 'rev-parse', 'feature/x'), head, 'the branch itself has no missing commits');
    asks(decide(dir, head), 'Rebase in progress', wt);
  });

  test('R7 F-F names the main worktree detached while rebasing the pull request branch', () => {
    const { dir, head } = clone();
    writeFileSync(join(dir, 'app.txt'), 'main change\n');
    sh(dir, 'commit', '-q', '-am', 'feat: conflicting main');
    sh(dir, 'checkout', '-q', 'feature/x');
    const rebase = fixtureGit(dir, 'rebase', '--merge', 'main');
    assert.equal(rebase.status, 1, rebase.stderr);
    assert.match(rebase.stdout + rebase.stderr, /CONFLICT/);
    const gitdir = sh(dir, 'rev-parse', '--absolute-git-dir');
    assert.equal(gitdir, join(dir, '.git'), 'the rebase must be in the main worktree');
    assert.equal(readFileSync(join(gitdir, 'rebase-merge', 'head-name'), 'utf8').trim(), 'refs/heads/feature/x');
    assert.equal(fixtureGit(dir, 'symbolic-ref', '-q', 'HEAD').status, 1, 'the main worktree must be detached');
    assert.equal(sh(dir, 'rev-parse', 'feature/x'), head, 'the branch itself has no missing commits');
    asks(decide(dir, head), 'Rebase in progress', dir);
  });
});
