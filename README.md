# claude-atdd-workflow

Versioned user-level configuration for Claude Code, plus the templates that
bring a repository into an agent-assisted workflow with human-approved
acceptance tests.

This repository continues the private `claude-workflow` (ADR 0022). Issue and
pull request numbers up to 74 in code, tests and documentation refer to that
repository; commit messages write them as `claude-workflow#N`, and
`docs/migration/claude-workflow-commits.csv` maps its commit ids to these.

## Donating session metrics

You can donate metrics from your own Claude Code sessions (ADR 0023). Donated
data is published under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/):
you dedicate it to the public domain by ticking the licence checkbox in the
[metrics-donation template](.github/PULL_REQUEST_TEMPLATE/metrics-donation.md),
confirming that you have the right to share it.

The report collects one row per session: its UTC ISO week, CLI version,
entrypoint, permission modes, models and efforts, request and token counts,
duration rounded to minutes, tool and skill counts, and subagent counts and
tokens. Skills, agents and MCP servers are named only when this repository
ships them; other values become `other`. Subagent counts are separate from
the main session totals. The header records the schema, script version and
script hash, generation week and licence.

It never collects prompts, responses, tool inputs or results, file snapshots,
paths, branch names, session or account identifiers, pull request URLs, custom
titles, or private MCP server names. Unknown records and keys are counted and
discarded, never printed.

With Node 22 or newer, run this command from a checkout of the repository on
Windows (PowerShell), macOS or Linux (a terminal); no dependencies are needed:

```sh
node scripts/metrics-report.mjs --since 2026-10-05 --until 2026-10-11
```

Change the dates to your range, or omit either bound. Both UTC days are
inclusive; sessions belong to the day of their first record and are reported
whole. Transcripts come from `CLAUDE_CONFIG_DIR/projects` when that environment
variable is set, otherwise `.claude/projects` under your home directory.
Optionally add `--project "path/to/project"` (or `--project "C:\work\project"`
on Windows) to include only that directory and its descendants. This filter
path is not included in the report. `--out "report.json"` chooses an output
file; an existing file is never overwritten.

Read the JSON report before submitting it. By default the script creates
`YYYY-Www-<8 random hex digits>.json` in the working directory and prints a
plain-text summary. In a fork, add that one file to
`docs/experiments/donated/`, preserving the generated filename, and open a pull
request with the metrics-donation template. GitHub applies it only through the
`template` query parameter, so open the comparison of your branch with it, replacing
the placeholders:

```text
https://github.com/parisbs/claude-atdd-workflow/compare/main...YOUR-USER:YOUR-BRANCH?quick_pull=1&template=metrics-donation.md
```

