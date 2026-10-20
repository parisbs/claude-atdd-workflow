// Issue #19 (ADR 0023): scripts/metrics-report.mjs turns Claude Code transcripts into a report a contributor
// can donate. The fixtures and the contract are in metrics-fixtures.mjs. Each test writes its own transcripts
// in a temporary directory and runs the real script.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { after, describe, test } from 'node:test';
import {
  RANGE, ROW_A, ROW_B, ROW_F, cleanup, copyScripts, isoWeek, reportScript, runNode, sortRows, tempDir, writeTranscripts,
} from './metrics-fixtures.mjs';

after(cleanup);

const HEADER_KEYS = ['generated_week', 'license', 'schema_version', 'script_sha256', 'script_version', 'sessions', 'totals'];

function generate(args = RANGE, { fixture = writeTranscripts } = {}) {
  const dir = tempDir();
  const config = join(dir, 'config');
  const paths = fixture(config);
  const out = join(dir, 'report.json');
  const r = runNode(reportScript, [...args, '--out', out], { cwd: dir, env: { CLAUDE_CONFIG_DIR: config } });
  return { dir, out, paths, r, report: r.status === 0 ? JSON.parse(readFileSync(out, 'utf8')) : null };
}

const leaks = (text) => [...new Set(text.match(/canary\w*/gi) ?? [])];

