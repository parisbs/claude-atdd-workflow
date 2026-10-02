# Android (Kotlin, Gradle)

Detected by `settings.gradle.kts` or `settings.gradle` with an Android plugin.

## Verify

The command that mirrors CI. Typical: `./gradlew assemble test lint`, adding
`ktlintCheck`, `detekt` and `apiCheck` when the build configures them. Scope to
a module with `:<module>:<task>`. Instrumented tests
(`connectedAndroidTest`) need a device: they run in the pre-PR gate, never in a
`Stop` hook, and a run without a device is reported as not run.

## Test paths

`src/test/`, `src/androidTest/` and Kotlin Multiplatform source sets such as
`src/commonTest/` and `src/androidHostTest/`. The guard covers them by default.

## Rules for CLAUDE.md

Adapt each line to what the repository actually uses; delete what does not
apply.

- Never commit secrets: `local.properties`, keystores and their properties,
  `google-services.json`, generated secret resources. The build reads them from
  local files or CI secrets.
- Dependencies and versions live in {{`gradle/libs.versions.toml` | the
  repository's version file}}; module build files never hard-code versions.
- Build scripts use {{the Kotlin DSL | Groovy}}; do not mix both.
- Static analysis runs with zero findings. Do not add a detekt or lint baseline
  without an explicit, recorded reason.
- For acceptance tests, declare new public API with `TODO()` bodies so tests
  fail by assertion, not by compilation.
- Anything a screen reader user perceives (content descriptions, focus order,
  touch targets, contrast) is checked with TalkBack enabled, not only in tests.

## CI

The workflow runs the verify command on pull requests to `main`. Its check
names become the required status checks of the main ruleset.
