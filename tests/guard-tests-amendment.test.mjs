// Issue #64: guard-tests asks, in the main session, before a write to a test path frozen by an
// `oracle/<branch>` tag, instead of denying it, and the question carries the evidence the human needs: the
// repository-relative path, the oracle tag, the commit it points to, and whether the file is amended or
// added. A subagent (an event with agent_id) and a main session in bypassPermissions are still denied. A Bash
// entry of guard-tests in global/settings.json reads the common shell forms that write a file: redirections,
// tee, in-place editing, cp, mv, install, ln, rm, truncate, git checkout, restore and rm, inline
// interpreters, compound commands, globs and find. A command that only reads or runs the tests gets no
// verdict.
//
// Each case runs the entries of global/settings.json that run guard-tests (claude-hooks.mjs), so the Bash
// entry under test is the one that is installed, with a fake `gh` that fails at once first on PATH. Only the
// guard-tests entries run: guard-git has verdicts of its own on some of these commands (git checkout, git
// rm), and they are not the subject here. Nothing runs the commands under test, so the fixtures are only
// read. The fixtures repeat those of hooks.test.mjs: a test file cannot import another without running its
// suites.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { SETTINGS, runConfigured } from './claude-hooks.mjs';

const ORACLE = 'oracle/feature/x';
const FROZEN = 'test/a.test.js';

// The three sessions of the issue. The main session is an event without agent_id and with a permission_mode
// other than bypassPermissions.
const MAIN = { permission_mode: 'default' };
const AUTO = { permission_mode: 'auto' };
const SUBAGENT = { agent_id: 'agent-64', agent_type: 'claude-implementer', permission_mode: 'default' };
const BYPASS = { permission_mode: 'bypassPermissions' };
const BYPASS_REASON = /switch[^.]*to a mode that shows permission prompts/i;

// The PreToolUse entries of global/settings.json that run guard-tests, and nothing else.
const GUARD_TESTS = {
  hooks: {
    PreToolUse: SETTINGS.hooks.PreToolUse.filter((entry) => (entry.hooks ?? []).some((h) => h.command.includes('guard-tests.mjs'))),
  },
};

let scratch;
let offlineBin;
before(() => {
  scratch = mkdtempSync(join(tmpdir(), 'cw-amend-'));
  offlineBin = join(scratch, 'bin');
  mkdirSync(offlineBin);
  writeFileSync(join(offlineBin, 'gh'), '#!/bin/sh\necho "gh: offline" >&2\nexit 1\n', { mode: 0o755 });
});
after(() => rmSync(scratch, { recursive: true, force: true }));

function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function put(dir, files) {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(file)), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
}

// A repository on feature/x whose last commit holds the acceptance tests and package.json, tagged as the
// oracle unless `tag` is false. src/a.js and x are ordinary files beside them.
function repo({ tag = true } = {}) {
  const dir = mkdtempSync(join(scratch, 'repo-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'Test');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  sh(dir, 'config', 'tag.gpgsign', 'false');
  put(dir, { 'README.md': 'x\n', 'src/a.js': 'export const a = 1;\n', x: 'x\n' });
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'chore: init');
  sh(dir, 'checkout', '-q', '-b', 'feature/x');
  put(dir, {
    [FROZEN]: "test('AC-1 works', () => {});\n",
    'test/b.test.js': "test('AC-2 works', () => {});\n",
    'test/nb.ipynb': '{"cells":[]}\n',
    'package.json': '{"scripts":{"test":"node --test"}}\n',
  });
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'test: add acceptance tests');
  if (tag) sh(dir, 'tag', ORACLE);
  return dir;
}

