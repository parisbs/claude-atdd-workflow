// Shared fixtures for the donated session metrics of issue #19 (ADR 0023).
//
// The contract the tests fix, which is the API the implementation must offer:
//
// scripts/metrics-report.mjs [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--project <path>] [--out <file>]
//   - Reads `$CLAUDE_CONFIG_DIR/projects`, or `.claude/projects` under the home directory. A session is one
//     `<projects>/<project>/<name>.jsonl` file; its subagents are `<projects>/<project>/<name>/subagents/
//     agent-*.jsonl`, each with an optional `agent-*.meta.json` holding `agentType`.
//   - A session belongs to the range by the UTC day of its first timestamped record, both ends inclusive, and
//     is reported whole, so consecutive ranges never share or split a session. Without --since there is no
//     lower bound and without --until no upper bound. A date must be a real calendar date. --project keeps
//     the sessions whose first `cwd` is that path or below it. Both paths are compared after resolving them
//     against the working directory and, when they exist, through symbolic links (macOS `/var` is
//     `/private/var`).
//   - Without --out it writes `<generated_week>-<8 random hex digits>.json` in the working directory. It never
//     overwrites a file, and on any error it writes no file.
//   - stdout is the summary, plain text, one `Label: value` per line, no tables, box drawing or ANSI codes:
//     `Sessions`, `Weeks`, `Models` (sorted, comma-separated), `Requests`, `Input tokens`, `Output tokens`,
//     `Cache creation tokens`, `Cache read tokens`, `Invalid lines skipped`, `Unknown record types skipped`,
//     `Unknown keys skipped`, `Unreadable paths skipped`, `Report` (the output path), and a line asking to read
//     the file before submitting it. It never shows a value the report does not hold, nor the --project path. Errors go to stderr with a
//     non-zero exit and no stack trace.
//
// The report, schema_version 1, every key required and no other:
//   { schema_version: 1, script_version: 'x.y.z', script_sha256: <64 hex>, generated_week: 'YYYY-Www',
//     license: 'CC0-1.0',
//     totals: { sessions, requests, input_tokens, output_tokens, cache_creation_input_tokens,
//               cache_read_input_tokens },
//     sessions: [ row, ... ] }
//   row: { week, cli_version, entrypoint, permission_mode, models, efforts, requests, input_tokens,
//          output_tokens, cache_creation_input_tokens, cache_read_input_tokens, duration_minutes, tool_calls,
//          skills, subagents: { count, requests, input_tokens, output_tokens, cache_creation_input_tokens,
//          cache_read_input_tokens, types } }
//   - Weeks are ISO 8601 weeks in UTC. week: of the session's first timestamped record. generated_week: of the
//     moment the report is written. script_sha256: SHA-256 of the script file with CRLF turned into LF.
//   - cli_version and entrypoint: from the first main record that has them. permission_mode: the values of the
//     main transcript. models and efforts: the values of the requests counted in the row. Each of these
//     arrays is mapped to its enumeration first, then made distinct and sorted.
//   - A request is a distinct `message.id` of a main assistant record whose model is not `<synthetic>`, zero
//     usage included. Each token field of a request is the largest value among its records. A message id is
//     counted once over everything read: in the session whose first record is earliest, even when that
//     session is out of the range or of the project, and within a session in the main transcript before any
//     subagent.
//   - duration_minutes: first to last timestamped main record, rounded to the nearest minute.
//   - tool_calls: distinct `tool_use` ids over the records of the main transcript whose message is a request
//     counted in the row, so a copy of another session's message adds no tool call, by name: a built-in tool by
//     its name, an `mcp__<server>__<tool>` as `mcp:<server>` when the server is a key of
//     `global/mcp-servers.json` and `mcp:other` otherwise, anything else `other`. skills: `Skill` calls by the
//     skill when it is a directory of `global/skills/`, `other` otherwise. subagents.types: by `agentType`
//     when it is an agent of `global/agents/`, `other` otherwise, including a missing or unreadable
//     meta file. Counting objects hold positive integers only.
//   - Enumerations. entrypoint: cli, claude-desktop, claude-vscode, sdk-cli, sdk-ts, sdk-py. permission_mode:
//     default, acceptEdits, plan, auto, bypassPermissions, dontAsk. efforts: low, medium, high, xhigh, max.
//     Built-in tools: one list in the script, shared with the validator, holding at least Bash, Read, Edit,
//     Write, Glob, Grep, Agent, Skill, WebFetch, WebSearch and ToolSearch. Patterns. cli_version:
//     ^\d+\.\d+\.\d+$. models: ^claude-(opus|sonnet|haiku|fable)-\d+(-\d+)?(-\d{8})?$. Every value outside
//     its enumeration or pattern is `other`.
//   - Skipped input, counted over the transcripts of the sessions in the report, subagents included: an
//     invalid line is one that is not JSON, not a JSON object, a record whose `timestamp` is present and is not
//     an ISO 8601 date-time of a real calendar day and time of day (no 31 February, no 24:00) with a `Z` or
//     `+hh:mm` offset between 1970 and 9999, or an assistant record without
//     `message.id` or with one of the four token fields of `message.usage` present and not a non-negative safe
//     integer; such a record contributes nothing. A missing token field counts as zero. A UTF-8 byte order mark
//     at the start of a line is ignored. An unknown
//     record type is a `type` the script does not know. An unknown key is a top-level key of a known record
//     the script does not know, once per occurrence. Nested unknown keys are ignored. The known types and keys
//     include those Claude Code writes today. An unreadable path (a transcript, a directory of subagents) is
//     skipped and counted in `Unreadable paths skipped`, over the whole run; only an unreadable projects
//     folder stops it. Files are read in code-unit order of their names, never a locale's.
//   - totals sum the rows' main fields; totals.sessions is the number of rows.
//
// scripts/metrics-validate.mjs <report> [--ref <git ref>]   (working directory: a git repository)
//   Exit 0 when the report is valid; otherwise non-zero, naming each cause on stderr. Valid means: the schema
//   above with every key and no other, the enumerations and patterns of the script (the `other` value
//   included), real ISO weeks, sorted distinct arrays, non-negative safe integer counts and positive safe
//   integer counting entries, totals equal to the rows, at most 2 MiB (2,097,152 bytes), and a script_sha256 equal to
//   the hash of some version of scripts/metrics-report.mjs in the history of the ref.
//
// scripts/metrics-donation-check.mjs --base <ref> --head <ref> --event <GitHub event JSON>
//   Run from the base checkout. Compares the head with its merge base with the base ref. When nothing under
//   docs/experiments/donated/ changes it passes without validating anything. Otherwise it fails, naming every
//   cause it finds, unless the pull request adds exactly one file, directly in that folder, named
//   `YYYY-Www-<8 hex digits>.json`, which the base's validator accepts, changes nothing else, and its body
//   ticks the CC0 1.0 checkbox of the metrics-donation template outside any HTML comment or fenced code
//   block. Its messages quote that checkbox line when it is missing. The check and the validator print every
//   value that comes from the donation (paths, keys) with control characters escaped, so that nothing a fork
//   controls can start a line or a workflow command.
//
// Every sensitive value below carries the word CANARY, which must never reach a report or a summary.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
export const reportScript = join(repo, 'scripts', 'metrics-report.mjs');
export const validateScript = join(repo, 'scripts', 'metrics-validate.mjs');
export const checkScript = join(repo, 'scripts', 'metrics-donation-check.mjs');

