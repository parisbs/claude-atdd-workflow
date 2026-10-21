// Issue #27: global/settings.json runs guard-git from two Bash entries. --skip-merge runs for every command
// and fails open like the other hooks; --merge-only runs when the command names gh pr merge, and its entry
// blocks the call when the hook does not finish. Each case runs the entries through claude-hooks.mjs, as
// Claude Code does, or one mode of the hook directly. The probes behind the split are in
// docs/experiments/2026-10-21-hook-if-and-onfailure-probes.md. The fixtures repeat those of hooks.test.mjs,
// as guard-subagents.test.mjs does: a test file cannot import another without running its suites.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { HOOKS, SETTINGS, handlersFor, ifApplies, runConfigured } from './claude-hooks.mjs';

// guard-git run directly, with a mode or without one.
function guardGit(event, env, ...args) {
  const result = spawnSync(process.execPath, [join(HOOKS, 'guard-git.mjs'), ...args], {
    input: JSON.stringify({ tool_name: 'Bash', ...event }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  if (result.stdout.trim() === '') return { decision: 'allow', explicit: false, stderr: result.stderr };
  const out = JSON.parse(result.stdout).hookSpecificOutput;
  return { decision: out.permissionDecision, reason: out.permissionDecisionReason, explicit: true, stderr: result.stderr };
}

function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'cw-hooks-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'Test');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  sh(dir, 'config', 'tag.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'x\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'chore: init');
  return dir;
}

// A fake `gh` first on PATH stands in for GitHub; it records its calls and answers from a scenario.
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_GH, 'utf8'));
fs.appendFileSync(process.env.FAKE_GH + '.calls', JSON.stringify(process.argv.slice(2)) + '\n');
const args = process.argv.slice(2);
const kind = args[0] === 'pr' ? 'view' : args[0] === 'api'
  ? args.some((arg) => arg === 'user' || arg === '/user') ? 'user' : 'api' : 'other';
