// Runs each fake executable once before a hook's time budget starts, so the macOS first-run assessment
// happens during setup. Run with no arguments, an empty environment and /dev/null as standard input,
// a fake must have no effect and exit promptly. The warm-up supplies only an empty PATH.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const emptyPath = mkdtempSync(join(tmpdir(), 'cw-executables-'));
process.on('exit', () => rmSync(emptyPath, { recursive: true, force: true }));

export function writeExecutable(path, content) {
  writeFileSync(path, content, { mode: 0o755 });
  spawnSync(path, { env: { PATH: emptyPath }, stdio: 'ignore', timeout: 30000, killSignal: 'SIGKILL' });
}
