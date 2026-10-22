#!/usr/bin/env node
// Issue #34: a local, read-only report on delegations from Claude Code transcripts: how task packages are filled,
// how large hand-backs and Codex results are and what Codex used. It prints aggregates, never prompt or report
// text, and is not part of the metrics donation (ADR 0023).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PARAMETERS = ['working_dir', 'context', 'target_files', 'acceptance_criteria', 'system_instructions',
  'output_schema', 'model', 'reasoning_effort'];
const CODEX = /^mcp__(.+)__(codex_delegate|codex_follow_up|codex_job_result)$/;
// Older codex-subagent-mcp versions print no uncached figure; it is then the input less the cached tokens. A
// thread of several turns prints `tokens this turn=` and `tokens thread so far=`; only this turn is the result's.
const STATS = /^model=([^\s|]+) \| effort=([^\s|]+) \|.*\btokens(?: this turn)?=in (\d+) \(cached (\d+)(?:, uncached (\d+))?\) \/ out (\d+)/;
const BEGIN = '-----BEGIN STRUCTURED RESULT-----';
const END = '-----END STRUCTURED RESULT-----';
const USAGE = 'Usage: metrics-delegations.mjs [--dir <projects>] [--since YYYY-MM-DD] [--rates <file>] [--json] [--verbose]';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const missing = (value) => value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
const dayOf = (timestamp) => {
  const time = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
};
const words = (name) => name.toLowerCase().split(/\s+/);

// Nearest rank: the p-th percentile of n sorted values is the ceil(p*n)-th; null over no values.
function rank(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(1, Math.ceil(p * sorted.length)) - 1];
}
const spread = (values) => ({ median: rank(values, 0.5), p90: rank(values, 0.9) });
const sizes = (values) => ({ ...spread(values), max: values.length ? values.reduce((a, b) => (b > a ? b : a)) : null });

function options(args) {
  const result = { json: false, verbose: false };
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--json' || key === '--verbose') { result[key.slice(2)] = true; continue; }
    if (!['--dir', '--since', '--rates'].includes(key)) throw new Error(`Unknown argument. ${USAGE}`);
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} needs a value. ${USAGE}`);
    result[key.slice(2)] = value;
  }
  if (result.since !== undefined) {
    const date = new Date(`${result.since}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(result.since) || !Number.isFinite(+date) || date.toISOString().slice(0, 10) !== result.since) {
      throw new Error('Invalid date for --since: use a real calendar date in YYYY-MM-DD form');
    }
    result.since = +date;
  }
  return result;
}

function rates(file) {
  let table;
  try { table = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error('Cannot read --rates as JSON'); }
  const valid = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!object(table) || !Object.values(table).every((r) => object(r) && ['input', 'cached', 'output'].every((k) => valid(r[k])))) {
    throw new Error('Invalid --rates: each model needs non-negative input, cached and output credits per million tokens');
  }
  return table;
}

// The `- Name:` items of the list after "Write each field", so the report follows the skill.
function fields() {
  let lines;
  try { lines = readFileSync(join(root, 'global/skills/task-package/SKILL.md'), 'utf8').split(/\r?\n/); } catch (error) {
    throw new Error(`Cannot read the task-package skill (${error.code ?? 'error'})`);
  }
  const start = lines.findIndex((line) => line.includes('Write each field'));
  const names = [];
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    if (line.startsWith('#')) break;
    const item = /^- ([^:]+):/.exec(line);
    if (item) names.push(item[1].trim());
  }
  if (!names.length) throw new Error('No fields found in global/skills/task-package/SKILL.md');
  return names.map((name) => {
    const first = words(name)[0];
    const shared = names.some((other) => other !== name && words(other)[0] === first);
    return { name, full: name.toLowerCase(), first: shared ? null : new RegExp(`^${first.replace(/\W/g, '\\$&')}\\b`) };
  });
}

