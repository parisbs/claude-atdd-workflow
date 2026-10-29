// Issue #64: the documents describe amending a frozen test as guard-tests now treats it. The main session
// asks and the human approves in the prompt; the amendment goes in its own commit; the oracle tag must then
// be moved, which asks (ADR 0029); until it moves the merge guard (ADR 0030) finds test paths changed against
// the tag, so the agent's merge does not go through without the human. None of the documents says the guard
// on frozen tests denies the main session, and each says subagents and bypassPermissions are denied. The
// matchers look for key terms within one paragraph or list item, as the documentation test of #55 does in
// guard-git-oracle-tags.test.mjs, so the wording stays free.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// A unit is a paragraph or a list item.
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

// A unit about the guard on frozen tests or about amending one.
const FROZEN = /frozen (?:acceptance )?(?:tests?|test paths?)\b|\bamend\w*/i;
const about = (file) => units(file).filter((unit) => FROZEN.test(unit));
const DENIES = /\bden(?:y|ies|ied|ial)\b/i;
// The ask is stated about frozen tests themselves, not borrowed from a clause about the oracle tag: between
// "frozen test" and "ask" there is no mention of an oracle tag, and no sentence ends.
const FROZEN_ASKS = /(?:frozen (?:acceptance )?tests?|\bamend\w*)(?:(?!oracle tag|oracle\/)[^.])*?\bask|\bask\w*(?:(?!oracle tag|oracle\/)[^.])*?(?:frozen (?:acceptance )?tests?|\bamend\w*)/i;

const some = (list, predicate, message) => assert.ok(list.some(predicate), message);

describe('the documents describe amending a frozen test (#64)', () => {
  for (const file of ['global/skills/atdd-implement/SKILL.md', 'global/skills/pr-prep/SKILL.md']) {
    test(`AC-12 ${file} says the main session asks and the human approves the amendment in the prompt`, () => {
      some(
        about(file),
        (unit) => /main session/i.test(unit) && FROZEN_ASKS.test(unit) && /\bapprov\w*/i.test(unit) && /\bprompt/i.test(unit),
        `${file}: no paragraph about amending a frozen test says the main session asks and the human approves in the prompt`,
      );
    });

    test(`AC-12 ${file} says the amendment goes in its own commit`, () => {
      some(
        about(file),
        (unit) => /\bamend\w*/i.test(unit) && /\bown commit\b/i.test(unit),
        `${file}: no paragraph about amending a frozen test says it goes in its own commit`,
      );
    });

    test(`AC-12 ${file} says the oracle tag must then be moved, which asks (ADR 0029)`, () => {
      some(
        units(file),
        (unit) => /oracle tag|oracle\/</i.test(unit) && /\bmov(?:e|es|ed|ing)\b/i.test(unit) && /\bask/i.test(unit) && /\b0029\b/.test(unit),
        `${file}: no paragraph says moving the oracle tag asks, citing ADR 0029`,
      );
    });

    test(`AC-12 ${file} says that until the tag moves the merge guard (ADR 0030) finds test paths changed and the merge needs the human`, () => {
      some(
        units(file),
        (unit) => /merge guard/i.test(unit)
          && /\b0030\b/.test(unit)
          && /test paths?\b[^.]*\bchanged|\bchanged\b[^.]*test paths?\b/i.test(unit)
          && /\b(?:until|before|unless)\b/i.test(unit)
          && /\bhuman\b/i.test(unit),
        `${file}: no paragraph says that until the tag moves the merge guard of ADR 0030 finds test paths changed and the merge waits for the human`,
      );
    });
  }

  for (const file of ['global/CLAUDE.md', 'global/skills/atdd-implement/SKILL.md', 'global/skills/pr-prep/SKILL.md']) {
    test(`AC-13 ${file} has no paragraph about frozen tests that says the guard denies the main session`, () => {
      // A denial may still be described for a subagent or for bypassPermissions, never for the main session.
      for (const unit of about(file).filter((u) => !/subagent|bypassPermissions/i.test(u))) {
        assert.doesNotMatch(unit, DENIES, `${file}: ${unit}`);
      }
    });

    test(`AC-13 ${file} says the guard on frozen tests asks, and names subagents and bypassPermissions as denied`, () => {
      some(
        about(file),
        (unit) => FROZEN_ASKS.test(unit) && /subagent/i.test(unit) && /bypassPermissions/.test(unit) && DENIES.test(unit),
        `${file}: no paragraph about frozen tests says the guard asks and names subagents and bypassPermissions as denied`,
      );
    });
  }
});
