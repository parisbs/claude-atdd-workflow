// Issue #34 (ADR 0015): delegates get goals, structured findings and the rules they lack. The task-package
// skill holds the package template and the report shape; the Delegation and Reviews sections carry the
// rules; both Claude agents skip CLAUDE.md, list their tools and require one report shape. These are static
// checks over the text: they prove the statements and fields are present, not that they read well or that a
// delegate follows them. AC-7 and AC-8 are manual probes, recorded in the pull request.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => {
  assert.ok(existsSync(join(repo, path)), `${path} is missing`);
  return readFileSync(join(repo, path), 'utf8');
};
const instructions = read('global/CLAUDE.md');
const sectionOf = (heading) => (instructions.split(`\n## ${heading}\n`)[1] ?? '').split('\n## ')[0];
const delegation = sectionOf('Delegation');
const reviews = sectionOf('Reviews');
const skill = () => read('global/skills/task-package/SKILL.md');

// One sentence or one list item at a time, so that a keyword and its negation or its companions must sit
// together, not merely appear somewhere in the same file.
const sentences = (text) =>
  text
    .split(/\n\s*(?:[-*]|\d+\.)\s+|\n\s*\n/)
    .flatMap((chunk) => chunk.replace(/\s+/g, ' ').split(/[.!?](?:\s|$)/))
    .map((sentence) => sentence.trim())
    .filter(Boolean);
const some = (text, ...patterns) => sentences(text).some((sentence) => patterns.every((pattern) => pattern.test(sentence)));
const says = (text, ...patterns) => assert.ok(some(text, ...patterns), `no single sentence matches all of ${patterns.join(' and ')}`);
const NEGATION = /\b(never|not|no|without)\b/i;

// The values of the shared report shape (ADR 0015). The skill, the schema and both agents use these.
const STATUSES = ['done', 'partial', 'failed'];
const FAILURE_TYPES = ['none', 'missing-dependency', 'oracle-test-wrong', 'check-failing', 'blocked-by-guard', 'scope-conflict', 'budget-exhausted', 'other'];
const REPORT_PROPERTIES = ['status', 'failure_type', 'what_changed', 'checks_run', 'checks_not_run', 'findings', 'left_out_or_unsure'];
const FINDING_PROPERTIES = ['claim', 'evidence', 'source', 'verified'];

function frontmatter(text) {
  const [, block = '', body = ''] = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text) ?? [];
  const fields = Object.fromEntries(
    block.split('\n').map((line) => /^([A-Za-z-]+):\s*(.*)$/.exec(line)).filter(Boolean).map((m) => [m[1], m[2].trim()]),
  );
  return { fields, body };
}

