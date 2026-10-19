// Issue #57: ADR 0017 records the decisions of the change and supersedes part of ADR 0014, which, being
// merged, changes only in its status line (ADR 0009). That the body of ADR 0014 is otherwise unchanged is
// AC-12, checked by hand against main. Issue #66 moved the status into MADR 4 front matter.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { frontStatus } from './front-matter.mjs';

const adrDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'adr');
const recordOf = (number) => {
  const file = readdirSync(adrDir).find((name) => name.startsWith(`${number}-`));
  assert.ok(file, `there is no ADR ${number}`);
  return { file, text: readFileSync(join(adrDir, file), 'utf8') };
};
const statusLine = frontStatus;
const section = (text, heading) => (text.split(`\n## ${heading}\n`)[1] ?? '').split('\n## ')[0];

describe('ADR 0017 (#57)', () => {
  test('AC-11 (#57) exists with status proposed or accepted', () => {
    assert.match(statusLine(recordOf('0017').text), /^(proposed|accepted)\b/);
  });

  test('AC-11 (#57) is in the index', () => {
    const index = readFileSync(join(adrDir, 'README.md'), 'utf8');
    assert.ok(index.includes(`(${recordOf('0017').file})`), 'docs/adr/README.md does not link ADR 0017');
  });

  test('AC-11 (#57) names the parts of ADR 0014 it supersedes', () => {
    const { text } = recordOf('0017');
    const header = text.split('\n## ')[0];
    assert.match(header, /Supersedes[^\n]*0014/i, 'the header does not say it supersedes ADR 0014');
    assert.match(header, /version range/i);
    assert.match(header, /job-status|codex_job_status/i);
  });

  test('AC-11 (#57) lists at least three rejected alternatives', () => {
    const alternatives = section(recordOf('0017').text, 'Alternatives considered');
    const items = alternatives.split('\n').filter((line) => /^- /.test(line));
    assert.ok(items.length >= 3, `only ${items.length} alternatives`);
    assert.ok(items.filter((line) => /Rejected/i.test(line)).length >= 3, 'fewer than three items say why they were rejected');
  });

  test("AC-11 (#57) ADR 0014's status line names ADR 0017", () => {
    const { text } = recordOf('0014');
    assert.match(statusLine(text), /0017/);
    assert.ok(existsSync(join(adrDir, recordOf('0017').file)));
  });
});
