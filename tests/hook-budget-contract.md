# Issue #84 hook test contract

These tests run the real hooks. A separate change implements this seam. No hook
source is replaced or evaluated by the tests.

Activation requires **all** of the following:

- `CW_HOOK_BUDGET_TEST` is exactly `issue-84:explicit-test-only`.
- `CW_HOOK_BUDGET_CONFIG` is an absolute path to a readable JSON file with
  `version: 1`, `root`, `trace`, `steps`, `cpuStepUs`, and `ready`.
- The real path of the running hook is exactly
  `<realpath(config.root)>/global/hooks/<hook basename>`, and
  `<root>/tests/hook-budget.mjs` exists. Resolve symlinks before comparing.
- `root` and `trace` are absolute paths, `steps` and `ready` are arrays, and
  `cpuStepUs` is a finite nonnegative safe integer. Each entry has the schema below;
  reject missing fields, invalid entries, and invalid configurations as a whole.

Missing, malformed, partial, or rejected configuration silently uses the production
clock, CPU accounting, timeouts, and defaults. In particular a copied installation
under `~/.claude/hooks` cannot activate the seam using a checkout's configuration.
The seam never executes code from configuration.

Each hook process starts virtual wall time and CPU usage at zero, including module
startup. Wall time is frozen except for the read charges below. Each deciding
`check()` in guard-tests increments virtual CPU usage by `cpuStepUs` microseconds
before comparing it with the existing CPU limit. Grace/trigger `wall()` checks do
not increment CPU. All existing budget/deadline arithmetic reads these clocks;
limits, caps, error handling, and verdict collection remain the production logic.

