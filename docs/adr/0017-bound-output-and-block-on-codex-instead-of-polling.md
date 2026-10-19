---
status: accepted
date: 2026-10-08
---
# 0017. Bound tool output, block on Codex instead of polling, and derive the Codex registrations from one file

- Supersedes in part: [0014](0014-run-codex-through-two-role-named-registrations.md) (the version range and the job-status permission)
- Amends: [0015](0015-pass-delegates-goals-structured-findings-and-the-rules-they-lack.md) (where the package's rules live)

## Context

The measurements are in the [orchestrator context probes](../experiments/2026-10-08-orchestrator-context-probes.md). They cover 18 per-issue desktop sessions since 2026-10-06, 280M context tokens read in all.

- Where the context goes: the fixed base of each request is about 36% of what is read, tool results 17%, and outputs carried forward (thinking included) about 30%. Every request re-reads everything before it, so one large result is paid again on every later request.
- Polling: Codex delegations were mostly started in the background, then `codex_job_status` was called 63 times. Each call is a full request over the whole context.
- What the client offers:
  - Claude Code notifies the model only about work it runs itself: subagents, background shell commands and `Monitor`.
  - In an interactive terminal session it also moves an MCP call that outlives `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` to the background and notifies on completion. A probe showed two parallel calls overlapping that way.
  - The desktop app does not: 15 blocking delegations of 110 to 590 s came back inline. `claude -p` does not either.
  - Two blocking calls to the same non-read-only MCP tool in one message run one after the other.
  - MCP Tasks has client code in Claude Code 2.1.291 behind a remote flag that is off. It is neither in the changelog nor in the documentation.
- Bash output: above `bashOutputMaxChars` (default 30,000 characters), a result arrives as a file path plus a 2,000-character preview. A probe confirmed the setting can be lowered. A bound of 12,000 would have kept about 2% of the context read out of those sessions, and 8,000 about 4%.
- The Codex registrations:
  - They run `npx -y codex-subagent-mcp@^0.5.0`. Measured startup: 1.3 s with the range, 1.0 s with an exact version and 0.23 s for a direct install. A range also takes a new patch silently.
  - Their names are written by hand in `global/mcp-servers.json`, in the allow list and in the guard-codex matcher.
- `task-package`: its Codex mapping and worktree rules are 41% of a 9.7 KB skill. A skill stays in the context once invoked, so a Claude delegation also carries rules it does not use.

## Decision

1. `global/settings.json` sets `bashOutputMaxChars` to 12000. The MCP and Read caps keep their defaults, because a Codex report of 5 to 11 thousand tokens must stay inline.
2. Codex registrations run an exact version, today `codex-subagent-mcp@0.5.0`. A new version, patch included, is a pull request read against the changelog.
3. A delegation to Codex is blocking unless the human asks for parallel or background work. Job status is never polled in a loop, and `codex_job_status` is no longer allowed, so each call asks. The other no-quota tools stay allowed.
4. The installer derives, from every `codex-subagent-mcp` registration in `global/mcp-servers.json`, the allowed no-quota tools and the guard-codex matcher. A registration is added in that one file.
5. `task-package` keeps the fields, the record rules and the report shape in `SKILL.md`. The Codex mapping and the worktree rules move to `codex.md` and `worktree.md`, read only when a delegation needs them. A script, `node ~/.claude/hooks/task-package.mjs`, prints the fields the orchestrator would otherwise copy by hand: the Invariants and Conventions sections and the `Verify:` line of the repository's `CLAUDE.md`, the oracle, the base commit and the report schema.
6. The global `CLAUDE.md` tells the orchestrator to wait instead of polling and to read by range. Its Delegation section keeps authority and routing; the Codex worktree steps live in `task-package`.

## Alternatives considered

- A Claude subagent that relays to Codex through its own inline server. It would get notifications in the desktop app, and a probe showed it works. Rejected for three reasons:
  - The per-hour delegation bound of `codex-subagent-mcp` counts per server process, so each relay would start a new count.
  - The relay is one more model hop that can summarise, retry or hide an error.
  - The orchestrator no longer sees the call it pays for.
- One server exposing role-named tools. Rejected: it loses the per-process sandbox ceiling and the per-registration bound of ADR 0014.
- `alwaysLoad` on the Codex servers. Rejected: every session would carry their full tool schemas, including sessions that never delegate.
- Per-stack `.mcp.json` templates or main-thread agent profiles shipped by this repository. Rejected:
  - Every user of the workflow would get one person's tools.
  - The servers left in the user scope cost under 1% of the base context.
  - A server that fails to connect adds no tools.
- A tool that runs a command and returns only what matters. Rejected:
  - A deterministic filter is what the model already writes into the command.
  - A filter run by a model is a lossy hop that can hide the error being looked for.
  - The output bound already keeps large results out of the context.
- Lower MCP and Read caps now. Rejected for the reason in decision 1; they can follow a measurement.
- A global install of the Codex server for the faster start. Rejected: the installer would gain a global `npm` side effect for 0.8 s, and the server's start does not block the first prompt.

## Consequences

- In the desktop app a Codex delegation holds the turn until it ends; messages can still be queued. Parallel Codex work is an explicit request, and it costs status calls that each ask for permission.
- In auto mode the classifier, not a prompt, decides a `codex_job_status` call, so the deterrent is weaker there.
- An output over 12,000 characters needs a `Read` or `grep` of its file when the model wants more than the preview. A failing command still gets its head-and-tail excerpt inline.
- `bashOutputMaxChars` needs Claude Code 2.1.261 or later.
- Updating Codex, even by a patch, is now a pull request.
- If the desktop app starts moving long MCP calls to the background, or MCP Tasks is supported, decision 3 should be revisited.
