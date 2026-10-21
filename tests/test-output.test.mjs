// Issue #31: the test script reports a failure with its name, message and line on every Node version that
// package.json admits. Before Node 22.2.0 the dot reporter printed only an X for a failure. CI runs this file
// on the minimum version of `engines`, which is what makes the check cover the whole range.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const scripts = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts;

describe('the test script shows what failed (#31)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-test-output-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('AC-5 (#31) a failing test prints its name, its message and its file with the line, and the run fails', () => {
    const reporter = scripts.test.match(/--test-reporter(?:-destination)?(?:=|\s+)\S+/g) ?? [];
    assert.ok(reporter.length > 0, 'the test script names its reporter');
    const file = join(dir, 'fails.test.mjs');
    writeFileSync(file, [
      "import assert from 'node:assert/strict';",
      "import { test } from 'node:test';",
      "test('fixture passes', () => {});",
      "test('fixture fails on purpose', () => { assert.equal(1, 2, 'one is not two'); });",
      '',
    ].join('\n'));
    // A child of a test run would otherwise report to its parent instead of through the reporter.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ['--test', ...reporter.flatMap((arg) => arg.split(/\s+/)), file], { cwd: dir, encoding: 'utf8', env });
    const output = `${run.stdout}${run.stderr}`.slice(0, 12000);
    assert.notEqual(run.status, 0, 'the run fails');
    assert.match(output, /fixture fails on purpose/, output);
    assert.match(output, /one is not two/, output);
    assert.match(output, /fails\.test\.mjs:4:\d+/, output);
  });
});
