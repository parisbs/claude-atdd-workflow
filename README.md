# claude-workflow

Versioned user-level configuration for Claude Code, plus the templates that
bring a repository into an agent-assisted workflow.

The repository separates three things:

- `global/` is generic configuration installed into `~/.claude`: the user
  `CLAUDE.md`, settings, hooks and skills. Nothing in it is specific to one
  person or one project.
- `personal/` holds the preferences of whoever installs it. Only the example
  files are versioned; the real ones are ignored by git.
- `common/` and the stack directories hold templates that the
  `repo-bootstrap` skill copies into a repository, so that every repository
  carries its own conventions and works on its own.

Setup and usage are documented as the pieces land.
