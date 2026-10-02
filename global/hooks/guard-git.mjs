#!/usr/bin/env node
// PreToolUse hook for Bash. A machine-level safety net for the rules in the
// global CLAUDE.md that must never break (ADR 0002, ADR 0004):
//
// - no commit on main or master, and no push to them;
// - no --no-verify on commit or push;
// - a force push asks, and is denied when it targets main;
// - `gh pr merge` must squash and must never use --admin, and is decided from what
//   GitHub shows about the pull request: checks, control-plane files, the label
//   needs-human, draft state (ADR 0010). Anything that cannot be read asks;
// - deploys to a linked Supabase project ask first;
// - an ATDD oracle tag cannot be deleted or moved by the agent, and creating one
//   asks: the tag is the human's approval of the oracle (ADR 0003, ADR 0010).
//
// Parsing is deliberately simple: the command is split into segments on
// shell operators, and each segment is read as words. It recognises the common
// forms; an unusual form it cannot read is allowed, because the repository's
// rulesets remain the real guarantee.
import { spawnSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { controlPlaneFiles, humanMergeMatchers } from './controlplane.mjs';
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

// Reads the options of a git subcommand into the flags that were given and the
// positional words, knowing which options consume the next word. Short options
// can be combined (-df, -am "msg"), and an option that takes a value ends the
// cluster: the rest of the cluster is the value, or the next word when nothing
// follows it.
function parseOptions(args, { longWithValue = [], shortWithValue = [], shortOptionalValue = [] }) {
  const flags = new Set();
  const positional = [];
  let onlyPositional = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (onlyPositional || !arg.startsWith('-') || arg === '-') {
      positional.push(arg);
    } else if (arg === '--') {
      onlyPositional = true;
    } else if (arg.startsWith('--')) {
      const [name] = arg.split('=');
      flags.add(name);
      if (longWithValue.includes(name) && !arg.includes('=')) i += 1;
    } else {
      for (let k = 1; k < arg.length; k += 1) {
        flags.add(`-${arg[k]}`);
        if (shortWithValue.includes(arg[k])) {
          if (k === arg.length - 1) i += 1;
          break;
        }
        if (shortOptionalValue.includes(arg[k])) break;
      }
    }
  }
  return { flags, positional };
}

const isOracleTag = (name) => name.startsWith('oracle/');

// What `git tag` is asked to do, and to which tag names. Without a creation,
// deletion, move or verification flag a bare name creates a tag; with a listing
// flag, or with no name at all, the command only reads.
function classifyTag(args) {
  const { flags, positional } = parseOptions(args, {
    longWithValue: ['--message', '--file', '--local-user', '--cleanup', '--format', '--sort', '--contains',
      '--no-contains', '--points-at', '--merged', '--no-merged', '--column'],
    shortWithValue: ['m', 'F', 'u'],
    shortOptionalValue: ['n'],
  });
  const has = (...names) => names.some((name) => flags.has(name));
  if (has('-d', '--delete')) return { mode: 'delete', names: positional };
  if (has('-v', '--verify')) return { mode: 'read', names: positional };
  if (has('-l', '--list', '-n', '--contains', '--no-contains', '--points-at', '--merged', '--no-merged',
    '--sort', '--format', '--column') || positional.length === 0) {
    return { mode: 'read', names: positional };
  }
  return { mode: has('-f', '--force') ? 'move' : 'create', names: positional.slice(0, 1) };
}

function hasFlag(args, ...flags) {
  return args.some((a) => flags.includes(a) || flags.some((f) => f.startsWith('--') && a.startsWith(`${f}=`)));
}

// A chain such as `git checkout -b feature/x && git commit ...` is evaluated
// before any of it runs, so a branch switch earlier in the chain is recorded
// here and used for the commands after it.
function trackSwitch(sub, rest, dir, branches) {
  if (sub !== 'checkout' && sub !== 'switch') return;
  const create = rest.findIndex((a) => ['-b', '-B', '-c', '-C'].includes(a));
  if (create >= 0 && rest[create + 1]) {
    branches.set(dir, rest[create + 1]);
    return;
  }
  if (rest.includes('--')) return; // restoring files, not switching
  const target = rest.find((a) => !a.startsWith('-'));
  if (target && git(dir, ['rev-parse', '--verify', '-q', `refs/heads/${target}`]) !== undefined) {
    branches.set(dir, target);
  }
}