// One tool call through the guard-tests entries of global/settings.json; none may fail, so a missing verdict
// is an assertion failure and not a harness error.
function decide(cwd, tool_name, tool_input, session = MAIN) {
  const result = runConfigured(
    { cwd, tool_name, tool_input, ...session },
    { env: { PATH: `${offlineBin}${delimiter}${process.env.PATH}` }, settings: GUARD_TESTS },
  );
  assert.deepEqual(result.failures, [], result.stderr);
  return result;
}
const bash = (cwd, command, session) => decide(cwd, 'Bash', { command }, session);
const edit = (cwd, file_path, session) => decide(cwd, 'Edit', { file_path, old_string: 'works', new_string: 'passes' }, session);
const write = (cwd, file_path, session) => decide(cwd, 'Write', { file_path, content: 'x\n' }, session);
const notebook = (cwd, notebook_path, session) => decide(cwd, 'NotebookEdit', { notebook_path, new_source: 'x' }, session);

// The verdict for the session: ask in the main session, deny for a subagent, both naming the path and the tag.
function asksAndDenies(cwd, command, path = FROZEN) {
  const main = bash(cwd, command, MAIN);
  assert.equal(main.decision, 'ask', `${command} (main session): ${main.reason}`);
  assert.ok(main.reason.includes(path), `${command}: the reason does not name ${path}: ${main.reason}`);
  assert.ok(main.reason.includes(ORACLE), `${command}: the reason does not name ${ORACLE}: ${main.reason}`);
  const sub = bash(cwd, command, SUBAGENT);
  assert.equal(sub.decision, 'deny', `${command} (subagent): ${sub.reason}`);
  assert.ok(sub.reason.includes(path), `${command}: the reason does not name ${path}: ${sub.reason}`);
  assert.ok(sub.reason.includes(ORACLE), `${command}: the reason does not name ${ORACLE}: ${sub.reason}`);
}

// No verdict from guard-tests in any session: it printed nothing.
function silent(cwd, command) {
  for (const session of [MAIN, SUBAGENT, BYPASS]) {
    const r = bash(cwd, command, session);
    assert.equal(r.explicit, false, `${command} (${JSON.stringify(session)}): ${r.decision} ${r.reason}`);
  }
}

describe('guard-tests asks before an Edit, Write or NotebookEdit of a frozen test in the main session (#64)', () => {
  let dir;
  let short;
  before(() => {
    dir = repo();
    short = sh(dir, 'rev-parse', `${ORACLE}^{commit}`).slice(0, 7);
  });

  test('AC-1 asks for Edit, Write and NotebookEdit of an existing frozen test and names the path, the tag, its commit and that it is amended', () => {
    for (const [tool, r, path] of [
      ['Edit', edit(dir, join(dir, FROZEN)), FROZEN],
      ['Write', write(dir, join(dir, FROZEN)), FROZEN],
      ['NotebookEdit', notebook(dir, join(dir, 'test/nb.ipynb')), 'test/nb.ipynb'],
    ]) {
      assert.equal(r.decision, 'ask', `${tool}: ${r.reason}`);
      assert.ok(r.reason.includes(path), `${tool}: the reason does not name ${path}: ${r.reason}`);
      assert.ok(r.reason.includes(ORACLE), `${tool}: the reason does not name ${ORACLE}: ${r.reason}`);
      assert.ok(r.reason.includes(short), `${tool}: the reason does not name the tag commit ${short}: ${r.reason}`);
      assert.match(r.reason, /\bamended\b/i, `${tool}: the reason does not say the file is amended: ${r.reason}`);
    }
  });

  test('AC-1 asks for a Write that adds a new file under a test path and says it is added', () => {
    const r = write(dir, join(dir, 'test/new.test.js'));
    assert.equal(r.decision, 'ask', r.reason);
    assert.ok(r.reason.includes('test/new.test.js'), r.reason);
    assert.ok(r.reason.includes(ORACLE), r.reason);
    assert.ok(r.reason.includes(short), r.reason);
    assert.match(r.reason, /\badded\b/i, `the reason does not say the file is added: ${r.reason}`);
  });

  test('AC-1 asks in auto mode too', () => {
    const r = edit(dir, join(dir, FROZEN), AUTO);
    assert.equal(r.decision, 'ask', r.reason);
    assert.ok(r.reason.includes(FROZEN) && r.reason.includes(ORACLE), r.reason);
  });

  test('AC-1 resolves a relative file_path against cwd and an absolute one through a symlinked directory', () => {
    const relative = edit(dir, FROZEN);
    assert.equal(relative.decision, 'ask', relative.reason);
    assert.ok(relative.reason.includes(FROZEN), `the reason names the repository-relative path: ${relative.reason}`);
    // On macOS tmpdir() is already under the /var link; the explicit link makes the case hold on Linux too.
    const link = join(mkdtempSync(join(scratch, 'link-')), 'repo');
    symlinkSync(dir, link);
    const linked = edit(link, join(link, FROZEN));
    assert.equal(linked.decision, 'ask', linked.reason);
    assert.ok(linked.reason.includes(FROZEN), `the reason names the repository-relative path: ${linked.reason}`);
  });

  test('AC-2 denies Edit, Write and NotebookEdit of a frozen test for a subagent and names the path and the tag', () => {
    for (const [tool, r, path] of [
      ['Edit', edit(dir, join(dir, FROZEN), SUBAGENT), FROZEN],
      ['Write', write(dir, join(dir, FROZEN), SUBAGENT), FROZEN],
      ['Write (added)', write(dir, join(dir, 'test/new.test.js'), SUBAGENT), 'test/new.test.js'],
      ['NotebookEdit', notebook(dir, join(dir, 'test/nb.ipynb'), SUBAGENT), 'test/nb.ipynb'],
    ]) {
      assert.equal(r.decision, 'deny', `${tool}: ${r.reason}`);
      assert.ok(r.reason.includes(path), `${tool}: ${r.reason}`);
      assert.ok(r.reason.includes(ORACLE), `${tool}: ${r.reason}`);
    }
  });

  test('AC-3 denies an Edit of a frozen test in bypassPermissions and says to switch to a mode that shows permission prompts', () => {
    const r = edit(dir, join(dir, FROZEN), BYPASS);
    assert.equal(r.decision, 'deny', r.reason);
    assert.ok(r.reason.includes(FROZEN) && r.reason.includes(ORACLE), r.reason);
    assert.match(r.reason, BYPASS_REASON);
  });
});

