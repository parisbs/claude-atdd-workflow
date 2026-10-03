---
name: atdd-implement
description: Phase 2 of the ATDD workflow. Implement against the frozen oracle/<branch> tests without modifying them, stopping to ask when a test looks wrong. Use only when an oracle/<branch> tag already freezes the approved tests for the issue.
argument-hint: <issue number>
---

Implement issue $ARGUMENTS against its frozen acceptance tests.

## Start from what was approved, not from how it was reached

Run this in a fresh context: a new session, or a subagent that receives only
what is listed here. Read only:

- the issue and its criterion-to-test comment (`gh issue view <n> --comments`);
- the oracle: `git show --stat oracle/<branch>` and the tests it contains;
- the repository's `CLAUDE.md`.

Do not read the transcript of the session that wrote the tests.

## Rules

- **Never modify the oracle to make it pass.** That covers editing, deleting,
  skipping or disabling tests (`@Ignore`, `@Disabled`, `skip:`, `.skip`,
  `xit`), narrowing test filters, changing fixtures or expected outputs,
  changing test configuration, adding static-analysis baselines, and
  introducing mocks or test-only branches into production code. Hard-coding
  results for the values the tests use is the same thing.
- The user-level guard denies edits to the frozen test paths and asks before
  edits to build and test configuration. Treat a denial as a stop sign, not as
  an obstacle to route around through the shell.

## Escape valve

When a test seems wrong, contradictory or impossible:

1. Stop implementing.
2. Explain which test, which criterion, and why, with evidence (the failing
   assertion and the behaviour the criterion actually asks for).
3. Wait. If the human approves a change, it goes into its own commit,
   `test(<scope>): amend AC-n for #<issue>`, the human moves the oracle tag,
   and the reason is recorded on the issue.

## Loop

Implement in small steps. After each, run the narrowest tests that cover it,
then the repository's verify command before declaring the work done. Report
iterations honestly: which tests went green, which are still red, and what was
not run (for example instrumented tests without a device).

## Finish

Run `node ~/.claude/hooks/oracle-check.mjs` from the repository root. It
compares the branch, including uncommitted and untracked files, with the oracle
tag using the same paths the guard protects. It must report the test paths as
unchanged; any test-configuration change or added skip it lists needs an
explanation. Then continue with `/pr-prep`.
