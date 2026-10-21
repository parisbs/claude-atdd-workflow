// Issue #19 (ADR 0023): the wiring around the metrics scripts, read from this repository: the CI jobs, the
// donation workflow, the README section, the pull request template and the human merge of donations. These
// are static checks; the manual run of a donation from a fork, recorded in the pull request, is the check of
// the workflow's behaviour. Issue #25 kept the metrics job on Windows only, so that CI runs each test file
// once per system and Node version; on Ubuntu and macOS the metrics tests then run only through `npm test`.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { controlPlaneFiles, humanMergeMatchers } from '../global/hooks/controlplane.mjs';
import { repo } from './metrics-fixtures.mjs';

const read = (path) => {
  assert.ok(existsSync(join(repo, path)), `${path} does not exist`);
  return readFileSync(join(repo, path), 'utf8');
};

// YAML without comment lines or trailing comments, so that a comment never satisfies a check.
const yaml = (path) => read(path).split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).map((line) => line.replace(/\s+#.*$/, '')).join('\n');

// The lines of a job in a workflow, from its key under `jobs:` up to the next job.
function job(workflow, name) {
  const start = new RegExp(`^ {2}${name}:\\s*$`, 'm').exec(workflow);
  assert.ok(start, `a ${name} job`);
  const rest = workflow.slice(start.index + start[0].length);
  const next = /^ {2}\S/m.exec(rest);
  return rest.slice(0, next ? next.index : undefined);
}

// The sorted items of a flow sequence such as `os: [ubuntu-latest, macos-latest]`.
const items = (block, key) => new RegExp(`^\\s*${key}:\\s*\\[([^\\]]*)\\]`, 'm').exec(block)?.[1].split(',').map((item) => item.trim()).sort();

// A glob as the npm scripts pass it to node --test, as a regular expression: `**/` spans any number of
// directories and `*` stays within one.
const globToRegExp = (glob) => new RegExp(`^${glob.split('**/').map((part) => part.split('*').map((text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('(?:[^/]+/)*')}$`);

// The text of the README section whose heading names donating metrics, up to the next heading of its level.
function readmeSection() {
  const text = read('README.md');
  const heading = /^(#{2,3}) .*donat.*$/im.exec(text);
  assert.ok(heading, 'README has no section on donating metrics');
  const rest = text.slice(heading.index + heading[0].length);
  const next = new RegExp(`^#{2,${heading[1].length}} `, 'm').exec(rest);
  return rest.slice(0, next ? next.index : undefined);
}

describe('metrics wiring (#19)', () => {
  test('AC-8 CI runs the metrics tests on Windows and keeps the full suite on Ubuntu and macOS', () => {
    const ci = yaml('.github/workflows/ci.yml');
    assert.match(ci, /os:\s*\[[^\]]*\bwindows-latest\b[^\]]*\]/, 'a matrix with windows-latest');
    assert.match(ci, /run:\s*node --test [^\n]*tests\/metrics-/);
    assert.match(ci, /os:\s*\[\s*ubuntu-latest,\s*macos-latest\s*\]/);
    assert.match(ci, /run:\s*npm test/);
  });

  test('AC-11 a donation workflow runs the check from the base checkout on every pull request event', () => {
    const wf = yaml('.github/workflows/metrics-donation.yml');
    const types = /^on:\s*\n\s+pull_request:\s*\n\s+types:\s*\[([^\]]*)\]/m.exec(wf);
    assert.ok(types, 'on: pull_request: types: [...]');
    for (const type of ['opened', 'edited', 'synchronize', 'reopened']) assert.match(types[1], new RegExp(`\\b${type}\\b`), type);
    assert.doesNotMatch(wf, /pull_request_target/, 'pull_request_target would give a fork write access and secrets');
    assert.equal(wf.match(/uses:\s*actions\/checkout@/g)?.length, 1, 'one checkout, of the base');
    assert.match(wf, /ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}/, 'checks out the base, not the head');
    assert.doesNotMatch(wf, /^\s*if:/m, 'no condition can skip the check');
    assert.match(wf, /run:[^\n]*\bnode scripts\/metrics-donation-check\.mjs\b[^\n]*--event\s+"?\$GITHUB_EVENT_PATH"?/);
    assert.doesNotMatch(wf, /github\.event\.pull_request\.body/, 'the body is never interpolated into the workflow');
    assert.match(wf, /permissions:\s*\n\s+contents:\s*read/);
    assert.match(wf, /persist-credentials:\s*false/);
  });

  test('AC-12 the README explains what is collected, how to run it, the licence and the limits', () => {
    const section = readmeSection();
    assert.match(section, /```[^\n]*\n[^`]*node scripts\/metrics-report\.mjs[^`]*```/, 'the command in a code block');
    for (const system of ['Windows', 'macOS', 'Linux']) assert.match(section, new RegExp(system));
    assert.match(section, /\]\([^)]*metrics-donation[^)]*\)/, 'a link to the metrics-donation template');
    assert.match(section, /CC0 1\.0/);
    assert.match(section, /public domain/i);
    assert.match(section, /checkbox|check box|tick/i);
    assert.match(section, /token/i, 'what is collected');
    assert.match(section, /never[^.]*prompt|prompt[^.]*never/i, 'what is never collected: prompts');
    assert.match(section, /never[^.]*path|path[^.]*never/i, 'what is never collected: paths');
    assert.match(section, /(read|review)[^.]*(file|report)[^.]*before/i, 'read the report before submitting it');
    assert.match(section, /GitHub account[^.]*public|public[^.]*GitHub account/i);
    assert.match(section, /self-reported/i);
    assert.match(section, /form[^.]*not[^.]*origin/i);
  });

  test('AC-12 the donation template carries the CC0 1.0 checkbox with the right to share', () => {
    const box = /^\s*[-*] \[ \] (.*CC0 1\.0.*)$/m.exec(read('.github/PULL_REQUEST_TEMPLATE/metrics-donation.md'));
    assert.ok(box, 'an unticked checkbox naming CC0 1.0');
    assert.match(box[1], /public domain/i);
    assert.match(box[1], /right/i);
    assert.doesNotMatch(box[1], /\b(decline|refuse|do not|don't)\b/i);
  });

  test('AC-13 a pull request that adds any donated report needs a human merge', () => {
    const matchers = humanMergeMatchers(read('CLAUDE.md'));
    const files = ['docs/experiments/donated/2026-W43-89abcdef.json', 'docs/experiments/donated/2027-W01-00ff00ff.json'];
    assert.deepEqual(controlPlaneFiles(files, matchers), files);
  });
});