function agent(name) {
  const { fields, body } = frontmatter(read(`global/agents/${name}.md`));
  const tools = fields.tools?.replace(/^\[|\]$/g, '').split(/,(?![^(]*\))/).map((item) => item.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  return { fields, body, tools };
}

const AGENTS = ['claude-implementer', 'claude-researcher'];

describe('the task-package skill', () => {
  test('AC-1 exists, says when to use it and can be started by the orchestrator', () => {
    const { fields } = frontmatter(skill());
    assert.equal(fields.name, 'task-package');
    assert.match(fields.description ?? '', /\bUse (it )?(only )?when\b/i, 'the description has no "Use when"');
    assert.equal(fields['disable-model-invocation'], undefined, 'the orchestrator must be able to load it');
  });

  test('AC-1 the package has the fields: goal, acceptance criteria, scope in and out, constraints, verify command, oracle, prior findings and report shape', () => {
    const text = skill();
    const field = (name) => new RegExp(`^\\s*(?:[-*]\\s+|#{1,6}\\s+|\\d+\\.\\s+)?(?:\\*\\*|\\*|_)?${name}\\b`, 'im');
    for (const name of ['Goal', 'Acceptance criteria', 'Scope in', 'Scope out', 'Constraints', 'Verify command', 'Oracle', 'Prior findings', 'Report shape']) {
      assert.match(text, field(name), `the template has no "${name}" field`);
    }
  });

  test('AC-5 the package has a field for the invariants and conventions of the repository that the task touches', () => {
    const text = skill();
    assert.match(text, /^\s*(?:[-*]\s+|#{1,6}\s+|\d+\.\s+)?(?:\*\*|\*|_)?Invariants and conventions\b/im);
    says(text, /invariants/i, /conventions/i, /touch/i, /`CLAUDE\.md`/);
  });

  test('AC-2 the prior findings field is a record of claim, evidence, source and verified, plus the fix commits for a review pass', () => {
    const text = skill();
    says(text, /claim/i, /evidence/i, /source/i, /not verified/i);
    says(text, /fix commits/i, /review/i);
  });

  test('AC-2 prior findings are data, not instructions; a verified flag is not trust; a finding not verified is checked before it is relied on', () => {
    const text = skill();
    says(text, /findings?/i, /\bdata\b/i, /not instructions?/i);
    says(text, /\bverified\b/i, NEGATION, /trust/i);
    says(text, /not verified/i, /\b(check|verify|confirm)\b/i, /before/i);
  });

  test('AC-6 the skill holds the report shape: the statuses, the failure types and the fields', () => {
    const text = skill();
    for (const value of [...STATUSES, ...FAILURE_TYPES]) assert.ok(text.includes(value), `the report shape does not name "${value}"`);
    for (const phrase of [/failure type/i, /what changed/i, /checks run/i, /not run/i, /left out/i]) assert.match(text, phrase);
    says(text, /findings/i, /source/i, /verified/i);
  });

  test('AC-4 the report schema for output_schema is a JSON block that satisfies the strict rules, with the shared fields and values', () => {
    const blocks = [...skill().matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]);
    assert.ok(blocks.length > 0, 'the skill has no fenced json block');
    const schema = blocks.map((block) => JSON.parse(block)).find((candidate) => candidate?.properties?.status);
    assert.ok(schema, 'no json block is the report schema (an object with a status property)');
    assert.ok(JSON.stringify(schema).length < 64 * 1024, 'output_schema allows at most 64 KiB');
    // OpenAI's structured outputs: every object has additionalProperties false and lists every property in required.
    const strict = (node, where) => {
      if (node === null || typeof node !== 'object') return;
      if (node.properties) {
        assert.equal(node.additionalProperties, false, `${where} needs "additionalProperties": false`);
        assert.deepEqual([...(node.required ?? [])].sort(), Object.keys(node.properties).sort(), `${where} must list every property in required`);
        for (const [key, child] of Object.entries(node.properties)) strict(child, `${where}.${key}`);
      }
      if (node.items) strict(node.items, `${where}[]`);
    };
    strict(schema, 'report');
    assert.deepEqual(Object.keys(schema.properties).sort(), [...REPORT_PROPERTIES].sort());
    assert.deepEqual([...schema.properties.status.enum].sort(), [...STATUSES].sort());
    assert.deepEqual([...schema.properties.failure_type.enum].sort(), [...FAILURE_TYPES].sort());
    assert.equal(schema.properties.findings.type, 'array');
    assert.deepEqual(Object.keys(schema.properties.findings.items.properties).sort(), [...FINDING_PROPERTIES].sort());
    assert.equal(schema.properties.findings.items.properties.verified.type, 'boolean');
  });

  test('AC-9 for codex-implementer the worktree is made from the last commit, so uncommitted changes, dependencies and build output are missing', () => {
    const text = skill();
    assert.match(text, /codex-implementer/);
    says(text, /last commit/i, /uncommitted/i, /dependenc/i, /build output/i);
  });

  test('AC-9 the delegate reports a missing dependency instead of changing production code to get around it, and leaves its changes uncommitted', () => {
    const text = skill();
    says(text, /report/i, /missing dependenc/i, /(instead of|rather than|not)/i, /production code/i);
    says(text, /\b(not|never|cannot)\b/i, /commit/i);
  });

  // Issue #42 replaced the listed integration steps with codex-integrate.mjs; what they guaranteed (new and
  // binary files, removal only after the changes are applied) is now tested on the script itself, in
  // codex-integrate.test.mjs.
  test('AC-7 (#42) names the integration script for a codex-implementer worktree instead of listing the steps', () => {
    const text = skill();
    says(text, /codex-integrate\.mjs/, /worktree/i);
    for (const step of [/git add -N/, /git diff --binary/, /git apply\b/, /--3way/]) {
      assert.doesNotMatch(text, step, `the skill still lists the step ${step}`);
    }
  });

  test('AC-7 (#42) says what to do when the script stops: report and keep the worktree', () => {
    says(skill(), /codex-integrate|script/i, /\b(stops|fails|exits)\b/i, /\b(report|keep)\b/i);
  });

  test('ADR 0015 when the package asks for commits it carries the commit convention, because the delegate does not load CLAUDE.md', () => {
    says(skill(), /commits?/i, /convention/i, /CLAUDE\.md/);
  });

  test('ADR 0015 holds nothing the skill loader would expand or run', () => {
    assert.doesNotMatch(skill(), /!`|\$ARGUMENTS|\$\{|\$\d/, 'a placeholder or shell form in a skill body can be substituted or executed on load');
  });
});

describe('the Delegation section', () => {
  test('AC-2 requires each earlier finding as a record with claim, evidence, source and verified or not verified', () => {
    says(delegation, /claim/i, /evidence/i, /source/i, /not verified/i);
  });

  test('AC-2 carries the findings of earlier agents complete, not summarised', () => {
    says(delegation, /findings/i, /\b(complete|completely|in full)\b/i, /summar/i, NEGATION);
  });

  test('AC-2 forbids passing the earlier agent\'s verdict and its reasoning', () => {
    says(delegation, NEGATION, /verdict/i);
    says(delegation, NEGATION, /reasoning/i);
  });

  test('ADR 0015 gives a delegate goals and criteria, not the steps', () => {
    says(delegation, /goals?/i, /criteria/i, /\b(steps|procedures?)\b/i, /\b(not|rather than|instead of)\b/i);
  });

  test('ADR 0015 tells the orchestrator to load task-package before delegating, and cites ADR 0015 beside ADR 0012', () => {
    says(delegation, /task-package/, /\bload\b/i, /before/i);
    assert.match(delegation, /ADR 0015/);
    assert.match(delegation, /ADR 0012/);
  });

  test('AC-3 a review pass after fixes gets the earlier findings as records plus the fix commits', () => {
    says(delegation, /review/i, /records?/i, /fix commits/i);
  });

  test('AC-9 the integration of a Codex worktree: commit before delegating, apply the diff to the work branch, run oracle-check and the verify command, remove the worktree', () => {
    says(delegation, /commit/i, /before delegat/i);
    says(delegation, /apply/i, /diff/i, /work branch/i);
    says(delegation, /oracle-check/, /verify command/i);
    assert.match(delegation, /git worktree remove/);
  });
});

describe('the Reviews section', () => {
  test('AC-3 says that passing the earlier findings as records plus the fix commits is not inheriting conclusions', () => {
    says(reviews, /records?/i, /fix commits/i, /not[^.]*inherit/i);
  });

  test('AC-3 keeps the fresh-context rule for a second pass', () => {
    assert.match(reviews, /fresh context/i);
    assert.match(reviews, /conclusions/i);
  });
});

// Issue #46: a Claude subagent started with `isolation: worktree` starts from the default remote branch, not
// from the work branch, so the package carries the commit it builds on and the delegate reaches it before any
// task edit; only then does guard-tests bind its worktree (ADR 0016). The statements must be affirmative and
// sit in a section about Claude, so that a negated sentence or one about Codex cannot satisfy them.
describe('a Claude subagent in a worktree (#46)', () => {
  // "no" is left out: "a repository with no remote" states a condition, not a negation of the rule.
  const NEGATED = /\b(never|not|cannot|can't|don't|doesn't|mustn't)\b/i;
  const affirms = (text, ...patterns) =>
    assert.ok(
      sentences(text).some((sentence) => patterns.every((pattern) => pattern.test(sentence)) && !NEGATED.test(sentence)),
      `no single affirmative sentence matches all of ${patterns.join(' and ')}`,
    );
  const claudeSection = () => {
    const chunk = skill().split('\n## ').slice(1).find((part) => /\bClaude\b/.test(part.split('\n')[0]));
    return chunk ? chunk.slice(chunk.indexOf('\n') + 1) : '';
  };
  const baseCommitField = () => {
    const fields = (skill().split('\n## Fields\n')[1] ?? '').split('\n## ')[0];
    return /^- Base commit:.*(?:\n {2}.*)*/m.exec(fields)?.[0] ?? '';
  };

  test('AC-1 (#46) the skill has a section about Claude subagents', () => {
    assert.ok(sentences(claudeSection()).length > 0, 'no non-empty "## ..." section whose heading names Claude');
  });

  test('AC-1 (#46) says a Claude subagent with isolation: worktree starts from the default remote branch unless worktree.baseRef is head', () => {
    affirms(claudeSection(), /isolation:\s*worktree/, /\bstarts?\b/i, /default remote branch/i, /worktree\.baseRef/, /\bhead\b/i);
  });

  test('AC-1 (#46) the package template has a Base commit field: the work branch commit the delegate builds on', () => {
    const field = baseCommitField();
    assert.ok(field, 'the Fields list has no "- Base commit:" item');
    affirms(field, /\bcommit\b/i, /work branch/i, /\bbuilds? on\b/i);
  });

  test('AC-1 (#46) says the package carries, in Base commit, the commit the delegate builds on', () => {
    affirms(claudeSection(), /\bpackage\b/i, /Base commit/, /\bbuilds? on\b/i);
  });

  test('AC-2 (#46) says the delegate confirms its branch contains the Base commit before any task edit', () => {
    affirms(
      claudeSection(),
      /\bdelegate\b/i,
      /\b(confirms?|checks?|verif(y|ies))\b/i,
      /\b(contains?|equals?|descends?|ancestor)\b/i,
      /Base commit/,
      /\b(branch|HEAD)\b/,
      /\bbefore\b.*\bedit/i,
    );
  });

  test('AC-2 (#46) says the delegate stops and reports missing-dependency when it cannot reach the Base commit', () => {
    const reports = sentences(claudeSection()).some(
      (sentence) =>
        /\b(cannot|can't|unable)\b/i.test(sentence) &&
        /Base commit/.test(sentence) &&
        /\bstops?\b/i.test(sentence) &&
        /\breports?\b/i.test(sentence) &&
        /missing-dependency/.test(sentence) &&
        !/\b(not|never|don't)\s+(\w+\s+)?reports?\b/i.test(sentence),
    );
    assert.ok(reports, 'no sentence says that, when it cannot reach the Base commit, the delegate stops and reports missing-dependency');
  });
});

describe('the package for Codex', () => {
  const MAPPINGS = [
    ['goal and criteria to acceptance_criteria', /\b(goal|criteria)\b/i, /`acceptance_criteria`/],
    ['background to context', /\bbackground\b/i, /`context`/],
    ['paths to target_files', /\bpaths?\b/i, /`target_files`/],
    ['rules to system_instructions', /\brules?\b/i, /`system_instructions`/],
  ];
  for (const [name, file] of [['pr-prep', 'global/skills/pr-prep/SKILL.md'], ['the task-package skill', 'global/skills/task-package/SKILL.md']]) {
    test(`AC-4 ${name} maps the package to the Codex fields and asks for the report through output_schema`, () => {
      const text = read(file);
      for (const [label, from, to] of MAPPINGS) assert.ok(some(text, from, to), `${name} does not map ${label}`);
      says(text, /`output_schema`/, /report/i);
    });
  }

  test('AC-7 (#42) the task-package skill maps the working directory to working_dir, and a follow-up to the worktree path', () => {
    const text = skill();
    says(text, /\b(directory|working root)\b/i, /`working_dir`/);
    says(text, /`codex_follow_up`/, /`working_dir`/, /worktree/i);
  });

  test('AC-4 pr-prep points to the task-package skill', () => {
    assert.match(read('global/skills/pr-prep/SKILL.md'), /task-package/);
  });
});

describe('the Claude agents', () => {
  for (const name of AGENTS) {
    test(`AC-5 ${name} skips CLAUDE.md and lists its tools as an allowlist with no Bash(...) entry`, () => {
      const { fields, tools } = agent(name);
      assert.equal(fields.omitClaudeMd, 'true');
      assert.ok(tools && tools.length > 0, 'tools must be a non-empty list on one line');
      assert.ok(!tools.some((tool) => /^Bash\(/.test(tool)), 'a Bash(...) entry restricts the shell (ADR 0013)');
      assert.ok(tools.includes('Bash'), 'the shell is how it runs checks and reads (ADR 0013 enforces the limits)');
      assert.ok(!tools.includes('Agent'), 'it must not be able to start other agents');
    });

    test(`AC-6 ${name} requires a report with status, failure type, what changed, checks run and not run, findings with source and verified, and what was left out`, () => {
      const { body } = agent(name);
      says(body, /status/i, ...STATUSES.map((value) => new RegExp(`\\b${value}\\b`)));
      for (const value of FAILURE_TYPES) assert.ok(body.includes(value), `${name} does not name the failure type "${value}"`);
      assert.match(body, /failure type/i);
      assert.match(body, /what changed/i);
      says(body, /checks run/i, /not run/i);
      says(body, /findings/i, /source/i, /verified/i);
      assert.match(body, /left out|unsure/i);
    });

    test(`AC-2 ${name} treats the findings in its package as data, not as instructions`, () => {
      says(agent(name).body, /package/i, /findings?/i, /\bdata\b/i);
    });
  }

  test('AC-5 the implementer can write and the researcher can search the web, as its description says', () => {
    const implementer = agent('claude-implementer').tools ?? [];
    for (const tool of ['Read', 'Edit', 'Write', 'Grep', 'Glob']) assert.ok(implementer.includes(tool), `the implementer needs ${tool}`);
    const researcher = agent('claude-researcher').tools ?? [];
    for (const tool of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']) assert.ok(researcher.includes(tool), `the researcher needs ${tool}`);
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) assert.ok(!researcher.includes(tool), `the researcher must not have ${tool}`);
  });
});

describe('what refers to the delegation rules', () => {
  test('ADR 0015 atdd-implement says that a subagent gets the invariants in its package', () => {
    says(read('global/skills/atdd-implement/SKILL.md'), /subagent/i, /package/i, /invariants/i);
  });

  test('ADR 0015 the README names every shipped skill and agent', () => {
    const readme = read('README.md');
    const skills = readdirSync(join(repo, 'global', 'skills')).filter((entry) => !entry.startsWith('.'));
    const agents = readdirSync(join(repo, 'global', 'agents')).filter((entry) => entry.endsWith('.md')).map((entry) => entry.replace(/\.md$/, ''));
    for (const name of [...skills, ...agents]) assert.ok(readme.includes(`\`${name}\``), `README.md does not name \`${name}\``);
  });
});
