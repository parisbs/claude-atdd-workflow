// Isolated repositories and fake executables shared by the issue #73 hook acceptance tests.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOKS, runConfigured } from './claude-hooks.mjs';
import { writeExecutable } from './executables.mjs';

export const POSIX = process.platform === 'win32' ? 'the hook tests are POSIX-only' : false;
export const SESSIONS = [
  ['main session', { permission_mode: 'default' }, 'ask'],
  ['subagent', { permission_mode: 'default', agent_id: 'agent-73' }, 'deny'],
  ['bypassPermissions', { permission_mode: 'bypassPermissions' }, 'deny'],
];
const REAL_GIT = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const GIT_ENV = {
  LC_ALL: 'C', LANG: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
const CLEAN_ENV = Object.fromEntries(Object.keys(process.env)
  .filter((key) => /^(?:GIT_|GH_|HUSKY|GUARD_GIT_|FAKE_)/.test(key)).map((key) => [key, undefined]));

const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_GH, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\n');
let step = { exit: 1, stderr: 'fake gh: unexpected call ' + JSON.stringify(args) };
if (args[0] === 'pr' && args[1] === 'view') step = { stdout: scenario.pr };
else if (args[0] === 'pr' && args[1] === 'list') step = { stdout: [] };
else if (args[0] === 'api') step = args.some((arg) => arg === 'user' || arg === '/user')
  ? { stdout: { login: 'me' } } : { exit: 1, stderr: 'gh: Not Found (HTTP 404)' };
if (args[0] === 'api') {
  const endpoint = args.map((arg) => decodeURIComponent(arg)).find((arg) => arg.includes('repos/o/r/contents/'));
  if (endpoint) {
    const key = endpoint.slice(endpoint.indexOf('repos/o/r/contents/') + 'repos/o/r/contents/'.length);
    step = scenario.contents?.[key] ?? { exit: 1, stderr: 'gh: Not Found (HTTP 404)' };
  }
}
if (step.stderr) process.stderr.write(step.stderr);
if (step.stdout !== undefined) process.stdout.write(typeof step.stdout === 'string' ? step.stdout : JSON.stringify(step.stdout));
process.exit(step.exit || 0);
`;

// Network reads never reach git. The delayed local read has a finite lifetime even on the old hook,
// which does not yet honour GUARD_GIT_DECISION_BUDGET_MS.
const FAKE_GIT = String.raw`#!/bin/sh
case " $* " in
  *" ls-remote "*) exec node "$FAKE_GIT_DRIVER" "$@" ;;
  *" fetch "*|*" push "*|*" pull "*|*" clone "*) exit 1 ;;
esac
if [ "$FAKE_GIT_HANG" = 1 ] || [ "$FAKE_GIT_LOG_ALL" = 1 ]; then
  exec node "$FAKE_GIT_DRIVER" "$@"
