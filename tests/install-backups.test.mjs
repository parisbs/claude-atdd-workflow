// Issue #42 (ADR 0027): the installer keeps what it overwrites or removes in one JSON bundle per install,
// in the XDG state directory and not under the target, trims the bundles of each target, lists and restores
// them, stops before taking over files it did not install, writes every file through a rename, and migrates
// the legacy manifest and backups. Every test runs the real installer from a throwaway repository, with a
// temporary target, HOME, XDG_STATE_HOME and working directory, and the fake `claude` first on PATH
// (tests/fake-claude.mjs). The bundle format and the messages below are the contract; how the installer
// reaches them is its own business. Stamps are read from the bundles, never built here.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { fakeClaude } from './fake-claude.mjs';
import { backupsDir, bundles, bundlesFor, textOf } from './state-home.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'cw-backups-'));
const fake = fakeClaude(join(scratch, 'fake'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
const fresh = (label) => mkdtempSync(join(scratch, `${label}-${(counter += 1)}-`));

const MANIFEST = '.claude-atdd-workflow-manifest.json';
const LEGACY_MANIFEST = '.claude-workflow-manifest.json';
// What the throwaway repository ships, by target path.
const SOURCE = {
  'CLAUDE.md': 'x\n',
  'hooks/demo-hook.mjs': '// demo hook\n',
  'skills/demo/SKILL.md': 'demo skill\n',
};
const OLD = { type: 'stdio', command: 'old-server', args: ['--v1'] };
const NEW = { type: 'stdio', command: 'new-server', args: ['--v2'] };

const put = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

// A repository with the installer and only the files a test declares. The hook ships with mode 0755.
function makeRepo({ servers, personal, extra = {} } = {}) {
  const dir = fresh('repo');
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(join(repo, 'scripts', 'install.mjs'), join(dir, 'scripts', 'install.mjs'));
  put(join(dir, 'global'), 'settings.json', '{}');
  for (const [rel, text] of Object.entries({ ...SOURCE, ...extra })) put(join(dir, 'global'), rel, text);
  chmodSync(join(dir, 'global', 'hooks', 'demo-hook.mjs'), 0o755);
  if (servers) put(join(dir, 'global'), 'mcp-servers.json', JSON.stringify(servers));
  if (personal) put(join(dir, 'personal'), 'settings.json', JSON.stringify(personal));
  return dir;
}

// Runs the installer of a throwaway repository on a target. `state` undefined leaves XDG_STATE_HOME unset.
function run(repoDir, target, args, { home, state, cwd }) {
  const env = { ...process.env, ...fake.env(), HOME: home };
  delete env.CLAUDE_CONFIG_DIR;
  if (state === undefined) delete env.XDG_STATE_HOME;
  else env.XDG_STATE_HOME = state;
  return spawnSync(process.execPath, [join(repoDir, 'scripts', 'install.mjs'), '--target', target, ...args], { encoding: 'utf8', env, cwd });
}

// A repository, a HOME, a state directory and a working directory of their own, and an installer bound to them.
function world(options) {
  const w = { repoDir: makeRepo(options), home: fresh('home'), state: fresh('state'), cwd: fresh('cwd') };
  w.install = (target, ...args) => run(w.repoDir, target, args, w);
  w.bundles = (target) => bundlesFor(target, w.state);
  return w;
}

// Edits the installed CLAUDE.md and installs again, so the install overwrites it.
const overwrite = (w, target, text, ...args) => {
  writeFileSync(join(target, 'CLAUDE.md'), text);
  const r = w.install(target, ...args);
  assert.equal(r.status, 0, r.stderr);
  return r;
};

// An installed target, the first install done.
const installed = (w, settings) => {
  const target = fresh('target');
  if (settings !== undefined) writeFileSync(join(target, 'settings.json'), settings);
  const r = w.install(target);
  assert.equal(r.status, 0, r.stderr);
  return target;
};

// Every file under a directory, as POSIX paths relative to it.
function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .filter((rel) => statSync(join(dir, rel)).isFile())
    .map((rel) => rel.split(sep).join('/'))
    .sort();
}

// Every path under a directory with its mode, and for a file its content and modification time, so a run
// that writes anything there, even the same bytes, shows up. null for a directory that does not exist.
function snapshot(dir) {
  if (!existsSync(dir)) return null;
  const out = {};
  for (const rel of readdirSync(dir, { recursive: true }).sort()) {
    const path = join(dir, rel);
    const st = statSync(path, { bigint: true });
    out[rel] = st.isDirectory() ? ['dir', st.mode] : [st.mode, st.mtimeNs, readFileSync(path).toString('base64')];
  }
  return out;
}

const writeLegacyManifest = (target, fileList = Object.keys(SOURCE), personalHooks = {}) => {
  writeFileSync(join(target, LEGACY_MANIFEST), JSON.stringify({ files: [...fileList].sort(), personalHooks }));
};

// Turns an installed target into one an installer before #42 left: the manifest under its legacy name.
const toLegacy = (target, fileList) => {
  rmSync(join(target, MANIFEST), { force: true });
  writeLegacyManifest(target, fileList);
};

const legacyRoot = (target) => join(target, 'backups', 'claude-workflow');
const settingsOf = (target) => JSON.parse(readFileSync(join(target, 'settings.json'), 'utf8'));
const manifestOf = (target) => JSON.parse(readFileSync(join(target, MANIFEST), 'utf8'));
const mcpWrites = () => fake.mcpCalls().filter((c) => ['add-json', 'remove'].includes(c.argv[1]));

describe('AC-1 one bundle per install in the state directory', () => {
  test('AC-1 a reinstall over an edited managed file writes exactly one bundle, mode 0600 in a 0700 directory, holding the edit and the target, and nothing under <target>/backups', () => {
    const w = world();
    const target = installed(w);
    overwrite(w, target, 'edited\n');
    const all = bundles(w.state);
    assert.equal(all.length, 1, 'one bundle for the one install that overwrote a file');
    const [bundle] = all;
    assert.equal(basename(bundle.file), `${bundle.stamp}.json`);
    assert.equal(statSync(bundle.file).mode & 0o777, 0o600);
    assert.equal(statSync(backupsDir(w.state)).mode & 0o777, 0o700);
    assert.equal(bundle.version, 1);
    assert.equal(bundle.legacy, false);
    assert.equal(bundle.target, realpathSync(target));
    assert.ok(!Number.isNaN(Date.parse(bundle.createdAt)), `createdAt is not a date: ${bundle.createdAt}`);
    assert.equal(textOf(bundle.files?.['CLAUDE.md']), 'edited\n');
    assert.equal(typeof bundle.files['CLAUDE.md'].mode, 'number');
    assert.equal(existsSync(join(target, 'backups')), false, 'nothing is written under <target>/backups');
  });

  test('AC-1 an install that overwrites and removes nothing writes no bundle, first into an empty target and then again', () => {
    const w = world();
    const target = installed(w);
    assert.deepEqual(bundles(w.state), [], 'the first install into an empty target overwrote nothing');
    const again = w.install(target);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(bundles(w.state), [], 'an install with nothing to change overwrote nothing');
    assert.equal(existsSync(join(target, 'backups')), false);
  });

  test('AC-1 a replaced MCP registration is saved in the bundle under mcpServers', () => {
    const w = world({ servers: { demo: NEW } });
    const target = fresh('target');
    fake.seed(target, { demo: OLD });
    const r = w.install(target);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fake.servers(target).demo, NEW, 'the registration was replaced');
    const saved = w.bundles(target);
    assert.equal(saved.length, 1, 'one bundle for the registration it replaced');
    assert.deepEqual(saved[0].mcpServers, { demo: OLD });
  });

  test('AC-1 with XDG_STATE_HOME unset or relative the bundle lands in HOME/.local/state/claude-atdd-workflow/backups and nothing is created under the working directory', () => {
    for (const [what, state] of [['unset', undefined], ['relative', 'relative-state']]) {
      const w = world();
      const options = { ...w, state };
      const target = fresh('target');
      assert.equal(run(w.repoDir, target, [], options).status, 0, what);
      writeFileSync(join(target, 'CLAUDE.md'), 'edited\n');
      const r = run(w.repoDir, target, [], options);
      assert.equal(r.status, 0, `${what}: ${r.stderr}`);
      const saved = bundlesFor(target, join(w.home, '.local', 'state'));
      assert.equal(saved.length, 1, `${what}: the bundle is under HOME/.local/state`);
      assert.equal(textOf(saved[0].files?.['CLAUDE.md']), 'edited\n', what);
      assert.deepEqual(readdirSync(w.cwd), [], `${what}: nothing is created under the working directory`);
    }
  });
});

