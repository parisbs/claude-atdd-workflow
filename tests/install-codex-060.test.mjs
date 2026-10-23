// Issue #50: codex-subagent-mcp 0.6.0 starts offline-first from an exact version, and the registrations adopt
// its ceilings. The behaviour tests run the real installer against a throwaway repository with the fake
// `claude` and the fake `npx` first on PATH (tests/fake-claude.mjs), so the cache prewarm never reaches the
// network; the static tests read the files this repository ships. AC-10 (`codex_doctor` after installing and
// restarting) is a manual check, and AC-3 is a manual probe whose record these tests only find.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeClaude } from './fake-claude.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'cw-codex060-'));
const fake = fakeClaude(join(scratch, 'fake'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const read = (path) => {
  assert.ok(existsSync(join(repo, path)), `${path} is missing`);
  return readFileSync(join(repo, path), 'utf8');
};
const shipped = () => JSON.parse(read('global/mcp-servers.json'));
const NAMES = ['codex-reviewer', 'codex-implementer'];
const packageOf = (server) => server.args.find((a) => a.startsWith('codex-subagent-mcp@'));

// One sentence or one list item at a time, as in task-package.test.mjs.
const sentences = (text) =>
  text
    .split(/\n\s*(?:[-*]|\d+\.)\s+|\n\s*\n/)
    .flatMap((chunk) => chunk.replace(/\s+/g, ' ').split(/[.!?](?:\s|$)/))
    .map((sentence) => sentence.trim())
    .filter(Boolean);
const says = (text, ...patterns) =>
  assert.ok(sentences(text).some((s) => patterns.every((p) => p.test(s))), `no single sentence matches all of ${patterns.join(' and ')}`);

let counter = 0;
const fresh = (label) => mkdtempSync(join(scratch, `${label}-${(counter += 1)}-`));

function makeRepo(servers) {
  const dir = fresh('repo');
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'global'));
  copyFileSync(join(repo, 'scripts', 'install.mjs'), join(dir, 'scripts', 'install.mjs'));
  writeFileSync(join(dir, 'global', 'CLAUDE.md'), 'x\n');
  writeFileSync(join(dir, 'global', 'settings.json'), '{}');
  writeFileSync(join(dir, 'global', 'mcp-servers.json'), JSON.stringify(servers));
  return dir;
}

function run(repoDir, target, args = [], extra = {}) {
  const env = { ...process.env, ...fake.env(extra) };
  delete env.CLAUDE_CONFIG_DIR;
  return spawnSync(process.execPath, [join(repoDir, 'scripts', 'install.mjs'), '--target', target, ...args], { encoding: 'utf8', env });
}

const PKG = 'codex-subagent-mcp@0.6.0';
const codex = (sandbox) => ({
  type: 'stdio',
  command: 'npx',
  args: ['--prefer-offline', '-y', PKG],
  env: { CODEX_SUBAGENT_DEFAULT_MODEL: 'm1', CODEX_SUBAGENT_MAX_SANDBOX: sandbox },
});
const DECLARED = { 'codex-reviewer': codex('read-only'), 'codex-implementer': codex('workspace-write') };
const PREWARM = ['--prefer-online', '-y', PKG];

