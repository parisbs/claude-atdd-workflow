#!/usr/bin/env node
// PreToolUse hook for Bash. A machine-level safety net for the rules in the
// global CLAUDE.md that must never break (ADR 0002, ADR 0004):
//
// - no commit on main or master, and no push to them;
// - no --no-verify on commit or push;
// - a force push asks, and is denied when it targets main;
// - `gh pr merge` must squash and must never use --admin;
// - deploys to a linked Supabase project ask first;
// - an ATDD oracle tag cannot be deleted or moved by the agent.
//
// Parsing is deliberately simple: the command is split into segments on
// shell operators, and each segment is read as words. It recognises the common
// forms; an unusual form it cannot read is allowed, because the repository's
// rulesets remain the real guarantee.
import { isAbsolute, resolve } from 'node:path';
import { Verdict, failOpen, git, readEvent } from './lib.mjs';

const PROTECTED = new Set(['main', 'master']);

function words(segment) {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, ''));
}

// Splits on &&, ||, ;, | and newlines. Quoted operators are rare in the
// commands this hook cares about, and a split inside quotes only produces
// extra segments that match nothing.
function segments(command) {
  return command.split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
}

function hasFlag(args, ...flags) {
  return args.some((a) => flags.includes(a) || flags.some((f) => f.startsWith('--') && a.startsWith(`${f}=`)));
}

function checkGit(args, cwd, verdict) {
  // git [-C dir] <subcommand> ...
  let dir = cwd;
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '-C' && args[i + 1]) {
      dir = isAbsolute(args[i + 1]) ? args[i + 1] : resolve(dir, args[i + 1]);
      i += 2;
    } else {
      i += 1;
    }
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  const branch = git(dir, ['branch', '--show-current']);
  const hasCommits = git(dir, ['rev-parse', '--verify', '-q', 'HEAD']) !== undefined;

  if (sub === 'commit') {
    if (hasFlag(rest, '--no-verify', '-n')) {
      verdict.add('deny', 'Commits must not skip hooks with --no-verify.');
    }
    if (PROTECTED.has(branch) && hasCommits) {
      verdict.add('deny', `Do not commit on ${branch}: create a branch from an updated ${branch} first.`);
    }
  }

  if (sub === 'push') {
    if (hasFlag(rest, '--no-verify')) {
      verdict.add('deny', 'Pushes must not skip hooks with --no-verify.');
    }
    const positional = rest.filter((a) => !a.startsWith('-'));
    const refspecs = positional.slice(1);
    const targets = refspecs.length > 0
      ? refspecs.map((r) => r.replace(/^\+/, '').split(':').pop().replace(/^refs\/heads\//, ''))
      : [branch];
    const force = hasFlag(rest, '--force', '-f', '--force-with-lease', '--force-if-includes')
      || refspecs.some((r) => r.startsWith('+'));
    const deletes = hasFlag(rest, '--delete', '-d') || refspecs.some((r) => r.startsWith(':'));

    for (const target of targets) {
      if (PROTECTED.has(target)) {
        const remote = positional[0] ?? 'origin';
        const published = git(dir, ['rev-parse', '--verify', '-q', `refs/remotes/${remote}/${target}`]) !== undefined;
        if (force || deletes) {
          verdict.add('deny', `Never force-push or delete ${target}.`);
        } else if (published) {
          verdict.add('deny', `Do not push to ${target}: open a pull request and squash-merge it.`);
        } else {
          verdict.add('ask', `This publishes ${target} for the first time on ${remote}.`);
        }
      }
    }
    if (force && !targets.some((t) => PROTECTED.has(t))) {
      verdict.add('ask', 'Force push: confirm that rewriting the remote branch is intended.');
    }
    if (deletes || refspecs.some((r) => r.includes('refs/tags/'))) {
      verdict.add('ask', 'This deletes or rewrites remote refs.');
    }
  }

  if (sub === 'tag') {
    const oracle = rest.some((a) => a.startsWith('oracle/'));
    if (oracle && hasFlag(rest, '-d', '--delete', '-f', '--force')) {
      verdict.add('deny', 'ATDD oracle tags are removed or moved by the human, not the agent.');
    }
  }
}

function checkGh(args, verdict) {
  if (args[0] === 'pr' && args[1] === 'merge') {
    if (hasFlag(args, '--admin')) {
      verdict.add('deny', 'Never merge with --admin: it bypasses every rule of the ruleset, required checks included.');
    }
    if (!hasFlag(args, '--squash', '-s')) {
      verdict.add('deny', 'Merge with --squash: main keeps a linear history.');
    }
  }
}

function checkSupabase(args, verdict) {
  const line = args.join(' ');
  const remote = /^(db push|link|functions deploy|secrets set|secrets unset|db reset --linked|migration repair)\b/;
  if (remote.test(line) || (args[0] === 'db' && hasFlag(args, '--linked', '--db-url'))) {
    verdict.add('ask', 'This acts on a remote Supabase project. Deploys normally go through the pull request and CI.');
  }
}

try {
  const event = readEvent();
  const command = event?.tool_input?.command;
  if (typeof command !== 'string') process.exit(0);

  const verdict = new Verdict();
  let cwd = event.cwd ?? process.cwd();
  for (const segment of segments(command)) {
    const w = words(segment);
    // Skip leading environment assignments such as FOO=1 git push.
    while (w.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w.shift();
    if (w[0] === 'cd' && w[1]) {
      cwd = isAbsolute(w[1]) ? w[1] : resolve(cwd, w[1].replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
    } else if (w[0] === 'git') {
      checkGit(w.slice(1), cwd, verdict);
    } else if (w[0] === 'gh') {
      checkGh(w.slice(1), verdict);
    } else if (w[0] === 'supabase' || (w[0] === 'npx' && w[1] === 'supabase')) {
      checkSupabase(w.slice(w[0] === 'npx' ? 2 : 1), verdict);
    }
  }
  verdict.emit();
} catch (error) {
  failOpen('guard-git', error);
}
