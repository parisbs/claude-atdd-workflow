// Issue #34: scripts/metrics-delegations.mjs reports, from local Claude Code transcripts, how delegations are
// packaged, how large their results are and what Codex used. Every transcript here is synthetic. The contract
// the tests fix, which is the API the implementation must offer:
//
// scripts/metrics-delegations.mjs [--dir <projects>] [--since YYYY-MM-DD] [--rates <file>] [--json] [--verbose]
//   - Reads every `*.jsonl` file under --dir, recursively (subagent transcripts included). Without --dir it
//     reads `$CLAUDE_CONFIG_DIR/projects`, or `.claude/projects` under the home directory. A transcript is one
//     file; its project is the first directory under the root, its session the file name without `.jsonl`.
//   - A delegation is a `tool_use` block in an assistant record named `Agent` (delegate: `input.subagent_type`,
//     or `general-purpose` without one) or `mcp__<server>__codex_delegate` / `mcp__<server>__codex_follow_up`
//     (delegate: `<server>`). It had task-package loaded when an earlier `Skill` tool_use in the same transcript
//     has `input.skill` `task-package` (or ending in `:task-package`), and ran the script when an earlier `Bash`
//     tool_use in the same transcript has a command containing `task-package.mjs`; both look at the whole
//     earlier transcript, whatever --since says.
//   - The package is `input.prompt` for Agent; for Codex the strings `prompt`, `context`, `system_instructions`
//     and each item of `acceptance_criteria`. Its size is the sum of their lengths in characters. The fields
//     are the `- Name:` items of the list after "Write each field" in global/skills/task-package/SKILL.md. A
//     field is present when a line of the package starts, after whitespace, list markers (`-`, `*`, `>`, `#`,
//     `1.`, `1)`) and emphasis (`*`, `_`), with the field name, or with its first word as a whole word when no
//     other field shares that word, case-insensitive.
//   - A Codex parameter is missing when absent, null, an empty string or an empty array. missing_parameters
//     counts only `codex_delegate` calls.
//   - A Codex result is the `tool_result` block in `message.content` (never the `toolUseResult` copy) answering
//     a `codex_delegate`, `codex_follow_up` or `codex_job_result` tool_use, whose text has a line
//     `model=M | effort=E | ... | tokens=in I (cached C, uncached U) / out O ...`. Its structured block runs
//     from the `-----BEGIN STRUCTURED RESULT-----` line to the `-----END STRUCTURED RESULT-----` line, its
//     command log from the line starting `Commands run (` to the statistics line. A share is the characters of
//     that section over the characters of all results of the group.
//   - A hand-back is a `queue-operation` record whose string `content` holds `<agent-message from="ID">` and
//     `[Subagent hand-back]`; its size is the text between the newline ending the frame line and the newline
//     before `</agent-message>`. Each agent id counts once.
//   - Empty lines are ignored; any other line that is not JSON is skipped and counted.
//   - --since keeps records whose `timestamp` is on or after that UTC day; it must be a real calendar date in
//     YYYY-MM-DD form, and an invalid one is reported naming --since.
//   - Statistics use the nearest rank: the p-th percentile of n sorted values is the ceil(p*n)-th; the median
//     is p = 0.5. Over no values each statistic is null. Credits per result are (U * input + C * cached + O *
//     output) / 1,000,000 with the rates of its model.
//   - --rates is JSON `{ "<model>": { "input": n, "cached": n, "output": n } }`, credits per million tokens, each
//     a non-negative number; an unreadable or malformed table is an error.
//   - Without --json stdout is plain text, `Label: value` lines, no tables, box drawing or ANSI codes. Errors go
//     to stderr with a non-zero exit and nothing on stdout.
//
// The --json document, every key required and no other:
//   { transcripts, invalid_lines, delegates: { <name>: delegate }, codex: [ group, ... ],
//     handbacks: { count, chars: { median, p90, max } },
//     unpriced: [model, ...] (only with --rates, sorted), delegations: [ row, ... ] (only with --verbose) }
//   delegate: { delegations, task_package_loaded, task_package_script, missing_fields: { <field>: n },
//               package_chars: { median, p90, max, total },
//               missing_parameters: { working_dir, context, target_files, acceptance_criteria,
//                                     system_instructions, output_schema, model, reasoning_effort } (Codex only) }
//   group: { model, effort, results, input_tokens: { median, p90 }, cached_tokens: { median, p90 },
//            output_tokens: { median, p90 }, command_log_share, structured_share,
//            credits: { median, p90 } | null (only with --rates; null for an unpriced model) }
//   row: { date: 'YYYY-MM-DD', project, session, delegate, package_chars, result_chars }, result_chars being the
//     characters of the text of the tool_result answering the delegation, or null without one.
//   missing_fields keys follow the order of the skill.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'metrics-delegations.mjs');
const scratch = [];
after(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const FIELDS = ['Goal', 'Acceptance criteria', 'Scope in', 'Scope out', 'Constraints', 'Invariants and conventions',
  'Verify command', 'Base commit', 'Oracle', 'Prior findings', 'Report shape'];
const PARAMETERS = ['working_dir', 'context', 'target_files', 'acceptance_criteria', 'system_instructions',
  'output_schema', 'model', 'reasoning_effort'];
const fieldCounts = (missing = []) => Object.fromEntries(FIELDS.map((f) => [f, missing.includes(f) ? 1 : 0]));
const allFields = (n) => Object.fromEntries(FIELDS.map((f) => [f, n]));

// Packages. FULL names every field; PARTIAL names four of them in the forms the matching rule accepts, and
// carries lines that look like fields but are not (Based, Scope:, Reporting).
const FULL = FIELDS.map((f) => `- ${f}: canaryprompt ${f.toLowerCase()}`).join('\n');
const FULL3 = `${FULL}\n- Extra: canaryprompt third package`;
const PARTIAL = ['## Goal', 'canaryprompt rewrite the parser', '- Scope in: scripts/', '**Invariants:** none',
  '3. Verify: npm test', 'Based on earlier work, canaryprompt', 'Scope: the whole repo', 'Reporting later'].join('\n');
const OLD = 'canaryprompt old package';
const BARE = 'canaryprompt just do it';
const CODEX_FULL = { prompt: 'canaryprompt implement it', context: FULL, working_dir: '/Users/canaryuser/git/canaryproj',
  target_files: ['scripts/x.mjs'], acceptance_criteria: ['AC-1 canaryprompt works'], system_instructions: 'canaryprompt rules',
  output_schema: { type: 'object' }, model: 'gpt-6.1-sol', reasoning_effort: 'high' };
const CODEX_OLD = { prompt: 'canaryprompt old codex', model: 'gpt-6.1-sol', reasoning_effort: 'high' };
const CODEX_BARE = { prompt: 'canaryprompt review it', working_dir: '', model: 'gpt-6-astra' };
const FOLLOW = { prompt: 'canaryprompt follow up', thread_id: 'canarythread0' };
const codexChars = (i) => [i.prompt, i.context, i.system_instructions, ...(i.acceptance_criteria ?? [])]
  .filter((s) => typeof s === 'string').reduce((n, s) => n + s.length, 0);

// Codex results, built from sections so the shares can be computed from their lengths.
const pad = (label, n) => `${label} ${'canarypath '.repeat(n)}`.trimEnd();
const stats = (model, effort, i, c, o) =>
  `model=${model} | effort=${effort} | sandbox=workspace-write | working_dir=/Users/canaryuser/git/canaryproj | duration=2m 3s | tokens=in ${i} (cached ${c}, uncached ${i - c}) / out ${o} (reasoning 10) | thread_id=canarythread1`;
const HEAD = `Codex's report follows.\n${pad('Codex ran in', 20)}\n\nStructured result (JSON, exactly as Codex returned it):`;
const BLOCK = `-----BEGIN STRUCTURED RESULT-----\n{\n  "status": "done",\n  "notes": "${'canaryreport '.repeat(60)}"\n}\n-----END STRUCTURED RESULT-----`;
const FILES = `Files changed (1):\n- [add] ${pad('/Users/canaryuser/git/canaryproj/x', 10)}`;
const COMMANDS = `Commands run (3 total):\n${[1, 2, 3].map((n) => `- [exit 0] ${pad(`/bin/zsh -lc "step ${n}"`, 15)}`).join('\n')}`;
const R1 = { parts: [HEAD, BLOCK, FILES, COMMANDS, stats('gpt-6.1-sol', 'high', 329178, 267136, 5499)] };
const R0 = { parts: [stats('gpt-6.1-sol', 'high', 100, 50, 10)] };
const RJ = { parts: [HEAD, COMMANDS, stats('gpt-6-astra', 'high', 600000, 500000, 6000)] };
const RF = { parts: [HEAD, BLOCK, stats('gpt-6-astra', 'high', 200000, 150000, 2000)] };
for (const r of [R1, R0, RJ, RF]) r.text = r.parts.join('\n');
const share = (results, section) => results.reduce((n, r) => n + (r.parts.includes(section) ? section.length : 0), 0)
  / results.reduce((n, r) => n + r.text.length, 0);

const REPORT_A = `  1. Status: done.\n  ${'canaryreport alpha '.repeat(30)}`;
const REPORT_B = `  1. Status: partial.\n  ${'canaryreport beta '.repeat(80)}`;
const REPORT_OLD = '  1. Status: done. canaryreport old';

// Records.
let seq = 0;
const ts = (day, time = '10:00:00') => `2026-10-${day}T${time}.000Z`;
const base = (type, timestamp) => ({ type, timestamp, sessionId: 'canarysession-id', cwd: '/Users/canaryuser/git/canaryproj', uuid: `u${seq++}` });
function use(timestamp, name, input, id = `toolu_${seq}`) {
  return { ...base('assistant', timestamp), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } };
}
function result(timestamp, id, text) {
  return { ...base('user', timestamp), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] },
    toolUseResult: [{ type: 'text', text }] };
}
function handback(timestamp, agent, report) {
  return { type: 'queue-operation', operation: 'enqueue', timestamp, sessionId: 'canarysession-id',
    content: `<agent-message from="${agent}">\n[Subagent hand-back] The text below is the final report of a subagent. The report follows:\n${report}\n</agent-message>` };
}
const jsonl = (records) => `${records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`;

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'delegations-'));
  scratch.push(dir);
  return dir;
}
function put(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

// Three sessions in two projects plus one subagent transcript.
function writeFixture(projects) {
  const p1 = join(projects, '-Users-canaryuser-git-canaryproj');
  const p2 = join(projects, '-Users-canaryuser-git-canaryother');
  put(join(p1, 'canarysession1.jsonl'), jsonl([
    use(ts(10, '10:00:00'), 'Skill', { skill: 'task-package' }),
    use(ts(10, '10:01:00'), 'Bash', { command: 'node ~/.claude/hooks/task-package.mjs --repo .' }),
    use(ts(10, '10:02:00'), 'Agent', { subagent_type: 'claude-researcher', description: 'canaryprompt', prompt: FULL }),
    use(ts(10, '10:03:00'), 'Agent', { subagent_type: 'claude-implementer', description: 'canaryprompt', prompt: PARTIAL }),
    use(ts(10, '10:04:00'), 'mcp__codex-implementer__codex_delegate', CODEX_FULL, 'toolu_c1'),
    result(ts(10, '10:10:00'), 'toolu_c1', R1.text),
    // A statistics line in a file that was read is not a Codex result.
    use(ts(10, '10:11:00'), 'Read', { file_path: '/Users/canaryuser/notes.md' }, 'toolu_read'),
    result(ts(10, '10:11:01'), 'toolu_read', stats('gpt-5.6-terra', 'low', 9, 9, 9)),
  ]));
  put(join(p1, 'canarysession1', 'subagents', 'agent-a1b2.jsonl'), jsonl([
    use(ts(11), 'Agent', { subagent_type: 'Explore', prompt: BARE }),
  ]));
  put(join(p2, 'canarysession2.jsonl'), jsonl([
    use(ts('01', '09:00:00'), 'Agent', { subagent_type: 'claude-researcher', prompt: OLD }),
    use(ts('01', '09:01:00'), 'mcp__codex-implementer__codex_delegate', CODEX_OLD, 'toolu_c0'),
    result(ts('01', '09:05:00'), 'toolu_c0', R0.text),
    handback(ts('01', '09:06:00'), 'canaryagent0', REPORT_OLD),
    use(ts(12, '10:00:00'), 'Agent', { prompt: BARE }),
    use(ts(12, '10:01:00'), 'mcp__codex-reviewer__codex_delegate', CODEX_BARE, 'toolu_c2'),
    result(ts(12, '10:01:01'), 'toolu_c2', 'Job started: canaryjob. Poll codex_job_status.'),
    use(ts(12, '10:02:00'), 'mcp__codex-reviewer__codex_job_status', { job_id: 'canaryjob' }, 'toolu_s1'),
    result(ts(12, '10:02:01'), 'toolu_s1', 'running'),
    use(ts(12, '10:09:00'), 'mcp__codex-reviewer__codex_job_result', { job_id: 'canaryjob' }, 'toolu_j1'),
    result(ts(12, '10:09:01'), 'toolu_j1', RJ.text),
    '{"type": "user", "broken',
    handback(ts(12, '11:00:00'), 'canaryagent1', REPORT_A),
    handback(ts(12, '11:00:01'), 'canaryagent1', REPORT_A),
    handback(ts(12, '11:30:00'), 'canaryagent2', REPORT_B),
    use(ts(13), 'mcp__codex-reviewer__codex_follow_up', FOLLOW, 'toolu_f1'),
    result(ts(13, '10:05:00'), 'toolu_f1', RF.text),
  ]));
  put(join(p2, 'canarysession3.jsonl'), jsonl([
    use(ts('01'), 'Skill', { skill: 'task-package' }),
    use(ts('06'), 'Agent', { subagent_type: 'claude-researcher', prompt: FULL3 }),
  ]));
}

function run(args, { fixture = writeFixture, env = () => ({}) } = {}) {
  assert.ok(existsSync(script), `${script} does not exist`);
  const dir = tempDir();
  const projects = join(dir, 'projects');
  mkdirSync(projects);
  fixture(projects, dir);
  const r = spawnSync(process.execPath, [script, ...args.map((a) => a.replace('<dir>', projects).replace('<root>', dir))], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, HOME: dir, TZ: 'Pacific/Kiritimati', CLAUDE_CONFIG_DIR: join(dir, 'none'), ...env(dir) },
  });
  return { ...r, dir, projects };
}
const runJson = (args, options) => {
  const r = run(['--dir', '<dir>', '--json', ...args], options);
  assert.equal(r.status, 0, r.stderr);
  return { ...r, doc: JSON.parse(r.stdout) };
};
const group = (doc, model, effort) => doc.codex.find((g) => g.model === model && g.effort === effort);
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.005, `${message}: ${actual} is not ${expected}`);
const leaks = (text) => [...new Set(text.match(/canary\w*/gi) ?? [])];
const sizes = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const rank = (p) => s[Math.ceil(p * s.length) - 1];
  return { median: rank(0.5), p90: rank(0.9), max: s.at(-1) };
};

