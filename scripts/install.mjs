#!/usr/bin/env node
// Installs this repository into a Claude Code configuration directory.
//
//   node scripts/install.mjs            install into ~/.claude
//   node scripts/install.mjs --check    report drift, change nothing (exit 1 on drift)
//   node scripts/install.mjs --target <dir>
//   node scripts/install.mjs --adopt    take over differing unmanaged files
//   node scripts/install.mjs --keep-backups <n>   retain n bundles per target (default 10)
//   node scripts/install.mjs --list-backups       list this target's bundles
//   node scripts/install.mjs --restore <stamp>    restore a bundle of this target
//
// What it installs (ADR 0001):
// - global/CLAUDE.md, global/hooks, global/skills and global/agents, copied, never linked:
//   Cowork sessions skip a symlinked ~/.claude/CLAUDE.md;
// - common/ and the stack directories, as templates of the repo-bootstrap skill, plus
//   scripts/check-adrs.mjs and scripts/migrate-adrs.mjs as templates/common/scripts/ (ADR 0020):
//   copied at install time, so the repository holds one copy of each and an install refreshes them;
// - personal/preferences.md, when present, as rules/personal.md;
// - settings: the existing settings.json, then global/settings.json, then
//   personal/settings.json, merged in that order. Permission lists are unions,
//   hook entries whose command or args match MANAGED_HOOK
//   (/.claude/hooks/<name>.mjs) are replaced as managed. Kept third-party
//   entries come first, followed by global and personal hooks. The manifest
//   tracks personal entries for replacement or removal. Every install removes
//   all copies matching current personal entries, regardless of the manifest,
//   then appends each once unless already in global hooks. This also collapses
//   identical third-party entries, even on a first install. Anything else
//   already in the file is kept. The one exception is
//   global/retired-permissions.json: the rules listed there ({"ask": [...],
//   "allow": [...], "deny": [...]}) were installed once and no longer ship, so
//   they are removed from the existing settings before the merge, because a
//   union alone never lets a rule leave;
// - MCP servers (ADR 0014): global/mcp-servers.json (name -> add-json object),
//   with the env of personal/mcp-servers.json merged over it key by key, is
//   registered in the user scope through `claude mcp add-json` and
//   `claude mcp remove`, never by writing .claude.json, which only the CLI
//   writes. A registration that differs is removed and added again; one named
//   in global/retired-mcp-servers.json is removed; any other server is left
//   alone. The state is read from .claude.json in the target when --target names
//   a directory other than ~/.claude (the CLI then runs with
//   CLAUDE_CONFIG_DIR=<target>) and in HOME otherwise. Without a claude on PATH the servers are reported as not
//   verified.
//
// Files it installed before and no longer ships are removed, using the manifest
// it writes. Everything it overwrites or removes, MCP registrations included,
// is first saved in one JSON bundle under $XDG_STATE_HOME/claude-atdd-workflow/backups/
// (or ~/.local/state/claude-atdd-workflow/backups/). Legacy backups are migrated
// once and exempt from retention; empty legacy directories need no bundle. Migration
// removes .DS_Store but leaves and reports other loose files as not backups.
// Malformed bundle files are skipped with a warning and left out of retention.
// Differing unmanaged files require --adopt. Files are written through a
// same-directory rename, preserving existing symlinks by writing to their real
// destinations. Settings follow planned files and precede orphan removal; the
// manifest is written last, before removing a legacy manifest.
//
// --check also reports a claude on PATH older than MIN_CLAUDE.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STACKS = ['android', 'flutter', 'node-mcp', 'supabase'];
const MANIFEST = '.claude-atdd-workflow-manifest.json';
const LEGACY_MANIFEST = '.claude-workflow-manifest.json';
const MANAGED_HOOK = /\/\.claude\/hooks\/[a-z-]+\.mjs/;
const CODEX_NO_QUOTA = ['codex_doctor', 'list_codex_models', 'codex_recommend', 'codex_job_result', 'codex_job_cancel'];
const CODEX_ALLOW = new RegExp(`^mcp__.+__(?:${CODEX_NO_QUOTA.join('|')})$`);
// The first Claude Code that honours onFailure on a hook. An older one ignores it, and the
// merge decision of guard-git fails open when the hook does not finish.
const MIN_CLAUDE = [2, 1, 295];

