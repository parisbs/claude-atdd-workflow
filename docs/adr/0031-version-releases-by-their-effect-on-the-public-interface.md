---
status: proposed
date: 2026-10-28
---
# 0031. Version releases by their effect on the public interface

- Extends: [0005](0005-conventional-commits-and-releases-from-tags.md) (a release is an annotated `vX.Y.Z` tag on `main`)
- Issue: #60

## Context

ADR 0005 makes a release an annotated tag and says a hotfix bumps the patch
version, but nothing says what makes a release major or minor, and nothing names
what a user of this repository depends on. The tags v0.1.0 to v0.6.0 were chosen
by judgement. `release-prep` derives the bump from commit types, which misses
breaking changes that ship under `fix` or `feat`: `e0d020d fix(hooks): fail
closed on merges` changed what a merge does when the hook cannot read the pull
request, and `93c75ad fix(install): back up outside ~/.claude` moved the
installer backups to another directory.

An update on demand (roadmap item V-1) must tell the user whether an update is
safe to take, and v1.0.0 must promise something. Both need a version policy and
a public interface it is measured against.

## Decision

The version follows Semantic Versioning 2.0.0, measured against the public
interface below. The commit type is evidence for the bump, not the rule.

### Public interface

1. What is installed and where (ADR 0001): `global/CLAUDE.md` as
   `~/.claude/CLAUDE.md`; `global/hooks/`, `global/skills/` and `global/agents/`
   under `~/.claude/` with their file, skill and agent names; the templates under
   `~/.claude/skills/repo-bootstrap/templates/` (`common/`, the stack
   directories, and `scripts/check-adrs.mjs` and `scripts/migrate-adrs.mjs`
   under `common/scripts/`); `personal/preferences.md` as
   `~/.claude/rules/personal.md`; the merged `settings.json`, its permission
   rules and hook entries; the user-scope MCP registrations and their names
   (`codex-implementer`, `codex-reviewer`, ADR 0014); and the backup directory
   `$XDG_STATE_HOME/claude-atdd-workflow/backups/` (ADR 0027).
2. The installer's command line: `node scripts/install.mjs` with `--check`,
   `--target <dir>`, `--adopt`, `--keep-backups <n>`, `--list-backups` and
   `--restore <stamp>`, their defaults (target `~/.claude`, ten bundles) and the
   exit status of `--check` (1 on drift).
3. The bootstrap's arguments: `/repo-bootstrap new <name> [private|public]` and
   `/repo-bootstrap integrate`, and the files it writes into a repository.
4. The formats other tools read: the installer manifest
   `.claude-atdd-workflow-manifest.json` (`files`, `personalHooks`), the backup
   bundle format, the files under `personal/` that a user fills from the
   `*.example.*` files, and, once phases P and M introduce them, the project
   profile and the module manifest.
5. What the workflow reads from a project's `CLAUDE.md`: the `Verify:` line,
   in the form ``- Verify: `<command>` ``; `Implement:` (`claude` or `codex`);
   `Review:` (`none` or `codex`); `Human merge:` (comma-separated paths or
   globs, a trailing slash for a directory, `none`), read from the base branch;
   and the `## Invariants` and `## Conventions` sections, which `task-package`
   copies into a delegate's package.
6. The repository conventions the hooks and skills act on: `oracle/<branch>`
   tags, the `needs-human` label, `AC-n` identifiers in test names, and ADR
   front matter `status` (ADR 0020, 0021).

Anything else is internal: the code of hooks and scripts, test files, messages
and wording, the order of steps inside a skill, and the files under `docs/`.

### Bumps

- **Major**: a user or a project must change something, or gets a different
  result without asking for it.
  - The format or location of the manifest, the profile or anything in item 4
    changes, even when the installer migrates it: an older installer, a restore
    or the V-1 updater reads it too. Example: v0.6.0 renamed
    `.claude-workflow-manifest.json` to `.claude-atdd-workflow-manifest.json`
    (`93c75ad`).
  - Something installed is removed or renamed: a skill, agent, hook, MCP
    registration, template or, later, a module. Example: retiring the
    `codex-subagent` registration in favour of two role-named ones (ADR 0014,
    `global/retired-mcp-servers.json`).
  - A default changes behaviour: a hook or permission rule denies what it
    allowed, or allows what it asked or denied; a default value of an option
    changes; a line in item 5 becomes required or changes meaning. Examples:
    merges failing closed (`e0d020d`, v0.6.0); `CLAUDE.md` replacing
    `AGENTS.md` as the only instruction file (ADR 0012, v0.2.0); backups moving
    out of `~/.claude` (ADR 0027, v0.6.0).
- **Minor**: something is added and nothing existing changes for a user who
  ignores it.
  - A new skill, agent, hook, script, stack, MCP registration or module.
    Examples: `task-package` (v0.3.0), `claude-implementer` and
    `claude-researcher` (v0.3.0), `scripts/metrics-report.mjs` (v0.5.0).
  - A new installer option or bootstrap argument. Example: `--keep-backups`,
    `--list-backups` and `--restore` (v0.6.0).
  - A new optional `CLAUDE.md` line, or a hook that asks where it allowed or
    denied before: the user decides and can still proceed. Examples: asking
    before merging a pull request from a fork or another author (`efd9a7b`,
    v0.5.0); asking instead of denying before deleting or moving an oracle tag
    in the main session (ADR 0029).
- **Patch**: a correction that makes the shipped behaviour match what an ADR,
  the README or a skill already says, documentation, tests and CI. Example:
  v0.3.1, where the installer compared the url and headers of a declared MCP
  server as it already claimed to.

A release takes the highest bump among its changes. When a change fits two
classes, the higher one wins.

### Before 1.0.0

Until v1.0.0 a major-class change bumps the minor version, and its changelog
entry starts with **Breaking**; minor-class and patch-class changes bump as
above. From v1.0.0 the bumps apply as written.

### Changelog

`CHANGELOG.md` has one section per tag, newest first. Each entry links its
pull request, and each section lists the tools it adds under "New tools". The
process in `docs/releasing.md` writes it, once per release.

## Alternatives considered

- **Derive the bump from commit types alone** (`feat` minor, `fix` patch, `!`
  major), as `release-prep` did. Rejected: the type describes intent, not
  effect, and both examples in the context would have been released as minor or
  patch without warning.
- **Calendar versioning.** Rejected: it says when, not whether an update is
  safe, which is what V-1 must tell the user.
- **Count only the installer and the files under `~/.claude` as the interface.**
  Rejected: the `CLAUDE.md` lines and the oracle tags are what other
  repositories depend on, and a change there breaks them without touching
  `~/.claude`.
- **Count skill wording and hook messages as interface.** Rejected: nearly every
  change would be major, and nothing parses them.
- **Apply full SemVer before 1.0.0.** Rejected: v1.0.0 waits on the
  reorientation of B-1; jumping to it, or to v2.0.0, on the next breaking change
  would spend the promise v1.0.0 is meant to make.
- **Generate the changelog with a script at every release.** Rejected: entries
  are compiled from pull request bodies with judgement, once per release, and a
  generator would need its own tests for little gain.

## Consequences

- `release-prep` reads the bump from this record and `docs/releasing.md` in this
  repository and falls back to commit types only in repositories without a
  policy.
- Existing tags keep their numbers; v0.6.0 would have been breaking under these
  rules, and its changelog entries say so.
- The project profile and the module manifest are interface from the release
  that introduces them; their fields are defined there.
- Adding an item to the public interface is a minor change; removing one is
  major.
