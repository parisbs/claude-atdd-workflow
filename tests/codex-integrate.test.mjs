// Issue #42 (ADR 0014): codex-integrate brings the uncommitted changes a codex-implementer run left in its
// Codex worktree into the work branch, runs oracle-check there, and removes the worktree only once the
// changes are applied. Each case builds a real repository and a worktree where Codex makes them,
// $CODEX_HOME/worktrees/<id>/<repository>, with CODEX_HOME pointed at a scratch directory.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'global', 'hooks', 'codex-integrate.mjs');

const scratch = [];
const tmp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

const codexHome = tmp('cw-integrate-home-');

function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function write(dir, path, content) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

// A work branch with a frozen oracle, as phase 2 of the ATDD workflow has it.
function workBranch() {
  const dir = tmp('cw-integrate-');
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'Test');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  sh(dir, 'config', 'tag.gpgsign', 'false');
  write(dir, 'README.md', 'base\n');
  write(dir, 'old.txt', 'to delete\n');
  write(dir, 'other.txt', 'other\n');
  write(dir, '.gitignore', 'node_modules/\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'chore: init');
  sh(dir, 'checkout', '-q', '-b', 'feature/x');
  write(dir, 'test/a.test.js', "test('AC-1 works', () => {});\n");
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'test: add acceptance tests');
  sh(dir, 'tag', 'oracle/feature/x');
  return dir;
}

let ids = 0;
function codexWorktree(dir) {
  ids += 1;
  const path = join(codexHome, 'worktrees', `w${ids}`, 'repo');
  mkdirSync(dirname(path), { recursive: true });
  sh(dir, 'worktree', 'add', '-q', '--detach', path, 'HEAD');
  return path;
}

const integrate = (cwd, ...args) =>
  spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: { ...process.env, CODEX_HOME: codexHome } });

const BINARY = Buffer.from([0, 1, 2, 3, 255, 254, 0, 10, 13, 0, 128]);

// The work branch as it stood: its commit and its working tree.
const snapshot = (dir) => ({ head: sh(dir, 'rev-parse', 'HEAD'), status: sh(dir, 'status', '--porcelain', '--untracked-files=all') });

