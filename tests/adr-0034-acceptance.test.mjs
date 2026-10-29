// Issue #73: accepting ADR 0034 updates the invariants and status metadata without rewriting decided bodies.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { frontMatter, frontStatus } from './front-matter.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'd4f4707';
const read = (file) => readFileSync(join(root, file), 'utf8');
const normalize = (text) => text.replace(/\s+/g, ' ').trim();
const records = readdirSync(join(root, 'docs/adr'));
function record(number) {
  const file = records.find((name) => name.startsWith(`${number}-`));
  assert.ok(file, `ADR ${number} is missing`);
  return { file, text: read(`docs/adr/${file}`) };
}
function baseline(file) {
  const r = spawnSync('git', ['show', `${BASE}:${file}`], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' },
  });
  assert.equal(r.status, 0, `cannot read the committed baseline ${BASE}:${file}: ${r.stderr}`);
  return r.stdout;
}
const invariants = () => read('CLAUDE.md').split('\n## Invariants\n')[1]?.split('\n## ')[0] ?? '';
const bullet = (text, start) => normalize(text.split('\n').reduce((blocks, line) => {
  if (line.startsWith('- ')) blocks.push(line);
  else if (blocks.length) blocks[blocks.length - 1] += ` ${line}`;
  return blocks;
}, []).find((block) => block.startsWith(`- ${start}`)) ?? '');

describe('ADR 0034 acceptance (#73)', () => {
  test('AC-19 ADR 0034 is accepted', () => {
    assert.match(frontStatus(record('0034').text), /^accepted(?:\b|$)/);
  });

  test('AC-19 the safety-net invariant states the consequence rule of ADR 0034', () => {
    const text = bullet(invariants(), 'The hooks are a safety net');
    assert.ok(text.includes('The hooks are a safety net for one machine that limits what the agent does on its own, not a boundary: they read a command as words.'), text);
    assert.ok(text.includes('At the high-consequence gates of ADR 0034'), text);
    for (const gate of ['merge', 'push to a protected branch', 'oracle tags', 'release tags', 'skipped hooks',
      'GitHub actions of a subagent', 'remote Supabase actions']) assert.ok(text.includes(gate), `${gate}: ${text}`);
    assert.ok(text.includes("a command that reaches a gate's trigger and that they cannot read asks in the main session and is denied to subagents and in `bypassPermissions`; elsewhere they allow it."), text);
    assert.ok(text.includes('Two named exceptions remain: a hook that cannot start or times out fails open, except the merge entry, and `guard-tests` allows a program it does not know.'), text);
    assert.ok(text.includes('`guard-readonly` denies a form it cannot read.'), text);
    assert.doesNotMatch(text, /read a command as words and allow a form they cannot read/);
  });

  test('AC-19 frozen tests remain a named gap until A-12', () => {
    const text = normalize(invariants());
    assert.match(text, /(?:frozen[- ]test(?:s| gate)?|`guard-tests`)[^.\n]{0,220}(?:gap|pending|except|until)[^.\n]{0,160}A-12/i);
  });

  test('AC-19 the safety-net invariant keeps the human-review and CI text unchanged', () => {
    const current = bullet(invariants(), 'The hooks are a safety net');
    const previous = bullet(baseline('CLAUDE.md'), 'The hooks are a safety net');
    assert.ok(current.includes('That net,'));
    assert.equal(current.slice(current.indexOf('That net,')), previous.slice(previous.indexOf('That net,')));
  });

  test('AC-19 the fail-open invariant gains the deciding-exception sentence and keeps its other exceptions', () => {
    const text = bullet(invariants(), 'What must always hold');
    const sentence = 'A guard that throws while deciding a command that reaches a high-consequence gate of ADR 0034 asks or denies instead; a hook that cannot start or times out still fails open.';
    assert.ok(text.includes(sentence), text);
    assert.equal(normalize(text.replace(sentence, '')), bullet(baseline('CLAUDE.md'), 'What must always hold'));
  });

  for (const number of ['0002', '0010', '0013', '0029', '0030', '0032', '0033']) {
    test(`AC-19 ADR ${number} records amended by 0034 in its front matter status`, () => {
      const status = frontStatus(record(number).text);
      assert.match(status, /^accepted\b/);
      assert.match(status, /amended by/i);
      assert.ok(status.includes(`[0034](${record('0034').file})`), status);
    });
    test(`AC-19 ADR ${number} keeps its body byte for byte from main ${BASE}`, () => {
      const { file, text } = record(number);
      const before = frontMatter(baseline(`docs/adr/${file}`));
      const after = frontMatter(text);
      assert.ok(before, `${BASE}:${file} has no front matter`);
      assert.ok(after, `${file} has no front matter`);
      assert.equal(after.rest, before.rest, `${file}: a decided body changed`);
      assert.equal(after.fields.date, before.fields.date, `${file}: accepting an amendment does not change its date`);
    });
  }
});
