# Roadmap

## Phase 0: repository

- Create the private GitHub repository and push `main`.

## Phase 1: structure and generic configuration

- `global/`: user `CLAUDE.md`, generic settings, safety hooks and user skills.
- `personal/`: example preferences and settings; real files stay local.
- `common/` and stack directories (`android/`, `flutter/`, `node-mcp/`,
  `supabase/`): templates for `repo-bootstrap`.
- `scripts/install.mjs`: copy `global/` into `~/.claude`, install personal
  files, merge settings, and a `--check` mode that reports drift.

## Phase 2: install on this machine

- Install, then remove the duplicates it replaces: personal preferences copied
  into project `CLAUDE.local.md` files and auto-memory entries.
- Register `codex-subagent-mcp` in the user scope with a read-only ceiling.

## Phase 3: integrate the existing repositories

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

Run the workflow of ADR 0003 on real issues and record what happens in
`docs/experiments/`.

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

- Pitest support for Kotlin, and whether it needs the commercial Arcmutate
  plugin.
- Kotest property testing: current version and Gradle integration.
- How Codex loads project documents beyond the cases ADR 0012 checked: the size cap, nested
  directories, a global instruction file in `~/.codex`, and `codex exec resume`.
- The `codex-subagent-mcp` README still said Node 20 when the minimum became 22.
- The behaviour of an `@path` import whose target does not exist.
- Whether `axScreenReader` has any effect in the desktop app.
- CheatBench figures once its code is published.
- Standardized SWE-bench Pro entries for the September 2026 models.
