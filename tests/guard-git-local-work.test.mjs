// Issue #53: guard-git asks before `gh pr merge` when the local copy of the pull request holds work its
// head on GitHub lacks: commits not reachable from headRefOid, or uncommitted changes in a worktree that
// has the branch checked out. Each case runs the Bash entries of global/settings.json through
// claude-hooks.mjs, with a fake `gh` first on PATH and a temporary repository whose remote names the pull
// request's repository. The fixtures repeat those of hooks.test.mjs, as guard-git-entries.test.mjs does: a
// test file cannot import another without running its suites.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runConfigured } from './claude-hooks.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

// A fake `gh` first on PATH stands in for GitHub; it answers from a scenario.
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

// Since #57 the merge decision also asks the remote for the oracle tag with `git ls-remote`. A fake `git` first
// on PATH answers that call with "no tag" and logs it, so these cases never reach the network; it runs the real
// git, by absolute path, for everything else.
const REAL_GIT = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const FAKE_GIT = String.raw`#!/bin/sh
case " $* " in
  *" ls-remote "*) exec node "$FAKE_LS_REMOTE" "$@" ;;
esac
exec "$REAL_GIT" "$@"
`;
const FAKE_LS_REMOTE = String.raw`require('node:fs').appendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\n');
`;
// Installs the fake git in `bin` and returns the environment that makes it answer with no tag.
function installFakeGit(root, bin) {
  writeFileSync(join(bin, 'git'), FAKE_GIT, { mode: 0o755 });
  writeFileSync(join(root, 'ls-remote.js'), FAKE_LS_REMOTE);
  return { FAKE_LS_REMOTE: join(root, 'ls-remote.js'), FAKE_GIT_LOG: join(root, 'ls-remote.log'), REAL_GIT };
}

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