describe('AC-2 retention per target', () => {
  test('AC-2 by default a target keeps its 10 most recent bundles', () => {
    const w = world();
    const target = installed(w);
    for (let i = 1; i <= 11; i += 1) overwrite(w, target, `edit ${i}\n`);
    const kept = w.bundles(target).map((b) => textOf(b.files?.['CLAUDE.md'])).sort();
    const latest = Array.from({ length: 10 }, (_, i) => `edit ${i + 2}\n`).sort();
    assert.deepEqual(kept, latest);
  });

  test('AC-2 --keep-backups 2 keeps the two latest bundles of the target, and the bundles of another target and the legacy ones', () => {
    const w = world();
    const target = fresh('target');
    put(join(legacyRoot(target), '2025-01-01T00-00-00-000Z'), 'CLAUDE.md', 'legacy\n');
    const first = w.install(target);
    assert.equal(first.status, 0, first.stderr);
    const other = installed(w);
    overwrite(w, other, 'other edit\n');
    for (let i = 1; i <= 3; i += 1) overwrite(w, target, `edit ${i}\n`);
    overwrite(w, target, 'edit 4\n', '--keep-backups', '2');
    const mine = w.bundles(target);
    const current = mine.filter((b) => !b.legacy).map((b) => textOf(b.files?.['CLAUDE.md'])).sort();
    assert.deepEqual(current, ['edit 3\n', 'edit 4\n']);
    const legacy = mine.filter((b) => b.legacy === true);
    assert.equal(legacy.length, 1, 'the legacy bundle is exempt from retention');
    assert.equal(textOf(legacy[0].files?.['CLAUDE.md']), 'legacy\n');
    const theirs = w.bundles(other);
    assert.equal(theirs.length, 1, 'the bundle of another target is kept');
    assert.equal(textOf(theirs[0].files?.['CLAUDE.md']), 'other edit\n');
  });

  test('AC-2 --keep-backups with a value that is not a positive integer exits 2 and writes nothing', () => {
    const w = world();
    const target = installed(w);
    overwrite(w, target, 'edit 1\n');
    writeFileSync(join(target, 'CLAUDE.md'), 'edit 2\n');
    for (const value of [['0'], ['-1'], ['abc'], ['1.5'], []]) {
      const before = { target: snapshot(target), state: snapshot(w.state) };
      const r = w.install(target, '--keep-backups', ...value);
      const what = value.length > 0 ? value[0] : 'no value';
      assert.equal(r.status, 2, `${what}: ${r.stdout}${r.stderr}`);
      assert.deepEqual({ target: snapshot(target), state: snapshot(w.state) }, before, `${what}: nothing is written`);
    }
    // The values above are refused for what they are: a positive integer is accepted.
    const valid = w.install(target, '--keep-backups', '1');
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(w.bundles(target).length, 1);
  });
});

