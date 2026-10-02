// Tests for the user-level hooks. Each case runs the hook as Claude Code would:
// a JSON event on stdin, the decision on stdout.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const hooks = join(dirname(fileURLToPath(import.meta.url)), '..', 'global', 'hooks');

function run(hook, event, env = {}) {
  const result = spawnSync(process.execPath, [join(hooks, hook)], {
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

const bash = (cwd, command, env) => run('guard-git.mjs', { cwd, tool_name: 'Bash', tool_input: { command } }, env);
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
    assert.equal(bash(dir, 'git tag -d oracle/feature/x').decision, 'deny');
    assert.equal(bash(dir, 'git tag -f oracle/feature/x HEAD').decision, 'deny');
    assert.equal(bash(dir, 'git tag oracle/feature/x').decision, 'ask');
  });

  test('ignores commands it does not govern', () => {
    assert.equal(bash(dir, 'ls -la && echo "git push origin main"').decision, 'allow');
  });
});

// Issue #8: creating an oracle tag is the human's approval of the oracle, so it asks;
// moving or deleting one is denied through every route the guard can read.
describe('guard-git oracle tags', () => {
  let dir;
  before(() => { dir = repo(); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const expectAll = (commands, decision) => {
    for (const command of commands) {
      assert.equal(bash(dir, command).decision, decision, command);
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

  test('AC-3 denies deleting or moving an oracle tag with git tag, combined flags included', () => {
    expectAll([
      'git tag -d oracle/x',
      'git tag --delete oracle/x',
      'git tag -df oracle/x',
      'git tag -fd oracle/x',
      'git tag -f oracle/x HEAD',
      'git tag --force oracle/x HEAD',
      'git tag -d v1.0.0 oracle/x',
      'git tag -d oracle/x v1.0.0',
    ], 'deny');
  });

  test('AC-4 denies git update-ref on an oracle tag that exists', () => {
    sh(dir, 'tag', 'oracle/feature/x');
    expectAll([
      'git update-ref refs/tags/oracle/feature/x HEAD',
      'git update-ref -d refs/tags/oracle/feature/x',
      'git update-ref --no-deref refs/tags/oracle/feature/x HEAD',
      'git update-ref -m "retag" refs/tags/oracle/feature/x HEAD',
      'git update-ref -m retag -d refs/tags/oracle/feature/x',
    ], 'deny');
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
const kind = process.argv[2] === 'pr' ? 'view' : process.argv[2] === 'api' ? 'api' : 'other';
let step = scenario[kind] || { exit: 1, stderr: 'fake gh: unexpected call' };
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
    files: files.map((path) => ({ path })),
    changedFiles: files.length,
    statusCheckRollup: [PASSED],
    ...rest,
  };
}

describe('guard-git merge decision', () => {
  let dir;
  let root;
  let bin;
  before(() => {
    dir = repo();
    root = mkdtempSync(join(tmpdir(), 'cw-gh-'));
    bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  const withoutGh = () => process.env.PATH.split(delimiter).filter((d) => !existsSync(join(d, 'gh'))).join(delimiter);

  function merge(command, { pr = green(), view = { stdout: pr }, api = NOT_FOUND, env = {} } = {}) {
    const scenario = join(root, 'scenario.json');
    writeFileSync(scenario, JSON.stringify({ view, api }));
    rmSync(`${scenario}.calls`, { force: true });
    const result = bash(dir, command, { PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_GH: scenario, ...env });
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
    const call = outcome('src/other.ts', 'develop').calls.find((c) => c[0] === 'api');
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
