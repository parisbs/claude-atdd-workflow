#!/usr/bin/env node
// Integrates the uncommitted changes a `codex-implementer` run left in its
// Codex worktree into the work branch (ADR 0014, issue #42). Run from inside
// the work branch:
//
//   node ~/.claude/hooks/codex-integrate.mjs <worktree-path>
//
// Applies the worktree's changes, new and binary files included and ignored
// files excluded, runs oracle-check on the work branch, and removes the
// worktree only once the changes are applied, with the directory Codex made
// around it when that directory is left empty. Exits 0 when the changes are
// applied and oracle-check is clean, 1 when they are applied and oracle-check
// reports a changed test path, and 2 when nothing was applied: the work branch
// is left untouched and the worktree is kept.
//
// The worktree's files are read into a scratch index, so its own index is not
// touched, and the patch is checked before it is applied; `git apply` is
// atomic, so a patch that does not apply writes nothing. When the work branch
// moved since the worktree was made, the changes are merged three-way in the
// object database (`git merge-tree`) and applied only when the merge is clean:
// a conflict never leaves markers on the work branch. The changes stay
// uncommitted; the caller runs the verify command and commits.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexWorktreeOf, codexWorktrees, insideCodexWorktrees, realPath } from './codex.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// Runs git without a shell and returns the whole result, so the caller can
// read the status, the error output or a patch as raw bytes.
function run(cwd, args, { env, encoding = 'utf8' } = {}) {
  return spawnSync('git', args, { cwd, encoding, maxBuffer: 1024 ** 3, env: { ...process.env, ...env } });
}
const ok = (result) => !result.error && result.status === 0;
const out = (result) => (ok(result) ? result.stdout.trim() : undefined);
const why = (result) => (result.error?.message ?? result.stderr?.toString() ?? '').trim();

// Nothing was applied: exit 2, work branch untouched, worktree kept.
class Stop extends Error {}
const stop = (message) => {
  throw new Stop(message);
};