describe('codex-integrate', () => {
  test('AC-5 applies a modification, a deletion, a new file and a binary file, leaves ignored files out, runs oracle-check and removes the worktree', () => {
    const dir = workBranch();
    const worktree = codexWorktree(dir);
    const head = sh(dir, 'rev-parse', 'HEAD');
    write(worktree, 'README.md', 'changed by codex\n');
    rmSync(join(worktree, 'old.txt'));
    write(worktree, 'src/new.txt', 'new\n');
    write(worktree, 'assets/logo.bin', BINARY);
    write(worktree, 'node_modules/dep.js', 'ignored\n');

    const r = integrate(dir, worktree);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), 'changed by codex\n');
    assert.equal(existsSync(join(dir, 'old.txt')), false, 'the deletion is applied');
    assert.equal(readFileSync(join(dir, 'src/new.txt'), 'utf8'), 'new\n');
    assert.deepEqual(readFileSync(join(dir, 'assets/logo.bin')), BINARY, 'the binary file arrives byte for byte');
    assert.equal(existsSync(join(dir, 'node_modules/dep.js')), false, 'ignored files stay out');
    assert.match(r.stdout, /oracle-check against oracle\/feature\/x/);
    assert.match(r.stdout, /test paths: unchanged/);
    assert.equal(existsSync(worktree), false, 'the worktree is removed once the changes are applied');
    assert.ok(!sh(dir, 'worktree', 'list', '--porcelain').includes(`w${ids}`), 'git no longer lists the worktree');
    assert.equal(sh(dir, 'rev-parse', 'HEAD'), head, 'the script does not commit');
  });

  test('AC-5 applies when the work branch moved with a commit to another file after the worktree was made', () => {
    const dir = workBranch();
    const worktree = codexWorktree(dir);
    write(dir, 'other.txt', 'moved on\n');
    sh(dir, 'commit', '-q', '-am', 'feat: move on');
    write(worktree, 'README.md', 'changed by codex\n');

    const r = integrate(dir, worktree);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), 'changed by codex\n');
    assert.equal(readFileSync(join(dir, 'other.txt'), 'utf8'), 'moved on\n');
    assert.equal(existsSync(worktree), false);
  });

  // Issue #64: a frozen test changed in the worktree stops the integration before anything is applied, so a
  // delegate's change to the oracle never reaches the work branch without the human (it replaces the case
  // where the changes were applied and the script exited 1).
  test('AC-11 (#64) applies nothing, keeps the worktree, exits 2 and names the test when the worktree changes a frozen test', () => {
    const dir = workBranch();
    const worktree = codexWorktree(dir);
    write(worktree, 'test/a.test.js', "test.skip('AC-1 works', () => {});\n");
    write(worktree, 'README.md', 'changed by codex\n');
    const before = snapshot(dir);

    const r = integrate(dir, worktree);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /test\/a\.test\.js/, 'it names the frozen test');
    assert.deepEqual(snapshot(dir), before, 'the work branch is untouched');
    assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), 'base\n', 'not even the other change is applied');
    assert.equal(existsSync(worktree), true, 'the worktree is kept');
    assert.equal(readFileSync(join(worktree, 'test/a.test.js'), 'utf8'), "test.skip('AC-1 works', () => {});\n");
  });

  test('AC-11 (#64) applies nothing, keeps the worktree, exits 2 and names the test when the worktree adds a file under a test path', () => {
    const dir = workBranch();
    const worktree = codexWorktree(dir);
    write(worktree, 'test/new.test.js', "test('AC-9 new', () => {});\n");
    write(worktree, 'README.md', 'changed by codex\n');
    const before = snapshot(dir);

    const r = integrate(dir, worktree);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /test\/new\.test\.js/, 'it names the added test');
    assert.deepEqual(snapshot(dir), before, 'the work branch is untouched');
    assert.equal(existsSync(join(dir, 'test/new.test.js')), false);
    assert.equal(existsSync(worktree), true, 'the worktree is kept');
  });

  test('AC-11 (#64) applies nothing, keeps the worktree, exits 2 and names the test when the worktree deletes a frozen test', () => {
    const dir = workBranch();
    const worktree = codexWorktree(dir);
    rmSync(join(worktree, 'test/a.test.js'));
    write(worktree, 'README.md', 'changed by codex\n');
    const before = snapshot(dir);

    const r = integrate(dir, worktree);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /test\/a\.test\.js/, 'it names the deleted test');
    assert.deepEqual(snapshot(dir), before, 'the work branch is untouched');
    assert.equal(existsSync(join(dir, 'test/a.test.js')), true, 'the frozen test is still on the work branch');
    assert.equal(existsSync(worktree), true, 'the worktree is kept');
  });

  test('AC-11 (#64) still applies a change to test configuration alone, exits 0 and reports it', () => {
    const dir = workBranch();
    const worktree = codexWorktree(dir);
    write(worktree, 'package.json', '{"scripts":{"test":"node --test"}}\n');

    const r = integrate(dir, worktree);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), '{"scripts":{"test":"node --test"}}\n');
    assert.match(r.stdout, /test configuration changed[\s\S]*package\.json/);
    assert.equal(existsSync(worktree), false, 'the worktree is removed once the changes are applied');
  });

  test('AC-6 exits 2 when the changes conflict with the work branch, leaving it untouched and keeping the worktree', () => {
    const dir = workBranch();
    const worktree = codexWorktree(dir);
    write(dir, 'README.md', 'changed by the orchestrator\n');
    sh(dir, 'commit', '-q', '-am', 'feat: change the readme');
    write(worktree, 'README.md', 'changed by codex\n');
    write(worktree, 'src/new.txt', 'new\n');
    const before = snapshot(dir);

    const r = integrate(dir, worktree);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /not[^.\n]*appl/i, 'it says the changes were not applied');
    assert.deepEqual(snapshot(dir), before, 'the work branch is untouched: no partial apply, no conflict markers, no rejects');
    assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), 'changed by the orchestrator\n');
    assert.equal(readFileSync(join(worktree, 'README.md'), 'utf8'), 'changed by codex\n', 'the worktree keeps its changes');
    assert.equal(readFileSync(join(worktree, 'src/new.txt'), 'utf8'), 'new\n');
  });

  test('AC-6 exits 2 without touching anything when the path is missing, is not a Codex worktree, or belongs to another repository', () => {
    const dir = workBranch();
    const plain = join(codexHome, 'worktrees', 'plain', 'repo');
    mkdirSync(plain, { recursive: true });
    const linked = join(tmp('cw-integrate-linked-'), 'repo');
    sh(dir, 'worktree', 'add', '-q', '--detach', linked, 'HEAD');
    write(linked, 'README.md', 'changed outside codex\n');
    const foreign = codexWorktree(workBranch());
    write(foreign, 'README.md', 'changed in another repository\n');
    const before = snapshot(dir);

    for (const [label, args] of [
      ['no argument', []],
      ['a path that does not exist', [join(codexHome, 'worktrees', 'missing', 'repo')]],
      ['a directory under worktrees that is not a git worktree', [plain]],
      ['a linked worktree that Codex did not make', [linked]],
      ['a Codex worktree of another repository', [foreign]],
    ]) {
      const r = integrate(dir, ...args);
      assert.equal(r.status, 2, `${label}: ${r.stdout}${r.stderr}`);
      assert.deepEqual(snapshot(dir), before, `${label}: the work branch is untouched`);
    }
    assert.equal(readFileSync(join(linked, 'README.md'), 'utf8'), 'changed outside codex\n');
    assert.equal(readFileSync(join(foreign, 'README.md'), 'utf8'), 'changed in another repository\n');
  });
});

// Review finding on #42: once the worktree is removed, the <id> directory Codex made around it is left
// empty under $CODEX_HOME/worktrees, where it looks like a worktree to anything that checks the path.
describe('codex-integrate cleanup', () => {
  test('AC-5 removes the empty directory Codex made around the worktree, and keeps one that holds anything else', () => {
    const dir = workBranch();
    const worktree = codexWorktree(dir);
    write(worktree, 'README.md', 'changed by codex\n');
    const r = integrate(dir, worktree);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(existsSync(dirname(worktree)), false, 'the empty <id> directory is removed');
    assert.equal(existsSync(join(codexHome, 'worktrees')), true, 'the worktrees directory itself stays');

    const kept = codexWorktree(dir);
    write(dirname(kept), 'other/file.txt', 'not ours\n');
    write(kept, 'other.txt', 'changed by codex\n');
    const again = integrate(dir, kept);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(existsSync(kept), false);
    assert.equal(readFileSync(join(dirname(kept), 'other/file.txt'), 'utf8'), 'not ours\n', 'a directory that holds anything else stays');
  });
});
