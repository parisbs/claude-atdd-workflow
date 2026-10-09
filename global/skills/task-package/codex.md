# Codex

`codex_delegate` runs blocking unless the human asks for parallel or background work.
Job status is never polled in a loop.
Load the tools for the chosen role with ToolSearch:

- Reviewer: `select:mcp__codex-reviewer__codex_delegate,mcp__codex-reviewer__codex_follow_up`
- Implementer: `select:mcp__codex-implementer__codex_delegate,mcp__codex-implementer__codex_follow_up`

`codex_delegate` has a field for each part of the package:

- The goal and the acceptance criteria go to `acceptance_criteria`, and `prompt` states the goal in a sentence.
- Background, Base commit and prior findings go to `context`, the findings as records.
- Paths in scope go to `target_files`.
- The rules (constraints, scope out, invariants and conventions, the oracle and the verify command) go to `system_instructions`.
- The report is requested through `output_schema` with the schema below.
- The directory the delegate works on goes to `working_dir`, always: without it Codex runs in the directory the MCP server started in.

A writing delegation to `codex-implementer` (sandbox `workspace-write`) sets `use_worktree` to `true`.
Its worktree is made from the last commit, so uncommitted changes, ignored dependencies and build output are missing from it; commit what it needs before delegating, and say in the package what is absent.
The delegate reports a missing dependency (failure type missing-dependency) instead of changing production code to get around it.
It does not commit: its sandbox cannot write the repository's git index, so it leaves its changes uncommitted in the worktree, under `$CODEX_HOME/worktrees` (`~/.codex` by default).
A `codex_follow_up` to `codex-implementer` passes that worktree path as `working_dir`, so that it resumes in the worktree; without it, the follow-up writes the work branch directly, past the integration.
`guard-codex` denies a delegation or follow-up that breaks these rules.

To integrate the worktree, run `node ~/.claude/hooks/codex-integrate.mjs <worktree-path>` from the work branch.
It applies the worktree's changes, new and binary files included, runs `oracle-check`, and removes the worktree only once the changes are applied.
It exits 0 when oracle-check is clean and 1 when it reports a changed test path; the changes are on the work branch either way and stay uncommitted, so run the verify command there next.
When the script stops with exit 2, nothing was applied and the work branch is untouched: report what it printed and keep the worktree, so that the delegate's work is not lost.

## Report schema

Pass this report schema as `output_schema`:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["status", "failure_type", "what_changed", "checks_run", "checks_not_run", "findings", "left_out_or_unsure"],
  "properties": {
    "status": { "type": "string", "enum": ["done", "partial", "failed"] },
    "failure_type": {
      "type": "string",
      "enum": ["none", "missing-dependency", "oracle-test-wrong", "check-failing", "blocked-by-guard", "scope-conflict", "budget-exhausted", "other"]
    },
    "what_changed": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["file", "why"],
        "properties": { "file": { "type": "string" }, "why": { "type": "string" } }
      }
    },
    "checks_run": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["command", "result"],
        "properties": { "command": { "type": "string" }, "result": { "type": "string" } }
      }
    },
    "checks_not_run": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["check", "reason"],
        "properties": { "check": { "type": "string" }, "reason": { "type": "string" } }
      }
    },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["claim", "evidence", "source", "verified"],
        "properties": {
          "claim": { "type": "string" },
          "evidence": { "type": "string" },
          "source": { "type": "string" },
          "verified": { "type": "boolean" }
        }
      }
    },
    "left_out_or_unsure": { "type": "array", "items": { "type": "string" } }
  }
}
```
