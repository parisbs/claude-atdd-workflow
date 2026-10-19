---
status: proposed
date: 2026-10-19
---
# 0021. Require recognised statuses on added ADRs and ignore commented index links

- Supersedes in part: [0020](0020-standardise-adr-metadata-on-madr-4-front-matter.md) (the added-record status rule and the index reading)

## Context

The ADR check accepts any non-empty front matter status on an added record.
A MADR template placeholder therefore passes, but becomes an unrecognised
status on `main`: the record is frozen and can only be normalised to accepted,
rejected or superseded. It can never become an editable proposed draft again.

The index check also counts links inside HTML comments. A record can pass
while its only index entry is hidden from readers, and a commented link to a
nonexistent record can fail the check.

## Decision

- An added record needs a recognised leading status word in its front matter:
  proposed, accepted, rejected, superseded or deprecated, without regard to
  case. Quoted values are unquoted and annotations after the word are allowed;
  a word glued to more text, such as `proposed-x`, is unrecognised, while a
  no-break space ends the word. All five statuses allow historical records
  imported from another repository to keep their status. The check rejects a
  missing or unrecognised status and names the file and the status as written.
- Base records keep their existing handling: an unrecognised status freezes
  the record and may only be normalised to accepted, rejected or superseded.
- Remove HTML comments before reading index links, from `<!--` through the
  next `-->`, across lines; an unclosed comment runs to the end of the document.
  Links inside HTML comments do not index a record or require a target to
  exist. Text after a closed comment on the same line is still read, and
  diagnostic line numbers stay unchanged. Links inside code spans or fences
  still count, as in issue 66; reference-style links stay outside the check.
- `scripts/check-adrs.mjs` enforces both rules in CI. The CI check and the
  ruleset requiring it provide the guarantee (ADR 0002 and 0008).

## Alternatives considered

- **Keep any non-empty status.** Rejected: a template placeholder can merge
  and freeze a record that was meant to remain an editable draft.
- **Allow only proposed and accepted on added records.** Rejected: importing
  historical rejected, superseded or deprecated records would require changing
  their status and misrepresenting their history.
- **Treat HTML comments as part of the index.** Rejected: hidden links do not
  make a record discoverable in the rendered index, and hidden stale targets
  should not fail the check.

## Consequences

- Copies of the check in two private repositories and codex-subagent-mcp are
  stale until re-copied, with one pull request per repository; `drift-audit`
  reports these differing copies.
- An open pull request elsewhere that adds a placeholder record fails once
  that repository's copy of the check is updated; it must choose a recognised
  status before merging.
- Once ADR 0021 is accepted, annotate ADR 0020 as superseded in part in its
  front matter status, naming the added-record status rule and the index
  reading. Its body remains unchanged.
