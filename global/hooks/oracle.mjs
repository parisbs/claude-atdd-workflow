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

// Glob matching without regular expressions, so a pattern with many wildcards
// cannot backtrack: the match advances a set of pattern positions per character.
// `**` matches any run of characters, `*` any run without `/`, `?` one character
// other than `/`; anything else matches itself. The match is anchored at both ends.
export function globToRegExp(glob) {
  const tokens = [];
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      tokens.push({ any: true });
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') tokens.push({ star: true });
    else if (c === '?') tokens.push({ one: true });
    else tokens.push({ char: c });
  }
  // A star token may match the empty string, so a position advances past it for free.
  const close = (states) => {
    for (let i = 0; i < states.length; i += 1) {
      const at = states[i];
      if (at < tokens.length && (tokens[at].any || tokens[at].star) && !states.includes(at + 1)) states.push(at + 1);
    }
    return states;
  };
  return {
    test(path) {
      let states = close([0]);
      for (const ch of path) {
        const next = [];
        for (const at of states) {
          const token = tokens[at];
          if (!token) continue;
          if (token.any || (token.star && ch !== '/')) {
            if (!next.includes(at)) next.push(at);
          } else if ((token.one && ch !== '/') || token.char === ch) {
            if (!next.includes(at + 1)) next.push(at + 1);
          }
        }
        if (!next.length) return false;
        states = close(next);
      }
      return states.includes(tokens.length);
    },
  };
}

// The oracle that binds the checkout at root: the tag `oracle/<current branch>`
// when it exists. In a linked worktree, where a delegate works on a branch of
// its own (or on a detached HEAD), it is otherwise the `oracle/*` tag whose
// commit is an ancestor of HEAD and nearest to it, so the oracle of the branch
// the worktree was made from still binds it. The main checkout keeps the
// branch's own tag only, so a branch stacked on another is not bound by it.
export function oracleTag(root, read = git) {
  const branch = read(root, ['branch', '--show-current']);
  if (branch) {
    const tag = `oracle/${branch}`;
    if (read(root, ['rev-parse', '--verify', '-q', `refs/tags/${tag}`]) !== undefined) return tag;
  }
  return isLinkedWorktree(root, read) ? nearestAncestorTag(root, read) : undefined;
}

function isLinkedWorktree(root, read) {
  const dirs = read(root, ['rev-parse', '--git-dir', '--git-common-dir'])?.split('\n');
  if (dirs?.length !== 2) return false;
  return resolve(root, dirs[0]) !== resolve(root, dirs[1]);
}

// Ties at equal distance go to the first tag name in sort order. A tag whose
// commit is an ancestor of another candidate is never the nearest, so only the
// independent commits need a distance and the number of git calls does not grow
// with the number of tags.
function nearestAncestorTag(root, read) {
  // %(*objectname) is the peeled commit of an annotated tag; empty for a lightweight tag.
  const refs = read(root, ['for-each-ref', '--merged', 'HEAD', '--sort=refname',
    '--format=%(refname) %(objectname) %(*objectname)', 'refs/tags/oracle/']);
  const byCommit = new Map(); // commit -> first ref name in sort order
  for (const line of (refs ?? '').split('\n').filter(Boolean)) {
    const [ref, object, peeled] = line.split(' ');
    const commit = peeled || object;
    if (!byCommit.has(commit)) byCommit.set(commit, ref);
  }
  if (byCommit.size === 0) return undefined;
  // A failed merge-base, or commits it names that the map does not hold, fall back to the
  // distance of every distinct commit, which is bounded by commits, not by tags.
  let heads = byCommit.size === 1 ? [...byCommit.keys()]
    : (read(root, ['merge-base', '--independent', ...byCommit.keys()]) ?? '').split('\n').filter(Boolean);
  if (!heads.length || heads.some((commit) => !byCommit.has(commit))) heads = [...byCommit.keys()];
  let nearest;
  for (const commit of heads) {
    const distance = Number(read(root, ['rev-list', '--count', `${commit}..HEAD`]));
    if (!Number.isInteger(distance)) continue;
    const ref = byCommit.get(commit);
    if (nearest === undefined || distance < nearest.distance || (distance === nearest.distance && ref < nearest.ref)) {
      nearest = { ref, distance };
    }
  }
  return nearest?.ref.slice('refs/tags/'.length);
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
