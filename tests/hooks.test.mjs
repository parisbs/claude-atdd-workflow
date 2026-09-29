// Tests for the user-level hooks. Each case runs the hook as Claude Code would:
// a JSON event on stdin, the decision on stdout.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const hooks = join(dirname(fileURLToPath(import.meta.url)), '..', 'global', 'hooks');

function run(hook, event) {
  const result = spawnSync(process.execPath, [join(hooks, hook)], {
    input: JSON.stringify(event),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  if (result.stdout.trim() === '') return { decision: 'allow' };
  const out = JSON.parse(result.stdout).hookSpecificOutput;
  return { decision: out.permissionDecision, reason: out.permissionDecisionReason };
}

function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'cw-hooks-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'Test');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  sh(dir, 'config', 'tag.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'x\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'chore: init');
  return dir;
}

const bash = (cwd, command) => run('guard-git.mjs', { cwd, tool_name: 'Bash', tool_input: { command } });
const edit = (cwd, file_path) => run('guard-tests.mjs', { cwd, tool_name: 'Edit', tool_input: { file_path } });

describe('guard-git', () => {
  let dir;
  before(() => { dir = repo(); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('denies a commit on main once it has history', () => {
    assert.equal(bash(dir, 'git commit -m "feat: x"').decision, 'deny');
  });

  test('allows a commit on a feature branch', () => {
    sh(dir, 'checkout', '-q', '-b', 'feature/x');
    assert.equal(bash(dir, 'git add . && git commit -m "feat: x"').decision, 'allow');
    sh(dir, 'checkout', '-q', 'main');
  });

  test('allows the first commit of an empty repository', () => {
    const empty = mkdtempSync(join(tmpdir(), 'cw-empty-'));
    sh(empty, 'init', '-q', '-b', 'main');
    assert.equal(bash(empty, 'git commit -m "chore: init"').decision, 'allow');
    rmSync(empty, { recursive: true, force: true });
  });

  test('denies --no-verify', () => {
    sh(dir, 'checkout', '-q', '-b', 'feature/nv');
    assert.equal(bash(dir, 'git commit --no-verify -m "feat: x"').decision, 'deny');
    assert.equal(bash(dir, 'git push --no-verify origin feature/nv').decision, 'deny');
    sh(dir, 'checkout', '-q', 'main');
  });

  test('asks before the first publication of main', () => {
    assert.equal(bash(dir, 'git push -u origin main').decision, 'ask');
  });

  test('denies a push to a published main', () => {
    sh(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.equal(bash(dir, 'git push origin main').decision, 'deny');
    assert.equal(bash(dir, 'git push').decision, 'deny');
    assert.equal(bash(dir, 'git push --force origin feature/y:main').decision, 'deny');
  });

  test('asks for a force push to a feature branch', () => {
    assert.equal(bash(dir, 'git push --force-with-lease origin feature/y').decision, 'ask');
  });

  test('follows cd and git -C to the right repository', () => {
    const other = mkdtempSync(join(tmpdir(), 'cw-other-'));
    sh(other, 'init', '-q', '-b', 'main');
    assert.equal(bash(other, `cd ${dir} && git commit -m "feat: x"`).decision, 'deny');
    assert.equal(bash(other, `git -C ${dir} commit -m "feat: x"`).decision, 'deny');
    rmSync(other, { recursive: true, force: true });
  });

  test('requires squash and forbids --admin on gh pr merge', () => {
    assert.equal(bash(dir, 'gh pr merge 12 --squash --delete-branch').decision, 'allow');
    assert.equal(bash(dir, 'gh pr merge 12 --merge').decision, 'deny');
    assert.equal(bash(dir, 'gh pr merge 12 --squash --admin').decision, 'deny');
  });

  test('asks before acting on a remote Supabase project', () => {
    assert.equal(bash(dir, 'supabase db push').decision, 'ask');
    assert.equal(bash(dir, 'npx supabase link --project-ref abc').decision, 'ask');
    assert.equal(bash(dir, 'supabase db reset').decision, 'allow');
  });

  test('protects oracle tags from the agent', () => {
    assert.equal(bash(dir, 'git tag -d oracle/feature/x').decision, 'deny');
    assert.equal(bash(dir, 'git tag -f oracle/feature/x HEAD').decision, 'deny');
    assert.equal(bash(dir, 'git tag oracle/feature/x').decision, 'allow');
  });

  test('ignores commands it does not govern', () => {
    assert.equal(bash(dir, 'ls -la && echo "git push origin main"').decision, 'allow');
  });
});

describe('guard-tests', () => {
  let dir;
  before(() => {
    dir = repo();
    sh(dir, 'checkout', '-q', '-b', 'feature/login');
    mkdirSync(join(dir, 'app/src/test/kotlin'), { recursive: true });
    writeFileSync(join(dir, 'app/src/test/kotlin/LoginTest.kt'), 'class LoginTest\n');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('allows everything while no oracle tag exists', () => {
    assert.equal(edit(dir, join(dir, 'app/src/test/kotlin/LoginTest.kt')).decision, 'allow');
  });

  test('freezes test paths once the oracle is tagged', () => {
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'test: add login acceptance tests');
    sh(dir, 'tag', 'oracle/feature/login');
    assert.equal(edit(dir, join(dir, 'app/src/test/kotlin/LoginTest.kt')).decision, 'deny');
    assert.equal(edit(dir, 'app/src/androidTest/kotlin/New.kt').decision, 'deny');
    assert.equal(edit(dir, join(dir, 'test/widget_test.dart')).decision, 'deny');
    assert.equal(edit(dir, join(dir, 'supabase/tests/rls.sql')).decision, 'deny');
  });

  test('allows production code and asks for test configuration', () => {
    assert.equal(edit(dir, join(dir, 'app/src/main/kotlin/Login.kt')).decision, 'allow');
    assert.equal(edit(dir, join(dir, 'app/build.gradle.kts')).decision, 'ask');
  });

  test('uses the test paths recorded in the oracle commit', () => {
    sh(dir, 'checkout', '-q', '-b', 'feature/custom');
    mkdirSync(join(dir, '.atdd'), { recursive: true });
    writeFileSync(join(dir, '.atdd/test-paths'), '# frozen\nspecs/**\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'test: declare test paths');
    sh(dir, 'tag', 'oracle/feature/custom');
    assert.equal(edit(dir, join(dir, 'specs/a/b.kt')).decision, 'deny');
    assert.equal(edit(dir, join(dir, 'app/src/test/kotlin/LoginTest.kt')).decision, 'allow');
    assert.equal(edit(dir, join(dir, '.atdd/test-paths')).decision, 'deny');
  });

  test('ignores files outside a git repository', () => {
    const loose = mkdtempSync(join(tmpdir(), 'cw-loose-'));
    assert.equal(edit(loose, join(loose, 'test/a.dart')).decision, 'allow');
    rmSync(loose, { recursive: true, force: true });
  });
});

describe('oracle-check', () => {
  let dir;
  const check = () => spawnSync(process.execPath, [join(hooks, 'oracle-check.mjs')], { cwd: dir, encoding: 'utf8' });

  before(() => {
    dir = repo();
    sh(dir, 'checkout', '-q', '-b', 'feature/pay');
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'test/pay.test.ts'), "test('AC-1 pays', () => {});\n");
    writeFileSync(join(dir, 'package.json'), '{}\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'test: add acceptance tests');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('passes when there is no oracle tag', () => {
    assert.equal(check().status, 0);
  });

  test('passes when only production code changed', () => {
    sh(dir, 'tag', 'oracle/feature/pay');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/pay.ts'), 'export const pay = () => 1;\n');
    const r = check();
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /test paths: unchanged/);
  });

  test('reports configuration changes without failing', () => {
    writeFileSync(join(dir, 'package.json'), '{"scripts":{}}\n');
    const r = check();
    assert.equal(r.status, 0);
    assert.match(r.stdout, /test configuration changed[\s\S]*package\.json/);
  });

  test('fails when a test changed, committed or not, and reports added skips', () => {
    writeFileSync(join(dir, 'test/pay.test.ts'), "test.skip('AC-1 pays', () => {});\n");
    const r = check();
    assert.equal(r.status, 1);
    assert.match(r.stdout, /test paths changed[\s\S]*test\/pay\.test\.ts/);
    assert.match(r.stdout, /skip annotations added/);
  });
});
