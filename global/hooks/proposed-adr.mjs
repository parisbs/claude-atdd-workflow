// ADR 0035: shared by the merge guard and the local pre-PR check.
import { posix } from 'node:path';

const adrDirectory = /(^|\/)docs\/(adr|adrs|decisions)\//;
const recordName = /^\d{4}-[^/]+\.md$/;

function isProposed(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return false;
  const end = lines.indexOf('---', 1);
  if (end < 0) return false;
  const statuses = lines.slice(1, end).filter((line) => /^status:(?:[ \t]|$)/.test(line));
  if (statuses.length !== 1) return false;
  let value = statuses[0].slice('status:'.length).replace(/^[ \t]+|[ \t]+$/g, '');
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\(["\\])/g, '$1');
  else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/''/g, "'");
  return /^proposed(?=$|[\s,;:.([])/i.test(value);
}

// readRecord returns the head/working-tree contents, or null for a deleted record.
export function proposedAdrChange(paths, readRecord) {
  const changed = [...new Set(paths)];
  const proposed = changed.filter((path) => {
    if (!adrDirectory.test(path) || !recordName.test(posix.basename(path))) return false;
    const text = readRecord(path);
    return text !== null && isProposed(text);
  });
  const other = changed.filter((path) => !adrDirectory.test(path));
  return { proposed, other, mixed: proposed.length > 0 && other.length > 0 };
}

export function proposedAdrMessage(change, { branch = false, experiment = false } = {}) {
  const evidence = `Proposed ADR records: ${change.proposed.join(', ')}. Paths outside the ADR directories: ${change.other.join(', ')}.`;
  return experiment
    ? `${evidence} This pull request is a declared experiment (label experiment, ADR 0035).`
    : `${evidence} Accept the record in this ${branch ? 'branch' : 'pull request'}, or move it to its own pull request and merge that one first (ADR 0035).`;
}
