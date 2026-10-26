// Issue #50, test gaps left by tests/install-codex-060.test.mjs (which is frozen; same precedent as PR #46).
// Four defects in the npx cache prewarm of scripts/install.mjs went unnoticed: no test failed when the 60 s
// timeout was removed, when standard input was inherited instead of ignored, when only one of several distinct
// packages was prewarmed, or when "only" was dropped from the codex.md sentence about `label`. The installer
// runs through an async spawn, because spawnSync would block node:test's timers (G1) and gives the child a
// standard input that is at end of file at once (G2). The fake claude and the fake npx first on PATH keep
// the prewarm away from the network (tests/fake-claude.mjs).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeClaude } from './fake-claude.mjs';
// For its side effect: XDG_STATE_HOME points at a temporary directory, so no bundle lands in ~/.local/state.
import './state-home.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'cw-codex060-gaps-'));
const fake = fakeClaude(join(scratch, 'fake'));
after(() => rmSync(scratch, { recursive: true, force: true }));

// One sentence or one list item at a time, as in install-codex-060.test.mjs.
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

// Runs the installer with an async spawn and keeps its standard input pipe open until it exits. After `guardMs`
// it kills the installer and sets `guarded`. `elapsed` is in milliseconds.
function launch(repoDir, target, { guardMs = 20000, extraEnv = {}, bins = [] } = {}) {
  const env = { ...process.env, ...fake.env(), HOME: fresh('home'), ...extraEnv };
  delete env.CLAUDE_CONFIG_DIR;
  env.PATH = [...bins, fake.bin, process.env.PATH].join(delimiter);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(repoDir, 'scripts', 'install.mjs'), '--target', target], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let guarded = false;
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    child.stdin.on('error', () => {});
    const guard = setTimeout(() => {
      guarded = true;
      child.kill('SIGKILL');
    }, guardMs);
    child.on('error', (error) => { clearTimeout(guard); reject(error); });
    child.on('close', (status, signal) => {
      clearTimeout(guard);
      resolve({ status, signal, stdout, stderr, guarded, elapsed: Date.now() - started });
    });
  });
}

const PKG = 'codex-subagent-mcp@0.6.0';
const NEXT = 'codex-subagent-mcp@0.6.1';
const codex = (pkg, sandbox) => ({
  type: 'stdio',
  command: 'npx',
  args: ['--prefer-offline', '-y', pkg],
  env: { CODEX_SUBAGENT_DEFAULT_MODEL: 'm1', CODEX_SUBAGENT_MAX_SANDBOX: sandbox },
});
const DECLARED = { 'codex-reviewer': codex(PKG, 'read-only'), 'codex-implementer': codex(PKG, 'workspace-write') };

describe('G1 (#50) the prewarm is bounded by a timeout', () => {
  // An npx that never exits and whose grandchild keeps its standard output open, as real npx does when it
  // runs the package through npm exec. Both exit on their own after two minutes, so nothing leaks.
  const HANG_MS = 120000;
  const HANGING_NPX = `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
if (process.env.HANGING_NPX_LOG) appendFileSync(process.env.HANGING_NPX_LOG, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${HANG_MS})'], { stdio: ['ignore', 'inherit', 'inherit'] });
setTimeout(() => {}, ${HANG_MS});
`;

  test('G1 (#50) an npx that never exits is stopped after about 60 s, and the install completes with status 0', { timeout: 110000 }, async () => {
    const bin = fresh('hang-bin');
    writeFileSync(join(bin, 'npx'), HANGING_NPX);
    chmodSync(join(bin, 'npx'), 0o755);
    const npxLog = join(bin, 'npx.log');
    const repoDir = makeRepo(DECLARED);
    const target = fresh('target');
    fake.reset();
    const r = await launch(repoDir, target, { guardMs: 90000, bins: [bin], extraEnv: { HANGING_NPX_LOG: npxLog } });
    assert.ok(!r.guarded, `the installer was still waiting for npx after ${r.elapsed} ms: the prewarm has no timeout, or a much longer one`);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.ok(r.elapsed >= 59000, `the prewarm was stopped after ${r.elapsed} ms, before the 60 s timeout`);
    assert.ok(r.elapsed < 80000, `the prewarm was stopped after ${r.elapsed} ms, well past the 60 s timeout`);
    assert.equal(readFileSync(npxLog, 'utf8').split('\n').filter(Boolean).length, 1, 'the prewarm ran once');
    assert.deepEqual(fake.servers(target), DECLARED, 'the registrations are in place');
    assert.ok(existsSync(join(target, 'CLAUDE.md')), 'the files are installed');
    const lines = `${r.stdout}\n${r.stderr}`.split('\n');
    assert.ok(
      lines.some((line) => /prewarm/i.test(line) && line.includes(PKG) && /\b(fail|failed|not)\b/i.test(line)),
      `no line reports that ${PKG} was not prewarmed:\n${r.stdout}\n${r.stderr}`,
    );
  });
});

describe('G2 (#50) the prewarm gets standard input closed', () => {
  test('G2 (#50) with the installer\'s own standard input left open, npx still sees it at end of file', async () => {
    const repoDir = makeRepo(DECLARED);
    const target = fresh('target');
    fake.reset();
    const r = await launch(repoDir, target);
    assert.ok(!r.guarded, 'the installer did not exit');
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.deepEqual(fake.npxCalls(), [{ argv: ['--prefer-online', '-y', PKG], stdinClosed: true }]);
  });
});

describe('G3 (#50) every distinct package is prewarmed once', () => {
  test('G3 (#50) three registrations of two specs prewarm each spec once, no more and no fewer', async () => {
    const repoDir = makeRepo({
      'codex-a': codex(PKG, 'read-only'),
      'codex-b': codex(PKG, 'workspace-write'),
      'codex-c': codex(NEXT, 'read-only'),
    });
    const target = fresh('target');
    fake.reset();
    const r = await launch(repoDir, target);
    assert.ok(!r.guarded, 'the installer did not exit');
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const calls = fake.npxCalls().sort((a, b) => a.argv.at(-1).localeCompare(b.argv.at(-1)));
    assert.deepEqual(calls, [
      { argv: ['--prefer-online', '-y', PKG], stdinClosed: true },
      { argv: ['--prefer-online', '-y', NEXT], stdinClosed: true },
    ]);
  });
});

describe('G4 (#50) codex.md says label is persisted only with the usage log on', () => {
  test('G4 (#50) one sentence mentions label, only and the usage log', () => {
    const doc = readFileSync(join(repo, 'global', 'skills', 'task-package', 'codex.md'), 'utf8');
    says(doc, /\blabel\b/, /\bonly\b/i, /\busage log\b/i);
  });
});
