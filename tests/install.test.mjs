// Tests for scripts/install.mjs against a temporary target directory.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { fakeClaude } from './fake-claude.mjs';
import './state-home.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
// The installer registers MCP servers through `claude` (ADR 0014); a fake one stands in for it, so the
// tests neither need the CLI nor touch a real configuration.
const claudeDir = mkdtempSync(join(tmpdir(), 'cw-install-claude-'));
const fake = fakeClaude(claudeDir);
after(() => rmSync(claudeDir, { recursive: true, force: true }));
const install = (target, ...args) => spawnSync(
  process.execPath,
  [join(repo, 'scripts', 'install.mjs'), '--target', target, ...args],
  { encoding: 'utf8', env: { ...process.env, ...fake.env() } },
);
const settingsOf = (target) => JSON.parse(readFileSync(join(target, 'settings.json'), 'utf8'));

describe('install', () => {
  let target;
  before(() => {
    target = mkdtempSync(join(tmpdir(), 'cw-install-'));
    writeFileSync(join(target, 'settings.json'), JSON.stringify({
      theme: 'dark',
      permissions: { allow: ['Bash(make:*)'] },
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$HOME/.claude/hooks/guard-git.mjs"' }] },
          { matcher: 'Write', hooks: [{ type: 'command', command: '/usr/local/bin/my-own-hook' }] },
        ],
      },
    }));
  });
  after(() => rmSync(target, { recursive: true, force: true }));

  test('reports drift before installing', () => {
    const r = install(target, '--check');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /differs or missing: CLAUDE\.md/);
    assert.equal(existsSync(join(target, 'CLAUDE.md')), false, 'check must not write');
  });

  test('installs global files, skills and templates', () => {
    const r = install(target);
    assert.equal(r.status, 0, r.stderr);
    for (const f of [
      'CLAUDE.md',
      'hooks/guard-git.mjs',
      'hooks/oracle-check.mjs',
      'skills/atdd-oracle/SKILL.md',
      'skills/repo-bootstrap/templates/common/github/rulesets/main.json',
      'skills/repo-bootstrap/templates/supabase/stack.md',
    ]) assert.ok(existsSync(join(target, f)), f);
    const personal = existsSync(join(repo, 'personal', 'preferences.md'));
    assert.equal(existsSync(join(target, 'rules/personal.md')), personal);
  });

  test('merges settings without losing what was already there', () => {
    const s = settingsOf(target);
    assert.equal(s.theme, 'dark');
    assert.equal(s.includeGitInstructions, false);
    assert.ok(s.permissions.allow.includes('Bash(make:*)'));
    assert.ok(s.permissions.allow.includes('Bash(git status *)'));
    assert.ok(!(s.permissions.ask ?? []).includes('Bash(gh pr merge:*)'), 'the merge decision moved to guard-git (ADR 0010)');
    const commands = s.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command));
    assert.ok(commands.includes('/usr/local/bin/my-own-hook'), 'a hook the user added is kept');
    const shipped = JSON.parse(readFileSync(join(repo, 'global', 'settings.json'), 'utf8'));
    const guardGit = shipped.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command)).filter((c) => c.includes('guard-git.mjs'));
    assert.deepEqual(commands.filter((c) => c.includes('guard-git.mjs')), guardGit, 'managed hooks are not duplicated');
  });

  test('is idempotent', () => {
    const r = install(target, '--check');
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /matches the repository/);
  });

  test('detects and repairs a local edit, keeping a backup', () => {
    writeFileSync(join(target, 'CLAUDE.md'), 'edited\n');
    assert.equal(install(target, '--check').status, 1);
    const r = install(target);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Backed up/);
    assert.equal(readFileSync(join(target, 'CLAUDE.md'), 'utf8'), readFileSync(join(repo, 'global', 'CLAUDE.md'), 'utf8'));
  });

  test('removes files it installed and no longer ships', () => {
    const manifest = join(target, '.claude-atdd-workflow-manifest.json');
    const m = JSON.parse(readFileSync(manifest, 'utf8'));
    m.files.push('skills/retired/SKILL.md');
    writeFileSync(manifest, JSON.stringify(m));
    writeFileSync(join(target, 'skills', 'atdd-oracle', 'extra.md'), 'not ours\n');
    const retired = join(target, 'skills', 'retired');
    spawnSync('mkdir', ['-p', retired]);
    writeFileSync(join(retired, 'SKILL.md'), 'old\n');
    const r = install(target);
    assert.equal(r.status, 0);
    assert.equal(existsSync(join(retired, 'SKILL.md')), false);
    assert.ok(existsSync(join(target, 'skills', 'atdd-oracle', 'extra.md')), 'files it never installed are left alone');
  });
});

