// Issue #32 (ADR 0014): the installer registers the MCP servers this repository declares, through the
// `claude` CLI and in the user scope, and reports drift in --check. The behaviour tests run the real
// installer against a throwaway repository and a fake `claude` first on PATH (tests/fake-claude.mjs), as
// the hook tests do with `gh`; the static tests read the files this repository ships. Only the files
// and messages below are the contract: how the installer reaches them is its own business.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeClaude } from './fake-claude.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'cw-mcp-'));
const fake = fakeClaude(join(scratch, 'fake'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const REVIEWER = {
  type: 'stdio',
  command: 'npx',
  args: ['-y', 'codex-subagent-mcp@^0.5.0'],
  env: { CODEX_SUBAGENT_DEFAULT_MODEL: 'm1', CODEX_SUBAGENT_MAX_SANDBOX: 'read-only' },
};
const IMPLEMENTER = {
  ...REVIEWER,
  env: { CODEX_SUBAGENT_DEFAULT_MODEL: 'm1', CODEX_SUBAGENT_MAX_SANDBOX: 'workspace-write' },
};
const DECLARED = { 'codex-reviewer': REVIEWER, 'codex-implementer': IMPLEMENTER };

let counter = 0;
const fresh = (label) => mkdtempSync(join(scratch, `${label}-${(counter += 1)}-`));

// A repository with the installer and only the files a test declares.
function makeRepo({ servers, retired, personal } = {}) {
  const dir = fresh('repo');
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'global'));
  copyFileSync(join(repo, 'scripts', 'install.mjs'), join(dir, 'scripts', 'install.mjs'));
  writeFileSync(join(dir, 'global', 'CLAUDE.md'), 'x\n');
  writeFileSync(join(dir, 'global', 'settings.json'), '{}');
  if (servers) writeFileSync(join(dir, 'global', 'mcp-servers.json'), JSON.stringify(servers));
  if (retired) writeFileSync(join(dir, 'global', 'retired-mcp-servers.json'), JSON.stringify(retired));
  if (personal) {
    mkdirSync(join(dir, 'personal'));
    writeFileSync(join(dir, 'personal', 'mcp-servers.json'), JSON.stringify(personal));
  }
  return dir;
}

// Runs an installer. `target` undefined means the default target, under HOME.
function run(repoDir, target, args = [], { env = fake.env(), home } = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.CLAUDE_CONFIG_DIR;
  if (home) childEnv.HOME = home;
  return spawnSync(
    process.execPath,
    [join(repoDir, 'scripts', 'install.mjs'), ...(target ? ['--target', target] : []), ...args],
    { encoding: 'utf8', env: childEnv },
  );
}

const writesOf = (name) => fake.calls().filter((c) => c.argv[2] === name).map((c) => c.argv[1]);