describe('AC-1 (#50) the shipped registrations', () => {
  const COMMON = {
    CODEX_SUBAGENT_DEFAULT_MODEL: 'gpt-6.1-sol',
    CODEX_SUBAGENT_ALLOWED_MODELS: 'gpt-6-astra,gpt-6.1-sol',
    CODEX_SUBAGENT_DEFAULT_EFFORT: 'high',
    CODEX_SUBAGENT_MCP_SERVERS: 'none',
    CODEX_SUBAGENT_PLUGINS: 'none',
    CODEX_SUBAGENT_APPS: 'off',
    CODEX_SUBAGENT_MAX_BACKGROUND_JOBS: '2',
  };
  const EXPECTED = {
    'codex-reviewer': { ...COMMON, CODEX_SUBAGENT_MAX_EFFORT: 'high', CODEX_SUBAGENT_MAX_SANDBOX: 'read-only', CODEX_SUBAGENT_MAX_DELEGATIONS_PER_HOUR: '10' },
    'codex-implementer': { ...COMMON, CODEX_SUBAGENT_MAX_EFFORT: 'xhigh', CODEX_SUBAGENT_MAX_SANDBOX: 'workspace-write', CODEX_SUBAGENT_MAX_DELEGATIONS_PER_HOUR: '6' },
  };
  // The allowed list is a set: its order carries no meaning.
  const normalised = (env) => ({
    ...env,
    CODEX_SUBAGENT_ALLOWED_MODELS: (env.CODEX_SUBAGENT_ALLOWED_MODELS ?? '').split(',').map((m) => m.trim()).sort().join(','),
  });

  test('AC-1 (#50) both start offline-first on an exact 0.6.0 or later, with the environment the human decided', () => {
    const servers = shipped();
    for (const name of NAMES) {
      const [flag, yes, pkg, ...rest] = servers[name].args;
      assert.deepEqual([flag, yes, rest], ['--prefer-offline', '-y', []], name);
      const match = /^codex-subagent-mcp@(\d+)\.(\d+)\.(\d+)$/.exec(pkg);
      assert.ok(match, `${name}: ${pkg} is not an exact version`);
      const [major, minor] = match.slice(1).map(Number);
      assert.ok(major > 0 || minor >= 6, `${name}: the ceilings need 0.6.0 or later, found ${pkg}`);
      assert.deepEqual(normalised(servers[name].env), EXPECTED[name], name);
    }
  });

  test('AC-1 (#50) an install of this repository registers exactly the shipped servers, and --check then reports no drift', () => {
    const target = fresh('target');
    fake.reset();
    const r = run(repo, target);
    assert.equal(r.status, 0, r.stderr);
    const servers = shipped();
    const registered = fake.servers(target);
    for (const name of NAMES) assert.deepEqual(registered[name], servers[name], name);
    const check = run(repo, target, ['--check']);
    assert.equal(check.status, 0, check.stdout);
  });
});

describe('AC-2 (#50) the installer prewarms the npx cache when a registration changes', () => {
  test('AC-2 (#50) two new registrations of one package prewarm it once, with --prefer-online and standard input closed', () => {
    const repoDir = makeRepo(DECLARED);
    const target = fresh('target');
    fake.reset();
    const r = run(repoDir, target);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fake.npxCalls(), [{ argv: PREWARM, stdinClosed: true }]);
  });

  test('AC-2 (#50) replacing one registration prewarms its package once', () => {
    const repoDir = makeRepo(DECLARED);
    const target = fresh('target');
    fake.seed(target, { 'codex-reviewer': { ...DECLARED['codex-reviewer'], env: { CODEX_SUBAGENT_MAX_SANDBOX: 'read-only' } }, 'codex-implementer': DECLARED['codex-implementer'] });
    fake.reset();
    const r = run(repoDir, target);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Replaced MCP server codex-reviewer/);
    assert.deepEqual(fake.npxCalls(), [{ argv: PREWARM, stdinClosed: true }]);
  });

  test('AC-2 (#50) does not prewarm when no registration changes, nor under --check', () => {
    const repoDir = makeRepo(DECLARED);
    const target = fresh('target');
    assert.equal(run(repoDir, target).status, 0);
    fake.reset();
    const again = run(repoDir, target);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(fake.npxCalls(), [], 'nothing changed, so nothing to prewarm');

    const drifted = fresh('target');
    fake.seed(drifted, { 'codex-reviewer': { ...DECLARED['codex-reviewer'], env: {} } });
    fake.reset();
    const check = run(repoDir, drifted, ['--check']);
    assert.equal(check.status, 1, check.stdout);
    assert.deepEqual(fake.npxCalls(), [], '--check writes nothing and prewarms nothing');
  });

  test('AC-2 (#50) does not prewarm when every add fails', () => {
    const repoDir = makeRepo(DECLARED);
    const target = fresh('target');
    fake.reset();
    const r = run(repoDir, target, [], { FAKE_CLAUDE_FAIL: 'add:codex-reviewer,add:codex-implementer' });
    assert.equal(r.status, 1, 'a failed registration still fails the install');
    assert.deepEqual(fake.npxCalls(), []);
  });

  test('AC-2 (#50) prewarms only npx registrations of codex-subagent-mcp', () => {
    const repoDir = makeRepo({
      other: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@0.0.83'] },
      my_codex: { type: 'stdio', command: '/opt/tools/codex-subagent-mcp/build/index.js', args: [] },
    });
    const target = fresh('target');
    fake.reset();
    const r = run(repoDir, target);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Registered MCP server other/);
    assert.deepEqual(fake.npxCalls(), []);
  });

  for (const failure of ['exit', 'signal']) {
    test(`AC-2 (#50) a prewarm that fails by ${failure === 'exit' ? 'exit status' : 'a signal, as on a timeout'} is reported, and the install completes with status 0`, () => {
      const repoDir = makeRepo(DECLARED);
      const target = fresh('target');
      fake.reset();
      const r = run(repoDir, target, [], { FAKE_NPX_FAIL: failure });
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      assert.equal(fake.npxCalls().length, 1, 'the prewarm ran');
      assert.deepEqual(fake.servers(target), DECLARED, 'the registrations are in place');
      assert.ok(existsSync(join(target, 'CLAUDE.md')), 'the files are installed');
      const lines = `${r.stdout}\n${r.stderr}`.split('\n');
      assert.ok(
        lines.some((line) => /prewarm/i.test(line) && line.includes(PKG) && /\b(fail|failed|not)\b/i.test(line)),
        `no line reports that ${PKG} was not prewarmed:\n${r.stdout}\n${r.stderr}`,
      );
    });
  }
});

