#!/usr/bin/env node
// Issue #19 (ADR 0023): build a report from allowlisted fields only. Keep extraction in this file so
// script_sha256 identifies all of its code; the validator shares its enumerations through exports.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const root = join(dirname(script), '..');
export const TOKENS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
export const COUNTS = ['requests', ...TOKENS];
export const VERSION = /^\d+\.\d+\.\d+$/;
export const MODEL = /^claude-(opus|sonnet|haiku|fable)-\d+(-\d+)?(-\d{8})?$/;
export const ENTRYPOINTS = ['cli', 'claude-desktop', 'claude-vscode', 'sdk-cli', 'sdk-ts', 'sdk-py'];
export const PERMISSIONS = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const TOOLS = ['Bash', 'Edit', 'Write', 'Read', 'WebFetch', 'ToolSearch', 'Skill', 'Agent', 'WebSearch',
  'SubagentHandback', 'AskUserQuestion', 'SendMessage', 'Monitor', 'SendUserFile', 'ReadNotifications',
  'TaskStop', 'ExitPlanMode', 'Glob', 'Grep', 'NotebookEdit', 'TodoWrite', 'Task', 'EnterPlanMode', 'KillShell', 'BashOutput'];

export function allowlists() {
  return {
    skills: readdirSync(join(root, 'global/skills'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name),
    agents: readdirSync(join(root, 'global/agents'), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name.slice(0, -3)),
    servers: Object.keys(JSON.parse(readFileSync(join(root, 'global/mcp-servers.json'), 'utf8'))),
  };
}

const recordTypes = new Set(['user', 'assistant', 'attachment', 'system', 'custom-title', 'pr-link',
  'file-history-snapshot', 'bridge-session', 'queue-operation', 'last-prompt', 'relocated', 'atis-latch',
  'agent-name', 'file-history-delta', 'cost-state', 'mode', 'summary', 'api-request-shape', 'api-request-blob',
  'api-request', 'agent-setting']);
const recordKeys = new Set(`type operation timestamp sessionId content parentUuid isSidechain promptId message uuid
  permissionMode origin promptSource turnOrigin turnPosition userType entrypoint cwd version gitBranch attachment
  rendered renderedRole lastPrompt leafUuid relocatedCwd messageId snapshot isSnapshotUpdate atis bridgeSessionId
  lastSequenceNum ownerAccountUuid ownerOrganizationUuid customTitle agentName thinkingDurationMs thinkingDisplay
  serverClassifierRequest apiBlockIndex requestId requestedModel effort perTurnEffort wireToolInputs wireIngestContext
  toolUseResult serverClassifierContext sourceToolAssistantUUID permissionDecision renderedBesideToolResult subtype
  hookCount hookInfos hookErrors hookAdditionalContext preventedContinuation stopReason hasOutput level toolUseID
  attributionMcpServer attributionMcpTool snapshotMessageId trackingPath backup renderedInHumanTurn reason commandUuid
  deliveryId prNumber prUrl prRepository mcpMeta queueSkipAttachments totalCostUSD totalAPIDuration
  totalAPIDurationWithoutRetries totalToolDuration totalLinesAdded totalLinesRemoved totalDuration startTime modelUsage
  hasUnknownModelCost mode toolDenialKind isMeta turnCompanion sourceToolUseID attributionSkill apiError apiErrorParams
  quotaLimits error isApiErrorMessage apiErrorStatus slug agentId attributionAgent classifierMetaLines toolEndsTurn
  queueSkipSlashCommands requestRef attributionPlugin logicalParentUuid compactMetadata isVisibleInTranscriptOnly
  isCompactSummary retryInMs retryAttempt maxRetries source usageLimitNote shapeHash shape hash id querySource params keep
  tail cacheControl requestDigest base agentSetting`.split(/\s+/));

export const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const hashScript = (text) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
const allowed = (value, values) => values.includes(value) ? value : 'other';
const patterned = (value, pattern) => typeof value === 'string' && pattern.test(value) ? value : 'other';
const distinct = (values) => [...new Set(values)].sort();
const counts = () => Object.fromEntries(COUNTS.map((key) => [key, 0]));
const increment = (target, key) => { target[key] = (target[key] ?? 0) + 1; };
const addCounts = (target, source) => { for (const key of COUNTS) target[key] += source[key]; };
const skippedCounts = () => ({ invalid: 0, types: 0, keys: 0 });
// Names in code-unit order: a locale's collation would make ownership of a copied message depend on the machine.
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Only an explicit offset makes a timestamp a point in time; outside 1970 to 9999 it is corrupt, and an ISO
// week could not even be written for it.
const MIN_TIME = Date.UTC(1970, 0, 1);
const MAX_TIME = Date.UTC(10000, 0, 1);
const validTimestamp = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/.test(value)) return false;
  // Date.parse normalises impossible calendar days instead of rejecting them.
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (!(day >= MIN_TIME && day < MAX_TIME) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) return false;
  const time = Date.parse(value);
  return time >= MIN_TIME && time < MAX_TIME;
};
const unreadable = { paths: 0 };

