#!/usr/bin/env node
// Issue #19: validate donated data without trusting its claimed script version or origin.
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { allowlists, COUNTS, EFFORTS, ENTRYPOINTS, hashScript, isMain, isoWeek, MODEL, object, PERMISSIONS, TOOLS, VERSION } from './metrics-report.mjs';

export const MAX_BYTES = 2 * 1024 * 1024;

// Quote donated values so neither control characters nor a leading :: can become workflow commands.
export const shown = (value) => JSON.stringify(value)
  .replace(/[\u007f-\u009f\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

export function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Cannot read git data: ${result.error?.message ?? result.stderr.trim()}`);
  return result.stdout;
}

export function validWeek(value) {
  if (typeof value !== 'string' || !/^\d{4}-W\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const week = Number(value.slice(6));
  const last = new Date(`${value.slice(0, 4)}-12-28T00:00:00Z`);
  return year > 0 && week > 0 && week <= Number(isoWeek(last).slice(6));
}

export function validateReport(file, ref = 'main') {
  const errors = [];
  const fail = (where, cause) => errors.push(`${shown(where)}: ${shown(cause)}`);
  let report;
  try {
    if (statSync(file).size > MAX_BYTES) return ['Report exceeds 2 MiB (2097152 bytes)'];
    const text = readFileSync(file, 'utf8');
    try { report = JSON.parse(text); } catch { return ['Report is not valid JSON']; }
  } catch { return ['Cannot read report file']; }
  const lists = allowlists();
  const shape = (value, keys, where) => {
    if (!object(value)) { fail(where, 'must be an object'); return false; }
    for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${where}.${key}`, 'required key is missing');
    for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${where}.${key}`, 'unknown key');
    return true;
  };
  const integer = (value, where, minimum = 0) => {
    if (!Number.isSafeInteger(value) || value < minimum) fail(where, minimum ? 'must be a positive safe integer' : 'must be a non-negative safe integer');
  };
  const string = (value, where, matches) => {
    if (typeof value !== 'string' || !matches(value)) fail(where, 'string outside enumeration or pattern');
  };
  const enumeration = (values) => (value) => value === 'other' || values.includes(value);
  const pattern = (regex) => (value) => value === 'other' || regex.test(value);
  const array = (value, where, matches) => {
    if (!Array.isArray(value)) { fail(where, 'must be an array'); return; }
    value.forEach((item, index) => string(item, `${where}[${index}]`, matches));
    if (JSON.stringify(value) !== JSON.stringify([...new Set(value)].sort())) fail(where, 'must be sorted and distinct');
  };
  const counting = (value, where, keys) => {
    if (!object(value)) { fail(where, 'must be a counting object'); return; }
    for (const [key, count] of Object.entries(value)) {
      if (!keys.includes(key)) fail(`${where}.${key}`, 'unknown counting key');
      integer(count, `${where}.${key}`, 1);
    }
  };
  const numbers = (value, where, keys) => { for (const key of keys) integer(value[key], `${where}.${key}`); };
  if (!shape(report, ['schema_version', 'script_version', 'script_sha256', 'generated_week', 'license', 'totals', 'sessions'], 'report')) return errors;
  if (report.schema_version !== 1) fail('schema_version', 'must be 1');
  string(report.script_version, 'script_version', (v) => VERSION.test(v));
  string(report.script_sha256, 'script_sha256', (v) => /^[0-9a-f]{64}$/.test(v));
  if (!validWeek(report.generated_week)) fail('generated_week', 'must be a real ISO week');
  if (report.license !== 'CC0-1.0') fail('license', 'must be CC0-1.0');
  const totalsValid = shape(report.totals, ['sessions', ...COUNTS], 'totals');
  if (totalsValid) numbers(report.totals, 'totals', ['sessions', ...COUNTS]);
  if (!Array.isArray(report.sessions)) fail('sessions', 'must be an array');
  else {
    const sums = Object.fromEntries(COUNTS.map((key) => [key, 0]));
    sums.sessions = report.sessions.length;
    for (const [index, row] of report.sessions.entries()) {
      const where = `sessions[${index}]`;
      if (!shape(row, ['week', 'cli_version', 'entrypoint', 'permission_mode', 'models', 'efforts', ...COUNTS,
        'duration_minutes', 'tool_calls', 'skills', 'subagents'], where)) continue;
      if (!validWeek(row.week)) fail(`${where}.week`, 'must be a real ISO week');
      string(row.cli_version, `${where}.cli_version`, pattern(VERSION));
      string(row.entrypoint, `${where}.entrypoint`, enumeration(ENTRYPOINTS));
      array(row.permission_mode, `${where}.permission_mode`, enumeration(PERMISSIONS));
      array(row.models, `${where}.models`, pattern(MODEL));
      array(row.efforts, `${where}.efforts`, enumeration(EFFORTS));
      numbers(row, where, [...COUNTS, 'duration_minutes']);
      counting(row.tool_calls, `${where}.tool_calls`, [...TOOLS, 'other', 'mcp:other', ...lists.servers.map((s) => `mcp:${s}`)]);
      counting(row.skills, `${where}.skills`, [...lists.skills, 'other']);
      if (shape(row.subagents, ['count', ...COUNTS, 'types'], `${where}.subagents`)) {
        numbers(row.subagents, `${where}.subagents`, ['count', ...COUNTS]);
        counting(row.subagents.types, `${where}.subagents.types`, [...lists.agents, 'other']);
      }
      for (const key of COUNTS) sums[key] += row[key];
    }
    if (totalsValid) for (const [key, sum] of Object.entries(sums)) {
      if (report.totals[key] !== sum) fail(`totals.${key}`, 'does not match the session rows');
    }
  }
  try {
    const commit = git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim();
    const versions = git('log', '--full-history', '--format=%H', commit, '--', 'scripts/metrics-report.mjs').trim().split(/\s+/).filter(Boolean);
    const matches = versions.some((version) => {
      // A deletion can occur in the history; it contributes no script hash.
      const present = git('ls-tree', version, '--', 'scripts/metrics-report.mjs').trim();
      return present && hashScript(git('show', `${version}:scripts/metrics-report.mjs`)) === report.script_sha256;
    });
    if (!matches) fail('script_sha256', 'hash matches no script version in the ref history');
  } catch (error) { fail('script_sha256', error.message); }
  return errors;
}

if (isMain(import.meta.url)) {
  try {
    const [file, flag, ref, ...rest] = process.argv.slice(2);
    if (!file || (flag !== undefined && (flag !== '--ref' || !ref)) || rest.length) {
      throw new Error('Usage: node scripts/metrics-validate.mjs <report> [--ref <git ref>]');
    }
    const errors = validateReport(file, ref);
    if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
    else console.log('Report is valid in form; origin is self-reported.');
  } catch (error) { console.error(shown(error.message)); process.exitCode = 1; }
}
