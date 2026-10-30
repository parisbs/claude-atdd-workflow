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

With Node 22.2.0 or newer, run this command from a checkout of the repository on
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
    `codex-implementer`, two registrations pinned to `codex-subagent-mcp@0.6.0`
    with `--prefer-offline` and different ceilings (ADR 0028):

    - `CODEX_SUBAGENT_DEFAULT_MODEL=gpt-6.1-sol` supplies the model when a call
      names none; `CODEX_SUBAGENT_ALLOWED_MODELS=gpt-6.1-sol,gpt-6-astra`
      refuses any other model, keeping Astra for escalation under ADR 0025.
      An empty list allows all models; an empty entry is a configuration error.
      Without a default, a one-model allowed list supplies it.
    - `CODEX_SUBAGENT_DEFAULT_EFFORT=high` supplies an omitted effort;
      `CODEX_SUBAGENT_MAX_EFFORT` caps it at `high` for the reviewer and `xhigh`
      for the implementer, clamping a request to the nearest supported level
      within the ceiling and refusing it if none qualifies.
    - `CODEX_SUBAGENT_MAX_SANDBOX` refuses calls above `read-only` for the
      reviewer and `workspace-write` for the implementer, follow-ups included;
      unset, the ceiling is `workspace-write`.
      `CODEX_SUBAGENT_DEFAULT_SANDBOX` stays unset (default `read-only`), so
      every write needs an explicit argument.
    - `CODEX_SUBAGENT_MCP_SERVERS=none`, `CODEX_SUBAGENT_PLUGINS=none` and
      `CODEX_SUBAGENT_APPS=off` disable inherited MCP servers, plugins and apps;
      `none` also avoids running `codex plugin list`.
      MCP servers and plugins accept `none`, `all` or a list; apps accept `on`
      or `off`.
    - `CODEX_SUBAGENT_MAX_DELEGATIONS_PER_HOUR` limits the reviewer to `10`
      and the implementer to `6` delegations in a rolling one-hour window per
      process, counting failed and cancelled runs and resetting on restart.
    - `CODEX_SUBAGENT_MAX_BACKGROUND_JOBS=2` caps background jobs in each
      registration (valid values 1 to 8, default 8).

    Values are explicit even when they equal a default, so a future default
    change needs a pull request to affect these registrations. An invalid
    value leaves the server running: `codex_doctor` lists the errors, and every
    tool that reaches the Codex CLI except `codex_doctor` refuses calls until
    the environment is fixed and the server restarts. This includes
    `list_codex_models` and `codex_recommend`, which the installer allows
    without a prompt.
    Use `codex_usage` to recalibrate the delegation and job ceilings after
    enabling the usage log with `CODEX_SUBAGENT_USAGE_LOG=on` in the personal
    overlay; the shipped registrations leave logging off.
    The installer derives their permissions and guard matcher from this file
    (ADR 0017), recognizing the package in a
    command or argument under any registration name.
    `retired-mcp-servers.json` lists registrations it removes.
  - `hooks/`: `guard-git.mjs` (no commit or push on main, no `--no-verify`,
    confirmation before remote Supabase actions, oracle tags created with
    confirmation, deletion or moves asking in the main session and denied for
    subagents and bypassPermissions, and the merge decision: squash
    only, never `--admin`, and a pull request is merged without a prompt only
    when its checks passed, it touches no control-plane path, the local copy
    holds nothing missing from the pull request's head, and the
    authenticated `gh` user opened it from a branch in the base repository, not
    a fork, ADR 0024. It compares the pull request's head with the remote
    `oracle/<head branch>` tag: changed tests, `atdd` without a tag, or an
    unreadable oracle ask in the main session and deny in bypassPermissions
    (ADR 0030). A proposed ADR record merged together with paths outside the
    ADR directories asks in the main session and is denied in
    bypassPermissions unless the pull request carries `experiment`
    (ADR 0035); and for a subagent's call, no `git push` and only
    read-only `gh` commands, ADR 0013), `guard-readonly.mjs` (the researcher's
    closed list of shell reads; denies writes, execution and unread forms, and
    fails closed), `commands.mjs` (command knowledge shared by both guards),
    `controlplane.mjs` (those paths), `guard-tests.mjs` (asks before amending
    frozen acceptance tests in the main session; denies subagents and
    bypassPermissions, for Edit, Write, NotebookEdit and common Bash writes,
    ADR 0033), `shell-writes.mjs` (reads those shell forms without executing
    them). The freeze binds while an `oracle/<branch>` tag exists, and in a
    linked worktree while an oracle tag's commit is an ancestor of HEAD.
    The remaining hooks are `oracle-check.mjs` (the
    deterministic pre-PR check of the oracle), `proposed-adr-check.mjs` (the
    pre-PR check that `pr-prep` runs for a proposed ADR shipped with other
    paths), `proposed-adr.mjs` (its rule, shared with the merge decision),
    `guard-codex.mjs` (Codex delegations pass `working_dir`, a worktree delegation starts from a clean
    directory, and a writing call of any declared Codex registration runs in a Codex
    worktree), `codex-integrate.mjs` (applies a Codex worktree's changes to the
    work branch, refusing all changes when frozen test paths are touched;
    otherwise runs `oracle-check` and removes the worktree) and `codex.mjs`
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
  See [Personalization](docs/personalization.md) for effort, language, git
  context and attribution settings.
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

