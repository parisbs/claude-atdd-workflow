// Issue #76: the merge verdict must use each changed record's front matter at the PR head.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, POSIX } from './guard-git-fixture.mjs';

const ADR = 'docs/adr/0001-choice.md';
const OTHER = 'docs/releasing.md';
const record = (status) => `---\nstatus: ${status}\ndate: 2026-10-30\n---\n# Choice\n\nStatus: ${status === 'accepted' ? 'proposed' : 'accepted'}\n`;
const bypass = { permission_mode: 'bypassPermissions' };
const proposedReason = /proposed|accept\b.*(?:record|ADR)|(?:record|ADR).*accept\b/i;

function merge(t, { paths = [ADR, OTHER], statuses = { [ADR]: 'proposed' }, session,
  labels = [], baseStatuses = {}, failures = {} } = {}) {
  const f = fixture();
  t.after(() => f.close());
  const repo = f.repository();
  const contents = {};
  for (const [path, status] of Object.entries(statuses)) {
    if (status !== null) contents[`${path}?ref=${repo.b}`] = { stdout: record(status) };
  }
  for (const [path, status] of Object.entries(baseStatuses)) {
    for (const ref of ['main', repo.a]) contents[`${path}?ref=${ref}`] = { stdout: record(status) };
  }
  for (const [path, stderr] of Object.entries(failures)) contents[`${path}?ref=${repo.b}`] = { exit: 1, stderr };
  const result = f.decide(repo, 'gh pr merge 5 --squash', {
    session, contents, pr: { files: paths.map((path) => ({ path })), changedFiles: paths.length,
      labels: labels.map((name) => ({ name })) },
  });
  assert.equal(result.stderr, '');
  return { ...result, head: repo.b };
}

function evidence(result, paths = [ADR, OTHER]) {
  assert.match(result.reason, /proposed/i);
  for (const path of paths) assert.ok(result.reason.includes(path), `missing ${path}: ${result.reason}`);
}

function remedies(reason) {
  assert.match(reason, /accept[\s\S]*(?:this|same)[\s\S]*(?:pull request|PR)\b/i);
  assert.match(reason, /(?:move|split|separat)[\s\S]*(?:own|separate)[\s\S]*(?:pull request|PR)\b/i);
}

for (const directory of ['docs/adr', 'docs/adrs', 'docs/decisions', 'packages/api/docs/adr', 'packages/api/docs/adrs', 'packages/api/docs/decisions']) {
  test(`AC-1 asks with every proposed record and outside path in ${directory}`, { skip: POSIX }, (t) => {
    const first = `${directory}/0001-choice.md`;
    const second = `${directory}/0002-choice.md`;
    const paths = [first, second, OTHER, 'src/app.mjs'];
    const result = merge(t, { paths, statuses: { [first]: 'proposed', [second]: 'ProPoSeD, awaiting review' } });
    assert.equal(result.decision, 'ask');
    evidence(result, paths);
    remedies(result.reason);
  });
}

test('AC-2 denies a mixed PR in bypassPermissions with record and other path evidence', { skip: POSIX }, (t) => {
  const result = merge(t, { session: bypass });
  assert.equal(result.decision, 'deny', result.reason);
  evidence(result);
  remedies(result.reason);
});

test('AC-3 keeps the subagent merge denial', { skip: POSIX }, (t) => {
  const result = merge(t, { session: { permission_mode: 'default', agent_id: 'agent-76' } });
  assert.equal(result.decision, 'deny', result.reason);
  assert.match(result.reason, /subagent/i);
});

test('AC-4 a proposed record and ADR index only still ask in bypassPermissions without a proposed reason', { skip: POSIX }, (t) => {
  const result = merge(t, { paths: [ADR, 'docs/adr/README.md'], session: bypass });
  assert.equal(result.decision, 'ask', result.reason);
  assert.doesNotMatch(result.reason, proposedReason);
});

for (const [name, status] of [['accepted at head', 'accepted'], ['deleted at head', null]]) {
  test(`AC-5 ${name} adds no proposed reason`, { skip: POSIX }, (t) => {
    const result = merge(t, { statuses: { [ADR]: status }, session: bypass });
    assert.equal(result.decision, 'ask', result.reason);
    assert.doesNotMatch(result.reason, proposedReason);
  });
}

test('AC-5 reads accepted status at headRefOid even when the base is proposed', { skip: POSIX }, (t) => {
  const result = merge(t, { statuses: { [ADR]: 'accepted' }, baseStatuses: { [ADR]: 'proposed' }, session: bypass });
  assert.equal(result.decision, 'ask', result.reason);
  assert.doesNotMatch(result.reason, proposedReason);
  assert.ok(result.ghCalls.some(({ args }) => args.some((arg) => {
    const decoded = decodeURIComponent(arg);
    return decoded.includes(`repos/o/r/contents/${ADR}`) && decoded.includes(`ref=${result.head}`);
  })), 'must read the changed record at headRefOid');
});

test('AC-5 indexes and templates are not records and body status does not override front matter', { skip: POSIX }, (t) => {
  const result = merge(t, { paths: [ADR, 'docs/adr/README.md', 'docs/adr/template.md', OTHER], session: bypass,
    statuses: { [ADR]: 'accepted', 'docs/adr/README.md': 'proposed', 'docs/adr/template.md': 'proposed' } });
  assert.equal(result.decision, 'ask', result.reason);
  assert.doesNotMatch(result.reason, proposedReason);
});

for (const label of ['experiment', 'Experiment']) {
  test(`AC-6 ${label} lifts the bypass denial but retains declared experiment evidence`, { skip: POSIX }, (t) => {
    const result = merge(t, { session: bypass, labels: [label] });
    assert.equal(result.decision, 'ask', result.reason);
    evidence(result);
    assert.match(result.reason, /declared[\s\S]*experiment/i);
  });
}

for (const [name, session, decision] of [['main session', { permission_mode: 'default' }, 'ask'], ['bypassPermissions', bypass, 'deny']]) {
  test(`AC-7 unreadable head status in ${name} ${decision === 'deny' ? 'denies' : 'asks'} and names the record`, { skip: POSIX }, (t) => {
    const result = merge(t, { session, failures: { [ADR]: 'gh: Server Error (HTTP 500)' } });
    assert.equal(result.decision, decision, result.reason);
    assert.ok(result.reason.includes(ADR), result.reason);
    assert.match(result.reason, /(?:could not|cannot|unable|unreadable|failed)[\s\S]*(?:status|record|ADR)|(?:status|record|ADR)[\s\S]*(?:could not|cannot|unable|unreadable|failed)/i);
  });
}
