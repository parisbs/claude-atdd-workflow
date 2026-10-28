# Model and effort calibration for Claude subagents, 2026-10-28

Roadmap item M-6, experiments E1 (oracle test generation) and E3 (code review). Three Claude configurations wrote
oracle tests for two merged tasks and reviewed the guard hook three ways. The aim is to set defaults for a model and
effort matrix per role with data from this repository. Codex and experiment E2 (implementation) are out of scope
here and will be measured on the user's machine.

Every run was a subagent with `model` and `effort` set explicitly on the Agent call. Each transcript recorded the
model that served it (`claude-sonnet-5-5` or `claude-opus-5-5`) and the effort. The run happened in a Claude Code
cloud session on Linux with Node 22.22. `npm test` passed on `main` at 9239cb6 before the experiments started.

**Bottom line:**

- At this sample size the three configurations cannot be told apart on quality, in test writing or in review.
- Sonnet 5.5 at high cost the least in every comparison: 0.56 to 0.93 times Opus 5.5 at medium per comparison, and
  0.38 to 0.70 times Opus 5.5 at high.
- Run counts are small (one or two per cell), so the conclusions are provisional.

## Configurations

| Id | Model | Effort |
| --- | --- | --- |
| sh | Sonnet 5.5 (`sonnet`) | high |
| om | Opus 5.5 (`opus`) | medium |
| oh | Opus 5.5 (`opus`) | high |

Prices are from the `claude-api` skill's model table, consulted on 2026-10-28; the table itself was cached on
2026-10-06. Rates per million tokens:

- Opus 5.5: $4 input, $20 output, $0.20 cache read.
- Sonnet 5.5: $2 input, $10 output, $0.20 cache read.
- Cache writes are priced at 1.25 times input, the five-minute rate.

The cost of each run is computed from the per-message `usage` that Claude Code records in the subagent transcript:
input, output, cache read and cache write. Wall time is the span from the first transcript event to the last.

## E1: oracle test generation

### Tasks

- **T1:** issue #57, PR #61 (ATDD oracle in the merge decision).
  - Base 966def3, merge 6d27ce7.
  - In scope: AC-1 to AC-9. The text tests AC-10 and AC-11 were left out.
  - Reference tests: the PR's `tests/guard-git-oracle-gate.test.mjs`, `tests/guard-git-command-forms.test.mjs`,
    `tests/guard-git-entries.test.mjs` and `tests/guard-git-merge-flags.test.mjs`, 151 tests.
- **T2:** issue #55, PR #56 (ask before deleting or moving an oracle tag).
  - Base efe786a, merge d8d10ea.
  - In scope: AC-1 to AC-6. The text test AC-7 was left out.
  - Reference tests: the PR's `tests/guard-git-oracle-tags.test.mjs`, 16 tests.

### Method

- **Isolation:**
  - Each run got its own repository, built from `git archive <base>`, with a fresh history of one commit. The
    merge was therefore not reachable through git.
  - The task's ADR was added to that repository as the plan: ADR 0030 for T1, ADR 0029 for T2.
  - Each transcript was checked afterwards. No tool call read the main checkout, the merge commits or another
    run's directory.
- **Package:** every configuration received the same `TASK.md`, containing:
  - the goal and the issue body verbatim, including the acceptance criteria;
  - scope: new files under `tests/` only, with no change to existing files;
  - conventions: the AC id goes in each test name, and hook tests spawn the real hook with a fake `gh` first on
    `PATH`, as `tests/claude-hooks.mjs` and the existing tests show;
  - the requirement that the tests be red by assertion on the base, not by a harness error.
- **Deviation from the reference:** new files only. The reference also changed existing test files, which would
  not copy cleanly onto the merge.
