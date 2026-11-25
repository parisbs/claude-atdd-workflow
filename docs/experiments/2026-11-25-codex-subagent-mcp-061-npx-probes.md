# codex-subagent-mcp 0.6.1 npx probes, 2026-11-25

These probes check that `codex-subagent-mcp@0.6.1` starts with the `--prefer-offline` form the registrations
use (ADR 0028), as the [0.6.0 probes](2026-10-23-codex-subagent-mcp-060-npx-probes.md) did for 0.6.0. They
also test the case that record left unverified: a cache whose package document predates the pinned version.

Environment: npm 11.9.0, Node 24.14.0, macOS, standard input from `/dev/null`, the maintainer's own npm cache.
Before the first run, that cache held the `codex-subagent-mcp` package document from before 0.6.1 was
published, about three hours earlier. Each command ran once, in the order below, so each run starts from the
cache the previous one left. The times are wall-clock times to process exit, single observations rather than a
statistical comparison.

| Order | Command (with `< /dev/null`) | HTTP log | Result | Total |
| --- | --- | --- | --- | --- |
| 1 | `npx --loglevel=http --prefer-offline -y codex-subagent-mcp@0.6.1` | Package document served from the stale cache | `ETARGET`, no matching version | 0.82 s |
| 2 | `npx --loglevel=http --prefer-online -y codex-subagent-mcp@0.6.1` | Package document updated, then the tarball's dependencies fetched | Started | 5.75 s |
| 3 | `npx --loglevel=http -y codex-subagent-mcp@0.6.1` | One revalidation GET | `codex-subagent v0.6.1 running on stdio` | 1.20 s |
| 4 | `npx --loglevel=http --prefer-offline -y codex-subagent-mcp@0.6.1` | Cache hit, no fetch | `codex-subagent v0.6.1 running on stdio` | 1.01 s |

The first log lines of each run, in table order:

```text
npm http fetch GET 200 https://registry.npmjs.org/codex-subagent-mcp 17ms (cache stale)
npm error notarget No matching version found for codex-subagent-mcp@0.6.1.
npm http fetch GET 200 https://registry.npmjs.org/codex-subagent-mcp 318ms (cache updated)
npm http fetch GET 200 https://registry.npmjs.org/codex-subagent-mcp 181ms (cache revalidated)
npm http cache https://registry.npmjs.org/codex-subagent-mcp 14ms (cache hit)
```

## Findings

1. A stale package document makes `--prefer-offline` fail outright. npm resolves the exact version against the
   cached document, does not refetch it, and exits with `ETARGET`. This is the scenario the 0.6.0 record listed
   as not verified. It is real.
2. The installer's `--prefer-online` prewarm fixes it: the run updated the package document and fetched the
   dependencies. After that, the `--prefer-offline` start was a cache hit with no request.
3. So, after a version bump, a registration starts only once a prewarm has succeeded on that machine. A failed
   prewarm is advisory in the installer, and its registrations would then fail to start until a run with
   network access refreshes the document.

## Not verified

The output of run 2 was cut after its first eight log lines, so its startup line was not seen. Run 3 shows the
package starting from that cache. A cold cache was not tested again; the 0.6.0 record covers it.
