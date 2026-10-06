# Delegation probes, 2026-10-06

Practical checks behind ADR 0014 and ADR 0015. Each one states what was run, on which versions, and what was observed. A single run per variant: it shows that a behaviour exists, not how often. Environment: Claude Code 2.1.291 on macOS, Codex CLI 0.160.1, `codex-subagent-mcp` 0.5.0, model `gpt-5.6-sol`, Sonnet 5.5 for the Claude subagents.

## 1. What a Claude subagent loads

Method: a subagent was asked, before any tool call, whether its context held the user instruction file, the personal rules and the repository instruction file. Run on the installed `claude-researcher` and on the built-in `Explore`, in the desktop session.

- `claude-researcher`: all three present; no memory index; no git status. It also listed every skill and every MCP server of the session.
- `Explore`: none of the three; the list of skills present.

## 2. `omitClaudeMd` and the tool list, with the first-request cost

Method: headless, so that no installed file changes. `claude -p` with `--agents` defining three probe agents (Sonnet 5.5) that differ only in `omitClaudeMd` and `tools`, run from this repository, with Haiku as the parent. The agent was asked the same three questions. The cost is the sum of input, cache-creation and cache-read tokens of the first request in the subagent's transcript (`~/.claude/projects/<project>/<session>/subagents/agent-*.jsonl`, field `message.usage`).

| Variant | Saw the three files | First request, tokens |
| --- | --- | --- |
| default loading, all tools | yes, yes, yes | 34,065 |
| `omitClaudeMd: true`, all tools | no, no, no | 28,402 |
| `omitClaudeMd: true`, `tools` of six (`Read`, `Grep`, `Glob`, `Bash`, `WebFetch`, `WebSearch`) | no, no, no | 3,973 |

Same method in the desktop session, prompt "reply OK", all with Sonnet 5.5 unless noted: `general-purpose` 51,500; `claude-researcher` 50,094; `Explore` 34,426; `claude-code-guide` (Haiku 4.5, four tools) 22,045. The main session's first request: 69,152. Headless and desktop baselines differ (the desktop session has connectors and plugin skills), so only differences inside one environment are comparable.

The allowlist was then tried on real tasks, see section 4.

## 3. Codex through the server, as the reviewer and as the implementer

Method: a small Node client over stdio (the SDK in the npx cache) started `npx -y codex-subagent-mcp@^0.5.0` with the environment of one registration and called its tools, as Claude Code would. The target was a scratch repository with one commit: a test expecting `greet('ada')` to return `Hello, ADA!`, a source file that did not, and an ignored `node_modules/mini-upper` that the source imported.

Observed with the `codex-reviewer` environment (`CODEX_SUBAGENT_MAX_SANDBOX=read-only`):

- The server sends no `instructions` and names itself `codex-subagent` whatever the registration. The description of `codex_delegate` still mentions `workspace-write` and `codex_recommend`, with a default model configured.
- A call with `sandbox: workspace-write` is refused before any run: the ceiling is a message naming the variable.
- A read-only run read both files and answered correctly. Asked to create a file, it reported `touch: probe.txt: Operation not permitted`, and the working tree stayed clean. The result ended with `applied=confirmed`.

Observed with the `codex-implementer` environment (`workspace-write`), one call with `use_worktree: true`, `acceptance_criteria` and `target_files`, effort low:

- The edit landed in a worktree under `~/.codex/worktrees/1f0d/repo`, registered in the repository as a detached `HEAD` at the commit the delegation started from. The original working tree stayed untouched. The result said `applied=differs` and named the new working directory.
- `git -C <worktree> diff | git apply --check` against the original repository succeeded, so the orchestrator can recover the change.
- The tests ran with no dependencies. The worktree had no `node_modules`, since ignored files are not in a worktree, so the first run failed on the missing import. Codex changed production code to remove the import and made the test pass. It reported what it did.
- It could not commit: `index.lock: Operation not permitted` under the repository's `.git/worktrees/`. The change stayed unstaged.
- The worktree is not removed: it stays registered until `git worktree remove`.
- The delegation used 108,286 input tokens (102,784 cached) and 1,094 output for a one-line change that took four commands. A second, inspection-only run with one command used 24,980 (12,160 cached): the cost follows the number of steps, with a floor near 25,000.
- The result noted that the plugin listing failed (`codex plugin list --json`) and still reported `plugins none`.

