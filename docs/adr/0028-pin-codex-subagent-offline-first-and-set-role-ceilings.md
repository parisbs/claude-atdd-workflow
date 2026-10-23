---
status: proposed
date: 2026-10-23
---
# 0028. Pin Codex subagent offline-first and set role ceilings

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
   is and must not be shipped. The usage log lives under `XDG_STATE_HOME` and
   is shared by both registrations. The [README](../../README.md#layout)
   documents each environment variable's effect and invalid-value handling.

## Alternatives considered

- A version range: two GETs and an advisories POST per start, 1.61 s in the
  audit, and a version that can change without a pull request.
- An exact version without `--prefer-offline`: one revalidation GET per warm
  start, measured at 0.67 s for 0.6.0.
- A global npm install with a direct command: fastest at about 0.23 s, but a
  manual install step outside the installer and a version that can drift from
  the repository.

## Consequences

- This raises the implementer's effort ceiling from the temporary `high` of
  accepted ADR 0025, enabling its complex-implementer `xhigh` route. That
  immutable record and the routing matrix stay as written.
- Delegation bounds count failed and cancelled runs in a rolling hour per
  process and reset on restart; they are tuning limits, not durable quotas.
  Recalibrate the 10/6 delegation and 2-job ceilings using `codex_usage`.
- The prewarm refreshes the package document once at installation. A cache
  whose document predates the pinned version might not refresh with
  `--prefer-offline`; that scenario remains unverified. A failed prewarm
  leaves the install usable but may leave a later start needing the network.
- Machine paths and local logging remain optional. An invalid environment
  value leaves the server running for `codex_doctor`, while tools that spend
  quota refuse calls until restart with a corrected configuration.