describe('AC-1 registers the declared servers in the user scope', () => {
  test('AC-1 registers every declared server in a new target, through claude mcp add-json with -s user', () => {
    const repoDir = makeRepo({ servers: DECLARED });
    const target = fresh('target');
    fake.reset();
    const r = run(repoDir, target);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fake.servers(target), DECLARED);
    const calls = fake.calls();
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.deepEqual([c.argv[0], c.argv[1]], ['mcp', 'add-json']);
      assert.equal(c.argv[c.argv.indexOf('-s') + 1], 'user');
    }
    assert.match(r.stdout, /Registered MCP server codex-reviewer/);
    assert.match(r.stdout, /Registered MCP server codex-implementer/);
    assert.match(r.stdout, /reload/i, 'open sessions keep the old process until they reload');
  });

  test('AC-1 does not run claude at all when every registration already matches, and --check only reads its version', () => {
    const repoDir = makeRepo({ servers: DECLARED });
    const target = fresh('target');
    assert.equal(run(repoDir, target).status, 0);
    assert.deepEqual(fake.servers(target), DECLARED, 'the first install registered them');
    fake.reset();
    const again = run(repoDir, target);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(fake.calls(), []);
    assert.doesNotMatch(again.stdout, /Registered MCP server|Replaced MCP server/);
    const check = run(repoDir, target, ['--check']);
    assert.equal(check.status, 0, check.stdout);
    assert.deepEqual(fake.calls().map((c) => c.argv), [['--version']]);
  });

  test('AC-1 leaves a server it does not declare untouched', () => {
    const repoDir = makeRepo({ servers: DECLARED });
    const target = fresh('target');
    const mine = { type: 'stdio', command: 'dart', args: ['mcp-server'] };
    fake.seed(target, { ft: mine });
    fake.reset();
    const r = run(repoDir, target);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fake.servers(target), { ft: mine, ...DECLARED }, 'the declared servers are added beside it');
    assert.deepEqual(fake.calls().filter((c) => c.argv[2] === 'ft'), []);
    const check = run(repoDir, target, ['--check']);
    assert.doesNotMatch(check.stdout, /\bft\b/);
  });

  test('AC-1 with --target points claude at that directory, and without it uses the configuration under HOME', () => {
    const repoDir = makeRepo({ servers: DECLARED });
    const target = fresh('target');
    fake.reset();
    assert.equal(run(repoDir, target).status, 0);
    assert.ok(fake.calls().every((c) => c.configDir === target), 'CLAUDE_CONFIG_DIR is the target');

    const home = fresh('home');
    fake.reset();
    const r = run(repoDir, undefined, [], { home });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fake.calls().length > 0);
    assert.ok(fake.calls().every((c) => c.configDir === null), 'the default target must not set CLAUDE_CONFIG_DIR');
    assert.deepEqual(fake.servers(home), DECLARED, 'the servers land in HOME/.claude.json');
    assert.ok(existsSync(join(home, '.claude', 'CLAUDE.md')), 'the files still go to HOME/.claude');
  });

  test('AC-1 treats an explicit --target that is the default directory as the default one, and so registers in HOME/.claude.json', () => {
    const repoDir = makeRepo({ servers: DECLARED });
    const home = fresh('home');
    const target = join(home, '.claude');
    fake.reset();
    const r = run(repoDir, target, [], { home });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fake.calls().length > 0);
    assert.ok(fake.calls().every((c) => c.configDir === null), 'CLAUDE_CONFIG_DIR must not point at the default directory');
    assert.deepEqual(fake.servers(home), DECLARED, 'the servers land in HOME/.claude.json, where Claude Code reads them');
    assert.deepEqual(fake.servers(target), {}, 'and not in <target>/.claude.json');
    assert.ok(existsSync(join(target, 'CLAUDE.md')));
    fake.reset();
    const check = run(repoDir, target, ['--check'], { home });
    assert.equal(check.status, 0, check.stdout);
    assert.deepEqual(fake.mcpCalls(), []);
  });

  test('AC-1 recognises the default directory when ~/.claude is a symbolic link to the --target', () => {
    const repoDir = makeRepo({ servers: DECLARED });
    const home = fresh('home');
    const target = fresh('claude-dir');
    symlinkSync(target, join(home, '.claude'));
    fake.reset();
    const r = run(repoDir, target, [], { home });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fake.calls().length > 0);
    assert.ok(fake.calls().every((c) => c.configDir === null));
    assert.deepEqual(fake.servers(home), DECLARED);
  });

  test('AC-1 needs no claude when no server is declared', () => {
    const repoDir = makeRepo();
    const target = fresh('target');
    const noClaude = { PATH: fresh('empty-path') };
    const install = run(repoDir, target, [], { env: noClaude });
    assert.equal(install.status, 0, install.stderr);
    assert.equal(run(repoDir, target, ['--check'], { env: noClaude }).status, 0);
    assert.doesNotMatch(install.stdout, /MCP/);
  });
});