describe('guard-tests reads the Bash forms that write a frozen test (#64)', () => {
  let dir;
  let elsewhere;
  before(() => {
    dir = repo();
    elsewhere = mkdtempSync(join(scratch, 'elsewhere-'));
  });

  test('AC-2 denies a subagent one form of each Bash family', () => {
    for (const command of [
      `echo x > ${FROZEN}`, // AC-4
      `cp x ${FROZEN}`, // AC-5
      `node -e "require('fs').writeFileSync('${FROZEN}','')"`, // AC-6
      `true && sed -i s/a/b/ ${FROZEN}`, // AC-7
      'find test -name \'*.js\' -delete', // AC-8
    ]) {
      const r = bash(dir, command, SUBAGENT);
      assert.equal(r.decision, 'deny', `${command}: ${r.reason}`);
      assert.ok(r.reason.includes(ORACLE), `${command}: ${r.reason}`);
    }
  });

  test('AC-3 denies a Bash redirection into a frozen test in bypassPermissions and says to switch to a mode that shows permission prompts', () => {
    const r = bash(dir, `echo x > ${FROZEN}`, BYPASS);
    assert.equal(r.decision, 'deny', r.reason);
    assert.ok(r.reason.includes(FROZEN) && r.reason.includes(ORACLE), r.reason);
    assert.match(r.reason, BYPASS_REASON);
  });

  const AC4 = [
    ['>', `echo x > ${FROZEN}`],
    ['>>', `echo x >> ${FROZEN}`],
    ['&>', `echo x &> ${FROZEN}`],
    ['>|', `echo x >| ${FROZEN}`],
    ['a heredoc', `cat > ${FROZEN} <<'EOF'\ntest('AC-1 works', () => {});\nEOF`],
    ['tee', `echo x | tee ${FROZEN}`],
    ['tee -a', `echo x | tee -a ${FROZEN}`],
    ['sed -i', `sed -i s/a/b/ ${FROZEN}`],
    ["sed -i '' (BSD)", `sed -i '' s/a/b/ ${FROZEN}`],
    ['sed -i.bak', `sed -i.bak s/a/b/ ${FROZEN}`],
    ['perl -pi -e', `perl -pi -e 's/a/b/' ${FROZEN}`],
    ['ruby -i -pe', `ruby -i -pe 'gsub(/a/, "b")' ${FROZEN}`],
  ];
  for (const [label, command] of AC4) {
    test(`AC-4 asks for ${label} into a frozen test in the main session and denies it for a subagent`, () => {
      asksAndDenies(dir, command);
    });
  }

  const AC5 = [
    ['cp', `cp x ${FROZEN}`, FROZEN],
    ['cp into a directory of tests', 'cp x test/', 'test/'],
    ['mv', `mv x ${FROZEN}`, FROZEN],
    ['install', `install -m 644 x ${FROZEN}`, FROZEN],
    ['ln -sf', `ln -sf x ${FROZEN}`, FROZEN],
    ['rm', `rm ${FROZEN}`, FROZEN],
    ['rm -f with several paths, one frozen', `rm -f src/a.js ${FROZEN} README.md`, FROZEN],
    ['truncate -s 0', `truncate -s 0 ${FROZEN}`, FROZEN],
    ['git checkout --', `git checkout -- ${FROZEN}`, FROZEN],
    ['git checkout <tree-ish> --', `git checkout ${ORACLE} -- ${FROZEN}`, FROZEN],
    ['git restore', `git restore ${FROZEN}`, FROZEN],
    ['git restore --source', `git restore --source=HEAD~1 ${FROZEN}`, FROZEN],
    ['git rm', `git rm ${FROZEN}`, FROZEN],
  ];
  for (const [label, command, path] of AC5) {
    test(`AC-5 asks for ${label} on a frozen test in the main session and denies it for a subagent`, () => {
      asksAndDenies(dir, command, path);
    });
  }

  test('AC-5 asks for git -C <repo> checkout -- of a frozen test from another cwd and denies it for a subagent', () => {
    asksAndDenies(elsewhere, `git -C ${dir} checkout -- ${FROZEN}`);
  });

  const AC6 = [
    ['node -e', `node -e "require('fs').writeFileSync('${FROZEN}','')"`],
    ['node --eval', `node --eval "require('fs').writeFileSync('${FROZEN}','')"`],
    ['node -p', `node -p "require('fs').writeFileSync('${FROZEN}','')"`],
    ['python3 -c', `python3 -c "open('${FROZEN}', 'w').write('')"`],
    ['perl -e', `perl -e "unlink '${FROZEN}'"`],
    ['ruby -e', `ruby -e "File.write('${FROZEN}', '')"`],
    ['bash -c as a nested command', `bash -c "echo x > ${FROZEN}"`],
    ['sh -c as a nested command', `sh -c "sed -i s/a/b/ ${FROZEN}"`],
  ];
  for (const [label, command] of AC6) {
    test(`AC-6 asks for ${label} naming a frozen test in the main session and denies it for a subagent`, () => {
      asksAndDenies(dir, command);
    });
  }

  test('AC-6 gives no verdict for bash -c whose nested command only reads a frozen test', () => {
    silent(dir, `bash -c "cat ${FROZEN}"`);
  });

  const AC7 = [
    ['after &&', `true && echo x > ${FROZEN}`],
    ['after ;', `true; echo x > ${FROZEN}`],
    ['after ||', `false || echo x > ${FROZEN}`],
    ['a pipe ending in tee', `cat src/a.js | sort | tee ${FROZEN}`],
    ['a subshell', `(echo x > ${FROZEN})`],
  ];
  for (const [label, command] of AC7) {
    test(`AC-7 asks for a write to a frozen test ${label} in the main session and denies it for a subagent`, () => {
      asksAndDenies(dir, command);
    });
  }

  test('AC-7 asks for sed -i on a relative path after cd into the test directory and denies it for a subagent', () => {
    asksAndDenies(dir, 'cd test && sed -i s/a/b/ a.test.js');
  });

  test('AC-7 asks for sed -i with a glob that expands on disk to a frozen test and denies it for a subagent', () => {
    asksAndDenies(dir, 'sed -i s/a/b/ test/*.test.js');
  });

  const AC8 = [
    ['-delete', "find test -name '*.js' -delete"],
    ['-exec sed -i', 'find test -exec sed -i s/a/b/ {} +'],
    ['-execdir sed -i', "find test -name '*.js' -execdir sed -i s/a/b/ {} \\;"],
    ['piped to xargs sed -i', "find test -name '*.js' | xargs sed -i s/a/b/"],
  ];
  for (const [label, command] of AC8) {
    test(`AC-8 asks for find over frozen tests with ${label} in the main session and denies it for a subagent`, () => {
      asksAndDenies(dir, command, 'test/');
    });
  }

  test('AC-8 gives no verdict for find that only prints frozen tests', () => {
    silent(dir, "find test -name '*.js' -print");
  });

  test('AC-10 asks for a Bash redirection and sed -i into package.json, in the main session and for a subagent', () => {
    for (const command of ['echo {} > package.json', 'sed -i s/node/vitest/ package.json']) {
      for (const session of [MAIN, SUBAGENT]) {
        const r = bash(dir, command, session);
        assert.equal(r.decision, 'ask', `${command} (${JSON.stringify(session)}): ${r.reason}`);
        assert.ok(r.reason.includes('package.json'), `${command}: ${r.reason}`);
      }
    }
  });
});

