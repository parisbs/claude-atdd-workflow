---
name: release-prep
description: Prepare and publish a release from a tag - release branch with documentation, changelog and version bump, pull request, annotated vX.Y.Z tag on main, publish, GitHub release and milestone close. Stops wherever the human must act.
argument-hint: <version X.Y.Z>
disable-model-invocation: true
---

Prepare release $ARGUMENTS. A release is an annotated tag `vX.Y.Z` on `main`
(claude-atdd-workflow ADR 0005). The release branch only prepares it and is deleted
after merging.

The repository's own release procedure wins over the steps below: a
`docs/releasing.md`, a release section in its `CLAUDE.md` or a project skill.
When it has one, follow it step by step; a step below that it does not
mention, or that it says does not apply, is skipped. In claude-atdd-workflow that procedure is `docs/releasing.md`, with
the version policy in ADR 0031.

## 1. Decide the version

List what shipped since the last tag (`git describe --tags --abbrev=0`, then
`git log <tag>..main --oneline`) and classify it with the repository's version
policy when it records one. Without a policy, a breaking change (`!` or
`BREAKING CHANGE`) is a major bump, `feat` a minor one, anything else a patch.
If the requested version disagrees, say so and ask.

## 2. Release branch

From an updated `main`, create `release/X.Y.Z` and:

- Align documentation with what is shipping: `README.md`, `docs/ROADMAP.md`,
  ADR statuses.
- Write the changelog entry, compiled from the bodies of the pull requests
  merged since the last tag. This is the only moment the changelog changes.
- Bump every version the repository keeps: `package.json` and lockfile,
  `pubspec.yaml` (`version: X.Y.Z+build`), Gradle version properties or
  `version.gradle`, server version constants. Search for the old version string
  to find stragglers.
- Run the verify command and any release smoke test the repository declares.

Commit as `chore(release): prepare X.Y.Z`, then prepare the pull request with
`/pr-prep`.

## 3. After the pull request is merged

1. Update `main` and create the annotated tag on the merge commit:
   `git tag -a vX.Y.Z -m "vX.Y.Z"`. Tag creation is signed if the machine signs.
2. Publishing a release is the human's (user `CLAUDE.md`): push the tag and
   publish only when told, otherwise hand over the exact commands and stop. A
   publish workflow triggered by the tag, if the repository has one, does the
   build; publishing that needs the human (two factor approval, store console)
   is theirs, so say exactly what is left.
3. Verify the published artefact exists (registry, store, release assets) before
   any post-publish step.
4. When told, create the GitHub release from the tag with the changelog entry
   and close the release's milestone. Delete the `release/X.Y.Z` branch locally
   and on the remote.
