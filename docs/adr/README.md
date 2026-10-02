# Architecture decision records

Short MADR form. Create new records from `template.md`. Records are immutable
once merged to `main`: a changed decision is a new record that supersedes the
old one, which changes only in its status line.

- [0001. Separate generic, personal and repository configuration](0001-separate-generic-personal-and-repository-configuration.md)
- [0002. Enforce with hooks, permissions and CI, and guide with prose](0002-enforce-with-hooks-permissions-and-ci.md)
- [0003. Approved executable tests replace prose behaviour specifications](0003-approved-tests-replace-behaviour-specs.md)
- [0004. Protect main with rulesets applied by repo-bootstrap](0004-protect-main-with-rulesets-from-bootstrap.md)
- [0005. Use Conventional Commits and release from tags](0005-conventional-commits-and-releases-from-tags.md)
- [0006. Make AGENTS.md the canonical instructions file of a repository](0006-agents-md-is-the-canonical-repository-file.md)
- [0007. User skill names never shadow project skills](0007-user-skill-names-never-shadow-project-skills.md)
- [0008. Let the administrator bypass rulesets, only through pull requests](0008-administrator-bypasses-rulesets-through-pull-requests.md)
- [0009. ADRs are immutable once merged](0009-adrs-are-immutable-once-merged.md)
- [0010. Move human control to the specification and gate merges by verified conditions](0010-move-human-control-to-the-specification-and-gate-merges.md)
- [0011. Delegate through Claude Code subagents, interchangeable with Codex](0011-delegate-through-subagents-interchangeable-with-codex.md)
- [0012. Keep repository instructions in CLAUDE.md alone](0012-keep-repository-instructions-in-claude-md-alone.md)
