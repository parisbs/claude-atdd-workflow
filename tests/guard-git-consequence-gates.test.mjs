// Issue #73 (ADR 0034): unread commands ask or deny at each consequence gate, while ordinary work stays quiet.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { handlersFor, SETTINGS } from './claude-hooks.mjs';
import { fixture, POSIX, SESSIONS, silent, unread } from './guard-git-fixture.mjs';

describe('guard-git consequence gates (#73)', { skip: POSIX }, () => {
  let fx;
  let repo;
  let main;
  before(() => {
    fx = fixture();
    repo = fx.repository();
    main = fx.repository({ branch: 'main' });
  });
  after(() => fx?.close());

  function rule(ac, command, gate, part, options = {}) {
    for (const [who, session, expected] of SESSIONS) {
      test(`${ac} ${command} is unread at ${gate} for ${who}`, () => {
        unread(fx.decide(repo, command, { ...options, session }), expected, gate, part, command);
      });
    }
  }
  function quiet(ac, command, options = {}) {
    for (const [who, session] of SESSIONS) {
      test(`${ac} ${command} has no verdict for ${who}`, () => {
        silent(fx.decide(repo, command, { ...options, session }), command);
      });
    }
  }

  for (const command of [
    'printf "%s" "$UNREAD"', 'echo "$(date)"', 'npm install supabase',
    'rg -n "git push" global/hooks', 'echo gh pr merge', 'printf "%s" "gh pr merge"',
    'grep "gh pr merge" notes.txt', 'which git gh supabase', 'type gh', 'command -v gh', 'man git push',
    'git show --stat oracle/x', 'git log', 'git diff', 'git ls-remote origin', 'git fetch origin', 'gh pr view 5',
    'env git show --stat oracle/x', 'bash -c "git log"', 'git diff "$BASE"',
    'gh pr view 5 --json mergedAt', 'git merge-base main HEAD', 'git stage README.md',
    'gh pr create -f',
  ]) {
    // Creating a pull request belongs to the orchestrator, so only this control excludes a subagent.
    if (command === 'gh pr create -f') {
      test('AC-1 creating a pull request in the main session has no gate verdict', () => {
        silent(fx.decide(repo, command, { configured: true }), command);
      });
    } else quiet('AC-1', command, { configured: true });
  }

  for (const [command, gate, part] of [
    ['env gh pr "merge" 5 --squash', 'merge', /env/],
    ['env gh api -X PUT repos/o/r/pulls/5/merge', 'merge', /env/],
    ['env gh api graphql -f query=mutation{mergePullRequest}', 'merge', /env/],
    ['env git tag "oracle/x"', 'oracle tags', /env/],
    ['env git update-ref "refs/tags/oracle/x" HEAD', 'oracle tags', /env/],
    ['env git -c alias.publish=push publish', 'oracle tags', /env|alias/],
    ['env git commit --no-verif', 'skipped hooks', /env/],
    ['env git fetch --prune-ta', 'oracle tags', /env/],
    ['env git -c CORE.HOOKSPATH=/dev/null commit', 'skipped hooks', /env|HOOKSPATH/i],
    ['GIT_CONFIG_COUNT=1 env git commit', 'skipped hooks', /GIT_CONFIG_/],
    ['HUSKY_SKIP_HOOKS=1 env git commit', 'skipped hooks', /HUSKY/],
  ]) rule('AC-2', command, gate, part);

  for (const command of [
    'env git merge-base main HEAD', 'env git stage README.md',
    'echo "oracle/x refs/tags/x alias.x --no-v --prune-tags GIT_CONFIG_COUNT HUSKY hooksPath mergePullRequest"',
    "cat <<'EOF' > notes.txt\ngh pr merge 5; git push origin main; supabase db push\nEOF",
    "tee notes.txt <<'EOF'\ngh pr merge 5; git tag oracle/x; git commit --no-verify\nEOF",
    'git commit -m "gh pr merge; git push main; oracle/x; supabase db push"',
    'git commit --message "gh pr merge; git push main; oracle/x"',
    "git commit -m \"$(cat <<'EOF'\ngh pr merge 5\ngit push origin main\nsupabase db push\nEOF\n)\"",
    'gh pr create --title "gh pr merge; git push" --body "supabase db push; oracle/x"',
    "gh pr create -t \"$(cat <<'EOF'\ngh pr merge; git push main; oracle/x\nEOF\n)\" -b safe",
  ]) {
    if (command.startsWith('gh pr create')) {
      test(`AC-2 message data in ${command} does not trigger a gate in the main session`, () => {
        silent(fx.decide(repo, command, { configured: true }), command);
      });
    } else quiet('AC-2', command, { configured: true });
  }
  for (const session of [{ permission_mode: 'default' }, { permission_mode: 'bypassPermissions' }]) {
    test(`AC-2 mergedAt is not merge in ${session.permission_mode}`, () => {
      const command = 'env gh api repos/o/r/pulls/5/mergedAt';
      silent(fx.decide(repo, command, { configured: true, session }), command);
    });
  }
  for (const flag of ['--subject', '-t', '--title', '-b', '--body']) {
    test(`AC-2 gh ${flag} data cannot invent a second gate`, () => {
      const command = `gh pr create ${flag} "git push main; gh pr merge; supabase db push"`;
      silent(fx.decide(repo, command), command);
    });
  }

  for (const [who, session, expected] of SESSIONS) {
    test(`AC-3 an injected exception at a gated command asks or denies for ${who}`, () => {
      const command = 'printf ready; env gh pr merge 5 --squash';
      const r = fx.decide(repo, command, { session, extraEnv: { GUARD_GIT_TEST_THROW: '1' } });
      unread(r, expected, 'merge', /throw|exception|injected/i, command);
    });
    test(`AC-3 an injected exception keeps an earlier denial for ${who}`, () => {
      const command = 'git commit --no-verify; env gh pr merge 5 --squash';
      const r = fx.decide(repo, command, { session, extraEnv: { GUARD_GIT_TEST_THROW: '1' } });
      unread(r, 'deny', 'merge', /throw|exception|injected/i, command);
      assert.match(r.reason, /skip hooks|--no-verify/i);
    });
    test(`AC-3 an injected exception keeps an earlier question for ${who}`, () => {
      const command = 'git tag oracle/new; env gh pr merge 5 --squash';
      const r = fx.decide(repo, command, { session, extraEnv: { GUARD_GIT_TEST_THROW: '1' } });
      unread(r, expected, 'merge', /throw|exception|injected/i, command);
      assert.match(r.reason, /Creating an oracle tag|freezes the approved tests/i);
    });
    test(`AC-3 an exception away from a gate stays visible and silent on stdout for ${who}`, () => {
      const r = fx.decide(repo, 'printf ready; printf done', { session, extraEnv: { GUARD_GIT_TEST_THROW: '1' } });
      assert.equal(r.decision, 'allow');
      assert.equal(r.explicit, false);
      assert.match(r.stderr, /guard-git:.*(?:could not evaluate|allowing)/i);
    });
    test(`AC-3 a decision budget bounds a required git read at a gate for ${who}`, () => {
      const command = 'git push origin main';
      const r = fx.decide(main, command, { session,
        extraEnv: { GUARD_GIT_DECISION_BUDGET_MS: '300', FAKE_GIT_HANG: '1' } });
      assert.ok(r.gitCalls.some((call) => call.delayed), 'the required branch read did not reach the fake git');
      unread(r, expected, 'push to a protected branch', /budget|deadline|timed? out/i, command);
      assert.ok(!r.gitCalls.some((call) => call.completed), 'the decision waited for the delayed read to complete');
    });
    test(`AC-3 a spent budget keeps verdicts already collected for ${who}`, () => {
      const command = 'git tag oracle/new; git push origin main';
      const r = fx.decide(main, command, { session,
        extraEnv: { GUARD_GIT_DECISION_BUDGET_MS: '750', FAKE_GIT_HANG: '1', FAKE_GIT_HANG_AFTER: '2' } });
      assert.ok(r.gitCalls.some((call) => call.delayed), 'the delayed read was not reached');
      unread(r, expected, 'push to a protected branch', /budget|deadline|timed? out/i, command);
      assert.match(r.reason, /Creating an oracle tag|freezes the approved tests/i);
      assert.ok(!r.gitCalls.some((call) => call.completed), 'the decision waited for the delayed read to complete');
    });
    test(`AC-3 a spent budget away from gates allows with a visible message for ${who}`, () => {
      const r = fx.decide(repo, 'git status', { session,
        extraEnv: { GUARD_GIT_DECISION_BUDGET_MS: '300', FAKE_GIT_HANG: '1' } });
      assert.ok(r.gitCalls.some((call) => call.delayed), 'the git read did not reach the fake git');
      assert.equal(r.decision, 'allow');
      assert.equal(r.explicit, false);
      assert.match(r.stderr, /guard-git:.*(?:budget|deadline|timed? out)/i);
      assert.ok(!r.gitCalls.some((call) => call.completed), 'the decision waited for the delayed read to complete');
    });
  }
  for (const member of ['constructor', 'toString', '__proto__']) {
    test(`AC-3 gh ${member} cannot throw or erase a later subagent denial`, () => {
      const session = { agent_id: 'agent-73' };
      const alone = fx.decide(repo, `gh ${member}`, { session });
      assert.equal(alone.stderr, '');
      assert.equal(alone.decision, 'deny', alone.reason);
      const chained = fx.decide(repo, `gh ${member}; gh pr create -f`, { session });
      assert.equal(chained.stderr, '');
      assert.equal(chained.decision, 'deny', chained.reason);
      assert.match(chained.reason, /gh pr create/);
    });
  }

  for (const [command, part] of [
    ['echo $(gh pr merge 5 --squash)', /substitution|\$\(/i],
    ['echo `gh pr merge 5 --squash`', /backtick|`/i],
    ['(gh pr merge 5 --squash)', /subshell|\(/i],
    ['{ gh pr merge 5 --squash; }', /brace|\{/i],
    ['f() { gh pr merge 5 --squash; }; f', /function|body|f\(\)/i],
    ['printf ready & gh pr merge 5 --squash', /background|&/i],
    ...['bash', 'sh', 'zsh'].map((shell) => [`${shell} -c 'gh pr merge 5 --squash'`, new RegExp(shell)]),
    ["eval 'gh pr merge 5 --squash'", /eval/],
    ["python -c 'import os; os.system(\"gh pr merge 5 --squash\")'", /python/],
    ["node -e 'require(\"child_process\").execSync(\"gh pr merge 5 --squash\")'", /node/],
    ["bash <<'EOF'\ngh pr merge 5 --squash\nEOF", /heredoc|bash|<</i],
    ...['env', 'command', 'exec', 'sudo', 'nohup', 'time', 'nice', 'timeout 10', 'xargs', 'ionice', 'unknown-runner']
      .map((prefix) => [`${prefix} gh pr merge 5 --squash`, new RegExp(prefix.split(' ')[0])]),
    ['FOO="a b" gh pr merge 5 --squash', /FOO|assignment/i],
  ]) rule('AC-4', command, 'merge', part);
  for (const [command, gate] of [
    ['env git push origin main', 'push to a protected branch'],
    ['env git tag -d oracle/x', 'oracle tags'],
    ['env git push origin refs/tags/v1.0.0', 'release tags'],
    ['env git commit --no-verify', 'skipped hooks'],
    ['env supabase db push', 'remote Supabase actions'],
  ]) rule('AC-4', command, gate, /env/);
  test('AC-4 an unread subagent GitHub action names that gate', () => {
    unread(fx.decide(repo, 'env gh pr create -f', { session: { agent_id: 'agent-73' } }),
      'deny', 'GitHub actions of a subagent', /env/, 'env gh pr create -f');
  });

  for (const [command, gate, part] of [
    ['git push origin $B', 'push to a protected branch', /\$B/],
    ['git -C $R push origin main', 'push to a protected branch', /\$R/],
    ['gh pr merge $N --squash', 'merge', /\$N/],
    ['gh pr merge `printf 5` --squash', 'merge', /backtick|`/i],
    ['git push origin feature/?', 'push to a protected branch', /glob|\?/i],
    ['git push origin [ab]:main', 'push to a protected branch', /glob|\[ab\]/i],
    ['git push origin feature/*', 'push to a protected branch', /glob|\*/i],
    ['gh pr merge fi"ve" --squash', 'merge', /quote|fi"ve"/i],
    ['gh pr merge "fi|ve" --squash', 'merge', /operator|fi\|ve|quote/i],
    ['\\gh pr merge 5 --squash', 'merge', /escaped|\\gh/i],
    ['"git" push origin main', 'push to a protected branch', /quoted|"git"/i],
  ]) rule('AC-5', command, gate, part);
  for (const value of ['--subject "$SUBJECT"', '--subject "`date`"', '--match-head-commit "$SHA"']) {
    test(`AC-5 an unread ${value} value does not change a literal merge decision`, () => {
      const command = `gh pr merge 5 --squash ${value}`;
      const r = fx.decide(repo, command);
      assert.equal(r.stderr, '');
      assert.equal(r.decision, 'allow', r.reason);
      assert.equal(r.explicit, false, 'a non-plain command cannot lift the permission prompt');
      assert.ok(r.ghCalls.some((call) => call.args[0] === 'pr' && call.args[1] === 'view' && call.args[2] === '5'));
    });
  }
  quiet('AC-5', 'gh pr view 5 --jq "$QUERY"');
  test('AC-5 a variable in another command does not change the literal merge decision', () => {
    const r = fx.decide(repo, 'printf "%s" "$VALUE"; gh pr merge 5 --squash');
    assert.equal(r.stderr, '');
    assert.equal(r.decision, 'allow', r.reason);
    assert.equal(r.explicit, false);
    assert.ok(r.ghCalls.some((call) => call.args[0] === 'pr' && call.args[1] === 'view'));
  });

  for (const [command, gate, part] of [
    ['git --git-dir /tmp/repo.git push origin main', 'push to a protected branch', /--git-dir/],
    ['git --work-tree /tmp/tree push origin main', 'push to a protected branch', /--work-tree/],
    ...['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE'].map((key) =>
      [`${key}=elsewhere git push origin main`, 'push to a protected branch', new RegExp(key)]),
    ['GIT_CONFIG_COUNT=1 git commit -m safe', 'skipped hooks', /GIT_CONFIG_COUNT/],
    ['GIT_CONFIG_KEY_0=core.hooksPath git commit -m safe', 'skipped hooks', /GIT_CONFIG_KEY_0/],
    ['GIT_CONFIG_VALUE_0=/dev/null git commit -m safe', 'skipped hooks', /GIT_CONFIG_VALUE_0/],
    ...['GH_REPO', 'GH_HOST', 'GH_TOKEN'].map((key) => [`${key}=other gh pr merge 5 --squash`, 'merge', new RegExp(key)]),
    ['git -c alias.ship=push ship origin main', 'oracle tags', /alias\.ship/],
    ['git unknown-command oracle/x', 'oracle tags', /unknown-command/],
    ['cd $R && gh pr merge 5 --squash', 'merge', /\$R|cd/],
  ]) rule('AC-6', command, gate, part);
  test('AC-6 GH_PAGER is a resolved ordinary assignment', () => {
    const r = fx.decide(repo, 'GH_PAGER=cat gh pr merge 5 --squash');
    assert.equal(r.stderr, '');
    assert.equal(r.decision, 'allow', r.reason);
    assert.equal(r.explicit, false);
    assert.ok(r.ghCalls.some((call) => call.args[0] === 'pr' && call.args[1] === 'view'));
  });

  for (const [command, gate, part] of [
    ['gh api -X PUT repos/o/r/pulls/5/merge', 'merge', /gh api|\/merge/],
    ["gh api graphql -f 'query=mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'", 'merge', /gh api|mergePullRequest/],
    ['git push --prune origin', 'oracle tags', /--prune/],
    ['git update-ref --stdin', 'oracle tags', /--stdin/],
    ...['--prune-tags', '--prune-t', '-P', '-pP'].map((flag) => [`git fetch ${flag} origin`, 'oracle tags', new RegExp(flag)]),
    ['git fetch origin +refs/tags/*:refs/tags/*', 'oracle tags', /fetch|refspec|\*/i],
    ['git config core.hooksPath /dev/null', 'skipped hooks', /config|hooksPath/],
    ['GIT_CONFIG_PARAMETERS=core.hooksPath=/dev/null git commit -m safe', 'skipped hooks', /GIT_CONFIG_PARAMETERS/],
    ['git push --future-option origin main', 'push to a protected branch', /--future-option/],
    ['git tag --future-option -d oracle/x', 'oracle tags', /--future-option/],
    ['gh pr merge 5 --squash --future-option', 'merge', /--future-option/],
  ]) rule('AC-7', command, gate, part);
  for (const flag of ['--all', '--branches', '--mirror']) {
    for (const [who, session] of SESSIONS) {
      test(`AC-7 ${flag} includes published main and is denied for ${who}`, () => {
        const r = fx.decide(repo, `git push ${flag} origin`, { session });
        assert.equal(r.stderr, '');
        assert.equal(r.decision, 'deny', r.reason);
        assert.match(r.reason, /main/);
      });
    }
  }
  for (const command of [
    'git push origin v1.0.0', 'git push origin tag v1.0.0', 'git push origin tags/v1.0.0',
    'git push --tags origin', 'git push --follow-tags origin',
  ]) {
    for (const [who, session] of SESSIONS) {
      test(`AC-7 ${command} follows the canonical release-tag push rule for ${who}`, () => {
        const r = fx.decide(repo, command, { session });
        assert.equal(r.stderr, '');
        assert.equal(r.decision, session.agent_id ? 'deny' : 'ask', r.reason);
      });
    }
  }
  for (const command of [
    'git merge --no-verify feature/work', 'git rebase --no-verify main', 'git am --no-verify patch.mbox',
    'git -c core.hooksPath=/dev/null commit -m safe', 'git -c core.hooksPath=/dev/null push origin feature/work',
    'HUSKY=0 git commit -m safe', 'HUSKY_SKIP_HOOKS=1 git commit -m safe',
  ]) {
    for (const [who, session] of SESSIONS) {
      test(`AC-7 ${command} denies skipped hooks for ${who}`, () => {
        const r = fx.decide(repo, command, { session });
        assert.equal(r.stderr, '');
        assert.equal(r.decision, 'deny', r.reason);
        assert.match(r.reason, /hook|verify|HUSKY/i);
      });
    }
  }
  test('AC-7 known short push options remain read', () => {
    silent(fx.decide(repo, 'git push -uq origin feature/work'), 'git push -uq origin feature/work');
  });

  for (const action of [
    'db push', 'functions deploy worker', 'secrets set X=y', 'secrets unset X',
    'db reset --linked', 'migration repair 1 --status applied', 'db diff --linked', 'db dump --db-url postgres://local/db',
  ]) {
    rule('AC-8', `env supabase ${action}`, 'remote Supabase actions', /env/);
    for (const prefix of ['supabase', 'npx supabase']) {
      for (const [who, session] of SESSIONS) {
        test(`AC-8 ${prefix} ${action} keeps its read-form question for ${who}`, () => {
          const r = fx.decide(repo, `${prefix} ${action}`, { session });
          assert.equal(r.stderr, '');
          assert.equal(r.decision, 'ask', r.reason);
          assert.match(r.reason, /Supabase/i);
        });
      }
    }
  }
  rule('AC-8', 'env npx supabase db push', 'remote Supabase actions', /env/);
  for (const command of ['env gh pr create -f', 'env git push origin feature/work']) {
    test(`AC-8 ${command} is denied at the subagent GitHub gate`, () => {
      unread(fx.decide(repo, command, { session: { agent_id: 'agent-73' } }),
        'deny', 'GitHub actions of a subagent', /env/, command);
    });
  }

  test('AC-9 every Bash entry has no if and the merge entry keeps its failure block and timeouts', () => {
    const handlers = handlersFor('Bash');
    const every = handlers.find((h) => h.command.includes('guard-git.mjs') && h.command.includes('--skip-merge'));
    const merge = handlers.find((h) => h.command.includes('guard-git.mjs') && h.command.includes('--merge-only'));
    assert.ok(every);
    assert.ok(merge);
    assert.equal(Object.hasOwn(every, 'if'), false);
    assert.equal(every.timeout, 15);
    assert.equal(merge.if, 'Bash(*gh pr merge *)');
    assert.equal(merge.timeout, 30);
    assert.equal(merge.onFailure, 'block');
  });
  rule('AC-9', 'env gh pr merge 5 --squash', 'merge', /env/, { configured: true });
  for (const [who, session, expected] of SESSIONS) {
    test(`AC-9 the configured every-Bash entry alone catches unread merges for ${who}`, () => {
      const settings = { ...SETTINGS, hooks: { ...SETTINGS.hooks, PreToolUse: SETTINGS.hooks.PreToolUse
        .map((entry) => ({ ...entry, hooks: entry.hooks.filter((h) => h.command.includes('--skip-merge')) })) } };
      const command = 'env gh pr merge 5 --squash';
      const r = fx.decide(repo, command, { configured: true, settings, session });
      assert.equal(r.ran.length, 1);
      assert.match(r.ran[0], /--skip-merge/);
      unread(r, expected, 'merge', /env/, command);
    });
  }
  test('AC-9 a verified merge cannot print allow for an unread command in the same call', () => {
    const command = 'gh pr merge 5 --squash; env gh pr merge 6 --squash';
    const r = fx.decide(repo, command, { configured: true });
    unread(r, 'ask', 'merge', /env/, command);
  });

  for (const operator of [';', '|', '&&', '||', '\n']) {
    for (const [who, session] of SESSIONS) {
      test(`AC-10 quoted ${JSON.stringify(operator)} cannot hide --admin for ${who}`, () => {
        const r = fx.decide(repo, `gh pr merge 5 --squash --subject "a${operator} b" --admin`, { session, configured: true });
        assert.equal(r.stderr, '');
        assert.equal(r.decision, 'deny', r.reason);
        assert.match(r.reason, session.agent_id ? /subagent/i : /--admin/);
      });
    }
    quiet('AC-10', `rg -n "foo${operator}git push" .`, { configured: true });
  }
});