// Issue #7 (ADR 0010): the ask on `gh pr merge` leaves the shipped settings, and
// the installer can retire a permission rule it installed in the past.
describe('install permissions', () => {
  const OLD_ASK = 'Bash(gh pr merge:*)';
  const seeded = (permissions) => {
    const target = mkdtempSync(join(tmpdir(), 'cw-perms-'));
    writeFileSync(join(target, 'settings.json'), JSON.stringify({ permissions }));
    return target;
  };

  test('AC-7 ships no ask rule for gh pr merge', () => {
    const shipped = JSON.parse(readFileSync(join(repo, 'global', 'settings.json'), 'utf8'));
    assert.ok(!(shipped.permissions?.ask ?? []).includes(OLD_ASK));
  });

  test('AC-7 retires the rule an earlier install left in settings.json', () => {
    const target = seeded({ ask: [OLD_ASK, 'Bash(mine:*)'], allow: ['Bash(keep:*)'] });
    const r = install(target);
    assert.equal(r.status, 0, r.stderr);
    const s = settingsOf(target);
    assert.deepEqual(s.permissions.ask, ['Bash(mine:*)']);
    assert.ok(s.permissions.allow.includes('Bash(keep:*)'));
    rmSync(target, { recursive: true, force: true });
  });

  describe('with a retired-permissions file', () => {
    let fakeRepo;
    const installFake = (target, ...args) => spawnSync(
      process.execPath,
      [join(fakeRepo, 'scripts', 'install.mjs'), '--target', target, ...args],
      { encoding: 'utf8', env: { ...process.env, ...fake.env() } },
    );
    before(() => {
      fakeRepo = mkdtempSync(join(tmpdir(), 'cw-fake-repo-'));
      mkdirSync(join(fakeRepo, 'scripts'));
      mkdirSync(join(fakeRepo, 'global'));
      copyFileSync(join(repo, 'scripts', 'install.mjs'), join(fakeRepo, 'scripts', 'install.mjs'));
      writeFileSync(join(fakeRepo, 'global', 'CLAUDE.md'), 'x\n');
      writeFileSync(join(fakeRepo, 'global', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(a:*)'] } }));
      writeFileSync(join(fakeRepo, 'global', 'retired-permissions.json'), JSON.stringify({
        ask: [OLD_ASK],
        allow: ['Bash(old:*)'],
      }));
    });
    after(() => rmSync(fakeRepo, { recursive: true, force: true }));

    test('AC-8 removes a retired rule from every list and keeps the rules the user added', () => {
      const target = seeded({ ask: [OLD_ASK, 'Bash(mine:*)'], allow: ['Bash(old:*)', 'Bash(keep:*)'] });
      const r = installFake(target);
      assert.equal(r.status, 0, r.stderr);
      const s = settingsOf(target);
      assert.deepEqual(s.permissions.ask, ['Bash(mine:*)']);
      assert.ok(s.permissions.allow.includes('Bash(keep:*)'));
      assert.ok(s.permissions.allow.includes('Bash(a:*)'));
      assert.ok(!s.permissions.allow.includes('Bash(old:*)'));
      rmSync(target, { recursive: true, force: true });
    });

    test('AC-8 reports a retired rule that is still installed as drift, and stops once it is gone', () => {
      const target = seeded({ ask: [OLD_ASK] });
      const before = installFake(target, '--check');
      assert.equal(before.status, 1);
      assert.match(before.stdout, /retired/i);
      assert.equal(installFake(target).status, 0);
      assert.equal(installFake(target, '--check').status, 0);
      rmSync(target, { recursive: true, force: true });
    });
  });
});

// Issue #57 (ADR 0017): a Bash result above the bound arrives as a file path plus a preview, and task-package
// ships its Codex and worktree rules as files beside the skill.
describe('install (#57)', () => {
  let target;
  before(() => {
    target = mkdtempSync(join(tmpdir(), 'cw-install-57-'));
    const r = install(target);
    assert.equal(r.status, 0, r.stderr);
  });
  after(() => rmSync(target, { recursive: true, force: true }));

  test('AC-1 (#57) an install sets bashOutputMaxChars to 12000', () => {
    assert.equal(settingsOf(target).bashOutputMaxChars, 12000);
  });

  test('AC-5 (#57) an install copies codex.md and worktree.md beside the task-package skill', () => {
    for (const f of ['skills/task-package/SKILL.md', 'skills/task-package/codex.md', 'skills/task-package/worktree.md']) {
      assert.ok(existsSync(join(target, f)), f);
    }
  });
});

// Issue #27: an install moves the merge decision to an entry of its own that blocks the call when the hook
// fails, keeps only the editing tools Claude Code has in the test guard's matcher, and --check reports a
// claude too old to honour onFailure.
describe('install (#27)', () => {
  let target;
  before(() => {
    target = mkdtempSync(join(tmpdir(), 'cw-install-27-'));
    writeFileSync(join(target, 'settings.json'), JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$HOME/.claude/hooks/guard-git.mjs"', timeout: 15 }] },
          { matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: 'node "$HOME/.claude/hooks/guard-tests.mjs"', timeout: 15 }] },
        ],
      },
    }));
    const r = install(target);
    assert.equal(r.status, 0, r.stderr);
  });
  after(() => rmSync(target, { recursive: true, force: true }));

  const handlers = (script) => settingsOf(target).hooks.PreToolUse
    .flatMap((entry) => entry.hooks.map((hook) => ({ matcher: entry.matcher, ...hook })))
    .filter((hook) => hook.command.includes(script));

  test('AC-1 (#27) an install replaces the single guard-git entry with a general one and a merge one that blocks when it fails', () => {
    assert.deepEqual(handlers('guard-git.mjs').map((h) => [h.matcher, / (--skip-merge|--merge-only)\b/.exec(h.command)?.[1], h.if, h.onFailure]), [
      ['Bash', '--skip-merge', undefined, undefined],
      ['Bash', '--merge-only', 'Bash(*gh pr merge *)', 'block'],
    ]);
  });

  // Since #64 the test guard also reads Bash commands that write a frozen test, through an entry of its own.
  test('AC-6 (#27) an install leaves the test guard matching Edit, Write and NotebookEdit', () => {
    assert.deepEqual(handlers('guard-tests.mjs').map((h) => h.matcher).sort(), ['Bash', 'Edit|Write|NotebookEdit']);
  });

  const check = (version) => spawnSync(
    process.execPath,
    [join(repo, 'scripts', 'install.mjs'), '--target', target, '--check'],
    { encoding: 'utf8', env: { ...process.env, ...fake.env({ FAKE_CLAUDE_VERSION: version }) } },
  );

  // Compared as numbers: 2.1.99 is older than 2.1.295, and 2.1.1000 is not.
  for (const version of ['2.1.294', '2.1.99', '2.0.999']) {
    test(`AC-7 (#27) --check reports claude ${version} as drift, older than 2.1.295`, () => {
      const r = check(version);
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stdout, new RegExp(`claude ${version.replace(/\./g, '\\.')} is older than 2\\.1\\.295`));
    });
  }

  for (const version of ['2.1.295', '2.1.1000', '3.0.0']) {
    test(`AC-7 (#27) --check accepts claude ${version}`, () => {
      const r = check(version);
      assert.equal(r.status, 0, r.stdout);
      assert.doesNotMatch(r.stdout, /older than/);
    });
  }

  test('AC-7 (#27) --check says it cannot verify a claude that prints no version', () => {
    const r = check('unknown');
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /cannot verify the claude version/);
  });
});

