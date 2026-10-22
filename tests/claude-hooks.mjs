// Runs the PreToolUse entries of global/settings.json for one tool call the way Claude Code runs them
// (issue #27), so the hook tests check the configuration that is installed and not only the scripts.
//
// Every entry whose matcher and `if` apply runs its command through /bin/sh, with its timeout, and with
// HOME pointing at a directory whose .claude/hooks is the hooks directory under test. As the hooks
// reference documents: exit 2 blocks the call with stderr as the reason; a run that cannot start, exits
// with another code, runs past its timeout or prints output that is not JSON has failed, and the call
// goes on unless the entry declares onFailure "block"; decisions combine as deny > ask > allow, and a
// hook that prints nothing gives none.
//
// Two simplifications. An entry without a matcher is skipped: only guard-codex ships without one, and
// the installer derives it. And `if` is approximated: Bash(<words> *) runs the hook when the command
// holds those words in that order, which reaches every form Claude Code matched in
// docs/experiments/2026-10-21-hook-if-and-onfailure-probes.md, and more. It also runs it, as Claude Code
// does for a pattern that names more than the command, whenever the command holds a form `if` cannot
// rule out: $(), backticks, ${...}, a for, while or until loop in any spelling, a function definition with
// or without the function keyword, a variable in command position, or test or [ with a variable (issue #31,
// docs/experiments/2026-10-21-hook-if-and-onfailure-probes.md, section 2).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
export const HOOKS = join(repo, 'global', 'hooks');
export const SETTINGS = JSON.parse(readFileSync(join(repo, 'global', 'settings.json'), 'utf8'));
const severity = { allow: 0, ask: 1, deny: 2 };

const scratch = mkdtempSync(join(tmpdir(), 'cw-claude-hooks-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));

// node alone, so that a test can take gh off PATH without taking node with it.
const nodeBin = join(scratch, 'node-bin');
mkdirSync(nodeBin);
symlinkSync(process.execPath, join(nodeBin, 'node'));

const homes = new Map();
function homeFor(hooksDir) {
  if (!homes.has(hooksDir)) {
    const home = mkdtempSync(join(scratch, 'home-'));
    mkdirSync(join(home, '.claude'));
    symlinkSync(hooksDir, join(home, '.claude', 'hooks'));
    homes.set(hooksDir, home);
  }
  return homes.get(hooksDir);
}

// The hook handlers of the PreToolUse entries whose matcher names the tool.
export function handlersFor(toolName, settings = SETTINGS) {
  return (settings.hooks?.PreToolUse ?? [])
    .filter((entry) => entry.matcher !== undefined && new RegExp(`^(?:${entry.matcher})$`).test(toolName))
    .flatMap((entry) => entry.hooks ?? []);
}

// The forms after which Claude Code runs a hook whose `if` names more than the command, matched or not.
const UNREADABLE = new RegExp([
  /\$\(|`|\$\{/.source,
  /(?:^|[\s;&|(])(?:for|while|until)\b[\s\S]*\bdo\b/.source,
  /\w+\s*\(\s*\)\s*\{|\bfunction\s+\w+/.source,
  /(?:^|[;&|(\n])\s*\$\w/.source,
  /(?:^|[;&|(\n])\s*(?:test|\[\[?)\s[^;&|\n]*\$/.source,
].join('|'));

export function ifApplies(rule, toolName, input) {
  if (rule === undefined) return true;
  const match = /^Bash\((.*?)(?: \*)?\)$/.exec(rule);
  if (!match) throw new Error(`claude-hooks: unsupported if rule ${rule}`);
  if (toolName !== 'Bash') return false;
  if (match[1].includes(' ') && UNREADABLE.test(input.command ?? '')) return true;
  const words = match[1].split(' ').map((word) => `\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  return new RegExp(words.join('[\\s\\S]*')).test(input.command ?? '');
}

function runHandler(handler, event, { env, hooksDir, timeoutMs, path }) {
  const limit = timeoutMs ?? handler.timeout * 1000;
  const run = spawnSync('/bin/sh', ['-c', handler.command], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    timeout: limit,
    env: {
      ...process.env,
      ...env,
      HOME: homeFor(hooksDir),
      PATH: path ?? `${nodeBin}${delimiter}${env.PATH ?? process.env.PATH}`,
    },
  });
  const stderr = run.stderr ?? '';
  let failure;
  if (run.error?.code === 'ETIMEDOUT') failure = `timed out after ${limit} ms`;
  else if (run.error) failure = `could not run (${run.error.message})`;
  else if (run.status === 2) return { decision: 'deny', reason: stderr.trim(), stderr };
  else if (run.status !== 0) failure = `exited with ${run.status}`;
  else if (run.stdout.trim() === '') return { stderr };
  else {
    try {
      const out = JSON.parse(run.stdout).hookSpecificOutput ?? {};
      return out.permissionDecision ? { decision: out.permissionDecision, reason: out.permissionDecisionReason, stderr } : { stderr };
    } catch {
      failure = 'printed output that is not JSON';
    }
  }
  if (handler.onFailure === 'block') {
    return { decision: 'deny', reason: `${handler.command}: ${failure}; blocking because onFailure is "block". ${stderr.trim()}`, stderr, failure };
  }
  return { stderr, failure };
}

// The outcome of one tool call. `failures` lists the runs that failed without blocking, which Claude Code
// shows as non-blocking hook errors; `ran` lists the commands of the handlers that ran.
export function runConfigured(event, { env = {}, hooksDir = HOOKS, timeoutMs, path, settings } = {}) {
  const runs = handlersFor(event.tool_name, settings)
    .filter((handler) => ifApplies(handler.if, event.tool_name, event.tool_input ?? {}))
    .map((handler) => ({ handler, ...runHandler(handler, event, { env, hooksDir, timeoutMs, path }) }));
  const decided = runs.filter((r) => r.decision);
  const decision = decided.reduce((top, r) => (severity[r.decision] > severity[top] ? r.decision : top), 'allow');
  return {
    decision,
    reason: decided.filter((r) => r.decision === decision).map((r) => r.reason).join(' '),
    explicit: decided.length > 0,
    stderr: runs.map((r) => r.stderr).join(''),
    failures: runs.filter((r) => r.failure && !r.decision).map((r) => `${r.handler.command}: ${r.failure}`),
    ran: runs.map((r) => r.handler.command),
  };
}
