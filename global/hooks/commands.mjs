// Command knowledge shared by the GitHub subagent rule and the read-only shell.
// Keep one gh read list so the two guards cannot disagree about a GitHub command.
const GH_READS = {
  pr: ['view', 'list', 'diff', 'checks', 'status'],
  issue: ['view', 'list', 'diff', 'checks', 'status'],
  run: ['view', 'list', 'watch'],
  repo: ['view'],
  label: ['list'],
  release: ['view', 'list'],
  workflow: ['view', 'list'],
};

// The program a word names, so /opt/homebrew/bin/gh reads as gh.
export const program = (word) => (word ?? '').split('/').pop();

// The git subcommand after the global options, which can take a value of their own:
// `git -c key=value push` and `git -C dir push` are both a push.
export function gitSubcommand(args) {
  const withValue = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'];
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += withValue.includes(args[i]) ? 2 : 1;
  return args[i];
}

// gh api is a read only as a plain GET: any other method, or a field or an input body, writes.
// graphql is denied outright, because a mutation looks like a query from here.
export function ghApiIsRead(args) {
  if (args.includes('graphql')) return false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (['-f', '-F', '--field', '--raw-field', '--input'].includes(arg)) return false;
    if (/^--(field|raw-field|input)=/.test(arg) || /^-[fF]./.test(arg)) return false;
    let method;
    if (arg === '-X' || arg === '--method') method = args[i + 1];
    else if (arg.startsWith('--method=')) method = arg.slice('--method='.length);
    else if (/^-X./.test(arg)) method = arg.slice(2);
    if (method !== undefined && method.toUpperCase() !== 'GET') return false;
  }
  return true;
}

export function ghIsRead(args) {
  const [cmd, sub] = args;
  if (['--version', 'help', '--help'].includes(cmd) || cmd === 'search') return true;
  if (cmd === 'api') return ghApiIsRead(args.slice(1));
  if (cmd === 'auth') {
    // auth status prints the token with -t or --show-token, also inside a cluster of short flags.
    const showsToken = args.some((a) => a === '--show-token' || a.startsWith('--show-token=') || /^-[A-Za-z]*t/.test(a));
    return sub === 'status' && !showsToken;
  }
  return Boolean(GH_READS[cmd]?.includes(sub));
}

