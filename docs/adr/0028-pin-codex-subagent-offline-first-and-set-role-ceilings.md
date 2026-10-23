---
status: proposed
date: 2026-10-23
---
# 0028. Pin Codex subagent offline-first and set role ceilings

- Supersedes in part: [0014](0014-run-codex-through-two-role-named-registrations.md) (the effort ceiling of the implementer)

## Context

ADR 0017 requires an exact version. With npm 11.9.0 that pin still revalidates
the package document on every start; `--prefer-offline` starts a cached version
without a request. The [probe record](../experiments/2026-10-23-codex-subagent-mcp-060-npx-probes.md)
contains the supplied measurements and their limits. The 2026-10-21 source
audit found no breaking change from 0.5.0 in 0.6.0 (gitHead `577a36d`, tag
`v0.6.0`) and verified its ceilings and local-only `codex_usage` tool.
On 2026-10-23 the human selected the models and limits after reading the
current `list_codex_models` catalog.

## Decision

1. Both registrations run `npx --prefer-offline -y codex-subagent-mcp@0.6.0`.
   After successful additions or replacements the installer prewarms once per
   distinct npx Codex package with `--prefer-online`, closed standard input
   and a 60-second timeout. Prewarm failure is reported but never changes the
   install status; unchanged registrations and `--check` never prewarm.
2. Both default to `gpt-6.1-sol` at `high` and allow only `gpt-6.1-sol` and
   `gpt-6-astra`, the models of ADR 0025, with Astra reserved for escalation.
   The reviewer caps effort at `high`, sandbox at `read-only` and delegations
   per hour at `10`; the implementer uses `xhigh`, `workspace-write` and `6`.
   Both cap background jobs at `2` and disable inherited MCP servers, plugins
   and apps. Defaults and ceilings are explicit, except the default sandbox
   stays unset so every write is an explicit argument.
3. Allow `codex_usage` through the derived no-quota permissions; delegation,
   follow-up and job status still prompt. Keep the optional `CODEX_BIN` and
   `CODEX_SUBAGENT_USAGE_LOG` values personal; an empty `CODEX_BIN` is used as
   is and must not be shipped. The usage log is off unless
   `CODEX_SUBAGENT_USAGE_LOG=on` is set in the personal overlay; the shipped
   registrations do not set it. Both registrations share the log. It lives
   in `XDG_STATE_HOME/codex-subagent-mcp` only when `XDG_STATE_HOME` is an
   absolute path. Otherwise it uses
   `~/Library/Application Support/codex-subagent-mcp` on macOS,
   `~/.local/state/codex-subagent-mcp` on other POSIX systems, or
   `LOCALAPPDATA/codex-subagent-mcp` on Windows.
   The [README](../../README.md#layout)
   documents each environment variable's effect and invalid-value handling.

## Alternatives considered

The 2026-10-21 audit measured a range at 1.61 s, 0.5.0 exact at 1.44 s and
0.5.0 with `--prefer-offline` at 0.88 s. These figures come from a separate
run whose method is not recorded in the repository, so they are not directly
comparable with the 2026-10-23 0.6.0 timings. The request counts (GETs,
advisories POST and cache hit) are the comparable part.

- A version range: two GETs and an advisories POST per start, and a version
  that can change without a pull request.
- An exact version without `--prefer-offline`: one revalidation GET per warm
  start, measured at 0.67 s for 0.6.0.
- A global npm install with a direct command: the
  [2026-10-08 probe](../experiments/2026-10-08-orchestrator-context-probes.md)
  measured `node` on the installed `codex-subagent-mcp` 0.5.0 package at
  0.23 s up to the `initialize` response. This is not directly comparable
  with the 0.6.0 timings measured to process exit after standard input closed.
  It also requires a manual install step outside the installer and a version
  that can drift from the repository.

## Consequences

- This raises the implementer's effort ceiling from the `high` of accepted
  ADR 0014 and the temporary `high` of accepted ADR 0025, enabling the latter's
  complex-implementer `xhigh` route. Those immutable records and the routing
  matrix stay as written, including their stale ceiling references.
- Accepted [ADR 0027](0027-keep-installer-backups-in-the-xdg-state-directory-as-json-bundles.md)
  says 0.6.0 keeps its usage log under `XDG_STATE_HOME`; this holds only when
  that variable is an absolute path. Its stale statement stays as written;
  the platform fallbacks are recorded above.
- Delegation bounds count failed and cancelled runs in a rolling hour per
  process and reset on restart; they are tuning limits, not durable quotas.
  Recalibrating the 10/6 delegation and 2-job ceilings using `codex_usage`
  requires enabling the usage log with `CODEX_SUBAGENT_USAGE_LOG=on` in the
  personal overlay.
- The prewarm refreshes the package document once at installation. A cache
  whose document predates the pinned version might not refresh with
  `--prefer-offline`; that scenario remains unverified. A failed prewarm
  leaves the install usable but may leave a later start needing the network.
- Machine paths and local logging remain optional. An invalid environment
  value leaves the server running: `codex_doctor` lists the errors, and every
  tool that reaches the Codex CLI except `codex_doctor` refuses calls until
  the environment is fixed and the server restarts. This includes
  `list_codex_models` and `codex_recommend`, which the installer allows
  without a prompt.
