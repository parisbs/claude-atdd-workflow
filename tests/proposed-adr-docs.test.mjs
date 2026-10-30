// Issue #76: ADR work is done only after human acceptance or a standalone proposed record.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('AC-10 pr-prep runs the installed proposed ADR check and stops for the human choice', () => {
  const text = read('global/skills/pr-prep/SKILL.md');
  assert.match(text, /node\s+[^\n]*proposed-adr-check\.mjs/);
  const step = text.split(/\n\s*\n/).find((block) => block.includes('proposed-adr-check.mjs'));
  assert.match(step, /stop|pause|ask/i);
  assert.match(text, /accept/i);
  assert.match(text, /split|separate|own pull request/i);
  assert.match(text, /experiment/i);
});

test('AC-10 task-package defines done as human acceptance in the applying PR or proposed merged alone', () => {
  const text = read('global/skills/task-package/SKILL.md');
  const block = text.split(/\n\s*\n/).find((part) => /(?:ADR|record)/i.test(part) && /proposed/i.test(part));
  assert.ok(block, 'task-package must define done for proposed ADR work');
  assert.match(block, /done|complet|acceptance criteria/i);
  assert.match(block, /human/i);
  assert.match(block, /accept/i);
  assert.match(block, /pull request|\bPR\b/i);
  assert.match(block, /appl|implement/i);
  assert.match(block, /merg/i);
  assert.match(block, /alone|own|separate|standalone/i);
});

test('AC-10 Delegation merge conditions name proposed records with other paths and the experiment label', () => {
  const text = read('global/CLAUDE.md');
  const section = /^## Delegation\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(text)?.[1];
  assert.ok(section, 'Delegation section must exist');
  const condition = section.split(/\n(?=- )/).find((part) => /orchestrator/i.test(part) && /merg/i.test(part) && /proposed/i.test(part));
  assert.ok(condition, 'orchestrator merge conditions must mention proposed records');
  assert.match(condition, /record|ADR/i);
  assert.match(condition, /other|outside/i);
  assert.match(condition, /path|file/i);
  assert.match(condition, /label/i);
  assert.match(condition, /experiment/);
});
