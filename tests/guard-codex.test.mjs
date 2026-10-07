// Issue #42 (ADR 0002, 0014): guard-codex makes the rules about Codex delegations hold for every call of
// codex_delegate and codex_follow_up, in both registrations. Each case runs the real hook as Claude Code
// would: a JSON event on stdin, the decision on stdout, a fail-open message on stderr. A Codex worktree is
// a path inside $CODEX_HOME/worktrees, so every case points CODEX_HOME at a scratch directory.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hook = join(root, 'global', 'hooks', 'guard-codex.mjs');
const REGISTRATIONS = ['codex-reviewer', 'codex-implementer'];
const tool = (registration, name) => `mcp__${registration}__${name}`;

const scratch = [];
const tmp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

const codexHome = tmp('cw-codex-home-');

function call(tool_name, tool_input, cwd = tmpdir()) {
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ cwd, hook_event_name: 'PreToolUse', tool_name, tool_input }),
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: codexHome },
  });
  assert.equal(result.status, 0, result.stderr);
  if (result.stdout.trim() === '') return { decision: 'allow', explicit: false, stderr: result.stderr };
  const out = JSON.parse(result.stdout).hookSpecificOutput;
  return { decision: out.permissionDecision, reason: out.permissionDecisionReason, explicit: true, stderr: result.stderr };
}

// A call that passes gets no verdict at all: a printed allow would lift the permission prompt (ADR 0010).
const passes = (result, label) => {
  assert.equal(result.decision, 'allow', `${label}: ${result.reason}`);
  assert.equal(result.explicit, false, `${label}: a passing call must print nothing`);
};

function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function repo() {
  const dir = tmp('cw-guard-codex-');
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'Test');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'x\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'chore: init');
  sh(dir, 'checkout', '-q', '-b', 'feature/x');
  return dir;
}

// A worktree where Codex makes them: $CODEX_HOME/worktrees/<id>/<repository>.
function codexWorktree(dir, id) {
  const path = join(codexHome, 'worktrees', id, 'repo');
  mkdirSync(dirname(path), { recursive: true });
  sh(dir, 'worktree', 'add', '-q', '--detach', path, 'HEAD');
  return path;
}

describe('guard-codex registration', () => {
  test('AC-2 settings.json runs the guard for codex_delegate and codex_follow_up of both registrations, and for no other tool', () => {
    const settings = JSON.parse(readFileSync(join(root, 'global', 'settings.json'), 'utf8'));
    const entries = settings.hooks.PreToolUse.filter((entry) => entry.hooks.some((h) => (h.command ?? '').includes('guard-codex.mjs')));
    assert.equal(entries.length, 1, 'guard-codex.mjs must be registered once under PreToolUse');
    const matcher = new RegExp(`^(?:${entries[0].matcher})$`);
    for (const registration of REGISTRATIONS) {
      for (const name of ['codex_delegate', 'codex_follow_up']) assert.match(tool(registration, name), matcher);
      for (const name of ['codex_job_status', 'codex_job_result', 'codex_job_cancel', 'codex_doctor', 'codex_recommend', 'list_codex_models']) {
        assert.doesNotMatch(tool(registration, name), matcher);
      }
    }
    for (const other of ['Bash', 'Edit', 'mcp__codex__codex_delegate', 'mcp__codex-implementer-x__codex_delegate']) assert.doesNotMatch(other, matcher);
  });
});

