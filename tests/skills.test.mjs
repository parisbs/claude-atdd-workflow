// Issue #9 (ADR 0010, amended by issue #34 for task-package): the orchestrator may start the workflow's skills, except the two that
// publish or reconfigure. Static checks over each skill's frontmatter and text: they prove what is
// declared and said, not that the model picks the right skill at the right time.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'global', 'skills');
const text = (name) => readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');

function frontmatter(name) {
  const [, block = ''] = /^---\n([\s\S]*?)\n---/.exec(text(name)) ?? [];
  return Object.fromEntries(
    block.split('\n').map((line) => /^([A-Za-z-]+):\s*(.*)$/.exec(line)).filter(Boolean).map((m) => [m[1], m[2]]),
  );
}

const OPEN = ['issue-draft', 'adr-draft', 'drift-audit', 'pr-prep', 'atdd-implement', 'atdd-oracle', 'task-package'];
const MANUAL = ['release-prep', 'repo-bootstrap'];

describe('workflow skills', () => {
  test('AC-1 the seven skills the orchestrator may start do not disable model invocation', () => {
    for (const name of OPEN) {
      assert.equal(frontmatter(name)['disable-model-invocation'], undefined, `${name} still disables model invocation`);
    }
  });

  test('AC-2 release-prep and repo-bootstrap stay manual', () => {
    for (const name of MANUAL) {
      assert.equal(frontmatter(name)['disable-model-invocation'], 'true', `${name} must stay manual`);
    }
  });

  test('AC-3 issue-draft still stops before creating an issue without approval, and adr-draft before committing', () => {
    assert.match(text('issue-draft'), /only after\s+explicit\s+approval/);
    assert.match(text('adr-draft'), /Do not commit/);
  });

  test('AC-4 atdd-oracle says the guard asks before the oracle tag is created, and that this is the confirmation', () => {
    assert.match(text('atdd-oracle'), /guard asks/i);
  });

  test('AC-4 atdd-implement accepts a subagent as the fresh context', () => {
    assert.match(text('atdd-implement'), /subagent/i);
  });

  test('AC-5 each description of the seven states when to use the skill', () => {
    for (const name of OPEN) {
      assert.match(frontmatter(name).description ?? '', /\bUse (it )?(only )?when\b/i, `${name}: the description has no "Use when"`);
    }
  });

  test('ADR 0007 the nine skill names are unchanged and match their folders', () => {
    const folders = readdirSync(skillsDir).filter((entry) => !entry.startsWith('.')).sort();
    assert.deepEqual(folders, [...OPEN, ...MANUAL].sort());
    for (const name of folders) assert.equal(frontmatter(name).name, name);
  });
});
