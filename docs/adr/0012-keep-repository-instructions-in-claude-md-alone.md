---
status: accepted
date: 2026-10-02
---
# 0012. Keep repository instructions in CLAUDE.md alone

- Supersedes: [0006](0006-agents-md-is-the-canonical-repository-file.md)

## Context

ADR 0006 made `AGENTS.md` the canonical file of a repository and `CLAUDE.md` an
import of it, on the premise that Codex reads `AGENTS.md` and not `CLAUDE.md`
(then marked PROBABLE), so a delegated Codex would work with the project's rules.
Since then Codex became a delegate of an orchestrator (ADR 0011), and the premise
was checked on 2026-10-02 against Codex CLI 0.160.0, `gpt-6.1-sol`, through the
delegation server and directly with `codex exec`, in scratch directories with a
planted `AGENTS.md`. Each probe is a single low-effort run, so it shows a
behaviour exists, not how often.

- **It is loaded** into a delegated run (a marker the file asked for appeared in
  the answer, through the server and directly), and the official documentation
  describes it as user-role context placed before the task prompt.
- **An explicit instruction in the prompt wins.** "Always answer REPO" lost to a
  prompt asking for TASK, with and without a sentence saying the prompt
  overrides; "ask permission first" lost to "do not ask questions".
- **When the prompt is silent, the file is obeyed.** "Run `pwd` before any
  task" made a task that asked only for "DONE" run a command, and doubled its
  input tokens; "append a marker" appended it. Interference is additive: a narrow
  delegated task picks up the repository's own obligations (a full verify, a
  review step, the workflow of a human contributor) that the orchestrator did not
  ask for and cannot see.
- **The orchestrator has no control over it.** The delegation server sets nothing
  about project documents. `-c project_doc_max_bytes=0` removes them in a direct
  `codex exec` (the marker disappeared), but the server does not expose it, and
  `--ignore-user-config` and `--ignore-rules` do not touch them.

On the Claude Code side (official documentation): `/init` writes `CLAUDE.md`;
with `CLAUDE_CODE_NEW_INIT=1` it reads `AGENTS.md` and `/import` appends a copy
of it, both into `CLAUDE.md`. With a `CLAUDE.md` that only imports `AGENTS.md`,
those commands tend to produce two diverging copies. Claude Code reads
`AGENTS.md` directly only when no `CLAUDE.md` exists.

Not checked: the size cap, nested directories, a global `~/.codex/AGENTS.md`,
and `codex exec resume`.

## Decision

- Each repository keeps its instructions in `CLAUDE.md`, and has no `AGENTS.md`.
  Path-scoped rules stay in `.claude/rules/`.
- The orchestrator is the only source of instructions for a delegate. It
  assembles the task package of ADR 0011 from `CLAUDE.md`, choosing what the task
  needs, and passes it in the prompt, as the global Delegation rule already says.
  A delegate working in a repository finds no repository instructions of its own
  to add to that package.
- The lines the workflow reads (`Verify:`, `Review:`, `Implement:`,
  `Human merge:`) live in the Workflow section of `CLAUDE.md`. The merge decision
  of ADR 0010 reads `Human merge:` from the `CLAUDE.md` of the base branch.
- Wherever ADR 0010 and ADR 0011 say `AGENTS.md`, read `CLAUDE.md`.
- A repository that has an `AGENTS.md` is migrated by moving its content into
  `CLAUDE.md` and deleting the file; `drift-audit` flags a stray one.

## Alternatives considered

- **Keep ADR 0006.** Rejected: it feeds every delegated run instructions
  addressed to a human contributor and to Claude Code, which the orchestrator
  cannot see, and it leaves the duplication problem with `/init` and `/import`.
- **Keep `AGENTS.md` and switch project documents off in delegations**
  (`-c project_doc_max_bytes=0`). Rejected: it needs an option in the delegation
  server, a decision that belongs to the server's policy rather than its
  mechanism, and it leaves a file with a single reader, Claude Code through an
  import.
- **Keep `AGENTS.md` for neutral facts only and `CLAUDE.md` for everything
  else.** Rejected: the file cannot be kept neutral, since any fact written there
  is obeyed by a delegate that was not asked for it, and the split is the
  complexity that made `/init` hard to live with.
- **A symlink from `CLAUDE.md` to `AGENTS.md`.** Rejected for the reasons in
  ADR 0006, and it keeps the loading problem.

## Consequences

- Tools that read only `AGENTS.md` (Codex run directly in a repository, Cursor,
  Copilot) get no repository instructions. If one of them is used directly, that
  is a new decision that supersedes this one for that repository.
- A delegation to Codex depends on the orchestrator writing a complete task
  package. A thin prompt is no longer rescued by a repository file.
- A global `~/.codex/AGENTS.md`, if one exists, is still loaded into every
  delegation and is outside this repository's control.
- ADR 0010 and ADR 0011 are merged and are not edited; this record is the note
  that their `AGENTS.md` means `CLAUDE.md`.
- Work that follows, each its own issue: the merge decision reads `CLAUDE.md`;
  the bootstrap templates, the stack rules, the skills and the global
  instructions stop naming `AGENTS.md`; each managed repository is migrated,
  starting with codex-subagent-mcp.
