---
status: accepted
date: 2026-10-29
---
# 0034. Guard high-consequence gates by consequence, not by form

- Amends:
  - [0002](0002-enforce-with-hooks-permissions-and-ci.md) (its consequence that hooks fail open when they cannot decide)
  - [0010](0010-move-human-control-to-the-specification-and-gate-merges.md) (its consequence that `guard-git` allows a form it cannot read)
  - [0013](0013-guard-git-keeps-subagents-off-github.md) (its consequence that the guard allows a form it cannot read, and that a wrapper with nothing in it that acts on GitHub gets no verdict)
  - [0029](0029-ask-before-deleting-or-moving-an-oracle-tag-in-the-main-session.md) (its consequence that `git fetch --prune-tags`, `git push --mirror` or `--prune` and `git update-ref --stdin` stay unread)
  - [0030](0030-enforce-the-oracle-on-the-agent-at-the-merge-guard-not-in-ci.md) (its accepted risk that `gh api` merges, `git -c alias...`, `--git-dir`, `GIT_DIR`, `GH_REPO`, `GH_HOST` and `gh` behind `env`, `command`, `time` or as `\gh` pass)
  - [0032](0032-reorient-the-workflow-into-a-toolbox-the-human-directs.md) (the restated invariant, that the hooks allow a form they cannot read, and the sentence of principle 8 that names the forms the net does not read as known gaps)
  - [0033](0033-ask-before-amending-a-frozen-test-in-the-main-session.md) (its rule that a command the reader cannot evaluate gets no verdict)

## Context

The hooks read a command as words and allow a form they cannot read. The root
`CLAUDE.md` states it as an invariant, restated by ADR 0032 from ADR 0002;
ADR 0010 and 0013 repeat it for `guard-git`. The exceptions so far are
narrow: the merge decision asks when it cannot read the pull request
(ADR 0010, 0030), `guard-readonly` denies what it cannot read, a subagent's
shell wrapper that runs `gh` or `git push` is denied (ADR 0013), and flags
written before `merge` in `gh pr merge` are denied (ADR 0030).

Every review of the hooks has found new forms that escape them. The counts
come from the project's audit notes, which are kept outside the repository:

- A-8 (2026-10-26), a fresh review of the A-4 and A-7 fixes: 24 records,
  among them `git -c alias.zz='tag -d' zz oracle/y`, which deletes an oracle
  tag with no verdict, and `GIT_DIR=` or `--git-dir`, which make the hook read
  another repository.
