---
status: accepted; the legacy status reading, the status transitions, added records and the index check superseded in part by [0020](0020-standardise-adr-metadata-on-madr-4-front-matter.md)
date: 2026-10-16
---
# 0019. Check ADRs in CI against the base


## Context

ADR 0018 freezes records once accepted or rejected on `main`, while proposed
records remain editable drafts. Only prose and the manually run `drift-audit`
enforce this rule and the completeness of the ADR index. ADR 0002 requires
what must always hold to be a hook, a permission rule or CI.

The status on a pull request's base already says whether a record is frozen.
Comparing that snapshot with the committed head is sufficient for changes
that reach `main` through pull requests, as required by ADR 0004.

## Decision

- Run `scripts/check-adrs.mjs <base-ref>` in CI on pull requests only. Compare
  the committed HEAD tree directly with the base tree, not their merge base.
  GitHub's pull request checkout is a merge commit containing the base. Local
  runs against a branch behind `main` should pass the merge base explicitly.
- Check records named `NNNN-*.md` in `docs/adr/`, `docs/adrs/` or
  `docs/decisions/` when present. The index and template are not records.
  Every base record keeps its path, including proposed records. Added records
  continue the base numbering without gaps or duplicates. Each directory's
  `README.md` index lists every record exactly once and no other file.
- Read the leading word of the `- Status:` line without regard to case;
  `Accepted` and `accepted, amended by NNNN` both mean accepted. A proposed
  record on the base is editable, including when the same change accepts or
  rejects it. Newly added records are drafts within the pull request,
  whatever their status, and their content is unrestricted by this check.
- A base record marked accepted, rejected or superseded is frozen except
  its status line. That line may keep its leading word, with or without an
  annotation, or become superseded. It cannot switch between accepted and
  rejected, become proposed, or gain an unrecognised status.
- A missing or unrecognised base status also freezes the record. Its status
  line may be normalised to accepted, rejected or superseded; adding a missing
  status line counts. Normalising to proposed is forbidden because it would
  unfreeze the record in the next pull request.
- Fail closed when either tree, a record or the index cannot be read. Report
  each problem on stderr with its repository-relative path, and its line
  when known. No violation exits successfully.

## Alternatives considered

- **Walk the history on main.** Rejected: this needs full history in CI and
  must handle squash merges and renames, while the base status already says
  whether a record is frozen. Edits that bypass pull requests remain
  `drift-audit`'s responsibility.
- **Leave enforcement to drift-audit alone.** Rejected: a manual audit cannot
  enforce what must always hold; ADR 0002 requires an automated boundary.
- **Use a local hook.** Rejected: hooks are a safety net for one machine,
  not a boundary. CI and rulesets provide the guarantee (ADR 0002 and 0008).
- **Read statuses case-sensitively.** Rejected: migrated MADR records commonly
  use `Accepted`; treating that as unrecognised needlessly requires
  normalisation.
- **Allow normalisation to proposed.** Rejected: it would unfreeze the record
  in the next pull request, contrary to ADR 0018.

## Consequences

- This implements ADR 0018 rather than superseding it. Its consequence saying
  the CI check needs full history is stale and stays as written in that
  immutable record. `drift-audit` keeps its history check to catch edits that
  never went through a pull request.
- The checkout must make the base branch available, through an explicit fetch
  or `fetch-depth: 0`. The workflow uses the latter for simplicity; the script
  itself only needs the two trees and fails if the base is unavailable.
  Event values reach the shell through environment variables.
- The workflow is on the control plane, so the human merges the pull request
  that changes it. Pushes to `main` do not run the check: rulesets route every
  change through a pull request.
- Two open pull requests adding the same next number can both pass against
  their current base. After the first merges, the second result is stale
  until a rerun catches the reused number; `drift-audit` also catches it on
  `main`. Requiring branches to be up to date would close this gap and is a
  separate ruleset decision.
- The base is fetched when the job runs, while the merge commit under test was
  made when the pull request last changed. When the base gains records in
  between, they look deleted and the check fails until the branch is updated.
  That is kept on purpose: it is what makes a rerun catch a reused number. The
  message says to update the branch.
- CI is the guarantee only when `Check ADRs` is a required status check of the
  ruleset that protects `main`; until it is added there, a failure is visible
  but does not block the merge.