Each step is `{ program, args, occurrence, elapsedMs, cwd? }`. `program` is `git`, `gh`,
or `ssh`; `args` is a contiguous subsequence of the actual argv (so it also matches
git's `--no-optional-locks` prefix). `args` is a nonempty array of strings;
`occurrence` is a positive safe integer; `elapsedMs` is a nonnegative safe integer.
An optional absolute `cwd` further restricts matching to that real working directory
(resolve symlinks on both sides). Occurrences are counted independently per step
and per hook process, starting at one. A step applies once, after that real read
finishes, including failed reads. Advance wall time by
`min(elapsedMs, logicalTimeoutMs)` where logicalTimeoutMs is the timeout the
production budget arithmetic requested. When elapsedMs >= logicalTimeoutMs,
return a native-style timeout result through the read's existing error path
(`error.code` is `ETIMEDOUT`, and `error.message` includes `ETIMEDOUT`). Otherwise keep
the real result. Async ls-remote participates too. No matching step means zero
virtual elapsed time. Production gh elapsed-call accounting includes only gh and
ls-remote charges; local git and ssh charges still spend phase/process budgets.

Ordinary real subprocesses use a 120000 ms emergency watchdog when the seam is
active, independent of logicalTimeoutMs. This prevents process-start latency from
spending a virtual budget. The tests' harness watchdog is also 120000 ms; this is
test infrastructure, not a hook default or a timing assertion.

`ready` entries are `{ program, args, readyFile, timeoutMs }`, with the same program
and args validation, an absolute readyFile path, and a positive safe integer
timeoutMs. They match the first read with that program and args once per process.
Tests never configure overlapping steps and readiness entries. Start the real child immediately, but arm its real
timeout only after readyFile exists. The fixture writes the file after the hung
child (and any descendants whose death is asserted) has started. Startup is covered
only by the emergency watchdog. Once ready, invoke the **existing termination and
timeout-result path** after timeoutMs real milliseconds; the seam must not supply a
replacement successful kill or verdict. For synchronous reads an implementation
may use a worker to bridge readiness, preserving the hook's synchronous interface.
Destroy inherited pipes and kill process groups where the production path does so.
When that timeout fires, advance virtual wall time by the read's logical timeout
and account for it in ghElapsed only for gh/ls-remote, just as for a timed-out step.
The fixture hangs for 60000 ms after readiness; tests require a timeout and no
natural completion. Direct git stalls and the ssh tree must be dead before cleanup;
the guard-tests inherited-pipe case retains its original return/verdict assertion
and cleans the pipe-holding descendant in finally. The seam must not add a new
production kill mechanism to satisfy a test.

Append JSON lines to trace with `hook` (`guard-git` or `guard-tests`) and `mode`
(argv[2] or an empty string) on every event:

- `limits`: `values` contains the **effective values used by the real arithmetic**.
  guard-git keys: decisionMs, ghBudgetMs, ghTimeoutMs, processMs, localWorkMs,
  oracleDiscoveryMs, oracleComparisonMs, sshConfigMs. guard-tests keys: gitBudgetMs,
  gitTimeoutMs, cpuBudgetMs, graceMs. Emit once before the first decision.
- `charge`: program, args (actual argv), occurrence, elapsedMs (requested charge),
  appliedMs, timeoutMs (logical timeout), timedOut (boolean), nowMs (after charging).
- `ready-timeout`: program, args, readyFile, timeoutMs, emitted only after readiness
  and the real timeout path fires.
- `cpu-exhausted`: checks (number of deciding checks), cpuUs, limitUs, when the
  virtual CPU comparison exhausts the budget.

Append rather than overwrite: configured entries can share one trace. Traces are
test observability only; without activation neither files nor extra output appear.

The helper probes support with a separate zero-charge configuration and an `echo`
event before a scenario starts. Missing support fails with `missing issue #84 budget
seam in <hook>`, so missing implementation does not start hung fixtures. A limits
event must therefore be emitted even for an event that needs no external reads.

## Test behavior and load independence

- Success-only calls in `guard-git-fixture`, `hooks` merge, `guard-git-oracle-gate`,
  `guard-git-command-forms`, and `guard-git-merge-flags` also supply zero-charge
  configurations and use emergency harness watchdogs. This includes logged-read
  regressions in `guard-git-consequence-gates-review` and `guard-git-read-forms`.
  They retain all functional assertions; only explicit budget scenarios require
  seam support up front. Existing hooks can still run these functional tests;
  the positive/default contract tests prevent silently shipping an absent seam.
- `guard-git-consequence-gates`: AC-3 / AC-2 (#84) charges the first branch read
  10000 ms at the protected-push gate, or the second one after creating an oracle
  tag. All three sessions must ask/deny with unread evidence; the earlier oracle
  verdict stays collected. The ordinary `git status` variant allows with stderr.
  Every required read runs before its charge, regardless of startup latency.
  The separate readiness test kills the real stalled branch read in each session.
- `guard-git-local-work-gaps`: all `decide` calls freeze uncharged time so local
  success paths cannot lose their 5000 ms phases to process startup. AC-2 scripts
  an ssh -G timeout instead of sleeping. Both AC-5 cases charge a local read 2400
  ms, more than the 2000 ms gh budget, then charge the policy/ls-remote read 400 ms;
  that later read must still receive its 1000 ms limit. AC-7 waits for all three
  ssh PIDs before starting the existing ls-remote group-kill timer, then checks
  all three are dead and that the 60000 ms fixture never completed.
- `guard-git-local-work-review`: all decisions freeze uncharged time. R1 F1
  charges two PR views 600 ms each and each merge's worktree list 5000 ms, proving
  two local phase timeouts still ask with oracle reads and below logical 27000 ms.
  R1 F10 gives a required branch read 12000 ms with a larger 20000 ms decision
  budget, proving the process cap wins. R2 F2, R3 F4/F5, R4 F8 (both remotes),
  R5 F3, R6 F-A, and R7 F-F keep their original local-work/oracle assertions.
- `guard-tests-consequence-gate`: AC-3/H6/H12 exhausts at a deciding CPU check
  (1000 us) or the first rev-parse read (1 ms), retaining gate/control behavior
  for all three sessions. AC-14's wildcard case and AC-18's 1/300-tag cases use
  frozen clocks and retain verdict and constant-read assertions. AC-17's stalls
  start timing only after the direct child or pipe-holding descendant is ready;
  the direct SIGTERM-ignoring child must die, and both forms must return a verdict
  without natural completion. The exact-lookup/scan case charges 10000 us per
  deciding check, so exact lookup finishes but scans exhaust at check 100,
  exactly 1000000 us, independent of CPU speed.
- `guard-tests-consequence-gate-review`: R1-F2's CPU-exhaustion rule charges
  1000 us per deciding check against 1 ms, keeping unread ask/deny and fail-open
  controls in all sessions.
- `guard-tests-review-2`: G2 uses frozen clocks for all three 5000-candidate forms,
  retaining deny, quiet stderr, inline-name, and single-inventory-read checks.
- `guard-tests-review`: F1 scripts a 5000 ms timeout only in the `stall` working
  directory, after the first frozen verdict, and retains that ask/deny plus the
  visible ETIMEDOUT message. The working-directory match prevents a charge from
  accidentally spending the earlier read's budget.
- `hooks`: the user and PR/policy timeout cases script gh charges against the
  300 ms per-call limit. The shared-budget case spends 1500 ms on PR view and
  requests 1500 ms on user; the latter must time out at the remaining 1000 ms
  of a 2500 ms budget, despite a 4000 ms per-call limit. All reads are real,
  immediate fake-gh responses; process startup spends no logical time.
- `guard-git-oracle-gate`: AC-4 (#57) scripts a 60000 ms ls-remote charge against
  a 1000 ms limit, preserving the oracle unread ask and absence of explicit allow.
  Actual async group termination is covered by AC-7 above.
- `hook-budget.test`: AC-3 (#84) pins all effective default limits (and the
  guard-tests 10000 ms cap) through limits events, without elapsed-time checks.
  AC-4 (#84) pairs rejected activation cases with positive exhaustion controls;
  copied ~/.claude/hooks cannot accept a checkout's configuration.

Class B cases kept unchanged, per test:

- `guard-git-entries` AC-1 (#27), gh hangs past the merge entry: only requires
  the configured runner timeout/onFailure verdict, not a child-start marker.
- `guard-git-entries` AC-1 and AC-2 (#31), hook cannot start or runs past timeout:
  stub entry timeouts test fail-open/fail-closed configuration without a hook budget.
- `guard-git-oracle-tags` AC-5 (#55), PR lookup times out: a single gh read must
  produce the existing unread-state warning; no delayed-child marker is required.
- `guard-subagents` AC-6 (#29), cannot start/crash/timeout: stub entry timeout
  has a 60000 ms hang and no required startup marker.

No artificial load is started. The five loaded runs required by AC-1 (#84) belong
to the orchestrator after the hook implementation exists.