const scratch = [];
export const cleanup = () => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); };
export function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-'));
  scratch.push(dir);
  return dir;
}

// Runs one of the scripts, failing first when it does not exist, so that a missing script never passes a
// test that expects a non-zero exit. An env value of undefined removes the variable.
export function runNode(script, args, { cwd, env = {} } = {}) {
  assert.ok(existsSync(script), `${script} does not exist`);
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    // A timezone far from UTC makes a local-time bug visible in the range and the week.
    env: { ...process.env, TZ: 'Pacific/Kiritimati', ...env },
  });
}

// The ISO 8601 week of a date, in UTC.
export function isoWeek(date) {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  day.setUTCDate(day.getUTCDate() + 3 - ((day.getUTCDay() + 6) % 7));
  const year = day.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((day - jan4) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

const jsonl = (records) => records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
export function put(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const usage = (input, output, creation, read) => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: creation,
  cache_read_input_tokens: read,
});

const assistant = (timestamp, id, model, content, use, extra = {}) => ({
  type: 'assistant',
  timestamp,
  sessionId: 'CANARYSESSIONID',
  uuid: `CANARYUUID-${id}-${timestamp}`,
  parentUuid: 'CANARYPARENT',
  isSidechain: false,
  requestId: 'CANARYREQUEST',
  message: { id, model, role: 'assistant', type: 'message', content, usage: use },
  ...extra,
});

const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });

// Writes the transcripts and returns where they are. Sessions, by first record:
// D 2026-10-04T23:59:59Z (before the range, its request after midnight), A 2026-10-06, E 2026-10-07 (synthetic
// only), F 2026-10-08 in another project, B 2026-10-11T23:59:30Z (last second of the range), C
// 2026-10-12T00:00:00Z (after it). Every anomaly the summary counts is in A or its subagents.
export function writeTranscripts(root) {
  const projects = join(root, 'projects');
  const cwdA = join(root, 'work', 'CANARYPROJ');
  const cwdB = join(cwdA, 'sub');
  const cwdF = join(root, 'work', 'CANARYPROJ-other');
  const dirA = join(projects, '-work-CANARYPROJDIR');
  const dirF = join(projects, '-work-CANARYOTHERDIR');
  const base = { sessionId: 'CANARYSESSIONID', userType: 'external', gitBranch: 'CANARYBRANCH', isSidechain: false };
  for (const dir of [cwdB, cwdF]) mkdirSync(dir, { recursive: true });

  put(join(dirA, 'CANARYSESSIONA.jsonl'), jsonl([
    // The first timestamped record is not a user record and carries no version.
    { type: 'attachment', timestamp: '2026-10-06T10:00:00.000Z', sessionId: 'CANARYSESSIONID', attachment: { type: 'file', content: 'CANARYATTACH' } },
    { ...base, type: 'user', timestamp: '2026-10-06T10:00:01.000Z', uuid: 'CANARYUUID1', parentUuid: null, cwd: cwdA,
      version: '2.1.299', entrypoint: 'claude-desktop', permissionMode: 'auto', zzCANARYKEYNAME: 'CANARYUNKNOWNKEY',
      message: { role: 'user', content: 'CANARYPROMPT' } },
    // msg_A1 streams four records: cache_read is largest in the first, output in the second, which is written
    // twice, and the last one carries a tool call of its own.
    assistant('2026-10-06T10:00:05.000Z', 'msg_A1', 'claude-opus-5-5', [{ type: 'text', text: 'CANARYASSISTANT' }],
      usage(3, 7, 500, 1200), { cwd: cwdA, version: '2.1.299', entrypoint: 'claude-desktop', effort: 'high' }),
    assistant('2026-10-06T10:00:06.000Z', 'msg_A1', 'claude-opus-5-5', [toolUse('toolu_A1', 'Bash', { command: 'cat CANARYTOOLINPUT' })],
      usage(3, 412, 500, 1000), { cwd: cwdA, effort: 'high' }),
    assistant('2026-10-06T10:00:06.000Z', 'msg_A1', 'claude-opus-5-5', [toolUse('toolu_A1', 'Bash', { command: 'cat CANARYTOOLINPUT' })],
      usage(3, 412, 500, 1000), { cwd: cwdA, effort: 'high' }),
    assistant('2026-10-06T10:00:07.000Z', 'msg_A1', 'claude-opus-5-5', [toolUse('toolu_A1b', 'Read', { file_path: '/CANARYREADPATH' })],
      usage(3, 300, 500, 1000), { cwd: cwdA, effort: 'high' }),
    { ...base, type: 'user', timestamp: '2026-10-06T10:00:10.000Z', uuid: 'CANARYUUID2', cwd: cwdA, permissionMode: 'plan',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_A1', content: 'CANARYTOOLRESULT' }] },
      toolUseResult: { stdout: 'CANARYTOOLRESULT2', stderr: '' } },
    assistant('2026-10-06T10:01:00.000Z', 'msg_A2', 'claude-opus-5-5', [toolUse('toolu_A2', 'Skill', { skill: 'atdd-oracle' })],
      { ...usage(10, 20, 30, 2000), CANARYNESTEDUSAGE: 'CANARYNESTED' }, { effort: 'xhigh' }),
    assistant('2026-10-06T10:02:00.000Z', 'msg_A3', 'claude-sonnet-5-5', [
      toolUse('toolu_A3', 'Skill', { skill: 'anthropic-skills:CANARYSKILL' }),
      toolUse('toolu_A4', 'mcp__codex-reviewer__codex_delegate', { prompt: 'CANARYMCPINPUT' }),
      { type: 'CANARYBLOCKTYPE', data: 'CANARYBLOCKDATA' },
    ], usage(1, 2, 3, 4), { effort: 'CANARYEFFORT' }),
    assistant('2026-10-06T10:03:00.000Z', 'msg_A4', 'CANARYMODEL-gpt', [
      toolUse('toolu_A5', 'mcp__CANARYPRIVATESRV__run', { query: 'CANARYMCPPRIVATE' }),
      toolUse('toolu_A6', 'CanaryFutureTool', {}),
      toolUse('toolu_A7', 'Agent', { subagent_type: 'claude-researcher', description: 'CANARYDESC', prompt: 'CANARYAGENTPROMPT' }),
    ], usage(5, 5, 5, 5)),
    // A real request with zero usage, from a lowercase custom model that a loose pattern would keep.
    assistant('2026-10-06T10:03:10.000Z', 'msg_A5', 'claude-canaryinternal', [], usage(0, 0, 0, 0), { effort: 'max' }),
    assistant('2026-10-06T10:03:20.000Z', 'msg_A6', 'claude-CANARYCUSTOMER/x', [], usage(1, 1, 1, 1), { effort: 'CANARYEFFORT2' }),
    assistant('2026-10-06T10:03:30.000Z', 'msg_SYN', '<synthetic>', [{ type: 'text', text: 'CANARYSYNTHETIC' }], usage(0, 0, 0, 0)),
    // Later records change the version and the entrypoint: the first values stay.
    { ...base, type: 'user', timestamp: '2026-10-06T10:03:40.000Z', uuid: 'CANARYUUID9', cwd: cwdA, version: '2.1.300',
      entrypoint: 'cli', permissionMode: 'bypassPermissions', message: { role: 'user', content: 'CANARYPROMPT2' } },
    { ...base, type: 'user', timestamp: '2026-10-06T10:03:41.000Z', uuid: 'CANARYUUID10', cwd: cwdA,
      permissionMode: 'CANARYMODE', message: { role: 'user', content: 'CANARYPROMPT3' } },
    { ...base, type: 'user', timestamp: '2026-10-06T10:03:42.000Z', uuid: 'CANARYUUID11', cwd: cwdA,
      permissionMode: 'CANARYMODE2', message: { role: 'user', content: 'CANARYPROMPT4' } },
    { type: 'custom-title', customTitle: 'CANARYTITLE', sessionId: 'CANARYSESSIONID' },
    { type: 'pr-link', timestamp: '2026-10-06T10:04:00.000Z', sessionId: 'CANARYSESSIONID', prNumber: 7,
      prUrl: 'https://github.com/CANARYORG/repo/pull/7', prRepository: 'CANARYORG/repo' },
    { type: 'file-history-snapshot', messageId: 'CANARYMSGID', isSnapshotUpdate: false,
      snapshot: { messageId: 'CANARYMSGID', trackedFileBackups: { '/CANARYFILEPATH': {} }, timestamp: '2026-10-06T10:04:00.000Z' } },
    { type: 'bridge-session', bridgeSessionId: 'CANARYBRIDGE', ownerAccountUuid: 'CANARYACCOUNT', ownerOrganizationUuid: 'CANARYORGUUID' },
    // Three records of unknown types.
    { type: 'frobnicate', timestamp: '2026-10-06T10:05:00.000Z', content: 'CANARYUNKNOWNTYPE' },
    { type: 'frobnicate', timestamp: '2026-10-06T10:05:01.000Z', content: 'CANARYUNKNOWNTYPE2' },
    { type: 'CANARYTYPE', timestamp: '2026-10-06T10:05:02.000Z', content: 'CANARYUNKNOWNTYPE3' },
    // Five invalid lines: not JSON, not an object (twice), an assistant without message, a usage that is a string.
    '{"type":"user","message":{"content":"CANARYBROKENLINE"',
    'null',
    '[]',
    { type: 'assistant', timestamp: '2026-10-06T10:06:00.000Z', requestId: 'CANARYNOMESSAGE' },
    assistant('2026-10-06T10:06:10.000Z', 'msg_BAD', 'claude-opus-5-5', [toolUse('toolu_BAD', 'Bash', { command: 'CANARYBAD' })],
      { ...usage(1, 1, 1, 1), input_tokens: '12' }),
    { type: 'system', timestamp: '2026-10-06T10:44:20.000Z', subtype: 'turn_duration', level: 'info', content: 'CANARYSYSTEM',
      zzCANARYKEY2: 'CANARYUNKNOWNKEY2' },
  ]));

  const subagents = join(dirA, 'CANARYSESSIONA', 'subagents');
  put(join(subagents, 'agent-a1.jsonl'), jsonl([
    { ...base, isSidechain: true, type: 'user', timestamp: '2026-10-06T10:03:05.000Z', uuid: 'CANARYUUID3', cwd: cwdA,
      message: { role: 'user', content: 'CANARYSUBPROMPT' } },
    assistant('2026-10-06T10:03:10.000Z', 'msg_S1', 'claude-sonnet-5-5', [{ type: 'text', text: 'CANARYSUBTEXT' }],
      usage(100, 200, 300, 400), { isSidechain: true }),
    assistant('2026-10-06T10:03:11.000Z', 'msg_S1', 'claude-sonnet-5-5', [{ type: 'text', text: 'CANARYSUBTEXT' }],
      usage(100, 250, 300, 400), { isSidechain: true }),
    // Main tool calls only: this one is not in tool_calls.
    assistant('2026-10-06T10:03:20.000Z', 'msg_S2', 'claude-sonnet-5-5', [toolUse('toolu_S1', 'Bash', { command: 'CANARYSUBCMD' })],
      usage(1, 1, 1, 1), { isSidechain: true }),
    // A copy of a main message: counted in the main transcript only.
    assistant('2026-10-06T10:03:25.000Z', 'msg_A2', 'claude-opus-5-5', [], usage(10, 20, 30, 2000), { isSidechain: true }),
  ]));
  put(join(subagents, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'claude-researcher', description: 'CANARYMETADESC' }));
  put(join(subagents, 'agent-a2.jsonl'), jsonl([
    assistant('2026-10-06T10:04:10.000Z', 'msg_S3', 'claude-haiku-4-5-20251001', [{ type: 'text', text: 'CANARYSUBTEXT2' }],
      usage(10, 10, 10, 10), { isSidechain: true }),
  ]));
  put(join(subagents, 'agent-a2.meta.json'), JSON.stringify({ agentType: 'CANARYPRIVATEAGENT', description: 'CANARYMETADESC2' }));
  // No meta file.
  put(join(subagents, 'agent-a3.jsonl'), jsonl([
    assistant('2026-10-06T10:04:20.000Z', 'msg_S4', 'claude-haiku-4-5-20251001', [], usage(2, 2, 2, 2), { isSidechain: true }),
  ]));
  // A meta file that is not JSON.
  put(join(subagents, 'agent-a4.jsonl'), jsonl([
    assistant('2026-10-06T10:04:30.000Z', 'msg_S5', 'claude-haiku-4-5-20251001', [], usage(3, 3, 3, 3), { isSidechain: true }),
  ]));
  put(join(subagents, 'agent-a4.meta.json'), '{"agentType":"CANARYBROKENMETA"');

  put(join(dirA, 'CANARYSESSIONB.jsonl'), jsonl([
    { ...base, type: 'user', timestamp: '2026-10-11T23:59:30.000Z', uuid: 'CANARYUUID4', cwd: cwdB, version: '2.1.299-beta',
      entrypoint: 'CANARYENTRY', permissionMode: 'default', message: { role: 'user', content: 'CANARYPROMPTB' } },
    // Copies of messages first written in A and in D: counted there, not here, tool calls included.
    assistant('2026-10-11T23:59:40.000Z', 'msg_A1', 'claude-opus-5-5', [{ type: 'text', text: 'CANARYCOPY' }], usage(3, 412, 500, 1200)),
    assistant('2026-10-11T23:59:41.000Z', 'msg_A1', 'claude-opus-5-5', [toolUse('toolu_A1', 'Bash', { command: 'cat CANARYTOOLINPUT' })],
      usage(3, 412, 500, 1200)),
    assistant('2026-10-11T23:59:42.000Z', 'msg_A2', 'claude-opus-5-5', [toolUse('toolu_A2', 'Skill', { skill: 'atdd-oracle' })],
      usage(10, 20, 30, 2000)),
    assistant('2026-10-11T23:59:45.000Z', 'msg_D1', 'claude-opus-5-5', [{ type: 'text', text: 'CANARYCOPY' }], usage(1000, 1000, 1000, 1000)),
    assistant('2026-10-12T00:00:20.000Z', 'msg_B1', 'claude-haiku-4-5-20251001', [{ type: 'text', text: 'CANARYB' }],
      usage(1, 2, 0, 0), { effort: 'low' }),
  ]));

  put(join(dirA, 'CANARYSESSIONC.jsonl'), jsonl([
    { ...base, type: 'user', timestamp: '2026-10-12T00:00:00.000Z', uuid: 'CANARYUUID5', cwd: cwdA, version: '2.1.299',
      entrypoint: 'cli', permissionMode: 'default', message: { role: 'user', content: 'CANARYPROMPTC' } },
    assistant('2026-10-12T00:01:00.000Z', 'msg_C1', 'claude-opus-5-5', [], usage(7, 7, 7, 7)),
  ]));

  put(join(dirA, 'CANARYSESSIOND.jsonl'), jsonl([
    { ...base, type: 'user', timestamp: '2026-10-04T23:59:59.000Z', uuid: 'CANARYUUID6', cwd: cwdA, version: '2.1.299',
      entrypoint: 'cli', permissionMode: 'default', message: { role: 'user', content: 'CANARYPROMPTD' } },
    assistant('2026-10-05T00:00:30.000Z', 'msg_D1', 'claude-opus-5-5', [], usage(1000, 1000, 1000, 1000)),
  ]));

  put(join(dirA, 'CANARYSESSIONE.jsonl'), jsonl([
    { ...base, type: 'user', timestamp: '2026-10-07T09:00:00.000Z', uuid: 'CANARYUUID7', cwd: cwdA, version: '2.1.299',
      entrypoint: 'cli', permissionMode: 'default', message: { role: 'user', content: 'CANARYPROMPTE' } },
    assistant('2026-10-07T09:00:01.000Z', 'msg_E1', '<synthetic>', [{ type: 'text', text: 'CANARYE' }], usage(0, 0, 0, 0)),
  ]));

  put(join(dirF, 'CANARYSESSIONF.jsonl'), jsonl([
    { ...base, type: 'user', timestamp: '2026-10-08T12:00:00.000Z', uuid: 'CANARYUUID8', cwd: cwdF, version: '2.1.295',
      entrypoint: 'cli', permissionMode: 'default', message: { role: 'user', content: 'CANARYPROMPTF' } },
    assistant('2026-10-08T12:30:00.000Z', 'msg_F1', 'claude-sonnet-5-5', [], usage(4, 4, 4, 4), { effort: 'medium' }),
  ]));

  return { projects, cwdA, cwdB, cwdF };
}

