# Changelog

Notable changes to the configuration this repository installs, one section per release, newest first. Versions
follow [ADR 0031](docs/adr/0031-version-releases-by-their-effect-on-the-public-interface.md), and
[docs/releasing.md](docs/releasing.md) says how a section is written. An entry marked **Breaking** changes the
public interface that ADR defines; before v1.0.0 such a change bumps the minor version.

Each entry links its pull request, or its commit when it has none. Links of the form `claude-workflow#N` point to the private `claude-workflow`
repository this project continues (ADR 0022), which is archived and not public; `#N` links point to this
repository.

## [Unreleased]

### Changes

- **Breaking**: feat(codex): pin codex-subagent-mcp 0.6.0 offline-first and adopt its ceilings ([#51](https://github.com/parisbs/claude-atdd-workflow/pull/51))
- fix(test): merge the personal overlay and isolate the state directory in the codex 0.6.0 tests ([#52](https://github.com/parisbs/claude-atdd-workflow/pull/52))
- fix(guard-git): ask before merging when local work is missing from the pull request ([#54](https://github.com/parisbs/claude-atdd-workflow/pull/54))
- feat(guard-git): ask before deleting or moving an oracle tag in the main session ([#56](https://github.com/parisbs/claude-atdd-workflow/pull/56))
- test(install): cover the codex prewarm timeout, stdin, distinct packages and label wording ([#58](https://github.com/parisbs/claude-atdd-workflow/pull/58))
- docs(experiments): record rules loading probes on CLI and desktop ([#59](https://github.com/parisbs/claude-atdd-workflow/pull/59))

### New tools

None.

## [0.6.0] - 2026-10-23

### Changes

- chore: make verification output compact and stop loading the global instructions source ([#26](https://github.com/parisbs/claude-atdd-workflow/pull/26))
- **Breaking**: fix(hooks): fail closed on merges, protect the remote default branch and drop MultiEdit ([#28](https://github.com/parisbs/claude-atdd-workflow/pull/28))
- **Breaking**: fix(agents): give claude-researcher a read-only shell ([#30](https://github.com/parisbs/claude-atdd-workflow/pull/30))
- docs(adr): propose model and effort routing and compact delegation reports ([#33](https://github.com/parisbs/claude-atdd-workflow/pull/33))
- feat(metrics): report delegation packages, result sizes and Codex usage from local transcripts ([#35](https://github.com/parisbs/claude-atdd-workflow/pull/35))
- **Breaking**: fix: close the gaps found in the review of the hook and test-output changes ([#36](https://github.com/parisbs/claude-atdd-workflow/pull/36))
- **Breaking**: feat(settings): deny reading secrets and tidy the shipped and personal settings ([#38](https://github.com/parisbs/claude-atdd-workflow/pull/38))
- fix(install): keep managed hooks when personal settings define hooks ([#40](https://github.com/parisbs/claude-atdd-workflow/pull/40))
- docs: refresh the roadmap, add issue templates and tidy the project instructions ([#41](https://github.com/parisbs/claude-atdd-workflow/pull/41))
- **Breaking**: fix(install): back up outside ~/.claude, write atomically and refuse to overwrite unmanaged files ([#43](https://github.com/parisbs/claude-atdd-workflow/pull/43))
- test(install): add regression tests for the PR-06 review fixes ([#46](https://github.com/parisbs/claude-atdd-workflow/pull/46))
- fix(install): keep the undo bundle a restore writes ([#49](https://github.com/parisbs/claude-atdd-workflow/pull/49))
- fix: add the needs-human label and cover stack templates and tests in Human merge ([#47](https://github.com/parisbs/claude-atdd-workflow/pull/47))

### New tools

- Hook: `guard-readonly`, for `claude-researcher`.
- Script: `scripts/metrics-delegations.mjs`.

## [0.5.0] - 2026-10-20

### Changes

- chore: rename the project to claude-atdd-workflow ([#1](https://github.com/parisbs/claude-atdd-workflow/pull/1))
- chore: license the project under MIT ([#2](https://github.com/parisbs/claude-atdd-workflow/pull/2))
- ci: cancel superseded pull request runs ([#3](https://github.com/parisbs/claude-atdd-workflow/pull/3))
- docs(adr): record and accept the publication as claude-atdd-workflow from a rewritten history ([#4](https://github.com/parisbs/claude-atdd-workflow/pull/4))
- docs(adr): accept collecting donated session metrics through an allowlist script ([#18](https://github.com/parisbs/claude-atdd-workflow/pull/18))
- feat(guard-git): ask before merging a pull request from a fork or another author ([#23](https://github.com/parisbs/claude-atdd-workflow/pull/23))
- feat(metrics): let contributors donate de-identified session metrics ([#20](https://github.com/parisbs/claude-atdd-workflow/pull/20))
- chore(metrics): donate the maintainer's session metrics ([#24](https://github.com/parisbs/claude-atdd-workflow/pull/24))

### New tools

- Scripts: `scripts/metrics-report.mjs`, `scripts/metrics-validate.mjs`, `scripts/metrics-donation-check.mjs`.

## [0.4.0] - 2026-10-19

### Changes

- **Breaking**: feat(adr): make records immutable once accepted or rejected, not once merged ([claude-workflow#64](https://github.com/parisbs/claude-workflow/pull/64))
- feat(adr): enforce ADR immutability and the ADR index in CI ([claude-workflow#65](https://github.com/parisbs/claude-workflow/pull/65))
- **Breaking**: feat(adr): standardise ADR metadata on MADR 4 front matter and migrate records ([claude-workflow#67](https://github.com/parisbs/claude-workflow/pull/67))
- docs(adr): accept ADR 0020 and mark ADR 0018 and 0019 as superseded in part ([claude-workflow#68](https://github.com/parisbs/claude-workflow/pull/68))
- ci(bootstrap): stop persisting the checkout token in the ADR check workflow ([claude-workflow#69](https://github.com/parisbs/claude-workflow/pull/69))
- fix(adr): require a recognised status on added records and ignore index links in HTML comments ([claude-workflow#71](https://github.com/parisbs/claude-workflow/pull/71))
- docs(adr): accept ADR 0021 and mark ADR 0020 as superseded in part ([claude-workflow#72](https://github.com/parisbs/claude-workflow/pull/72))
- ci: pin actions by commit SHA and stop persisting the checkout token ([claude-workflow#73](https://github.com/parisbs/claude-workflow/pull/73))

### New tools

- Scripts: `scripts/check-adrs.mjs`, `scripts/migrate-adrs.mjs`, also shipped as `repo-bootstrap` templates.
- Templates: `common/docs/adr/template.md`, `common/github/workflows/check-adrs.yml`.

## [0.3.1] - 2026-10-09

### Changes

- fix(install): compare the url and headers of a declared MCP server ([claude-workflow#59](https://github.com/parisbs/claude-workflow/pull/59))

### New tools

None.

## [0.3.0] - 2026-10-08

### Changes

- **Breaking**: feat(guard-git): deny GitHub writes and git push to subagents ([claude-workflow#29](https://github.com/parisbs/claude-workflow/pull/29))
- feat(agents): ship the claude-implementer and claude-researcher subagents ([claude-workflow#30](https://github.com/parisbs/claude-workflow/pull/30))
- docs(roadmap): bring the status up to date and accept ADR 0011 and 0013 ([claude-workflow#31](https://github.com/parisbs/claude-workflow/pull/31))
- docs(adr): propose two Codex registrations and a delegate context contract ([claude-workflow#35](https://github.com/parisbs/claude-workflow/pull/35))
- docs(adr): accept ADR 0014 and ADR 0015 ([claude-workflow#36](https://github.com/parisbs/claude-workflow/pull/36))
- **Breaking**: feat(install): register the Codex MCP servers from the repository ([claude-workflow#37](https://github.com/parisbs/claude-workflow/pull/37))
- feat(delegation): add task-package and slim the Claude delegates ([claude-workflow#41](https://github.com/parisbs/claude-workflow/pull/41))
- docs(experiments): record the Codex alignment probes ([claude-workflow#44](https://github.com/parisbs/claude-workflow/pull/44))
- feat(delegation): guard Codex delegations and integrate their worktrees with a script ([claude-workflow#47](https://github.com/parisbs/claude-workflow/pull/47))
- **Breaking**: fix(oracle): bind a linked worktree to the nearest ancestor oracle tag ([claude-workflow#49](https://github.com/parisbs/claude-workflow/pull/49))
- feat(task-package): say where a Claude worktree starts and which commit it builds on ([claude-workflow#51](https://github.com/parisbs/claude-workflow/pull/51))
- feat(worktrees): ignore Claude Code worktrees here and in bootstrapped repositories ([claude-workflow#52](https://github.com/parisbs/claude-workflow/pull/52))
- chore(skills): run pr-prep and drift-audit at medium effort ([claude-workflow#56](https://github.com/parisbs/claude-workflow/pull/56))
- **Breaking**: feat(delegation): bound tool output, block on Codex instead of polling, and slim the delegation instructions ([claude-workflow#58](https://github.com/parisbs/claude-workflow/pull/58))

### New tools

- Agents: `claude-implementer`, `claude-researcher`.
- Skill: `task-package`.
- Hook: `guard-codex`.
- Scripts: `global/hooks/task-package.mjs`, `global/hooks/codex-integrate.mjs`.
- MCP registrations: `codex-implementer`, `codex-reviewer`.

## [0.2.0] - 2026-10-02

### Changes

- docs(global): hand the human the oracle tag cleanup commands after a merge ([claude-workflow#5](https://github.com/parisbs/claude-workflow/pull/5))
- docs(adr): accept the control model and propose subagent delegation ([claude-workflow#6](https://github.com/parisbs/claude-workflow/pull/6))
- fix(guard-git): ask on oracle tag creation and close the removal bypasses ([claude-workflow#13](https://github.com/parisbs/claude-workflow/pull/13))
- **Breaking**: feat(guard-git): decide gh pr merge from what GitHub shows ([claude-workflow#14](https://github.com/parisbs/claude-workflow/pull/14))
- docs(adr): supersede ADR 0006 with CLAUDE.md alone ([claude-workflow#16](https://github.com/parisbs/claude-workflow/pull/16))
- feat(guard-git): read Human merge from CLAUDE.md ([claude-workflow#20](https://github.com/parisbs/claude-workflow/pull/20))
- docs(claude): add CLAUDE.md as the only instruction file ([claude-workflow#21](https://github.com/parisbs/claude-workflow/pull/21))
- **Breaking**: docs: stop naming AGENTS.md in skills, stack rules and docs ([claude-workflow#22](https://github.com/parisbs/claude-workflow/pull/22))
- **Breaking**: feat(bootstrap): ship a single CLAUDE.md skeleton with the workflow lines ([claude-workflow#23](https://github.com/parisbs/claude-workflow/pull/23))
- **Breaking**: feat(skills): let the orchestrator start the workflow skills ([claude-workflow#24](https://github.com/parisbs/claude-workflow/pull/24))
- docs(global): write the orchestration rules into the Delegation section ([claude-workflow#25](https://github.com/parisbs/claude-workflow/pull/25))

### New tools

None.

## [0.1.0] - 2026-09-29

### Changes

- chore: initialize the claude-workflow repository ([63709d4](https://github.com/parisbs/claude-atdd-workflow/commit/63709d497027ec4a1da624cbb9eb6eafa31fae06))
- feat: add the initial user-level workflow configuration ([claude-workflow#1](https://github.com/parisbs/claude-workflow/pull/1))
- fix: follow branch switches in chains and conventional Dependabot titles ([claude-workflow#2](https://github.com/parisbs/claude-workflow/pull/2))
- feat: let the administrator bypass rulesets through pull requests ([claude-workflow#3](https://github.com/parisbs/claude-workflow/pull/3))
- feat: stricter title check and immutable ADRs by default ([claude-workflow#4](https://github.com/parisbs/claude-workflow/pull/4))

### New tools

- Skills: `adr-draft`, `atdd-implement`, `atdd-oracle`, `drift-audit`, `issue-draft`, `pr-prep`, `release-prep`, `repo-bootstrap`.
- Hooks: `guard-git`, `guard-tests`.
- Scripts: `scripts/install.mjs`, `global/hooks/oracle-check.mjs`.
- Stacks: `android`, `flutter`, `node-mcp`, `supabase`.
- Templates: `common/AGENTS.md.template`, `common/CLAUDE.md.template`, and under `common/github/` the issue and pull request templates, `labels.json`, the `main` and `tags` rulesets and the `pr-title.yml` workflow.

[Unreleased]: https://github.com/parisbs/claude-atdd-workflow/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/parisbs/claude-atdd-workflow/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/parisbs/claude-atdd-workflow/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/parisbs/claude-atdd-workflow/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/parisbs/claude-atdd-workflow/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/parisbs/claude-atdd-workflow/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/parisbs/claude-atdd-workflow/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/parisbs/claude-atdd-workflow/tree/v0.1.0
