# 0002. Enforce with hooks, permissions and CI, and guide with prose

- Status: accepted
- Date: 2026-09-29

## Context

Model output is not deterministic, and `CLAUDE.md` is context, not enforced
configuration (VERIFIED, official memory documentation: "To block an action
regardless of what Claude decides, use a PreToolUse hook"). A rule that must
never be broken cannot rest on the model remembering it. See
`docs/research/evidence.md`, sections 2 and 3.

## Decision

Every rule is placed by how much it matters that it always holds:

1. **Must never be violated**: a hook, a permission rule, a CI check or a
   GitHub ruleset. These are deterministic.
2. **Judgement and preferences**: prose in `CLAUDE.md`, `AGENTS.md` or a
   personal rule.
3. **Procedures used some of the time**: skills, which cost context only when
   used.
4. **Facts about a part of a codebase**: path-scoped rules inside that
   repository.

The generator is not made deterministic; the verifier is.

## Alternatives considered

- **Stronger wording in `CLAUDE.md`.** Rejected: adherence improves but is
  never guaranteed, and conflicting instructions are resolved arbitrarily.
- **A model acting as judge** (the approach of TDD Guard). Rejected as the
  primary control: a non-deterministic judge inherits the problem it is meant to
  solve. It remains acceptable as a secondary review.

## Consequences

- User-level hooks are a safety net for one machine. The authoritative
  enforcement of a repository is its CI and its rulesets (ADR 0004).
- Hooks are written in Node, which every supported stack already has, and must
  fail open with a visible message when they cannot decide.