const noSubagents = {
  count: 0, requests: 0, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, types: {},
};

export const ROW_A = {
  week: '2026-W41',
  cli_version: '2.1.299',
  entrypoint: 'claude-desktop',
  permission_mode: ['auto', 'bypassPermissions', 'other', 'plan'],
  models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'other'],
  efforts: ['high', 'max', 'other', 'xhigh'],
  requests: 6,
  input_tokens: 20,
  output_tokens: 440,
  cache_creation_input_tokens: 539,
  cache_read_input_tokens: 3210,
  // 10:00:00 to 10:44:20 is 44 min 20 s.
  duration_minutes: 44,
  tool_calls: { Bash: 1, Read: 1, Skill: 2, 'mcp:codex-reviewer': 1, 'mcp:other': 1, other: 1, Agent: 1 },
  skills: { 'atdd-oracle': 1, other: 1 },
  subagents: {
    count: 4, requests: 5, input_tokens: 116, output_tokens: 266, cache_creation_input_tokens: 316,
    cache_read_input_tokens: 416, types: { 'claude-researcher': 1, other: 3 },
  },
};

export const ROW_B = {
  week: '2026-W41',
  cli_version: 'other',
  entrypoint: 'other',
  permission_mode: ['default'],
  models: ['claude-haiku-4-5-20251001'],
  efforts: ['low'],
  requests: 1,
  input_tokens: 1,
  output_tokens: 2,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  // 50 s.
  duration_minutes: 1,
  tool_calls: {},
  skills: {},
  subagents: noSubagents,
};

