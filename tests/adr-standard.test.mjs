// Issue #66 (ADR 0020): ADR metadata is standardised on MADR 4 front matter. Static checks over this
// repository's records, ADR 0020, the instruction files and skills, and the repo-bootstrap templates, plus an
// install into a temporary target for the copies of the scripts. They prove the rule is stated where an
// agent reads it, not that it reads well; the behaviour of repo-bootstrap and drift-audit (AC-17, AC-18) and
// the run of the check over this repository's migration commit (AC-12) are checked by hand.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeClaude } from './fake-claude.mjs';
import './state-home.mjs';
import { LEGACY_LINE, frontMatter, frontStatus } from './front-matter.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(repo, path), 'utf8');
const adrDir = join(repo, 'docs', 'adr');
const records = readdirSync(adrDir).filter((name) => /^\d{4}-.+\.md$/.test(name)).sort();
const recordOf = (number) => {
  const file = records.find((name) => name.startsWith(`${number}-`));
  assert.ok(file, `there is no ADR ${number}`);
  return { file, text: readFileSync(join(adrDir, file), 'utf8') };
};
const section = (text, heading) => (text.split(`\n## ${heading}\n`)[1] ?? '').split('\n## ')[0];
const headings = (text) => text.split('\n').filter((line) => /^## /.test(line)).map((line) => line.slice(3));
// A paragraph or a list item: the unit a rule is stated in.
const blocks = (text) =>
  text
    .split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.)\s)/)
    .map((block) => block.trim())
    .filter(Boolean);
