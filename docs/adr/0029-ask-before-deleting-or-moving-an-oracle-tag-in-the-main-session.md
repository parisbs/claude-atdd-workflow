---
status: accepted, amended by [0032](0032-reorient-the-workflow-into-a-toolbox-the-human-directs.md)
date: 2026-10-23
---
# 0029. Ask before deleting or moving an oracle tag in the main session

- Amends: [0010](0010-move-human-control-to-the-specification-and-gate-merges.md) (moving or deleting an oracle tag is denied)
- Issue: #55

## Context

ADR 0010 makes the `oracle/*` tag the human's approval of the oracle. Creating
one asks; moving or deleting one is denied, through `git tag` and
`git update-ref` alike, so the human runs those commands in a terminal. After
every merge the orchestrator hands the human two commands to remove the tag.

The human now works from remote sessions (Remote Control from a phone or a
browser) that have no terminal. A denied command cannot be approved from
there, so the tags of merged branches pile up until the human is back at the
machine. The `Human only` line of `global/CLAUDE.md` already says the guard
asks for creating, moving or deleting a tag, which is true only for creation.

What Claude Code documents and what was checked (Claude Code 2.1.308):

- A PreToolUse hook's `ask` forces a permission prompt in auto mode; the
  classifier can deny the call but cannot approve it silently.
- Remote Control keeps permission prompts open until they are answered from
  the phone or the web, and Bypass permissions cannot be selected from the app.
- In a `-p` run an `ask` nobody can answer becomes a denial; an experiment
  confirmed it in default and auto mode, and inside a subagent, whose event
  carries `agent_id`.
- Whether a hook's `ask` still prompts in `bypassPermissions` is not
  documented. The list of actions no mode auto-approves names explicit ask
  rules, not hook decisions, and an experiment in that mode was not possible.

Two facts limit what the tag protects. Without the tag `oracle-check` checks
nothing for the branch, and `oracle/*` has no ruleset on GitHub, so deleting
the tag before the merge turns the oracle off silently.

## Decision

- In the main session, deleting or moving an `oracle/*` tag asks instead of
  being denied. It covers `git tag -d` and `-f` (combined flags included),
  `git update-ref` on an oracle tag ref, and `git push` that deletes or forces
  an oracle tag (`:refs/tags/oracle/...`, `--delete`, `+` refspecs, `--force`).
  The action stays human-only: the human decides in the prompt, and the agent
  runs the command only after that approval.
- The question says what is lost. On deletion it says whether the branch's
  pull request is still open, with its URL, and that without the tag
  `oracle-check` checks nothing; when the pull request cannot be read it still
  asks and says why. On a move it names the commit the tag points to and the
  commit it would point to.
- A subagent is still denied: it cannot show the question reliably, and the
  approval belongs to the main session.
- In `bypassPermissions` the main session is still denied, because nothing
  documents that the hook's `ask` prompts there; the reason tells the human to
  switch to a mode that shows prompts.
- Creating a tag is unchanged. Amending a frozen test (`guard-tests`) stays
  denied; whether it should ask is a separate decision.

## Alternatives considered

- Keep the denial (ADR 0010 as is). Rejected: the human cannot remove a tag
  from a remote session, which is now the usual way of working.
- Ask in every mode, `bypassPermissions` included. Rejected: if that mode
  skips the hook's question, a deletion would run with no human decision at
  all, which is weaker than the denial it replaces.
- Ask for subagents too. Rejected: a subagent's question is not shown in
  every session (it becomes a denial in `-p` and background runs), and a
  delegate never needs to touch the oracle.
- Protect `oracle/*` with a tag ruleset on GitHub instead. Rejected for this
  change: it guards only the remote copy, still needs a terminal or the web
  settings to lift, and is a separate decision about rulesets.

## Consequences

- The human can remove or move a tag from any session that shows prompts,
  Remote Control included, by approving the agent's command.
- A deletion approved while the pull request is open turns `oracle-check` off
  for that branch; the question says so, and the decision is the human's.
- `guard-git` reads `permission_mode` from the event; if Claude Code renames
  the field or the mode, the bypass denial stops applying and the deletion
  asks like in any other mode.
- Forms the hook does not read stay unread: `git fetch --prune-tags`,
  `git push --mirror` or `--prune`, `git update-ref --stdin`, and removing
  files under `.git/refs/tags`. CI and the rulesets remain the guarantee
  (ADR 0002).
- ADR 0010 is accepted and frozen; its sentence "Moving or deleting one is
  denied" stays as written. Once this record is accepted, ADR 0010's status
  gains the annotation `amended by 0029`.
