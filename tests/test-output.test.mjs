// Issue #31: the test script reports a failure with its name, message and line on every Node version that
// package.json admits. Before Node 22.2.0 the dot reporter printed only an X for a failure. CI runs this file
// on the minimum version of `engines`, which is what makes the check cover the whole range. The test runs the
// script itself, so a script that silences its output or its exit code fails it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const scripts = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts;

// The repository's test script, run as npm runs it (sh -c, with the running node first on PATH) in a directory
// whose only test fails on purpose.
function runScript(dir, script) {
  // A child of a test run would otherwise report to its parent instead of through the reporter.
  const env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}` };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync('/bin/sh', ['-c', script], { cwd: dir, encoding: 'utf8', env });
  return { status: run.status, output: `${run.stdout}${run.stderr}`.slice(0, 12000) };
}

// What a run fails to show of the fixture's failure.
function missing({ status, output }) {
  return [
    status === 0 && 'a failing exit code',
    !/fixture fails on purpose/.test(output) && 'the test name',
    !/one is not two/.test(output) && 'the assertion message',
    !/fails\.test\.mjs:4:\d+/.test(output) && 'the file with its line',
  ].filter(Boolean);
}

describe('the test script shows what failed (#31)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-test-output-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'tests'));
  writeFileSync(join(dir, 'tests', 'fails.test.mjs'), [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "test('fixture passes', () => {});",
    "test('fixture fails on purpose', () => { assert.equal(1, 2, 'one is not two'); });",
    '',
  ].join('\n'));

  test('AC-5 (#31) a failing test prints its name, its message and its file with the line, and the run fails', () => {
    const run = runScript(dir, scripts.test);
    assert.deepEqual(missing(run), [], run.output);
  });

  test('AC-5 (#31) the check fails for a script that hides the failure', () => {
    assert.ok(missing(runScript(dir, `${scripts.test} >/dev/null 2>&1 || true`)).length > 0, 'output and exit code silenced');
    assert.ok(missing(runScript(dir, scripts.test.replace(/--test-reporter=\S+/, '--test-reporter=dot --test-reporter-destination=/dev/null'))).length > 0, 'reporter sent nowhere');
  });
});
