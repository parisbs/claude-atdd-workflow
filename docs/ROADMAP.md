# Roadmap

Status as of 2026-10-22, checked against GitHub and the machine, not remembered.

Issue numbers written `claude-workflow#N` belong to the archived private
repository (ADR 0022); `#N` belongs to this one. Each open issue that moved here
names its old number in its body.

- Phases 0 and 1: done.
- Phase 2: done, except the removal of duplicates, which has not been checked.
- Orchestration (below): done. Open in milestone `orchestration`: #16 and #17.
- Delegation (below): decided in ADR 0014 and 0015, amended by ADR 0025 and
  0026, whose implementation has not started. Open in milestone `delegation`:
  #10 to #15.
- Hardening (below): open in milestone `hardening`: #6 to #9, #21 and #22.
- Efficiency (milestone `efficiency`): #25 done by #26.
- Measurement (below): #19 and #34 done by #20 and #35.
- Issues labelled `next`: #6 to #10, #21 and #22.
- Phase 3: started. One repository is migrated; the other was tracked by
  claude-workflow#19, closed in the archived repository. Whether it was
  migrated has not been checked here.
- Phase 4: not started. `docs/experiments/` holds seven records, the delegation
  probes and the Codex alignment probes of 2026-10-06, the Claude worktree
  probes of 2026-10-07, the orchestrator context probes of 2026-10-08, the
  hook `if` and `onFailure` probes and the researcher frontmatter hook probes
  of 2026-10-21, and the secret deny probes of 2026-10-22; the workflow has
  been used on this repository only and nothing about it has been measured
  beyond those probes and the donated session metrics.

## Phase 0: repository

Status: done. The repository exists and `main` is protected by the rulesets of ADR 0004.

- Create the private GitHub repository and push `main`.

## Phase 1: structure and generic configuration

Status: done. Pull requests run the tests on Ubuntu and macOS with Node 22 and
24, the whole suite again on Node 22.2.0 (the `engines` floor), and the metrics
tests on Windows with Node 22 and 24.

- `global/`: user `CLAUDE.md`, generic settings, safety hooks and user skills.
- `personal/`: example preferences and settings; real files stay local.
- `common/` and stack directories (`android/`, `flutter/`, `node-mcp/`,
  `supabase/`): templates for `repo-bootstrap`.
- `scripts/install.mjs`: copy `global/` into `~/.claude`, install personal
  files, merge settings, and a `--check` mode that reports drift.

## Phase 2: install on this machine

