---
status: proposed
date: 2026-10-29
---
# 0034. Guard high-consequence gates by consequence, not by form

- Amends:
  - [0002](0002-enforce-with-hooks-permissions-and-ci.md) (its consequence that hooks fail open when they cannot decide)
  - [0010](0010-move-human-control-to-the-specification-and-gate-merges.md) (its consequence that `guard-git` allows a form it cannot read)
  - [0013](0013-guard-git-keeps-subagents-off-github.md) (its consequence that the guard allows a form it cannot read, and that a wrapper with nothing in it that acts on GitHub gets no verdict)
  - [0032](0032-reorient-the-workflow-into-a-toolbox-the-human-directs.md) (the restated invariant: the hooks allow a form they cannot read)
  - [0033](0033-ask-before-amending-a-frozen-test-in-the-main-session.md) (its rule that a command the reader cannot evaluate gets no verdict)

## Context

The hooks read a command as words and allow a form they cannot read. The root
`CLAUDE.md` states it as an invariant, restated by ADR 0032 from ADR 0002;
ADR 0010 and 0013 repeat it for `guard-git`. Only two places differ: the merge
decision asks when it cannot read the pull request (ADR 0010, 0030), and
`guard-readonly` denies what it cannot read.

Every review of the hooks has found new forms that escape them:

- A-8 (2026-10-26), a fresh review of the A-4 and A-7 fixes: 24 records,
  among them `git -c alias.zz='tag -d' zz oracle/y`, which deletes an oracle
  tag with no verdict, and `GIT_DIR=` or `--git-dir`, which make the hook read
  another repository.
