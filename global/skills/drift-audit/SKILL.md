---
name: drift-audit
description: Audit a repository for drift between its documentation, its code, GitHub and the claude-workflow templates - dangling references, stale roadmap and ADR state, instruction files that restate derivable facts, and missing conventions. Reports; changes nothing unless asked.
disable-model-invocation: true
---

Audit this repository for drift. Report findings grouped by area, each with the
evidence (file and line, command output). Change nothing unless asked.

Prefer checks a command can settle over judgement: run the command and quote
the result.

## 1. Instruction files

- `AGENTS.md` exists and `CLAUDE.md` imports it with `@AGENTS.md`.
- Every command they name exists: npm scripts in `package.json`, make targets,
  Gradle tasks (`./gradlew tasks --all` only if cheap), Flutter or Supabase
  commands. A `Verify:` line is present.
- Every file or directory path they mention exists.
- Content an agent can derive from the code (directory layouts, dependency and
  version lists, architecture overviews, generic command lists) is flagged for
  removal. Pitfalls, rationale, invariants and non-default conventions stay.
- Contradictions between `AGENTS.md`, `CLAUDE.md`, `.claude/rules/`, skills and
  the user-level `~/.claude/CLAUDE.md`.
- `CLAUDE.local.md` or auto-memory entries that duplicate user-level personal
  preferences.

## 2. Documentation

- ADR index matches the files; numbering has no gaps or duplicates; each record
  has a status; superseded records name their successor.
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