- The second review of A-9: 5 records.
- Experiment E3a of M-6
  (`docs/experiments/2026-10-28-model-calibration-claude.md`, section "New
  defects found in E3a"), verified against `main` at 9239cb6: 6 defects.
  In `gh constructor; gh pr create -f` from a subagent, `ghIsRead` throws a
  TypeError on an `Object.prototype` name (`global/hooks/commands.mjs:72`);
  the hook stops before it reads the second segment and `failOpen`
  (`global/hooks/guard-git.mjs:948`) emits no verdict at all. `env`, `&`, a
  subshell or a quoted assignment in front of `gh pr merge` reaches no merge
  decision, also with `--merge-only`, against the rule that the merge asks
  when it cannot read. `git push origin HEAD` on `main` and
  `git push --mirror` get no decision, also in `bypassPermissions`. A
  backslash continuation hides the rest of a commit, and
  `git -c core.hooksPath=/dev/null commit` skips hooks.
- The three reviews of A-10 (ADR 0033): about 36 records, most of them forms
  the Bash reader of `guard-tests` did not read.

Each round reads the forms it was shown, and the next round finds others. The
grammar of a shell is open: a prefix program, a substitution, an interpreter
or an alias can put any command behind words the hook does not parse. Reading
more forms does not converge, and while an unread form at a gate is allowed,
the promise the gate makes holds only for the forms someone thought to test.

Principle 8 of ADR 0032 sets what the hooks are for: they limit what the agent
does on its own; in the main session they ask with evidence; for subagents and
in `bypassPermissions` they deny; the threat is the agent's error or shortcut,
not an attacker; and a question is asked only where the consequence is real.
Whether a hook's `ask` prompts in `bypassPermissions` was not verified when
ADR 0029 was written. An experiment on 2026-10-29 (Claude Code 2.1.312,
`claude -p` with Haiku, project settings only, a probe hook on `touch`)
answers half of it: in `bypassPermissions` the hook's `ask` was not
auto-approved; the command did not run and was reported as a permission
denial, as in default mode. The controls behaved as expected: the hook's
`deny` was honoured in `bypassPermissions`, and a command with no verdict ran.
The human then ran the interactive check the same day (Claude Code 2.1.312,
Haiku, project settings only, the same probe hook, after trusting the project
folder): in an interactive `bypassPermissions` session the hook's `ask`
showed the permission prompt with the hook's reason; the human declined it
and the command did not run.

A scan of the Bash commands in the local Claude Code transcripts of this
machine, 2026-09-11 to 2026-10-29 (9,168 from main sessions and 3,352 from
subagents), gives an order of magnitude for the cost of the alternatives. It
approximates the readers with regular expressions, so it is neither an upper
nor a lower bound:

- 31% of the main-session commands and 11% of the subagent commands hold at
  least one construct the hooks do not read today (a substitution, a heredoc,
  a subshell or brace group, `&`, a backslash continuation, a shell string, a
  prefix such as `env` or `xargs`, or a quoted assignment). The count includes
  heredocs that only carry a commit message.
- Counting only commands where such a construct, or a non-literal word, is
  attached to a merge, a push, an oracle tag change or a skipped hook, the
  figure is 80 main-session commands (0.9%) and 3 subagent commands (0.1%).
  The frozen-test, subagent GitHub, release tag and Supabase gates were not
  scanned, nor were forms that are unread only because the guard has no rule
  for them (point 5 below), such as a bare tag name in a push. Most hits were a variable in a merge or push value (`$SHA`,
  `-C $R`) and backticks inside a double-quoted `gh` body, which the shell
  runs.

## Decision

### The rule

1. At a high-consequence gate, a command the guard cannot read gets a verdict
   instead of none: in the main session it asks; for a subagent (an event
   with `agent_id`) and in `bypassPermissions` it is denied. The reason names
   the gate, says which part of the command was not read, and shows the
   canonical form that the guard reads. The main session asks even where the
   canonical form is denied, such as a push to `main` or `--admin`: the guard
   does not know that the unread command is that form, and the human sees the
   command.
2. Everywhere else a command the guard cannot read is still allowed, with no
   verdict, as today.
3. A command the guard reads keeps the decision its own ADR gives it.
4. The deny in `bypassPermissions` follows ADR 0029. The experiments above
   show that an `ask` is neither skipped nor auto-approved in that mode, and
   that it prompts in an interactive session. Turning that deny into an `ask`
   is a separate decision and needs its own record.
5. The rule applies to the Bash commands that `guard-git` and `guard-tests`
   read. Hooks on structured tool input, such as `guard-codex`, read no
   command forms and are not affected.

### Classifying a gate

A gate is high-consequence when both hold:

- a guard already decides its canonical form with `deny` or `ask`, so a
  decision exists to protect; and
- the action, taken by the agent on its own, cannot be undone from the
  session because it changes shared state that others or a later merge rely
  on, turns off a control the human relies on, or takes a decision that
  belongs to another party (approving an oracle and publishing a release
  belong to the human; acting on GitHub belongs to the orchestrator, not a
  subagent).

A guarded action that fails the second test stays outside: committing on
`main` (local, undone with a reset), force-pushing a work branch and deleting
a remote work branch (both ask today, and the commits remain in the local
clone and its reflog), and `supabase link` (local configuration). An action
that no guard decides today is not a gate; it needs its own decision first.
Adding or removing a gate needs a new record.

### The gates

| Gate | Guard | Canonical forms decided today | Forms with no rule today |
| --- | --- | --- | --- |
| Merge | `guard-git` | `gh pr merge` with its flags, `--admin` and the merge method | a `gh api` call that is not a read and names a pull request merge (`/merge`, `mergePullRequest`) |
| Push to a protected branch | `guard-git` | a push whose refspec or current branch is `main`, `master` or the remote's default branch | `HEAD` or `@` as the refspec, `--all`, `--branches`, `--mirror`, `--prune` |
| Oracle tags | `guard-git` | `git tag`, `git update-ref` and `git push` refspecs that create, delete or move an `oracle/*` tag | `git update-ref --stdin`, `git push --mirror` or `--prune`, and `git fetch` with `--prune-tags` (`-P`, also in a cluster or abbreviated) or a forced tag refspec |
| Release tags | `guard-git` | a push refspec under `refs/tags/` (ADR 0005: a release is a tag) | a bare tag name as the refspec (`git push origin vX.Y.Z`, the step of `docs/releasing.md`), `tag <name>`, `tags/...` without `refs/`, `--tags`, `--follow-tags` |
| Skipped hooks | `guard-git` | `git commit` with `-n` or `--no-verify`, `git push --no-verify` | `-n` in a cluster or an abbreviated `--no-verify` on commit, `--no-verify` on `merge`, `rebase` or `am`, `-c core.hooksPath`, `git config core.hooksPath`, `GIT_CONFIG_*`, `HUSKY=0` or `HUSKY_SKIP_HOOKS` before a git command |
| Frozen tests | `guard-tests` | the write forms of ADR 0033 on a frozen test path or a test-configuration path | the constructs the reader skips |
| GitHub actions of a subagent | `guard-git` | for an event with `agent_id` only: any `gh` command off the read-only list and any `git push` (ADR 0013), opening a pull request included | none beyond the unread constructs |
| Remote Supabase actions | `guard-git` | `supabase`, or `npx supabase`, with `db push`, `functions deploy`, `secrets set` or `unset`, `db reset --linked`, `migration repair`, and `--linked` or `--db-url` | none beyond the unread constructs |

`gh pr create` from the main session is not a gate: the orchestrator opens
pull requests (ADR 0010).

### What "not read" means

The model is an allowlist scoped to the gates. A command that reaches a gate
is read only when every part of it that can run the gate's program is a
simple command in the guard's grammar, every word the decision depends on is
a literal in a context the guard resolves, and, for the gate's own
subcommands, the guard has a rule for that form. Points 1 to 5 below list
what fails these conditions today. A git or gh subcommand that belongs to no
gate (`git show`, `git diff`, `git log`, `git ls-remote`, `git fetch` without
a tag option, `gh pr view`) is read and gets no verdict, so
`git show --stat oracle/<branch>`, which `atdd-implement` prescribes, stays
allowed.

A command reaches a gate through its trigger. Triggers are matched on shell
words with their quotes removed: a trigger matches a whole word; a path
component of one for `oracle/`, `refs/tags/` and, in a `gh` command,
`merge`; the start of one for `alias.`, `--no-v`, `--prune-t`, `GIT_CONFIG_`
and `HUSKY`; and anywhere in one for `mergePullRequest` and `hooksPath`.
Matching is case-sensitive except for `hooksPath`, which git reads in any
case, so `core.hooksPath=/dev/null` matches. `merge` does not match
`mergedAt` or `merge-base`, and `tag` does not match `stage`.

- The gate program (`git`, `gh` or `supabase`) is in command position: the
  first word of a segment after unquoted assignments, the word after `npx` or
  `bunx` for `supabase`, or the first word after an unknown program and its
  options (`xargs -0 gh`, `ionice git`; not `npm install supabase`). A gate
  program that is only
  an argument of a program that does not run its arguments (`echo`, `printf`,
  `grep`, `rg`, `which`, `type`, `command -v`, `man`) triggers nothing, so
  `rg -n "git push" global/hooks` stays allowed.
- Or the gate program sits inside a construct the guard does not read (a
  shell or interpreter string, a substitution, a subshell).
- And the gate's trigger words appear in that command or construct:
  - merge: `gh` and `merge` or `mergePullRequest`;
  - push to a protected branch: `git` and `push`;
  - oracle tags: `git` and `oracle/`, `refs/tags/`, `tag`, `update-ref` or
    `alias.`; `git`, `push` and `--mirror` or `--prune`; `git`, `fetch` and
    `--prune-t`, a short-option cluster that holds `P`, or a refspec into
    `refs/tags/`;
  - release tags: `git` and `push`;
  - skipped hooks: `git` and `--no-v`, `hooksPath`, `GIT_CONFIG_` or
    `HUSKY`, or `commit` and a short-option cluster that holds `n`;
  - subagent GitHub actions, for an event with `agent_id` only: `gh`, or
    `git` and `push`;
  - Supabase: `supabase`.

Text the reader proves to be data is removed before matching: the body of a
heredoc with a quoted delimiter that `cat` or `tee` writes to a file, and the
value of a message option (`-m`, `--message`, `--subject`, and `-t`,
`--title`, `-b` and `--body` of `gh`), including Claude Code's own
`"$(cat <<'EOF' ... EOF)"` form.

In `guard-git`, a command that reaches a gate is not read when any of these
holds:

1. The guard threw, or ran out of its own time budget, while deciding. The
   TypeError of `gh constructor` is the first case.
2. The gate's program sits inside a construct outside the grammar. Today that
   is: a command substitution or backticks; a subshell or brace group; a
   function body; a background `&`; a shell or interpreter string
   (`bash -c`, `sh -c`, `zsh -c`, `eval`, `python -c`, `node -e`, a heredoc
   fed to an interpreter); an unknown program before it; a backslash-newline
   continuation; or an assignment whose value
   is quoted (`FOO="a b" gh ...`). `env`, `command`, `exec`, `sudo`,
   `nohup`, `time`, `nice` and `timeout` count as unknown programs until the
   guard strips them with a test.
3. A word of the gate command that its decision depends on is not a literal:
   it holds `$`, a backtick, a glob character the guard does not expand, or a
   quote or a shell operator inside the word, or the program word itself is
   escaped or quoted (`\gh`, `"git"`). Examples are a refspec `$B`, `git -C $R push`, or a pull
   request selector `$N`. A word the decision does not read, such as a
   `--subject`, `--match-head-commit` or `--jq` value, does not count, and
   neither do the words of other commands in the same line. Today
   `guard-git` splits segments inside quotes; A-6 makes the split
   quote-aware so that a quoted operator in such a value does not create a
   segment.
4. The command names a context the guard does not resolve: `--git-dir`,
   `--work-tree`, an assignment to `GIT_DIR`, `GIT_WORK_TREE`,
   `GIT_COMMON_DIR`, `GIT_NAMESPACE`, `GIT_CONFIG_*`, `GH_REPO`, `GH_HOST` or
   `GH_TOKEN` (other assignments, such as `GH_PAGER=cat`, are read),
   `git -c alias.*`, a git subcommand that
   is not built into git (an alias), or a `cd` to a non-literal directory
   before the gate command.
5. The guard has no rule for the form of a gate's own subcommand (`push`,
   `tag`, `update-ref`, `fetch` with a tag option, `config` of `hooksPath`,
   `commit`, `merge`, `rebase` or `am` with a skipped hook, `gh pr merge`,
   `gh api` naming a merge): the "Forms with no rule today" column, and any
   option of that subcommand the guard does not know. The short form of a
   known option counts as known (`-u`, `-q`). A-6 gives
   each of these a canonical rule with a test, such as `HEAD` on `main` read
   as a push to `main`, or leaves it under this rule.