export function isoWeek(date) {
  const day = new Date(date);
  day.setUTCHours(0, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() + 3 - ((day.getUTCDay() + 6) % 7));
  const year = day.getUTCFullYear();
  const jan4 = new Date(day);
  jan4.setUTCMonth(0, 4);
  const week = 1 + Math.round(((day - jan4) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${String(year).padStart(4, '0')}-W${String(week).padStart(2, '0')}`;
}

function transcript(file) {
  const records = [];
  const skipped = skippedCounts();
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { unreadable.paths++; return { records, skipped, unreadable: true }; }
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line.replace(/^\uFEFF/, '')); } catch { skipped.invalid++; continue; }
    if (!object(record) || (record.timestamp !== undefined && !validTimestamp(record.timestamp)) || (record.type === 'assistant' &&
      (typeof record.message?.id !== 'string' || !record.message.id || TOKENS.some((key) =>
        record.message.usage?.[key] !== undefined &&
        (!Number.isSafeInteger(record.message.usage[key]) || record.message.usage[key] < 0))))) {
      skipped.invalid++;
      continue;
    }
    if (!recordTypes.has(record.type)) { skipped.types++; continue; }
    skipped.keys += Object.keys(record).filter((key) => !recordKeys.has(key)).length;
    records.push(record);
  }
  return { records, skipped };
}

// The projects folder must be readable; any other directory that cannot be read is skipped and counted.
function entries(directory, required = false) {
  try { return readdirSync(directory, { withFileTypes: true }).sort((a, b) => byName(a.name, b.name)); }
  catch (error) {
    if (required) throw new Error(error.code === 'ENOENT' ? 'Transcript directory does not exist' : 'Cannot read transcript directory');
    if (error.code !== 'ENOENT') unreadable.paths++;
    return [];
  }
}

// Resolve existing paths through symlinks as well as normalising relative paths (notably /var on macOS).
function canonical(path) {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch { return absolute; }
}

function requests(records, seen, owned = new Map()) {
  for (const record of records) {
    if (record.type !== 'assistant' || record.message.model === '<synthetic>') continue;
    const { id, model, usage } = record.message;
    if (!owned.has(id)) {
      if (seen.has(id)) continue;
      seen.add(id);
      owned.set(id, { ...counts(), requests: 1, models: [], efforts: [] });
    }
    const request = owned.get(id);
    for (const key of TOKENS) request[key] = Math.max(request[key], usage?.[key] ?? 0);
    request.models.push(patterned(model, MODEL));
    if (record.effort !== undefined) request.efforts.push(allowed(record.effort, EFFORTS));
  }
  const result = { ...counts(), models: [], efforts: [] };
  for (const request of owned.values()) {
    addCounts(result, request);
    result.models.push(...request.models);
    result.efforts.push(...request.efforts);
  }
  result.models = distinct(result.models);
  result.efforts = distinct(result.efforts);
  return result;
}

function sessionRow(session, seen, lists) {
  const { records } = session.main;
  const owned = new Map();
  const main = requests(records, seen, owned);
  const first = (key) => records.find((record) => record[key] !== undefined)?.[key];
  const row = {
    week: Number.isFinite(session.start) ? isoWeek(session.start) : 'other',
    cli_version: patterned(first('version'), VERSION),
    entrypoint: allowed(first('entrypoint'), ENTRYPOINTS),
    permission_mode: distinct(records.filter((r) => r.permissionMode !== undefined).map((r) => allowed(r.permissionMode, PERMISSIONS))),
    ...main,
    duration_minutes: Math.max(0, Math.round((session.end - session.start) / 60000)),
    tool_calls: {}, skills: {}, subagents: { count: 0, ...counts(), types: {} },
  };
  const toolIds = new Set();
  for (const record of records) {
    if (record.type !== 'assistant' || record.message.model === '<synthetic>' || !owned.has(record.message.id)) continue;
    if (!Array.isArray(record.message?.content)) continue;
    for (const block of record.message.content) {
      if (block?.type !== 'tool_use' || typeof block.id !== 'string' || toolIds.has(block.id)) continue;
      toolIds.add(block.id);
      const server = typeof block.name === 'string' ? /^mcp__(.+?)__(.+)$/.exec(block.name)?.[1] : undefined;
      const name = server ? `mcp:${allowed(server, lists.servers)}` : allowed(block.name, TOOLS);
      increment(row.tool_calls, name);
      if (block.name === 'Skill') increment(row.skills, allowed(block.input?.skill, lists.skills));
    }
  }
  const subdir = join(dirname(session.file), session.file.split(sep).at(-1).slice(0, -6), 'subagents');
  for (const entry of entries(subdir).filter((e) => e.isFile() && /^agent-.*\.jsonl$/.test(e.name))) {
    const file = join(subdir, entry.name);
    const sub = transcript(file);
    if (sub.unreadable) continue;
    addCounts(row.subagents, requests(sub.records, seen));
    row.subagents.count++;
    let type;
    try { type = JSON.parse(readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')).agentType; } catch { /* missing metadata is other */ }
    increment(row.subagents.types, allowed(type, lists.agents));
    for (const key of Object.keys(sub.skipped)) session.main.skipped[key] += sub.skipped[key];
  }
  return row;
}

function options(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--since', '--until', '--project', '--out'].includes(key) || !args[index + 1] ||
      args[index + 1].startsWith('--') || result[key] !== undefined) throw new Error('Invalid arguments: use --since, --until, --project and --out with values');
    result[key] = args[index + 1];
  }
  for (const key of ['--since', '--until']) {
    if (result[key] === undefined) continue;
    const date = new Date(`${result[key]}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(result[key]) || !Number.isFinite(+date) || date.toISOString().slice(0, 10) !== result[key]) {
      throw new Error(`Invalid date for ${key}`);
    }
  }
  if (result['--since'] && result['--until'] && result['--since'] > result['--until']) throw new Error('Invalid range: --since is after --until');
  return result;
}

