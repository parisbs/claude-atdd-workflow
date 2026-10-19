// Issue #66, second review: cases the first round of fixes left open. The migration script decoded records
// as UTF-8 and silently replaced invalid bytes, so the check rejected its output; reading records byte for
// byte made a no-break space after the status word glue it to the word; double quotes do not keep U+0085
// for a YAML reader, and a tab before # or : was left unquoted; a status of only blanks counted as present;
// and the skills and comments claimed more than the code does.
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
const legacy = (title, status) => [`# ${title}`, '', `- Status: ${status}`, '- Date: 2026-01-01', ...BODY].join('\n');
const entry = (file) => `- [${file.slice(0, 4)}. Title](${file})`;

// A base branch main with the records given and an index linking each, and a head branch feature/x.
function fixture(records) {
  const dir = mkdtempSync(join(tmpdir(), 'cw-check-adrs-madr-review2-'));
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

function check(dir, base = 'main') {
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '--allow-empty', '-m', 'docs: head');
  return spawnSync(process.execPath, [checkAdrs, base], { cwd: dir, encoding: 'utf8' });
}

const run = (dir) => spawnSync(process.execPath, [migrate], { cwd: dir, encoding: 'utf8' });
const passes = (r) => assert.equal(r.status, 0, `expected the check to pass:\n${r.stderr}`);
function fails(r, ...names) {
  assert.notEqual(r.status, 0, 'expected the check to fail');
  for (const name of names) assert.ok(r.stderr.includes(name), `stderr does not name ${name}:\n${r.stderr}`);
}

describe('migrate-adrs and check-adrs, second review regressions (#66)', () => {
  test('AC-10 (#66 review 2) the script names a record that is not valid UTF-8 and leaves its bytes unchanged', () => {
    const bytes = Buffer.concat([Buffer.from(legacy('0001. A', 'accepted').replace('Original context.\n', 'Caf')), Buffer.from([0xe9, 0x0a])]);
    const dir = fixture({ '0001-a.md': bytes });
    const r = run(dir);
    assert.notEqual(r.status, 0, 'expected the script to name the record');
    assert.match(r.stderr, /docs\/adr\/0001-a\.md/);
    assert.ok(readFileSync(join(dir, 'docs/adr/0001-a.md')).equals(bytes), 'the record changed');
  });

  test('AC-1 (#66 review 2) a no-break space after the status word ends the word', () => {
    const dir = fixture({ '0001-a.md': standard('0001. A', 'proposed (revised)') });
    write(dir, 'docs/adr/0001-a.md', standard('0001. A', 'proposed (revised)').replace('Original context.', 'Rewritten context.'));
    passes(check(dir));
  });

  test('AC-10 (#66 review 2) the script names a record whose legacy value holds U+0085, which YAML does not keep', () => {
    const text = legacy('0001. A', 'accepted\u0085amended');
    const dir = fixture({ '0001-a.md': text });
    const r = run(dir);
    assert.notEqual(r.status, 0, 'expected the script to name the record');
    assert.match(r.stderr, /docs\/adr\/0001-a\.md/);
    assert.equal(readFileSync(join(dir, 'docs/adr/0001-a.md'), 'utf8'), text);
  });

  for (const status of ['Accepted\t# note', 'Accepted:\tsee below']) {
    test(`AC-9 (#66 review 2) the script quotes ${JSON.stringify(status)} and the check admits the result`, () => {
      const dir = fixture({ '0001-a.md': legacy('0001. A', status) });
      const base = sh(dir, 'rev-parse', 'HEAD');
      const r = run(dir);
      assert.equal(r.status, 0, r.stderr);
      const line = readFileSync(join(dir, 'docs/adr/0001-a.md'), 'utf8').split('\n').find((text) => text.startsWith('status:'));
      assert.match(line ?? '', /^status: ".*"$/);
      passes(check(dir, base));
    });
  }

  for (const status of ['" "', "'\t'"]) {
    test(`AC-2 (#66 review 2) fails on an added record whose status is only blanks (status: ${JSON.stringify(status)})`, () => {
      const dir = fixture({ '0001-a.md': standard('0001. A', 'accepted') });
      write(dir, 'docs/adr/0002-new.md', standard('0002. New', status));
      write(dir, 'docs/adr/README.md', ['# ADRs', '', entry('0001-a.md'), entry('0002-new.md'), ''].join('\n'));
      fails(check(dir), 'docs/adr/0002-new.md');
    });
  }

  test('AC-10 (#66 review 2) the script names a front matter record whose status is only blanks', () => {
    const dir = fixture({ '0001-a.md': standard('0001. A', '" "') });
    const r = run(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /docs\/adr\/0001-a\.md/);
  });
});

describe('skills and comments, second review regressions (#66)', () => {
  const read = (path) => readFileSync(join(repo, path), 'utf8');
  const blocks = (text) => text.split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.)\s)/).map((block) => block.trim()).filter(Boolean);
  const someBlock = (text, ...patterns) => blocks(text).some((block) => patterns.every((p) => p.test(block)));
  const bootstrap = read('global/skills/repo-bootstrap/SKILL.md');

  test('AC-17 (#66 review 2) repo-bootstrap needs the index before running the template check over the migration', () => {
    assert.ok(someBlock(bootstrap, /migrat/i, /templates\/common\/scripts\/check-adrs\.mjs/, /index|README\.md/));
  });

  test('AC-17 (#66 review 2) repo-bootstrap says the index is read from inline links and the check runs against the merge base', () => {
    assert.match(bootstrap, /inline\s+links?/i);
    assert.match(bootstrap, /merge\s+base/i);
  });

  test('AC-13 (#66 review 2) ADR 0020 states the limits of the index reading', () => {
    const adr = read('docs/adr/0020-standardise-adr-metadata-on-madr-4-front-matter.md');
    assert.ok(someBlock(adr, /inline\s+links?/i, /reference-style/i));
  });

  test('AC-14 (#66 review 2) adr-draft points to the migration script only where the repository has it', () => {
    assert.ok(someBlock(read('global/skills/adr-draft/SKILL.md'), /migrate-adrs\.mjs/, /repo-bootstrap/));
  });

  test('AC-16 (#66 review 2) the installer does not claim the template copies cannot drift', () => {
    assert.doesNotMatch(read('scripts/install.mjs'), /cannot drift/);
  });
});