// Issue #37: the shipped settings deny reading secrets, the allow list moves from the Bash(x:*) form to the
// space form through global/retired-permissions.json, and the personal examples and docs/personalization.md
// set effort and language where they take effect.
describe('install (#37)', () => {
  const DENY = [
    'Read(**/.env)',
    'Read(**/.env.*)',
    'Read(!**/.env.example)',
    'Read(!**/.env.sample)',
    'Read(**/*.pem)',
    'Read(**/*.key)',
    'Read(**/id_rsa*)',
    'Read(**/id_ed25519*)',
    'Read(**/*.keystore)',
    'Read(**/*.jks)',
  ];
  // The allow list global/settings.json shipped before #37.
  const OLD_ALLOW = [
    'Bash(git status:*)',
    'Bash(git diff:*)',
    'Bash(git log:*)',
    'Bash(git show:*)',
    'Bash(git branch --show-current:*)',
    'Bash(git branch --list:*)',
    'Bash(git fetch:*)',
    'Bash(git merge-base:*)',
    'Bash(git merge-tree:*)',
    'Bash(git rev-parse:*)',
    'Bash(git ls-files:*)',
    'Bash(git tag --list:*)',
    'Bash(git stash list:*)',
    'Bash(gh issue list:*)',
    'Bash(gh issue view:*)',
    'Bash(gh pr list:*)',
    'Bash(gh pr view:*)',
    'Bash(gh pr diff:*)',
    'Bash(gh pr checks:*)',
    'Bash(gh run list:*)',
    'Bash(gh run view:*)',
    'Bash(gh run watch:*)',
    'Bash(gh label list:*)',
    'Bash(gh repo view:*)',
  ];
  const spaced = (rule) => rule.replace(/^Bash\((.*):\*\)$/, 'Bash($1 *)');
  const readRepo = (...path) => readFileSync(join(repo, ...path), 'utf8');
  const shipped = () => JSON.parse(readRepo('global', 'settings.json'));
  const personalDoc = () => readRepo('docs', 'personalization.md');
  const seeded = (settings) => {
    const target = mkdtempSync(join(tmpdir(), 'cw-install-37-'));
    writeFileSync(join(target, 'settings.json'), JSON.stringify(settings));
    return target;
  };

  test('AC-1 (#37) an install writes the approved deny rules in order, each exception after the rule it narrows', () => {
    const target = seeded({});
    const r = install(target);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(settingsOf(target).permissions.deny, DENY);
    rmSync(target, { recursive: true, force: true });
  });

  test('AC-1 (#37) an install keeps a deny rule the user already had and adds the approved ones in order', () => {
    const target = seeded({ permissions: { deny: ['Read(**/secrets/**)'] } });
    const r = install(target);
    assert.equal(r.status, 0, r.stderr);
    const deny = settingsOf(target).permissions.deny;
    assert.ok(deny.includes('Read(**/secrets/**)'));
    assert.deepEqual(deny.filter((rule) => DENY.includes(rule)), DENY);
    rmSync(target, { recursive: true, force: true });
  });

  test('AC-3 (#37) an install over the Bash(x:*) rules retires them, keeps their space-form equivalents and leaves no drift', () => {
    const target = seeded({ permissions: { allow: OLD_ALLOW } });
    const r = install(target);
    assert.equal(r.status, 0, r.stderr);
    const allow = settingsOf(target).permissions.allow;
    for (const rule of OLD_ALLOW) {
      assert.ok(!allow.includes(rule), `${rule} is still installed`);
      assert.ok(allow.includes(spaced(rule)), `${spaced(rule)} is missing`);
    }
    const check = install(target, '--check');
    assert.equal(check.status, 0, check.stdout);
    assert.match(check.stdout, /matches the repository/);
    rmSync(target, { recursive: true, force: true });
  });

  test('AC-3 (#37) the retired-permissions file lists every old allow rule and keeps the earlier retirements', () => {
    const retired = JSON.parse(readRepo('global', 'retired-permissions.json'));
    for (const rule of OLD_ALLOW) assert.ok(retired.allow.includes(rule), rule);
    assert.ok(retired.ask.includes('Bash(gh pr merge:*)'));
    assert.ok(retired.allow.includes('mcp__codex-reviewer__codex_job_status'));
    assert.ok(retired.allow.includes('mcp__codex-implementer__codex_job_status'));
  });

  test('AC-3 (#37) the shipped settings hold no rule in the colon form', () => {
    const lists = Object.values(shipped().permissions).flat();
    assert.deepEqual(lists.filter((rule) => /:\*\)$/.test(rule)), []);
  });

  test('AC-4 (#37) the new allow list is exactly the space-form equivalent of the old one', () => {
    const allow = shipped().permissions.allow;
    assert.deepEqual([...allow].sort(), OLD_ALLOW.map(spaced).sort());
    assert.equal(new Set(allow).size, OLD_ALLOW.length);
  });

  test('AC-5 (#37) the personal settings example sets the Opus 5.5 effort through modelSettings', () => {
    const example = JSON.parse(readRepo('personal', 'settings.example.json'));
    // Settings accept no 'max' in either effortLevel key.
    assert.ok(['low', 'medium', 'high', 'xhigh'].includes(example.modelSettings?.['claude-opus-5-5']?.effortLevel));
  });

  test('AC-5 (#37) the personalization guide explains effortLevel, modelSettings and the drift /effort causes', () => {
    const doc = personalDoc();
    assert.match(doc, /modelSettings/);
    assert.match(doc, /effortLevel[^]*(earlier|older|previous|before Opus 5\.5)/i);
    assert.match(doc, /\/effort[^]*drift/i);
    assert.match(doc, /revert|overwrit|undo/i);
  });

  test('AC-6 (#37) the preferences example leaves the response language to the language setting', () => {
    const prefs = readRepo('personal', 'preferences.example.md');
    assert.doesNotMatch(prefs, /^#+\s*Language\b/im);
    assert.doesNotMatch(prefs, /\b(respond|reply|answer|write)\b[^.\n]*\bin (English|Spanish|French|German|Portuguese|Italian)\b/i);
    const example = JSON.parse(readRepo('personal', 'settings.example.json'));
    assert.equal(typeof example.language, 'string');
    assert.ok(example.language.length > 0);
  });

  test('AC-7 (#37) the personalization guide covers git instructions, attribution, a SessionStart hook, the deny limits and the schema lag', () => {
    const doc = personalDoc();
    assert.match(doc, /includeGitInstructions[^]*(snapshot|git status)/i);
    assert.match(doc, /attribution[^]*personal\/settings\.json|personal\/settings\.json[^]*attribution/);
    assert.match(doc, /SessionStart[^]*git (branch|status)/);
    assert.match(doc, /deny[^]*sandbox/i);
    assert.match(doc, /schema[^]*(lag|behind|out of date|not yet)/i);
  });

  test('AC-7 (#37) the README links the personalization guide', () => {
    assert.match(readRepo('README.md'), /\]\((\.\/)?docs\/personalization\.md\)/);
  });
});