- **Scoring:** done by the orchestrator with `node --test --test-reporter=tap` on fresh copies, never by the
  subagent.
  1. **Legitimate red:** the new tests run on the base. Each failing leaf test is classed as an assertion failure
     (`ERR_ASSERTION`) or a harness failure.
  2. **Green with the implementation:** the same files run on the merge. Each failure there is a false red.
  3. **Mutations:** the same files run on the merge with one mutation applied at a time. A mutation is killed when
     at least one test that passed on the unmutated merge fails. The reference tests are scored the same way.
  4. **Coverage:** the AC ids that appear in test names, plus the issue's edge cases, read from the files.
  5. **Stability:** three runs of the suite on the merge, in parallel, on a 4-core machine shared with other
     runs.

### Mutations

The same list was used for every configuration and for the reference of each task. Each mutation is a single
string replacement that occurs exactly once in the merged code.

T1, applied to 6d27ce7:

| Id | File | Change |
| --- | --- | --- |
| M1 | guard-git.mjs | `words()` no longer cuts at a `#` word |
| M2 | guard-git.mjs | `--delete` removed from the tag long options, so `--del` is not expanded |
| M3 | guard-git.mjs | push refspec `tags/oracle/x` without `refs/` is not read as an oracle tag |
| M4 | guard-git.mjs | `PLAIN_MERGE` accepts a `#` word |
| M5 | guard-git.mjs | atdd label check inverted |
| M6 | guard-git.mjs | changed test paths: `> 0` becomes `> 1` |
| M7 | guard-git.mjs | an unreadable oracle becomes evidence (passes) |
| M8 | guard-git.mjs | `bypassPermissions` check never matches (deny becomes ask) |
| M9 | guard-git.mjs | `--squash --merge` no longer denied |
| M10 | guard-git.mjs | a valued method flag gets the explicit allow |
| M11 | guard-git.mjs | the explicit allow omits the oracle evidence |
| M12 | guard-git.mjs | `gh` by absolute path skips the merge decision |
| M13 | guard-git.mjs | `gh pr -R x merge` not recognised as a merge |
| M14 | settings.json | merge entry `if` back to `Bash(gh pr merge *)` |
| M15 | guard-git.mjs | a changed oracle in `bypassPermissions` asks instead of denying |

T2, applied to d8d10ea:

| Id | File | Change |
| --- | --- | --- |
| N1 | guard-git.mjs | subagent: deny becomes ask |
| N2 | guard-git.mjs | `bypassPermissions`: deny becomes ask |
| N3 | guard-git.mjs | open pull requests: `> 0` becomes `> 1` |
| N4 | guard-git.mjs | a gh failure is reported as "no open pull request" |
| N5 | guard-git.mjs | the oracle-check warning is dropped |
| N6 | guard-git.mjs | the move reason omits the target commit |
| N7 | guard-git.mjs | `:refs/tags/oracle/x` is not a deletion |
| N8 | guard-git.mjs | a `+refspec` is not a move |
| N9 | guard-git.mjs | `git tag --force` is not a move |
| N10 | guard-git.mjs | `update-ref -d` is asked as a move |
| N11 | guard-git.mjs | unique long-option abbreviations are not expanded |
| N12 | commands.mjs | `git -C dir` is ignored |
| N13 | guard-git.mjs | `git` by absolute path skips the git rules |
| N14 | guard-git.mjs | an existing tag with `-f` is asked as a creation |
| N15 | guard-git.mjs | `git tag -d` on an oracle tag passes |

M1, M4 and M13 (findings A and B of the second A-9 review) and N13 are outside the issues' acceptance criteria.
The other 12 T1 mutations and 14 T2 mutations are within them.

### Results

Two runs per configuration per task, 12 runs in all.