const realOrResolved = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

function parseArgs(argv) {
  const defaultTarget = join(homedir(), '.claude');
  // configDir is the CLAUDE_CONFIG_DIR for claude: only an explicit target other than the default sets
  // it. Left unset, claude keeps its user configuration in ~/.claude.json; set to ~/.claude it would
  // use ~/.claude/.claude.json, which nothing reads.
  const args = { check: false, target: defaultTarget, configDir: null, adopt: false, listBackups: false, keepBackups: 10, restore: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--check') args.check = true;
    else if (argv[i] === '--adopt') args.adopt = true;
    else if (argv[i] === '--list-backups') args.listBackups = true;
    else if (argv[i] === '--keep-backups') {
      const value = argv[(i += 1)];
      if (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
        throw new Error('--keep-backups requires a positive integer');
      }
      args.keepBackups = Number(value);
    } else if (argv[i] === '--restore') {
      args.restore = argv[(i += 1)];
      if (!args.restore || args.restore.startsWith('--')) throw new Error('--restore requires a stamp');
    } else if (argv[i] === '--target') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--target requires a directory');
      args.target = resolve(argv[(i += 1)]);
      args.configDir = realOrResolved(args.target) === realOrResolved(defaultTarget) ? null : args.target;
    } else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if ([args.check, args.listBackups, args.restore !== null].filter(Boolean).length > 1) {
    throw new Error('--check, --list-backups and --restore cannot be combined');
  }
  return args;
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === '.DS_Store') return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

// Target-relative path (POSIX separators) -> absolute source path.
function plannedFiles() {
  const files = new Map();
  const add = (sourceDir, targetDir) => {
    for (const source of walk(sourceDir)) {
      files.set([targetDir, ...relative(sourceDir, source).split(sep)].join('/'), source);
    }
  };
  files.set('CLAUDE.md', join(repo, 'global', 'CLAUDE.md'));
  add(join(repo, 'global', 'hooks'), 'hooks');
  add(join(repo, 'global', 'skills'), 'skills');
  add(join(repo, 'global', 'agents'), 'agents');
  add(join(repo, 'common'), 'skills/repo-bootstrap/templates/common');
  for (const script of ['check-adrs.mjs', 'migrate-adrs.mjs']) {
    const source = join(repo, 'scripts', script);
    if (existsSync(source)) files.set(`skills/repo-bootstrap/templates/common/scripts/${script}`, source);
  }
  for (const stack of STACKS) add(join(repo, stack), `skills/repo-bootstrap/templates/${stack}`);
  const personal = join(repo, 'personal', 'preferences.md');
  if (existsSync(personal)) files.set('rules/personal.md', personal);
  return files;
}

