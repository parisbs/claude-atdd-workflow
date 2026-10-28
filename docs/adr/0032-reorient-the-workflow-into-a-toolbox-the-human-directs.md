---
status: proposed
date: 2026-10-28
---
# 0032. Reorient the workflow into a toolbox the human directs

- Amends:
  - [0001](0001-separate-generic-personal-and-repository-configuration.md) (decision 1, "**Generic** (`global/`, versioned, installed into `~/.claude`)", under which the installer copies `global/CLAUDE.md` over the whole `~/.claude/CLAUDE.md`)
  - [0002](0002-enforce-with-hooks-permissions-and-ci.md) (CI and rulesets as the authoritative enforcement)
  - [0003](0003-approved-tests-replace-behaviour-specs.md) (ATDD as a user-level workflow that every feature goes through, with the levels listed in the global `CLAUDE.md`)
  - [0008](0008-administrator-bypasses-rulesets-through-pull-requests.md) (the required checks of the ruleset as what binds the agent, with the hook as part of that protection)
  - [0011](0011-delegate-through-subagents-interchangeable-with-codex.md) (`claude-implementer` as the default implementer)
  - [0012](0012-keep-repository-instructions-in-claude-md-alone.md) (the reasons that assume every task is delegated)
  - [0015](0015-pass-delegates-goals-structured-findings-and-the-rules-they-lack.md) (a finding's `verified` flag)
  - [0025](0025-route-model-and-effort-per-delegation-through-a-matrix.md) (decisions 2, 4 and 7)
  - [0026](0026-return-a-compact-envelope-and-keep-the-full-delegation-report-in-the-scratchpad.md) (decision 1)
- Builds on: [0031](0031-version-releases-by-their-effect-on-the-public-interface.md)
  (SemVer for the workflow as a whole; v1.0.0 waits on a planned reorientation)
- Evidence: [rules loading probes, 2026-10-28](../experiments/2026-10-28-rules-loading-probes.md)

## Context

The workflow grew as one model applied everywhere. One `~/.claude/CLAUDE.md` of
157 lines loads into every session in every repository and tells it to pick a
level for each task, with ATDD for every feature. Without an `Implement:` line,
code is written by `claude-implementer`, so delegation is the default (ADR
0011). The routing matrix of ADR 0025 is applied to every delegation and checks
explicit choices. CI and rulesets are named the guarantee against the agent (ADR
0002, ADR 0008, the root `CLAUDE.md`). A local audit plan, kept outside the
repository, lists the conflicts this produces; the identifiers in parentheses
below are its own. The three this record resolves are:

- C-02: without an `Implement:` line the code goes to `claude-implementer`, so
  the default is to delegate.
- C-11: the matrix would apply on every call and check explicit choices (ADR
  0025, decisions 2 and 4).
- C-13: ADRs 0003, 0011, 0012, 0025 and 0026 fix the current model and are
  immutable.

What Claude Code does, verified in `code.claude.com/docs` and against CLI
2.1.308 on 2026-10-23 unless noted:

- The user, project and local `CLAUDE.md` files are concatenated; none overrides
  another. User rules load before project rules, and neither overrides the
  other.
- When a personal and a project skill share a name, the personal one wins. Among
  agents of the same name, project wins over user, and user over plugin.
- Only a skill's description loads until the skill runs, up to 1,536 characters,
  so every user skill costs context in every session.
- Claude Code reads `AGENTS.md` natively since 2.1.277, but by default only when
  no
  `CLAUDE.md` exists in the working directory or above it (memory page, read on
  2026-10-28). ADR 0012's premise still holds.
- A plugin cannot carry always-loaded memory: a `CLAUDE.md` at the plugin root
  is not loaded, and `claude plugin validate` warns about it. Its settings apply
  only `agent` and `subagentStatusLine`, so a plugin ships no permission rules
  (plugin manifest reference, read again on 2026-10-28). Plugin agents ignore
  `hooks`, `mcpServers` and `permissionMode` (read on 2026-10-23, not read
  again). `guard-readonly` and the deny rules for secrets depend on exactly
  those.
- `claude plugin validate` reports as an error a plugin name that passes as one
  of Anthropic's own: one that starts with `claude-`, `anthropic-`,
  `anthropics-` or `cc-plugin-`; one that is exactly `claude`, `anthropic`,
  `anthropics`, `claude-code` or `claude-mods`; and one that puts `official`
  beside `claude` or `anthropic`. The check ignores case and treats any run of
  separators as one. `claude plugin init` and `claude plugin tag` refuse such a
  name. `claude`, `anthropic` or `anthropics` as a whole word anywhere else
  draws a warning (plugin manifest reference, read on 2026-10-28).
- Imports organise a long file but do not reduce its context cost, because
  imported files load with the file that imports them (memory page).
- In Cowork sessions Claude Code skips any import in a user-scope file that
  resolves outside the session's working directory, skips a
  `~/.claude/CLAUDE.md` that is a symlink or hard link, and skips a symlinked
  `~/.claude/rules/` directory or rule file pointing outside it (memory page,
  read on 2026-10-28). Regular files are not among those limits.
- Recursive discovery of `.md` files in subdirectories is documented for project
  rules (`.claude/rules/`). For user rules (`~/.claude/rules/`) the page shows
  flat files only and says nothing about subdirectories (memory page, read on
  2026-10-28).

The spike answered the three loading questions on the CLI and the desktop app,
once per variant, and did not test Cowork:

- User rules without `paths` load at session start.
- Rules with `paths`, user or project, load only after a matching read, in the
  main session and in every subagent.
- `omitClaudeMd` drops the `CLAUDE.md` files and every rule without `paths` from
  a subagent, user rules included, but not the rules with `paths`.

B-0 compared the plan with the public exam guide of Anthropic's Claude Certified
Architect – Foundations certification (CCA-F), published on the [certification's
Skilljar
page](https://anthropic.skilljar.com/claude-certified-architect-foundations-access-request);
the version B-0 read is not recorded here.
Its records R-04, R-08, R-25, R-34, R-37, R-39 and R-41 are weighed in the
decisions and alternatives below. The threat this workflow guards against was
restated during A-9 and applied in ADR 0030: the agent's error or shortcut to
pass the tests, not an attacker. The agent acts with the human's GitHub token.

## Decision

### Principles

1. **The workflow is a toolbox the human directs.** With no instruction, the
   session works directly and verifies with the repository's command. A heavier
   tool is suggested in one line when the risk justifies it, and never started
   until the human asks for it. Heavier tools are regression first, the ATDD
   oracle, delegation and independent review. Modes are short names the human
   uses in the prompt, not a decision tree.
   - Delegation (R-04, a middle point between this principle and the guide): the
     session looks for delegation and suggests it where it pays, in these kinds
     of task:
     - exploration and research;
     - diagnosing a bug: reproduction, cause and the files involved;
     - oracle tests, and regression tests when justified;
     - production code on top of those tests;
     - review of generated code;
     - independent verification of another agent's findings;
     - wide mechanical changes, with the verify command as their guarantee;
     - throwaway experiments or spikes in a worktree.

     Writing documents and ADRs is not delegated, because it needs the
     conversation's context.
   - Read-only delegations to Claude (exploration, research, diagnosis,
     verification) may start without asking when they protect the session's
     context. A delegation that writes, and every review, is suggested in one
     line and waits for the human's yes.
   - Codex always asks, because it spends a third party's quota. It is suggested
     only when its MCP server is installed and authenticated (`codex_doctor`,
     quotas through `codex_usage`).
   - Review (R-39):
     - In direct architecture the human decides on review.
     - In orchestrated architecture, when a spoke wrote production code, the
       session suggests a review in one line at the close; it is not an
       automatic step.
     - `Review: none` stays the default, and a repository that always wants a
       review declares it.
   - Parallel work (R-08), in orchestrated architecture:
     - Independent read-only Claude delegations, where none needs another's
       result, run in parallel without asking.
     - Writing delegations run in parallel only with the human's yes, each in
       its own worktree with no shared files.
     - Codex runs in parallel only when the human asks, under the ceiling of two
       background jobs per registration of ADR 0028, adjustable in `personal/`.
       `task-package` carries this.
2. **The always-loaded user core is 10 to 15 lines.** A line enters only if it
   holds in any repository, whatever its profile, and no project would
   contradict it. Personal preferences (the language of answers, accessibility,
   behaviour) stay in the personal rule. The same test applies to the
   descriptions of user skills, which also always load.
3. **A repository without bootstrap is a valid environment.** It gets only the
   user core and the safety guards.
4. **Four independent axes, each at its own level, on a common base.**
   - The base is always user-level: the core and the global safety guards that
     carry no process. That includes the guards an artefact switches on: the
     oracle tag and the Codex registrations. The guards apply whoever writes:
     the session, a subagent or Codex.
   - The environment is what the code is: Android, Flutter, Supabase,
     TypeScript, node-mcp or generic. It is installed in the project, and a
     repository may combine several.
   - Workflow tools are the steps and gates of the work: ATDD, regression,
     releases and auditors.
     - They are installed in the project (a versioned `.claude/`) from this
       repository as a catalogue, and a repository may hold several.
     - Holding a tool does not oblige anyone to use it.
     - Each tool defines steps, roles (tests, implementation, review) and gates,
       never an engine.
   - The session architecture is who does each step: direct, meant for simple
     tasks of known scope and effects, or an orchestrator with spokes. It is
     local, not part of CI.
   - Agent engines are what fills a role, and they are user-level together with
     the orchestration:
     - Claude subagents are assumed, since using this project already needs a
       Claude subscription.
     - Codex through MCP is optional, since it needs its own subscription.
   - The human picks the architecture, the tool and the engines in each session
     and answers for the combination. The workflow provides tools, mostly
     deterministic ones, and does not validate that the combination is right.
5. **Modules are installed by this repository's installer, not as Claude Code
   plugins, but each module uses a plugin's folder structure** (`skills/`,
   `agents/`, `hooks/`). Plugins cannot carry the always-loaded memory, the
   permission rules or the agent hooks the guards need (see Context).
6. **The bootstrap manages each project's profile**, meaning its environments
   and its workflow tools. It creates, integrates, reconfigures and updates the
   profile, on request.
7. **The workflow follows SemVer as a whole**, as ADR 0031 decides; this record
   does not restate it.
8. **Deterministic safeguards limit what the agent does on its own, not what the
   human decides.** This holds for the whole project.
   - A hook sees only the agent's tool calls, never the human's terminal or
     GitHub's web interface. Locally, everything a guard stops is an action of
     the agent.
   - Where the human decides, the control does not block. It gives the human
     deterministic evidence read by the hook (pull request state, commits, diff,
     files and tag), never a summary written by the agent, which is the party
     being checked.
   - A question is asked only where the consequence is real. An ask on
     everything wears down the human's judgement into an automatic yes.
   - The project's control pattern, from A-7: in the main session, ask with
     evidence; for subagents, Codex and `bypassPermissions`, deny. What the
     human does stays outside the guards. A-6, A-9 and A-10 follow it.
   - The threat is the agent's error or shortcut, not an attacker. A net that
     reads the common forms is proportionate, and the forms it does not read are
     named as known gaps.
   - GitHub cannot tell the agent from the human, because they share a token, so
     CI and rulesets stop being the workflow's guarantee against the agent. That
     protection is the hook net plus human review at the gates that are already
     human: the control-plane merge, ADRs and oracle tags. CI and rulesets
     become optional tools a human or a team applies to themselves (P-5).

### Restated invariant

The invariant in the root `CLAUDE.md` and in ADRs 0002 and 0008 reads, from this
record on: the hooks are a safety net for one machine that limits what the agent
does on its own. Together with human review at the gates that are already human
(the control-plane merge, ADRs and oracle tags), they are the workflow's
protection against the agent. CI and rulesets are tools a human or team applies
to themselves, not a guarantee against an agent holding the same token. The
hooks read a command as words and allow a form they cannot read, except
`guard-readonly`, which fails closed: it denies an event or a command it cannot
read, and its entry declares `onFailure: "block"`. The other fail-open and
fail-closed rules of ADRs 0002, 0010 and 0030 are unchanged.

### Roles and defaults

9. **The main session is the default implementer.** This replaces the default of
   ADR 0011.
   - M-1 defines `Implement: session | claude | codex` with `session` when the
     line is absent, and `Review: none | claude | codex` with `none` when it is
     absent.
   - A new line for the test role is added. Its name is left to M-1.
   - Agent files are defined only for roles that need a guarantee or a contract,
     such as a read-only boundary or a report shape.
10. **ATDD is a project workflow tool, and delegation is an architecture filled
    by user-level engines.**
    - The ATDD procedure (the oracle and implementation skills, and the levels
      that send every feature to it) moves from the user level to the projects
      that install the tool; P-3 carries the move. This replaces the parts of
      ADR 0003 that presume ATDD is the user-level workflow of every feature,
      including its consequence that the global `CLAUDE.md` lists the levels.
    - The guards an oracle tag switches on stay in the base (principle 4).
    - ADR 0012's decision stands: instructions live in `CLAUDE.md` alone, and a
      delegate gets its instructions from the task package. Its reasons that
      assume every task is delegated now hold wherever a task is delegated. The
      decision is kept because any repository may be delegated to in any
      session.
    - A nuance to ADR 0012: rules with `paths`, user or project, reach a
      subagent on a matching read without passing through the orchestrator,
      `omitClaudeMd` or not (spike, sections 2 and 3). The task package is the
      only source of a delegate's instructions except for those rules, so a
      path-scoped rule must suit a delegate as well as the session.

### Scope of ADRs 0025 and 0026

11. **Routing fills gaps and never questions a choice** (M-6), which resolves
    C-11.
    - ADR 0025, decision 2: the model and effort come from the matrix only when
      the call leaves them unset. An explicit value on the call is the choice.
    - ADR 0025, decision 4: the hook fills a missing model or effort, and never
      checks, overwrites or asks about an explicit one. When the client does not
      let it fill the input, it passes the call through with a visible message.
    - ADR 0025, decision 7: the values in `global/` are neutral to the
      subscription plan. A plan's windows are a constraint each user applies in
      `personal/`: the preference for Sonnet 5.5 at high effort over Opus 5.5
      for standard work under the Pro plan moves there. The values are
      calibrated by this project's own experiments, not fixed by a record.
    - Decision 3 stands: defaults in `global/`, overrides in `personal/`. The
      matrix applies to delegations built with `task-package`, the orchestration
      module, whatever the session architecture.
12. **The delegation report** (M-7): ADR 0026, decision 1 keeps the compact
    inline envelope and the full report in the scratchpad for delegations built
    with `task-package`, whatever the session architecture. A one-off query
    answers inline, with no envelope and no report file.
    - The severities blocking, should-fix and nit are defined once and reused by
      the envelope, the report and the reviews.
    - A finding's `verified` carries a value and a reason. This amends the
      verified flag of ADR 0015's report shape.

### Installation

13. **The installer owns one delimited block of `~/.claude/CLAUDE.md`, not the
    file.** The block holds a copy of the user core, never an import.
    - The core is not also installed as a rule, so it loads once on every
      surface that loads `~/.claude/CLAUDE.md`, Cowork included.
    - Everything outside the block belongs to the user and is never changed.
    - When the file is missing, the installer creates it holding only the block.
    - First migration: when the file has no block and is an unmodified copy of a
      previously installed version, the installer migrates it to the block, with
      a backup under ADR 0027.
    - In any other case, including an edited copy without a block or anything
      but exactly one intact block, the installer reports why and writes nothing
      to the file.
    - M-2 fixes the details, such as how an unmodified copy is recognised.
    - The markers and the block format are left to M-2 and are public interface
      from the release that introduces them (ADR 0031, item 4).
    - This replaces the audit plan's earlier decision that the installer stops
      owning the file altogether. It amends ADR 0001, whose generic layer is
      "installed into `~/.claude`" and today copies `global/CLAUDE.md` over the
      whole `~/.claude/CLAUDE.md`.
14. **Installed user rules use flat file names with the prefix
    `claude-atdd-workflow-`**, as in
    `~/.claude/rules/claude-atdd-workflow-<module>.md`.
    - The installer writes no other name under `~/.claude/rules/`, except
      `personal.md`, which keeps its name and its source
      (`personal/preferences.md`, ADR 0001).
    - Module rules stay rules.
15. **The fallback for a surface that does not load user rules** is the block of
    decision 13. Wherever `~/.claude/CLAUDE.md` loads, the core applies; module
    rules and `personal.md` may not. By principle 3 that is a valid environment.
    That the safety guards (the hooks and permission rules of `settings.json`)
    also apply on every surface that loads `~/.claude/CLAUDE.md` is not
    verified; it waits on the Cowork probe.
16. **Modules have a plugin-compatible structure and are not plugins**
    (principle 5). A module could later be packaged as a plugin for the parts
    plugins support without moving files, but this project does not distribute
    plugins.
    - A module's name is its name as a plugin would be, so it must pass `claude
      plugin validate` without an error. It never starts with `claude-`,
      `anthropic-`, `anthropics-` or `cc-plugin-`. It is never exactly `claude`,
      `anthropic`, `anthropics`, `claude-code` or `claude-mods`. It never puts
      `official` beside `claude` or `anthropic`. The check ignores case and runs
      of separators (see Context).
    - M-1, which decides which modules exist, keeps to it.
    - The rule files keep the prefix of decision 14, which names files, not
      modules: `claude-atdd-workflow-<module>.md`.

## Alternatives considered

- **Keep one `~/.claude/CLAUDE.md` holding everything, as today.** Rejected:
  - every line loads into every repository, including the levels, the delegation
    rules and the ATDD procedure that most tasks do not use;
  - it states as defaults what a project would contradict, against principle 2.
- **A minimal `~/.claude/CLAUDE.md` that imports the core and modules from
  `~/.claude/rules/`.** Rejected:
  - Imports do not reduce context cost (R-25).
  - In Cowork the imports resolve outside the working directory and are skipped,
    so the fallback would arrive empty on the very surface it exists for.
  - On the CLI and the desktop app the same files would also load as user rules.
    The documentation states no deduplication for that case; it states one only
    for `AGENTS.md`.
- **The core as a user rule, with no fallback until Cowork is probed.**
  Rejected: Cowork is a surface the human uses, and it has not been probed. A
  regular `~/.claude/CLAUDE.md` is the form that works today on every surface,
  the premise of ADR 0001. The documentation does not exclude regular rule files
  in Cowork, so a rule may well load there, but nothing shows it yet; the block
  keeps the core from depending on it.
- **The installer stops owning `~/.claude/CLAUDE.md` altogether**, the audit
  plan's earlier wording. Rejected: the fallback then has no writer, and a user
  would have to copy and update the core by hand on every release.
- **A subdirectory namespace, `~/.claude/rules/claude-atdd-workflow/`.**
  Rejected: recursive discovery is documented only for project rules, so it
  would need a probe on every surface, Cowork included. A prefix needs nothing.
- **Plugins as the install unit (R-41).** Rejected for principle 5: no
  always-loaded memory, no permission rules, and agents that ignore `hooks`,
  `mcpServers` and `permissionMode`. `guard-readonly` and the deny rules for
  secrets depend on those. Only the folder structure is kept.
  - A plugin's `SessionStart` hook could print the core as added context,
    standing in for the missing memory. That is not enough: it covers memory
    only, so the permission rules and the agent hooks are still missing. It also
    puts the core outside the instruction files that `InstructionsLoaded` audits
    and the spike measured.
- **Delegation by the session's own judgement of complexity, with "use
  proactively" agent descriptions (R-04).** Taken in part, as decision 1's
  middle point:
  - the session looks for and suggests delegation in the listed kinds of task;
  - it starts on its own only read-only Claude delegations that protect its
    context;
  - a writing delegation, a review or anything on Codex waits for the human.
  A fully proactive coordinator contradicts principle 1, and a strict "never
  suggest" wastes the session's context on exploration.
- **Claude Code in CI (R-37)**, as a required check or as an advisory review.
  Rejected:
  - the session architecture is local;
  - a CI review signed with the human's token adds no separation from the agent;
  - it costs every repository a maintained job.
- **A fresh-subagent review before work counts as done (R-39).** Not taken as a
  default: it contradicts `Review: none` and principle 1. It is suggested at the
  close in the orchestrated architecture when a spoke wrote production code, and
  a repository may declare it always.
- **Plan mode (explore, plan, implement) as a workflow mode (R-34).** Rejected
  as a tool of this workflow: it is native to Claude Code and the human uses it
  directly; wrapping it adds nothing.
- **Keep CI and rulesets as the guarantee (ADRs 0002 and 0008).** Rejected
  (principle 8): GitHub cannot tell the agent from the human, who share a token
  and administrator rights, so a ruleset binds the agent no more than the hook
  does.
- **`oracle-check` as a required CI check in the core, a ruleset on `oracle/**`
  with no bypass actors, and a hook on `gh pr create`.** Rejected, as in ADR
  0030. The CI check stays an optional tool (P-5).
- **Keep `claude-implementer` as the default implementer (ADR 0011).** Rejected:
  every code change, trivial ones included, would go to a delegate, against
  principle 1 (C-02). It also spends a delegation's budget where the session
  already holds the context; ADR 0025 counted all 14 measured implementer
  delegations at Opus high.
- **Keep ATDD at the user level (ADR 0003).** Rejected: its skill descriptions
  and its levels would load into every repository, including those that never
  use it, against principle 2. A project's process would also depend on the
  machine that works on it, the argument ADR 0001 makes against user-level stack
  rules.
- **A matrix that checks explicit choices (ADR 0025 as written).** Rejected: it
  questions a choice the human or the session made on purpose, an ask with no
  real consequence, against principle 8 (C-11).
- **The current scope of ADR 0026, an envelope and a report file from every
  delegate.** Rejected: a one-off query that answers in a few lines would pay a
  file write and a read-back for nothing. The envelope pays off for delegations
  built with `task-package`, whose reports are long.
- **A decision tree of task levels, as the global `CLAUDE.md` has today.**
  Rejected: the human names a mode in the prompt, and a tree applied by the
  model would choose tools the human did not ask for.

## Consequences

- ADRs 0001, 0002, 0003, 0008, 0011, 0012, 0015, 0025 and 0026 are accepted and
  frozen. Each gains `amended by 0032` in its front matter status, and their
  sentences stay as written. ADR 0029's consequence that names CI and rulesets
  as the guarantee also stays as written; this record restates it.
- Once this record is accepted, the invariant in the root `CLAUDE.md` that calls
  CI and rulesets "the guarantee" is restated as above in the same pull request.
- Nothing under `global/` changes here. M-1, M-2, M-4, M-6 and M-7 apply these
  decisions:
  - M-1: the `Implement:`, `Review:` and test-role lines, and the agents per
    role.
  - M-2: the core, the block and the namespaced rules.
  - M-4: the user skills and the effort of each skill.
  - M-6: routing.
  - M-7: the report.

  P-3 moves the ATDD skills to the projects that install the tool. The remaining
  conflicts of the audit plan (C-01, C-03 to C-10, C-12 and C-14) are assigned
  to M-1 (C-08), M-2, P-1, M-4, M-5 and Q-3.
- Under ADR 0031 these changes are major-class:
  - `global/CLAUDE.md` is no longer installed as the whole `~/.claude/CLAUDE.md`
    (item 1);
  - the absent `Implement:` line changes meaning from `claude` to `session`
    (item 5);
  - the ATDD skills leave the user level (a removal from item 1).

  These are minor-class additions: the values `Implement: session` and `Review:
  claude`, the test-role line, and the new rule files under `~/.claude/rules/`.
  ADR 0031 says v1.0.0 waits on a planned reorientation of the project; these
  changes are that reorientation.
- The first install that writes the block migrates an unmodified copy of a
  previous version, with a backup (decision 13). A user who edited the installed
  `~/.claude/CLAUDE.md` gets a report and no write, and moves those edits
  outside the block by hand. From then on, edits outside the block are kept.
- On a surface that loads `~/.claude/CLAUDE.md` but not user rules, the user's
  personal rule does not load, so preferences such as language and accessibility
  are lost there. Known gap, untested: Cowork was not probed, and a probe there
  settles whether the gap exists.
- `claude-implementer` and `claude-researcher` set `omitClaudeMd`, so they get
  neither the block nor the user rules without `paths`, and still need the task
  package (spike, section 2).
- A module meant for every project carries no `paths`. A user rule with `paths`
  acts per project, through subagents too.
- The human answers for the combination of architecture, tool and engines. The
  workflow no longer stops a combination it would not have chosen. It only
  guards what the agent does on its own.
