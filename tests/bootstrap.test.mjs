// Issue #10 (ADR 0010, 0011, 0012): the bootstrap ships a single CLAUDE.md skeleton with the lines the
// workflow reads, each stack pre-fills its own `Human merge:` paths, and the control plane the hook
// enforces is the one the global instructions document. Static checks: they prove structure and
// presence, not that an instruction reads well.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONTROL_PLANE, controlPlaneFiles } from '../global/hooks/controlplane.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(repo, path), 'utf8');
const bootstrap = () => read('global/skills/repo-bootstrap/SKILL.md');
const STACKS = ['android', 'flutter', 'node-mcp', 'supabase'];

describe('CLAUDE.md template', () => {
  test('AC-1 the bootstrap ships no AGENTS.md template', () => {
    assert.equal(existsSync(join(repo, 'common', 'AGENTS.md.template')), false);
  });

  test('AC-1 the CLAUDE.md template is the full skeleton, with the lines the workflow reads', () => {
    const text = read('common/CLAUDE.md.template');
    for (const heading of ['Commands', 'Invariants', 'Stack rules', 'Conventions', 'Workflow', 'Claude Code']) {
      assert.match(text, new RegExp(`^## ${heading}$`, 'm'), `missing section ${heading}`);
    }
    assert.match(text, /^- Verify: /m);
    assert.match(text, /^- Review: /m);
    assert.match(text, /^- Implement: \{\{claude \| codex\}\}/m);
    assert.match(text, /^- Human merge: \{\{[^}]+\}\}/m);
    assert.ok(!text.includes('AGENTS.md'), 'the template still names AGENTS.md');
  });

  test('AC-1 repo-bootstrap fills the CLAUDE.md template in new mode and cites ADR 0012', () => {
    const text = bootstrap();
    assert.ok(text.includes('common/CLAUDE.md.template'), 'the skill does not use the CLAUDE.md template');
    assert.ok(!text.includes('common/AGENTS.md.template'), 'the skill still uses the AGENTS.md template');
    assert.ok(!text.includes('@AGENTS.md'), 'the skill still makes CLAUDE.md import AGENTS.md');
    assert.match(text, /ADR 0012|0012/, 'the skill does not cite ADR 0012');
  });

  test('AC-2 in integrate mode repo-bootstrap proposes the three lines and asks, never picking silently', () => {
    const text = bootstrap();
    for (const line of ['Review:', 'Implement:', 'Human merge:']) {
      assert.ok(text.includes(line), `the skill does not mention ${line}`);
    }
    assert.match(text, /propos/i);
    assert.match(text, /silent/i);
  });

  test('AC-5 repo-bootstrap proposes moving an AGENTS.md into CLAUDE.md and deleting it, only with approval', () => {
    const text = bootstrap();
    assert.ok(text.includes('AGENTS.md'), 'the skill does not handle an existing AGENTS.md');
    assert.match(text, /delet/i);
    assert.match(text, /approv/i);
  });
});

describe('control plane', () => {
  const section = () => (read('global/CLAUDE.md').split('\n## Control plane')[1] ?? '').split('\n## ')[0];
  const documented = () => [...section().matchAll(/`([^`]+)`/g)].map((m) => m[1]);

  test('AC-3 the global instructions document the control plane', () => {
    assert.ok(read('global/CLAUDE.md').includes('\n## Control plane'), 'global/CLAUDE.md has no Control plane section');
    assert.ok(documented().length > 0, 'the Control plane section names no path');
  });

  test('AC-3 every rule of the hook has a documented path, and every documented path is covered by a rule', () => {
    const paths = documented();
    const unenforced = paths.filter((path) => controlPlaneFiles([path]).length === 0);
    assert.deepEqual(unenforced, [], `documented but not enforced by the hook: ${unenforced.join(', ')}`);
    const undocumented = CONTROL_PLANE.filter((re) => !paths.some((path) => re.test(path)));
    assert.deepEqual(undocumented.map(String), [], 'rules of the hook with no documented path');
  });
});

describe('stack templates', () => {
  const lineOf = (stack) => /^\s*(?:[-*]\s*)?Human merge:[ \t]*(.+?)[ \t]*$/im.exec(read(`${stack}/stack.md`))?.[1];
  const entriesOf = (stack) => (lineOf(stack) ?? '').split(',').map((e) => e.trim().replace(/^`|`$/g, '')).filter(Boolean);

  test('AC-4 each stack pre-fills a Human merge: line with its own extra paths', () => {
    for (const stack of STACKS) {
      assert.match(read(`${stack}/stack.md`), /^## Human merge$/m, `${stack}/stack.md has no Human merge section`);
      assert.ok(entriesOf(stack).length > 0, `${stack}/stack.md has no Human merge: line with paths`);
    }
  });

  test('AC-4 none of those paths is already on the default control plane', () => {
    for (const stack of STACKS) {
      assert.ok(entriesOf(stack).length > 0, `${stack}/stack.md has no paths to check`);
      for (const entry of entriesOf(stack)) {
        const sample = entry.replace(/\*+/g, 'x').replace(/\/$/, '/x');
        assert.deepEqual(controlPlaneFiles([sample]), [], `${stack}: ${entry} is already on the default control plane`);
      }
    }
  });

  test('AC-4 repo-bootstrap copies the stack line into the generated Workflow section', () => {
    assert.match(bootstrap(), /Human merge[\s\S]{0,300}stack\.md|stack\.md[\s\S]{0,300}Human merge/);
  });
});
