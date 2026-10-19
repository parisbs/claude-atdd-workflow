// Issue #66 (ADR 0020): scripts/check-adrs.mjs reads the status only from MADR 4 front matter, admits the
// one-time mechanical migration of a legacy record, treats deprecated as a decided status reachable from
// accepted, lets the date of a decided record change only with an allowed status transition, and checks
// only the index links that name a record. Each case builds a real repository with a base branch main and a
// head branch feature/x, as the tests of #28 do, and runs the script from its root against main.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { migrated } from './front-matter.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-adrs.mjs');

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

const read = (dir, path) => readFileSync(join(dir, path), 'utf8');

const BODY = ['', '## Context', '', 'Original context.', '', '## Decision', '', 'Original decision.', ''];

// A record in the standard format. With a status and a date, line 2 is the status, line 3 the date and
// "Original context." line 9. null leaves a field out; extra adds front matter lines after the date.
const standard = (title, status, { date = '2026-01-01', extra = [] } = {}) =>
  ['---', ...(status === null ? [] : [`status: ${status}`]), ...(date === null ? [] : [`date: ${date}`]), ...extra, '---',
    `# ${title}`, ...BODY].join('\n');

// A legacy record as #28 read it: "- Status:" and "- Date:" lines under the title. extra adds lines after
// them, such as "- Supersedes:".
const legacy = (title, status, { date = '2026-01-01', extra = [] } = {}) =>
  [`# ${title}`, '', `- Status: ${status}`, ...(date === null ? [] : [`- Date: ${date}`]), ...extra, ...BODY].join('\n');

// A legacy record as codex-subagent-mcp writes it: a "Status:" line without a dash, and no date.
const bare = (title, status) => [`# ${title}`, '', `Status: ${status}`, ...BODY].join('\n');

const entry = (file) => `- [${file.slice(0, 4)}. Title](${file})`;

// The base branch main holds docs/adr/ with the records given, a template and an index linking every
// record, and docs/decisions/ with one accepted record and its index; the head branch feature/x starts from
// it.
function fixture(records) {
  const dir = mkdtempSync(join(tmpdir(), 'cw-check-adrs-madr-'));
  scratch.push(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'Test');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  for (const [file, text] of Object.entries(records)) write(dir, `docs/adr/${file}`, text);
  write(dir, 'docs/adr/template.md', standard('NNNN. Title', 'proposed | accepted | rejected | deprecated | superseded by NNNN', { date: 'YYYY-MM-DD' }));
  write(dir, 'docs/adr/README.md', ['# ADRs', '', ...Object.keys(records).map(entry), ''].join('\n'));
  write(dir, 'docs/decisions/0001-x.md', standard('0001. X', 'accepted'));
  write(dir, 'docs/decisions/README.md', ['# Decisions', '', entry('0001-x.md'), ''].join('\n'));
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'docs: base');
  sh(dir, 'checkout', '-q', '-b', 'feature/x');
  return dir;
}

function replace(dir, path, from, to) {
  const text = read(dir, path);
  assert.ok(text.includes(from), `${path} does not contain ${from}`);
  write(dir, path, text.replace(from, to));
}

