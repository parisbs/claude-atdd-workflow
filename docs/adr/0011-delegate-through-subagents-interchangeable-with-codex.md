# 0011. Delegate through Claude Code subagents, interchangeable with Codex

- Status: accepted, amended by [0013](0013-guard-git-keeps-subagents-off-github.md)
- Date: 2026-10-02

## Context

The orchestrating session should orchestrate: complex programming goes to a
stronger model, research to a cheaper one, and the developer chooses between
Claude and Codex per task, through `AGENTS.md` or through the orchestrator.
Codex is already a callable subagent through `codex-subagent-mcp`; Claude has
no equivalent in this configuration.

What the official documentation says (read on 2026-10-02 through a model that
summarises pages, so a real probe must confirm it before this record is
accepted):

- A subagent file sets `model` (including `opus` and `sonnet`), `effort`,
  `tools`, `disallowedTools`, `isolation`, `skills` and `hooks`, and runs in a
  fresh context. User-level files live in `~/.claude/agents/`; a project agent
  with the same name wins over a user one.
- A skill's `model` applies for the rest of the turn. Run in a subagent, it needs
  `context: fork` and an `agent`, so it ends up using a subagent anyway. A skill
  with `disable-model-invocation: true` cannot be preloaded into a subagent.
- PreToolUse hooks defined in settings fire for subagent tool calls.
- `isolation: worktree` branches from the repository's default remote branch,
  not from the current `HEAD`, unless `worktree.baseRef` is `"head"`. The branch
  gets a name such as `worktree-<name>`.
- Subagents can spawn subagents, three levels deep by default.

From the configuration: `guard-tests` looks for the tag `oracle/<current
branch>`. In a subagent's worktree the branch is not the work branch, so the
guard finds no oracle and lets frozen tests be edited without a word. This was
read in `oracle.mjs`, not exercised.

## Decision

- Delegation to Claude goes through **subagents** defined in `global/agents/`,
  installed by `install.mjs` into `~/.claude/agents/` with the same manifest and
  backups as the rest.
- `claude-implementer`: `model: opus`, `effort: high`, write tools, and
  `disallowedTools` for `Agent` and for the `gh` commands that act on GitHub, so
  it neither delegates further nor leaves the worktree. It returns what changed,
  which tests ran and which did not.
- `claude-researcher`: `model: sonnet`, `effort: medium`, no `Edit`, `Write` or
  `NotebookEdit`, web and read tools only. It returns findings with sources and
  separates what it verified from what it did not.
- A `claude-reviewer` (Opus, read-only, fresh context) is deferred.
- **Claude and Codex are interchangeable.** Both receive the same task package
  (the issue, the oracle, `AGENTS.md` and the scope) and return the same report
  shape. A line `Implement: claude` or `Implement: codex` in `AGENTS.md` chooses
  one, as `Review:` already does for reviews; the orchestrator follows it unless
  the human says otherwise in the session, and when the line is absent it uses
  `claude-implementer` and says so.
- **Writing happens where the branch is the work branch.** The session runs in a
  worktree on that branch (the desktop app's worktree option, or `git worktree
  add`), and the implementer runs without `isolation` inside it. That satisfies
  the rule that a writing delegation runs in a worktree and keeps
  `guard-tests` effective. `isolation: worktree` is not used in the agent files
  until the guard resolves the oracle some other way.
- Orchestration rules, meaning which agent for which task, go in the Delegation
  section of `global/CLAUDE.md`, which applies only where a repository's
  `AGENTS.md` is silent.

## Alternatives considered

- **Skills only.** Rejected: a skill shares the session's context and changes the
  model only for a turn, so the orchestrator would still do the work.
- **A skill with `context: fork` as the way in.** Not rejected, deferred: it is a
  thin wrapper over a subagent, useful later for `atdd-implement`, and needs the
  subagent first.
- **Ad hoc `Agent` calls with a `model` parameter.** Kept as an escape hatch: it
  works today, but carries no persistent rules, tools or reporting contract.
- **`isolation: worktree` in the agent file.** Rejected for now for the two
  reasons in Context: the wrong base branch and a blind oracle guard.
- **Codex only.** Rejected: the developer wants both, chosen per task.

## Consequences

- `install.mjs` gains `global/agents` and the drift check covers it. A first
  probe, read-only, must confirm the applied model, the tools and the denied
  commands before this record is accepted.
- Subagents take `CLAUDE.md` and rules from the main session, not from their own
  worktree.
- Opus usage in the implementer is a cost the developer chooses by choosing the
  line in `AGENTS.md`.
- Because a project agent shadows a user agent of the same name, a repository can
  override these two deliberately. That is the opposite of skills (ADR 0007) and
  is acceptable here.
- The merge and GitHub rules for subagents come from
  [0010](0010-move-human-control-to-the-specification-and-gate-merges.md).
