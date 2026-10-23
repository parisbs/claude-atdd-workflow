// Issue #45: regression tests for the review fixes of PR #43 (issue #42, ADR 0027), findings F1..F7 of the first
// review pass and N1..N7 of the second. They pin what the installer does with stray files in the legacy backups,
// malformed bundles, symbolic links in the target, the order of its writes and removals, and a restore under
// retention. Like tests/install-backups.test.mjs, every test runs the real installer from a throwaway repository,
// with a temporary target, HOME, XDG_STATE_HOME and working directory, and the fake `claude` first on PATH
// (tests/fake-claude.mjs). Stamps are read from the bundles, never built here.
import { backupsDir } from './state-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeClaude } from './fake-claude.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'cw-review-fixes-'));
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

const put = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

// A repository with the installer and only the files a test declares. The hook ships with mode 0755.
function makeRepo({ personal, extra = {} } = {}) {
  const dir = fresh('repo');
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(join(repo, 'scripts', 'install.mjs'), join(dir, 'scripts', 'install.mjs'));
  put(join(dir, 'global'), 'settings.json', '{}');
  for (const [rel, text] of Object.entries({ ...SOURCE, ...extra })) put(join(dir, 'global'), rel, text);
  chmodSync(join(dir, 'global', 'hooks', 'demo-hook.mjs'), 0o755);
  if (personal) put(join(dir, 'personal'), 'settings.json', JSON.stringify(personal));
  return dir;
}

// The command line and environment that run the installer of a throwaway repository on a target.
function invocation(repoDir, target, args, { home, state }) {
  const env = { ...process.env, ...fake.env(), HOME: home, XDG_STATE_HOME: state };
  delete env.CLAUDE_CONFIG_DIR;
  return { argv: [join(repoDir, 'scripts', 'install.mjs'), '--target', target, ...args], env };
}

// A repository, a HOME, a state directory and a working directory of their own, and an installer bound to them.
function world(options) {
  const w = { repoDir: makeRepo(options), home: fresh('home'), state: fresh('state'), cwd: fresh('cwd') };
  w.install = (target, ...args) => {
    const { argv, env } = invocation(w.repoDir, target, args, w);
    return spawnSync(process.execPath, argv, { encoding: 'utf8', env, cwd: w.cwd });
  };
  // The installer under a file size limit of zero: it can create files and remove them, but writes no byte to one.
  w.installWithoutWrites = (target, ...args) => {
    const { argv, env } = invocation(w.repoDir, target, args, w);
    return spawnSync('/bin/sh', ['-c', 'ulimit -f 0 && exec "$0" "$@"', process.execPath, ...argv], { encoding: 'utf8', env, cwd: w.cwd });
  };
  w.dir = () => backupsDir(w.state);
  w.bundles = (target) => readableBundles(w.dir()).filter((b) => b.target === realpathSync(target));
  return w;
}

// The bundles in a backups directory, each with the path of its file as `file`, past any file that is not JSON.
function readableBundles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.json')).flatMap((name) => {
    try {
      return [{ ...JSON.parse(readFileSync(join(dir, name), 'utf8')), file: join(dir, name) }];
    } catch {
      return [];
    }
  });
}

const textOf = (entry) => (entry ? Buffer.from(entry.content, 'base64').toString('utf8') : undefined);

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

const legacyRoot = (target) => join(target, 'backups', 'claude-workflow');
const output = (r) => r.stdout + r.stderr;
const isLink = (path) => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true;
const mtime = (path) => statSync(path, { bigint: true }).mtimeNs;

