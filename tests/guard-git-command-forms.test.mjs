// Issue #57 (ADR 0030), second review: three command forms that guard-git reads differently from the shell,
// gh or git. A hook that prints allow lifts the prompt for the whole command, so the explicit allow must
// only be given when the hook read exactly the pull request the shell will merge (ADR 0010).
//
// A. A word that starts with `#` is a shell comment: bash and zsh -c drop it and everything after it. In
//    `gh pr merge -s #12` the shell merges the pull request of the current branch, while gh reads `#12` as
//    the selector 12. The hook must not give the explicit allow to a command that holds a comment, and the
//    `gh pr view` it runs must read the pull request the shell merges: no selector for `-s #12`, the
//    selector 12 for `12 -s # note`. A `#` inside a word (`-t fix#3`) is not a comment.
// B. `gh pr` takes persistent flags (-R, --repo) before the subcommand: `gh pr -R o/x merge 12 -s` merges.
//    The merge entry's `if` (Bash(*gh pr merge *)) does not start for it, so the denial must come through
//    the configured entries as a whole. gh accepts the same flags after `merge`, where the guard reads them.
// D. `git tag --column -d oracle/x`: git's --column takes a value only with `=` (PARSE_OPT_OPTARG), so it
//    never consumes the next word and `-d` deletes the tag; `--colu` and `--colum` abbreviate it. The guard
//    reads that as a deletion, exactly as for `git tag -d oracle/x` (ADR 0029).
//
// Each case runs the Bash entries of global/settings.json through claude-hooks.mjs with the real hooks,
// with a fake `gh` and a fake `git` first on PATH, as guard-git-merge-flags.test.mjs and
// guard-git-oracle-tags.test.mjs do (their fixtures are repeated here: a test file cannot import another
// without running its suites). The repositories are temporary, so no case touches the network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { runConfigured } from './claude-hooks.mjs';
import { writeExecutable } from './executables.mjs';

// Git answers in the language of the machine and reads its user configuration; the fixtures and the hook
// get neither, and a developer's signing configuration cannot reach the commits.
const GIT_ENV = {
  LC_ALL: 'C',
  LANG: 'C',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

// The real git, by absolute path, resolved before the fake one is put on PATH.
const REAL_GIT = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();

function sh(cwd, ...args) {
  const r = spawnSync(REAL_GIT, args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

// A fake `gh` stands in for GitHub. It logs its arguments (one JSON line a call) and answers `gh pr view`
// from the scenario's `view` and `gh pr list` from its `list`, which must be asked for `--head <head>` when
// the scenario names one; `gh api user` answers from `user`, any other `gh api` from `api`.
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_GH, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args }) + '\n');
const at = args.findIndex((arg) => arg === '--head' || arg.startsWith('--head='));
const head = at < 0 ? undefined : args[at].includes('=') ? args[at].slice('--head='.length) : args[at + 1];
let step = { exit: 1, stderr: 'fake gh: unexpected call' };
if (args[0] === 'pr' && args[1] === 'view') step = scenario.view || step;
else if (args[0] === 'pr' && args[1] === 'list') {
  step = scenario.head !== undefined && head !== scenario.head
    ? { exit: 1, stderr: 'fake gh: pr list was not asked for --head ' + scenario.head }
    : scenario.list || { exit: 1, stderr: 'fake gh: no list scenario' };
} else if (args[0] === 'api') {
  step = (args.some((arg) => arg === 'user' || arg === '/user') ? scenario.user : scenario.api) || step;
}
if (step.stderr) process.stderr.write(step.stderr);
if (step.stdout !== undefined) process.stdout.write(typeof step.stdout === 'string' ? step.stdout : JSON.stringify(step.stdout));
process.exit(step.exit === undefined ? 0 : step.exit);
`;

// A fake `git` first on PATH: ls-remote answers "no tag", the rest runs the real git by absolute path.
const FAKE_GIT = String.raw`#!/bin/sh
case " $* " in
  *" ls-remote "*) exit 0 ;;
