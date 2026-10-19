// Issue #70, review: cases the oracle did not pin. A literal "<!--" in a code span or a fenced code block
// was read as the start of an HTML comment, hiding the index links after it; the short CommonMark comments
// "<!-->" and "<!--->" hid the rest of the document; and drift-audit had no baseline for a record first
// merged as deprecated, and would report a deprecated import whose base was never accepted.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repo, 'scripts', 'check-adrs.mjs');

const scratch = [];
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

function write(dir, path, content) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

const standard = (title, status) => ['---', `status: ${status}`, 'date: 2026-01-01', '---', `# ${title}`, '', '## Context', '', 'Text.', ''].join('\n');
const entry = (file) => `- [${file.slice(0, 4)}. Title](${file})`;
const index = (...lines) => ['# ADRs', '', ...lines, ''].join('\n');

// A base branch main with records 0001 (accepted) and 0002 (proposed) and an index linking both, and a head
// branch feature/x whose index is the one given.
function check(...lines) {
  const dir = mkdtempSync(join(tmpdir(), 'cw-check-adrs-70-review-'));
  scratch.push(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'Test');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  write(dir, 'docs/adr/0001-a.md', standard('0001. A', 'accepted'));
  write(dir, 'docs/adr/0002-b.md', standard('0002. B', 'proposed'));
  write(dir, 'docs/adr/README.md', index(entry('0001-a.md'), entry('0002-b.md')));
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'docs: base');
  sh(dir, 'checkout', '-q', '-b', 'feature/x');
  write(dir, 'docs/adr/README.md', index(...lines));
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '--allow-empty', '-m', 'docs: head');
  return spawnSync(process.execPath, [script, 'main'], { cwd: dir, encoding: 'utf8' });
}

const passes = (r) => assert.equal(r.status, 0, `expected the check to pass:\n${r.stderr}`);
function fails(r, ...names) {
  assert.notEqual(r.status, 0, 'expected the check to fail');
  for (const name of names) assert.ok(r.stderr.includes(name), `stderr does not name ${name}:\n${r.stderr}`);
}

describe('check-adrs HTML comments, review regressions (#70)', () => {
  test('AC-4 (#70 review) a "<!--" in a code span starts no comment', () => {
    passes(check('Write `<!--` to hide a note.', '', entry('0001-a.md'), entry('0002-b.md')));
  });

  test('AC-4 (#70 review) a "<!--" in a fenced code block starts no comment', () => {
    passes(check('```html', '<!-- a note', '```', '', entry('0001-a.md'), entry('0002-b.md')));
  });

  test('AC-5 (#70 review) a dangling record link after a "<!--" in a code span is still reported', () => {
    fails(check('Write `<!--` to hide a note.', entry('0001-a.md'), entry('0002-b.md'), '- [Ghost](0099-ghost.md)'), '0099-ghost.md');
  });

  for (const marker of ['<!-->', '<!--->']) {
    test(`AC-6 (#70 review) ${marker} is a complete comment and hides nothing after it`, () => {
      passes(check(marker, entry('0001-a.md'), entry('0002-b.md')));
    });
  }

  test('AC-4 (#70 review) a comment after a code span on the same line still hides its link', () => {
    fails(check(entry('0001-a.md'), '`code` <!-- [0002. B](0002-b.md) -->'), '0002-b.md');
  });
});

describe('drift-audit and deprecated imports, review regressions (#70)', () => {
  const text = readFileSync(join(repo, 'global/skills/drift-audit/SKILL.md'), 'utf8');
  const blocks = text.split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.)\s)/).map((block) => block.trim()).filter(Boolean);
  const someBlock = (...patterns) => blocks.some((block) => patterns.every((p) => p.test(block)));

  test('AC-9 (#70 review) the history baseline covers a record first merged as deprecated', () => {
    assert.ok(someBlock(/baseline/i, /\bdeprecated\b/i), 'the baseline rule does not name deprecated');
  });

  test('AC-9 (#70 review) a record that first appears on main as deprecated is not reported as an invalid deprecation', () => {
    assert.ok(someBlock(/\bdeprecated\b/i, /first appear|import/i, /not accepted|whose base/i), 'nothing exempts a deprecated import');
  });
});
