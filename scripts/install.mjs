#!/usr/bin/env node
// Installs this repository into a Claude Code configuration directory.
//
//   node scripts/install.mjs            install into ~/.claude
//   node scripts/install.mjs --check    report drift, change nothing (exit 1 on drift)
//   node scripts/install.mjs --target <dir>
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
//   kept third-party hook entries come first, followed by global and personal
//   hooks. The manifest tracks personal entries for replacement or removal;
//   upgrading without that record removes all copies matching the current
//   personal entries before appending them. Anything else already in the file
//   is kept. The one exception is global/retired-permissions.json: the rules
//   listed there ({"ask": [...], "allow": [...], "deny": [...]}) were installed
//   once and no longer ship, so they are removed from the existing settings
//   before the merge, because a union alone never lets a rule leave;
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
// it writes. Everything it overwrites or removes, MCP registrations included
// (as mcp-servers.json), is first copied to backups/claude-workflow/<timestamp>/
// inside the target.
//
// --check also reports a claude on PATH older than MIN_CLAUDE.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STACKS = ['android', 'flutter', 'node-mcp', 'supabase'];
const MANIFEST = '.claude-workflow-manifest.json';
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
  const args = { check: false, target: defaultTarget, configDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--check') args.check = true;
    else if (argv[i] === '--target') {
      args.target = resolve(argv[(i += 1)]);
      args.configDir = realOrResolved(args.target) === realOrResolved(defaultTarget) ? null : args.target;
    } else throw new Error(`unknown argument: ${argv[i]}`);
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

// Replaces the hook entries this repository installed, keeps everyone else's.
function mergeHooks(current, managed, personal, previousPersonal) {
  const out = {};
  const events = new Set([...Object.keys(current), ...Object.keys(managed), ...Object.keys(personal)]);
  for (const event of events) {
    let remaining = [...(current[event] ?? [])];
    // Older manifests did not track personal entries, so remove every matching copy on upgrade.
    if (!previousPersonal) {
      remaining = remaining.filter((entry) => !(personal[event] ?? []).some((installed) => isDeepStrictEqual(installed, entry)));
    }
    // Personal entries were appended, so remove from the end to keep identical third-party entries.
    for (const installed of previousPersonal?.[event] ?? []) {
      const index = remaining.findLastIndex((entry) => isDeepStrictEqual(installed, entry));
      if (index >= 0) remaining.splice(index, 1);
    }
    const kept = remaining.filter(
      (entry) => !(entry.hooks ?? []).some((h) => MANAGED_HOOK.test(`${h.command ?? ''} ${(h.args ?? []).join(' ')}`)),
    );
    const merged = [...kept, ...(managed[event] ?? []), ...(personal[event] ?? [])];
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
  const { check, target, configDir } = parseArgs(process.argv.slice(2));
  const planned = plannedFiles();
  const manifest = readJson(join(target, MANIFEST));
  const previous = manifest.files ?? [];
  const orphans = previous.filter((f) => !planned.has(f) && existsSync(join(target, f)));

  const changed = [...planned].filter(([rel, source]) => {
    const dest = join(target, rel);
    return !existsSync(dest) || !readFileSync(dest).equals(readFileSync(source));
  }).map(([rel]) => rel);

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

  const backup = join(target, 'backups', 'claude-workflow', new Date().toISOString().replace(/[:.]/g, '-'));
  const unregistered = claude ? [...plan.replace, ...plan.remove] : [];
  if (unregistered.length > 0) {
    mkdirSync(backup, { recursive: true });
    writeFileSync(join(backup, 'mcp-servers.json'), stable(Object.fromEntries(unregistered.map((name) => [name, plan.current[name]]))));
    console.log(`Backed up ${unregistered.length} MCP registration(s) to ${join(backup, 'mcp-servers.json')}`);
  }
  const touched = [...changed, ...orphans, ...(settingsChanged ? ['settings.json'] : [])]
    .filter((f) => existsSync(join(target, f)));
  if (touched.length > 0) {
    for (const f of touched) {
      mkdirSync(dirname(join(backup, f)), { recursive: true });
      cpSync(join(target, f), join(backup, f));
    }
    console.log(`Backed up ${touched.length} file(s) to ${backup}`);
  }

  for (const rel of changed) {
    mkdirSync(dirname(join(target, rel)), { recursive: true });
    cpSync(planned.get(rel), join(target, rel));
  }
  for (const rel of orphans) rmSync(join(target, rel));
  if (settingsChanged) writeFileSync(settingsPath, settings);
  writeFileSync(join(target, MANIFEST), stable({ files: [...planned.keys()].sort(), personalHooks: desired.personalHooks }));

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