// A field is present when a line starts with its name, or its unshared first word, after markers and emphasis.
function missingFields(text, list) {
  const starts = text.split(/\r?\n/).map((line) => line.replace(/^(?:\s+|[-*>#_]+|\d+[.)])*/, '').toLowerCase());
  return list.filter((f) => !starts.some((s) => s.startsWith(f.full) || (f.first && f.first.test(s)))).map((f) => f.name);
}

// Every `*.jsonl` under the root; a directory that cannot be listed is skipped and counted, never named.
function transcripts(dir, counters) {
  let info;
  try { info = statSync(dir); } catch { throw new Error('The transcript directory does not exist'); }
  if (!info.isDirectory()) throw new Error('The transcript directory is not a directory');
  const files = [];
  const walk = (directory, top) => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch (error) {
      if (top) throw new Error(`Cannot read the transcript directory (${error.code ?? 'error'})`);
      counters.unreadable++;
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(join(directory, e.name), false);
      else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(join(directory, e.name));
    }
  };
  walk(dir, true);
  return files.sort(byName);
}

// The records of one transcript, or null when it cannot be read (a live one may vanish after listing).
function records(file, counters) {
  let content;
  try { content = readFileSync(file, 'utf8'); } catch {
    counters.unreadable++;
    return null;
  }
  const result = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (object(record)) result.push(record);
    } catch { counters.invalid++; }
  }
  return result;
}

const blocks = (record) => (object(record.message) && Array.isArray(record.message.content) ? record.message.content.filter(object) : []);
const resultText = (block) => typeof block.content === 'string' ? block.content
  : Array.isArray(block.content) ? block.content.filter((c) => object(c) && typeof c.text === 'string').map((c) => c.text).join('\n') : '';

function delegateOf(block) {
  if (block.name === 'Agent') {
    const type = typeof block.input?.subagent_type === 'string' && block.input.subagent_type ? block.input.subagent_type : 'general-purpose';
    return { name: type, codex: false };
  }
  const codex = CODEX.exec(block.name ?? '');
  return codex && codex[2] !== 'codex_job_result' ? { name: codex[1], codex: true, tool: codex[2] } : null;
}

function packageOf(block, codex) {
  const input = object(block.input) ? block.input : {};
  const parts = codex
    ? [input.prompt, input.context, input.system_instructions, ...(Array.isArray(input.acceptance_criteria) ? input.acceptance_criteria : [])]
    : [input.prompt];
  const strings = parts.filter((s) => typeof s === 'string');
  return { text: strings.join('\n'), chars: strings.reduce((n, s) => n + s.length, 0) };
}

// The statistics line, the structured block and the command log of one Codex result, by character offsets.
function codexResult(text) {
  const lines = [];
  let offset = 0;
  for (const line of text.split('\n')) { lines.push({ start: offset, line }); offset += line.length + 1; }
  const statsIndex = lines.findLastIndex((l) => STATS.test(l.line));
  if (statsIndex < 0) return null;
  const [, model, effort, input, cached, uncached, output] = STATS.exec(lines[statsIndex].line);
  const begin = lines.findIndex((l) => l.line.trimEnd() === BEGIN);
  const end = begin < 0 ? -1 : lines.findIndex((l, i) => i > begin && l.line.trimEnd() === END);
  const commands = lines.findIndex((l, i) => i < statsIndex && l.line.startsWith('Commands run ('));
  return {
    model, effort, input: +input, cached: +cached, uncached: uncached === undefined ? input - cached : +uncached, output: +output, chars: text.length,
    structured: end < 0 ? 0 : lines[end].start + lines[end].line.length - lines[begin].start,
    commands: commands < 0 ? 0 : lines[statsIndex].start - 1 - lines[commands].start,
  };
}

// Text between the newline ending the frame line and the newline before `</agent-message>`.
function handback(content) {
  const from = /<agent-message from="([^"]*)">/.exec(content);
  const frame = content.indexOf('[Subagent hand-back]');
  if (!from || frame < 0) return null;
  const start = content.indexOf('\n', frame) + 1;
  const end = content.indexOf('\n</agent-message>', start - 1);
  if (start <= 0 || end < start - 1) return null;
  return { agent: from[1], chars: Math.max(0, end - start) };
}

