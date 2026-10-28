// What the ATDD oracle protects (ADR 0003). Shared by the edit guard and by
// oracle-check and the merge guard, so the paths they compare and freeze are
// the same by construction.
import { resolve } from 'node:path';
import { git } from './lib.mjs';

export const DEFAULT_TESTS = [
  /(^|\/)src\/[A-Za-z0-9]*[Tt]est\//, // test, androidTest, commonTest, jvmTest, androidHostTest
  /(^|\/)(test|tests|integration_test|__tests__|testdata)\//,
  /(^|\/)fixtures\//,
  /(^|\/)supabase\/tests\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /_test\.dart$/,
];

const ATDD_DIR = /(^|\/)\.atdd\//;

export const TEST_CONFIG = [
  /(^|\/)build\.gradle(\.kts)?$/,
  /(^|\/)gradle\/libs\.versions\.toml$/,
  /(^|\/)detekt[^/]*\.(yml|xml)$/,
  /(^|\/)package\.json$/,
  /(^|\/)(jest|vitest|playwright)\.config\.[cm]?[jt]s$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)pubspec\.yaml$/,
  /(^|\/)analysis_options\.yaml$/,
  /(^|\/)dart_test\.yaml$/,
  /(^|\/)(pyproject\.toml|setup\.cfg|pytest\.ini|tox\.ini)$/,
  /(^|\/)supabase\/config\.toml$/,
  /(^|\/)\.github\/workflows\//,
];

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

// The oracle that binds the checkout at root: the tag `oracle/<current branch>`
// when it exists. In a linked worktree, where a delegate works on a branch of
// its own (or on a detached HEAD), it is otherwise the `oracle/*` tag whose
// commit is an ancestor of HEAD and nearest to it, so the oracle of the branch
// the worktree was made from still binds it. The main checkout keeps the
// branch's own tag only, so a branch stacked on another is not bound by it.
export function oracleTag(root) {
  const branch = git(root, ['branch', '--show-current']);
  if (branch) {
    const tag = `oracle/${branch}`;
    if (git(root, ['rev-parse', '--verify', '-q', `refs/tags/${tag}`]) !== undefined) return tag;
  }
  return isLinkedWorktree(root) ? nearestAncestorTag(root) : undefined;
}

function isLinkedWorktree(root) {
  const dirs = git(root, ['rev-parse', '--git-dir', '--git-common-dir'])?.split('\n');
  if (dirs?.length !== 2) return false;
  return resolve(root, dirs[0]) !== resolve(root, dirs[1]);
}

// Ties at equal distance go to the first tag name in sort order.
function nearestAncestorTag(root) {
  const refs = git(root, ['for-each-ref', '--merged', 'HEAD', '--format=%(refname)', 'refs/tags/oracle/']);
  let nearest;
  for (const ref of (refs ?? '').split('\n').filter(Boolean).sort()) {
    const distance = Number(git(root, ['rev-list', '--count', `${ref}..HEAD`]));
    if (!Number.isInteger(distance)) continue;
    if (nearest === undefined || distance < nearest.distance) nearest = { tag: ref.slice('refs/tags/'.length), distance };
  }
  return nearest?.tag;
}

// Test paths as recorded in the oracle commit, so a later edit to
// .atdd/test-paths cannot widen what may change. The merge guard supplies a
// strict reader so a failed read cannot silently fall back to the defaults.
export function testMatchers(root, tag, read = git) {
  const paths = read(root, ['ls-tree', '--name-only', tag, '--', '.atdd/test-paths']);
  const declared = paths ? read(root, ['show', `${tag}:.atdd/test-paths`])?.trim() : undefined;
  const base = declared
    ? declared.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map(globToRegExp)
    : DEFAULT_TESTS;
  return [...base, ATDD_DIR];
}

export const isTest = (matchers, rel) => matchers.some((re) => re.test(rel));
export const isTestConfig = (rel) => TEST_CONFIG.some((re) => re.test(rel));
