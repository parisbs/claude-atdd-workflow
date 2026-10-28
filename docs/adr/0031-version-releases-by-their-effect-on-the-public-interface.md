---
status: accepted
date: 2026-10-28
---
# 0031. Version releases by their effect on the public interface

- Extends: [0005](0005-conventional-commits-and-releases-from-tags.md) (a release is an annotated `vX.Y.Z` tag on `main`, and a hotfix increments the patch version)
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

An installer that updates on demand would have to tell the user whether an
update is safe to take, and v1.0.0 must promise something. Both need a version policy and a public
interface it is measured against.

## Decision

The version follows Semantic Versioning 2.0.0, measured against the public
interface below. The commit type is evidence for the bump, not the rule.

### Public interface

1. What is installed and where (ADR 0001): `global/CLAUDE.md` as
   `~/.claude/CLAUDE.md`; `global/hooks/`, `global/skills/` and `global/agents/`
   under `~/.claude/` with their file, skill and agent names and how a skill is
   invoked (`disable-model-invocation`, arguments); the templates under
   `~/.claude/skills/repo-bootstrap/templates/` (`common/`, the stack
   directories, and `scripts/check-adrs.mjs` and `scripts/migrate-adrs.mjs`
   under `common/scripts/`); `personal/preferences.md` as
   `~/.claude/rules/personal.md`; the merged `settings.json`, with its
   permission rules, hook entries and shipped values (`bashOutputMaxChars`,
   `includeGitInstructions`, `attribution`); the user-scope MCP registrations,
   their names (`codex-implementer`, `codex-reviewer`, ADR 0014), pinned
   package and environment (ADR 0028); and the backup directory
   `$XDG_STATE_HOME/claude-atdd-workflow/backups/` (ADR 0027).
2. Command lines: `node scripts/install.mjs` with `--check`, `--target <dir>`,
   `--adopt`, `--keep-backups <n>`, `--list-backups` and `--restore <stamp>`,
   their defaults (target `~/.claude`, ten bundles) and exit statuses;
   `scripts/check-adrs.mjs <base-ref>` as the bootstrapped CI runs it; and the
   metrics scripts (`metrics-report.mjs`, `metrics-validate.mjs`,
   `metrics-delegations.mjs`) with the options and report schema the README
   documents.
3. The bootstrap's arguments: `/repo-bootstrap new <name> [private|public]` and
   `/repo-bootstrap integrate`, and the files it writes into a repository.
4. The formats other tools read: the installer manifest
   `.claude-atdd-workflow-manifest.json` (`files`, `personalHooks`), the backup
   bundle format, the files under `personal/` that a user fills from the
   `*.example.*` files, and, once they are introduced, the project profile and
   the module manifest.
5. What the workflow reads from a project's `CLAUDE.md`, and its default when
   absent: the `Verify:` line, in the form ``- Verify: `<command>` `` (absent:
   what CI runs); `Implement:` (`claude` or `codex`; absent: `claude`);
   `Review:` (`none` or `codex`; absent: no review); `Human merge:`
   (comma-separated paths or globs, a trailing slash for a directory, `none`;
   absent: none), read from the base branch; the `## Invariants` and
   `## Conventions` sections, which `task-package` copies into a delegate's
   package; and the procedures and directories it names for a skill to follow
   (a release or pre-PR procedure, the ADR directory).
6. What the hooks and skills read from a project otherwise: `oracle/<branch>`
   tags; `.atdd/test-paths` at the oracle tag, one glob per line, and the
   default test paths when it is absent; the default control-plane and
   test-configuration paths; the protected branches (`main`, `master`, the
   remote default) and squash-only merges; the `needs-human` label and the
   `atdd` label (ADR 0030); `AC-n`
   identifiers in test names; ADR directories (`docs/adr/`, `docs/adrs/`,
   `docs/decisions/`), `NNNN-slug.md` names, the README index and the front
   matter `status` with its words and transitions (ADR 0020, 0021); and the
   project procedures skills defer to (`docs/releasing.md`,
   `.claude/skills/ship/`).
7. Runtime minimums and environment: Node (`engines` in `package.json`), Claude
   Code (`MIN_CLAUDE` in the installer), and the variables the hooks read, such
   as `GUARD_GIT_GH_TIMEOUT_MS` and `GUARD_GIT_GH_BUDGET_MS` (ADR 0024).

Anything else is internal: the code of hooks and scripts behind those
interfaces, test files, this repository's own CI, messages and wording, the
order of steps and the effort of a skill, and the files under `docs/`.

### Bumps

A release is compared with the previous tag, not each pull request with its
parent: a change to something added since the previous tag is not breaking.

