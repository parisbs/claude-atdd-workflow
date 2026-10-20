// Issue #19 (ADR 0023): scripts/metrics-validate.mjs checks the form of a donated report. It runs in a git
// repository whose ref holds the history of scripts/metrics-report.mjs, and accepts a report whose script hash
// matches any version of it in that history.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { cleanup, copyScripts, git, makeRepo, makeReport, runNode, tempDir } from './metrics-fixtures.mjs';

after(cleanup);

const LATER = '\n// a later version\n';
const SIDE = '\n// a version only on another branch\n';
const TOKENS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];

let base;
let report;
let laterReport;
let sideHash;
before(() => {
  base = makeRepo();
  const script = join(base, 'scripts', 'metrics-report.mjs');
  // A version that never reaches main.
  git(base, 'checkout', '-q', '-b', 'side');
  appendFileSync(script, SIDE);
  sideHash = createHash('sha256').update(readFileSync(script, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
  git(base, 'commit', '-q', '-am', 'side version');
  git(base, 'checkout', '-q', 'main');
  // A later version on main: reports from the earlier and from the later version must both pass.
  appendFileSync(script, LATER);
  git(base, 'commit', '-q', '-am', 'later version');
  report = JSON.parse(readFileSync(makeReport(), 'utf8'));
  const copy = copyScripts();
  appendFileSync(join(copy, 'scripts', 'metrics-report.mjs'), LATER);
  laterReport = JSON.parse(readFileSync(makeReport({ script: join(copy, 'scripts', 'metrics-report.mjs') }), 'utf8'));
});

function validate(content) {
  const file = join(tempDir(), 'report.json');
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return runNode(join(base, 'scripts', 'metrics-validate.mjs'), [file, '--ref', 'main'], { cwd: base });
}

function rejects(mutate, pattern) {
  const copy = structuredClone(report);
  mutate(copy);
  const r = validate(copy);
  assert.notEqual(r.status, 0, `the validator accepted it: ${mutate}`);
  assert.match(r.stderr, pattern);
  assert.doesNotMatch(r.stderr, /\n\s+at /, 'stack trace instead of a cause');
}

// The row with the most fields filled: the fixture's session A.
const rowA = (copy) => copy.sessions.find((row) => row.requests === 6);

// Changes a main count of a row and keeps the totals consistent, so that a test fails on the defect it names
// and not on the totals.
function setCount(copy, field, value) {
  const row = rowA(copy);
  copy.totals[field] += value - row[field];
  row[field] = value;
}

describe('metrics-validate (#19)', () => {
  test('AC-10 passes reports made by an earlier and by the latest version of the script on main', () => {
    for (const valid of [report, laterReport]) {
      const r = validate(valid);
      assert.equal(r.status, 0, r.stderr);
    }
  });

  test('AC-10 fails on a key outside the schema, at every level', () => {
    rejects((c) => { c.contributor = 'someone'; }, /contributor|key/i);
    rejects((c) => { c.totals.ownerAccountUuid = 'x'; }, /ownerAccountUuid|key/i);
    rejects((c) => { rowA(c).session_id = 'abc'; }, /session_id|key/i);
    rejects((c) => { rowA(c).subagents.prompt = 'x'; }, /prompt|key/i);
  });

  test('AC-10 fails on a missing key, at every level', () => {
    rejects((c) => { delete c.license; }, /license|missing|required/i);
    rejects((c) => { delete c.totals.output_tokens; }, /output_tokens|missing|required/i);
    rejects((c) => { delete rowA(c).duration_minutes; }, /duration_minutes|missing|required/i);
    rejects((c) => { delete rowA(c).subagents.types; }, /types|missing|required/i);
  });

  test('AC-10 fails on a string outside its enumeration or pattern, in every string field', () => {
    rejects((c) => { rowA(c).models = ['claude-opus-5-5', 'gpt-4']; }, /model|gpt-4/i);
    rejects((c) => { rowA(c).models = ['claude-acme-internal', 'claude-opus-5-5']; }, /model|claude-acme-internal/i);
    rejects((c) => { rowA(c).entrypoint = 'my-laptop'; }, /entrypoint|my-laptop/i);
    rejects((c) => { rowA(c).cli_version = 'my-host'; }, /cli_version|my-host/i);
    rejects((c) => { rowA(c).permission_mode = ['root-shell']; }, /permission|root-shell/i);
    rejects((c) => { rowA(c).efforts = ['turbo']; }, /effort|turbo/i);
    rejects((c) => { c.script_version = 'v1 private'; }, /script_version/i);
    rejects((c) => { c.license = 'MIT'; }, /licen[cs]e/i);
    rejects((c) => { c.schema_version = 2; }, /schema/i);
  });

  test('AC-10 fails on a counting key outside the allowlists', () => {
    rejects((c) => { rowA(c).tool_calls.Frobnicate = 1; }, /tool|Frobnicate/i);
    rejects((c) => { rowA(c).tool_calls['mcp:acme-internal'] = 1; }, /mcp|acme-internal/i);
    rejects((c) => { rowA(c).skills['acme-deploy'] = 1; }, /skill|acme-deploy/i);
    rejects((c) => { rowA(c).subagents.types['acme-agent'] = 1; }, /agent|acme-agent/i);
  });

  test('AC-10 fails on a week that is not a real ISO week', () => {
    for (const week of ['2026-10-06', '2026-W00', '2026-W54', '2025-W53']) {
      rejects((c) => { rowA(c).week = week; }, /week/i);
      rejects((c) => { c.generated_week = week; }, /week/i);
    }
  });

  test('AC-10 fails on an array that is not sorted and distinct, or not an array', () => {
    rejects((c) => { rowA(c).models = ['other', 'claude-opus-5-5']; }, /model|sort|order/i);
    rejects((c) => { rowA(c).efforts = ['other', 'other']; }, /effort|duplicate|distinct/i);
    rejects((c) => { rowA(c).models = 'claude-opus-5-5'; }, /model|array/i);
  });

  test('AC-10 fails on a count that is negative, fractional or not a number, wherever it is', () => {
    rejects((c) => setCount(c, 'requests', -1), /negative|integer|requests/i);
    rejects((c) => setCount(c, 'input_tokens', 1.5), /integer|input_tokens/i);
    rejects((c) => { rowA(c).duration_minutes = '45'; }, /duration_minutes|integer|number/i);
    rejects((c) => { rowA(c).subagents.requests = -1; }, /negative|integer|requests/i);
    rejects((c) => { rowA(c).tool_calls.Bash = 'CANARYINPUT'; }, /Bash|integer|number/i);
    rejects((c) => { rowA(c).tool_calls.Bash = 0; }, /Bash|zero|positive/i);
    rejects((c) => { rowA(c).subagents.types.other = { prompt: 'x' }; }, /other|integer|number/i);
  });

  test('AC-10 fails when any total does not match the rows', () => {
    rejects((c) => { c.totals.sessions += 1; }, /total|sessions/i);
    rejects((c) => { c.totals.requests += 1; }, /total|requests/i);
    for (const field of TOKENS) rejects((c) => { c.totals[field] += 1; }, new RegExp(`total|${field}`, 'i'));
  });

  test('AC-10 accepts a file of exactly 2 MiB and fails on one byte more, even when it is valid JSON', () => {
    const text = JSON.stringify(report);
    const at = validate(text + ' '.repeat(2 * 1024 * 1024 - Buffer.byteLength(text)));
    assert.equal(at.status, 0, at.stderr);
    const over = validate(text + ' '.repeat(2 * 1024 * 1024 - Buffer.byteLength(text) + 1));
    assert.notEqual(over.status, 0);
    assert.match(over.stderr, /size|MiB|MB|bytes|large/i);
  });

  test('AC-10 fails on a script hash that matches no version of the script in the history of the ref', () => {
    rejects((c) => { c.script_sha256 = 'a'.repeat(64); }, /sha256|hash|version/i);
    rejects((c) => { c.script_sha256 = sideHash; }, /sha256|hash|version/i);
  });

  test('AC-10 fails on a file that is not JSON', () => {
    const r = validate('{"schema_version": 1,');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /JSON|parse/i);
  });
});
