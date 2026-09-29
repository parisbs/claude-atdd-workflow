# 0004. Protect main with rulesets applied by repo-bootstrap

- Status: accepted, amended by [0008](0008-administrator-bypasses-rulesets-through-pull-requests.md)
- Date: 2026-09-29

## Context

Every repository has a single developer. A ruleset that requires one approving
review can never be satisfied by that developer, so every merge used the
administrator bypass, and a bypass skips every rule of the ruleset, required
checks included. The agent acts with the developer's GitHub token and therefore
has the same bypass. Protection was also inconsistent: some repositories had
rulesets, some classic branch protection with administrators exempt, some none.

## Decision

`repo-bootstrap` applies the same two rulesets to every repository it sets up
or integrates:

- **main**: pull request required with zero approvals, required status checks,
  linear history, no force push, no deletion, and **no bypass actors**.
- **release tags** (`v*`): no update and no deletion.

The human gate moves to the machine: `gh pr merge` asks for confirmation and
`--admin` is denied by a user-level hook.

## Alternatives considered

- **Keep one required review with an administrator bypass.** Rejected: every
  merge becomes a full bypass and CI protects nothing.
- **Two rulesets, one bypassable for reviews and one not for checks.** Rejected:
  a review requirement adds nothing for a single developer.

## Consequences

- CI is mandatory for everyone, including the developer and the agent. When CI
  breaks for an external reason, the ruleset must be edited on purpose.
- A future oracle check in CI becomes meaningful, because nobody can skip it.
