#!/usr/bin/env node
// PreToolUse hook for Edit, Write, NotebookEdit and common Bash writes.
// Frozen test changes ask in the main session: the human must approve an
// amendment, addition or deletion against the oracle in its own commit.
// Subagents cannot approve amendments, and bypassPermissions has no guaranteed
// prompt, so both are denied (ADR 0033). Test configuration changes ask too.
// oracle.mjs defines the paths and linked-worktree binding (ADR 0003, 0016).
// Unread shell forms pass; errors fail open visibly without losing findings
// already collected (ADR 0002). oracle-check and the merge guard catch what
// passes (ADR 0030). An allow prints nothing.
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Verdict, git, readEvent } from './lib.mjs';
import { isTest, isTestConfig, oracleTag, testMatchers } from './oracle.mjs';
import { shellWrites } from './shell-writes.mjs';

// Resolve the existing part of a path, including /var on macOS and symlinked
// directories. Write can name a file whose parents do not yet exist.
function realPath(path) {
  let dir = dirname(path);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  const real = realpathSync(dir);
  return { dir: real, file: join(real, relative(dir, path)) };
}

const verdict = new Verdict();
const report = (error) => process.stderr.write(`guard-tests: could not evaluate, allowing unread remainder (${error?.message ?? error})\n`);
try {
  const event = readEvent();
  if (event) {
    const input = event.tool_input ?? {};
    const cwd = event.cwd ?? process.cwd();
    const repositories = new Map();
    const roots = new Map();
    const seen = new Set();
    // Each git read and all of them together stay inside the entry's 15 s timeout, so a stalled
    // repository fails open with a message instead of being killed before the verdict is printed.
    // The environment overrides exist for the tests, as GUARD_GIT_GH_TIMEOUT_MS does for guard-git.
    const limit = Number(process.env.GUARD_TESTS_GIT_TIMEOUT_MS) || 5000;
    const deadline = Date.now() + (Number(process.env.GUARD_TESTS_GIT_BUDGET_MS) || 12000);
    const read = (dir, args) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('oracle read budget exhausted');
      return git(dir, args, { timeout: Math.min(limit, remaining), onError: (error) => { throw error; } });
    };
    const repository = (dir) => {
      if (!roots.has(dir)) {
        roots.set(dir, undefined);
        roots.set(dir, read(dir, ['rev-parse', '--show-toplevel']));
      }
      const root = roots.get(dir);
      if (!root) return undefined;
      if (!repositories.has(root)) {
        // Cache failures too: an unread repository must not be retried per file.
        repositories.set(root, undefined);
        const tag = oracleTag(root, read);
        if (tag) {
          const commit = read(root, ['rev-parse', '--verify', `${tag}^{commit}`]);
          if (!commit) throw new Error(`could not read the commit of ${tag}`);
          const matchers = testMatchers(root, tag, read);
          const tree = read(root, ['ls-tree', '-rz', '--name-only', commit]);
          if (tree === undefined) throw new Error(`could not read the files at ${tag}`);
          const files = tree.split('\0').filter((path) => path && (isTest(matchers, path) || isTestConfig(path)));
          for (const path of files) roots.set(dirname(resolve(root, path)), root);
          repositories.set(root, { root, tag, commit, matchers, files, frozen: new Set(files) });
        }
      }
      return repositories.get(root);
    };
    const record = (path, action = 'changed') => {
      try {
        const { dir, file } = realPath(isAbsolute(path) ? path : resolve(cwd, path));
        const key = `${action}:${file}`;
        if (seen.has(key)) return;
        seen.add(key);
        const oracle = repository(dir);
        if (!oracle) return;
        const { root, tag, commit, matchers, frozen } = oracle;
        const rel = relative(root, file).split(sep).join('/');
        if (rel.startsWith('../')) return;
        if (isTest(matchers, rel)) {
          const change = action === 'deleted' ? 'deleted' : frozen.has(rel) ? 'amended' : 'added';
          const evidence = `${rel} would be ${change} against the test oracle ${tag} (${commit}).`;
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
      } catch (error) {
        report(error);
      }
    };
    const files = (dir) => {
      const oracle = repository(realpathSync(dir));
      return oracle ? oracle.files.map((path) => ({ path: resolve(oracle.root, path), root: oracle.root, test: isTest(oracle.matchers, path) })) : [];
    };
    if (event.tool_name === 'Bash' && typeof input.command === 'string') {
      shellWrites(input.command, cwd, { files, write: record, error: report });
    } else {
      const raw = input.file_path ?? input.notebook_path;
      if (typeof raw === 'string') record(raw);
    }
  }
} catch (error) {
  report(error);
}
verdict.emit();
