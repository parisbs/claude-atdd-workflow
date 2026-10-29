// Issue #72: local-work gaps in the merge decision. Each integration case runs the configured Bash
// entries with real hooks, fake gh/git/ssh first on PATH, and an isolated temporary repository. git
// handles local reads normally; ls-remote never reaches the network, except in AC-7 where real git
// reaches a fake ssh so its descendants exercise the hook's process-group timeout.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { runConfigured } from './claude-hooks.mjs';
import { writeExecutable } from './executables.mjs';
import { fixtureGit, GIT_ENV } from './git-fixture.mjs';

const REAL_GIT = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
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
if (step.sleep) setTimeout(finish, step.sleep); else finish();
`;

const FAKE_GIT = String.raw`#!/bin/sh
if [ -z "$REAL_GIT" ]; then exit 0; fi
printf '%s\n' "$*" >> "$FAKE_GIT_LOG"
case " $* " in
  *" ls-remote "*)
    if [ "$REAL_REMOTE" = 1 ]; then exec "$REAL_GIT" "$@"; fi
    exit 0 ;;
  *" worktree list "*" -z "*)
    if [ "$OLD_GIT" = 1 ]; then
      printf 'error: unknown switch \140z\047\n' >&2
      exit 129
    fi ;;
esac
case " $* " in
  *" for-each-ref "*|*" remote -v "*)
    if [ -n "$SLOW_READ" ]; then exec node "$FAKE_GIT_READ" "$@"; fi ;;
esac
exec "$REAL_GIT" "$@"
`;

// Only the selected local read sleeps, once. No remote call spends this time.
const FAKE_GIT_READ = String.raw`const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const remoteReads = fs.readFileSync(process.env.FAKE_GIT_LOG, 'utf8').split('\n')
  .filter((line) => line.endsWith('remote -v')).length;
const slow = process.env.SLOW_READ === 'local' ? args.includes('for-each-ref')
  : args.includes('remote') && remoteReads === 2;