In `guard-tests`, which already reads wrappers, shell strings and
interpreters (ADR 0033), a command is not read when the reader fails (an
exception, the deadline or the CPU budget) or skips a span of the command, and
the command or that span names, as a word, a frozen test path or a
test-configuration path of the oracle commit. When the oracle inventory
itself cannot be read, the trigger is a word that matches the test paths of
`global/hooks/oracle.mjs`. A plain program the reader does not know, naming a
frozen path, stays allowed: the vocabulary of programs that only read or run
tests is open, and the merge decision compares the pull request with the
oracle tag (ADR 0030).

The guards may widen their grammar, for example by stripping `env` and its
assignments or by reading a substitution recursively with the same grammar.
A widened construct counts as read only with a test that pins it. A form the
guard reads but reads wrongly, such as an unexpanded `~` in `git -C ~/repo`,
is a defect fixed with its own test.

### How the guards apply it

- The trigger runs in the entry that sees every Bash command. No gate depends
  on an entry's `if` to start, because an `if` reads the command as words too.
- An exception keeps the verdicts collected before it. If the raw command
  reaches a gate, the guard adds the gate's ask or deny; if not, it fails open
  with a visible message, as today.
- The merge decision keeps its own entry, which fails closed when the hook
  cannot start (ADR 0010, 0030).

