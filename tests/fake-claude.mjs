// A fake `claude` CLI for the installer tests (issue #32, ADR 0014). It stands in for the part of
// Claude Code that the installer drives: `claude mcp add-json <name> <json> -s user` and
// `claude mcp remove <name> -s user`. Like the real CLI it keeps the user-scope servers under the
// `mcpServers` key of `<CLAUDE_CONFIG_DIR or HOME>/.claude.json`. Any other subcommand, and any
// call without `-s user`, exits 2: the installer must not reach for anything else.
// Every call is logged, so a test can say what the installer ran and what it did not.
// FAKE_CLAUDE_FAIL is a comma-separated list of `add:<name>` and `remove:<name>` that exit 1.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const SCRIPT = `#!${process.execPath}
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const argv = process.argv.slice(2);
const env = process.env;
if (env.FAKE_CLAUDE_LOG) {
  appendFileSync(env.FAKE_CLAUDE_LOG, JSON.stringify({ argv, configDir: env.CLAUDE_CONFIG_DIR ?? null, home: env.HOME ?? null }) + '\\n');
}
const fail = (message, code) => { process.stderr.write(message + '\\n'); process.exit(code); };
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

export function fakeClaude(dir) {
  const bin = join(dir, 'bin');
  const log = join(dir, 'calls.log');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), SCRIPT);
  chmodSync(join(bin, 'claude'), 0o755);
  return {
    bin,
    log,
    // The environment for a child process that should find this claude first.
    env(extra = {}) {
      return { PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_CLAUDE_LOG: log, ...extra };
    },
    calls() {
      return existsSync(log)
        ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
        : [];
    },
    reset() {
      writeFileSync(log, '');
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
