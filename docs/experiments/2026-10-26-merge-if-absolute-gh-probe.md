# Merge entry `if` and an absolute-path `gh`, 2026-10-26

The check behind issue 57 (AC-7). It answers one question: which `if` pattern starts the merge entry of
`global/settings.json` when `gh` is called by a path rather than by name?

Each variant ran once, so it shows that a behaviour exists, not how often.

Environment: Claude Code 2.1.308 on macOS, headless `claude -p` with Haiku 5.5 and `--tools Bash`, started in an
empty directory with `--setting-sources project`, so that no user hook ran, and the probe hooks passed through
`--settings`. Three handlers on Bash: one without `if` logged every call and exited 2, so nothing ran; one with
`if: "Bash(*gh pr merge *)"` and one with `if: "Bash(gh pr merge *)"` only logged. The model passed ten commands
verbatim, one per call, and the first handler's log showed each of them as sent.

| Command | `Bash(*gh pr merge *)` | `Bash(gh pr merge *)` |
| --- | --- | --- |
| `gh pr merge 5 --squash` | ran | ran |
| `<scratch>/bin/gh pr merge 5 --squash` | ran | did not run |
| `/opt/homebrew/bin/gh pr merge 12 --squash --delete-branch` | ran | did not run |
| `./gh pr merge 5 --squash` | ran | did not run |
| `cd /tmp && /usr/local/bin/gh pr merge 5 --squash` | ran | did not run |
| `GH_HOST=github.com /usr/bin/gh pr merge 5 -s` | ran | did not run |
| `echo gh pr merge 5` | ran | did not run |
| `ghx pr merge 5` | did not run | did not run |
| `gh pr view 5` | did not run | did not run |
| `gh pr list` | did not run | did not run |

Findings:

- `Bash(gh pr merge *)` does not start the entry for `gh` by any path, so the merge decision is skipped entirely
  for `/opt/homebrew/bin/gh pr merge` (A-8 review, records 3 and 14).
- A leading `*` matches any prefix of the command word, a path included, and keeps the rest of the pattern: it
  starts the entry for every path form above and not for other `gh` commands.
- It also starts the entry for a command that only mentions `gh pr merge`, such as `echo gh pr merge 5`. The
  hook then decides; with `onFailure: "block"` a hook failure would block such a command, as the merge entry
  already accepts for commands whose event holds `merge`.

A first, rougher run the same day with user hooks loaded showed the same split between the two patterns for an
absolute path.
