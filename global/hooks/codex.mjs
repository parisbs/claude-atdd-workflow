// What a Codex worktree is (issue #42). Shared by guard-codex and
// codex-integrate, so the directory the guard lets a writing follow-up resume
// in and the directory the integration accepts are the same by construction.
//
// Codex CLI creates a worktree under `$CODEX_HOME/worktrees/<id>/<repository>`
// as a git linked worktree, detached at the commit it was made from;
// CODEX_HOME defaults to `~/.codex`. A path there is not a worktree by itself:
// the <id> directory, or one left once a worktree is removed, is not a
// repository, and a repository made there with `git init` is not a linked
// worktree. So a Codex worktree is a linked worktree whose git top-level is
// inside the worktrees directory; callers ask codexWorktreeOf, never test the
// directory alone.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// Resolves symlinks in the part of the path that exists, so paths compare
// equal with what git reports (on macOS, /var is a link to /private/var).
export function realPath(path) {
  let dir = resolve(path);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  return join(realpathSync(dir), relative(dir, resolve(path)));
}

export function codexWorktrees() {
  const home = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), '.codex');
  return realPath(join(home, 'worktrees'));
}

// True when the real path `dir` lies inside the Codex worktrees directory.
// Pass it the real path of a git top-level, not a directory as given.
export function insideCodexWorktrees(dir) {
  const rel = relative(codexWorktrees(), dir);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// The Codex worktree that the directory `dir` belongs to. Returns its
// top-level and the common git directory of its repository, as real paths,
// when it is one; null when git reads a repository at `dir` that is not one;
// undefined when git cannot read a repository at `dir`. A linked worktree has
// a git directory of its own, apart from the common one; the main working
// tree of a repository, one made with `git init` included, shares it.
export function codexWorktreeOf(dir) {
  const run = spawnSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'],
    { cwd: dir, encoding: 'utf8' },
  );
  if (run.error || run.status !== 0) return undefined;
  const [top, gitDir, common] = run.stdout.split('\n').map((line) => line.trim());
  if (!top || !gitDir || !common) return undefined;
  const tree = { top: realPath(top), common: realPath(common) };
  if (!insideCodexWorktrees(tree.top) || realPath(gitDir) === tree.common) return null;
  return tree;
}