function main() {
  const opts = options(process.argv.slice(2));
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
  const sessions = [];
  for (const project of entries(projects, true).filter((e) => e.isDirectory())) {
    const directory = join(projects, project.name);
    for (const entry of entries(directory).filter((e) => e.isFile() && e.name.endsWith('.jsonl'))) {
      const file = join(directory, entry.name);
      const main = transcript(file);
      if (main.unreadable) continue;
      const timestamps = main.records.map((r) => typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN).filter(Number.isFinite);
      sessions.push({ file, main, start: timestamps[0] ?? Infinity, end: timestamps.at(-1) ?? Infinity });
    }
  }
  sessions.sort((a, b) => a.start - b.start || byName(a.file, b.file));
  const lists = allowlists();
  const seen = new Set();
  const rows = [];
  const skipped = skippedCounts();
  const project = opts['--project'] === undefined ? undefined : canonical(opts['--project']);
  for (const session of sessions) {
    // Ownership includes filtered-out sessions, and main requests precede subagent requests.
    const row = sessionRow(session, seen, lists);
    if (!Number.isFinite(session.start) || !row.requests) continue;
    const day = new Date(session.start).toISOString().slice(0, 10);
    if ((opts['--since'] && day < opts['--since']) || (opts['--until'] && day > opts['--until'])) continue;
    if (project !== undefined) {
      const cwd = session.main.records.find((r) => r.cwd !== undefined)?.cwd;
      if (typeof cwd !== 'string') continue;
      const path = relative(project, canonical(cwd));
      if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) continue;
    }
    rows.push(row);
    for (const key of Object.keys(skipped)) skipped[key] += session.main.skipped[key];
  }
  if (!rows.length) throw new Error('No sessions match the requested range and project');
  const totals = { sessions: rows.length, ...counts() };
  for (const row of rows) addCounts(totals, row);
  const report = { schema_version: 1, script_version: '1.0.0', script_sha256: hashScript(readFileSync(script, 'utf8')),
    generated_week: isoWeek(new Date()), license: 'CC0-1.0', totals, sessions: rows };
  const out = opts['--out'] ?? `${report.generated_week}-${randomBytes(4).toString('hex')}.json`;
  let fd;
  try { fd = openSync(out, 'wx'); } catch (error) {
    throw new Error(error.code === 'EEXIST' ? 'Output file already exists' : 'Cannot create output file');
  }
  try { writeFileSync(fd, `${JSON.stringify(report, null, 2)}\n`); }
  catch { closeSync(fd); unlinkSync(out); throw new Error('Cannot write output file'); }
  closeSync(fd);
  const summary = {
    Sessions: totals.sessions, Weeks: distinct(rows.map((r) => r.week)).join(', '),
    Models: distinct(rows.flatMap((r) => r.models)).join(', '), Requests: totals.requests,
    'Input tokens': totals.input_tokens, 'Output tokens': totals.output_tokens,
    'Cache creation tokens': totals.cache_creation_input_tokens, 'Cache read tokens': totals.cache_read_input_tokens,
    'Invalid lines skipped': skipped.invalid, 'Unknown record types skipped': skipped.types, 'Unknown keys skipped': skipped.keys,
    'Unreadable paths skipped': unreadable.paths,
    Report: out, Reminder: 'Read the file before submitting it.',
  };
  for (const [label, value] of Object.entries(summary)) console.log(`${label}: ${value}`);
}

export const isMain = (url) => process.argv[1] && canonical(process.argv[1]) === canonical(fileURLToPath(url));

if (isMain(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
