---
status: accepted, amended by [0034](0034-guard-high-consequence-gates-by-consequence-not-by-form.md)
date: 2026-10-28
---
# 0033. Ask before amending a frozen test in the main session

- Amends: [0003](0003-approved-tests-replace-behaviour-specs.md) (the guard denies Edit and Write on test paths), [0010](0010-move-human-control-to-the-specification-and-gate-merges.md) (amending a frozen test is human only)
- Issue: #64

## Context

ADR 0003 freezes the approved tests with an `oracle/<branch>` tag, and
`guard-tests` denies every Edit and Write of a test path while the tag exists.
ADR 0010 makes amending a frozen test a human-only action. The denial holds
even after the human approves an amendment, so the human has to open a
terminal and change the file themself; it happened in A-4. From a remote
session (Remote Control, phone or web) there is no terminal.

ADR 0029 met the same problem for oracle tags and settled the pattern: in the
main session the guard asks, with evidence the hook reads itself; a subagent
is denied; the main session in `bypassPermissions` is denied, because nothing
documents that a hook's `ask` prompts there. Its context holds the facts
checked in Claude Code 2.1.308: an `ask` forces a prompt in auto mode, Remote
Control keeps prompts open, and in a `-p` run or a subagent an unanswerable
`ask` becomes a denial.

Two ways to change a frozen test passed no guard. ADR 0003 records that a Bash
command gets around `guard-tests`, and auto mode tells the agent to edit files
with `sed` and heredocs. A Codex delegation writes in its own worktree, which
no Claude Code hook sees, and `codex-integrate` applied its changes to the work
branch before `oracle-check` reported a changed test. The merge guard of
ADR 0030 compares the pull request's head with the tag, so neither reached a
merge unnoticed, but both were found only at the end.

## Decision

- In the main session, an Edit, Write or NotebookEdit of a frozen test path
  asks instead of being denied. The reason names the repository-relative path,
  the oracle tag, the commit it points to, and whether the file exists in that
  commit (amended) or not (added); a Bash deletion says deleted. The tool's own
  prompt shows the change. The amendment stays human-only: the human decides
  in the prompt.
- A subagent (an event with `agent_id`) is denied. The main session in
  `bypassPermissions` is denied, and the reason says to switch to a mode that
  shows permission prompts.
- `guard-tests` gains a Bash entry that reads the forms an agent uses to write
  a file and gives them the same verdict as an Edit: output redirection and
  heredocs, `tee`, in-place editing (`sed -i`, `perl -i`, `ruby -i`), `cp`,
  `mv`, `install`, `ln` (including `-s` without `-f`), `rm`, `touch` and
  `truncate` on the path, `git checkout -- <path>`, `git checkout <path>`
  when the operand names a frozen file or an existing directory, `git restore`, `git rm` and `git mv`.
  File-descriptor redirects (`2>`, `2>&1`, `1>`, `&>` and `>& file`) are read.
  Inline interpreters ask only when their script text names a frozen file or
  test-configuration path,
  relative to the repository or command's working directory. This includes
  `node -pe`, `perl -we`/`-pie`, versioned `python3.x -c`, and interpreter
  scripts supplied through a heredoc (`python3 -`, `node`). `bash -c`,
  `bash -lc`/`-ce`, `sh -ec`/`-cx`, `zsh -c` and shell heredocs are read as nested commands.
  Before the script flag, the reader skips values for shell `-o`/`-O`
  (including `bash -euo pipefail`), Python `-W`/`-X`, Node
  `-r`/`--require`/`--import`, and Perl or Ruby `-I`.
  `git restore --staged` or `-S` without `--worktree` or `-W` changes only
  the index and gets no verdict.
  The reader handles compound commands, a leading `cd <dir> &&`, keyword
  prefixes (`if`, `elif`, `while`, `until`, `then`, `do`, `else`, `{`, `!`,
  `time`), wrappers (`sudo`, `doas`, `nice`, `stdbuf`, `nohup`,
  `timeout <n>`, `exec`, `command`, `env` with or without assignments),
  combined in-place flags (`sed -Ei`/`-ri`/`-ni`/`-i.bak`), brace alternatives
  in targets, globs (including `**` and directory matches) against the oracle inventory, and `find` with
  `-delete`, `-exec`, `-execdir` or `xargs`. `find` reads `-name`, `-type f`,
  `-depth`, `-print` and `-print0`; `xargs` options and `-I` replacements are
  read even after any intervening pipeline stage. The reader carries the
  original `find` candidates through these stages without applying their
  transformations: `grep -v`, for example, does not remove a candidate. A command that
  only reads or runs the tests gets no verdict. A test-configuration path
  written this way asks, as for an Edit.
- Directory targets and `find` candidates use the frozen test and configuration
  paths recorded in the oracle commit, read once per repository. They never
  walk the working tree: untracked dependency and build trees contribute no
  candidates. Explicit file targets still protect new test paths as additions.
  Targets without a wildcard resolve symlinks and discover their own repository,
  including external repositories and linked worktrees. Globs use only the
  repository discovered at their fixed prefix. Directory and exact-path indexes are built
  once per repository; inline names use exact lookups. A preceding `mkdir`
  supplies directories for later `cd`, including `cd -P` and `cd --`;
  `pushd` and `popd` track the working directory too. Repository discovery is
  cached per directory. Git reads use a 64 MiB buffer, disable lazy fetching
  and kill stalled git processes with SIGKILL. Git and CPU work share a 10 s
  deadline, with at most 8 s of CPU for reading and matching, below the 15 s entry
  timeout. If the inventory cannot be read, explicit test file targets still get
  the session's verdict and say the change label could not be read, provided
  the CPU and time budgets have not expired. Reasons
  list at most 20 paths, then count the remaining paths. Errors are reported on stderr and fail open for
  unread work; an ask or deny already collected is still emitted. Here-strings
  (`<<<`), process substitutions (`<(...)`, `>(...)`), read-write redirects
  (`<>`), arithmetic shifts (`$((1<<2))`) and unterminated heredocs do not
  discard later commands.
