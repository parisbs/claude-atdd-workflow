---
name: atdd-oracle
description: Phase 1 of the ATDD workflow. From an issue's AC-n acceptance criteria, plan and write the acceptance tests, get human approval, record the red evidence, and freeze them as the oracle with an oracle/<branch> tag.
argument-hint: <issue number>
disable-model-invocation: true
---

Build the test oracle for issue $ARGUMENTS. The reasoning is in the
claude-workflow ADR 0003: tests a human approved are both the instruction and
the verification for phase 2, and nothing about them may be guessed.

## 1. Inputs

- Read the issue with `gh issue view <n> --comments`. Without `AC-n` criteria
  in `WHEN ... THEN ...` form, stop and propose `/issue-draft`.
- Read the repository's `AGENTS.md`: its verify command, its conventions, and
  the files the issue names. Work on the issue's branch, created from an
  updated `main`.

## 2. Test plan

1. Derive the use cases and edge cases from each criterion.
2. Compare them with the existing tests at every level the stack has (unit,
   integration, instrumented, database). Name the tests that already cover a
   case and those that contradict one.
3. Propose which tests to create or change, one line of justification each,
   and the level each belongs to. Put the criterion identifier in every test
   name, for example `AC-3 rejects an expired session` or
   `ac3_rejectsExpiredSession`, following the stack's naming rules.
4. Challenge the edge cases the human supplied. A test that cannot be
   satisfied makes the task impossible, and impossible tasks multiply attempts
   to game the checks.

Present the plan and wait for approval before writing tests.

## 3. Write the tests

- Where the language needs declarations for tests to compile, define the public
  signatures with placeholder bodies, so every new test fails by assertion and
  not by compilation. In Kotlin, bodies are `TODO()`. In Dart, `throw
  UnimplementedError()`. In TypeScript, `throw new Error('not implemented')`.
  These signatures are part of what the human approves: they are the API
  design.
- For each test, check that an implementation can satisfy it: no contradictory
  assertions, no dependence on time, order or network that the test does not
  control, no flaky waits. A test that is flaky today is left out of the oracle
  and reported.

## 4. Red evidence

Run the repository's verify command, or the narrowest test command that runs
the new tests. Record, for each new test, that it failed and why, and confirm
the reason is the missing behaviour and not a setup error. Instrumented tests
that need a device may be recorded as not run, and must be said to be not run.

## 5. Approval and freeze

Show the human the test diff, the signatures and the red evidence. Only after
explicit approval:

1. If the tests live outside the default paths (`src/*Test/`, `test/`,
   `tests/`, `integration_test/`, `__tests__/`, `fixtures/`, `supabase/tests/`,
   `*.test.*`, `*.spec.*`, `*_test.dart`), write their globs, one per line,
   into `.atdd/test-paths`.
2. Commit the tests, signatures and `.atdd/test-paths` together:
   `test(<scope>): add acceptance tests for #<issue>`.
3. Create the lightweight tag `oracle/<branch>` on that commit. From now on,
   the user-level guard denies edits to those paths on this branch.
4. Comment on the issue with the criterion-to-test map, the oracle commit and
   the red evidence.

Stop there. Implementation is `/atdd-implement`, preferably in a new session so
it does not inherit this conversation.
