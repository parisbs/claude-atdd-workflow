#!/usr/bin/env node
// Issue #19: run from the base checkout. The head supplies data blobs only, never executable code.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, MAX_BYTES, validateReport, validWeek } from './metrics-validate.mjs';

const donated = 'docs/experiments/donated/';
// Paths come from the fork. Escaping control characters keeps a name from starting a line, which the Actions
// runner would read as a workflow command (::error:: and the like).
const shown = (path) => JSON.stringify(path).slice(1, -1);
// A box ticked inside an HTML comment is not shown to the reader, so it is not consent.
const visible = (text) => text.replace(/<!--[\s\S]*?(-->|$)/g, '');

function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--base', '--head', '--event'].includes(key) || !args[index + 1] || options[key]) throw new Error('Expected --base <ref> --head <ref> --event <file>');
    options[key] = args[index + 1];
  }
  if (Object.keys(options).length !== 3) throw new Error('Expected --base <ref> --head <ref> --event <file>');
  const commit = (ref) => git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim();
  const base = commit(options['--base']);
  const head = commit(options['--head']);
  const mergeBase = git('merge-base', base, head).trim();
  const fields = git('diff', '--name-status', '-z', '--find-renames', mergeBase, head, '--').split('\0');
  const changes = [];
  for (let index = 0; index < fields.length && fields[index];) {
    const status = fields[index++];
    const paths = [fields[index++]];
    if (/^[RC]/.test(status)) paths.push(fields[index++]);
    changes.push({ status, paths });
  }
  if (!changes.some((change) => change.paths.some((path) => path.startsWith(donated)))) {
    console.log('No donations changed; nothing to validate.');
    return;
  }
  const errors = [];
  const additions = [];
  for (const { status, paths } of changes) {
    for (const path of paths) if (!path.startsWith(donated)) errors.push(`${shown(path)}: changes outside the donated folder are not allowed`);
    if (status !== 'A') errors.push(`${paths.map(shown).join(' -> ')}: existing files must not be modified, deleted or renamed`);
    else if (paths[0].startsWith(donated)) additions.push(paths[0]);
  }
  if (changes.length !== 1 || additions.length !== 1) errors.push('A donation must add exactly one file and change nothing else');
  const template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../.github/PULL_REQUEST_TEMPLATE/metrics-donation.md'), 'utf8');
  const consent = template.split(/\r?\n/).find((line) => /^\s*[-*] \[ \] .*CC0 1\.0/.test(line));
  try {
    const body = JSON.parse(readFileSync(options['--event'], 'utf8')).pull_request?.body;
    const checked = typeof body === 'string' && visible(body).split(/\r?\n/).some((line) =>
      /^\s*[-*] \[[xX]\] /.test(line) && line.replace(/\[[xX]\]/, '[ ]').trim() === consent?.trim());
    if (!checked) errors.push(`The CC0 1.0 licence checkbox from the donation template must be ticked: ${consent?.trim().replace('[ ]', '[x]')}`);
  } catch { errors.push('Cannot read the pull request event and CC0 1.0 licence checkbox'); }
  const scratch = mkdtempSync(join(tmpdir(), 'metrics-donation-'));
  try {
    for (const path of additions) {
      const name = /^(\d{4}-W\d{2})-[0-9a-f]{8}\.json$/.exec(path.slice(donated.length));
      if (!name || !validWeek(name[1])) errors.push(`${shown(path)}: report must be named YYYY-Www-<8 hex digits>.json directly in the donated folder`);
      try {
        const entry = git('ls-tree', '-z', head, '--', path);
        if (!/^100644 blob /.test(entry)) errors.push(`${shown(path)}: report must be a regular non-executable file`);
        if (Number(git('cat-file', '-s', `${head}:${path}`).trim()) > MAX_BYTES) {
          errors.push(`${shown(path)}: report exceeds 2 MiB`);
          continue;
        }
        const file = join(scratch, 'report.json');
        writeFileSync(file, git('show', `${head}:${path}`));
        errors.push(...validateReport(file, base).map((error) => `${shown(path)}: ${error}`));
      } catch (error) { errors.push(`${shown(path)}: ${error.message.replace(/[\r\n]+/g, ' ')}`); }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('Donation is valid in form and requires human review and merge.');
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