describe('guard-codex', () => {
  let dir;
  let worktree;
  before(() => {
    dir = repo();
    worktree = codexWorktree(dir, 'ab12');
  });

  test('AC-1 denies a worktree delegation from a directory with an uncommitted tracked change and an untracked file, naming both', () => {
    writeFileSync(join(dir, 'README.md'), 'changed\n');
    writeFileSync(join(dir, 'notes.txt'), 'new\n');
    try {
      for (const registration of REGISTRATIONS) {
        const r = call(tool(registration, 'codex_delegate'), { prompt: 'x', working_dir: dir, use_worktree: true, sandbox: 'read-only' });
        assert.equal(r.decision, 'deny', registration);
        assert.match(r.reason, /README\.md/, registration);
        assert.match(r.reason, /notes\.txt/, registration);
        assert.match(r.reason, /\bcommit\b/i, registration);
      }
    } finally {
      sh(dir, 'checkout', '-q', '--', 'README.md');
      rmSync(join(dir, 'notes.txt'));
    }
  });

  test('AC-1 gives no verdict for a worktree delegation when only ignored files are present', () => {
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'node_modules/dep.js'), 'x\n');
    for (const registration of REGISTRATIONS) {
      passes(call(tool(registration, 'codex_delegate'), { prompt: 'x', working_dir: dir, use_worktree: true, sandbox: 'read-only' }), registration);
    }
  });

  test('AC-1 does not check the status of a delegation that does not use a worktree', () => {
    writeFileSync(join(dir, 'notes.txt'), 'new\n');
    try {
      for (const registration of REGISTRATIONS) {
        passes(call(tool(registration, 'codex_delegate'), { prompt: 'x', working_dir: dir, sandbox: 'read-only' }), `${registration} without use_worktree`);
        passes(call(tool(registration, 'codex_delegate'), { prompt: 'x', working_dir: dir, use_worktree: false, sandbox: 'read-only' }), `${registration} use_worktree false`);
      }
    } finally {
      rmSync(join(dir, 'notes.txt'));
    }
  });

  test('AC-2 denies codex_delegate and codex_follow_up of both registrations without working_dir, and says to pass it', () => {
    for (const registration of REGISTRATIONS) {
      for (const [name, input] of [
        ['codex_delegate', { prompt: 'x', sandbox: 'read-only' }],
        ['codex_delegate', { prompt: 'x', working_dir: '', sandbox: 'read-only' }],
        ['codex_follow_up', { prompt: 'x', thread_id: 't1', sandbox: 'read-only' }],
        ['codex_follow_up', { prompt: 'x', thread_id: 't1', working_dir: '', sandbox: 'read-only' }],
      ]) {
        const r = call(tool(registration, name), input, dir);
        assert.equal(r.decision, 'deny', `${registration} ${name} ${JSON.stringify(input)}`);
        assert.match(r.reason, /working_dir/);
      }
    }
  });

  test('AC-2 gives no verdict on the other Codex tools, which take no working_dir', () => {
    for (const registration of REGISTRATIONS) {
      passes(call(tool(registration, 'codex_job_status'), { job_id: 'j1' }, dir), registration);
    }
  });

  test('AC-3 denies a writing follow-up of codex-implementer in the work tree, and says to pass the worktree path or start a new delegation', () => {
    for (const sandbox of ['workspace-write', 'danger-full-access']) {
      const r = call(tool('codex-implementer', 'codex_follow_up'), { prompt: 'x', thread_id: 't1', working_dir: dir, sandbox });
      assert.equal(r.decision, 'deny', sandbox);
      assert.match(r.reason, /worktree/i);
      assert.match(r.reason, /codex_delegate|new delegation/i);
    }
  });

  test('AC-3 denies a writing follow-up of codex-implementer in a linked worktree that Codex did not make', () => {
    const other = join(tmp('cw-other-worktree-'), 'repo');
    sh(dir, 'worktree', 'add', '-q', '--detach', other, 'HEAD');
    const r = call(tool('codex-implementer', 'codex_follow_up'), { prompt: 'x', thread_id: 't1', working_dir: other, sandbox: 'workspace-write' });
    assert.equal(r.decision, 'deny');
  });

  test('AC-3 gives no verdict for a writing follow-up of codex-implementer inside a Codex worktree, or a directory in it', () => {
    mkdirSync(join(worktree, 'src'), { recursive: true });
    for (const working_dir of [worktree, join(worktree, 'src')]) {
      passes(call(tool('codex-implementer', 'codex_follow_up'), { prompt: 'x', thread_id: 't1', working_dir, sandbox: 'workspace-write' }), working_dir);
    }
  });

  test('AC-3 gives no verdict for a follow-up that does not write, or one to codex-reviewer', () => {
    passes(call(tool('codex-implementer', 'codex_follow_up'), { prompt: 'x', thread_id: 't1', working_dir: dir, sandbox: 'read-only' }), 'read-only');
    passes(call(tool('codex-implementer', 'codex_follow_up'), { prompt: 'x', thread_id: 't1', working_dir: dir }), 'no sandbox: the registration default is read-only');
    passes(call(tool('codex-reviewer', 'codex_follow_up'), { prompt: 'x', thread_id: 't1', working_dir: dir, sandbox: 'workspace-write' }), 'codex-reviewer');
  });

  test('AC-8 denies a writing delegation of codex-implementer without a worktree, and says to set use_worktree', () => {
    for (const sandbox of ['workspace-write', 'danger-full-access']) {
      for (const input of [{ prompt: 'x', working_dir: dir, sandbox }, { prompt: 'x', working_dir: dir, sandbox, use_worktree: false }]) {
        const r = call(tool('codex-implementer', 'codex_delegate'), input);
        assert.equal(r.decision, 'deny', JSON.stringify(input));
        assert.match(r.reason, /use_worktree/);
      }
    }
  });

  test('AC-8 gives no verdict for a writing delegation of codex-implementer in a worktree from a clean directory, or a read-only one without', () => {
    passes(call(tool('codex-implementer', 'codex_delegate'), { prompt: 'x', working_dir: dir, sandbox: 'workspace-write', use_worktree: true }), 'worktree');
    passes(call(tool('codex-implementer', 'codex_delegate'), { prompt: 'x', working_dir: dir, sandbox: 'read-only' }), 'read-only');
    passes(call(tool('codex-implementer', 'codex_delegate'), { prompt: 'x', working_dir: dir }), 'no sandbox');
  });

  test('AC-4 allows with a message on stderr when the working directory is not a repository or does not exist', () => {
    const loose = tmp('cw-loose-');
    const missing = join(loose, 'missing');
    for (const [name, input] of [
      [tool('codex-reviewer', 'codex_delegate'), { prompt: 'x', working_dir: loose, use_worktree: true }],
      [tool('codex-implementer', 'codex_delegate'), { prompt: 'x', working_dir: missing, use_worktree: true, sandbox: 'workspace-write' }],
      [tool('codex-implementer', 'codex_follow_up'), { prompt: 'x', thread_id: 't1', working_dir: missing, sandbox: 'workspace-write' }],
    ]) {
      const r = call(name, input);
      passes(r, `${name} ${input.working_dir}`);
      assert.match(r.stderr, /guard-codex/, 'the message names the hook');
      assert.match(r.stderr, /allow/i, 'the message says the call is allowed');
    }
  });
});

