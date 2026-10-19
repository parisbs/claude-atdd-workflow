---
status: accepted
date: 2026-09-29
---
# 0003. Approved executable tests replace prose behaviour specifications


## Context

Spec-driven development frameworks keep behaviour specifications as Markdown
that nothing checks against the code, and they drift. Tests that a human has
validated work both as instruction and as verification, while tests an agent
writes on its own add little. Frontier models attempt to game their checks
roughly half the time when the environment allows it, and far more often when
the task is impossible. See `docs/research/evidence.md`.

## Decision

Adopt a two-phase, human-gated acceptance-test-driven workflow (ATDD),
introduced in a basic form first:

- **Phase 0, requirements** (`issue-draft`): acceptance criteria written as
  WHEN/THEN, each with an identifier `AC-n`, in the issue.
- **Phase 1, oracle** (`atdd-oracle`): derive cases and edge cases, compare
  them with existing tests, propose a justified test plan, challenge the
  human's edge cases explicitly, define public signatures with placeholder
  bodies where the language needs them (in Kotlin, `TODO()`) so tests fail by
  assertion rather than compilation, check that every test is satisfiable, get
  human approval, record the red evidence, commit, and tag the commit
  `oracle/<branch>`.
- **Phase 2, implementation** (`atdd-implement`): a clean context receives only
  what was approved. Tests are not modified to pass. If a test must change, the
  agent stops and asks; the change goes into its own commit after approval.

The basic form enforces phase 2 with a user-level PreToolUse hook that denies
Edit and Write on the stack's test paths while an `oracle/<branch>` tag exists,
and with `pr-prep` checking that the test diff against the tag is empty.

## Alternatives considered

- **Adopting OpenSpec or Spec Kit.** Rejected: their artefacts duplicate
  issues, milestones, ADRs and pull requests, and nothing enforces the specs.
- **Starting with the full protocol** (held-out tests in a private repository,
  CI oracle check, signed approval tags). Deferred, not rejected: it needs
  measurement first, and the basic form already exercises the workflow.

## Consequences

- The basic guard can be bypassed through Bash or by deleting the tag. It is a
  guard against accidents, not against a determined agent. The CI oracle check
  closes that gap later, inside each repository.
- Test names carry their `AC-n`, and the pull request maps criteria to tests.
- Trivial changes do not use the protocol; the global `CLAUDE.md` lists the
  levels.