describe('AC-1 loose files at the legacy root', () => {
  test('AC-1 (F1, N5) a .DS_Store besides legacy directories is removed with them, the root is gone and --check reports no drift', () => {
    const w = world();
    const target = installed(w);
    put(legacyRoot(target), '.DS_Store', 'finder metadata');
    put(join(legacyRoot(target), '2025-01-01T00-00-00-000Z'), 'CLAUDE.md', 'legacy\n');
    const r = w.install(target);
    assert.equal(r.status, 0, output(r));
    assert.equal(existsSync(legacyRoot(target)), false, 'backups/claude-workflow is removed');
    const check = w.install(target, '--check');
    assert.equal(check.status, 0, check.stdout);
  });

  test('AC-1 (F1, N5) another loose file stays, install and --check name it as not a backup, and --check reports no pending migration of the legacy backups', () => {
    const w = world();
    const target = installed(w);
    put(legacyRoot(target), 'notes.txt', 'my notes\n');
    put(join(legacyRoot(target), '2025-01-01T00-00-00-000Z'), 'CLAUDE.md', 'legacy\n');
    const r = w.install(target);
    assert.equal(r.status, 0, output(r));
    assert.equal(readFileSync(join(legacyRoot(target), 'notes.txt'), 'utf8'), 'my notes\n', 'the loose file stays');
    assert.equal(existsSync(join(legacyRoot(target), '2025-01-01T00-00-00-000Z')), false, 'the legacy directory is migrated');
    assert.match(output(r), /notes\.txt[^\n]*not a backup/, `the install names the file:\n${output(r)}`);
    const check = w.install(target, '--check');
    assert.match(check.stdout, /not a backup[^\n]*notes\.txt/, `--check names the file:\n${check.stdout}`);
    assert.doesNotMatch(check.stdout, /pending migration[^\n]*backups\/claude-workflow/, `no pending migration:\n${check.stdout}`);
    assert.equal(readFileSync(join(legacyRoot(target), 'notes.txt'), 'utf8'), 'my notes\n');
  });
});

describe('AC-2 the legacy manifest outlives a failed write of the new one', () => {
  test('AC-2 (F2) when the write of the new manifest fails, the legacy manifest is still in place', () => {
    const w = world();
    const target = installed(w);
    // An installed target as an installer before #42 left it: everything else is current, so the new manifest
    // is the only file the install writes, and a file size limit of zero makes that write fail.
    const legacy = JSON.stringify({ files: Object.keys(SOURCE).sort(), personalHooks: {} });
    rmSync(join(target, MANIFEST));
    writeFileSync(join(target, LEGACY_MANIFEST), legacy);
    const r = w.installWithoutWrites(target);
    assert.notEqual(r.status, 0, output(r));
    assert.equal(existsSync(join(target, MANIFEST)), false, 'the new manifest was not written');
    assert.equal(readFileSync(join(target, LEGACY_MANIFEST), 'utf8'), legacy, 'the legacy manifest is still in place');
    // Without the limit the same install migrates it.
    const again = w.install(target);
    assert.equal(again.status, 0, output(again));
    assert.equal(existsSync(join(target, LEGACY_MANIFEST)), false);
  });
});

