# 0010. Move human control to the specification and gate merges by verified conditions

- Status: accepted
- Date: 2026-10-02
- Amends: [0008](0008-administrator-bypasses-rulesets-through-pull-requests.md)

## Context

The developer wants a hub-and-spoke way of working: one conversation with an
orchestrator, which delegates to subagents, without losing control over what
reaches `main`. Two things get in the way, both found by reading the
configuration and the documentation (2026-10-02):

- **Merges ask every time, and a per-repository authorization cannot change
  that.** ADR 0008 installs `ask` on `Bash(gh pr merge:*)` in the user-level
  settings. Permission rules are evaluated deny, then ask, then allow; the first
  match wins and specificity does not reorder them, so a matching `ask` prompts
  even when a project `allow` also matches, and a PreToolUse hook that returns
  `allow` does not lift it (VERIFIED, official permissions documentation). A
  project-level allow for `gh pr merge` therefore never took effect.
- **No orchestrator can start the workflow's skills.** All eight user skills set
  `disable-model-invocation: true`, so only a slash command typed by the human
  starts them. That is a control, but a blunt one: it removes the human from the
  loop by making the human the loop.

The human's real control already sits elsewhere. ADR 0003 puts approval on the
acceptance criteria and the test oracle, and tests plus CI prove the result. What
is missing is the gate on the oracle itself, which is prose in `atdd-oracle`
step 5 and nothing else, and a merge gate that depends on what is being merged
instead of asking every time.

## Decision

The human approves *what* is built; machines prove *that* it was built; the
orchestrator does the rest. Actions fall into three classes:

1. **Free for subagents**: reading, researching, drafting, editing in the
   worktree, commits on the work branch, running tests. Subagents never act on
   GitHub; they return a report.
2. **Orchestrator only**: pushing the work branch, opening pull requests, issues,
   labels, milestones and comments, and merging when the conditions below hold.
3. **Human only**: accepting an ADR, amending a frozen test, publishing a
   release, creating, moving or deleting an oracle tag, force pushes, `--admin`.

The orchestrator merges a pull request without asking when all of these hold,
and otherwise reports what failed or could not run and waits:

- every check required by the ruleset is green;
- `oracle-check` reports the test paths unchanged;
- the review the repository's `AGENTS.md` declares (`Review:`) ran and left no
  open finding;
- no changed file is on the control plane;
- the pull request does not carry the label `needs-human`;
- the merge is `--squash --delete-branch`.

The control plane is where an agent could weaken its own controls: by default
`.github/workflows/`, `docs/adr/`, `AGENTS.md`, `CLAUDE.md`, `.claude/`, and
release files such as the version in `package.json`. A repository adds its own
paths with a line `Human merge:` in `AGENTS.md`, in the style of `Verify:` and
`Review:`. A pull request that touches the control plane is merged by the human.

Mechanism, following ADR 0002 (what must always hold is a hook, the rest is
procedure):

- The `ask` on `gh pr merge` leaves `global/settings.json`. `guard-git` decides
  on `gh pr merge` instead: it reads the pull request with `gh`, and returns
  `deny` for `--admin` or a merge that is not squash, `ask` when a check is not
  green, a control-plane path changed, `needs-human` is set, or the pull request
  cannot be read, and `allow` otherwise. Unlike the other guards it asks rather
  than fails open when it cannot decide, because a merge cannot be undone.
- The hook verifies only what GitHub shows. `oracle-check` and the review are
  obligations of `pr-prep`, reported in the pull request body, and are
  procedure, not enforcement.
- Creating a tag `oracle/*` asks. Moving or deleting one is denied, through `git tag` and through `git update-ref` alike. This is
  the single human checkpoint on the happy path, and it turns the approval in
  `atdd-oracle` step 5 from prose into a prompt.
- `disable-model-invocation` is removed from `issue-draft`, `adr-draft`,
  `drift-audit`, `pr-prep`, `atdd-implement` and `atdd-oracle`. `release-prep`
  and `repo-bootstrap` stay manual because they publish or reconfigure. The stops
  inside the skills remain: `issue-draft` waits for approval and `adr-draft` does
  not commit.
- A delegated task stops after two failed attempts or two review passes and
  reports. This is prose; its counterpart on the server side is
  [codex-subagent-mcp#62](https://github.com/parisbs/codex-subagent-mcp/issues/62).

## Alternatives considered

- **Keep the `ask` of ADR 0008.** Rejected: it costs a prompt per merge and
  protects nothing the required checks do not already protect, while treating a
  documentation fix and a change to the hooks alike.
- **Remove the `ask` and merge unconditionally.** Rejected: it leaves no gate on
  the control plane, where a merged change can disable the other gates.
- **A per-repository `allow` rule.** Rejected: it cannot work (see Context).
- **Human approval through GitHub reviews or CODEOWNERS.** Rejected: the agent
  uses the developer's token and GitHub does not let an author approve their own
  pull request, so the rule would block both or neither.
- **A second GitHub identity for the agent, without administrator rights.**
  Rejected for now by the developer. It is the only option that makes the
  separation real instead of a hook; revisit it if the hook proves too easy to
  go around.

## Consequences

- ADR 0008's sentence "`gh pr merge` asks for confirmation" no longer holds; its
  status line records the amendment. Its other decisions stand.
- As in ADR 0008, the protection depends on the user-level hook being installed:
  `guard-git` reads a command as words and allows a form it cannot read. For
  checks, the ruleset stays the guarantee. For control-plane paths there is no
  guarantee on GitHub's side.
- A merge needs `gh` and the network at the moment of the merge.
- Authorizations recorded per repository (for example "merge without asking" in
  a project's local settings) are obsolete and should be removed.
- Verified on Claude Code 2.1.285 (2026-10-02, non-interactive probe with a
  throwaway hook): a hook that returns `allow` lets a command run that would
  otherwise need approval, and the same hook with an `ask` rule matching the
  command does not, so the `ask` has to go. `Verdict.emit` in `lib.mjs` prints
  nothing for `allow`, which means no opinion, so the merge decision must print
  an explicit `allow`.
- Verified with a prototype classifier over 27 command shapes: creating, listing
  and deleting an oracle tag can be told apart, including combined flags such as
  `-am` and `-df`. The guard as it is cannot: it allows `git tag -df oracle/x`,
  and it never looks at `git update-ref refs/tags/oracle/*`, so both delete an
  oracle tag without a verdict. The change that adds the tag prompt closes both.
- Follow-up work, each its own issue: the merge decision in `guard-git`, the
  oracle tag prompt, the skill flags, the `Human merge:` line in the
  `repo-bootstrap` templates, and the Delegation section of `global/CLAUDE.md`.
