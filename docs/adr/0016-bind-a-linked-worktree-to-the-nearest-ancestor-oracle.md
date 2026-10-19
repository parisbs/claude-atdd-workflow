---
status: accepted
date: 2026-10-07
---
# 0016. Bind a linked worktree to the nearest ancestor oracle tag

- Amends: [0003](0003-approved-tests-replace-behaviour-specs.md)

## Context

ADR 0003 enforces phase 2 with a hook that denies edits to the test paths while
an `oracle/<branch>` tag exists, and `oracle-check` compares the tree with that
tag. Both find the tag through `oracleTag` in `global/hooks/oracle.mjs`, which
looked only for `oracle/<current branch>`.

A Claude subagent with `isolation: worktree` works in a linked worktree on a
branch of its own (`worktree-agent-<id>`). On 2026-10-06, while implementing
issue 42, two `claude-implementer` delegations ran on such branches with
`oracle/feature/codex-delegation-guard` present, and the guard would have let
them edit the frozen tests (issue 45). Phase 2 is where a subagent is most
likely to be the implementer, and ADR 0002 asks for a hook where something must
always hold.

The worktree only carries the oracle when its `HEAD` descends from the oracle
commit. Claude Code branches a subagent's worktree from the default remote
branch unless `worktree.baseRef` is `"head"` (Claude Code documentation, "Run
parallel sessions with worktrees"); issue 46 covers building on the work
branch's commit.

## Decision

`oracleTag` decides which oracle binds a checkout, in this order:

1. The tag `oracle/<current branch>`, when it exists, as before.
2. Otherwise, only in a linked worktree (its git directory differs from the
   common git directory), the `oracle/*` tag whose commit is an ancestor of
   `HEAD` and nearest to it, counted in commits. Ties at equal distance go to
   the first tag name in sort order. Annotated tags, ancestry through a merge
   and a detached `HEAD` count.
3. Otherwise, no oracle.

The test paths are still read from the oracle commit's `.atdd/test-paths`.
`guard-tests` and `oracle-check` share the rule through `oracle.mjs`, and the
acceptance tests of issue 45 in `tests/hooks.test.mjs` pin it.

## Alternatives considered

- **A marker the orchestrator writes when it delegates**, naming the oracle the
  worktree is bound to. Rejected: it is one more step the orchestrator can
  forget, which is the kind of rule ADR 0002 moves out of prose, and a delegate
  could edit or delete a marker inside its own worktree. Git ancestry needs no
  step and is not in the delegate's working tree.
- **The ancestor rule in every checkout, the main one included.** Rejected: a
  branch stacked on another branch with an oracle would inherit that oracle and
  have its own new tests denied, a change to today's behaviour that no
  observation asks for.
- **Every ancestor oracle at once**, denying when any of them freezes a path.
  Rejected: `oracle-check` would have to compare against several tags, and the
  nearest oracle is the one the work was planned against.

## Consequences

- A delegate's worktree is bound only when its `HEAD` descends from the oracle
  commit. With Claude Code's default base it does not until the delegate builds
  on the work branch's commit; issue 46 makes the package carry that commit.
- A stale oracle tag whose commit is reachable from `main`, which a squash merge
  does not produce, would bind every linked worktree made from `main`, the
  desktop app's worktree sessions included. The denial names the tag, and
  removing merged oracle tags is already the rule.
- ADR 0011 rejected `isolation: worktree` in the agent files for two reasons, a
  wrong base branch and a blind oracle guard. This record answers the second;
  ADR 0011's text stays as written.
- Each hook call in a linked worktree with no own tag adds one `git
  for-each-ref` and one `git rev-list --count` per ancestor oracle tag.
