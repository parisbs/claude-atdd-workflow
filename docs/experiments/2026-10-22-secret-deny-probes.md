# Secret deny rule probes, 2026-10-22

The checks behind issue 37 (AC-2). They answer two questions:

- Do the deny rules shipped in `global/settings.json` stop a session from reading `.env` and private keys, while the
  `!` exceptions still let it read `.env.example` and `.env.sample`?
- Does a space-form rule such as `Bash(x *)` allow the same commands as the `Bash(x:*)` rule it replaces, including
  the bare command with no arguments?

Each variant ran once, so it shows that a behaviour exists, not how often.

Environment: Claude Code 2.1.306 on macOS, headless `claude -p` with `--max-turns 3` and stdin closed, started in a
scratch git repository holding fake values only: `.env`, `.env.example`, `.env.sample`, `.env.local`,
`keys/server.key`, `keys/cert.pem` and an executable `probe.sh` that echoes its arguments. Each prompt asked the
session to read one file or run one command verbatim and to print the output or the exact error.

## 1. Deny rules and their exceptions

Method: the repository's `.claude/settings.json` held the `permissions` block of `global/settings.json` at commit
95e527f (the 24 space-form allow rules and the 10 deny rules), plus allow rules for `cat` and `probe.sh`. The
workspace was not trusted, so Claude Code ignored the project's allow entries (it printed `Ignoring 26
permissions.allow entries from .claude/settings.json: this workspace has not been trusted`) but applied the deny
entries. The Read tool was allowed with `--allowedTools Read`.

Observed:

- Read of `.env`, `.env.local`, `keys/server.key` and `keys/cert.pem` came back as `File is in a directory that is
  denied by your permission settings.`
- Read of `.env.example` and `.env.sample` returned their content.
- `cat .env` came back as `Permission to use Bash with command cat .env has been denied.`; `cat .env.example`
  returned its content.

A preliminary run before the implementation, with only the four `.env` rules in the project settings and the
project allow `Bash(cat *)`, gave the same results for `.env`, `.env.example`, `.env.local` and `cat .env`. Its
control removed the two `!` rules: Read of `.env.example` was then denied, so the exception is what lets it
through.

## 2. Space form and colon form

Method: an empty project settings file, and a settings file passed with `--settings` holding a single allow rule,
`Bash(./probe.sh *)` in one run and `Bash(./probe.sh:*)` in the other. Without either rule, the same command came
back as `This command requires approval`.

Observed: with either form, both `./probe.sh` and `./probe.sh x` ran and printed `probe-ran` and `probe-ran x`.

## Conclusions

- The shipped deny rules denied Read for `.env`, `.env.local`, `keys/server.key` and `keys/cert.pem`, and denied
  `cat` for `.env`. With the `!` exceptions placed after `Read(**/.env.*)`, Read and `cat` were allowed for
  `.env.example`, and Read was allowed for `.env.sample`. The patterns `id_rsa*`, `id_ed25519*`, `*.keystore` and
  `*.jks` were not probed. Deny rules applied even in an untrusted workspace, where project allow rules did not.
- `Bash(x *)` allows the bare command and the command with arguments, as `Bash(x:*)` does, so the migration keeps
  every previously allowed command.
- The probes used project and `--settings` sources, not `~/.claude/settings.json`. The deny and exception result
  carries over to the installed user file because all ten rules sit in one source there too: a `!` exception
  only narrows rules from the same source. The installed user file is checked by the install tests instead.