describe('AC-3 --list-backups', () => {
  test('AC-3 --list-backups prints the backups directory and each bundle of the target with its stamp, date, legacy mark, files and MCP servers, and writes nothing', () => {
    const w = world({ servers: { demo: NEW } });
    const target = fresh('target');
    fake.seed(target, { demo: OLD });
    put(join(legacyRoot(target), '2025-01-01T00-00-00-000Z'), 'skills/x/SKILL.md', 'legacy skill\n');
    put(join(legacyRoot(target), '2025-02-01T00-00-00-000Z'), 'mcp-servers.json', JSON.stringify({ 'legacy-server': OLD }));
    const first = w.install(target);
    assert.equal(first.status, 0, first.stderr);
    overwrite(w, target, 'edited\n');
    const other = installed(w);
    overwrite(w, other, 'other edit\n');

    const before = { target: snapshot(target), state: snapshot(w.state) };
    fake.reset();
    const r = w.install(target, '--list-backups');
    assert.equal(r.status, 0, r.stderr);
    const dir = backupsDir(w.state);
    assert.ok(r.stdout.includes(dir) || r.stdout.includes(realpathSync(dir)), `the backups directory is printed:\n${r.stdout}`);
    const mine = w.bundles(target);
    assert.ok(mine.length >= 3, 'the setup made the bundles of the target');
    const pad = (n) => String(n).padStart(2, '0');
    for (const bundle of mine) {
      assert.ok(r.stdout.includes(bundle.stamp), `stamp ${bundle.stamp} is listed`);
      const at = new Date(bundle.createdAt);
      const local = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
      assert.ok(r.stdout.includes(bundle.createdAt.slice(0, 10)) || r.stdout.includes(local), `the date of ${bundle.stamp} is listed`);
      for (const path of Object.keys(bundle.files ?? {})) assert.ok(r.stdout.includes(path), `${path} is listed`);
      for (const name of Object.keys(bundle.mcpServers ?? {})) assert.ok(r.stdout.includes(name), `${name} is listed`);
    }
    assert.ok(mine.some((b) => b.legacy === true), 'the setup made a legacy bundle');
    assert.match(r.stdout, /legacy/i);
    for (const path of ['CLAUDE.md', 'skills/x/SKILL.md']) assert.ok(r.stdout.includes(path), path);
    for (const name of ['demo', 'legacy-server']) assert.ok(r.stdout.includes(name), name);
    for (const bundle of w.bundles(other)) assert.ok(!r.stdout.includes(bundle.stamp), 'a bundle of another target is not listed');
    assert.deepEqual({ target: snapshot(target), state: snapshot(w.state) }, before, '--list-backups writes nothing');
    assert.deepEqual(mcpWrites(), []);
  });
});