| Run | Tests | Red on base: assertion / harness / pass | False red on merge | Mutation score | Cost | Time |
| --- | --- | --- | --- | --- | --- | --- |
| T1 sh-1 | 112 | 93 / 0 / 19 | 0 | 12/15 | $1.48 | 10.0 min |
| T1 sh-2 | 43 | 32 / 0 / 11 | 0 | 12/15 | $1.64 | 15.4 min |
| T1 om-1 | 43 | 43 / 0 / 0 | 0 | 12/15 | $1.76 | 6.5 min |
| T1 om-2 | 19 | 19 / 0 / 0 | 1 | 12/15 | $1.61 | 6.8 min |
| T1 oh-1 | 19 | 19 / 0 / 0 | 0 | 11/15 | $2.18 | 7.9 min |
| T1 oh-2 | 24 | 24 / 0 / 0 | 0 | 12/15 | $2.28 | 12.3 min |
| T1 reference | 151 | not run | 0 | 13/15 | | |
| T2 sh-1 | 34 | 25 / 0 / 9 | 0 | 14/15 | $0.67 | 3.5 min |
| T2 sh-2 | 24 | 20 / 0 / 4 | 1 | 14/15 | $0.64 | 3.5 min |
| T2 om-1 | 10 | 10 / 0 / 0 | 0 | 14/15 | $1.00 | 2.7 min |
| T2 om-2 | 11 | 11 / 0 / 0 | 0 | 14/15 | $0.86 | 2.9 min |
| T2 oh-1 | 10 | 10 / 0 / 0 | 0 | 14/15 | $1.32 | 4.3 min |
| T2 oh-2 | 10 | 10 / 0 / 0 | 0 | 14/15 | $1.16 | 4.7 min |
| T2 reference | 16 | not run | 0 | 11/15 | | |

**Surviving mutations:**

- Every T1 configuration run left M1, M4 and M13 alive; T1 oh-1 also left M6. All three are outside the acceptance
  criteria: they come from review findings made after the issue was written. The T1 reference, written after those
  reviews, kills them but leaves M2 and M3, two AC-9 forms, alive. Counting only the 12 mutations within the
  criteria:
  - five configuration runs killed 12 of 12;
  - T1 oh-1 killed 11 of 12 (it missed M6, a single changed test file);
  - the reference killed 10 of 12.
- Every T2 run left only N13 alive, which is outside the criteria. The T2 reference also left N9, N10 and N11 alive.

**False reds:** two in 12 runs, both from assertions stricter than the criterion.

- T1 om-2: the AC-3 test asserts that the explicit allow does not contain the tag name. The implementation says
  "No oracle was checked: oracle/feature/x is absent on ...", which AC-3 permits.
- T2 sh-2: an AC-2 test builds the command with a JavaScript `undefined`
  (`git tag -f oracle/feature/x undefined`), so the hook cannot resolve the target.

**Harness errors:** none in any run. Every failure on the base was an assertion failure. Sonnet's suites also hold
tests that already pass on the base: controls, and forms the hook already handled, from 4 to 19 per run. The Opus
suites at both efforts contained only red tests.

**Coverage:**

- Every run named every in-scope AC.
- T1 AC-4 lists five unreadable cases. They were all covered by sh-1, sh-2, om-1, oh-1 and oh-2 (oh-1 and oh-2
  used a tag that points to a blob for the comparison failure). om-2 covered four and said so in its report.
- AC-9 forms:
  - sh-1 left out the forms that already pass today, and reported it.
  - oh-2 left out the unforced `git push origin tags/oracle/x`, and explained why: git refuses it.
  - The rest covered the listed forms.

**Stability:** 11 of 12 suites gave the same result in all three runs. T2 om-1 failed one test once in three runs.
It did not reproduce later, and the likely cause is the timeout test under load (the machine was shared with
other evaluations and subagents). A false red counted above failed in all three runs, so it is deterministic.

**Suite size and spread:**

- Suite size varied most for Sonnet: T1 had 112 and 43 tests, T2 had 34 and 24.
- Opus suites were smaller and more even: T1 had 19 to 43 tests, T2 had 10 or 11.
- The mutation score did not follow suite size: on T1 the 112-test and the 19-test suites scored the same, 12 of
  15.

**Rule deviations:**

- Three runs (T1 sh-1, T1 sh-2, T1 oh-2) wrote a throwaway prototype of the feature in `/tmp` to check that their
  tests could pass, then deleted it. The package forbade implementing the feature. The prototypes did not reach the
  scored files, but they can only have helped those runs avoid false reds.
- T1 om-2 created a directory outside its run directory once and deleted it straight away. It reported this
  itself.