The [comparison with the template](https://github.com/parisbs/claude-atdd-workflow/compare?quick_pull=1&template=metrics-donation.md)
is the same page before you choose your fork and branch. Change no other file
and tick the CC0 checkbox. CI checks the report using the base branch's validator; a
maintainer reviews and merges it. You can also validate locally with
`node scripts/metrics-validate.mjs <report> --ref origin/main` once your local
history includes the published script version.

Your GitHub account is public through the pull request, so the report is
de-identified in content but not anonymous. The data is self-reported and
validated in form, not in origin. Donors are self-selected; pooled counts
cannot separate the effects of the workflow, developer, project and model.

## Layout

- `global/`: generic configuration installed into `~/.claude`. Nothing in it
  is specific to one person or one project.
  - `CLAUDE.md`: workflow defaults (git, pull requests, reviews, task levels).
  - `settings.json`: read-only permissions, built-in git instructions off, hook
    wiring and a 12,000-character Bash output cap; MCP and Read caps stay at their
    defaults. `retired-permissions.json` lists rules that no longer ship and that
    the installer removes from an installed `settings.json`.
  - `mcp-servers.json`: the MCP servers the installer registers in the user
    scope through `claude mcp` (ADR 0014): `codex-reviewer` and
    `codex-implementer`, two registrations pinned to `codex-subagent-mcp@0.5.0`
    with different sandbox ceilings. The installer derives their permissions
    and guard matcher from this file (ADR 0017), recognizing the package in a
    command or argument under any registration name.
    `retired-mcp-servers.json` lists registrations it removes.
  - `hooks/`: `guard-git.mjs` (no commit or push on main, no `--no-verify`,
    confirmation before remote Supabase actions, oracle tags created with
    confirmation and never moved or deleted, and the merge decision: squash
    only, never `--admin`, and a pull request is merged without a prompt only
    when its checks passed, it touches no control-plane path, and the
    authenticated `gh` user opened it from a branch in the base repository, not
    a fork, ADR 0024; and for a subagent's call, no `git push` and only
    read-only `gh` commands, ADR 0013), `guard-readonly.mjs` (the researcher's
    closed list of shell reads; denies writes, execution and unread forms, and
    fails closed), `commands.mjs` (command knowledge shared by both guards),
    `controlplane.mjs` (those paths), `guard-tests.mjs` (frozen acceptance
    tests while an `oracle/<branch>` tag exists, and in a linked worktree while
    an oracle tag's commit is an ancestor of HEAD), `oracle-check.mjs` (the
    deterministic pre-PR check of the oracle), `guard-codex.mjs` (Codex
    delegations pass `working_dir`, a worktree delegation starts from a clean
    directory, and a writing call of any declared Codex registration runs in a Codex
    worktree), `codex-integrate.mjs` (applies a Codex worktree's changes to the
    work branch, runs `oracle-check` and removes the worktree) and `codex.mjs`
    (where Codex makes its worktrees); `task-package.mjs` prints repository
    invariants, conventions, the verify command, HEAD, the oracle with its own
    commit and frozen tests, and the report schema.
  - `skills/`: `issue-draft`, `atdd-oracle`, `atdd-implement`, `adr-draft`,
    `pr-prep`, `drift-audit`, `task-package` (the package and report shape for
    any delegation in `SKILL.md`, Codex mapping and schema in `codex.md`, and
    Claude worktree rules in `worktree.md`, ADR 0015 and 0017), `release-prep`
    and `repo-bootstrap`. Their names
    never collide with project skills (ADR 0007).
  - `agents/`: the subagents the orchestrator delegates to (ADR 0011):
    `claude-implementer` (Opus, writes code against a task package) and
    `claude-researcher` (Sonnet, read-only, with `guard-readonly` enforced by its
    own Bash hook and `onFailure: "block"`). Both set `omitClaudeMd`, so the
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
  pull request title check, an ADR template and the ADR check workflow,
  labels and GitHub rulesets.
- `android/`, `flutter/`, `node-mcp/`, `supabase/`: per-stack verify
  commands, test paths and the rules a repository of that stack should carry.
- `scripts/install.mjs`: the installer.
- `scripts/check-adrs.mjs`: the CI check that ADRs change only as ADR 0018
  allows, with numbering and index (ADR 0019), reading the status from MADR 4
  front matter (ADR 0020).
- `scripts/migrate-adrs.mjs`: rewrites legacy ADRs into MADR 4 front matter,
  mechanically, so the check admits the change. The installer copies both
  scripts into the `repo-bootstrap` templates.
- `CLAUDE.md`: this repository's own instructions, the only instruction file it has (ADR 0012).
- `docs/`: the decisions (`adr/`), the roadmap and the research behind them.

## Install

Requires Node 22 or later and Claude Code 2.1.295 or later. Older versions of
Claude Code ignore the `onFailure` setting that blocks a merge when its guard
does not finish, and `--check` reports an older `claude` on `PATH`.

```bash
cp personal/preferences.example.md personal/preferences.md
cp personal/settings.example.json personal/settings.json
cp personal/mcp-servers.example.json personal/mcp-servers.json
node scripts/install.mjs --check
node scripts/install.mjs
```

The personal files are optional: edit them to your own preferences first. The
check reports what would change without writing anything. Installing copies
files (never links them), merges `settings.json` keeping existing user settings
except retired rules and reconciling the derived Codex permissions, backs up
whatever it overwrites to `~/.claude/backups/claude-workflow/`,
and removes files it installed earlier but no longer ships. It also registers the
declared MCP servers through the `claude` CLI, never by writing `~/.claude.json`,
replacing a registration that differs (the old one is saved in the backup
directory) and removing a retired one; a Claude Code session that is already
open keeps the old server process until it reloads. Without `claude` on `PATH`
the servers are reported as not verified, and the check exits 1. Run the check
again at any time to detect drift.

Each declared Codex registration allows only the five no-quota tools
`codex_doctor`, `list_codex_models`, `codex_recommend`, `codex_job_result` and
`codex_job_cancel`; delegation, follow-up and job status require permission.
The previously shipped job-status permissions are retired during installation.
Removing a Codex name also removes its derived permissions and guard coverage.
`--check` compares the same derived settings and exact server version that an
install writes.

Codex delegations block unless the human requests parallel or background work;
job status is never polled in a loop. CI uses the app's PR monitor or
`gh pr checks --watch`, local work uses background commands, and files and
outputs are read by range (ADR 0017).
Run `node ~/.claude/hooks/task-package.mjs` from a repository to collect the
mechanical package fields before delegating.

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

It prints one dot per test and, at the end, each failure with its message and stack. To see every test by
name:

```bash
npm run test:verbose
```

`CLAUDE.md` lists the scripts that run only the tests of one area.

To measure delegations before and after a change, `node scripts/metrics-delegations.mjs` reads your local
transcripts and prints aggregates only: how task packages are filled, how large hand-backs and Codex results
are, and the tokens Codex used per model and effort. `--since YYYY-MM-DD`, `--rates <file>`, `--json` and
`--verbose` refine it; it writes nothing and is not part of the metrics donation.

## License

MIT. See [LICENSE](LICENSE).
