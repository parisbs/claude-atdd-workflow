---
status: accepted
date: 2026-10-20
---
# 0023. Collect donated session metrics through an allowlist script and fork pull requests

## Context

The repository is public (ADR 0022), and the evidence behind the workflow is
four probe records in `docs/experiments/` written by hand from one developer's
sessions. The orchestrator context probes computed their figures with a script
over the transcripts that was never committed, so nobody can reproduce them.
The roadmap's Measurement section planned an analysis script anyone could run
on their own data and stated that the aim was not to pool data from many
people. That aim changes here: anyone who uses the workflow should be able to
donate metrics from their own sessions, so that the evidence does not rest on
one developer.

What the transcripts hold, checked on 2026-10-20 over 123 local transcripts of
Claude Code 2.1.29x:

- Each line of `~/.claude/projects/<project>/<session>.jsonl` is a JSON record
  with one of at least sixteen `type` values, and the set of keys is
  undocumented and grows between releases. Subagent transcripts live in
  `<session>/subagents/agent-*.jsonl`.
- Assistant records carry `message.model`, `message.id` and `message.usage`
  (input, output, cache creation and cache read tokens), and `tool_use` blocks
  with the tool name. Other records carry `version`, `entrypoint`, `effort`
  and `permissionMode`.
- The same records carry what must never leave the machine: prompts, tool
  inputs and results, file snapshots, `cwd`, `gitBranch`, `sessionId`, uuids,
  `ownerAccountUuid`, `ownerOrganizationUuid`, `prUrl`, custom titles, and the
  names of MCP servers, which can name private systems. The project directory
  name encodes the local path.

Constraints from the request: the script must run on Windows, Linux and macOS;
the contributor reviews the report before sending it; a second, public review
happens on a pull request from a fork; nothing should need deep privacy
authorisations or a complex setup.

## Decision

- **Extraction.** `scripts/metrics-report.mjs`, a Node script without
  dependencies on the Node version of `package.json`, reads the transcripts
  under `$CLAUDE_CONFIG_DIR/projects`, or `~/.claude/projects` when the
  variable is unset, resolved with `os.homedir()` and `path.join` so that the
  same code serves Windows. It takes `--since`, `--until` and `--project` (a
  local path filter that is never written out) and writes one JSON file.
- **Allowlist, never a blocklist.** The report is built field by field from a
  fixed list. Any key the script does not know is dropped, so a new transcript
  field cannot leak through. The report holds no free text: every string is an
  enumeration or a value matched against a pattern, and anything else becomes
  `other`. One row per session, with:
  - `week`: the ISO week of the session's first record, for example
    `2026-W42`; no dates or times.
  - `cli_version`, matched against `^\d+\.\d+\.\d+$`.
  - `entrypoint` and `permission_mode`, from fixed enumerations.
  - `models`: the model ids used, matched against `^claude-[a-z0-9-]+$`;
    `efforts`: from a fixed enumeration.
  - `requests`: distinct `message.id` values; token sums for input, output,
    cache creation and cache read.
  - `duration_minutes`: from first to last record, rounded to whole minutes.
  - `tool_calls`: counts by tool name for Claude Code's built-in tools; every
    MCP tool counted under its server only when the server is one this
    repository ships in `global/mcp-servers.json`, and under `mcp:other`
    otherwise.
  - `skills`: counts for the skills this repository ships in `global/skills/`;
    any other skill counts under `other`.
  - `subagents`: the number of subagent transcripts and their token sums, with
    the agent type when it is one this repository ships in `global/agents/`.
- **Report header.** `schema_version`, `script_version`, the SHA-256 of the
  script file with line endings normalised to LF, the ISO week it was
  generated, and `license: CC0-1.0`. No contributor name or identifier: the
  pull request already carries the identity.
- **First review, by the contributor.** The script prints what it wrote in
  plain text: sessions, weeks, models and totals. The README asks the
  contributor to read the file before sending it.
- **Submission.** A pull request from a fork that adds one file under
  `docs/experiments/donated/`, named by the ISO week and a random suffix, using
  the `metrics-donation` pull request template.