describe('AC-3 (#50) the network probe is recorded', () => {
  test('AC-3 (#50) docs/experiments holds an npx --loglevel=http probe of the pinned version with --prefer-offline', () => {
    const version = packageOf(shipped()['codex-reviewer']).split('@')[1];
    const dir = join(repo, 'docs', 'experiments');
    const probes = readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => readFileSync(join(dir, f), 'utf8'));
    assert.ok(
      probes.some((text) => text.includes('--loglevel=http') && text.includes('--prefer-offline') && text.includes(`codex-subagent-mcp@${version}`)),
      'no probe in docs/experiments covers the pinned version',
    );
  });
});

describe('AC-4 (#50) codex_usage spends no quota', () => {
  test('AC-4 (#50) an install of this repository allows codex_usage on each registration, and codex_delegate, codex_follow_up and codex_job_status still ask', () => {
    const target = fresh('target');
    const r = run(repo, target);
    assert.equal(r.status, 0, r.stderr);
    const allow = JSON.parse(readFileSync(join(target, 'settings.json'), 'utf8')).permissions?.allow ?? [];
    for (const name of NAMES) {
      assert.ok(allow.includes(`mcp__${name}__codex_usage`), `mcp__${name}__codex_usage`);
      for (const tool of ['codex_delegate', 'codex_follow_up', 'codex_job_status']) {
        assert.ok(!allow.includes(`mcp__${name}__${tool}`), `mcp__${name}__${tool} must ask`);
      }
    }
  });
});

