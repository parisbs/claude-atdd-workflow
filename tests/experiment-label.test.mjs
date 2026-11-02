// Issue #80: the experiment label changes wording without lifting the mixed proposed ADR denial.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fixture, POSIX, SESSIONS } from './guard-git-fixture.mjs';

const RECORDS = ['docs/adr/0001-choice.md', 'docs/adr/0002-choice.md'];
const PATHS = [...RECORDS, 'docs/releasing.md', 'src/app.mjs'];
const ADR35 = '0035-keep-a-proposed-adr-from-merging-with-the-change-that-applies-it.md';
// SHA-256 of ADR 0035 as accepted at 756c343; the CI test job checks out without history.
const ADR35_ACCEPTED = 'c98a36680076ff625cb310806a627af58fef04538f9cf33513a66705cb56201e';
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const bypass = { permission_mode: 'bypassPermissions' };

function merge(t) {
  const f = fixture();
  t.after(() => f.close());
  const repo = f.repository();
  const contents = Object.fromEntries(RECORDS.map((path) => [
    `${path}?ref=${repo.b}`, { stdout: '---\nstatus: proposed\ndate: 2026-10-30\n---\n# Choice\n' },
  ]));
  return (session, labels = []) => {
    const result = f.decide(repo, 'gh pr merge 5 --squash', {
      session, contents, pr: { files: PATHS.map((path) => ({ path })), changedFiles: PATHS.length,
        labels: labels.map((name) => ({ name })) },
    });
    assert.equal(result.stderr, '');
    return result;
  };
}

function evidence(result) {
  assert.match(result.reason, /proposed/i);
  for (const path of PATHS) assert.ok(result.reason.includes(path), `missing ${path}: ${result.reason}`);
  assert.match(result.reason, /declared[\s\S]*experiment/i);
}

for (const label of ['experiment', 'Experiment']) {
  test(`AC-1 ${label} denies in bypassPermissions with every record and outside path`, { skip: POSIX }, (t) => {
    const result = merge(t)(bypass, [label]);
    evidence(result);
    assert.equal(result.decision, 'deny', result.reason);
  });

  test(`AC-2 ${label} asks in the main session with every record and outside path`, { skip: POSIX }, (t) => {
    const result = merge(t)({ permission_mode: 'default' }, [label]);
    assert.equal(result.decision, 'ask', result.reason);
    evidence(result);
  });

  for (const [name, session] of SESSIONS) {
    test(`AC-3 ${label} preserves the unlabelled decision in ${name}`, { skip: POSIX }, (t) => {
      const decide = merge(t);
      const unlabelled = decide(session);
      const labelled = decide(session, [label]);
      assert.equal(labelled.decision, unlabelled.decision, `${label} must not change the ${name} decision`);
    });
  }
}

test('AC-4 Delegation says the experiment label does not lift the proposed-record condition', () => {
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
  const proposed = condition.slice(condition.search(/proposed/i)).split(/,\s+and the merge\b|\.\s/)[0];
  assert.doesNotMatch(proposed, /unless[\s\S]*experiment/i, 'the proposed-record condition must not exempt experiment labels');
  assert.match(condition, /(?:label[\s\S]*experiment|experiment[\s\S]*label)[\s\S]*(?:does not|doesn't|cannot|can't|never)[\s\S]*(?:lift|waive|bypass|exempt|relax|override|remove)/i,
    'the experiment label must explicitly not lift the proposed-record condition');
});

test('AC-5 ADR 0036 amends 0035 and preserves every other line of the accepted record', () => {
  const records = readdirSync(new URL('../docs/adr/', import.meta.url)).filter((name) => /^0036-.*\.md$/.test(name));
  assert.equal(records.length, 1, 'exactly one docs/adr/0036-*.md record must exist');
  const [filename] = records;
  const text = read(`docs/adr/${filename}`);
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  assert.ok(front, 'ADR 0036 must have YAML front matter');
  assert.match(front, /^status:\s*\S[^\r\n]*$/m);
  assert.match(front, /^date:\s*\S[^\r\n]*$/m);
  const amends = /^- Amends:[^\n]*(?:\n[ \t]+[^\n]*)*/m.exec(text)?.[0];
  assert.ok(amends?.includes(`](${ADR35})`), 'ADR 0036 must link ADR 0035 in its Amends entry');
  assert.ok(read('docs/adr/README.md').includes(`](${filename})`), 'the ADR index must list ADR 0036');
  const amended = read(`docs/adr/${ADR35}`);
  const status = `---\nstatus: accepted, amended by [0036](${filename})\n`;
  assert.ok(amended.startsWith(status), `ADR 0035 status must read amended by 0036: ${amended.split('\n')[1]}`);
  const restored = `---\nstatus: accepted\n${amended.slice(status.length)}`;
  assert.equal(createHash('sha256').update(restored).digest('hex'), ADR35_ACCEPTED,
    'only ADR 0035 front matter status may change from 756c343');
});
