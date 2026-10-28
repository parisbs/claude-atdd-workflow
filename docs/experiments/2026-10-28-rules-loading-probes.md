# Rules loading probes, 2026-10-28

The checks behind B-1, the record that would move the installed user instructions from one
`~/.claude/CLAUDE.md` into a short core plus namespaced user rules, with path-scoped project rules for each
stack (P-2). That only works if rules load as expected on each surface and in the subagents that set
`omitClaudeMd`. The probes answer three questions:

1. Does a user rule (`~/.claude/rules/`) without `paths` load at session start?
2. Does a user rule with `paths` load only after a matching project file is read, and not before? Does a
   project rule with `paths` behave the same?
3. Do subagents that set `omitClaudeMd` (`claude-implementer`, `claude-researcher`) skip those rules? Does a
   subagent without it, for comparison?

Each variant ran once, so it shows that a behaviour exists, not how often.

## Answers

| Question | CLI (`claude -p`) | Desktop app (Code tab) | Cowork |
| :- | :- | :- | :- |
| 1. User rule without `paths` | Loads at session start | Loads at session start | Not tested |
| 2a. User rule with `paths` | Loads only on reading a matching file | Loads only on reading a matching file | Not tested |
| 2b. Project rule with `paths` | Loads only on reading a matching file | Loads only on reading a matching file | Not tested |
| 3a. Subagent with `omitClaudeMd` | Skips every eager file, user rules included; still gets path-scoped rules, user and project, on a matching read | Same as the CLI | Not tested |
| 3b. Subagent without `omitClaudeMd` | Gets every eager file and the path-scoped rules on a matching read | Same as the CLI | Not tested |

Cowork was not tested: see section 5.

## Evidence source

