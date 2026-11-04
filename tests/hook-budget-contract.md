# Issue #84 hook test contract

These tests run the real hooks. A separate change implements this seam. No hook
source is replaced or evaluated by the tests.

Activation requires **all** of the following:

- `CW_HOOK_BUDGET_TEST` is exactly `issue-84:explicit-test-only`.
- `CW_HOOK_BUDGET_CONFIG` is an absolute path to a readable JSON file with
  `version: 1`, `root`, `trace`, `steps`, and `cpuStepUs`.
- The real path of the running hook is exactly
  `<realpath(config.root)>/global/hooks/<hook basename>`, and
  `<root>/tests/hook-budget.mjs` exists. Resolve symlinks before comparing.
- `root` and `trace` are absolute paths, `steps` is an array, and
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

Each step is `{ program, args, occurrence, elapsedMs, cwd?, realTimeoutMs? }`.
`program` is `git`, `gh`, or `ssh`; `args` is a contiguous subsequence of the actual
argv (so it also matches git's `--no-optional-locks` prefix). `args` is a nonempty array of strings;
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
spending a virtual budget. Configured budget harnesses also use 120000 ms; this is
test infrastructure, not a hook default or a timing assertion.
Seam-driven tests add no node:test timeout, including on parents that run several
sessions; the child watchdogs are their only emergency real-time limits.

An optional `realTimeoutMs` selects a native timeout test instead of a scripted
charge. It must be a positive safe integer and requires `elapsedMs: 0`; reject
configurations that combine a nonzero elapsedMs with this field. For that matched
read only, pass `max(logicalTimeoutMs, realTimeoutMs)` as the existing spawnSync
`timeout` option, or as the delay of the existing ls-remote `setTimeout`. Start the
native timer at its normal point; there is no marker polling, timer reset, worker,
extra signalling, replacement process runner, or alternate termination path.
Unmatched reads still use the emergency watchdog above. A successful native-mode
read costs zero virtual time. If the actual spawnSync result has ETIMEDOUT, or the
existing ls-remote timeout callback fires, preserve that result and charge exactly
logicalTimeoutMs, ignoring elapsedMs. Count that charge in ghElapsed only for gh
and ls-remote. The raised real timeout never changes a logical limit or deadline.
For any matched step, an actual native timeout takes precedence over scripted
charges; report the real error through the existing error path, without
manufacturing a successful kill.

The four main-session native cases use finite 60000 ms hangs and large startup
margins: 15000 ms for guard-git's required read, 20000 ms for its ls-remote SSH
tree, and 15000 ms each for guard-tests' direct stall and exited-parent/inherited-
pipe case. Existing investigation measured approximately 60-130 ms for a fake-git
startup/read; 15 seconds is over 100 times 130 ms. The longer SSH allowance covers
three nested Node startups, targeting at least a 50-fold quiet-machine margin.
These are deliberately large-margin physical-time exceptions, not deterministic
budget assertions. They require PID markers, no natural completion, a native
rather than synthetic timeout, and a load-safe elapsed-time lower bound showing
the timer really elapsed. Direct git stalls and the SSH tree must be dead before
cleanup. The inherited-pipe case retains its original return/verdict assertion
and cleans its pipe-holding descendant in finally; it does not claim spawnSync
kills an orphaned descendant. The seam must not introduce a new kill mechanism.

Only the main session runs each physical case. Other sessions use scripted
charges, retaining ask/deny semantics without sleeping or starting hung fixtures.
The four native waits total 65000 ms of aggregate test execution, versus 1000 ms
for the previous ten short timers: approximately 64 seconds added in aggregate.
They occupy three independently runnable test files; guard-tests contains two
serial 15-second cases, so the longest added per-file wait is about 29.4 seconds.
Actual end-to-end suite overhead depends on scheduling and must be measured after
implementation; a missing-seam run fails its support probe before any hang starts.

Append JSON lines to trace with `hook` (`guard-git` or `guard-tests`) and `mode`
(argv[2] or an empty string) on every event:

- `limits`: `values` contains the **effective values used by the real arithmetic**.
  guard-git keys: decisionMs, ghBudgetMs, ghTimeoutMs, processMs, localWorkMs,
  oracleDiscoveryMs, oracleComparisonMs, sshConfigMs. guard-tests keys: gitBudgetMs,
  gitTimeoutMs, cpuBudgetMs, graceMs. Emit once before the first decision.
- `charge`: program, args (actual argv), occurrence, elapsedMs (requested charge),
  appliedMs, timeoutMs (logical timeout), realTimeoutMs (effective physical timeout
  passed to spawnSync/setTimeout), timedOut (boolean), nativeTimeout (boolean),
  nowMs (after charging). nativeTimeout is true only for an actual native timeout
  result/callback, never for synthesized ETIMEDOUT. For native-mode timeout steps,
  elapsedMs is 0, appliedMs equals timeoutMs, and both timeout flags are true.
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
  One main-session native test kills the real stalled branch read after its
  15000 ms native timer; the three logical gate tests cover every session.
- `guard-git-local-work-gaps`: all `decide` calls freeze uncharged time so local
  success paths cannot lose their 5000 ms phases to process startup. AC-2 scripts
  an ssh -G timeout instead of sleeping. Both AC-5 cases charge a local read 2400
  ms, more than the 2000 ms gh budget, then charge the policy/ls-remote read 400 ms;
  that later read must still receive its 1000 ms limit. AC-7 gives ls-remote's
  existing group-kill timer 20000 ms to let the SSH tree start, then checks all
  three PIDs are dead and that the 60000 ms fixture never completed. Its 1500 ms
  logical limit is still charged, without spending 20000 ms of virtual time.
- `guard-git-local-work-review`: all decisions freeze uncharged time. R1 F1
  charges two PR views 600 ms each and each merge's worktree list 5000 ms, proving
  two local phase timeouts still ask with oracle reads and below logical 27000 ms.
  R1 F10 gives a required branch read 12000 ms with a larger 20000 ms decision
  budget, proving the process cap wins. R2 F2, R3 F4/F5, R4 F8 (both remotes),
  R5 F3, R6 F-A, and R7 F-F keep their original local-work/oracle assertions.
- `guard-tests-consequence-gate`: AC-3/H6/H12 exhausts at a deciding CPU check
  (1000 us) or the first rev-parse read (1 ms), retaining gate/control behavior
  for all three sessions. AC-14's wildcard case and AC-18's 1/300-tag cases use
  frozen clocks and retain verdict and constant-read assertions. AC-17 uses a
  15000 ms native timeout only in the main session for each fixture mode; it
  charges the original 5000 ms logical read limit when that timer fires. The
  direct SIGTERM-ignoring child must die, and both forms must return a verdict
  without natural completion. Subagent and bypass variants synthesize 5000 ms
  inventory-read timeouts from ordinary immediate reads, with no hanging child.
  The exact-lookup/scan case charges 10 us per deciding check, including the
  20000-entry inventory construction. Exact lookup must finish quietly within
  250 ms of virtual CPU (25000 checks), one quarter of the scan's 1000 ms budget.
  Six distinct nonmatching globs force repeated inventory scans and exhaustion at check
  100000, exactly 1000000 us, followed by an unread deny naming the oracle.
  Each subtest has its own trace. Six globs bound recovery work too: the former
  2000-glob command forced millions of grace-path matches while virtual wall
  time stayed frozen. There is no parent-level 60 s deadline; the child runner's
  120 s watchdog remains solely emergency infrastructure. No timing assertion
  decides the H12 result.
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
- `guard-git-oracle-tags`: AC-5 (#55) scripts a 3000 ms gh PR-list charge against
  a 300 ms limit after an immediate fake-gh response. It retains the unread-state
  warning and ask, and verifies the timeout is synthetic, with no physical wait.
- `hook-budget.test`: AC-3 (#84) pins all effective default limits (and the
  guard-tests 10000 ms cap) through limits events, without elapsed-time checks.
  AC-4 (#84) pairs rejected activation cases with positive exhaustion controls.
  The guard-git positive control charges its branch read, while guard-tests uses
  only an 8000000 us CPU check with no read charges, leaving recovery reads intact.
  Copied ~/.claude/hooks cannot accept a checkout's configuration.
  Rejection cases invalidate one field at a time, including the steps array,
  occurrence, elapsed time, argument contents, empty arguments, program and cwd.

Class B entry-timeout policy cases kept unchanged, per test:

- `guard-git-entries` AC-1 (#27), gh hangs past the merge entry: only requires
  the configured runner timeout/onFailure verdict, not a child-start marker.
- `guard-git-entries` AC-1 and AC-2 (#31), hook cannot start or runs past timeout:
  stub entry timeouts test fail-open/fail-closed configuration without a hook budget.
- `guard-subagents` AC-6 (#29), cannot start/crash/timeout: stub entry timeout
  has a 60000 ms hang and no required startup marker.

No artificial load is started. The five loaded runs required by AC-1 (#84) belong
to the orchestrator after the hook implementation exists.
