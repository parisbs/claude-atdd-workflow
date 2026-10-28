---
status: proposed
date: 2026-10-26
---
# 0030. Enforce the oracle on the agent at the merge guard, not in CI

- Amends: [0003](0003-approved-tests-replace-behaviour-specs.md) (the CI oracle check deferred, not rejected)
- Issue: #57

## Context

ADR 0003 freezes the human-approved tests with an `oracle/<branch>` tag and
enforces the freeze locally: `guard-tests` denies Edit and Write on test paths,
and `oracle-check` compares the working tree with the tag in `pr-prep` and
`codex-integrate`. It deferred a CI oracle check as part of the full protocol.

Two gaps remain. The merge conditions in `global/CLAUDE.md` say `oracle-check`
is clean before the agent merges, but `guard-git`'s merge decision never
compares the pull request with the tag, so the condition is prose. And a
frozen test changed through Bash, or a tag deleted by a form `guard-git` does
not read, reaches an agent merge unnoticed. The A-8 review found four such
forms that would also slip past a new gate: `git tag --del` and `--forc` read
as creation, `gh` by absolute path skipping the merge decision (Claude Code
2.1.308 does not start an entry whose `if` is `Bash(gh pr merge *)`),
`gh pr merge --squash=false --merge` earning the explicit allow, and push
refspecs `tags/oracle/x` moving or deleting a remote tag without the denial of
ADR 0029.

A CI job was designed first (`pull_request`, script from the base commit,
label `atdd`, a ruleset on `oracle/**`) and weighed against what it costs:

- The threat this workflow guards against is the agent's error or shortcut,
  not an attacker. Its deterministic controls limit what the agent does on its
  own and do not stop the human; where the human decides, a control gives
  evidence the hook read (pull request state, commits, diff, files, tag), never
  a summary the agent wrote.
- The agent acts with the human's token, and the human is an administrator,
  so a ruleset's administrator bypass applies to the agent as well: a tag
  ruleset raises the bar without being a boundary, and lifting it for cleanup
  needs the human.
- For other repositories (P-3) a CI job adds a workflow to maintain and
  distribute, Actions minutes billed on private repositories, rulesets that
  need a paid plan there, and tags that must stay on the remote until the
  merge.
- No measurement shows a frozen test changing unnoticed.

Claude Code's documentation (October 2026) describes command hooks as
deterministic in execution: a matching hook runs and its decision applies,
and since 2.1.295 `onFailure: "block"` blocks the call when the hook cannot
start, fails or times out. What a hook on Bash detects is not complete: it
reads the command string, and the documentation lists forms of the same
command that string matching misses.

## Decision

- The core workflow does not check the oracle in CI. The check runs where the
  agent acts on its own: `guard-git`'s merge decision.
- Before an agent merge, the merge decision reads `oracle/<head branch>` from
  the remote of the pull request's base repository with a bounded
  `ls-remote`, and compares the tag's commit with the pull request's head
  commit using the test paths of `global/hooks/oracle.mjs` as recorded in the
  oracle commit. The comparison is strict, like `oracle-check`.
- A changed test path, the label `atdd` without a tag, or an oracle that
  cannot be read is a reason in the merge decision: the main session asks and
  shows the tag, its commit and the changed files; `bypassPermissions`
  denies. `bypassPermissions` shows no prompt, so it also denies any other
  merge state the decision cannot read: the pull request, its provenance, the
  local work or `CLAUDE.md`. Subagents are already denied `gh pr merge` (ADR 0013). With neither
  a tag nor the label the oracle adds no reason, and the explicit allow says
  that nothing was checked; with a clean oracle it names the tag and commit.
- The four forms above are read: abbreviated long options and push refspecs
  without `refs/` count as deleting or moving an oracle tag, the merge entry
  starts for `gh` by any path (`if: Bash(*gh pr merge *)`), and a merge-method
  flag with a value, `--merge` or `--rebase` never earns the explicit allow.
- Three more forms found in review are read: a word that starts with `#` is
  a shell comment that ends the command and never earns the explicit allow;
  flags between `gh pr` and `merge`, which the merge entry's `if` does not
  match, are denied with the advice to write them after `merge`; and
  `git tag --column`, which takes a value only after `=`, does not hide a
  following `-d`.
- The CI oracle check is not rejected. It stays an optional tool that a human
  or team may apply to themselves, unbuilt until someone asks for it. Its
  first design (`pull_request` with the script from the base commit, tag read
  from the remote, label events, a stable job name) is the starting point.

## Alternatives considered

- **A CI job as a required check, with a ruleset on `oracle/**`.** Rejected
  for the core: it does not bind the agent more than the merge guard does,
  because the agent holds the administrator's token, and it costs every
  repository that installs the workflow a maintained job, billed minutes on
  private repositories and paid-plan rulesets. Kept as an optional tool.
- **`pull_request_target`, so the pull request cannot edit the job.**
  Rejected with the CI job; it also needed an experiment to show that its
  check counts as a required check on the pull request's head.
- **A hook on `gh pr create` that pastes `oracle-check`'s output into the
  pull request.** Rejected: the output would reach the human through the
  agent, which is the party being checked.
- **Leave it to prose and `pr-prep`.** Rejected: the merge condition is
  already prose and nothing checks it.
- **Deny the main session when the oracle fails.** Rejected: the human
  answers the question and decides; a branch updated from `main` after
  freezing, where `main` touched tests, would otherwise block every agent
  merge until the oracle is frozen again.

## Consequences

- An agent merge is checked against the oracle on any machine with the hooks
  installed, whichever form deleted a tag or changed a test before.
- Accepted risk: when the human merges on the web there is no independent
  evidence of the oracle, and the guard is a net: forms it does not read
  (such as `gh api` merges, `git -c alias...` aliases, `--git-dir` or
  `GIT_DIR`, `gh` run through `env`, `command`, `time` or as `\gh`) pass.
  An assignment prefix such as `GH_REPO=` or `GH_HOST=`, or an exported
  `GH_REPO`, makes gh merge a pull request of another repository than the one
  the hook reads. They are named as known gaps.
- The decision reads the pull request once, before the merge runs: a head
  pushed between that read and the merge is not compared, and
  `gh pr merge --auto` lets GitHub merge later pushes without the hook. Both
  are known gaps.
- The merge decision makes one more network call inside its 10 s budget;
  exhausting the budget asks in the main session and denies in
  `bypassPermissions`. Both commits must be in the local clone, which
  the merge decision does not fetch.
- A fork's oracle tag must be on the base repository.
- A branch updated from `main` after freezing, where `main` touched tests,
  lists those files and asks.
- The invariant that CI and rulesets are the workflow's guarantee
  (`CLAUDE.md`, ADR 0002, ADR 0008) is not changed here; a later record
  restates it. ADR 0029's consequence naming CI and the rulesets as the
  guarantee stays as written.
- ADR 0003 is accepted and frozen; its sentence that "the CI oracle check
  closes that gap later" stays as written. Once this record is accepted,
  ADR 0003's status gains the annotation `amended by 0030`.
