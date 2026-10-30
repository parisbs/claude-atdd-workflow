---
status: proposed
date: 2026-10-30
---
# 0035. Keep a proposed ADR from merging with the change that applies it

- Issue: #76

## Context

PR #62 merged ADR 0031 with `status: proposed` together with the work that
applies it: `docs/releasing.md`, the Breaking markers of `CHANGELOG.md` and
`global/skills/release-prep/SKILL.md`, which is installed in every
repository. PR #63 accepted the record afterwards. In between, installed
behaviour depended on a record that ADR 0018 still treats as an editable
draft, so the decision could change without a new record while code relied
on it. ADR 0028 had the same shape earlier: it stayed proposed after its
implementation merged in PR #51 until PR #70 accepted it.

Nothing in the flow looked at the record's status. The orchestrator's brief
for #62 defined done as "ADR 0031 in proposed" plus a pull request for human
merge; `pr-prep` and the merge decision of `guard-git` read paths, not ADR
status. The only control was the human merge of the control plane.

Two cases are legitimate and must keep working: a pull request that carries
only the record, so the human can discuss it before anything applies it; and
a declared spike or experiment that changes nothing installed.

Principle 8 of ADR 0032 bounds where a control may live: deterministic
safeguards limit what the agent does on its own, not what the human decides.
Where the human decides, a control gives evidence read by the hook (pull
request state, files, labels, the record's front matter), never a summary the
agent wrote. GitHub cannot tell the agent from the human, so CI is a tool the
human applies to themselves, not a guarantee against the agent.

`docs/adr/` is already on the control plane (`controlplane.mjs`, ADR 0010) in
every repository, so the merge guard already asks in the main session for any
pull request that touches a record, and subagents cannot merge at all
(ADR 0013). What is missing is that the ask names this case, that the agent
in `bypassPermissions` is stopped, and that the case is caught before the
pull request exists.

## Decision

### Terms

- ADR directories: `docs/adr/`, `docs/adrs/` and `docs/decisions/` at any
  depth, the same list that `controlplane.mjs` and `check-adrs.mjs` use.
- A record: a file in an ADR directory whose name matches `NNNN-*.md`. The
  index and the template are not records.
- A proposed record: a record the change adds or edits whose front matter
  `status` (MADR 4, ADR 0020), read at the head of the change, has the leading
  word `proposed` in any case. A deleted record, or one whose status at the
  head is any other word, is not proposed; that includes a record the same
  change moves from proposed to accepted.
- A mixed change: one with at least one proposed record and at least one
  changed path outside the ADR directories.

### Where the control lives

1. The merge guard. `guard-git` reads the front matter of every changed
   record at the pull request's head commit and, for a mixed pull request,
   adds a reason to its merge decision. The reason names each proposed record,
   the paths outside the ADR directories, and the two ways out: accept the
   record in this pull request, or move it to its own pull request and merge
   that one first. The decision follows the pattern of ADR 0030 and 0034: the
   main session asks; `bypassPermissions` is denied; a subagent is already
   denied by ADR 0013. A record whose status the guard cannot read, for any
   reason other than the file not existing at the head, is unreadable: the
   main session asks and `bypassPermissions` is denied, naming the record.
2. `pr-prep`, before the pull request. An installed script,
   `~/.claude/hooks/proposed-adr-check.mjs`, compares the branch with its
   merge base with `main`, uncommitted and untracked work included, and reads
   each record's status from the working tree. For a mixed change it exits
   non-zero and prints the records, the paths and the two ways out; otherwise
   it exits 0. `pr-prep` runs it and stops for the human's choice: accept the
   record in this branch, split it out, or declare the change an experiment.
   The script and `guard-git` share the rule through one module,
   `global/hooks/proposed-adr.mjs`, as `oracle-check` and `guard-tests` share
   `oracle.mjs`.
3. `check-adrs.mjs` informs only. For a mixed change against its base it
   prints a notice on stdout naming the records and the paths, and its exit
   code stays what its other checks give. CI shows the notice; it never fails
   on it.
4. Done for ADR work. Briefs, `task-package` and the Delegation section of
   `global/CLAUDE.md` define a task that adds or changes a record as done when
   the human accepted the record in the pull request that applies it, or when
   the record merged alone as proposed. The orchestrator's merge conditions in
   `global/CLAUDE.md` list "no proposed record together with other paths,
   unless the pull request carries `experiment`" next to the others.

### Declaring an exception

- A pull request with only records and the index is not mixed and needs no
  declaration.
- A spike or experiment is declared with the label `experiment` on the pull
  request, matched without regard to case like `needs-human`. With it, the
  merge guard does not deny in `bypassPermissions` for this reason, and its
  reason states that the pull request is a declared experiment while still
  naming the proposed records and the other paths. Every other reason of the
  merge decision applies unchanged, and the control-plane ask still reaches
  the human because the pull request touches `docs/adr/`.
- Before the pull request exists there is no label. The local check does not
  read one; `pr-prep` asks the human, and the label is added when the pull
  request opens.

## Alternatives considered

- Fail `check-adrs` in CI for a mixed pull request unless it carries
  `experiment`, as B-2 proposed. Rejected: a failing required check stops the
  human who merges this way on purpose, which principle 8 rules out, and it
  protects nothing more against the agent, which shares the human's token and
  can add the label or merge with `--admin` as easily as the human.
- Prose only, in briefs and `task-package`. Rejected: the #62 brief was the
  cause. A rule the orchestrator writes into its own brief is the thing that
  failed; ADR 0002 keeps what must always hold in a hook.
- Only `pr-prep`, without the merge guard. Rejected: `pr-prep` is a
  procedure the agent may skip or misread, and the merge guard is where the
  agent's merge is decided from evidence the hook reads itself.
- "Other paths" meaning paths outside `docs/`, as B-2 wrote. Rejected: in #62
  `docs/releasing.md` was part of the implementation. The ADR directories are
  the only paths a record can travel with and still be "the record alone".
- Verifying that an experiment "changes nothing installed". Rejected: what a
  repository installs or ships is not decidable from paths in general. The
  label is a declaration the human answers for.
- A new high-consequence gate under ADR 0034. Not needed: this is one more
  reason inside the existing merge gate, whose canonical and unread forms ADR
  0034 already decides.

## Consequences

- An agent's merge of a mixed pull request reaches the human with the
  records and paths named, and never passes in `bypassPermissions`. The
  earlier catch is `pr-prep`, before review time is spent.
- The merge decision makes one more `gh api` read per changed record, within
  its existing time budget. A failed read asks, as for the other parts of the
  merge decision that fail closed.
- `check-adrs.mjs` changes, and the `repo-bootstrap` template copies it, so
  bootstrapped repositories print the notice too.
- Known gaps, named under principle 8:
  - The agent can add the `experiment` label itself; GitHub cannot tell who
    did (ADR 0032). The control-plane ask still reaches the human, so the
    label lifts only the `bypassPermissions` deny and changes the wording.
  - Code that applies a proposed record already on `main`, in a pull request
    that does not touch the record, is not detected: the guard cannot tie code
    to a record it does not see in the diff.
  - A record whose directory is outside the three ADR directories, or whose
    name does not match `NNNN-*.md`, is not read.
  - Merges the human makes outside the agent's tool calls, in a terminal or
    on GitHub, are outside every guard, by design.
- This record is itself applied by the pull request that adds it: it is done
  only when the human accepts it there.