describe('AC-6 (#50) the shipped environment is coherent', () => {
  const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const models = (env) => env.CODEX_SUBAGENT_ALLOWED_MODELS.split(',').map((m) => m.trim()).sort();

  test('AC-6 (#50) the default model is allowed, and the model, the allowed list and the default effort are the same in both', () => {
    const servers = shipped();
    for (const name of NAMES) {
      const env = servers[name].env;
      assert.ok(env.CODEX_SUBAGENT_ALLOWED_MODELS, `${name}: an allowed list`);
      assert.ok(models(env).every(Boolean), `${name}: an empty entry is a configuration error`);
      assert.ok(models(env).includes(env.CODEX_SUBAGENT_DEFAULT_MODEL), `${name}: the default model is not allowed`);
    }
    const [a, b] = NAMES.map((name) => servers[name].env);
    assert.equal(a.CODEX_SUBAGENT_DEFAULT_MODEL, b.CODEX_SUBAGENT_DEFAULT_MODEL);
    assert.deepEqual(models(a), models(b));
    assert.equal(a.CODEX_SUBAGENT_DEFAULT_EFFORT, b.CODEX_SUBAGENT_DEFAULT_EFFORT);
  });

  test('AC-6 (#50) each default effort is within its ceiling, and the delegation and background-job ceilings are valid integers', () => {
    const servers = shipped();
    for (const name of NAMES) {
      const env = servers[name].env;
      const effort = EFFORTS.indexOf(env.CODEX_SUBAGENT_DEFAULT_EFFORT);
      const ceiling = EFFORTS.indexOf(env.CODEX_SUBAGENT_MAX_EFFORT);
      assert.ok(effort >= 0 && ceiling >= 0, `${name}: unknown effort level`);
      assert.ok(effort <= ceiling, `${name}: the default effort is above the ceiling`);
      assert.match(env.CODEX_SUBAGENT_MAX_DELEGATIONS_PER_HOUR ?? '', /^[1-9]\d*$/, `${name}: delegations per hour`);
      assert.match(env.CODEX_SUBAGENT_MAX_BACKGROUND_JOBS ?? '', /^[1-8]$/, `${name}: background jobs from 1 to 8`);
    }
  });
});

describe('AC-7 (#50) codex.md explains web_search and label', () => {
  const doc = () => read('global/skills/task-package/codex.md');

  test('AC-7 (#50) web_search is set to true only for explicit research', () => {
    says(doc(), /web_search/, /\btrue\b/, /\bonly\b/i, /research/i);
  });

  test('AC-7 (#50) omitting web_search keeps the Codex configuration instead of disabling search', () => {
    says(doc(), /web_search/, /\b(omit|omitted|omitting|omits)\b/i, /\b(configuration|config)\b/i, /\b(keeps|kept|applies|own)\b/i);
  });

  test('AC-7 (#50) a review guaranteed without search needs search disabled in the user\'s Codex configuration', () => {
    says(doc(), /\breview/i, /\bsearch\b/i, /\b(disabled|disable|off)\b/i, /\b(configuration|config)\b/i);
  });

  test('AC-7 (#50) label is a tag kept only in the local usage log', () => {
    says(doc(), /\blabel\b/, /\b(usage log|local log)\b/i);
  });
});

describe('AC-8 (#50) the machine values stay personal', () => {
  test('AC-8 (#50) the personal example shows CODEX_BIN and CODEX_SUBAGENT_USAGE_LOG for both registrations', () => {
    const example = JSON.parse(read('personal/mcp-servers.example.json'));
    for (const name of NAMES) {
      const env = example[name]?.env ?? {};
      assert.ok(env.CODEX_BIN, `${name}: CODEX_BIN, not empty`);
      assert.ok('CODEX_SUBAGENT_USAGE_LOG' in env, `${name}: CODEX_SUBAGENT_USAGE_LOG`);
    }
  });

  test('AC-8 (#50) the README calls them optional and warns that CODEX_BIN must not be left empty', () => {
    const readme = read('README.md');
    says(readme, /CODEX_SUBAGENT_USAGE_LOG/, /\boptional\b/i);
    says(readme, /CODEX_BIN/, /\bempty\b/i, /\b(never|not|no|must not)\b/i);
  });
});

describe('AC-9 (#50) the README documents the pin and the environment', () => {
  test('AC-9 (#50) names the shipped version and no other version of the package', () => {
    const readme = read('README.md');
    const pkg = packageOf(shipped()['codex-reviewer']);
    assert.ok(readme.includes(pkg), `README does not name ${pkg}`);
    const named = [...readme.matchAll(/codex-subagent-mcp@\d+\.\d+\.\d+/g)].map((m) => m[0]);
    assert.deepEqual([...new Set(named)], [pkg], 'the README names another version');
  });

  test('AC-9 (#50) names every environment variable the registrations set', () => {
    const readme = read('README.md');
    const servers = shipped();
    const keys = new Set(NAMES.flatMap((name) => Object.keys(servers[name].env)));
    for (const key of keys) assert.ok(readme.includes(key), `README does not document ${key}`);
  });
});