- **Major**: a user or a project must change something, or gets a different
  result without asking for it.
  - The format or location of anything in item 4 changes, even when the
    installer migrates it: an older installer, a restore or an updater reads it
    too. Example: v0.6.0 renamed `.claude-workflow-manifest.json` to
    `.claude-atdd-workflow-manifest.json` (`93c75ad`).
  - Something in the interface is removed or renamed: a skill, agent, hook,
    MCP registration, template, option or, later, a module. Example: v0.2.0
    deleted `common/AGENTS.md.template` (`ce556fb`).
  - A default changes behaviour: a hook or permission rule denies what it
    allowed, or allows what it asked or denied; a shipped setting or a default
    value changes; a line in item 5 or 6 becomes required or changes meaning; a
    runtime minimum rises. Examples: merges allowed without asking when GitHub
    shows them safe (`7dfea36`, v0.2.0); skills reading `CLAUDE.md` instead of
    `AGENTS.md` (ADR 0012, v0.2.0); skills the model may start unasked
    (`a611147`, v0.2.0); a linked worktree bound to its ancestor's oracle (ADR
    0016 amending 0003, v0.3.0); merges failing closed (`e0d020d`, v0.6.0);
    backups moving out of `~/.claude` (ADR 0027, v0.6.0); Node 22.2.0 required
    (`b8b4e8f`, v0.6.0).
- **Minor**: something is added and nothing existing changes for a user who
  ignores it.
  - A new skill, agent, hook, script, stack, template, MCP registration or
    module.
    Examples: `task-package` (v0.3.0), `claude-implementer` and
    `claude-researcher` (v0.3.0), `scripts/metrics-report.mjs` (v0.5.0).
  - A new option or bootstrap argument. Example: `--keep-backups`,
    `--list-backups` and `--restore` (v0.6.0).
  - A new optional `CLAUDE.md` line, or a hook that asks where it allowed or
    denied before: the user decides and can still proceed. Examples: asking
    before merging a pull request from a fork or another author (`efd9a7b`,
    v0.5.0); asking instead of denying before deleting or moving an oracle tag
    in the main session (ADR 0029).
- **Patch**: a correction that makes the shipped behaviour match what an ADR,
  the README or a skill already says, documentation, tests and CI. A hook that
  now denies a bypass of a rule it already enforced is a patch; a change that
  needs a new or amending ADR to justify it is not. Examples: v0.3.1, where the
  installer compared the url and headers of a declared MCP server as it already
  claimed to; closing the oracle tag removal bypasses (`e5cb7d5`, v0.2.0).

A release takes the highest bump among its changes. When a change fits two
classes, the higher one wins. A hotfix release holds only patch-class changes;
when `main` holds anything else since the previous tag, the release takes that
class and is not a hotfix.

### Before 1.0.0

Until v1.0.0 a major-class change bumps the minor version, and its changelog
entry starts with **Breaking**; minor-class and patch-class changes bump as
above. From v1.0.0 the bumps apply as written.

### Changelog

`CHANGELOG.md` has one section per tag, newest first. Each entry links its
pull request, or its commit when it has none, and each section lists the tools it adds under "New tools". The
process in `docs/releasing.md` writes it, once per release.

## Alternatives considered

- **Derive the bump from commit types alone** (`feat` minor, `fix` patch, `!`
  major), as `release-prep` did. Rejected: the type describes intent, not
  effect, and both examples in the context would have been released as minor or
  patch without warning.
- **Calendar versioning.** Rejected: it says when, not whether an update is
  safe, which is what an updater must tell the user.
- **Count only the installer and the files under `~/.claude` as the interface.**
  Rejected: the `CLAUDE.md` lines and the oracle tags are what other
  repositories depend on, and a change there breaks them without touching
  `~/.claude`.
- **Count skill wording and hook messages as interface.** Rejected: nearly every
  change would be major, and nothing parses them.
- **Classify each pull request against its parent.** Rejected: a fix to
  something no tag has shipped yet would count as breaking.
- **Apply full SemVer before 1.0.0.** Rejected: v1.0.0 waits on a planned
  reorientation of the project; jumping to it, or to v2.0.0, on the next
  breaking change would spend the promise v1.0.0 is meant to make.
- **Generate the changelog with a script at every release.** Rejected: entries
  are compiled from pull request bodies with judgement, once per release, and a
  generator would need its own tests for little gain.

## Consequences

- `release-prep` reads the bump from this record and `docs/releasing.md` in this
  repository and falls back to commit types only in repositories without a
  policy.
- Existing tags keep their numbers. v0.2.0, v0.3.0, v0.4.0 and v0.6.0 hold
  changes that are breaking under these rules, and the changelog marks them.
- The promise covers installs from a tag. An install from an untagged `main`
  gets whatever has merged since the last tag; `docs/releasing.md` says how to
  install a release.
- The project profile and the module manifest are interface from the release
  that introduces them; their fields are defined there.
- Adding an item to the public interface is a minor change; removing one is
  major.
