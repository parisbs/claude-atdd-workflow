// The control plane (ADR 0010): the files where an agent could weaken its own
// controls, or whose merge is itself a deployment. A pull request that changes
// one of them is merged by the human.
//
// The default is stack independent plus the test-configuration paths of the
// oracle (one list for both guards), plus database migrations. A repository adds
// its own paths with a line `Human merge:` in AGENTS.md.
import { TEST_CONFIG, globToRegExp } from './oracle.mjs';

export const CONTROL_PLANE = [
  /(^|\/)\.github\/workflows\//,
  /(^|\/)docs\/(adr|adrs|decisions)\//,
  /(^|\/)(AGENTS|CLAUDE)\.md$/,
  /(^|\/)\.claude\//,
  /(^|\/)supabase\/migrations\//,
  ...TEST_CONFIG,
];

// Reads `Human merge: a, b/**, c` from the text of an AGENTS.md. `none`, or no
// such line, adds nothing. A trailing slash means a whole directory.
export function humanMergeMatchers(agentsMd) {
  const line = /^\s*(?:[-*]\s*)?Human merge:[ \t]*(.+?)[ \t]*$/im.exec(agentsMd ?? '');
  if (!line || /^none$/i.test(line[1].trim())) return [];
  return line[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^`|`$/g, ''))
    .filter(Boolean)
    .map((entry) => globToRegExp(entry.endsWith('/') ? `${entry}**` : entry));
}

export const controlPlaneFiles = (paths, extra = []) => paths.filter((path) => [...CONTROL_PLANE, ...extra].some((re) => re.test(path)));
