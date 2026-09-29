#!/usr/bin/env node
// PreToolUse hook for Edit, Write, MultiEdit and NotebookEdit. Enforces phase 2
// of the basic ATDD workflow (ADR 0003): while a tag `oracle/<branch>` exists in
// the repository of the edited file, the approved tests are frozen.
//
// - Edits to test paths are denied.
// - Edits to files that change how tests run (build and test configuration)
//   ask first.
//
// The paths are defined in oracle.mjs. This is a guard against accidents: Bash
// and a deleted tag get around it, `oracle-check` catches what got through
// before a pull request, and a CI oracle check closes the gap later.
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Verdict, failOpen, git, readEvent } from './lib.mjs';
import { isTest, isTestConfig, oracleTag, testMatchers } from './oracle.mjs';

// Resolves symlinks in the part of the path that exists, so the result is
// comparable with `git rev-parse --show-toplevel` (on macOS, /var is a link to
// /private/var). The file itself may not exist yet when Write creates it.
function realPath(path) {
  let dir = dirname(path);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  const real = realpathSync(dir);
  return { dir: real, file: join(real, relative(dir, path)) };
}

try {
  const event = readEvent();
  const input = event?.tool_input ?? {};
  const raw = input.file_path ?? input.notebook_path;
  if (typeof raw !== 'string') process.exit(0);

  const cwd = event.cwd ?? process.cwd();
  const { dir, file } = realPath(isAbsolute(raw) ? raw : resolve(cwd, raw));
  const root = git(dir, ['rev-parse', '--show-toplevel']);
  if (!root) process.exit(0);
  const tag = oracleTag(root);
  if (!tag) process.exit(0);

  const rel = relative(root, file).split(sep).join('/');
  if (rel.startsWith('../')) process.exit(0);

  const verdict = new Verdict();
  if (isTest(testMatchers(root, tag), rel)) {
    verdict.add(
      'deny',
      `${rel} belongs to the test oracle frozen at ${tag}. Do not change tests to make them pass. `
        + 'If a test is wrong, stop and explain why to the human; an approved change goes in its own commit.',
    );
  } else if (isTestConfig(rel)) {
    verdict.add('ask', `${rel} can change how the frozen tests at ${tag} run. Confirm this edit does not weaken them.`);
  }
  verdict.emit();
} catch (error) {
  failOpen('guard-tests', error);
}
