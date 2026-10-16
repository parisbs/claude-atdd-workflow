# 0018. ADRs are immutable once accepted or rejected

- Status: accepted
- Date: 2026-10-16
- Supersedes: [0009](0009-adrs-are-immutable-once-merged.md)

## Context

ADR 0009 freezes every record merged to `main`, whatever its status.
`adr-draft` creates proposed records and only the human may accept a decision,
but the workflow never defined when acceptance happens. Flipping the status
inside each pull request became a habit rather than a rule. Migrations that
split legacy projects into new repositories brought proposed records onto
`main`, freezing proposals nobody had accepted.

The rules also disagree: ADR 0009 permits a status-line change only to name a
successor, while `drift-audit` permits any status-line change. A merge should
publish a draft without silently making its proposal a decision.

## Decision

- An ADR is immutable from the first commit on `main` where its status becomes
  accepted or rejected. Only the human accepts or rejects a record; an agent
  drafts it as proposed. Acceptance or rejection takes effect when that status
  reaches `main` through a pull request, including in the record's first merge.
  Until then, any record in an open pull request can be edited.
- A proposed record on `main` remains an editable draft. Revisions go through
  pull requests, which reach the human because `docs/adr/` is on the control
  plane. An edit before acceptance or rejection is not an immutability
  violation.
- A rejected record keeps its number and body as the history of a discarded
  option, immutable like an accepted record: deciding against an option is
  also a decision. Numbers are never reused, including rejected numbers. A
  reconsidered rejection or changed accepted decision needs a new record.
- A superseded record changes only in its status line, naming its successor
  or the part superseded. Its body stays frozen against its first accepted or
  rejected snapshot on `main`; with neither recorded, against the snapshot
  where it became superseded, so edits made while it was proposed stay
  allowed. Changing a status back to proposed does not unfreeze a decided
  record.
- A status is read from its leading word; what follows, such as
  `amended by NNNN`, is an annotation. A missing status line, or a leading
  word other than proposed, accepted, rejected or superseded, makes the record
  immutable from its merge. When acceptance cannot be determined, preserve the
  existing protection and ask the human to normalise the status without
  unfreezing its history.
- `drift-audit` reports body edits after acceptance or rejection, using the
  first such commit on `main` as the baseline and checking every later
  snapshot except its status line. It also reports proposed records on `main`
  for more than 30 days, references to proposed records from `CLAUDE.md`, code
  or decided (accepted, rejected or superseded) records, for the human to
  accept or reject the record cited, and missing or unrecognised statuses.

## Alternatives considered

- **Keep merge as acceptance and add a CI check refusing proposed records.**
  Rejected: this is coherent going forward but leaves migrated proposals
  already on `main` frozen, and substitutes a merge for the human's acceptance.
- **Allow corrections to accepted records.** Rejected for the reason in
  ADR 0009: the boundary between correcting a fact and rewriting the reasoning
  is a judgement call that makes the history less trustworthy.
- **Check only a hand-picked set of statuses, without a fallback.** Rejected:
  legacy values such as Approved, Deprecated or Spanish statuses would have
  undefined protection. Immutability from merge is the conservative fallback.

## Consequences

- Records merged as proposed under ADR 0009 become editable again unless they
  later became accepted or rejected. This is intended for migrated
  repositories; this repository has no such records before this proposal.
- Rejecting an option preserves its history and consumes its number. Reversing
  that rejection grows the supersession chain rather than rewriting it.
- Stale references in frozen merged records stay as written. A new record
  notes them in its consequences; this includes ADR 0009's old rule and its
  reference to the former instruction-file template.
- Until an automated CI check exists, `drift-audit` is the only detector of an
  edited accepted or rejected record. That CI check needs full history and is
  deferred to a separate issue; this change adds no hook blocking ADR edits.
- The instruction files, ADR index and template, and `adr-draft`, `drift-audit`
  and `repo-bootstrap` skills carry the same lifecycle rule. Other
  repositories' statuses are normalised separately, by their humans.
