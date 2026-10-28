// Issue #66: three tests failed on some runs and not on others, for causes the suite itself could fix.
// AC-2: a hook whose shell exits 127 (node not on PATH) before it has read a large event must be reported
// as "exited with 127", not as "could not run (... EPIPE)". AC-3: the codex-integrate cases must not depend
// on the temporary directory's name, which can hold the id of a Codex worktree such as w1. AC-4: a fake
// executable that a hook will run is run once, harmlessly, by tests/executables.mjs before the hook's time
// budget starts, because macOS assesses a new executable on its first run and that can take seconds. These
// cases run the hook tests' own helpers, so they guard the fixtures and not the hooks.
// Hook tests are POSIX-only (/bin/sh, shebangs), so the suite is skipped on win32.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runConfigured } from './claude-hooks.mjs';

const tests = dirname(fileURLToPath(import.meta.url));
const posix = process.platform === 'win32' ? 'the hook tests are POSIX-only' : false;

const scratch = [];
const tmp = (prefix, parent = tmpdir()) => {
  const dir = mkdtempSync(join(parent, prefix));
  scratch.push(dir);
  return dir;
};
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

describe('AC-2 (#66) a shell that exits before reading the event is reported by its exit status', { skip: posix }, () => {
  const COMMAND = 'node "$HOME/.claude/hooks/guard-git.mjs" --skip-merge';
  const settings = (extra = {}) => ({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: COMMAND, timeout: 10, ...extra }] }] },
  });
  // About 200 KB, well past the 64 KB pipe buffer, so the shell is gone before the event is fully written.
  const event = { tool_name: 'Bash', cwd: tmpdir(), tool_input: { command: `echo ${'x'.repeat(200 * 1024)}` } };
  const noNode = () => tmp('cw-flaky-empty-path-');

  test('AC-2 (#66) an entry without onFailure fails with "exited with 127", never with EPIPE', () => {
    const result = runConfigured(event, { settings: settings(), path: noNode() });
    assert.equal(result.failures.length, 1, `one failed run expected, got ${JSON.stringify(result)}`);
    assert.match(result.failures[0], /exited with 127/);
    assert.doesNotMatch(result.failures[0], /EPIPE/);
    assert.equal(result.decision, 'allow', 'a failed run without onFailure lets the call go on');
  });

  test('AC-2 (#66) an entry with onFailure "block" denies with a reason that says "exited with 127", never EPIPE', () => {
    const result = runConfigured(event, { settings: settings({ onFailure: 'block' }), path: noNode() });
    assert.equal(result.decision, 'deny', JSON.stringify(result));
    assert.match(result.reason, /exited with 127/);
    assert.doesNotMatch(result.reason, /EPIPE/);
  });
});

describe('AC-3 (#66) codex-integrate does not depend on the name of the temporary directory', { skip: posix }, () => {
  test('AC-3 (#66) every codex-integrate case passes when TMPDIR holds the ids w1 to w5', { timeout: 280000 }, () => {
    const tmpdirWithIds = tmp('cw-flaky-w1-w2-w3-w4-w5-');
    const env = { ...process.env, TMPDIR: tmpdirWithIds };
    // A child of a test run would otherwise report to its parent instead of through the reporter.
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ['--test', '--test-reporter=spec', join(tests, 'codex-integrate.test.mjs')], {
      encoding: 'utf8',
      env,
      timeout: 270000,
    });
    assert.equal(run.status, 0, `node --test exited with ${run.status}${run.error ? ` (${run.error.message})` : ''}:\n${run.stdout}\n${run.stderr}`);
  });
});