Last machine verification: installed, with `node scripts/install.mjs --check`
reporting no drift on 2026-10-22. The installer registers `codex-reviewer`
(ceiling `read-only`) and `codex-implementer` (`workspace-write`) through the
CLI, pinned to `codex-subagent-mcp@0.5.0` (claude-workflow#32 and
claude-workflow#57). Not
checked: whether the duplicate `CLAUDE.local.md` files and stale auto-memory
entries are gone from every repository; Phase 3 covers them per repository.

- Install, then remove the duplicates it replaces: personal preferences copied
  into project `CLAUDE.local.md` files and auto-memory entries.
- Register `codex-subagent-mcp` in the user scope: two registrations by role (ADR 0014).

## Orchestration

Status: done (claude-workflow#7 to claude-workflow#12, claude-workflow#17,
claude-workflow#18 and claude-workflow#26). Open in milestone `orchestration`:
#16 and #17, which place file-bound stack rules in path-scoped rules and
recommend the bug or oracle route with an issue label.

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

Status: decided; claude-workflow#32, claude-workflow#34, claude-workflow#42,
claude-workflow#46 and claude-workflow#57 implemented; open here as #10 to #15
(below). ADR 0014 and 0015 are accepted, and ADR 0025 and 0026, recorded
through this repository's #32 and #33, amend them with a routing matrix and compact reports
whose implementation has not started; the probes behind them are in
`docs/experiments/2026-10-06-delegation-probes.md`, and the checks of
`codex-subagent-mcp` against them in
`docs/experiments/2026-10-06-codex-alignment-probes.md`. Where a Claude
subagent's worktree starts, and what it takes to bind the oracle there, is in
`docs/experiments/2026-10-07-claude-worktree-probes.md`.

- claude-workflow#32: declare the two Codex registrations in `global/mcp-servers.json`,
  install them through `claude mcp`, report drift in `--check`, and allow the
  tools that spend no quota except job status (ADR 0014, amended by ADR 0017).
  Implemented; running the installer on
  this machine, with `personal/mcp-servers.json` for `CODEX_BIN`, follows the merge.
- #10 (was claude-workflow#33): name delegates `<engine>-<role>`, route by literal tool name, and
  check that descriptions route work. Upstream, `codex-subagent-mcp` issue 143
  asks each registration to describe itself.
- claude-workflow#34: the `task-package` skill, the three context rules, `omitClaudeMd`
  and a `tools` allowlist in both Claude agents, one report shape (ADR 0015).
  Implemented; its manual probes (the first-request cost and what a real
  subagent's context holds) are in section 5 of the probes record.
- claude-workflow#42: a hook over the Codex tools that denies a worktree delegation from a
  tree with uncommitted changes, a call without `working_dir` and a writing
  follow-up outside a Codex worktree, and a script that integrates a worktree.
  Implemented as `guard-codex.mjs` and `codex-integrate.mjs`.
  Upstream, `codex-subagent-mcp` issue 149 makes a follow-up resume in the
  worktree and issue 150 reports the worktree and what it left out.
- #11 (was claude-workflow#38): integrating a Claude subagent's worktree into
  the work branch and removing it with its branch. Its guard part is done by
  claude-workflow#45 and its base commit by claude-workflow#46; the integration
  and the ADR it names remain.
- #12 (was claude-workflow#39): cover the nested `CLAUDE.md` that reaches a
  delegate that sets `omitClaudeMd`.
- #13 (was claude-workflow#40): check that the tools allowlist of the Claude
  agents matches the tools a delegate has.
- #14 (was claude-workflow#43): how to protect the oracle inside a Codex run now that Codex has hooks
  of its own. Needs an ADR.
- claude-workflow#46: a Claude subagent's worktree starts from the fetched default remote
  branch, not the work branch, so the package names a Base commit and the
  delegate reaches it before any task edit. Implemented in `task-package`; its
  implementation ran through `claude-implementer` with `isolation: worktree` and
  a Base commit.
- The two-attempt budget of ADR 0010 is prose for every delegate.
  `codex-subagent-mcp` issue 62, which ADR 0010 names as its counterpart, bounds
  how many delegations a session can start; it does not count attempts at one
  problem.
- claude-workflow#57 (ADR 0017): Bash output is capped at 12,000 characters; MCP and Read
  caps stay unchanged, Codex runs blocking unless the human asks otherwise,
  and job status is never polled in a loop or allowed without permission.
  Both registrations are pinned to `codex-subagent-mcp@0.5.0`; the installer
  derives the five no-quota permissions and guard matcher from the server
  declarations, retires the old job-status permissions and reconciles removed
  names, with the same derivation used by `--check`.
  `guard-codex` applies the writing rules by requested sandbox for any name.
  Implemented: `task-package` keeps its fields and report prose in `SKILL.md`,
  with Codex details and schema in `codex.md` and Claude worktree rules in
  `worktree.md`; `task-package.mjs` prints its mechanical fields using the
  oracle's own commit and tree, and `pr-prep` refers to the Codex reference.
  Global instructions say to wait for CI through the app's PR monitor or
  `gh pr checks --watch`, run local work as background commands, read by range,
  and send broad investigations to `claude-researcher`.
- #15 (was claude-workflow#60): copy into the task package the path-scoped
  rules a delegation touches.
- #34, done by #35: `scripts/metrics-delegations.mjs` reports task-package
  coverage, hand-back and Codex result sizes and Codex tokens, the before and
  after measurement for ADR 0025 and 0026.

## Hardening (milestone `hardening`)

- #6 (was claude-workflow#27): `guard-git` does not read `git -c key=value` or
  `--git-dir`, so every rule is skipped for those forms.
- #7 (was claude-workflow#53), #8 (was claude-workflow#54) and #9 (was
  claude-workflow#55): `guard-git` should read quoted strings and heredocs as
  one word, recognise git behind command prefixes, absolute paths and grouping,
  and treat other ways of skipping git hooks like `--no-verify`.
- claude-workflow#28: Implemented: CI compares ADRs with the pull request base under
  ADR 0018, enforcing immutability, status transitions, numbering and the index.
- claude-workflow#66: the ADR check reads only legacy `- Status:` lines, so it cannot be
  rolled out to other repositories. Implemented: ADR metadata is standardised
  on MADR 4 front matter, read strictly (ADR 0020); `scripts/migrate-adrs.mjs`
  migrates legacy records mechanically, which the check verifies, and
  `repo-bootstrap` distributes the check, the migration script, the workflow
  and the required check.
- claude-workflow#70: Implemented: added ADRs require a recognised status word, and index links inside HTML comments are ignored (ADR 0021).
- claude-workflow#45: `guard-tests` keys the oracle on the branch name, so it does not
  freeze the tests inside a Claude subagent's worktree. Implemented: a linked
  worktree is bound by the nearest oracle tag that is an ancestor of `HEAD`
  (ADR 0016).
- claude-workflow#50: `.claude/worktrees/` is not ignored here nor by `repo-bootstrap`,
  so a subagent worktree shows as untracked in the main checkout. Implemented:
  this repository ignores it, `repo-bootstrap` adds it to the root `.gitignore`
  in both modes, and `drift-audit` reports a missing rule or tracked paths.
- #5, done by #23: with the repository public, the merge decision would merge a
  stranger's passing pull request without asking. Implemented: it also requires
  the author to be the authenticated `gh` user and the head branch to live in
  the base repository, reads every `gh api` call with an explicit host, and
  shares one time budget among its `gh` calls (ADR 0024).
- #21 and #22, from the reviews of #5: the merge decision reads the
  repository option differently from `gh` (attached, clustered, repeated, or
  consumed by another option), and `guard-git` can outlast its hook timeout
  when a subprocess ignores the termination signal or `git` stalls.
- #27, done by #28: the merge decision fails closed when its hook cannot run,
  `guard-git` also protects the branch `origin/HEAD` names, and `guard-tests`
  no longer matches the retired `MultiEdit` tool.
- #29, done by #30: `claude-researcher` reads untrusted pages with an
  unrestricted shell. Implemented: `guard-readonly`, declared in its own frontmatter with
  `onFailure: "block"`, allows a closed list of reads named by bare programs and
  denies everything else, unread forms included.
- #31, done by #36: the gaps found in the review of #26 and #28; the Node floor
  is 22.2.0, where the dot reporter first prints failure details.
- #37, done by #38: the shipped settings deny reading common secret files.
- #39, done by #40: the installer keeps the managed hooks when personal
  settings define hooks.
- #53, done by #54: a pull request was merged while an amendment existed only
  locally. Implemented: the merge decision asks when the local branch of the
  pull request has commits missing from its head or a worktree of it has
  uncommitted changes, and `pr-prep` checks the same after the push and before
  the merge.
- #55: oracle tags could only be deleted or moved from a terminal. Implemented:
  in the main session `guard-git` asks, saying whether the pull request is still
  open or which commits a move goes from and to; subagents and
  `bypassPermissions` stay denied (ADR 0029).

## Efficiency (milestone `efficiency`)

- #25, done by #26: compact verification output, and this repository's
  `.claude/settings.json` excludes `global/CLAUDE.md` from its sessions.

## Phase 3: integrate the existing repositories

Status: started. `codex-subagent-mcp` is migrated (its issue 142). `css-diagnostic`
was pending under claude-workflow#19, which is closed in the archived
repository; whether it was migrated has not been checked here.

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

Status: collection and donation implemented (ADR 0023, issue #19). The aim is
that other developers can inspect and replicate the
evidence behind the workflow, and, since the repository is public, donate
de-identified metrics from their own sessions to it.

- Donated session metrics (ADR 0023): a cross-platform script extracts one row
  per session from the Claude Code transcripts through a field allowlist; the
  contributor reviews the report and adds it to `docs/experiments/donated/`
  through a pull request from a fork; CI validates its form; the data is
  published under CC0 1.0. The transcript format was checked on 2026-10-20.
- The maintainer's own dataset comes from the same script, with model, effort
  and CLI versions.
- A local delegation report (issue #34, `scripts/metrics-delegations.mjs`): task-package coverage, hand-back
  and Codex result sizes, and Codex tokens per model and effort, in aggregates only. It is the before and after
  measurement for the routing and compact-report decisions (ADR 0025 and 0026) and is not donated.
- An optional local event log of hook decisions, off by default: counts,
  categories and enumerations only, never prompts, code or paths. Not decided.
- A baseline from the git and GitHub history. Not decided.
- A measurement protocol written before the data is read, as an ADR: metrics with
  operational definitions, hypotheses, covariates and limits.
- The claim it can support is "this worked in these contributors' contexts, and
  here is how to check", not "the workflow is valid in general". Donors are
  self-selected and their data is validated in form, not in origin, so the effect
  of the developer, the project type and the model cannot be separated from the
  effect of the workflow.

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
- The `effort` applied to the shipped subagents: the probe of claude-workflow#12 read the
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