describe('metrics-delegations (#34)', () => {
  test('AC-1 reports per delegate the delegations, the task-package loads and the missing package fields', () => {
    const { doc } = runJson([]);
    assert.deepEqual(Object.keys(doc.delegates).sort(),
      ['Explore', 'claude-implementer', 'claude-researcher', 'codex-implementer', 'codex-reviewer', 'general-purpose']);
    const pick = (name) => {
      const { delegations, task_package_loaded, task_package_script, missing_fields } = doc.delegates[name];
      return { delegations, task_package_loaded, task_package_script, missing_fields };
    };
    // A Skill load anywhere earlier in the same transcript counts; a load in the parent session does not
    // count for a subagent transcript.
    assert.deepEqual(pick('claude-researcher'), { delegations: 3, task_package_loaded: 2, task_package_script: 1, missing_fields: allFields(1) });
    assert.deepEqual(pick('claude-implementer'), { delegations: 1, task_package_loaded: 1, task_package_script: 1,
      missing_fields: fieldCounts(['Acceptance criteria', 'Scope out', 'Constraints', 'Base commit', 'Oracle', 'Prior findings', 'Report shape']) });
    assert.deepEqual(pick('general-purpose'), { delegations: 1, task_package_loaded: 0, task_package_script: 0, missing_fields: allFields(1) });
    assert.deepEqual(pick('Explore'), { delegations: 1, task_package_loaded: 0, task_package_script: 0, missing_fields: allFields(1) });
    assert.deepEqual(pick('codex-implementer'), { delegations: 2, task_package_loaded: 1, task_package_script: 1, missing_fields: allFields(1) });
    assert.deepEqual(pick('codex-reviewer'), { delegations: 2, task_package_loaded: 0, task_package_script: 0, missing_fields: allFields(2) });
  });

  test('AC-1 counts the Codex parameters each codex_delegate omits, and only for Codex delegates', () => {
    const { doc } = runJson([]);
    const absent = (names) => Object.fromEntries(PARAMETERS.map((p) => [p, names.includes(p) ? 1 : 0]));
    assert.deepEqual(doc.delegates['codex-implementer'].missing_parameters,
      absent(['working_dir', 'context', 'target_files', 'acceptance_criteria', 'system_instructions', 'output_schema']));
    // An empty working_dir is missing; the follow-up is a delegation but not a codex_delegate.
    assert.deepEqual(doc.delegates['codex-reviewer'].missing_parameters,
      absent(PARAMETERS.filter((p) => p !== 'model')));
    for (const name of ['claude-researcher', 'claude-implementer', 'general-purpose', 'Explore']) {
      assert.ok(!('missing_parameters' in doc.delegates[name]), `${name} has missing_parameters`);
    }
  });

  test('AC-1 reads $CLAUDE_CONFIG_DIR/projects when no directory is given', () => {
    const r = run(['--json'], { env: (dir) => ({ CLAUDE_CONFIG_DIR: dir }) });
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.transcripts, 4);
    assert.equal(doc.delegates['claude-researcher'].delegations, 3);
  });

  test('AC-2 reports Codex tokens per model and effort, and the shares of the command log and the structured block', () => {
    const { doc } = runJson([]);
    assert.deepEqual(doc.codex.map((g) => `${g.model}|${g.effort}`).sort(), ['gpt-6-astra|high', 'gpt-6.1-sol|high']);
    const sol = group(doc, 'gpt-6.1-sol', 'high');
    assert.deepEqual({ results: sol.results, input_tokens: sol.input_tokens, cached_tokens: sol.cached_tokens, output_tokens: sol.output_tokens }, {
      results: 2, input_tokens: { median: 100, p90: 329178 }, cached_tokens: { median: 50, p90: 267136 }, output_tokens: { median: 10, p90: 5499 },
    });
    near(sol.structured_share, share([R1, R0], BLOCK), 'sol structured share');
    near(sol.command_log_share, share([R1, R0], COMMANDS), 'sol command log share');
    // The asynchronous job result and the follow-up are results; the job start and status are not.
    const astra = group(doc, 'gpt-6-astra', 'high');
    assert.deepEqual({ results: astra.results, input_tokens: astra.input_tokens, cached_tokens: astra.cached_tokens, output_tokens: astra.output_tokens }, {
      results: 2, input_tokens: { median: 200000, p90: 600000 }, cached_tokens: { median: 150000, p90: 500000 }, output_tokens: { median: 2000, p90: 6000 },
    });
    near(astra.structured_share, share([RJ, RF], BLOCK), 'astra structured share');
    near(astra.command_log_share, share([RJ, RF], COMMANDS), 'astra command log share');
  });

  test('AC-3 reports hand-back sizes once per agent, and package sizes per delegate', () => {
    const { doc } = runJson([]);
    assert.deepEqual(doc.handbacks, { count: 3, chars: sizes([REPORT_OLD.length, REPORT_A.length, REPORT_B.length]) });
    const researcher = [FULL.length, OLD.length, FULL3.length];
    assert.deepEqual(doc.delegates['claude-researcher'].package_chars, { ...sizes(researcher), total: researcher.reduce((a, b) => a + b) });
    const codex = [codexChars(CODEX_FULL), codexChars(CODEX_OLD)];
    assert.deepEqual(doc.delegates['codex-implementer'].package_chars, { ...sizes(codex), total: codex.reduce((a, b) => a + b) });
  });

  test('AC-3 uses the nearest rank for the median and the 90th percentile', () => {
    const fixture = (projects) => put(join(projects, 'p', 's.jsonl'),
      jsonl([10, 3, 8, 1, 6, 9, 2, 7, 5, 4].map((n, i) => handback(ts(10, `10:00:0${i}`), `agent${n}`, 'x'.repeat(n * 10)))));
    const { doc } = runJson([], { fixture });
    assert.deepEqual(doc.handbacks, { count: 10, chars: { median: 50, p90: 90, max: 100 } });
  });

  test('AC-4 --since counts only records on or after that UTC day', () => {
    const { doc } = runJson(['--since', '2026-10-05']);
    const r = doc.delegates['claude-researcher'];
    // The session-3 load before the date still counts for its later delegation.
    assert.deepEqual([r.delegations, r.task_package_loaded, r.task_package_script, r.missing_fields], [2, 2, 1, allFields(0)]);
    assert.equal(doc.delegates['codex-implementer'].delegations, 1);
    assert.deepEqual(doc.delegates['codex-implementer'].missing_parameters, Object.fromEntries(PARAMETERS.map((p) => [p, 0])));
    const sol = group(doc, 'gpt-6.1-sol', 'high');
    assert.deepEqual([sol.results, sol.input_tokens], [1, { median: 329178, p90: 329178 }]);
    assert.equal(doc.handbacks.count, 2);
  });

  test('AC-4 --since counts a record of that day and drops the day before', () => {
    const fixture = (projects) => put(join(projects, 'p', 's.jsonl'), jsonl([
      use('2026-10-04T23:59:59.999Z', 'Agent', { subagent_type: 'a', prompt: 'x' }),
      use('2026-10-05T00:00:00.000Z', 'Agent', { subagent_type: 'b', prompt: 'x' }),
    ]));
    const { doc } = runJson(['--since', '2026-10-05'], { fixture });
    assert.deepEqual(Object.keys(doc.delegates), ['b']);
  });

  test('AC-4 an invalid --since date exits non-zero with a message and no report', () => {
    for (const date of ['2026-02-30', 'yesterday', '2026-10-5']) {
      const r = run(['--dir', '<dir>', '--since', date]);
      assert.notEqual(r.status, 0, `${date} was accepted`);
      assert.equal(r.stdout, '', `${date} printed a report`);
      assert.match(r.stderr, /since/i);
    }
  });

  test('AC-5 the text and JSON output carry no prompt or report text, project names, paths or ids', () => {
    const text = run(['--dir', '<dir>']);
    assert.equal(text.status, 0, text.stderr);
    assert.ok(text.stdout.trim().length > 0, 'the text report is empty');
    const { stdout: json, dir } = runJson([]);
    for (const [label, out] of [['text', text.stdout], ['json', json]]) {
      assert.deepEqual(leaks(out), [], `${label} output leaks`);
      assert.ok(!out.includes(text.dir) && !out.includes(dir), `${label} output holds the transcript path`);
      assert.ok(!out.includes('/Users/'), `${label} output holds a path`);
    }
  });

  test('AC-5 --verbose adds one row per delegation with date, project, session, delegate and sizes, and still no text', () => {
    const { doc, stdout } = runJson(['--verbose']);
    assert.equal(doc.delegations.length, 10);
    for (const row of doc.delegations) {
      assert.deepEqual(Object.keys(row).sort(), ['date', 'delegate', 'package_chars', 'project', 'result_chars', 'session']);
      assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/);
    }
    const implementer = doc.delegations.find((row) => row.delegate === 'claude-implementer');
    assert.deepEqual(implementer, { date: '2026-10-10', project: '-Users-canaryuser-git-canaryproj', session: 'canarysession1',
      delegate: 'claude-implementer', package_chars: PARTIAL.length, result_chars: null });
    const c1 = doc.delegations.find((row) => row.delegate === 'codex-implementer' && row.date === '2026-10-10');
    assert.equal(c1.result_chars, R1.text.length);
    assert.deepEqual(leaks(stdout).filter((w) => !/^canary(proj|other|user|session\d)$/i.test(w)), []);
    const text = run(['--dir', '<dir>', '--verbose']);
    assert.equal(text.status, 0, text.stderr);
    assert.ok(text.stdout.includes('canarysession1') && text.stdout.includes('-Users-canaryuser-git-canaryother'), 'verbose text lacks the rows');
    assert.ok(!/canary(prompt|report|path|thread|agent|job)/i.test(text.stdout), 'verbose text leaks content or ids');
  });

  test('AC-6 --rates computes credits per model and effort and lists the unpriced models', () => {
    const fixture = (projects, dir) => {
      writeFixture(projects);
      put(join(dir, 'rates.json'), JSON.stringify({ 'gpt-6.1-sol': { input: 100, cached: 10, output: 500 } }));
    };
    const { doc } = runJson(['--rates', '<root>/rates.json'], { fixture });
    assert.deepEqual(doc.unpriced, ['gpt-6-astra']);
    const credits = group(doc, 'gpt-6.1-sol', 'high').credits;
    near(credits.median, (50 * 100 + 50 * 10 + 10 * 500) / 1e6, 'median credits');
    near(credits.p90, ((329178 - 267136) * 100 + 267136 * 10 + 5499 * 500) / 1e6, 'p90 credits');
    assert.equal(group(doc, 'gpt-6-astra', 'high').credits, null);
    const text = run(['--dir', '<dir>', '--rates', '<root>/rates.json'], { fixture });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /credit/i);
  });

  test('AC-6 without a rate table no credit figure appears', () => {
    const { doc, stdout } = runJson([]);
    assert.ok(!('unpriced' in doc), 'unpriced appears without rates');
    for (const g of doc.codex) assert.ok(!('credits' in g), `${g.model} has credits without rates`);
    assert.doesNotMatch(stdout, /credit/i);
    const text = run(['--dir', '<dir>']);
    assert.doesNotMatch(text.stdout, /credit/i);
  });

  test('AC-6 an unreadable or malformed rate table exits non-zero with no report', () => {
    const fixture = (projects, dir) => {
      writeFixture(projects);
      put(join(dir, 'bad.json'), '{ "gpt-6.1-sol": ');
      put(join(dir, 'wrong.json'), JSON.stringify({ 'gpt-6.1-sol': { input: 'cheap' } }));
    };
    for (const file of ['bad.json', 'wrong.json', 'absent.json']) {
      const r = run(['--dir', '<dir>', '--rates', `<root>/${file}`], { fixture });
      assert.notEqual(r.status, 0, `${file} was accepted`);
      assert.equal(r.stdout, '', `${file} printed a report`);
    }
  });

  test('AC-7 skips and counts lines that are not JSON', () => {
    const { doc } = runJson([]);
    assert.equal(doc.invalid_lines, 1);
    assert.equal(doc.transcripts, 4);
    const text = run(['--dir', '<dir>']);
    assert.match(text.stdout, /invalid[^\n]*: 1$/im);
  });

  test('AC-7 a missing directory exits non-zero and an empty one reports zero counts', () => {
    const missing = run(['--dir', '<root>/nowhere']);
    assert.notEqual(missing.status, 0);
    assert.equal(missing.stdout, '');
    assert.ok(missing.stderr.length > 0);
    const { doc } = runJson([], { fixture: () => {} });
    assert.deepEqual(doc, { transcripts: 0, invalid_lines: 0, delegates: {}, codex: [],
      handbacks: { count: 0, chars: { median: null, p90: null, max: null } } });
    const text = run(['--dir', '<dir>'], { fixture: () => {} });
    assert.equal(text.status, 0, text.stderr);
  });

  test('AC-8 --json prints one document with exactly the documented keys', () => {
    const { doc } = runJson([]);
    assert.deepEqual(Object.keys(doc).sort(), ['codex', 'delegates', 'handbacks', 'invalid_lines', 'transcripts']);
    for (const [name, d] of Object.entries(doc.delegates)) {
      const keys = ['delegations', 'missing_fields', 'package_chars', 'task_package_loaded', 'task_package_script'];
      if (name.startsWith('codex-')) keys.push('missing_parameters');
      assert.deepEqual(Object.keys(d).sort(), keys.sort(), name);
      assert.deepEqual(Object.keys(d.missing_fields), FIELDS, `${name} fields`);
    }
    for (const g of doc.codex) {
      assert.deepEqual(Object.keys(g).sort(), ['cached_tokens', 'command_log_share', 'effort', 'input_tokens', 'model',
        'output_tokens', 'results', 'structured_share']);
    }
  });

  test('AC-8 the text output is plain Label: value lines without tables or escape codes', () => {
    const text = run(['--dir', '<dir>']);
    assert.equal(text.status, 0, text.stderr);
    assert.doesNotMatch(text.stdout, /\u001b|[─-╿]|\|/);
    for (const line of text.stdout.split('\n').filter(Boolean)) assert.match(line, /^[^:]+: \S/, `line "${line}"`);
  });
});
