#!/usr/bin/env node
// PreToolUse hook for Edit, Write, NotebookEdit and common Bash writes.
// Frozen test amendments ask in the main session with evidence from the
// oracle; subagents and bypassPermissions are denied (ADR 0033). Build and
// test configuration changes ask too. oracle.mjs defines the paths and the
// linked-worktree binding (ADR 0003, ADR 0016). Unread shell forms pass and
// errors fail open visibly (ADR 0002); oracle-check and the merge guard catch
// changes that get through (ADR 0030). An allow prints nothing.
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Verdict, failOpen, git, readEvent } from './lib.mjs';
import { isTest, isTestConfig, oracleTag, testMatchers } from './oracle.mjs';
import { shellWrites } from './shell-writes.mjs';

// Resolves symlinks in the part of the path that exists, so the result is
// comparable with `git rev-parse --show-toplevel` (on macOS, /var is a link to
// /private/var). The file itself may not exist yet when Write creates it.
function realPath(path) {
  let dir = dirname(path);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  const real = realpathSync(dir);
  return { dir: real, file: join(real, relative(dir, path)) };
}

try {
  const event = readEvent();
  const input = event?.tool_input ?? {};
  const cwd = event.cwd ?? process.cwd();
  const raw = input.file_path ?? input.notebook_path;
  const paths = event.tool_name === 'Bash' && typeof input.command === 'string'
    ? shellWrites(input.command, cwd) : typeof raw === 'string' ? [raw] : [];
  const verdict = new Verdict();
  const repositories = new Map();
  const seen = new Set();
  for (const path of paths) {
    const { dir, file } = realPath(isAbsolute(path) ? path : resolve(cwd, path));
    if (seen.has(file)) continue;
    seen.add(file);
    const root = git(dir, ['rev-parse', '--show-toplevel']);
    if (!root) continue;
    if (!repositories.has(root)) {
      const tag = oracleTag(root);
      repositories.set(root, tag ? {
        tag,
        commit: git(root, ['rev-parse', '--verify', `${tag}^{commit}`]),
        matchers: testMatchers(root, tag),
      } : undefined);
    }
    const oracle = repositories.get(root);
    if (!oracle) continue;
    const { tag, commit, matchers } = oracle;
    if (!commit) throw new Error(`could not read the commit of ${tag}`);
    const rel = relative(root, file).split(sep).join('/');
    if (rel.startsWith('../')) continue;
    if (isTest(matchers, rel)) {
      const exists = git(root, ['ls-tree', '--name-only', commit, '--', rel]);
      if (exists === undefined) throw new Error(`could not read ${rel} at ${tag}`);
      const evidence = `${rel} would be ${exists ? 'amended' : 'added'} against the test oracle ${tag} (${commit}).`;
      if (typeof event.agent_id === 'string' && event.agent_id.length > 0) {
        verdict.add('deny', `${evidence} A subagent must not change frozen tests; return to the main session for human approval.`);
      } else if (event.permission_mode === 'bypassPermissions') {
        verdict.add('deny', `${evidence} Changing frozen tests is denied in bypassPermissions; switch to a mode that shows permission prompts.`);
      } else {
        verdict.add('ask', `${evidence} Confirm the human approves this amendment; it belongs in its own commit.`);
      }
    } else if (isTestConfig(rel)) {
      verdict.add('ask', `${rel} can change how the frozen tests at ${tag} run. Confirm this edit does not weaken them.`);
    }
  }
  verdict.emit();
} catch (error) {
  failOpen('guard-tests', error);
}
