#!/usr/bin/env node
// PreToolUse hook for `codex_delegate` and `codex_follow_up` of both Codex
// registrations (ADR 0014, issue #42). Makes the delegation rules that were
// prose hold for every call:
//
// - A call without `working_dir` is denied: Codex would run in the directory
//   the MCP server started in, not the one the orchestrator works on.
// - A delegation with `use_worktree: true` from a directory with uncommitted
//   or untracked files is denied: the worktree is made from the last commit.
// - A writing delegation of `codex-implementer` without a worktree is denied.
// - A writing follow-up of `codex-implementer` outside a Codex worktree is
//   denied: it would write the work branch directly, past the integration.
//
// A call is writing when its sandbox is `workspace-write` or
// `danger-full-access`; neither registration sets a default, so an omitted
// sandbox is read-only. `codex-reviewer` has a read-only ceiling, so only its
// `working_dir` and worktree status are checked.
//
// A Codex worktree is a git linked worktree whose top-level is inside
// `$CODEX_HOME/worktrees` (`~/.codex` when CODEX_HOME is unset), see codex.mjs.
// When the guard cannot read the directory or its git repository it allows the
// call with a message on stderr (ADR 0002). A call that passes gets no verdict:
// a printed allow would lift the permission prompt (ADR 0010).
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Verdict, failOpen, readEvent } from './lib.mjs';
import { codexWorktreeOf, realPath } from './codex.mjs';

const TOOL = /^mcp__(codex-reviewer|codex-implementer)__(codex_delegate|codex_follow_up)$/;
const WRITING = new Set(['workspace-write', 'danger-full-access']);
const LISTED = 20;

// The uncommitted and untracked paths of the repository at `dir`, ignored
// files left out, or undefined when git cannot read its status.
function dirtyPaths(dir) {
  const run = spawnSync('git', ['--no-optional-locks', 'status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
  if (run.error || run.status !== 0) return undefined;
  return run.stdout.split('\n').filter(Boolean).map((line) => line.slice(3));
}

try {
  const event = readEvent();
  const match = TOOL.exec(event?.tool_name ?? '');
  if (!match) process.exit(0);
  const [, registration, name] = match;
  const input = event.tool_input ?? {};
  const writing = registration === 'codex-implementer' && WRITING.has(input.sandbox);

  const verdict = new Verdict();
  if (typeof input.working_dir !== 'string' || input.working_dir.trim() === '') {
    verdict.add(
      'deny',
      `Pass working_dir to ${name}: without it Codex runs in the directory the MCP server started in, `
        + 'not the one you work on. For a follow-up to a worktree delegation, pass the worktree path.',
    );
    verdict.emit();
  }
  const dir = resolve(event.cwd ?? process.cwd(), input.working_dir);

  if (name === 'codex_delegate') {
    if (writing && input.use_worktree !== true) {
      verdict.add(
        'deny',
        `A writing delegation of codex-implementer (sandbox ${input.sandbox}) runs in a worktree: `
          + 'set use_worktree: true, then integrate it with codex-integrate.mjs.',
      );
    }
    if (input.use_worktree === true) {
      const dirty = dirtyPaths(dir);
      if (dirty === undefined) failOpen('guard-codex', new Error(`cannot read the git status of ${dir}`));
      if (dirty.length > 0) {
        const named = dirty.slice(0, LISTED).join(', ') + (dirty.length > LISTED ? ` and ${dirty.length - LISTED} more` : '');
        verdict.add(
          'deny',
          `${dir} has uncommitted or untracked files: ${named}. The Codex worktree is made from the last commit, `
            + 'so they would be missing from it. Commit what the task needs before delegating, and remove or ignore the rest.',
        );
      }
    }
  } else if (writing) {
    // Decided by git, not the path: a directory under the worktrees directory
    // that is not a repository, such as the <id> directory left once a
    // worktree is removed, or a repository made there with `git init`, is not
    // a Codex worktree.
    const tree = codexWorktreeOf(realPath(dir));
    if (tree === undefined) failOpen('guard-codex', new Error(`cannot read the git repository of ${dir}`));
    if (tree === null) {
      verdict.add(
        'deny',
        `${dir} is not a Codex worktree: a writing codex_follow_up of codex-implementer would resume there and write `
          + 'it directly, past codex-integrate and oracle-check. Pass the worktree path of the delegation as working_dir, '
          + 'or start a new delegation with codex_delegate and use_worktree: true.',
      );
    }
  }
  verdict.emit();
} catch (error) {
  failOpen('guard-codex', error);
}