function addRecord(dir, file, text) {
  write(dir, `docs/adr/${file}`, text);
  write(dir, 'docs/adr/README.md', `${read(dir, 'docs/adr/README.md')}${entry(file)}\n`);
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

const editContext = (dir, file) => replace(dir, file, 'Original context.', 'Rewritten context.');
const setStatus = (dir, file, from, to) => replace(dir, file, `status: ${from}\n`, `status: ${to}\n`);
const setDate = (dir, file, to) => replace(dir, file, 'date: 2026-01-01\n', to === null ? '' : `date: ${to}\n`);

describe('check-adrs on MADR 4 front matter (#66)', () => {
  describe('AC-1 (#66) only the front matter status counts', () => {
    for (const status of ['proposed', '"proposed"', "'Proposed'"]) {
      test(`AC-1 (#66) a record whose front matter status is ${status} is a draft`, () => {
        const dir = fixture({ '0001-a.md': standard('0001. A', status) });
        editContext(dir, 'docs/adr/0001-a.md');
        passes(check(dir));
      });
    }

    test('AC-1 (#66) a quoted accepted status with an annotation freezes the record', () => {
      const dir = fixture({ '0001-a.md': standard('0001. A', '"Accepted, amended by 0002"') });
      editContext(dir, 'docs/adr/0001-a.md');
      fails(check(dir), 'docs/adr/0001-a.md:9');
    });

    for (const [name, text] of [
      ['a legacy "- Status: proposed" line alone', legacy('0001. A', 'proposed')],
      ['a legacy "Status: proposed" line alone', bare('0001. A', 'proposed')],
      ['front matter without status and a legacy "- Status: proposed" line',
        ['---', 'date: 2026-01-01', '---', '# 0001. A', '', '- Status: proposed', ...BODY].join('\n')],
      ['"status: proposed" outside any front matter', ['# 0001. A', '', 'status: proposed', ...BODY].join('\n')],
      ['front matter that does not start on line 1', `\n${standard('0001. A', 'proposed')}`],
      ['front matter that is never closed', ['---', 'status: proposed', 'date: 2026-01-01', '# 0001. A', ...BODY].join('\n')],
      ['two status fields', standard('0001. A', 'proposed', { extra: ['status: proposed'] })],
    ]) {
      test(`AC-1 (#66) a record with ${name} counts as missing a status, so it is frozen`, () => {
        const dir = fixture({ '0001-a.md': text });
        editContext(dir, 'docs/adr/0001-a.md');
        fails(check(dir), 'docs/adr/0001-a.md');
      });
    }
  });

  describe('AC-2 (#66) an added record must be in the standard format', () => {
    for (const [name, text] of [
      ['only a legacy "- Status:" line', legacy('0002. New', 'proposed')],
      ['only a legacy "Status:" line', bare('0002. New', 'proposed')],
      ['no status at all', standard('0002. New', null)],
    ]) {
      test(`AC-2 (#66) fails on an added record with ${name}, naming the file`, () => {
        const dir = fixture({ '0001-a.md': standard('0001. A', 'accepted') });
        addRecord(dir, '0002-new.md', text);
        fails(check(dir), 'docs/adr/0002-new.md');
      });
    }

    test('AC-2 (#66) passes on an added record with a front matter status', () => {
      const dir = fixture({ '0001-a.md': standard('0001. A', 'accepted') });
      addRecord(dir, '0002-new.md', standard('0002. New', 'proposed'));
      passes(check(dir));
    });
  });

  describe('AC-3 (#66) a mechanical migration passes whatever the base status', () => {
    for (const [name, text, fields] of [
      ['an accepted record with a date', legacy('0001. A', 'accepted'), ['status: accepted', 'date: 2026-01-01']],
      ['a proposed record', legacy('0001. A', 'proposed'), ['status: proposed', 'date: 2026-01-01']],
      ['a superseded record, carrying the link', legacy('0001. A', 'superseded by [0002](0002-b.md)'),
        ['status: superseded by [0002](0002-b.md)', 'date: 2026-01-01']],
      ['a record with a "- Supersedes:" line, which stays', legacy('0001. A', 'accepted', { extra: ['- Supersedes: [0002](0002-b.md)'] }),
        ['status: accepted', 'date: 2026-01-01']],
      ['a "Status:" record without a date', bare('0001. A', 'Accepted'), ['status: Accepted']],
      ['a record migrated with quoted values', legacy('0001. A', 'accepted'), ['status: "accepted"', "date: '2026-01-01'"]],
    ]) {
      test(`AC-3 (#66) passes on the migration of ${name}`, () => {
        const dir = fixture({ '0001-a.md': text, '0002-b.md': standard('0002. B', 'accepted') });
        write(dir, 'docs/adr/0001-a.md', migrated(text, fields));
        passes(check(dir));
      });
    }
  });

  describe('AC-4 (#66) a migration that is not mechanical fails', () => {
    const accepted = legacy('0001. A', 'accepted');
    for (const [name, text, head] of [
      ['also edits another line', accepted,
        migrated(accepted, ['status: accepted', 'date: 2026-01-01']).replace('Original context.', 'Rewritten context.')],
      ['carries another status', accepted, migrated(accepted, ['status: rejected', 'date: 2026-01-01'])],
      ['normalises an unrecognised status', legacy('0001. A', 'Approved'), migrated(legacy('0001. A', 'Approved'), ['status: accepted', 'date: 2026-01-01'])],
      ['carries another date', accepted, migrated(accepted, ['status: accepted', 'date: 2026-02-02'])],
      ['adds a date the legacy record did not have', bare('0001. A', 'accepted'), migrated(bare('0001. A', 'accepted'), ['status: accepted', 'date: 2026-01-01'])],
      ['drops the legacy date', accepted, migrated(accepted, ['status: accepted'])],
      ['adds another front matter field', accepted, migrated(accepted, ['status: accepted', 'date: 2026-01-01', 'decision-makers: someone'])],
    ]) {
      test(`AC-4 (#66) fails on a migration that ${name}, naming the file`, () => {
        const dir = fixture({ '0001-a.md': text });
        write(dir, 'docs/adr/0001-a.md', head);
        fails(check(dir), 'docs/adr/0001-a.md');
      });
    }
  });

  describe('AC-5 (#66) deprecated is decided, reachable only from accepted', () => {
    const records = () => ({
      '0001-a.md': standard('0001. A', 'accepted'),
      '0002-b.md': standard('0002. B', 'proposed'),
      '0003-c.md': standard('0003. C', 'rejected'),
      '0004-d.md': standard('0004. D', 'superseded by [0001](0001-a.md)'),
      '0005-e.md': standard('0005. E', 'deprecated'),
      '0006-f.md': standard('0006. F', 'Approved'),
    });

    for (const [file, from, to] of [
      ['0001-a.md', 'accepted', 'deprecated'],
      ['0005-e.md', 'deprecated', 'superseded by [0001](0001-a.md)'],
      ['0005-e.md', 'deprecated', 'deprecated, see [0001](0001-a.md)'],
    ]) {
      test(`AC-5 (#66) passes when ${from} becomes ${to}`, () => {
        const dir = fixture(records());
        setStatus(dir, `docs/adr/${file}`, from, to);
        passes(check(dir));
      });
    }

    for (const [file, from, to] of [
      ['0002-b.md', 'proposed', 'deprecated'],
      ['0003-c.md', 'rejected', 'deprecated'],
      ['0004-d.md', 'superseded by [0001](0001-a.md)', 'deprecated'],
      ['0006-f.md', 'Approved', 'deprecated'],
      ['0005-e.md', 'deprecated', 'accepted'],
      ['0005-e.md', 'deprecated', 'proposed'],
      ['0005-e.md', 'deprecated', 'rejected'],
    ]) {
      test(`AC-5 (#66) fails when ${from} becomes ${to}, naming the file and both statuses`, () => {
        const dir = fixture(records());
        setStatus(dir, `docs/adr/${file}`, from, to);
        fails(check(dir), `docs/adr/${file}`, from.split(' ')[0], to);
      });
    }

    test('AC-5 (#66) a deprecated record is frozen', () => {
      const dir = fixture(records());
      editContext(dir, 'docs/adr/0005-e.md');
      fails(check(dir), 'docs/adr/0005-e.md:9');
    });
  });

  describe('AC-6 (#66) the date of a decided record changes only with an allowed status transition', () => {
    const records = () => ({
      '0001-a.md': standard('0001. A', 'accepted'),
      '0002-b.md': standard('0002. B', 'proposed'),
      '0003-c.md': standard('0003. C', 'Approved'),
    });

    for (const [file, from, to] of [
      ['0001-a.md', 'accepted', 'superseded by [0002](0002-b.md)'],
      ['0001-a.md', 'accepted', 'deprecated'],
      ['0003-c.md', 'Approved', 'accepted'],
    ]) {
      test(`AC-6 (#66) passes when the date changes as ${from} becomes ${to}`, () => {
        const dir = fixture(records());
        setStatus(dir, `docs/adr/${file}`, from, to);
        setDate(dir, `docs/adr/${file}`, '2026-03-03');
        passes(check(dir));
      });
    }

    test('AC-6 (#66) passes when the date of a proposed record changes alone', () => {
      const dir = fixture(records());
      setDate(dir, 'docs/adr/0002-b.md', '2026-03-03');
      passes(check(dir));
    });

    test('AC-6 (#66) fails when the date of an accepted record changes alone, naming the file', () => {
      const dir = fixture(records());
      setDate(dir, 'docs/adr/0001-a.md', '2026-03-03');
      fails(check(dir), 'docs/adr/0001-a.md');
    });

    test('AC-6 (#66) fails when the date changes with an annotation alone, naming the file', () => {
      const dir = fixture(records());
      setStatus(dir, 'docs/adr/0001-a.md', 'accepted', 'accepted, amended by [0002](0002-b.md)');
      setDate(dir, 'docs/adr/0001-a.md', '2026-03-03');
      fails(check(dir), 'docs/adr/0001-a.md');
    });

    test('AC-6 (#66) fails when the date of an accepted record is removed, naming the file', () => {
      const dir = fixture(records());
      setDate(dir, 'docs/adr/0001-a.md', null);
      fails(check(dir), 'docs/adr/0001-a.md');
    });
  });

  describe('AC-7 (#66) the index check reads only links to records', () => {
    const records = () => ({ '0001-a.md': standard('0001. A', 'accepted'), '0002-b.md': standard('0002. B', 'proposed') });
    const index = (...lines) => ['# ADRs', '', ...lines, ''].join('\n');

    test('AC-7 (#66) ignores links to other documents, external pages, anchors and repeated records', () => {
      const dir = fixture(records());
      write(dir, 'docs/adr/README.md', index(
        'See [the roadmap](../ROADMAP.md), [MADR](https://adr.github.io/madr/), [below](#records) and [the template](template.md).',
        'Also [0001 again](0001-a.md), [its context](0001-a.md#context), [a sibling](../decisions/0001-x.md) and [elsewhere](https://example.com/0001-a.md).',
        '',
        '## Records',
        '',
        '| Record | Status |',
        '| --- | --- |',
        '| [0001. A](0001-a.md) | accepted |',
        '| [0002. B](./0002-b.md) | proposed, see [0001](0001-a.md) |',
      ));
      passes(check(dir));
    });

    test('AC-7 (#66) fails when a record is not linked, naming it', () => {
      const dir = fixture(records());
      write(dir, 'docs/adr/README.md', index('See [MADR](https://adr.github.io/madr/).', entry('0001-a.md')));
      fails(check(dir), '0002-b.md');
    });

    for (const link of ['0099-ghost.md', '../decisions/0042-x.md']) {
      test(`AC-7 (#66) fails when a link to the record-named file ${link} does not resolve, naming it`, () => {
        const dir = fixture(records());
        write(dir, 'docs/adr/README.md', `${read(dir, 'docs/adr/README.md')}- [Ghost](${link})\n`);
        fails(check(dir), link.split('/').at(-1));
      });
    }
  });
});
