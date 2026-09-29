# 0001. Separate generic, personal and repository configuration

- Status: accepted
- Date: 2026-09-29

## Context

User-level Claude Code configuration applies to every project on the machine,
while a repository is cloned, shared and worked on by other people and other
agents. Before this repository, the most mature workflow (pre-PR checks, Codex
review, ADR scaffolding, hooks) lived inside a single project, other projects
reinvented parts of it, and personal preferences (response language,
screen-reader formatting) were copied into several `CLAUDE.local.md` files and
auto-memory entries.

Claude Code loads user rules before project rules, and when they conflict it may
follow either one (VERIFIED, official memory documentation). A personal skill
also wins over a project skill with the same name (VERIFIED, official skills
documentation).

This repository may become public, so personal preferences must not travel
with it.

## Decision

Configuration lives in exactly one of three places, by who needs it:

1. **Generic** (`global/`, versioned, installed into `~/.claude`): workflow
   defaults that apply to anyone and any project, safety hooks, generic skills.
2. **Personal** (`personal/`, ignored by git except for `*.example.*`
   files): the installer's own preferences. `preferences.md` is installed as
   `~/.claude/rules/personal.md`, a user rule without `paths` that always loads;
   `settings.json` is merged over the generic settings.
3. **Repository** (inside each project): everything the project needs to be
   worked on correctly by anyone, including its conventions, verify command,
   invariants and the critical rules of its stack. A repository never depends
   on this one to be correct.

Stack knowledge in this repository exists only as templates that
`repo-bootstrap` copies into a project. There are no user-level rules per
stack.

## Alternatives considered

- **User-level path-scoped rules per stack** (for example Supabase security
  rules under `~/.claude/rules/`). Rejected: a repository would silently depend
  on the machine that works on it, and a collaborator or another agent would not
  get rules that are critical to that project.
- **Personal preferences imported with `@path` from the global `CLAUDE.md`.**
  Rejected: the behaviour of an import whose target is missing was not
  verified, while a user rule file either exists and loads or does not.
- **Keeping personal preferences in the versioned files.** Rejected: they
  would be published if the repository becomes public.

## Consequences

- Critical rules are duplicated across repositories on purpose. Drift is
  handled by the `drift-audit` skill comparing projects against the templates.
- The global `CLAUDE.md` restates repository conventions only as defaults, and
  says that a repository's own convention wins. Both must stay consistent.
- Personal files are not backed up by this repository.
