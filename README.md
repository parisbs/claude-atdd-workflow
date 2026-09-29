# claude-workflow

Versioned user-level configuration for Claude Code, plus the templates that
bring a repository into an agent-assisted workflow with human-approved
acceptance tests.

## Layout

- `global/`: generic configuration installed into `~/.claude`. Nothing in it
  is specific to one person or one project.
  - `CLAUDE.md`: workflow defaults (git, pull requests, reviews, task levels).
  - `settings.json`: read-only permissions, `gh pr merge` behind a
    confirmation, built-in git instructions off, hook wiring.
  - `hooks/`: `guard-git.mjs` (no commit or push on main, no `--no-verify`,
    squash-only merges without `--admin`, confirmation before remote Supabase
    actions, oracle tags protected), `guard-tests.mjs` (frozen acceptance tests
    while an `oracle/<branch>` tag exists) and `oracle-check.mjs` (the
    deterministic pre-PR check of the oracle).
  - `skills/`: `issue-draft`, `atdd-oracle`, `atdd-implement`, `adr-draft`,
    `pr-prep`, `drift-audit`, `release-prep` and `repo-bootstrap`. Their names
    never collide with project skills (ADR 0007).
- `personal/`: the installer's own preferences. Only `*.example.*` files are
  versioned. `preferences.md` becomes `~/.claude/rules/personal.md`;
  `settings.json` is merged over the generic settings.
- `common/`: templates every repository receives through `repo-bootstrap`:
  `AGENTS.md` and `CLAUDE.md` skeletons, issue and pull request templates, the
  pull request title check, labels and GitHub rulesets.
- `android/`, `flutter/`, `node-mcp/`, `supabase/`: per-stack verify
  commands, test paths and the rules a repository of that stack should carry.
- `scripts/install.mjs`: the installer.
- `docs/`: the decisions (`adr/`), the roadmap and the research behind them.

## Install

Requires Node 22 or later.

```bash
cp personal/preferences.example.md personal/preferences.md
cp personal/settings.example.json personal/settings.json
node scripts/install.mjs --check
node scripts/install.mjs
```

The personal files are optional: edit them to your own preferences first. The
check reports what would change without writing anything. Installing copies
files (never links them), merges `settings.json` keeping anything already
there, backs up whatever it overwrites to `~/.claude/backups/claude-workflow/`,
and removes files it installed earlier but no longer ships. Run the check again
at any time to detect drift.

## Workflow in short

Every repository stays self-sufficient: its `AGENTS.md` carries its
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
