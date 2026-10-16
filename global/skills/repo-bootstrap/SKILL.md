---
name: repo-bootstrap
description: Set up a new repository, or integrate an existing one, into the agent-assisted workflow - a single CLAUDE.md, stack rules, issue and PR templates, the PR title check, labels, merge settings and GitHub rulesets. Every repository ends up self-sufficient.
argument-hint: new <name> [private|public] | integrate
disable-model-invocation: true
---

Mode and arguments: $ARGUMENTS

Templates live next to this file in `templates/`: `common/` for every
repository, and one directory per stack (`android/`, `flutter/`, `node-mcp/`,
`supabase/`) with a `stack.md`. The reasoning is in the claude-workflow ADRs
0001, 0004, 0005 and 0012: whatever a repository needs to be worked on
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

A repository keeps its instructions in a single `CLAUDE.md` (ADR 0012).

- **new**: fill `common/CLAUDE.md.template` with what the human tells you, the
  stack rules from each `stack.md` and the `Human merge:` line of each
  `stack.md`.
- **integrate**: move the existing instructions into `CLAUDE.md` in English and
  keep only what cannot be derived from the code: invariants with their
  reasons, pitfalls, non-default conventions and commands that are not obvious.
  Drop directory layouts, dependency and version lists, architecture overviews
  and generic command lists. Keep every repository-specific rule; when unsure
  whether something is derivable, keep it and flag it.
- If the repository has an `AGENTS.md`, or a `CLAUDE.md` that only imports it,
  propose moving its content into `CLAUDE.md` and deleting `AGENTS.md`, and do
  neither without the human's approval: a delegated agent would load the file
  into every run.
- Add the conventions section from the template, adapted where the repository
  has a recorded exception, and a `Verify:` line with the one command that
  mirrors CI. When there is no such command, propose one (npm script, make
  target, Gradle task) and add it.
- Workflow lines: propose values for `Review:`, `Implement:` and `Human merge:`
  and ask the human; never pick any of them silently. For `Human merge:` start
  from the line in each stack's `stack.md`.
- Paste the stack rules, adapted to what the repository actually uses. Critical
  rules always stay in the repository, even when another repository repeats
  them.
- Repoint every living reference to the old file (skills, agents, rules,
  README, contributing guide, design notes, code comments) at `CLAUDE.md`.
  ADRs are immutable from the commit on `main` where their status becomes
  accepted or rejected; proposed records on `main` remain editable drafts,
  revised through pull requests. Record the move in a new ADR instead of
  editing frozen bodies; superseded records change only in their status line.
  State the policy in the ADR index when the repository does not. When a
  comment changes under a path coupled to generated output, prove the output
  did not change.
- Keep every repository rule at least as strong as it was. Where a repository
  rule is stricter than the template (for example, all diagram content also in
  text), keep the repository's.
- `CLAUDE.md` keeps a Claude Code section listing the project's skills, hooks
  and rules. Project skills, commands, agents, hooks and rules stay where they
  are; flag any whose name a user-level skill shadows.
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
- `.github/dependabot.yml`, when present: set each ecosystem's
  `commit-message` to `prefix: "build"` (dependencies) or `prefix: "ci"`
  (GitHub Actions) with `include: "scope"`, so Dependabot titles its pull
  requests `build(deps): ...` and passes the title check.
- Root `.gitignore`, in both modes: create it when it is missing, or complete
  the existing one, and add `.claude/worktrees/` so it appears exactly once.
  Claude Code makes its worktrees there, and unignored, a broad `git add`
  stages a live worktree as an embedded repository. Keep the existing entries
  and add no rule that ignores the rest of `.claude/`: the repository versions
  its settings, skills, agents and rules.
- Documentation diagrams: convert ASCII diagrams to Mermaid with a prose
  description when touched; do not rewrite untouched documents.

Commit in coherent groups (`docs: move agent instructions to CLAUDE.md`,
`ci: check pull request titles`, `chore: add issue and pull request templates`)
and prepare the pull request with `/pr-prep`.

## 4. GitHub settings (ask before each)

1. Merge settings: squash only, delete branches on merge, through the REST API
   and read back, because `gh repo edit` has been seen to exit 0 without
   applying them:
   `gh api repos/{owner}/{repo} --method PATCH -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false -F delete_branch_on_merge=true`.
2. Labels from `common/github/labels.json` (`gh label create --force`).
3. Rulesets, after the pull request title check has run at least once so its
   name exists. Both templates let the administrator role bypass (ADR 0008):
   on main only through pull requests, on tags always.
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
