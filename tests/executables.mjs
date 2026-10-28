// Runs each fake executable once before a hook's time budget starts, so the macOS first-run assessment
// happens during setup. An empty PATH and no inherited environment keep the warm-up from doing work.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const emptyPath = mkdtempSync(join(tmpdir(), 'cw-executables-'));
process.on('exit', () => rmSync(emptyPath, { recursive: true, force: true }));

export function writeExecutable(path, content) {
  writeFileSync(path, content, { mode: 0o755 });
  spawnSync(path, { env: { PATH: emptyPath }, stdio: 'ignore' });
}