describe('guard-git merge decision with local work (#53)', () => {
  let scratch;
  let bin;
  let gitEnv;
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cw-local-work-'));
    bin = join(scratch, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
    gitEnv = installFakeGit(scratch, bin);
  });
  after(() => rmSync(scratch, { recursive: true, force: true }));

  // A clone of o/r on github.com: main with one commit, and feature/x one commit ahead, pushed as the
  // pull request's head. The clone stays on main.
  function clone({ remote = 'https://github.com/o/r.git' } = {}) {
    const dir = mkdtempSync(join(scratch, 'clone-'));
    sh(dir, 'init', '-q', '-b', 'main');
    sh(dir, 'config', 'user.email', 'test@example.com');
    sh(dir, 'config', 'user.name', 'Test');
    sh(dir, 'config', 'commit.gpgsign', 'false');
    sh(dir, 'config', 'tag.gpgsign', 'false');
    if (remote) sh(dir, 'remote', 'add', 'origin', remote);
    writeFileSync(join(dir, 'README.md'), 'x\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'chore: init');
    sh(dir, 'checkout', '-q', '-b', 'feature/x');
    writeFileSync(join(dir, 'app.txt'), 'first\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'feat: first');
    const head = sh(dir, 'rev-parse', 'HEAD');
    sh(dir, 'checkout', '-q', 'main');
    return { dir, head };
  }

  // A commit on a branch that is not checked out, made in a temporary worktree that is removed afterwards.
  function commitOn(dir, branch, subject) {
    const wt = mkdtempSync(join(scratch, 'commit-'));
    rmSync(wt, { recursive: true });
    sh(dir, 'worktree', 'add', '-q', wt, branch);
    writeFileSync(join(wt, 'app.txt'), `${subject}\n`);
    sh(wt, 'commit', '-q', '-am', subject);
    const oid = sh(wt, 'rev-parse', 'HEAD');
    sh(dir, 'worktree', 'remove', wt);
    return oid;
  }

  function worktree(dir, branch) {
    const wt = mkdtempSync(join(scratch, 'wt-'));
    rmSync(wt, { recursive: true });
    sh(dir, 'worktree', 'add', '-q', wt, branch);
    return wt;
  }

  function merge(cwd, pr, command = SQUASH) {
    const scenario = join(scratch, `scenario-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(scenario, JSON.stringify({ view: { stdout: pr }, api: NOT_FOUND, user: { stdout: { login: 'me' } } }));
    const result = runConfigured({ cwd, tool_name: 'Bash', tool_input: { command } },
      { env: { PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_GH: scenario, ...gitEnv } });
    assert.deepEqual(result.failures, [], result.stderr);
    return result;
  }

  const allowed = (result, label) => {
    assert.equal(result.decision, 'allow', `${label}: ${result.reason}`);
    assert.equal(result.explicit, true, `${label}: the explicit allow of a green pull request was expected`);
  };
  const asks = (result, label, ...needles) => {
    assert.equal(result.decision, 'ask', `${label}: ${result.reason}`);
    for (const needle of needles) {
      if (needle instanceof RegExp) assert.match(result.reason, needle, label);
      else assert.ok(result.reason.includes(needle), `${label}: the reason must include ${needle}: ${result.reason}`);
    }
  };

  test('AC-1 asks and lists a commit added to the local branch after the push', () => {
    const { dir, head } = clone();
    const extra = commitOn(dir, 'feature/x', 'fix: local amendment');
    asks(merge(dir, green({ headRefOid: head })), 'added commit', extra.slice(0, 7), 'fix: local amendment');
  });

  test('AC-1 asks and lists the commit that replaced the pushed one with an amend', () => {
    const { dir, head } = clone();
    sh(dir, 'checkout', '-q', 'feature/x');
    sh(dir, 'commit', '-q', '--amend', '-m', 'feat: first, amended');
    const amended = sh(dir, 'rev-parse', 'HEAD');
    sh(dir, 'checkout', '-q', 'main');
    asks(merge(dir, green({ headRefOid: head })), 'amended commit', amended.slice(0, 7), 'feat: first, amended');
  });

  test('AC-1 asks for a local branch with another name whose upstream is the head branch', () => {
    const { dir, head } = clone();
    sh(dir, 'branch', '-m', 'feature/x', 'work');
    sh(dir, 'config', 'branch.work.remote', 'origin');
    sh(dir, 'config', 'branch.work.merge', 'refs/heads/feature/x');
    const extra = commitOn(dir, 'work', 'fix: on the tracking branch');
    asks(merge(dir, green({ headRefOid: head })), 'tracking branch', extra.slice(0, 7), 'fix: on the tracking branch');
  });

  test('AC-1 asks for a merge without a number run from the branch itself', () => {
    const { dir, head } = clone();
    sh(dir, 'checkout', '-q', 'feature/x');
    writeFileSync(join(dir, 'app.txt'), 'second\n');
    sh(dir, 'commit', '-q', '-am', 'feat: second');
    const extra = sh(dir, 'rev-parse', 'HEAD');
    asks(merge(dir, green({ headRefOid: head }), 'gh pr merge --squash --delete-branch'), 'current branch',
      extra.slice(0, 7), 'feat: second');
  });

  for (const remote of ['https://github.com/o/r', 'git@github.com:o/r.git', 'ssh://git@github.com/o/r.git']) {
    test(`AC-1 recognises the pull request's repository in the remote ${remote}`, () => {
      const { dir, head } = clone({ remote });
      const extra = commitOn(dir, 'feature/x', 'fix: local amendment');
      asks(merge(dir, green({ headRefOid: head })), remote, extra.slice(0, 7), 'fix: local amendment');
    });
  }

  test('AC-2 asks and names the worktree and the path of an unstaged change', () => {
    const { dir, head } = clone();
    const wt = worktree(dir, 'feature/x');
    writeFileSync(join(wt, 'app.txt'), 'edited\n');
    asks(merge(dir, green({ headRefOid: head })), 'unstaged change', basename(wt), 'app.txt');
  });

  test('AC-2 asks for a staged change in the worktree', () => {
    const { dir, head } = clone();
    const wt = worktree(dir, 'feature/x');
    writeFileSync(join(wt, 'staged.txt'), 'new\n');
    sh(wt, 'add', 'staged.txt');
    asks(merge(dir, green({ headRefOid: head })), 'staged change', basename(wt), 'staged.txt');
  });

  test('AC-2 asks for an untracked file that is not ignored', () => {
    const { dir, head } = clone();
    const wt = worktree(dir, 'feature/x');
    writeFileSync(join(wt, 'forgotten.test.mjs'), '// new test\n');
    asks(merge(dir, green({ headRefOid: head })), 'untracked file', basename(wt), 'forgotten.test.mjs');
  });

  test('AC-2 asks for uncommitted changes in the main checkout when it has the branch checked out', () => {
    const { dir, head } = clone();
    sh(dir, 'checkout', '-q', 'feature/x');
    writeFileSync(join(dir, 'app.txt'), 'edited\n');
    asks(merge(dir, green({ headRefOid: head })), 'main checkout', 'app.txt');
  });

  test('AC-2 does not count ignored files', () => {
    const { dir, head } = clone();
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '*.log\n');
    const wt = worktree(dir, 'feature/x');
    writeFileSync(join(wt, 'debug.log'), 'noise\n');
    allowed(merge(dir, green({ headRefOid: head })), 'ignored file');
  });

  test('AC-2 does not count changes in a worktree of another branch', () => {
    const { dir, head } = clone();
    sh(dir, 'branch', 'other', 'main');
    const wt = worktree(dir, 'other');
    writeFileSync(join(wt, 'README.md'), 'edited\n');
    allowed(merge(dir, green({ headRefOid: head })), 'other branch');
  });

  test('AC-3 keeps the explicit allow when the local branch is at headRefOid and clean', () => {
    const { dir, head } = clone();
    worktree(dir, 'feature/x');
    allowed(merge(dir, green({ headRefOid: head })), 'in sync');
  });

  test('AC-3 keeps the explicit allow when the local branch is behind headRefOid', () => {
    const { dir, head: first } = clone();
    const pushed = commitOn(dir, 'feature/x', 'feat: pushed from elsewhere');
    sh(dir, 'branch', '-f', 'feature/x', first);
    allowed(merge(dir, green({ headRefOid: pushed })), 'behind');
  });

  test('AC-4 keeps the explicit allow when the repository has no local branch for the pull request', () => {
    const { dir, head } = clone();
    sh(dir, 'branch', '-D', 'feature/x');
    allowed(merge(dir, green({ headRefOid: head })), 'no local branch');
  });

  test('AC-4 keeps the explicit allow when the working directory is not a git repository', () => {
    const plain = mkdtempSync(join(scratch, 'plain-'));
    allowed(merge(plain, green({ headRefOid: 'a'.repeat(40) })), 'not a repository');
  });

  test('AC-5 asks when gh returns no headRefOid', () => {
    const { dir } = clone();
    asks(merge(dir, green()), 'no headRefOid', 'headRefOid');
  });

  test('AC-5 asks when gh returns no headRefName', () => {
    const { dir, head } = clone();
    asks(merge(dir, green({ headRefName: undefined, headRefOid: head })), 'no headRefName', 'headRefName');
  });

  test('AC-5 asks when headRefOid is not in the local repository', () => {
    const { dir } = clone();
    const unknown = '0123456789abcdef0123456789abcdef01234567';
    asks(merge(dir, green({ headRefOid: unknown })), 'unknown head', unknown.slice(0, 7));
  });

  test('AC-5 asks when a worktree of the branch cannot be read', { skip: process.getuid?.() === 0 ? 'root reads any directory' : false }, () => {
    const { dir, head } = clone();
    const wt = worktree(dir, 'feature/x');
    chmodSync(wt, 0o000);
    try {
      asks(merge(dir, green({ headRefOid: head })), 'unreadable worktree', basename(wt));
    } finally {
      chmodSync(wt, 0o755);
    }
  });

  for (const [label, remote] of [
    ['another repository', 'https://github.com/other/repo.git'],
    ['the same name on another host', 'https://ghe.example.com/o/r.git'],
    ['no remote', null],
  ]) {
    test(`AC-6 keeps the explicit allow when the clone's remote is ${label}`, () => {
      const { dir, head } = clone({ remote });
      commitOn(dir, 'feature/x', 'fix: unrelated local work');
      allowed(merge(dir, green({ headRefOid: head })), label);
    });
  }

  test('AC-7 pr-prep checks the local copy before opening the pull request and before asking for the merge', () => {
    const skill = readFileSync(join(root, 'global', 'skills', 'pr-prep', 'SKILL.md'), 'utf8');
    // The paragraph or list item that compares with headRefOid also covers uncommitted changes and stops.
    const block = skill.split(/\n\s*\n/).find((b) => b.includes('headRefOid'));
    assert.ok(block, 'pr-prep must compare the local branch with the head GitHub has (headRefOid)');
    assert.match(block, /uncommitted/i, 'the same step must look for uncommitted changes');
    assert.match(block, /\bstop/i, 'the same step must stop when local work is missing');
    assert.match(skill, /before (?:opening|it opens) the pull request/i, 'pr-prep must check before opening the pull request');
    assert.match(skill, /before asking for the merge/i, 'pr-prep must check again before asking for the merge');
  });
});
