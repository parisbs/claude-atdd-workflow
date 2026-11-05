// Test clocks and read charges for issue #84. Installed hooks use the native
// clocks and subprocess runner; configuration is data, never executable code.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const production = {
  now: () => performance.now(),
  cpuUsage: (started) => process.cpuUsage(started),
  limits() {},
  spawnSync,
  read: (_program, _args, _cwd, timeout) => ({ timeout, finish: (result) => result }),
};
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
const absolute = (value) => typeof value === 'string' && isAbsolute(value);
const programs = new Set(['git', 'gh', 'ssh']);

export function hookBudget(url) {
  if (process.env.CW_HOOK_BUDGET_TEST !== 'issue-84:explicit-test-only') return production;
  let config;
  let hook;
  try {
    const path = process.env.CW_HOOK_BUDGET_CONFIG;
    if (!absolute(path)) return production;
    config = JSON.parse(readFileSync(path, 'utf8'));
    if (config?.version !== 1 || !absolute(config.root) || !absolute(config.trace)
      || !Array.isArray(config.steps) || !nonnegative(config.cpuStepUs)) return production;
    const root = realpathSync(config.root);
    const name = basename(fileURLToPath(url));
    if (realpathSync(fileURLToPath(url)) !== join(root, 'global/hooks', name)
      || !existsSync(join(root, 'tests/hook-budget.mjs'))) return production;
    hook = basename(name, '.mjs');
    for (const step of config.steps) {
      if (!step || !programs.has(step.program) || !Array.isArray(step.args) || !step.args.length
        || !step.args.every((arg) => typeof arg === 'string')
        || !nonnegative(step.occurrence) || step.occurrence === 0 || !nonnegative(step.elapsedMs)
        || ('cwd' in step && !absolute(step.cwd))
        || ('realTimeoutMs' in step && (!nonnegative(step.realTimeoutMs)
          || step.realTimeoutMs === 0 || step.elapsedMs !== 0))) return production;
      if ('cwd' in step) step.cwd = realpathSync(step.cwd);
    }
  } catch {
    return production;
  }

  let now = 0;
  let checks = 0;
  let cpuUs = 0;
  const counts = config.steps.map(() => 0);
  const trace = (type, values) => {
    try {
      appendFileSync(config.trace, `${JSON.stringify({ hook, mode: process.argv[2] ?? '', type, ...values })}\n`);
    } catch { /* Observability must not change a verdict. */ }
  };
  const read = (program, args, cwd, timeoutMs) => {
    const matches = [];
    for (const [index, step] of config.steps.entries()) {
      if (step.program !== program || !args.some((_, start) => step.args.every((arg, offset) => args[start + offset] === arg))) continue;
      if (step.cwd !== undefined) {
        try { if (realpathSync(cwd ?? process.cwd()) !== step.cwd) continue; } catch { continue; }
      }
      if (++counts[index] === step.occurrence) matches.push(step);
    }
    const native = matches.filter((step) => step.realTimeoutMs !== undefined);
    const realTimeoutMs = native.length ? Math.max(timeoutMs, ...native.map((step) => step.realTimeoutMs)) : 120000;
    return {
      timeout: realTimeoutMs,
      finish(result) {
        const nativeTimeout = result.error?.code === 'ETIMEDOUT';
        for (const step of matches) {
          const timedOut = nativeTimeout || step.elapsedMs >= timeoutMs;
          const appliedMs = nativeTimeout ? timeoutMs : Math.min(step.elapsedMs, timeoutMs);
          now += appliedMs;
          trace('charge', { program, args, occurrence: step.occurrence, elapsedMs: step.elapsedMs,
            appliedMs, timeoutMs, realTimeoutMs, timedOut, nativeTimeout, nowMs: now });
          if (timedOut && !nativeTimeout) {
            const error = Object.assign(new Error(`spawnSync ${program} ETIMEDOUT`), { code: 'ETIMEDOUT' });
            result = { ...result, error, status: null };
          }
        }
        return result;
      },
    };
  };
  return {
    now: () => now,
    cpuUsage(started, limitUs) {
      if (started === undefined) return { user: 0, system: 0 };
      checks += 1;
      cpuUs += config.cpuStepUs;
      if (cpuUs >= limitUs) trace('cpu-exhausted', { checks, cpuUs, limitUs });
      return { user: cpuUs, system: 0 };
    },
    limits: (values) => trace('limits', { values }),
    read,
    spawnSync(program, args, options) {
      const call = read(program, args, options.cwd, options.timeout);
      return call.finish(spawnSync(program, args, { ...options, timeout: call.timeout }));
    },
  };
}
