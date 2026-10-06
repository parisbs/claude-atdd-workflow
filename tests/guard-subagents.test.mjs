// Issue #26 (ADR 0010, 0011): guard-git is the only place that can enforce "subagents never act on
// GitHub". A subagent's PreToolUse event carries agent_id and agent_type; the main session's carries
// neither. For an event with agent_id the hook denies `git push` and every `gh` command that is not
// on a read-only allowlist, and the Delegation section says so. The helpers repeat those of
// hooks.test.mjs on purpose: a test file cannot import another without running its suites, and that
// file stays untouched as the regression oracle of AC-4.
//
// The guard reads a command as words and allows a form it cannot read (ADR 0002, 0008). These tests
// pin what it must read; curl with a token, scripts that hide a gh call and the like are out of reach.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hook = join(root, 'global', 'hooks', 'guard-git.mjs');

function run(event, env = {}) {
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  if (result.stdout.trim() === '') return { decision: 'allow', explicit: false };
  const out = JSON.parse(result.stdout).hookSpecificOutput;
  return { decision: out.permissionDecision, reason: out.permissionDecisionReason, explicit: true };
}

function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'cw-subagent-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'Test');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'x\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'chore: init');
  sh(dir, 'checkout', '-q', '-b', 'feature/work');
  return dir;
}

