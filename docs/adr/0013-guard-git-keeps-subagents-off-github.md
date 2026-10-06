# 0013. Let guard-git keep subagents off GitHub

- Status: accepted
- Date: 2026-10-05
- Amends: [0011](0011-delegate-through-subagents-interchangeable-with-codex.md)

## Context

ADR 0010 puts "subagents never act on GitHub" in the first action class: a
subagent reads, edits, commits on the work branch and runs tests, and the
orchestrator pushes, opens pull requests and merges. ADR 0011 planned to enforce
it in the agent file, with `disallowedTools` listing the `gh` commands that act
on GitHub. That does not work: a `Bash(...)` entry in `disallowedTools` removes
the whole shell from the subagent, so an implementer could no longer run its
tests.

Nothing else in a subagent file can carry the restriction, and the rule is
prose until something enforces it. A PreToolUse hook can: the event of a tool
call made by a subagent carries `agent_id` and `agent_type`, and the event of a
call from the main session carries neither. PreToolUse hooks from the settings
fire for subagent tool calls (ADR 0011).

## Decision

`guard-git` enforces the rule for any Bash call whose event carries `agent_id`.
For such a call it denies:

- `git push` in any form: with flags or refspecs, after `git -C dir` or
  `git -c key=value`, through an absolute path such as `/usr/bin/git`, after an
  environment assignment, and anywhere in a chain;
- every `gh` command that is not on the read-only list below, also through an
  absolute path such as `/opt/homebrew/bin/gh`;
- a shell wrapper (`bash -c`, `sh -c`, `zsh -c`, `eval`) whose string runs `gh`
  or `git push`, even when what it runs is a read.

The read-only list, the only `gh` commands a subagent may run:

- `pr` and `issue` with `view`, `list`, `diff`, `checks` or `status`;
- `run` with `view`, `list` or `watch`;
- `repo view`, `label list`, `release view` or `list`, `workflow view` or
  `list`, and `search ...`;
- `auth status` without `-t` or `--show-token`, which print the token;
- `--version`, `help` and `--help`;
- `gh api` only as a plain GET: no `-X` or `--method` other than `GET`
  (attached forms such as `-XDELETE` and `--method=DELETE` included), and none
  of `-f`, `-F`, `--field`, `--raw-field` or `--input`.

Everything else is denied, so a new `gh` command stays denied until it is added
to the list. A read on the list gets no verdict from this rule: the hook prints
nothing, never an explicit `allow`. A subagent's `gh` never reaches the merge
decision of ADR 0010, so `gh pr merge` from a subagent is denied even when the
same merge would be an explicit `allow` for the orchestrator. Every denial
reason names the subagent rule. An event without `agent_id` is decided exactly
as before.

The Delegation section of `global/CLAUDE.md` says that `guard-git` enforces the
rule. This record amends ADR 0011 where it puts the `gh` restriction in
`disallowedTools` of the implementer's file; its other decisions stand.

## Alternatives considered

- **List `gh` in `disallowedTools` of the agent files (ADR 0011).** Rejected: a
  `Bash(...)` entry there removes the whole shell from the subagent, not one
  command, so the implementer could not run tests or commit.
- **A denylist of the `gh` commands that write.** Rejected: `gh` grows, and a
  new command that writes would be allowed until someone noticed. An allowlist
  fails closed for what it does not know.
- **Deny every `gh` command to subagents.** Rejected: an implementer or a
  researcher legitimately reads a pull request, its checks or an issue, and the
  orchestrator would have to relay all of it.
- **Rely on prose in the Delegation section alone.** Rejected by ADR 0002: what
  must always hold is a hook, a permission rule or CI.
- **A second GitHub identity without write access for subagents.** Not
  available: subagents run with the developer's token (ADR 0010).

## Consequences

- `gh api graphql` is denied to subagents, because a mutation looks like a
  query to a hook that reads words; a subagent that needs GraphQL asks the
  orchestrator.
- A shell wrapper that runs `gh` or `git push` is denied even for a read; a
  subagent runs the plain command instead. A wrapper with nothing in it that
  acts on GitHub gets no verdict.
- Only a non-empty `agent_id` string marks a subagent. If Claude Code stops
  sending it, or sends it to the main session, the rule goes silent or applies
  to the orchestrator; the tests that spawn the hook with and without it pin
  the current shape.
- The guard reads a command as words and allows a form it cannot read (ADR
  0002, 0008). A script that hides a `gh` call, `curl` or any other client with
  the token, `xargs gh` and tools other than Bash are out of its reach. It is a
  safety net; the rulesets on GitHub remain the guarantee.
- Words split on shell operators inside quotes can produce a false positive,
  for example a commit message that contains `; gh issue create`. The denial
  names the rule, and the subagent rephrases.
- A read-only `gh` command a subagent needs is denied until it is added to the
  list in `guard-git`.
