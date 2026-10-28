// Issue #57 (ADR 0030), amended after the first review: four defects of the merge decision of guard-git.
//
// F1. gh reads merge flags with spf13/pflag: a boolean shorthand takes its default when no value follows,
//     inside a cluster `-X=value` sets that flag's value, and the last occurrence wins. `-s -ms=false` is
//     m=true, s=false (a merge commit), and must be denied like any merge that is not a squash.
// F2. A pull request that cannot be read (gh failing, no JSON, incomplete data, a hook that cannot decide)
//     asks in the main session and is denied in bypassPermissions, which shows no prompt (AC-5).
// F3. `-R other/x`, `-Rother/x`, `-R=other/x`, `--repo other/x`, `--repo=other/x`: gh merges that repository's
//     pull request, so the hook must read the same one: `gh pr view` receives the repository, the last
//     occurrence winning, and never falls back to the repository of the working directory.
// F4. `--squash=true` and `-s=true` are real squashes and are not denied for being squashes. A valued
//     merge-method flag never earns the explicit allow (AC-8), so they are not allowed explicitly either.
//
// The cases run the Bash entries of global/settings.json through claude-hooks.mjs with the real hooks, with
// a fake `gh` and a fake `git` first on PATH, as guard-git-oracle-gate.test.mjs does (its fixtures are
// repeated here: a test file cannot import another without running its suites). The fake gh also logs every
// call, so F3 can read the arguments of `gh pr view`. The repositories are temporary clones of
// https://github.com/o/r.git, so no case touches the network. The cases without a Bash command spawn the
// hook with --merge-only directly: no entry of global/settings.json runs without a command.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { HOOKS, runConfigured } from './claude-hooks.mjs';
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

// A fake `gh` stands in for GitHub; it answers from a scenario and logs its arguments (one JSON line a call).
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_GH, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args }) + '\n');
const kind = args[0] === 'pr' ? 'view' : args[0] === 'api'
  ? args.some((arg) => arg === 'user' || arg === '/user') ? 'user' : 'api' : 'other';
const step = scenario[kind] || { exit: 1, stderr: 'fake gh: unexpected call' };
if (step.stderr) process.stderr.write(step.stderr);
if (step.stdout !== undefined) process.stdout.write(typeof step.stdout === 'string' ? step.stdout : JSON.stringify(step.stdout));
process.exit(step.exit === undefined ? 0 : step.exit);
`;

// A fake `git` first on PATH: ls-remote answers "no tag", the rest runs the real git by absolute path.
const FAKE_GIT = String.raw`#!/bin/sh
case " $* " in
  *" ls-remote "*) exit 0 ;;
esac
exec "$REAL_GIT" "$@"
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

// What a reason says when something could not be read or decided.
const REASON_UNREADABLE = /could not|cannot|can't|unable|failed|unknown|unreadable|not (?:found|available|present)|unavailable|missing/i;
const REASON_SQUASH = /squash/i;

