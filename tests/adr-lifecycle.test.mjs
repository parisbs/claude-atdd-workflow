// Issue #63: an ADR is immutable from the commit where its status becomes accepted or rejected, not from its
// merge; a proposed record on main is still a draft. These are static checks over the files: they prove the
// rule is stated where an agent reads it, not that it reads well. That ADR 0009 changes only in its status
// line (AC-3) and that drift-audit tells an edited proposal from an edited decision (AC-9) are checked by hand.
// Issue #66 moved the status into MADR 4 front matter, so the status is read from there.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { frontStatus } from './front-matter.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(repo, path), 'utf8');
const adrDir = join(repo, 'docs', 'adr');
const recordOf = (number) => {
  const file = readdirSync(adrDir).find((name) => name.startsWith(`${number}-`));
  assert.ok(file, `there is no ADR ${number}`);
  return { file, text: readFileSync(join(adrDir, file), 'utf8') };
};
const statusLine = frontStatus;
const section = (text, heading) => (text.split(`\n## ${heading}\n`)[1] ?? '').split('\n## ')[0];
// A paragraph or a list item: the unit a rule is stated in.
const blocks = (text) =>
  text
    .split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.)\s)/)
    .map((block) => block.trim())
    .filter(Boolean);
const someBlock = (text, ...patterns) => blocks(text).some((block) => patterns.every((p) => p.test(block)));
// The ADR index keeps the titles of merged records, ADR 0009's among them, so only its policy text counts:
// the old title would fail the old-rule check forever, and a new title could stand in for the policy.
const INDEX = 'docs/adr/README.md';
const policyText = (file) => {
  const text = read(file);
  return file === INDEX ? text.replace(/^- \[\d{4}\..*$/gm, '') : text;
};

const OLD_RULE = [
  /immutable\s+once\s+merged/i,
  /merged\s+(?:ADRs|records)\s+are\s+immutable/i,
  /records\s+merged\s+to\s+`?main`?\s+are\s+immutable/i,
];

const STATING_THE_RULE = [
  'global/CLAUDE.md',
  'common/CLAUDE.md.template',
  'CLAUDE.md',
  'docs/adr/README.md',
  'global/skills/adr-draft/SKILL.md',
  'global/skills/repo-bootstrap/SKILL.md',
];

describe('ADR lifecycle (#63)', () => {
  test('AC-1 (#63) ADR 0018 exists with status proposed or accepted and is in the index', () => {
    const { file, text } = recordOf('0018');
    assert.match(statusLine(text), /^(proposed|accepted)\b/);
    assert.ok(read('docs/adr/README.md').includes(`(${file})`), 'docs/adr/README.md does not link ADR 0018');
  });

  test('AC-1 (#63) ADR 0018 says in its header that it supersedes ADR 0009', () => {
    const header = recordOf('0018').text.split('\n## ')[0];
    assert.match(header, /Supersedes[^\n]*0009/i);
  });

  test('AC-1 (#63) ADR 0018 rejects at least two alternatives, among them merge as acceptance with a check', () => {
    const items = blocks(section(recordOf('0018').text, 'Alternatives considered')).filter((b) => /^- /.test(b));
    const rejected = items.filter((item) => /Rejected/i.test(item));
    assert.ok(rejected.length >= 2, `only ${rejected.length} alternatives say why they were rejected`);
    assert.ok(
      rejected.some((item) => /merge/i.test(item) && /\b(?:CI|check)\b/i.test(item) && /proposed/i.test(item)),
      'no rejected alternative keeps merge as acceptance with a check that refuses proposed records',
    );
  });

  test("AC-2 (#63) ADR 0009's status line names ADR 0018", () => {
    assert.match(statusLine(recordOf('0009').text), /0018/);
  });

  test('AC-4 (#63) the ADR template offers proposed, accepted, rejected and superseded', () => {
    const status = statusLine(read('docs/adr/template.md'));
    for (const value of [/\bproposed\b/, /\baccepted\b/, /\brejected\b/, /\bsuperseded by NNNN\b/]) {
      assert.match(status, value);
    }
  });

  for (const file of STATING_THE_RULE) {
    test(`AC-5 (#63) ${file} ties immutability to accepted or rejected, not to the merge`, () => {
      const text = policyText(file);
      assert.ok(someBlock(text, /immutab/i, /\baccepted\b/i, /\brejected\b/i), 'no statement of immutability names accepted and rejected');
      assert.ok(
        someBlock(text, /\bproposed\b/i, /draft|editable|can (?:still )?be edited/i),
        'nothing says a proposed record is still an editable draft',
      );
      for (const old of OLD_RULE) assert.doesNotMatch(text, old);
    });
  }

  test('AC-6 (#63) accepting or rejecting an ADR is human-only', () => {
    assert.ok(someBlock(read('global/CLAUDE.md'), /Human only/, /accept/i, /reject/i, /\bADR\b/));
  });

  for (const file of ['docs/adr/README.md', 'global/skills/adr-draft/SKILL.md']) {
    test(`AC-7 (#63) ${file} says numbers are never reused, rejected records included`, () => {
      assert.ok(someBlock(policyText(file), /never\s+reus/i, /\brejected\b/i));
    });
  }

  describe('AC-8 (#63) drift-audit', () => {
    const text = read('global/skills/drift-audit/SKILL.md');

    test('AC-8 (#63) compares each body with the first commit where it became accepted or rejected', () => {
      assert.ok(someBlock(text, /first commit/i, /\baccepted\b/i, /\brejected\b/i));
      assert.doesNotMatch(text, /No merged ADR had its body edited after merging/);
    });

    test('AC-8 (#63) treats an unrecognised status as immutable from the merge and asks to normalise it', () => {
      assert.ok(someBlock(text, /recogni[sz]ed/i, /merge/i, /normali[sz]/i));
    });

    test('AC-8 (#63) flags proposed records on main older than 30 days', () => {
      assert.ok(someBlock(text, /\bproposed\b/i, /\b30 days\b/i));
    });

    test('AC-8 (#63) flags references to proposed records from CLAUDE.md, code or decided records', () => {
      assert.ok(someBlock(text, /referenc/i, /\bproposed\b/i, /CLAUDE\.md/, /\bcode\b/i));
    });
  });
});
