---
status: accepted
date: 2026-09-29
---
# 0007. User skill names never shadow project skills


## Context

When a personal skill and a project skill share a name, the personal one runs,
and a skill wins over a command file with the same name (VERIFIED, official
skills documentation). Existing projects already define `ship`, `verify`,
`new-adr`, `fixtures` and others.

## Decision

User-level skills use names no project uses: `issue-draft`, `atdd-oracle`,
`atdd-implement`, `adr-draft`, `pr-prep`, `drift-audit`, `release-prep` and
`repo-bootstrap`. Each one looks for what the repository declares first (its
own pre-PR skill, verify command, ADR template) and uses it instead of a generic
default.

## Alternatives considered

- **Generic names that projects override.** Rejected: the precedence runs the
  other way, so the generic skill would silently replace the project's.

## Consequences

- Before adding a user skill, check the names used by the managed repositories
  and by bundled skills.
