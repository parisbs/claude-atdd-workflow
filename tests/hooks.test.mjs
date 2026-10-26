// Tests for the user-level hooks. Each case runs the hook as Claude Code would:
// a JSON event on stdin, the decision on stdout. guard-git runs through the Bash
// entries of global/settings.json (claude-hooks.mjs), so its cases check the
// configuration that is installed; the merge-decision cases run the entry that
// decides merges, and guard-git-entries.test.mjs checks both entries together
// (issue #27).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runConfigured } from './claude-hooks.mjs';

const hooks = join(dirname(fileURLToPath(import.meta.url)), '..', 'global', 'hooks');

function run(hook, event, env = {}, args = []) {
  const result = spawnSync(process.execPath, [join(hooks, hook), ...args], {
    input: JSON.stringify(event),
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

// A Bash call through every entry of global/settings.json that applies to it; none may fail.
function bash(cwd, command, env = {}) {
  const result = runConfigured({ cwd, tool_name: 'Bash', tool_input: { command } }, { env });
  assert.deepEqual(result.failures, [], result.stderr);
  return result;
}
// Deleting an oracle tag makes guard-git read the branch's pull request with gh (#55), and these cases
// must not reach the network or depend on a login: a gh that fails at once comes first on PATH.
let offlineBin;
function bashOffline(cwd, command) {
  if (!offlineBin) {
    offlineBin = mkdtempSync(join(tmpdir(), 'cw-hooks-offline-gh-'));
    writeFileSync(join(offlineBin, 'gh'), '#!/bin/sh\necho "gh: offline" >&2\nexit 1\n', { mode: 0o755 });
    process.on('exit', () => rmSync(offlineBin, { recursive: true, force: true }));
  }
  return bash(cwd, command, { PATH: `${offlineBin}${delimiter}${process.env.PATH}` });
}
// guard-git run directly, with a mode or without one.
const guardGit = (event, env, ...args) => run('guard-git.mjs', { tool_name: 'Bash', ...event }, env, args);
const edit = (cwd, file_path) => run('guard-tests.mjs', { cwd, tool_name: 'Edit', tool_input: { file_path } });

describe('guard-git', () => {
  let dir;
  before(() => { dir = repo(); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('denies a commit on main once it has history', () => {
    assert.equal(bash(dir, 'git commit -m "feat: x"').decision, 'deny');
  });

  test('allows a commit on a feature branch', () => {
    sh(dir, 'checkout', '-q', '-b', 'feature/x');
    assert.equal(bash(dir, 'git add . && git commit -m "feat: x"').decision, 'allow');
    sh(dir, 'checkout', '-q', 'main');
  });

  test('allows the first commit of an empty repository', () => {
    const empty = mkdtempSync(join(tmpdir(), 'cw-empty-'));
    sh(empty, 'init', '-q', '-b', 'main');
    assert.equal(bash(empty, 'git commit -m "chore: init"').decision, 'allow');
    rmSync(empty, { recursive: true, force: true });
  });

  test('follows a branch switch earlier in the same chain', () => {
    assert.equal(bash(dir, 'git checkout -b feature/chain && git add . && git commit -m "feat: x"').decision, 'allow');
    assert.equal(bash(dir, 'git switch -c feature/chain2 && git commit -m "feat: x"').decision, 'allow');
    sh(dir, 'branch', 'feature/existing');
    assert.equal(bash(dir, 'git checkout feature/existing && git commit -m "feat: x"').decision, 'allow');
    assert.equal(bash(dir, 'git checkout -- README.md && git commit -m "feat: x"').decision, 'deny');
    sh(dir, 'checkout', '-q', 'feature/existing');
    assert.equal(bash(dir, 'git checkout main && git commit -m "feat: x"').decision, 'deny');
    sh(dir, 'checkout', '-q', 'main');
  });

  test('denies --no-verify', () => {
    sh(dir, 'checkout', '-q', '-b', 'feature/nv');
    assert.equal(bash(dir, 'git commit --no-verify -m "feat: x"').decision, 'deny');
    assert.equal(bash(dir, 'git push --no-verify origin feature/nv').decision, 'deny');
    sh(dir, 'checkout', '-q', 'main');
  });

  test('asks before the first publication of main', () => {
    assert.equal(bash(dir, 'git push -u origin main').decision, 'ask');
  });

  test('denies a push to a published main', () => {
    sh(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.equal(bash(dir, 'git push origin main').decision, 'deny');
    assert.equal(bash(dir, 'git push').decision, 'deny');
    assert.equal(bash(dir, 'git push --force origin feature/y:main').decision, 'deny');
  });

  test('asks for a force push to a feature branch', () => {
    assert.equal(bash(dir, 'git push --force-with-lease origin feature/y').decision, 'ask');
  });

  test('follows cd and git -C to the right repository', () => {
    const other = mkdtempSync(join(tmpdir(), 'cw-other-'));
    sh(other, 'init', '-q', '-b', 'main');
    assert.equal(bash(other, `cd ${dir} && git commit -m "feat: x"`).decision, 'deny');
    assert.equal(bash(other, `git -C ${dir} commit -m "feat: x"`).decision, 'deny');
    rmSync(other, { recursive: true, force: true });
  });

  test('requires squash and forbids --admin on gh pr merge', () => {
    assert.equal(bash(dir, 'gh pr merge 12 --merge').decision, 'deny');
    assert.equal(bash(dir, 'gh pr merge 12 --squash --admin').decision, 'deny');
  });

  test('asks before acting on a remote Supabase project', () => {
    assert.equal(bash(dir, 'supabase db push').decision, 'ask');
    assert.equal(bash(dir, 'npx supabase link --project-ref abc').decision, 'ask');
    assert.equal(bash(dir, 'supabase db reset').decision, 'allow');
  });

  test('protects oracle tags from the agent', () => {
    assert.equal(bashOffline(dir, 'git tag -d oracle/feature/x').decision, 'ask');
    assert.equal(bashOffline(dir, 'git tag -f oracle/feature/x HEAD').decision, 'ask');
    assert.equal(bash(dir, 'git tag oracle/feature/x').decision, 'ask');
  });

  test('ignores commands it does not govern', () => {
    assert.equal(bash(dir, 'ls -la && echo "git push origin main"').decision, 'allow');
  });
});

// Issue #8: creating an oracle tag is the human's approval of the oracle, so it asks;
// moving or deleting one was denied through every route the guard can read. Issue #55 (ADR 0029): in the
// main session those ask too, so the human can approve them from a session without a terminal;
// guard-git-oracle-tags.test.mjs covers the reasons, the subagent and bypassPermissions.
describe('guard-git oracle tags', () => {
  let dir;
  before(() => { dir = repo(); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const expectAll = (commands, decision, run = bash) => {
    for (const command of commands) {
      assert.equal(run(dir, command).decision, decision, command);
    }
  };

  test('AC-1 asks before git tag creates an oracle tag in any flag form', () => {
    expectAll([
      'git tag oracle/x',
      'git tag oracle/feature/a-b abc1234',
      'git tag -a oracle/x -m "msg"',
      'git tag -m "msg" oracle/x',
      'git tag --annotate oracle/x --message=msg',
      'git tag -am "msg" oracle/x',
      'git tag -s oracle/x -m m',
      'git tag -u KEYID oracle/x -m m',
      'git tag -F notes.txt oracle/x HEAD~1',
      `git -C ${dir} tag oracle/x`,
      `cd ${dir} && git tag oracle/x`,
      'git add . && git tag oracle/x',
    ], 'ask');
  });

  test('AC-2 gives no verdict when tags are only listed or read', () => {
    expectAll([
      'git tag',
      "git tag -l 'oracle/*'",
      'git tag --list oracle/*',
      'git tag -l --sort=-v:refname',
      'git tag -n oracle/x',
      'git tag -v oracle/x',
      'git tag --contains HEAD',
      'git tag --points-at HEAD',
    ], 'allow');
  });

  test('AC-3 asks before deleting or moving an oracle tag with git tag, combined flags included', () => {
    expectAll([
      'git tag -d oracle/x',
      'git tag --delete oracle/x',
      'git tag -df oracle/x',
      'git tag -fd oracle/x',
      'git tag -f oracle/x HEAD',
      'git tag --force oracle/x HEAD',
      'git tag -d v1.0.0 oracle/x',
      'git tag -d oracle/x v1.0.0',
    ], 'ask', bashOffline);
  });

  test('AC-4 asks before git update-ref moves or deletes an oracle tag that exists', () => {
    sh(dir, 'tag', 'oracle/feature/x');
    expectAll([
      'git update-ref refs/tags/oracle/feature/x HEAD',
      'git update-ref -d refs/tags/oracle/feature/x',
      'git update-ref --no-deref refs/tags/oracle/feature/x HEAD',
      'git update-ref -m "retag" refs/tags/oracle/feature/x HEAD',
      'git update-ref -m retag -d refs/tags/oracle/feature/x',
    ], 'ask', bashOffline);
  });

  test('AC-4 asks when git update-ref would create an oracle tag that does not exist', () => {
    expectAll([
      'git update-ref refs/tags/oracle/feature/new HEAD',
      'git update-ref -m "approved" refs/tags/oracle/feature/new HEAD',
    ], 'ask');
  });

  test('AC-4 allows git update-ref on refs that are not oracle tags', () => {
    expectAll([
      'git update-ref refs/heads/feature/x HEAD',
      'git update-ref refs/tags/v1.0.0 HEAD',
      'git update-ref refs/heads/oracle/x HEAD',
    ], 'allow');
  });

  test('AC-5 gives no verdict when oracle/ appears only in a message or in another tag', () => {
    expectAll([
      'git tag -a v1.2.3 -m "oracle/x was removed"',
      'git tag -m "oracle/x fix" v1.2.3',
      'git tag -f -m "oracle/x fix" v1.2.3',
      'git tag v1.0.0 -m "see oracle/x"',
    ], 'allow');
  });
});

// Issue #7 (ADR 0010): `gh pr merge` is decided from what GitHub shows about the pull request.
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
    headRefName: 'feature/x', // the oracle tag of #57 is oracle/<head branch>
    ...rest,
  };
}

describe('guard-git merge decision', () => {
  let dir;
  let root;
  let bin;
  let gitEnv;
  before(() => {
    dir = repo();
    root = mkdtempSync(join(tmpdir(), 'cw-gh-'));
    bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
    gitEnv = installFakeGit(root, bin);
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  const withoutGh = () => process.env.PATH.split(delimiter).filter((d) => !existsSync(join(d, 'gh'))).join(delimiter);

  function merge(command, { pr = green(), view = { stdout: pr }, api = NOT_FOUND, user = { stdout: { login: 'me' } }, env = {} } = {}) {
    const scenario = join(root, 'scenario.json');
    writeFileSync(scenario, JSON.stringify({ view, api, user }));
    rmSync(`${scenario}.calls`, { force: true });
    // The entry that decides merges; AC-4 (#27) checks it together with the general one.
    const result = guardGit({ cwd: dir, tool_input: { command } }, { PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_GH: scenario, ...gitEnv, ...env }, '--merge-only');
    const calls = existsSync(`${scenario}.calls`)
      ? readFileSync(`${scenario}.calls`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    return { ...result, calls };
  }

  const SQUASH = 'gh pr merge 12 --squash --delete-branch';
  const allowed = (result, label) => {
    assert.equal(result.decision, 'allow', `${label}: ${result.reason}`);
    assert.equal(result.explicit, true, `${label}: an explicit allow was expected`);
  };
  const asks = (result, label, pattern) => {
    assert.equal(result.decision, 'ask', label);
    if (pattern) assert.match(result.reason, pattern, label);
  };

  // Issue #5: passing checks do not authorize a fork or another author's pull request.
  const userCalls = (result) => result.calls.filter((c) =>
    c[0] === 'api' && c.some((arg) => arg === 'user' || arg === '/user'));

  for (const [label, login, headRepository] of [
    ["a stranger's fork", 'stranger', { name: 'r' }],
    ["the user's own fork", 'me', { name: 'r' }],
    ['a deleted fork', 'stranger', null],
  ]) {
    test(`AC-1 (#5) asks for ${label} and names the head repository`, () => {
      const result = merge(SQUASH, {
        pr: green({ isCrossRepository: true, headRepositoryOwner: { login }, headRepository }),
      });
      asks(result, label);
      assert.match(result.reason, new RegExp(`\\b${login}\\b`), 'the reason must name the head owner');
      if (headRepository) assert.ok(result.reason.includes(`${login}/r`), 'the reason must name the head repository as owner/name');
    });
  }

  test('AC-1 (#5) asks for a fork even when gh names no head owner', () => {
    asks(merge(SQUASH, { pr: green({ isCrossRepository: true, headRepositoryOwner: null }) }), 'fork without a head owner');
  });

  for (const [login, is_bot] of [['collaborator', false], ['app/dependabot', true], ['app/renovate', true]]) {
    test(`AC-2 (#5) asks when the author is ${login} and names the author`, () => {
      const result = merge(SQUASH, { pr: green({ author: { login, is_bot } }) });
      asks(result, login);
      assert.ok(result.reason.includes(login), `the reason must name ${login}`);
    });
  }

  for (const host of ['github.com', 'ghe.example.com']) {
    test(`AC-2 (#5) reads the authenticated user with --hostname ${host} from the pull request URL`, () => {
      const result = merge(SQUASH, {
        pr: green({ url: `https://${host}/o/r/pull/12` }),
        env: { GH_HOST: 'elsewhere.example.com' },
      });
      const calls = userCalls(result);
      assert.ok(calls.length > 0, 'gh api user was not called');
      for (const call of calls) {
        assert.ok(call.some((arg, i) => arg === '--hostname' && call[i + 1] === host), `missing --hostname ${host}: ${call.join(' ')}`);
        assert.ok(!call.some((arg) => /^--jq(?:=|$)|^-q/.test(arg)), 'the user lookup must return the JSON body without --jq');
      }
      allowed(result, host);
    });
  }

  test('AC-1/AC-2 (#5) asks gh pr view for author and head-repository fields', () => {
    const call = merge(SQUASH).calls.find((c) => c[0] === 'pr' && c[1] === 'view');
    assert.ok(call, 'gh pr view was not called');
    const fields = call[call.indexOf('--json') + 1].split(',');
    for (const field of ['author', 'isCrossRepository', 'headRepositoryOwner', 'headRepository']) {
      assert.ok(fields.includes(field), `missing ${field}`);
    }
  });

  test("AC-3 (#5) explicitly allows the user's own pull request in the base repository after looking up the user", () => {
    const result = merge(SQUASH, {
      pr: green({ author: { login: 'developer', is_bot: false } }),
      user: { stdout: { login: 'developer' } },
    });
    allowed(result, 'own pull request in the base repository');
    assert.ok(userCalls(result).length > 0, 'gh api user was not called');
  });

  for (const [label, author] of [['missing', undefined], ['null', null], ['without a login', { is_bot: false }], ['with an empty login', { login: '', is_bot: false }]]) {
    test(`AC-4 (#5) asks when the author is ${label}`, () => {
      asks(merge(SQUASH, { pr: green({ author }) }), `author ${label}`);
    });
  }

  for (const [label, isCrossRepository] of [['missing', undefined], ['null', null], ['a string', 'false'], ['a number', 0]]) {
    test(`AC-4 (#5) asks when isCrossRepository is ${label}`, () => {
      asks(merge(SQUASH, { pr: green({ isCrossRepository }) }), `isCrossRepository ${label}`);
    });
  }

  for (const [label, user] of [
    ['fails with HTTP 403', { exit: 1, stderr: 'gh: Resource not accessible by integration (HTTP 403)' }],
    ['returns non-JSON output', { stdout: '<html>oops</html>' }],
    ['returns JSON without a login', { stdout: {} }],
    ['returns empty output', { stdout: '' }],
  ]) {
    test(`AC-4 (#5) asks when the authenticated user lookup ${label}`, () => {
      const result = merge(SQUASH, { user });
      asks(result, label);
      assert.ok(userCalls(result).length > 0, 'gh api user was not called');
    });
  }

  test('AC-4 (#5) asks when the authenticated user lookup times out', () => {
    asks(merge(SQUASH, {
      user: { stdout: { login: 'me' }, delayMs: 1500 },
      env: { GUARD_GIT_GH_TIMEOUT_MS: '300' },
    }), 'slow user lookup');
  });

  // Review of #5: three serial gh calls must answer within the hook's own timeout, so
  // the calls share one budget (GUARD_GIT_GH_BUDGET_MS) besides the limit of each.
  test('AC-4 (#5) asks when the gh calls together exceed the time budget, though each is under its limit', () => {
    const slow = { delayMs: 1500 };
    const result = merge(SQUASH, {
      view: { stdout: green(), ...slow },
      api: { ...NOT_FOUND, ...slow },
      user: { stdout: { login: 'me' }, ...slow },
      env: { GUARD_GIT_GH_TIMEOUT_MS: '4000', GUARD_GIT_GH_BUDGET_MS: '2500' },
    });
    asks(result, 'calls over the shared budget', /time/i);
  });

  test('AC-2 (#5) reads CLAUDE.md of the base branch with --hostname of the pull request host', () => {
    const result = merge(SQUASH, { env: { GH_HOST: 'elsewhere.example.com' } });
    const call = result.calls.find((c) => c[0] === 'api' && c.some((arg) => arg.includes('contents/CLAUDE.md')));
    assert.ok(call, 'gh api was not called to read CLAUDE.md');
    assert.ok(call.some((arg, i) => arg === '--hostname' && call[i + 1] === 'github.com'), `missing --hostname github.com: ${call.join(' ')}`);
  });

  test('AC-1 denies --admin and any merge that does not squash, even when gh is missing', () => {
    const env = { PATH: withoutGh() };
    for (const command of [
      'gh pr merge 12 --admin --squash',
      'gh pr merge 12 -s --admin',
      'gh pr merge 12 --merge',
      'gh pr merge 12 --rebase',
      'gh pr merge 12',
    ]) {
      assert.equal(bash(dir, command, env).decision, 'deny', command);
    }
  });

  test('AC-2 prints an explicit allow for a green pull request, whatever the selector form', () => {
    for (const command of [
      SQUASH,
      'gh pr merge 12 -s -d',
      'gh pr merge https://github.com/o/r/pull/12 --squash',
      'gh pr merge feature/x --squash',
      'gh pr merge --squash',
      'gh pr merge 12 --squash -R o/r',
    ]) {
      allowed(merge(command), command);
    }
  });

  test('AC-2 passes the selector and the repository on to gh pr view', () => {
    const view = (command) => {
      const call = merge(command).calls.find((c) => c[0] === 'pr' && c[1] === 'view');
      assert.ok(call, `gh pr view was not called for: ${command}`);
      return call;
    };
    assert.ok(view(SQUASH).includes('12'));
    assert.ok(view('gh pr merge feature/x --squash').includes('feature/x'));
    const remote = view('gh pr merge 12 --squash -R o/r');
    assert.ok(remote.includes('-R') && remote.includes('o/r'));
  });

  test('AC-2 asks gh for every field the decision needs', () => {
    const call = merge(SQUASH).calls.find((c) => c[0] === 'pr' && c[1] === 'view');
    assert.ok(call, 'gh pr view was not called');
    const fields = call[call.indexOf('--json') + 1].split(',');
    for (const field of ['baseRefName', 'changedFiles', 'files', 'isDraft', 'labels', 'statusCheckRollup', 'url']) {
      assert.ok(fields.includes(field), `missing ${field}`);
    }
  });

  test('AC-2 counts SUCCESS, SKIPPED, NEUTRAL and successful statuses as passed', () => {
    allowed(merge(SQUASH, {
      pr: green({
        statusCheckRollup: [
          PASSED,
          { __typename: 'CheckRun', name: 'Optional', status: 'COMPLETED', conclusion: 'SKIPPED' },
          { __typename: 'CheckRun', name: 'Lint', status: 'COMPLETED', conclusion: 'NEUTRAL' },
          { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS' },
        ],
      }),
    }), 'mixed passing checks');
  });

  test('AC-2 gives no verdict when the command is more than a plain merge', () => {
    for (const command of [
      `${SQUASH} && echo done`,
      `echo start; ${SQUASH}`,
      `${SQUASH} > out.txt`,
      `${SQUASH} | cat`,
      'gh pr merge 12 --squash --body "$(id)"',
      'gh pr merge 12 --squash --body `id`',
    ]) {
      const result = merge(command);
      assert.equal(result.decision, 'allow', command);
      assert.equal(result.explicit, false, `${command}: an explicit allow would cover the whole command`);
    }
  });

  test('AC-3 asks when a check did not pass, and names it', () => {
    const run = (check) => ({ __typename: 'CheckRun', name: 'Build', status: 'COMPLETED', ...check });
    const rollups = [
      [run({ conclusion: 'FAILURE' })],
      [run({ conclusion: 'CANCELLED' })],
      [run({ conclusion: 'TIMED_OUT' })],
      [run({ conclusion: 'ACTION_REQUIRED' })],
      [run({ conclusion: 'STARTUP_FAILURE' })],
      [run({ status: 'IN_PROGRESS', conclusion: '' })],
      [run({ status: 'QUEUED', conclusion: '' })],
      [PASSED, run({ conclusion: 'FAILURE' })],
    ];
    for (const statusCheckRollup of rollups) {
      asks(merge(SQUASH, { pr: green({ statusCheckRollup }) }), JSON.stringify(statusCheckRollup), /Build/);
    }
    for (const state of ['PENDING', 'FAILURE', 'ERROR']) {
      asks(merge(SQUASH, { pr: green({ statusCheckRollup: [{ __typename: 'StatusContext', context: 'ci/legacy', state }] }) }),
        state, /ci\/legacy/);
    }
  });

  test('AC-3 asks when the pull request has no checks at all', () => {
    asks(merge(SQUASH, { pr: green({ statusCheckRollup: [] }) }), 'no checks', /checks/i);
  });

  test('AC-4 asks for every default control-plane path, in every stack and at any depth', () => {
    for (const path of [
      '.github/workflows/ci.yml',
      'docs/adr/0012-x.md',
      'docs/adrs/0001-x.md',
      'docs/decisions/001-x.md',
      'AGENTS.md',
      'CLAUDE.md',
      'app/AGENTS.md',
      'app/CLAUDE.md',
      '.claude/settings.json',
      'package.json',
      'packages/a/package.json',
      'tsconfig.json',
      'pubspec.yaml',
      'analysis_options.yaml',
      'app/build.gradle.kts',
      'gradle/libs.versions.toml',
      'supabase/config.toml',
      'supabase/migrations/20260101_init.sql',
      'pyproject.toml',
      'svc/setup.cfg',
      'pytest.ini',
      'tox.ini',
    ]) {
      asks(merge(SQUASH, { pr: green({ files: ['src/app.ts', path] }) }), path, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  test('AC-4 does not ask for ordinary source files of any stack', () => {
    allowed(merge(SQUASH, {
      pr: green({
        files: [
          'lib/main.dart',
          'app/src/main/kotlin/App.kt',
          'src/app.py',
          'src/index.ts',
          'README.md',
          'docs/adr-notes.md',
          'docs/guide.md',
          'supabase/functions/hello/index.ts',
        ],
      }),
    }), 'ordinary files');
  });

  test('AC-1 (#17) reads Human merge: from the CLAUDE.md of the base branch with gh api', () => {
    const claudeMd = { stdout: '# Repo\n\n## Workflow\n\n- Review: none\n- Human merge: src/codex/args.ts, server.json\n' };
    const api = { routes: { 'contents/CLAUDE.md': claudeMd } };
    const outcome = (file, base = 'main') => merge(SQUASH, { pr: green({ files: [file], baseRefName: base }), api });
    asks(outcome('src/codex/args.ts'), 'listed file', /src\/codex\/args\.ts/);
    asks(outcome('server.json'), 'second listed file', /server\.json/);
    allowed(outcome('src/other.ts'), 'unlisted file');
    const call = outcome('src/other.ts', 'develop').calls.find((c) => c[0] === 'api' && c.some((arg) => arg.includes('contents/CLAUDE.md')));
    assert.ok(call, 'gh api was not called to read CLAUDE.md');
    const line = call.join(' ');
    assert.match(line, /repos\/o\/r\/contents\/CLAUDE\.md/);
    assert.match(line, /ref=develop/);
  });

  test('AC-4 accepts globs in Human merge:, and none adds nothing', () => {
    const globs = { routes: { 'contents/CLAUDE.md': { stdout: '- Human merge: src/codex/**, **/*.sql\n' } } };
    asks(merge(SQUASH, { pr: green({ files: ['src/codex/deep/x.ts'] }), api: globs }), 'glob directory');
    asks(merge(SQUASH, { pr: green({ files: ['db/seed.sql'] }), api: globs }), 'glob extension');
    const none = { routes: { 'contents/CLAUDE.md': { stdout: '- Human merge: none\n' } } };
    allowed(merge(SQUASH, { pr: green({ files: ['src/codex/x.ts'] }), api: none }), 'none, ordinary file');
    asks(merge(SQUASH, { pr: green({ files: ['AGENTS.md'] }), api: none }), 'none, default path');
  });

  test('AC-2 (#17) applies only the defaults when the base has no CLAUDE.md', () => {
    const api = { routes: { 'contents/CLAUDE.md': NOT_FOUND } };
    allowed(merge(SQUASH, { pr: green({ files: ['src/x.ts'] }), api }), 'no CLAUDE.md, ordinary file');
    asks(merge(SQUASH, { pr: green({ files: ['.github/workflows/ci.yml'] }), api }), 'no CLAUDE.md, default path');
  });

  test('AC-4 (#17) ignores a Human merge: line that only AGENTS.md carries and never requests that file', () => {
    const api = {
      routes: {
        'contents/CLAUDE.md': NOT_FOUND,
        'contents/AGENTS.md': { stdout: '- Human merge: src/x.ts\n' },
      },
    };
    const result = merge(SQUASH, { pr: green({ files: ['src/x.ts'] }), api });
    allowed(result, 'line only in AGENTS.md');
    assert.ok(!result.calls.some((c) => c.join(' ').includes('AGENTS.md')), 'AGENTS.md must not be requested');
  });

  test('AC-5 asks when the pull request carries needs-human, in any capitalisation', () => {
    for (const labels of [
      [{ name: 'needs-human' }],
      [{ name: 'Needs-Human' }],
      [{ name: 'bug' }, { name: 'needs-human' }],
    ]) {
      asks(merge(SQUASH, { pr: green({ labels }) }), JSON.stringify(labels), /needs-human/i);
    }
    allowed(merge(SQUASH, { pr: green({ labels: [{ name: 'bug' }] }) }), 'unrelated label');
  });

  test('AC-9 asks when the pull request is a draft', () => {
    asks(merge(SQUASH, { pr: green({ isDraft: true }) }), 'draft', /draft/i);
  });

  test('AC-6 asks, and says why, when gh is missing', () => {
    asks(bash(dir, SQUASH, { PATH: withoutGh() }), 'gh missing', /gh/);
  });

  test('AC-6 asks, and says why, when the pull request cannot be read', () => {
    const cases = [
      ['gh fails', { exit: 1, stderr: 'gh: not logged in' }, /not logged in/],
      ['no pull request for the argument', { exit: 1, stderr: 'no pull requests found for branch "x"' }, /no pull requests found/],
      ['output is not JSON', { stdout: '<html>oops</html>' }, /could not read/i],
      ['output lacks fields', { stdout: { number: 12 } }, /could not read/i],
      ['output is empty', { stdout: '' }, /could not read/i],
    ];
    for (const [label, view, pattern] of cases) {
      asks(merge(SQUASH, { view }), label, pattern);
    }
  });

  test('AC-6 asks when gh is slower than the limit', () => {
    const env = { GUARD_GIT_GH_TIMEOUT_MS: '300' };
    asks(merge(SQUASH, { view: { stdout: green(), delayMs: 1500 }, env }), 'slow pr view', /timed out/i);
    asks(merge(SQUASH, { api: { stdout: '', delayMs: 1500 }, env }), 'slow gh api', /timed out/i);
  });

  test('AC-6 asks when fewer files are listed than the pull request changed', () => {
    const files = Array.from({ length: 100 }, (_, i) => `src/f${i}.ts`);
    asks(merge(SQUASH, { pr: green({ files, changedFiles: 143 }) }), 'truncated file list', /files/i);
  });

  test('AC-3 (#17) asks, naming CLAUDE.md, when it cannot be read for a reason other than not found', () => {
    const fails = (stderr) => ({ routes: { 'contents/CLAUDE.md': { exit: 1, stderr } } });
    asks(merge(SQUASH, { api: fails('gh: Internal Server Error (HTTP 500)') }), 'server error', /CLAUDE\.md/);
    asks(merge(SQUASH, { api: fails('dial tcp: lookup api.github.com: no such host') }), 'network', /CLAUDE\.md/);
  });
});

// Issue #27: a repository may name another default branch, so the one origin/HEAD points to is protected
// like main and master.
describe('guard-git default branch of origin (#27)', () => {
  let dir;
  let plain;
  before(() => {
    dir = repo();
    sh(dir, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    sh(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    sh(dir, 'checkout', '-q', '-b', 'develop');
    plain = repo();
    sh(plain, 'checkout', '-q', '-b', 'develop');
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  });

  test('AC-5 (#27) denies a commit on the branch origin/HEAD points to', () => {
    const result = bash(dir, 'git commit -m "feat: x"');
    assert.equal(result.decision, 'deny');
    assert.match(result.reason, /Do not commit on develop/);
  });

  test('AC-5 (#27) denies a push to it, a force push and its deletion, as for main', () => {
    for (const command of [
      'git push origin develop',
      'git push',
      'git push origin feature/y:develop',
      'git push origin HEAD:refs/heads/develop',
      'git push --force origin develop',
      'git push origin +feature/y:develop',
      'git push origin --delete develop',
      'git push origin :develop',
    ]) {
      assert.equal(bash(dir, command).decision, 'deny', command);
    }
  });

  test('AC-5 (#27) keeps main and master protected beside it', () => {
    sh(dir, 'checkout', '-q', 'main');
    try {
      assert.equal(bash(dir, 'git commit -m "feat: x"').decision, 'deny');
    } finally {
      sh(dir, 'checkout', '-q', 'develop');
    }
    assert.equal(bash(dir, 'git push origin master').decision, 'ask', 'a first publication of master asks');
  });

  test('AC-5 (#27) treats develop as an ordinary branch where origin/HEAD does not name it', () => {
    assert.equal(bash(plain, 'git commit -m "feat: x"').decision, 'allow');
    assert.equal(bash(plain, 'git push origin develop').decision, 'allow');
  });

  test('AC-5 (#27) reads origin/HEAD of the repository the command reaches through cd or git -C', () => {
    assert.equal(bash(plain, `cd ${dir} && git commit -m "feat: x"`).decision, 'deny');
    assert.equal(bash(plain, `git -C ${dir} commit -m "feat: x"`).decision, 'deny');
    assert.equal(bash(dir, `git -C ${plain} commit -m "feat: x"`).decision, 'allow');
  });
});

describe('guard-tests', () => {
  let dir;
  before(() => {
    dir = repo();
    sh(dir, 'checkout', '-q', '-b', 'feature/login');
    mkdirSync(join(dir, 'app/src/test/kotlin'), { recursive: true });
    writeFileSync(join(dir, 'app/src/test/kotlin/LoginTest.kt'), 'class LoginTest\n');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('allows everything while no oracle tag exists', () => {
    assert.equal(edit(dir, join(dir, 'app/src/test/kotlin/LoginTest.kt')).decision, 'allow');
  });

  test('freezes test paths once the oracle is tagged', () => {
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'test: add login acceptance tests');
    sh(dir, 'tag', 'oracle/feature/login');
    assert.equal(edit(dir, join(dir, 'app/src/test/kotlin/LoginTest.kt')).decision, 'deny');
    assert.equal(edit(dir, 'app/src/androidTest/kotlin/New.kt').decision, 'deny');
    assert.equal(edit(dir, join(dir, 'test/widget_test.dart')).decision, 'deny');
    assert.equal(edit(dir, join(dir, 'supabase/tests/rls.sql')).decision, 'deny');
  });

  test('allows production code and asks for test configuration', () => {
    assert.equal(edit(dir, join(dir, 'app/src/main/kotlin/Login.kt')).decision, 'allow');
    assert.equal(edit(dir, join(dir, 'app/build.gradle.kts')).decision, 'ask');
  });

  test('uses the test paths recorded in the oracle commit', () => {
    sh(dir, 'checkout', '-q', '-b', 'feature/custom');
    mkdirSync(join(dir, '.atdd'), { recursive: true });
    writeFileSync(join(dir, '.atdd/test-paths'), '# frozen\nspecs/**\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'test: declare test paths');
    sh(dir, 'tag', 'oracle/feature/custom');
    assert.equal(edit(dir, join(dir, 'specs/a/b.kt')).decision, 'deny');
    assert.equal(edit(dir, join(dir, 'app/src/test/kotlin/LoginTest.kt')).decision, 'allow');
    assert.equal(edit(dir, join(dir, '.atdd/test-paths')).decision, 'deny');
  });

  test('ignores files outside a git repository', () => {
    const loose = mkdtempSync(join(tmpdir(), 'cw-loose-'));
    assert.equal(edit(loose, join(loose, 'test/a.dart')).decision, 'allow');
    rmSync(loose, { recursive: true, force: true });
  });
});

describe('oracle-check', () => {
  let dir;
  const check = () => spawnSync(process.execPath, [join(hooks, 'oracle-check.mjs')], { cwd: dir, encoding: 'utf8' });

  before(() => {
    dir = repo();
    sh(dir, 'checkout', '-q', '-b', 'feature/pay');
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'test/pay.test.ts'), "test('AC-1 pays', () => {});\n");
    writeFileSync(join(dir, 'package.json'), '{}\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'test: add acceptance tests');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('passes when there is no oracle tag', () => {
    assert.equal(check().status, 0);
  });

  test('passes when only production code changed', () => {
    sh(dir, 'tag', 'oracle/feature/pay');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/pay.ts'), 'export const pay = () => 1;\n');
    const r = check();
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /test paths: unchanged/);
  });

  test('reports configuration changes without failing', () => {
    writeFileSync(join(dir, 'package.json'), '{"scripts":{}}\n');
    const r = check();
    assert.equal(r.status, 0);
    assert.match(r.stdout, /test configuration changed[\s\S]*package\.json/);
  });

  test('fails when a test changed, committed or not, and reports added skips', () => {
    writeFileSync(join(dir, 'test/pay.test.ts'), "test.skip('AC-1 pays', () => {});\n");
    const r = check();
    assert.equal(r.status, 1);
    assert.match(r.stdout, /test paths changed[\s\S]*test\/pay\.test\.ts/);
    assert.match(r.stdout, /skip annotations added/);
  });
});

// A delegate in a linked worktree works on a branch of its own (#45). The oracle
// of the branch the worktree was made from still binds it.
describe('guard-tests and oracle-check in a linked worktree (#45)', () => {
  let dir;
  let trees;
  const tree = (name, start, branch = `worktree-agent-${name}`) => {
    const path = join(trees, name);
    sh(dir, 'worktree', 'add', '-q', '-b', branch, path, start);
    return path;
  };
  const commit = (cwd, files, message) => {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(join(cwd, dirname(file)), { recursive: true });
      writeFileSync(join(cwd, file), content);
    }
    sh(cwd, 'add', '.');
    sh(cwd, 'commit', '-q', '-m', message);
  };
  const write = (cwd, file_path) => run('guard-tests.mjs', { cwd, tool_name: 'Write', tool_input: { file_path, content: 'x\n' } });
  const check = (cwd) => spawnSync(process.execPath, [join(hooks, 'oracle-check.mjs')], { cwd, encoding: 'utf8' });
  // An allow must come from evaluating the rule, not from failing open.
  const evaluatedAllow = (r) => {
    assert.equal(r.decision, 'allow');
    assert.equal(r.stderr, '');
  };

  before(() => {
    dir = repo();
    trees = mkdtempSync(join(tmpdir(), 'cw-trees-'));
    sh(dir, 'checkout', '-q', '-b', 'feature/x');
    commit(dir, { 'test/x.test.ts': "test('AC-1 x', () => {});\n", 'package.json': '{}\n' }, 'test: add acceptance tests');
    sh(dir, 'tag', 'oracle/feature/x');
    sh(dir, 'checkout', '-q', '-b', 'feature/y');
    commit(dir, { 'test/y.test.ts': "test('AC-1 y', () => {});\n" }, 'test: add more acceptance tests');
    sh(dir, 'tag', 'oracle/feature/y');
    sh(dir, 'checkout', '-q', '-b', 'feature/custom', 'main');
    commit(dir, { '.atdd/test-paths': 'specs/**\n', 'specs/a.kt': 'class A\n', 'package.json': '{}\n' }, 'test: declare test paths');
    sh(dir, 'tag', 'oracle/feature/custom');
    sh(dir, 'checkout', '-q', 'main');
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(trees, { recursive: true, force: true });
  });

  test('AC-1 denies Edit and Write on a test path in a worktree whose HEAD is the oracle commit of another branch', () => {
    const wt = tree('at-oracle', 'oracle/feature/x');
    const r = edit(wt, join(wt, 'test/x.test.ts'));
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /oracle\/feature\/x/);
    assert.equal(write(wt, join(wt, 'test/new.test.ts')).decision, 'deny');
  });

  test('AC-1 resolves the oracle from the worktree of the edited file, not from the session cwd', () => {
    const wt = tree('cwd-elsewhere', 'oracle/feature/x');
    assert.equal(edit(dir, join(wt, 'test/x.test.ts')).decision, 'deny');
  });

  test('AC-1 denies test paths in a worktree with commits after the oracle commit', () => {
    const wt = tree('after-oracle', 'oracle/feature/x');
    commit(wt, { 'src/x.ts': 'export const x = 1;\n' }, 'feat: implement x');
    assert.equal(edit(wt, join(wt, 'test/x.test.ts')).decision, 'deny');
    assert.equal(edit(wt, join(wt, 'test/new.test.ts')).decision, 'deny');
    assert.equal(edit(wt, join(wt, 'src/x.ts')).decision, 'allow');
  });

  test('AC-1 denies test paths in a detached linked worktree that descends from the oracle', () => {
    const wt = tree('detached', 'oracle/feature/x');
    sh(wt, 'checkout', '-q', '--detach');
    assert.equal(edit(wt, join(wt, 'test/x.test.ts')).decision, 'deny');
  });

  test('AC-1 denies test paths when the oracle commit is reached through a merge', () => {
    const wt = tree('merged', 'main');
    commit(wt, { 'src/m.ts': 'export const m = 1;\n' }, 'feat: independent work');
    sh(wt, 'merge', '-q', '--no-ff', '--no-edit', 'oracle/feature/x');
    assert.equal(edit(wt, join(wt, 'test/x.test.ts')).decision, 'deny');
  });

  test('AC-1 honours an annotated oracle tag', () => {
    const wt = tree('annotated', 'main');
    commit(wt, { 'test/a.test.ts': "test('AC-1 a', () => {});\n" }, 'test: add acceptance tests');
    sh(wt, 'tag', '-a', 'oracle/feature/annotated', '-m', 'approved');
    commit(wt, { 'src/a.ts': 'export const a = 1;\n' }, 'feat: implement a');
    assert.equal(edit(wt, join(wt, 'test/a.test.ts')).decision, 'deny');
  });

  test('AC-1 applies the test paths and configuration rules recorded in that oracle commit', () => {
    const wt = tree('custom', 'oracle/feature/custom');
    commit(wt, { '.atdd/test-paths': 'other/**\n' }, 'test: attempt to redefine paths');
    assert.equal(edit(wt, join(wt, 'specs/b.kt')).decision, 'deny');
    assert.equal(edit(wt, join(wt, '.atdd/test-paths')).decision, 'deny');
    assert.equal(edit(wt, join(wt, 'other/a.kt')).decision, 'allow');
    assert.equal(edit(wt, join(wt, 'test/other.test.ts')).decision, 'allow');
    assert.equal(edit(wt, join(wt, 'package.json')).decision, 'ask');
  });

  test('AC-1 uses the oracle tag nearest to HEAD when several are ancestors', () => {
    const wt = tree('nearest', 'oracle/feature/y');
    commit(wt, { 'src/near.ts': 'export const near = 1;\n' }, 'feat: advance');
    sh(wt, 'tag', 'oracle/feature/x2');
    commit(wt, { 'src/later.ts': 'export const later = 1;\n' }, 'feat: advance again');
    const r = edit(wt, join(wt, 'test/x.test.ts'));
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /oracle\/feature\/x2/);
    assert.doesNotMatch(r.reason, /oracle\/feature\/(x|y)\b/);
  });

  test('AC-2 allows test paths in a worktree that no oracle tag is an ancestor of', () => {
    const wt = tree('from-main', 'main');
    evaluatedAllow(edit(wt, join(wt, 'test/x.test.ts')));
  });

  test("AC-2 keeps a linked worktree branch's own oracle tag, even when it is not an ancestor", () => {
    const wt = tree('own', 'main');
    sh(wt, 'tag', 'oracle/worktree-agent-own', 'oracle/feature/x');
    const r = edit(wt, join(wt, 'test/x.test.ts'));
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /oracle\/worktree-agent-own/);
  });

  test('AC-2 leaves the main checkout as today on a branch stacked on another branch with an oracle', () => {
    sh(dir, 'checkout', '-q', '-b', 'feature/stacked', 'oracle/feature/x');
    try {
      evaluatedAllow(edit(dir, join(dir, 'test/x.test.ts')));
    } finally {
      sh(dir, 'checkout', '-q', 'main');
    }
  });

  test('AC-3 oracle-check in such a worktree compares against that oracle tag', () => {
    const wt = tree('check', 'oracle/feature/x');
    commit(wt, { 'src/x.ts': 'export const x = 1;\n' }, 'feat: implement x');
    let r = check(wt);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /against oracle\/feature\/x/);
    writeFileSync(join(wt, 'test/x.test.ts'), "test.skip('AC-1 x', () => {});\n");
    r = check(wt);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /test paths changed[\s\S]*test\/x\.test\.ts/);
    commit(wt, {}, 'test: alter frozen test');
    r = check(wt);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /test paths changed[\s\S]*test\/x\.test\.ts/);
  });

  test('AC-3 oracle-check uses the nearest oracle and its recorded test paths', () => {
    const clean = tree('check-nearest', 'oracle/feature/y');
    let r = check(clean);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /against oracle\/feature\/y/);
    const custom = tree('check-custom', 'oracle/feature/custom');
    writeFileSync(join(custom, 'specs/a.kt'), 'class Changed\n');
    r = check(custom);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /test paths changed[\s\S]*specs\/a\.kt/);
  });

  test('AC-3 oracle-check has nothing to check in a worktree no oracle tag is an ancestor of', () => {
    const wt = tree('check-main', 'main');
    const r = check(wt);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /nothing to check/);
  });
});
