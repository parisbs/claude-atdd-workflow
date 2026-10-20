// Issue #11 (ADR 0010, 0011, 0012): the global Delegation section says which agent does what, who may
// act on GitHub, when the orchestrator may merge, and when to stop. Static checks over the text: they
// prove the statements are present, not that they read well. What must always hold is enforced by the
// hooks, not by this prose (ADR 0002).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeClaude } from './fake-claude.mjs';

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

  test('AC-5 (#5) lists the authenticated gh user and forks among the Delegation merge conditions', () => {
    const conditions = delegation.split(/\n(?=- )/).find((bullet) => /merg[\s\S]*without\s+asking/i.test(bullet)) ?? '';
    assert.match(conditions, /author|opened by/i);
    assert.match(conditions, /authenticat[\s\S]{0,80}\bgh\b|\bgh\b[\s\S]{0,80}authenticat/i);
    assert.match(conditions, /\bforks?\b/i);
  });

  test('AC-5 (#5) records the author and fork merge conditions in a new ADR citing ADR 0010', () => {
    const adrs = join(repo, 'docs', 'adr');
    const records = readdirSync(adrs)
      .filter((name) => /^\d{4}-.*\.md$/.test(name) && Number(name.slice(0, 4)) > 22)
      .map((name) => readFileSync(join(adrs, name), 'utf8'));
    const record = records.find((text) => /\bisCrossRepository\b/.test(text));
    assert.ok(record, 'no ADR numbered above 0022 mentions isCrossRepository');
    assert.match(record, /\b0010\b/);
    assert.match(record, /author|opened by/i);
    assert.match(record, /authenticat[\s\S]{0,80}\bgh\b|\bgh\b[\s\S]{0,80}authenticat/i);
    assert.match(record, /\bforks?\b/i);
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
    assert.ok(lines <= 45, `the Delegation section has ${lines} lines; keep it to 45 or fewer`);
  });
});

// Issue #57 (ADR 0017): every poll is a full request over the whole context, and every large result is
// re-read on every later request, so the orchestrator waits instead of polling and reads by range. The
// Codex worktree steps moved to task-package's codex.md, read only when a delegation needs them.
const sentences = (text) =>
  text
    .split(/\n\s*(?:[-*]|\d+\.)\s+|\n\s*\n/)
    .flatMap((chunk) => chunk.replace(/\s+/g, ' ').split(/[.!?](?:\s|$)/))
    .map((sentence) => sentence.trim())
    .filter(Boolean);
const says = (text, ...patterns) =>
  assert.ok(
    sentences(text).some((sentence) => patterns.every((pattern) => pattern.test(sentence))),
    `no single sentence matches all of ${patterns.join(' and ')}`,
  );

describe('waiting and reading (#57)', () => {
  test('AC-10 (#57) the global instructions say to wait instead of polling', () => {
    says(instructions, /\bwait/i, /\bpoll/i, /\b(instead|never|not)\b/i);
  });

  test('AC-10 (#57) a Codex delegation is blocking', () => {
    says(instructions, /\bCodex\b/, /\bblocking\b/i);
  });

  test('AC-10 (#57) CI is waited on through the PR monitor or gh pr checks --watch', () => {
    says(instructions, /\bmonitor\b/i, /gh pr checks --watch/);
  });

  test('AC-10 (#57) local work runs as background commands', () => {
    says(instructions, /\bbackground\b/i, /\b(commands?|shell|Bash)\b/i);
  });

  test('AC-10 (#57) files and outputs are read by range', () => {
    says(instructions, /\bread\b/i, /\branges?\b/i);
  });

  test('AC-10 (#57) broad investigations go to claude-researcher', () => {
    says(instructions, /claude-researcher/, /\binvestigat/i);
  });

  test('AC-10 (#57) the Delegation section no longer carries the Codex worktree integration steps', () => {
    assert.doesNotMatch(delegation, /git worktree remove/);
    assert.doesNotMatch(delegation, /\bapply\b[^.]*\bdiff\b/i);
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
    // The installer registers MCP servers through `claude` (ADR 0014): a fake one stands in, so the test
    // does not depend on the CLI being installed, which CI does not have.
    const claude = fakeClaude(mkdtempSync(join(tmpdir(), 'cw-delegation-claude-')));
    const run = (...args) => spawnSync(process.execPath, [join(repo, 'scripts', 'install.mjs'), '--target', target, ...args], { encoding: 'utf8', env: { ...process.env, ...claude.env() } });
    assert.equal(run().status, 0);
    const check = run('--check');
    assert.equal(check.status, 0, check.stdout);
    assert.match(check.stdout, /matches the repository/);
    rmSync(target, { recursive: true, force: true });
    rmSync(dirname(claude.bin), { recursive: true, force: true });
  });
});
