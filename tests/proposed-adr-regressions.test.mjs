// A-11 review: pin unreadable records, ADR-only read avoidance, and approval attribution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proposedAdrChange } from '../global/hooks/proposed-adr.mjs';
import { fixture, POSIX } from './guard-git-fixture.mjs';

const ADR = 'docs/adr/0001-choice.md';
const OTHER = 'docs/releasing.md';
const bypass = { permission_mode: 'bypassPermissions' };
const proposed = '---\nstatus: proposed\n---\n# Choice\n';
const notFound = { exit: 1, stderr: 'gh: Not Found (HTTP 404)' };

function merge(t, { paths = [ADR, OTHER], additions = 1, content = { stdout: proposed }, session } = {}) {
  const f = fixture();
  t.after(() => f.close());
  const repo = f.repository();
  const result = f.decide(repo, 'gh pr merge 5 --squash', {
    session, contents: { [`${ADR}?ref=${repo.b}`]: content },
    pr: { files: paths.map((path) => ({ path, additions })), changedFiles: paths.length },
  });
  assert.equal(result.stderr, '');
  return result;
}

for (const [name, session, decision] of [
  ['main session', { permission_mode: 'default' }, 'ask'],
  ['bypassPermissions', bypass, 'deny'],
]) {
  test(`F1 a 404 for a record with additions in ${name} is unreadable at the head`, { skip: POSIX }, (t) => {
    const result = merge(t, { content: notFound, session });
    assert.equal(result.decision, decision, result.reason);
    assert.ok(result.reason.includes(`Could not read the status of ADR record ${ADR} at the pull request head`), result.reason);
  });
}

test('F1 a 404 for a record with zero additions is a deletion', { skip: POSIX }, (t) => {
  const result = merge(t, { additions: 0, content: notFound, session: bypass });
  assert.equal(result.decision, 'ask', result.reason);
  assert.doesNotMatch(result.reason, /proposed|could not read the status|unreadable/i);
});

test('F2 ADR-directory-only changes never call readRecord', () => {
  const reads = [];
  const result = proposedAdrChange([ADR, 'docs/adr/README.md'], (path) => {
    reads.push(path);
    return proposed;
  });
  assert.deepEqual(reads, [], 'ADR-directory-only changes must not read records');
  assert.deepEqual(result, { proposed: [], other: [], mixed: false });
});

test('F2 ADR-directory-only PRs make no gh contents reads for records', { skip: POSIX }, (t) => {
  const result = merge(t, { paths: [ADR, 'docs/adr/README.md'], session: bypass });
  const reads = result.ghCalls.filter(({ args }) => args[0] === 'api'
    && args.some((arg) => decodeURIComponent(arg).includes('repos/o/r/contents/docs/adr/')));
  assert.deepEqual(reads, [], 'ADR-directory-only PRs must not spend gh calls on records');
  assert.equal(result.decision, 'ask', result.reason);
});

test('F3 a mixed proposed ADR denial attributes approval to the merge', { skip: POSIX }, (t) => {
  const result = merge(t, { session: bypass });
  assert.equal(result.decision, 'deny', result.reason);
  assert.ok(result.reason.includes(ADR), result.reason);
  assert.match(result.reason, /proposed/i);
  assert.doesNotMatch(result.reason, /oracle requires/i);
  assert.match(result.reason, /this merge requires human approval/i);
});
