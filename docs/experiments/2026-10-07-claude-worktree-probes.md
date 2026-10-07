# Claude subagent worktree probes, 2026-10-07

Practical checks behind issue 46: where a Claude subagent started with `isolation: worktree` begins, whether it
can reach the commit a package names, and whether `guard-tests` binds its worktree once it does (ADR 0016, the
live probe that pull request 49 left open). Each section states what was run and what was observed. A single run
per variant: it shows that a behaviour exists, not how often.

Environment: Claude Code 2.1.291 on macOS, desktop app and headless `claude -p`. Opus 5.5 for
`claude-implementer`, Sonnet 5.5 for `claude-researcher`, Haiku 4.5 for the headless parent and probe agent. Git
prints in Spanish on this machine, so quoted git output is in Spanish. `worktree.baseRef` was not set in
`global/settings.json`, `~/.claude/settings.json` or `.claude/settings.local.json`; `.claude/settings.json` does
not exist. `origin/HEAD` points to `origin/main`.

## Setup

In this repository, a scratch branch `probe/46-worktree-base` from `1d8517f` (then `main` and `origin/main`) with
two local commits, never pushed:

- `d779ab6` adds `tests/probe-46.test.mjs`, tagged `oracle/probe/46-worktree-base` (the tag guard asked and the
  developer confirmed).
- `e5e5835` adds `probe46/notes.txt`; this is the base commit the packages named.

The main checkout was on that branch at `e5e5835` during the desktop probes. Everything was removed afterwards
(section 9).

## 1. Where the worktree starts, desktop (default settings)

Method: a foreground `Agent` call to `claude-researcher` with `isolation: worktree`, asked to run read-only git
commands and report them verbatim.

- Directory `.claude/worktrees/agent-<id>`, branch `worktree-agent-<id>`, its git directory under
  `.git/worktrees/agent-<id>`, the common directory the repository's `.git`.
- `HEAD` was `1d8517f`, equal to `origin/main`, while the main checkout was at `e5e5835` on another branch.
- `e5e5835` existed as an object (`git cat-file -t` gave `commit`) but was not an ancestor of `HEAD`
  (`git merge-base --is-ancestor` exited 1).
- The worktree was removed when the agent ended: it had no changes.
- The harness refused the first command, a compound script: "This agent is isolated in the worktree ... but this
  command names git in a form too complex to verify that it stays inside the worktree. Refusing to run it — a
  worktree-isolated agent's git operations must target its own worktree. Split it into plain, separate commands".
  `echo $?` after a git command was refused the same way; the same commands run alone succeeded.

Cost: 13,202 subagent tokens, 15 tool uses, 33 seconds.

## 2. Reaching the base commit and the oracle guard, desktop

Method: a foreground `Agent` call to `claude-implementer` with `isolation: worktree` and a package built from
`task-package`, with a Base commit `e5e5835`, the oracle `oracle/probe/46-worktree-base`, no commits allowed,
and explicit observation steps: check containment, bring the commit in without switching branches, then try one
edit of the frozen test and one of an ordinary file.

- Initial `HEAD` `1d8517f` on `worktree-agent-<id>`; the base commit was not an ancestor.
- `git merge --ff-only e5e5835...` ran with no prompt and fast-forwarded the branch; the ancestry check then
  exited 0. The commits were local and unpushed: the worktree shares the repository's object store.
- An `Edit` of `tests/probe-46.test.mjs` was denied by `guard-tests`: "tests/probe-46.test.mjs belongs to the test
  oracle frozen at oracle/probe/46-worktree-base. Do not change tests to make them pass." The worktree branch has
  no tag of its own, so the oracle was resolved through the nearest ancestor tag (ADR 0016).
- An `Edit` of `probe46/notes.txt` was allowed with no prompt.
- The worktree was kept when the agent ended: it had an uncommitted change. Checked from the main checkout:
  `HEAD` `e5e5835`, ` M probe46/notes.txt`.
