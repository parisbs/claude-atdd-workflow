---
status: proposed
date: 2026-10-21
---
# 0026. Return a compact envelope and keep the full delegation report in the scratchpad

- Would amend: [0015](0015-pass-delegates-goals-structured-findings-and-the-rules-they-lack.md) (the report shape)

## Context

ADR 0015 gave Claude and Codex delegates one report shape, returned inline: status, failure type, what changed, checks run and not run, findings with source and verified flag, and what was left out or unsure. ADR 0017 measured that every request re-reads everything before it, so a large tool result is paid again on every later request of the orchestrator.

The evidence was gathered on 2026-10-21 against `main` at `f676e03`, Claude Code 2.1.306 and codex-subagent-mcp 0.5.0, with a script over every local transcript since 2026-10-08; N-02 of the audit plan turns that script into a repository script. The working notes are the routing annex of the 2026-10-21 audit, a local file kept outside the repository. Each item says whether it was verified.

- Packages the orchestrator writes: median 7,073 characters, 90th percentile 12,792, maximum 22,250, about 929,000 in 119 delegations. They are output tokens of the orchestrator. Verified.
- Claude subagent reports: median 6,608 characters (about 1,700 tokens), 90th percentile 18,291, maximum 35,684, over 76 reports. Verified.
- Codex results: in 51 results since 2026-10-15, 580,000 characters in all, the command log is 49% and the structured block 38%. Measured from the `Commands run (N total):` section and the `BEGIN/END STRUCTURED RESULT` markers. Verified.
- There is no output schema for Claude subagents: `--json-schema` exists only for `claude -p`, and `outputFormat` only for the Agent SDK. Source: `sub-agents.md`, `cli-reference.md` and `agent-sdk/structured-outputs.md` on `code.claude.com/docs`. Verified as an absence from those pages.
- The full transcript of each subagent is already on disk at `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`, deleted after `cleanupPeriodDays` (30 by default). Source: `sub-agents.md`. Verified in the documentation.
- `codex_delegate` in 0.5.0 has no option to write its report to a file. Source: the tool schema. Verified.
- `claude-researcher` has no `Write` tool, and `guard-readonly` denies shell writes. Source: `global/agents/claude-researcher.md`. Verified.
- parisbs/codex-subagent-mcp#166, "Keep the command log out of the result by default", moves the command log to a file with mode 0600 outside the working tree and keeps the structured block inline. On 2026-10-21 it was assigned to the 0.7.0 milestone, with a comment carrying the 49% and 38% measurement and its dependency on #138. Source: `gh issue view 166` and the milestones API. Verified.
- Whether a SubagentStop hook can block a subagent that returns a malformed envelope is not verified.

## Decision

1. A delegate returns a short envelope inline and writes its full report to a file. The envelope holds:
   - status (done, partial or failed) and failure type;
   - the verdict in at most three sentences;
   - the number of findings by severity;
   - the path of the full report.
2. The full report goes to `<scratchpad>/delegations/<id>/report.md` and `report.json`, where `<scratchpad>` is the orchestrator session's scratchpad directory and `<id>` names one delegation. The orchestrator reads it by range when it needs more than the envelope.
3. The report schema of ADR 0015 is trimmed:
   - `checks_run` holds, per check, the command, the result (pass, fail or blocked) and one line;
   - the implementer's `what_changed` is reduced to paths, because the orchestrator reads the diff anyway;
   - sources and what was left out appear only in the file, not in the envelope.
4. Read-only Claude agents get `Write`, limited by a guard to `<scratchpad>/delegations/`. Every other write stays denied, so the agent still cannot change the repository.
5. For Codex, the command log leaves the result through parisbs/codex-subagent-mcp#166 once a release carrying it is adopted, through a pull request like any version change (ADR 0017), and the envelope is requested through `output_schema`. Where the full Codex report is kept depends on what that release offers; the implementation records it.
6. The envelope is validated by a hook when the client allows it; otherwise the orchestrator checks it and treats a malformed envelope as a failed delegation.

## Alternatives considered

- The full report inline, as today. Rejected: a median Claude report of about 1,700 tokens, and up to 35,684 characters, is re-read on every later turn of the orchestrator, and almost half of a Codex result is a command log it seldom needs.
- Reading the subagent's JSONL transcript instead of a report file. Rejected: it holds every tool call and result rather than a conclusion, its format belongs to Claude Code and may change, it is deleted after `cleanupPeriodDays`, and Codex results do not pass through it.
- Lowering the MCP output cap. Rejected: a cap cuts the result where it falls, so it can drop the structured block that the orchestrator needs, while the command log that makes results large stays in front of it; moving the log out (#166) removes the bulk without losing the block. ADR 0017 kept the cap at its default for a related reason: a Codex report must stay whole inline.

## Consequences

- If accepted, ADR 0015 changes only in its front matter status, as amended in part. ADR 0017 is unchanged: its MCP cap keeps the default.
- The orchestrator's context carries envelopes, and the full reports stay on disk for the session. They are lost with the scratchpad; a report worth keeping is copied into an issue or a pull request.
- `claude-researcher` and any other read-only agent gain a narrow write path. The guard that limits it becomes part of the read-only boundary and must fail closed like `guard-readonly`.
- The scratchpad path must reach the delegate in its package, since a subagent does not share the orchestrator's prompt. Codex runs in its own sandbox and may not be able to write there; decision 5 covers it through the server.
- The envelope only pays off if the orchestrator reads the file by range instead of whole; that is guidance, not a check.
- Adopting #166 waits for the codex-subagent-mcp release that carries it; until then Codex results keep their command log inline.
