// Issue #57 (ADR 0030): the oracle is enforced on the agent at the merge guard, not in CI.
//
// AC-10: no workflow of the repository, nor of the workflows it distributes to others, runs the oracle
// check. This holds before the change and is a regression guard: the CI oracle check stays an optional tool.
// AC-11: the documents that describe merging an ATDD branch say that the merge guard compares the head with
// the oracle tag and asks, and none of them says that CI checks or enforces the oracle.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('no workflow checks the oracle (#57)', () => {
  const WORKFLOW_DIRS = ['.github/workflows', 'common/github/workflows'];
  const ORACLE_CHECK = /oracle-check|oracle\.mjs|refs\/tags\/oracle/;

  test('AC-10 (#57) the workflows of the repository and the ones it distributes do not mention the oracle check', () => {
    let read = 0;
    for (const dir of WORKFLOW_DIRS) {
      for (const name of readdirSync(join(root, dir)).filter((file) => /\.ya?ml$/.test(file))) {
        read += 1;
        assert.doesNotMatch(readFileSync(join(root, dir, name), 'utf8'), ORACLE_CHECK, `${dir}/${name}`);
      }
    }
    assert.ok(read > 0, 'no workflow was read: the directories moved?');
  });
});

// A unit is a paragraph or a list item (as in guard-git-oracle-tags.test.mjs).
function units(file) {
  const out = [];
  let current = [];
  const flush = () => {
    if (current.length > 0) out.push(current.join(' '));
    current = [];
  };
  for (const line of readFileSync(join(root, file), 'utf8').split('\n')) {
    if (line.trim() === '') flush();
    else {
      if (/^\s*(?:[-*]|\d+\.)\s/.test(line)) flush();
      current.push(line.trim());
    }
  }
  flush();
  return out;
}

describe('the documents describe the oracle at the merge guard (#57)', () => {
  const files = ['global/CLAUDE.md', 'global/skills/pr-prep/SKILL.md', 'global/skills/atdd-implement/SKILL.md'];
  const GUARD = /guard-git|merge guard|merge decision|guard's merge/i;
  const COMPARES = /compar\w*|\bdiff(?:s|ed)?\b/i;
  const CI = /\bCI\b|continuous integration/;
  // A unit that names CI together with the oracle must say the check is not there, or that it is optional.
  const NOT_IN_CI = new RegExp([
    /\bnot (?:\w+ ){0,3}(?:in|by|on) (?:the )?(?:core )?(?:CI|continuous integration)\b/.source,
    /\boptional/.source,
    /\bno (?:CI|continuous integration)\b/.source,
    /\b(?:CI|continuous integration)\b[^.]{0,60}\b(?:does not|doesn't|do not|never|is not|are not|isn't)\b/.source,
  ].join('|'), 'i');

  for (const file of files) {
    test(`AC-11 (#57) ${file} says the merge guard compares the head with the oracle tag and asks`, () => {
      const about = units(file).filter((unit) => GUARD.test(unit) && /oracle/i.test(unit) && COMPARES.test(unit) && /\bask/i.test(unit));
      assert.ok(about.length > 0, `${file}: no paragraph or list item says the merge guard compares the head with the oracle tag and asks`);
    });

    test(`AC-11 (#57) ${file} never says that CI checks or enforces the oracle`, () => {
      for (const unit of units(file).filter((u) => CI.test(u) && /oracle/i.test(u))) {
        assert.match(unit, NOT_IN_CI, `${file}: a unit names CI and the oracle without saying the check is not in CI or is optional: ${unit}`);
      }
    });
  }
});