- The compound-command refusal of section 1 happened again on the first call.

Cost: 15,324 subagent tokens, 16 tool uses, 59 seconds.

## 3. `worktree.baseRef` set to `"head"`, headless

Method: `claude -p --model haiku --settings '{"worktree":{"baseRef":"head"}}'` from the main checkout at
`e5e5835`, with `--agents` defining a Haiku probe agent that reports `git rev-parse HEAD`, the branch and `pwd`,
and the parent asked to call it once with `isolation: worktree`. The setting existed only for that invocation; no
settings file changed.

- With the setting: the worktree `HEAD` was `e5e5835`, the local `HEAD`.
- Control, the same command without `--settings`: `1d8517f`, as in section 1. Headless and desktop agree.

## 4. A repository without a remote, headless

Method: a scratch repository with `main` at `db1f91d` and a branch `work` at `c4b3c51`, checked out, no remote.
Same headless command as the control of section 3.

- The worktree `HEAD` was `c4b3c51`: the local `HEAD`, not `main`.

## 5. A remote that moved, headless

Method: a scratch repository cloned from a local bare `origin`, built so that four candidate bases differ:

- `c1` `253b1fc`, the common base; `work` `925cf4d` branches from it and is checked out.
- `c2` `489de46` on `main`, pushed, so `origin/main` was `c2`.
- `c3` `f77ced9` on local `main`, not pushed.
- `c4` `d80d677` pushed to `origin` from another clone, not fetched by this one.

The probe agent ran plain commands: report `HEAD`, try `git merge --ff-only` to `work`, and `git reset --hard` to
it if that failed.

- The worktree `HEAD` was `d80d677`, `c4`: Claude Code fetched before making the worktree and branched from the
  remote's tip, not from the stale `origin/main` (`c2`), the local `main` (`c3`) or the local `HEAD` (`work`).
  Afterwards the parent repository's `origin/main` was `d80d677`: the fetch updated it.
- `git merge --ff-only 925cf4d...` failed with exit 128: "Diverging branches can't be fast-forwarded ... fatal: No
  es posible hacer fast-forward, abortando."
- `git reset --hard 925cf4d...` succeeded; the ancestry check then exited 0.

## 6. A base that does not descend from the remote, desktop

Method: a scratch commit `ca99a73` on `afc7027`, the parent of `origin/main`, made with `git commit-tree` and held
by a scratch branch. A foreground `Agent` call to `claude-implementer` with `isolation: worktree`, the Base commit
`ca99a73`, no file edits, plain commands only: fast-forward first, `git reset --hard` if that failed.

- Initial `HEAD` `1d8517f`; `--is-ancestor` exited 1.
- `git merge --ff-only` failed with exit 128, the same diverging-branches message as section 5.
- `git reset --hard ca99a73...` ran with no prompt and no hook denial; `HEAD` was then `ca99a73` and the tree
  clean.
- The worktree was kept when the agent ended although no file changed: its `HEAD` had moved.

Cost: 12,576 subagent tokens, 8 tool uses, 36 seconds.

## 7. Other observations

- `.claude/worktrees/` is not ignored in this repository: while a worktree exists, `git status` in the main
  checkout shows `?? .claude/`.
- An unchanged worktree is removed when its agent ends; one with uncommitted changes or a moved `HEAD` is kept
  with its `worktree-agent-<id>` branch, and the orchestrator has to remove both.
- The permission outcome of moving the worktree branch is not stable. Issue 38 records that on 2026-10-06 a
  delegate's `git merge --ff-only` to an unpushed oracle commit was denied by the auto-mode classifier as "Git
  Destructive", and the delegate reported `blocked-by-guard`. On 2026-10-07 the same kind of fast-forward
  (section 2) and a `git reset --hard` (section 6) ran with no prompt. A package therefore cannot count on the move
  being allowed, and `blocked-by-guard` stays a possible outcome.

