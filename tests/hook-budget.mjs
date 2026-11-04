// Issue #84: the hook-side contract is documented in hook-budget-contract.md.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const BUDGET_TEST_TOKEN = 'issue-84:explicit-test-only';
export const BUDGET_TEST_ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const scratch = mkdtempSync(join(tmpdir(), 'cw-budget-84-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
let sequence = 0;
const available = new Map();

export function hookBudget({ steps = [], cpuStepUs = 0 } = {}) {
  const id = ++sequence;
  const config = join(scratch, `${id}.json`);
  const trace = join(scratch, `${id}.jsonl`);
  writeFileSync(config, JSON.stringify({ version: 1, root: BUDGET_TEST_ROOT, trace, steps, cpuStepUs }));
  const events = () => existsSync(trace)
    ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return {
    env: { CW_HOOK_BUDGET_TEST: BUDGET_TEST_TOKEN, CW_HOOK_BUDGET_CONFIG: config },
    config, trace, events,
    // Fail before starting a 60 s fixture when the separately implemented seam is absent.
    require(hook, env) {
      if (!available.has(hook)) {
        const probe = hookBudget();
        const run = spawnSync(process.execPath, [join(BUDGET_TEST_ROOT, 'global/hooks', `${hook}.mjs`)], {
          cwd: BUDGET_TEST_ROOT, encoding: 'utf8', timeout: 120000,
          input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo issue-84' } }),
          env: { ...process.env, ...env, ...probe.env },
        });
        assert.equal(run.status, 0, run.error?.message ?? run.stderr);
        available.set(hook, probe.events().some((event) => event.hook === hook && event.type === 'limits'));
      }
      assert.ok(available.get(hook), `missing issue #84 budget seam in ${hook}`);
    },
    active(hook) {
      const all = events().filter((event) => event.hook === hook);
      assert.ok(all.some((event) => event.type === 'limits'), `missing issue #84 budget seam in ${hook}`);
      return all;
    },
    charged(hook, count = 1) {
      const all = this.active(hook).filter((event) => event.type === 'charge');
      assert.equal(all.length, count, 'each scripted read must be reached exactly once');
      return all;
    },
  };
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    if (existsSync('/proc') && /^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, 'utf8'))) return false;
    return true;
  } catch (error) {
    if (error.code === 'ESRCH' || error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function deadProcesses(pids) {
  const deadline = performance.now() + 30000;
  while (pids.some(processAlive) && performance.now() < deadline) await delay(25);
  assert.deepEqual(pids.filter(processAlive), [], 'no hung child or descendant may survive');
}

export async function cleanupProcesses(pids) {
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  await deadProcesses(pids);
}
