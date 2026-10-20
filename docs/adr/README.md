# Architecture decision records

Short MADR form. Create new records from `template.md`. The metadata is MADR 4
YAML front matter: the status is the `status` field of the front matter, read
strictly, and `date` is optional; sections and this index are free (ADR 0020).
Records are immutable from the commit on `main` where their status becomes
accepted or rejected. Proposed records on `main` remain editable drafts,
revised through pull requests. Only the human accepts or rejects a record. A
changed decision needs a new record; superseded records change only in their
front matter status.

Numbers are never reused, including those of rejected records. A rejected
record keeps its number and body as the history of a discarded option;
reconsidering it needs a new record. The status is its leading word, so
`accepted, amended by NNNN` is accepted. A missing status or a leading word
other than proposed, accepted, rejected, deprecated or superseded makes a
record immutable from its merge; `drift-audit` asks to normalise it (ADR
0018). Only an accepted record becomes deprecated, and a deprecated one only
superseded. The date of a decided record changes only with its status.

An added record needs a recognised leading status word in its front matter:
proposed, accepted, rejected, superseded or deprecated, without regard to case.
Annotations after the word are allowed; imported historical records may keep
any of these five statuses (ADR 0021).

The index check reads inline links. Links inside HTML comments do not index a
record; an unclosed comment hides everything after its opening. Links inside
code spans or fences still count; reference-style links are not read (ADR 0021).

A record without front matter, such as one with a legacy `- Status:` line,
counts as missing a status. Its one-time migration is mechanical: front matter
added, the legacy status and date lines removed, every other line identical.
`scripts/migrate-adrs.mjs` writes it and `scripts/check-adrs.mjs` verifies it.

- [0001. Separate generic, personal and repository configuration](0001-separate-generic-personal-and-repository-configuration.md)
- [0002. Enforce with hooks, permissions and CI, and guide with prose](0002-enforce-with-hooks-permissions-and-ci.md)
- [0003. Approved executable tests replace prose behaviour specifications](0003-approved-tests-replace-behaviour-specs.md)
- [0004. Protect main with rulesets applied by repo-bootstrap](0004-protect-main-with-rulesets-from-bootstrap.md)
- [0005. Use Conventional Commits and release from tags](0005-conventional-commits-and-releases-from-tags.md)
- [0006. Make AGENTS.md the canonical instructions file of a repository](0006-agents-md-is-the-canonical-repository-file.md)
- [0007. User skill names never shadow project skills](0007-user-skill-names-never-shadow-project-skills.md)
- [0008. Let the administrator bypass rulesets, only through pull requests](0008-administrator-bypasses-rulesets-through-pull-requests.md)
- [0009. ADRs are immutable once merged](0009-adrs-are-immutable-once-merged.md)
- [0010. Move human control to the specification and gate merges by verified conditions](0010-move-human-control-to-the-specification-and-gate-merges.md)
- [0011. Delegate through Claude Code subagents, interchangeable with Codex](0011-delegate-through-subagents-interchangeable-with-codex.md)
- [0012. Keep repository instructions in CLAUDE.md alone](0012-keep-repository-instructions-in-claude-md-alone.md)
- [0013. Let guard-git keep subagents off GitHub](0013-guard-git-keeps-subagents-off-github.md)
- [0014. Run Codex through two registrations named by role and install them from this repository](0014-run-codex-through-two-role-named-registrations.md)
- [0015. Give delegates goals, structured findings and the rules they lack](0015-pass-delegates-goals-structured-findings-and-the-rules-they-lack.md)
- [0016. Bind a linked worktree to the nearest ancestor oracle tag](0016-bind-a-linked-worktree-to-the-nearest-ancestor-oracle.md)
- [0017. Bound tool output, block on Codex instead of polling, and derive the Codex registrations from one file](0017-bound-output-and-block-on-codex-instead-of-polling.md)
- [0018. ADRs are immutable once accepted or rejected](0018-adrs-are-immutable-once-accepted-or-rejected.md)
- [0019. Check ADRs in CI against the base](0019-check-adrs-in-ci-against-the-base.md)
- [0020. Standardise ADR metadata on MADR 4 front matter](0020-standardise-adr-metadata-on-madr-4-front-matter.md)
- [0021. Require recognised statuses on added ADRs and ignore commented index links](0021-require-recognised-statuses-on-added-adrs-and-ignore-commented-index-links.md)
- [0022. Publish the project as claude-atdd-workflow from a rewritten history](0022-publish-as-claude-atdd-workflow-from-a-rewritten-history.md)
- [0023. Collect donated session metrics through an allowlist script and fork pull requests](0023-collect-donated-session-metrics-through-an-allowlist-script-and-fork-pull-requests.md)
- [0024. Merge without asking only the user's own pull requests from the base repository](0024-merge-without-asking-only-the-users-own-pull-requests-from-the-base-repository.md)