`InstructionsLoaded` is documented in the hooks reference
(<https://code.claude.com/docs/en/hooks#instructionsloaded>, read on 2026-10-28). It fires "when a `CLAUDE.md`
or `.claude/rules/*.md` file is loaded into context", at session start for eager files and later for lazy
loads such as rules whose `paths:` match. Besides the common fields (`session_id`, `agent_id`, `agent_type`),
it carries `file_path`, `memory_type` (`User`, `Project`, `Local`, `Managed`), `load_reason`
(`session_start`, `nested_traversal`, `path_glob_match`, `include`, `compact`), `globs` and
`trigger_file_path`. It cannot block. The memory page says a path-scoped rule loads when Claude uses Read,
Write or Edit on a matching file, and that user rules resolve `paths` against the session's primary working
directory. The sub-agents page says `omitClaudeMd` starts a subagent "without the user, project, and local
CLAUDE.md files", and that path-scoped rules "still load when the subagent works with files there".

One gap showed up in the probes: when a subagent starts, `InstructionsLoaded` does not fire for the files it
loads eagerly; it fires in the subagent only for path-scoped loads. What a subagent received at start was
therefore read from its own transcript, `~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl`,
by counting the marker lines in it.

## Environment

Claude Code 2.1.310 on macOS 26 (Darwin 25.6.0). The logging hook is a small Node script that appends the
hook input, trimmed to the fields above plus a timestamp, as one JSON line to a log outside the repository:

```js
import { appendFileSync } from 'node:fs';
let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  const e = JSON.parse(raw);
  const keep = {
    t: new Date().toISOString(), event: e.hook_event_name, session: e.session_id?.slice(0, 8),
    agent_id: e.agent_id, agent_type: e.agent_type, file_path: e.file_path, memory_type: e.memory_type,
    load_reason: e.load_reason, globs: e.globs, trigger_file_path: e.trigger_file_path,
    tool: e.tool_name, tool_file: e.tool_input?.file_path, subagent: e.tool_input?.subagent_type,
  };
  appendFileSync(process.argv[2], JSON.stringify(keep) + '\n');
});
```

It ran on `InstructionsLoaded` (every load reason), on `PreToolUse` for `Read|Agent|Task` and on
`SubagentStart`, so the log orders each load against the read that triggered it.

Each rule holds one marker line, `- Probe marker <ID>: ...`, so a transcript or a model's report shows
whether the rule reached that context:

- `P-ALWAYS`: project rule without `paths`, `.claude/rules/project-always.md`.
- `P-SCOPED`: project rule with `paths: ["src/**/*.ts"]`, `.claude/rules/project-scoped.md`.
- `U-SCOPED`: user rule with `paths: ["rules-probe-user/**/*.txt"]`, `~/.claude/rules/zz-rules-probe.md`,
  created by the user for the probe and removed afterwards.
- The installed `~/.claude/rules/personal.md`, which has no `paths`, stands for a user rule without `paths`;
  its line `- Do not agree just to please.` is its marker.

Two project agents, `probe-omit` (with `omitClaudeMd: true`) and `probe-plain` (without), have `tools: Read`
and `model: haiku`; the installed `claude-implementer` and `claude-researcher` both set `omitClaudeMd: true`.

### Isolation

An isolated user configuration (`CLAUDE_CONFIG_DIR`, or a temporary `HOME`, pointing at a scratch directory
with its own rules, agents and hook) loads its rules, as the hook showed, but the session cannot start: it
answers `Not logged in · Please run /login`, because the login lives in the real configuration. So the CLI
probes ran with the real user configuration, read-only, and added the hook either through `--settings` or
through the probe project's own `.claude/settings.json`. The only change to `~/.claude` was the `U-SCOPED`
rule, which the user created and removed by hand.

## 1. CLI, main session

Method: in an empty git repository holding the probe rules, `CLAUDE.md`, `notes.md`, `probe/a.txt` and
`src/b.ts`, with the hook in `hook-settings.json`:

```sh
claude -p "Use the Read tool on notes.md, then on probe/a.txt, then on src/b.ts, one call at a time. Then reply with every line starting with '- Probe marker' that is in your context." \
  --model haiku --settings hook-settings.json --allowedTools Read
```

Log, paths shortened:

```text
15:35:14.033 InstructionsLoaded ~/.claude/rules/personal.md          User    session_start
15:35:14.148 InstructionsLoaded CLAUDE.md                            Project session_start
15:35:14.188 InstructionsLoaded ~/.claude/CLAUDE.md                  User    session_start
15:35:14.211 InstructionsLoaded .claude/rules/project-always.md      Project session_start
15:35:19.322 PreToolUse Read notes.md
15:35:21.517 PreToolUse Read probe/a.txt
15:35:23.634 PreToolUse Read src/b.ts
15:35:23.830 InstructionsLoaded .claude/rules/project-scoped.md      Project path_glob_match globs=["src/**/*.ts"] trigger=src/b.ts
```

The user rule without `paths` and the project rule without `paths` load at session start. The project rule
with `paths` stays out through two non-matching reads and loads right after `src/b.ts`, which the log names as
the trigger.

## 2. CLI, subagents

Method: the same project, four separate runs, one per agent, with the main session told not to read
anything itself:

```sh
claude -p "Do not read any file yourself. Use the Agent tool once with subagent_type \"<agent>\" and this prompt: 'Use the Read tool on src/b.ts and then on probe/a.txt, one call at a time. Change nothing. Report each file's first line, then quote every line starting with \"- Probe marker\" and every line starting with \"- Do not agree\" that is in your context, or say none.' Then reply with the subagent's report verbatim." \
  --model haiku --settings hook-settings.json --allowedTools "Read Agent"
```

In every run the main session logged the same four `session_start` loads as in section 1. For each subagent
the log shows `SubagentStart`, its read of `src/b.ts`, and then one `InstructionsLoaded` with its own
`agent_id` and `agent_type`:

```text
probe-plain        PreToolUse Read src/b.ts
probe-plain        InstructionsLoaded .claude/rules/project-scoped.md Project path_glob_match trigger=src/b.ts
probe-omit         InstructionsLoaded .claude/rules/project-scoped.md Project path_glob_match trigger=src/b.ts
claude-researcher  InstructionsLoaded .claude/rules/project-scoped.md Project path_glob_match trigger=src/b.ts
claude-implementer InstructionsLoaded .claude/rules/project-scoped.md Project path_glob_match trigger=src/b.ts
```

No subagent logged a `session_start` load. Marker counts in each subagent's transcript (`P-ALWAYS`, `P-SCOPED`,
the `personal.md` line, the `~/.claude/CLAUDE.md` heading `Workflow defaults`):

```text
probe-plain         P-ALWAYS=3 P-SCOPED=3 personal=3 userCLAUDE=2
probe-omit          P-ALWAYS=0 P-SCOPED=3 personal=0 userCLAUDE=0
claude-researcher   P-ALWAYS=0 P-SCOPED=3 personal=0 userCLAUDE=0
claude-implementer  P-ALWAYS=0 P-SCOPED=3 personal=0 userCLAUDE=0
```

Each subagent's own report agreed: `probe-plain` quoted `P-ALWAYS`, `P-SCOPED` and the `personal.md` line; the
three with `omitClaudeMd` quoted only `P-SCOPED`, which they saw arrive in a reminder after reading `src/b.ts`.

So `omitClaudeMd` drops the user rules without `paths` as well as the `CLAUDE.md` files and the project rules
without `paths`, and it does not stop path-scoped rules.

## 3. CLI, user rule with `paths`

Method: the user created `~/.claude/rules/zz-rules-probe.md`:

```sh
printf -- '---\npaths:\n  - "rules-probe-user/**/*.txt"\n---\n- Probe marker U-SCOPED: user rule scoped to rules-probe-user/**/*.txt.\n' > ~/.claude/rules/zz-rules-probe.md
```

A second probe project carried the hook in its own `.claude/settings.json`, with the command
`node "$CLAUDE_PROJECT_DIR/.claude/log.mjs" "$CLAUDE_PROJECT_DIR/.claude/rules-probe.log"`, and a `PROBE.md`
that asks the main session to run `probe-omit`, `probe-plain` and `claude-researcher` on `src/b.ts` and
`rules-probe-user/a.txt`, and then to read `notes.md`, `rules-probe-user/a.txt` and `src/b.ts` itself:

