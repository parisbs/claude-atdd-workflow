// Issue #44: the labels the workflow relies on ship in common/github/labels.json, and the project
// Human merge: line covers every stack template the installer ships and the tests. Static checks over
// the files: the label names in use are read from the hooks and the installed instructions, and the
// stacks from scripts/install.mjs, so a new label or stack cannot drift out of either list.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { humanMergeMatchers } from '../global/hooks/controlplane.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(repo, path), 'utf8');
const labels = () => JSON.parse(read('common/github/labels.json'));
const labelNames = () => new Set(labels().map((label) => label.name));

function walk(path) {
  const full = join(repo, path);
  if (!existsSync(full)) return [];
  if (!statSync(full).isDirectory()) return [path];
  return readdirSync(full).flatMap((name) => (name === '.DS_Store' ? [] : walk(join(path, name))));
}

// A label compared with a string literal on the same line: `label.name === 'x'`, `labels ... !== "x"`.
const HOOK_LABEL = /\blabels?\b[^\n]*?[!=]==?\s*(['"])([^'"\n]+)\1/gi;
// A label named in backticks: "carry `x`", "label `x`", "labelled `x`", "`x` label", "`x` issues".
const INSTRUCTION_LABEL = [
  /\b(?:carry|carries|carrying|label|labelled|labeled)\s+`([a-z0-9][a-z0-9-]*)`/gi,
  /`([a-z0-9][a-z0-9-]*)`\s+(?:labels?|issues?)\b/gi,
];

function hookLabels() {
  const found = new Map();
  for (const path of walk('global/hooks').filter((p) => p.endsWith('.mjs'))) {
    for (const match of read(path).matchAll(HOOK_LABEL)) found.set(match[2], path);
  }
  return found;
}

function instructionLabels() {
  const found = new Map();
  for (const path of walk('global').filter((p) => p.endsWith('.md'))) {
    const text = read(path);
    for (const re of INSTRUCTION_LABEL) for (const match of text.matchAll(re)) found.set(match[1], path);
  }
  return found;
}

function stacks() {
  const list = /\bconst STACKS = \[([^\]]*)\]/.exec(read('scripts/install.mjs'));
  assert.ok(list, 'scripts/install.mjs no longer declares const STACKS = [...]; follow its new source');
  return [...list[1].matchAll(/(['"])([^'"]+)\1/g)].map((match) => match[2]);
}

const covered = (path) => humanMergeMatchers(read('CLAUDE.md')).some((re) => re.test(path));

describe('labels shipped in common/github/labels.json', () => {
  test('AC-1 ships needs-human, every entry has a name, a hex colour and a description, and names are unique', () => {
    const entries = labels();
    assert.ok(entries.some((label) => label.name === 'needs-human'), 'labels.json has no needs-human entry');
    for (const label of entries) {
      assert.match(String(label.name), /^\S(.*\S)?$/, `label without a usable name: ${JSON.stringify(label)}`);
      assert.match(String(label.color), /^[0-9A-Fa-f]{6}$/, `${label.name} has no six-digit hex colour`);
      assert.ok(typeof label.description === 'string' && label.description.trim() !== '', `${label.name} has no description`);
    }
    const names = entries.map((label) => label.name.toLowerCase());
    assert.equal(new Set(names).size, names.length, `duplicate label names: ${names.join(', ')}`);
  });

  test('AC-2 every label a hook compares with a literal is in labels.json', () => {
    const found = hookLabels();
    assert.ok(found.has('needs-human'), 'the extraction no longer finds needs-human in guard-git; update the pattern');
    const names = labelNames();
    for (const [name, path] of found) assert.ok(names.has(name), `${path} reads the label ${name}, which labels.json does not ship`);
  });

  test('AC-3 every label the installed instructions name is in labels.json', () => {
    const found = instructionLabels();
    for (const expected of ['needs-human', 'next']) {
      assert.ok(found.has(expected), `the extraction no longer finds ${expected} in global/; update the pattern`);
    }
    const names = labelNames();
    for (const [name, path] of found) assert.ok(names.has(name), `${path} names the label ${name}, which labels.json does not ship`);
  });
});

describe('the project Human merge: line', () => {
  test('AC-4 covers every stack template the installer ships', () => {
    const list = stacks();
    assert.ok(list.length > 0, 'no stacks read from scripts/install.mjs');
    for (const stack of list) assert.ok(covered(`${stack}/stack.md`), `Human merge: does not cover ${stack}/`);
  });

  test('AC-5 covers tests/ and still covers the directories it named before', () => {
    for (const path of ['tests/hooks.test.mjs', 'global/CLAUDE.md', 'scripts/install.mjs', 'personal/preferences.md', 'common/github/labels.json', 'docs/experiments/donated/sample.json']) {
      assert.ok(covered(path), `Human merge: does not cover ${path}`);
    }
  });
});