- **Second review, in CI and by people.** A check on pull requests that touch
  `docs/experiments/donated/` runs the validator of the base branch, never the
  head's code, and fails when:
  - the pull request changes anything outside `docs/experiments/donated/` or
    changes an existing donated file;
  - the file has a key outside the schema, a string outside its enumeration or
    pattern, a negative or non-integer count, or totals that do not match the
    rows;
  - the script hash matches no version of the script on `main`;
  - the licence checkbox of the template is not ticked.
  Then a maintainer reviews and merges.
- **Licence and consent.** Donated data is published under CC0 1.0. The
  contributor accepts it by ticking a required checkbox in the template, which
  states that they have the right to share the data and dedicate it to the
  public domain. The README explains this before the contributor runs anything.
- **Stated limits.** The README and every analysis say that the data is
  self-reported and validated in form, not in origin; that a contributor's
  GitHub account is public through the pull request, so the data is
  de-identified in content but not anonymous; and that donors are
  self-selected.

## Alternatives considered

- **Prove that the script produced the report.** Rejected: everything runs on
  the contributor's machine, so any key or signature the script uses can be
  read and reproduced by hand. Artifact attestations only prove what ran in CI,
  and the transcripts never reach CI. The hash of the script and the schema
  check catch mistakes and stale versions, not fabrication, and the record says
  so instead of claiming more.
- **Blocklist of sensitive fields.** Rejected: the transcript format is
  undocumented and grows with each release; a blocklist leaks the first field
  it does not know.
- **Aggregate totals per contributor instead of one row per session.**
  Rejected: totals cannot separate sessions that used the workflow from those
  that did not, or one model from another, which are the comparisons the
  evidence needs. Truncating dates to the ISO week keeps the rows from showing
  when someone worked.
- **CC BY 4.0.** Rejected: attribution would have to follow every derived
  dataset and figure, which complicates pooling donations; counts and token
  sums may not be protected at all, and CC0 removes the doubt.
- **CDLA-Permissive-2.0.** Rejected in favour of CC0: less familiar to
  contributors, and nothing in it is needed for counts.
- **Consent by opening the pull request, stated only in the README.** Rejected:
  it leaves no record that the contributor saw the terms. A ticked checkbox in
  the pull request is as simple and leaves one.
- **DCO sign-off on each commit.** Rejected: more friction for a contributor
  who adds one file, and it certifies origin of code rather than a licence on
  data.
- **Free-text fields such as a note from the contributor.** Rejected: free text
  is where sensitive data and instructions aimed at agents that review the pull
  request would hide; context belongs in the pull request body.
- **A shell or PowerShell script per platform.** Rejected: Node is already the
  repository's only runtime, and one script tested on all three systems is less
  to keep in step.

## Consequences

- The workflow's evidence can be reproduced: the same script produces the
  maintainer's dataset and every donation, and the analysis can be rerun on
  `docs/experiments/donated/`.
- The test matrix in `.github/workflows/ci.yml` gains `windows-latest` for the
  metrics script's tests. The hook tests stay POSIX-only, so the Windows job
  runs only those tests. Changing `ci.yml` makes that pull request a human
  merge.
- Every change to the transcript format can silently shrink the report: an
  unknown field is dropped, not reported. The script must count the records and
  keys it skipped and print those counts, never their content, so that a
  maintainer notices the format moved.
- The allowlists of skills, agents and MCP servers follow what this repository
  ships. Adding a skill means it appears in reports from the next script
  version on.
- The validator runs on pull requests from forks with a read-only token and no
  secrets, and reads the donated file as data. A donation pull request that
  also touches the validator fails its own check, and `scripts/` is a human
  merge path.
- Pooled, self-selected data from different developers and projects cannot
  separate the effect of the workflow from the developer, the project or the
  model. The measurement protocol with hypotheses and covariates, which the
  roadmap asks for before the data is read, is still to be written; this record
  decides only how data is collected and shared.
- The roadmap's Measurement section said the aim was not to pool data from many
  people; it must be updated to point here. The optional local event log of
  hook decisions, such as attempts to touch protected paths, is not part of
  this record.
