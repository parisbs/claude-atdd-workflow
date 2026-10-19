// Issue #66, review of the first implementation: cases the frozen oracle did not pin. The check compared
// records after decoding them as UTF-8, so a changed invalid byte in a frozen record went unseen; an empty
// status counted as a status; valid inline links with a title, angle brackets or a protocol-relative URL
// broke the index check; a value with a Unicode line separator was written by the migration script in a form
// the check did not read; and repo-bootstrap installed the check without an index linking every record.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const checkAdrs = join(repo, 'scripts', 'check-adrs.mjs');
const migrate = join(repo, 'scripts', 'migrate-adrs.mjs');

const scratch = [];
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function write(dir, path, content) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

const BODY = ['', '## Context', '', 'Original context.', ''];
const standard = (title, status) => ['---', `status: ${status}`, 'date: 2026-01-01', '---', `# ${title}`, ...BODY].join('\n');
const entry = (file) => `- [${file.slice(0, 4)}. Title](${file})`;

// A base branch main with the records given and an index linking each, and a head branch feature/x.
function fixture(records) {
  const dir = mkdtempSync(join(tmpdir(), 'cw-check-adrs-madr-review-'));
  scratch.push(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'Test');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  for (const [file, content] of Object.entries(records)) write(dir, `docs/adr/${file}`, content);
  write(dir, 'docs/adr/README.md', ['# ADRs', '', ...Object.keys(records).map(entry), ''].join('\n'));
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'docs: base');
  sh(dir, 'checkout', '-q', '-b', 'feature/x');
  return dir;
}

function check(dir) {
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '--allow-empty', '-m', 'docs: head');
  return spawnSync(process.execPath, [checkAdrs, 'main'], { cwd: dir, encoding: 'utf8' });
}

const passes = (r) => assert.equal(r.status, 0, `expected the check to pass:\n${r.stderr}`);
function fails(r, ...names) {
  assert.notEqual(r.status, 0, 'expected the check to fail');
  for (const name of names) assert.ok(r.stderr.includes(name), `stderr does not name ${name}:\n${r.stderr}`);
}

const index = (...lines) => ['# ADRs', '', ...lines, ''].join('\n');
const two = () => ({ '0001-a.md': standard('0001. A', 'accepted'), '0002-b.md': standard('0002. B', 'proposed') });

describe('check-adrs review regressions (#66)', () => {
  test('AC-8 (#66 review) fails when an invalid UTF-8 byte of a frozen record changes', () => {
    // "Original context." becomes "Caf" and a Latin-1 é (0xE9), which is not valid UTF-8; the head writes è.
    const base = Buffer.concat([Buffer.from(`${standard('0001. A', 'accepted').replace('Original context.\n', 'Caf')}`), Buffer.from([0xe9, 0x0a])]);
    const dir = fixture({ '0001-a.md': base });
    base[base.length - 2] = 0xe8;
    write(dir, 'docs/adr/0001-a.md', base);
    fails(check(dir), 'docs/adr/0001-a.md');
  });

  for (const status of ['', '""', "''"]) {
    test(`AC-2 (#66 review) fails on an added record whose status is empty (status: ${status})`, () => {
      const dir = fixture({ '0001-a.md': standard('0001. A', 'accepted') });
      write(dir, 'docs/adr/0002-new.md', standard('0002. New', status).replace('status: \n', 'status:\n'));
      write(dir, 'docs/adr/README.md', index(entry('0001-a.md'), entry('0002-new.md')));
      fails(check(dir), 'docs/adr/0002-new.md');
    });
  }

  test('AC-7 (#66 review) reads inline links with a title or in angle brackets', () => {
    const dir = fixture(two());
    write(dir, 'docs/adr/README.md', index('- [A](0001-a.md "The first record")', "- [B](<0002-b.md> 'The second')"));
    passes(check(dir));
  });

  test('AC-7 (#66 review) fails on a titled link to a record-named file that does not exist, naming it', () => {
    const dir = fixture(two());
    write(dir, 'docs/adr/README.md', `${readFileSync(join(dir, 'docs/adr/README.md'), 'utf8')}- [Ghost](0099-ghost.md "Ghost")\n`);
    fails(check(dir), '0099-ghost.md');
  });

  test('AC-7 (#66 review) ignores a protocol-relative link to an external page', () => {
    const dir = fixture(two());
    write(dir, 'docs/adr/README.md', `${readFileSync(join(dir, 'docs/adr/README.md'), 'utf8')}- [Elsewhere](//example.com/0009-z.md)\n`);
    passes(check(dir));
  });

  test('AC-7 (#66 review) resolves a link that starts with / from the repository root, as GitHub does', () => {
    const dir = fixture(two());
    write(dir, 'docs/adr/README.md', index(entry('0001-a.md'), '- [B](/docs/adr/0002-b.md)'));
    passes(check(dir));
  });

  test('AC-9 (#66 review) a status with a Unicode line separator migrates into a form the check admits', () => {
    const dir = fixture({ '0001-a.md': ['# 0001. A', '', '- Status: accepted amended', '- Date: 2026-01-01', ...BODY].join('\n') });
    const base = sh(dir, 'rev-parse', 'HEAD');
    const r = spawnSync(process.execPath, [migrate], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-q', '-m', 'docs: migrate');
    const c = spawnSync(process.execPath, [checkAdrs, base], { cwd: dir, encoding: 'utf8' });
    assert.equal(c.status, 0, c.stderr);
  });

  test('AC-10 (#66 review) the migration script names an unclosed front matter as unclosed', () => {
    const dir = fixture({ '0001-a.md': ['---', 'status: accepted', '# 0001. A', ...BODY].join('\n') });
    const r = spawnSync(process.execPath, [migrate], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /docs\/adr\/0001-a\.md.*(?:not closed|unclosed)/);
  });
});

describe('repo-bootstrap review regressions (#66)', () => {
  const read = (path) => readFileSync(join(repo, path), 'utf8');
  const blocks = (text) => text.split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.)\s)/).map((block) => block.trim()).filter(Boolean);
  const someBlock = (text, ...patterns) => blocks(text).some((block) => patterns.every((p) => p.test(block)));

  test('AC-17 (#66 review) repo-bootstrap requires an index linking every record before installing the check', () => {
    assert.ok(someBlock(read('global/skills/repo-bootstrap/SKILL.md'), /README\.md|index/i, /every record/i, /check-adrs|Check ADRs/));
  });

  test('AC-17 (#66 review) repo-bootstrap runs the template copy of the check over the migration before it merges', () => {
    assert.ok(someBlock(read('global/skills/repo-bootstrap/SKILL.md'), /migrat/i, /templates\/common\/scripts\/check-adrs\.mjs/));
  });

  test('AC-14 (#66 review) the CLAUDE.md template does not claim CI verifies a migration that runs before the check exists', () => {
    assert.doesNotMatch(read('common/CLAUDE.md.template'), /verifies it in CI\./);
  });
});