if (slow) fs.appendFileSync(process.env.FAKE_GIT_LOG, 'slow local read\n');
const finish = () => {
  const r = spawnSync(process.env.REAL_GIT, args, { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
};
if (slow) setTimeout(finish, 2400); else finish();
`;

// OpenSSH reads the passwd home, not HOME. A fake -G keeps alias resolution isolated on every machine.
const FAKE_SSH = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
if (!process.env.FAKE_SSH_LOG) process.exit(0);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(args) + '\n');
if (!args.includes('-G') || !args.includes('gh-work')) {
  process.stderr.write('fake ssh: unexpected call\n');
  process.exit(1);
}
if (process.env.SSH_MODE === 'fail') process.exit(1);
if (process.env.SSH_MODE === 'hang') setTimeout(() => process.exit(1), 8000);
else process.stdout.write('hostname ' + (process.env.SSH_MODE === 'other' ? 'other.example.com' : 'github.com') + '\n');
`;

const HANGING_SSH = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
if (!process.env.FAKE_SSH_PIDS) process.exit(0);
const role = process.argv[2] === 'child' || process.argv[2] === 'grandchild' ? process.argv[2] : 'ssh';
fs.appendFileSync(process.env.FAKE_SSH_PIDS, JSON.stringify({ role, pid: process.pid, ppid: process.ppid }) + '\n');
if (role !== 'grandchild') spawn(process.execPath, [__filename, role === 'ssh' ? 'child' : 'grandchild'], { stdio: 'inherit' });
setTimeout(() => process.exit(1), 12000);
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
  assert.equal(r.decision, 'allow', r.reason);
  assert.equal(r.explicit, true, 'the clean pull request must get an explicit allow');
};
const asks = (r, ...needles) => {
  assert.equal(r.decision, 'ask', r.reason);
  for (const needle of needles) assert.ok(r.reason.includes(needle), `the reason must include ${needle}: ${r.reason}`);
};

describe('guard-git local-work gaps (#72)', () => {
  let scratch;
  let bin;
  let scenarios = 0;
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cw-local-gaps-'));
    bin = join(scratch, 'bin');
    mkdirSync(bin);
    writeExecutable(join(bin, 'gh'), FAKE_GH);
    writeExecutable(join(bin, 'git'), FAKE_GIT);
    writeExecutable(join(bin, 'ssh'), FAKE_SSH);
    writeFileSync(join(scratch, 'git-read.cjs'), FAKE_GIT_READ);
  });
  after(() => rmSync(scratch, { recursive: true, force: true }));

  function clone(remote = 'https://github.com/o/r.git', objectFormat) {
    const dir = mkdtempSync(join(scratch, 'clone-'));
    sh(dir, 'init', '-q', '-b', 'main', ...(objectFormat ? [`--object-format=${objectFormat}`] : []));
    sh(dir, 'config', 'user.name', 'Test');
    sh(dir, 'config', 'user.email', 'test@example.com');
    sh(dir, 'remote', 'add', 'origin', remote);
    writeFileSync(join(dir, 'app.txt'), 'base\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'chore: init');
    sh(dir, 'checkout', '-q', '-b', 'feature/x');
    writeFileSync(join(dir, 'app.txt'), 'first\n');
    sh(dir, 'commit', '-q', '-am', 'feat: first');
    const head = sh(dir, 'rev-parse', 'HEAD');
    sh(dir, 'checkout', '-q', 'main');
    return { dir, head };
  }

  function worktree(dir, ...options) {
    const wt = realpathSync(mkdtempSync(join(scratch, 'wt-')));
    sh(dir, 'worktree', 'add', '-q', ...options, wt, 'feature/x');
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

  function decide(dir, head, { env = {}, api = NOT_FOUND, command = SQUASH } = {}) {
    const file = join(scratch, `scenario-${++scenarios}.json`);
    writeFileSync(file, JSON.stringify({ view: { stdout: green(head) }, user: { stdout: { login: 'me' } }, api }));
    const r = runConfigured({ cwd: dir, permission_mode: 'default', tool_name: 'Bash', tool_input: { command } }, {
      env: {
        ...GIT_ENV, PATH: `${bin}${delimiter}${process.env.PATH}`, REAL_GIT,
        FAKE_GH: file, FAKE_GIT_LOG: `${file}.git`, FAKE_GIT_READ: join(scratch, 'git-read.cjs'),
        FAKE_SSH_LOG: `${file}.ssh`, SSH_MODE: 'match', OLD_GIT: '', SLOW_READ: '', REAL_REMOTE: '',
        GIT_SSH_COMMAND: 'ssh', GIT_SSH_VARIANT: 'ssh',
        GUARD_GIT_GH_TIMEOUT_MS: '6000', GUARD_GIT_GH_BUDGET_MS: '10000', ...env,
      },
    });
    assert.deepEqual(r.failures, [], r.stderr);
    assert.notEqual(r.decision, 'deny', `the configured hook must complete: ${r.reason}`);
    return { ...r, gh: lines(`${file}.calls`).map(JSON.parse), git: lines(`${file}.git`), ssh: lines(`${file}.ssh`).map(JSON.parse) };
  }

  for (const remote of ['git@gh-work:o/r.git', 'ssh://git@gh-work/o/r.git']) {
    test(`AC-1 lists missing local commits through the SSH alias ${remote}`, () => {
      const { dir, head } = clone();
      const extra = extraCommit(dir);
      asks(decide(dir, head), extra.slice(0, 7), 'fix: local amendment');
      sh(dir, 'remote', 'set-url', 'origin', remote);
      asks(decide(dir, head), extra.slice(0, 7), 'fix: local amendment');
    });
  }

  for (const mode of ['other', 'fail', 'hang']) {
    test(`AC-2 adds no local-work verdict when SSH alias resolution is ${mode}`, () => {
      const { dir, head } = clone('git@gh-work:o/r.git');
      extraCommit(dir);
      const start = performance.now();
      const r = decide(dir, head, { env: { SSH_MODE: mode } });
      allowed(r);
      assert.doesNotMatch(r.reason, /local commits missing|could not read the local|uncommitted changes|stash@/i);
      assert.ok(r.ssh.some((args) => args.includes('-G') && args.includes('gh-work')), 'the alias must be resolved with ssh -G');
      assert.ok(performance.now() - start < 13000, 'alias resolution must remain bounded');
    });
  }

  test('AC-3 handles clean and dirty branches when git rejects worktree list -z', () => {
    const clean = clone();
    worktree(clean.dir);
    const cleanResult = decide(clean.dir, clean.head, { env: { OLD_GIT: '1' } });
    const dirty = clone();
    const extra = extraCommit(dirty.dir);
    const wt = worktree(dirty.dir);
    writeFileSync(join(wt, 'app.txt'), 'uncommitted\n');
    const dirtyResult = decide(dirty.dir, dirty.head, { env: { OLD_GIT: '1' } });
    assert.ok(cleanResult.git.some((line) => /worktree list.*-z/.test(line)), 'the old-git rejection must be exercised');
    asks(dirtyResult);
    const listed = dirtyResult.reason.includes(extra.slice(0, 7)) && dirtyResult.reason.includes('app.txt')
      && dirtyResult.reason.includes(basename(wt));
    assert.ok(listed || /could not read[^.]*worktree/i.test(dirtyResult.reason), dirtyResult.reason);
    allowed(cleanResult);
  });

  for (const backend of ['merge', 'apply']) {
    test(`AC-4 names a detached worktree rebasing the pull request branch with rebase-${backend}`, () => {
      const { dir, head } = clone();
      writeFileSync(join(dir, 'app.txt'), 'main change\n');
      sh(dir, 'commit', '-q', '-am', 'feat: conflicting main');
      const wt = worktree(dir);
      const rebase = fixtureGit(wt, 'rebase', `--${backend}`, 'main');
      assert.equal(rebase.status, 1, rebase.stderr);
      assert.match(rebase.stdout + rebase.stderr, /CONFLICT/);
      const gitdir = sh(wt, 'rev-parse', '--absolute-git-dir');
      assert.equal(readFileSync(join(gitdir, `rebase-${backend}`, 'head-name'), 'utf8').trim(), 'refs/heads/feature/x');
      assert.equal(fixtureGit(wt, 'symbolic-ref', '-q', 'HEAD').status, 1, 'the rebase worktree must be detached');
      assert.equal(sh(dir, 'rev-parse', 'feature/x'), head, 'the branch itself has no missing commits');
      asks(decide(dir, head), basename(wt));
    });
  }

  for (const custom of [false, true]) {
    test(`AC-4 names a stash entry with the ${custom ? 'On' : 'WIP on'} branch subject`, () => {
      const { dir, head } = clone();
      sh(dir, 'checkout', '-q', 'feature/x');
      writeFileSync(join(dir, 'app.txt'), 'stashed work\n');
      sh(dir, 'stash', 'push', ...(custom ? ['-m', 'unfinished patch'] : []));
      const subject = sh(dir, 'stash', 'list', '--format=%gs');
      assert.ok(subject.startsWith(`${custom ? 'On' : 'WIP on'} feature/x:`), subject);
      assert.equal(sh(dir, 'status', '--porcelain'), '', 'the work must exist only in the stash');
      assert.equal(sh(dir, 'rev-parse', 'HEAD'), head);
      sh(dir, 'checkout', '-q', 'main');
      asks(decide(dir, head), 'stash@{0}');
    });
  }

  test('AC-5 gives the later gh call its limit after a slow local-work read', () => {
    const { dir, head } = clone();
    const r = decide(dir, head, {
      env: { SLOW_READ: 'local', GUARD_GIT_GH_BUDGET_MS: '2000', GUARD_GIT_GH_TIMEOUT_MS: '1000' },
      api: { stdout: 'Human merge: src/\n', sleep: 400 },
    });
    assert.ok(r.git.includes('slow local read'), 'the local read must spend more than the gh budget');
    asks(r, 'Control-plane files changed: src/app.ts');
    assert.ok(r.gh.some((args) => args.some((arg) => arg.includes('/contents/CLAUDE.md'))), 'gh must read the base policy');
    assert.doesNotMatch(r.reason, /time budget|timed out/i);
  });

  test('AC-5 leaves the remote lookup its budget after slow local oracle discovery', () => {
    const { dir, head } = clone();
    const r = decide(dir, head, {
      env: { SLOW_READ: 'oracle', GUARD_GIT_GH_BUDGET_MS: '2000', GUARD_GIT_GH_TIMEOUT_MS: '1000' },
    });
    assert.ok(r.git.includes('slow local read'), 'oracle discovery must spend more than the gh budget');
    allowed(r);
    assert.ok(r.git.some((line) => line.startsWith('ls-remote ')), 'the bounded remote lookup must still run');
  });

  test('AC-6 isolates fixture HOME, git configuration and diagnostic language', () => {
    const probe = sh(scratch, '-c', 'alias.fixture-env=!printf "%s\\n" "$HOME" "$LC_ALL" "$LANG"', 'fixture-env').split('\n');
    assert.equal(realpathSync(probe[0]), realpathSync(GIT_ENV.HOME));
    assert.ok(realpathSync(probe[0]).startsWith(join(realpathSync(tmpdir()), 'cw-git-home-')));
    assert.deepEqual(probe.slice(1), ['C', 'C']);
    assert.equal(GIT_ENV.GIT_CONFIG_NOSYSTEM, '1');
    // Even a config in the isolated home must not leak into fixture git.
    writeFileSync(join(GIT_ENV.HOME, '.gitconfig'), '[fixture]\n  leaked = true\n');
    try {
      assert.equal(sh(scratch, 'config', '--global', '--list'), '');
      assert.equal(sh(scratch, 'config', '--system', '--list'), '');
      assert.equal(sh(scratch, 'config', '--list'), '');
      const r = fixtureGit(scratch, 'fixture-missing-command');
      assert.equal(r.status, 1);
      assert.match(r.stderr, /^git: 'fixture-missing-command' is not a git command\. See 'git --help'\./);
    } finally {
      rmSync(join(GIT_ENV.HOME, '.gitconfig'), { force: true });
    }
  });

  test('AC-7 kills ssh and its child and grandchild when an oracle forced-push lookup times out', async () => {
    const { dir, head } = clone('git@gh-work:o/r.git');
    sh(dir, 'tag', 'oracle/feature/x', head);
    const pidsFile = join(scratch, 'ssh-pids.jsonl');
    const sshBin = join(scratch, 'hanging-bin');
    mkdirSync(sshBin);
    writeExecutable(join(sshBin, 'ssh'), HANGING_SSH);
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        // Linux can retain a killed orphan as a zombie until PID 1 reaps it.
        if (existsSync('/proc')) {
          const status = readFileSync(`/proc/${pid}/status`, 'utf8');
          if (/^State:\s+Z/m.test(status)) return false;
        }
        return true;
      } catch (error) {
        if (error.code === 'ESRCH' || error.code === 'ENOENT') return false;
        throw error;
      }
    };
    let pids = [];
    try {
      const start = performance.now();
      const r = decide(dir, head, {
        command: 'git push -f origin oracle/feature/x',
        env: {
          PATH: `${sshBin}${delimiter}${bin}${delimiter}${process.env.PATH}`,
          REAL_REMOTE: '1', FAKE_SSH_PIDS: pidsFile,
          GUARD_GIT_GH_TIMEOUT_MS: '1500', GUARD_GIT_GH_BUDGET_MS: '3000',
        },
      });
      pids = lines(pidsFile).map(JSON.parse);
      asks(r, 'Move oracle/feature/x', 'git ls-remote timed out');
      assert.ok(performance.now() - start < 6000, 'inherited pipes must not keep the hook alive');
      assert.deepEqual(pids.map(({ role }) => role).sort(), ['child', 'grandchild', 'ssh']);
      const ssh = pids.find(({ role }) => role === 'ssh');
      const child = pids.find(({ role }) => role === 'child');
      assert.equal(child.ppid, ssh.pid);
      assert.equal(pids.find(({ role }) => role === 'grandchild').ppid, child.pid);
      const deadline = performance.now() + 1500;
      while (pids.some(({ pid }) => alive(pid)) && performance.now() < deadline) await delay(25);
      assert.deepEqual(pids.filter(({ pid }) => alive(pid)), [], 'no ssh descendant may survive the timeout');
    } finally {
      for (const { pid } of pids.length ? pids : lines(pidsFile).map(JSON.parse)) {
        if (alive(pid)) process.kill(pid, 'SIGKILL');
      }
    }
  });

  test('AC-8 asks for a pushed head missing from a partial clone without trying to fetch it', () => {
    const source = clone();
    sh(source.dir, 'config', 'uploadpack.allowFilter', 'true');
    const dir = mkdtempSync(join(scratch, 'partial-'));
    sh(scratch, 'clone', '-q', '--filter=blob:none', '--no-checkout', '--single-branch', '--branch', 'main',
      pathToFileURL(source.dir).href, dir);
    sh(dir, 'branch', 'feature/x', 'main');
    sh(dir, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git');
    assert.equal(sh(dir, 'config', 'remote.origin.promisor'), 'true');
    assert.equal(sh(dir, 'config', 'remote.origin.partialclonefilter'), 'blob:none');
    const object = `${source.head}^{commit}`;
    const unavailable = () => {
      const r = spawnSync(REAL_GIT, ['cat-file', '-e', object], {
        cwd: dir, encoding: 'utf8', timeout: 10000,
        env: { ...GIT_ENV, GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' },
      });
      assert.equal(r.error, undefined);
      assert.notEqual(r.status, 0, 'the pushed head must be absent from the partial clone');
    };
    unavailable();
    const trace = join(dir, '.git', 'local-read-trace.jsonl');
    const r = decide(dir, source.head, {
      env: { GIT_TRACE2_EVENT: trace, GIT_TRACE2_ENV_VARS: 'GIT_NO_LAZY_FETCH', GIT_ALLOW_PROTOCOL: '' },
    });
    asks(r, `The pushed head ${source.head.slice(0, 7)} is unavailable in the local repository`);
    const events = lines(trace).map(JSON.parse);
    const cat = events.find(({ event, argv = [] }) => event === 'start' && argv.includes('cat-file') && argv.includes(object));
    assert.ok(cat, 'real git must check the pushed commit');
    assert.ok(events.some(({ event, sid, param, value }) => event === 'def_param' && sid === cat.sid
      && param === 'GIT_NO_LAZY_FETCH' && value === '1'), 'the object read must disable lazy fetching');
    assert.ok(!events.some(({ argv = [] }) => argv.some((arg) => /^(?:fetch|ls-remote|ssh|git-remote-https?)$/.test(arg))),
      'real git must not start a fetch, remote lookup or network transport');
    assert.ok(!r.git.some((line) => /\bfetch\b/.test(line) || (line.includes('ls-remote') && line.includes(source.head))),
      'the hook must not fetch or look up the missing object');
    assert.deepEqual(r.ssh, []);
    unavailable();
  });

  for (const remote of ['ssh://git@github.com:22/o/r.git', 'https://github.com:443/o/r.git']) {
    test(`AC-8 matches the pull request repository through the explicit port in ${remote}`, () => {
      const { dir, head } = clone(remote);
      const extra = extraCommit(dir);
      asks(decide(dir, head), `${extra.slice(0, 7)} fix: local amendment`);
    });
  }

  test('AC-8 skips a prunable branch worktree whose path is gone', () => {
    const { dir, head } = clone();
    const wt = worktree(dir);
    rmSync(wt, { recursive: true });
    const record = sh(dir, 'worktree', 'list', '--porcelain', '-z').split('\0\0')
      .find((entry) => entry.includes(`worktree ${wt}\0`));
    assert.ok(record?.includes('\0branch refs/heads/feature/x\0'), 'the removed worktree must still name the branch');
    assert.match(record, /\0prunable(?: |\0)/);
    const r = decide(dir, head);
    allowed(r);
    assert.ok(!r.git.some((line) => line.includes('status --porcelain')), 'git must not read the removed worktree');
    assert.ok(!r.reason.includes(wt), r.reason);
  });

  test('AC-8 asks when a prunable branch worktree exists but cannot be read', (t) => {
    if (process.getuid() === 0) return t.skip('root can read chmod-denied directories, so permission denial cannot be exercised');
    const { dir, head } = clone();
    const wt = worktree(dir);
    rmSync(join(wt, '.git'));
    const record = sh(dir, 'worktree', 'list', '--porcelain', '-z').split('\0\0')
      .find((entry) => entry.includes(`worktree ${wt}\0`));
    assert.ok(record?.includes('\0branch refs/heads/feature/x\0'), 'the unreadable worktree must still name the branch');
    assert.match(record, /\0prunable(?: |\0)/);
    chmodSync(wt, 0o000);
    try {
      assert.throws(() => readdirSync(wt), { code: 'EACCES' });
      asks(decide(dir, head), `Could not read the local copy in ${wt}`);
    } finally {
      chmodSync(wt, 0o755);
    }
  });

  test('AC-9 lists both rename paths and preserves spaces in changed paths', () => {
    const { dir, head } = clone();
    const wt = worktree(dir);
    sh(wt, 'mv', 'app.txt', 'renamed app.txt');
    writeFileSync(join(wt, 'notes with spaces.txt'), 'unfinished\n');
    assert.ok(sh(wt, 'status', '--porcelain=v1', '-z').startsWith('R  renamed app.txt\0app.txt\0'));
    asks(decide(dir, head), `Uncommitted changes in worktree ${wt}: renamed app.txt, app.txt, notes with spaces.txt.`);
  });

  test('AC-9 lists changed paths in each worktree of the branch', () => {
    const { dir, head } = clone();
    const first = worktree(dir);
    const second = worktree(dir, '--force');
    writeFileSync(join(first, 'first patch.txt'), 'unfinished first\n');
    writeFileSync(join(second, 'second patch.txt'), 'unfinished second\n');
    asks(decide(dir, head), `Uncommitted changes in worktree ${first}: first patch.txt.`,
      `Uncommitted changes in worktree ${second}: second patch.txt.`);
  });

  test('AC-9 counts only branches tracking the matching repository among several remotes', () => {
    const { dir, head } = clone('https://github.com/other/r.git');
    const unrelated = extraCommit(dir);
    sh(dir, 'branch', '-m', 'feature/x', 'other-local');
    sh(dir, 'update-ref', 'refs/remotes/origin/feature/x', head);
    sh(dir, 'branch', '--set-upstream-to=origin/feature/x', 'other-local');
    sh(dir, 'remote', 'add', 'matching', 'https://github.com/o/r.git');
    sh(dir, 'update-ref', 'refs/remotes/matching/feature/x', head);
    sh(dir, 'branch', '--track', 'local-copy', 'matching/feature/x');
    allowed(decide(dir, head));
    sh(dir, 'checkout', '-q', 'local-copy');
    sh(dir, 'commit', '-q', '--allow-empty', '-m', 'fix: matching remote amendment');
    const matching = sh(dir, 'log', '-1', '--format=%h %s');
    sh(dir, 'checkout', '-q', 'main');
    const r = decide(dir, head);
    asks(r, matching);
    assert.ok(!r.reason.includes(unrelated.slice(0, 7)), r.reason);
    assert.ok(!r.reason.includes('fix: local amendment'), r.reason);
  });

  test('AC-9 accepts a 64-hex pushed head and lists local commits in a SHA-256 repository', () => {
    const { dir, head } = clone(undefined, 'sha256');
    assert.equal(sh(dir, 'rev-parse', '--show-object-format'), 'sha256');
    assert.match(head, /^[a-f0-9]{64}$/);
    allowed(decide(dir, head));
    extraCommit(dir);
    const extra = sh(dir, 'log', '-1', '--format=%h %s', 'feature/x');
    asks(decide(dir, head), `Local commits missing from the pushed head ${head}: ${extra}.`);
  });

  test('AC-9 lists the first ten missing commits and the remaining count', () => {
    const { dir, head } = clone();
    sh(dir, 'checkout', '-q', 'feature/x');
    const commits = [];
    for (let i = 1; i <= 12; i += 1) {
      sh(dir, 'commit', '-q', '--allow-empty', '-m', `fix: local patch ${i}`);
      commits.unshift(sh(dir, 'log', '-1', '--format=%h %s'));
    }
    sh(dir, 'checkout', '-q', 'main');
    const r = decide(dir, head);
    asks(r, `Local commits missing from the pushed head ${head}: ${commits.slice(0, 10).join('; ')}; 2 more.`);
    for (const omitted of commits.slice(10)) assert.ok(!r.reason.includes(omitted), r.reason);
  });

  test('AC-9 lists the first ten changed paths and the remaining count', () => {
    const { dir, head } = clone();
    const wt = worktree(dir);
    const paths = Array.from({ length: 12 }, (_, i) => `patch ${String(i + 1).padStart(2, '0')}.txt`);
    for (const path of paths) writeFileSync(join(wt, path), 'unfinished\n');
    const r = decide(dir, head);
    asks(r, `Uncommitted changes in worktree ${wt}: ${paths.slice(0, 10).join(', ')}, 2 more.`);
    for (const omitted of paths.slice(10)) assert.ok(!r.reason.includes(omitted), r.reason);
  });
});