// A fake `gh` first on PATH stands in for GitHub, as in hooks.test.mjs.
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_GH, 'utf8'));
const kind = process.argv[2] === 'pr' ? 'view' : process.argv[2] === 'api' ? 'api' : 'other';
const step = scenario[kind] || { exit: 1, stderr: 'fake gh: unexpected call' };
if (step.stderr) process.stderr.write(step.stderr);
if (step.stdout !== undefined) process.stdout.write(typeof step.stdout === 'string' ? step.stdout : JSON.stringify(step.stdout));
process.exit(step.exit === undefined ? 0 : step.exit);
`;

const NOT_FOUND = { exit: 1, stderr: 'gh: Not Found (HTTP 404)' };
const PASSED = { __typename: 'CheckRun', name: 'Test', status: 'COMPLETED', conclusion: 'SUCCESS' };
const FAILED = { __typename: 'CheckRun', name: 'Test', status: 'COMPLETED', conclusion: 'FAILURE' };

function green(overrides = {}) {
  return {
    number: 12,
    state: 'OPEN',
    isDraft: false,
    labels: [],
    baseRefName: 'main',
    url: 'https://github.com/o/r/pull/12',
    files: [{ path: 'src/app.ts' }],
    changedFiles: 1,
    statusCheckRollup: [PASSED],
    ...overrides,
  };
}

describe('guard-git for subagents', () => {
  let dir;
  let tmp;
  let bin;
  before(() => {
    dir = repo();
    tmp = mkdtempSync(join(tmpdir(), 'cw-subagent-gh-'));
    bin = join(tmp, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  });

  function call(command, { agent = true, pr = green() } = {}) {
    const scenario = join(tmp, 'scenario.json');
    writeFileSync(scenario, JSON.stringify({ view: { stdout: pr }, api: NOT_FOUND }));
    const event = { cwd: dir, tool_name: 'Bash', tool_input: { command } };
    if (agent) Object.assign(event, { agent_id: 'agent-7f3a', agent_type: 'claude-implementer' });
    return run(event, { PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_GH: scenario });
  }
  const asSubagent = (command, options) => call(command, options);
  const asOrchestrator = (command, options) => call(command, { ...options, agent: false });

  const denied = (commands, { agent = true } = {}) => {
    for (const command of commands) {
      const result = call(command, { agent });
      assert.equal(result.decision, 'deny', `${command} -> ${result.decision}`);
      assert.match(result.reason, /subagent/i, `${command}: the reason must name the rule`);
    }
  };
  const silent = (commands) => {
    for (const command of commands) {
      const result = asSubagent(command);
      assert.equal(result.decision, 'allow', `${command} -> ${result.decision}: ${result.reason}`);
      assert.equal(result.explicit, false, `${command}: this rule must print nothing`);
    }
  };

  test('AC-1 denies git push from a subagent in every form and names the rule', () => {
    denied([
      'git push',
      'git push origin feature/work',
      'git push -u origin feature/work',
      'git push origin HEAD:feature/work',
      'git push --force-with-lease origin feature/work',
      'git push --delete origin feature/old',
      'git push origin :feature/old',
      `git -C ${dir} push`,
      'git -c user.name=x push',
      'FOO=1 git push',
      '/usr/bin/git push origin feature/work',
      'git add . && git push',
      'git status; git push origin feature/work',
      'npm test || git push',
      'npm test\ngit push',
    ]);
  });

  test('AC-1 denies git push hidden in a shell wrapper', () => {
    denied([
      'bash -c "git push origin feature/work"',
      "sh -c 'git push'",
      'zsh -c "git add . && git push"',
      'bash -lc "git push"',
      'eval "git push origin feature/work"',
    ]);
  });

  test('AC-1 leaves every other git command of a subagent alone', () => {
    silent([
      'git status',
      'git diff',
      'git log --oneline',
      'git fetch origin',
      'git pull',
      'git add .',
      'git commit -m "feat: x"',
      'git checkout -b feature/next',
      'git stash',
      'git tag -l',
    ]);
  });

  test('AC-2 denies every gh command that is not on the read-only allowlist', () => {
    denied([
      'gh pr merge 12 --squash --delete-branch',
      'gh pr create --title "feat: x" --body y',
      'gh pr comment 12 --body hi',
      'gh pr close 12',
      'gh pr edit 12 --add-label needs-human',
      'gh pr review 12 --approve',
      'gh issue create --title x',
      'gh issue comment 5 --body hi',
      'gh issue close 5',
      'gh release create v1.0.0',
      'gh repo delete o/r --yes',
      'gh workflow run ci.yml',
      'gh run rerun 5',
      'gh secret set NAME',
      'gh gist create notes.md',
      'gh extension install o/gh-x',
      'gh config set editor vim',
      'gh frobnicate',
      'FOO=1 gh issue create --title x',
      '/opt/homebrew/bin/gh pr merge 12 --squash',
      'cd /tmp && /usr/local/bin/gh issue create --title x',
    ]);
  });

  test('AC-2 denies gh api unless it is a plain GET', () => {
    denied([
      'gh api -X POST repos/o/r/issues',
      'gh api --method POST repos/o/r/issues',
      'gh api --method=DELETE repos/o/r/issues/1',
      'gh api -XDELETE repos/o/r/issues/1',
      'gh api -X PATCH repos/o/r/issues/1',
      'gh api repos/o/r/issues -f title=x',
      'gh api repos/o/r/issues -F title=x',
      'gh api repos/o/r/issues --field title=x',
      'gh api repos/o/r/issues --raw-field title=x',
      'gh api repos/o/r/issues --input body.json',
      "gh api graphql -f query='query { viewer { login } }'",
    ]);
  });

  test('AC-2 denies every way of printing the token, auth status included', () => {
    denied([
      'gh auth token',
      'gh auth login',
      'gh auth refresh',
      'gh auth status --show-token',
      'gh auth status -t',
      'gh auth status --json hosts --show-token',
    ]);
  });

  test('AC-2 denies a gh call hidden in a shell wrapper', () => {
    denied([
      'bash -c "gh pr merge 12 --squash"',
      "sh -c 'gh issue create --title x'",
      'zsh -c "cd /tmp && gh issue comment 1 -b hi"',
      'bash -lc "gh pr merge 12 --squash"',
      'eval "gh pr merge 12 --squash"',
    ]);
  });

  test('AC-2 leaves a shell wrapper alone when nothing in it acts on GitHub', () => {
    silent([
      'bash -c "npm test"',
      "sh -c 'echo hello'",
      'zsh -c "node build.js && node --test"',
    ]);
  });

  test('AC-3 gives no verdict for an allowlisted read', () => {
    silent([
      'gh pr view 5',
      'gh pr view 5 -R o/r',
      'gh pr list',
      'gh pr diff 5',
      'gh pr checks 5',
      'gh pr status',
      'gh issue view 5',
      'gh issue list',
      'gh issue status',
      'gh run view 5',
      'gh run list',
      'gh run watch 5',
      'gh repo view o/r',
      'gh label list',
      'gh release view v1.0.0',
      'gh release list',
      'gh workflow view ci.yml',
      'gh workflow list',
      'gh search issues foo',
      'gh auth status',
      'gh api repos/o/r/pulls',
      'gh api -X GET repos/o/r/pulls',
      'gh api --method GET repos/o/r/pulls',
      'gh api -H "Accept: application/vnd.github+json" repos/o/r/pulls',
      'gh --version',
      'gh help',
      'gh --help',
      'cd /tmp && gh pr view 5',
      'gh pr view 5 && gh issue list | head -5',
    ]);
  });

  test('AC-4 decides as before when the event has no agent_id', () => {
    for (const command of [
      'git push origin feature/work',
      'gh issue create --title x',
      'bash -c "gh issue create --title x"',
      'gh auth status --show-token',
      '/opt/homebrew/bin/gh issue create --title x',
    ]) {
      const result = asOrchestrator(command);
      assert.equal(result.decision, 'allow', `${command}: ${result.reason}`);
      assert.equal(result.explicit, false, command);
    }
    assert.equal(asOrchestrator('gh pr merge 12 --merge').decision, 'deny');
    const merged = asOrchestrator('gh pr merge 12 --squash --delete-branch');
    assert.equal(merged.decision, 'allow');
    assert.equal(merged.explicit, true, 'the merge decision of ADR 0010 must still print an allow');
  });

  test('AC-5 denies a subagent merge that would be an explicit allow for the orchestrator, and prints no allow', () => {
    for (const command of [
      'gh pr merge 12 --squash --delete-branch',
      'gh pr merge 12 --squash',
      'gh pr merge --squash',
      'gh pr merge 12 --squash -R o/r',
    ]) {
      const forOrchestrator = asOrchestrator(command);
      assert.equal(forOrchestrator.explicit, true, `${command}: expected an allow for the orchestrator`);
      const forSubagent = asSubagent(command);
      assert.equal(forSubagent.decision, 'deny', `${command} -> ${forSubagent.decision}`);
      assert.match(forSubagent.reason, /subagent/i, command);
    }
  });

  test('AC-5 keeps the denial a denial, not a question, when the pull request is not mergeable', () => {
    for (const pr of [
      green({ isDraft: true }),
      green({ statusCheckRollup: [FAILED] }),
      green({ labels: [{ name: 'needs-human' }] }),
      green({ files: [{ path: 'CLAUDE.md' }] }),
    ]) {
      assert.equal(asSubagent('gh pr merge 12 --squash', { pr }).decision, 'deny');
    }
  });

  test('AC-6 denies the whole call when one segment of the chain is denied', () => {
    denied([
      'cd /tmp && gh pr merge 12 --squash',
      'echo done && git push',
      'gh pr view 5 && git push origin feature/work',
      'git status; git push',
      'git push || true',
      'gh pr view 5 | tee out.txt && gh issue create --title x',
      'npm test\ngit push',
      'cd /tmp && bash -c "git push"',
    ]);
  });
});

describe('Delegation section and ADR 0013', () => {
  const instructions = readFileSync(join(root, 'global', 'CLAUDE.md'), 'utf8');
  const delegation = instructions.split(/^## /m).find((part) => part.startsWith('Delegation')) ?? '';
  const adrs = join(root, 'docs', 'adr');

  test('AC-7 says guard-git enforces that a subagent never acts on GitHub', () => {
    assert.match(delegation, /never act on GitHub/i);
    assert.match(delegation, /guard-git[\s\S]{0,200}subagent|subagent[\s\S]{0,200}guard-git/i);
    assert.match(delegation, /enforce|denies|denied/i);
  });

  test('AC-8 records the decision as ADR 0013, lists it in the index and marks ADR 0011 as amended by it', () => {
    const file = readdirSync(adrs).find((name) => name.startsWith('0013-') && name.endsWith('.md'));
    assert.ok(file, 'docs/adr/0013-*.md does not exist');
    const text = readFileSync(join(adrs, file), 'utf8');
    assert.match(text, /agent_id/);
    assert.match(text, /0011/);
    assert.match(readFileSync(join(adrs, 'README.md'), 'utf8'), new RegExp(`\\(${file.replace('.', '\\.')}\\)`));
    const eleven = readdirSync(adrs).find((name) => name.startsWith('0011-'));
    assert.match(readFileSync(join(adrs, eleven), 'utf8'), /^- Status: .*0013/m);
  });
});
