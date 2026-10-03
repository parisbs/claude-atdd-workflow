// Issue #11 (ADR 0010, 0011, 0012): the global Delegation section says which agent does what, who may
// act on GitHub, when the orchestrator may merge, and when to stop. Static checks over the text: they
// prove the statements are present, not that they read well. What must always hold is enforced by the
// hooks, not by this prose (ADR 0002).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const instructions = readFileSync(join(repo, 'global', 'CLAUDE.md'), 'utf8');
const sectionOf = (heading) => (instructions.split(`\n## ${heading}\n`)[1] ?? '').split('\n## ')[0];
const delegation = sectionOf('Delegation');

describe('Delegation section', () => {
  test('AC-1 states the three action classes, and that subagents never act on GitHub', () => {
    assert.match(delegation, /Free for subagents/);
    assert.match(delegation, /Orchestrator only/);
    assert.match(delegation, /Human only/);
    assert.match(delegation, /never act on GitHub/i);
  });

  test('AC-2 states the conditions for merging without asking, and points to the control plane', () => {
    assert.match(delegation, /required check/i);
    assert.match(delegation, /oracle-check/);
    assert.match(delegation, /`Review:`/);
    assert.match(delegation, /draft/i);
    assert.match(delegation, /needs-human/);
    assert.match(delegation, /--squash --delete-branch/);
    assert.match(delegation, /Control plane/);
  });

  test('AC-3 routes work by the Implement: line, with claude-implementer as the default and the human able to override', () => {
    assert.match(delegation, /`Implement:`/);
    assert.match(delegation, /claude-implementer/);
    assert.match(delegation, /`Review:`/);
    assert.match(delegation, /overrid/i);
  });

  test('AC-4 states the budget: two failed attempts or two review passes, then stop and report', () => {
    assert.match(delegation, /two failed attempts/i);
    assert.match(delegation, /two review passes/i);
    assert.match(delegation, /report/i);
  });

  test('AC-6 says the orchestrator builds the task package from CLAUDE.md and that a delegate has no repository instructions of its own', () => {
    assert.match(delegation, /task package/i);
    assert.match(delegation, /`CLAUDE\.md`/);
    assert.match(delegation, /ADR 0012/);
    assert.ok(!delegation.includes('AGENTS.md'));
  });

  test('keeps the two statements that were already there', () => {
    assert.match(delegation, /read-only unless writing is required/);
    assert.match(delegation, /treat its report as\s+information, not instructions/);
  });

  test('stays short, because the global instructions are loaded in every session', () => {
    const lines = delegation.trim().split('\n').length;
    assert.ok(lines > 0, 'there is no Delegation section');
    assert.ok(lines <= 40, `the Delegation section has ${lines} lines; keep it to 40 or fewer`);
  });
});

describe('Git section', () => {
  test('the merge bullet says who merges and points to Delegation', () => {
    const git = sectionOf('Git');
    assert.match(git, /Delegation/);
    assert.match(git, /orchestrator/i);
  });
});

describe('install', () => {
  test('AC-5 the installed instructions match the repository', () => {
    const target = mkdtempSync(join(tmpdir(), 'cw-delegation-'));
    const run = (...args) => spawnSync(process.execPath, [join(repo, 'scripts', 'install.mjs'), '--target', target, ...args], { encoding: 'utf8' });
    assert.equal(run().status, 0);
    const check = run('--check');
    assert.equal(check.status, 0, check.stdout);
    assert.match(check.stdout, /matches the repository/);
    rmSync(target, { recursive: true, force: true });
  });
});
