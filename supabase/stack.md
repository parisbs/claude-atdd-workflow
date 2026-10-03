# Supabase (managed from the repository)

Detected by a `supabase/config.toml`.

## Verify

Typical, with the local stack running (`supabase start`):
`supabase db lint && supabase test db`, plus the repository's integration tests
and any contract generation it checks for drift.

## Test paths

`supabase/tests/` (pgTAP) and the repository's integration test directory. The
guard covers `supabase/tests/` and `tests/` by default.

## Human merge

Edge functions run with the project's secrets and the seed data is applied to
environments. Migrations are already on the default control plane.

- Human merge: supabase/functions/, supabase/seed.sql

## Rules for CLAUDE.md

These protect production data; keep them unless the repository has a stronger
rule.

- Migrations are immutable once pushed: add a new migration, never edit an old
  one.
- Never apply migrations to production from a local machine. Production changes
  go through pull request, CI and the deploy workflow.
- Every table in an exposed schema has row level security enabled and explicit
  policies.
- Views are created with `security_invoker = true`; otherwise they run as their
  owner and bypass row level security.
- Every function sets `search_path = ''`, so every object it references is
  schema-qualified, custom types in its signature and `DECLARE` block included
  (`public.user_role`, `auth.uid()`).
- `SECURITY DEFINER` functions are the exception, each with a comment saying
  why.
- The service role key is used only by backend scripts and CI, never by a
  client.
- When migrations change the API shape, regenerate the committed contract or
  types in the same change; CI fails on drift.

## CI

The workflow starts the local stack, applies migrations, lints, runs pgTAP and
integration tests, and checks contract drift. Its check names become the
required status checks of the main ruleset.
