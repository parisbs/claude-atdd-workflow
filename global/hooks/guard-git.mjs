#!/usr/bin/env node
// PreToolUse hook for Bash. A machine-level safety net for the rules in the
// global CLAUDE.md that must never break (ADR 0002, ADR 0004):
//
// - no commit on main, master or the branch origin/HEAD names, and no push to them;
// - no skipped hooks on commit, push, merge, rebase or am;
// - a force push asks, and is denied when it targets one of those branches;
// - `gh pr merge` must squash and must never use --admin, and is decided from what
//   GitHub shows about the pull request: checks, control-plane files, the label
//   needs-human, draft state (ADR 0010), and that the authenticated gh user opened
//   it from a branch in the base repository (ADR 0024). Local commits missing from
//   its pushed head and uncommitted changes in its branch's worktrees ask too.
//   The merge guard compares the head with oracle/<head branch> on the base
//   repository's remote: changed tests, atdd without a tag, or an unreadable
//   oracle ask, and deny in bypassPermissions (ADR 0030). Anything unreadable asks
//   in the main session and denies in bypassPermissions;
// - deploys to a linked Supabase project ask first;
// - creating an ATDD oracle tag asks; deleting or moving one asks in the main
//   session and is denied for subagents and bypassPermissions, including forced
//   moves with git tag -f and pushes that can move tags wholesale (ADR 0010, ADR 0029);
// - a subagent never acts on GitHub: for an event with agent_id, git push and every
//   gh command off a read-only list are denied, also inside bash -c or eval (ADR 0013).
//
// Commands are read as shell words, preserving quoted operators. At the gates of
// ADR 0034 an unread form asks in the main session and denies to subagents and
// bypassPermissions; elsewhere unread commands stay allowed. Deciding exceptions
// keep earlier verdicts and apply the same gate rule.
//
// global/settings.json runs it from two entries. With --skip-merge it
// runs for every Bash command and fails open like the other hooks; of the merge
// decision it keeps only the denials that need no network. With --merge-only it
// decides merges and nothing else, and asks when it cannot decide (denies in
// bypassPermissions). Claude Code runs
// its entry when the `if` matches gh pr merge or cannot rule a command out. The entry
// uses shell builtins to look for literal merge, including a whole-quoted word,
// between the command and following description keys in compact events of at most
// 16,000 characters. Larger events or an unrecognized shape use the whole event.
// Only a match starts Node. With onFailure "block", a hook failure or timeout blocks
// a merge and, at worst, a non-merge with merge in that scope. Without a flag the
// hook applies every rule.
import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { controlPlaneFiles, humanMergeMatchers } from './controlplane.mjs';
import { Verdict, failOpen, git as readGit, readEvent } from './lib.mjs';
import { ghIsRead, gitCommand, gitSubcommand, program } from './commands.mjs';
import { isTest, testMatchers } from './oracle.mjs';
import { commandWords, gateCommands, nonliteral, rawGateCommands, shellParts, supabaseIndex, withoutMessages } from './git-shell.mjs';

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

const decisionBudget = Number(process.env.GUARD_GIT_DECISION_BUDGET_MS) || 10000;
const decisionDeadline = performance.now() + decisionBudget;
function checkBudget() {
  if (performance.now() >= decisionDeadline) throw new Error(`decision time budget of ${decisionBudget} ms exhausted`);
}

// Bound required local reads too: an unknown branch is not evidence of a safe push.
function git(cwd, args, options = {}) {
  checkBudget();
  let timedOut = false;
  const result = readGit(cwd, args, {
    ...options, timeout: Math.max(1, Math.min(options.timeout ?? Infinity, Math.ceil(decisionDeadline - performance.now()))),
    onError(error) { timedOut = error.code === 'ETIMEDOUT'; options.onError?.(error); },
  });
  if (timedOut) throw new Error(`git read exceeded the decision time budget of ${decisionBudget} ms`);
  checkBudget();
  return result;
}

// Reads the options of a git subcommand into the flags that were given and the
// positional words, knowing which options consume the next word. Short options
// can be combined (-df, -am "msg"), and an option that takes a value ends the
// cluster: the rest of the cluster is the value, or the next word when nothing
// follows it.
function parseOptions(args, { longWithValue = [], shortWithValue = [], shortOptionalValue = [], longOptions = [] }) {
  const flags = new Set();
  const positional = [];
  const values = new Map();
  let onlyPositional = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (onlyPositional || !arg.startsWith('-') || arg === '-') {
      positional.push(arg);
    } else if (arg === '--') {
      onlyPositional = true;
    } else if (arg.startsWith('--')) {
      let [name] = arg.split('=');
      if (!longOptions.includes(name)) {
        const matches = longOptions.filter((option) => option.startsWith(name));
        if (matches.length === 1) [name] = matches;
        // All the force options ask about a rewrite, even if Git would reject
        // an ambiguous abbreviation such as --forc.
        else if (matches.length > 0 && matches.every((option) => option.startsWith('--force'))) name = '--force';
      }
      flags.add(name);
      if (longWithValue.includes(name)) values.set(name, arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i]);
    } else {
      for (let k = 1; k < arg.length; k += 1) {
        flags.add(`-${arg[k]}`);
        if (shortWithValue.includes(arg[k])) {
          values.set(`-${arg[k]}`, k === arg.length - 1 ? args[++i] : arg.slice(k + 1));
          break;
        }
        if (shortOptionalValue.includes(arg[k])) break;
      }
    }
  }
  return { flags, positional, values };
}

const PUSH_OPTIONS = ['--verbose', '--quiet', '--repo', '--all', '--branches', '--mirror', '--delete', '--tags',
  '--dry-run', '--porcelain', '--force', '--force-with-lease', '--force-if-includes', '--recurse-submodules',
  '--thin', '--receive-pack', '--exec', '--set-upstream', '--progress', '--prune', '--verify', '--follow-tags',
  '--signed', '--atomic', '--push-option', '--ipv4', '--ipv6'];
const REF_CHANGING = new Set(['checkout', 'switch', 'commit', 'reset', 'tag', 'update-ref', 'merge', 'rebase',
  'cherry-pick', 'revert', 'pull', 'fetch', 'push', 'am', 'branch', 'stash', 'symbolic-ref', 'remote', 'worktree', 'bisect']);

function coversOracleTags(pattern) {
  const wildcard = pattern.indexOf('*');
  if (wildcard < 0) return false;
  const prefix = pattern.slice(0, wildcard);
  const namespace = 'refs/tags/oracle/';
  return prefix.startsWith(namespace) || namespace.startsWith(prefix);
}