- The second review of A-9: 5 records.
- Experiment E3a of M-6
  (`docs/experiments/2026-10-28-model-calibration-claude.md`, section "New
  defects found in E3a"), verified against `main` at 9239cb6: 6 defects.
  `gh constructor; gh pr create -f` from a subagent gets no verdict, because
  `ghIsRead` throws a TypeError on an `Object.prototype` name
  (`global/hooks/commands.mjs:72`) and `failOpen` drops the denials already
  collected (`global/hooks/guard-git.mjs:948`). `env`, `&`, a subshell or a
  quoted assignment in front of `gh pr merge` reaches no merge decision, also
  with `--merge-only`, against the rule that the merge asks when it cannot
  read. `git push origin HEAD` on `main` and `git push --mirror` get no
  decision, also in `bypassPermissions`. A backslash continuation hides the
  rest of a commit, and `git -c core.hooksPath=/dev/null commit` skips hooks.
- The three reviews of A-10 (ADR 0033): about 36 records, most of them forms
  the Bash reader of `guard-tests` did not read.

Each round reads the forms it was shown, and the next round finds others. The
grammar of a shell is open: a prefix program, a substitution, an interpreter
or an alias can put any command behind words the hook does not parse. Reading
more forms does not converge, and while a form at a gate is allowed, the
promise the gate makes holds only for the forms someone thought to test.

Principle 8 of ADR 0032 sets what the hooks are for: they limit what the agent
does on its own; in the main session they ask with evidence; for subagents and
in `bypassPermissions` they deny; the threat is the agent's error or shortcut,
not an attacker; and a question is asked only where the consequence is real.
Whether a hook's `ask` prompts in `bypassPermissions` is still not verified
(ADR 0029); the experiment belongs to A-6 and the human runs it.

A scan of the Bash commands in the local Claude Code transcripts of this
machine, 2026-09-11 to 2026-10-29 (9,168 from main sessions and 3,352 from
subagents), measured what the alternatives would cost:

- 31% of the main-session commands and 11% of the subagent commands hold at
  least one construct the hooks do not read today (a substitution, a heredoc,
  a subshell or brace group, `&`, a backslash continuation, a shell string, a
  prefix such as `env` or `xargs`, or a quoted assignment).
- Counting only commands where such a construct, or a non-literal word, is
  attached to a gate command (a merge, a push, an oracle tag change or a
  skipped hook), the figure falls to 80 main-session commands (0.9%) and 3
  subagent commands (0.1%). The scan approximates the reader with regular
  expressions and does not read substitutions recursively, so it is an upper
  bound. Most hits were a variable in a merge or push value (`$SHA`, `-C $R`)
  and backticks inside a double-quoted `gh` body, which the shell runs.

## Decision

### The rule

1. At a high-consequence gate, a form the guard cannot read gets a verdict
   instead of none: in the main session it asks; for a subagent (an event with
   `agent_id`) and in `bypassPermissions` it is denied. The reason names the
   gate, says which part of the command was not read, and shows the canonical
   form that the guard reads. The main session asks even where the canonical
   form is denied, such as a push to `main` or `--admin`: the guard does not
   know that the unread command is that form, and the human sees the command.
2. Everywhere else a form the guard cannot read is still allowed, with no
   verdict, as today.
3. A form the guard reads keeps the decision its own ADR gives it. This record
   changes nothing for read forms.
4. The deny in `bypassPermissions` follows ADR 0029 and changes only with a
   record that rests on the A-6 experiment.

### Classifying a gate

A gate is high-consequence when both hold:

- a guard already decides its canonical form with `deny` or `ask`, so a
  decision exists to protect; and
- the action, taken by the agent on its own, cannot be undone from the
  session because it changes shared state that others or a later merge rely
  on, turns off a control the human relies on, or takes a decision that
  belongs to another party (approving an oracle belongs to the human; acting
  on GitHub belongs to the orchestrator, not a subagent).

A guarded action that fails the second test stays outside: committing on
`main` (local, undone with a reset), force-pushing a work branch (asks today,
recoverable from the reflog) and deleting a remote work branch after its merge.
An action that no guard decides today, such as publishing a release, is not a
gate; it needs its own decision first. Adding or removing a gate needs a new
record.

### The gates

| Gate | Guard | Covers |
| --- | --- | --- |
| Merge | `guard-git` | `gh pr merge` by any path or prefix, with `--admin`, non-squash methods and `--auto`; a `gh api` call that is not a read and names a pull request merge (`/merge`, `mergePullRequest`) |
| Push to a protected branch | `guard-git` | any push whose target is or can be `main`, `master` or the remote's default branch: an explicit refspec, `HEAD` or `@` while on it, no refspec while on it, `--all` and `--branches` |
| Wholesale ref rewrite | `guard-git` | `git push --mirror` and `git push --prune` |
| Oracle tags | `guard-git` | creating, deleting or moving an `oracle/*` tag, locally or on a remote, through `git tag`, `git update-ref` (`--stdin` included), `git push` refspecs and `git fetch` (`--prune-tags`, forced tag refspecs) |
| Skipped hooks | `guard-git` | `commit` or `push` with `-n` in any cluster, `--no-verify` or an abbreviation of it, and `-c core.hooksPath` or a `GIT_CONFIG_*` variable that sets it |
| Frozen tests | `guard-tests` | writing, moving or deleting a frozen test path or a test-configuration path (ADR 0033) |
| GitHub actions of a subagent | `guard-git` | for a subagent only: any `gh` command off the read-only list and any `git push` (ADR 0013); opening a pull request is one of them |
| Remote Supabase actions | `guard-git` | `supabase db push`, `link`, `functions deploy`, `secrets set` or `unset`, `db reset --linked`, `migration repair`, and `--linked` or `--db-url` |

`gh pr create` from the main session is not a gate: the orchestrator opens
pull requests (ADR 0010). The Supabase row follows from the rule: the guard
asks today, and a remote database change cannot be undone from the session.

### What "not read" means

A command reaches a gate when its raw text, quoted strings included, holds the
gate's trigger words:

- merge: the word `gh` and `merge` or `mergePullRequest`;
- push, wholesale rewrite: `git` and `push`;
- oracle tags: `git` and one of `oracle`, `refs/tags`, `tag`, `update-ref`,
  `--prune-tags`, `--mirror` or `alias.`;
- skipped hooks: `--no-v`, `hooksPath` in any case, `core.hooks`, or `commit`
  followed by a short-option cluster holding `n`;
- frozen tests: a frozen path, a directory holding one, or a test-configuration
  path of the oracle commit;
- subagent GitHub actions: `gh`, or `git` and `push`;
- Supabase: `supabase`.

Text that the reader proves to be data is removed first: the body of a heredoc
with a quoted delimiter that `cat` or `tee` writes to a file, and the value of
a message option (`-m`, `--message`, `--title`, `--body`, `--subject`),
including Claude Code's own `"$(cat <<'EOF' ... EOF)"` form.

A command that reaches a gate is not read when any of these holds:

1. The guard threw, or ran out of its own time or CPU budget, while deciding.
   The TypeError of `gh constructor` is the first case.
2. The gate's command sits inside a construct outside the grammar the guard
   implements. Today that is: a command substitution or backticks; a subshell
   or brace group; a function body; a background `&`; a shell or interpreter
   string (`bash -c`, `sh -c`, `zsh -c`, `eval`, `python -c`, `node -e`, a
   heredoc fed to an interpreter); a word before `git`, `gh` or `supabase`
   that is not an unquoted assignment and that the guard does not strip
   (`env`, `command`, `exec`, `xargs`, `sudo`, `nohup`, `time`, `nice`,
   `timeout` and any unknown word); a backslash-newline continuation; or an
   assignment whose value is quoted (`FOO="a b" gh ...`).
3. A word the gate's decision depends on is not a literal: it holds `$`, a
   backtick, a glob character the guard does not expand, or a quote inside the
   word. Examples are a refspec `$B`, `git -C $R push`, or a pull request
   selector `$N`. A word the decision does not read, such as a `--subject` or
   a `--match-head-commit` value, does not count.
4. The command names a context the guard does not resolve: `--git-dir`,
   `--work-tree`, `GIT_DIR`, `GIT_WORK_TREE`, `GH_REPO`, `GH_HOST`,
   `git -c alias.*`, a git subcommand that is not built into git (an alias),
   or `update-ref --stdin`.

The guard may widen its grammar, for example by stripping `env` and its
assignments or by reading a substitution recursively with the same grammar.
A widened construct counts as read only with a test that pins it. A form the
guard reads but reads wrongly, such as an unexpanded `~` in `git -C ~/repo`,
is a defect fixed with its own test, not an unread form.

### How the guards apply it

- The trigger runs in the entry that sees every Bash command. No gate depends
  on an entry's `if` to start, because an `if` reads the command as words too.
- An exception keeps the verdicts collected before it. If the raw command
  reaches a gate, the guard adds the gate's ask or deny; if not, it fails open
  with a visible message, as today.
- The merge decision keeps its own entry, which fails closed when the hook
  cannot start (ADR 0010, 0030).
- `guard-git` applies the rule to the merge, push, wholesale rewrite, oracle
  tag, skipped hooks, subagent and Supabase gates. `guard-tests` applies it to
  frozen tests: a reader failure or one of the constructs of point 2 that
  names a frozen or test-configuration path asks or denies. An unknown plain
  program that names a frozen path stays allowed, because the vocabulary of
  programs that only read or run tests is open and the merge decision compares
  the pull request with the oracle tag (ADR 0030).

### The invariant from this record on

If the human accepts this record, the invariant in the root `CLAUDE.md` reads,
in the same pull request:

> The hooks are a safety net for one machine that limits what the agent does
> on its own, not a boundary: they read a command as words. At the
> high-consequence gates of ADR 0034 (merge, push to a protected branch,
> `push --mirror` and `--prune`, oracle tags, skipped hooks, frozen tests,
> GitHub actions of a subagent and remote Supabase actions) a form they cannot
> read asks in the main session and is denied to subagents and in
> `bypassPermissions`; elsewhere they allow it. `guard-readonly` denies a form
> it cannot read.

The rest of that bullet, on human review at the gates that are already human
and on CI and rulesets, is unchanged. On acceptance, the front matter of ADRs
0002, 0010, 0013, 0032 and 0033 records "amended by 0034"; their bodies stay as
written.

## Alternatives considered

- **Keep allowing every unread form.** Rejected: four reviews in a row found
  new forms, and E3a found forms that contradict invariants the workflow
  states (a subagent opens a pull request, a merge passes with no decision,
  `--mirror` force-updates `main` and `oracle/*`). Chasing forms one by one
  does not converge.
- **Ask or deny by consequence at the gates (chosen).** It closes the class at
  the places where an escape is costly and leaves the rest untouched. Its cost
  is a few more questions near the gates: at most 0.9% of main-session
  commands and 0.1% of subagent commands in the scan, before A-6 widens the
  grammar.
- **Deny every unread form.** Rejected: 31% of main-session commands and 11%
  of subagent commands hold a construct the hooks do not read, almost all of
  them unrelated to any gate. Denying them would stop ordinary work, and in
  the main session it would block what the human decides, against principle 8.
  Asking on all of them instead would wear the human's judgement into an
  automatic yes.
- **An allowlist of read forms for every command**, as `guard-readonly` does
  for the researcher. Rejected for the main session and the implementer:
  their commands are open-ended, unlike the researcher's read-only needs. At
  the gates the chosen rule is this allowlist, scoped: the grammar is the list
  of read forms, and anything outside it asks or is denied.
- **A full shell parser in the hooks.** Not chosen as the decision: it narrows
  the unread set but cannot remove it, since aliases, variables, scripts and
  interpreters resolve only at run time, and the hooks carry no dependencies
  today. A-6 may still use a better parser inside the grammar.

## Consequences

- The class of unread forms at the gates closes as a class. The E3a defects
  (`gh constructor`, `env`, `&`, subshells and quoted assignments before a
  merge or `gh pr create`, `push HEAD` on `main`, `--mirror`, the backslash
  continuation and `core.hooksPath`) and the forms that A-6 had left outside
  (`fetch --prune-tags`, `push --mirror` and `--prune`, `update-ref --stdin`,
  `bash -c`, `git -c alias.*`) all fall under the rule.
- The agent gets more questions, or denials as a subagent, when it writes an
  unusual form near a gate. The reason shows the canonical form, so the usual
  fix is to rewrite the command. In `bypassPermissions` those forms are denied
  until the A-6 experiment says whether an `ask` prompts there.
- A-6 carries the implementation: tests first, then the fix, in its own pull
  request with a human merge. Its criteria 10 to 13 become instances of this
  rule; it adds tests for each construct of points 1 to 4 at each
  `guard-git` gate, for the exception that keeps collected verdicts, for the
  trigger running in the entry that sees every command, and for the Supabase
  gate. Its criteria 1 to 9 are defects in read forms and stay as they are.
- A-12 carries the `guard-tests` part, since it already holds the pending work
  on that reader: a reader failure, or a construct of point 2 that names a
  frozen path, asks or denies.
- Named gaps that remain, by design or because no hook sees them:
  - an alias defined in a git configuration file (`git p` for `git push`), a
    script, a Makefile or a package script that runs a gate command, and
    `curl` or any other client that holds the token;
  - tools other than Bash, such as a GitHub MCP server that merges or pushes;
  - Codex commands, which no Claude Code hook sees; its sandbox ceilings
    (ADR 0028) and `guard-codex` limit it, unchanged by this record;
  - a hook that cannot start or times out in Claude Code: the entry that sees
    every command still fails open, and only the merge entry blocks;
  - in `guard-tests`, an unknown plain program that names a frozen path, with
    the merge decision's oracle comparison as the backstop;
  - trigger words in text the reader cannot prove is data, which can ask or
    deny a harmless command, for example a commit message held in a variable
    that names `merge`.
- The scan behind the cost figures is a regular-expression approximation run
  once on one machine. A-6 measures again on the implemented rule and reports
  the share of commands that ask.
