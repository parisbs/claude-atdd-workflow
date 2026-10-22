---
status: accepted, consequence on the manifest and backup directory superseded by 0027
date: 2026-10-19
---
# 0022. Publish the project as claude-atdd-workflow from a rewritten history

## Context

The project lived in the private repository `parisbs/claude-workflow`. On
2026-10-19 its CI was about three quarters of the account's private Actions
minutes for October, mostly macOS jobs, which bill at ten times the Linux rate;
the month's quota was expected to run out. Standard GitHub-hosted runners are
free for public repositories, macOS included.

Making that repository public was examined first:

- Its history was clean: no personal paths, no email other than the GitHub
  noreply address, no token-shaped strings, and `personal/` only ever held the
  example files.
- Two accepted records named private repositories: ADR 0020 (the rollout line)
  and ADR 0021 (the stale copies line). The orchestrator context probes named
  an internal Claude Code feature flag, read from the binary, and stated that it
  was off for this account.
- Its issues and pull requests describe private repositories in more detail,
  and GitHub keeps the edit history of their bodies.
- GitHub keeps every commit a pull request referenced under `refs/pull/*`, so a
  rewritten history would still expose the old commits of its 41 pull requests.
- An issue cannot be transferred from a private repository to a public one.

## Decision

- The project continues as the public repository
  `parisbs/claude-atdd-workflow`, licensed under MIT. `parisbs/claude-workflow`
  stays private and is archived once the new repository is in use; its issues
  and pull requests remain there.
- `main` of the new repository is the full history of `claude-workflow` up to
  its commit `ca21adf` (39 commits), rewritten once with these substitutions in
  every commit, and nothing else:
  - ADR 0020 and ADR 0021 say "two private repositories" instead of naming
    them. Both records were accepted, so this is a redaction of frozen records,
    made once for publication; their decisions are unchanged.
  - The orchestrator context probes say "a remote feature flag that was off in
    these probes" instead of the flag's internal name and the account's state.
  - The worktree probes name the rewritten ids of the two `main` commits they
    cite. The two scratch commits they cite were never on `main` and keep their
    old ids.
  - Commit messages write a pull request or issue number `#N` as
    `claude-workflow#N`, which GitHub does not link, so that no message links
    to an unrelated issue of the new repository.
- Authors, committers, dates and the files each commit changes are those of the
  original. `docs/migration/claude-workflow-commits.csv` maps every original
  commit id to its rewritten one.
- Issue and pull request numbers up to 74 in code, tests and documentation,
  written `#N` or `issue N`, refer to `claude-workflow` and are left as written.

## Alternatives considered

- **Make `claude-workflow` public.** Rejected: its pull request refs keep the
  unredacted commits reachable, which only GitHub Support can purge, and its
  issues and pull requests would be published with their edit history.
- **Start the new repository from a single commit.** Rejected: it loses the
  record of when each decision was accepted, which the immutability rule
  (ADR 0018) depends on, and the history of the workflow this repository
  demonstrates. The history scan found nothing that a single commit would hide
  and a rewrite could not.
- **Rewrite every `#N` reference in files as well.** Rejected: GitHub does not
  link them in files, they appear in more than 200 places, including test names
  and accepted records, and a note serves the reader as well.
- **Keep the CI cost in the private repository by trimming macOS jobs.**
  Rejected as the lasting answer: at October's rate even one macOS job per pull
  request was projected to exceed the quota, and the hooks run on macOS, so its
  coverage matters.
- **AGPL-3.0-or-later.** Rejected: the repository is meant to be copied into
  other repositories (templates, the ADR check, workflows), and AGPL would bind
  each of them; its network clause adds nothing to software that is not served.
- **MPL-2.0.** Rejected in favour of MIT: file-level copyleft adds a notice and
  sharing duty to every copied template for little benefit in a one-person
  project.

## Consequences

- The rewritten commits carry no signature: GitHub signed the 38 squash merges
  and the author signed the first commit, and a rewrite drops signatures. They
  show no Verified badge. Squash merges in the new repository are signed again.
- Every commit id changed, because each id covers the parent's id and the
  signature. An old id from a note or another repository is found through
  `docs/migration/claude-workflow-commits.csv`.
- ADR 0020 and ADR 0021 differ from the records accepted in `claude-workflow`
  only in the redacted lines. ADR 0018 still holds in this repository from its
  first commit: this was the only exception, and it happened before the
  repository existed.
- ADR 0004 described a private repository; the rulesets carry over unchanged,
  with the same required checks. Phase 0 of the roadmap still says the
  repository was created private, which describes `claude-workflow`.
- The installer keeps its manifest `~/.claude/.claude-workflow-manifest.json`
  and its backup directory `~/.claude/backups/claude-workflow/`, so an existing
  installation stays tracked.
- The user's `Configuration source` preference, the local folder, the session
  memory and any other repository that names `claude-workflow` must move to the
  new name; each is a change outside this repository.
- In a public repository anyone can open issues and pull requests. They are a
  channel for instructions aimed at agents, and the merge decision does not yet
  look at a pull request's author or head repository.