const isOracleTag = (name) => name.startsWith('oracle/');

// What `git tag` is asked to do, and to which tag names. Without a creation,
// deletion, move or verification flag a bare name creates a tag; with a listing
// flag, or with no name at all, the command only reads.
function classifyTag(args) {
  const { flags, positional } = parseOptions(args, {
    longOptions: TAG_OPTIONS,
    longWithValue: TAG_VALUES,
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
  return { mode: has('-f', '--force') ? 'move' : 'create', names: positional.slice(0, 1), target: positional[1] ?? 'HEAD' };
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

async function checkGit(args, cwd, verdict, branches, session) {
  const { subcommand: sub, rest, directories } = gitCommand(args);
  let dir = cwd;
  for (const directory of directories) {
    const expanded = directory.replace(/^~(?=\/|$)/, process.env.HOME ?? '~');
    dir = isAbsolute(expanded) ? expanded : resolve(dir, expanded);
  }
  trackSwitch(sub, rest, dir, branches);
  const branch = branches.get(dir) ?? git(dir, ['branch', '--show-current']);
  const refs = sub === 'push'
    ? git(dir, ['for-each-ref', '--format=%(refname)', 'refs/heads/', 'refs/tags/'])?.split('\n').filter(Boolean) ?? []
    : [];
  const hasCommits = sub !== 'push' && git(dir, ['rev-parse', '--verify', '-q', 'HEAD']) !== undefined;

  if (sub === 'commit') {
    if (skipsHooks(sub, rest)) {
      verdict.add('deny', 'Commits must not skip hooks with --no-verify.');
    }
    if (protectedBranches(dir).has(branch) && hasCommits) {
      verdict.add('deny', `Do not commit on ${branch}: create a branch from an updated ${branch} first.`);
    }
  }

  if (['commit', 'push', 'merge', 'rebase', 'am'].includes(sub)
    && args.some((arg) => /hooksPath/i.test(arg))) {
    verdict.add('deny', 'Git must not skip hooks with core.hooksPath.');
  }
  if (['merge', 'rebase', 'am'].includes(sub) && skipsHooks(sub, rest)) {
    verdict.add('deny', 'Git must not skip hooks with --no-verify.');
  }

  if (sub === 'push') {
    const { flags, positional, values } = parseOptions(rest, {
      longOptions: [...PUSH_OPTIONS, ...PUSH_OPTIONS.map((option) => option.replace('--', '--no-'))],
      longWithValue: ['--repo', '--push-option', '--receive-pack', '--exec', '--recurse-submodules'],
      shortWithValue: ['o'],
    });
    const has = (...names) => names.some((name) => flags.has(name));
    if (has('--no-verify')) {
      verdict.add('deny', 'Pushes must not skip hooks with --no-verify.');
    }
    const remote = positional[0] ?? values.get('--repo');
    const refspecs = positional.slice(1);
    const targets = has('--mirror') ? [...protectedBranches(dir)]
      : has('--all', '--branches') ? refs.filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice('refs/heads/'.length))
      : refspecs.length > 0
        ? refspecs.map((r) => r.replace(/^\+/, '').split(':').pop().replace(/^refs\/heads\//, '')).map((r) => ['HEAD', '@'].includes(r) ? branch : r)
        : [branch];
    const forced = has('--force', '-f', '--force-with-lease', '--force-if-includes', '--mirror');
    const force = forced
      || refspecs.some((r) => r.startsWith('+'));
    const deletes = has('--delete', '-d') || refspecs.some((r) => r.startsWith(':'));

    const guarded = protectedBranches(dir);
    for (const target of targets) {
      if (guarded.has(target)) {
        const destination = remote ?? 'origin';
        const published = git(dir, ['rev-parse', '--verify', '-q', `refs/remotes/${destination}/${target}`]) !== undefined;
        if (force || deletes) {
          verdict.add('deny', `Never force-push or delete ${target}.`);
        } else if (published) {
          verdict.add('deny', `Do not push to ${target}: open a pull request and squash-merge it.`);
        } else {
          verdict.add('ask', `This publishes ${target} for the first time on ${destination}.`);
        }
      }
    }
    if (force && !targets.some((t) => guarded.has(t))) {
      verdict.add('ask', 'Force push: confirm that rewriting the remote branch is intended.');
    }
    if (deletes) verdict.add('ask', 'This deletes remote refs.');
    if (has('--tags', '--follow-tags') || refspecs.some((r) => /^(?:refs\/)?tags\//.test(r.replace(/^\+/, '').split(':').pop()))
      || refspecs.some((r) => r === 'tag' || refs.includes(`refs/tags/${r}`))) {
      verdict.add('ask', 'This pushes a tag: confirm the human approved publishing it.');
    }
    if (force) {
      const oracles = refs.filter((r) => r.startsWith('refs/tags/oracle/'));
      const wholesale = has('--mirror') || (forced && has('--tags')) || refspecs.some((refspec) => {
        const destination = refspec.replace(/^\+/, '').split(':').pop();
        return (forced || refspec.startsWith('+')) && coversOracleTags(destination);
      });
      if (wholesale && (oracles.length > 0 || has('--mirror') || refspecs.some((r) => coversOracleTags(r.split(':').pop())))) {
        await checkOracleChange(dir, 'oracle/*', 'move-many', undefined, verdict, session, remote);
      }
    }
    for (const refspec of refspecs) {
      const [source, destination = source] = refspec.replace(/^\+/, '').split(':');
      const name = destination.replace(/^(?:refs\/)?tags\//, '');
      if (!isOracleTag(name) || name.includes('*')) continue;
      const deleting = has('--delete', '-d') || source === '';
      const forcing = forced || refspec.startsWith('+');
      if (deleting || forcing) {
        await checkOracleChange(dir, name, deleting ? 'delete' : 'move', source, verdict, session, remote);
      }
    }
  }

  if (sub === 'tag') {
    const { mode, names, target } = classifyTag(rest);
    if (names.some(isOracleTag)) {
      if (mode === 'delete' || mode === 'move') {
        for (const name of names.filter(isOracleTag)) {
          const creating = mode === 'move' && !session.refsMayChange
            && git(dir, ['rev-parse', '--verify', '-q', `refs/tags/${name}`]) === undefined;
          await checkOracleChange(dir, name, creating ? 'create' : mode, target, verdict, session);
        }
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
        await checkOracleChange(dir, ref.slice('refs/tags/'.length), flags.has('-d') ? 'delete' : 'move', positional[1], verdict, session);
      } else {
        verdict.add('ask', 'Creating an oracle tag freezes the approved tests: confirm the human approved the oracle.');
      }
    }
  }
  return REF_CHANGING.has(sub);
}

const PLAIN_MERGE = /^gh pr merge(?: (?!#)[A-Za-z0-9@%+=:,./_#-]+)*$/;
const PR_FIELDS = 'author,baseRefName,changedFiles,files,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,isDraft,labels,statusCheckRollup,url';
const PASSED_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const ghLimit = () => Number(process.env.GUARD_GIT_GH_TIMEOUT_MS) || 6000;
// All gh calls, ls-remote and the bounded git config --get core.sshCommand read
// share this budget, counted from the start of the process. A merge decision makes
// up to three gh calls and one ls-remote, and global/settings.json blocks the merge
// when the hook runs past 30 s; 10 s leaves the rest for Node to
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

function oracleDeletionReason(dir, name) {
  const warning = `Without the tag ${name}, oracle-check checks nothing for ${name.slice('oracle/'.length)}.`;
  const result = gh(['pr', 'list', '--head', name.slice('oracle/'.length), '--state', 'open', '--json', 'number,url'], dir);
  if (result.failure) return `${warning} Could not read the pull request state: ${result.failure}.`;
  try {
    const prs = JSON.parse(result.stdout);
    if (!Array.isArray(prs) || prs.some((pr) => typeof pr?.url !== 'string')) throw new Error('gh returned an unreadable pull request list');
    return prs.length > 0
      ? `${warning} The pull request is still open: ${prs.map((pr) => pr.url).join(', ')}.`
      : `${warning} No open pull request was found for the branch.`;
  } catch (error) {
    return `${warning} Could not read the pull request state: ${brief(error.message)}.`;
  }
}

// ls-remote can reach the network, so it shares gh's remaining budget. Close
// stdin, disable prompts and kill the process group on timeout: an SSH child
// holding the pipes open must not keep the hook alive. Respect a custom SSH
// command; otherwise use BatchMode. Peel annotated tags to their commits.
async function remoteOracleLookup(dir, remote, ref) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const configLimit = Math.floor(Math.min(5000, ghBudget() - performance.now()));
  if (configLimit < 1) return { failure: `could not read ${remote}: time budget exhausted` };
  const config = env.GIT_SSH_COMMAND === undefined
    ? spawnSync('git', ['config', '--get', 'core.sshCommand'], {
      cwd: dir, encoding: 'utf8', timeout: configLimit, killSignal: 'SIGKILL',
    }) : undefined;
  // Exit 1 with no output means the setting is absent; other failures are unreadable.
  if (config && (config.error || (config.status !== 0 && (config.status !== 1 || config.stdout || config.stderr)))) {
    return { failure: `could not read core.sshCommand: ${config.error?.message || brief(config.stderr) || `git exited with ${config.status}`}` };
  }
  if (config?.status === 1) {
    const ssh = env.GIT_SSH ? `'${env.GIT_SSH.replace(/'/g, "'\\''")}'` : 'ssh';
    env.GIT_SSH_COMMAND = `${ssh} -o BatchMode=yes`;
  }
  const left = Math.floor(ghBudget() - performance.now());
  if (left < 1) return { failure: `could not read ${remote}: time budget exhausted` };
  const limit = Math.min(ghLimit(), left);
  const run = await new Promise((done) => {
    const child = spawn('git', ['ls-remote', '--', remote, ref, `${ref}^{}`], {
      cwd: dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (data) => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data; });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      done({ error: { code: 'ETIMEDOUT' } });
    }, limit);
    child.on('error', (error) => {
      clearTimeout(timer);
      done({ error });
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr });
    });
  });
  if (run.error || run.status !== 0) {
    const why = run.error?.code === 'ETIMEDOUT' ? `git ls-remote timed out after ${limit} ms`
      : run.error?.message || brief(run.stderr) || `git ls-remote exited with ${run.status}`;
    return { failure: `could not read ${remote}: ${why}` };
  }
  const refs = new Map();
  for (const line of run.stdout.trim().split('\n').filter(Boolean)) {
    const [commit, name] = line.split(/\s+/);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit) || ![ref, `${ref}^{}`].includes(name)) {
      return { failure: `could not read ${ref} on ${remote}: git ls-remote returned unreadable refs` };
    }
    refs.set(name, commit);
  }
  return { commit: refs.get(`${ref}^{}`) ?? refs.get(ref) };
}

async function remoteOracleCommit(dir, remote, ref) {
  const result = await remoteOracleLookup(dir, remote, ref);
  return result.failure ? `unknown (${result.failure})` : result.commit ?? `absent on ${remote}`;
}

async function checkOracleChange(dir, name, action, target, verdict, session, remote) {
  if (action === 'create') {
    verdict.add('ask', 'Creating an oracle tag freezes the approved tests: confirm the human approved the oracle.');
    return;
  }
  if (session.subagent) {
    verdict.add('deny', 'A subagent must not delete or move an ATDD oracle tag; return to the main session for human approval.');
    return;
  }
  if (session.permissionMode === 'bypassPermissions') {
    verdict.add('deny', 'Deleting or moving an ATDD oracle tag is denied in bypassPermissions; switch to a mode that shows permission prompts.');
    return;
  }
  if (action === 'move-many') {
    verdict.add('ask', `Oracle tags may be moved on the remote ${remote ?? 'selected by git'}. Confirm the human approved changing the frozen oracles.`);
    return;
  }
  if (action === 'delete') {
    verdict.add('ask', `Delete ${name}${remote ? ` on ${remote}` : ''}? ${oracleDeletionReason(dir, name)}`);
    return;
  }
  const ref = `refs/tags/${name}`;
  const before = remote ? await remoteOracleCommit(dir, remote, ref)
    : git(dir, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]) ?? 'unknown (could not read the current commit)';
  const tag = target?.replace(/^(?:refs\/)?tags\//, '');
  const source = remote && isOracleTag(tag ?? '') ? `refs/tags/${tag}` : target;
  const after = git(dir, ['rev-parse', '--verify', '-q', `${source}^{commit}`]) ?? `unknown (could not resolve ${target})`;
  const timing = session.refsMayChange
    ? ' These commits were read before the command runs; earlier segments may change HEAD, branches or tags.' : '';
  verdict.add('ask', `Move ${name}${remote ? ` on ${remote}` : ''} from ${before} to ${after}?${timing} Confirm the human approved changing the frozen oracle.`);
}

// gh uses pflag: boolean shorthands take true unless followed by =value;
// value shorthands consume the rest of their cluster. The last occurrence wins.
function mergeOptions(args) {
  const booleans = new Set(['squash', 'merge', 'rebase', 'delete-branch', 'auto', 'disable-auto', 'admin', 'help']);
  const strings = new Set(['repo', 'subject', 'body', 'body-file', 'author-email', 'match-head-commit']);
  const short = { s: 'squash', m: 'merge', r: 'rebase', d: 'delete-branch', h: 'help',
    R: 'repo', t: 'subject', b: 'body', F: 'body-file', A: 'author-email' };
  const values = new Map();
  const positional = [];
  let failure;
  let valuedMethod = false;
  let onlyPositional = false;
  const set = (name, value) => {
    if (booleans.has(name)) {
      const yes = ['1', 't', 'T', 'TRUE', 'true', 'True'];
      const no = ['0', 'f', 'F', 'FALSE', 'false', 'False'];
      if (!yes.includes(value) && !no.includes(value)) failure = `unreadable --${name} value`;
      else values.set(name, yes.includes(value));
    } else if (strings.has(name) && value !== undefined) {
      values.set(name, value);
      if (name === 'repo' && !value) failure = 'empty --repo value';
    } else failure = `unreadable --${name} option`;
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (onlyPositional || !arg.startsWith('-') || arg === '-') positional.push(arg);
    else if (arg === '--') onlyPositional = true;
    else if (arg.startsWith('--')) {
      const at = arg.indexOf('=');
      const name = arg.slice(2, at < 0 ? undefined : at);
      if (at >= 0 && ['squash', 'merge', 'rebase'].includes(name)) valuedMethod = true;
      set(name, at >= 0 ? arg.slice(at + 1) : booleans.has(name) ? 'true' : args[++i]);
    } else {
      for (let k = 1; k < arg.length; k += 1) {
        const name = short[arg[k]];
        if (!name) {
          failure = `unreadable -${arg[k]} option`;
          break;
        }
        const tail = arg.slice(k + 1);
        if (booleans.has(name) && !tail.startsWith('=')) set(name, 'true');
        else {
          if (['squash', 'merge', 'rebase'].includes(name)) valuedMethod = true;
          set(name, tail ? tail.replace(/^=/, '') : args[++i]);
          break;
        }
      }
    }
  }
  return { values, positional, failure, valuedMethod };
}

function checkIssue(check) {
  const name = check.name ?? check.context ?? 'unnamed check';
  if (check.__typename === 'StatusContext') return check.state === 'SUCCESS' ? undefined : `${name} (${check.state})`;
  if (check.status === 'COMPLETED' && PASSED_CONCLUSIONS.has(check.conclusion)) return undefined;
  return `${name} (${check.conclusion || check.status})`;
}

const mergeReadFailure = (reason) => ({ reasons: [reason], unreadable: true });

// Who opened the pull request and where its head branch lives (ADR 0024). Only the
// authenticated gh user is a trusted author, bots included in the rest; the user is
// read on the pull request's own host, so GH_HOST cannot point the lookup elsewhere.
// A head branch in another repository asks even when the user opened it.
function provenanceReasons(pr, host, cwd) {
  const reasons = [];
  let unreadable = false;
  if (typeof pr.isCrossRepository !== 'boolean') {
    reasons.push('Could not read where the head branch lives: gh returned no isCrossRepository.');
    unreadable = true;
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
    return { reasons, unreadable: true };
  }
  if (!host) {
    reasons.push('Could not read the authenticated gh user: the pull request URL has an unexpected shape.');
    return { reasons, unreadable: true };
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
    unreadable = true;
  } else if (user !== author) {
    reasons.push(`The pull request was opened by ${author}, not by the authenticated gh user ${user} on ${host}.`);
  }
  return { reasons, unreadable };
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

// Reads local git without trimming paths, taking optional locks or lazily fetching.
// Each caller supplies a deadline: local work, oracle discovery and oracle
// comparison each share five seconds across their reads.
function localGit(cwd, args, deadline) {
  const left = Math.floor(deadline - performance.now());
  if (left < 1) throw new Error(`Could not read the local copy in ${cwd}: git exhausted its time budget.`);
  const run = spawnSync('git', ['--no-optional-locks', ...args], {
    cwd, encoding: 'utf8', timeout: left, killSignal: 'SIGKILL',
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }, maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error || run.status !== 0) {
    throw new Error(`Could not read the local copy in ${cwd}: git ${args[0]} failed (${brief(run.stderr) || run.error?.message || run.status}).`, { cause: run });
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

function summarize(items, separator) {
  const shown = items.slice(0, 10).map((item) => item.length > 200 ? `${item.slice(0, 200)}…` : item);
  if (items.length > shown.length) shown.push(`${items.length - shown.length} more`);
  return shown.join(separator);
}

// A failed discovery is not proof that no repository exists. Only traversable
// ancestors with no worktree or bare-repository marker establish that; errors
// and an explicit GIT_DIR keep the original failure and ask.
function outsideRepository(cwd) {
  if (process.env.GIT_DIR !== undefined) return false;
  try {
    let dir = realpathSync(cwd);
    for (;;) {
      for (const marker of ['.git', 'HEAD']) {
        try {
          lstatSync(resolve(dir, marker));
          return false;
        } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return false;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) return true;
      dir = parent;
    }
  } catch {
    return false;
  }
}

// Only a clone with a matching remote can hold this pull request's local work.
// Check named and upstream-tracking branches without fetching; local failures
// add reasons to ask and never grant permission for a merge.
function localWorkReasons(pr, where, cwd) {
  if (!where) return { reasons: [] };
  const deadline = performance.now() + 5000;
  try {
    try {
      localGit(cwd, ['rev-parse', '--absolute-git-dir'], deadline);
    } catch (error) {
      if (!error.cause?.error && error.cause?.status === 128 && outsideRepository(cwd)) return { reasons: [] };
      throw error;
    }
    const remotes = localGit(cwd, ['remote', '-v'], deadline);
    const repository = remoteRepository(`https://${where[1]}/${where[2]}/${where[3]}`);
    const matching = new Set(remotes.trim().split('\n').flatMap((line) => {
      const [name, url] = line.split(/\s+/);
      return url && remoteRepository(url) === repository ? [name] : [];
    }));
    if (matching.size === 0) return { reasons: [] };
    if (typeof pr.headRefName !== 'string' || !pr.headRefName) {
      return mergeReadFailure('Could not read the local branch: gh returned no headRefName.');
    }
    const refs = localGit(cwd, [
      'for-each-ref', '--format=%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)', 'refs/heads/',
    ], deadline);
    const branches = refs.trim().split('\n').flatMap((line) => {
      const [ref, remote, upstream] = line.split('\0');
      return ref === `refs/heads/${pr.headRefName}`
        || (matching.has(remote) && upstream === `refs/heads/${pr.headRefName}`) ? [ref] : [];
    });
    if (branches.length === 0) return { reasons: [] };
    if (typeof pr.headRefOid !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(pr.headRefOid)) {
      return mergeReadFailure('Could not read the pushed head: gh returned no valid headRefOid.');
    }
    try {
      localGit(cwd, ['cat-file', '-e', `${pr.headRefOid}^{commit}`], deadline);
    } catch (error) {
      return mergeReadFailure(`The pushed head ${pr.headRefOid.slice(0, 7)} is unavailable in the local repository; fetch the pull request's head and retry. ${error.message}`);
    }
    const missing = localGit(cwd, ['log', '--no-show-signature', '--format=%h %s', ...branches, '--not', pr.headRefOid, '--'], deadline).trim();
    const reasons = [];
    if (missing) reasons.push(`Local commits missing from the pushed head ${pr.headRefOid}: ${summarize(missing.split('\n'), '; ')}.`);
    const worktrees = localGit(cwd, ['worktree', 'list', '--porcelain', '-z'], deadline);
    for (const record of worktrees.split('\0\0')) {
      const fields = record.split('\0');
      if (!fields.some((field) => field.startsWith('branch ') && branches.includes(field.slice(7)))) continue;
      const path = fields.find((field) => field.startsWith('worktree '))?.slice(9);
      if (!path) throw new Error('Could not read the path of a local branch worktree.');
      if (fields.some((field) => field === 'prunable' || field.startsWith('prunable '))) {
        try {
          lstatSync(path);
        } catch (error) {
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
          throw new Error(`Could not read the local copy in ${path}: ${error.message}`);
        }
      }
      const paths = changedPaths(localGit(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], deadline));
      if (paths.length > 0) reasons.push(`Uncommitted changes in worktree ${path}: ${summarize(paths, ', ')}.`);
    }
    return { reasons };
  } catch (error) {
    return mergeReadFailure(error.message);
  }
}

// Read the base repository's oracle, never a fork's. Compare committed trees
// without fetching, using the test paths declared in the oracle commit.
async function mergeOracle(pr, where, cwd) {
  let tag;
  try {
    if (typeof pr.headRefName !== 'string' || !pr.headRefName.trim()) {
      throw new Error('gh returned no headRefName');
    }
    tag = `oracle/${pr.headRefName}`;
    if (!where) throw new Error('the pull request URL has an unexpected shape');
    const url = `https://${where[1]}/${where[2]}/${where[3]}`;
    const deadline = performance.now() + 5000;
    let remotes;
    try {
      remotes = localGit(cwd, ['remote', '-v'], deadline);
    } catch (error) {
      if (!error.cause?.error && error.cause?.status === 128 && outsideRepository(cwd)) remotes = '';
      else throw error;
    }
    // ls-remote uses the fetch URL, even when a separate push URL matches.
    const matching = remotes.trim().split('\n').map((line) => line.split(/\s+/))
      .find(([, remote, usage]) => usage === '(fetch)' && remoteRepository(remote) === remoteRepository(url));
    const remote = matching?.[0] ?? url;
    const lookup = await remoteOracleLookup(cwd, remote, `refs/tags/${tag}`);
    if (lookup.failure) throw new Error(lookup.failure);
    if (!lookup.commit) {
      return pr.labels.some((label) => String(label.name).toLowerCase() === 'atdd')
        ? { reason: `The oracle tag ${tag} is missing on ${remote}; the pull request carries atdd.` }
        : { evidence: `No oracle was checked: ${tag} is absent on ${remote}.` };
    }
    const commit = lookup.commit;
    if (!matching) throw new Error(`no local clone of the base repository holds ${tag} at ${commit}`);
    if (typeof pr.headRefOid !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(pr.headRefOid)) {
      throw new Error('gh returned no valid headRefOid');
    }
    const compareDeadline = performance.now() + 5000;
    const read = (root, args) => localGit(root, args, compareDeadline);
    read(cwd, ['cat-file', '-e', `${commit}^{commit}`]);
    read(cwd, ['cat-file', '-e', `${pr.headRefOid}^{commit}`]);
    const root = read(cwd, ['rev-parse', '--show-toplevel']).trim();
    const matchers = testMatchers(root, commit, read);
    const changed = read(root, ['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', commit, pr.headRefOid, '--'])
      .split('\0').filter((path) => path && isTest(matchers, path));
    return changed.length > 0
      ? { reason: `Oracle ${tag} at ${commit} differs from the pull request head in test paths: ${changed.join(', ')}.` }
      : { evidence: `Oracle ${tag} at ${commit}: test paths unchanged against the pull request head.` };
  } catch (error) {
    return { reason: `Could not read the oracle${tag ? ` ${tag}` : ''}: ${error.message}.` };
  }
}

// What the hook may say about a merge: reasons to ask, or none when every
// condition of ADR 0010, ADR 0024 and ADR 0030 holds.
async function mergeReasons(options, cwd) {
  const { positional, values } = options;
  const repoFlag = values.get('repo');
  const view = gh(['pr', 'view', ...(positional[0] ? [positional[0]] : []), ...(repoFlag ? ['-R', repoFlag] : []), '--json', PR_FIELDS], cwd);
  if (view.failure) return mergeReadFailure(`Could not read the pull request: ${view.failure}.`);

  let pr;
  try {
    pr = JSON.parse(view.stdout);
  } catch {
    return mergeReadFailure('Could not read the pull request: gh did not return JSON.');
  }
  const complete = pr && typeof pr.baseRefName === 'string' && typeof pr.url === 'string' && typeof pr.isDraft === 'boolean'
    && typeof pr.changedFiles === 'number' && Array.isArray(pr.files) && Array.isArray(pr.labels) && Array.isArray(pr.statusCheckRollup);
  if (!complete) return mergeReadFailure('Could not read the pull request: gh returned incomplete data.');

  const reasons = [];
  let unreadable = false;
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
    unreadable = true;
  }

  const where = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(pr.url);
  const provenance = provenanceReasons(pr, where?.[1], cwd);
  const local = localWorkReasons(pr, where, cwd);
  reasons.push(...provenance.reasons, ...local.reasons);
  unreadable ||= provenance.unreadable || local.unreadable;

  // The list a pull request is judged by comes from its base branch, never from its own copy.
  let extra = [];
  if (!where) {
    reasons.push('Could not read CLAUDE.md of the base branch: the pull request URL has an unexpected shape.');
    unreadable = true;
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
    else if (!/HTTP 404/.test(file.stderr ?? '')) {
      reasons.push(`Could not read CLAUDE.md of the base branch: ${file.failure}.`);
      unreadable = true;
    }
  }
  const sensitive = controlPlaneFiles(paths, extra);
  if (sensitive.length > 0) reasons.push(`Control-plane files changed: ${sensitive.join(', ')}.`);
  const oracle = await mergeOracle(pr, where, cwd);
  if (oracle.reason) reasons.push(oracle.reason);
  return { reasons, oracle, unreadable };
}

const couldNotDecide = (error) => `Could not decide this merge (${error?.message ?? error}).`;

function askHuman(verdict, reasons) {
  verdict.add('ask', `${reasons.join(' ')} The human decides this merge (ADR 0010).`);
}

function mergeDecision(verdict, reasons, permissionMode, unreadable) {
  if (unreadable && permissionMode === 'bypassPermissions') {
    verdict.add('deny', `${reasons.join(' ')} The oracle requires human approval; switch from bypassPermissions to a mode that shows permission prompts.`);
  } else askHuman(verdict, reasons);
}

// Returns oracle evidence when a merge was verified end to end. Without
// readPullRequest only the denials that need no network apply; nothing is verified.
async function checkGh(args, verdict, cwd, readPullRequest, permissionMode) {
  if (args[0] !== 'pr' || args[1] !== 'merge') return false;
  const options = mergeOptions(args.slice(2));
  const { values } = options;
  if (hasFlag(args, '--admin')) {
    verdict.add('deny', 'Never merge with --admin: it bypasses every rule of the ruleset, required checks included.');
  }
  if (values.get('squash') !== true || values.get('merge') === true || values.get('rebase') === true) {
    verdict.add('deny', 'Merge with --squash: main keeps a linear history.');
  }
  if (verdict.decision === 'deny' || !readPullRequest) return false;
  if (options.failure) {
    mergeDecision(verdict, [couldNotDecide(options.failure)], permissionMode, true);
    return false;
  }
  let result;
  try {
    result = await mergeReasons(options, cwd);
  } catch (error) {
    result = mergeReadFailure(couldNotDecide(error));
  }
  // Valued merge-method flags keep the normal permission prompt (ADR 0030).
  if (result.reasons.length === 0) return options.valuedMethod || options.positional.length > 1 ? false : result.oracle.evidence;
  mergeDecision(verdict, result.reasons, permissionMode, result.unreadable || !!result.oracle?.reason);
  return false;
}

function checkSupabase(args, verdict) {
  const line = args.join(' ');
  const remote = /^(db push|link|functions deploy|secrets set|secrets unset|db reset --linked|migration repair)\b/;
  if (remote.test(line) || hasFlag(args, '--linked', '--db-url')) {
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

function isMerge(w) {
  if (program(w[0]) !== 'gh' || w[1] !== 'pr') return false;
  const { positional } = parseOptions(w.slice(2), { longWithValue: ['--repo'], shortWithValue: ['R'] });
  return positional[0] === 'merge';
}

const CANONICAL = {
  merge: 'gh pr merge <number> --squash --delete-branch',
  'push to a protected branch': 'git push origin <literal-branch>',
  'oracle tags': 'git tag <literal-oracle/name> or git push origin refs/tags/oracle/<name>',
  'release tags': 'git push origin refs/tags/<literal-tag>',
  'skipped hooks': 'git commit -m <message> or git push origin <branch>, with hooks enabled',
  'GitHub actions of a subagent': 'gh pr view <number>; return writes to the orchestrator',
  'remote Supabase actions': 'supabase db push (human approval)',
};
const TAG_OPTIONS = ['--annotate', '--sign', '--no-sign', '--force', '--delete', '--verify', '--list',
  '--message', '--file', '--local-user', '--cleanup', '--format', '--sort', '--contains', '--no-contains',
  '--points-at', '--merged', '--no-merged', '--column', '--no-column', '--create-reflog', '--ignore-case',
  '--omit-empty', '--trailer', '--edit'];
const TAG_VALUES = ['--message', '--file', '--local-user', '--cleanup', '--format', '--sort', '--contains',
  '--no-contains', '--points-at', '--merged', '--no-merged'];
const COMMIT_OPTIONS = ['--all', '--patch', '--reuse-message', '--reedit-message', '--fixup', '--squash',
  '--reset-author', '--short', '--branch', '--porcelain', '--long', '--null', '--file', '--author', '--date',
  '--message', '--template', '--signoff', '--trailer', '--no-verify', '--allow-empty', '--allow-empty-message',
  '--cleanup', '--edit', '--no-edit', '--amend', '--no-post-rewrite', '--include', '--only', '--pathspec-from-file',
  '--pathspec-file-nul', '--untracked-files', '--verbose', '--quiet', '--dry-run', '--status', '--no-status',
  '--gpg-sign', '--no-gpg-sign', '--no-ahead-behind'];
const BUILTIN_GIT = new Set(['add', 'am', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bundle', 'cat-file', 'checkout',
  'cherry', 'cherry-pick', 'clean', 'clone', 'commit', 'config', 'describe', 'diff', 'difftool', 'fetch', 'format-patch',
  'diff-tree', 'for-each-ref', 'fsck', 'gc', 'grep', 'help', 'init', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge', 'merge-base', 'mergetool',
  'mv', 'notes', 'pull', 'push', 'range-diff', 'rebase', 'reflog', 'remote', 'reset', 'restore', 'revert',
  'rev-list', 'rev-parse', 'rm', 'shortlog', 'show', 'show-ref', 'sparse-checkout', 'stage', 'stash', 'status', 'submodule',
  'switch', 'symbolic-ref', 'tag', 'update-index', 'update-ref', 'version', 'worktree']);

function skipsHooks(sub, args) {
  const { flags } = parseOptions(args, {
    longOptions: COMMIT_OPTIONS, shortWithValue: ['m', 'F', 'C', 'c', 't'],
  });
  return flags.has('--no-verify') || (sub === 'commit' && flags.has('-n'));
}

function remoteSupabase(args) {
  return /^(?:db push|functions deploy|secrets (?:set|unset)|migration repair)\b/.test(args.join(' '))
    || hasFlag(args, '--linked', '--db-url');
}

function gatesFor(candidate, subagent) {
  const w = candidate.tokens.map((t) => t.value);
  const name = program(w[0]);
  const gates = [];
  if (name === 'gh') {
    if ((w.some((word) => word.split('/').includes('merge') || word.includes('mergePullRequest')))
      && !ghIsRead(w.slice(1))) gates.push('merge');
    if (subagent && (candidate.issue || !ghIsRead(w.slice(1)))) gates.push('GitHub actions of a subagent');
  } else if (name === 'git') {
    const { subcommand: sub, rest } = gitCommand(w.slice(1));
    // Read-only subcommands keep their own meaning, even with an oracle path argument.
    const own = ['push', 'tag', 'update-ref', 'fetch', 'commit', 'merge', 'rebase', 'am', 'config'].includes(sub);
    const all = [...candidate.assignments.map((t) => t.value), ...w];
    const skipped = all.some((word) => /hooksPath/i.test(word) || /^(?:--no-v|GIT_CONFIG_|HUSKY)/.test(word))
      || (sub === 'commit' && skipsHooks(sub, rest));
    const alias = all.some((word) => word.startsWith('alias.'));
    const push = sub === 'push' || (!BUILTIN_GIT.has(sub) && w.includes('push'));
    if (push) gates.push('push to a protected branch');
    if ((sub === 'tag' && classifyTag(rest).mode !== 'read') || sub === 'update-ref' || alias
      || (sub === 'push' && (rest.some((a) => /^(?:--mirror|--prune)/.test(a)) || rest.some((a) => /(?:^|[/:])oracle\//.test(a) || /(?:^|[+:])refs\/tags\//.test(a))))
      || (sub === 'fetch' && rest.some((a) => /^--prune-t/.test(a) || /^-[^-]*P/.test(a) || a.includes('refs/tags/')))
      || (!BUILTIN_GIT.has(sub) && all.some((a) => /(?:^|[/:])oracle\//.test(a) || a.includes('refs/tags/')))) gates.push('oracle tags');
    if (push) gates.push('release tags');
    if (skipped && (own || !BUILTIN_GIT.has(sub))) gates.push('skipped hooks');
    if (subagent && push) gates.push('GitHub actions of a subagent');
  } else if (name === 'supabase' && remoteSupabase(w.slice(1))) gates.push('remote Supabase actions');
  return gates;
}

function unknownOption(args, spec, short) {
  const { flags } = parseOptions(args, spec);
  return [...flags].find((flag) => flag.startsWith('--') ? !(spec.longOptions ?? []).includes(flag) : !short.includes(flag.slice(1)));
}

function unreadPart(candidate, cwdIssue) {
  const { tokens, assignments } = candidate;
  const w = tokens.map((t) => t.value);
  const name = program(w[0]);
  if (candidate.issue) return [candidate.issue, ...assignments.map((t) => t.raw)].join(' ');
  if (cwdIssue) return cwdIssue;
  for (const token of assignments) {
    if (/["']/.test(token.raw)) return `quoted assignment ${token.raw}`;
    if (/^(?:GIT_(?:DIR|WORK_TREE|COMMON_DIR|NAMESPACE|CONFIG_\w*)|GH_(?:REPO|HOST|TOKEN))=/.test(token.value)) return `unresolved context ${token.raw}`;
  }
  const programIssue = nonliteral(tokens[0], true);
  if (programIssue) return programIssue;
  let relevant = tokens.slice(1);
  if (name === 'git') {
    const { subcommand: sub, rest } = gitCommand(w.slice(1));
    const context = tokens.find((t) => /^--(?:git-dir|work-tree)(?:=|$)/.test(t.value) || /^alias\./.test(t.value));
    if (context) return `unresolved context ${context.raw}`;
    if (!BUILTIN_GIT.has(sub)) return `unknown git subcommand ${sub}`;
    if (sub === 'push' && rest.some((a) => /^--prune/.test(a))) return 'push --prune';
    if (sub === 'update-ref' && rest.includes('--stdin')) return 'update-ref --stdin';
    if (sub === 'fetch') return `fetch tag options or refspec ${rest.join(' ')}`;
    if (sub === 'config') return `git config hooksPath ${rest.join(' ')}`;
    const config = assignments.find((t) => /^GIT_CONFIG_/.test(t.value));
    if (config) return config.raw;
    let unknown;
    if (sub === 'push') {
      unknown = unknownOption(rest, {
        longOptions: [...PUSH_OPTIONS, ...PUSH_OPTIONS.map((o) => o.replace('--', '--no-'))],
        longWithValue: ['--repo', '--push-option', '--receive-pack', '--exec', '--recurse-submodules'], shortWithValue: ['o'],
      }, 'vqdfnou46');
      // Forced tag refspec globs have a canonical oracle move rule. Other globs do not.
      const forced = parseOptions(rest, { longOptions: PUSH_OPTIONS }).flags;
      relevant = relevant.filter((t) => !((t.value.startsWith('+') || forced.has('--force') || forced.has('-f'))
        && t.value.includes('*') && /(?:^|:)refs\/tags\//.test(t.value.replace(/^\+/, ''))));
    } else if (sub === 'tag') {
      unknown = unknownOption(rest, { longOptions: TAG_OPTIONS, longWithValue: TAG_VALUES,
        shortWithValue: ['m', 'F', 'u'], shortOptionalValue: ['n'] }, 'asfdvlnmFu');
    } else if (sub === 'update-ref') {
      unknown = unknownOption(rest, { longOptions: ['--no-deref', '--create-reflog'], shortWithValue: ['m'] }, 'dm');
    } else if (sub === 'commit') {
      unknown = unknownOption(rest, { longOptions: COMMIT_OPTIONS,
        longWithValue: ['--message', '--file', '--reuse-message', '--reedit-message', '--author', '--date', '--template', '--cleanup'],
        shortWithValue: ['m', 'F', 'C', 'c', 't'] }, 'apnqvsmFCctiozS');
    }
    if (unknown) return `unknown option ${unknown}`;
  } else if (name === 'gh') {
    if (w[1] === 'api') return `gh api merge ${w.slice(2).join(' ')}`;
    // gh's value flags that do not select the pull request cannot affect the decision.
    const ignored = new Set(['--subject', '--body', '--match-head-commit', '--jq', '-t', '-b']);
    relevant = [];
    for (let i = 1; i < tokens.length; i += 1) {
      const value = tokens[i].value;
      if (ignored.has(value)) { i += 1; continue; }
      if ([...ignored].some((flag) => value.startsWith(flag + '='))) continue;
      relevant.push(tokens[i]);
    }
    if (w[1] === 'pr' && w[2] === 'merge') {
      const failure = mergeOptions(w.slice(3)).failure;
      if (failure?.includes('option')) return failure;
    }
  }
  return relevant.map((t) => nonliteral(t)).find(Boolean);
}

function addUnread(verdict, gates, part, session) {
  for (const gate of gates) {
    verdict.add(session.subagent || session.permissionMode === 'bypassPermissions' ? 'deny' : 'ask',
      `Unread command at the ${gate} gate: ${part}. Canonical form: ${CANONICAL[gate]}.`);
  }
}

let permissionMode;
let session = {};
let candidates = [];
let command;
const verdict = new Verdict();
try {
  const event = readEvent();
  permissionMode = event?.permission_mode;
  command = event?.tool_input?.command;
  if (typeof command !== 'string') {
    if (mergeOnly) throw new Error('the event carries no Bash command');
    process.exit(0);
  }
  const subagent = typeof event.agent_id === 'string' && event.agent_id !== '';
  session = { subagent, permissionMode };
  let cwd = event.cwd ?? process.cwd();
  let cwdIssue;
  const branches = new Map();
  let refsMayChange = false;
  const parts = shellParts(command);
  const exports = new Map();
  const readings = parts.map((part) => {
    const words = commandWords(part.tokens).tokens;
    if (words[0]?.value === 'export') {
      for (const token of words.slice(1)) {
        if (/^(?:GIT_(?:DIR|WORK_TREE|COMMON_DIR|NAMESPACE|CONFIG_\w*)|GH_(?:REPO|HOST|TOKEN)|HUSKY(?:_SKIP_HOOKS)?)=/.test(token.value)) {
          exports.set(token.value.split('=')[0], token);
        }
      }
    }
    part.exports = [...exports.values()];
    return gateCommands(part).map((candidate) => ({ ...candidate,
      assignments: [...part.exports, ...candidate.assignments] }));
  });
  candidates = readings.flat().map((candidate) => ({ ...candidate, gates: gatesFor(candidate, subagent) }));
  let merged = false;
  for (let i = 0; i < parts.length; i += 1) {
    checkBudget();
    const words = commandWords(parts[i].tokens);
    const assignments = [...parts[i].exports, ...words.assignments];
    const original = words.tokens;
    const tokens = withoutMessages(original);
    const w = tokens.map((t) => t.value);
    let unread = false;
    for (const candidate of readings[i]) {
      const gates = gatesFor(candidate, subagent).filter((g) => !mergeOnly || g === 'merge' || (g === 'GitHub actions of a subagent' && gatesFor(candidate, subagent).includes('merge')));
      if (!gates.length) continue;
      const issue = unreadPart(candidate, cwdIssue);
      if (issue) {
        addUnread(verdict, gates, issue, session);
        unread = true;
        // An unresolved gh context still asks. Keep any merge findings from the
        // hook's own context as additional evidence, never as verification.
        if (!skipMerge && !subagent && permissionMode !== 'bypassPermissions'
          && issue.startsWith('unresolved context GH_')
          && !candidate.tokens.some((token) => nonliteral(token))) {
          const evidence = new Verdict();
          await checkGh(candidate.tokens.slice(1).map((token) => token.value), evidence, cwd, true, permissionMode);
          if (evidence.decision === 'ask') {
            for (const reason of evidence.reasons) verdict.add('ask', `Merge evidence from the hook's current context: ${reason}`);
          }
        }
      }
    }
    if (!unread) {
      if (isMerge(w) && w[2] !== 'merge') {
        verdict.add('deny', 'Write gh pr flags after merge so the merge guard can verify the pull request.');
      }
      if (subagent && (!mergeOnly || isMerge(w))) checkSubagent(w, verdict);
      if (['pushd', 'popd'].includes(w[0])) {
        cwdIssue = `unresolved directory context after ${w[0]}`;
      } else if (w[0] === 'cd' && w[1]) {
        const directory = w[1].replace(/^~(?=\/|$)/, process.env.HOME ?? '~');
        const issue = nonliteral(tokens[1]);
        if (issue) cwdIssue = issue;
        else if (isAbsolute(directory) || !cwdIssue) {
          cwdIssue = undefined;
          cwd = isAbsolute(directory) ? directory : resolve(cwd, directory);
        }
      } else if (program(w[0]) === 'git' && !mergeOnly) {
        if (assignments.some((t) => /^HUSKY(?:=0$|_SKIP_HOOKS=)/.test(t.value))) {
          verdict.add('deny', 'Git must not skip hooks with HUSKY or HUSKY_SKIP_HOOKS.');
        }
        refsMayChange = await checkGit(w.slice(1), cwd, verdict, branches, {
          ...session, refsMayChange,
        }) || refsMayChange;
      } else if (program(w[0]) === 'gh' && !subagent) {
        merged = await checkGh(w.slice(1), verdict, cwd, !skipMerge, permissionMode) || merged;
        refsMayChange ||= (w[1] === 'pr' && w[2] === 'checkout') || (w[1] === 'repo' && w[2] === 'sync');
      } else if (!mergeOnly && supabaseIndex(tokens) !== undefined) {
        checkSupabase(w.slice(supabaseIndex(tokens) + 1), verdict);
      }
    }
    checkBudget();
    if (process.env.GUARD_GIT_TEST_THROW === '1' && i === 0) throw new Error('injected deciding exception');
  }
  // An explicit allow lifts the prompt for the whole command. Only a single plain
  // merge can earn it, and every relevant part must have been verified.
  if (merged && !subagent && parts.length === 1 && PLAIN_MERGE.test(command.trim())) {
    verdict.allowExplicitly(`Checks passed, no control-plane files, no needs-human label, the local copy holds nothing missing from the pull request, opened by the authenticated gh user from a branch in the base repository (ADR 0010, ADR 0024). ${merged}`);
  }
  verdict.emit();
} catch (error) {
  const fallback = typeof command === 'string' ? rawGateCommands(command).flatMap((c) => gatesFor(c, session.subagent)) : [];
  const gates = [...new Set([...candidates.flatMap((c) => c.gates), ...fallback].filter((g) => !mergeOnly || g === 'merge'))];
  if (gates.length) {
    addUnread(verdict, gates, `deciding exception: ${mergeOnly ? couldNotDecide(error) : error.message}`, session);
    verdict.emit();
  }
  if (mergeOnly) {
    mergeDecision(verdict, [couldNotDecide(error)], permissionMode, true);
    verdict.emit();
  }
  // Preserve earlier questions or denials even when the failing command has no gate.
  if (verdict.decision !== 'allow') verdict.emit();
  failOpen('guard-git', error);
}