function collect(dir, opts) {
  const counters = { invalid: 0, unreadable: 0, read: 0 };
  const files = transcripts(dir, counters);
  const delegations = [];
  const results = [];
  const handbacks = new Map();
  const counted = (record) => opts.since === undefined || Date.parse(record.timestamp) >= opts.since;
  for (const file of files) {
    const parts = relative(dir, file).split(sep);
    const project = parts.length > 1 ? parts[0] : '(none)';
    const session = parts.at(-1).slice(0, -'.jsonl'.length);
    const uses = new Map();
    let loaded = false;
    let ran = false;
    const list = records(file, counters);
    if (!list) continue;
    counters.read++;
    for (const record of list) {
      if (record.type === 'queue-operation' && typeof record.content === 'string' && counted(record)) {
        const h = handback(record.content);
        if (h && !handbacks.has(h.agent)) handbacks.set(h.agent, h.chars);
      }
      for (const block of blocks(record)) {
        if (record.type === 'assistant' && block.type === 'tool_use') {
          const delegate = delegateOf(block);
          if (delegate && counted(record)) {
            const pkg = packageOf(block, delegate.codex);
            const row = { ...delegate, loaded, ran, pkg, input: object(block.input) ? block.input : {},
              date: dayOf(record.timestamp), project, session, result: null };
            delegations.push(row);
            uses.set(block.id, { name: block.name, row });
          } else if (CODEX.test(block.name ?? '')) uses.set(block.id, { name: block.name });
          if (block.name === 'Skill' && typeof block.input?.skill === 'string' &&
            (block.input.skill === 'task-package' || block.input.skill.endsWith(':task-package'))) loaded = true;
          if (block.name === 'Bash' && typeof block.input?.command === 'string' && block.input.command.includes('task-package.mjs')) ran = true;
        }
        if (record.type === 'user' && block.type === 'tool_result' && uses.has(block.tool_use_id)) {
          const use = uses.get(block.tool_use_id);
          const text = resultText(block);
          if (use.row && use.row.result === null) use.row.result = text.length;
          const parsed = CODEX.test(use.name) && counted(record) ? codexResult(text) : null;
          if (parsed) results.push(parsed);
        }
      }
    }
  }
  return { counters, delegations, results, handbacks: [...handbacks.values()] };
}

function report(data, opts, list, table) {
  // No prototype, so a delegate named `__proto__` stays an ordinary key.
  const delegates = Object.create(null);
  for (const name of [...new Set(data.delegations.map((d) => d.name))].sort(byName)) {
    const rows = data.delegations.filter((d) => d.name === name);
    const chars = rows.map((d) => d.pkg.chars);
    const missingCount = Object.fromEntries(list.map((f) => [f.name, 0]));
    for (const row of rows) for (const field of missingFields(row.pkg.text, list)) missingCount[field]++;
    const entry = {
      delegations: rows.length,
      task_package_loaded: rows.filter((d) => d.loaded).length,
      task_package_script: rows.filter((d) => d.ran).length,
      missing_fields: missingCount,
      package_chars: { ...sizes(chars), total: chars.reduce((a, b) => a + b, 0) },
    };
    if (rows.some((d) => d.codex)) {
      const calls = rows.filter((d) => d.tool === 'codex_delegate');
      entry.missing_parameters = Object.fromEntries(PARAMETERS.map((p) => [p, calls.filter((d) => missing(d.input[p])).length]));
    }
    delegates[name] = entry;
  }
  const keys = [...new Set(data.results.map((r) => `${r.model}\n${r.effort}`))].sort(byName);
  const codex = keys.map((key) => {
    const [model, effort] = key.split('\n');
    const rs = data.results.filter((r) => r.model === model && r.effort === effort);
    const total = rs.reduce((n, r) => n + r.chars, 0);
    const shareOf = (section) => (total ? rs.reduce((n, r) => n + r[section], 0) / total : null);
    const group = {
      model, effort, results: rs.length,
      input_tokens: spread(rs.map((r) => r.input)), cached_tokens: spread(rs.map((r) => r.cached)),
      output_tokens: spread(rs.map((r) => r.output)),
      command_log_share: shareOf('commands'), structured_share: shareOf('structured'),
    };
    if (table) {
      const rate = Object.hasOwn(table, model) ? table[model] : null;
      group.credits = rate ? spread(rs.map((r) => (r.uncached * rate.input + r.cached * rate.cached + r.output * rate.output) / 1e6)) : null;
    }
    return group;
  });
  const doc = {
    transcripts: data.counters.read, invalid_lines: data.counters.invalid, delegates, codex,
    handbacks: { count: data.handbacks.length, chars: sizes(data.handbacks) },
  };
  if (table) doc.unpriced = [...new Set(codex.filter((g) => g.credits === null).map((g) => g.model))].sort(byName);
  if (opts.verbose) {
    doc.delegations = data.delegations.map((d) => ({ date: d.date, project: d.project, session: d.session, delegate: d.name,
      package_chars: d.pkg.chars, result_chars: d.result }));
  }
  return doc;
}

