# claude-workflow

Versioned user-level configuration for Claude Code, plus the templates that
bring a repository into an agent-assisted workflow with human-approved
acceptance tests.

## Layout

- `global/`: generic configuration installed into `~/.claude`. Nothing in it
  is specific to one person or one project.
  - `CLAUDE.md`: workflow defaults (git, pull requests, reviews, task levels).
  - `settings.json`: read-only permissions, built-in git instructions off, hook
    wiring. `retired-permissions.json` lists rules that no longer ship and that
    the installer removes from an installed `settings.json`.
  - `mcp-servers.json`: the MCP servers the installer registers in the user
    scope through `claude mcp` (ADR 0014): `codex-reviewer` and
    `codex-implementer`, two registrations of `codex-subagent-mcp` with different
    sandbox ceilings. `retired-mcp-servers.json` lists registrations it removes.
  - `hooks/`: `guard-git.mjs` (no commit or push on main, no `--no-verify`,
    confirmation before remote Supabase actions, oracle tags created with
    confirmation and never moved or deleted, and the merge decision: squash
    only, never `--admin`, and a pull request is merged without a prompt only
    when its checks passed and it touches no control-plane path; and for a
    subagent's call, no `git push` and only read-only `gh` commands, ADR 0013),
    `controlplane.mjs` (those paths), `guard-tests.mjs` (frozen acceptance
    tests while an `oracle/<branch>` tag exists), `oracle-check.mjs` (the
    deterministic pre-PR check of the oracle), `guard-codex.mjs` (Codex
    delegations pass `working_dir`, a worktree delegation starts from a clean
    directory, and a writing `codex-implementer` call runs in a Codex
    worktree), `codex-integrate.mjs` (applies a Codex worktree's changes to the
    work branch, runs `oracle-check` and removes the worktree) and `codex.mjs`
    (where Codex makes its worktrees).
  - `skills/`: `issue-draft`, `atdd-oracle`, `atdd-implement`, `adr-draft`,
    `pr-prep`, `drift-audit`, `task-package` (the package and report shape for
    any delegation, ADR 0015), `release-prep` and `repo-bootstrap`. Their names
    never collide with project skills (ADR 0007).
  - `agents/`: the subagents the orchestrator delegates to (ADR 0011):
    `claude-implementer` (Opus, writes code against a task package) and
    `claude-researcher` (Sonnet, read-only). Both set `omitClaudeMd`, so the
    package is all they know, list their tools as an allowlist that leaves out
    `Agent`, and end with the shared report (ADR 0015). That neither acts on
    GitHub is enforced by `guard-git` (ADR 0013), not by the agent files. A
    project agent with the same name overrides them.
- `personal/`: the installer's own preferences. Only `*.example.*` files are
  versioned. `preferences.md` becomes `~/.claude/rules/personal.md`;
  `settings.json` is merged over the generic settings; `mcp-servers.json` holds
  machine values, such as `CODEX_BIN`, merged over the env of the shared servers.
- `common/`: templates every repository receives through `repo-bootstrap`:
  a `CLAUDE.md` skeleton, issue and pull request templates, the
  pull request title check, labels and GitHub rulesets.
- `android/`, `flutter/`, `node-mcp/`, `supabase/`: per-stack verify
  commands, test paths and the rules a repository of that stack should carry.
- `scripts/install.mjs`: the installer.
- `CLAUDE.md`: this repository's own instructions, the only instruction file it has (ADR 0012).
- `docs/`: the decisions (`adr/`), the roadmap and the research behind them.

## Install

Requires Node 22 or later.

```bash
cp personal/preferences.example.md personal/preferences.md
cp personal/settings.example.json personal/settings.json
cp personal/mcp-servers.example.json personal/mcp-servers.json
node scripts/install.mjs --check
node scripts/install.mjs
```

The personal files are optional: edit them to your own preferences first. The
check reports what would change without writing anything. Installing copies
files (never links them), merges `settings.json` keeping anything already
there, backs up whatever it overwrites to `~/.claude/backups/claude-workflow/`,
and removes files it installed earlier but no longer ships. It also registers the
declared MCP servers through the `claude` CLI, never by writing `~/.claude.json`,
replacing a registration that differs (the old one is saved in the backup
directory) and removing a retired one; a Claude Code session that is already
open keeps the old server process until it reloads. Without `claude` on `PATH`
the servers are reported as not verified, and the check exits 1. Run the check
again at any time to detect drift.

## Workflow in short

Every repository stays self-sufficient: its `CLAUDE.md` carries its
conventions, verify command and critical rules, and its CI and rulesets
enforce them. The user level only adds generic defaults, personal preferences,
a safety net of hooks, and skills.

Work is sized by level: trivial changes follow the normal flow; bugs start with
a failing regression test; features go through `/issue-draft` for acceptance
criteria, `/atdd-oracle` to write and freeze the approved tests, and
`/atdd-implement` to implement without touching them; `/pr-prep` closes the
loop. See `docs/adr/` for the reasoning and `docs/ROADMAP.md` for what comes
next.

## Development

```bash
npm test
```