describe('AC-4 --restore', () => {
  test('AC-4 --restore brings back an overwritten file and a removed one, after saving what it overwrites in a new bundle', () => {
    const w = world({ extra: { 'skills/old/SKILL.md': 'old skill\n' } });
    const target = installed(w);
    rmSync(join(w.repoDir, 'global', 'skills', 'old'), { recursive: true });
    overwrite(w, target, 'edited\n');
    assert.equal(existsSync(join(target, 'skills', 'old', 'SKILL.md')), false, 'the file that no longer ships was removed');
    const [saved] = w.bundles(target);
    assert.ok(saved, 'the install made a bundle');
    const r = w.install(target, '--restore', saved.stamp);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(target, 'CLAUDE.md'), 'utf8'), 'edited\n');
    assert.equal(readFileSync(join(target, 'skills', 'old', 'SKILL.md'), 'utf8'), 'old skill\n');
    const fresher = w.bundles(target).filter((b) => b.stamp !== saved.stamp);
    assert.equal(fresher.length, 1, 'the restore saved what it overwrote in one new bundle');
    assert.equal(textOf(fresher[0].files?.['CLAUDE.md']), SOURCE['CLAUDE.md']);
  });

  test('AC-4 --restore puts an MCP registration back through claude', () => {
    const w = world({ servers: { demo: NEW } });
    const target = fresh('target');
    fake.seed(target, { demo: OLD });
    assert.equal(w.install(target).status, 0);
    assert.deepEqual(fake.servers(target).demo, NEW);
    const [saved] = w.bundles(target);
    assert.ok(saved, 'the install made a bundle');
    fake.reset();
    const r = w.install(target, '--restore', saved.stamp);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fake.servers(target).demo, OLD);
    assert.ok(mcpWrites().some((c) => c.argv[1] === 'add-json' && c.argv[2] === 'demo'), 'the registration went back through claude mcp add-json');
    const fresher = w.bundles(target).filter((b) => b.stamp !== saved.stamp);
    assert.equal(fresher.length, 1, 'the restore saved the registration it replaced');
    assert.deepEqual(fresher[0].mcpServers, { demo: NEW });
  });

  test('AC-4 --restore with an unknown stamp exits non-zero and changes nothing', () => {
    const w = world();
    const target = installed(w);
    overwrite(w, target, 'edited\n');
    const [saved] = w.bundles(target);
    assert.ok(saved, 'the install made a bundle');
    writeFileSync(join(target, 'CLAUDE.md'), 'edited again\n');
    const before = { target: snapshot(target), state: snapshot(w.state) };
    const r = w.install(target, '--restore', 'no-such-stamp');
    assert.notEqual(r.status, 0, r.stdout);
    assert.deepEqual({ target: snapshot(target), state: snapshot(w.state) }, before);
    // The refusal is about the stamp: the bundle that exists restores.
    assert.equal(w.install(target, '--restore', saved.stamp).status, 0);
  });

  test('AC-4 --restore with a bundle of another target exits non-zero and changes nothing', () => {
    const w = world();
    const target = installed(w);
    overwrite(w, target, 'edited\n');
    const other = installed(w);
    overwrite(w, other, 'other edit\n');
    const [theirs] = w.bundles(other);
    assert.ok(theirs, 'the other target has a bundle');
    writeFileSync(join(target, 'CLAUDE.md'), 'edited again\n');
    const before = { target: snapshot(target), other: snapshot(other), state: snapshot(w.state) };
    const r = w.install(target, '--restore', theirs.stamp);
    assert.notEqual(r.status, 0, r.stdout);
    assert.deepEqual({ target: snapshot(target), other: snapshot(other), state: snapshot(w.state) }, before);
    // The refusal is about the target: the bundle of this target restores.
    const [mine] = w.bundles(target);
    assert.ok(mine, 'this target has a bundle');
    assert.equal(w.install(target, '--restore', mine.stamp).status, 0);
  });
});

