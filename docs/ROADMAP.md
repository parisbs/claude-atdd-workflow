# Roadmap

Status as of 2026-10-06, checked against GitHub and the machine, not remembered:

- Phases 0 and 1: done.
- Phase 2: done, except the removal of duplicates, which has not been checked.
- Orchestration (below): done.
- Delegation (below): decided in ADR 0014 and 0015. Issues 32, 34 and 42 are implemented; 33, 43 and 46 are open. Milestone `delegation`.
- Phase 3: started. One repository is migrated, one is pending.
- Phase 4: not started. `docs/experiments/` holds two records, the delegation
  probes and the Codex alignment probes of 2026-10-06; the workflow has been used
  on this repository only and nothing about it has been measured beyond those
  probes.

## Phase 0: repository

Status: done. The repository exists and `main` is protected by the rulesets of ADR 0004.

- Create the private GitHub repository and push `main`.

## Phase 1: structure and generic configuration

Status: done. Pull requests run the tests on Ubuntu and macOS with Node 22 and 24.

- `global/`: user `CLAUDE.md`, generic settings, safety hooks and user skills.
- `personal/`: example preferences and settings; real files stay local.
- `common/` and stack directories (`android/`, `flutter/`, `node-mcp/`,
  `supabase/`): templates for `repo-bootstrap`.
- `scripts/install.mjs`: copy `global/` into `~/.claude`, install personal
  files, merge settings, and a `--check` mode that reports drift.

## Phase 2: install on this machine

Status: installed, and `node scripts/install.mjs --check` reports no drift
(2026-10-06). `codex-subagent-mcp` is registered by hand in the user scope, twice, as
`codex-reviewer` (ceiling `read-only`) and `codex-implementer` (`workspace-write`),
on `^0.5.0` (`claude mcp get <name>`); issue 32 makes the repository install them. Not
checked: whether the duplicate `CLAUDE.local.md` files and stale auto-memory
entries are gone from every repository; Phase 3 covers them per repository.

- Install, then remove the duplicates it replaces: personal preferences copied
  into project `CLAUDE.local.md` files and auto-memory entries.
- Register `codex-subagent-mcp` in the user scope: two registrations by role (ADR 0014).

## Orchestration

Status: done (milestone `orchestration`, issues 7 to 12, 17, 18 and 26). Open in
that milestone: issue 19, which belongs to Phase 3.

What now exists, each part with its decision record:

- The merge decision of `gh pr merge` from what GitHub shows, with `Human merge`
  read from the repository's `CLAUDE.md` (ADR 0010).
- The orchestrator can start the workflow skills, and the global Delegation
  section says who does what and when to stop (ADR 0010, 0011).
- Two user-level subagents, `claude-implementer` and `claude-researcher`,
  installed in `~/.claude/agents/` (ADR 0011). The reviewer is deferred.
- `guard-git` denies `git push` and every `gh` command off a read-only list to
  any subagent, also inside `bash -c` or `eval` (ADR 0013). It was probed on
  2026-10-06 with a real subagent: merge, push and wrapper were denied and a
  read was allowed.
- `CLAUDE.md` as the only instruction file of a repository (ADR 0012).

Known costs, accepted: a subagent cannot call `gh api graphql`; the hook reads a
command as words, so a quoted `; git push` inside a commit message is denied.

## Delegation (milestone `delegation`)

Status: decided; issues 32, 34 and 42 implemented, 33, 43 and 46 open. ADR 0014 and
0015 are accepted; the probes behind them are in
`docs/experiments/2026-10-06-delegation-probes.md`, and the checks of
`codex-subagent-mcp` against them in
`docs/experiments/2026-10-06-codex-alignment-probes.md`.

- Issue 32: declare the two Codex registrations in `global/mcp-servers.json`,
  install them through `claude mcp`, report drift in `--check`, and allow the
  tools that spend no quota (ADR 0014). Implemented; running the installer on
  this machine, with `personal/mcp-servers.json` for `CODEX_BIN`, follows the merge.
- Issue 33: name delegates `<engine>-<role>`, route by literal tool name, and
  check that descriptions route work. Upstream, `codex-subagent-mcp` issue 143
  asks each registration to describe itself.