### The invariants from this record on

The invariants of the root `CLAUDE.md` change in the pull request that accepts
this record. The safety-net bullet reads:

> The hooks are a safety net for one machine that limits what the agent does
> on its own, not a boundary: they read a command as words. At the
> high-consequence gates of ADR 0034 (merge, push to a protected branch,
> oracle tags, release tags, skipped hooks, frozen tests, GitHub actions of a
> subagent and remote Supabase actions) a command that reaches a gate's
> trigger and that they cannot read asks in the main session and is denied to
> subagents and in `bypassPermissions`; elsewhere they allow it. Two named
> exceptions remain: a hook that cannot start or times out fails open, except
> the merge entry, and `guard-tests` allows a program it does not know. `guard-readonly` denies a form it cannot
> read.

The rest of that bullet, on human review at the gates that are already human
and on CI and rulesets, is unchanged. The fail-open bullet, which is about a
hook that cannot decide, start or finish, gains one sentence after its first:
"A guard that throws while deciding a command that reaches a high-consequence
gate of ADR 0034 asks or denies instead; a hook that cannot start or times out
still fails open." The rest of that bullet, its two exceptions included, is
unchanged.

On acceptance, the front matter of ADRs 0002, 0010, 0013, 0029, 0030, 0032
and 0033 records "amended by 0034"; their bodies stay as written.

## Alternatives considered

