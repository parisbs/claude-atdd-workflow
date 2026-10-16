---
name: drift-audit
description: Audit a repository for drift between its documentation, its code, GitHub and the claude-workflow templates - dangling references, stale roadmap and ADR state, instruction files that restate derivable facts, and missing conventions. Reports; changes nothing unless asked. Use when asked to audit a repository, or before preparing a release.
effort: medium
---

Audit this repository for drift. Report findings grouped by area, each with the
evidence (file and line, command output). Change nothing unless asked.

Prefer checks a command can settle over judgement: run the command and quote
the result.

## 1. Instruction files

- `CLAUDE.md` holds the repository's instructions and nothing else does (ADR 0012).
  A stray `AGENTS.md` is reported, and so is a `CLAUDE.md` that only imports it with
  `@AGENTS.md`: either calls for the migration, which moves the content into
  `CLAUDE.md` and deletes `AGENTS.md`, and which `repo-bootstrap` proposes and the
  human approves.
- Every command they name exists: npm scripts in `package.json`, make targets,
  Gradle tasks (`./gradlew tasks --all` only if cheap), Flutter or Supabase
  commands. A `Verify:` line is present.
- Every file or directory path they mention exists.
- Content an agent can derive from the code (directory layouts, dependency and
  version lists, architecture overviews, generic command lists) is flagged for
  removal. Pitfalls, rationale, invariants and non-default conventions stay.
- Contradictions between `CLAUDE.md`, `.claude/rules/`, skills and
  the user-level `~/.claude/CLAUDE.md`.
- `CLAUDE.local.md` or auto-memory entries that duplicate user-level personal
  preferences.

## 2. Documentation

- ADR index matches the files; numbering has no gaps or duplicates; each record
  has a status; superseded records name their successor.
- Read each ADR's history on `main` chronologically, using first-parent
  snapshots (including merge commits), following earlier paths if renamed.
  The baseline is the first commit on `main` where its status became accepted,
  rejected or, with no earlier decision, superseded. Compare every later
  snapshot with that body, excluding only the status line; report body edits,
  even if later reverted. Proposed drafts may be edited through pull requests
  before that baseline without an immutability violation.
- A status is read from its leading word: proposed, accepted, rejected or
  superseded. What follows it, such as `amended by NNNN` or a named successor,
  is an annotation. A record with no status line or no recognised leading word
  is immutable from its merge. Compare subsequent bodies against that snapshot
  and ask the human to normalise the status; normalisation does not unfreeze
  its history.
- Flag proposed records on `main` for more than 30 days, measured from their
  first appearance on `main`; editing a draft does not reset its age.
- Flag references to proposed records from `CLAUDE.md`, code, or decided
  (accepted, rejected or superseded) records: a draft must not serve as a
  decided rule, so ask the human to accept or reject the record cited.
- `docs/ROADMAP.md` against GitHub: items marked done have merged pull requests
  or closed issues; open milestones and `next` issues appear in the roadmap
  (`gh issue list --state all`, `gh api repos/{owner}/{repo}/milestones`).
- `README.md` describes commands and behaviour that still exist.
- Diagrams are Mermaid with a prose description.

## 3. Conventions and enforcement

Compare with the templates in `~/.claude/skills/repo-bootstrap/templates/`:

- Pull request title check workflow present and equivalent.
- Dependabot, when configured, uses conventional commit prefixes, or its pull
  requests fail the title check.
- Issue and pull request templates carry acceptance criteria and the
  criterion-to-test map.
- `.claude/worktrees/`, where Claude Code makes its worktrees, is ignored by a
  versioned `.gitignore`. Run
  `git check-ignore --no-index -v .claude/worktrees/x` and report a missing
  root `.gitignore`, no match, a `!` pattern, or a match from a file that is
  not a versioned `.gitignore`. An equivalent pattern
  (`/.claude/worktrees/`, `worktrees/`) counts; the user-level excludes and
  `.git/info/exclude` do not count, since other clones lack them. Recommend
  `.claude/worktrees/` in the root `.gitignore`.
- No path under `.claude/worktrees/` is tracked: report every path
  `git ls-files .claude/worktrees` lists (mode 160000 is a worktree staged as
  an embedded repository), since an ignore rule leaves it tracked.
- Rulesets (`gh api repos/{owner}/{repo}/rulesets` and each ruleset by id):
  main requires pull requests with zero approvals, squash merges, required
  checks, linear history, no force push or deletion, and only the administrator
  role as bypass actor in `pull_request` mode; `v*` tags cannot be updated or
  deleted except by the administrator. Legacy branch protection or release-branch rulesets
  left over.
- Repository settings: squash merge only, branches deleted on merge
  (`gh api repos/{owner}/{repo} --jq '{allow_squash_merge,allow_merge_commit,allow_rebase_merge,delete_branch_on_merge}'`).
- Recent commit subjects on `main` follow Conventional Commits.
- Stale branches: merged branches still present locally or on the remote, and
  release branches that outlived their tag.

## 4. Report

End with a short prioritised list: what breaks correctness first, then what
misleads an agent, then cosmetic drift. Offer `/repo-bootstrap integrate` for
convention gaps.
