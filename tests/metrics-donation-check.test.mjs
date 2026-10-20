// Issue #19 (ADR 0023): scripts/metrics-donation-check.mjs is the CI check of a donation pull request. It
// runs from the base checkout, compares the head with its merge base, reads the pull request body from the
// GitHub event file, and validates the added report with the base's validator. Each case builds a real
// repository whose main branch is the base and whose `donation` branch is the pull request; a branch named
// `head` would clash with HEAD on a case-insensitive file system.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { cleanup, git, makeRepo, makeReport, repo, runNode, tempDir } from './metrics-fixtures.mjs';

after(cleanup);

const DONATED = 'docs/experiments/donated';
const EXISTING = `${DONATED}/2026-W40-0123abcd.json`;
const ADDED = `${DONATED}/2026-W43-89abcdef.json`;
const template = join(repo, '.github', 'PULL_REQUEST_TEMPLATE', 'metrics-donation.md');

let valid;
let unticked;
let ticked;
before(() => {
  valid = readFileSync(makeReport(), 'utf8');
  assert.ok(existsSync(template), `${template} does not exist`);
  unticked = readFileSync(template, 'utf8');
  const box = /^\s*[-*] \[ \] .*CC0 1\.0.*$/m.exec(unticked);
  assert.ok(box, 'the template has no unticked CC0 1.0 checkbox');
  ticked = unticked.replace(box[0], box[0].replace('[ ]', '[x]'));
});

function write(dir, path, content) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

const invalid = () => JSON.stringify({ ...JSON.parse(valid), contributor: 'someone' }, null, 2);

// Builds the base with one earlier donation, applies `change` on the donation branch, then `advance` on main after
// the head branched off, and runs the check from the base checkout.
function check(change, { body = ticked, existing = valid, advance } = {}) {
  const dir = makeRepo();
  write(dir, EXISTING, existing);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'earlier donation');
  git(dir, 'checkout', '-q', '-b', 'donation');
  change(dir);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'pull request');
  git(dir, 'checkout', '-q', 'main');
  if (advance) {
    advance(dir);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'main moves on');
  }
  const event = join(tempDir(), 'event.json');
  writeFileSync(event, JSON.stringify({ pull_request: { number: 1, body } }));
  return runNode(join(dir, 'scripts', 'metrics-donation-check.mjs'), ['--base', 'main', '--head', 'donation', '--event', event], { cwd: dir });
}

function fails(r, ...patterns) {
  assert.notEqual(r.status, 0, 'the check passed');
  for (const pattern of patterns) assert.match(r.stderr, pattern);
  assert.doesNotMatch(r.stderr, /\n\s+at /, 'stack trace instead of a cause');
}

describe('metrics-donation-check (#19)', () => {
  test('AC-11 passes a pull request that adds one valid report with the licence box ticked', () => {
    const r = check((dir) => write(dir, ADDED, valid));
    assert.equal(r.status, 0, r.stderr);
  });

  test('AC-11 passes when main moved on after the pull request branched off', () => {
    const r = check((dir) => write(dir, ADDED, valid), {
      advance: (dir) => { write(dir, `${DONATED}/2026-W42-fedcba98.json`, valid); write(dir, 'README.md', 'changed on main\n'); },
    });
    assert.equal(r.status, 0, r.stderr);
  });

  test('AC-11 passes without validating anything a pull request that does not touch the donated folder', () => {
    // The earlier donation on the base is invalid: validating it would fail the check.
    const r = check((dir) => write(dir, 'README.md', 'changed\n'), { body: '', existing: invalid() });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no donat|nothing to (check|validate)|does not touch/i);
  });

  test('AC-11 fails when the pull request also changes a path outside the donated folder', () => {
    fails(check((dir) => { write(dir, ADDED, valid); write(dir, 'README.md', 'changed\n'); }), /README\.md/);
    fails(check((dir) => { write(dir, ADDED, valid); write(dir, 'docs/experiments/donated-private/2026-W43-89abcdef.json', valid); }),
      /donated-private/);
  });

  test('AC-11 fails when the pull request modifies, deletes or renames an earlier donation', () => {
    fails(check((dir) => write(dir, EXISTING, valid.replace('"schema_version"', ' "schema_version"'))), /2026-W40-0123abcd/);
    fails(check((dir) => rmSync(join(dir, EXISTING))), /2026-W40-0123abcd/);
    fails(check((dir) => git(dir, 'mv', EXISTING, `${DONATED}/2026-W44-0123abcd.json`)), /2026-W40-0123abcd/);
  });

  test('AC-11 fails when the pull request adds more than one file', () => {
    fails(check((dir) => { write(dir, ADDED, valid); write(dir, `${DONATED}/2026-W43-01234567.json`, valid); }), /one file|exactly one|2026-W43-01234567/i);
    fails(check((dir) => { write(dir, ADDED, valid); write(dir, `${DONATED}/notes.txt`, 'CANARY raw transcript'); }), /notes\.txt/);
  });

  test('AC-11 fails when the added report is invalid', () => {
    fails(check((dir) => write(dir, ADDED, invalid())), /contributor|key/i);
  });

  test('AC-11 fails when the added file is not named by week and eight hex digits, directly in the folder', () => {
    fails(check((dir) => write(dir, `${DONATED}/jane-doe-laptop.json`, valid)), /jane-doe-laptop/);
    fails(check((dir) => write(dir, `${DONATED}/sub/2026-W43-89abcdef.json`, valid)), /sub\//);
  });

  test('AC-11 fails when the licence box is not ticked, even with another box ticked', () => {
    fails(check((dir) => write(dir, ADDED, valid), { body: unticked }), /licen[cs]e|CC0|checkbox|box/i);
    fails(check((dir) => write(dir, ADDED, valid), { body: `${unticked}\n- [x] I read the report\n` }), /licen[cs]e|CC0|checkbox|box/i);
  });

  test('AC-11 names every cause, validating with the base validator, not the one the pull request brings', () => {
    const r = check((dir) => {
      write(dir, 'scripts/metrics-validate.mjs', 'process.exit(0);\n');
      write(dir, ADDED, invalid());
    });
    fails(r, /scripts\/metrics-validate\.mjs/, /contributor|key/i);
  });
});