describe('AC-5 files the installer did not put there', () => {
  // A target with its own CLAUDE.md and skill under planned names, no manifest, and settings an install rewrites.
  const foreign = () => {
    const target = fresh('target');
    put(target, 'CLAUDE.md', 'my own instructions\n');
    put(target, 'skills/demo/SKILL.md', 'my own skill\n');
    writeFileSync(join(target, 'settings.json'), '{"theme":"dark"}');
    return target;
  };

  test('AC-5 an install over files with planned names that it did not install exits 2, lists them, and writes nothing', () => {
    const w = world({ servers: { demo: NEW } });
    const target = foreign();
    const before = snapshot(target);
    fake.reset();
    const r = w.install(target);
    assert.equal(r.status, 2, r.stdout);
    for (const path of ['CLAUDE.md', 'skills/demo/SKILL.md']) assert.ok((r.stdout + r.stderr).includes(path), `${path} is listed`);
    assert.deepEqual(snapshot(target), before, 'no file, settings or manifest is written');
    assert.deepEqual(bundles(w.state), [], 'no bundle is written');
    assert.equal(existsSync(join(target, MANIFEST)), false);
    assert.equal(existsSync(join(target, LEGACY_MANIFEST)), false);
    assert.deepEqual(mcpWrites(), [], 'no MCP registration is made');
  });

  test('AC-5 with --adopt the install takes the files over and keeps the originals in the bundle', () => {
    const w = world();
    const target = foreign();
    const r = w.install(target, '--adopt');
    assert.equal(r.status, 0, r.stderr);
    for (const [path, text] of Object.entries(SOURCE)) assert.equal(readFileSync(join(target, path), 'utf8'), text, path);
    const saved = w.bundles(target);
    assert.equal(saved.length, 1);
    assert.equal(textOf(saved[0].files?.['CLAUDE.md']), 'my own instructions\n');
    assert.equal(textOf(saved[0].files?.['skills/demo/SKILL.md']), 'my own skill\n');
  });

  test('AC-5 an existing file identical to the one it would install is taken over without stopping', () => {
    const w = world();
    const target = fresh('target');
    put(target, 'CLAUDE.md', SOURCE['CLAUDE.md']);
    const r = w.install(target);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(manifestOf(target).files.includes('CLAUDE.md'), 'the manifest takes CLAUDE.md over');
  });

  test('AC-5 an edited file that the previous manifest lists is overwritten without --adopt', () => {
    const w = world();
    const target = installed(w);
    writeFileSync(join(target, 'CLAUDE.md'), 'edited\n');
    const r = w.install(target);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(join(target, 'CLAUDE.md'), 'utf8'), SOURCE['CLAUDE.md']);
  });
});

