// Issue #50: Claude Code creates its worktrees under .claude/worktrees/, and a broad `git add` in the main
// checkout stages an unignored one as an embedded repository. AC-1 runs git in this repository; the
// user-level excludes are turned off so that only the repository's own rules can satisfy it. AC-2 to
// AC-4 are static checks over the skill text: they prove an affirmative instruction is present in the
// right section, not that a run follows it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(repo, path), 'utf8');

// One record per path from `check-ignore -v --non-matching`: source, line and pattern are empty when no
// rule matches. A pattern that starts with `!` re-includes the path, so it does not ignore it.
function checkIgnore(paths) {
  const result = spawnSync(
    'git',
    ['-c', 'core.excludesFile=/dev/null', 'check-ignore', '--no-index', '-v', '--non-matching', '--', ...paths],
    { cwd: repo, encoding: 'utf8' },
  );
  assert.ok(result.status === 0 || result.status === 1, `git check-ignore failed: ${result.stderr}`);
  return result.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [, source, number, pattern, path] = /^(.*?):(\d*):(.*)\t(.*)$/.exec(line) ?? [];
    return { source, number, pattern, path, ignores: Boolean(pattern) && !pattern.startsWith('!') };
  });
}

// The text of the `## <heading>` section, with or without a number before the heading.
function section(text, heading) {
  const parts = text.split(/^## /m);
  const found = parts.find((part) => new RegExp(`^(\\d+\\.\\s+)?${heading}\\s*$`, 'm').test(part.split('\n')[0]));
  assert.ok(found, `no "${heading}" section`);
  return found;
}

// Top-level bullets of a section, each joined with its continuation lines.
function bullets(text) {
  const items = [];
  for (const line of text.split('\n')) {
    if (/^- /.test(line)) items.push(line);
    else if (items.length && /^\s+\S/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
    else if (!line.trim() || /^\S/.test(line)) items.push(null);
  }
  return items.filter(Boolean);
}

const sentences = (text) => text.split(/(?<=[.;:])\s+/);
const WORKTREES = /`\.claude\/worktrees\/?`/;

describe('worktree ignore in this repository', () => {
  test('AC-1 paths under .claude/worktrees/ are ignored by the root .gitignore', () => {
    const paths = [
      '.claude/worktrees/agent-a1b2c3',
      '.claude/worktrees/agent-d4e5f6/package.json',
      '.claude/worktrees/bright-running-fox/src/deep/file.mjs',
      '.claude/worktrees/pr-123/README.md',
    ];
    const records = checkIgnore(paths);
    assert.deepEqual(records.map((r) => r.path), paths, 'check-ignore did not report every path');
    for (const record of records) {
      assert.ok(record.ignores, `${record.path} is not ignored`);
      assert.equal(record.source, '.gitignore', `${record.path} is ignored by ${record.source}, not the root .gitignore`);
    }
  });

  // A guard against a rule that is too broad, such as `.claude/`: it passes before the change too.
  test("AC-1 settings, skills, agents and rules under .claude/ are not ignored by the repository's rules", () => {
    const paths = ['.claude/settings.json', '.claude/skills/x/SKILL.md', '.claude/agents/x.md', '.claude/rules/x.md'];
    const records = checkIgnore(paths);
    assert.deepEqual(records.map((r) => r.path), paths, 'check-ignore did not report every path');
    for (const record of records) {
      const fromGitignore = record.source === '.gitignore' || record.source.endsWith('/.gitignore');
      assert.ok(!(record.ignores && fromGitignore), `${record.path} is ignored by ${record.source}:${record.number} ${record.pattern}`);
    }
  });
});

describe('worktree ignore in the skills', () => {
  test('AC-2 repo-bootstrap creates or completes the root .gitignore with .claude/worktrees/ in both modes', () => {
    const text = section(read('global/skills/repo-bootstrap/SKILL.md'), 'Repository files');
    const bullet = bullets(text).find((b) => b.includes('.gitignore') && WORKTREES.test(b));
    assert.ok(bullet, 'no bullet in "Repository files" names .gitignore and .claude/worktrees/');
    assert.ok(
      sentences(bullet).some((s) => WORKTREES.test(s) && /\b(add|ensure|include)/i.test(s)),
      'no sentence affirmatively adds .claude/worktrees/',
    );
    assert.match(bullet, /both modes|new and integrate|integrate and new/i, 'the bullet does not cover both modes');
    assert.match(bullet, /creat/i, 'the bullet does not create a missing .gitignore');
    assert.match(bullet, /\b(missing|absent)\b|no `\.gitignore`/i, 'the bullet does not handle a missing .gitignore');
    assert.match(bullet, /\bonce\b|duplicat/i, 'the bullet does not prevent a duplicate entry');
    assert.match(bullet, /\b(keep|preserv)/i, 'the bullet does not keep the existing entries');
    assert.match(bullet, /rest of `?\.claude\/?`?|whole `?\.claude\/?`?/i, 'the bullet does not keep the rest of .claude/ unignored');
  });

  test('AC-3 drift-audit reports a missing or ineffective .claude/worktrees/ ignore, judged by git check-ignore', () => {
    const text = section(read('global/skills/drift-audit/SKILL.md'), 'Conventions and enforcement');
    const bullet = bullets(text).find((b) => WORKTREES.test(b) && b.includes('check-ignore'));
    assert.ok(bullet, 'no bullet in "Conventions and enforcement" checks .claude/worktrees/ with git check-ignore');
    assert.match(bullet, /git check-ignore[^`]*--no-index/, 'the check does not use --no-index');
    assert.match(bullet, /\breport/i, 'the bullet does not report');
    assert.match(bullet, /\b(missing|absent)\b/i, 'the bullet does not cover a missing .gitignore');
    assert.match(bullet, /equivalent/i, 'the bullet does not accept an equivalent pattern');
    assert.match(bullet, /user-level|global/i, 'the bullet does not set the user-level excludes aside');
    assert.match(bullet, /info\/exclude/, 'the bullet does not set .git/info/exclude aside');
    assert.match(bullet, /(do not|does not|don't|never) count/i, 'the bullet does not say which sources do not count');
  });

  test('AC-4 drift-audit reports tracked paths under .claude/worktrees/', () => {
    const text = section(read('global/skills/drift-audit/SKILL.md'), 'Conventions and enforcement');
    const bullet = bullets(text).find((b) => /git ls-files \.claude\/worktrees/.test(b));
    assert.ok(bullet, 'no bullet in "Conventions and enforcement" runs git ls-files .claude/worktrees');
    assert.match(bullet, /\breport/i, 'the bullet does not report the tracked paths');
    assert.match(bullet, /track/i, 'the bullet does not say an ignore rule leaves them tracked');
  });
});
