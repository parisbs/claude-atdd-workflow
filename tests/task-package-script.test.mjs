// Issue #57 (ADR 0017): global/hooks/task-package.mjs prints the fields of a task package that the
// orchestrator would otherwise copy by hand: the Invariants and Conventions sections and the Verify line of
// the repository's CLAUDE.md, the base commit, the oracle with its frozen test files, and the report schema,
// read from task-package's codex.md so there is one source. Each case runs the real script with the
// repository as its working directory. The output is plain text under fixed labels, one field after another;
// a field's value is the rest of its label's line plus the lines up to the next label.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'global', 'hooks', 'task-package.mjs');
const LABELS = ['Invariants', 'Conventions', 'Verify command', 'Base commit', 'Oracle', 'Frozen test files', 'Report schema'];

const scratch = [];
const tmp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function write(dir, rel, text) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

const INVARIANTS = '- Rule one: keep the parser pure.\n- Rule two: never call `fetch` in tests.';
const CONVENTIONS = '- Commits follow Conventional Commits.\n- Code is in English.';
const VERIFY = 'npm test -- --reporter dot';

function claudeMd({ invariants = true, conventions = true, verify = true } = {}) {
  return [
    '# sample',
    '',
    '## Commands',
    '',
    verify ? `- Verify: \`${VERIFY}\`` : '- Install: `npm ci`',
    '',
    ...(invariants ? ['## Invariants', '', INVARIANTS, ''] : []),
    ...(conventions ? ['## Conventions', '', CONVENTIONS, ''] : []),
    '## Workflow',
    '',
    '- Review: none',
    '',
  ].join('\n');
}

// A repository on branch feature/x whose oracle tag sits on an earlier commit than HEAD: after the tag, a
// second test file and a source change are committed, so a script that reads HEAD instead of the tag shows.
function repo({ oracle = true, ...claude } = {}) {
  const dir = tmp('cw-task-package-');
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'Test');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  sh(dir, 'config', 'tag.gpgsign', 'false');
  write(dir, 'CLAUDE.md', claudeMd(claude));
  write(dir, 'src/parser.mjs', 'export const parse = () => 1;\n');
  write(dir, 'tests/parser.test.mjs', "import test from 'node:test';\ntest('AC-1 parses', () => {});\n");
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'chore: init');
  sh(dir, 'checkout', '-q', '-b', 'feature/x');
  const oracleCommit = sh(dir, 'rev-parse', 'HEAD');
  if (oracle) sh(dir, 'tag', 'oracle/feature/x', oracleCommit);
  write(dir, 'tests/later.test.mjs', "import test from 'node:test';\ntest('AC-2 later', () => {});\n");
  write(dir, 'src/parser.mjs', 'export const parse = () => 2;\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'feat: change the parser');
  return { dir, oracleCommit, head: sh(dir, 'rev-parse', 'HEAD') };
}

function runScript(cwd) {
  return spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
}

// The value of each label: the rest of its line plus the lines up to the next label.
function fields(stdout) {
  const out = {};
  let current;
  for (const line of stdout.split('\n')) {
    const label = LABELS.find((name) => line.startsWith(`${name}:`));
    if (label) {
      current = label;
      out[label] = line.slice(label.length + 1);
    } else if (current) {
      out[current] += `\n${line}`;
    }
  }
  for (const key of Object.keys(out)) out[key] = out[key].trim();
  return out;
}

// A field that must be present: its absence fails as an assertion, not as a type error.
function get(out, label) {
  assert.ok(label in out, `no "${label}:" field`);
  return out[label];
}

function codexSchema() {
  const file = join(root, 'global', 'skills', 'task-package', 'codex.md');
  assert.ok(existsSync(file), 'global/skills/task-package/codex.md is missing');
  const blocks = [...readFileSync(file, 'utf8').matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]));
  const schema = blocks.find((candidate) => candidate?.properties?.status);
  assert.ok(schema, 'codex.md has no report schema');
  return schema;
}

