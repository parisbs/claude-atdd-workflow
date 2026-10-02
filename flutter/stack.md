# Flutter (Dart)

Detected by `pubspec.yaml` with a `flutter` dependency.

## Verify

Typical: `dart format --output=none --set-exit-if-changed . && flutter analyze && flutter test`.
When the project uses code generation, run
`dart run build_runner build --delete-conflicting-outputs` first.

## Test paths

`test/` and `integration_test/`, and files ending in `_test.dart`. The guard
covers them by default.

## Rules for CLAUDE.md

Adapt each line to what the repository actually uses; delete what does not
apply.

- Generated files (`*.g.dart`, `*.freezed.dart`, `*.config.dart`, `*.gr.dart`)
  are never edited by hand. After changing an annotation that feeds a generator
  (freezed, json_serializable, injectable, hive), run `build_runner`.
- Every `// ignore:` for a lint carries the reason on the same line.
- Localised strings live in the localisation files, never as literals in
  widgets.
- Every interactive widget has a semantic label; verify with TalkBack and
  VoiceOver, not only in tests.
- For acceptance tests, declare new public API with
  `throw UnimplementedError()` bodies so tests fail by assertion.

## CI

The workflow runs the verify command on pull requests to `main`. Its check
names become the required status checks of the main ruleset.
