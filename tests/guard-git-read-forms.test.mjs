// Issue #73: pin the E3a escapes, the fixes of 0b6568c and the remaining A-8 command-reading defects.
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fixture, POSIX, SESSIONS, silent, unread } from './guard-git-fixture.mjs';

describe('guard-git read forms (#73)', { skip: POSIX }, () => {
  let fx;
  let repo;
  let main;
  let noOracle;
  let tilde;
  before(() => {
    fx = fixture();
    repo = fx.repository();
    main = fx.repository({ branch: 'main' });
    noOracle = fx.repository({ oracle: false });
    tilde = fx.repository({ branch: 'main', directory: join(fx.home, 'repo') });
  });
  after(() => fx?.close());

  function outcome(ac, command, decision, reason, options = {}) {
    for (const [who, session] of SESSIONS) {
      test(`${ac} ${command} has its canonical decision for ${who}`, () => {
        const r = fx.decide(options.repo ? options.repo() : repo, command, { ...options, session });
        assert.equal(r.stderr, '', `${command}: ${r.stderr}`);
        assert.equal(r.decision, typeof decision === 'function' ? decision(session) : decision, `${command}: ${r.reason || 'no verdict'}`);
        assert.equal(r.explicit, true, command);
        if (reason) assert.match(r.reason, reason, command);
      });
    }
  }

  for (const member of ['constructor', 'toString', '__proto__']) {
    for (const [who, session] of SESSIONS) {
      test(`AC-11 gh ${member} alone never throws for ${who}`, () => {
        const r = fx.decide(repo, `gh ${member}`, { session });
        assert.equal(r.stderr, '', `gh ${member}: ${r.stderr}`);
        if (session.agent_id) {
          assert.equal(r.decision, 'deny', r.reason);
          assert.match(r.reason, /subagent/i);
        } else silent(r, `gh ${member}`);
      });
    }
    for (const command of [`gh ${member}; gh pr create -f`, `gh pr create -f; gh ${member}`]) {
      test(`AC-11 ${command} keeps every subagent denial`, () => {
        const r = fx.decide(repo, command, { session: { agent_id: 'agent-73' } });
        assert.equal(r.stderr, '', r.stderr);
        assert.equal(r.decision, 'deny', r.reason);
        assert.match(r.reason, /gh pr create/);
      });
    }
  }

  const PREFIXES = [
    ['env ', '', /env/],
    ['printf ready & ', '', /background|&/i],
    ['(', ')', /subshell|\(/i],
    ['FOO="a b" ', '', /FOO|assignment/i],
  ];
  for (const [prefix, suffix, part] of PREFIXES) {
    for (const mode of [undefined, '--merge-only']) {
      for (const [who, session, expected] of SESSIONS) {
        const command = `${prefix}gh pr merge 5 --squash${suffix}`;
        test(`AC-12 ${command} is decided through ${mode ?? 'the whole hook'} for ${who}`, () => {
          unread(fx.decide(repo, command, { mode, session }), expected, 'merge', part, command);
        });
      }
    }
    const command = `${prefix}gh pr create -f${suffix}`;
    test(`AC-12 ${command} is denied to a subagent`, () => {
      unread(fx.decide(repo, command, { session: { agent_id: 'agent-73' } }),
        'deny', 'GitHub actions of a subagent', part, command);
    });
  }

  for (const ref of ['HEAD', '@']) {
    outcome('AC-13', `git push origin ${ref}`, 'deny', /main|subagent/i, { repo: () => main });
  }
  outcome('AC-13', 'git push --mirror origin', 'deny', /main/, { repo: () => main });
  test('AC-13 mirror also records the possible oracle-tag move', () => {
    const r = fx.decide(repo, 'git push --mirror origin');
    assert.equal(r.stderr, '');
    assert.equal(r.decision, 'deny', r.reason);
    assert.match(r.reason, /oracle\/\*|oracle tags/i);
  });

  for (const command of [
    'git commit \\\n --no-verify -m safe',
    'git push origin \\\n main',
    'gh pr merge 5 --squash \\\n --admin',
    'git -c core.hooksPath=/dev/null commit -m safe',
    'git -c core.hooksPath=/dev/null push origin feature/work',
  ]) outcome('AC-14', command, 'deny', /hook|verify|main|--admin|subagent/i);
  test('AC-14 a continued ordinary commit is still quiet', () => {
    const command = 'git commit \\\n -m safe';
    silent(fx.decide(repo, command), command);
  });

  for (const command of [
    'git commit -nm safe', 'git commit -an -m safe', 'git commit -qn -m safe',
    'git commit --no-verif -m safe', 'git commit --no-v -m safe',
  ]) outcome('AC-15', command, 'deny', /hook|verify/i);

  const oracleDecision = (session) => session.agent_id || session.permission_mode === 'bypassPermissions' ? 'deny' : 'ask';
  for (const command of [
    'git push -qd origin oracle/x', 'git push -fq origin oracle/x', 'git push --del origin oracle/x',
  ]) outcome('AC-16', command, oracleDecision, /oracle|subagent/i);
  for (const command of [
    'git -c color.ui=false tag -d oracle/x',
    'git --config-env color.ui=TEST_COLOR tag -d oracle/x',
    'git --namespace team tag -d oracle/x',
    '/usr/bin/git tag -d oracle/x',
  ]) outcome('AC-16', command, oracleDecision, /oracle|subagent/i);
  test('AC-16 F2 -C with a value reads the named repository', () => {
    const command = `git -C ${repo.dir} tag -d oracle/x`;
    const r = fx.decide(main, command);
    assert.equal(r.stderr, '');
    assert.equal(r.decision, 'ask', r.reason);
    assert.match(r.reason, /Delete oracle\/x/);
  });
  for (const command of [
    'git push --tags --force origin',
    'git push --force origin refs/tags/oracle/*:refs/tags/oracle/*',
    'git push origin +refs/tags/*:refs/tags/*',
    'git push -o ci.skip origin --delete oracle/x',
    'git push -o ci.skip --force origin refs/tags/oracle/x',
  ]) outcome('AC-16', command, oracleDecision, /oracle|subagent/i);
  test('AC-16 F5 -o consumes its value before the remote and names that remote in the move question', () => {
    const command = 'git push -o ci.skip --force origin refs/tags/oracle/x';
    const r = fx.decide(repo, command);
    assert.equal(r.stderr, '');
    assert.equal(r.decision, 'ask', r.reason);
    assert.match(r.reason, /origin/);
    assert.ok(r.gitCalls.some((call) => call.args?.includes('ls-remote') && call.args.includes('origin')),
      JSON.stringify(r.gitCalls));
  });
  outcome('AC-16', 'git tag -f oracle/missing', 'ask', /creat|freez|approv/i);

  for (const command of [
    'git --attr-source HEAD commit --no-verify -m safe',
    'git --shallow-file /dev/null commit --no-verify -m safe',
  ]) outcome('AC-17', command, 'deny', /hook|verify/i);
  test('AC-17 --follow-tags on a forced branch push is not a wholesale oracle move', () => {
    const r = fx.decide(repo, 'git push --force --follow-tags origin feature/work', {
      session: { permission_mode: 'bypassPermissions' },
    });
    assert.equal(r.stderr, '');
    assert.equal(r.decision, 'ask', r.reason);
    assert.doesNotMatch(r.reason, /oracle\/\*|oracle tags/i);
  });
  outcome('AC-17', 'git push --force origin refs/tags/oracle/*:refs/tags/oracle/*', oracleDecision,
    /oracle|subagent/i, { repo: () => noOracle });
  for (const earlier of ['gh pr checkout 5', 'gh repo sync', 'git bisect start']) {
    test(`AC-17 ${earlier} adds the timing note to the later move question`, () => {
      const r = fx.decide(repo, `${earlier}; git tag -f oracle/x HEAD`);
      assert.equal(r.stderr, '');
      assert.equal(r.decision, 'ask', r.reason);
      assert.match(r.reason, /before|earlier|change.*(?:ref|HEAD)|current.*(?:ref|HEAD)|at hook time/i);
      assert.match(r.reason, /oracle\/x/);
      assert.ok(r.reason.includes(repo.a.slice(0, 7)), r.reason);
      assert.ok(r.reason.includes(repo.b.slice(0, 7)), r.reason);
    });
  }
  test('AC-17 git -C ~/repo expands HOME before reading the current branch', () => {
    const r = fx.decide(repo, 'git -C ~/repo commit -m safe', { extraEnv: { FAKE_GIT_LOG_ALL: '1' } });
    assert.equal(r.stderr, '');
    assert.equal(r.decision, 'deny', r.reason);
    assert.match(r.reason, /main/);
    // macOS reaches the temporary directory through the /var -> /private/var link.
    assert.ok(r.gitCalls.some((call) => realpathSync(call.cwd) === realpathSync(tilde.dir)), JSON.stringify(r.gitCalls));
  });
  outcome('AC-17', 'git tag -f oracle/another-missing', 'ask', /creat|freez|approv/i);
  test('AC-17 gh pr merge 5 -sd has no erroneous denial and is verified end to end', () => {
    const r = fx.decide(repo, 'gh pr merge 5 -sd');
    assert.equal(r.stderr, '');
    assert.equal(r.decision, 'allow', r.reason);
    assert.equal(r.explicit, true, 'this plain green merge should be verified end to end');
    assert.ok(r.ghCalls.some((call) => call.args[0] === 'pr' && call.args[1] === 'view' && call.args[2] === '5'));
  });
});
