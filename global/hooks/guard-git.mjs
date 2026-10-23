#!/usr/bin/env node
// PreToolUse hook for Bash. A machine-level safety net for the rules in the
// global CLAUDE.md that must never break (ADR 0002, ADR 0004):
//
// - no commit on main, master or the branch origin/HEAD names, and no push to them;
// - no --no-verify on commit or push;
// - a force push asks, and is denied when it targets one of those branches;
// - `gh pr merge` must squash and must never use --admin, and is decided from what
//   GitHub shows about the pull request: checks, control-plane files, the label
//   needs-human, draft state (ADR 0010), and that the authenticated gh user opened
//   it from a branch in the base repository (ADR 0024). Local commits missing from
//   its pushed head and uncommitted changes in its branch's worktrees ask too.
//   Anything that cannot be read asks;
// - deploys to a linked Supabase project ask first;
// - an ATDD oracle tag cannot be deleted or moved by the agent, and creating one
//   asks: the tag is the human's approval of the oracle (ADR 0003, ADR 0010);
// - a subagent never acts on GitHub: for an event with agent_id, git push and every
//   gh command off a read-only list are denied, also inside bash -c or eval (ADR 0013).
//
// Parsing is deliberately simple: the command is split into segments on
// shell operators, and each segment is read as words. It recognises the common
// forms; an unusual form it cannot read is allowed, because the repository's
// rulesets remain the real guarantee.
//
// global/settings.json runs it from two entries. With --skip-merge it
// runs for every Bash command and fails open like the other hooks; of the merge
// decision it keeps only the denials that need no network. With --merge-only it
// decides merges and nothing else, and asks when it cannot decide. Claude Code runs
// its entry when the `if` matches gh pr merge or cannot rule a command out. The entry
// uses shell builtins to look for literal merge, including a whole-quoted word,
// between the command and following description keys in compact events of at most
// 16,000 characters. Larger events or an unrecognized shape use the whole event.
// Only a match starts Node. With onFailure "block", a hook failure or timeout blocks
// a merge and, at worst, a non-merge with merge in that scope. Without a flag the
// hook applies every rule.
import { spawnSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { controlPlaneFiles, humanMergeMatchers } from './controlplane.mjs';
import { Verdict, failOpen, git, readEvent } from './lib.mjs';
import { ghIsRead, gitSubcommand, program } from './commands.mjs';

const mode = process.argv[2];
const mergeOnly = mode === '--merge-only';
const skipMerge = mode === '--skip-merge';

// main and master, and the branch origin/HEAD names: a repository may make develop
// or trunk its default. Read once for each repository a command reaches.
const defaultBranches = new Map();
function protectedBranches(dir) {
  if (!defaultBranches.has(dir)) {
    const head = git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    defaultBranches.set(dir, new Set(['main', 'master', ...(head ? [head.replace(/^origin\//, '')] : [])]));
  }
  return defaultBranches.get(dir);
}

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
    if (protectedBranches(dir).has(branch) && hasCommits) {
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

    const guarded = protectedBranches(dir);
    for (const target of targets) {
      if (guarded.has(target)) {
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
    if (force && !targets.some((t) => guarded.has(t))) {
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
const PR_FIELDS = 'author,baseRefName,changedFiles,files,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,isDraft,labels,statusCheckRollup,url';
const PASSED_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const ghLimit = () => Number(process.env.GUARD_GIT_GH_TIMEOUT_MS) || 6000;
// All gh calls of one hook run share this budget, counted from the start of the
// process. A merge decision makes up to three serial calls, and global/settings.json
// blocks the merge when the hook runs past 30 s; 10 s leaves the rest for Node to
// start, for git, for a timed-out gh to exit after its signal, and for the hook to
// print its ask, so a slow GitHub ends in a question rather than in a block.
const ghBudget = () => Number(process.env.GUARD_GIT_GH_BUDGET_MS) || 10000;
const brief = (text) => (text ?? '').trim().split('\n')[0].slice(0, 200);

// Runs gh without a shell and says why when it could not give an answer. A call
// never runs past what is left of the shared budget.
function gh(args, cwd) {
  const left = Math.floor(ghBudget() - performance.now());
  const outOfBudget = { failure: `gh ran out of the time budget of ${ghBudget()} ms for this hook` };
  // A timeout of 0 would mean no timeout at all, so a spent budget skips the call.
  if (left < 1) return outOfBudget;
  const limit = Math.min(ghLimit(), left);
  const run = spawnSync('gh', args, { cwd, encoding: 'utf8', timeout: limit });
  if (run.error?.code === 'ENOENT') return { failure: 'gh is not installed or not on PATH' };
  if (run.error?.code === 'ETIMEDOUT') return limit < ghLimit() ? outOfBudget : { failure: `gh timed out after ${limit} ms` };
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

// Who opened the pull request and where its head branch lives (ADR 0024). Only the
// authenticated gh user is a trusted author, bots included in the rest; the user is
// read on the pull request's own host, so GH_HOST cannot point the lookup elsewhere.
// A head branch in another repository asks even when the user opened it.
function provenanceReasons(pr, host, cwd) {
  const reasons = [];
  if (typeof pr.isCrossRepository !== 'boolean') {
    reasons.push('Could not read where the head branch lives: gh returned no isCrossRepository.');
  } else if (pr.isCrossRepository) {
    // A deleted fork has no headRepository but keeps its owner.
    const owner = pr.headRepositoryOwner?.login;
    const name = pr.headRepository?.name;
    const head = owner ? (name ? `${owner}/${name}` : owner) : 'an unnamed repository';
    reasons.push(`The head branch lives in a fork, ${head}, not in the base repository.`);
  }

  const author = pr.author?.login;
  if (typeof author !== 'string' || author === '') {
    reasons.push('Could not read who opened the pull request: gh returned no author.');
    return reasons;
  }
  if (!host) {
    reasons.push('Could not read the authenticated gh user: the pull request URL has an unexpected shape.');
    return reasons;
  }
  const lookup = gh(['api', '--hostname', host, 'user'], cwd);
  let user;
  try {
    user = lookup.failure ? undefined : JSON.parse(lookup.stdout)?.login;
  } catch {
    user = undefined;
  }
  if (typeof user !== 'string' || user === '') {
    reasons.push(`Could not read the authenticated gh user on ${host}: ${lookup.failure ?? 'gh returned no login'}.`);
  } else if (user !== author) {
    reasons.push(`The pull request was opened by ${author}, not by the authenticated gh user ${user} on ${host}.`);
  }
  return reasons;
}

// Normalizes HTTPS, scp and SSH remote URLs so another repository's local work
// cannot affect this pull request, even when its branch has the same name.
function remoteRepository(remote) {
  try {
    const url = new URL(remote.replace(/^git@([^:]+):/, 'ssh://git@$1/'));
    const path = url.pathname.replace(/\/$/, '').replace(/\.git$/, '');
    if (!['https:', 'http:', 'ssh:'].includes(url.protocol) || !/^\/[^/]+\/[^/]+$/.test(path)) return undefined;
    return `${url.hostname}${path}`.toLowerCase();
  } catch {
    return undefined;
  }
}

// Reads local git without trimming paths or taking optional locks. All reads
// share five seconds so a broken local copy still leaves time to print an ask.
function localGit(cwd, args, deadline) {
  const left = Math.floor(deadline - performance.now());
  if (left < 1) throw new Error(`Could not read the local copy in ${cwd}: git exhausted its time budget.`);
  const run = spawnSync('git', ['--no-optional-locks', ...args], {
    cwd, encoding: 'utf8', timeout: left, killSignal: 'SIGKILL',
  });
  if (run.error || run.status !== 0) {
    throw new Error(`Could not read the local copy in ${cwd}: git ${args[0]} failed (${brief(run.stderr) || run.error?.message || run.status}).`);
  }
  return run.stdout;
}

// Reads porcelain's NUL records so spaces, newlines and rename paths survive.
// Untracked files count; git status excludes ignored files by default.
function changedPaths(status) {
  const records = status.split('\0');
  const paths = [];
  for (let i = 0; i < records.length; i += 1) {
    if (!records[i]) continue;
    paths.push(records[i].slice(3));
    if (/[RC]/.test(records[i].slice(0, 2))) paths.push(records[++i]);
  }
  return paths;
}

// Only a clone with a matching remote can hold this pull request's local work.
// Check named and upstream-tracking branches without fetching; local failures
// add reasons to ask and never grant permission for a merge.
function localWorkReasons(pr, where, cwd) {
  if (!where) return [];
  const deadline = performance.now() + 5000;
  try {
    let remotes;
    try {
      remotes = localGit(cwd, ['remote', '-v'], deadline);
    } catch (error) {
      if (/not a git repository/i.test(error.message)) return [];
      throw error;
    }
    const repository = where.slice(1).join('/').toLowerCase();
    const matching = new Set(remotes.trim().split('\n').flatMap((line) => {
      const [name, url] = line.split(/\s+/);
      return url && remoteRepository(url) === repository ? [name] : [];
    }));
    if (matching.size === 0) return [];
    if (typeof pr.headRefName !== 'string' || !pr.headRefName) {
      return ['Could not read the local branch: gh returned no headRefName.'];
    }
    const refs = localGit(cwd, [
      'for-each-ref', '--format=%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)', 'refs/heads/',
    ], deadline);
    const branches = refs.trim().split('\n').flatMap((line) => {
      const [ref, remote, upstream] = line.split('\0');
      return ref === `refs/heads/${pr.headRefName}`
        || (matching.has(remote) && upstream === `refs/heads/${pr.headRefName}`) ? [ref] : [];
    });
    if (branches.length === 0) return [];
    if (typeof pr.headRefOid !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(pr.headRefOid)) {
      return ['Could not read the pushed head: gh returned no valid headRefOid.'];
    }
    localGit(cwd, ['cat-file', '-e', `${pr.headRefOid}^{commit}`], deadline);
    const missing = localGit(cwd, ['log', '--format=%h %s', ...branches, '--not', pr.headRefOid, '--'], deadline).trim();
    const reasons = [];
    if (missing) reasons.push(`Local commits missing from the pushed head ${pr.headRefOid}: ${missing.split('\n').join('; ')}.`);
    const worktrees = localGit(cwd, ['worktree', 'list', '--porcelain', '-z'], deadline);
    for (const record of worktrees.split('\0\0')) {
      const fields = record.split('\0');
      if (!fields.some((field) => field.startsWith('branch ') && branches.includes(field.slice(7)))) continue;
      const path = fields.find((field) => field.startsWith('worktree '))?.slice(9);
      if (!path) throw new Error('Could not read the path of a local branch worktree.');
      const paths = changedPaths(localGit(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], deadline));
      if (paths.length > 0) reasons.push(`Uncommitted changes in worktree ${path}: ${paths.join(', ')}.`);
    }
    return reasons;
  } catch (error) {
    return [error.message];
  }
}

// What the hook may say about a merge: reasons to ask, or none when every
// condition of ADR 0010 and ADR 0024 holds. Never throws: a merge cannot be undone.
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

  const where = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(pr.url);
  reasons.push(...provenanceReasons(pr, where?.[1], cwd));
  reasons.push(...localWorkReasons(pr, where, cwd));

  // The list a pull request is judged by comes from its base branch, never from its own copy.
  let extra = [];
  if (!where) {
    reasons.push('Could not read CLAUDE.md of the base branch: the pull request URL has an unexpected shape.');
  } else {
    const [, host, owner, name] = where;
    // An explicit host, github.com included: without it gh follows GH_HOST, and a 404
    // from another host would read as no CLAUDE.md and drop its Human merge: paths.
    const file = gh([
      'api', '--hostname', host,
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

const couldNotDecide = (error) => `Could not decide this merge (${error?.message ?? error}).`;

function askHuman(verdict, reasons) {
  verdict.add('ask', `${reasons.join(' ')} The human decides this merge (ADR 0010).`);
}

// Returns true when a merge was verified end to end. Without readPullRequest only the
// denials that need no network apply, and nothing is verified.
function checkGh(args, verdict, cwd, readPullRequest) {
  if (args[0] !== 'pr' || args[1] !== 'merge') return false;
  if (hasFlag(args, '--admin')) {
    verdict.add('deny', 'Never merge with --admin: it bypasses every rule of the ruleset, required checks included.');
  }
  if (!hasFlag(args, '--squash', '-s')) {
    verdict.add('deny', 'Merge with --squash: main keeps a linear history.');
  }
  if (verdict.decision === 'deny' || !readPullRequest) return false;
  let reasons;
  try {
    reasons = mergeReasons(args, cwd);
  } catch (error) {
    reasons = [couldNotDecide(error)];
  }
  if (reasons.length === 0) return true;
  askHuman(verdict, reasons);
  return false;
}

function checkSupabase(args, verdict) {
  const line = args.join(' ');
  const remote = /^(db push|link|functions deploy|secrets set|secrets unset|db reset --linked|migration repair)\b/;
  if (remote.test(line) || (args[0] === 'db' && hasFlag(args, '--linked', '--db-url'))) {
    verdict.add('ask', 'This acts on a remote Supabase project. Deploys normally go through the pull request and CI.');
  }
}

// Subagents never act on GitHub (ADR 0010). A subagent file cannot say so: a Bash(...) entry in
// disallowedTools removes the whole shell from it. So this hook enforces it for any event that
// carries agent_id, which only a subagent's tool call has (ADR 0013). A gh command is denied unless
// it is on the read-only list in commands.mjs; a new gh command stays denied until it is added there.
function checkSubagent(w, verdict) {
  const name = program(w[0]);
  if (name === 'git' && gitSubcommand(w.slice(1)) === 'push') {
    verdict.add('deny', 'A subagent never pushes: it commits on the work branch and the orchestrator pushes (ADR 0010, 0013).');
  } else if (name === 'gh' && !ghIsRead(w.slice(1))) {
    verdict.add('deny', `A subagent never acts on GitHub, and \`${['gh', ...w.slice(1, 3)].join(' ')}\` is not on its read-only list: return a report and let the orchestrator do it (ADR 0010, 0013).`);
  }
}

// bash -c, sh -c, zsh -c and eval run a string this hook would otherwise read as one word.
// The string is taken from the whole command, because segments() splits inside quotes.
const WRAPPER = /(?:^|[\s;&|(`])(?:\S*\/)?(?:(?:ba|z|k|da)?sh(?:\s+-{1,2}[A-Za-z-]+)*?\s+-[A-Za-z]*c[A-Za-z]*|eval)\s+("[^"]*"|'[^']*'|[^;&|\n]+)/g;

function wrapped(command) {
  return [...command.matchAll(WRAPPER)].map((m) => m[1].replace(/^(["'])([\s\S]*)\1$/, '$2'));
}

function actsOnGitHub(command) {
  const direct = segments(command).some((segment) => {
    const w = words(segment);
    while (w.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w.shift();
    return program(w[0]) === 'gh' || (program(w[0]) === 'git' && gitSubcommand(w.slice(1)) === 'push');
  });
  return direct || wrapped(command).some(actsOnGitHub);
}

// A wrapper that runs gh or git push is denied even for a read: what it runs is harder to read
// than a plain command, and a subagent has no need to hide one.
function checkWrappers(command, verdict) {
  if (wrapped(command).some(actsOnGitHub)) {
    verdict.add('deny', 'A subagent must not run gh or git push inside a shell wrapper (bash -c, sh -c, zsh -c, eval); run a plain read instead (ADR 0013).');
  }
}

const isMerge = (w) => program(w[0]) === 'gh' && w[1] === 'pr' && w[2] === 'merge';

try {
  const event = readEvent();
  const command = event?.tool_input?.command;
  if (typeof command !== 'string') {
    if (mergeOnly) throw new Error('the event carries no Bash command');
    process.exit(0);
  }

  // Only a subagent's call carries agent_id; the main session's carries none.
  const subagent = typeof event.agent_id === 'string' && event.agent_id !== '';
  const verdict = new Verdict();
  if (subagent && !mergeOnly) checkWrappers(command, verdict);
  let cwd = event.cwd ?? process.cwd();
  const branches = new Map();
  const parts = segments(command);
  let merged = false;
  for (const segment of parts) {
    const w = words(segment);
    // Skip leading environment assignments such as FOO=1 git push.
    while (w.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w.shift();
    if (subagent && (!mergeOnly || isMerge(w))) checkSubagent(w, verdict);
    if (w[0] === 'cd' && w[1]) {
      cwd = isAbsolute(w[1]) ? w[1] : resolve(cwd, w[1].replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
    } else if (w[0] === 'git' && !mergeOnly) {
      checkGit(w.slice(1), cwd, verdict, branches);
    } else if (w[0] === 'gh' && !subagent) {
      // A subagent's gh is decided by the read-only list alone, so it never reaches the
      // merge decision and never earns its explicit allow.
      merged = checkGh(w.slice(1), verdict, cwd, !skipMerge) || merged;
    } else if (!mergeOnly && (w[0] === 'supabase' || (w[0] === 'npx' && w[1] === 'supabase'))) {
      checkSupabase(w.slice(w[0] === 'npx' ? 2 : 1), verdict);
    }
  }
  // An explicit allow lifts the prompt for the whole command, so it is only given to a
  // command that is nothing but one plain merge, with no quotes, chains or redirections.
  if (merged && !subagent && parts.length === 1 && PLAIN_MERGE.test(command.trim())) {
    verdict.allowExplicitly('Checks passed, no control-plane files, no needs-human label, opened by the authenticated gh user from a branch in the base repository (ADR 0010, ADR 0024).');
  }
  verdict.emit();
} catch (error) {
  if (mergeOnly) {
    // A merge cannot be undone, so the merge entry asks rather than letting the call through.
    const verdict = new Verdict();
    askHuman(verdict, [couldNotDecide(error)]);
    verdict.emit();
  }
  failOpen('guard-git', error);
}
