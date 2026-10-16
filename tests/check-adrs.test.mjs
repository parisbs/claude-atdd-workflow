// Issue #28 (ADR 0018): scripts/check-adrs.mjs compares the ADRs of a pull request with its base. A record
// whose status on the base is decided, missing or unrecognised is frozen except its status line; a proposed
// one is a draft. Each case builds a real repository with a base branch and a head branch, as the hook
// tests do, and runs the script from its root. The static checks at the end read this repository.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
  return r.stdout.trim();
}

function write(dir, path, content) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

const read = (dir, path) => readFileSync(join(dir, path), 'utf8');

// Line 3 is the status line; "Original context." is on line 8, or line 7 when there is no status line.
const record = (number, title, status) =>
  [`# ${number}. ${title}`, '', ...(status === null ? [] : [`- Status: ${status}`]), '- Date: 2026-01-01', '',
    '## Context', '', 'Original context.', '', '## Decision', '', 'Original decision.', ''].join('\n');

const BASE = {
  '0001-a.md': ['A', 'accepted'],
  '0002-b.md': ['B', 'proposed'],
  '0003-c.md': ['C', 'Approved'],
  '0004-d.md': ['D', null],
  '0005-e.md': ['E', 'rejected'],
  '0006-f.md': ['F', 'superseded by [0001](0001-a.md)'],
  '0007-g.md': ['G', 'accepted, amended by [0001](0001-a.md)'],
  '0008-h.md': ['H', 'Proposed'],
};
const entry = (file, title) => `- [${file.slice(0, 4)}. ${title}](${file})`;

// The base branch main holds docs/adr/ (the records above, an index and a template) and docs/decisions/
// (one accepted record and its index); the head branch feature/x starts from it.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cw-check-adrs-'));
  scratch.push(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'Test');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  for (const [file, [title, status]] of Object.entries(BASE)) write(dir, `docs/adr/${file}`, record(file.slice(0, 4), title, status));
  write(dir, 'docs/adr/template.md', record('NNNN', 'Title', 'proposed | accepted | rejected | superseded by NNNN'));
  write(dir, 'docs/adr/README.md', ['# ADRs', '', ...Object.entries(BASE).map(([f, [t]]) => entry(f, t)), ''].join('\n'));
  write(dir, 'docs/decisions/0001-x.md', record('0001', 'X', 'accepted'));
  write(dir, 'docs/decisions/README.md', ['# Decisions', '', entry('0001-x.md', 'X'), ''].join('\n'));
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

function addRecord(dir, file, title, status = 'proposed', { index = true } = {}) {
  write(dir, `docs/adr/${file}`, record(file.slice(0, 4), title, status));
  if (index) write(dir, 'docs/adr/README.md', `${read(dir, 'docs/adr/README.md')}${entry(file, title)}\n`);
}

function check(dir, base = 'main') {
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '--allow-empty', '-m', 'docs: head');
  return spawnSync(process.execPath, [script, base], { cwd: dir, encoding: 'utf8' });
}

const passes = (r) => assert.equal(r.status, 0, `expected the check to pass:\n${r.stderr}`);
function fails(r, ...names) {
  assert.notEqual(r.status, 0, 'expected the check to fail');
  for (const name of names) assert.ok(r.stderr.includes(name), `stderr does not name ${name}:\n${r.stderr}`);
}

const editContext = (dir, file) => replace(dir, file, 'Original context.', 'Rewritten context.');
const setStatus = (dir, file, from, to) => replace(dir, file, `- Status: ${from}\n`, `- Status: ${to}\n`);

