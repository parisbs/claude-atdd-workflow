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
import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { realPath } from './codex.mjs';
import { Verdict, git, readEvent } from './lib.mjs';
import { isTest, isTestConfig, oracleTag, testMatchers } from './oracle.mjs';
import { shellWrites } from './shell-writes.mjs';

// Git and CPU work share an overall deadline below the entry's 15 s timeout.
const verdict = new Verdict(20);
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
    const started = performance.now();
    const cpuStarted = process.cpuUsage();
    const deadline = started + Math.min(Number(process.env.GUARD_TESTS_GIT_BUDGET_MS) || 10000, 10000);
    // CPU spent reading the command and matching the inventory; 8 s leaves room for the 10 s deadline.
    const cpuLimit = (Number(process.env.GUARD_TESTS_CPU_BUDGET_MS) || 8000) * 1000;
    const check = () => {
      const cpu = process.cpuUsage(cpuStarted);
      if (performance.now() >= deadline || cpu.user + cpu.system >= cpuLimit) throw new Error('oracle CPU or read budget exhausted');
    };
    const read = (dir, args) => {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) throw new Error('oracle read budget exhausted');
      return git(dir, args, {
        timeout: Math.min(limit, remaining), killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }, onError: (error) => { throw error; },
      });
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
          const oracle = { root, tag, commit, matchers };
          repositories.set(root, oracle);
          try {
            const tree = read(root, ['ls-tree', '-rz', '--name-only', commit]);
            if (tree === undefined) throw new Error(`could not read the files at ${tag}`);
            const files = [];
            const byPath = new Map();
            const byDirectory = new Map();
            for (const path of tree.split('\0')) {
              check();
              if (!path || !(isTest(matchers, path) || isTestConfig(path))) continue;
              const file = { path: resolve(root, path), root };
              files.push(file);
              byPath.set(file.path, file);
              let dir = dirname(file.path);
              roots.set(dir, root);
              while (dir === root || dir.startsWith(`${root}${sep}`)) {
                if (!byDirectory.has(dir)) byDirectory.set(dir, []);
                byDirectory.get(dir).push(file);
                if (dir === root) break;
                dir = dirname(dir);
              }
            }
            oracle.files = Object.assign(files, { byPath, byDirectory, root });
            oracle.frozen = new Set(files.map((file) => relative(root, file.path).split(sep).join('/')));
          } catch (error) {
            report(new Error(`change label could not be read at ${tag}: ${error.message}`));
          }
        }
      }
      return repositories.get(root);
    };
    const record = (path, action = 'changed') => {
      try {
        const file = realPath(isAbsolute(path) ? path : resolve(cwd, path));
        let dir = dirname(file);
        while (!existsSync(dir)) dir = dirname(dir);
        const key = `${action}:${file}`;
        if (seen.has(key)) return;
        seen.add(key);
        const oracle = repository(dir);
        if (!oracle) return;
        const { root, tag, commit, matchers, frozen } = oracle;
        const rel = relative(root, file).split(sep).join('/');
        if (rel.startsWith('../')) return;
        if (isTest(matchers, rel)) {
          const change = !frozen ? 'changed (change label could not be read)' : action === 'deleted' ? 'deleted' : frozen.has(rel) ? 'amended' : 'added';
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
    const files = (path) => {
      check();
      let dir = realPath(path);
      while (!existsSync(dir)) dir = dirname(dir);
      if (!statSync(dir).isDirectory()) dir = dirname(dir);
      return repository(dir)?.files ?? [];
    };
    if (event.tool_name === 'Bash' && typeof input.command === 'string') {
      shellWrites(input.command, cwd, { files, write: record, error: report, check });
    } else {
      const raw = input.file_path ?? input.notebook_path;
      if (typeof raw === 'string') record(raw);
    }
  }
} catch (error) {
  report(error);
}
verdict.emit();
