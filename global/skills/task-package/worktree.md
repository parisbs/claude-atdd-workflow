# Claude subagents in a worktree

A writing delegation to `claude-implementer` normally runs where the session already works on the work branch, without isolation (ADR 0011).
The rest of this section applies when the `Agent` call sets `isolation: worktree`.
A subagent with `isolation: worktree` starts from the default remote branch, which Claude Code fetches when it makes the worktree, unless `worktree.baseRef` is `"head"` or the repository has no remote, in which case it starts from the local HEAD.
The worktree is on a branch of its own, `worktree-agent-<id>`, and shares the repository's object store, so committed work is reachable from it and uncommitted changes are absent.
In that worktree Claude Code refuses a git command it cannot verify stays inside it, such as one chained with `cd`, `;` or `&&`, so the package gives git commands as plain, separate commands.
The package carries, in Base commit, the hash of the work branch commit the delegate builds on.
Before any task edit, the delegate confirms that its branch contains the Base commit, with HEAD equal to it or descending from it.
Moving the fresh worktree branch to the Base commit is preparation, not a change: `git merge --ff-only` to the hash works when the default branch has not moved since the work branch left it, and `git reset --hard` to the hash works when it has.
The delegate does not merge, which would bring other commits in.
If the delegate cannot reach the Base commit, it stops before any task edit and reports missing-dependency, or blocked-by-guard when a hook or permission denied the move.
`guard-tests` binds a linked worktree only once its HEAD descends from the oracle commit (ADR 0016), which is why the delegate reaches the Base commit first.
A worktree whose files or HEAD changed is kept with its branch when the agent ends, and the orchestrator integrates it into the work branch.