describe('check-adrs (#28)', () => {
  describe('AC-1 (#28) a decided record is frozen except its status line', () => {
    for (const [file, status] of [['0001-a.md', 'accepted'], ['0005-e.md', 'rejected'], ['0006-f.md', 'superseded'], ['0007-g.md', 'accepted, amended by']]) {
      test(`AC-1 (#28) fails on a body edit of a ${status} record, naming the file and the line`, () => {
        const dir = fixture();
        editContext(dir, `docs/adr/${file}`);
        fails(check(dir), `docs/adr/${file}:8`);
      });
    }

    test('AC-1 (#28) fails on a body edit in docs/decisions', () => {
      const dir = fixture();
      editContext(dir, 'docs/decisions/0001-x.md');
      fails(check(dir), 'docs/decisions/0001-x.md:8');
    });

    test('AC-1 (#28) fails when the same change supersedes a record and edits its body', () => {
      const dir = fixture();
      setStatus(dir, 'docs/adr/0001-a.md', 'accepted', 'superseded by [0002](0002-b.md)');
      editContext(dir, 'docs/adr/0001-a.md');
      fails(check(dir), 'docs/adr/0001-a.md:8');
    });
  });

  describe('AC-2 (#28) a record with a missing or unrecognised status is frozen', () => {
    test('AC-2 (#28) fails on a body edit of a record whose status is unrecognised', () => {
      const dir = fixture();
      editContext(dir, 'docs/adr/0003-c.md');
      fails(check(dir), 'docs/adr/0003-c.md:8');
    });

    test('AC-2 (#28) fails on a body edit of a record without a status line', () => {
      const dir = fixture();
      editContext(dir, 'docs/adr/0004-d.md');
      fails(check(dir), 'docs/adr/0004-d.md:7');
    });
  });

  describe('AC-3 (#28) a proposed record is a draft', () => {
    test('AC-3 (#28) passes on a body edit of a proposed record', () => {
      const dir = fixture();
      editContext(dir, 'docs/adr/0002-b.md');
      passes(check(dir));
    });

    test('AC-3 (#28) passes when the same change edits a proposed record and accepts it', () => {
      const dir = fixture();
      editContext(dir, 'docs/adr/0002-b.md');
      setStatus(dir, 'docs/adr/0002-b.md', 'proposed', 'accepted');
      passes(check(dir));
    });

    test('AC-3 (#28) reads the status without regard to case: a Proposed record is a draft', () => {
      const dir = fixture();
      editContext(dir, 'docs/adr/0008-h.md');
      passes(check(dir));
    });
  });

  describe('AC-4 (#28) a decided record may be annotated or superseded', () => {
    test('AC-4 (#28) passes when an accepted record gains an annotation', () => {
      const dir = fixture();
      setStatus(dir, 'docs/adr/0001-a.md', 'accepted', 'accepted, amended by [0002](0002-b.md)');
      passes(check(dir));
    });

    test('AC-4 (#28) passes when an accepted record is superseded', () => {
      const dir = fixture();
      setStatus(dir, 'docs/adr/0001-a.md', 'accepted', 'superseded by [0002](0002-b.md)');
      passes(check(dir));
    });

    test('AC-4 (#28) passes when a rejected record is superseded', () => {
      const dir = fixture();
      setStatus(dir, 'docs/adr/0005-e.md', 'rejected', 'superseded by [0002](0002-b.md)');
      passes(check(dir));
    });
  });

  describe('AC-5 (#28) a decided record cannot move to another decision or back to a draft', () => {
    for (const [file, from, to] of [
      ['0001-a.md', 'accepted', 'proposed'],
      ['0001-a.md', 'accepted', 'rejected'],
      ['0005-e.md', 'rejected', 'accepted'],
      ['0001-a.md', 'accepted', 'Approved'],
    ]) {
      test(`AC-5 (#28) fails when ${from} becomes ${to}, naming the file and both statuses`, () => {
        const dir = fixture();
        setStatus(dir, `docs/adr/${file}`, from, to);
        fails(check(dir), `docs/adr/${file}`, from, to);
      });
    }
  });

  describe('AC-6 (#28) a missing or unrecognised status may be normalised, never to proposed', () => {
    test('AC-6 (#28) passes when an unrecognised status becomes accepted', () => {
      const dir = fixture();
      setStatus(dir, 'docs/adr/0003-c.md', 'Approved', 'accepted');
      passes(check(dir));
    });

    test('AC-6 (#28) passes when a record without a status line gains one', () => {
      const dir = fixture();
      replace(dir, 'docs/adr/0004-d.md', '- Date: 2026-01-01\n', '- Status: accepted\n- Date: 2026-01-01\n');
      passes(check(dir));
    });

    test('AC-6 (#28) fails when an unrecognised status becomes proposed, naming the file and both statuses', () => {
      const dir = fixture();
      setStatus(dir, 'docs/adr/0003-c.md', 'Approved', 'proposed');
      fails(check(dir), 'docs/adr/0003-c.md', 'Approved', 'proposed');
    });
  });

  describe('AC-7 (#28) records on the base are never deleted or renamed', () => {
    test('AC-7 (#28) fails when an accepted record is deleted', () => {
      const dir = fixture();
      unlinkSync(join(dir, 'docs/adr/0001-a.md'));
      replace(dir, 'docs/adr/README.md', `${entry('0001-a.md', 'A')}\n`, '');
      fails(check(dir), 'docs/adr/0001-a.md');
    });

    test('AC-7 (#28) fails when a proposed record is renamed', () => {
      const dir = fixture();
      sh(dir, 'mv', 'docs/adr/0002-b.md', 'docs/adr/0002-renamed.md');
      replace(dir, 'docs/adr/README.md', '(0002-b.md)', '(0002-renamed.md)');
      fails(check(dir), 'docs/adr/0002-b.md');
    });
  });

  describe('AC-8 (#28) added records continue the numbering', () => {
    test('AC-8 (#28) passes when the next number is added, whatever its content', () => {
      const dir = fixture();
      addRecord(dir, '0009-i.md', 'I', 'accepted');
      passes(check(dir));
    });

    test('AC-8 (#28) fails on a gap, naming the number', () => {
      const dir = fixture();
      addRecord(dir, '0010-j.md', 'J');
      fails(check(dir), '0010');
    });

    test('AC-8 (#28) fails on two added records with the same number, naming it', () => {
      const dir = fixture();
      addRecord(dir, '0009-i.md', 'I');
      addRecord(dir, '0009-other.md', 'Other');
      fails(check(dir), '0009');
    });

    test('AC-8 (#28) fails on an added record that reuses a number of the base, naming it', () => {
      const dir = fixture();
      addRecord(dir, '0003-again.md', 'Again');
      fails(check(dir), '0003');
    });
  });

  describe('AC-9 (#28) the index matches the records', () => {
    test('AC-9 (#28) fails when the index misses a record, naming it', () => {
      const dir = fixture();
      addRecord(dir, '0009-i.md', 'I', 'proposed', { index: false });
      fails(check(dir), '0009-i.md');
    });

    test('AC-9 (#28) fails when the index links a file that does not exist, naming it', () => {
      const dir = fixture();
      write(dir, 'docs/adr/README.md', `${read(dir, 'docs/adr/README.md')}${entry('0099-ghost.md', 'Ghost')}\n`);
      fails(check(dir), '0099-ghost.md');
    });
  });

  test('AC-10 (#28) fails, naming the base, when the base cannot be read', () => {
    const dir = fixture();
    fails(check(dir, 'no-such-base'), 'no-such-base');
  });
});