describe('task-package.mjs with every field present (#57)', () => {
  test('AC-7 (#57) prints every field under its label and exits 0', () => {
    const { dir } = repo();
    const r = runScript(dir);
    assert.equal(r.status, 0, r.stderr);
    const out = fields(r.stdout);
    for (const label of LABELS) assert.ok(label in out, `no "${label}:" field in:\n${r.stdout}`);
  });

  test('AC-7 (#57) prints the Invariants and Conventions sections verbatim, and nothing from other sections', () => {
    const { dir } = repo();
    const out = fields(runScript(dir).stdout);
    assert.equal(get(out, 'Invariants'), INVARIANTS);
    assert.equal(get(out, 'Conventions'), CONVENTIONS);
    assert.doesNotMatch(runScript(dir).stdout, /Review: none/);
  });

  test('AC-7 (#57) prints the command inside the backticks of the Verify line', () => {
    const { dir } = repo();
    assert.equal(get(fields(runScript(dir).stdout), 'Verify command'), VERIFY);
  });

  test('AC-7 (#57) prints the full HEAD hash as base commit, and the oracle tag with its own, earlier commit', () => {
    const { dir, oracleCommit, head } = repo();
    assert.notEqual(oracleCommit, head);
    const out = fields(runScript(dir).stdout);
    assert.match(get(out, 'Base commit'), new RegExp(`\\b${head}\\b`));
    assert.match(get(out, 'Oracle'), /\boracle\/feature\/x\b/);
    assert.match(get(out, 'Oracle'), new RegExp(`\\b${oracleCommit}\\b`));
    assert.doesNotMatch(get(out, 'Oracle'), new RegExp(`\\b${head}\\b`));
  });

  test('AC-7 (#57) lists as frozen only the test files in the oracle commit\'s tree', () => {
    const { dir } = repo();
    const frozen = get(fields(runScript(dir).stdout), 'Frozen test files');
    assert.match(frozen, /tests\/parser\.test\.mjs/);
    assert.doesNotMatch(frozen, /tests\/later\.test\.mjs/, 'a test added after the tag is not frozen');
    assert.doesNotMatch(frozen, /src\/parser\.mjs/, 'a source file is not a test');
  });

  test('AC-7 (#57) prints the report schema of codex.md', () => {
    const { dir } = repo();
    assert.deepEqual(JSON.parse(get(fields(runScript(dir).stdout), 'Report schema')), codexSchema());
  });
});

describe('task-package.mjs with a field missing (#57)', () => {
  const cases = [
    ['Invariants', { invariants: false }, ['Invariants']],
    ['Conventions', { conventions: false }, ['Conventions']],
    ['the Verify line', { verify: false }, ['Verify command']],
    ['the oracle tag', { oracle: false }, ['Oracle', 'Frozen test files']],
  ];
  for (const [what, options, missing] of cases) {
    test(`AC-8 (#57) without ${what}, prints none for that field, the others in full, and exits 0`, () => {
      const { dir, head } = repo(options);
      const r = runScript(dir);
      assert.equal(r.status, 0, r.stderr);
      const out = fields(r.stdout);
      for (const label of LABELS) assert.ok(label in out, `no "${label}:" field`);
      for (const label of missing) assert.equal(out[label], 'none', label);
      if (!missing.includes('Invariants')) assert.equal(get(out, 'Invariants'), INVARIANTS);
      if (!missing.includes('Conventions')) assert.equal(get(out, 'Conventions'), CONVENTIONS);
      if (!missing.includes('Verify command')) assert.equal(get(out, 'Verify command'), VERIFY);
      if (!missing.includes('Oracle')) assert.match(get(out, 'Oracle'), /oracle\/feature\/x/);
      assert.match(get(out, 'Base commit'), new RegExp(`\\b${head}\\b`));
      assert.deepEqual(JSON.parse(get(out, 'Report schema')), codexSchema());
    });
  }
});

describe('task-package.mjs with uncommitted changes, or outside git (#57)', () => {
  const warns = (r, label) => {
    assert.equal(r.status, 0, `${label}: ${r.stderr}`);
    assert.match(r.stderr, /uncommitted/i, `${label}: the warning names uncommitted changes`);
    assert.match(r.stderr, /Codex/, `${label}: the warning names Codex`);
    assert.match(r.stderr, /worktree/i, `${label}: the warning names the worktree`);
  };

  test('AC-8 (#57) warns on stderr about a modified tracked file, and exits 0', () => {
    const { dir } = repo();
    writeFileSync(join(dir, 'src', 'parser.mjs'), 'export const parse = () => 3;\n');
    warns(runScript(dir), 'modified');
  });

  test('AC-8 (#57) warns on stderr about an untracked file, and exits 0', () => {
    const { dir } = repo();
    writeFileSync(join(dir, 'notes.txt'), 'new\n');
    warns(runScript(dir), 'untracked');
  });

  test('AC-8 (#57) says nothing about uncommitted changes in a clean tree', () => {
    const { dir } = repo();
    const r = runScript(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /uncommitted/i);
  });

  test('AC-8 (#57) exits non-zero with a message outside a git repository', () => {
    const dir = tmp('cw-task-package-loose-');
    const r = runScript(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /\brepository\b/i, 'the message says it is not in a git repository');
    assert.doesNotMatch(r.stderr, /Cannot find module|ERR_MODULE_NOT_FOUND/, 'the script itself must run');
  });
});