describe('AC-6 writes through a rename, in order', () => {
  test('AC-6 a reader holding the old CLAUDE.md, settings.json or hook keeps the old content, and no temporary file remains', () => {
    const w = world();
    const target = installed(w, '{"theme":"dark"}');
    const old = { 'CLAUDE.md': 'old instructions\n', 'settings.json': '{"theme":"light"}', 'hooks/demo-hook.mjs': '// old hook\n' };
    const links = fresh('links');
    for (const [path, text] of Object.entries(old)) {
      writeFileSync(join(target, path), text);
      linkSync(join(target, path), join(links, path.replaceAll('/', '_')));
    }
    const existing = files(target);
    const r = w.install(target);
    assert.equal(r.status, 0, r.stderr);
    for (const [path, text] of Object.entries(old)) {
      assert.equal(readFileSync(join(links, path.replaceAll('/', '_')), 'utf8'), text, `${path}: the old file changed under its reader`);
      assert.notEqual(readFileSync(join(target, path), 'utf8'), text, `${path} was not rewritten`);
    }
    assert.equal(readFileSync(join(target, 'CLAUDE.md'), 'utf8'), SOURCE['CLAUDE.md']);
    assert.equal(readFileSync(join(target, 'hooks/demo-hook.mjs'), 'utf8'), SOURCE['hooks/demo-hook.mjs']);
    assert.equal(settingsOf(target).theme, 'light');
    const expected = new Set([...existing, ...Object.keys(SOURCE), 'settings.json', MANIFEST]);
    assert.deepEqual(files(target).filter((f) => !expected.has(f)), [], 'no temporary file remains');
  });

  test('AC-6 a rewritten settings.json keeps mode 0600 and an overwritten hook takes the 0755 of its source', () => {
    const w = world();
    const target = installed(w);
    const settings = join(target, 'settings.json');
    const hook = join(target, 'hooks', 'demo-hook.mjs');
    writeFileSync(settings, '{"theme":"dark"}');
    chmodSync(settings, 0o600);
    writeFileSync(hook, '// old hook\n');
    chmodSync(hook, 0o644);
    const r = w.install(target);
    assert.equal(r.status, 0, r.stderr);
    assert.notEqual(readFileSync(settings, 'utf8'), '{"theme":"dark"}', 'settings.json was rewritten');
    assert.equal(statSync(settings).mode & 0o777, 0o600);
    assert.equal(readFileSync(hook, 'utf8'), SOURCE['hooks/demo-hook.mjs']);
    assert.equal(statSync(hook).mode & 0o777, 0o755);
  });

  test('AC-6 every planned file is written before settings.json, and the manifest last', () => {
    const w = world();
    const target = installed(w, '{"theme":"dark"}');
    const mtime = (path) => statSync(join(target, path), { bigint: true }).mtimeNs;
    const settings = mtime('settings.json');
    for (const path of Object.keys(SOURCE)) assert.ok(mtime(path) <= settings, `${path} is written before settings.json`);
    assert.ok(settings <= mtime(MANIFEST), 'the manifest is written last');
  });
});

