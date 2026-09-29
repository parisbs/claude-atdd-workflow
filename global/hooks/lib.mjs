// Shared helpers for the user-level PreToolUse hooks.
//
// The hooks are a safety net for one machine (ADR 0002): the authoritative
// enforcement of a repository is its CI and its rulesets. So every helper fails
// open. When a hook cannot decide, it allows the call and says why on stderr,
// rather than blocking work on a guess.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function readEvent() {
  try {
    const raw = readFileSync(0, 'utf8');
    return raw.trim() === '' ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// Runs git without a shell. Returns trimmed stdout, or undefined on failure.
export function git(cwd, args) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (run.error || run.status !== 0) return undefined;
  return run.stdout.trim();
}

const severity = { allow: 0, ask: 1, deny: 2 };

// Collects findings and prints the most severe one as the hook decision.
export class Verdict {
  constructor() {
    this.decision = 'allow';
    this.reasons = [];
  }

  add(decision, reason) {
    if (severity[decision] > severity[this.decision]) this.decision = decision;
    if (decision !== 'allow') this.reasons.push(reason);
  }

  emit() {
    if (this.decision === 'allow') process.exit(0);
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: this.decision,
          permissionDecisionReason: this.reasons.join(' '),
        },
      }),
    );
    process.exit(0);
  }
}

export function failOpen(hook, error) {
  process.stderr.write(`${hook}: could not evaluate, allowing (${error?.message ?? error})\n`);
  process.exit(0);
}