describe('guard-tests gives no verdict on Bash that only reads or runs frozen tests (#64)', () => {
  let dir;
  let untagged;
  let loose;
  before(() => {
    dir = repo();
    untagged = repo({ tag: false });
    loose = mkdtempSync(join(scratch, 'loose-'));
    put(loose, { [FROZEN]: "test('AC-1 works', () => {});\n", x: 'x\n' });
  });

  const READS = [
    `cat ${FROZEN}`,
    `grep -n x ${FROZEN}`,
    `head ${FROZEN}`,
    `wc -l ${FROZEN}`,
    `git diff -- ${FROZEN}`,
    `git show HEAD:${FROZEN}`,
    `git log -- ${FROZEN}`,
    `node --test ${FROZEN}`,
    'npm test',
    `npx vitest run ${FROZEN}`,
    `sort < ${FROZEN} > out.txt`,
    'echo x > src/a.js',
    'sed -i s/a/b/ src/a.js',
    `cp ${FROZEN} /tmp/copy.js`,
  ];
  for (const command of READS) {
    test(`AC-9 gives no verdict for ${command.split('\n')[0]}`, () => {
      silent(dir, command);
    });
  }

  const WRITES = [`echo x > ${FROZEN}`, `sed -i s/a/b/ ${FROZEN}`, `rm ${FROZEN}`, `git checkout -- ${FROZEN}`, `node -e "require('fs').writeFileSync('${FROZEN}','')"`];

  test('AC-9 gives no verdict for any writing form when no oracle tag exists', () => {
    for (const command of WRITES) silent(untagged, command);
  });

  test('AC-9 gives no verdict for any writing form outside a git repository', () => {
    for (const command of WRITES) silent(loose, command);
  });
});

// ADR 0016: in a linked worktree a delegate's branch descends from the oracle commit, and the nearest
// oracle tag binds it. The Bash entry follows the same binding as Edit.
describe('guard-tests binds a linked worktree for Bash too (#64)', () => {
  test('AC-2 denies a subagent a redirection into a frozen test in a linked worktree that descends from the oracle commit', () => {
    const dir = repo();
    const wt = join(mkdtempSync(join(scratch, 'trees-')), 'delegate');
    sh(dir, 'worktree', 'add', '-q', '-b', 'worktree-agent-64', wt, ORACLE);
    const r = bash(wt, `echo x > ${FROZEN}`, SUBAGENT);
    assert.equal(r.decision, 'deny', r.reason);
    assert.ok(r.reason.includes(FROZEN) && r.reason.includes(ORACLE), r.reason);
  });
});