// Names from transcripts lose colons and control characters, so they cannot break or forge a `Label: value` line.
const safe = (name) => String(name).replace(/[\p{Cc}\u2028\u2029:]/gu, '_');
const value = (n) => (n === null || n === undefined ? 'none' : String(n));
const percent = (n) => (n === null ? 'none' : `${(n * 100).toFixed(1)}%`);
const credit = (n) => (n === null ? 'none' : String(Number(n.toFixed(6))));
const stats = (s, format = value) => Object.entries(s).map(([k, n]) => `${k} ${format(n)}`).join(', ');

function text(doc, unreadable) {
  const lines = [`Transcripts: ${doc.transcripts}`, `Unreadable paths skipped: ${unreadable}`, `Invalid lines skipped: ${doc.invalid_lines}`];
  for (const [raw, d] of Object.entries(doc.delegates)) {
    const name = safe(raw);
    lines.push(`Delegate ${name} delegations: ${d.delegations}`, `Delegate ${name} task-package loaded: ${d.task_package_loaded}`,
      `Delegate ${name} task-package script run: ${d.task_package_script}`, `Delegate ${name} package chars: ${stats(d.package_chars)}`);
    for (const [field, n] of Object.entries(d.missing_fields)) lines.push(`Delegate ${name} missing field ${field}: ${n}`);
    for (const [parameter, n] of Object.entries(d.missing_parameters ?? {})) lines.push(`Delegate ${name} missing parameter ${parameter}: ${n}`);
  }
  for (const g of doc.codex) {
    const label = `Codex ${safe(g.model)} ${safe(g.effort)}`;
    lines.push(`${label} results: ${g.results}`, `${label} input tokens: ${stats(g.input_tokens)}`,
      `${label} cached tokens: ${stats(g.cached_tokens)}`, `${label} output tokens: ${stats(g.output_tokens)}`,
      `${label} command log share: ${percent(g.command_log_share)}`, `${label} structured result share: ${percent(g.structured_share)}`);
    if ('credits' in g) lines.push(`${label} credits per result: ${g.credits ? stats(g.credits, credit) : 'unpriced'}`);
  }
  if (doc.unpriced) lines.push(`Unpriced models: ${doc.unpriced.length ? doc.unpriced.map(safe).join(', ') : 'none'}`);
  lines.push(`Hand-backs: ${doc.handbacks.count}`, `Hand-back chars: ${stats(doc.handbacks.chars)}`);
  for (const d of doc.delegations ?? []) {
    lines.push(`Delegation: date ${value(d.date)}, project ${safe(d.project)}, session ${safe(d.session)}, delegate ${safe(d.delegate)}, ` +
      `package chars ${d.package_chars}, result chars ${value(d.result_chars)}`);
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const opts = options(process.argv.slice(2));
  const table = opts.rates === undefined ? null : rates(opts.rates);
  const list = fields();
  const dir = opts.dir ?? join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  const data = collect(dir, opts);
  const doc = report(data, opts, list, table);
  const { unreadable } = data.counters;
  // The JSON document keeps its documented keys, so skipped paths are noted on stderr.
  if (opts.json && unreadable) console.error(`Unreadable paths skipped: ${unreadable}`);
  // A reader that closes the pipe early, such as head, ends the report quietly.
  process.stdout.on('error', (error) => {
    if (error.code !== 'EPIPE') { console.error(error.message); process.exitCode = 1; }
  });
  process.stdout.write(opts.json ? `${JSON.stringify(doc, null, 2)}\n` : text(doc, unreadable));
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