describe('AC-2 reports and repairs drift', () => {
  const registered = (target, servers) => fake.seed(target, servers);

  test('AC-2 --check names a server that differs in command, args or env, or is missing, and changes nothing', () => {
    const repoDir = makeRepo({ servers: DECLARED });
    const cases = {
      command: { ...REVIEWER, command: 'node' },
      args: { ...REVIEWER, args: ['-y', 'codex-subagent-mcp@^0.3.0'] },
      env: { ...REVIEWER, env: { ...REVIEWER.env, CODEX_SUBAGENT_MAX_SANDBOX: 'workspace-write' } },
      'an extra env key': { ...REVIEWER, env: { ...REVIEWER.env, CODEX_BIN: '/somewhere/codex' } },
    };
    for (const [what, wrong] of Object.entries(cases)) {
      const target = fresh('target');
      registered(target, { 'codex-reviewer': wrong, 'codex-implementer': IMPLEMENTER });
      fake.reset();
      const r = run(repoDir, target, ['--check']);
      assert.equal(r.status, 1, `${what}: ${r.stdout}`);
      assert.match(r.stdout, /mcp server differs: codex-reviewer/, what);
      assert.doesNotMatch(r.stdout, /codex-implementer/, `${what}: the matching server is not drift`);
      assert.deepEqual(fake.mcpCalls(), [], `${what}: --check must not run claude mcp`);
      assert.deepEqual(fake.servers(target)['codex-reviewer'], wrong, `${what}: --check must not write`);
    }
    const target = fresh('target');
    registered(target, { 'codex-reviewer': REVIEWER });
    const missing = run(repoDir, target, ['--check']);
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /mcp server missing: codex-implementer/);
  });

  test('AC-2 replaces a differing registration by removing it and adding it again, in that order, and --check then exits 0', () => {
    const repoDir = makeRepo({ servers: DECLARED });
    const target = fresh('target');
    registered(target, { 'codex-reviewer': { ...REVIEWER, args: ['-y', 'codex-subagent-mcp@^0.3.0'] }, 'codex-implementer': IMPLEMENTER });
    fake.reset();
    const r = run(repoDir, target);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(writesOf('codex-reviewer'), ['remove', 'add-json']);
    assert.deepEqual(writesOf('codex-implementer'), [], 'a matching server is not touched');
    assert.match(r.stdout, /Replaced MCP server codex-reviewer/);
    assert.equal(run(repoDir, target, ['--check']).status, 0);
  });

  test('AC-2 copies the registration it replaces or removes into the backup directory first', () => {
    const repoDir = makeRepo({ servers: DECLARED, retired: ['old-server'] });
    const target = fresh('target');
    const previous = { ...REVIEWER, env: { ...REVIEWER.env, CODEX_BIN: '/my/codex' } };
    const old = { type: 'stdio', command: 'old', args: [] };
    registered(target, { 'codex-reviewer': previous, 'old-server': old });
    assert.equal(run(repoDir, target).status, 0);
    const root = join(target, 'backups', 'claude-workflow');
    assert.ok(existsSync(root), 'the installer made no backup');
    const saved = readdirSync(root)
      .map((stamp) => join(root, stamp, 'mcp-servers.json'))
      .filter(existsSync)
      .map((file) => JSON.parse(readFileSync(file, 'utf8')));
    assert.equal(saved.length, 1, 'one backup of the registrations that were replaced or removed');
    assert.deepEqual(saved[0], { 'codex-reviewer': previous, 'old-server': old });
  });

  test('AC-2 says that a server is not registered when adding it fails after it was removed, and still installs the rest', () => {
    const repoDir = makeRepo({ servers: DECLARED });
    const target = fresh('target');
    registered(target, { 'codex-reviewer': { ...REVIEWER, command: 'node' } });
    fake.reset();
    const r = run(repoDir, target, [], { env: fake.env({ FAKE_CLAUDE_FAIL: 'add:codex-reviewer' }) });
    assert.equal(r.status, 1, 'a registration that was tried and failed is a failed install');
    assert.match(r.stdout + r.stderr, /codex-reviewer/);
    assert.match(r.stdout + r.stderr, /not registered/i);
    assert.equal('codex-reviewer' in fake.servers(target), false);
    assert.deepEqual(fake.servers(target)['codex-implementer'], IMPLEMENTER, 'the other server is still registered');
    assert.ok(existsSync(join(target, 'CLAUDE.md')), 'the files are installed whatever happens to the servers');
  });
});

