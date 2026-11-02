---
status: accepted
date: 2026-11-02
---
# 0036. Keep the proposed ADR denial when a pull request is labelled experiment

- Issue: #80
- Amends: [0035](0035-keep-a-proposed-adr-from-merging-with-the-change-that-applies-it.md) (its decision that the label lifts the bypassPermissions deny, in "Where the control lives", "Declaring an exception" and known gap 1)

## Context

ADR 0035 names its first known gap: the agent can add the `experiment` label
itself, because GitHub cannot tell the agent from the human who shares its
token (ADR 0032). Letting that label lift the `bypassPermissions` denial
lets the agent remove a safeguard on its own. Principle 8 of ADR 0032 says
the safeguards limit what the agent does on its own, not what the human
decides.

## Decision

The `experiment` label, matched without regard to case, changes only the
wording of the proposed-record reason. The decision in every mode is the
one the pull request gets without the label: a proposed ADR record together
with paths outside the ADR directories asks in the main session and is
denied in `bypassPermissions`; subagents stay denied.

The reason still names every proposed record and every outside path. With
the label, it states that the pull request is a declared experiment and
that the human must merge it from the main session. A real experiment is
merged by the human from that session.

## Alternatives considered

- Keep ADR 0035 as written. Rejected: the agent can set the label itself and
  lift the denial without the human.
- Remove the label altogether. Rejected: it still tells the human that the
  pull request is a declared experiment, and the reason says so.

## Consequences

- The agent can no longer merge an experiment with a proposed record and
  outside paths in `bypassPermissions`.
- The orchestrator's Delegation merge condition no longer has the label
  exception. `pr-prep` explains that declaring an experiment leaves its merge
  to the human in the main session.
- ADR 0035 is immutable except for its front matter status. Its references
  to the old label exception in "Where the control lives", "Declaring an
  exception" and known gap 1 stay as written; this record amends them.
- This record is itself applied by the pull request that adds it: it is done
  only when the human accepts it there.