describe('AC-3 malformed bundle files', () => {
  test('AC-3 (F3) a *.json file that is not valid JSON or not a bundle is skipped with a warning and left in place by install, --list-backups, --restore and retention', () => {
    const w = world();
    const target = installed(w);
    overwrite(w, target, 'edit 1\n');
    const [first] = w.bundles(target);
    assert.ok(first, 'the install made a bundle');
    const stray = { 'broken.json': '{ not json', 'other.json': '{"hello":"world"}' };
    for (const [name, text] of Object.entries(stray)) put(w.dir(), name, text);
    const strayInPlace = (what) => {
      for (const [name, text] of Object.entries(stray)) assert.equal(readFileSync(join(w.dir(), name), 'utf8'), text, `${what}: ${name} stays`);
    };
    const warns = (what, r) => {
      for (const name of Object.keys(stray)) assert.ok(r.stderr.includes(name), `${what} warns about ${name}:\n${r.stderr}`);
    };

    const install = overwrite(w, target, 'edit 2\n');
    warns('install', install);
    strayInPlace('install');
    assert.equal(w.bundles(target).length, 2, 'the install wrote its bundle');

    const list = w.install(target, '--list-backups');
    assert.equal(list.status, 0, output(list));
    assert.ok(list.stdout.includes(first.stamp), 'the valid bundle is listed');
    warns('--list-backups', list);
    strayInPlace('--list-backups');

    const restore = w.install(target, '--restore', first.stamp);
    assert.equal(restore.status, 0, output(restore));
    assert.equal(readFileSync(join(target, 'CLAUDE.md'), 'utf8'), 'edit 1\n', 'the valid bundle is restored');
    warns('--restore', restore);
    strayInPlace('--restore');

    const retention = overwrite(w, target, 'edit 3\n', '--keep-backups', '1');
    warns('retention', retention);
    strayInPlace('retention');
    assert.equal(w.bundles(target).length, 1, 'retention trimmed the valid bundles');
  });

  test('AC-3 (N7) a malformed legacy-*.json for one legacy directory leaves only that directory unmigrated and the install exits non-zero', () => {
    const w = world();
    const target = installed(w);
    const kept = '2025-01-01T00-00-00-000Z';
    const migrated = '2025-02-01T00-00-00-000Z';
    put(join(legacyRoot(target), kept), 'CLAUDE.md', 'legacy one\n');
    const first = w.install(target);
    assert.equal(first.status, 0, output(first));
    const [bundle] = w.bundles(target).filter((b) => b.legacy === true);
    assert.ok(bundle, 'the first install made the legacy bundle of the directory');
    writeFileSync(bundle.file, '{ not json');
    // The same directory comes back, as after a failed removal, next to one not migrated yet.
    put(join(legacyRoot(target), kept), 'CLAUDE.md', 'legacy one\n');
    put(join(legacyRoot(target), migrated), 'CLAUDE.md', 'legacy two\n');
    const r = w.install(target);
    assert.notEqual(r.status, 0, output(r));
    assert.ok(output(r).includes(kept), `the failure names the directory:\n${output(r)}`);
    assert.equal(readFileSync(join(legacyRoot(target), kept, 'CLAUDE.md'), 'utf8'), 'legacy one\n', 'that directory stays');
    assert.equal(existsSync(join(legacyRoot(target), migrated)), false, 'the other directory is migrated');
    const legacy = w.bundles(target).filter((b) => b.legacy === true);
    assert.deepEqual(legacy.map((b) => textOf(b.files?.['CLAUDE.md'])), ['legacy two\n']);
    assert.equal(readFileSync(bundle.file, 'utf8'), '{ not json', 'the malformed bundle file is left in place');
  });
});

describe('AC-4 symbolic links in the target', () => {
  test('AC-4 (F4) a settings.json that is a symbolic link stays a link and its target holds the merged settings', () => {
    const w = world({ personal: { permissions: { allow: ['Bash(ls)'] } } });
    const target = installed(w);
    const real = join(fresh('elsewhere'), 'settings.json');
    writeFileSync(real, '{"theme":"dark"}');
    rmSync(join(target, 'settings.json'));
    symlinkSync(real, join(target, 'settings.json'));
    const r = w.install(target);
    assert.equal(r.status, 0, output(r));
    assert.ok(isLink(join(target, 'settings.json')), 'settings.json is still a symbolic link');
    assert.equal(readlinkSync(join(target, 'settings.json')), real);
    const merged = JSON.parse(readFileSync(real, 'utf8'));
    assert.equal(merged.theme, 'dark', 'the existing settings are kept');
    assert.deepEqual(merged.permissions?.allow, ['Bash(ls)'], 'the personal settings are merged in');
  });

  test('AC-4 (N1) a planned file or the manifest that is a symbolic link becomes a regular file with the installed content, and the former link target is unchanged', () => {
    const w = world();
    const target = installed(w);
    const expected = readFileSync(join(target, MANIFEST), 'utf8');
    const elsewhere = fresh('elsewhere');
    // The installer reads the manifest, so its link target holds the same manifest, written in another layout.
    const outside = { 'CLAUDE.md': 'outside instructions\n', [MANIFEST]: JSON.stringify(JSON.parse(expected)) };
    for (const [rel, text] of Object.entries(outside)) {
      writeFileSync(join(elsewhere, rel), text);
      rmSync(join(target, rel));
      symlinkSync(join(elsewhere, rel), join(target, rel));
    }
    const before = Object.fromEntries(Object.keys(outside).map((rel) => [rel, mtime(join(elsewhere, rel))]));
    const r = w.install(target);
    assert.equal(r.status, 0, output(r));
    for (const [rel, text] of [['CLAUDE.md', SOURCE['CLAUDE.md']], [MANIFEST, expected]]) {
      assert.equal(isLink(join(target, rel)), false, `${rel} is no longer a link`);
      assert.ok(statSync(join(target, rel)).isFile(), `${rel} is a regular file`);
      assert.equal(readFileSync(join(target, rel), 'utf8'), text, `${rel} holds the installed content`);
      assert.equal(readFileSync(join(elsewhere, rel), 'utf8'), outside[rel], `the former target of ${rel} is unchanged`);
      assert.equal(mtime(join(elsewhere, rel)), before[rel], `the former target of ${rel} is not written`);
    }
  });

  test('AC-4 (N2) a dangling settings.json, planned file or manifest link lets the install exit 0 and writes nothing at the missing target', () => {
    for (const rel of ['settings.json', 'CLAUDE.md', MANIFEST]) {
      const w = world();
      const target = installed(w);
      const missing = join(fresh('elsewhere'), 'missing');
      rmSync(join(target, rel));
      symlinkSync(missing, join(target, rel));
      const r = w.install(target);
      assert.equal(r.status, 0, `${rel}: ${output(r)}`);
      assert.equal(existsSync(missing), false, `${rel}: nothing is written at the missing target`);
      assert.ok(statSync(join(target, rel)).isFile(), `${rel}: the install wrote it as a regular file`);
    }
  });
});

