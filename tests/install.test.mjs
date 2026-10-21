// Tests for scripts/install.mjs against a temporary target directory.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeClaude } from './fake-claude.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
// The installer registers MCP servers through `claude` (ADR 0014); a fake one stands in for it, so the
// tests neither need the CLI nor touch a real configuration.
const claudeDir = mkdtempSync(join(tmpdir(), 'cw-install-claude-'));
const fake = fakeClaude(claudeDir);
after(() => rmSync(claudeDir, { recursive: true, force: true }));
const install = (target, ...args) => spawnSync(
  process.execPath,
  [join(repo, 'scripts', 'install.mjs'), '--target', target, ...args],
  { encoding: 'utf8', env: { ...process.env, ...fake.env() } },
);
const settingsOf = (target) => JSON.parse(readFileSync(join(target, 'settings.json'), 'utf8'));

describe('install', () => {
  let target;
  before(() => {
    target = mkdtempSync(join(tmpdir(), 'cw-install-'));
    writeFileSync(join(target, 'settings.json'), JSON.stringify({
      theme: 'dark',
      permissions: { allow: ['Bash(make:*)'] },
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$HOME/.claude/hooks/guard-git.mjs"' }] },
          { matcher: 'Write', hooks: [{ type: 'command', command: '/usr/local/bin/my-own-hook' }] },
        ],
      },
    }));
  });
  after(() => rmSync(target, { recursive: true, force: true }));

  test('reports drift before installing', () => {
    const r = install(target, '--check');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /differs or missing: CLAUDE\.md/);
    assert.equal(existsSync(join(target, 'CLAUDE.md')), false, 'check must not write');
  });

  test('installs global files, skills and templates', () => {
    const r = install(target);
    assert.equal(r.status, 0, r.stderr);
    for (const f of [
      'CLAUDE.md',
      'hooks/guard-git.mjs',
      'hooks/oracle-check.mjs',
      'skills/atdd-oracle/SKILL.md',
      'skills/repo-bootstrap/templates/common/github/rulesets/main.json',
      'skills/repo-bootstrap/templates/supabase/stack.md',
    ]) assert.ok(existsSync(join(target, f)), f);
    const personal = existsSync(join(repo, 'personal', 'preferences.md'));
    assert.equal(existsSync(join(target, 'rules/personal.md')), personal);
  });

  test('merges settings without losing what was already there', () => {
    const s = settingsOf(target);
    assert.equal(s.theme, 'dark');
    assert.equal(s.includeGitInstructions, false);
    assert.ok(s.permissions.allow.includes('Bash(make:*)'));
    assert.ok(s.permissions.allow.includes('Bash(git status:*)'));
    assert.ok(!(s.permissions.ask ?? []).includes('Bash(gh pr merge:*)'), 'the merge decision moved to guard-git (ADR 0010)');
    const commands = s.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command));
    assert.ok(commands.includes('/usr/local/bin/my-own-hook'), 'a hook the user added is kept');
    const shipped = JSON.parse(readFileSync(join(repo, 'global', 'settings.json'), 'utf8'));
    const guardGit = shipped.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command)).filter((c) => c.includes('guard-git.mjs'));
    assert.deepEqual(commands.filter((c) => c.includes('guard-git.mjs')), guardGit, 'managed hooks are not duplicated');
  });

  test('is idempotent', () => {
    const r = install(target, '--check');
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /matches the repository/);
  });

  test('detects and repairs a local edit, keeping a backup', () => {
    writeFileSync(join(target, 'CLAUDE.md'), 'edited\n');
    assert.equal(install(target, '--check').status, 1);
    const r = install(target);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Backed up/);
    assert.equal(readFileSync(join(target, 'CLAUDE.md'), 'utf8'), readFileSync(join(repo, 'global', 'CLAUDE.md'), 'utf8'));
  });

  test('removes files it installed and no longer ships', () => {
    const manifest = join(target, '.claude-workflow-manifest.json');
    const m = JSON.parse(readFileSync(manifest, 'utf8'));
    m.files.push('skills/retired/SKILL.md');
    writeFileSync(manifest, JSON.stringify(m));
    writeFileSync(join(target, 'skills', 'atdd-oracle', 'extra.md'), 'not ours\n');
    const retired = join(target, 'skills', 'retired');
    spawnSync('mkdir', ['-p', retired]);
    writeFileSync(join(retired, 'SKILL.md'), 'old\n');
    const r = install(target);
    assert.equal(r.status, 0);
    assert.equal(existsSync(join(retired, 'SKILL.md')), false);
    assert.ok(existsSync(join(target, 'skills', 'atdd-oracle', 'extra.md')), 'files it never installed are left alone');
  });
});

