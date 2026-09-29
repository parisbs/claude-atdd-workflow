// What the ATDD oracle protects (ADR 0003). Shared by the edit guard and by
// oracle-check, so the paths the guard freezes and the paths the pre-PR check
// compares are the same by construction.
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

export function oracleTag(root) {
  const branch = git(root, ['branch', '--show-current']);
  if (!branch) return undefined;
  const tag = `oracle/${branch}`;
  return git(root, ['rev-parse', '--verify', '-q', `refs/tags/${tag}`]) === undefined ? undefined : tag;
}

// Test paths as recorded in the oracle commit, so a later edit to
// .atdd/test-paths cannot widen what may change.
export function testMatchers(root, tag) {
  const declared = git(root, ['show', `${tag}:.atdd/test-paths`]);
  const base = declared
    ? declared.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map(globToRegExp)
    : DEFAULT_TESTS;
  return [...base, ATDD_DIR];
}

export const isTest = (matchers, rel) => matchers.some((re) => re.test(rel));
export const isTestConfig = (rel) => TEST_CONFIG.some((re) => re.test(rel));
