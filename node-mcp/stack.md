# Node MCP server (TypeScript)

Detected by `package.json` with a dependency on `@modelcontextprotocol/sdk`.

## Verify

Declare one script, `npm run verify`, that runs what CI runs: typecheck, lint,
build and tests.

## Test paths

`test/`, `tests/`, `__tests__/` and files ending in `.test.*` or `.spec.*`. The
guard covers them by default.

## Rules for CLAUDE.md

Adapt each line to what the repository actually uses; delete what does not
apply.

- A stdio server writes only protocol messages to stdout. Logs and diagnostics
  go to stderr.
- Never build a shell command string. Spawn child processes with an argument
  array and `shell: false`; pass untrusted text through stdin, never through
  the argument list.
- Preflight checks (is the external CLI installed, signed in) run per tool call,
  never at startup: a server that fails while connecting never shows its
  diagnosis.
- npm scripts are shell-agnostic: no globs, `rm` or POSIX-only syntax, because
  npm runs them through cmd.exe on Windows.
- Never degrade to a plausible-looking answer when a dependency is unavailable;
  fail with the remedy.
- Verify external CLI behaviour against the installed binary (`--help`), not
  from memory, and pin what was learned in a test.
- For acceptance tests, declare new API with
  `throw new Error('not implemented')` bodies so tests fail by assertion.

## CI

Run the verify script on the supported Node versions and operating systems. Its
check names become the required status checks of the main ruleset.
