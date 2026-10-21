# Researcher frontmatter hook probes, 2026-10-21

The checks behind issue 29. They answer three questions:

- Does Claude Code run a PreToolUse hook declared in a subagent's frontmatter, for a user agent in
  `~/.claude/agents` as well as for one passed with `--agents`?
- Does it run that hook only inside the agent that declares it?
- Does `onFailure: "block"` in the frontmatter block the call when the hook cannot run?

Each variant ran once, so it shows that a behaviour exists, not how often.

Environment: Claude Code 2.1.304 on macOS, headless `claude -p` with Haiku 5.5, started in an empty directory with
`--setting-sources user,project`, `--allowedTools "Bash(echo *)" Agent` and `--permission-mode acceptEdits`. A probe
hook, `log.mjs`, appended every event it received to a log with a tag naming where it was declared, the
`agent_id`, the `agent_type` and the command. A second copy, passed through `--settings` with the tag `global`,
logged every Bash call of the session. A frontmatter copy denied any command that contained `probe-write`. The two
user agents were written to `~/.claude/agents` for the run and removed after it.

## 1. Where a frontmatter hook runs

Method: the main session ran `echo main-call` and then started five agents, each asked to run its commands
verbatim:

- `probe-cli`, passed with `--agents`, with a hook in its JSON definition;
- `probe-plain`, passed with `--agents`, without hooks;
- `probe-user-fm`, a user agent with the hook in block YAML;
- `probe-user-block`, a user agent whose hook points at a script that does not exist, with `onFailure: "block"`;
- the installed `claude-implementer`.

Observed:

- The frontmatter hook ran for each Bash call of `probe-cli` and `probe-user-fm`, and its event carried
  `agent_id` and `agent_type` (`probe-cli`, `probe-user-fm`). `echo cli-read` and `echo user-read` ran;
  `echo cli > probe-write-cli.txt` and `echo user > probe-write-user.txt` came back as
  `PreToolUse:Bash hook error: probe fm-cli denies writes` (and `fm-user`), and no file was written.
- It did not run for `echo main-call` in the main session, whose event carried no `agent_id` or `agent_type`, nor
  for `probe-plain` or `claude-implementer`, whose events carried their own `agent_type`. `probe-plain` wrote
  `probe-write-plain.txt`.
- `probe-user-block` did not run `echo block-read`: the call came back as
  `PreToolUse:Bash hook error: [node ".../missing.mjs"]: failed; blocking because onFailure is "block"`, followed by
  Node's `Cannot find module`.
- The `global` hook logged every Bash call of every agent, as before.

## 2. Hooks on one line of JSON

Method: as in section 1, with two user agents whose `hooks` field is one line of JSON, which is valid YAML:
`probe-user-flow`, with the logging hook and `onFailure: "block"`, and `probe-user-flowblock`, pointing at a script
that does not exist.

Observed: `echo flow-read` ran and the frontmatter hook logged it with `agent_type` `probe-user-flow`;
`echo flow > probe-write-flow.txt` was denied with the probe's reason and wrote nothing; `echo flowblock-read` was
blocked with the same `failed; blocking because onFailure is "block"` message as in section 1.

## Conclusion

On Claude Code 2.1.304 a frontmatter hook is a per-agent guard: it runs only while the agent that declares it is
active, for user agents as well, and `onFailure: "block"` holds there. So `claude-researcher` declares
guard-readonly in its own frontmatter, and the alternative of a global hook that filters on `agent_type` is not
needed. The hooks are written as one line of JSON so that the tests can read them without a YAML parser.