describe('check-adrs wiring and records (#28)', () => {
  const text = (path) => readFileSync(join(repo, path), 'utf8');
  const adrDir = join(repo, 'docs', 'adr');
  const recordOf = (number) => {
    const file = readdirSync(adrDir).find((name) => name.startsWith(`${number}-`));
    assert.ok(file, `there is no ADR ${number}`);
    return { file, text: readFileSync(join(adrDir, file), 'utf8') };
  };
  const section = (body, heading) => (body.split(`\n## ${heading}\n`)[1] ?? '').split('\n## ')[0];
  const items = (body) => body.split(/\n(?=- )/).map((item) => item.trim()).filter((item) => item.startsWith('- '));

  test('AC-11 (#28) CI runs the check with the base branch available', () => {
    const ci = text('.github/workflows/ci.yml');
    assert.match(ci, /scripts\/check-adrs\.mjs/);
    assert.match(ci, /fetch-depth:\s*0|git fetch[^\n]*base_ref/);
  });

  test('AC-12 (#28) ADR 0019 exists with status proposed or accepted and is in the index', () => {
    const { file, text: body } = recordOf('0019');
    assert.match(/^- Status: (.*)$/m.exec(body)?.[1] ?? '', /^(proposed|accepted)\b/);
    assert.ok(text('docs/adr/README.md').includes(`(${file})`), 'docs/adr/README.md does not link ADR 0019');
  });

  test('AC-12 (#28) ADR 0019 records the comparison with the base, the transitions and the case rule', () => {
    const { text: body } = recordOf('0019');
    const decision = section(body, 'Decision');
    for (const word of [/\bbase\b/i, /\bsuperseded\b/i, /\bproposed\b/i, /\bcase\b/i]) assert.match(decision, word);
    const rejected = items(section(body, 'Alternatives considered')).filter((item) => /Rejected/i.test(item));
    assert.ok(rejected.length >= 2, `only ${rejected.length} alternatives say why they were rejected`);
    assert.ok(rejected.some((item) => /histor/i.test(item)), 'no rejected alternative walks the history');
    const consequences = section(body, 'Consequences');
    assert.match(consequences, /0018/);
    assert.match(consequences, /histor/i);
  });

  test('AC-12 (#28) ADR 0018 is unchanged apart from its status line', () => {
    const body = recordOf('0018').text.replace(/^- Status: .*\n/m, '');
    assert.equal(createHash('sha256').update(body).digest('hex'), '4225ed2db8e379117ff5e693bd279765e2a899b5d0d45349b89c661246eb738e');
  });

  test('AC-13 (#28) the roadmap line for issue 28 describes the check under ADR 0018', () => {
    const line = (text('docs/ROADMAP.md').split(/\n(?=- )/).find((item) => item.startsWith('- Issue 28:')) ?? '');
    assert.ok(line, 'docs/ROADMAP.md has no line for issue 28');
    assert.match(line, /0018/);
    assert.doesNotMatch(line, /change only their status line/i);
  });
});
