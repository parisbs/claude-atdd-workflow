---
status: superseded by [0018](0018-adrs-are-immutable-once-accepted-or-rejected.md)
date: 2026-09-29
---
# 0009. ADRs are immutable once merged


## Context

An architecture decision record is the history of why something is the way it
is. Editing one after the fact erases the reasoning that was true when the
decision was made, and a reader can no longer tell what was decided from what
was learned later. Repositories disagreed: one treated accepted records as
immutable, another allowed edits to correct facts that had become untrue, and
the first integration edited accepted records to repoint references, which the
review of that integration flagged.

## Decision

Across every repository, an ADR is immutable once merged to `main`:

- A changed decision is a new record that supersedes the old one.
- The old record changes only in its status line, naming the record that
  supersedes it, or the part it supersedes.
- A stale reference inside a merged record stays as written; the record that
  makes it stale says so in its consequences.
- A record in an open pull request is a draft and can be edited until merged.

The rule is a default of the user `CLAUDE.md`, the `AGENTS.md` template and the
`adr-draft` skill, and `drift-audit` checks for merged records whose body
changed.

## Alternatives considered

- **Allow corrections of facts that became untrue.** Rejected: the boundary
  between correcting a fact and rewriting the reasoning is a judgement call, and
  every such edit makes the record less trustworthy as history.
- **Leave the policy to each repository.** Rejected: it is expected of any
  repository, and leaving it open produced the inconsistency above.

## Consequences

- Repositories whose contributing guide allows editing accepted records get
  their rule aligned when integrated.
- Supersession chains grow; the ADR index and status lines are what keep them
  navigable.