describe('AC-7 migration of the legacy manifest and backups', () => {
  // Two directories an installer before #42 left: one with nested files, one with MCP registrations.
  const LEGACY_DIRS = {
    '2025-01-01T00-00-00-000Z': { 'CLAUDE.md': 'legacy instructions\n', 'skills/x/SKILL.md': 'legacy skill\n' },
    '2025-02-01T00-00-00-000Z': { 'mcp-servers.json': JSON.stringify({ 'legacy-server': OLD }) },
  };
  const writeLegacyDirs = (target) => {
    for (const [name, content] of Object.entries(LEGACY_DIRS)) {
      for (const [path, text] of Object.entries(content)) put(join(legacyRoot(target), name), path, text);
    }
  };

  test('AC-7 an install over a legacy manifest writes the new one, removes the legacy one, and treats the files it lists as managed', () => {
    const w = world();
    const target = fresh('target');
    put(target, 'CLAUDE.md', 'old managed\n');
    writeLegacyManifest(target, ['CLAUDE.md']);
    const r = w.install(target);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(join(target, 'CLAUDE.md'), 'utf8'), SOURCE['CLAUDE.md'], 'a file the legacy manifest lists is managed');
    assert.ok(existsSync(join(target, MANIFEST)), `${MANIFEST} is written`);
    assert.equal(existsSync(join(target, LEGACY_MANIFEST)), false, `${LEGACY_MANIFEST} is removed`);
    assert.deepEqual([...manifestOf(target).files].sort(), Object.keys(SOURCE).sort());
  });

  test('AC-7 each legacy backup directory becomes one legacy bundle, the directory is removed, the install reports it, and Claude Code\'s own backups stay', () => {
    const w = world();
    const target = fresh('target');
    writeLegacyDirs(target);
    put(join(target, 'backups'), '.claude.json.backup.123', '{"claude":"own"}');
    const r = w.install(target);
    assert.equal(r.status, 0, r.stderr);
    const legacy = w.bundles(target).filter((b) => b.legacy === true);
    assert.equal(legacy.length, 2, 'one legacy bundle per directory');
    const withFiles = legacy.find((b) => b.files?.['CLAUDE.md']);
    assert.ok(withFiles, 'a legacy bundle holds CLAUDE.md');
    assert.equal(textOf(withFiles.files['CLAUDE.md']), 'legacy instructions\n');
    assert.equal(textOf(withFiles.files['skills/x/SKILL.md']), 'legacy skill\n');
    const withServers = legacy.find((b) => b !== withFiles);
    assert.deepEqual(withServers.mcpServers, { 'legacy-server': OLD });
    for (const bundle of legacy) assert.equal(bundle.target, realpathSync(target));
    assert.equal(existsSync(legacyRoot(target)), false, 'backups/claude-workflow is removed');
    assert.match(r.stdout + r.stderr, /migrat|legacy/i, 'the install reports the migration');
    assert.equal(readFileSync(join(target, 'backups', '.claude.json.backup.123'), 'utf8'), '{"claude":"own"}');
  });

  test('AC-7 migrating the same legacy directories again creates no duplicate bundle', () => {
    const w = world();
    const target = fresh('target');
    writeLegacyDirs(target);
    assert.equal(w.install(target).status, 0);
    writeLegacyDirs(target);
    const r = w.install(target);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(w.bundles(target).filter((b) => b.legacy === true).length, 2);
  });

  test('AC-7 a legacy directory that cannot be converted stays in place, the failure is reported and the install exits non-zero', { skip: process.getuid?.() === 0 && 'root can read a file of mode 000' }, () => {
    const w = world();
    const target = fresh('target');
    const name = '2025-03-01T00-00-00-000Z';
    const dir = join(legacyRoot(target), name);
    put(dir, 'CLAUDE.md', 'readable\n');
    put(dir, 'skills/x/SKILL.md', 'unreadable\n');
    chmodSync(join(dir, 'skills', 'x', 'SKILL.md'), 0o000);
    try {
      const r = w.install(target);
      assert.notEqual(r.status, 0, r.stdout);
      assert.ok((r.stdout + r.stderr).includes(name), `the failure names the directory:\n${r.stdout}${r.stderr}`);
      assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), 'readable\n', 'the legacy directory is left in place');
      assert.ok(existsSync(join(dir, 'skills', 'x', 'SKILL.md')));
    } finally {
      chmodSync(join(dir, 'skills', 'x', 'SKILL.md'), 0o644);
    }
  });
});