describe('AC-3 keeps machine values out of the shared file', () => {
  test('AC-3 merges the env of personal/mcp-servers.json over the generic env, key by key', () => {
    const personal = { 'codex-reviewer': { env: { CODEX_BIN: '/my/codex', CODEX_SUBAGENT_DEFAULT_MODEL: 'm2' } } };
    const repoDir = makeRepo({ servers: DECLARED, personal });
    const target = fresh('target');
    const r = run(repoDir, target);
    assert.equal(r.status, 0, r.stderr);
    assert.ok('codex-reviewer' in fake.servers(target), 'codex-reviewer was not registered');
    assert.deepEqual(fake.servers(target)['codex-reviewer'].env, {
      CODEX_SUBAGENT_DEFAULT_MODEL: 'm2',
      CODEX_SUBAGENT_MAX_SANDBOX: 'read-only',
      CODEX_BIN: '/my/codex',
    });
    assert.deepEqual(fake.servers(target)['codex-implementer'], IMPLEMENTER);
    assert.equal(run(repoDir, target, ['--check']).status, 0, 'the merged result is the desired state');
  });

  test('AC-3 ignores a name in the personal file that is not declared, and says so', () => {
    const repoDir = makeRepo({ servers: DECLARED, personal: { 'codex-reviwer': { env: { CODEX_BIN: '/x' } } } });
    const target = fresh('target');
    const r = run(repoDir, target);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /codex-reviwer/);
    assert.deepEqual(Object.keys(fake.servers(target)).sort(), ['codex-implementer', 'codex-reviewer']);
  });

  test('AC-3 the shipped global/mcp-servers.json holds no absolute path and no user directory', () => {
    const file = join(repo, 'global', 'mcp-servers.json');
    assert.ok(existsSync(file), 'global/mcp-servers.json is missing');
    const strings = [];
    const collect = (value) => {
      if (typeof value === 'string') strings.push(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    };
    collect(JSON.parse(readFileSync(file, 'utf8')));
    assert.ok(strings.length > 0);
    for (const s of strings) {
      assert.doesNotMatch(s, /^\//, `an absolute path: ${s}`);
      assert.doesNotMatch(s, /\/Users\/|\/home\//, `a user directory: ${s}`);
    }
  });
});

describe('AC-4 retires servers that no longer ship', () => {
  test('AC-4 removes a retired server that is registered, and --check reports it until then', () => {
    const repoDir = makeRepo({ servers: DECLARED, retired: ['old-server'] });
    const target = fresh('target');
    const mine = { type: 'stdio', command: 'dart', args: ['mcp-server'] };
    fake.seed(target, { 'old-server': { type: 'stdio', command: 'old', args: [] }, ft: mine, ...DECLARED });
    const before = run(repoDir, target, ['--check']);
    assert.equal(before.status, 1);
    assert.match(before.stdout, /retired mcp server still registered: old-server/);
    fake.reset();
    const r = run(repoDir, target);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(writesOf('old-server'), ['remove']);
    assert.match(r.stdout, /Removed MCP server old-server/);
    assert.equal('old-server' in fake.servers(target), false);
    assert.deepEqual(fake.servers(target).ft, mine, 'a server nobody listed stays');
    assert.equal(run(repoDir, target, ['--check']).status, 0);
  });

  test('AC-4 does nothing for a retired server that is not registered', () => {
    const repoDir = makeRepo({ servers: DECLARED, retired: ['old-server'] });
    const target = fresh('target');
    fake.seed(target, DECLARED);
    fake.reset();
    const r = run(repoDir, target);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fake.calls(), []);
    assert.equal(run(repoDir, target, ['--check']).status, 0);
  });
});

describe('AC-5 without a usable claude', () => {
  const noClaude = () => ({ PATH: fresh('empty-path') });

  test('AC-5 still installs the files, lists the servers it could not verify, and exits 0', () => {
    const repoDir = makeRepo({ servers: DECLARED });
    const target = fresh('target');
    const r = run(repoDir, target, [], { env: noClaude() });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(target, 'CLAUDE.md')));
    assert.match(r.stdout, /not verified/i);
    assert.match(r.stdout, /codex-reviewer/);
    assert.match(r.stdout, /codex-implementer/);
  });

  test('AC-5 --check exits 1 and says it cannot verify, which is not the same as drift', () => {
    const repoDir = makeRepo({ servers: DECLARED });
    const target = fresh('target');
    assert.equal(run(repoDir, target).status, 0);
    const r = run(repoDir, target, ['--check'], { env: noClaude() });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /cannot verify mcp servers/i);
    assert.match(r.stdout, /codex-reviewer/);
    assert.doesNotMatch(r.stdout, /mcp server differs|mcp server missing/);
  });
});

