---
status: proposed
date: 2026-10-21
---
# 0025. Route model and effort per delegation through a matrix applied by a hook

- Would amend: [0011](0011-delegate-through-subagents-interchangeable-with-codex.md) (the fixed model and effort of each agent file)

## Context

The orchestrator delegates to Claude subagents and to Codex under subscription limits, not API billing: the Claude Pro five-hour and weekly windows, and Codex plan credits. The orchestrator and its Claude delegates run under the same subscription, so they are assumed to draw on the same windows (not verified against the plan's metering): a delegation run on a larger model or a higher effort than it needs is then paid out of the same budget as the work that does need it.

The evidence was gathered on 2026-10-21 against `main` at `f676e03`, Claude Code 2.1.306 and codex-subagent-mcp 0.5.0. Usage was counted with a script over every local transcript since 2026-10-08, when `task-package` reached its current form; the script lives in a session scratchpad today, and a planned follow-up turns it into a repository delegation report. The working notes are the routing annex of the 2026-10-21 audit, a local file kept outside the repository; the identifiers in parentheses (G-01 to G-08) are its findings. Each item below says whether it was verified.

What the client does (G-02, G-03; Claude Code documentation read through a summarising subagent, not tested live):

- Switching the model of a session does not widen its context window, but the next request reads the whole history with no cache hits; each model has its own cache. Source: `code.claude.com/docs/en/prompt-caching.md`. Verified in the documentation.
- Changing only the effort keeps the cache on Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1, with an API key or a Claude subscription. Source: the same page. Verified in the documentation.
- A skill without `context: fork` that declares another `model` runs the rest of that turn, with the whole conversation, on the other model, which is a model switch; the session returns to its model on the next prompt. Source: `skills.md` and `prompt-caching.md`. Verified in the documentation.
- A skill with `context: fork` is a new subagent that does not see the conversation history and returns a summary. Source: `skills.md`. Verified in the documentation.
- A subagent's model and effort can be passed per invocation and win over its frontmatter. The precedence is the per-invocation parameter, the frontmatter, `CLAUDE_CODE_SUBAGENT_MODEL`, then the main model. Per-invocation effort needs Claude Code 2.1.292 and does not apply to forks. Source: `sub-agents.md`. Verified in the documentation.
- `availableModels`, `maxEffortLevel` and an organization effort cap still limit a skill or subagent; no other escalation rule between a session and a skill or subagent was found, but that absence is not verified. Source: `model-config.md`.
- Whether a PreToolUse hook can rewrite the input (`updatedInput`) of an `Agent` call or of an MCP tool call such as `codex_delegate` in 2.1.306 is not verified.
- The Claude Code and API documentation disagree on the default effort of Sonnet 5.5 (medium against high). Not verified with `/effort`.

What the delegations did (G-01, G-03, G-06; local transcripts, verified):

- `claude-implementer` never received a model or effort per invocation: 0 of 14 delegations, so every one ran Opus high from its frontmatter.
- 15 Codex delegations set neither `model` nor `reasoning_effort` and ran the server default, `gpt-5.6-sol` high, of the previous generation. Of 75 `codex_delegate` calls, 60 set both.
- Astra was chosen in 20 of the 60 Codex delegations with an explicit model.

What Codex costs (G-06; local transcripts; the tokens are verified, the credits are not):

- Credits were computed from the per-million rates read on `learn.chatgpt.com/docs/pricing` on 2026-09-14: Astra 250 input, 25 cached and 1,250 output; Sol 100, 10 and 500. That `gpt-6.1-sol` uses the Sol rate is not verified.
- Median credits per delegation: `gpt-6.1-sol` medium 15.4 (6 delegations), `gpt-6.1-sol` high 21.1 (33, 90th percentile 39.5), `gpt-5.6-sol` high 17.7 (36), `gpt-6-astra` high 40.7 (24, 90th percentile 62.0). Astra costs about twice `gpt-6.1-sol` at high effort.
- At high effort the output is 22 to 26% of the cost; the rest is input re-read across turns, 540,000 to 740,000 tokens per delegation and almost all cached. A higher effort costs mostly through more turns.

What the models can do (G-07, G-08; secondary sources that reproduce vendor figures; that the pages say so is verified, the figures are not):

- Opus 5.5 reaches its ceiling at medium effort on FrontierCode (54.6% at medium, 54.4% at max), while CursorBench still rises above medium (52.5% at medium, 57.8% at its peak). Source: vellum.ai.
- Sonnet 5.5 depends strongly on effort: CursorBench 39.2% at medium, 47.8% high, 53.1% xhigh, 55.5% max. Source: computingforgeeks.com.
- Fable 5.1, priced at 10 and 50 dollars per million tokens, scores below Opus 5.5 on Terminal-Bench 4.0, FrontierCode and CursorBench. Source: vellum.ai.
- `gpt-6.1-sol` is priced at 2 and 10 dollars per million (0.10 cached), and OpenAI is reported to say it matches Astra on DeepSWE at a fifth of the cost; Astra, at 10 and 50, leads on Terminal-Bench. Sources: nerdschalk.com and nocode.mba, not OpenAI.
- A search, itself partial, found no public coding figures for Haiku 5.5 or `gpt-6-luna`, nor per-language figures for Kotlin, Dart or TypeScript.
- Cross-family review: in arXiv 2607.21656 (116 LiveCodeBench tasks, reviewer without test execution), Claude reviewing Codex code raised it from 71.6% to 89.7%, and Codex reviewing Claude code lowered it from 91.4% to 82.8%. Only the abstract was read; the models and efforts are not known.

ADR 0002 puts what must always hold in a hook, a permission rule or CI. Today the choice of model and effort is a judgement left to the orchestrator in each call, and the measurements show it is often not made.

## Decision

1. Agent files are defined by permission profile, not by model: what a delegate may read, write and run. A file keeps a `model` and `effort` in its frontmatter only as the fallback for a call the routing does not cover.
2. The model and effort of each delegation are chosen per invocation, on the `Agent` call for a Claude subagent and on `codex_delegate` for Codex, from a routing matrix with four criteria:
   - role: issue and ADR second opinion, oracle and tests, complex implementation, standard tasks and bugs, reviewer, quick fix, dependency audit;
   - difficulty: trivial, standard, hard;
   - risk: control plane, concurrency, security;
   - priority: quality, balance, cost.
3. The matrix defaults live in a file in `global/` and a user's overrides in `personal/`, merged by the installer. The names and the format are left to the implementation (a planned follow-up).
4. A PreToolUse hook on `Agent` and on `codex_delegate` applies the matrix to delegations. The matrix also lists the model and effort of the orchestrator session and of work done in it, which no hook applies: the user sets the session, and in-session skills follow decision 6. The hook fills a missing model or effort, or checks an explicit one against the matrix. If the client does not let the hook rewrite the input for those tools, the hook validates instead and asks, naming the values the matrix expects. Like other hooks it fails open with a visible message (ADR 0002).
5. Every routed call sets the effort explicitly; no route relies on a model's default effort, because the documentation does not agree on it for Sonnet 5.5.
6. Interactive skills that run in the orchestrator's conversation (issue drafting, ADR drafting, oracle approval) declare `effort` only, never `model`: an effort change keeps the cache, a model change re-reads the whole conversation without it. A skill with `context: fork` runs as a fresh subagent and may declare a model.
7. The five-hour and weekly windows of the Claude subscription and the Codex plan credits are a design constraint of the matrix: a route takes the cheaper model and effort that meets the role, difficulty and risk. The provisional matrix applies it by preferring Sonnet 5.5 at high effort to Opus 5.5 for standard work under the Claude Pro plan, because Opus is assumed to draw on the weekly limit about twice as fast per token; that ratio is not verified here.
8. Astra and Fable are escalation models only. No route chooses them for standard difficulty with no listed risk. They are chosen after a failed attempt, or where the matrix names them for a listed risk.
9. The provisional default matrix is the one below. It was not measured in this repository: it rests on the evidence above and is expected to change once the planned delegation report runs over real tasks.

Provisional default matrix, each role as Claude model and effort, then Codex model and effort:

- Orchestrator: Opus 5.5 medium, raised for oracle and review work because an effort change keeps the cache.
- Issues and ADRs: Opus 5.5 high in the session. Codex only as a second opinion, `gpt-6.1-sol` high, Astra for a listed risk.
- Oracle and tests: Opus 5.5 high, with the approval in the session. Codex `gpt-6.1-sol` high; Astra high with concurrency.
- Complex implementer: Opus 5.5 high, xhigh with concurrency or strict architecture. Codex `gpt-6.1-sol` high, xhigh when the effort ceiling allows it; Astra high to escalate after a failed attempt.
- Standard tasks and bugs: Sonnet 5.5 high while the plan is Pro; Opus 5.5 medium when the budget allows. Codex `gpt-6.1-sol` medium.
- Reviewer: fresh context, Opus 5.5 high. Codex `gpt-6.1-sol` high; Astra for the control plane or security.
- Quick fixes: Sonnet 5.5 low, delegated only when the build loop makes noise worth keeping out of the orchestrator. Codex `gpt-6.1-sol` low.
- Dependency audit: `claude-researcher` with Sonnet 5.5 medium, or a forked skill. Codex `gpt-6.1-sol` medium with `web_search`.

`CODEX_SUBAGENT_MAX_EFFORT` stays at `high` for now, so a Codex xhigh route cannot run at xhigh until that ceiling is raised. Whether `codex_delegate` then lowers such a request to high or refuses it is not verified.

## Alternatives considered

- A fixed model and effort per agent file, as today (ADR 0011). Rejected: a per-invocation `model` parameter already exists as an escape hatch (ADR 0011), but nothing makes the orchestrator use it, and it went unused in all 14 measured implementer delegations, which ran Opus high whatever their difficulty. Without a rule applied on every call, the choice does not follow the subscription windows.
- Model overrides in skills. Rejected: a non-forked skill that declares a model makes that turn a model switch, re-reading the whole conversation without cache, while an effort change keeps it. Forked skills keep that right because they start fresh.
- One agent file per model and effort pair. Rejected: the permission profile would be copied into every file and drift, the number of files grows with every model and effort, and the per-invocation parameter already does the same with one file per profile.

## Consequences

- If accepted, ADR 0011 changes only in its front matter status; the agent files stop carrying the routing and keep a fallback.
- The routing of delegations becomes one file a user can tune in `personal/` without touching agent files, and a hook makes the choice visible on every call instead of left to judgement.
- Every route sets effort explicitly; a forked delegation cannot take a per-invocation effort (G-02), so its effort comes from outside the call.
- Decision 4 depends on what the hook can do on `Agent` and MCP calls in the installed Claude Code; the implementation must verify it before it relies on rewriting the input.
- The matrix is a proposal until the delegation report measures it; its values are expected to change. What this record decides is the criteria, the mechanism, the effort-only rule for in-session skills and the escalation-only rule for Astra and Fable.
- The cross-family review evidence (G-08) rests on one abstract; who reviews whom is left to the reviewer work and to the `Review:` line of ADR 0011, not decided here.
- Benchmarks and credit rates age quickly. A new model or a new plan is a change to the matrix file, not to this record, unless it changes a decision above.
