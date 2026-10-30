// Issue #73, review 2: executable shell forms reach gates; data forms stay quiet.
import { after, before, describe, test } from 'node:test';
import { fixture, POSIX, SESSIONS, silent, unread } from './guard-git-fixture.mjs';

describe('guard-git consequence gates, second review (#73)', { skip: POSIX }, () => {
  let fx;
  let repo;
  before(() => {
    fx = fixture();
    repo = fx.repository();
  });
  after(() => fx?.close());

  function rule(command, gate, part, options = {}) {
    for (const [who, session, expected] of SESSIONS) {
      test(`${JSON.stringify(command)} asks or denies at ${gate} for ${who}`, () => {
        unread(fx.decide(repo, command, { ...options, session }), expected, gate, part, command);
      });
    }
  }

  function merge(command, part) {
    for (const [entry, options] of [
      ['all gates', {}], ['--merge-only', { mode: '--merge-only' }],
      ['configured entries', { configured: true }],
    ]) {
      describe(entry, () => rule(command, 'merge', part, options));
    }
  }

  function quiet(command) {
    for (const [who, session] of SESSIONS) {
      test(`${JSON.stringify(command)} has no verdict for ${who}`, () => {
        silent(fx.decide(repo, command, { session }), command);
      });
    }
  }

  describe('S-A (F-A): interpreter here-strings', () => {
    for (const command of [
      "bash <<< 'git push origin main'",
      `python3 <<< 'import os; os.system("git push origin main")'`,
    ]) rule(command, 'push to a protected branch', /here-string|<<</i);
    merge('sh <<<"gh pr merge 5 --squash --admin"', /here-string|<<</i);

    quiet("grep x <<< 'git push origin main'");
    quiet('cat <<< "gh pr merge 5"');
  });

  describe('S-B (F-B): heredocs reaching prefixed interpreters or stdin readers', () => {
    for (const command of [
      "env bash <<'EOF'\ngit push origin main\nEOF",
      "sudo sh <<'EOF'\ngit push origin main\nEOF",
      'timeout 60 bash <<EOF\ngit push origin main\nEOF',
      "source /dev/stdin <<'EOF'\ngit push origin main\nEOF",
      ". /dev/stdin <<'EOF'\ngit push origin main\nEOF",
      "cat <<'EOF' | env bash\ngit push origin main\nEOF",
    ]) rule(command, 'push to a protected branch', /heredoc|<</i);

    for (const command of [
      "cat <<'EOF' > notes.txt\nRun git push origin main or gh pr merge 5.\nEOF",
      "tee notes.txt <<'EOF'\nRun git push origin main or gh pr merge 5.\nEOF",
      "git commit -F - <<'EOF'\nDocument git push origin main in the guide.\nEOF",
    ]) quiet(command);
  });

  describe('S-C (F-C): prefixes with arguments before gate commands', () => {
    for (const [command, part] of [
      ['env FOO=1 git push origin main', /\bprefix env\b/i],
      ['env -u X git push origin main', /\bprefix env\b/i],
      ['timeout 30s git push origin main', /\bprefix timeout\b/i],
      ['timeout -k 5 30 git push origin main', /\bprefix timeout\b/i],
      ['sudo -u bob git push origin main', /\bprefix sudo\b/i],
    ]) rule(command, 'push to a protected branch', part);

    merge('env GH_HOST=x gh pr merge 5 --squash --admin', /\bprefix env\b/i);
    merge('exec -a n gh pr merge 5 --squash', /\bprefix exec\b/i);
    rule('nice -n 5 git commit --no-verify -m x', 'skipped hooks', /\bprefix nice\b/i);

    for (const [command, part] of [
      ['timeout 30s git push origin feature/y', /\bprefix timeout\b/i],
      ['env FOO=1 gh pr create -f', /\bprefix env\b/i],
    ]) {
      test(`${JSON.stringify(command)} denies a subagent GitHub action`, () => {
        unread(fx.decide(repo, command, { session: SESSIONS[1][1] }), 'deny',
          'GitHub actions of a subagent', part, command);
      });
    }

    // ADR 0034 names xargs -n 1 gh ... as a gap: its option values have no rule.
    for (const command of ['env FOO=1 npm test', 'timeout 30s git log', 'time git status']) quiet(command);
  });

  describe('S-D (F-D): process substitutions', () => {
    rule('cat <(git push origin main)', 'push to a protected branch', /process substitution|<\(/i);
    rule('tee >(gh pr merge 5 --squash --admin) < /dev/null', 'merge', /process substitution|>\(/i);
    rule('diff <(gh pr merge 5 --squash) x', 'merge', /process substitution|<\(/i);
    quiet('diff <(git show HEAD:a) <(git show HEAD~1:a)');
  });

  describe('S-E (F-E): locale-quoted gate words never stay silent', () => {
    rule('$"git" push origin main', 'push to a protected branch', /\$"git"/);
    rule('git $"push" origin main', 'push to a protected branch', /\$"push"/);
    merge('$"gh" pr merge 5 --squash --admin', /\$"gh"/);
  });
});