describe('AC-6 the shipped registrations', () => {
  const shipped = () => {
    const file = join(repo, 'global', 'mcp-servers.json');
    assert.ok(existsSync(file), 'global/mcp-servers.json is missing');
    return JSON.parse(readFileSync(file, 'utf8'));
  };
  test('AC-2 (#57) declares codex-reviewer and codex-implementer on exactly codex-subagent-mcp@0.5.0, and no codex-subagent', () => {
    const servers = shipped();
    assert.ok('codex-reviewer' in servers && 'codex-implementer' in servers);
    assert.equal('codex-subagent' in servers, false);
    const ranges = ['codex-reviewer', 'codex-implementer'].map((name) => {
      const s = servers[name];
      assert.equal(s.type, 'stdio', name);
      assert.equal(s.command, 'npx', name);
      assert.ok(s.args.includes('-y'), name);
      const pkg = s.args.filter((a) => a.startsWith('codex-subagent-mcp'));
      assert.equal(pkg.length, 1, name);
      assert.equal(pkg[0], 'codex-subagent-mcp@0.5.0', `${name}: an exact version, not a range (ADR 0017)`);
      return pkg[0];
    });
    assert.equal(ranges[0], ranges[1], 'both registrations run the same version');
  });

  test('AC-2 (#57) --check reports a registration installed on a caret range as drift from the shipped exact version', () => {
    const servers = shipped();
    const repoDir = makeRepo({ servers });
    const target = fresh('target');
    const onRange = (server) => ({ ...server, args: server.args.map((a) => (a.startsWith('codex-subagent-mcp@') ? 'codex-subagent-mcp@^0.5.0' : a)) });
    fake.seed(target, { 'codex-reviewer': onRange(servers['codex-reviewer']), 'codex-implementer': servers['codex-implementer'] });
    fake.reset();
    const r = run(repoDir, target, ['--check']);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /mcp server differs: codex-reviewer/);
    assert.doesNotMatch(r.stdout, /mcp server differs: codex-implementer/);
    assert.deepEqual(fake.mcpCalls(), [], '--check must not run claude mcp');
  });

  test('AC-6 gives the reviewer a read-only ceiling and the implementer a workspace-write one, with no default sandbox', () => {
    const servers = shipped();
    assert.equal(servers['codex-reviewer'].env.CODEX_SUBAGENT_MAX_SANDBOX, 'read-only');
    assert.equal(servers['codex-implementer'].env.CODEX_SUBAGENT_MAX_SANDBOX, 'workspace-write');
    for (const name of ['codex-reviewer', 'codex-implementer']) {
      assert.equal('CODEX_SUBAGENT_DEFAULT_SANDBOX' in servers[name].env, false, `${name}: a write must be an explicit argument`);
    }
  });

  test('AC-6 turns off inherited MCP servers, plugins and apps, and caps and sets the effort, in both', () => {
    const servers = shipped();
    for (const name of ['codex-reviewer', 'codex-implementer']) {
      const env = servers[name].env;
      assert.equal(env.CODEX_SUBAGENT_MCP_SERVERS, 'none', name);
      assert.equal(env.CODEX_SUBAGENT_PLUGINS, 'none', name);
      assert.equal(env.CODEX_SUBAGENT_APPS, 'off', name);
      assert.equal(env.CODEX_SUBAGENT_MAX_EFFORT, 'high', name);
      assert.equal(env.CODEX_SUBAGENT_DEFAULT_EFFORT, 'high', name);
      assert.ok(env.CODEX_SUBAGENT_DEFAULT_MODEL, `${name}: a default model`);
      assert.equal('CODEX_BIN' in env, false, `${name}: CODEX_BIN is a machine value, it belongs in personal/`);
    }
  });
});

