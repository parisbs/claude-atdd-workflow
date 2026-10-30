// Issue #73, review 1: gate escapes get a verdict; message data and ordinary redirects stay quiet.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fixture, POSIX, SESSIONS, silent, unread } from './guard-git-fixture.mjs';

describe('guard-git consequence gates, first review (#73)', { skip: POSIX }, () => {
  let fx;
  let repo;
  let main;
  before(() => {
    fx = fixture();
    repo = fx.repository();
    main = fx.repository({ branch: 'main' });
    fx.git(repo.dir, 'tag', 'v1.2.3');
  });
  after(() => fx?.close());

  function verdict(result, decision, reason, command) {
    assert.equal(result.stderr, '', `${command}: unexpected failure: ${result.stderr}`);
    assert.equal(result.decision, decision, `${command}: ${result.reason || 'no verdict'}`);
    assert.equal(result.explicit, true, command);
    assert.match(result.reason, reason, `${command}: ${result.reason}`);
  }

  // A widened grammar may read these forms. Otherwise all parts of the unread rule must hold.
  function canonicalOrUnread(result, expected, gate, part, decision, reason, command) {
    if (result.reason.includes('Unread command at the ')) unread(result, expected, gate, part, command);
    else verdict(result, decision, reason, command);
  }

  function push(id, command, part, options = {}) {
    for (const [who, session, expected] of SESSIONS) {
      test(`${id} ${JSON.stringify(command)} decides the protected push for ${who}`, () => {
        const r = fx.decide(main, command, { ...options, session });
        canonicalOrUnread(r, expected, 'push to a protected branch', part,
          'deny', /Do not push to main/, command);
      });
    }
  }

  function merge(id, command, part, options = {}) {
    for (const [who, session, expected] of SESSIONS) {
      test(`${id} ${JSON.stringify(command)} decides the admin merge for ${who}`, () => {
        const r = fx.decide(repo, command, { ...options, session });
        canonicalOrUnread(r, expected, 'merge', part,
          'deny', /--admin|gh pr merge/, command);
      });
    }
  }

  function quiet(id, command, options = {}) {
    for (const [who, session] of SESSIONS) {
      test(`${id} ${JSON.stringify(command)} has no verdict for ${who}`, () => {
        silent(fx.decide(repo, command, { ...options, session }), command);
      });
    }
  }

  for (const command of [
    "git commit -m \"$(cat <<'EOF'\nDon't lose the later command.\nEOF\n)\" && git push origin main",
    "git commit -F - <<'EOF'\nDon't lose the later command.\nEOF\ngit push origin main",
  ]) push('R1', command, /heredoc|<<|substitution|\$\(|quote/i);

  const messageThenMerge = "gh pr create --body \"$(cat <<'EOF'\nPlease don't lose the later merge.\nEOF\n)\" && gh pr merge 5 --squash --admin";
  for (const options of [{}, { mode: '--merge-only' }, { configured: true }]) {
    const entry = options.configured ? 'configured entries' : options.mode || 'all gates';
    merge(`R1 ${entry}`, messageThenMerge, /heredoc|<<|substitution|\$\(|quote/i, options);
  }
  quiet('R1', "git commit -m \"$(cat <<'EOF'\nDon't run git push origin main or gh pr merge 5.\nEOF\n)\"");
  quiet('R1', "git commit -F - <<'EOF'\nDon't run git push origin main.\nEOF");

  push('R2', '>/dev/null git push origin main', /redirect|>\/dev\/null/i);
  for (const options of [{}, { mode: '--merge-only' }, { configured: true }]) {
    const entry = options.configured ? 'configured entries' : options.mode || 'all gates';
    merge(`R2 ${entry}`, '2>/dev/null gh pr merge 5 --squash --admin', /redirect|2>\/dev\/null/i, options);
  }
  test('R2 a leading redirect cannot hide a subagent pull request creation', () => {
    const command = '> out gh pr create -f';
    const session = SESSIONS[1][1];
    const plain = fx.decide(repo, 'gh pr create -f', { session });
    verdict(plain, 'deny', /gh pr create/, 'gh pr create -f');
    canonicalOrUnread(fx.decide(repo, command, { session }), 'deny', 'GitHub actions of a subagent',
      /redirect|> out/i, plain.decision, /gh pr create/, command);
  });

  push('R3', 'git commit -m "$(git push origin main)"', /substitution|\$\(/i);
  merge('R3', 'gh pr create -t x -b "`gh pr merge 5 --admin`"', /backtick|substitution|`/i);
  quiet('R3', "git commit -m \"$(cat <<'EOF'\ngit push origin main; gh pr merge 5 --admin\nEOF\n)\"");

  for (const redirect of ['2>&1', '>&2', '&>file', '>&file']) {
    for (const [who, session] of SESSIONS) {
      test(`R4 ${redirect} keeps the plain feature push decision for ${who}`, () => {
        const plainCommand = 'git push -u origin feature/y';
        const plain = fx.decide(repo, plainCommand, { session });
        if (session.agent_id) verdict(plain, 'deny', /subagent never pushes/i, plainCommand);
        else silent(plain, plainCommand);
        const command = `${plainCommand} ${redirect} | tail -5`;
        const r = fx.decide(repo, command, { session });
        assert.deepEqual({ decision: r.decision, reason: r.reason, explicit: r.explicit, stderr: r.stderr },
          { decision: plain.decision, reason: plain.reason, explicit: plain.explicit, stderr: plain.stderr }, command);
      });
      test(`R4 ${redirect} reaches the merge decision for ${who}`, () => {
        const plainCommand = 'gh pr merge 5 --squash';
        const plain = fx.decide(repo, plainCommand, { session });
        assert.equal(plain.stderr, '', plainCommand);
        assert.doesNotMatch(plain.reason, /Unread command at the /, plainCommand);
        const command = `${plainCommand} ${redirect}`;
        const r = fx.decide(repo, command, { session });
        assert.equal(r.stderr, '', command);
        assert.doesNotMatch(r.reason, /Unread command at the /, command);
        assert.equal(r.decision, plain.decision, `${command}: ${r.reason}`);
        // A redirect is outside the verified plain-merge form that can lift a prompt.
        if (r.decision === 'allow') silent(r, command);
        else assert.equal(r.reason, plain.reason, command);
        if (!session.agent_id) {
          assert.ok(r.ghCalls.some((call) => call.args[0] === 'pr' && call.args[1] === 'view'),
            `${command}: the merge decision did not read the pull request`);
        }
      });
    }
    quiet('R4', `gh pr view 5 ${redirect}`);
    quiet('R4', `gh run view 1 ${redirect}`);
  }
  for (const [who, session, expected] of SESSIONS) {
    test(`R4 a real background push stays unread for ${who}`, () => {
      const command = 'git push origin main &';
      unread(fx.decide(main, command, { session }), expected,
        'push to a protected branch', /background|&/i, command);
    });
  }

  for (const command of [
    'npx -y supabase db push', './node_modules/.bin/supabase db push', '/usr/local/bin/npx supabase db push',
  ]) {
    for (const [who, session, expected] of SESSIONS) {
      test(`R5 ${command} reaches remote Supabase actions for ${who}`, () => {
        canonicalOrUnread(fx.decide(repo, command, { session }), expected,
          'remote Supabase actions', /npx|supabase|prefix|program|option/i,
          'ask', /remote Supabase project/i, command);
      });
    }
  }

  for (const command of [
    "$'git' push origin main", "git $'push' origin main", "echo $'it\\'s'; git push origin main",
  ]) push('R6', command, /quote|non-literal|\$|escape/i);

  for (const [who, session, expected] of SESSIONS) {
    test(`R7 a shell reader nesting exception fails closed at a merge for ${who}`, () => {
      const command = `echo ${'$('.repeat(25)}gh pr merge 5 --squash${')'.repeat(25)}`;
      unread(fx.decide(repo, command, { session }), expected, 'merge', /exception|nesting|budget/i, command);
    });
  }

  for (const command of [
    "cat a > b; bash <<'EOF'\ngit push origin main\nEOF",
    "tee x.sh <<'EOF' | bash\ngit push origin main\nEOF",
  ]) push('R8', command, /heredoc|<<|bash|interpreter|pipe/i);

  quiet('R9', 'cat > notes.md <<EOF\nRun git push origin main\nEOF\ngit status');
  push('R9', 'cat > notes.md <<EOF\n$(git push origin main)\nEOF\ngit status', /substitution|\$\(|heredoc|<</i);

  for (const [who, session, expected] of SESSIONS) {
    test(`R10 an exported git context is unresolved for ${who}`, () => {
      const command = 'export GIT_DIR=/x; git push origin main';
      unread(fx.decide(main, command, { session }), expected,
        'push to a protected branch', /GIT_DIR|export|context/i, command);
    });
    test(`R10 an exported HUSKY setting cannot skip hooks for ${who}`, () => {
      const command = 'export HUSKY=0; git commit -m x';
      canonicalOrUnread(fx.decide(repo, command, { session }), expected,
        'skipped hooks', /HUSKY|export/i, 'deny', /HUSKY|skip hooks/i, command);
    });
    test(`R10 pushd cannot leave the push in the original repository for ${who}`, () => {
      const command = 'pushd /tmp && git push origin main';
      const r = fx.decide(main, command, { session, extraEnv: { FAKE_GIT_LOG_ALL: '1' } });
      if (r.reason.includes('Unread command at the ')) {
        unread(r, expected, 'push to a protected branch', /pushd|directory|cwd|context/i, command);
      } else {
        assert.equal(r.stderr, '', command);
        assert.ok(r.gitCalls.some((call) => /\/(?:private\/)?tmp$/.test(call.cwd)
          && call.args[0] === 'branch' && call.args[1] === '--show-current'),
        `${command}: the push was not decided in /tmp: ${JSON.stringify(r.gitCalls)}`);
        // This command has no merge that could earn an explicit allow.
        if (r.decision === 'allow') silent(r, command);
      }
    });
  }
  for (const command of [
    'git cat-file -p oracle/x:README.md', 'git diff-tree HEAD',
    'git for-each-ref refs/tags/oracle/', 'git shortlog -s',
  ]) quiet('R10', command);
  for (const [who, session] of SESSIONS) {
    test(`R10 a release tag push names the tag action for ${who}`, () => {
      const command = 'git push origin v1.2.3';
      const r = fx.decide(repo, command, { session });
      // The canonical release question stays an ask in bypassPermissions; a subagent cannot push.
      verdict(r, session.agent_id ? 'deny' : 'ask', session.agent_id ? /subagent never pushes/i : /tag.*push|push.*tag/i, command);
      assert.doesNotMatch(r.reason, /deletes or rewrites/i, command);
    });
  }
});
