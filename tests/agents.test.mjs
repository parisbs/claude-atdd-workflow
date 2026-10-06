// Issue #12 (ADR 0011): the user-level subagents ship from global/agents and the installer carries them
// to ~/.claude/agents. The checks on the two agents are static: they prove what the files declare and
// say, not that Claude Code honours it. That is the read-only probe recorded in the pull request.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const agentPath = (name) => join(repo, 'global', 'agents', `${name}.md`);

function agent(name) {
  assert.ok(existsSync(agentPath(name)), `global/agents/${name}.md is missing`);
  const text = readFileSync(agentPath(name), 'utf8');
  const [, block = '', body = ''] = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text) ?? [];
  const fields = Object.fromEntries(
    block.split('\n').map((line) => /^([A-Za-z]+):\s*(.*)$/.exec(line)).filter(Boolean).map((m) => [m[1], m[2].trim()]),
  );
  const list = (value) => {
    if (value === undefined) return undefined;
    const inner = value.replace(/^\[|\]$/g, '');
    return inner.split(/,(?![^(]*\))/).map((item) => item.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  };
  return { fields, body, tools: list(fields.tools), disallowed: list(fields.disallowedTools) ?? [] };
}

const excludes = (a, tool) => (a.tools ? !a.tools.includes(tool) : a.disallowed.includes(tool));

describe('installing agents', () => {
  let fake;
  const dirs = [];
  const freshTarget = () => {
    const target = mkdtempSync(join(tmpdir(), 'cw-agents-target-'));
    dirs.push(target);
    return target;
  };
  const installFake = (target, ...args) => spawnSync(process.execPath, [join(fake, 'scripts', 'install.mjs'), '--target', target, ...args], { encoding: 'utf8' });
  const example = () => join(fake, 'global', 'agents', 'example.md');

  before(() => {
    fake = mkdtempSync(join(tmpdir(), 'cw-agents-repo-'));
    mkdirSync(join(fake, 'scripts'));
    mkdirSync(join(fake, 'global', 'agents'), { recursive: true });
    copyFileSync(join(repo, 'scripts', 'install.mjs'), join(fake, 'scripts', 'install.mjs'));
    writeFileSync(join(fake, 'global', 'CLAUDE.md'), 'x\n');
    writeFileSync(join(fake, 'global', 'settings.json'), '{}\n');
    writeFileSync(example(), '---\nname: example\n---\nbody\n');
  });
  after(() => {
    rmSync(fake, { recursive: true, force: true });
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  test('AC-1 copies every file of global/agents to agents/ and records it in the manifest', () => {
    const target = freshTarget();
    const r = installFake(target);
    assert.equal(r.status, 0, r.stderr);
    const copy = join(target, 'agents', 'example.md');
    assert.ok(existsSync(copy), 'the installer did not copy agents/example.md');
    assert.equal(readFileSync(copy, 'utf8'), readFileSync(example(), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(target, '.claude-workflow-manifest.json'), 'utf8'));
    assert.ok(manifest.files.includes('agents/example.md'), 'the manifest does not list agents/example.md');
  });

  test('AC-1 --check reports an installed agent that differs or is missing', () => {
    const target = freshTarget();
    assert.equal(installFake(target).status, 0);
    const copy = join(target, 'agents', 'example.md');
    assert.ok(existsSync(copy), 'the installer did not copy agents/example.md');
    writeFileSync(copy, 'edited\n');
    const differs = installFake(target, '--check');
    assert.equal(differs.status, 1, 'a modified agent must be drift');
    assert.match(differs.stdout, /agents\/example\.md/);
    rmSync(copy);
    const missing = installFake(target, '--check');
    assert.equal(missing.status, 1, 'a missing agent must be drift');
    assert.match(missing.stdout, /agents\/example\.md/);
  });

  test('AC-2 removes an installed agent that is no longer shipped, after backing it up', () => {
    const target = freshTarget();
    assert.equal(installFake(target).status, 0);
    const copy = join(target, 'agents', 'example.md');
    assert.ok(existsSync(copy), 'the installer did not copy agents/example.md');
    const kept = readFileSync(example(), 'utf8');
    rmSync(example());
    try {
      const r = installFake(target);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(existsSync(copy), false, 'the retired agent is still installed');
      assert.match(r.stdout, /Backed up/);
      const backups = join(target, 'backups', 'claude-workflow');
      const saved = readdirSync(backups).some((stamp) => existsSync(join(backups, stamp, 'agents', 'example.md')));
      assert.ok(saved, 'the retired agent was not backed up');
    } finally {
      writeFileSync(example(), kept);
    }
  });
});

describe('the shipped agents', () => {
  test('AC-1 claude-implementer and claude-researcher ship in global/agents', () => {
    for (const name of ['claude-implementer', 'claude-researcher']) {
      assert.ok(existsSync(agentPath(name)), `${name}.md is missing`);
      const { fields } = agent(name);
      assert.equal(fields.name, name);
      assert.ok(fields.description && fields.description.length > 20, `${name} needs a description saying when to use it`);
    }
  });

  test('AC-3 claude-implementer runs on Opus at high effort, cannot delegate, keeps its shell and does not isolate', () => {
    const a = agent('claude-implementer');
    assert.equal(a.fields.model, 'opus');
    assert.equal(a.fields.effort, 'high');
    assert.ok(a.disallowed.includes('Agent'), 'Agent must be disallowed');
    assert.ok(!a.disallowed.some((entry) => /^Bash/.test(entry)), 'a Bash entry removes the whole shell (ADR 0013)');
    assert.equal(a.fields.isolation, undefined, 'isolation: worktree is not used (ADR 0011)');
  });

  test('AC-4 claude-researcher runs on Sonnet at medium effort and cannot write files or delegate', () => {
    const a = agent('claude-researcher');
    assert.equal(a.fields.model, 'sonnet');
    assert.equal(a.fields.effort, 'medium');
    for (const tool of ['Edit', 'Write', 'NotebookEdit', 'Agent']) {
      assert.ok(excludes(a, tool), `${tool} must be excluded`);
    }
  });

  test('AC-5 the implementer reports what changed and what ran, and never acts on GitHub', () => {
    const { body } = agent('claude-implementer');
    assert.match(body, /what changed/i);
    assert.match(body, /tests (that )?ran/i);
    assert.match(body, /not run/i);
    assert.match(body, /GitHub/);
  });

  test('AC-5 the researcher reports findings with sources, and separates what it verified from what it did not', () => {
    const { body } = agent('claude-researcher');
    assert.match(body, /sources?/i);
    assert.match(body, /verified/i);
    assert.match(body, /not verified|unverified/i);
  });
});
