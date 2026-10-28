---
status: accepted, amended by [0032](0032-reorient-the-workflow-into-a-toolbox-the-human-directs.md)
date: 2026-10-22
---
# 0027. Keep installer backups in the XDG state directory as JSON bundles

## Context

`scripts/install.mjs` copies everything it overwrites or removes to `~/.claude/backups/claude-workflow/<timestamp>/`, keeping each file under its own path. Findings F-07, F-21 and F-06 of the 2026-10-21 audit, a local working file outside the repository, and issue #42 describe what that costs. Each item says whether it was verified.

- Claude Code owns `~/.claude/backups/`: it keeps its own rotated copies of `~/.claude.json` there and sweeps the directory by `cleanupPeriodDays`. Source: the "Cleaned up automatically" table of `code.claude.com/docs/en/claude-directory`. Verified in the documentation.
- The installer has no retention. On the maintainer's machine the directory held 35 backups and 696 KB on 2026-10-22, the oldest from 2026-09-29. Verified with `ls` and `du`.
- The copies keep live names (`CLAUDE.md`, `rules/personal.md`, `skills/<name>/SKILL.md`) and `settings.json` with any secrets in `env`. A `CLAUDE.md` in a subdirectory loads as memory when Claude reads a file there, so a session started in the home directory could load an old copy. Inferred from `code.claude.com/docs/en/memory`, not tested.
- Writes go in place, through `cpSync` and `writeFileSync`. Claude Code reloads hooks and settings when their files change, and a hook that fails lets the action through, so an install opens a short window without guards. Verified in the hooks documentation, not reproduced.
- Every planned destination that differs is overwritten, whether or not the installer put it there, so a third party's own `~/.claude/CLAUDE.md` or a skill of the same name is replaced silently. Verified in `scripts/install.mjs`.
- On the maintainer's machine `XDG_STATE_HOME` is unset, and `~/.local/state/` already exists and holds the GitHub CLI's state. codex-subagent-mcp 0.6.0 also keeps its usage log under `XDG_STATE_HOME`, according to the audit plan's reading of its code; this repository installs 0.5.0. Verified for the machine, not verified for 0.6.0.

## Decision

1. The installer keeps its state outside the Claude Code configuration directory, in `$XDG_STATE_HOME/claude-atdd-workflow/` when `XDG_STATE_HOME` is an absolute path, and in `~/.local/state/claude-atdd-workflow/` otherwise. A relative value is ignored, as the XDG Base Directory specification requires.
2. Each install that overwrites or removes something writes one backup bundle in `backups/` there: a single JSON file with mode 0600, in a directory with mode 0700, holding the previous content of every file it overwrites or removes, the MCP registrations it replaces or removes, and the target directory it was made for. No file in it has a name Claude Code would load.
3. Retention keeps the 10 most recent bundles per target, configurable with `--keep-backups <n>`. `--list-backups` lists them and `--restore <stamp>` applies one to the target it was made for, saving what it overwrites in a new bundle first.
4. The installer refuses to overwrite a planned destination that exists, is not in its previous manifest and differs from what it would install, and exits with status 2. `--adopt` backs such files up and takes them over.
5. Every file is written to a temporary file in the same directory and renamed over the destination. Hooks, scripts and every other planned file are written before `settings.json`, and the manifest last.
6. The manifest becomes `.claude-atdd-workflow-manifest.json`. An install migrates the legacy manifest, keeping its records, `personalHooks` included, and converts each directory of `~/.claude/backups/claude-workflow/` into a legacy bundle once, then removes that directory. Legacy bundles are exempt from retention, because the oldest hold the user's own files from before the first install. A conversion that fails leaves the legacy directory in place.

## Alternatives considered

- Keep the backups in `~/.claude/backups/`. Rejected: Claude Code owns and sweeps that directory, the installer would still need a retention of its own, and copies under live names can load as memory.
- A dot directory in the home, `~/.claude-atdd-workflow/`. Rejected by the maintainer on 2026-10-22: it is easier to spot, but it adds a directory to the home and ignores a user who set `XDG_STATE_HOME` to avoid exactly that. `--list-backups` prints the directory, which covers finding it. `~/.atdd-workflow/` was also rejected, because the name is ambiguous with other tools.
- `XDG_DATA_HOME` (`~/.local/share/`). Rejected: backups are state the tool can rebuild from or discard by retention, not user data. It depends on a variable in the same way, so it gains nothing over the state directory.
- Migrated legacy backups counting toward retention. Rejected: the first install would delete 25 of the 35 legacy backups, including the user's files from before the first install.
- One retention count across all targets. Rejected: an install into a test target would evict backups of `~/.claude`.

## Consequences

- Backups survive Claude Code's sweep and stop growing without bound, and their format no longer loads as instructions.
- ADR 0022, accepted and frozen, says the installer keeps its manifest and backup directory under the former name. This record supersedes that consequence only. The text of ADR 0022 stays as written.
- Backups live outside `~/.claude`, so an environment that keeps only `~/.claude`, such as a container that mounts it as a volume, loses them when it is rebuilt. Tools that sync `~/.claude` stop carrying them, which keeps the secrets in `settings.json` out of those copies.
- A user who sets `XDG_STATE_HOME` in some environments and not in others gets bundles in two directories, and `--list-backups` shows only one of them. This was judged an edge case and accepted without a mitigation.
- A third party whose `~/.claude` holds their own files with planned names sees the first install stop until they pass `--adopt`; the message names each file.
- Reverting the change does not move migrated backups back to `~/.claude/backups/claude-workflow/`; they stay in the state directory, readable only by an installer that carries this decision.
