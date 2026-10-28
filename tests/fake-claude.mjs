// A fake `claude` CLI for the installer tests (issue #32, ADR 0014). It stands in for the part of
// Claude Code that the installer drives: `claude mcp add-json <name> <json> -s user` and
// `claude mcp remove <name> -s user`. Like the real CLI it keeps the user-scope servers under the
// `mcpServers` key of `<CLAUDE_CONFIG_DIR or HOME>/.claude.json`. `claude --version` prints
// FAKE_CLAUDE_VERSION, 2.1.304 by default, which `--check` reads (issue #27). Any other subcommand,
// and any call without `-s user`, exits 2: the installer must not reach for anything else.
// Every call is logged, so a test can say what the installer ran and what it did not.
// FAKE_CLAUDE_FAIL is a comma-separated list of `add:<name>` and `remove:<name>` that exit 1.
// Issue #50: the same bin holds a fake `npx`, so that the installer's cache prewarm never reaches the
// network. It logs its argv and whether its standard input reached end of file within three seconds to
// FAKE_NPX_LOG. FAKE_NPX_FAIL=exit makes it exit 1; FAKE_NPX_FAIL=signal makes it die by SIGKILL, as a
// process the installer stopped on a timeout would.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { writeExecutable } from './executables.mjs';

const SCRIPT = `#!${process.execPath}
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const argv = process.argv.slice(2);
const env = process.env;
if (env.FAKE_CLAUDE_LOG) {
  appendFileSync(env.FAKE_CLAUDE_LOG, JSON.stringify({ argv, configDir: env.CLAUDE_CONFIG_DIR ?? null, home: env.HOME ?? null }) + '\\n');
}
const fail = (message, code) => { process.stderr.write(message + '\\n'); process.exit(code); };
if (argv.length === 1 && argv[0] === '--version') {
  process.stdout.write((env.FAKE_CLAUDE_VERSION ?? '2.1.304') + ' (Claude Code)\\n');
  process.exit(0);
}
const [area, sub, name, ...rest] = argv;
if (area !== 'mcp' || !['add-json', 'remove'].includes(sub)) fail('fake claude: unexpected call ' + argv.join(' '), 2);
const scopeAt = argv.indexOf('-s');
if (scopeAt < 0 || argv[scopeAt + 1] !== 'user') fail('fake claude: the user scope is required', 2);
if ((env.FAKE_CLAUDE_FAIL ?? '').split(',').includes((sub === 'add-json' ? 'add:' : 'remove:') + name)) {
  fail('fake claude: ' + sub + ' ' + name + ' failed on purpose', 1);
}
const file = join(env.CLAUDE_CONFIG_DIR ?? env.HOME, '.claude.json');
const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
config.mcpServers = config.mcpServers ?? {};
if (sub === 'add-json') {
  config.mcpServers[name] = JSON.parse(rest[0]);
  process.stdout.write('Added stdio MCP server ' + name + ' to user config\\n');
} else {
  if (!(name in config.mcpServers)) fail('No MCP server found with name: ' + name, 1);
  delete config.mcpServers[name];
  process.stdout.write('Removed MCP server ' + name + ' from user config\\n');
}
mkdirSync(join(file, '..'), { recursive: true });
writeFileSync(file, JSON.stringify(config, null, 2));
`;

const NPX = `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const argv = process.argv.slice(2);
const env = process.env;
const finish = (stdinClosed) => {
  if (env.FAKE_NPX_LOG) appendFileSync(env.FAKE_NPX_LOG, JSON.stringify({ argv, stdinClosed }) + '\\n');
  if (env.FAKE_NPX_FAIL === 'signal') process.kill(process.pid, 'SIGKILL');
  if (env.FAKE_NPX_FAIL === 'exit') {
    process.stderr.write('fake npx: failed on purpose\\n');
    process.exit(1);
  }
  process.exit(stdinClosed ? 0 : 1);
};
const timer = setTimeout(() => finish(false), 3000);
process.stdin.on('end', () => { clearTimeout(timer); finish(true); });
process.stdin.on('error', () => { clearTimeout(timer); finish(true); });
process.stdin.resume();
`;

export function fakeClaude(dir) {
  const bin = join(dir, 'bin');
  const log = join(dir, 'calls.log');
  const npxLog = join(dir, 'npx.log');
  mkdirSync(bin, { recursive: true });
  writeExecutable(join(bin, 'claude'), SCRIPT);
  writeExecutable(join(bin, 'npx'), NPX);
  return {
    bin,
    log,
    // The environment for a child process that should find this claude first.
    env(extra = {}) {
      return { PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_CLAUDE_LOG: log, FAKE_NPX_LOG: npxLog, ...extra };
    },
    // The calls the fake npx received, each as { argv, stdinClosed }.
    npxCalls() {
      return existsSync(npxLog)
        ? readFileSync(npxLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
        : [];
    },
    calls() {
      return existsSync(log)
        ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
        : [];
    },
    // The calls that could change a registration, without the version that --check reads.
    mcpCalls() {
      return this.calls().filter((call) => call.argv[0] === 'mcp');
    },
    reset() {
      writeFileSync(log, '');
      writeFileSync(npxLog, '');
    },
    // The user-scope servers registered in a configuration directory.
    servers(configDir) {
      const file = join(configDir, '.claude.json');
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).mcpServers ?? {} : {};
    },
    seed(configDir, servers) {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, '.claude.json'), JSON.stringify({ mcpServers: servers }, null, 2));
    },
  };
}