describe('metrics-report (#19)', () => {
  test('AC-1 writes the header and one row per session in the range, with exact counts', () => {
    const before = isoWeek(new Date());
    const { r, report } = generate();
    const after = isoWeek(new Date());
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(Object.keys(report).sort(), HEADER_KEYS);
    assert.equal(report.schema_version, 1);
    assert.match(report.script_version, /^\d+\.\d+\.\d+$/);
    assert.match(report.script_sha256, /^[0-9a-f]{64}$/);
    assert.ok([before, after].includes(report.generated_week), `generated_week ${report.generated_week} is not the current week`);
    assert.equal(report.license, 'CC0-1.0');
    // A: streamed records of one message counted once at their largest value per field, every tool call of
    // its records counted once, a synthetic message and invalid records ignored, a zero-usage request counted,
    // subagents in the row without the copy of a main message. B: copies of messages first written in A and
    // in D (out of the range) not counted again. C, D: out of the range. E: no request.
    assert.deepEqual(sortRows(report.sessions), sortRows([ROW_A, ROW_B, ROW_F]));
    assert.deepEqual(report.totals, {
      sessions: 3, requests: 8, input_tokens: 25, output_tokens: 446, cache_creation_input_tokens: 543, cache_read_input_tokens: 3214,
    });
  });

  test('AC-1 consecutive ranges share no row and together hold every session', () => {
    const first = generate(['--since', '2026-10-05', '--until', '2026-10-08']);
    const second = generate(['--since', '2026-10-09', '--until', '2026-10-11']);
    assert.equal(first.r.status, 0, first.r.stderr);
    assert.equal(second.r.status, 0, second.r.stderr);
    assert.deepEqual(sortRows(first.report.sessions), sortRows([ROW_A, ROW_F]));
    assert.deepEqual(sortRows(second.report.sessions), sortRows([ROW_B]));
  });

  test('AC-1 a range of one day, an open start, an open end and no range at all', () => {
    const weeks = (args) => {
      const { r, report } = generate(args);
      assert.equal(r.status, 0, r.stderr);
      return report.sessions.map((row) => `${row.week}:${row.requests}`).sort();
    };
    assert.deepEqual(weeks(['--since', '2026-10-06', '--until', '2026-10-06']), ['2026-W41:6']);
    // B, F and C (C starts on 2026-10-12, week 42).
    assert.deepEqual(weeks(['--since', '2026-10-08']), ['2026-W41:1', '2026-W41:1', '2026-W42:1']);
    // D (it starts on 2026-10-04, week 40, and owns msg_D1) and A.
    assert.deepEqual(weeks(['--until', '2026-10-06']), ['2026-W40:1', '2026-W41:6']);
    assert.deepEqual(weeks([]), ['2026-W40:1', '2026-W41:1', '2026-W41:1', '2026-W41:6', '2026-W42:1']);
  });

  test('AC-1 weeks are ISO 8601 weeks in UTC across a year boundary', () => {
    const fixture = (root) => {
      const dir = join(root, 'projects', '-work-year');
      mkdirSync(dir, { recursive: true });
      const session = (name, start) => writeFileSync(join(dir, `${name}.jsonl`), [
        { type: 'user', timestamp: start, cwd: join(root, 'w'), version: '2.1.299', entrypoint: 'cli', permissionMode: 'default',
          message: { role: 'user', content: 'CANARYPROMPT' } },
        { type: 'assistant', timestamp: start, message: { id: `msg_${name}`, model: 'claude-opus-5-5', role: 'assistant', content: [],
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
      ].map((record) => JSON.stringify(record)).join('\n') + '\n');
      session('s1', '2026-12-28T00:00:00.000Z');
      session('s2', '2027-01-01T00:30:00.000Z');
      session('s3', '2027-01-03T23:59:59.000Z');
      session('s4', '2027-01-04T00:00:00.000Z');
    };
    const { r, report } = generate(['--since', '2026-12-28', '--until', '2027-01-04'], { fixture });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(report.sessions.map((row) => row.week).sort(), ['2026-W53', '2026-W53', '2026-W53', '2027-W01']);
  });

  test('AC-1 without --out names each file by the generated week and eight random hex digits', () => {
    const dir = tempDir();
    const config = join(dir, 'config');
    writeTranscripts(config);
    const cwd = join(dir, 'out');
    mkdirSync(cwd);
    for (let run = 0; run < 2; run++) {
      const r = runNode(reportScript, RANGE, { cwd, env: { CLAUDE_CONFIG_DIR: config } });
      assert.equal(r.status, 0, r.stderr);
    }
    const files = readdirSync(cwd).sort();
    assert.equal(files.length, 2, `two runs should write two files: ${files.join(', ')}`);
    for (const file of files) {
      assert.match(file, /^\d{4}-W\d{2}-[0-9a-f]{8}\.json$/);
      assert.equal(file.slice(0, 8), JSON.parse(readFileSync(join(cwd, file), 'utf8')).generated_week);
    }
  });

  test('AC-2 no sensitive value reaches the report or the summary', () => {
    const { r, out } = generate();
    assert.equal(r.status, 0, r.stderr);
    for (const [where, text] of [['report', readFileSync(out, 'utf8')], ['stdout', r.stdout], ['stderr', r.stderr]]) {
      assert.deepEqual(leaks(text), [], `${where} leaks`);
    }
  });

  test('AC-3 values outside their enumeration or pattern are reported as other, once', () => {
    const { r, report } = generate();
    assert.equal(r.status, 0, r.stderr);
    const a = report.sessions.find((row) => row.requests === 6);
    const b = report.sessions.find((row) => row.cli_version !== '2.1.295' && row.requests === 1);
    assert.deepEqual(a.models, ['claude-opus-5-5', 'claude-sonnet-5-5', 'other'], 'three models outside the pattern, one other');
    assert.deepEqual(a.efforts, ['high', 'max', 'other', 'xhigh'], 'two unknown efforts, one other');
    assert.deepEqual(a.permission_mode, ['auto', 'bypassPermissions', 'other', 'plan'], 'two unknown modes, one other');
    assert.equal(a.tool_calls.other, 1, 'unknown built-in tool');
    assert.equal(a.tool_calls['mcp:other'], 1, 'MCP server this repository does not ship');
    assert.equal(a.skills.other, 1, 'skill this repository does not ship');
    assert.equal(a.subagents.types.other, 3, 'agent type unknown, meta file missing, meta file unreadable');
    assert.equal(b.cli_version, 'other', 'version outside x.y.z');
    assert.equal(b.entrypoint, 'other', 'unknown entrypoint');
  });

  test('AC-4 skipped input is counted in the summary, never shown, and does not stop the run', () => {
    const { r } = generate();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Invalid lines skipped: 5$/m);
    assert.match(r.stdout, /^Unknown record types skipped: 3$/m);
    assert.match(r.stdout, /^Unknown keys skipped: 2$/m);
    assert.deepEqual(leaks(r.stdout), []);
  });

  test('AC-4 a run without skipped input reports zero', () => {
    const fixture = (root) => {
      const dir = join(root, 'projects', '-work-clean');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'clean.jsonl'), [
        { type: 'user', timestamp: '2026-10-06T10:00:00.000Z', cwd: join(root, 'w'), version: '2.1.299', entrypoint: 'cli',
          permissionMode: 'default', message: { role: 'user', content: 'hello' } },
        { type: 'assistant', timestamp: '2026-10-06T10:00:01.000Z', message: { id: 'msg_1', model: 'claude-opus-5-5', role: 'assistant',
          content: [], usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
      ].map((record) => JSON.stringify(record)).join('\n') + '\n');
    };
    const { r } = generate(RANGE, { fixture });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Invalid lines skipped: 0$/m);
    assert.match(r.stdout, /^Unknown record types skipped: 0$/m);
    assert.match(r.stdout, /^Unknown keys skipped: 0$/m);
  });

  test('AC-5 prints a plain-text summary, one labelled fact per line, and a reminder to read the file', () => {
    const { r, out } = generate();
    assert.equal(r.status, 0, r.stderr);
    for (const line of [
      'Sessions: 3', 'Weeks: 2026-W41', 'Models: claude-haiku-4-5-20251001, claude-opus-5-5, claude-sonnet-5-5, other', 'Requests: 8',
      'Input tokens: 25', 'Output tokens: 446', 'Cache creation tokens: 543', 'Cache read tokens: 3214', `Report: ${out}`,
    ]) {
      assert.ok(r.stdout.split(/\r?\n/).includes(line), `missing line: ${line}`);
    }
    assert.match(r.stdout, /^.*(read|review)[^\n]*before[^\n]*(submit|send|donat|pull request).*$/im);
    assert.doesNotMatch(r.stdout, /[─-╿]/, 'box drawing');
    assert.doesNotMatch(r.stdout, /\x1b/, 'ANSI escape codes');
    assert.doesNotMatch(r.stdout, /^\s*[|+]/m, 'table rows');
  });

  test('AC-6 --project keeps the sessions at or below the path and shows the path nowhere', () => {
    const dir = tempDir();
    const config = join(dir, 'config');
    writeTranscripts(config);
    const out = join(dir, 'report.json');
    // Relative to the working directory, with a trailing separator.
    const r = runNode(reportScript, [...RANGE, '--project', `CANARYPROJ${sep}`, '--out', out], {
      cwd: join(config, 'work'),
      env: { CLAUDE_CONFIG_DIR: config },
    });
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    // F's directory, CANARYPROJ-other, shares the prefix of the path but is not below it.
    assert.deepEqual(sortRows(report.sessions), sortRows([ROW_A, ROW_B]));
    assert.equal(report.totals.sessions, 2);
    for (const [where, text] of [['report', readFileSync(out, 'utf8')], ['stdout', r.stdout], ['stderr', r.stderr]]) {
      assert.deepEqual(leaks(text), [], `${where} leaks`);
    }
  });

  describe('AC-7 exits non-zero, says why and writes nothing', () => {
    const fails = (args, env, pattern) => {
      const dir = tempDir();
      const config = join(dir, 'config');
      writeTranscripts(config);
      const cwd = join(dir, 'cwd');
      mkdirSync(cwd);
      for (const out of [[], ['--out', join(dir, 'report.json')]]) {
        const r = runNode(reportScript, [...args, ...out], { cwd, env: { CLAUDE_CONFIG_DIR: config, ...env(dir) } });
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, pattern);
        assert.doesNotMatch(r.stderr, /\n\s+at /, 'stack trace instead of a message');
        assert.deepEqual(readdirSync(cwd), []);
        assert.ok(!existsSync(join(dir, 'report.json')), 'the --out file was written');
      }
    };

    test('AC-7 when the transcript directory does not exist', () => {
      fails(RANGE, (dir) => ({ CLAUDE_CONFIG_DIR: join(dir, 'missing') }), /not found|does not exist|no such/i);
    });

    test('AC-7 when the range is reversed', () => {
      fails(['--since', '2026-10-11', '--until', '2026-10-05'], () => ({}), /range|since|until/i);
    });

    test('AC-7 when a date is not a calendar date', () => {
      fails(['--since', '2026-13-01', '--until', '2026-10-05'], () => ({}), /date|since/i);
      fails(['--since', '2026-02-30'], () => ({}), /date|since/i);
      fails(['--until', '2026-2-3'], () => ({}), /date|until/i);
    });

    test('AC-7 when no session matches', () => {
      fails(['--since', '2030-01-01', '--until', '2030-01-31'], () => ({}), /no session/i);
    });

    test('AC-7 when the output file already exists', () => {
      const dir = tempDir();
      const config = join(dir, 'config');
      writeTranscripts(config);
      const out = join(dir, 'report.json');
      writeFileSync(out, 'keep');
      const r = runNode(reportScript, [...RANGE, '--out', out], { cwd: dir, env: { CLAUDE_CONFIG_DIR: config } });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /exist/i);
      assert.equal(readFileSync(out, 'utf8'), 'keep');
    });
  });

  test('AC-7 a leap day is a calendar date', () => {
    const { r } = generate(['--since', '2024-02-29', '--until', '2026-10-11']);
    assert.equal(r.status, 0, r.stderr);
  });

  test('AC-8 reads .claude/projects under the home directory when CLAUDE_CONFIG_DIR is unset', () => {
    const home = tempDir();
    writeTranscripts(join(home, '.claude'));
    // The working directory has transcripts of its own, with one more session, which must not be read.
    const cwd = tempDir();
    writeTranscripts(join(cwd, '.claude'));
    writeFileSync(join(cwd, '.claude', 'projects', '-work-CANARYPROJDIR', 'extra.jsonl'), JSON.stringify({
      type: 'assistant', timestamp: '2026-10-07T10:00:00.000Z',
      message: { id: 'msg_X1', model: 'claude-opus-5-5', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } },
    }) + '\n');
    const out = join(cwd, 'report.json');
    const r = runNode(reportScript, [...RANGE, '--out', out], {
      cwd,
      env: { CLAUDE_CONFIG_DIR: undefined, HOME: home, USERPROFILE: home },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).totals.sessions, 3);
  });

  test('AC-9 the script hash is the SHA-256 of the script with LF endings, whatever the checkout', () => {
    assert.ok(existsSync(reportScript), `${reportScript} does not exist`);
    const lf = readFileSync(reportScript, 'utf8').replace(/\r\n/g, '\n');
    const hashes = ['\n', '\r\n'].map((eol) => {
      const copy = copyScripts();
      const script = join(copy, 'scripts', 'metrics-report.mjs');
      writeFileSync(script, lf.replace(/\n/g, eol));
      const config = join(copy, 'config');
      writeTranscripts(config);
      const out = join(copy, 'report.json');
      const r = runNode(script, [...RANGE, '--out', out], { cwd: copy, env: { CLAUDE_CONFIG_DIR: config } });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(readFileSync(out, 'utf8')).script_sha256;
    });
    assert.equal(hashes[0], hashes[1]);
    assert.equal(hashes[0], createHash('sha256').update(lf).digest('hex'));
  });
});