### E1 cost

| Config | T1 (2 runs) | T2 (2 runs) | Mean per run |
| --- | --- | --- | --- |
| sh | $3.12 | $1.31 | $1.11 |
| om | $3.37 | $1.86 | $1.31 |
| oh | $4.46 | $2.48 | $1.74 |

Sonnet high was the slowest on T1, at 10 and 15 minutes against 6.5 to 12 for Opus. It was about as fast as Opus
on T2.

## E3: code review

### Known defects

**Open records from the A-8 review.** They were re-run against `main` at 9239cb6 with the real hook, so their
status here is this session's, not the original review's.

| Record | Claim | Status on main |
| --- | --- | --- |
| 2 | `git commit -nm x` and `-an -m x` skip hooks without a deny | reproduced |
| 17 | `git commit --no-verif` and `-qn` pass without a deny | reproduced |
| 4 | `--attr-source` and `--shallow-file` values are read as the subcommand | reproduced (push `--no-verify` and subagent push pass) |
| 5 | a forced push with `--follow-tags` is treated as able to move oracle tags | reproduced (oracle ask) |
| 6 | forced glob `refs/heads/*:refs/tags/oracle/*` without local oracle tags gets only the generic ask | reproduced (ask even in `bypassPermissions`) |
| 7 | `gh pr checkout`, `gh repo sync` and `git bisect` miss the timing warning | not verified |
| 8 | `git -C ~/repo` does not expand the tilde | reproduced |
| 9 | for a subagent, `git tag -f` on a missing oracle tag is denied as "delete or move" | reproduced |
| 18 | `--git-dir`/`--work-tree` or `GIT_DIR=` read another repository | reproduced; listed as a known gap in issue #57 |
| 20 | with a push URL, the move question shows the fetch remote's commit | not verified |
| 24 | `-sd` is wrongly denied as not `--squash` | not reproduced: `-sd` now asks like `-s -d` (PR #61's `mergeOptions`); excluded |

That leaves 10 open records for E3a, two of them unverified.

**Seeded defects for E3b.** They are hunks of PR #61 reverted on top of `main`. Each one was checked against
`main` with the real hook.

| Id | Defect | Check |
| --- | --- | --- |
| S1 | `git tag --del` and `--forc` on an oracle tag read as creation (record 1) | `bypassPermissions`: main denies, seeded asks "Creating an oracle tag" |
| S2 | gh by absolute path skips the merge decision (records 3 and 14) | `/usr/bin/gh pr merge 1 --rebase`: main denies, seeded no decision |
| S3 | `gh pr merge --squash=false --merge` passes the squash check (record 15) | main denies, seeded reads the pull request (explicit allow on a green one) |
| S4 | refspecs `tags/oracle/x` without `refs/` not treated as oracle tags (record 16) | `bypassPermissions` `:tags/oracle/x`: main denies, seeded generic ask |
| S5 | a `#` comment word earns the explicit allow for another pull request (finding A) | by reading the code; reviewers reproduced it end to end |
| S6 | `gh pr -R x merge` gets no decision (finding B) | main denies, seeded no decision |
| S7 | `git tag --colu -d` read as a listing (finding D) | `bypassPermissions`: main denies, seeded no decision |

The seeded diff also carried three harmless changes: an import reorder, a variable rename and a comment.

**Clean refactor for E3c.** Seven behaviour-preserving edits in `guard-git.mjs` and `commands.mjs`:

- constants hoisted;
- a list folded;
- `hasFlag` rewritten equivalently;
- a variable renamed.

`npm run test:hooks` passes on it.

### Method

- **E3a, recall on real code.** Each configuration reviewed `global/hooks/guard-git.mjs` and
  `global/hooks/commands.mjs` of `main` with the instruction "find correctness defects in how this hook reads
  commands; report each with file, line, a reproducing command and severity". One run per configuration.
- **E3b, recall on a seeded diff.** The diff was applied to the working tree as `PR.diff`. Each configuration was
  told to review it as a pull request. Two runs per configuration.
- **E3c, precision.** The clean refactor was presented the same way as E3b. One run per configuration.

**Run setup:**

- Each run had its own copy of the repository, without the A-8 records. The reviewers could run the hook and the
  tests.
- Each report was labelled with a random id.

**Scoring:**

- A finding counts when it matches a known defect.
- Every cited line was checked against the file: about 35 citations in E3a and every citation in E3b and E3c.
- New claims were verified by running the hook where that was cheap.

**Blinding was partial.** Six reviewers could not write `REPORT.md` (the Write tool refuses report files from a
subagent), so their reports arrived in the orchestrator's context. The orchestrator also launched every run and so
knew the mapping. The scoring is mechanical against fixed lists, which limits the effect.

### Results

**E3b, seeded diff (two runs per configuration):**

- Every one of the six runs found all seven seeded defects.
- No run reported a false positive. Every run named the three harmless changes as harmless.
- No cited line was invented: every citation matched the seeded file.
- Several runs also found a true secondary effect of the S3 revert: `-sd` is denied again.
- Costs: sh $0.56 and $0.52, om $1.11 and $0.42, oh $0.91 and $1.33.
  - The $1.11 om run kept a background command alive after reporting and was stopped. Its cost includes that idle
    time.

**E3c, clean refactor (one run per configuration):**

- All three runs said there was no defect, so there were no false positives.
- Two runs noted, correctly, that two comments now sit above a constant rather than the function they describe,
  and called it cosmetic.
- Costs: sh $0.18, om $0.32, oh $0.48.

**E3a, real code (one run per configuration).** Records found:

| Run | Records found (of 10 open) | Cost | Time |
| --- | --- | --- | --- |
| sh | 2, 17, 8, 18 (4) | $0.79 | 6.0 min |
| om | 2, 17, 18 (3) | $1.28 | 5.8 min |
| oh | 2, 17, 4 (3) | $1.68 | 7.4 min |

- No run found records 5, 6, 7, 9 or 20.
- All three reports were long, 15 to 17 findings each, and actionable: each finding came with a reproducing
  command.
- Most findings beyond the A-8 records belong to the class the repository already accepts: forms the hook cannot
  read, which it allows (`CLAUDE.md`, invariants).
- The cited lines that were checked all matched `main`.

### New defects found in E3a

These are records, not fixes. Each one was verified by piping a PreToolUse event into `global/hooks/guard-git.mjs` of
`main` at 9239cb6, in a scratch repository.

1. **A gh word named after an `Object.prototype` member crashes the hook, and it fails open for the whole command.**
   - Claim: `ghIsRead` looks the first gh word up on a plain object (`GH_READS[cmd]?.includes(sub)`,
     `global/hooks/commands.mjs:72`). `constructor`, `toString` or `__proto__` return an inherited value without
     `includes`. The resulting TypeError reaches `failOpen` (`guard-git.mjs:948`), which drops the denials of
     every other segment.
   - Evidence: with `agent_id`, `gh pr create -f` is denied. `gh constructor; gh pr create -f` gets no decision.
   - Source: E3a, sh and oh.
   - Verified.
2. **`env`, `&`, a subshell or a quoted assignment hides `gh pr merge` from the merge decision, also with
   `--merge-only`.**
   - Evidence: `gh pr merge 5 --squash --admin` is denied. `env gh pr merge 5 --squash --admin`,
     `(gh pr merge 5 --squash --admin)`, `true & gh pr merge 5 --admin` and `FOO="a b" gh pr merge 5 --admin` get
     no decision with `--merge-only`.
   - The invariant says the hook allows forms it cannot read, while the merge decision "asks when it cannot read
     the pull request". These forms reach neither.
   - The same prefixes hide `gh pr create` from the subagent rule (`env gh pr create -f`, `true & gh pr create -f`).
   - Source: E3a, all three.
   - Verified.
3. **`git push origin HEAD` on `main` gets no decision.**
   - Evidence: the target is the literal `HEAD`, never resolved to the current branch.
   - Source: E3a, all three.
   - Verified.
4. **`git push --mirror origin` gets no decision, also in `bypassPermissions`.**
   - Evidence: `--mirror` force-updates and prunes every ref, including `main` and `oracle/*`.
   - Source: E3a, all three.
   - Verified.
5. **A backslash line continuation hides the rest of the command.**
   - Evidence: `git commit \` followed by a newline and ` --no-verify -m x` gets no decision. `segments` splits on
     the newline.
   - Source: E3a, sh.
   - Verified.
6. **`git -c core.hooksPath=/dev/null commit -m x` skips hooks without a deny.**
   - Source: E3a, om and oh.
   - Verified on a feature branch.

The reviewers also reported a few defects that this session did not verify:

- `GH_REPO=` or `GH_HOST=` before `gh pr merge` make the hook read a different pull request.
- `gh pr merge --body-file <path>` earns the explicit allow.
- A quoted `;` or `|` hides the flags after it.

## Cost

| Item | Cost |
| --- | --- |
| E1, 12 runs | $16.60 |
| E3, 12 runs | $9.58 |
| Probe of the Agent parameters | $0.13 |
| Orchestrator session (measured, at the time of writing) | about $8 |
| Total | about $34 |

The budget was $50, with a stop at $40. It was not reached. The original priority rule was two runs per
configuration in one task each of E1 and E3. The budget allowed two runs for both E1 tasks and for E3b, and one run
for E3a and E3c.

## What could not be measured, and why

- **Codex (gpt-6.1-sol, gpt-6-astra) and E2 (implementation).** Out of scope for this cloud session; they will be
  measured on the user's machine.
- **Variance in E3a and E3c.** One run per configuration, so there is no spread. E3b's two runs per configuration
  agreed exactly, which is a ceiling effect, not evidence of low variance.
- **Ceiling effects:**
  - E3b (7 of 7 everywhere) and E3c (0 false positives everywhere) did not discriminate.
  - The seeded defects were reverts of fixes whose tests still sit in `tests/`. Every reviewer ran the suite and
    used the failing tests as a map. A diff without that safety net would be a harder test.
- **E1 discrimination:** within the criteria, the mutation scores sit at the top (11 or 12 of 12 for T1, 14 of 14
  for T2). The mutation lists do not separate the configurations either. A harder mutant set, or tasks with weaker
  plans, would be needed.
- **Blinding:** partial, as described above.
- **Red on base for the reference tests:** not run, because the reference changed existing files and the helper
  `tests/claude-hooks.mjs`.
- **Records 7 and 20:** not re-verified on `main`; they need real remotes.
- **Effort as a separate variable for Sonnet:** only high was measured. The earlier finding that Sonnet depends
  strongly on effort was not tested.

## Conclusions by role, provisional

- **Oracle tests.** Sonnet 5.5 at high is a reasonable default.
  - It matched Opus at both efforts on mutation score and coverage, with no harness errors, for about 0.70 to 0.93
    times the cost of Opus at medium.
  - It wrote larger suites with passing controls, and was slower on the larger task.
  - Opus at medium was not measurably worse than Opus at high, so the Opus session that wrote tests at medium
    instead of Sonnet at high lost nothing measurable here.
  - Confidence: low. There are two runs per cell and the scores are at the ceiling.
- **Review of a diff.** Sonnet 5.5 at high is enough when the diff has tests that cover it: all configurations
  found every seeded defect, with no false positives and no invented lines. Confidence: low, for the ceiling reasons
  above.
- **Review of code without a diff.** No configuration separated from the others: 4, 3 and 3 of 10 records with one
  run each. All three found the same serious new defects.
  - This data does not support the external 8-of-13 versus 6-of-13 gap between Opus and Sonnet, nor contradict it.
  - Opus at high cost about twice Sonnet at high.
  - Confidence: very low.
- **Where the difference fades.** On tasks with a precise plan and testable criteria, the difference between the
  three configurations is below what this sample can detect. If Opus has an edge, it would show on open-ended
  review and on tasks with a weaker plan, and neither was measured with enough runs to see it.