Requires Node 22.2.0 or later and Claude Code 2.1.295 or later. Older versions of
Claude Code ignore the `onFailure` setting that blocks a merge when its guard
does not finish, and `--check` reports an older `claude` on `PATH`.

```bash
cp personal/preferences.example.md personal/preferences.md
cp personal/settings.example.json personal/settings.json
cp personal/mcp-servers.example.json personal/mcp-servers.json
node scripts/install.mjs --check
node scripts/install.mjs
```

This installs whatever the checkout holds. To install a release, check out its tag first
([docs/releasing.md](docs/releasing.md#installing-a-release)).

The personal files are optional: edit them to your own preferences first.
`CODEX_BIN` and `CODEX_SUBAGENT_USAGE_LOG` overrides in the MCP example are
optional: `CODEX_BIN` selects the Codex CLI path and must not be left empty,
because an empty value is used as is; `CODEX_SUBAGENT_USAGE_LOG` accepts `on`
or `off`. The local usage log is off unless set to `on` in the personal
overlay; the shipped registrations do not set it. Both registrations share
the log, and recalibrating the ceilings with `codex_usage` needs logging on.
The log lives in `XDG_STATE_HOME/codex-subagent-mcp` only when `XDG_STATE_HOME`
is an absolute path. Otherwise it uses
`~/Library/Application Support/codex-subagent-mcp` on macOS,
`~/.local/state/codex-subagent-mcp` on other POSIX systems, or
`LOCALAPPDATA/codex-subagent-mcp` on Windows.
`CODEX_HOME` is Codex's own configuration directory variable, also read by
`guard-codex`.

The check reports what would change without writing anything. Installing copies
files (never links them), merges `settings.json` keeping existing user settings
except retired rules and reconciling the derived Codex permissions, backs up
whatever it overwrites or removes in JSON bundles under
`$XDG_STATE_HOME/claude-atdd-workflow/backups/` (or
`~/.local/state/claude-atdd-workflow/backups/` when unset or relative), and removes
files it installed earlier but no longer ships. It keeps the latest 10 bundles
per target; `--keep-backups <n>` changes that limit. `--list-backups` lists them
and their location; `--restore <stamp>` restores one for its target after saving
what it overwrites, keeping the restored bundle and that new one during retention,
so the restore can be repeated and undone. Legacy backups are migrated once and exempt from retention.
Empty legacy directories are removed without a bundle; migration removes
`.DS_Store` and leaves other loose files in place, reporting them as not backups
during installation and `--check`. Symlinks inside legacy backups are reported
and skipped; a symlink or regular file at the legacy root is reported as not
migratable and left untouched. Malformed bundle files are skipped with a warning
and never removed by retention; one blocking a legacy directory leaves that
directory in place and the install exits non-zero while other directories migrate.
Atomic writes replace symlinks at planned files and the manifest with regular
files, leaving their former targets untouched and saving resolved content in
the bundle. Only `settings.json` keeps a resolving symlink and updates its real
path atomically; a dangling settings link is replaced by a regular file.
Settings are written before retired files are removed, and the new manifest is
written before the legacy one is removed.
An install refuses differing files it does not manage with exit 2; `--adopt`
backs them up and takes them over. It also registers the
declared MCP servers through the `claude` CLI, never by writing `~/.claude.json`,
replacing a registration that differs (the old one is saved in the bundle)
and removing a retired one. After successful additions or replacements, it
prewarms the npx cache once per distinct Codex package with
`npx --prefer-online -y <package spec>`, closed standard input and a 60-second
timeout; a failed prewarm is reported without failing the install.
Unchanged registrations and `--check` do not prewarm.
This refreshes the package document before later offline-first starts; see
the [network probe](docs/experiments/2026-10-23-codex-subagent-mcp-060-npx-probes.md).
A Claude Code session that is already open keeps the old server process until
it reloads. Without `claude` on `PATH`
the servers are reported as not verified, and the check exits 1. Run the check
again at any time to detect drift.

Each declared Codex registration allows only the six no-quota tools
`codex_doctor`, `list_codex_models`, `codex_recommend`, `codex_job_result`,
`codex_job_cancel` and `codex_usage`, which only reads the local usage log;
delegation, follow-up and job status require permission.
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
are, and the tokens Codex used per model and effort. It reads `$CLAUDE_CONFIG_DIR/projects`, or
`~/.claude/projects` without that variable; `--dir <projects>` reads another directory. `--since YYYY-MM-DD`
counts only records from that UTC day on, `--json` prints one JSON document and `--verbose` adds one row per
delegation. `--rates <file>` adds credits from a JSON table of credits per million input, cached and output
tokens per model; `input` applies to uncached input tokens only:

```json
{ "gpt-6.1-sol": { "input": 100, "cached": 10, "output": 500 } }
```

A missing or unreadable transcript directory or rate table is an error. Below the directory, a file or folder
it cannot read is skipped and counted: always on a text line, and with `--json` in a note on stderr when any
was skipped. A Codex result whose turn usage the server reports as unknown is not counted. It writes nothing
and is not part of the metrics donation.

## License

MIT. See [LICENSE](LICENSE).