describe('AC-5 removal of files no longer shipped', () => {
  test('AC-5 (F5) a managed file no longer shipped is removed only after settings.json has been written', () => {
    const w = world({ extra: { 'skills/old/SKILL.md': 'old skill\n' } });
    const target = installed(w, '{"theme":"dark"}');
    rmSync(join(w.repoDir, 'global', 'skills', 'old'), { recursive: true });
    // Settings the install rewrites, so it writes settings.json and removes the file in the same run.
    writeFileSync(join(target, 'settings.json'), '{"theme":"light"}');
    const r = w.install(target);
    assert.equal(r.status, 0, output(r));
    assert.equal(existsSync(join(target, 'skills', 'old', 'SKILL.md')), false, 'the file is removed');
    assert.notEqual(readFileSync(join(target, 'settings.json'), 'utf8'), '{"theme":"light"}', 'settings.json was rewritten');
    // Nothing else is written in skills/old, so its modification time is the time of the removal.
    assert.ok(mtime(join(target, 'skills', 'old')) >= mtime(join(target, 'settings.json')), 'the file is removed after settings.json is written');
  });
});

describe('AC-6 legacy directories changed after or before their migration', () => {
  const name = '2025-01-01T00-00-00-000Z';
  const LEGACY = { 'CLAUDE.md': 'legacy instructions\n', 'skills/x/SKILL.md': 'legacy skill\n' };
  // A target whose legacy directory has been migrated once, with its one legacy bundle.
  const migratedOnce = (w) => {
    const target = installed(w);
    for (const [path, text] of Object.entries(LEGACY)) put(join(legacyRoot(target), name), path, text);
    const r = w.install(target);
    assert.equal(r.status, 0, output(r));
    assert.equal(w.bundles(target).filter((b) => b.legacy === true).length, 1, 'the first install made the legacy bundle');
    return target;
  };

  test('AC-6 (F6) a legacy directory partly removed after its bundle was written is migrated by the next install without error', () => {
    const w = world();
    const target = migratedOnce(w);
    put(join(legacyRoot(target), name), 'CLAUDE.md', LEGACY['CLAUDE.md']);
    const r = w.install(target);
    assert.equal(r.status, 0, output(r));
    assert.equal(existsSync(legacyRoot(target)), false, 'the rest of the directory is migrated');
    const legacy = w.bundles(target).filter((b) => b.legacy === true);
    assert.equal(legacy.length, 1, 'no second bundle');
    for (const [path, text] of Object.entries(LEGACY)) assert.equal(textOf(legacy[0].files?.[path]), text, `the bundle still holds ${path}`);
  });

  test('AC-6 (F6) a remaining file that differs from the bundle keeps the directory and the install exits non-zero', () => {
    const w = world();
    const target = migratedOnce(w);
    put(join(legacyRoot(target), name), 'CLAUDE.md', 'changed since\n');
    const r = w.install(target);
    assert.notEqual(r.status, 0, output(r));
    assert.equal(readFileSync(join(legacyRoot(target), name, 'CLAUDE.md'), 'utf8'), 'changed since\n', 'the directory stays');
    const legacy = w.bundles(target).filter((b) => b.legacy === true);
    assert.equal(legacy.length, 1);
    assert.equal(textOf(legacy[0].files?.['CLAUDE.md']), LEGACY['CLAUDE.md'], 'the bundle is unchanged');
  });

  test('AC-6 (F7) an empty legacy directory is removed and no bundle is written for it', () => {
    const w = world();
    const target = installed(w);
    mkdirSync(join(legacyRoot(target), name), { recursive: true });
    const r = w.install(target);
    assert.equal(r.status, 0, output(r));
    assert.equal(existsSync(join(legacyRoot(target), name)), false, 'the empty directory is removed');
    assert.deepEqual(w.bundles(target), [], 'no bundle is written');
  });
});