// Issue #57 (ADR 0017) narrows AC-7: codex_job_status is no longer allowed, so a status poll asks, and the
// rules are derived at install time from global/mcp-servers.json instead of being written in global/settings.json.
describe('AC-7 permissions for the tools that spend no quota', () => {
  const NO_QUOTA = ['codex_doctor', 'list_codex_models', 'codex_recommend', 'codex_job_result', 'codex_job_cancel'];
  const SERVERS = ['codex-reviewer', 'codex-implementer'];

  const assertRules = (allow) => {
    for (const server of SERVERS) {
      for (const tool of NO_QUOTA) assert.ok(allow.includes(`mcp__${server}__${tool}`), `mcp__${server}__${tool}`);
      assert.ok(!allow.includes(`mcp__${server}__codex_delegate`), `${server}: codex_delegate asks every time`);
      assert.ok(!allow.includes(`mcp__${server}__codex_follow_up`), `${server}: codex_follow_up asks every time`);
      assert.ok(!allow.includes(`mcp__${server}__codex_job_status`), `${server}: codex_job_status asks every time (#57)`);
      assert.ok(!allow.includes(`mcp__${server}`), `${server}: the whole server is not allowed`);
    }
    assert.ok(!allow.some((rule) => rule.startsWith('mcp__codex-subagent')), 'no rule for the old name');
  };

  test('AC-7 (#57) an install of this repository leaves the five rules of each server in settings.json, and none that delegates or polls', () => {
    const target = fresh('target');
    const r = run(repo, target);
    assert.equal(r.status, 0, r.stderr);
    const installed = JSON.parse(readFileSync(join(target, 'settings.json'), 'utf8'));
    assertRules(installed.permissions?.allow ?? []);
  });
});

