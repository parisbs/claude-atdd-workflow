// Issue #70 (ADR 0021): an added record needs a status word the check recognises, because a record merged
// with an unrecognised status is frozen and can never become a draft again; and links inside HTML comments
// do not index a record, because the rendered index does not show them. Each case builds a real repository
// with a base branch main and a head branch feature/x, as the tests of #66 do. The static checks at the end
// read this repository. That this repository's records pass the check against main (AC-7) is checked by the
// Check ADRs job of the pull request, since the test job's clone has no main.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { frontStatus } from './front-matter.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repo, 'scripts', 'check-adrs.mjs');

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
const index = (...lines) => ['# ADRs', '', ...lines, ''].join('\n');

// A base branch main with the records given and an index linking each, and a head branch feature/x.
function fixture(records) {
  const dir = mkdtempSync(join(tmpdir(), 'cw-check-adrs-70-'));
  scratch.push(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'Test');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  for (const [file, text] of Object.entries(records)) write(dir, `docs/adr/${file}`, text);
  write(dir, 'docs/adr/README.md', index(...Object.keys(records).map(entry)));
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'docs: base');
  sh(dir, 'checkout', '-q', '-b', 'feature/x');
  return dir;
}

function check(dir) {
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '--allow-empty', '-m', 'docs: head');
  return spawnSync(process.execPath, [script, 'main'], { cwd: dir, encoding: 'utf8' });
}

const passes = (r) => assert.equal(r.status, 0, `expected the check to pass:\n${r.stderr}`);
function fails(r, ...names) {
  assert.notEqual(r.status, 0, 'expected the check to fail');
  for (const name of names) assert.ok(r.stderr.includes(name), `stderr does not name ${name}:\n${r.stderr}`);
}

const one = () => ({ '0001-a.md': standard('0001. A', 'accepted') });
const two = () => ({ '0001-a.md': standard('0001. A', 'accepted'), '0002-b.md': standard('0002. B', 'proposed') });

function addRecord(dir, status) {
  write(dir, 'docs/adr/0002-new.md', standard('0002. New', status));
  write(dir, 'docs/adr/README.md', index(entry('0001-a.md'), entry('0002-new.md')));
}

describe('check-adrs added statuses and HTML comments (#70)', () => {
  describe('AC-1 (#70) an added record with an unrecognised status word fails', () => {
    for (const [status, shown] of [
      ['"{proposed | rejected | accepted | deprecated | … | superseded by ADR-0123}"', '{proposed'],
      ['banana', 'banana'],
      ['Approved', 'Approved'],
      ['proposed-x', 'proposed-x'],
      ['~', '~'],
    ]) {
      test(`AC-1 (#70) fails on an added record with status ${status}, naming the file and the status`, () => {
        const dir = fixture(one());
        addRecord(dir, status);
        fails(check(dir), 'docs/adr/0002-new.md', shown);
      });
    }
  });

  describe('AC-2 (#70) an added record with a recognised status word passes', () => {
    for (const status of ['proposed', 'Accepted', 'REJECTED', 'superseded by [0001](0001-a.md)', 'deprecated, see [0001](0001-a.md)', '"accepted, amended by 0001"']) {
      test(`AC-2 (#70) passes on an added record with status ${status}`, () => {
        const dir = fixture(one());
        addRecord(dir, status);
        passes(check(dir));
      });
    }
  });

  describe('AC-3 (#70) a base record with an unrecognised status keeps its handling', () => {
    test('AC-3 (#70) an unrecognised base status may still be normalised to accepted', () => {
      const dir = fixture({ '0001-a.md': standard('0001. A', 'Approved') });
      write(dir, 'docs/adr/0001-a.md', standard('0001. A', 'accepted'));
      passes(check(dir));
    });

    test('AC-3 (#70) a base record with an unrecognised status is still frozen', () => {
      const dir = fixture({ '0001-a.md': standard('0001. A', 'Approved') });
      write(dir, 'docs/adr/0001-a.md', standard('0001. A', 'Approved').replace('Original context.', 'Rewritten context.'));
      fails(check(dir), 'docs/adr/0001-a.md');
    });
  });

  describe('AC-4 (#70) a link inside an HTML comment does not index a record', () => {
    for (const [name, lines] of [
      ['a one-line comment', [entry('0001-a.md'), `<!-- ${entry('0002-b.md')} -->`]],
      ['a comment across lines', [entry('0001-a.md'), '<!--', entry('0002-b.md'), '-->']],
      ['a comment after a link on the same line', [`${entry('0001-a.md')} <!-- [0002](0002-b.md) -->`]],
    ]) {
      test(`AC-4 (#70) fails when the only link to a record is in ${name}, naming the record`, () => {
        const dir = fixture(two());
        write(dir, 'docs/adr/README.md', index(...lines));
        fails(check(dir), '0002-b.md');
      });
    }

    test('AC-4 (#70) a link after a closed comment on the same line still indexes the record', () => {
      const dir = fixture(two());
      write(dir, 'docs/adr/README.md', index(entry('0001-a.md'), '<!-- a note --> [0002. B](0002-b.md)'));
      passes(check(dir));
    });
  });

  test('AC-5 (#70) ignores a link to a record that does not exist when it is inside an HTML comment', () => {
    const dir = fixture(two());
    write(dir, 'docs/adr/README.md', index(entry('0001-a.md'), entry('0002-b.md'), '<!-- - [0099. Ghost](0099-ghost.md) -->'));
    passes(check(dir));
  });

  test('AC-6 (#70) ignores everything after an HTML comment that is never closed', () => {
    const dir = fixture(two());
    write(dir, 'docs/adr/README.md', index(entry('0001-a.md'), '<!-- unfinished note', entry('0002-b.md'), '- [Ghost](0099-ghost.md)'));
    const r = check(dir);
    fails(r, '0002-b.md');
    assert.ok(!r.stderr.includes('0099-ghost.md'), `stderr names a link inside the unclosed comment:\n${r.stderr}`);
  });
});

