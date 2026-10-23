// Issue #55 (ADR 0029): in the main session guard-git asks before deleting or moving an `oracle/*` tag,
// instead of denying it. The question says what is lost: for a move, the commit the tag points to and
// the one it would point to; for a deletion, whether the branch's pull request is still open (read with
// `gh pr list --head <branch> --state open --json ...` in the repository), or why it could not be read.
// A subagent and a main session in bypassPermissions are still denied. Each case runs the Bash entries of
// global/settings.json through claude-hooks.mjs, with a fake `gh` first on PATH and temporary
// repositories; a local bare repository stands in for the remote. The fixtures repeat those of
// hooks.test.mjs and guard-git-local-work.test.mjs: a test file cannot import another without running
// its suites.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runConfigured } from './claude-hooks.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Git answers in the language of the machine and reads its user configuration; the fixtures and the hook
// get neither.
const GIT_ENV = {
  LC_ALL: 'C',
  LANG: 'C',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

// A fake `gh` first on PATH stands in for GitHub. It answers `pr list` from a scenario and records every
// call with its working directory. The scenario's `head`, when given, is the branch `pr list` must be asked
// for with --head; any other call fails.
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_GH, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH + '.calls', JSON.stringify({ args, cwd: process.cwd() }) + '\n');
const at = args.findIndex((arg) => arg === '--head' || arg.startsWith('--head='));
const head = at < 0 ? undefined : args[at].includes('=') ? args[at].slice('--head='.length) : args[at + 1];
let step = { exit: 1, stderr: 'fake gh: unexpected call' };
if (args[0] === 'pr' && args[1] === 'list') {
  step = scenario.head !== undefined && head !== scenario.head
    ? { exit: 1, stderr: 'fake gh: pr list was not asked for --head ' + scenario.head }
    : scenario.list || { exit: 1, stderr: 'fake gh: no list scenario' };
}
const finish = () => {
  if (step.stderr) process.stderr.write(step.stderr);
  if (step.stdout !== undefined) process.stdout.write(typeof step.stdout === 'string' ? step.stdout : JSON.stringify(step.stdout));
  process.exit(step.exit === undefined ? 0 : step.exit);
};
if (step.sleep) setTimeout(finish, step.sleep); else finish();
`;

const OPEN_PR = { number: 12, url: 'https://github.com/o/r/pull/12', headRefName: 'feature/x', state: 'OPEN' };
const NO_PR = { list: { stdout: [] } };
const ORACLE = 'oracle/feature/x';
const MODES = [undefined, 'default', 'auto', 'acceptEdits'];

describe('guard-git asks before deleting or moving an oracle tag (#55)', () => {
  let scratch;
  let bin;
  let noGh;
  let scenarios = 0;
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cw-oracle-tags-'));
    bin = join(scratch, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
    // node and git alone: the PATH of a machine without gh.
    noGh = join(scratch, 'no-gh');
    mkdirSync(noGh);
    symlinkSync(process.execPath, join(noGh, 'node'));
    const git = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    symlinkSync(git, join(noGh, 'git'));
  });
  after(() => rmSync(scratch, { recursive: true, force: true }));

  // A repository with the commits A (on main) and B (on feature/x, checked out), a bare `origin`, and the
  // tag oracle/feature/x at `local` while origin holds it at `remote`. Nothing runs the commands under
  // test, so the fixture is only read. oracle/x and v1.0.0 exist as well, at A.
  function fixture({ local = 'a', remote = 'a' } = {}) {
    const dir = mkdtempSync(join(scratch, 'repo-'));
    const origin = join(mkdtempSync(join(scratch, 'remote-')), 'origin.git');
    sh(scratch, 'init', '-q', '--bare', '-b', 'main', origin);
    sh(dir, 'init', '-q', '-b', 'main');
    sh(dir, 'config', 'user.email', 'test@example.com');
    sh(dir, 'config', 'user.name', 'Test');
    sh(dir, 'config', 'commit.gpgsign', 'false');
    sh(dir, 'config', 'tag.gpgsign', 'false');
    sh(dir, 'remote', 'add', 'origin', origin);
    writeFileSync(join(dir, 'README.md'), 'a\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'chore: init');
    const a = sh(dir, 'rev-parse', 'HEAD');
    sh(dir, 'checkout', '-q', '-b', 'feature/x');
    writeFileSync(join(dir, 'README.md'), 'b\n');
    sh(dir, 'commit', '-q', '-am', 'feat: x');
    const b = sh(dir, 'rev-parse', 'HEAD');
    const at = { a, b };
    sh(dir, 'tag', 'v1.0.0', a);
    sh(dir, 'tag', 'oracle/x', a);
    sh(dir, 'tag', ORACLE, at[remote]);
    sh(dir, 'push', '-q', 'origin', `refs/tags/${ORACLE}`);
    sh(dir, 'tag', '-f', ORACLE, at[local]);
    return { dir, a, b, short: { a: a.slice(0, 7), b: b.slice(0, 7) } };
  }

  // One Bash call through every entry of global/settings.json that applies to it; none may fail.
  function decide(dir, command, { extra = {}, gh = NO_PR, env = {}, path } = {}) {
    scenarios += 1;
    const file = join(scratch, `scenario-${scenarios}.json`);
    writeFileSync(file, JSON.stringify(gh));
    const event = { cwd: dir, tool_name: 'Bash', tool_input: { command }, ...extra };
    const options = path
      ? { path, env: { ...GIT_ENV, FAKE_GH: file, ...env } }
      : { env: { ...GIT_ENV, PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_GH: file, ...env } };
    const result = runConfigured(event, options);
    assert.deepEqual(result.failures, [], result.stderr);
    const calls = existsSync(`${file}.calls`)
      ? readFileSync(`${file}.calls`, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : [];
    return { ...result, calls };
  }

  const DELETES = [
    'git tag -d oracle/x',
    'git tag --delete oracle/x',
    'git tag -df oracle/x',
    'git tag -fd oracle/x',
    'git tag -d v1.0.0 oracle/x',
    `git update-ref -d refs/tags/${ORACLE}`,
    `git push origin :refs/tags/${ORACLE}`,
    `git push --delete origin ${ORACLE}`,
    `git push -d origin ${ORACLE}`,
  ];

  test('AC-1 asks, in every mode that shows prompts, for a command that deletes an oracle tag', () => {
    const { dir } = fixture();
    for (const mode of MODES) {
      for (const command of DELETES) {
        const extra = mode === undefined ? {} : { permission_mode: mode };
        const r = decide(dir, command, { extra });
        assert.equal(r.decision, 'ask', `${command} (permission_mode ${mode}): ${r.reason}`);
      }
    }
  });

  test('AC-2 asks for a local move and the reason names the commit the tag points to and the one it would point to', () => {
    const { dir, b, short } = fixture();
    for (const command of [
      `git tag -f ${ORACLE} ${b}`,
      `git tag -f ${ORACLE}`,
      `git update-ref refs/tags/${ORACLE} ${b}`,
    ]) {
      const r = decide(dir, command);
      assert.equal(r.decision, 'ask', `${command}: ${r.reason}`);
      assert.ok(r.reason.includes(short.a), `${command}: the reason lacks the commit the tag points to ${short.a}: ${r.reason}`);
      assert.ok(r.reason.includes(short.b), `${command}: the reason lacks the commit it would point to ${short.b}: ${r.reason}`);
    }
  });

  test('AC-2 asks for a forced push of an oracle tag and the reason names the remote value and the pushed one', () => {
    // origin holds the tag at A, the local tag is at B: a forced push moves the remote tag from A to B.
    const { dir, short } = fixture({ local: 'b', remote: 'a' });
    for (const command of [
      `git push -f origin ${ORACLE}`,
      `git push --force origin refs/tags/${ORACLE}`,
      `git push origin +refs/tags/${ORACLE}`,
    ]) {
      const r = decide(dir, command);
      assert.equal(r.decision, 'ask', `${command}: ${r.reason}`);
      assert.ok(r.reason.includes(short.a), `${command}: the reason lacks the remote value ${short.a}: ${r.reason}`);
      assert.ok(r.reason.includes(short.b), `${command}: the reason lacks the pushed value ${short.b}: ${r.reason}`);
    }
  });

  test('AC-3 says, when the pull request of the branch is open, that it is still open, gives its URL and says oracle-check checks nothing', () => {
    const { dir } = fixture();
    for (const command of [`git tag -d ${ORACLE}`, `git push origin :refs/tags/${ORACLE}`]) {
      const r = decide(dir, command, { gh: { head: 'feature/x', list: { stdout: [OPEN_PR] } } });
      assert.equal(r.decision, 'ask', `${command}: ${r.reason}`);
      assert.ok(r.reason.includes(OPEN_PR.url), `${command}: the reason lacks the URL: ${r.reason}`);
      assert.match(r.reason, /still open/i, command);
      assert.ok(r.reason.includes('oracle-check'), `${command}: the reason does not mention oracle-check: ${r.reason}`);
      const asked = r.calls.filter((call) => call.args[0] === 'pr' && call.args[1] === 'list');
      assert.ok(asked.length > 0, `${command}: gh pr list was not called (calls: ${JSON.stringify(r.calls)})`);
      assert.equal(realpathSync(asked[0].cwd), realpathSync(dir), `${command}: gh pr list ran outside the repository`);
    }
  });

  test('AC-3 does not say the pull request is open when gh shows none', () => {
    const { dir } = fixture();
    for (const command of [`git tag -d ${ORACLE}`, `git push origin :refs/tags/${ORACLE}`]) {
      const r = decide(dir, command, { gh: { head: 'feature/x', list: { stdout: [] } } });
      assert.equal(r.decision, 'ask', `${command}: ${r.reason}`);
      assert.doesNotMatch(r.reason, /still open/i, command);
    }
  });

  test('AC-4 denies a subagent that deletes or moves an oracle tag', () => {
    const { dir, b } = fixture();
    for (const command of [
      `git tag -d ${ORACLE}`,
      `git tag -f ${ORACLE} ${b}`,
      `git update-ref -d refs/tags/${ORACLE}`,
      `git update-ref refs/tags/${ORACLE} ${b}`,
      `git push origin :refs/tags/${ORACLE}`,
    ]) {
      const r = decide(dir, command, { extra: { agent_id: 'agent-1' } });
      assert.equal(r.decision, 'deny', `${command}: ${r.reason}`);
    }
  });

  test('AC-5 asks and says the pull request state could not be read, and why, when gh fails', () => {
    const { dir } = fixture();
    for (const command of [`git tag -d ${ORACLE}`, `git push origin :refs/tags/${ORACLE}`]) {
      const r = decide(dir, command, { gh: { list: { exit: 1, stderr: 'gh: not logged in' } } });
      assert.equal(r.decision, 'ask', `${command}: ${r.reason}`);
      assert.match(r.reason, /could not read/i, command);
      assert.ok(r.reason.includes('not logged in'), `${command}: the reason does not say why: ${r.reason}`);
    }
  });

  test('AC-5 asks and says the pull request state could not be read when gh times out', () => {
    const { dir } = fixture();
    const r = decide(dir, `git tag -d ${ORACLE}`, {
      gh: { list: { sleep: 3000, stdout: [OPEN_PR] } },
      env: { GUARD_GIT_GH_TIMEOUT_MS: '300' },
    });
    assert.equal(r.decision, 'ask', r.reason);
    assert.match(r.reason, /could not read/i);
    assert.match(r.reason, /timed out/i);
  });

  test('AC-5 asks and says the pull request state could not be read when gh is missing', () => {
    const { dir } = fixture();
    const r = decide(dir, `git tag -d ${ORACLE}`, { path: noGh });
    assert.equal(r.decision, 'ask', r.reason);
    assert.match(r.reason, /could not read/i);
  });

  test('AC-6 denies in bypassPermissions a command that deletes or moves an oracle tag and says to switch to a mode that shows prompts', () => {
    const { dir, b } = fixture();
    for (const command of [
      `git tag -d ${ORACLE}`,
      `git update-ref -d refs/tags/${ORACLE}`,
      `git push origin :refs/tags/${ORACLE}`,
      `git tag -f ${ORACLE} ${b}`,
      `git update-ref refs/tags/${ORACLE} ${b}`,
    ]) {
      const r = decide(dir, command, { extra: { permission_mode: 'bypassPermissions' } });
      assert.equal(r.decision, 'deny', `${command}: ${r.reason}`);
      assert.ok(r.reason.includes('bypassPermissions'), `${command}: the reason does not name bypassPermissions: ${r.reason}`);
      assert.match(r.reason, /prompt/i, command);
    }
  });
});

// The three files that describe deleting or moving an oracle tag. A unit is a paragraph or a list item.
function units(file) {
  const out = [];
  let current = [];
  const flush = () => {
    if (current.length > 0) out.push(current.join(' '));
    current = [];
  };
  for (const line of readFileSync(join(root, file), 'utf8').split('\n')) {
    if (line.trim() === '') flush();
    else {
      if (/^\s*(?:[-*]|\d+\.)\s/.test(line)) flush();
      current.push(line.trim());
    }
  }
  flush();
  return out;
}

const ORACLE_TAG = /oracle tag|oracle\/</i;
const DELETE_OR_MOVE = /\b(?:delet\w*|remov\w*|mov(?:e|es|ed|ing))\b/i;
const aboutOracleTagChange = (file) => units(file).filter((unit) => ORACLE_TAG.test(unit) && DELETE_OR_MOVE.test(unit));

describe('the documents describe the ask for deleting or moving an oracle tag (#55)', () => {
  const files = ['global/CLAUDE.md', 'global/skills/atdd-implement/SKILL.md', 'global/skills/pr-prep/SKILL.md'];

  for (const file of files) {
    test(`AC-7 ${file} says the main session asks, and none of its paragraphs says the guard denies it`, () => {
      const about = aboutOracleTagChange(file);
      assert.ok(about.some((unit) => /\bask/i.test(unit)), `${file}: no paragraph about deleting or moving an oracle tag says it asks`);
      // A denial may still be described for a subagent or for bypassPermissions, never for the main session.
      for (const unit of about.filter((u) => !/subagent|bypassPermissions/i.test(u))) {
        assert.doesNotMatch(unit, /\bden(?:y|ies|ied)\b/i, `${file}: ${unit}`);
      }
    });
  }

  test('AC-7 global/skills/pr-prep/SKILL.md says that deleting the tag before the merge turns oracle-check off', () => {
    const about = aboutOracleTagChange('global/skills/pr-prep/SKILL.md');
    assert.ok(
      about.some((unit) => /\bask/i.test(unit) && unit.includes('oracle-check')),
      'no paragraph about deleting or moving an oracle tag that asks names oracle-check',
    );
  });
});