// Issue #39: a hooks key in personal/settings.json must neither strip the managed hooks nor pile up across
// installs. The installer runs from a fake copy of the repository whose personal settings each test writes.
describe('install (#39)', () => {
  const PERSONAL_SESSION = { hooks: [{ type: 'command', command: 'git branch --show-current' }] };
  const PERSONAL_BASH = { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/personal-guard' }] };
  const THIRD_PARTY_BASH = { matcher: 'Bash', hooks: [{ type: 'command', command: '/opt/vendor/bin/vendor-guard' }] };
  const THIRD_PARTY_SESSION = { hooks: [{ type: 'command', command: '/opt/vendor/bin/vendor-start' }] };
  const shippedHooks = JSON.parse(readFileSync(join(repo, 'global', 'settings.json'), 'utf8')).hooks;
  const temps = [];
  after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });
  const temp = (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    temps.push(dir);
    return dir;
  };
  const writePersonal = (fakeRepo, personal) => {
    mkdirSync(join(fakeRepo, 'personal'), { recursive: true });
    writeFileSync(join(fakeRepo, 'personal', 'settings.json'), JSON.stringify(personal));
  };
  const fakeRepoWith = (personal) => {
    const fakeRepo = temp('cw-fake-repo-39-');
    mkdirSync(join(fakeRepo, 'scripts'));
    mkdirSync(join(fakeRepo, 'global'));
    copyFileSync(join(repo, 'scripts', 'install.mjs'), join(fakeRepo, 'scripts', 'install.mjs'));
    copyFileSync(join(repo, 'global', 'settings.json'), join(fakeRepo, 'global', 'settings.json'));
    copyFileSync(join(repo, 'global', 'mcp-servers.json'), join(fakeRepo, 'global', 'mcp-servers.json'));
    writeFileSync(join(fakeRepo, 'global', 'CLAUDE.md'), 'x\n');
    writePersonal(fakeRepo, personal);
    return fakeRepo;
  };
  const installFrom = (fakeRepo, target, ...args) => spawnSync(
    process.execPath,
    [join(fakeRepo, 'scripts', 'install.mjs'), '--target', target, ...args],
    { encoding: 'utf8', env: { ...process.env, ...fake.env() } },
  );
  const seeded = (settings) => {
    const target = temp('cw-install-39-');
    if (settings) writeFileSync(join(target, 'settings.json'), JSON.stringify(settings));
    return target;
  };
  const installTwice = (fakeRepo, target) => {
    for (let i = 0; i < 2; i += 1) {
      const r = installFrom(fakeRepo, target);
      assert.equal(r.status, 0, r.stderr);
    }
    return settingsOf(target);
  };
  const count = (entries, entry) => (entries ?? []).filter((e) => isDeepStrictEqual(e, entry)).length;
  const withPersonalHooks = { hooks: { SessionStart: [PERSONAL_SESSION], PreToolUse: [PERSONAL_BASH] } };
  const withThirdParty = { hooks: { PreToolUse: [THIRD_PARTY_BASH], SessionStart: [THIRD_PARTY_SESSION] } };
  // The installer rewrites the guard-codex matcher, so a managed entry is matched by its hooks; the merge
  // entry, which it never rewrites, must also keep its matcher and fail closed.
  const assertManagedKept = (installed) => {
    for (const [event, entries] of Object.entries(shippedHooks)) {
      for (const entry of entries) {
        assert.ok((installed[event] ?? []).some((e) => isDeepStrictEqual(e.hooks, entry.hooks)), `${event} ${entry.hooks[0].command.slice(0, 60)}`);
      }
    }
    const merge = shippedHooks.PreToolUse.find((e) => e.hooks.some((h) => h.onFailure === 'block'));
    assert.ok(merge, 'the shipped settings hold the fail-closed merge entry');
    assert.equal(count(installed.PreToolUse, merge), 1);
  };

  test('AC-1 (#39) an install with personal hooks keeps every managed hook entry, the fail-closed merge entry included', () => {
    const fakeRepo = fakeRepoWith(withPersonalHooks);
    const target = seeded();
    const r = installFrom(fakeRepo, target);
    assert.equal(r.status, 0, r.stderr);
    assertManagedKept(settingsOf(target).hooks);
  });

  test('AC-2 (#39) after two installs each personal hook entry appears exactly once', () => {
    const fakeRepo = fakeRepoWith(withPersonalHooks);
    const { hooks } = installTwice(fakeRepo, seeded());
    assert.equal(count(hooks.SessionStart, PERSONAL_SESSION), 1);
    assert.equal(count(hooks.PreToolUse, PERSONAL_BASH), 1);
    assertManagedKept(hooks);
  });

  test('AC-3 (#39) after two installs with personal hooks --check reports no drift', () => {
    const fakeRepo = fakeRepoWith(withPersonalHooks);
    const target = seeded();
    installTwice(fakeRepo, target);
    const r = installFrom(fakeRepo, target, '--check');
    assert.equal(r.status, 0, r.stdout);
    assert.doesNotMatch(r.stdout, /settings\.json differs/);
  });

  test('AC-4 (#39) third-party hooks already in the target stay beside the managed and personal ones', () => {
    const fakeRepo = fakeRepoWith(withPersonalHooks);
    const { hooks } = installTwice(fakeRepo, seeded(withThirdParty));
    assert.equal(count(hooks.PreToolUse, THIRD_PARTY_BASH), 1);
    assert.equal(count(hooks.SessionStart, THIRD_PARTY_SESSION), 1);
    assert.equal(count(hooks.SessionStart, PERSONAL_SESSION), 1);
    assert.equal(count(hooks.PreToolUse, PERSONAL_BASH), 1);
    assertManagedKept(hooks);
  });

  test('AC-5 (#39) personal settings without hooks install the third-party hooks followed by the managed ones, as before', () => {
    const fakeRepo = fakeRepoWith({ theme: 'light' });
    const s = installTwice(fakeRepo, seeded(withThirdParty));
    assert.equal(s.theme, 'light');
    assert.deepEqual(Object.keys(s.hooks).sort(), ['PreToolUse', 'SessionStart']);
    assert.deepEqual(s.hooks.SessionStart, [THIRD_PARTY_SESSION]);
    assert.deepEqual(s.hooks.PreToolUse[0], THIRD_PARTY_BASH);
    assert.deepEqual(s.hooks.PreToolUse.slice(1).map((e) => e.hooks), shippedHooks.PreToolUse.map((e) => e.hooks));
  });

  test('AC-6 (#39) a hook entry removed from the personal settings leaves the installed settings on the next install', () => {
    const fakeRepo = fakeRepoWith(withPersonalHooks);
    const target = seeded(withThirdParty);
    installTwice(fakeRepo, target);
    writePersonal(fakeRepo, { hooks: { SessionStart: [PERSONAL_SESSION] } });
    const r = installFrom(fakeRepo, target);
    assert.equal(r.status, 0, r.stderr);
    const { hooks } = settingsOf(target);
    assert.equal(count(hooks.PreToolUse, PERSONAL_BASH), 0);
    assert.equal(count(hooks.SessionStart, PERSONAL_SESSION), 1);
    assert.equal(count(hooks.PreToolUse, THIRD_PARTY_BASH), 1);
    assert.equal(count(hooks.SessionStart, THIRD_PARTY_SESSION), 1);
    assertManagedKept(hooks);
  });
});
