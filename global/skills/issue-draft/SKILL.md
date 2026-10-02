---
name: issue-draft
description: Turn a feature idea or bug report into a GitHub issue with WHEN/THEN acceptance criteria (AC-n), labels, milestone and project, then stop. Use when requirements are being defined or refined, before any implementation.
argument-hint: <idea, bug description or existing issue number>
disable-model-invocation: true
---

Draft or refine a GitHub issue for: $ARGUMENTS

This is phase 0 of the workflow (see the levels in the user `CLAUDE.md`). The
acceptance criteria written here are the ceiling of every test derived later,
so their quality matters more than their speed.

## 1. Understand before writing

- If an issue number was given, read it with `gh issue view <n> --comments`.
- Read the repository's `CLAUDE.md`, the ADRs its instructions point to, and
  only the code the request touches. Do not survey the whole codebase.
- Read the repository's issue templates under `.github/ISSUE_TEMPLATE/` and
  use the one that fits. Without a template, use the structure below.

## 2. Challenge the request

Before drafting, list what is ambiguous, contradictory or missing, and the edge
cases the request does not mention: empty and maximum inputs, errors and
timeouts, permissions, concurrency, accessibility (screen readers, focus
order, contrast), localisation, offline and slow networks, and platform or
version differences that apply to the stack.

Question the edge cases the human proposed, not only the missing ones. Say
plainly when one looks wrong or untestable. Ask the open questions and wait for
answers; do not invent requirements to fill the gaps.

## 3. Draft

- **Problem**: who is affected and what they cannot do today.
- **Scope**: what is in, and explicitly what is out.
- **Acceptance criteria**: one per observable behaviour, numbered `AC-1`,
  `AC-2`, and so on, each written as `WHEN <situation> THEN <observable
  result>`. Each must be testable by an automated test or, when that is
  impossible, name the manual check. No criterion describes implementation.
- **Test level**: for each criterion, the lowest test level that proves it
  (unit, integration, instrumented or end-to-end, database test).
- **Decisions**: any decision that closes an alternative gets an ADR through
  `/adr-draft`; link it.
- **Dependencies and risks**.

## 4. Publish only when told

Show the draft in full. Create or edit the issue with `gh` only after explicit
approval. Then, when the repository uses them, add labels, the milestone and
the GitHub Project. Report the issue URL and stop: preparing is not executing.