export const ROW_F = {
  week: '2026-W41',
  cli_version: '2.1.295',
  entrypoint: 'cli',
  permission_mode: ['default'],
  models: ['claude-sonnet-5-5'],
  efforts: ['medium'],
  requests: 1,
  input_tokens: 4,
  output_tokens: 4,
  cache_creation_input_tokens: 4,
  cache_read_input_tokens: 4,
  duration_minutes: 30,
  tool_calls: {},
  skills: {},
  subagents: noSubagents,
};

export const RANGE = ['--since', '2026-10-05', '--until', '2026-10-11'];

// Rows have no identity, so tests compare them in a stable order of their own.
export const sortRows = (rows) => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

// Generates a report from the fixture with the given copy of the script and returns its path.
export function makeReport({ dir = tempDir(), script = reportScript } = {}) {
  const config = join(dir, 'config');
  writeTranscripts(config);
  const out = join(dir, 'report.json');
  const r = runNode(script, [...RANGE, '--out', out], { cwd: dir, env: { CLAUDE_CONFIG_DIR: config } });
  assert.equal(r.status, 0, r.stderr);
  return out;
}

// A copy of this repository's scripts/ and global/, so that a script can run with a changed source.
export function copyScripts() {
  const dir = tempDir();
  for (const part of ['scripts', 'global']) cpSync(join(repo, part), join(dir, part), { recursive: true });
  return dir;
}

// A git repository whose main branch holds this repository's scripts/, global/ and .github/, as the base of a
// donation pull request would.
export function makeRepo() {
  const dir = tempDir();
  for (const part of ['scripts', 'global', '.github']) cpSync(join(repo, part), join(dir, part), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

export function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
