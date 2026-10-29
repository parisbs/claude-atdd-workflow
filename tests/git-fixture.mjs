// Fixture git reads no developer configuration and answers in a fixed language. Keep HOME temporary
// as well: git and commands run by git must never use the developer's home during repository setup.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cw-git-home-'));
process.on('exit', () => rmSync(home, { recursive: true, force: true }));

export const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  HOME: home,
  XDG_CONFIG_HOME: home,
  LC_ALL: 'C',
  LANG: 'C',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

export function fixtureGit(cwd, ...args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, timeout: 10000 });
}