let step = scenario[kind] || (kind === 'user' ? { stdout: { login: 'me' } } : { exit: 1, stderr: 'fake gh: unexpected call' });
if (kind === 'api' && step.routes) {
  const line = process.argv.slice(2).join(' ');
  const key = Object.keys(step.routes).find((k) => line.includes(k));
  step = key ? step.routes[key] : { exit: 1, stderr: 'fake gh: unexpected call' };
}
const finish = () => {
  if (step.stderr) process.stderr.write(step.stderr);
  if (step.stdout !== undefined) process.stdout.write(typeof step.stdout === 'string' ? step.stdout : JSON.stringify(step.stdout));
  process.exit(step.exit === undefined ? 0 : step.exit);
};
if (step.delayMs) setTimeout(finish, step.delayMs); else finish();
`;

const NOT_FOUND = { exit: 1, stderr: 'gh: Not Found (HTTP 404)' };
const PASSED = { __typename: 'CheckRun', name: 'Test', status: 'COMPLETED', conclusion: 'SUCCESS' };

function green({ files = ['src/app.ts'], ...rest } = {}) {
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
    files: files.map((path) => ({ path })),
    changedFiles: files.length,
    statusCheckRollup: [PASSED],
    ...rest,
  };
}

describe('guard-git entries of global/settings.json (#27)', () => {
  let dir;
  let root;
  let bin;
  let broken;
  before(() => {
    dir = repo();
    root = mkdtempSync(join(tmpdir(), 'cw-entries-'));
    bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
    // A hooks directory caught halfway through an install: guard-git.mjs is there, lib.mjs is not.
    broken = join(root, 'hooks');
    mkdirSync(broken);
    copyFileSync(join(HOOKS, 'guard-git.mjs'), join(broken, 'guard-git.mjs'));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  const SQUASH = 'gh pr merge 12 --squash --delete-branch';
  const RED = { pr: green({ statusCheckRollup: [{ ...PASSED, conclusion: 'FAILURE' }] }) };
  let scenarios = 0;
  let scenario;
  // The environment of a fake gh that answers from a scenario. Each scenario has a call log of its own, so a
  // gh that a killed hook left behind cannot write into the log of a later case.
  function github({ pr = green(), view = { stdout: pr }, api = NOT_FOUND, user = { stdout: { login: 'me' } } } = {}) {
    scenarios += 1;
    scenario = join(root, `scenario-${scenarios}.json`);
    writeFileSync(scenario, JSON.stringify({ view, api, user }));
    return { PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_GH: scenario };
  }
  const ghCalls = () => (existsSync(`${scenario}.calls`)
    ? readFileSync(`${scenario}.calls`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []);
  const event = (command, extra = {}) => ({ cwd: dir, tool_name: 'Bash', tool_input: { command }, ...extra });
  const outcome = (result) => [result.decision, result.explicit];
  const guardGitHandlers = () => handlersFor('Bash').filter((h) => h.command.includes('guard-git.mjs'));
  const NO_NODE = () => join(root, 'no-node');

  test('AC-1 (#27) decides merges from an entry of its own that runs only for gh pr merge and blocks the call when it fails', () => {
    const merge = guardGitHandlers().filter((h) => / --merge-only\b/.test(h.command));
    assert.equal(merge.length, 1, 'one handler runs guard-git --merge-only');
    assert.equal(merge[0].if, 'Bash(gh pr merge *)');
    assert.equal(merge[0].onFailure, 'block');
  });

  test('AC-2 (#27) leaves every other rule to an entry for all of Bash that fails open, and no other hook blocks on failure', () => {
    const general = guardGitHandlers().filter((h) => / --skip-merge\b/.test(h.command));
    assert.equal(general.length, 1, 'one handler runs guard-git --skip-merge');
    assert.equal(general[0].if, undefined, 'it runs for every Bash command');
    assert.equal(guardGitHandlers().length, 2);
    const blocking = SETTINGS.hooks.PreToolUse.flatMap((entry) => entry.hooks).filter((h) => h.onFailure !== undefined);
    assert.equal(blocking.length, 1, 'one handler blocks on failure');
    assert.match(blocking[0].command, /node "\$HOME\/\.claude\/hooks\/guard-git\.mjs" --merge-only\b/);
    assert.equal(blocking[0].onFailure, 'block');
  });

  test('AC-1 (#27) blocks the merge, saying why, when gh hangs past the timeout of the merge entry', () => {
    // GUARD_GIT_GH_TIMEOUT_MS and GUARD_GIT_GH_BUDGET_MS let gh run for longer than the entry waits.
    const env = { ...github({ view: { stdout: green(), delayMs: 4000 } }), GUARD_GIT_GH_TIMEOUT_MS: '5000', GUARD_GIT_GH_BUDGET_MS: '5000' };
    const result = runConfigured(event(SQUASH), { env, timeoutMs: 1500 });
    assert.equal(result.decision, 'deny');
    assert.match(result.reason, /--merge-only\b[^\n]*: timed out after 1500 ms; blocking because onFailure is "block"/);
  });

  test('AC-1 (#27) blocks the merge when the hook cannot load its modules, or node cannot start', () => {
    for (const options of [{ hooksDir: broken }, { path: NO_NODE() }]) {
      const result = runConfigured(event(SQUASH), { env: github(), ...options });
      assert.equal(result.decision, 'deny', JSON.stringify(options));
      assert.match(result.reason, /--merge-only\b[^\n]*: exited with \d+; blocking because onFailure is "block"/);
      assert.deepEqual(ghCalls(), [], 'nothing read the pull request');
    }
  });

  test('AC-2 (#27) lets a command that is not a merge go ahead when the hook cannot load its modules, or node cannot start', () => {
    for (const options of [{ hooksDir: broken }, { path: NO_NODE() }]) {
      const result = runConfigured(event('git status'), options);
      assert.deepEqual(outcome(result), ['allow', false], JSON.stringify(options));
      assert.equal(result.failures.length, 1, 'the general entry shows a non-blocking error');
      assert.match(result.failures[0], /--skip-merge/);
    }
  });

  test('AC-2 (#27) lets a command that is not a merge go ahead, with the message on stderr, when guard-git throws', () => {
    // A cwd that is not a string makes guard-git throw as it follows the cd.
    const result = runConfigured(event('cd sub && git status', { cwd: 42 }));
    assert.deepEqual(outcome(result), ['allow', false]);
    assert.deepEqual(result.failures, []);
    assert.match(result.stderr, /guard-git: could not evaluate, allowing/);
  });

  test('AC-2 (#27) --merge-only gives no verdict and calls no gh for a command that is not a merge', () => {
    // Claude Code also runs the merge entry for what its `if` cannot rule out: $(), backticks, loops, functions.
    for (const command of [
      'echo $(date)',
      'echo `date`',
      'for f in a b; do echo $f; done',
      'f() { echo hi; }; f',
      'ls ${TMPDIR:-/tmp}',
      'git commit -m "$(cat msg.txt)"',
      'git push origin main',
      'gh pr view 12',
      'git merge feature/x',
      'echo gh pr merge 12 --squash',
    ]) {
      assert.deepEqual(outcome(guardGit(event(command), github(), '--merge-only')), ['allow', false], command);
      assert.deepEqual(ghCalls(), [], command);
    }
  });

  test('AC-3 (#27) --merge-only decides a merge in every compound form the guard reads, and --skip-merge never reads the pull request', () => {
    // A pull request gh cannot read ends the decision after its first call.
    const UNREADABLE = { view: { exit: 1, stderr: 'gh: not logged in' } };
    for (const command of [
      SQUASH,
      `cd ${dir} && gh pr merge 12 --squash`,
      `cd ${dir}; gh pr merge 12 --squash`,
      'GH_HOST=github.com gh pr merge 12 --squash',
      'FOO=1 BAR=2 gh pr merge 12 --squash',
      'gh pr merge 12 --squash -R o/r',
      'gh pr merge 12 --squash --repo=o/r',
      `cd ${dir} && GH_HOST=github.com gh pr merge 12 --squash -R o/r`,
      'echo start; gh pr merge 12 --squash',
      'false || gh pr merge 12 --squash',
      'gh pr merge 12 --squash | cat',
      'echo start\ngh pr merge 12 --squash',
      'gh pr merge 12 --squash && echo done',
    ]) {
      assert.equal(guardGit(event(command), github(UNREADABLE), '--merge-only').decision, 'ask', command);
      assert.ok(ghCalls().some((call) => call[0] === 'pr' && call[1] === 'view'), `${command}: the pull request was not read`);
      assert.deepEqual(outcome(guardGit(event(command), github(UNREADABLE), '--skip-merge')), ['allow', false], command);
      assert.deepEqual(ghCalls(), [], `${command}: --skip-merge called gh`);
    }
  });

  test('AC-4 (#27) both entries together decide as guard-git did from a single entry, for a subagent too', () => {
    const SUBAGENT = { agent_id: 'agent-1' };
    for (const [command, situation, extra] of [
      [SQUASH, {}, {}],
      [`${SQUASH} && echo done`, {}, {}],
      [SQUASH, RED, {}],
      ['gh pr merge 12 --admin --squash', {}, {}],
      ['gh pr merge 12 --merge', {}, {}],
      [`git commit -m "feat: x" && ${SQUASH}`, {}, {}],
      ['git commit -m "feat: x"', {}, {}],
      ['git push origin main', {}, {}],
      ['git push --force-with-lease origin feature/y', {}, {}],
      ['git tag -d oracle/feature/x', {}, {}],
      ['supabase db push', {}, {}],
      ['ls -la', {}, {}],
      [SQUASH, {}, SUBAGENT],
      ['gh pr view 12', {}, SUBAGENT],
      ['git push origin feature/y', {}, SUBAGENT],
    ]) {
      const label = `${command} ${JSON.stringify(extra)}`;
      const configured = runConfigured(event(command, extra), { env: github(situation) });
      assert.deepEqual(configured.failures, [], label);
      assert.deepEqual(outcome(configured), outcome(guardGit(event(command, extra), github(situation))), label);
    }
  });

  test('AC-8 (#27) --merge-only asks, giving the error, when it fails inside its own code', () => {
    // A cwd that is not a string makes guard-git throw as it follows the cd, before any gh call.
    const failing = event(`cd sub && ${SQUASH}`, { cwd: 42 });
    const result = guardGit(failing, github(), '--merge-only');
    assert.equal(result.decision, 'ask');
    assert.match(result.reason, /could not decide this merge/i);
    assert.match(result.reason, /must be of type string/);
    assert.equal(runConfigured(failing, { env: github() }).decision, 'ask', 'the general entry fails open, the merge entry asks');
  });

  // Issue #31: Claude Code runs the merge entry for every command its `if` cannot rule out, so a failure of
  // that entry must block a merge and nothing else.
  const NOT_MERGES = [
    'echo $(date)',
    'echo `date`',
    'for f in a b; do echo $f; done',
    'while false; do :; done',
    'f() { echo hi; }; f',
  ];
  // A hooks directory whose guard-git never finishes.
  const hanging = () => {
    const hooks = join(root, 'hanging');
    if (!existsSync(hooks)) {
      mkdirSync(hooks);
      writeFileSync(join(hooks, 'guard-git.mjs'), 'setInterval(() => {}, 1000);\n');
    }
    return hooks;
  };
  const isMergeEntry = (command) => command.includes('guard-git.mjs') && / --merge-only\b/.test(command);

  test('AC-1 (#31) a command that is not a merge goes ahead when the merge entry cannot start or runs past its timeout', () => {
    for (const [label, options] of [
      ['modules missing', { hooksDir: broken }],
      ['no node', { path: NO_NODE() }],
      ['hook hangs', { hooksDir: hanging(), timeoutMs: 1000 }],
    ]) {
      for (const command of NOT_MERGES) {
        const result = runConfigured(event(command), options);
        assert.ok(result.ran.some(isMergeEntry), `${label}, ${command}: the merge entry did not run`);
        assert.notEqual(result.decision, 'deny', `${label}, ${command}: ${result.reason}`);
        assert.ok(!result.failures.some(isMergeEntry), `${label}, ${command}: ${result.failures}`);
      }
    }
  });

  test('AC-2 (#31) a merge is blocked, naming onFailure, when the merge entry cannot start or runs past its timeout', () => {
    const merges = [
      SQUASH,
      `cd ${dir} && gh pr merge 12 --squash`,
      `cd ${dir}; gh pr merge 12 --squash`,
      'GH_HOST=github.com gh pr merge 12 --squash',
      'FOO=1 BAR=2 gh pr merge 12 --squash',
      'gh pr merge 12 --squash -R o/r',
      'gh pr merge 12 --squash --repo=o/r',
      'echo start; gh pr merge 12 --squash',
      'false || gh pr merge 12 --squash',
      'gh pr merge 12 --squash | cat',
      'echo start\ngh pr merge 12 --squash',
      'gh pr merge 12 --squash && echo done',
      'echo $(gh pr merge 12 --squash)',
      'echo `gh pr merge 12 --squash`',
      'for n in 12; do gh pr merge $n --squash; done',
      'gh pr "merge" 12 --squash',
      "gh pr 'merge' 12 --squash",
    ];
    for (const [label, options, commands] of [
      ['modules missing', { hooksDir: broken }, merges],
      ['no node', { path: NO_NODE() }, merges],
      ['hook hangs', { hooksDir: hanging(), timeoutMs: 1000 }, [SQUASH, 'echo $(gh pr merge 12 --squash)', "gh pr 'merge' 12 --squash"]],
    ]) {
      for (const command of commands) {
        const result = runConfigured(event(command), { env: github(), ...options });
        assert.equal(result.decision, 'deny', `${label}, ${command}`);
        assert.match(result.reason, /--merge-only\b[^\n]*: (?:exited with \d+|timed out after \d+ ms); blocking because onFailure is "block"/, `${label}, ${command}`);
      }
    }
  });

  test('AC-4 (#31) the merge entry exits 0 with no output for a command that is not a merge when node is not on PATH', () => {
    const [merge] = guardGitHandlers().filter((h) => isMergeEntry(h.command));
    const home = mkdtempSync(join(root, 'home-'));
    for (const command of NOT_MERGES) {
      const run = spawnSync('/bin/sh', ['-c', merge.command], {
        input: JSON.stringify(event(command)),
        encoding: 'utf8',
        env: { HOME: home, PATH: NO_NODE() },
      });
      assert.equal(run.status, 0, `${command}: ${run.stderr}`);
      assert.equal(run.stdout, '', command);
      assert.equal(run.stderr, '', command);
    }
  });
});

describe('the if of the test harness follows Claude Code (#31)', () => {
  const RULE = 'Bash(gh pr merge *)';
  const runs = (command, tool = 'Bash') => ifApplies(RULE, tool, { command });

  test('AC-3 (#31) runs an entry whose pattern names more than the command for any form if cannot rule out', () => {
    for (const command of ['echo $(date)', 'echo `date`', 'ls ${TMPDIR:-/tmp}', 'for f in a b; do echo $f; done', 'while false; do :; done', 'until true; do :; done', 'f() { echo hi; }; f']) {
      assert.equal(runs(command), true, command);
    }
  });

  test('AC-3 (#31) still applies the pattern to a plain command', () => {
    assert.equal(runs('gh pr merge 5 --squash'), true);
    for (const command of ['git status', 'echo $HOME', 'gh pr view 5', 'git log --oneline -3']) {
      assert.equal(runs(command), false, command);
    }
    assert.equal(runs('echo $(date)', 'Edit'), false, 'a Bash rule never runs for another tool');
  });
});