describe('CI runs each test file once per system and Node version (#25)', () => {
  test('AC-5 the metrics tests run on Windows only in the metrics job, and with the whole suite on Ubuntu and macOS', () => {
    const ci = yaml('.github/workflows/ci.yml');
    const suite = job(ci, 'test');
    assert.match(suite, /run:\s*npm test\s*$/m);
    assert.deepEqual(items(suite, 'os'), ['macos-latest', 'ubuntu-latest']);
    const npmTest = JSON.parse(read('package.json')).scripts.test;
    assert.match(npmTest, /^node --test /);
    const globs = [...npmTest.matchAll(/"([^"]+)"/g)].map((match) => globToRegExp(match[1]));
    const files = readdirSync(join(repo, 'tests'), { recursive: true }).map((file) => `tests/${String(file).replaceAll('\\', '/')}`).filter((file) => file.endsWith('.test.mjs'));
    assert.ok(files.some((file) => file.startsWith('tests/metrics-')), 'metrics tests exist');
    for (const file of files) assert.ok(globs.some((glob) => glob.test(file)), `npm test runs ${file}`);
    const metrics = job(ci, 'metrics');
    assert.match(metrics, /run:\s*node --test [^\n]*tests\/metrics-/);
    assert.deepEqual(items(metrics, 'os'), ['windows-latest'], 'the test job already runs the metrics tests elsewhere');
  });
});

// Issue #31: which test files each CI step runs, for every system and Node version of its job. A step runs
// tests through `npm test`, `npm run <script>` or `node --test <globs>`, chained with && or ;.
const testFiles = () => readdirSync(join(repo, 'tests'), { recursive: true })
  .map((file) => `tests/${String(file).replaceAll('\\', '/')}`)
  .filter((file) => file.endsWith('.test.mjs'));

