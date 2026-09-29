// Tests for scripts/install.mjs against a temporary target directory.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const install = (target, ...args) => spawnSync(
  process.execPath,
  [join(repo, 'scripts', 'install.mjs'), '--target', target, ...args],
  { encoding: 'utf8' },
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
    assert.ok(s.permissions.ask.includes('Bash(gh pr merge:*)'));
    const commands = s.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command));
    assert.ok(commands.includes('/usr/local/bin/my-own-hook'), 'a hook the user added is kept');
    assert.equal(commands.filter((c) => c.includes('guard-git.mjs')).length, 1, 'managed hooks are not duplicated');
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