// Issue #7 (ADR 0010): the ask on `gh pr merge` leaves the shipped settings, and
// the installer can retire a permission rule it installed in the past.
describe('install permissions', () => {
  const OLD_ASK = 'Bash(gh pr merge:*)';
  const seeded = (permissions) => {
    const target = mkdtempSync(join(tmpdir(), 'cw-perms-'));
    writeFileSync(join(target, 'settings.json'), JSON.stringify({ permissions }));
    return target;
  };

  test('AC-7 ships no ask rule for gh pr merge', () => {
    const shipped = JSON.parse(readFileSync(join(repo, 'global', 'settings.json'), 'utf8'));
    assert.ok(!(shipped.permissions?.ask ?? []).includes(OLD_ASK));
  });

  test('AC-7 retires the rule an earlier install left in settings.json', () => {
    const target = seeded({ ask: [OLD_ASK, 'Bash(mine:*)'], allow: ['Bash(keep:*)'] });
    const r = install(target);
    assert.equal(r.status, 0, r.stderr);
    const s = settingsOf(target);
    assert.deepEqual(s.permissions.ask, ['Bash(mine:*)']);
    assert.ok(s.permissions.allow.includes('Bash(keep:*)'));
    rmSync(target, { recursive: true, force: true });
  });

  describe('with a retired-permissions file', () => {
    let fake;
    const installFake = (target, ...args) => spawnSync(
      process.execPath,
      [join(fake, 'scripts', 'install.mjs'), '--target', target, ...args],
      { encoding: 'utf8' },
    );
    before(() => {
      fake = mkdtempSync(join(tmpdir(), 'cw-fake-repo-'));
      mkdirSync(join(fake, 'scripts'));
      mkdirSync(join(fake, 'global'));
      copyFileSync(join(repo, 'scripts', 'install.mjs'), join(fake, 'scripts', 'install.mjs'));
      writeFileSync(join(fake, 'global', 'CLAUDE.md'), 'x\n');
      writeFileSync(join(fake, 'global', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(a:*)'] } }));
      writeFileSync(join(fake, 'global', 'retired-permissions.json'), JSON.stringify({
        ask: [OLD_ASK],
        allow: ['Bash(old:*)'],
      }));
    });
    after(() => rmSync(fake, { recursive: true, force: true }));

    test('AC-8 removes a retired rule from every list and keeps the rules the user added', () => {
      const target = seeded({ ask: [OLD_ASK, 'Bash(mine:*)'], allow: ['Bash(old:*)', 'Bash(keep:*)'] });
      const r = installFake(target);
      assert.equal(r.status, 0, r.stderr);
      const s = settingsOf(target);
      assert.deepEqual(s.permissions.ask, ['Bash(mine:*)']);
      assert.ok(s.permissions.allow.includes('Bash(keep:*)'));
      assert.ok(s.permissions.allow.includes('Bash(a:*)'));
      assert.ok(!s.permissions.allow.includes('Bash(old:*)'));
      rmSync(target, { recursive: true, force: true });
    });

    test('AC-8 reports a retired rule that is still installed as drift, and stops once it is gone', () => {
      const target = seeded({ ask: [OLD_ASK] });
      const before = installFake(target, '--check');
      assert.equal(before.status, 1);
      assert.match(before.stdout, /retired/i);
      assert.equal(installFake(target).status, 0);
      assert.equal(installFake(target, '--check').status, 0);
      rmSync(target, { recursive: true, force: true });
    });
  });
});

// Issue #57 (ADR 0017): a Bash result above the bound arrives as a file path plus a preview, and task-package
// ships its Codex and worktree rules as files beside the skill.
describe('install (#57)', () => {
  let target;
  before(() => {
    target = mkdtempSync(join(tmpdir(), 'cw-install-57-'));
    const r = install(target);
    assert.equal(r.status, 0, r.stderr);
  });
  after(() => rmSync(target, { recursive: true, force: true }));

  test('AC-1 (#57) an install sets bashOutputMaxChars to 12000', () => {
    assert.equal(settingsOf(target).bashOutputMaxChars, 12000);
  });

  test('AC-5 (#57) an install copies codex.md and worktree.md beside the task-package skill', () => {
    for (const f of ['skills/task-package/SKILL.md', 'skills/task-package/codex.md', 'skills/task-package/worktree.md']) {
      assert.ok(existsSync(join(target, f)), f);
    }
  });
});

// Issue #27: an install moves the merge decision to an entry of its own that blocks the call when the hook
// fails, and keeps only the editing tools Claude Code has in the test guard's matcher.
describe('install (#27)', () => {
  let target;
  before(() => {
    target = mkdtempSync(join(tmpdir(), 'cw-install-27-'));
    writeFileSync(join(target, 'settings.json'), JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$HOME/.claude/hooks/guard-git.mjs"', timeout: 15 }] },
          { matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: 'node "$HOME/.claude/hooks/guard-tests.mjs"', timeout: 15 }] },
        ],
      },
    }));
    const r = install(target);
    assert.equal(r.status, 0, r.stderr);
  });
  after(() => rmSync(target, { recursive: true, force: true }));

  const handlers = (script) => settingsOf(target).hooks.PreToolUse
    .flatMap((entry) => entry.hooks.map((hook) => ({ matcher: entry.matcher, ...hook })))
    .filter((hook) => hook.command.includes(script));

  test('AC-1 (#27) an install replaces the single guard-git entry with a general one and a merge one that blocks when it fails', () => {
    assert.deepEqual(handlers('guard-git.mjs').map((h) => [h.matcher, h.command.split(' ').pop(), h.if, h.onFailure]), [
      ['Bash', '--skip-merge', undefined, undefined],
      ['Bash', '--merge-only', 'Bash(gh pr merge *)', 'block'],
    ]);
  });

  test('AC-6 (#27) an install leaves the test guard matching Edit, Write and NotebookEdit', () => {
    assert.deepEqual(handlers('guard-tests.mjs').map((h) => h.matcher), ['Edit|Write|NotebookEdit']);
  });
});