function filesOf(command, scripts, files) {
  return command.split(/&&|;|\|\|/).map((part) => part.trim()).flatMap((part) => {
    const npm = /^npm (?:run )?(test(?::[\w-]+)?)\b/.exec(part);
    if (npm) return filesOf(scripts[npm[1]] ?? '', scripts, files);
    if (!/^node --test\b/.test(part)) return [];
    const globs = part.split(/\s+/).slice(2).filter((arg) => !arg.startsWith('-')).map((arg) => globToRegExp(arg.replace(/^["']|["']$/g, '')));
    return files.filter((file) => globs.some((glob) => glob.test(file)));
  });
}

// The names of the jobs of a workflow, in order.
const jobNames = (workflow) => [...workflow.slice(workflow.search(/^jobs:/m)).matchAll(/^ {2}([\w-]+):\s*$/gm)].map((match) => match[1]);

// Each test file that runs more than once for the same system and Node version, within a job or across
// jobs, as [combination, file, times].
function repeatedRuns(workflow, scripts, files = testFiles()) {
  const runs = new Map();
  for (const name of jobNames(workflow)) {
    const block = job(workflow, name);
    const systems = items(block, 'os') ?? [/runs-on:\s*(\S+)/.exec(block)?.[1]];
    const nodes = items(block, 'node') ?? [/node-version:\s*["']?([^\s"']+)/.exec(block)?.[1]];
    const ran = [...block.matchAll(/run:\s*(.+)$/gm)].flatMap((match) => filesOf(match[1].trim(), scripts, files));
    for (const os of systems) {
      for (const node of nodes) {
        const key = `${os}, Node ${node}`;
        if (!runs.has(key)) runs.set(key, new Map());
        for (const file of ran) runs.get(key).set(file, (runs.get(key).get(file) ?? 0) + 1);
      }
    }
  }
  return [...runs].flatMap(([key, counts]) => [...counts].filter(([, times]) => times > 1).map(([file, times]) => [key, file, times]));
}

describe('CI keeps one run per test file and the Node floor of package.json (#31)', () => {
  const ci = () => yaml('.github/workflows/ci.yml');
  const scripts = () => JSON.parse(read('package.json')).scripts;
  const replaceIn = (workflow, name, from, to) => {
    const block = job(workflow, name);
    assert.ok(block.includes(from), `${name} holds ${from}`);
    return workflow.replace(block, block.replace(from, to));
  };

  test('AC-6 (#31) a CI job runs npm test on exactly the minimum Node version of engines', () => {
    const engines = JSON.parse(read('package.json')).engines?.node ?? '';
    const floor = /^>=\s*(\d+\.\d+\.\d+)$/.exec(engines);
    assert.ok(floor, `engines.node is a minimum with major, minor and patch: ${engines}`);
    const workflow = ci();
    const runsOnFloor = jobNames(workflow).filter((name) => {
      const block = job(workflow, name);
      const nodes = items(block, 'node') ?? [/node-version:\s*["']?([^\s"']+)/.exec(block)?.[1]];
      return nodes.includes(floor[1]) && /run:\s*npm test\s*$/m.test(block);
    });
    assert.equal(runsOnFloor.length, 1, `one job runs npm test on Node ${floor[1]}`);
  });

  test('AC-7 (#31) no CI step runs a test file more than once for the same system and Node version', () => {
    assert.deepEqual(repeatedRuns(ci(), scripts()), []);
  });

  test('AC-7 (#31) the check fails when the metrics step runs its tests twice', () => {
    const workflow = ci();
    const step = /run:\s*(node --test [^\n]*tests\/metrics-[^\n]*)$/m.exec(job(workflow, 'metrics'))?.[1];
    assert.ok(step, 'the metrics job runs node --test');
    const twice = replaceIn(workflow, 'metrics', step, `${step} && ${step}`);
    const repeated = repeatedRuns(twice, scripts());
    assert.ok(repeated.some(([, file]) => file.startsWith('tests/metrics-')), JSON.stringify(repeated));
  });

  test('AC-7 (#31) the check fails when a job adds the whole suite where the metrics tests already run', () => {
    const workflow = ci();
    const step = /run:\s*(node --test [^\n]*tests\/metrics-[^\n]*)$/m.exec(job(workflow, 'metrics'))?.[1];
    const both = replaceIn(workflow, 'metrics', step, `npm test && ${step}`);
    assert.ok(repeatedRuns(both, scripts()).some(([, file]) => file.startsWith('tests/metrics-')));
  });

  test('AC-7 (#31) the check fails when two jobs run the suite on the same system and Node version', () => {
    const workflow = ci();
    const floor = /^>=\s*(\d+\.\d+\.\d+)$/.exec(JSON.parse(read('package.json')).engines?.node ?? '')?.[1];
    assert.ok(floor, 'engines.node names a full version');
    const name = jobNames(workflow).find((n) => job(workflow, n).includes(floor) && /run:\s*npm test\s*$/m.test(job(workflow, n)));
    assert.ok(name, `a job runs on Node ${floor}`);
    const line = /node-version:\s*["']?[^\s"']+["']?/.exec(job(workflow, name))?.[0] ?? `node: [${floor}]`;
    const clash = replaceIn(workflow, name, line, line.replace(floor, items(job(workflow, 'test'), 'node')[0]));
    assert.ok(repeatedRuns(clash, scripts()).length > 0, 'a second run of the suite on Node 22 is caught');
  });
});
