#!/usr/bin/env node
// PreToolUse hook for Edit, Write, NotebookEdit and common Bash writes.
// Frozen test changes ask in the main session: the human must approve an
// amendment, addition or deletion against the oracle in its own commit.
// Subagents cannot approve amendments, and bypassPermissions has no guaranteed
// prompt, so both are denied (ADR 0033). Test configuration changes ask too.
// oracle.mjs defines the paths and linked-worktree binding (ADR 0003, 0016).
// Text the reader does not read, and a reader that fails, ask or deny the same
// way when it names a frozen or configuration path (ADR 0034); a program the
// reader does not know stays allowed, and other failures fail open visibly
// without losing findings already collected (ADR 0002). oracle-check and the
// merge guard catch what passes (ADR 0030). An allow prints nothing.
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { realPath } from './codex.mjs';
import { SUFFIX, fragments, sessionOf, unreadReason, withoutData } from './frozen-trigger.mjs';
import { Verdict, git, readEvent } from './lib.mjs';
import { globToRegExp, isTest, isTestConfig, oracleTag, testMatchers } from './oracle.mjs';
import { shellWrites } from './shell-writes.mjs';

const report = (error) => process.stderr.write(`guard-tests: could not evaluate, allowing unread remainder (${error?.message ?? error})\n`);
const exhausted = () => Object.assign(new Error('oracle CPU or read budget exhausted'), { budget: true });
// Reasons by severity, so the cap of the verdict keeps the most severe first: denies, then
// frozen-test asks, then configuration asks. Within a class the unread-command reasons come
// first, since they say that the guard stopped reading.
const denies = [];
const frozenAsks = [];
const configAsks = [];
const unreadDenies = [];
const unreadAsks = [];
try {
  const event = readEvent();
  if (event) {
    const input = event.tool_input ?? {};
    const cwd = event.cwd ?? process.cwd();
    const session = sessionOf(event);
    const roots = new Map();
    const repositories = new Map();
    const broken = new Set();
    const seen = new Set();
    const rules = new Set();
    // Each git read and all of them together stay inside the entry's 15 s timeout, so a stalled
    // repository fails open with a message instead of being killed before the verdict is printed.
    // The environment overrides exist for the tests, as GUARD_GIT_GH_TIMEOUT_MS does for guard-git.
    const limit = Number(process.env.GUARD_TESTS_GIT_TIMEOUT_MS) || 5000;
    // performance.now() counts from the start of the process, module load included. The trigger
    // may still read the oracle for 2 s after the budget trips, so the verdict is not lost to it.
    const deadline = Math.min(Number(process.env.GUARD_TESTS_GIT_BUDGET_MS) || 10000, 10000);
    const grace = deadline + 2000;
    const cpuStarted = process.cpuUsage();
    // CPU spent reading the command and matching the inventory; 8 s leaves room for the 10 s deadline.
    const cpuLimit = (Number(process.env.GUARD_TESTS_CPU_BUDGET_MS) || 8000) * 1000;
    const check = () => {
      const cpu = process.cpuUsage(cpuStarted);
      if (performance.now() >= deadline || cpu.user + cpu.system >= cpuLimit) throw exhausted();
    };
    const wall = () => {
      if (performance.now() >= grace) throw exhausted();
    };
    const reader = (until) => (dir, args) => {
      const remaining = Math.floor(until - performance.now());
      if (remaining <= 0) throw exhausted();
      return git(dir, args, {
        timeout: Math.min(limit, remaining), killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }, onError: (error) => { throw error; },
      });
    };
    const read = reader(deadline);
    const readGrace = reader(grace);
    // The cheap part of an oracle: the tag and its matchers. Cache failures too, so an unread
    // repository is not retried per file; the trigger retries them within its own allowance.
    const repository = (dir, rd = read) => {
      if (!roots.has(dir) || (rd !== read && broken.has(`dir ${dir}`))) {
        roots.set(dir, undefined);
        try {
          roots.set(dir, rd(dir, ['rev-parse', '--show-toplevel']));
          broken.delete(`dir ${dir}`);
        } catch (error) {
          broken.add(`dir ${dir}`);
          throw error;
        }
      }
      const root = roots.get(dir);
      if (!root) return undefined;
      if (!repositories.has(root) || (rd !== read && broken.has(`root ${root}`))) {
        repositories.set(root, undefined);
        try {
          const tag = oracleTag(root, rd);
          if (tag) {
            const commit = rd(root, ['rev-parse', '--verify', `${tag}^{commit}`]);
            if (!commit) throw new Error(`could not read the commit of ${tag}`);
            repositories.set(root, { root, tag, commit, matchers: testMatchers(root, tag, rd) });
          }
          broken.delete(`root ${root}`);
        } catch (error) {
          broken.add(`root ${root}`);
          throw error;
        }
      }
      return repositories.get(root);
    };
    // The file list of the oracle commit, built when a decision needs it. A list that cannot be
    // read marks the oracle unreadable; a budget that runs out while deciding is the caller's.
    const inventoryOf = (oracle, rd = read, tick = check) => {
      if (oracle.files || oracle.unreadable) return oracle;
      try {
        const { root, tag, commit, matchers } = oracle;
        const tree = rd(root, ['ls-tree', '-rz', '--name-only', commit]);
        if (tree === undefined) throw new Error(`could not read the files at ${tag}`);
        const files = [];
        const byPath = new Map();
        const byDirectory = new Map();
        for (const path of tree.split('\0')) {
          tick();
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
        if (error.budget && rd === read) throw error;
        oracle.unreadable = true;
        if (rd === read) report(new Error(`change label could not be read at ${oracle.tag}: ${error.message}`));
      }
      return oracle;
    };
    const locate = (path) => {
      const target = realPath(path);
      let dir = target;
      while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
      if (!statSync(dir).isDirectory()) dir = dirname(dir);
      return { target, oracle: repository(dir) };
    };
    const relativeTo = (oracle, target) => relative(oracle.root, target).split(sep).join('/');
    // The trigger: which oracles, and which of their paths, the words of a text name.
    // It reads the oracle within the grace allowance, since it runs when the budget may be gone.
    // `dir` is the directory the reader had reached where the text sits, when it knew it.
    const triggered = (text, dir) => {
      const found = new Map();
      const tried = new Set();
      let project;
      const projectRoot = () => {
        if (project === undefined) {
          let start = cwd;
          while (!existsSync(start) && dirname(start) !== start) start = dirname(start);
          project = repository(start, readGrace)?.root ?? null;
        }
        return project ?? undefined;
      };
      // Where a relative word may point, nearest first: the reader's directory, the event cwd and
      // the project root.
      const bases = () => [...new Set([dir, cwd, projectRoot()].filter((base) => base !== undefined))];
      const add = (oracle, names) => {
        if (!found.has(oracle)) found.set(oracle, []);
        for (const entry of names) if (!found.get(oracle).includes(entry)) found.get(oracle).push(entry);
      };
      // A glob names the frozen files and the files of the frozen directories it matches. A bracket
      // class counts as one character of any kind: over-matching is the safe side here.
      const match = (oracle, target) => {
        const re = globToRegExp(target.replace(/\[[^\]/]*\]/g, '?'));
        const names = [];
        let count = 0;
        for (const [key, file] of oracle.files.byPath) {
          if (++count % 256 === 0) wall();
          if (re.test(key)) names.push(relativeTo(oracle, file.path));
        }
        for (const [key, files] of oracle.files.byDirectory) {
          if (++count % 256 === 0) wall();
          if (key !== oracle.root && re.test(key)) names.push(...files.map((file) => relativeTo(oracle, file.path)));
        }
        return names;
      };
      const name = (path, glob) => {
        let target;
        let nearest;
        try {
          target = realPath(path);
          nearest = target;
          while (!existsSync(nearest) && dirname(nearest) !== nearest) nearest = dirname(nearest);
          if (!statSync(nearest).isDirectory()) nearest = dirname(nearest);
        } catch {
          return;
        }
        const oracle = repository(nearest, readGrace);
        if (!oracle) return;
        const rel = relativeTo(oracle, target);
        if (!rel || rel === '..' || rel.startsWith('../')) return;
        inventoryOf(oracle, readGrace, wall);
        const names = [];
        if (oracle.files && glob) names.push(...match(oracle, target));
        else if (oracle.files) {
          // An addition, a path under the test paths that is not frozen yet, counts as well.
          if (oracle.files.byPath.has(target) || isTestConfig(rel) || isTest(oracle.matchers, rel)) names.push(rel);
          else if (oracle.files.byDirectory.has(target)) names.push(...oracle.files.byDirectory.get(target).map((file) => relativeTo(oracle, file.path)));
        } else if (isTest(oracle.matchers, rel) || isTest(oracle.matchers, `${rel}/`) || isTestConfig(rel)) names.push(rel);
        if (names.length) add(oracle, names);
      };
      try {
        for (const { text: word, tail, glob } of fragments(text)) {
          wall();
          let paths;
          if (tail) paths = bases().map((base) => resolve(base, word.replace(/^\/+/, '')));
          else if (word === '~' || word.startsWith('~/')) paths = [resolve(homedir(), word.slice(2))];
          else if (isAbsolute(word)) paths = [word];
          else paths = bases().map((base) => resolve(base, word));
          for (const path of paths) {
            if (tried.has(path)) continue;
            tried.add(path);
            name(path, glob);
          }
        }
      } catch (error) {
        // What was found stays; the run-out is visible.
        report(error);
      }
      return found;
    };
    // Adds the rule's verdict for what `text` names; false when it names nothing.
    const unreadAt = (text, part, span, dir) => {
      const found = triggered(text, dir);
      for (const [oracle, names] of found) {
        const reason = unreadReason({ part, span, names, tag: oracle.tag, commit: oracle.commit, session });
        if (rules.has(reason)) continue;
        rules.add(reason);
        (session === 'main' ? unreadAsks : unreadDenies).push(reason);
      }
      return found.size > 0;
    };
    let subject = () => '';
    let named;
    // A reader failure: the whole command is the span, and the failure stays visible. If the
    // command names nothing, that message is all there is: the failure fails open.
    const failed = (error) => {
      try {
        if (named === undefined) named = unreadAt(subject(), `the reader failed (${error?.message ?? error})`);
      } catch (inner) {
        named = false;
        report(inner);
      }
      report(error);
    };
    // `cause` is why the reader stopped reading, when a failure it recovered from was the reason.
    // `dir` is the directory the reader had reached at the span, or undefined when it did not know.
    const unread = (span, part, cause, dir) => {
      try {
        if (unreadAt(span, part, span, dir) && cause) report(cause);
      } catch (error) {
        failed(error);
      }
    };
    const record = (path, action = 'changed') => {
      try {
        check();
        const file = realPath(isAbsolute(path) ? path : resolve(cwd, path));
        let dir = dirname(file);
        while (!existsSync(dir)) dir = dirname(dir);
        const key = `${action}:${file}`;
        if (seen.has(key)) return;
        seen.add(key);
        const oracle = repository(dir);
        if (!oracle) return;
        check();
        const { tag, commit, matchers } = oracle;
        const rel = relativeTo(oracle, file);
        if (rel.startsWith('../')) return;
        if (isTest(matchers, rel)) {
          const { frozen } = inventoryOf(oracle);
          const change = action === 'deleted' ? 'deleted'
            : !frozen ? 'changed (change label could not be read)'
              : frozen.has(rel) ? 'amended' : 'added';
          const evidence = `${rel} would be ${change} against the test oracle ${tag} (${commit}).`;
          if (session === 'main') frozenAsks.push(`${evidence} ${SUFFIX.main}`);
          else denies.push(`${evidence} ${SUFFIX[session]}`);
        } else if (isTestConfig(rel)) {
          configAsks.push(`${rel} can change how the frozen tests at ${tag} run. Confirm this edit does not weaken them.`);
        }
      } catch (error) {
        failed(error);
      }
    };
    const files = (path) => {
      check();
      const { oracle } = locate(path);
      if (!oracle) return [];
      inventoryOf(oracle);
      return oracle.files ?? Object.assign([], { unreadable: true });
    };
    // Whether a path can be a test or a configuration path, without reading the file list.
    const mayHoldTests = (path) => {
      check();
      const { target, oracle } = locate(path);
      if (!oracle) return false;
      const rel = relativeTo(oracle, target);
      if (!rel || rel === '..' || rel.startsWith('../')) return false;
      return isTest(oracle.matchers, rel) || isTest(oracle.matchers, `${rel}/`) || isTestConfig(rel);
    };
    const rootOf = (path) => locate(path).oracle?.root;
    if (event.tool_name === 'Bash' && typeof input.command === 'string') {
      subject = () => withoutData(input.command);
      try {
        shellWrites(input.command, cwd, {
          files, write: record, error: failed, check, unread, mayHoldTests, rootOf, testThrow: process.env.GUARD_TESTS_TEST_THROW === '1',
        });
      } catch (error) {
        failed(error);
      }
    } else {
      const raw = input.file_path ?? input.notebook_path;
      subject = () => String(raw ?? '');
      if (typeof raw === 'string') record(raw);
    }
  }
} catch (error) {
  report(error);
}
const verdict = new Verdict(20);
for (const reason of [...unreadDenies, ...denies]) verdict.add('deny', reason);
for (const reason of [...unreadAsks, ...frozenAsks]) verdict.add('ask', reason);
for (const reason of configAsks) verdict.add('ask', reason);
verdict.emit();
