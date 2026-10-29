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

When the fresh context is a subagent, it loads no `CLAUDE.md`, so the
invariants and conventions the task touches arrive in its package, built with
`task-package`.

Do not read the transcript of the session that wrote the tests.

## Rules

- **Never modify the oracle to make it pass.** That covers editing, deleting,
  skipping or disabling tests (`@Ignore`, `@Disabled`, `skip:`, `.skip`,
  `xit`), narrowing test filters, changing fixtures or expected outputs,
  changing test configuration, adding static-analysis baselines, and
  introducing mocks or test-only branches into production code. Hard-coding
  results for the values the tests use is the same thing.
- The user-level guard asks before amending frozen test paths in the main
  session, where the human approves the amendment in the tool's prompt;
  subagents and bypassPermissions are denied (ADR 0033). It reads Edit,
  Write, NotebookEdit and common Bash writes, and asks before edits to build
  and test configuration. Treat a denial as a stop sign.

## Escape valve

When a test seems wrong, contradictory or impossible:

1. Stop implementing.
2. Explain which test, which criterion, and why, with evidence (the failing
   assertion and the behaviour the criterion actually asks for).
3. Wait for approval. The main session asks before amending a frozen test,
   and the human approves in the tool's prompt. The amendment goes into its own commit,
   `test(<scope>): amend AC-n for #<issue>`, and the reason is recorded on the
   issue. Then move the oracle tag to that commit; moving it asks in the main
   session (ADR 0029). Subagents and bypassPermissions stay denied.

Until the oracle tag moves, the merge guard (ADR 0030) finds test paths changed
against the tag, so the agent's merge cannot go through without the human.

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

Before merging, the merge guard compares the pull request's head with the
`oracle/<head branch>` tag on the base repository's remote and asks when test
paths changed, the label `atdd` has no tag, or the oracle cannot be read.
These cases deny in bypassPermissions. The comparison uses committed trees
and the test paths recorded in the oracle commit, without fetching (ADR 0030).
