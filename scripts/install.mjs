#!/usr/bin/env node
// Installs this repository into a Claude Code configuration directory.
//
//   node scripts/install.mjs            install into ~/.claude
//   node scripts/install.mjs --check    report drift, change nothing (exit 1 on drift)
//   node scripts/install.mjs --target <dir>
//
// What it installs (ADR 0001):
// - global/CLAUDE.md, global/hooks and global/skills, copied, never linked:
//   Cowork sessions skip a symlinked ~/.claude/CLAUDE.md;
// - common/ and the stack directories, as templates of the repo-bootstrap skill;
// - personal/preferences.md, when present, as rules/personal.md;
// - settings: the existing settings.json, then global/settings.json, then
//   personal/settings.json, merged in that order. Permission lists are unions,
//   hooks installed by this repository are replaced, anything else already in
//   the file is kept. The one exception is global/retired-permissions.json: the
//   rules listed there ({"ask": [...], "allow": [...], "deny": [...]}) were
//   installed once and no longer ship, so they are removed from the existing
//   settings before the merge, because a union alone never lets a rule leave.
//
// Files it installed before and no longer ships are removed, using the manifest
// it writes. Everything it overwrites or removes is first copied to
// backups/claude-workflow/<timestamp>/ inside the target.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STACKS = ['android', 'flutter', 'node-mcp', 'supabase'];
const MANIFEST = '.claude-workflow-manifest.json';
const MANAGED_HOOK = /\/\.claude\/hooks\/[a-z-]+\.mjs/;

function parseArgs(argv) {
  const args = { check: false, target: join(homedir(), '.claude') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--check') args.check = true;
    else if (argv[i] === '--target') args.target = resolve(argv[(i += 1)]);
    else throw new Error(`unknown argument: ${argv[i]}`);
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
  add(join(repo, 'common'), 'skills/repo-bootstrap/templates/common');
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
    if (key === 'hooks') {
      out.hooks = mergeHooks(out.hooks ?? {}, value);
    } else if (key === 'permissions' && isObject(value)) {
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
function mergeHooks(current, managed) {
  const out = {};
  const events = new Set([...Object.keys(current), ...Object.keys(managed)]);
  for (const event of events) {
    const kept = (current[event] ?? []).filter(
      (entry) => !(entry.hooks ?? []).some((h) => MANAGED_HOOK.test(`${h.command ?? ''} ${(h.args ?? []).join(' ')}`)),
    );
    const merged = [...kept, ...(managed[event] ?? [])];
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

function desiredSettings(target) {
  const existing = withoutRetired(readJson(join(target, 'settings.json')));
  const generic = readJson(join(repo, 'global', 'settings.json'));
  const personal = readJson(join(repo, 'personal', 'settings.json'));
  return mergeSettings(mergeSettings(existing, generic), personal);
}

const stable = (value) => `${JSON.stringify(value, null, 2)}\n`;

function main() {
  const { check, target } = parseArgs(process.argv.slice(2));
  const planned = plannedFiles();
  const previous = readJson(join(target, MANIFEST)).files ?? [];
  const orphans = previous.filter((f) => !planned.has(f) && existsSync(join(target, f)));

  const changed = [...planned].filter(([rel, source]) => {
    const dest = join(target, rel);
    return !existsSync(dest) || !readFileSync(dest).equals(readFileSync(source));
  }).map(([rel]) => rel);

  const settingsPath = join(target, 'settings.json');
  const settings = stable(desiredSettings(target));
  const settingsChanged = !existsSync(settingsPath) || readFileSync(settingsPath, 'utf8') !== settings;

  if (check) {
    const drift = [
      ...changed.map((f) => `differs or missing: ${f}`),
      ...orphans.map((f) => `no longer shipped: ${f}`),
      ...retiredPresent(readJson(settingsPath)).map((rule) => `retired permission rule still installed: ${rule}`),
      ...(settingsChanged ? ['settings.json differs from the merged settings'] : []),
    ];
    if (drift.length === 0) {
      console.log(`${target} matches the repository.`);
      return 0;
    }
    console.log(`Drift in ${target}:\n${drift.map((d) => `- ${d}`).join('\n')}`);
    return 1;
  }

  const touched = [...changed, ...orphans, ...(settingsChanged ? ['settings.json'] : [])]
    .filter((f) => existsSync(join(target, f)));
  if (touched.length > 0) {
    const backup = join(target, 'backups', 'claude-workflow', new Date().toISOString().replace(/[:.]/g, '-'));
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
  writeFileSync(join(target, MANIFEST), stable({ files: [...planned.keys()].sort() }));

  console.log(`Installed into ${target}: ${changed.length} file(s) written, ${orphans.length} removed, settings ${settingsChanged ? 'updated' : 'unchanged'}.`);
  if (!existsSync(join(repo, 'personal', 'preferences.md'))) {
    console.log('No personal/preferences.md: copy personal/preferences.example.md to add your own.');
  }
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(`install: ${error.message}`);
  process.exit(2);
}