const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {});
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function mergeSettings(base, overlay) {
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (key === 'permissions' && isObject(value)) {
      const current = isObject(out.permissions) ? out.permissions : {};
      out.permissions = { ...current };
      for (const [list, rules] of Object.entries(value)) {
        out.permissions[list] = Array.isArray(rules)
          ? [...new Set([...(current[list] ?? []), ...rules])]
          : rules;
      }
    } else if (isObject(value) && isObject(out[key])) {
      out[key] = mergeSettings(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// Replaces managed hooks and deduplicates personal hooks, keeping distinct third-party entries.
function mergeHooks(current, managed, personal, previousPersonal) {
  const out = {};
  const events = new Set([...Object.keys(current), ...Object.keys(managed), ...Object.keys(personal)]);
  for (const event of events) {
    const remaining = [...(current[event] ?? [])];
    // Personal entries were appended, so remove from the end to keep identical third-party entries.
    for (const installed of previousPersonal?.[event] ?? []) {
      const index = remaining.findLastIndex((entry) => isDeepStrictEqual(installed, entry));
      if (index >= 0) remaining.splice(index, 1);
    }
    const kept = remaining.filter(
      (entry) => !(entry.hooks ?? []).some((h) => MANAGED_HOOK.test(`${h.command ?? ''} ${(h.args ?? []).join(' ')}`))
        && !(personal[event] ?? []).some((installed) => isDeepStrictEqual(installed, entry)),
    );
    // The manifest can be missing or stale; current personal entries still appear only once.
    const merged = [...kept, ...(managed[event] ?? [])];
    for (const entry of personal[event] ?? []) {
      if (!merged.some((installed) => isDeepStrictEqual(installed, entry))) merged.push(entry);
    }
    if (merged.length > 0) out[event] = merged;
  }
  return out;
}

const retiredRules = () => readJson(join(repo, 'global', 'retired-permissions.json'));

// The retired rules still present in a settings object, as "<list> <rule>".
function retiredPresent(settings) {
  const present = [];
  for (const [list, rules] of Object.entries(retiredRules())) {
    for (const rule of rules) {
      if (Array.isArray(settings.permissions?.[list]) && settings.permissions[list].includes(rule)) present.push(`${list} ${rule}`);
    }
  }
  return present;
}

function withoutRetired(settings) {
  if (!isObject(settings.permissions)) return settings;
  const permissions = { ...settings.permissions };
  for (const [list, rules] of Object.entries(retiredRules())) {
    if (Array.isArray(permissions[list])) permissions[list] = permissions[list].filter((rule) => !rules.includes(rule));
  }
  return { ...settings, permissions };
}

function desiredSettings(target, previousPersonal) {
  const existing = withoutRetired(readJson(join(target, 'settings.json')));
  const generic = readJson(join(repo, 'global', 'settings.json'));
  const genericHooks = generic.hooks;
  const { hooks: personalHooks = {}, ...personal } = readJson(join(repo, 'personal', 'settings.json'));
  const settings = mergeSettings(mergeSettings(existing, generic), personal);
  if (existing.hooks || genericHooks || Object.keys(personalHooks).length > 0) {
    settings.hooks = mergeHooks(existing.hooks ?? {}, genericHooks ?? {}, personalHooks, previousPersonal);
  }
  const servers = readJson(join(repo, 'global', 'mcp-servers.json'));
  const names = Object.entries(servers).filter(([, server]) =>
    [server.command, ...(server.args ?? [])].some((part) => typeof part === 'string' && part.includes('codex-subagent-mcp')),
  ).map(([name]) => name);

  // Derived rules are reconciled, not unioned: a renamed registration must not
  // leave permissions behind. Other permission rules still merge by union.
  const allow = settings.permissions?.allow ?? [];
  if (names.length > 0 || allow.some((rule) => CODEX_ALLOW.test(rule))) {
    settings.permissions = {
      ...settings.permissions,
      allow: [
        ...allow.filter((rule) => !CODEX_ALLOW.test(rule)),
        ...names.flatMap((name) => CODEX_NO_QUOTA.map((tool) => `mcp__${name}__${tool}`)),
      ],
    };
  }
  if (settings.hooks?.PreToolUse) {
    const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const withServerMatcher = (entry) => {
      if (!(entry.hooks ?? []).some((hook) => /(?:^|\/)guard-codex\.mjs(?:["'\s]|$)/.test(hook.command ?? ''))) return [entry];
      return names.length > 0
        ? [{ ...entry, matcher: `^mcp__(?:${escaped.join('|')})__codex_(?:delegate|follow_up)$` }]
        : [];
    };
    settings.hooks.PreToolUse = settings.hooks.PreToolUse.flatMap(withServerMatcher);
    if (personalHooks.PreToolUse) personalHooks.PreToolUse = personalHooks.PreToolUse.flatMap(withServerMatcher);
  }
  return { settings, personalHooks };
}

const stable = (value) => `${JSON.stringify(value, null, 2)}\n`;

function atomicWrite(path, content, mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o644) {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) path = realpathSync(path);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.claude-atdd-workflow-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

const backupsDirectory = () => join(
  isAbsolute(process.env.XDG_STATE_HOME ?? '') ? process.env.XDG_STATE_HOME : join(homedir(), '.local', 'state'),
  'claude-atdd-workflow', 'backups',
);

function readBundles() {
  const dir = backupsDirectory();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.json')).flatMap((name) => {
    const file = join(dir, name);
    try {
      const bundle = readJson(file);
      if (!isObject(bundle) || bundle.version !== 1
        || typeof bundle.createdAt !== 'string' || Number.isNaN(Date.parse(bundle.createdAt))
        || typeof bundle.stamp !== 'string' || !bundle.stamp
        || typeof bundle.target !== 'string' || !bundle.target
        || !isObject(bundle.files) || !isObject(bundle.mcpServers)
        || !Object.values(bundle.files).every((entry) => isObject(entry)
          && Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o777 && typeof entry.content === 'string')
        || !Object.values(bundle.mcpServers).every(isObject)) {
        throw new Error('not a version 1 backup bundle');
      }
      return [{ ...bundle, file }];
    } catch (error) {
      console.warn(`Skipping backup ${file}: ${error.message}`);
      return [];
    }
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.stamp.localeCompare(b.stamp));
}

function savedFiles(target, paths) {
  return Object.fromEntries(paths.filter((rel) => existsSync(join(target, rel))).map((rel) => {
    const path = join(target, rel);
    return [rel, { mode: statSync(path).mode & 0o777, content: readFileSync(path).toString('base64') }];
  }));
}

function writeBundle(target, files, mcpServers, { legacy = false, stamp, createdAt = new Date().toISOString() } = {}) {
  if (Object.keys(files).length === 0 && Object.keys(mcpServers).length === 0) return;
  stamp ??= `${createdAt.replace(/[:.]/g, '-')}-${randomUUID()}`;
  const dir = backupsDirectory();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, `${stamp}.json`);
  atomicWrite(file, stable({ version: 1, stamp, createdAt, target: realpathSync(target), legacy, files, mcpServers }), 0o600);
  console.log(`Backed up ${Object.keys(files).length} file(s) and ${Object.keys(mcpServers).length} MCP registration(s) to ${file}`);
}

function retainBundles(target, keep) {
  const current = readBundles().filter((bundle) => bundle.target === realpathSync(target) && !bundle.legacy);
  for (const bundle of current.slice(0, Math.max(0, current.length - keep))) rmSync(bundle.file);
}

function migrateBackups(target) {
  const root = join(target, 'backups', 'claude-workflow');
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (!lstatSync(dir).isDirectory()) {
      if (name !== '.DS_Store') console.warn(`Skipping ${dir}: not a backup; leaving it in place.`);
      continue;
    }
    try {
      const files = savedFiles(dir, walk(dir).map((path) => relative(dir, path).split(sep).join('/')));
      const mcpFile = files['mcp-servers.json'];
      const mcpServers = mcpFile ? JSON.parse(Buffer.from(mcpFile.content, 'base64').toString('utf8')) : {};
      delete files['mcp-servers.json'];
      // Stable identity lets a retry recognize a bundle even if removing its old directory failed.
      const stamp = `legacy-${createHash('sha256').update(JSON.stringify([realpathSync(target), name])).digest('hex')}`;
      const file = join(backupsDirectory(), `${stamp}.json`);
      if (existsSync(file)) {
        const previous = readJson(file);
        if (!previous.legacy || previous.target !== realpathSync(target)
          || !isObject(previous.files)
          || !Object.entries(files).every(([rel, entry]) => Object.hasOwn(previous.files, rel) && isDeepStrictEqual(previous.files[rel], entry))
          || (mcpFile && !isDeepStrictEqual(previous.mcpServers, mcpServers))) {
          throw new Error(`existing bundle ${stamp} differs`);
        }
      } else {
        const date = new Date(name.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z'));
        const createdAt = Number.isNaN(date.getTime()) ? statSync(dir).mtime.toISOString() : date.toISOString();
        writeBundle(target, files, mcpServers, { legacy: true, stamp, createdAt });
      }
      rmSync(dir, { recursive: true });
      console.log(`Migrated legacy backup ${name}.`);
    } catch (error) {
      throw new Error(`cannot migrate legacy backup ${dir}: ${error.message}`);
    }
  }
  const metadata = join(root, '.DS_Store');
  const metadataStat = lstatSync(metadata, { throwIfNoEntry: false });
  if (metadataStat && !metadataStat.isDirectory()) rmSync(metadata);
  if (readdirSync(root).length === 0) rmdirSync(root);
}

function listBackups(target) {
  console.log(`Backups: ${backupsDirectory()}`);
  for (const bundle of readBundles().filter((entry) => entry.target === realOrResolved(target))) {
    console.log(`${bundle.stamp} ${bundle.createdAt} (${bundle.legacy ? 'legacy' : 'current'})`);
    for (const rel of Object.keys(bundle.files)) console.log(`  file: ${rel}`);
    for (const name of Object.keys(bundle.mcpServers)) console.log(`  MCP server: ${name}`);
  }
}

function restoreBackup(target, configDir, stamp, keep) {
  const bundle = readBundles().find((entry) => entry.stamp === stamp);
  if (!bundle) throw new Error(`unknown backup stamp: ${stamp}`);
  if (bundle.target !== realOrResolved(target)) throw new Error(`backup ${stamp} belongs to another target: ${bundle.target}`);
  const files = Object.entries(bundle.files).map(([rel, entry]) => {
    if (isAbsolute(rel) || rel.split('/').some((part) => !part || part === '.' || part === '..') || rel === '.claude.json') {
      throw new Error(`invalid backup path: ${rel}`);
    }
    return [rel, Buffer.from(entry.content, 'base64'), entry.mode];
  }).filter(([rel, content, mode]) => {
    const path = join(target, rel);
    return !existsSync(path) || !readFileSync(path).equals(content) || (statSync(path).mode & 0o777) !== mode;
  });
  const current = readJson(join(configDir ?? homedir(), '.claude.json')).mcpServers ?? {};
  const names = Object.keys(bundle.mcpServers);
  const plan = {
    servers: bundle.mcpServers,
    add: names.filter((name) => !(name in current)),
    replace: names.filter((name) => name in current && shape(current[name]) !== shape(bundle.mcpServers[name])),
    remove: [],
  };
  const claude = names.length > 0 ? findClaude() : null;
  if (names.length > 0 && !claude) throw new Error('cannot restore MCP servers: claude CLI unavailable');
  writeBundle(target, savedFiles(target, files.map(([rel]) => rel)), Object.fromEntries(plan.replace.map((name) => [name, current[name]])));
  // A bundle can contain settings or a manifest as well as the files they reference.
  const order = (rel) => rel === MANIFEST || rel === LEGACY_MANIFEST ? 2 : rel === 'settings.json' ? 1 : 0;
  files.sort(([a], [b]) => order(a) - order(b));
  for (const [rel, content, mode] of files) atomicWrite(join(target, rel), content, mode);
  const failed = claude ? registerServers(claude, configDir, plan) : 0;
  retainBundles(target, keep);
  console.log(`Restored backup ${stamp} into ${target}.`);
  return failed > 0 ? 1 : 0;
}

// Declared servers with the personal env merged over the generic one, and the
// personal names that declare nothing.
function desiredServers() {
  const generic = readJson(join(repo, 'global', 'mcp-servers.json'));
  const personal = readJson(join(repo, 'personal', 'mcp-servers.json'));
  const servers = {};
  for (const [name, server] of Object.entries(generic)) {
    const overlay = isObject(personal[name]?.env) ? personal[name].env : {};
    servers[name] = isObject(server.env) || Object.keys(overlay).length > 0
      ? { ...server, env: { ...server.env, ...overlay } }
      : server;
  }
  return { servers, ignored: Object.keys(personal).filter((name) => !(name in generic)) };
}

// Missing and empty compare equal, so the check does not depend on how the CLI
// writes defaults; env and headers key order does not count, args order does.
// A stdio server is its command, args and env; an http or sse one is its url
// and headers.
const sortedEntries = (o) => Object.entries(o ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const shape = (s) => JSON.stringify([
  s.type ?? 'stdio',
  s.command ?? null,
  s.args ?? [],
  sortedEntries(s.env),
  s.url ?? null,
  sortedEntries(s.headers),
]);

function mcpPlan(stateDir) {
  const { servers, ignored } = desiredServers();
  const retiredFile = join(repo, 'global', 'retired-mcp-servers.json');
  const retired = existsSync(retiredFile) ? JSON.parse(readFileSync(retiredFile, 'utf8')) : [];
  const declared = Object.keys(servers);
  if (declared.length === 0 && retired.length === 0) return { servers, ignored, declared, current: {}, add: [], replace: [], remove: [] };
  const state = readJson(join(stateDir, '.claude.json')).mcpServers;
  const current = isObject(state) ? state : {};
  return {
    servers,
    ignored,
    declared,
    current,
    add: declared.filter((name) => !(name in current)),
    replace: declared.filter((name) => name in current && shape(current[name]) !== shape(servers[name])),
    remove: retired.filter((name) => name in current && !(name in servers)),
  };
}

// Found on PATH rather than run, so an install with nothing to change makes no
// call; --check runs it once, for its version.
function findClaude() {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const path = join(dir, 'claude');
    try {
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // not here
    }
  }
  return null;
}

// The version claude reports, as numbers, or null when it prints none.
function claudeVersion(claude) {
  const run = spawnSync(claude, ['--version'], { encoding: 'utf8', timeout: 10000 });
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(run.stdout ?? '');
  return match ? match.slice(1).map(Number) : null;
}

const olderThan = (version, minimum) => {
  const at = version.findIndex((part, i) => part !== minimum[i]);
  return at >= 0 && version[at] < minimum[at];
};

// Applies the plan through the CLI and returns how many servers failed.
function registerServers(claude, configDir, plan) {
  const env = { ...process.env };
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  else delete env.CLAUDE_CONFIG_DIR;
  const mcp = (...args) => {
    const r = spawnSync(claude, ['mcp', ...args, '-s', 'user'], { encoding: 'utf8', env });
    if (r.status === 0) return true;
    console.error(`claude mcp ${args[0]} ${args[1]} failed: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim()}`);
    return false;
  };
  let failed = 0;
  let changed = 0;
  for (const name of plan.remove) {
    if (mcp('remove', name)) {
      changed += 1;
      console.log(`Removed MCP server ${name}`);
    } else {
      failed += 1;
      console.error(`MCP server ${name} not removed.`);
    }
  }
  for (const name of plan.replace) {
    if (!mcp('remove', name)) {
      failed += 1;
      console.error(`MCP server ${name} not replaced: the old registration is still in place.`);
      continue;
    }
    changed += 1;
    if (mcp('add-json', name, JSON.stringify(plan.servers[name]))) {
      console.log(`Replaced MCP server ${name}`);
    } else {
      failed += 1;
      console.error(`MCP server ${name} not registered: it was removed and adding it again failed.`);
    }
  }
  for (const name of plan.add) {
    if (mcp('add-json', name, JSON.stringify(plan.servers[name]))) {
      changed += 1;
      console.log(`Registered MCP server ${name}`);
    } else {
      failed += 1;
      console.error(`MCP server ${name} not registered.`);
    }
  }
  if (changed > 0) console.log('Open Claude Code sessions keep the old MCP server process until they reload.');
  return failed;
}

function main() {
  const { check, target, configDir, adopt, listBackups: list, keepBackups, restore } = parseArgs(process.argv.slice(2));
  if (list) {
    listBackups(target);
    return 0;
  }
  if (restore !== null) return restoreBackup(target, configDir, restore, keepBackups);
  const planned = plannedFiles();
  const legacyManifest = existsSync(join(target, LEGACY_MANIFEST));
  const legacyBackups = existsSync(join(target, 'backups', 'claude-workflow'));
  const manifest = readJson(join(target, existsSync(join(target, MANIFEST)) ? MANIFEST : LEGACY_MANIFEST));
  const previous = manifest.files ?? [];
  const orphans = previous.filter((f) => !planned.has(f) && existsSync(join(target, f)));

  const changed = [...planned].filter(([rel, source]) => {
    const dest = join(target, rel);
    return !existsSync(dest) || !readFileSync(dest).equals(readFileSync(source));
  }).map(([rel]) => rel);

  const unmanaged = changed.filter((rel) => !previous.includes(rel) && existsSync(join(target, rel)));
  if (!check && !adopt && unmanaged.length > 0) {
    console.error(`Refusing to overwrite unmanaged files in ${target}; use --adopt to back them up and take them over:\n${unmanaged.map((rel) => `- ${rel}`).join('\n')}`);
    return 2;
  }

  const settingsPath = join(target, 'settings.json');
  const desired = desiredSettings(target, manifest.personalHooks);
  const settings = stable(desired.settings);
  const settingsChanged = !existsSync(settingsPath) || readFileSync(settingsPath, 'utf8') !== settings;

  const plan = mcpPlan(configDir ?? homedir());
  const needed = [...plan.declared, ...plan.remove];
  const claude = check || needed.length > 0 ? findClaude() : null;
  const unverified = claude ? [] : needed;
  if (plan.ignored.length > 0) {
    console.log(`Ignored in personal/mcp-servers.json, not declared in global/mcp-servers.json: ${plan.ignored.join(', ')}`);
  }

  if (check) {
    const version = claude ? claudeVersion(claude) : undefined;
    const drift = [
      ...(legacyManifest ? [`pending migration: ${LEGACY_MANIFEST}`] : []),
      ...(legacyBackups ? ['pending migration: backups/claude-workflow'] : []),
      ...(legacyBackups ? readdirSync(join(target, 'backups', 'claude-workflow'))
        .filter((name) => name !== '.DS_Store' && !lstatSync(join(target, 'backups', 'claude-workflow', name)).isDirectory())
        .map((name) => `not a backup: backups/claude-workflow/${name}`) : []),
      ...changed.map((f) => `differs or missing: ${f}`),
      ...orphans.map((f) => `no longer shipped: ${f}`),
      ...retiredPresent(readJson(settingsPath)).map((rule) => `retired permission rule still installed: ${rule}`),
      ...(settingsChanged ? ['settings.json differs from the merged settings'] : []),
      ...(claude ? [
        ...plan.replace.map((name) => `mcp server differs: ${name}`),
        ...plan.add.map((name) => `mcp server missing: ${name}`),
        ...plan.remove.map((name) => `retired mcp server still registered: ${name}`),
      ] : []),
      ...(version && olderThan(version, MIN_CLAUDE)
        ? [`claude ${version.join('.')} is older than ${MIN_CLAUDE.join('.')}: it ignores onFailure, so the merge decision fails open`]
        : []),
    ];
    if (drift.length === 0 && unverified.length === 0 && version !== null) {
      console.log(`${target} matches the repository.`);
      return 0;
    }
    if (drift.length > 0) console.log(`Drift in ${target}:\n${drift.map((d) => `- ${d}`).join('\n')}`);
    // Not drift: the registrations may well match, but nothing can say so.
    if (unverified.length > 0) console.log(`cannot verify mcp servers (claude CLI unavailable): ${unverified.join(', ')}`);
    if (version === null) console.log(`cannot verify the claude version: ${claude} --version printed none`);
    return 1;
  }

  migrateBackups(target);
  const unregistered = claude ? [...plan.replace, ...plan.remove] : [];
  const touched = [...changed, ...orphans, ...(settingsChanged ? ['settings.json'] : [])];
  writeBundle(target, savedFiles(target, touched), Object.fromEntries(unregistered.map((name) => [name, plan.current[name]])));

  for (const rel of changed) {
    const source = planned.get(rel);
    atomicWrite(join(target, rel), readFileSync(source), statSync(source).mode & 0o777);
  }
  if (settingsChanged) atomicWrite(settingsPath, settings);
  for (const rel of orphans) rmSync(join(target, rel));
  atomicWrite(join(target, MANIFEST), stable({ files: [...planned.keys()].sort(), personalHooks: desired.personalHooks }));
  if (legacyManifest) {
    rmSync(join(target, LEGACY_MANIFEST));
    console.log(`Migrated legacy manifest ${LEGACY_MANIFEST} to ${MANIFEST}.`);
  }
  retainBundles(target, keepBackups);

  console.log(`Installed into ${target}: ${changed.length} file(s) written, ${orphans.length} removed, settings ${settingsChanged ? 'updated' : 'unchanged'}.`);
  if (!existsSync(join(repo, 'personal', 'preferences.md'))) {
    console.log('No personal/preferences.md: copy personal/preferences.example.md to add your own.');
  }
  if (unverified.length > 0) {
    console.log(`MCP servers not verified (claude CLI unavailable): ${unverified.join(', ')}`);
    return 0;
  }
  return claude && registerServers(claude, configDir, plan) > 0 ? 1 : 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(`install: ${error.message}`);
  process.exit(2);
}
