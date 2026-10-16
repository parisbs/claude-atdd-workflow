// Issue #28, review of the first implementation: cases the frozen oracle in check-adrs.test.mjs did not
// pin. The check ran from a subdirectory matched no record and passed; a status word glued to more text
// (proposed-x) read as proposed, so editable; and a duplicate number hid the number it skipped.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-adrs.mjs');

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

// "Original context." is on line 8.
const record = (number, status) =>
  [`# ${number}. Title`, '', `- Status: ${status}`, '- Date: 2026-01-01', '', '## Context', '', 'Original context.', ''].join('\n');
const entry = (file) => `- [${file.slice(0, 4)}. Title](${file})\n`;

// A base main with 0001 accepted and 0002 marked proposed-x, and a head branch feature/x.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cw-check-adrs-review-'));
  scratch.push(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'Test');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  write(dir, 'docs/adr/0001-a.md', record('0001', 'accepted'));
  write(dir, 'docs/adr/0002-b.md', record('0002', 'proposed-x'));
  write(dir, 'docs/adr/README.md', `# ADRs\n\n${entry('0001-a.md')}${entry('0002-b.md')}`);
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'docs: base');
  sh(dir, 'checkout', '-q', '-b', 'feature/x');
  return dir;
}

function replace(dir, path, from, to) {
  const text = readFileSync(join(dir, path), 'utf8');
  assert.ok(text.includes(from), `${path} does not contain ${from}`);
  write(dir, path, text.replace(from, to));
}

function check(dir, cwd = dir) {
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '--allow-empty', '-m', 'docs: head');
  return spawnSync(process.execPath, [script, 'main'], { cwd, encoding: 'utf8' });
}

function fails(r, ...names) {
  assert.notEqual(r.status, 0, 'expected the check to fail');
  for (const name of names) assert.ok(r.stderr.includes(name), `stderr does not name ${name}:\n${r.stderr}`);
}

describe('check-adrs review regressions (#28)', () => {
  test('AC-1 (#28 review) still fails on a frozen body edit when run from a subdirectory', () => {
    const dir = fixture();
    replace(dir, 'docs/adr/0001-a.md', 'Original context.', 'Rewritten context.');
    fails(check(dir, join(dir, 'docs')), 'docs/adr/0001-a.md:8');
  });

  test('AC-2 (#28 review) a status word glued to more text is unrecognised, so the record is frozen', () => {
    const dir = fixture();
    replace(dir, 'docs/adr/0002-b.md', 'Original context.', 'Rewritten context.');
    fails(check(dir), 'docs/adr/0002-b.md:8');
  });

  test('AC-5 (#28 review) a decided status cannot become a glued word that starts with it', () => {
    const dir = fixture();
    replace(dir, 'docs/adr/0001-a.md', '- Status: accepted\n', '- Status: accepted-not\n');
    fails(check(dir), 'docs/adr/0001-a.md', 'accepted-not');
  });

  test('AC-8 (#28 review) names the record out of sequence after a duplicate', () => {
    const dir = fixture();
    for (const file of ['0003-c.md', '0003-d.md', '0005-e.md']) {
      write(dir, `docs/adr/${file}`, record(file.slice(0, 4), 'proposed'));
      replace(dir, 'docs/adr/README.md', '# ADRs\n\n', `# ADRs\n\n${entry(file)}`);
    }
    fails(check(dir), '0005');
  });
});