- Issue 34: the `task-package` skill, the three context rules, `omitClaudeMd`
  and a `tools` allowlist in both Claude agents, one report shape (ADR 0015).
  Implemented; its manual probes (the first-request cost and what a real
  subagent's context holds) are in section 5 of the probes record.
- Issue 42: a hook over the Codex tools that denies a worktree delegation from a
  tree with uncommitted changes, a call without `working_dir` and a writing
  follow-up outside a Codex worktree, and a script that integrates a worktree.
  Implemented as `guard-codex.mjs` and `codex-integrate.mjs`.
  Upstream, `codex-subagent-mcp` issue 149 makes a follow-up resume in the
  worktree and issue 150 reports the worktree and what it left out.
- Issue 43: how to protect the oracle inside a Codex run now that Codex has hooks
  of its own. Needs an ADR.
- Issue 46: a Claude subagent's worktree starts from the default branch, not
  the work branch, so the package must name the commit the delegate builds on.
- The two-attempt budget of ADR 0010 is prose for every delegate.
  `codex-subagent-mcp` issue 62, which ADR 0010 names as its counterpart, bounds
  how many delegations a session can start; it does not count attempts at one
  problem.

## Hardening (milestone `hardening`)

- Issue 27: `guard-git` does not read `git -c key=value` or `--git-dir`, so
  every rule is skipped for those forms.
- Issue 28: CI check that merged ADRs change only their status line and that
  every ADR is in the index.
- Issue 45: `guard-tests` keys the oracle on the branch name, so it does not
  freeze the tests inside a Claude subagent's worktree.

## Phase 3: integrate the existing repositories

Status: started. `codex-subagent-mcp` is migrated (its issue 142); `css-diagnostic`
is pending. Issue 19 tracks both.

One branch and one pull request per repository that already has agent
instructions, through `repo-bootstrap` integrate mode, piloted on one
repository first. The list of repositories is tracked in this repository's
issues, not here. For each one:

- `CLAUDE.md` in English as the only instruction file (ADR 0012).
- Remove content that can be derived from the code.
- Declare conventions and one verify command.
- Copy the critical rules of the stack (for example the Supabase security rules
  into a Supabase repository that lacks them).
- Remove redundant `CLAUDE.local.md` files.
- Apply the rulesets of ADR 0004 and the pull request title check of ADR 0005;
  remove release-branch rulesets.
- Update stale auto-memory entries (merge policy, release branches).

## Phase 4: basic ATDD pilot

Status: not started. Next step: three real issues in one repository that has a
real test suite, run with the installed `claude-implementer`, with notes kept by
hand in `docs/experiments/`: what each issue cost, where the oracle was wrong,
what the human had to correct. Instrumentation waits for what the pilot shows.

Run the workflow of ADR 0003 on real issues and record what happens in
`docs/experiments/`.

## Measurement

Status: designed on 2026-10-05, not started, no issue and no ADR yet. The aim is
that other developers can inspect and replicate the evidence behind the workflow,
within its limits; it is not to pool data from many people.

- An optional local event log, off by default: counts, categories and
  enumerations only, never prompts, code or paths. What each developer records
  stays on their machine.
- A baseline taken from the Claude Code transcripts and the git and GitHub
  history that already exist, which needs a check of the transcript format first.
- An analysis script anyone can run on their own log, and the maintainer's
  dataset published in `docs/experiments/` with model, effort and CLI versions.
- A measurement protocol written before the data is read, as an ADR: metrics with
  operational definitions, hypotheses, covariates and limits.
- The claim it can support is "this worked in one developer's context, and here
  is how to check", not "the workflow is valid in general". With one developer the
  effect of the developer and of the project type cannot be separated.

## Later: the full protocol

Items from the original design that the basic form defers:

- **Held-out tests** in a separate private repository that only CI downloads,
  composing real usage scenarios. Needed because Codex reads are not confined.
- **CI oracle check** in each repository: compare the test tree, test resources
  and test configuration (for example in `build.gradle.kts`) with the approved
  oracle commit, and fail on any unauthorised difference.
- **Escape valve as a state machine**: the agent posts its justification on the
  issue or pull request, the human applies an approval, and CI accepts test
  changes only with that approval and in a separate commit. The approval must be
  something the agent cannot produce with the user's token, for example a tag
  signed with a key that needs interactive confirmation.
- **Indirect weakening checks**: `@Ignore` and skip annotations, test filters,
  Gradle `testOptions`, fixture changes, mocks introduced into production code,
  and static-analysis baselines.
- **Property-based tests** (Kotest property testing) and **mutation testing**
  after implementation (Pitest, possibly through the Arcmutate Kotlin plugin).
- **Second opinion in phase 1** from Codex, read-only, through
  `codex-subagent-mcp`, before the human approves.

Operational rules that apply from the start:

- Flaky tests poison the oracle and teach the agent that retrying until green
  is valid. Quarantine them outside the oracle until they are deterministic.
- Instrumented tests on devices are slow: run them in the pre-PR gate, never in
  a `Stop` hook.
- Cost levels: trivial changes skip the protocol (see the levels in
  `global/CLAUDE.md`).
- Traceability: each test name carries its `AC-n`; the pull request carries the
  criterion-to-test map, the oracle commit and the red evidence.

## Experiment

Measure on real repositories instead of relying on Python benchmarks.

- About ten comparable issues in one repository, each run two or three times per
  variant because the model is not deterministic.
- Variant A: approved criteria and tests (phase 1), then implementation (phase
  2). Optional variant B: the same plus a prose behaviour spec, to measure
  whether it adds anything.
- Model comparison: the same phase 2 run by Claude and by Codex through
  `codex-subagent-mcp`, inside a worktree.
- Metrics: tokens and cost per issue, iterations to green, attempts to touch
  protected paths (logged by the hook), failures on held-out tests, findings in
  pull request review, and rework after merge.
- Record results in `docs/experiments/` with date, model, reasoning effort and
  CLI version.
- The Kotlin repositories have very few tests today, so the mechanics are
  piloted first on a repository with a real test suite.

## Pending verification

- Not checked in the delegation probes: `auto_approve`, Codex efforts above low, Linux and Windows,
  and whether path-scoped rules load inside a subagent.
- The `effort` applied to the shipped subagents: the probe of issue 12 read the
  model from the subagent transcripts, not the effort.
- Whether the tool list of a subagent can be read from the harness: the probe
  relied on the agents reporting their own missing tools.
- Pitest support for Kotlin, and whether it needs the commercial Arcmutate
  plugin.
- Kotest property testing: current version and Gradle integration.
- How Codex loads project documents beyond the cases ADR 0012 checked: the size cap, nested
  directories, a global instruction file in `~/.codex`, and `codex exec resume`.
- The behaviour of an `@path` import whose target does not exist.
- Whether `axScreenReader` has any effect in the desktop app.
- CheatBench figures once its code is published.
- Standardized SWE-bench Pro entries for the September 2026 models.
