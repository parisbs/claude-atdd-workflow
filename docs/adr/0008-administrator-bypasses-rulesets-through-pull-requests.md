# 0008. Let the administrator bypass rulesets, only through pull requests

- Status: accepted, amended by [0010](0010-move-human-control-to-the-specification-and-gate-merges.md)
- Date: 2026-09-29
- Amends: [0004](0004-protect-main-with-rulesets-from-bootstrap.md)

## Context

ADR 0004 removed every bypass actor from the main ruleset so that CI would be
mandatory for everyone. The developer works alone and needs a way out when a
required check fails for a reason outside the change (a broken runner, an
external outage), without editing the ruleset each time.

The agent acts with the developer's GitHub token, so any bypass the developer
has, the agent has too.

## Decision

- The main ruleset lists the repository administrator role as a bypass actor
  with `bypass_mode: "pull_request"`: the administrator can merge a pull
  request that does not meet the rules (`gh pr merge --admin`), but nobody can
  push to `main` directly.
- The release tag ruleset lists the administrator with `bypass_mode: "always"`,
  because tags are not changed through pull requests.
- The agent is kept out of the bypass on the machine: the user-level
  `guard-git` hook denies `gh pr merge --admin` and any push to `main`, and
  `gh pr merge` asks for confirmation.

## Alternatives considered

- **No bypass actors (ADR 0004 as written).** Rejected by the developer: an
  external CI failure would block all work until the ruleset is edited.
- **Bypass mode `always` on main.** Rejected: it would also allow direct pushes
  to `main`, which nothing needs.

## Consequences

- Required checks are mandatory for the agent only as long as the user-level
  hook is installed. On a machine without it, the agent could bypass through a
  pull request, so the hook is part of the protection, not only a convenience.
- A future CI oracle check can be bypassed by the administrator, deliberately
  and visibly, but not silently by the agent.
