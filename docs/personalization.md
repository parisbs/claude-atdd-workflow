# Personalization

Copy `personal/settings.example.json` to `personal/settings.json` and
`personal/preferences.example.md` to `personal/preferences.md`, then edit the
copies. These local files are gitignored. The installer merges personal
settings over the global settings and copies preferences to
`~/.claude/rules/personal.md`. Run `node scripts/install.mjs --check` to see
drift and `node scripts/install.mjs` to apply changes.

## Effort and language

The example keeps top-level `effortLevel` as the default for models earlier
than Opus 5.5. Opus 5.5 starts at medium unless a source sets its effort; it
ignores top-level `effortLevel` in user settings, which
`personal/settings.json` feeds. Top-level `effortLevel` in project, local or
managed settings, or passed with `--settings`, still applies to every model.
Set its user-level effort under the canonical model name in
`personal/settings.json`:

```json
{
  "effortLevel": "high",
  "modelSettings": {
    "claude-opus-5-5": {
      "effortLevel": "high"
    }
  }
}
```

The per-model level takes precedence over the top-level level in the same
file. Changing a level with `/effort` produces drift in
`node scripts/install.mjs --check` when the personal file sets the same key.
The next install reverts that change to the personal file's value. Edit the
personal file to keep the new level across installs.

The `language` setting is passed to the model verbatim; the example sets it
to `english`. Keep response language there. Preferences can express what
settings cannot, such as keeping repository content in English regardless of
the conversation language, along with judgement about tone and detail.

## Git context and attribution

The shared `includeGitInstructions: false` removes the built-in commit and
pull request instructions. It also removes the git snapshot of branch,
status and recent commits read at session start. Set
`"includeGitInstructions": true` in `personal/settings.json` to restore both.

To keep git instructions disabled while restoring compact status context,
add an optional `SessionStart` hook that prints the current branch and up to
20 status lines. For every session, put it in `personal/settings.json` and
reinstall: the installer adds personal hooks after the repository's managed
ones, replaces them on each install and removes one you delete from the
file. For one project, put it in that project's `.claude/settings.local.json`
instead, merging it into any existing hooks there. Never edit the installed
copies in `~/.claude`.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "git branch --show-current; git --no-optional-locks status --short | head -20"
          }
        ]
      }
    ]
  }
}
```

This hook runs in the session's working directory. Outside a git repository
it prints nothing: git writes to stderr, which Claude does not see when the
hook exits 0 (the final `head` succeeds). `--no-optional-locks` keeps status
from taking an index lock. Keep the hook fast since `SessionStart` runs on
every session. It supplies compact status context without restoring recent
commits or the built-in instructions.

The shared `attribution` sets `commit` and `pr` to empty strings, removing
commit and pull request attribution, including the Co-Authored-By trailer.
Some organisations require that trailer. Override the fields in
`personal/settings.json`, using the identity your organisation requires:

```json
{
  "attribution": {
    "commit": "Co-Authored-By: Claude <noreply@anthropic.com>",
    "pr": "Assisted by Claude"
  }
}
```

## Secret reads and permission migration

The shipped deny rules cover `.env`, `.env.*`, PEM and key files, RSA and
Ed25519 identity files, keystores and JKS files. Their `**/` patterns match at
or under the session's current directory: they protect files inside the
project being worked on. They do not protect `~/.ssh` keys unless the session
starts in the home directory or above it, nor a `.env` outside the current
directory tree. Those need a `//` absolute or `~/` home-relative path rule.

The `.env.example` and `.env.sample` exceptions follow the rules they narrow:
a deny pattern with `!` excludes matching paths from preceding rules in the
same settings source only. A project-level `.env.*` deny is not narrowed by
the shipped user-level exceptions. The installer appends shipped rules after
deny rules already in `~/.claude/settings.json`, so the exceptions also narrow
your own earlier relative and `**/` rules there: `Read(**/.env*)` would no
longer cover `.env.example`. A `!` exception cannot reach rules anchored with
`/`, `~/` or `//`, including the home-relative and absolute rules above.

Read and Edit deny rules apply to Claude's file tools, to file commands
Claude Code recognises in Bash such as `cat`, `head`, `tail` and `sed`, and to
redirect targets. Input redirects such as `< file` are checked against Read
rules; `tee` and output redirects write, so Edit rules govern them. These
rules do not apply to commands that read files without naming them, such as
`grep -r pattern .` run from the directory holding the file, nor to arbitrary
programs. Use the sandbox with filesystem restrictions for full coverage of
shell programs.

Permission lists merge by union. Removing a shipped rule alone leaves it in
existing installations; `global/retired-permissions.json` tells the installer
which old rules to remove before merging. The former `Bash(x:*)` allow rules
are retired and replaced by equivalent `Bash(x *)` rules, matching the form
the permission dialog writes, with the same command prefixes. A retired
`Bash(x:*)` rule kept in `personal/settings.json` is re-added on every install
and reported by `--check` as a retired rule still installed. Use the space
form in personal files too.

## Schema diagnostics

The published schemastore schema can lag behind valid Claude Code settings.
It allows additional properties, so unknown keys such as `bashOutputMaxChars`,
`promptCacheTtl`, `subagentPromptCacheTtl`, `enableWorkflows` and `modelSettings`
get no completion or description in an editor rather than a validation error.
A key missing from the schema does not mean the setting is invalid.
