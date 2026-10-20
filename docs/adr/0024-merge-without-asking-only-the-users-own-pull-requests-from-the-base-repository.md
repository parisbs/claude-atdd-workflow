---
status: accepted
date: 2026-10-20
---
# 0024. Merge without asking only the user's own pull requests from the base repository

- Amends: [0010](0010-move-human-control-to-the-specification-and-gate-merges.md)

## Context

ADR 0010 lets the orchestrator merge a pull request without asking when its
checks passed, no changed file is on the control plane, it is not a draft and it
does not carry `needs-human`. `guard-git` enforces those conditions from what
`gh pr view` shows, and never looks at who opened the pull request or where its
head branch lives. Now that this repository is public (ADR 0022), and invites
pull requests from forks (ADR 0023), a stranger's pull request that passes CI
and touches no control-plane path meets every condition: an agent asked to merge
the open pull requests would merge it without a prompt. The hook is global, so
the same holds in every repository the user works in.

Read-only probes with `gh` on 2026-10-20:

- `isCrossRepository` is true for a pull request from a fork (cli/cli#14765) and
  false for a branch in the base repository (parisbs/claude-atdd-workflow#1 to
  #4).
- A deleted fork reads as `headRepository` null, `isCrossRepository` still true
  and `headRepositoryOwner` set (cli/cli#14544, #14502, #14482).
- Bots read as authors such as `{"login":"app/dependabot","is_bot":true}` and
  `app/github-actions`. Dependabot pull requests come from a branch in the base
  repository, so only the author condition stops them. A deleted author reads
  as `ghost`.
- `gh api user` returns the authenticated login in about 0.5 s. With
  `GH_HOST=ghe.invalid` it fails without `--hostname`, and returns the
  github.com user with `--hostname github.com`.
- Not probed: an installation token or the Actions `GITHUB_TOKEN`, documented to
  fail on `/user`, and GitHub Enterprise Server.

## Decision

Two conditions join those of ADR 0010. The orchestrator merges without asking
only when, in addition:

- the pull request was opened by the authenticated `gh` user, the person the
  agent acts for; and
- its head branch lives in the base repository, not in a fork
  (`isCrossRepository` false).

Mechanism, in the merge decision of `guard-git`:

- `gh pr view` also requests `author`, `isCrossRepository`,
  `headRepositoryOwner` and `headRepository`.
- The authenticated user is read with `gh api --hostname <host> user`, where
  `<host>` is the host of the pull request's URL. Its `login` is compared with
  the author's `login`.
- Every `gh api` call of the merge decision names that host with `--hostname`,
  github.com included: the user lookup and the read of `CLAUDE.md` of the base
  branch. Without it `gh` follows `GH_HOST`, so the user could be read on
  another host, and an HTTP 404 from another host would read as a base branch
  without `CLAUDE.md` and drop its `Human merge:` paths.
- Only the user is a trusted author. Collaborators ask, and so do bots such as
  Dependabot or Renovate: there is no exception by name.
- A pull request from a fork asks even when the user opened it. The reason
  names the head repository as `owner/name`, or the owner alone when the fork
  was deleted.
- As in ADR 0010, what cannot be read asks: an author without a login, an
  `isCrossRepository` that is not a boolean, and a user lookup that fails,
  times out or returns no login. A null `headRepository` is not missing data;
  `isCrossRepository` decides that case.

## Alternatives considered

- **Trust collaborators with write access.** Rejected: whether an account is a
  collaborator says what it may push, not that the user has seen its change.
  Comparing with the authenticated user also holds in personal and organisation
  repositories alike, without reading permissions that differ between them.
- **Exempt bots by name, such as Dependabot.** Rejected: a dependency update
  that changes a lockfile is what a human should see, even when the lockfile is
  not on the control plane. In parisbs/codex-subagent-mcp, 13 of 115 merged pull
  requests are Dependabot's and 10 of them touched only `package-lock.json`; they
  merge without a prompt today and will ask.
- **Allow the user's own pull requests from a fork.** Rejected: the head branch
  then lives in a repository whose access and rules the base repository does
  not control, and the case is rare enough that asking costs little.
- **Call `gh api` without `--hostname` on github.com.** Rejected: `gh` then
  follows `GH_HOST`, which can name another host and another account than the
  pull request's.
- **Also judge who pushed the commits, not only who opened the pull request.**
  Rejected for now: the risk it closes needs write access the user granted (see
  Consequences), and the change that introduced this record left it out of
  scope. A later record can add it.

## Consequences

- The author is who opened the pull request, not who pushed its commits. A
  collaborator with write access can push to the user's branch in the base
  repository, and the merge is still allowed without a prompt. That needs write
  access the user granted; it is an accepted risk, and the repository's CI and
  rulesets remain the guarantee.
- Every merge decision makes one more `gh` call, three in series with
  `gh pr view` and the read of `CLAUDE.md`. Each keeps its own limit
  (`GUARD_GIT_GH_TIMEOUT_MS`, 6 s by default), and all of them share one time
  budget per hook run (`GUARD_GIT_GH_BUDGET_MS`, 10 s by default, counted from
  the start of the hook), so that slow calls cannot together outlast the 15 s
  that `global/settings.json` gives `guard-git` before it prints an answer. A
  call is stopped when what is left of the budget runs out, and a spent budget
  asks with a reason that says so. The budget bounds only calls that exit when
  stopped: a `gh` that ignores the termination signal, or an unbounded `git`
  call elsewhere in the same command, can still outlast the hook timeout; that
  gap predates this record and is left to issue #22.
- A stricter gate asks more often, mostly where bots open pull requests.
  Donations of session metrics (ADR 0023) come from forks and are merged by a
  maintainer, which this rule now enforces.
- A token that cannot read `/user`, such as an installation token or the
  Actions `GITHUB_TOKEN`, makes every merge ask.
- ADR 0010 stays accepted and unchanged; its list of merge conditions is read
  together with this record. The Delegation section of `global/CLAUDE.md` lists
  both.
