// Issue #76: local preparation blocks mixed work; CI only reports it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { fixtureGit, GIT_ENV } from './git-fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ADR = 'docs/adr/0001-choice.md';
const OTHER = 'docs/releasing.md';
const record = (status) => `---\nstatus: ${status}\ndate: 2026-10-30\n---\n# 0001. Choice\n\n## Context\n\nA choice.\n`;

function repository(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cw-proposed-adr-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  function git(...args) {
    const result = fixtureGit(dir, ...args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  }
  function write(path, text) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  function commit() {
    git('add', '-A');
    git('commit', '-qm', 'test: fixture');
  }
  function addRecord(status = 'proposed', index = true) {
    write(ADR, record(status));
    if (index) write('docs/adr/README.md', '# Decisions\n\n- [0001. Choice](0001-choice.md)\n');
  }
  function run(script, args = []) {
    const result = spawnSync(process.execPath, [join(ROOT, script), ...args], {
      cwd: dir, env: GIT_ENV, encoding: 'utf8', timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  }
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  write(OTHER, 'Base release guide.\n');
  write('docs/adr/README.md', '# Decisions\n');
  commit();
  git('checkout', '-qb', 'feature/choice');
  return { git, write, commit, addRecord, run };
}

function blocks(result) {
  assert.notEqual(result.status, 0, 'mixed work must exit non-zero');
  const output = result.stdout + result.stderr;
  for (const path of [ADR, OTHER]) assert.ok(output.includes(path), `missing ${path}: ${output}`);
  assert.match(output, /accept[\s\S]*(?:this|same)[\s\S]*branch/i);
  assert.match(output, /(?:move|split|separat)[\s\S]*(?:own|separate)[\s\S]*(?:pull request|PR)\b/i);
}

for (const kind of ['committed mixed branch', 'committed record and unstaged tracked path', 'committed record and staged tracked path', 'untracked record and committed other path']) {
  test(`AC-8 blocks ${kind} using main by default`, (t) => {
    const f = repository(t);
    if (kind === 'untracked record and committed other path') {
      f.write(OTHER, 'Changed guide.\n');
      f.commit();
      f.addRecord();
    } else {
      f.addRecord();
      if (kind === 'committed mixed branch') f.write(OTHER, 'Changed guide.\n');
      f.commit();
      if (kind !== 'committed mixed branch') {
        f.write(OTHER, 'Uncommitted guide.\n');
        if (kind === 'committed record and staged tracked path') f.git('add', OTHER);
      }
    }
    blocks(f.run('global/hooks/proposed-adr-check.mjs'));
  });
}

test('AC-8 accepts an explicit base and compares from its merge base', (t) => {
  const f = repository(t);
  f.git('branch', 'integration');
  f.addRecord('Proposed, awaiting review');
  f.write(OTHER, 'Changed guide.\n');
  f.commit();
  // A direct diff against integration would see identical other-path content and miss the mixed branch.
  f.git('checkout', '-q', 'integration');
  f.write(OTHER, 'Changed guide.\n');
  f.commit();
  f.git('checkout', '-q', 'feature/choice');
  blocks(f.run('global/hooks/proposed-adr-check.mjs', ['integration']));
});

for (const kind of ['proposed record and index only', 'accepted record and other path', 'no records']) {
  test(`AC-8 allows ${kind}`, (t) => {
    const f = repository(t);
    if (kind !== 'no records') f.addRecord(kind.startsWith('accepted') ? 'accepted' : 'proposed');
    if (kind !== 'proposed record and index only') f.write(OTHER, 'Changed guide.\n');
    f.commit();
    const result = f.run('global/hooks/proposed-adr-check.mjs');
    assert.equal(result.status, 0, result.stderr);
  });
}

for (const index of [true, false]) {
  test(`AC-9 mixed branch prints a notice and ${index ? 'exits zero' : 'preserves a real index failure'}`, (t) => {
    const f = repository(t);
    f.addRecord('proposed', index);
    f.write(OTHER, 'Changed guide.\n');
    f.commit();
    const result = f.run('scripts/check-adrs.mjs', ['main']);
    assert.equal(result.status, index ? 0 : 1, result.stderr);
    if (index) assert.equal(result.stderr, '');
    else {
      assert.ok(result.stderr.includes(ADR), result.stderr);
      assert.match(result.stderr, /missing from.*README\.md/i);
    }
    for (const path of [ADR, OTHER]) assert.ok(result.stdout.includes(path), `notice missing ${path}: ${result.stdout}`);
    assert.match(result.stdout, /proposed/i);
  });
}

for (const kind of ['proposed record and index only', 'accepted record and other path', 'no records']) {
  test(`AC-9 ${kind} prints no mixed-change notice`, (t) => {
    const f = repository(t);
    if (kind !== 'no records') f.addRecord(kind.startsWith('accepted') ? 'accepted' : 'proposed');
    if (kind !== 'proposed record and index only') f.write(OTHER, 'Changed guide.\n');
    f.commit();
    const result = f.run('scripts/check-adrs.mjs', ['main']);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /proposed|mixed|0001-choice\.md/i);
  });
}
