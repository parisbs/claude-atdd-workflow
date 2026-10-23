// Issue #44: the labels the workflow relies on ship in common/github/labels.json, and the project
// Human merge: line covers every stack template the installer ships and the tests. Static checks over
// the files: the label names in use are read from the hooks and the installed instructions, and the
// stacks from scripts/install.mjs, so a new label or stack cannot drift out of either list. The
// extractions are words read as patterns, so each one is also checked against the forms it must see.
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

const literals = (text) => [...(text ?? '').matchAll(/(['"`])([^'"`\n]+)\1/g)].map((match) => match[2]);

// A label read by code: compared with a literal on either side, tested with includes or has, listed
// in a constant whose name says LABEL, compared inside labels.some or a sibling, or a case of a switch
// over a label. Operands may span lines.
const LABEL = String.raw`\blabels?\b`;
const OPERAND = String.raw`[\w.()\[\]?]*`;
const LIT = String.raw`(['"\x60])([^'"\x60\n]+)\1`;
const HOOK_FORMS = [
  new RegExp(String.raw`${LABEL}${OPERAND}\s*[!=]==?\s*${LIT}`, 'gi'),
  new RegExp(String.raw`${LIT}\s*[!=]==?\s*${OPERAND}${LABEL}`, 'gi'),
  new RegExp(String.raw`${LABEL}${OPERAND}\.(?:includes|has|startsWith|endsWith|indexOf)\(\s*${LIT}`, 'gi'),
];
const comparedIn = (text) => {
  const compared = new RegExp(String.raw`[!=]==?\s*${LIT}|${LIT}\s*[!=]==?`, 'g');
  return [...text.matchAll(compared)].map((match) => match[2] ?? match[4]);
};
const caseIn = (text) => [...text.matchAll(/\bcase\s+(['"`])([^'"`\n]+)\1/g)].map((match) => match[2]);
const HOOK_GROUPS = [
  // ['a', 'b'].includes(label.name), new Set(['a']).has(name.label)
  [new RegExp(String.raw`(\[[^\]]*\])\)?\s*\.(?:includes|has|some|indexOf)\(\s*${OPERAND}${LABEL}`, 'gi'), literals],
  // const NEEDS_HUMAN_LABEL = 'needs-human'; const BLOCKING_LABELS = new Set(['a', 'b']);
  [/\b\w*LABELS?\w*\s*=\s*(?:new Set\(\s*)?(\[[^\]]*\]|(['"`])[^'"`\n]+\2)/g, literals],
  // pr.labels.some((l) => l.name === 'a')
  [new RegExp(String.raw`${LABEL}\s*\.(?:some|every|find|findIndex|filter)\(([^;]*)`, 'gi'), comparedIn],
  // switch (label.name) { case 'a': ... }
  [new RegExp(String.raw`switch\s*\([^)]*${LABEL}[^)]*\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}`, 'gi'), caseIn],
];

function hookLabelsIn(text) {
  const found = new Set();
  for (const re of HOOK_FORMS) for (const match of text.matchAll(re)) found.add(match[2]);
  for (const [re, names] of HOOK_GROUPS) for (const match of text.matchAll(re)) for (const name of names(match[1])) found.add(name);
  return found;
}

// A label named in backticks by prose: "carry `x`", "label `x`", "labels `x` and `y`", "label: `x`",
// "labelled with `x`", "`x` label", "the `x` and `y` labels", "`x`-labelled", "`x` issues".
const TICKED = '`[^`\\n]+`';
const LIST = String.raw`((?:${TICKED}(?:\s*,\s*(?:(?:and|or)\s+)?|\s+(?:and|or)\s+))*${TICKED})`;
const INSTRUCTION_FORMS = [
  new RegExp(String.raw`\b(?:carry|carries|carrying|label|labels|labelled|labeled)(?:\s*:|\s+(?:with|as))?\s+${LIST}`, 'gi'),
  new RegExp(String.raw`${LIST}(?:\s+|\s*-\s*)(?:labels?|labelled|labeled|issues?)\b`, 'gi'),
];

function instructionLabelsIn(text) {
  const found = new Set();
  for (const re of INSTRUCTION_FORMS) {
    for (const match of text.matchAll(re)) for (const tick of match[1].matchAll(/`([^`\n]+)`/g)) found.add(tick[1]);
  }
  return found;
}

function collect(paths, extract) {
  const found = new Map();
  for (const path of paths) for (const name of extract(read(path))) found.set(name, path);
  return found;
}

const hookLabels = () => collect(walk('global/hooks').filter((p) => p.endsWith('.mjs')), hookLabelsIn);
const instructionLabels = () => collect(walk('global').filter((p) => p.endsWith('.md')), instructionLabelsIn);

function stacks() {
  const list = /\bconst STACKS = \[([^\]]*)\]/.exec(read('scripts/install.mjs'));
  assert.ok(list, 'scripts/install.mjs no longer declares const STACKS = [...]; follow its new source');
  const entries = list[1].split(',').map((entry) => entry.trim()).filter(Boolean);
  for (const entry of entries) {
    assert.match(entry, /^(['"])[^'"]+\1$/, `STACKS holds ${entry}, which is not a quoted literal; follow its new source`);
  }
  return entries.map((entry) => entry.slice(1, -1));
}

const covered = (path) => humanMergeMatchers(read('CLAUDE.md')).some((re) => re.test(path));

describe('labels shipped in common/github/labels.json', () => {
  test('AC-1 ships needs-human, every entry has exactly a name, a hex colour and a description, and names are unique', () => {
    const entries = labels();
    assert.ok(entries.some((label) => label.name === 'needs-human'), 'labels.json has no needs-human entry');
    for (const label of entries) {
      assert.deepEqual(Object.keys(label).sort(), ['color', 'description', 'name'], `unexpected keys in ${JSON.stringify(label)}`);
      assert.match(String(label.name), /^\S(.*\S)?$/, `label without a usable name: ${JSON.stringify(label)}`);
      assert.match(String(label.color), /^[0-9A-Fa-f]{6}$/, `${label.name} has no six-digit hex colour`);
      assert.ok(typeof label.description === 'string' && label.description.trim() !== '', `${label.name} has no description`);
    }
    const names = entries.map((label) => label.name.toLowerCase());
    assert.equal(new Set(names).size, names.length, `duplicate label names: ${names.join(', ')}`);
  });

  test('AC-2 the hook extraction sees every form a hook can read a label in', () => {
    const forms = {
      "String(label.name).toLowerCase() === 'a'": ['a'],
      "'a' !== label.name": ['a'],
      "pr.labels.some((l) => l.name\n  === 'a')": ['a'],
      "label.name\n  === 'a'": ['a'],
      "names.labels.includes('a')": ['a'],
      "['a', 'b'].includes(label.name)": ['a', 'b'],
      "new Set(['a']).has(label.name)": ['a'],
      "const NEEDS_HUMAN_LABEL = 'a';": ['a'],
      "const BLOCKING_LABELS = new Set(['a', 'b']);": ['a', 'b'],
      "switch (label.name) {\n  case 'a': return 1;\n  case \"b\": { return 2; }\n}": ['a', 'b'],
      "typeof pr.changedFiles === 'number' && Array.isArray(pr.labels)": [],
      "const PR_FIELDS = 'author,labels,url';": [],
      "label: ['list'],": [],
    };
    for (const [text, expected] of Object.entries(forms)) {
      assert.deepEqual([...hookLabelsIn(text)].sort(), expected, `extraction of ${JSON.stringify(text)}`);
    }
  });

  test('AC-2 every label a hook reads is in labels.json', () => {
    const found = hookLabels();
    assert.ok(found.has('needs-human'), 'the extraction no longer finds needs-human in guard-git; update the pattern');
    const names = labelNames();
    for (const [name, path] of found) assert.ok(names.has(name), `${path} reads the label ${name}, which labels.json does not ship`);
  });

  test('AC-3 the instruction extraction sees every form prose can name a label in', () => {
    const forms = {
      'does not carry `a`': ['a'],
      'the label `a`': ['a'],
      'the labels `a` and `b`': ['a', 'b'],
      'labels `a`, `b`, and `c`': ['a', 'b', 'c'],
      'label: `a`': ['a'],
      'labelled with `a`': ['a'],
      'labeled as `good first issue`': ['good first issue'],
      'the `a` label': ['a'],
      'the `a` and `b` labels': ['a', 'b'],
      '`a`-labelled issues': ['a'],
      '`a` issues': ['a'],
      'Labels from `common/github/labels.json` (`gh label create --force`).': [],
    };
    for (const [text, expected] of Object.entries(forms)) {
      assert.deepEqual([...instructionLabelsIn(text)].sort(), expected, `extraction of ${JSON.stringify(text)}`);
    }
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