const someBlock = (text, ...patterns) => blocks(text).some((block) => patterns.every((p) => p.test(block)));
// The ADR index keeps the titles of the records, so only its policy text counts.
const INDEX = 'docs/adr/README.md';
const policyText = (file) => {
  const text = read(file);
  return file === INDEX ? text.replace(/^- \[\d{4}\..*$/gm, '') : text;
};
const SECTIONS = ['Context', 'Decision', 'Alternatives considered', 'Consequences'];

function assertStandard(name, text, { date = /^\d{4}-\d{2}-\d{2}$/ } = {}) {
  const header = frontMatter(text);
  assert.ok(header, `${name} has no front matter starting on line 1`);
  assert.equal(header.keys.filter((key) => key === 'status').length, 1, `${name} needs exactly one status field`);
  assert.match(header.fields.status, /^[a-z]/i, `${name} has an empty status`);
  assert.match(header.fields.date ?? '', date, `${name} has no date field`);
  const legacy = text.split('\n').find((line) => LEGACY_LINE.test(line));
  assert.equal(legacy, undefined, `${name} still has a legacy line: ${legacy}`);
}

describe('ADR standard (#66)', () => {
  describe('AC-11 (#66) this repository is in the standard format', () => {
    for (const file of records) {
      test(`AC-11 (#66) docs/adr/${file} is in the standard format`, () => {
        assertStandard(file, readFileSync(join(adrDir, file), 'utf8'));
      });
    }

    test("AC-11 (#66) the template is in the standard format and keeps this repository's sections", () => {
      const text = read('docs/adr/template.md');
      assertStandard('docs/adr/template.md', text, { date: /YYYY-MM-DD/ });
      assert.deepEqual(headings(text), SECTIONS);
    });

    test('AC-11 (#66) the template offers deprecated among the statuses', () => {
      const status = frontStatus(read('docs/adr/template.md'));
      for (const value of [/\bproposed\b/, /\baccepted\b/, /\brejected\b/, /\bdeprecated\b/, /\bsuperseded by NNNN\b/]) {
        assert.match(status, value);
      }
    });
  });

  describe('AC-13 (#66) ADR 0020', () => {
    test('AC-13 (#66) exists with status proposed or accepted and is in the index', () => {
      const { file, text } = recordOf('0020');
      assert.match(frontStatus(text), /^(proposed|accepted)\b/i);
      assert.ok(read(INDEX).includes(`(${file})`), 'docs/adr/README.md does not link ADR 0020');
    });

    test('AC-13 (#66) records the metadata-only standard, the strict reading, the migration, deprecated and date', () => {
      const decision = section(recordOf('0020').text, 'Decision');
      for (const word of [/front matter/i, /metadata/i, /MADR/, /strict/i, /migrat/i, /mechanical/i, /\bdeprecated\b/i, /\bdate\b/i]) {
        assert.match(decision, word);
      }
    });

    test('AC-13 (#66) rejects every-format support, per-repository configuration and a judgement-based exception', () => {
      const items = blocks(section(recordOf('0020').text, 'Alternatives considered')).filter((block) => /^- /.test(block));
      const rejected = items.filter((item) => /Rejected/i.test(item));
      assert.ok(rejected.length >= 3, `only ${rejected.length} alternatives say why they were rejected`);
      assert.ok(rejected.some((item) => /format/i.test(item) && /(?:every|each) repositor/i.test(item)), 'no rejected alternative covers every repository format');
      assert.ok(rejected.some((item) => /configur/i.test(item)), 'no rejected alternative is per-repository configuration');
      assert.ok(rejected.some((item) => /judge?ment/i.test(item)), 'no rejected alternative is a judgement-based exception');
    });

    test('AC-13 (#66) its header names the parts of ADR 0018 and ADR 0019 it supersedes', () => {
      const header = recordOf('0020').text.split('\n## ')[0];
      assert.match(header, /Supersedes[^\n]*0018/i);
      assert.match(header, /Supersedes[^\n]*0019/i);
    });
  });

  describe('AC-14 (#66) the instruction files and skills describe the front matter status', () => {
    for (const file of [
      'global/CLAUDE.md',
      'common/CLAUDE.md.template',
      'CLAUDE.md',
      INDEX,
      'global/skills/adr-draft/SKILL.md',
      'global/skills/drift-audit/SKILL.md',
      'global/skills/repo-bootstrap/SKILL.md',
    ]) {
      test(`AC-14 (#66) ${file} describes the status as the front matter field and the migration exception`, () => {
        const text = policyText(file);
        assert.ok(someBlock(text, /front matter/i, /\bstatus\b/i), 'nothing names the status as a front matter field');
        assert.ok(someBlock(text, /migrat/i, /mechanical/i), 'nothing describes the mechanical migration exception');
        assert.doesNotMatch(text, /\bstatus line\b/i);
      });
    }

    test('AC-14 (#66) adr-draft creates records in the standard format', () => {
      const text = read('global/skills/adr-draft/SKILL.md');
      assert.ok(someBlock(text, /front matter/i, /status: proposed/), 'adr-draft does not create a front matter status: proposed');
      assert.match(text, /\bdate:/);
    });
  });

  describe('AC-15 (#66) common/ distributes the template, the workflow and the required check', () => {
    test('AC-15 (#66) common/ holds an ADR template in the standard format', () => {
      assertStandard('common/docs/adr/template.md', read('common/docs/adr/template.md'), { date: /YYYY-MM-DD/ });
    });

    test('AC-15 (#66) the workflow runs the check on pull requests with the base available', () => {
      const workflow = read('common/github/workflows/check-adrs.yml');
      assert.match(workflow, /^on:[\s\S]*\bpull_request\b/m);
      assert.match(workflow, /name:\s*Check ADRs\s*$/m);
      assert.match(workflow, /node scripts\/check-adrs\.mjs/);
      assert.match(workflow, /fetch-depth:\s*0/);
      assert.match(workflow, /github\.base_ref/);
    });

    test('AC-15 (#66) the workflow pins every action by full commit SHA', () => {
      const uses = read('common/github/workflows/check-adrs.yml').split('\n').filter((line) => /^\s*-?\s*uses:/.test(line));
      assert.ok(uses.length > 0, 'the workflow uses no action');
      for (const line of uses) assert.match(line, /uses:\s*[\w.-]+\/[\w./-]+@[0-9a-f]{40}(?:\s+#.*)?$/, line);
    });

    test('AC-15 (#66) event values reach the workflow shell only through environment variables', () => {
      for (const line of read('common/github/workflows/check-adrs.yml').split('\n').filter((text) => text.includes('${{'))) {
        assert.match(line, /^\s*[A-Z][A-Z0-9_]*:\s*\$\{\{[^}]*\}\}\s*$/, line);
      }
    });

    test('AC-15 (#66) the ruleset template requires Check ADRs', () => {
      const ruleset = JSON.parse(read('common/github/rulesets/main.json'));
      const checks = ruleset.rules.find((rule) => rule.type === 'required_status_checks')?.parameters.required_status_checks ?? [];
      assert.ok(checks.some((check) => check.context === 'Check ADRs'), 'main.json does not require Check ADRs');
    });
  });

  describe('AC-16 (#66) the installed templates carry the scripts unchanged', () => {
    const scratch = [];
    after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

    test('AC-16 (#66) the installed copies of check-adrs.mjs and migrate-adrs.mjs are identical to scripts/', () => {
      const claudeDir = mkdtempSync(join(tmpdir(), 'cw-adr-standard-claude-'));
      const target = mkdtempSync(join(tmpdir(), 'cw-adr-standard-'));
      scratch.push(claudeDir, target);
      const fake = fakeClaude(claudeDir);
      const r = spawnSync(process.execPath, [join(repo, 'scripts', 'install.mjs'), '--target', target], {
        encoding: 'utf8',
        env: { ...process.env, ...fake.env() },
      });
      assert.equal(r.status, 0, r.stderr);
      for (const name of ['check-adrs.mjs', 'migrate-adrs.mjs']) {
        const installed = join(target, 'skills', 'repo-bootstrap', 'templates', 'common', 'scripts', name);
        assert.equal(readFileSync(installed, 'utf8'), read(`scripts/${name}`), `${name} differs from scripts/${name}`);
      }
    });
  });

  describe('AC-17 and AC-18 (#66), static part: the skills name the install and the deviations', () => {
    test('AC-17 (#66) repo-bootstrap installs the check only on the standard format and proposes the migration otherwise', () => {
      const text = read('global/skills/repo-bootstrap/SKILL.md');
      assert.match(text, /scripts\/check-adrs\.mjs|check-adrs\.mjs/);
      assert.match(text, /migrate-adrs\.mjs/);
      assert.match(text, /Check ADRs/);
      assert.ok(someBlock(text, /front matter/i, /migrat/i, /check/i), 'no rule ties the check to the standard format');
    });

    test('AC-18 (#66) drift-audit reports legacy records, a differing copy of the check and a missing check', () => {
      const text = read('global/skills/drift-audit/SKILL.md');
      assert.ok(someBlock(text, /front matter|standard format/i, /migrat/i), 'no rule reports records outside the standard format');
      assert.ok(someBlock(text, /check-adrs/, /differ/i, /template/i), 'no rule reports a copy of the check that differs from the template');
      assert.ok(someBlock(text, /standard format/i, /without|missing|no\b/i, /check/i), 'no rule reports a standard repository without the check');
    });
  });
});