describe('guard-git merge decision: flags and repository as gh reads them, unreadable merges (#57 review)', () => {
  let scratch;
  let bin;
  let fx;
  let counter = 0;
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cw-merge-flags-'));
    bin = join(scratch, 'bin');
    mkdirSync(bin);
    writeExecutable(join(bin, 'gh'), FAKE_GH);
    writeExecutable(join(bin, 'git'), FAKE_GIT);
    // A clone of o/r on github.com, on feature/x with a clean working tree and one commit after main.
    const dir = mkdtempSync(join(scratch, 'clone-'));
    sh(dir, 'init', '-q', '-b', 'main');
    sh(dir, 'config', 'user.email', 'test@example.com');
    sh(dir, 'config', 'user.name', 'Test');
    sh(dir, 'config', 'commit.gpgsign', 'false');
    sh(dir, 'config', 'tag.gpgsign', 'false');
    sh(dir, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'README.md'), 'x\n');
    writeFileSync(join(dir, 'src', 'app.ts'), 'app\n');
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-q', '-m', 'chore: init');
    sh(dir, 'checkout', '-q', '-b', 'feature/x');
    writeFileSync(join(dir, 'src', 'app.ts'), 'app2\n');
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-q', '-m', 'feat: code');
    fx = { dir, head: sh(dir, 'rev-parse', 'HEAD') };
  });
  after(() => rmSync(scratch, { recursive: true, force: true }));

  // The merge decision for `command`, through every entry of global/settings.json. `view` is what
  // `gh pr view` answers (a step of the fake gh); `pr` overrides fields of the green pull request.
  function decide(command, { view, pr = {}, extra = {} } = {}) {
    counter += 1;
    const gh = join(scratch, `gh-${counter}.json`);
    const ghLog = join(scratch, `gh-${counter}.log`);
    const stdout = green({ headRefOid: fx.head, ...pr });
    writeFileSync(gh, JSON.stringify({ view: view ?? { stdout }, api: NOT_FOUND, user: { stdout: { login: 'me' } } }));
    const result = runConfigured({ cwd: fx.dir, tool_name: 'Bash', tool_input: { command }, ...extra }, {
      env: {
        ...GIT_ENV,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        FAKE_GH: gh,
        FAKE_GH_LOG: ghLog,
        REAL_GIT,
        GUARD_GIT_GH_BUDGET_MS: '8000',
        GUARD_GIT_GH_TIMEOUT_MS: '3000',
      },
    });
    const calls = existsSync(ghLog) ? readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    return { ...result, calls };
  }

  // The hook with --merge-only on an event, spawned directly (no entry runs for an event without a command).
  function mergeOnly(event) {
    const run = spawnSync(process.execPath, [join(HOOKS, 'guard-git.mjs'), '--merge-only'], {
      input: JSON.stringify(event),
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, ...GIT_ENV },
    });
    assert.equal(run.error, undefined, String(run.error));
    assert.equal(run.status, 0, `exit ${run.status}: ${run.stderr}`);
    const out = run.stdout.trim() === '' ? {} : JSON.parse(run.stdout).hookSpecificOutput ?? {};
    return { decision: out.permissionDecision ?? 'none', reason: out.permissionDecisionReason ?? '', stderr: run.stderr };
  }

  const wellRun = (result, name) => assert.deepEqual(result.failures, [], `${name}: ${result.stderr}`);
  const asks = (result, name, ...needles) => {
    wellRun(result, name);
    assert.equal(result.decision, 'ask', `${name}: ${result.reason}`);
    for (const needle of needles) assert.match(result.reason, needle, name);
  };
  const denies = (result, name, ...needles) => {
    wellRun(result, name);
    assert.equal(result.decision, 'deny', `${name}: ${result.reason}`);
    for (const needle of needles) assert.match(result.reason, needle, name);
  };
  const allowsExplicitly = (result, name) => {
    wellRun(result, name);
    assert.equal(result.decision, 'allow', `${name}: ${result.reason}`);
    assert.equal(result.explicit, true, `${name}: the explicit allow of a clean merge was expected`);
  };
  const notExplicitAllow = (result, name) => {
    assert.ok(!(result.decision === 'allow' && result.explicit), `${name}: the explicit allow was given: ${result.reason}`);
  };

  // F1: the flags as pflag reads them.
  const NOT_SQUASH = [
    '-s -ms=false', '-sm', '-ms', '-s -m', '-s --merge', '-s -r', '-s --rebase', '-s --merge=true', '-s -s=false', '--squash=false',
  ];
  for (const flags of NOT_SQUASH) {
    test(`AC-8 (#57) F1 denies gh pr merge 12 ${flags} on a green pull request: gh reads it as a merge that is not a squash`, () => {
      const r = decide(`gh pr merge 12 ${flags}`);
      denies(r, flags, REASON_SQUASH);
      assert.equal(r.explicit, true, `${flags}: a denial is printed by the hook`);
    });
  }

  const SQUASH_ONLY = ['-sd', '-ds', '-s', '--squash', '-s -d', '--squash --delete-branch'];
  for (const flags of SQUASH_ONLY) {
    test(`AC-8 (#57) F1 still gives the explicit allow to gh pr merge 12 ${flags} on a green pull request: a squash and nothing else`, () => {
      allowsExplicitly(decide(`gh pr merge 12 ${flags}`), flags);
    });
  }

  // F4: a valued squash is a squash. It is not denied as a merge that is not one, and it is not verified end to end.
  for (const flags of ['--squash=true', '-s=true', '--squash=1']) {
    test(`AC-8 (#57) F4 does not deny gh pr merge 12 ${flags}, a real squash, and does not give the explicit allow either`, () => {
      const r = decide(`gh pr merge 12 ${flags}`);
      wellRun(r, flags);
      assert.notEqual(r.decision, 'deny', `${flags}: ${r.reason}`);
      notExplicitAllow(r, flags);
    });
  }

  // F2: a pull request that cannot be read.
  const UNREADABLE_VIEWS = {
    'gh pr view fails': { exit: 1, stderr: 'gh: Could not resolve to a PullRequest (HTTP 502)' },
    'gh pr view prints no JSON': { stdout: 'this is not json' },
    'gh pr view prints incomplete JSON': { stdout: { number: 12, state: 'OPEN' } },
  };
  for (const [what, view] of Object.entries(UNREADABLE_VIEWS)) {
    test(`AC-5 (#57) F2 denies in bypassPermissions when ${what}`, () => {
      const r = decide('gh pr merge 12 --squash --delete-branch', { view, extra: { permission_mode: 'bypassPermissions' } });
      denies(r, what, REASON_UNREADABLE);
      assert.ok(r.calls.some((call) => call.args[1] === 'view'), `${what}: gh pr view was not called`);
    });

    test(`AC-5 (#57) F2 still asks in a mode that shows prompts, and when no mode is given, when ${what}`, () => {
      for (const extra of [{ permission_mode: 'default' }, { permission_mode: 'acceptEdits' }, {}]) {
        const r = decide('gh pr merge 12 --squash --delete-branch', { view, extra });
        asks(r, `${what} in ${extra.permission_mode ?? 'no mode'}`, REASON_UNREADABLE);
      }
    });
  }

  test('AC-5 (#57) F2 denies in bypassPermissions, and asks otherwise, when the event carries no Bash command', () => {
    for (const tool_input of [{}, { command: 42 }, undefined]) {
      const name = JSON.stringify(tool_input);
      const bypass = mergeOnly({ tool_name: 'Bash', tool_input, cwd: fx.dir, permission_mode: 'bypassPermissions' });
      assert.equal(bypass.decision, 'deny', `${name} in bypassPermissions: ${bypass.reason} ${bypass.stderr}`);
      assert.match(bypass.reason, REASON_UNREADABLE, name);
      for (const permission_mode of ['default', 'acceptEdits', undefined]) {
        const prompted = mergeOnly({ tool_name: 'Bash', tool_input, cwd: fx.dir, permission_mode });
        assert.equal(prompted.decision, 'ask', `${name} in ${permission_mode}: ${prompted.reason} ${prompted.stderr}`);
        assert.match(prompted.reason, REASON_UNREADABLE, name);
      }
    }
  });

  // F3: the repository gh merges is the repository the hook reads. The pull request of the fake gh lives in
  // other/x, so the answer is coherent with the flag; what is checked is what `gh pr view` was asked.
  // The repository a `gh pr view` call names, in any spelling, the last one winning.
  function repositoryOf(args) {
    let repo;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === '-R' || arg === '--repo') repo = args[++i];
      else if (arg.startsWith('--repo=')) repo = arg.slice(7);
      else if (arg.startsWith('-R=')) repo = arg.slice(3);
      else if (arg.startsWith('-R')) repo = arg.slice(2);
    }
    return repo;
  }
  const SPELLINGS = [
    '-R other/x',
    '-Rother/x',
    '-R=other/x',
    '--repo other/x',
    '--repo=other/x',
    '-R first/x --repo=other/x',
    '--repo=first/x -Rother/x',
    '-R first/x -R other/x',
  ];
  for (const spelling of SPELLINGS) {
    test(`AC-8 (#57) F3 reads pull request 12 of other/x, not of the working directory, for gh pr merge 12 -s ${spelling}`, () => {
      const r = decide(`gh pr merge 12 -s ${spelling}`, {
        pr: { url: 'https://github.com/other/x/pull/12', headRefName: 'feature/x' },
      });
      wellRun(r, spelling);
      const views = r.calls.filter((call) => call.args[0] === 'pr' && call.args[1] === 'view');
      assert.ok(views.length > 0, `${spelling}: gh pr view was not called`);
      for (const view of views) {
        assert.ok(view.args.includes('12'), `${spelling}: the pull request number is missing: ${JSON.stringify(view.args)}`);
        assert.equal(repositoryOf(view.args.slice(2)), 'other/x', `${spelling}: gh pr view was called with ${JSON.stringify(view.args)}`);
      }
    });
  }
});