esac
exec "$REAL_GIT" "$@"
`;

const NOT_FOUND = { exit: 1, stderr: 'gh: Not Found (HTTP 404)' };
const PASSED = { __typename: 'CheckRun', name: 'Test', status: 'COMPLETED', conclusion: 'SUCCESS' };

// A pull request that meets every other condition of the merge decision.
function green(rest = {}) {
  return {
    number: 12,
    state: 'OPEN',
    isDraft: false,
    labels: [],
    baseRefName: 'main',
    url: 'https://github.com/o/r/pull/12',
    author: { login: 'me', is_bot: false },
    isCrossRepository: false,
    headRepositoryOwner: { login: 'o' },
    headRepository: { name: 'r' },
    files: [{ path: 'src/app.ts' }],
    changedFiles: 1,
    statusCheckRollup: [PASSED],
    headRefName: 'feature/x',
    ...rest,
  };
}

const OPEN_PR = { number: 7, url: 'https://github.com/o/r/pull/7', headRefName: 'x', state: 'OPEN' };

describe('guard-git command forms: comments, gh pr flags before merge, git tag --column (#57 second review)', () => {
  let scratch;
  let bin;
  let fx;
  let counter = 0;
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cw-command-forms-'));
    bin = join(scratch, 'bin');
    mkdirSync(bin);
    writeExecutable(join(bin, 'gh'), FAKE_GH);
    writeExecutable(join(bin, 'git'), FAKE_GIT);
    // A clone of o/r on github.com, on feature/x with a clean working tree and one commit after main. The
    // tags oracle/x and v1.0.0 exist at the first commit.
    const dir = mkdtempSync(join(scratch, 'clone-'));
    sh(dir, 'init', '-q', '-b', 'main');
    sh(dir, 'config', 'user.email', 'test@example.com');
    sh(dir, 'config', 'user.name', 'Test');
    sh(dir, 'config', 'commit.gpgsign', 'false');
    sh(dir, 'config', 'tag.gpgsign', 'false');
    sh(dir, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'README.md'), 'x\n');
    writeFileSync(join(dir, 'src', 'app.ts'), 'app\n');
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-q', '-m', 'chore: init');
    sh(dir, 'tag', 'v1.0.0');
    sh(dir, 'tag', 'oracle/x');
    sh(dir, 'checkout', '-q', '-b', 'feature/x');
    writeFileSync(join(dir, 'src', 'app.ts'), 'app2\n');
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-q', '-m', 'feat: code');
    fx = { dir, head: sh(dir, 'rev-parse', 'HEAD') };
  });
  after(() => rmSync(scratch, { recursive: true, force: true }));

  // One Bash call through every entry of global/settings.json that applies to it. `pr` overrides fields of
  // the green pull request that `gh pr view` answers; `list` is what `gh pr list` answers, for `--head`
  // `head` when given.
  function decide(command, { pr = {}, list = { stdout: [] }, head, extra = {} } = {}) {
    counter += 1;
    const gh = join(scratch, `gh-${counter}.json`);
    const ghLog = join(scratch, `gh-${counter}.log`);
    writeFileSync(gh, JSON.stringify({
      view: { stdout: green({ headRefOid: fx.head, ...pr }) },
      list,
      head,
      api: NOT_FOUND,
      user: { stdout: { login: 'me' } },
    }));
    const result = runConfigured({ cwd: fx.dir, tool_name: 'Bash', tool_input: { command }, ...extra }, {
      env: {
        ...GIT_ENV,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        FAKE_GH: gh,
        FAKE_GH_LOG: ghLog,
        REAL_GIT,
        GUARD_GIT_GH_BUDGET_MS: '8000',
        GUARD_GIT_GH_TIMEOUT_MS: '3000',
      },
    });
    const calls = existsSync(ghLog) ? readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    return { ...result, calls };
  }

  const wellRun = (result, name) => assert.deepEqual(result.failures, [], `${name}: ${result.stderr}`);
  const allowsExplicitly = (result, name) => {
    wellRun(result, name);
    assert.equal(result.decision, 'allow', `${name}: ${result.reason}`);
    assert.equal(result.explicit, true, `${name}: the explicit allow of a clean merge was expected`);
  };
  const notExplicitAllow = (result, name) => {
    assert.ok(!(result.decision === 'allow' && result.explicit), `${name}: the explicit allow was given: ${result.reason}`);
  };
  const denies = (result, name, ...needles) => {
    wellRun(result, name);
    assert.equal(result.decision, 'deny', `${name}: ${result.reason}`);
    for (const needle of needles) assert.match(result.reason, needle, name);
  };
  const asks = (result, name, ...needles) => {
    wellRun(result, name);
    assert.equal(result.decision, 'ask', `${name}: ${result.reason}`);
    for (const needle of needles) assert.match(result.reason, needle, name);
  };

  // The `gh pr view` calls of a run, and the selector each one names: the first word after `pr view` when
  // it is not a flag.
  const viewsOf = (calls) => calls.filter((call) => call.args[0] === 'pr' && call.args[1] === 'view');
  const selectorOf = (call) => (call.args[2] !== undefined && !call.args[2].startsWith('-') ? call.args[2] : undefined);

  // A. The words from a `#` on are a comment: the shell never passes them to gh.
  const COMMENT_NO_SELECTOR = ['gh pr merge -s #12', 'gh pr merge -s #12 note', 'gh pr merge --squash #'];
  const COMMENT_AFTER_SELECTOR = ['gh pr merge 12 -s # note', 'gh pr merge 12 -s #note', 'gh pr merge 12 -s #13', 'gh pr merge 12 --squash # 13'];

  for (const command of [...COMMENT_NO_SELECTOR, ...COMMENT_AFTER_SELECTOR]) {
    test(`A (#57) never gives the explicit allow to ${command}: the shell drops the comment, so what the hook read is not what it merges`, () => {
      const r = decide(command);
      wellRun(r, command);
      notExplicitAllow(r, command);
    });
  }

  for (const command of COMMENT_NO_SELECTOR) {
    test(`A (#57) reads the pull request of the current branch, with no selector, for ${command}`, () => {
      const r = decide(command);
      wellRun(r, command);
      for (const view of viewsOf(r.calls)) {
        assert.equal(selectorOf(view), undefined, `${command}: gh pr view was called with ${JSON.stringify(view.args)}`);
      }
    });
  }

  for (const command of COMMENT_AFTER_SELECTOR) {
    test(`A (#57) reads pull request 12, and only that, for ${command}`, () => {
      const r = decide(command);
      wellRun(r, command);
      for (const view of viewsOf(r.calls)) {
        assert.equal(selectorOf(view), '12', `${command}: gh pr view was called with ${JSON.stringify(view.args)}`);
      }
    });
  }

  test('A (#57) control: gh pr merge 12 -s on the same green, oracle-clean pull request still gets the explicit allow, reading pull request 12', () => {
    const r = decide('gh pr merge 12 -s');
    allowsExplicitly(r, 'gh pr merge 12 -s');
    const views = viewsOf(r.calls);
    assert.ok(views.length > 0, 'gh pr view was not called');
    for (const view of views) assert.equal(selectorOf(view), '12', JSON.stringify(view.args));
  });

  test('A (#57) control: a # inside a word, as in gh pr merge 12 -s -t fix#3, is not a comment: the hook still reads pull request 12', () => {
    const command = 'gh pr merge 12 -s -t fix#3';
    const r = decide(command);
    wellRun(r, command);
    const views = viewsOf(r.calls);
    assert.ok(views.length > 0, `${command}: gh pr view was not called`);
    for (const view of views) assert.equal(selectorOf(view), '12', `${command}: ${JSON.stringify(view.args)}`);
    assert.notEqual(r.decision, 'deny', `${command}: ${r.reason}`);
  });

  // B. Flags of `gh pr` before `merge`: gh merges, the merge entry does not start, so the whole set of
  // entries must deny, and say where to write the flags.
  const FLAGS_BEFORE_MERGE = [
    'gh pr -R o/x merge 12 --squash',
    'gh pr -Ro/x merge 12 -s',
    'gh pr --repo o/x merge 12 --admin',
    'gh pr --repo=o/x merge 12 -s',
    '/opt/homebrew/bin/gh pr -R o/x merge 12 -s',
  ];
  const WRITE_AFTER_MERGE = /\bafter\b.{0,30}\bmerge\b/i;
  const SESSIONS = {
    'the main session': {},
    bypassPermissions: { permission_mode: 'bypassPermissions' },
    'a subagent': { agent_id: 'agent-1' },
  };

  for (const command of FLAGS_BEFORE_MERGE) {
    for (const [who, extra] of Object.entries(SESSIONS)) {
      test(`B (#57) denies ${command} for ${who} and says to write the flags after merge`, () => {
        const r = decide(command, { extra });
        denies(r, `${command} (${who})`, WRITE_AFTER_MERGE);
        assert.equal(r.explicit, true, `${command} (${who}): a denial is printed by a hook`);
      });
    }
  }

  for (const command of ['gh pr -R o/x view 12', 'gh pr -R o/x list']) {
    for (const [who, extra] of Object.entries(SESSIONS)) {
      test(`B (#57) control: ${command} gets no denial that tells to write the flags after merge, for ${who}`, () => {
        const r = decide(command, { extra });
        assert.doesNotMatch(r.reason, WRITE_AFTER_MERGE, `${command} (${who}): ${r.reason}`);
      });
    }
    test(`B (#57) control: ${command} is not denied in the main session`, () => {
      const r = decide(command);
      wellRun(r, command);
      assert.notEqual(r.decision, 'deny', `${command}: ${r.reason}`);
    });
  }

  // D. `--column` takes a value only with `=`; `-d` after it is the deletion flag. `oracle/x` is the tag of
  // the branch x, whose open pull request the question must show (the evidence of ADR 0029).
  const COLUMN_DELETES = [
    'git tag --colu -d oracle/x',
    'git tag --colum -d oracle/x',
    'git tag --column -d oracle/x',
    'git tag --column=always -d oracle/x',
  ];
  const MODES = [undefined, 'default', 'auto', 'acceptEdits'];

  for (const command of COLUMN_DELETES) {
    test(`D (#57) asks, in the main session, for ${command} as a deletion, with the pull request still open as evidence`, () => {
      for (const mode of MODES) {
        const extra = mode === undefined ? {} : { permission_mode: mode };
        const open = decide(command, { extra, head: 'x', list: { stdout: [OPEN_PR] } });
        asks(open, `${command} (permission_mode ${mode})`, /Delete oracle\/x\b/, /still open/i, /oracle-check/);
        assert.ok(open.reason.includes(OPEN_PR.url), `${command}: the reason lacks the URL: ${open.reason}`);
        const none = decide(command, { extra, head: 'x', list: { stdout: [] } });
        asks(none, `${command} (permission_mode ${mode}, no open pull request)`, /Delete oracle\/x\b/);
        assert.doesNotMatch(none.reason, /still open/i, command);
      }
    });

    test(`D (#57) denies a subagent that runs ${command}`, () => {
      denies(decide(command, { extra: { agent_id: 'agent-1' } }), command);
    });

    test(`D (#57) denies ${command} in bypassPermissions and says to switch to a mode that shows prompts`, () => {
      denies(decide(command, { extra: { permission_mode: 'bypassPermissions' } }), command, /bypassPermissions/, /prompt/i);
    });
  }

  test('D (#57) control: git tag -d oracle/x is asked as a deletion and denied for a subagent and bypassPermissions, the reference of the forms above', () => {
    asks(decide('git tag -d oracle/x', { head: 'x', list: { stdout: [OPEN_PR] } }), 'git tag -d oracle/x', /Delete oracle\/x\b/, /still open/i);
    denies(decide('git tag -d oracle/x', { extra: { agent_id: 'agent-1' } }), 'git tag -d oracle/x (subagent)');
    denies(decide('git tag -d oracle/x', { extra: { permission_mode: 'bypassPermissions' } }), 'git tag -d oracle/x (bypassPermissions)', /bypassPermissions/);
  });

  test('D (#57) control: git tag --column alone stays a read: no ask, no deny', () => {
    for (const extra of [{}, { permission_mode: 'bypassPermissions' }, { agent_id: 'agent-1' }]) {
      const r = decide('git tag --column', { extra });
      wellRun(r, 'git tag --column');
      assert.notEqual(r.decision, 'ask', `git tag --column ${JSON.stringify(extra)}: ${r.reason}`);
      assert.notEqual(r.decision, 'deny', `git tag --column ${JSON.stringify(extra)}: ${r.reason}`);
    }
  });
});
