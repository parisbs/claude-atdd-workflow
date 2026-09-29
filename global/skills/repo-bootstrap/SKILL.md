---
name: repo-bootstrap
description: Set up a new repository, or integrate an existing one, into the agent-assisted workflow - AGENTS.md and CLAUDE.md, stack rules, issue and PR templates, the PR title check, labels, merge settings and GitHub rulesets. Every repository ends up self-sufficient.
argument-hint: new <name> [private|public] | integrate
disable-model-invocation: true
---

Mode and arguments: $ARGUMENTS

Templates live next to this file in `templates/`: `common/` for every
repository, and one directory per stack (`android/`, `flutter/`, `node-mcp/`,
`supabase/`) with a `stack.md`. The reasoning is in the claude-workflow ADRs
0001, 0004, 0005 and 0006: whatever a repository needs to be worked on
correctly is copied into it, so it never depends on this machine.

Work on a branch named `chore/ai-workflow-integration` (integrate) or on the
initial `main` (new). Show every change before making it, and ask before each
action on GitHub.

## 1. Detect

- Stacks, by their markers (see each `stack.md`). A repository can have more
  than one.
- For integrate: current `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`,
  `.claude/` contents, `.github/` templates and workflows, ADR directory and
  format, the CI check names from a recent run
  (`gh pr checks <n>` on a recent pull request, or
  `gh api repos/{owner}/{repo}/commits/<sha>/check-runs --jq '.check_runs[].name'`),
  existing rulesets and classic branch protection, merge settings, labels.
- Report what was found before changing anything.

## 2. Instruction files

- **new**: fill `common/AGENTS.md.template` with what the human tells you and
  the stack rules from each `stack.md`.
- **integrate**: move the existing instructions into `AGENTS.md` in English and
  keep only what cannot be derived from the code: invariants with their
  reasons, pitfalls, non-default conventions and commands that are not obvious.
  Drop directory layouts, dependency and version lists, architecture overviews
  and generic command lists. Keep every repository-specific rule; when unsure
  whether something is derivable, keep it and flag it.
- Add the conventions section from the template, adapted where the repository
  has a recorded exception, and a `Verify:` line with the one command that
  mirrors CI. When there is no such command, propose one (npm script, make
  target, Gradle task) and add it.
- Paste the stack rules, adapted to what the repository actually uses. Critical
  rules always stay in the repository, even when another repository repeats
  them.
- `CLAUDE.md` becomes `@AGENTS.md` plus a Claude Code section listing the
  project's skills, hooks and rules. Project skills, commands, agents, hooks and
  rules stay where they are; flag any whose name a user-level skill shadows.
- `CLAUDE.local.md` and auto-memory entries that only repeat user-level personal
  preferences are proposed for removal; move removed files to the Trash, never
  delete them outright.

## 3. Repository files

- `.github/ISSUE_TEMPLATE/`: add `feature.yml`, `bug.yml` and `config.yml` from
  the templates. When the repository has its own, merge in the acceptance
  criteria field instead of replacing them.
- `.github/PULL_REQUEST_TEMPLATE.md`: the template, or the existing one with the
  acceptance criteria and verification sections merged in. Remove duplicate
  templates that differ only in file name case.
- `.github/workflows/pr-title.yml` from the template.
- Documentation diagrams: convert ASCII diagrams to Mermaid with a prose
  description when touched; do not rewrite untouched documents.

Commit in coherent groups (`docs: move agent instructions to AGENTS.md`,
`ci: check pull request titles`, `chore: add issue and pull request templates`)
and prepare the pull request with `/pr-prep`.

## 4. GitHub settings (ask before each)

1. Merge settings: squash only, delete branches on merge:
   `gh repo edit --enable-squash-merge --enable-merge-commit=false --enable-rebase-merge=false --delete-branch-on-merge`.
2. Labels from `common/github/labels.json` (`gh label create --force`).
3. Rulesets, after the pull request title check has run at least once so its
   name exists:
   - Fill `common/github/rulesets/main.json` with the real check names, show it,
     and create it with
     `gh api repos/{owner}/{repo}/rulesets --method POST --input <file>`.
   - Create `common/github/rulesets/tags.json` the same way.
   - Remove what they replace: a ruleset for release branches, an older main
     ruleset, and classic branch protection
     (`gh api repos/{owner}/{repo}/branches/main/protection --method DELETE`),
     each only after the new ruleset exists and each with its own
     confirmation.
   - If the API rejects a parameter, report the error and the payload; do not
     drop rules silently to make it pass.

## 5. New repository

For **new**, before step 2: create the repository with
`gh repo create <owner>/<name> --private|--public`, clone or initialise it with
`main` as default, add a `README.md`, the `.gitignore` for the stack, and the
instruction files, make the initial commit on `main`, and publish it (the git
guard asks before the first push of `main`). Then continue from step 3 on a
branch, and apply the rulesets once CI has run.

## 6. Report

List what changed in the repository, what changed on GitHub, what was left for
the human, and any rule that was kept only because it looked repository
specific.
