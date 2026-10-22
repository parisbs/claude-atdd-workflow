// Issue #42 (ADR 0027): the installer keeps its backups in $XDG_STATE_HOME/claude-atdd-workflow/backups/.
// Imported for its side effect by every test file that spawns scripts/install.mjs: it points XDG_STATE_HOME
// at a fresh temporary directory for this test process, and removes it at exit, so no test writes into the
// developer's ~/.local/state. The helpers read the bundles there, in the approved format:
// { version: 1, stamp, createdAt, target, legacy, files: { <path>: { mode, content } }, mcpServers }.
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const stateHome = mkdtempSync(join(tmpdir(), 'cw-state-home-'));
process.env.XDG_STATE_HOME = stateHome;
process.on('exit', () => rmSync(stateHome, { recursive: true, force: true }));

export const backupsDir = (home = stateHome) => join(home, 'claude-atdd-workflow', 'backups');

// Every bundle in a state directory, each with the path of its file as `file`.
export function bundles(home = stateHome) {
  const dir = backupsDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ ...JSON.parse(readFileSync(join(dir, name), 'utf8')), file: join(dir, name) }));
}

// The bundles made for one target directory, compared by real path (macOS: /var is /private/var).
export const bundlesFor = (target, home = stateHome) => bundles(home).filter((b) => b.target === realpathSync(target));

// The text a bundle holds for one file, or undefined when it holds none.
export const textOf = (entry) => (entry ? Buffer.from(entry.content, 'base64').toString('utf8') : undefined);
