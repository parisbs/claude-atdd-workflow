---
status: accepted
date: 2026-09-29
---
# 0005. Use Conventional Commits and release from tags


## Context

Repositories used four commit styles, and release branches were kept in some
repositories and deleted in others. With squash merging, the commit that lands
on `main` is the pull request title.

## Decision

- Commit subjects and pull request titles follow Conventional Commits in
  English, one line, imperative mood, for example
  `feat(capture): add viewport restore on interrupt`.
- Each repository validates the pull request title in CI.
- Branches follow gitflow names (`feature/`, `fix/`, `hotfix/`, `release/`,
  `chore/`, `docs/`, `refactor/`, `test/`) and merge to `main` with squash.
- A release is an annotated tag `vX.Y.Z` on `main`. A `release/X.Y.Z` branch,
  when used, only prepares the release (documentation, changelog, version) and
  is deleted after merging. A hotfix increments the patch version.

## Alternatives considered

- **A plain infinitive sentence without a type prefix.** Rejected: it gives
  release tooling and labelers nothing to read.
- **Long-lived release branches.** Rejected: the tag records the published
  state, and a stale copy of a released tree invites commits onto it.

## Consequences

- Rulesets protecting release branches become obsolete and are removed.
- Existing repositories adopt the rule through `repo-bootstrap` integrate mode.
