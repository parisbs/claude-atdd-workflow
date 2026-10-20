// Issue #19 (ADR 0023): regression tests for the findings of the verification of the first implementation.
// Real-world input that is valid JSON but implausible, or a file system that does not cooperate, must never
// contaminate a report, abort a run or produce a report the validator rejects; a fork must not be able to
// inject workflow commands through a file name or tick the licence box inside a comment.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { cleanup, git, makeRepo, makeReport, put, repo, reportScript, runNode, tempDir } from './metrics-fixtures.mjs';

after(cleanup);

const usage = (input, output = 1) => ({ input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
const user = (timestamp, extra = {}) => ({
  type: 'user', timestamp, cwd: '/w', version: '2.1.299', entrypoint: 'cli', permissionMode: 'default',
  message: { role: 'user', content: 'hello' }, ...extra,
});
const assistant = (timestamp, id, use = usage(1), extra = {}) => ({
  type: 'assistant', timestamp, message: { id, model: 'claude-opus-5-5', role: 'assistant', content: [], usage: use }, ...extra,
});

// Writes each session as raw lines (strings are written as they are) under one project and runs the script.
function run(sessions, args = ['--since', '2026-10-01', '--until', '2026-10-31'], extra) {
  const dir = tempDir();
  const config = join(dir, 'config');
  const project = join(config, 'projects', '-w');
  for (const [name, lines] of Object.entries(sessions)) {
    put(join(project, `${name}.jsonl`), lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n');
  }
  extra?.(project);
  const out = join(dir, 'report.json');
  const r = runNode(reportScript, [...args, '--out', out], { cwd: dir, env: { CLAUDE_CONFIG_DIR: config } });
  return { r, out, report: r.status === 0 ? JSON.parse(readFileSync(out, 'utf8')) : null };
}

const summary = (r, label) => {
  const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith(`${label}: `));
  assert.ok(line, `no summary line ${label}`);
  return line.slice(label.length + 2);
};

let base;
const validate = (file) => {
  base ??= makeRepo();
  return runNode(join(base, 'scripts', 'metrics-validate.mjs'), [file, '--ref', 'main'], { cwd: base });
};

describe('metrics hardening (#19)', () => {
  test('AC-4 a UTF-8 byte order mark does not cost the first record', () => {
    const { r, report } = run({ s: [`﻿${JSON.stringify(user('2026-10-06T10:00:00.000Z'))}`, assistant('2026-10-06T10:00:01.000Z', 'm1')] });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(summary(r, 'Invalid lines skipped'), '0');
    assert.equal(report.sessions[0].cli_version, '2.1.299');
  });

  test('AC-4 a timestamp outside 1970 to 9999 or without a zone makes its record invalid, and the report stays valid', () => {
    const { r, out, report } = run({
      s: [
        user('0000-01-01T00:00:00.000Z'),
        user('+010000-01-01T00:00:00.000Z'),
        user('2026-10-06T09:00:00'),
        user('2026-10-06T10:00:00.000Z'),
        assistant('2026-10-06T10:00:30.000Z', 'm1'),
      ],
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(summary(r, 'Invalid lines skipped'), '3');
    assert.equal(report.sessions[0].week, '2026-W41');
    assert.equal(report.sessions[0].duration_minutes, 1);
    const v = validate(out);
    assert.equal(v.status, 0, v.stderr);
  });

  test('AC-4 a timestamp of an impossible day or time of day makes its record invalid', () => {
    const { r } = run({
      s: [user('2025-02-31T10:00:00.000Z'), user('2026-10-06T24:00:00.000Z'), user('2026-10-06T10:61:00Z'),
        user('2026-10-06T10:00:00.000Z'), assistant('2026-10-06T10:00:01.000Z', 'm1')],
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(summary(r, 'Invalid lines skipped'), '3');
  });

  test('AC-1 a resumed session that copies earlier messages adds no tool or skill call of theirs', () => {
    const call = (timestamp, id, name, input = {}) => ({ type: 'assistant', timestamp,
      message: { id, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id: `t_${id}`, name, input }], usage: usage(1) } });
    const { r, report } = run({
      a: [user('2026-10-06T10:00:00.000Z'), call('2026-10-06T10:00:01.000Z', 'm1', 'Bash'),
        call('2026-10-06T10:00:02.000Z', 'm2', 'Skill', { skill: 'atdd-oracle' })],
      // b copies m1 and m2 from a, then adds m3.
      b: [user('2026-10-07T10:00:00.000Z'), call('2026-10-07T10:00:01.000Z', 'm1', 'Bash'),
        call('2026-10-07T10:00:02.000Z', 'm2', 'Skill', { skill: 'atdd-oracle' }), call('2026-10-07T10:00:03.000Z', 'm3', 'Bash')],
    });
    assert.equal(r.status, 0, r.stderr);
    const total = (field, key) => report.sessions.reduce((sum, row) => sum + (row[field][key] ?? 0), 0);
    assert.equal(report.totals.requests, 3);
    assert.equal(total('tool_calls', 'Bash'), 2);
    assert.equal(total('tool_calls', 'Skill'), 1);
    assert.equal(total('skills', 'atdd-oracle'), 1);
  });

  test('AC-4 a token count that is not a safe integer makes its record invalid', () => {
    const { r, report } = run({
      s: [
        user('2026-10-06T10:00:00.000Z'),
        assistant('2026-10-06T10:00:01.000Z', 'm1', usage(1e300)),
        '{"type":"assistant","timestamp":"2026-10-06T10:00:02.000Z","message":{"id":"m2","model":"claude-opus-5-5","content":[],"usage":{"input_tokens":9007199254740993,"output_tokens":1}}}',
        assistant('2026-10-06T10:00:03.000Z', 'm3', usage(5)),
      ],
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(summary(r, 'Invalid lines skipped'), '2');
    assert.equal(report.sessions[0].requests, 1);
    assert.equal(report.totals.input_tokens, 5);
    assert.equal(summary(r, 'Input tokens'), '5');
  });

  test('AC-4 an unreadable path is skipped and counted, and the run goes on', () => {
    const { r, report } = run(
      { s: [user('2026-10-06T10:00:00.000Z'), assistant('2026-10-06T10:00:01.000Z', 'm1')] },
      undefined,
      // A file where the session's directory of subagents belongs.
      (project) => { mkdirSync(join(project, 's')); writeFileSync(join(project, 's', 'subagents'), 'not a directory'); },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(summary(r, 'Unreadable paths skipped'), '1');
    assert.equal(report.sessions.length, 1);
    assert.equal(report.sessions[0].subagents.count, 0);
  });

  test('AC-4 the record types and top-level keys Claude Code writes today are known', () => {
    const keys = { slug: 'x', agentId: 'x', attributionAgent: 'x', classifierMetaLines: [], toolEndsTurn: false, queueSkipSlashCommands: false,
      requestRef: 'x', attributionPlugin: 'x', logicalParentUuid: 'x', compactMetadata: {}, isVisibleInTranscriptOnly: false,
      isCompactSummary: false, retryInMs: 1, retryAttempt: 1, maxRetries: 1, source: 'x', usageLimitNote: 'x' };
    const { r } = run({
      s: [
        user('2026-10-06T10:00:00.000Z', keys),
        assistant('2026-10-06T10:00:01.000Z', 'm1'),
        ...['api-request-shape', 'api-request-blob', 'api-request', 'agent-setting'].map((type) => ({ type, timestamp: '2026-10-06T10:00:02.000Z' })),
      ],
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(summary(r, 'Unknown record types skipped'), '0');
    assert.equal(summary(r, 'Unknown keys skipped'), '0');
  });

  test('AC-10 fails on a count that is not a safe integer', () => {
    const report = JSON.parse(readFileSync(makeReport(), 'utf8'));
    report.totals.requests += 2 ** 53 - report.sessions[0].requests;
    report.sessions[0].requests = 2 ** 53;
    const file = join(tempDir(), 'report.json');
    writeFileSync(file, JSON.stringify(report));
    const v = validate(file);
    assert.notEqual(v.status, 0);
    assert.match(v.stderr, /safe|integer/i);
  });

  test('AC-10 a key the donation brings cannot start a line of the validator output', () => {
    const report = JSON.parse(readFileSync(makeReport(), 'utf8'));
    report['x\n::error::injected'] = 1;
    report.sessions[0].tool_calls['y\n::warning::w'] = 1;
    const file = join(tempDir(), 'report.json');
    writeFileSync(file, JSON.stringify(report));
    const v = validate(file);
    assert.notEqual(v.status, 0);
    for (const text of [v.stdout, v.stderr]) assert.doesNotMatch(text, /^::/m, 'a line that the runner reads as a command');
    assert.match(v.stderr, /injected/);
  });

  describe('AC-11 donation check', () => {
    const DONATED = 'docs/experiments/donated';
    const template = readFileSync(join(repo, '.github', 'PULL_REQUEST_TEMPLATE', 'metrics-donation.md'), 'utf8');
    const box = /^\s*[-*] \[ \] (.*CC0 1\.0.*)$/m.exec(template);

    // Adds files to a `donation` branch through the index, so that names a file system rejects still work.
    function check(files, body) {
      const dir = makeRepo();
      git(dir, 'checkout', '-q', '-b', 'donation');
      // Git for Windows refuses a colon in a path by default; the file is never checked out here, and a fork
      // made on another system can carry one.
      git(dir, 'config', 'core.protectNTFS', 'false');
      for (const [path, content] of Object.entries(files)) {
        const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: content, encoding: 'utf8' }).stdout.trim();
        git(dir, 'update-index', '--add', '--cacheinfo', `100644,${blob},${path}`);
      }
      git(dir, 'commit', '-q', '-m', 'donation');
      git(dir, 'checkout', '-q', '-f', 'main');
      const event = join(tempDir(), 'event.json');
      writeFileSync(event, JSON.stringify({ pull_request: { number: 1, body } }));
      return runNode(join(dir, 'scripts', 'metrics-donation-check.mjs'), ['--base', 'main', '--head', 'donation', '--event', event], { cwd: dir });
    }
    const valid = () => readFileSync(makeReport(), 'utf8');
    const ticked = () => template.replace(box[0], box[0].replace('[ ]', '[x]'));

    test('AC-11 a file name cannot start a workflow command or a new line in the output', () => {
      const r = check({ [`${DONATED}/x\n::error::INJECTED.json`]: valid() }, ticked());
      assert.notEqual(r.status, 0);
      for (const text of [r.stdout, r.stderr]) assert.doesNotMatch(text, /^::/m, 'a line that the runner reads as a command');
      assert.match(r.stderr, /INJECTED/);
    });

    test('AC-11 a key inside the donated report cannot start a line of the check output', () => {
      const report = JSON.parse(valid());
      report['x\n::error::injected'] = 1;
      const r = check({ [`${DONATED}/2026-W43-89abcdef.json`]: JSON.stringify(report) }, ticked());
      assert.notEqual(r.status, 0);
      for (const text of [r.stdout, r.stderr]) assert.doesNotMatch(text, /^::/m, 'a line that the runner reads as a command');
      assert.match(r.stderr, /injected/);
    });

    test('AC-11 a licence box ticked inside a fenced code block does not count', () => {
      const body = `${template}\n\`\`\`\n- [x] ${box[1]}\n\`\`\`\n`;
      const r = check({ [`${DONATED}/2026-W43-89abcdef.json`]: valid() }, body);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /licen[cs]e|CC0|checkbox|box/i);
    });

    test('AC-11 a licence box ticked inside an HTML comment does not count', () => {
      const body = `${template}\n<!--\n- [x] ${box[1]}\n-->\n`;
      const r = check({ [`${DONATED}/2026-W43-89abcdef.json`]: valid() }, body);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /licen[cs]e|CC0|checkbox|box/i);
    });

    test('AC-11 the licence error quotes the checkbox line to tick', () => {
      const r = check({ [`${DONATED}/2026-W43-89abcdef.json`]: valid() }, '');
      assert.notEqual(r.status, 0);
      assert.ok(r.stderr.includes(box[1].trim()), 'the error names the line to tick');
    });
  });

  test('AC-11 the donation workflow runs on the four events that change the pull request, once at a time, with a time limit', () => {
    const wf = readFileSync(join(repo, '.github', 'workflows', 'metrics-donation.yml'), 'utf8')
      .split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join('\n');
    const types = /^on:\s*\n\s+pull_request:\s*\n\s+types:\s*\[([^\]]*)\]/m.exec(wf);
    assert.ok(types);
    assert.deepEqual(types[1].split(',').map((t) => t.trim()).sort(), ['edited', 'opened', 'reopened', 'synchronize']);
    assert.match(wf, /^concurrency:\s*\n\s+group:[^\n]*github\.event\.pull_request\.number[^\n]*\n\s+cancel-in-progress:\s*true/m);
    assert.match(wf, /^\s+timeout-minutes:\s*\d+/m);
  });

  test('AC-12 the README links the donation template as GitHub applies it', () => {
    const text = readFileSync(join(repo, 'README.md'), 'utf8');
    assert.match(text, /\]\([^)]*[?&]template=metrics-donation\.md[^)]*\)/);
  });
});
