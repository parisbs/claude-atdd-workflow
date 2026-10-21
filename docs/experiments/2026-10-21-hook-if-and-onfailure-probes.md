# Hook `if` and `onFailure` probes, 2026-10-21

The checks behind issue 27. They answer three questions:

- Does the `if` field of a hook match `gh pr merge` in every form guard-git reads as a merge?
- What else does such a pattern match?
- Does `onFailure: "block"` stop a merge when the merge guard cannot decide, and only then?

Each section states what was run and what was observed. Each variant ran once, so it shows that a behaviour
exists, not how often.

Environment: Claude Code 2.1.304 on macOS, headless `claude -p` with Haiku 5.5 and `--tools Bash`, started in an
empty directory with `--setting-sources project`, so that no user hook ran, and the probe hooks passed through
`--settings`. A fake `gh` first on `PATH` recorded its calls and changed nothing.

## 1. Where `if: "Bash(gh pr merge *)"` runs a hook

Method: two handlers on Bash. One without `if` logged every call and denied it, so nothing ran; one with
`if: "Bash(gh pr merge *)"` only logged. The model passed 30 commands verbatim, one per call, and the first
handler's log showed each of them as sent.

The handler with `if` ran for each of these 25 commands, every form guard-git reads as a merge:

- `gh pr merge 5 --squash --delete-branch`, `gh pr merge --squash`, a bare `gh pr merge` and `gh pr merge 5 -s`;
- after `cd /tmp &&` or `cd /tmp;`;
- after `GH_HOST=github.com`, `FOO=1 BAR=2` or `GH_HOST="github.com"`;
- with `-R owner/repo` or `--repo=owner/repo`, and with a `cd`, an assignment and `-R` together;
- after `echo start;`, `false ||`, `export GH_HOST=github.com &&` or a newline, and before `| cat`, `&& echo done`
  or `> /tmp/probe-out.txt`;
- inside `( ... )`, split by a line continuation, with `"gh"` or `"pr"` quoted, with `&&` inside a quoted
  argument, and with `$(...)` in an argument.

It did not run for `env GH_HOST=github.com gh pr merge 5 --squash` or `time gh pr merge 5 --squash`, which
guard-git does not read as merges either, nor for `gh pr view 5`, `echo gh pr merge 5 --squash` or `git status`.

## 2. What else such a pattern runs for

Method: as in section 1, with a third handler, `if: "Bash(gh *)"`, and 28 commands.

- `Bash(gh pr merge *)` also ran for `echo $(date)`, `` echo `date` ``, `echo "$(git rev-parse --show-toplevel)"`,
  `ls ${TMPDIR:-/tmp}`, `for f in a b; do echo $f; done`, `f() { echo hi; }; f`, `test -n "$X" && echo yes`,
  `x=$(gh pr view 5 --json url) && echo $x`, `gh pr merge $N --squash` and `$GH pr merge 5 --squash`.
- It did not run for `echo $HOME`, `echo "$HOME/x"`, `cd "$HOME" && ls`, `P=/tmp; cd "$P" && ls`, a here-document,
  `npm test 2>&1 | tail -5`, `git log --oneline -3`, `node -e "console.log(1)"`, `gh pr view 5`, `gh issue list`,
  `cd /tmp && gh pr checks 5`, `bash -c "gh pr merge 5 --squash"`, `eval "gh pr merge 5 --squash"`,
  `/usr/local/bin/gh pr merge 5 --squash`, `command gh pr merge 5 --squash`, `gh -R o/r pr merge 5 --squash` or
  `gh pr -R o/r merge 5 --squash`.
- `Bash(gh *)` ran for every command that starts with `gh`, the two with `-R` before `merge` included, for
  `$GH pr merge 5 --squash` and `x=$(gh pr view 5 --json url) && echo $x`, and for the loop, the function,
  `${TMPDIR:-/tmp}` and `test -n "$X"`; not for `echo $(date)`, the backticks or
  `echo "$(git rev-parse --show-toplevel)"`.

As the hooks reference documents, a pattern that names more than the command runs the hook for `$()` and
backticks, and any pattern runs it for what Claude Code cannot parse; a plain `$VAR` does not. Neither pattern
reaches `bash -c`, `eval`, `env`, `time`, `command` or an absolute path to `gh`.

So the merge entry also runs for many commands that are not merges: `--merge-only` must stay silent and fast for
them, and when it cannot start at all those commands are blocked too.

## 3. `onFailure: "block"` with the hooks of the branch

Method: the two guard-git entries of the branch, with absolute paths to its hooks: the general one with
`--skip-merge` and a 15 s timeout, and the merge one with `if: "Bash(gh pr merge *)"`, `--merge-only` and
`onFailure: "block"`. The fake `gh` hung on `pr view` and recorded `pr merge` if it ever ran. `--allowedTools`
allowed `Bash(gh pr merge *)` and `Bash(echo *)`, so a call that no hook stopped would run. Three variants:

- A, the merge entry with a 5 s timeout, and `GUARD_GIT_GH_TIMEOUT_MS` and `GUARD_GIT_GH_BUDGET_MS` at 60000 so
  that the hook outlived it. `gh pr merge 12 --squash` came back as
  `PreToolUse:Bash hook error: [node ".../guard-git.mjs" --merge-only]: timed out; blocking because onFailure is "block"`.
  `echo probe-a-ok` ran.
- B, the merge entry pointing at a script that does not exist. `gh pr merge 12 --squash` came back as
  `... --merge-only]: failed; blocking because onFailure is "block"`, followed by Node's `Cannot find module`.
  `echo probe-b-ok` ran, and `echo $(echo probe-b-subst)` was blocked with the same error, because `if` runs the
  entry for `$()`.
- C, the general entry pointing at a script that does not exist. `echo probe-c-ok` ran, and
  `gh pr merge 12 --squash` came back with the ask of the merge entry,
  `Could not read the pull request: gh timed out after 6000 ms. The human decides this merge (ADR 0010).`; headless,
  the call did not run.

`gh pr merge` never ran in any variant. In A and C, `echo $(echo ...)` was refused by the permission check of
`-p` mode (`A nested command in this command can't be checked before it runs`), not by a hook.

## 4. What this leaves open

- The split relies on `if` matching every form guard-git reads as a merge. Section 1 is worth repeating when a
  Claude Code release changes how `if` matches.
- A merge written as `env gh ...`, `time gh ...` or `command gh ...`, through an absolute path to `gh`, or inside
  `bash -c` or `eval` reaches neither guard-git nor the merge entry; the rulesets stay the guarantee.
- `install.mjs --check` reads the `claude` on `PATH`, which can differ from the version a desktop app runs.