After the session was restarted the same checks ran through the registered tools of Claude Code (`mcp__codex-reviewer__*` and `mcp__codex-implementer__*`): both `codex_doctor` calls were ok, the descriptions the model sees are identical in the two servers, and one more implementer run with a tracked file modified and an untracked file in the original tree, both uncommitted, gave a worktree that held neither: it is made from the last commit. The leftover worktrees were removed with `git worktree remove`.

Not checked: `auto_approve`, effort above low, a run on Linux or Windows.

## 4. The six-tool allowlist on real tasks

Method: headless as in section 2, with agents built from the bodies of the shipped `claude-researcher` and `claude-implementer` files plus `omitClaudeMd: true` and a `tools` allowlist: `Read`, `Grep`, `Glob`, `Bash`, `WebFetch`, `WebSearch` for the researcher (Sonnet 5.5) and `Read`, `Edit`, `Write`, `Grep`, `Glob`, `Bash` for the implementer (Opus 5.5). The package gave goal, scope, constraints and, for the implementer, acceptance criteria and the verify command.

- Researcher, asked which Bash commands `guard-git.mjs` denies for a subagent and where: it read the hook and ADR 0013 and returned the report shape of its file, with a verdict, seven findings ranked, each with line numbers and VERIFIED or NOT VERIFIED, sources, and what it did not check (it marked `lib.mjs` as unread). First request: 5,937 tokens.
- Implementer, on the scratch repository with the failing test: it fixed `src/greet.js` with a one-line change, touched nothing else, ran `npm test` before and after, did not commit as the package said, and reported that `mini-upper` is installed in `node_modules` but not listed in `package.json`, left alone as out of scope. First request: 5,890 tokens.

Against about 50,000 for the installed researcher in the desktop session. One run each, on one small task each; the headless environment has a smaller baseline, so the ratio, not the absolute numbers, is the point.

## 5. The installed agents in a desktop session (issue 34, AC-7 and AC-8)

Method: a desktop session started after `node scripts/install.mjs`, so the installed files were the shipped ones. Claude Code 2.1.291, Sonnet 5.5 and Opus 5.5. Each probe was a foreground `Agent` call; the numbers come from the subagent transcript (`subagents/agent-<id>.jsonl`): input, cache creation and cache read tokens of the first assistant message.

First-request cost of a trivial delegation (prompt "reply OK"), two runs each:

- `claude-researcher`: 54,253 and 54,253 before, 4,540 and 4,540 after.
- `claude-implementer`: 54,934 and 54,934 before, 4,479 and 4,479 after.
- `Explore`, the control the change does not touch: 38,883 and 38,883 before, 39,062 and 39,062 after. The 179 tokens are drift in the environment.

The saving cannot be split between `omitClaudeMd` and the shorter tool list: both changed together.

A package built from the `task-package` template, asking the agent to read one file and to say what its context holds:

- Both agents returned status, failure type, what changed, checks run and not run, findings each with source and verified flag, and what was left out. Both corrected a prior finding marked not verified, citing the line.
- Reading `package.json`, neither agent reported a `CLAUDE.md` or the personal rules, and the transcripts hold none of the text of the user, repository or personal files.
- A first attempt read `global/agents/*.md` and is discarded: Claude Code loaded `global/CLAUDE.md` after that `Read` (in the transcripts it appears after the tool result, not at start). `omitClaudeMd` stops the startup files, not the `CLAUDE.md` of a directory the agent reads into, so a delegate that reads under a folder with its own `CLAUDE.md` receives it. ADR 0015 does not cover this.
- The implementer of that attempt said it had no `Grep` or `Glob` although `tools` lists them. One observation, not checked.

One run per variant, on trivial tasks.