## 8. The implementation of issue 46 as a real delegation, desktop

Method: after the oracle was frozen (`a8af901`, tag `oracle/feature/claude-worktree-base`, pushed branch), a
foreground `Agent` call to `claude-implementer` with `isolation: worktree` and a package built from `task-package`:
goal, the issue's criteria, scope limited to `global/skills/task-package/SKILL.md`, a Base commit `a8af901`, the
oracle, sections 1 to 7 as prior findings, and one commit asked for.

- Initial `HEAD` `1d8517f` (`origin/main`) on `worktree-agent-<id>`; the Base commit was not an ancestor and was
  reachable as an object.
- `git merge --ff-only a8af901...` ran with no prompt, before any task edit; `HEAD` was then `a8af901`.
- It added the `Base commit` field and the section about Claude subagents, ran the file's tests (41 of 41) and
  `npm test` (217 of 217), and committed `3b65980` on its branch. It ran git as plain commands from the first
  call and reported no refusal.
- Integration by the orchestrator: the work branch was at `a8af901`, an ancestor of `3b65980`, so
  `git merge --ff-only` of the worktree branch brought the commit in; the unchanged-since-commit worktree was then
  removed with `git worktree remove` and its branch with `git branch -d`. `oracle-check` reported the test paths,
  test configuration and skip annotations unchanged, and `npm test` passed 217 of 217 on the work branch.

Cost: 34,079 subagent tokens, 17 tool uses, 113 seconds.

## 9. Cleanup

The two kept worktrees were removed with `git worktree remove --force` after their state was checked; the branches
`worktree-agent-*`, `probe/46-worktree-base` and `probe/46-diverged` were deleted, and the main checkout returned
to the work branch. The tag `oracle/probe/46-worktree-base` is removed by the developer, since the tag guard
denies the agent. The headless scratch repositories lived in the session's temporary directory.

## Review of the test plan

Before these probes, Codex reviewed the acceptance-test plan for issue 46 read-only through `codex-reviewer`
(`gpt-6.1-sol`, effort high, 4 minutes, 407,502 input tokens of which 332,160 cached, 7,867 output). It ran the
plan's patterns against counterexamples and showed that negated sentences satisfied four of them, such as "The
worktree never starts from the default remote branch"; the frozen tests require affirmative sentences inside a
section about Claude. It also pointed out the local-`HEAD` fallback, later confirmed in sections 3 and 4, and the
ambiguity of "before changing anything" against reaching the base commit, settled as "before any task edit".

## Comparison with Codex worktrees

Section 3 of `2026-10-06-delegation-probes.md` found that a `codex-implementer` worktree (`use_worktree: true`)
is a detached `HEAD` at the last commit of the checkout the delegation started from. A Claude `isolation: worktree`
starts instead from the freshly fetched tip of the default remote branch, on a branch of its own, unless
`worktree.baseRef` is `"head"` or there is no remote. Both share the repository's object store, so local commits
reach both; neither carries uncommitted changes or ignored files.

## What this means

- The base of a Claude subagent's worktree depends on the remote, not on the work branch, so a package that
  delegates into one names the commit to build on, and that commit must be committed.
- A fast-forward to that commit fails whenever the default branch has moved since the work branch left it, which
  squash merges make common. The fresh branch holds no work of its own, so moving it to the base commit loses
  nothing; a merge would bring the default branch's new commits into the delegate's work.
- Once the worktree's `HEAD` descends from the oracle commit, `guard-tests` binds it: the live probe that pull
  request 49 left open now passes.
- Issue 38 asked whether the wrong base came from the default branch or from the work branch being unpushed.
  Sections 1, 2 and 5 separate the two: the base is the fetched default remote branch whether or not the work
  branch is pushed, and an unpushed commit is still reachable from the worktree.
- Not checked: Linux or Windows, a repository whose default remote branch is not `main`, a fetch that fails
  (offline), and `worktree.baseRef` in the desktop app rather than headless.