describe('AC-7 a restore under retention', () => {
  test('AC-7 (N3) --restore <stamp> --keep-backups 1 keeps the restored bundle, and the same restore succeeds again', () => {
    const w = world();
    const target = installed(w);
    overwrite(w, target, 'edit 1\n');
    const [saved] = w.bundles(target);
    assert.ok(saved, 'the install made a bundle');
    overwrite(w, target, 'edit 2\n');
    assert.equal(w.bundles(target).length, 2, 'the setup made two bundles');
    const r = w.install(target, '--restore', saved.stamp, '--keep-backups', '1');
    assert.equal(r.status, 0, output(r));
    assert.equal(readFileSync(join(target, 'CLAUDE.md'), 'utf8'), 'edit 1\n');
    assert.ok(existsSync(saved.file), 'the restored bundle still exists');
    writeFileSync(join(target, 'CLAUDE.md'), 'edit 3\n');
    const again = w.install(target, '--restore', saved.stamp, '--keep-backups', '1');
    assert.equal(again.status, 0, output(again));
    assert.equal(readFileSync(join(target, 'CLAUDE.md'), 'utf8'), 'edit 1\n', 'the same restore succeeds again');
    assert.ok(existsSync(saved.file), 'the restored bundle still exists after the second restore');
  });
});