describe('ADR 0021 and wording (#70)', () => {
  const read = (path) => readFileSync(join(repo, path), 'utf8');
  const adrDir = join(repo, 'docs', 'adr');
  const recordOf = (number) => {
    const file = readdirSync(adrDir).find((name) => name.startsWith(`${number}-`));
    assert.ok(file, `there is no ADR ${number}`);
    return { file, text: readFileSync(join(adrDir, file), 'utf8') };
  };
  const section = (text, heading) => (text.split(`\n## ${heading}\n`)[1] ?? '').split('\n## ')[0];
  const blocks = (text) => text.split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.)\s)/).map((block) => block.trim()).filter(Boolean);
  const someBlock = (text, ...patterns) => blocks(text).some((block) => patterns.every((p) => p.test(block)));
  // The ADR index keeps the titles of the records, so only its policy text counts.
  const policyText = (file) => (file === 'docs/adr/README.md' ? read(file).replace(/^- \[\d{4}\..*$/gm, '') : read(file));

  test('AC-8 (#70) ADR 0021 exists with status proposed or accepted and is in the index', () => {
    const { file, text } = recordOf('0021');
    assert.match(frontStatus(text), /^(proposed|accepted)\b/i);
    assert.ok(read('docs/adr/README.md').includes(`(${file})`), 'docs/adr/README.md does not link ADR 0021');
  });

  test('AC-8 (#70) ADR 0021 names in its header the parts of ADR 0020 it supersedes', () => {
    assert.match(recordOf('0021').text.split('\n## ')[0], /Supersedes[^\n]*0020/i);
  });

  test('AC-8 (#70) ADR 0021 records the recognised status of added records and HTML comments in the index', () => {
    const decision = section(recordOf('0021').text, 'Decision');
    assert.ok(someBlock(decision, /added/i, /recogni[sz]ed/i), 'the decision does not require a recognised status on added records');
    assert.ok(someBlock(decision, /HTML comment/i, /index/i), 'the decision does not say links in HTML comments do not index a record');
  });

  test('AC-8 (#70) ADR 0021 rejects keeping any non-empty status and allowing only proposed and accepted', () => {
    const items = blocks(section(recordOf('0021').text, 'Alternatives considered')).filter((block) => /^- /.test(block));
    const rejected = items.filter((item) => /Rejected/i.test(item));
    assert.ok(rejected.length >= 2, `only ${rejected.length} alternatives say why they were rejected`);
    assert.ok(rejected.some((item) => /non-empty|any status/i.test(item)), 'no rejected alternative keeps any non-empty status');
    assert.ok(rejected.some((item) => /only/i.test(item) && /proposed/i.test(item) && /accepted/i.test(item)), 'no rejected alternative allows only proposed and accepted');
  });

  for (const file of ['docs/adr/README.md', 'global/skills/adr-draft/SKILL.md', 'global/skills/drift-audit/SKILL.md']) {
    test(`AC-9 (#70) ${file} requires a recognised status on added records and ignores links in HTML comments`, () => {
      const text = policyText(file);
      assert.ok(someBlock(text, /added|new record/i, /recogni[sz]ed/i, /status/i), 'nothing says an added record needs a recognised status word');
      assert.ok(someBlock(text, /HTML comment/i, /index/i), 'nothing says links in HTML comments do not index a record');
    });
  }
});
