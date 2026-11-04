// Issue #84: executable defaults and activation controls for both real hooks.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { HOOKS } from './claude-hooks.mjs';
import { fixture, POSIX } from './guard-git-fixture.mjs';
import { hookBudget } from './hook-budget.mjs';

describe('hook budget seam (#84)', { skip: POSIX }, () => {
  let fx, repo, installed, withoutMarker;
  before(() => {
    fx = fixture();
    repo = fx.repository();
    mkdirSync(join(repo.dir, 'tests'));
    writeFileSync(join(repo.dir, 'tests/a.test.mjs'), '// frozen\n');
    fx.git(repo.dir, 'add', '.');
    fx.git(repo.dir, 'commit', '-qm', 'test: freeze budget fixture');
    fx.git(repo.dir, 'tag', 'oracle/feature/work');
    installed = join(fx.home, '.claude/hooks');
    mkdirSync(installed, { recursive: true });
    cpSync(HOOKS, installed, { recursive: true });
    withoutMarker = join(fx.scratch, 'without-tests');
    mkdirSync(join(withoutMarker, 'global/hooks'), { recursive: true });
    cpSync(HOOKS, join(withoutMarker, 'global/hooks'), { recursive: true });
  });
  after(() => fx?.close());

  function run(hook, { mode, env = {}, hooks = HOOKS, command } = {}) {
    const event = { cwd: repo.dir, tool_name: 'Bash', permission_mode: 'default',
      tool_input: { command: command ?? (hook === 'guard-git' ? 'git status' : 'rm tests/a.test.mjs') } };
    const r = spawnSync(process.execPath, [join(hooks, `${hook}.mjs`), ...(mode ? [mode] : [])], {
      cwd: repo.dir, input: JSON.stringify(event), encoding: 'utf8', timeout: 120000,
      env: { ...process.env, ...fx.env,
        CW_HOOK_BUDGET_TEST: undefined, CW_HOOK_BUDGET_CONFIG: undefined,
        GUARD_TESTS_GIT_BUDGET_MS: undefined, GUARD_TESTS_GIT_TIMEOUT_MS: undefined,
        GUARD_TESTS_CPU_BUDGET_MS: undefined, ...env },
    });
    assert.equal(r.status, 0, r.error?.message ?? r.stderr);
    return { ...r, out: r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : {} };
  }

  for (const mode of ['', '--skip-merge', '--merge-only']) {
    test(`AC-3 (#84) guard-git defaults are unchanged in ${mode || 'combined mode'}`, () => {
      const budget = hookBudget();
      run('guard-git', { mode, env: budget.env });
      const [limits] = budget.active('guard-git').filter((event) => event.type === 'limits');
      assert.equal(limits.mode, mode);
      assert.deepEqual(limits.values, { decisionMs: 10000, ghBudgetMs: 10000, ghTimeoutMs: 6000,
        processMs: mode === '--skip-merge' ? 12000 : 27000,
        localWorkMs: 5000, oracleDiscoveryMs: 5000, oracleComparisonMs: 5000, sshConfigMs: 5000 });
    });
  }
  for (const override of [undefined, '20000']) {
    test(`AC-3 (#84) guard-tests defaults and 10000 ms cap with override ${override ?? 'unset'}`, () => {
      const budget = hookBudget();
      run('guard-tests', { env: { ...budget.env, GUARD_TESTS_GIT_BUDGET_MS: override } });
      const [limits] = budget.active('guard-tests').filter((event) => event.type === 'limits');
      assert.deepEqual(limits.values, { gitBudgetMs: 10000, gitTimeoutMs: 5000, cpuBudgetMs: 8000, graceMs: 2000 });
    });
  }

  for (const hook of ['guard-git', 'guard-tests']) {
    for (const variant of ['no variables', 'stray 1', 'stray true', 'config alone', 'token alone', 'unreadable config', 'relative config', 'malformed config', 'unsupported version', 'invalid steps', 'invalid CPU tick', 'relative trace', 'wrong root', 'missing checkout marker', 'installed copy']) {
      test(`AC-4 (#84) ${hook} ignores ${variant}`, () => {
        const budget = hookBudget({ cpuStepUs: 8000000,
          steps: [{ program: 'git', args: ['branch', '--show-current'], occurrence: 1, elapsedMs: 10000 }] });
        let env = { ...budget.env };
        if (variant === 'no variables') env = {};
        if (variant === 'stray 1') env.CW_HOOK_BUDGET_TEST = '1';
        if (variant === 'stray true') env.CW_HOOK_BUDGET_TEST = 'true';
        if (variant === 'config alone') delete env.CW_HOOK_BUDGET_TEST;
        if (variant === 'token alone') delete env.CW_HOOK_BUDGET_CONFIG;
        if (variant === 'unreadable config') env.CW_HOOK_BUDGET_CONFIG = join(fx.scratch, 'missing.json');
        if (variant === 'relative config') env.CW_HOOK_BUDGET_CONFIG = 'missing.json';
        if (variant === 'malformed config') writeFileSync(budget.config, '{');
        if (['unsupported version', 'invalid steps', 'invalid CPU tick', 'relative trace', 'wrong root', 'missing checkout marker'].includes(variant)) {
          const config = JSON.parse(readFileSync(budget.config, 'utf8'));
          if (variant === 'unsupported version') config.version = 2;
          if (variant === 'invalid steps') config.steps = [{ program: 'git', args: ['branch'], occurrence: 0, elapsedMs: -1 }];
          if (variant === 'invalid CPU tick') config.cpuStepUs = -1;
          if (variant === 'relative trace') config.trace = 'trace.jsonl';
          if (variant === 'wrong root') config.root = fx.scratch;
          if (variant === 'missing checkout marker') config.root = withoutMarker;
          writeFileSync(budget.config, JSON.stringify(config));
        }
        const hooks = variant === 'installed copy' ? installed
          : variant === 'missing checkout marker' ? join(withoutMarker, 'global/hooks') : HOOKS;
        const r = run(hook, { env, hooks });
        assert.equal(r.stderr, '', 'rejected activation must preserve ordinary production behavior');
        if (hook === 'guard-git') assert.equal(r.stdout, '');
        else {
          assert.equal(r.out.permissionDecision, 'ask');
          assert.match(r.out.permissionDecisionReason, /^tests\/a\.test\.mjs would be deleted/);
          assert.doesNotMatch(r.out.permissionDecisionReason, /Unread command/);
        }
        assert.equal(existsSync(budget.trace), false, 'rejected activation must not create a trace');
      });
    }
    test(`AC-4 (#84) ${hook} accepts only the explicit checkout configuration`, () => {
      const budget = hookBudget({ cpuStepUs: 8000000,
        steps: [{ program: 'git', args: ['branch', '--show-current'], occurrence: 1, elapsedMs: 10000 }] });
      const r = run(hook, { env: budget.env });
      budget.active(hook);
      assert.match(r.stderr, /budget/i, 'the accepted configuration must exhaust the deciding budget');
      if (hook === 'guard-git') assert.equal(r.stdout, '');
      else {
        assert.equal(r.out.permissionDecision, 'ask');
        assert.match(r.out.permissionDecisionReason, /Unread command at the frozen tests gate:/);
      }
    });
  }
});
