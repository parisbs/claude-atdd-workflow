# claude-workflow

Versioned user-level configuration for Claude Code, plus the templates that bring a repository into an
agent-assisted workflow with human-approved acceptance tests. It is edited here and installed into
`~/.claude`; the installed copies are never the source.

## Commands

- Verify: `npm test`
- Install: `node scripts/install.mjs`; `--check` reports drift and writes nothing. Run it after changing
  anything under `global/` or `personal/`.

## Invariants

- Instructions live in this `CLAUDE.md` alone. There is no `AGENTS.md`: a delegate would load it into every
  run, adding obligations the orchestrator did not ask for (ADR 0012).
- Never edit the installed copies in `~/.claude`. Change the repository on a branch, then install. The
  installer copies and never links, because Cowork sessions skip a symlinked `~/.claude/CLAUDE.md`
  (ADR 0001).
- What must always hold is a hook, a permission rule or CI; prose is for judgement (ADR 0002). Hooks fail
  open with a visible message, except the merge decision, which asks when it cannot read the pull request
  (ADR 0010).
- The hooks are a safety net for one machine, not a boundary: they read a command as words and allow a form
  they cannot read. The repository's CI and rulesets are the guarantee (ADR 0002, 0008).
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
- Hook tests spawn the real hook with a fake `gh` first on `PATH`. They are POSIX-only, like the CI matrix
  (Ubuntu and macOS).

## Conventions

- Git: gitflow branch names (`feature/`, `fix/`, `hotfix/`, `release/`, `chore/`, `docs/`, `refactor/`,
  `test/`), squash merge to `main`.
- Commits and pull request titles: Conventional Commits in English, one line, imperative mood. CI checks the
  pull request title.
- Code, comments and documentation are in English.
- Documentation diagrams use Mermaid and carry a short prose description.
- Decisions that close an alternative are recorded in `docs/adr/`. Records are immutable once merged to
  `main`: a changed decision is a new record that supersedes the old one, which changes only in its status
  line.

## Workflow

- Issues carry acceptance criteria as `WHEN ... THEN ...`, numbered `AC-n`. Tests that prove a criterion
  carry its identifier in their name.
- Review: none
- Implement: claude
- Human merge: global/, scripts/, personal/, common/