- **Keep allowing every unread form.** Rejected: four reviews in a row found
  new forms, and E3a found forms that contradict invariants the workflow
  states (a subagent opens a pull request, a merge passes with no decision,
  `--mirror` force-updates `main` and `oracle/*`). Chasing forms one by one
  does not converge.
- **Ask or deny by consequence at the gates (chosen).** It closes the class at
  the places where an escape is costly and leaves the rest untouched. Its cost
  is a few more questions near the gates: on the order of 1% of main-session
  commands and 0.1% of subagent commands in the scan, before the guards widen
  their grammar.
- **Deny every unread form.** Rejected: about 31% of main-session commands and
  11% of subagent commands hold a construct the hooks do not read, almost all
  of them unrelated to any gate. Denying them would stop ordinary work, and in
  the main session it would block what the human decides, against principle 8.
  Asking on all of them instead would wear the human's judgement into an
  automatic yes.
- **An allowlist of read forms for every command**, as `guard-readonly` does
  for the researcher. Rejected for the main session and the implementer:
  their commands are open-ended, unlike the researcher's read-only needs. The
  chosen rule is this allowlist scoped to the gates.
- **A full shell parser in the hooks.** Not chosen as the decision: it narrows
  the unread set but cannot remove it, since aliases, variables, scripts and
  interpreters resolve only at run time, and the hooks carry no dependencies
  today. A-6 may still use a better parser inside the grammar.

## Consequences

- The class of unread forms at the gates closes as a class. The E3a defects
  (`gh constructor`, `env`, `&`, subshells and quoted assignments before a
  merge or `gh pr create`, `push HEAD` on `main`, `--mirror`, the backslash
  continuation and `core.hooksPath`) and the forms ADR 0029 and 0030 left
  unread (`fetch --prune-tags`, `push --mirror` and `--prune`,
  `update-ref --stdin`, `bash -c`, `git -c alias.*`, `--git-dir`, `GIT_DIR`,
  `GH_REPO`, `GH_HOST`, `\gh`, `gh api` merges) all fall under the rule.
- The agent gets more questions, or denials as a subagent, when it writes an
  unusual form near a gate. The reason shows the canonical form, so the usual
  fix is to rewrite the command. In `bypassPermissions` those forms are denied,
  although an `ask` was shown to prompt there, until a record changes it.
- A-6 carries the `guard-git` implementation: tests first, then the fix, in
  its own pull request with a human merge. Its criteria 10 to 13 become
  instances of this rule. It adds tests for each case of points 1 to 5 at each
  `guard-git` gate, for the trigger and its matching, for an exception that
  keeps collected verdicts, for the trigger running in the entry that sees
  every command, and for the release tag and Supabase gates. Its criteria 1
  to 9 are defects in read forms and stay as they are.
- A-12 carries the `guard-tests` part, since it already holds the pending work
  on that reader.
- This record is merged as proposed, on its own, and accepted with the
  invariant text in A-6's pull request, so that the invariants never state a
  rule the hooks do not implement. Until A-12 lands, the frozen-test gate
  stays a named gap in that text.
- Named gaps that remain, by design or because no hook sees them:
  - an alias defined in a git configuration file (`git p` for `git push`), a
    script, a Makefile or a package script that runs a gate command, and
    `curl` or any other client that holds the token;
  - an unknown program that runs a quoted string (`watch "gh pr merge 5"`,
    `parallel`), since a quoted argument of an unknown program does not
    trigger, and an unknown program whose options take values the guard does
    not know (`xargs -n 1 gh ...`);
  - `GH_REPO` or `GH_HOST` exported earlier or inherited from the
    environment, which the hook does not see;
  - `gh release create`, which publishes a release and can create its tag
    with no guard deciding it today; it needs its own record to become a
    gate;
  - behaviour set by configuration (`push.default`, `remote.<name>.push`,
    `remote.<name>.mirror`, `fetch.pruneTags`), read neither from the command
    nor from the repository;
  - removing files under `.git/refs/tags`;
  - tools other than Bash, such as a GitHub MCP server that merges or pushes;
  - Codex commands, which no Claude Code hook sees; its sandbox ceilings
    (ADR 0028) and `guard-codex` limit it, unchanged by this record;
  - a hook that cannot start or times out in Claude Code: the entry that sees
    every command still fails open, and only the merge entry blocks;
  - in `guard-tests`, a plain program it does not know that names a frozen
    path, with the merge decision's oracle comparison as the backstop;
  - trigger words in text the reader cannot prove is data, which can ask or
    deny a harmless command, for example a commit message held in a variable
    that names `merge` next to `gh`.
- The scan behind the cost figures is an approximation run once on one
  machine. A-6 and A-12 measure again on the implemented rule and report the
  share of commands that ask.