describe('AC-8 personal hooks across the migration', () => {
  const DROPPED = { hooks: [{ type: 'command', command: '/usr/local/bin/dropped-personal-hook' }] };
  const KEPT = { hooks: [{ type: 'command', command: '/usr/local/bin/kept-personal-hook' }] };
  const count = (entries, entry) => (entries ?? []).filter((e) => isDeepStrictEqual(e, entry)).length;
  // A target whose settings hold both personal hooks, recorded by a legacy manifest.
  const legacyTarget = () => {
    const target = fresh('target');
    writeFileSync(join(target, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [DROPPED, KEPT] } }));
    writeLegacyManifest(target, [], { SessionStart: [DROPPED, KEPT] });
    return target;
  };

  test('AC-8 a personal hook recorded only in the legacy manifest and no longer in personal/settings.json leaves settings.json', () => {
    const w = world({ personal: { hooks: { SessionStart: [KEPT] } } });
    const target = legacyTarget();
    const r = w.install(target);
    assert.equal(r.status, 0, r.stderr);
    const hooks = settingsOf(target).hooks?.SessionStart;
    assert.equal(count(hooks, DROPPED), 0);
    assert.equal(count(hooks, KEPT), 1);
  });

  test('AC-8 the rewritten manifest keeps the personal hooks still installed, so one removed later leaves settings.json on the next install', () => {
    const w = world({ personal: { hooks: { SessionStart: [DROPPED, KEPT] } } });
    const target = legacyTarget();
    const r = w.install(target);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(manifestOf(target).personalHooks, { SessionStart: [DROPPED, KEPT] });
    put(join(w.repoDir, 'personal'), 'settings.json', JSON.stringify({ hooks: { SessionStart: [KEPT] } }));
    const next = w.install(target);
    assert.equal(next.status, 0, next.stderr);
    const hooks = settingsOf(target).hooks?.SessionStart;
    assert.equal(count(hooks, DROPPED), 0);
    assert.equal(count(hooks, KEPT), 1);
    assert.deepEqual(manifestOf(target).personalHooks, { SessionStart: [KEPT] });
  });
});

describe('AC-9 --check and the migration', () => {
  // An installed target as an installer before #42 left it: the legacy manifest and a legacy backup directory.
  const legacyInstalled = (w, extraFiles = []) => {
    const target = installed(w);
    toLegacy(target, [...Object.keys(SOURCE), ...extraFiles]);
    put(join(legacyRoot(target), '2025-01-01T00-00-00-000Z'), 'CLAUDE.md', 'legacy instructions\n');
    return target;
  };

  test('AC-9 --check with a legacy manifest and legacy backups writes nothing anywhere', () => {
    const w = world({ servers: { demo: NEW } });
    const target = legacyInstalled(w);
    fake.seed(target, { demo: OLD });
    const before = { target: snapshot(target), state: snapshot(w.state) };
    fake.reset();
    const r = w.install(target, '--check');
    assert.equal(r.status, 1, r.stdout);
    assert.deepEqual({ target: snapshot(target), state: snapshot(w.state) }, before);
    assert.deepEqual(mcpWrites(), []);
  });

  test('AC-9 --check reads the legacy manifest and reports the pending migration of the manifest and of backups/claude-workflow as drift', () => {
    const w = world();
    const target = legacyInstalled(w, ['skills/old/SKILL.md']);
    put(target, 'skills/old/SKILL.md', 'old skill\n');
    const r = w.install(target, '--check');
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /skills\/old\/SKILL\.md/, 'a file listed only in the legacy manifest is no longer shipped');
    assert.match(r.stdout, /\.claude-workflow-manifest\.json/, 'the legacy manifest is pending migration');
    assert.match(r.stdout, /backups\/claude-workflow/, 'the legacy backups are pending migration');
  });

  test('AC-9 after a migrating install --check reports no drift', () => {
    const w = world();
    const target = legacyInstalled(w);
    const r = w.install(target);
    assert.equal(r.status, 0, r.stderr);
    const check = w.install(target, '--check');
    assert.equal(check.status, 0, check.stdout);
  });
});