function commonDir(dir) {
  const path = out(run(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  return path && realPath(path);
}

// The Codex worktree at `path`, as a real path, after checking that it is one
// and that it belongs to the repository of `work`.
function codexWorktree(path, work) {
  if (!existsSync(path) || !statSync(path).isDirectory()) stop(`${path} does not exist.`);
  const tree = codexWorktreeOf(path);
  if (!tree) stop(`${path} is not a Codex worktree: a git linked worktree inside ${codexWorktrees()}.`);
  if (tree.top === work) stop(`${path} is the work branch itself; run the script from the work branch.`);
  const common = commonDir(work);
  if (!common) stop(`could not read the git directory of ${work}.`);
  if (tree.common !== common) stop(`${path} is a worktree of another repository than ${work}.`);
  return tree.top;
}

// Checks a patch and applies it to the working tree of `work`. Returns the
// error output when it does not apply; then nothing was written.
function apply(work, patch) {
  const check = run(work, ['apply', '--check', '--whitespace=nowarn', patch]);
  if (!ok(check)) return why(check) || 'git apply --check failed';
  const applied = run(work, ['apply', '--whitespace=nowarn', patch]);
  return ok(applied) ? undefined : why(applied) || 'git apply failed';
}

function patchFile(dir, name, from, to, cwd) {
  const diff = run(cwd, ['diff-tree', '-p', '--binary', '--full-index', from, to], { encoding: 'buffer' });
  if (!ok(diff)) stop(`could not diff ${from} and ${to}: ${why(diff)}`);
  const file = join(dir, name);
  writeFileSync(file, diff.stdout);
  return { file, empty: diff.stdout.length === 0 };
}

// Removes the <id> directory Codex made around the removed worktree `tree`
// when nothing is left in it, so no stale directory stays under the worktrees
// directory. The worktrees directory itself stays, and so does a directory
// that holds anything else: rmdir refuses one that is not empty.
function removeEmptyParent(tree) {
  const parent = dirname(tree);
  if (!insideCodexWorktrees(parent)) return;
  try {
    if (readdirSync(parent).length === 0) rmdirSync(parent);
  } catch (error) {
    console.error(`codex-integrate: could not remove the empty directory ${parent}: ${error.message}`);
  }
}

function integrate(arg, scratch, state) {
  if (!arg) stop('usage: node ~/.claude/hooks/codex-integrate.mjs <worktree-path>');
  const top = out(run(process.cwd(), ['rev-parse', '--show-toplevel']));
  if (!top) stop('not inside a git repository; run it from the work branch.');
  const work = realPath(top);
  const tree = codexWorktree(arg, work);

  const head = out(run(work, ['rev-parse', '--verify', 'HEAD']));
  const made = out(run(tree, ['rev-parse', '--verify', 'HEAD']));
  const base = head && made && out(run(work, ['merge-base', made, head]));
  if (!base) stop(`${tree} shares no commit with the work branch.`);

  // The worktree's files as a tree, ignored files left out, through a scratch
  // index so that the worktree's own index stays as it is.
  const index = { env: { GIT_INDEX_FILE: join(scratch, 'index') } };
  for (const args of [['read-tree', made], ['add', '-A']]) {
    const step = run(tree, args, index);
    if (!ok(step)) stop(`could not read the files of ${tree}: ${why(step)}`);
  }
  const snapshot = out(run(tree, ['write-tree'], index));
  if (!snapshot) stop(`could not read the files of ${tree}.`);

  const changes = patchFile(scratch, 'changes.patch', base, snapshot, work);
  if (changes.empty) stop(`${tree} has no changes to apply.`);
  let failure = apply(work, changes.file);
  if (failure !== undefined && base !== head) {
    // The work branch moved: merge three-way without touching it, and apply
    // the clean result as a patch from its HEAD.
    const merge = run(work, ['merge-tree', '--write-tree', '--name-only', `--merge-base=${base}`, head, snapshot]);
    const [result, ...rest] = (merge.stdout ?? '').split('\n');
    if (ok(merge)) {
      const merged = patchFile(scratch, 'merged.patch', head, result.trim(), work);
      failure = merged.empty ? undefined : apply(work, merged.file);
    } else if (merge.status === 1) {
      const conflicts = rest.slice(0, Math.max(0, rest.indexOf(''))).filter(Boolean);
      failure = `they conflict with the work branch in ${conflicts.join(', ') || 'some files'}`;
    } else {
      failure = `${failure}\n${why(merge)}`;
    }
  }
  if (failure !== undefined) {
    stop(`the changes of ${tree} were not applied: ${failure}\nThe work branch is untouched and the worktree is kept.`);
  }
  state.applied = true;
  console.log(`codex-integrate: applied the changes of ${tree} to ${work}, uncommitted.`);

  const check = spawnSync(process.execPath, [join(here, 'oracle-check.mjs')], { cwd: work, encoding: 'utf8' });
  process.stdout.write(check.stdout ?? '');
  process.stderr.write(check.stderr ?? '');
  const clean = !check.error && check.status === 0;
  if (!clean && check.status !== 1) console.error('codex-integrate: oracle-check did not run; run it on the work branch.');

  // The changes are on the work branch now, so the worktree can go; --force
  // because the delegate left them uncommitted there.
  const removed = run(work, ['worktree', 'remove', '--force', tree]);
  if (ok(removed)) {
    console.log(`codex-integrate: removed the worktree ${tree}.`);
    removeEmptyParent(tree);
  } else console.error(`codex-integrate: could not remove the worktree ${tree}: ${why(removed)}`);
  console.log('codex-integrate: run the verify command on the work branch before committing.');
  return clean ? 0 : 1;
}

const state = { applied: false };
const scratch = mkdtempSync(join(tmpdir(), 'codex-integrate-'));
try {
  process.exitCode = integrate(process.argv[2], scratch, state);
} catch (error) {
  if (error instanceof Stop) console.error(`codex-integrate: ${error.message}`);
  else console.error(`codex-integrate: ${error?.stack ?? error}`);
  process.exitCode = error instanceof Stop || !state.applied ? 2 : 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
