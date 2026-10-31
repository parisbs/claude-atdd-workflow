# claude-atdd-workflow

Versioned user-level configuration for Claude Code, plus the templates that bring a repository into an
agent-assisted workflow with human-approved acceptance tests. It is edited here and installed into
`~/.claude`; the installed copies are never the source.

## Commands

- Verify: `npm test`
- Narrow runs while a change stays in one area. `npm test` still runs before a pull request, and after any
  change to instructions, skills, agents or templates, which tests in several areas read.
  - `npm run test:hooks`: `global/hooks/`.
  - `npm run test:install`: `scripts/install.mjs` and the JSON files in `global/`.
  - `npm run test:adr`: `scripts/check-adrs.mjs`, `scripts/migrate-adrs.mjs` and `docs/adr/`.
  - `npm run test:metrics`: `scripts/metrics-*.mjs`, `.github/` and the README section on donating metrics.
- Install: `node scripts/install.mjs`; `--check` reports drift and writes nothing. Run it after changing
  anything under `global/` or `personal/`.
- Delegation report: `node scripts/metrics-delegations.mjs`, to measure a change to delegation before and after
  it.

## Invariants

- Instructions live in this `CLAUDE.md` alone. There is no `AGENTS.md`: a delegate would load it into every
  run, adding obligations the orchestrator did not ask for (ADR 0012).
- Never edit the installed copies in `~/.claude`. Change the repository on a branch, then install. The
  installer copies and never links, because Cowork sessions skip a symlinked `~/.claude/CLAUDE.md`
  (ADR 0001).
- What must always hold is a hook, a permission rule or CI; prose is for judgement (ADR 0002).
  A guard that throws while deciding a command that reaches a high-consequence gate of ADR 0034 asks or
  denies instead; a hook that cannot start or times out still fails open. Hooks fail
  open with a visible message, except the merge decision, which fails closed: it asks when it cannot read the
  pull request (ADR 0010) and denies in `bypassPermissions` (ADR 0030), and its own entry in `global/settings.json` blocks the merge when the hook cannot
  start, fails or times out (`onFailure: "block"`, Claude Code 2.1.295 or later). Claude Code also runs that
  entry for commands its `if` cannot rule out, so the entry starts the hook only when the command can be a
  merge. A hook failure can then block a merge and, at worst, a command whose event holds `merge` (for example
  in its working directory or description), because the gate checks the whole event when it cannot scope the
  check to the command.
  `guard-readonly` is the second exception: it fails closed,
  denying unread events and commands, and its entry in the researcher's frontmatter declares
  `onFailure: "block"` so a call is blocked when the hook cannot start, fails or times out.
- The hooks are a safety net for one machine that limits what the agent does on its own, not a boundary: they
  read a command as words. At the high-consequence gates of ADR 0034 (merge, push to a protected branch,
  oracle tags, release tags, skipped hooks, frozen tests, GitHub actions of a subagent and remote Supabase
  actions) a command that reaches a gate's trigger and that they cannot read asks in the main session and
  is denied to subagents and in `bypassPermissions`; elsewhere they allow it. Two named exceptions remain:
  a hook that cannot start or times out fails open, except the merge entry, and `guard-tests` allows a program
  it does not know. `guard-readonly` denies a form it cannot read. That net, with human review at the gates
  that are already human (the control-plane merge, ADRs and oracle tags), is the workflow's protection
  against the agent. GitHub cannot tell the agent from the human, who share a token, so CI and rulesets are
  tools a human or team applies to themselves, not a guarantee against the agent (ADR 0032, restating ADR 0002
  and 0008).
- A hook that prints `allow` lifts the permission prompt for the whole command, and `Verdict` prints nothing
  for an allow, which means no opinion. Print one only for a command verified end to end, and only when it
  is nothing but that command (ADR 0010).
- Permission lists in `settings.json` merge by union, so a rule that stops shipping stays in every installed
  file until it is listed in `global/retired-permissions.json`.
- One list of control-plane paths serves the merge decision: `global/hooks/controlplane.mjs`, built on the
  test-configuration list of `oracle.mjs`, which the test guard also uses. A new stack's paths go there once.
  The `Human merge:` line below is read from this file on the base branch, so it must be written here and not
  in a file imported from here.
- User skill names never collide with project skills (ADR 0007). Skills that publish or reconfigure stay
  manual; see ADR 0010 for which.
- Hook tests spawn the real hook with a fake `gh` first on `PATH`. They are POSIX-only: CI runs the whole suite
  on Ubuntu and macOS, and only the metrics tests on Windows.

## Conventions

- Git: gitflow branch names (`feature/`, `fix/`, `hotfix/`, `release/`, `chore/`, `docs/`, `refactor/`,
  `test/`), squash merge to `main`.
- Commits and pull request titles: Conventional Commits in English, one line, imperative mood. CI checks the
  pull request title.
- Code, comments and documentation are in English.
- Documentation diagrams use Mermaid and carry a short prose description.
- Decisions that close an alternative are recorded in `docs/adr/`. Records are immutable from the commit on
  `main` where their status becomes accepted or rejected. Proposed records on `main` remain editable drafts;
  a changed decision needs a new record, and superseded records change only in their front matter status.
- A record's status is the `status` field of its YAML front matter (MADR 4, ADR 0020). The one-time migration
  of a legacy record is mechanical: it adds front matter and removes the legacy status and date lines, every
  other line identical, and `scripts/check-adrs.mjs` verifies it.

## Workflow

- Issues carry acceptance criteria as `WHEN ... THEN ...`, numbered `AC-n`. Tests that prove a criterion
  carry its identifier in their name.
- Review: none
- Implement: claude
- Human merge: global/, scripts/, personal/, common/, docs/experiments/donated/, android/, flutter/, node-mcp/, supabase/, tests/
