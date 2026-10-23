# codex-subagent-mcp 0.6.0 npx probes, 2026-10-23

These measurements were supplied by the orchestrator for issue #50, not rerun
during implementation. Environment: npm 11.9.0, Node 24.14.0, macOS, standard
input from `/dev/null`. Each run printed
`codex-subagent v0.6.0 running on stdio` and exited when standard input closed,
so the installer can prewarm without leaving a server running.

## Warm cache

Each command ran once; the elapsed times show these observations, not a
statistical comparison of startup latency. The 0.6.0 timings measure elapsed
time to process exit after standard input closed.

| Command (with `< /dev/null`) | HTTP log | Total |
| --- | --- | --- |
| `npx --loglevel=http -y codex-subagent-mcp@0.6.0` | One revalidation GET | 0.67 s |
| `npx --loglevel=http --prefer-offline -y codex-subagent-mcp@0.6.0` | Cache hit, no fetch | 0.65 s |
| `npx --loglevel=http --prefer-online -y codex-subagent-mcp@0.6.0` | One revalidation GET | 1.02 s |

The corresponding log lines, in table order:

```text
npm http fetch GET 200 https://registry.npmjs.org/codex-subagent-mcp 193ms (cache revalidated)
npm http cache https://registry.npmjs.org/codex-subagent-mcp 28ms (cache hit)
npm http fetch GET 200 https://registry.npmjs.org/codex-subagent-mcp 415ms (cache revalidated)
```

The exact pin alone still revalidates on every start with this npm version;
`--prefer-offline` avoids that request with a warm cache. `--prefer-online` is
the installer's prewarm form, refreshing the package document on installation
rather than on every server start.

## Cold cache

With `--cache <empty dir>` added to
`npx --loglevel=http --prefer-offline -y codex-subagent-mcp@0.6.0`, the first
run fetched the package document, tarballs and dependencies, including
`@modelcontextprotocol/sdk`, with cache-miss GETs: 6.94 s total. A second run
against that same cache logged cache hits and zero fetch lines: 1.31 s total.
Offline-first still needs the network when the cache is empty.

## Earlier audit, 2026-10-21

The supplied audit measured a caret range at 1.61 s, with two GETs and a POST
to `/-/npm/v1/security/advisories/bulk`; `codex-subagent-mcp@0.5.0` exact at
1.44 s with revalidation; and that version with `--prefer-offline` at 0.88 s.

## Earlier startup probe, 2026-10-08

The [2026-10-08 probe](2026-10-08-orchestrator-context-probes.md) measured
`node` on the installed `codex-subagent-mcp` 0.5.0 package at 0.23 s up to
the `initialize` response. This is not directly comparable with the 0.6.0
timings measured to process exit after standard input closed. A global
install also puts the installation and version outside the repository
installer.

## Not verified

A cache whose package document predates the pinned version was not tested.
`--prefer-offline` might not refresh that document; the installer's
`--prefer-online` prewarm is intended to cover it, but that specific scenario
remains unverified. A failed prewarm is advisory, so a later server start may
still fetch or fail if its cache is insufficient.