function checkGit(args, cwd, verdict, branches) {
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
  trackSwitch(sub, rest, dir, branches);
  const branch = branches.get(dir) ?? git(dir, ['branch', '--show-current']);
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
    const { mode, names } = classifyTag(rest);
    if (names.some(isOracleTag)) {
      if (mode === 'delete' || mode === 'move') {
        verdict.add('deny', 'ATDD oracle tags are removed or moved by the human, not the agent.');
      } else if (mode === 'create') {
        verdict.add('ask', 'Creating an oracle tag freezes the approved tests: confirm the human approved the oracle.');
      }
    }
  }

  if (sub === 'update-ref') {
    // update-ref writes the same refs as git tag, so it gets the same rules.
    const { flags, positional } = parseOptions(rest, { shortWithValue: ['m'] });
    const ref = positional[0];
    if (ref?.startsWith('refs/tags/') && isOracleTag(ref.slice('refs/tags/'.length))) {
      const exists = git(dir, ['rev-parse', '--verify', '-q', ref]) !== undefined;
      if (flags.has('-d') || exists) {
        verdict.add('deny', 'ATDD oracle tags are removed or moved by the human, not the agent.');
      } else {
        verdict.add('ask', 'Creating an oracle tag freezes the approved tests: confirm the human approved the oracle.');
      }
    }
  }
}

