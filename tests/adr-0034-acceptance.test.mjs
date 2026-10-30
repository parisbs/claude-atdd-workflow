// Issue #73: accepting ADR 0034 updates the invariants and status metadata without rewriting decided bodies.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
// Digests of the texts at main d4f4707: CI checks out one commit, so the baseline cannot be read with git show.
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const BASELINE = {
  safetyNetTail: '8c5a83e50e8c4d45070a1ade165d183d22b1d65089685189df5746f0222d37ae',
  failOpen: 'c30ef141250da73c941d2c2c5ccf96cbf9f842d05cb05896e7c4ec9f2d42f4d2',
  bodies: {
    '0002': ['3af3a90fa3f64b1058f05db9ce9a487c0a82a9aac1e1cf8f9cb09d4dbaadad65', '2026-09-29'],
    '0010': ['d68cb3768c784590d748c28ba2290e7c67ac39d46053763a54fc13c09a18f047', '2026-10-02'],
    '0013': ['f93d72f682988f71ad52e7d4c13e1cefffa1f3b0f152261f63a426d0f1ead064', '2026-10-05'],
    '0029': ['ba2dc21fbfda5e01785b574e0f5b271af6c5224795a6d7ba7eb5c3bb98dd5a69', '2026-10-23'],
    '0030': ['4a831e4c73e3defab963d7e7cfcef4ce1095818ffb3842b08436b4ea98074a10', '2026-10-28'],
    '0032': ['8b725567062271cc85c69c28761b8dbb66ea2d655d453b26a8eff094d4a316fc', '2026-10-28'],
    '0033': ['af9e039c70728b617cee75a4ba359d72ed4898c325f95e87e85efeb83818d9c7', '2026-10-28'],
  },
};
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
    assert.ok(current.includes('That net,'));
    assert.equal(sha256(current.slice(current.indexOf('That net,'))), BASELINE.safetyNetTail, current);
  });

  test('AC-19 the fail-open invariant gains the deciding-exception sentence and keeps its other exceptions', () => {
    const text = bullet(invariants(), 'What must always hold');
    const sentence = 'A guard that throws while deciding a command that reaches a high-consequence gate of ADR 0034 asks or denies instead; a hook that cannot start or times out still fails open.';
    assert.ok(text.includes(sentence), text);
    assert.equal(sha256(normalize(text.replace(sentence, ''))), BASELINE.failOpen, text);
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
      const [body, date] = BASELINE.bodies[number];
      const after = frontMatter(text);
      assert.ok(after, `${file} has no front matter`);
      assert.equal(sha256(after.rest), body, `${file}: a decided body changed`);
      assert.equal(after.fields.date, date, `${file}: accepting an amendment does not change its date`);
    });
  }
});
