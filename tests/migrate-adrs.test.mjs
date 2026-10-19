// Issue #66 (ADR 0020): scripts/migrate-adrs.mjs rewrites every legacy record of a repository into MADR 4
// front matter, mechanically, so that scripts/check-adrs.mjs admits the change whatever the base status.
// Usage, from inside the repository: node scripts/migrate-adrs.mjs. It rewrites the working tree of
// docs/adr/, docs/adrs/ and docs/decisions/, names on stderr each record it cannot migrate and leaves that
// record unchanged, and exits 1 when it named any. Each case builds a real repository.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LEGACY_LINE, frontMatter } from './front-matter.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const migrate = join(scripts, 'migrate-adrs.mjs');
const checkAdrs = join(scripts, 'check-adrs.mjs');

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
const lines = (...head) => [...head, ...BODY].join('\n');
const entry = (file) => `- [${file.slice(0, 4)}. Title](${file})`;

// A committed repository with the given files under docs/; each directory with records gets an index.
function repository(files) {
  const dir = mkdtempSync(join(tmpdir(), 'cw-migrate-adrs-'));
  scratch.push(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'Test');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  const indexes = new Map();
  for (const [path, text] of Object.entries(files)) {
    write(dir, path, text);
    const [, directory, name] = /^(.*)\/([^/]+)$/.exec(path);
    if (/^\d{4}-/.test(name)) indexes.set(directory, [...(indexes.get(directory) ?? []), name]);
  }
  for (const [directory, names] of indexes) write(dir, `${directory}/README.md`, ['# ADRs', '', ...names.map(entry), ''].join('\n'));
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'docs: legacy records');
  return dir;
}

const run = (dir) => spawnSync(process.execPath, [migrate], { cwd: dir, encoding: 'utf8' });

describe('migrate-adrs (#66)', () => {
  describe('AC-9 (#66) the script rewrites every legacy record and leaves standard records unchanged', () => {
    // path -> [legacy text, status, date or undefined]
    const LEGACY = {
      'docs/adr/0001-a.md': [lines('# 0001. A', '', '- Status: accepted', '- Date: 2026-01-01'), 'accepted', '2026-01-01'],
      'docs/adr/0002-b.md': [lines('# 0002. B', '', '- Status: accepted', '- Date: 2026-01-02', '- Supersedes: [0001](0001-a.md)'), 'accepted', '2026-01-02'],
      'docs/adr/0003-c.md': [lines('# 0003. C', '', 'Status: Accepted; superseded by [ADR 1](0001-a.md)'), 'Accepted; superseded by [ADR 1](0001-a.md)', undefined],
      'docs/adr/0005-e.md': [lines('# 0005. E', '', '- Status: accepted: see the notes #1', '- Date: 2026-01-05'), 'accepted: see the notes #1', '2026-01-05'],
      'docs/decisions/0001-x.md': [lines('# 0001. X', '', '- Status: proposed', '- Date: 2026-01-06'), 'proposed', '2026-01-06'],
    };
    const UNCHANGED = {
      'docs/adr/0004-d.md': ['---', 'status: proposed', 'date: 2026-01-04', '---', '# 0004. D', ...BODY].join('\n'),
      'docs/adr/template.md': lines('# NNNN. Title', '', '- Status: proposed | accepted | rejected | superseded by NNNN', '- Date: YYYY-MM-DD'),
    };
    let dir;
    let base;
    let result;
    before(() => {
      dir = repository({ ...Object.fromEntries(Object.entries(LEGACY).map(([path, [text]]) => [path, text])), ...UNCHANGED });
      base = sh(dir, 'rev-parse', 'HEAD');
      UNCHANGED['docs/adr/README.md'] = read(dir, 'docs/adr/README.md');
      result = run(dir);
    });

    test('AC-9 (#66) exits 0 when every legacy record was migrated', () => {
      assert.equal(result.status, 0, result.stderr);
    });

    for (const [path, [text, status, date]] of Object.entries(LEGACY)) {
      test(`AC-9 (#66) ${path} carries its legacy status and date in front matter and no legacy line`, () => {
        const after = read(dir, path);
        const header = frontMatter(after);
        assert.ok(header, `${path} has no front matter:\n${after}`);
        assert.deepEqual(header.keys, date === undefined ? ['status'] : ['status', 'date']);
        assert.equal(header.fields.status, status);
        assert.equal(header.fields.date, date);
        assert.equal(header.rest, text.split('\n').filter((line) => !LEGACY_LINE.test(line)).join('\n'));
      });
    }

    for (const path of [...Object.keys(UNCHANGED), 'docs/adr/README.md']) {
      test(`AC-9 (#66) leaves ${path} unchanged`, () => {
        assert.equal(read(dir, path), UNCHANGED[path]);
      });
    }

    test('AC-9 (#66) quotes a status that plain YAML would misread', () => {
      const line = read(dir, 'docs/adr/0005-e.md').split('\n').find((text) => text.startsWith('status:'));
      assert.match(line ?? '', /^status: (["']).*\1$/);
    });

    test('AC-9 (#66) the check passes on the result against the commit before it', () => {
      assert.notEqual(sh(dir, 'status', '--porcelain'), '', 'the script changed nothing');
      sh(dir, 'add', '-A');
      sh(dir, 'commit', '-q', '-m', 'docs: migrate records');
      const r = spawnSync(process.execPath, [checkAdrs, base], { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    });

    test('AC-9 (#66) a second run changes nothing', () => {
      const again = run(dir);
      assert.equal(again.status, 0, again.stderr);
      assert.equal(sh(dir, 'status', '--porcelain'), '');
    });
  });

  describe('AC-10 (#66) the script leaves a record it cannot read unchanged and names it', () => {
    const CANNOT = {
      'docs/adr/0002-b.md': lines('# 0002. B', '', '- Date: 2026-01-02'),
      'docs/adr/0003-c.md': lines('# 0003. C', '', '- Status: accepted', '- Status: rejected', '- Date: 2026-01-03'),
      'docs/adr/0004-d.md': lines('# 0004. D', '', '- Status: accepted', 'Status: accepted', '- Date: 2026-01-04'),
      'docs/adr/0005-e.md': lines('# 0005. E', '', '- Status: accepted', '- Date: 2026-01-05', '- Date: 2026-01-06'),
    };
    const reason = {
      'docs/adr/0002-b.md': 'no legacy status line',
      'docs/adr/0003-c.md': 'two "- Status:" lines',
      'docs/adr/0004-d.md': 'both "- Status:" and "Status:"',
      'docs/adr/0005-e.md': 'two "- Date:" lines',
    };
    let dir;
    let result;
    before(() => {
      dir = repository({ 'docs/adr/0001-a.md': lines('# 0001. A', '', '- Status: accepted', '- Date: 2026-01-01'), ...CANNOT });
      result = run(dir);
    });

    test('AC-10 (#66) exits non-zero when it named a record', () => {
      assert.notEqual(result.status, 0);
    });

    for (const [path, text] of Object.entries(CANNOT)) {
      test(`AC-10 (#66) leaves ${path} (${reason[path]}) unchanged and names it`, () => {
        assert.equal(read(dir, path), text);
        assert.ok(result.stderr.includes(path), `stderr does not name ${path}:\n${result.stderr}`);
      });
    }

    test('AC-10 (#66) still migrates the records it can read', () => {
      assert.equal(frontMatter(read(dir, 'docs/adr/0001-a.md'))?.fields.status, 'accepted');
    });
  });
});
