#!/usr/bin/env node
// ADR 0035: compare the whole working tree with the branch's merge base.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './lib.mjs';
import { proposedAdrChange, proposedAdrMessage } from './proposed-adr.mjs';

try {
  if (process.argv.length > 3) throw new Error('usage: node proposed-adr-check.mjs [base]');
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  if (!root) throw new Error('not inside a git repository');
  const read = (args) => {
    const result = git(root, args);
    if (result === undefined) throw new Error(`could not read git ${args.join(' ')}`);
    return result;
  };
  const base = read(['merge-base', process.argv[2] ?? 'main', 'HEAD']);
  const paths = read(['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', base, '--']).split('\0')
    .concat(read(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')).filter(Boolean);
  const change = proposedAdrChange(paths, (path) => {
    try {
      return readFileSync(join(root, path), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error(`could not read ADR record ${path}: ${error.message}`);
    }
  });
  if (change.mixed) {
    console.error(proposedAdrMessage(change, { branch: true }));
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`proposed-adr-check: ${error.message}`);
  process.exitCode = 2;
}
