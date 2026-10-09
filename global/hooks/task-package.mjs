#!/usr/bin/env node
// Prints the mechanical fields; the orchestrator selects what the task touches.
// Read the schema from the Codex reference so both entry points share one source.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from './lib.mjs';
import { isTest, oracleTag, testMatchers } from './oracle.mjs';

function section(text, heading) {
  const start = new RegExp(`^## ${heading}[ \\t]*\\r?\\n`, 'm').exec(text);
  return start && text.slice(start.index + start[0].length).split(/^## /m)[0].trim();
}

function main() {
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  if (!root) throw new Error('not inside a git repository');
  const instructions = join(root, 'CLAUDE.md');
  const text = existsSync(instructions) ? readFileSync(instructions, 'utf8') : '';
  const tag = oracleTag(root);
  const oracleCommit = tag && git(root, ['rev-parse', `${tag}^{commit}`]);
  const matchers = tag && testMatchers(root, tag);
  const frozen = tag && git(root, ['ls-tree', '-r', '--name-only', '-z', tag])
    ?.split('\0').filter((path) => path && isTest(matchers, path)).join('\n');
  const reference = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'task-package', 'codex.md');
  const codex = existsSync(reference) ? readFileSync(reference, 'utf8') : '';
  const schema = [...codex.matchAll(/```json\n([\s\S]*?)\n```/g)]
    .map((match) => JSON.parse(match[1])).find((candidate) => candidate?.properties?.status);
  const fields = {
    Invariants: section(text, 'Invariants'),
    Conventions: section(text, 'Conventions'),
    'Verify command': /^- Verify: `([^`]+)`/m.exec(text)?.[1],
    'Base commit': git(root, ['rev-parse', 'HEAD']),
    Oracle: oracleCommit && `${tag} ${oracleCommit}`,
    'Frozen test files': frozen,
    'Report schema': schema && JSON.stringify(schema, null, 2),
  };
  for (const [label, value] of Object.entries(fields)) console.log(`${label}: ${value || 'none'}`);
  if (git(root, ['--no-optional-locks', 'status', '--porcelain'])) {
    console.error('Uncommitted changes and untracked files are absent from a Codex worktree.');
  }
}

try {
  main();
} catch (error) {
  console.error(`task-package: ${error.message}`);
  process.exit(1);
}
