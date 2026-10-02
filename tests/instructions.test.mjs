// Issue #18 (ADR 0012): repositories keep their instructions in CLAUDE.md alone, so nothing the
// workflow ships may send an agent to an AGENTS.md. These are static checks over the files: they
// prove a name is present or absent, not that an instruction reads well.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(repo, path), 'utf8');
const skill = (name) => read(`global/skills/${name}/SKILL.md`);

function walk(path) {
  const full = join(repo, path);
  if (!existsSync(full)) return [];
  if (!statSync(full).isDirectory()) return [path];
  return readdirSync(full).flatMap((name) => (name === '.DS_Store' ? [] : walk(join(path, name))));
}

describe('instruction files', () => {
  test('AC-1 the skills that read repository instructions take them from CLAUDE.md', () => {
    for (const name of ['pr-prep', 'atdd-oracle', 'atdd-implement', 'issue-draft', 'adr-draft', 'release-prep']) {
      const text = skill(name);
      assert.ok(text.includes('CLAUDE.md'), `${name} does not name CLAUDE.md`);
      assert.ok(!text.includes('AGENTS.md'), `${name} still names AGENTS.md`);
    }
  });

  test('AC-1 drift-audit and repo-bootstrap still name CLAUDE.md', () => {
    for (const name of ['drift-audit', 'repo-bootstrap']) {
      assert.ok(skill(name).includes('CLAUDE.md'), `${name} does not name CLAUDE.md`);
    }
  });

  test('AC-2 the stack files put their rules in CLAUDE.md', () => {
    for (const stack of ['android', 'flutter', 'node-mcp', 'supabase']) {
      const text = read(`${stack}/stack.md`);
      assert.match(text, /^## Rules for CLAUDE\.md$/m, `${stack}/stack.md has no "Rules for CLAUDE.md" heading`);
      assert.ok(!text.includes('AGENTS.md'), `${stack}/stack.md still names AGENTS.md`);
    }
  });

  test("AC-3 the global instructions name the repository's CLAUDE.md and never AGENTS.md", () => {
    const text = read('global/CLAUDE.md');
    assert.ok(!text.includes('AGENTS.md'), 'global/CLAUDE.md still names AGENTS.md');
    assert.match(text, /A repository's own `CLAUDE\.md`/, 'the sentence on whose instructions win does not name CLAUDE.md');
  });

  test('AC-4 the README and the roadmap describe CLAUDE.md alone', () => {
    for (const file of ['README.md', 'docs/ROADMAP.md']) {
      assert.ok(!read(file).includes('AGENTS.md'), `${file} still names AGENTS.md`);
    }
    const phase3 = read('docs/ROADMAP.md').split('## Phase 3')[1]?.split('\n## ')[0] ?? '';
    assert.ok(phase3.includes('CLAUDE.md'), 'phase 3 of the roadmap does not describe CLAUDE.md');
  });

  test('AC-5 drift-audit reports a stray AGENTS.md and a CLAUDE.md that only imports it, with the migration', () => {
    const text = skill('drift-audit');
    assert.match(text, /stray `AGENTS\.md`/i);
    assert.match(text, /only imports/i);
    assert.match(text, /migrat/i);
  });

  // The places that must name AGENTS.md: the audit that reports it, the bootstrap that migrates it
  // (until issue #10 rewrites it), and the control-plane list that keeps a stray one reaching the human.
  const ALLOWED = [
    'global/skills/drift-audit/SKILL.md',
    'global/skills/repo-bootstrap/SKILL.md',
    'global/hooks/controlplane.mjs',
  ];
  // common/ belongs to issue #10, and merged ADRs are never edited.
  const SCANNED = ['global', 'android', 'flutter', 'node-mcp', 'supabase', 'README.md', 'docs/ROADMAP.md'];

  test('AC-6 nothing outside the allowlist names AGENTS.md', () => {
    const offenders = SCANNED.flatMap(walk)
      .map((file) => file.split('\\').join('/'))
      .filter((file) => !ALLOWED.includes(file))
      .filter((file) => read(file).includes('AGENTS.md'));
    assert.deepEqual(offenders, [], `files that still name AGENTS.md: ${offenders.map((f) => relative('', f)).join(', ')}`);
  });

  test('AC-6 every file on the allowlist still needs to name AGENTS.md', () => {
    for (const file of ALLOWED) {
      assert.ok(read(file).includes('AGENTS.md'), `${file} no longer names AGENTS.md: remove it from the allowlist`);
    }
  });
});
