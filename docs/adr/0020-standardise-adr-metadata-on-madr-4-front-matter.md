---
status: proposed
date: 2026-10-16
---
# 0020. Standardise ADR metadata on MADR 4 front matter

- Supersedes in part: [0018](0018-adrs-are-immutable-once-accepted-or-rejected.md) (where the status is read and which statuses are recognised) and [0019](0019-check-adrs-in-ci-against-the-base.md) (reading the `- Status:` line, the status transitions, added records and the index check)

## Context

ADR 0019's check reads only a legacy `- Status:` line. Other repositories
write `Status: Accepted` without the dash, or MADR 4 YAML front matter, so
the check cannot be rolled out to them as it is. Its index check also rejects
every link that is not a record, which fails indexes that link the template,
the roadmap or external pages.

A check that guesses each repository's format reads a record differently from
one repository to the next, and a guess that reads a record as proposed
unfreezes it. The metadata the check reads must therefore be one format, read
the same way everywhere. Changing the format of a frozen record is itself a
body edit under ADR 0018, so moving to it needs an exception that a machine
can prove.

## Decision

- ADR metadata follows MADR 4 front matter: line 1 is exactly `---`, the
  front matter closes at the next `---` line, and its lines are flat
  `key: value` pairs. The `status` field is required and `date` is optional.
  This standard covers the metadata only: sections and the index format stay
  free.
- The reading is strict. Only the front matter `status` field counts, quoted
  or not, by its leading word without regard to case. A record without front
  matter on line 1, with unclosed front matter, without a `status` key or with
  more than one counts as missing a status, also when it has a legacy
  `- Status:` or `Status:` line. Added records must have a front matter
  status.
- A one-time mechanical migration passes whatever the base status: front
  matter added, the legacy status line and `- Date:` line removed, every other
  line identical, and the front matter holding only `status` and `date` equal
  to the legacy values. The check proves the migration by that identity, so
  no judgement is involved. Any other change to a legacy record goes through
  the frozen rules, where its status is missing. `scripts/migrate-adrs.mjs`
  writes exactly that change and names each record it cannot migrate.
- Decided statuses are accepted, rejected, superseded and deprecated.
  `deprecated` is reachable only from accepted and may only become superseded.
  A proposed record may become anything except deprecated. A missing or
  unrecognised status may be normalised to accepted, rejected or superseded.
- The `date` of a decided, missing or unrecognised record changes only in the
  same change as an allowed transition of its status word, a normalisation
  included; an annotation alone does not allow it. The date of a proposed
  record is free.
- The index check reads only inline links whose file name is a record's,
  with or without a title or angle brackets. Links to other documents,
  external pages (with a scheme or protocol-relative), anchors and repeated
  links are ignored; a record-named link must resolve, and every record must
  be linked. A link that starts with `/` resolves from the repository root,
  as GitHub resolves it. The index is read from plain inline links:
  reference-style links, nested brackets, an image inside the link text and
  parentheses in the destination are not read, so an index uses the plain
  form `[title](NNNN-slug.md)`.
- Records are compared byte for byte, so an edit to bytes that are not valid
  UTF-8 is still a change. An empty `status` value counts as missing.
- `repo-bootstrap` distributes the check, the migration script, a workflow
  running the check with every action pinned by full commit SHA, and
  `Check ADRs` in the ruleset template. It installs the check only on a
  repository whose records are in the standard format; otherwise it proposes
  the migration first. `drift-audit` reports records not in the standard
  format, a copy of the check that differs from the template, and a
  repository in the standard format without the check.

## Alternatives considered

- **Cover every repository's format in the check.** Rejected: each format the
  check reads widens what it must parse correctly, and a misread proposed
  status unfreezes a decided record; one format, read strictly, keeps the
  check small and its reading the same everywhere.
- **Per-repository configuration of the status format.** Rejected: the
  configuration becomes another file to keep right, and a wrong pattern
  silently weakens the protection; migrating once costs less than
  configuring forever.
- **A judgement-based exception for legacy records.** Rejected: ADR 0009
  rejected judgement-based exceptions because the boundary between a format
  change and a rewrite is a judgement call; the mechanical exception is
  checked line by line.
- **Keep legacy lines as a fallback reading.** Rejected: two readings of one
  record can disagree, and the legacy lines would never leave; the migration
  removes them once.

## Consequences

- Legacy proposed records in other repositories are frozen under the strict
  reading until migrated: they must be migrated before they can be edited.
- Each repository holds a copy of the check, and copies drift; `drift-audit`
  reports a copy that differs from the `repo-bootstrap` template.
- Rollout to codex-subagent-mcp and two private repositories is one pull
  request each, later: the migration first, then the check, the workflow and
  the required check.
- Stale references in frozen records stay as written: ADR 0019 describes the
  `- Status:` line, and ADR 0018 lists the statuses without deprecated.