// The ways a test file can write an executable. The lines of the allowed cases are named by file and by the
// text that identifies them, each with the reason the fix leaves it alone.
const WRITES = [
  { kind: 'writeFileSync with an executable mode', pattern: /\bmode:\s*0o7[0-7]{2}/ },
  { kind: 'chmodSync to an executable mode', pattern: /\bchmodSync\(.*0o7[0-7]{2}/ },
];
const ALLOWED = [
  {
    file: 'install-codex-060-gaps.test.mjs',
    line: /chmodSync\(join\(bin, 'npx'\)/,
    reason: 'G1 hanging npx has an absolute node shebang, so warming it would run the hang; its first run sits in a 59-80 s window, not in a hook budget',
  },
  {
    file: 'guard-git-local-work.test.mjs',
    line: /chmodSync\(wt, /,
    reason: 'chmod of a worktree directory to make it unreadable and back, not an executable',
  },
  {
    file: 'install-backups.test.mjs',
    line: /chmodSync\(join\(dir, 'global', 'hooks', 'demo-hook\.mjs'\)/,
    reason: 'a demo hook that the installer copies and the tests only read, never run',
  },
  {
    file: 'install-review-fixes.test.mjs',
    line: /chmodSync\(join\(dir, 'global', 'hooks', 'demo-hook\.mjs'\)/,
    reason: 'a demo hook that the installer copies and the tests only read, never run',
  },
];

describe('AC-4 (#66) a fake executable has run once before a hook runs it', { skip: posix }, () => {
  test('AC-4 (#66) no test file writes an executable except through writeExecutable of tests/executables.mjs', () => {
    const found = [];
    for (const name of readdirSync(tests).filter((n) => n.endsWith('.mjs') && n !== 'executables.mjs').sort()) {
      readFileSync(join(tests, name), 'utf8').split('\n').forEach((text, index) => {
        for (const { kind, pattern } of WRITES) {
          if (!pattern.test(text)) continue;
          if (ALLOWED.some((a) => a.file === name && a.line.test(text))) continue;
          found.push(`tests/${name}:${index + 1}: ${kind}: ${text.trim()}`);
        }
      });
    }
    assert.deepEqual(found, [], `write these executables with writeExecutable(path, content) from ./executables.mjs:\n${found.join('\n')}`);
  });

  test('AC-4 (#66) the allowlist names only files that exist and lines that are still there', () => {
    for (const { file, line } of ALLOWED) {
      const text = readFileSync(join(tests, file), 'utf8');
      assert.ok(text.split('\n').some((l) => line.test(l)), `${file} no longer has a line matching ${line}; drop its allowlist entry`);
    }
  });

  const load = async () => (await import('./executables.mjs')).writeExecutable;

  test('AC-4 (#66) writeExecutable writes the content with an executable mode', async () => {
    const writeExecutable = await load();
    const file = join(tmp('cw-flaky-exe-'), 'tool');
    const content = '#!/bin/sh\nexit 0\n';
    writeExecutable(file, content);
    assert.equal(readFileSync(file, 'utf8'), content);
    assert.equal(statSync(file).mode & 0o777, 0o755);
  });

  test('AC-4 (#66) writeExecutable runs a node script once without running its content', async () => {
    const writeExecutable = await load();
    const dir = tmp('cw-flaky-exe-');
    const log = join(dir, 'node.log');
    const file = join(dir, 'fake-node-tool');
    writeExecutable(file, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, 'ran\\n');\n`);
    assert.equal(existsSync(log), false, 'the warm-up run executed the script');
    // The script does work: with node on PATH it writes the log, so the check above is not vacuous.
    const env = { PATH: `${dirname(process.execPath)}${delimiter}/usr/bin${delimiter}/bin` };
    assert.equal(spawnSync(file, { env }).status, 0);
    assert.equal(readFileSync(log, 'utf8'), 'ran\n');
  });

  test('AC-4 (#66) writeExecutable runs a shell script once without running its content', async () => {
    const writeExecutable = await load();
    const dir = tmp('cw-flaky-exe-');
    const marker = join(dir, 'marker');
    const file = join(dir, 'fake-sh-tool');
    // touch is looked up on PATH, so it cannot run when the warm-up run has no PATH.
    writeExecutable(file, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    assert.equal(existsSync(marker), false, 'the warm-up run executed the script');
    const env = { PATH: `/usr/bin${delimiter}/bin` };
    assert.equal(spawnSync(file, { env }).status, 0);
    assert.equal(existsSync(marker), true, 'the script writes its marker when it has a PATH');
  });
});