```sh
claude -p "Follow the instructions in PROBE.md." --model haiku --allowedTools "Read Agent"
```

Log, condensed:

```text
main              InstructionsLoaded ~/.claude/CLAUDE.md, CLAUDE.md, ~/.claude/rules/personal.md, .claude/rules/project-always.md  session_start
probe-plain       PreToolUse Read src/b.ts
probe-plain       InstructionsLoaded .claude/rules/project-scoped.md  Project path_glob_match trigger=src/b.ts
probe-plain       PreToolUse Read rules-probe-user/a.txt
probe-plain       InstructionsLoaded ~/.claude/rules/zz-rules-probe.md User   path_glob_match trigger=rules-probe-user/a.txt
probe-omit        (the same two pairs)
claude-researcher (the same two pairs)
main              PreToolUse Read notes.md
main              PreToolUse Read rules-probe-user/a.txt
main              PreToolUse Read src/b.ts
main              InstructionsLoaded ~/.claude/rules/zz-rules-probe.md User   path_glob_match trigger=rules-probe-user/a.txt
main              InstructionsLoaded .claude/rules/project-scoped.md  Project path_glob_match trigger=src/b.ts
```

The user rule with `paths` is not among the `session_start` loads, and loads only after a read of a file it
matches, in the main session and in each subagent, `omitClaudeMd` or not. Its `paths` resolved against the
probe project, the primary working directory. In the main session the two lazy loads were logged together
after the third read, 0.8 seconds after the read of `rules-probe-user/a.txt`; each still names its own trigger
file, and neither came before its trigger.

The runs above started from a shell inside the desktop app, so the environment they inherited set
`CLAUDE_CODE_ENTRYPOINT=claude-desktop`; the process was still the standalone `claude` binary in print mode.

## 4. Desktop app

Method: this probe's own session, a Code tab session of the Claude desktop app, in the worktree of this
repository. Computer use cannot drive the Claude app itself (it is not offered among the apps it can control),
and the hook cannot be added to the running session's settings, so the evidence is what the session received.

- Question 1: the session started with `~/.claude/rules/personal.md` in its context, next to
  `~/.claude/CLAUDE.md` and the repository's `CLAUDE.md`.
- Question 2: with `~/.claude/rules/zz-rules-probe.md` in place, and with an untracked project rule
  `.claude/rules/zz-probe-scoped.md` (`paths: ["rules-probe-proj/**/*.ts"]`, marker `P-SCOPED-DESKTOP`) created
  during the session, neither marker was in context. Reading `rules-probe-user/a.txt` brought the `U-SCOPED`
  rule in a reminder attached to that read; reading `rules-probe-proj/b.ts` then brought `P-SCOPED-DESKTOP` the
  same way. A project rule created after the session started was still picked up.
- Question 3: the session ran `claude-researcher` (with `omitClaudeMd`) and `general-purpose` (without it),
  each told to read `rules-probe-proj/b.ts` and then `rules-probe-user/a.txt`. Marker counts in their
  transcripts:

  ```text
  claude-researcher  U-SCOPED=3 P-SCOPED-DESKTOP=3 personal=0 userCLAUDE=0
  general-purpose    U-SCOPED=3 P-SCOPED-DESKTOP=3 personal=3 userCLAUDE=2
  ```

  Both reported each path-scoped rule arriving in a reminder after the matching read, and not before; only
  `general-purpose` had the `personal.md` line.

The untracked files were removed after the probe.

## 5. Cowork

Not tested. Cowork runs inside the same Claude app, which computer use cannot drive, and a Cowork task cannot
be started from a Code session. The user did not run it by hand. The memory page documents Cowork-specific
limits on user-scope files: it skips imports in them that resolve outside the session's working directory, a
`~/.claude/CLAUDE.md` that is a symlink or hard link, and a symlinked `~/.claude/rules/` directory or rule file
that points outside the working directory. Regular files in `~/.claude/rules/`, which the installer copies,
are not among those limits, but that is documentation, not a probe.

## Consequences for B-1 and P-2

- Path-scoped project rules work for P-2 on the CLI and the desktop app, in the main session and in every
  subagent, including those that set `omitClaudeMd`.
- A user rule without `paths` behaves like `~/.claude/CLAUDE.md`: a subagent with `omitClaudeMd` does not get
  it. Moving the user core into rules does not change what `claude-implementer` and `claude-researcher`
  receive: they still need the task package.
- A user rule with `paths` does reach those subagents when they read a matching file, and resolves its globs
  against whichever project the session is in. A user module meant for every project should not carry
  `paths`; one with `paths` acts per project, through the subagents too.
- `InstructionsLoaded` is enough to audit lazy loads, but not what a subagent loads at start; for that the
  transcript is the record.
