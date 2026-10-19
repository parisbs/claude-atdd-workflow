---
status: superseded by [0012](0012-keep-repository-instructions-in-claude-md-alone.md)
date: 2026-09-29
---
# 0006. Make AGENTS.md the canonical instructions file of a repository


## Context

Repositories are worked on by Claude Code and, through delegation, by Codex.
Codex reads `AGENTS.md` and not `CLAUDE.md` (PROBABLE). Claude Code documents a
supported pattern: a `CLAUDE.md` that imports `@AGENTS.md` and adds only what is
specific to Claude (VERIFIED, official memory documentation).

## Decision

Each repository keeps its instructions in `AGENTS.md`. `CLAUDE.md` starts with
`@AGENTS.md` and holds only Claude-specific content: skills, hooks and rules
under `.claude/`. Both are written in English.

## Alternatives considered

- **`CLAUDE.md` only.** Rejected: delegated agents would work without the
  project's conventions and invariants.
- **Symlinking `CLAUDE.md` to `AGENTS.md`.** Rejected: it breaks on Windows
  clones without `core.symlinks`, and leaves no room for Claude-specific
  content.

## Consequences

- `AGENTS.md` holds only what an agent cannot derive from the code: pitfalls,
  rationale, invariants and conventions that differ from tool defaults. Layout
  descriptions, dependency lists and architecture overviews are removed.
