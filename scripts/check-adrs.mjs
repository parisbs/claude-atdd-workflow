#!/usr/bin/env node
// Issue #28 (ADR 0018, 0019): compares the ADRs of HEAD with a base reference and fails when a frozen record
// changed, a status moved the wrong way, a record was deleted or renamed, the numbering broke or the index
// does not match the records. Usage, from inside the repository: node scripts/check-adrs.mjs <base-ref>
// Exit 0 when clean; otherwise non-zero, with one line per problem on stderr, starting with the file
// (file:line when a line is known). Both refs are committed trees, compared directly, not through a merge
// base. A local run against a branch behind main should pass the merge base as <base-ref>.
import { spawnSync } from 'node:child_process';

const directories = ['docs/adr', 'docs/adrs', 'docs/decisions'];
const recordName = /^\d{4}-[^/]+\.md$/;
const decided = new Set(['accepted', 'rejected', 'superseded']);

function problem(file, message) {
  console.error(`${file}: ${message}`);
  process.exitCode = 1;
}

function git(file, ...args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`${file}: cannot read git data (${result.error?.message ?? result.stderr.trim().replace(/\s*\n\s*/g, '; ')})`);
  }
  return result.stdout;
}

function tree(ref) {
  return git(ref, 'rev-parse', '--verify', '--end-of-options', `${ref}^{tree}`).trim();
}

function paths(ref) {
  return new Set(git(ref, 'ls-tree', '-r', '-z', '--name-only', ref, '--', ...directories).split('\0').filter(Boolean));
}

function record(text) {
  const lines = text.split('\n');
  const statusIndex = lines.findIndex((line) => /^- Status:/.test(line));
  const status = statusIndex < 0 ? '(missing)' : lines[statusIndex].slice('- Status:'.length).trim();
  // A word glued to more text, such as proposed-x, is no status word: it reads as unrecognised, so frozen.
  const word = /^([a-z]+)(?=$|[\s,;:.([])/i.exec(status)?.[1].toLowerCase();
  return {
    status,
    statusLine: statusIndex < 0 ? null : statusIndex + 1,
    word,
    body: lines.map((text, index) => ({ text, line: index + 1 })).filter((_, index) => index !== statusIndex),
  };
}

function checkRecord(file, before, after) {
  if (before === after) return;
  const base = record(before);
  if (base.word === 'proposed') return;
  const head = record(after);
  const changed = head.body.findIndex((line, index) => line.text !== base.body[index]?.text);
  if (changed !== -1 || head.body.length !== base.body.length) {
    const line = head.body[changed]?.line ?? head.body.at(-1)?.line ?? 1;
    problem(`${file}:${line}`, 'record is frozen on the base; only its status line may change');
  }
  const allowed = decided.has(base.word)
    ? head.word === base.word || head.word === 'superseded'
    : decided.has(head.word);
  if (!allowed) problem(head.statusLine ? `${file}:${head.statusLine}` : file, `invalid status transition from "${base.status}" to "${head.status}"`);
}

const pad = (number) => String(number).padStart(4, '0');

function checkNumbers(directory, baseRecords, headRecords) {
  const next = Math.max(0, ...baseRecords.map((file) => Number(file.slice(0, 4)))) + 1;
  const added = new Set();
  let expected = next;
  for (const file of headRecords.filter((file) => !baseRecords.includes(file)).sort()) {
    const number = Number(file.slice(0, 4));
    if (number < next) {
      problem(`${directory}/${file}`, `record number ${pad(number)} is already used on the base`);
    } else if (added.has(number)) {
      problem(`${directory}/${file}`, `record number ${pad(number)} is added twice`);
    } else {
      if (number !== expected) problem(`${directory}/${file}`, `record number ${pad(number)} must continue the base numbering at ${pad(expected)}`);
      added.add(number);
      expected = number + 1;
    }
  }
  // Name every number the added records skip, not only the first record out of sequence.
  for (let number = next; number < Math.max(next, ...added); number++) {
    if (!added.has(number)) problem(directory, `record number ${pad(number)} is missing from the added records`);
  }
}

function checkIndex(directory, records, text) {
  const indexed = new Set();
  for (const [index, line] of text.split('\n').entries()) {
    for (const match of line.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
      const file = match[1].replace(/^\.\//, '').split('#')[0];
      if (!records.includes(file)) {
        problem(`${directory}/README.md:${index + 1}`, `index links a file that is not a record: ${file}`);
      } else if (indexed.has(file)) {
        problem(`${directory}/README.md:${index + 1}`, `index lists ${file} more than once`);
      }
      indexed.add(file);
    }
  }
  for (const file of records) {
    if (!indexed.has(file)) problem(`${directory}/${file}`, `record is missing from ${directory}/README.md`);
  }
}

try {
  const baseRef = process.argv[2];
  if (!baseRef || process.argv.length !== 3) throw new Error('scripts/check-adrs.mjs: usage: node scripts/check-adrs.mjs <base-ref>');
  // The ADR directories are pathspecs, which git reads from the current directory: from a subdirectory
  // they would match nothing and every check would pass.
  process.chdir(git('scripts/check-adrs.mjs', 'rev-parse', '--show-toplevel').trim());
  const base = tree(baseRef);
  const head = tree('HEAD');
  const basePaths = paths(base);
  const headPaths = paths(head);
  for (const directory of directories) {
    const records = (files) => [...files].filter((file) => file.startsWith(`${directory}/`) && recordName.test(file.slice(directory.length + 1)))
      .map((file) => file.slice(directory.length + 1));
    const baseRecords = records(basePaths);
    const headRecords = records(headPaths);
    for (const name of baseRecords) {
      const file = `${directory}/${name}`;
      if (!headPaths.has(file)) {
        problem(file, 'records on the base must not be deleted or renamed (if the base gained this record after the pull request\'s merge commit was made, update the branch)');
      } else {
        checkRecord(file, git(file, 'show', `${base}:${file}`), git(file, 'show', `${head}:${file}`));
      }
    }
    checkNumbers(directory, baseRecords, headRecords);
    const index = `${directory}/README.md`;
    if (headRecords.length || headPaths.has(index) || baseRecords.length) {
      checkIndex(directory, headRecords, git(index, 'show', `${head}:${index}`));
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