const PLAIN_MERGE = /^gh pr merge(?: [A-Za-z0-9@%+=:,./_#-]+)*$/;
const PR_FIELDS = 'baseRefName,changedFiles,files,isDraft,labels,statusCheckRollup,url';
const PASSED_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const ghLimit = () => Number(process.env.GUARD_GIT_GH_TIMEOUT_MS) || 6000;
const brief = (text) => (text ?? '').trim().split('\n')[0].slice(0, 200);

// Runs gh without a shell and says why when it could not give an answer.
function gh(args, cwd) {
  const run = spawnSync('gh', args, { cwd, encoding: 'utf8', timeout: ghLimit() });
  if (run.error?.code === 'ENOENT') return { failure: 'gh is not installed or not on PATH' };
  if (run.error?.code === 'ETIMEDOUT') return { failure: `gh timed out after ${ghLimit()} ms` };
  if (run.error) return { failure: `gh could not run (${run.error.message})` };
  if (run.status !== 0) return { failure: brief(run.stderr) || `gh exited with ${run.status}`, stderr: run.stderr ?? '' };
  return { stdout: run.stdout };
}

function optionValue(args, names) {
  const at = args.findIndex((a) => names.includes(a));
  if (at >= 0) return args[at + 1];
  const joined = args.find((a) => names.some((n) => n.startsWith('--') && a.startsWith(`${n}=`)));
  return joined?.slice(joined.indexOf('=') + 1);
}

function checkIssue(check) {
  const name = check.name ?? check.context ?? 'unnamed check';
  if (check.__typename === 'StatusContext') return check.state === 'SUCCESS' ? undefined : `${name} (${check.state})`;
  if (check.status === 'COMPLETED' && PASSED_CONCLUSIONS.has(check.conclusion)) return undefined;
  return `${name} (${check.conclusion || check.status})`;
}

// What the hook may say about a merge: reasons to ask, or none when every
// condition of ADR 0010 holds. Never throws: a merge cannot be undone.
function mergeReasons(args, cwd) {
  const rest = args.slice(2);
  const { positional } = parseOptions(rest, {
    shortWithValue: ['R', 't', 'b', 'F', 'A'],
    longWithValue: ['--repo', '--subject', '--body', '--body-file', '--author-email', '--match-head-commit'],
  });
  const repoFlag = optionValue(rest, ['-R', '--repo']);
  const view = gh(['pr', 'view', ...(positional[0] ? [positional[0]] : []), ...(repoFlag ? ['-R', repoFlag] : []), '--json', PR_FIELDS], cwd);
  if (view.failure) return [`Could not read the pull request: ${view.failure}.`];

  let pr;
  try {
    pr = JSON.parse(view.stdout);
  } catch {
    return ['Could not read the pull request: gh did not return JSON.'];
  }
  const complete = pr && typeof pr.baseRefName === 'string' && typeof pr.url === 'string' && typeof pr.isDraft === 'boolean'
    && typeof pr.changedFiles === 'number' && Array.isArray(pr.files) && Array.isArray(pr.labels) && Array.isArray(pr.statusCheckRollup);
  if (!complete) return ['Could not read the pull request: gh returned incomplete data.'];

  const reasons = [];
  if (pr.isDraft) reasons.push('The pull request is a draft.');
  if (pr.labels.some((label) => String(label.name).toLowerCase() === 'needs-human')) {
    reasons.push('The pull request carries needs-human.');
  }
  if (pr.statusCheckRollup.length === 0) reasons.push('The pull request has no checks.');
  const notPassed = pr.statusCheckRollup.map(checkIssue).filter(Boolean);
  if (notPassed.length > 0) reasons.push(`Checks that have not passed: ${notPassed.join(', ')}.`);

  const paths = pr.files.map((file) => file.path);
  if (paths.length < pr.changedFiles) {
    reasons.push(`GitHub lists only ${paths.length} of ${pr.changedFiles} changed files, so the control plane cannot be checked.`);
  }

  // The list a pull request is judged by comes from its base branch, never from its own copy.
  let extra = [];
  const where = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(pr.url);
  if (!where) {
    reasons.push('Could not read CLAUDE.md of the base branch: the pull request URL has an unexpected shape.');
  } else {
    const [, host, owner, name] = where;
    const file = gh([
      'api', ...(host === 'github.com' ? [] : ['--hostname', host]),
      '-H', 'Accept: application/vnd.github.raw+json',
      `repos/${owner}/${name}/contents/CLAUDE.md?ref=${encodeURIComponent(pr.baseRefName)}`,
    ], cwd);
    if (file.stdout !== undefined) extra = humanMergeMatchers(file.stdout);
    else if (!/HTTP 404/.test(file.stderr ?? '')) reasons.push(`Could not read CLAUDE.md of the base branch: ${file.failure}.`);
  }
  const sensitive = controlPlaneFiles(paths, extra);
  if (sensitive.length > 0) reasons.push(`Control-plane files changed: ${sensitive.join(', ')}.`);
  return reasons;
}

// Returns true when a merge was verified end to end.
function checkGh(args, verdict, cwd) {
  if (args[0] !== 'pr' || args[1] !== 'merge') return false;
  if (hasFlag(args, '--admin')) {
    verdict.add('deny', 'Never merge with --admin: it bypasses every rule of the ruleset, required checks included.');
  }
  if (!hasFlag(args, '--squash', '-s')) {
    verdict.add('deny', 'Merge with --squash: main keeps a linear history.');
  }
  if (verdict.decision === 'deny') return false;
  let reasons;
  try {
    reasons = mergeReasons(args, cwd);
  } catch (error) {
    reasons = [`Could not decide this merge (${error.message}).`];
  }
  if (reasons.length === 0) return true;
  verdict.add('ask', `${reasons.join(' ')} The human decides this merge (ADR 0010).`);
  return false;
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
  const branches = new Map();
  const parts = segments(command);
  let merged = false;
  for (const segment of parts) {
    const w = words(segment);
    // Skip leading environment assignments such as FOO=1 git push.
    while (w.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w.shift();
    if (w[0] === 'cd' && w[1]) {
      cwd = isAbsolute(w[1]) ? w[1] : resolve(cwd, w[1].replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
    } else if (w[0] === 'git') {
      checkGit(w.slice(1), cwd, verdict, branches);
    } else if (w[0] === 'gh') {
      merged = checkGh(w.slice(1), verdict, cwd) || merged;
    } else if (w[0] === 'supabase' || (w[0] === 'npx' && w[1] === 'supabase')) {
      checkSupabase(w.slice(w[0] === 'npx' ? 2 : 1), verdict);
    }
  }
  // An explicit allow lifts the prompt for the whole command, so it is only given to a
  // command that is nothing but one plain merge, with no quotes, chains or redirections.
  if (merged && parts.length === 1 && PLAIN_MERGE.test(command.trim())) {
    verdict.allowExplicitly('Checks passed, no control-plane files, no needs-human label (ADR 0010).');
  }
  verdict.emit();
} catch (error) {
  failOpen('guard-git', error);
}
