# Orchestrator context probes, 2026-10-08

The measurements behind issue 57 and ADR 0017. They answer three questions:

- Where an orchestrator session's context goes.
- What polling a Codex delegation costs.
- What Claude Code offers to avoid it.

Each section states what was run and what was observed. Headless probes ran once per variant, so they show that a behaviour exists, not how often.

Environment: Claude Code 2.1.291 on macOS (the latest published was 2.1.295), desktop app and headless `claude -p`. Opus 5.5 in the desktop sessions; Haiku 4.5 and Sonnet 5.5 in the headless probes. `codex-subagent-mcp` 0.5.0.

## 1. Where the context goes

Method: a script over the session transcripts in `~/.claude/projects/*/*.jsonl` reads the `usage` of each assistant message, counted once per message id. The context of a request is input plus cache creation plus cache read. A tool result or a message is charged once for every request after it, which is how a cached prefix is re-read. Scope: the 18 desktop sessions started on or after 2026-10-06 with five requests or more.

- Total context read: 280M tokens over 1,406 requests.
- The fixed base: the first request's context times the number of requests, 101M (36%). The first request of a desktop session was 69,000 to 75,000 tokens. The same configuration through `claude -p` was about 35,000: the rest is what the desktop app adds.
- Tool results carried forward: 48M (17%). The largest single results:
  - a Codex follow-up of 11,338 tokens, re-read 99 times;
  - a documentation page fetched twice at about 10,000 tokens;
  - a whole transcript read with `Read`;
  - a `cat` of several whole files.
- Outputs carried forward: 84M (30%). This is output tokens times the requests after them, thinking included. Transcripts keep thinking empty, so only the total is known.
- The rest (user messages, reminders, invoked skills): 17%.

Before the switch to one session per issue, the two longest sessions made 974 and 1,200 requests. Their context averaged 420,000 and 360,000 tokens per request, and each read over 400M tokens. The per-issue sessions made 13 to 180 requests, averaged 90,000 to 310,000 tokens, and read 1M to 54M each.

## 2. Polling Codex

Same transcripts, every session since 2026-09-29:

- 27 of 33 `codex_delegate` calls whose mode was recorded ran in the background.
- `codex_job_status` was called 63 times. Each call is a full request over the whole context.
- About 25 `ToolSearch` calls loaded Codex tools, often several per session.
- 68 Bash commands contained `sleep`. About 30 of them were a `sleep` of 8 to 25 s before `gh pr checks`.

## 3. Moving a long MCP call to the background

A local stdio server exposed one tool without `readOnlyHint` that sleeps for a given number of seconds (`slow_job`). The prompt asked for two calls of 20 s in one message, plus an unrelated answer while they ran. `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=3000`.

- `claude -p`: the calls ran one after the other (A from 3.7 s to 23.7 s, B from 23.7 s to 43.7 s), and nothing moved to the background.
- An interactive terminal session, driven through a pseudo-terminal: A started at 3.9 s and moved to the background. B started at 6.9 s, so the two overlapped. Two "MCP task ... completed" notices arrived, and the model reported both results without polling.
- The desktop app: in the transcripts, 15 blocking delegations of 110 to 590 s came back as inline tool results. None moved to the background, although the default threshold is 120 s.
- MCP Tasks: the Claude Code binary carries a client "task path" for tools that declare `execution.taskSupport`, gated by a remote feature flag that was off in these probes, and neither the changelog of 2.1.295 nor the documentation mentions it.

## 4. A subagent that relays to Codex

A Sonnet subagent, passed through `--agents`, declared its own inline `codex-subagent-mcp` server with a read-only ceiling and `background: true`.

- The parent session had none of the relay server's tools.
- The parent launched the relay, answered another question while it ran, and received the completion notice. It reported Codex's output (model, effort, sandbox, thread id) without polling.
- The relay's two requests were about 13,000 tokens of context in all.
- Defined in a project's `.claude/agents/`, the inline server did not load in an untrusted folder. Through `--agents`, it did.
- With a tools allowlist naming only the relay server's tool, Claude Code refused to spawn the agent ("would be spawned with zero tools").
- Haiku answered the prompt itself instead of calling the tool, in two runs.

The relay was rejected (ADR 0017): the per-hour delegation bound of `codex-subagent-mcp` counts per server process (its ADR 23), so every relay would start a new count.

## 5. Output bounds and startup

- `bashOutputMaxChars` lowered to 8,000 through `--settings`: `seq 1 4000` (18,893 characters) arrived as a file path plus a 2,000-character preview.
- Over the per-issue sessions, the results above each threshold would have been re-read as these shares of the context read, an upper bound. The base here is 307M tokens, because this count includes sessions with fewer than five requests:

  | Threshold (characters) | Bash | Read | MCP |
  | --- | --- | --- | --- |
  | 8,000 | 4.3% | 0.9% | 1.7% |
  | 12,000 | 1.8% | 0.8% | 1.5% |
  | 16,000 | 1.1% | 0.7% | 1.4% |

- Startup of `codex-subagent-mcp` up to the `initialize` response:
  - `npx -y codex-subagent-mcp@^0.5.0`: 1.3 s.
  - `npx -y codex-subagent-mcp@0.5.0`: 1.0 s (4.9 s on the first, uncached run).
  - `node` on the installed package: 0.23 s.
- Each PreToolUse hook took 110 ms (`guard-git`) to 140 ms (`guard-tests`) per call.

## 6. Base context by MCP configuration

`claude -p "Reply OK"` with Haiku, from a directory without `CLAUDE.md`, first request:

| Configuration | Tokens |
| --- | --- |
| Default | about 35,200 to 36,500 |
| Without claude.ai connectors (`ENABLE_CLAUDEAI_MCP_SERVERS=false`, or `disableClaudeAiConnectors` in the project's settings) | 33,000 |
| Without any MCP server (`--strict-mcp-config`) | 31,900 |

The documentation says the connector settings do not reach the desktop app, which receives connectors another way.

A main-thread agent passed through `--agents` and `--agent`, with an empty prompt and one inline server, kept the default system prompt and added that server's tools.
