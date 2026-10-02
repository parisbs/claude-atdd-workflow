---
name: release-prep
description: Prepare and publish a release from a tag - release branch with documentation, changelog and version bump, pull request, annotated vX.Y.Z tag on main, publish, GitHub release and milestone close. Stops wherever the human must act.
argument-hint: <version X.Y.Z>
disable-model-invocation: true
---

Prepare release $ARGUMENTS. A release is an annotated tag `vX.Y.Z` on `main`
(claude-workflow ADR 0005). The release branch only prepares it and is deleted
after merging. Follow the repository's own release procedure instead when its
`CLAUDE.md` or a project skill defines one.

## 1. Decide the version

Read the Conventional Commits subjects since the last tag
(`git describe --tags --abbrev=0`, then `git log <tag>..main --oneline`). A
breaking change (`!` or `BREAKING CHANGE`) is a major bump, `feat` a minor one,
anything else a patch. If the requested version disagrees, say so and ask.

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
2. Push the tag only when told. A publish workflow triggered by the tag, if the
   repository has one, does the build; publishing that needs the human (two
   factor approval, store console) is theirs, so stop and say exactly what is
   left.
3. Verify the published artefact exists (registry, store, release assets) before
   any post-publish step.
4. Create the GitHub release from the tag with the changelog entry, close the
   milestone, and delete the `release/X.Y.Z` branch locally and on the remote.