// Review finding on #42: a directory inside $CODEX_HOME/worktrees that is not a git worktree, such as the
// empty <id> directory left once a worktree is removed, must not pass silently as a Codex worktree.
describe('guard-codex on a stale Codex worktree directory', () => {
  test('AC-4 allows a writing follow-up of codex-implementer in a directory under worktrees that is not a repository, with a message on stderr', () => {
    const stale = join(codexHome, 'worktrees', 'stale');
    mkdirSync(stale, { recursive: true });
    const r = call(tool('codex-implementer', 'codex_follow_up'), { prompt: 'x', thread_id: 't1', working_dir: stale, sandbox: 'workspace-write' });
    passes(r, stale);
    assert.match(r.stderr, /guard-codex/, 'the message names the hook');
    assert.match(r.stderr, /allow/i, 'the message says the call is allowed');
  });
});

// Second review finding on #42: a standalone repository whose top-level lies inside $CODEX_HOME/worktrees
// is not a Codex worktree, which is a linked worktree; a writing follow-up there must still be denied.
describe('guard-codex on a standalone repository under the worktrees directory', () => {
  test('AC-3 denies a writing follow-up of codex-implementer in a repository made with git init under worktrees', () => {
    const plain = join(codexHome, 'worktrees', 'plain', 'repo');
    mkdirSync(plain, { recursive: true });
    sh(plain, 'init', '-q');
    const r = call(tool('codex-implementer', 'codex_follow_up'), { prompt: 'x', thread_id: 't1', working_dir: plain, sandbox: 'workspace-write' });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /worktree/i);
  });
});