describe('AC-8 symbolic links and files where the legacy backups are', () => {
  test('AC-8 (N4) symbolic links in a legacy directory, dangling or not, are skipped by name without being followed, and the rest is converted', () => {
    const w = world();
    const target = installed(w);
    const elsewhere = fresh('elsewhere');
    put(elsewhere, 'secret.txt', 'secret\n');
    put(elsewhere, 'dir/inner.txt', 'inner\n');
    const dir = join(legacyRoot(target), '2025-01-01T00-00-00-000Z');
    put(dir, 'CLAUDE.md', 'legacy\n');
    symlinkSync(join(elsewhere, 'secret.txt'), join(dir, 'file-link'));
    symlinkSync(join(elsewhere, 'dir'), join(dir, 'dir-link'));
    symlinkSync(join(elsewhere, 'missing'), join(dir, 'dangling-link'));
    const r = w.install(target);
    assert.equal(r.status, 0, output(r));
    for (const link of ['file-link', 'dir-link', 'dangling-link']) assert.ok(output(r).includes(link), `${link} is named:\n${output(r)}`);
    const legacy = w.bundles(target).filter((b) => b.legacy === true);
    assert.equal(legacy.length, 1, 'the directory is converted');
    assert.deepEqual(Object.keys(legacy[0].files), ['CLAUDE.md'], 'the bundle holds the rest and nothing behind a link');
    assert.equal(textOf(legacy[0].files['CLAUDE.md']), 'legacy\n');
    assert.equal(readFileSync(join(elsewhere, 'secret.txt'), 'utf8'), 'secret\n', 'the target of a link is untouched');
    assert.equal(readFileSync(join(elsewhere, 'dir', 'inner.txt'), 'utf8'), 'inner\n', 'the target of a link is untouched');
    assert.equal(existsSync(join(elsewhere, 'missing')), false);
  });

  test('AC-8 (N6) a legacy root that is a regular file or a symbolic link is left untouched, install and --check report it as not migratable, and the rest is installed', () => {
    for (const kind of ['file', 'link']) {
      const w = world();
      const target = fresh('target');
      const elsewhere = fresh('elsewhere');
      put(join(elsewhere, '2025-01-01T00-00-00-000Z'), 'CLAUDE.md', 'behind the link\n');
      mkdirSync(join(target, 'backups'));
      if (kind === 'file') writeFileSync(legacyRoot(target), 'not a directory\n');
      else symlinkSync(elsewhere, legacyRoot(target));
      const r = w.install(target);
      assert.equal(r.status, 0, `${kind}: ${output(r)}`);
      assert.match(output(r), /backups\/claude-workflow[^\n]*not migratable/, `${kind}: the install reports it:\n${output(r)}`);
      for (const [path, text] of Object.entries(SOURCE)) assert.equal(readFileSync(join(target, path), 'utf8'), text, `${kind}: ${path} is installed`);
      assert.ok(existsSync(join(target, MANIFEST)), `${kind}: the manifest is written`);
      if (kind === 'file') {
        assert.equal(readFileSync(legacyRoot(target), 'utf8'), 'not a directory\n', 'the file is untouched');
      } else {
        assert.equal(readlinkSync(legacyRoot(target)), elsewhere, 'the link is untouched');
        assert.equal(readFileSync(join(elsewhere, '2025-01-01T00-00-00-000Z', 'CLAUDE.md'), 'utf8'), 'behind the link\n');
      }
      assert.deepEqual(w.bundles(target), [], `${kind}: nothing is migrated`);
      const check = w.install(target, '--check');
      assert.match(check.stdout, /not migratable[^\n]*backups\/claude-workflow/, `${kind}: --check reports it:\n${check.stdout}`);
    }
  });
});

// Issue #48: a restore writes a bundle with what it overwrites, and retention after the restore must keep it, or
// the restore cannot be undone.
describe('issue #48 the undo bundle of a restore', () => {
  test('AC-1 --restore <stamp> --keep-backups 1 keeps the restored bundle and the one it wrote, and deletes the others', () => {
    const w = world();
    const target = installed(w);
    overwrite(w, target, 'edit 1\n');
    const [restored] = w.bundles(target);
    overwrite(w, target, 'edit 2\n');
    overwrite(w, target, 'edit 3\n');
    assert.equal(w.bundles(target).length, 3, 'the setup made three bundles');
    const before = new Set(w.bundles(target).map((b) => b.stamp));
    const r = w.install(target, '--restore', restored.stamp, '--keep-backups', '1');
    assert.equal(r.status, 0, output(r));
    const after = w.bundles(target);
    const undo = after.filter((b) => !before.has(b.stamp));
    assert.equal(undo.length, 1, `the restore wrote one bundle that survives retention:\n${output(r)}`);
    assert.equal(textOf(undo[0].files['CLAUDE.md']), 'edit 3\n', 'it holds what the restore overwrote');
    assert.deepEqual(after.map((b) => b.stamp).sort(), [restored.stamp, undo[0].stamp].sort(), 'every other bundle beyond the limit is deleted');
  });

  test('AC-2 restoring the bundle a restore wrote brings the files back to their state before that restore', () => {
    const w = world();
    const target = installed(w);
    overwrite(w, target, 'edit 1\n');
    const [restored] = w.bundles(target);
    writeFileSync(join(target, 'CLAUDE.md'), 'before the restore\n');
    const r = w.install(target, '--restore', restored.stamp, '--keep-backups', '1');
    assert.equal(r.status, 0, output(r));
    const undo = w.bundles(target).find((b) => b.stamp !== restored.stamp);
    assert.ok(undo, `the bundle the restore wrote survives retention:\n${output(r)}`);
    const back = w.install(target, '--restore', undo.stamp, '--keep-backups', '1');
    assert.equal(back.status, 0, output(back));
    assert.equal(readFileSync(join(target, 'CLAUDE.md'), 'utf8'), 'before the restore\n');
  });
});