- `codex-integrate` applies nothing when the Codex worktree changes, adds or
  deletes a frozen test path; it exits 2, keeps the worktree and names the
  paths. An unreadable oracle test-path declaration also stops integration
  before anything is applied, with exit 2 and the worktree kept.
- After an approved amendment, the oracle tag is moved to the commit that
  holds it, which asks (ADR 0029). Until it moves, the merge guard finds test
  paths changed against the tag, and the agent's merge does not go through
  without the human.

## Alternatives considered

- Keep the denial (ADR 0003 and 0010 as they are). Rejected: an approved
  amendment needs a terminal, which a remote session does not have.
- Ask in every mode, `bypassPermissions` included. Rejected for the reason
  ADR 0029 gives: if that mode skips the hook's question, a frozen test would
  change with no human decision at all.
- Ask for subagents too. Rejected: a subagent's question is not shown in every
  session, and a delegate never needs to change the oracle.
- Leave Bash as a known gap and rely on the merge guard. Rejected: editing by
  Bash is the agent's usual path in auto mode, so the gap would be the common
  case, and the human would learn of it only at the merge.
- Have the agent describe the amendment in the question. Rejected: when the
  human decides, the evidence is read by the hook, never written by the agent.
- Integrate a Codex worktree's other changes and drop only the test paths.
  Rejected: the rest of the change may depend on the dropped test edit, and a
  partial integration is harder to see than none.

## Consequences

- The human can approve an amendment from any session that shows prompts,
  Remote Control included.
- The Bash reader allows what it cannot read, as the hooks do (ADR 0002).
  Known gaps, still caught by `oracle-check` and the merge guard (ADR 0030):
  git operations that bring content from elsewhere (`git apply`, `git am`,
  `git stash pop` or `apply`, `git reset --hard`, `git merge`, `git rebase`,
  `git cherry-pick`, `git revert`, `git switch <branch>` and
  `git checkout <branch>`); patch and transfer tools (`patch`, `rsync`,
  `tar -x`, `unzip`, `curl -o`, `wget -O`, `dd of=`); formatters and fixers
  (`prettier --write`, `eslint --fix`, `dart format`); scripts in files,
  `npm run` and `make`; paths built from variables, command substitution or
  `eval`; links created earlier that point at a test; and MCP tools that
  write files or run commands, which pass neither Bash nor Edit.
  Other unread forms are `find` predicates beyond the list above (including
  `-type d`, `-empty`, `-path`, boolean expressions and pruning), `find`
  traversal through symlinks or nested repositories, directory contents absent
  from the oracle commit and brace ranges
  (`{1..3}`), dynamically generated stdin scripts, here-string scripts,
  command/process substitutions and shell functions. Pipeline transformations
  are not evaluated, and `xargs` input from sources other
  than `find` is not inferred. Unlisted wrapper options and interpreter flag
  combinations may also pass unread.
  Git pathspec globs passed to `git rm`, `git checkout` or `git restore`
  are read with shell semantics: the hook's `*` does not cross `/`, whereas
  Git's does, so a root-level `'*.test.js'` can miss nested frozen tests.
  Globs cannot collect candidates in another repository or a nested linked
  worktree, as in `rm -rf .claude/worktrees/*/test`, `rm -rf ~/git/*/test`
  or `rm -rf ../proj*/test`; only paths without a wildcard discover their own
  repository. Once the CPU or time budget expires, later explicit Bash
  targets get no verdict. An unreadable inventory also leaves directory
  targets such as `rm -rf test` without a verdict; these failures are reported
  on stderr.
  Unread wrappers and interpreters include `ionice`, `taskset`, `flock`,
  `caffeinate`, `uv run`, `poetry run`, `time -p`, `bun -e`, `deno eval`
  and `php -r`. Other gaps include output redirection inside an `awk` script,
  bracket globs such as `rm -rf t[e]st`, `rm -rf ..` from the repository
  root, and case variants on case-insensitive file systems.
- Naming a frozen path in an inline interpreter's script asks even when the
  script only reads it. Interpreter flags are read only before a script-file
  operand or `-m`; arguments to a module or script that runs tests give no
  verdict. If that proves noisy, moving the form to the known
  gaps is a new decision.
- `git checkout oracle/<branch> -- <path>`, which restores the frozen version,
  also asks: the hook does not compare contents.
- `guard-tests` reads `permission_mode` and `agent_id` from the event; if
  Claude Code renames them, the bypass or subagent denial stops applying.
- ADR 0003 and ADR 0010 are accepted and frozen; their sentences on the
  denial, and ADR 0003's "can be bypassed through Bash", stay as written. Once
  this record is accepted, both records' status gains the annotation
  `amended by 0033`.
