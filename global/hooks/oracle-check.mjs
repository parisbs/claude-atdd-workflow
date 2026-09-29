#!/usr/bin/env node
// Deterministic pre-PR check for the ATDD oracle (ADR 0003). Run from inside a
// repository:
//
//   node ~/.claude/hooks/oracle-check.mjs
//
// Compares the working tree (committed and uncommitted changes) with the
// `oracle/<branch>` tag and reports every changed test path, every changed
// test-configuration file, and every added skip annotation. Exits 1 when a test
// path changed, 0 otherwise; configuration changes and skips are reported for a
// human to judge. With no oracle tag on the branch there is nothing to check.
import { git } from './lib.mjs';
import { isTest, isTestConfig, oracleTag, testMatchers } from './oracle.mjs';

const SKIPS = /@Ignore\b|@Disabled\b|\bxit\(|\bxdescribe\(|\.skip\(|\bskip:\s*(true|'|")|@Skip\b|\btest\.todo\(/;

const root = git(process.cwd(), ['rev-parse', '--show-toplevel']);
if (!root) {
  console.error('oracle-check: not inside a git repository.');
  process.exit(2);
}
const tag = oracleTag(root);
if (!tag) {
  console.log('oracle-check: no oracle tag on this branch; nothing to check.');
  process.exit(0);
}

const changed = (git(root, ['diff', '--name-only', tag]) ?? '')
  .split('\n')
  .concat((git(root, ['ls-files', '--others', '--exclude-standard']) ?? '').split('\n'))
  .filter(Boolean);
const matchers = testMatchers(root, tag);
const tests = [...new Set(changed.filter((p) => isTest(matchers, p)))];
const config = [...new Set(changed.filter((p) => !isTest(matchers, p) && isTestConfig(p)))];

const added = (git(root, ['diff', '-U0', tag]) ?? '')
  .split('\n')
  .filter((l) => l.startsWith('+') && !l.startsWith('+++') && SKIPS.test(l));

console.log(`oracle-check against ${tag}`);
console.log(tests.length === 0 ? '- test paths: unchanged' : `- test paths changed:\n${tests.map((p) => `  - ${p}`).join('\n')}`);
console.log(config.length === 0 ? '- test configuration: unchanged' : `- test configuration changed, review it:\n${config.map((p) => `  - ${p}`).join('\n')}`);
console.log(added.length === 0 ? '- skip annotations: none added' : `- skip annotations added, review them:\n${added.map((l) => `  ${l}`).join('\n')}`);
process.exit(tests.length === 0 ? 0 : 1);