fi
exec "$REAL_GIT" "$@"
`;
const FAKE_GIT_DRIVER = String.raw`
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\n');
if (args.includes('ls-remote')) process.exit(0);
if (args.some((arg) => ['fetch', 'push', 'pull', 'clone'].includes(arg))) {
  process.stderr.write('fake git: network command refused');
  process.exit(1);
}
function finish() {
  const r = spawnSync(process.env.REAL_GIT, args, { encoding: 'utf8', timeout: 3000 });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status === null ? 1 : r.status);
}
const reads = fs.readFileSync(process.env.FAKE_GIT_LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  .filter((call) => call.args?.[0] === 'branch' && call.args[1] === '--show-current').length;
if (process.env.FAKE_GIT_HANG === '1' && args[0] === 'branch' && args[1] === '--show-current'
    && reads >= Number(process.env.FAKE_GIT_HANG_AFTER || 1)) {
  fs.appendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify({ delayed: true }) + '\n');
  setTimeout(() => {
    fs.appendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify({ completed: true }) + '\n');
    finish();
  }, 2000);
} else finish();
`;

export function fixture() {
  const scratch = mkdtempSync(join(tmpdir(), 'cw-gates-73-'));
  const home = join(scratch, 'home');
  const bin = join(scratch, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'node'));
  writeExecutable(join(bin, 'gh'), FAKE_GH);
  writeExecutable(join(bin, 'git'), FAKE_GIT);
  const gitDriver = join(scratch, 'fake-git.cjs');
  writeFileSync(gitDriver, FAKE_GIT_DRIVER);
  const env = {
    ...CLEAN_ENV, ...GIT_ENV, HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
    PATH: `${bin}${delimiter}${dirname(process.execPath)}${delimiter}/usr/bin${delimiter}/bin`, REAL_GIT,
    FAKE_GIT_DRIVER: gitDriver,
  };
  let counter = 0;
  function git(cwd, ...args) {
    const r = spawnSync(REAL_GIT, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 5000 });
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.error?.message ?? r.stderr}`);
    return r.stdout.trim();
  }
  function repository({ branch = 'feature/work', oracle = true, directory } = {}) {
    const dir = directory ?? mkdtempSync(join(scratch, 'repo-'));
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'config', 'tag.gpgsign', 'false');
    git(dir, 'config', 'core.hooksPath', '/dev/null');
    git(dir, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
    writeFileSync(join(dir, 'README.md'), 'a\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'chore: init');
    const a = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'update-ref', 'refs/remotes/origin/main', a);
    git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    git(dir, 'tag', 'v1.0.0');
    if (oracle) git(dir, 'tag', 'oracle/x');
    git(dir, 'checkout', '-q', '-b', 'feature/work');
    writeFileSync(join(dir, 'README.md'), 'b\n');
    git(dir, 'commit', '-q', '-am', 'feat: work');
    const b = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'update-ref', 'refs/remotes/origin/feature/work', b);
    if (branch !== 'feature/work') git(dir, 'checkout', '-q', branch);
    return { dir, a, b };
  }
  function decide(repo, command, { session = SESSIONS[0][1], mode, configured = false, settings, extraEnv = {}, pr = {}, contents = {} } = {}) {
    const id = ++counter;
    const ghFile = join(scratch, `gh-${id}.json`);
    const ghLog = join(scratch, `gh-${id}.log`);
    const gitLog = join(scratch, `git-${id}.log`);
    writeFileSync(ghFile, JSON.stringify({ pr: {
      number: 5, state: 'OPEN', isDraft: false, labels: [], baseRefName: 'main',
      url: 'https://github.com/o/r/pull/5', author: { login: 'me', is_bot: false },
      isCrossRepository: false, headRepositoryOwner: { login: 'o' }, headRepository: { name: 'r' },
      headRefName: 'feature/work', headRefOid: repo.b, files: [{ path: 'README.md' }], changedFiles: 1,
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'Test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      ...pr,
    }, contents }));
    const runEnv = { ...env, FAKE_GH: ghFile, FAKE_GH_LOG: ghLog, FAKE_GIT_LOG: gitLog,
      GUARD_GIT_GH_BUDGET_MS: '8000', GUARD_GIT_GH_TIMEOUT_MS: '3000', ...extraEnv };
    const event = { cwd: repo.dir, tool_name: 'Bash', tool_input: { command }, ...session };
    let result;
    const start = performance.now();
    if (configured) {
      result = runConfigured(event, { env: runEnv, settings, timeoutMs: 12000 });
      assert.deepEqual(result.failures, [], `${command}: ${result.stderr}`);
    } else {
      const r = spawnSync(process.execPath, [join(HOOKS, 'guard-git.mjs'), ...(mode ? [mode] : [])], {
        input: JSON.stringify(event), cwd: repo.dir, encoding: 'utf8', timeout: 12000,
        env: { ...process.env, ...runEnv },
      });
      assert.equal(r.status, 0, `${command}: ${r.error?.message ?? r.stderr}`);
      const out = r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : {};
      result = { decision: out.permissionDecision ?? 'allow', reason: out.permissionDecisionReason ?? '',
        explicit: Boolean(out.permissionDecision), stderr: r.stderr };
    }
    const calls = (file) => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    return { ...result, elapsed: performance.now() - start, ghCalls: calls(ghLog), gitCalls: calls(gitLog) };
  }
  return { scratch, home, git, repository, decide, close: () => rmSync(scratch, { recursive: true, force: true }) };
}

export function silent(result, command) {
  assert.equal(result.stderr, '', `${command}: unexpected failure: ${result.stderr}`);
  assert.equal(result.decision, 'allow', `${command}: ${result.reason}`);
  assert.equal(result.explicit, false, `${command}: an ordinary read must print no verdict`);
}

export function unread(result, expected, gate, part, command) {
  assert.equal(result.stderr, '', `${command}: unexpected failure: ${result.stderr}`);
  assert.equal(result.decision, expected, `${command}: ${result.reason || 'no verdict'}`);
  assert.equal(result.explicit, true, command);
  assert.ok(result.reason.includes(`Unread command at the ${gate} gate:`), `${command}: ${result.reason}`);
  assert.match(result.reason, part, `${command}: the unread part is missing: ${result.reason}`);
  assert.match(result.reason, /Canonical form:\s*\S/, command);
}

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