describe('AC-3 (#57) codex_job_status leaves the allow list', () => {
  const STATUS = ['mcp__codex-reviewer__codex_job_status', 'mcp__codex-implementer__codex_job_status'];

  test('AC-3 (#57) global/retired-permissions.json retires both codex_job_status rules from the allow list', () => {
    const retired = JSON.parse(readFileSync(join(repo, 'global', 'retired-permissions.json'), 'utf8'));
    for (const rule of STATUS) assert.ok((retired.allow ?? []).includes(rule), `${rule} is not retired`);
  });

  test('AC-3 (#57) an install over settings that allow codex_job_status removes it and keeps the other no-quota tools and the user\'s rules', () => {
    const target = fresh('target');
    writeFileSync(join(target, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(make:*)', ...STATUS] } }));
    const r = run(repo, target);
    assert.equal(r.status, 0, r.stderr);
    const allow = JSON.parse(readFileSync(join(target, 'settings.json'), 'utf8')).permissions?.allow ?? [];
    for (const rule of STATUS) assert.ok(!allow.includes(rule), `${rule} is still allowed`);
    for (const server of ['codex-reviewer', 'codex-implementer']) {
      for (const tool of ['codex_doctor', 'list_codex_models', 'codex_recommend', 'codex_job_result', 'codex_job_cancel']) {
        assert.ok(allow.includes(`mcp__${server}__${tool}`), `mcp__${server}__${tool}`);
      }
      for (const tool of ['codex_delegate', 'codex_follow_up']) assert.ok(!allow.includes(`mcp__${server}__${tool}`), `mcp__${server}__${tool}`);
    }
    assert.ok(allow.includes('Bash(make:*)'), 'a rule the user added is kept');
  });
});

// Issue #57 (ADR 0017): global/mcp-servers.json is the one list of Codex registrations. The installer derives
// from it the allow rules for the tools that spend no quota and the matcher of the guard-codex hook, so a
// registration is added in that file alone. The repository here copies the real global/settings.json and
// declares no codex-reviewer or codex-implementer, so any rule or coverage for those names was written by hand.
describe('AC-4 (#57) Codex rules derived from global/mcp-servers.json', () => {
  const NO_QUOTA = ['codex_doctor', 'list_codex_models', 'codex_recommend', 'codex_job_result', 'codex_job_cancel'];
  const SERVERS = {
    'codex-auditor': { type: 'stdio', command: 'npx', args: ['-y', 'codex-subagent-mcp@0.5.0'], env: { CODEX_SUBAGENT_MAX_SANDBOX: 'read-only' } },
    my_codex2: { type: 'stdio', command: '/opt/tools/codex-subagent-mcp/build/index.js', args: [], env: { CODEX_SUBAGENT_MAX_SANDBOX: 'workspace-write' } },
    other: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@0.0.83'] },
  };
  const DERIVED = ['codex-auditor', 'my_codex2'];

  let installed;
  const setup = () => {
    if (installed) return installed;
    const repoDir = makeRepo({ servers: SERVERS });
    copyFileSync(join(repo, 'global', 'settings.json'), join(repoDir, 'global', 'settings.json'));
    const target = fresh('target');
    const r = run(repoDir, target);
    assert.equal(r.status, 0, r.stderr);
    installed = JSON.parse(readFileSync(join(target, 'settings.json'), 'utf8'));
    return installed;
  };
  const matcher = () => {
    const entries = (setup().hooks?.PreToolUse ?? []).filter((entry) => (entry.hooks ?? []).some((h) => (h.command ?? '').includes('guard-codex.mjs')));
    assert.equal(entries.length, 1, 'guard-codex.mjs must be registered once under PreToolUse');
    return new RegExp(`^(?:${entries[0].matcher})$`);
  };

  test('AC-4 (#57) allows exactly the five no-quota tools of each declared Codex registration, from the command or the args form', () => {
    const rules = (setup().permissions?.allow ?? []).filter((rule) => rule.startsWith('mcp__')).sort();
    const expected = DERIVED.flatMap((name) => NO_QUOTA.map((tool) => `mcp__${name}__${tool}`)).sort();
    assert.deepEqual(rules, expected);
  });

  test('AC-4 (#57) the guard-codex matcher covers codex_delegate and codex_follow_up of each declared Codex registration, and nothing else of them', () => {
    const re = matcher();
    for (const name of DERIVED) {
      for (const tool of ['codex_delegate', 'codex_follow_up']) assert.match(`mcp__${name}__${tool}`, re);
      for (const tool of [...NO_QUOTA, 'codex_job_status']) assert.doesNotMatch(`mcp__${name}__${tool}`, re);
    }
  });

  test('AC-4 (#57) a server that is not codex-subagent-mcp, and a Codex name that is not declared, get no rule and no coverage', () => {
    const re = matcher();
    const allow = setup().permissions?.allow ?? [];
    for (const name of ['other', 'codex-reviewer', 'codex-implementer', 'codex-auditor-x']) {
      assert.ok(!allow.some((rule) => rule.startsWith(`mcp__${name}__`)), `${name} has an allow rule`);
      for (const tool of ['codex_delegate', 'codex_follow_up']) assert.doesNotMatch(`mcp__${name}__${tool}`, re, name);
    }
    for (const other of ['Bash', 'Edit', 'mcp__codex__codex_delegate']) assert.doesNotMatch(other, re);
  });
});

// A remote server is its type, url and headers, so a change in the url or the headers alone is drift
// that an install repairs, while a missing and an empty headers object compare equal.
describe('AC-2 remote servers differ by url and headers', () => {
  const REMOTE = { type: 'http', url: 'http://127.0.0.1:64342/stream' };
  const WITH_HEADERS = { type: 'http', url: 'http://127.0.0.1:9000/mcp', headers: { 'X-A': '1', 'X-B': '2' } };
  const SERVERS = { remote: REMOTE, guarded: WITH_HEADERS };

  test('--check names a server whose url or headers changed under the same type, and changes nothing', () => {
    const repoDir = makeRepo({ servers: SERVERS });
    const cases = {
      url: { remote: { ...REMOTE, url: 'http://127.0.0.1:64343/stream' }, guarded: WITH_HEADERS },
      'a header value': { remote: REMOTE, guarded: { ...WITH_HEADERS, headers: { 'X-A': '1', 'X-B': '3' } } },
      'a missing header': { remote: REMOTE, guarded: { ...WITH_HEADERS, headers: { 'X-A': '1' } } },
      'an extra header': { remote: { ...REMOTE, headers: { Authorization: 'x' } }, guarded: WITH_HEADERS },
    };
    for (const [what, seeded] of Object.entries(cases)) {
      const target = fresh('target');
      assert.equal(run(repoDir, target).status, 0, `${what}: the files are installed first`);
      fake.seed(target, seeded);
      fake.reset();
      const r = run(repoDir, target, ['--check']);
      assert.equal(r.status, 1, `${what}: ${r.stdout}`);
      const differs = [...r.stdout.matchAll(/mcp server differs: (\S+)/g)].map((m) => m[1]);
      assert.equal(differs.length, 1, `${what}: exactly one server differs: ${r.stdout}`);
      assert.deepEqual(fake.mcpCalls(), [], `${what}: --check must not run claude mcp`);
      assert.deepEqual(fake.servers(target), seeded, `${what}: --check must not write`);
    }
  });

  test('replaces a server whose url changed, and --check then exits 0', () => {
    const repoDir = makeRepo({ servers: SERVERS });
    const target = fresh('target');
    fake.seed(target, { remote: { ...REMOTE, url: 'http://127.0.0.1:64342/mcp' }, guarded: WITH_HEADERS });
    fake.reset();
    const r = run(repoDir, target);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(writesOf('remote'), ['remove', 'add-json']);
    assert.deepEqual(writesOf('guarded'), [], 'a matching server is not touched');
    assert.deepEqual(fake.servers(target).remote, REMOTE);
    assert.match(r.stdout, /Replaced MCP server remote/);
    assert.equal(run(repoDir, target, ['--check']).status, 0);
  });

  test('header order does not count, and missing headers equal empty ones', () => {
    const repoDir = makeRepo({ servers: SERVERS });
    const target = fresh('target');
    assert.equal(run(repoDir, target).status, 0, 'the files are installed first');
    fake.seed(target, { remote: { ...REMOTE, headers: {} }, guarded: { ...WITH_HEADERS, headers: { 'X-B': '2', 'X-A': '1' } } });
    fake.reset();
    const r = run(repoDir, target, ['--check']);
    assert.equal(r.status, 0, r.stdout);
    assert.deepEqual(fake.mcpCalls(), []);
  });
});

describe('the fake claude', () => {
  const hasClaude = spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0;

  test('behaves like the real CLI for add-json and remove (skipped where claude is not installed)', { skip: !hasClaude }, () => {
    const server = JSON.stringify({ type: 'stdio', command: 'echo', args: ['a'], env: { K: 'V' } });
    const outcome = (command, dir) => {
      const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
      const base = command === 'fake' ? { ...env, ...fake.env() } : env;
      const claude = command === 'fake' ? join(fake.bin, 'claude') : 'claude';
      const added = spawnSync(claude, ['mcp', 'add-json', 'demo', server, '-s', 'user'], { encoding: 'utf8', env: base });
      const after = fake.servers(dir);
      const removed = spawnSync(claude, ['mcp', 'remove', 'demo', '-s', 'user'], { encoding: 'utf8', env: base });
      return { added: added.status, registered: after.demo, removed: removed.status, left: fake.servers(dir).demo };
    };
    const real = outcome('real', fresh('real-config'));
    const fakeOutcome = outcome('fake', fresh('fake-config'));
    assert.deepEqual(fakeOutcome, real);
  });
});
