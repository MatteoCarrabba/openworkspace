/**
 * The declared `projects` CLI surface (PRD §8), as data.
 *
 * Single consumer pair: src/cli.ts dispatches it; the doc-currency doctor
 * check (PRD §10, R2/R3) greps orientation artifacts for `projects …`
 * references and validates them against this table — a stale orientation
 * artifact is a failure, not a footnote. Keep this table in lockstep with
 * cli.ts (tests/cli.test.ts asserts the dispatch surface matches).
 */

/**
 * command → set of valid subcommands, or null when the command takes
 * positionals/flags only (no subcommand vocabulary to validate).
 */
export const CLI_SURFACE: Readonly<Record<string, ReadonlySet<string> | null>> = {
  home: new Set(["init", "list", "scan", "doctor", "mint-suffix", "runner-node", "machine-id"]),
  init: null,
  new: null,
  show: null,
  doctor: null,
  rename: null,
  move: null,
  lifecycle: null,
  reconcile: null, // decision-2: heal location⟷metadata drift

  task: new Set([
    "create", "list", "show", "edit", "note", "status", "done", "hide", "recur", "archive",
  ]),
  decision: new Set(["new", "accept", "list", "show", "supersede"]),
  plan: new Set(["show", "open"]),
  forum: new Set([
    "announce", "depart", "who", "open", "post", "show", "list", "inbox",
    "resolve", "archive", "sweep",
  ]),
  // Declared in the PRD; stubbed in this build (the stub is loud, not absent).
  automation: new Set(["apply", "deactivate", "list", "status", "prune", "logs", "run-now"]),
  skills: new Set(["sync"]),
  dashboard: new Set(["dev", "open"]),
  import: new Set(["legacy"]),
  help: null,
};

/**
 * Vocabulary the PRD retired (§4.3 / §12 Delete): a reference to one of these
 * as a `_project/` primitive directory in an orientation doc is dead-doc rot.
 */
export const RETIRED_PRIMITIVE_DIRS = [
  "reflections",
  "scripts",
  "cache",
  "proposals",
  "reviews",
  "reminders",
] as const;

export interface DocCurrencyFinding {
  /** The offending text as found. */
  snippet: string;
  reason: string;
}

/**
 * Extract the regions of a Markdown document where command references are
 * load-bearing: inline code spans, fenced code blocks, and indented (4-space)
 * code lines. Prose mentions of the word "projects" stay out of scope —
 * orientation docs put runnable commands in code context.
 */
/** Drop shell-style `# …` comment tails: prose in comments is not a command. */
function stripComments(block: string): string {
  return block
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");
}

function codeRegions(text: string): string[] {
  const regions: string[] = [];
  // fenced blocks first, then strip them so their backticks don't confuse spans
  const fences = /```[^\n]*\n([\s\S]*?)```/g;
  let stripped = text;
  for (let m = fences.exec(text); m !== null; m = fences.exec(text)) {
    regions.push(stripComments(m[1] as string));
  }
  stripped = stripped.replace(fences, "");
  const spans = /`([^`\n]+)`/g;
  for (let m = spans.exec(stripped); m !== null; m = spans.exec(stripped)) {
    regions.push(m[1] as string);
  }
  for (const line of stripped.split("\n")) {
    if (/^ {4,}\S/.test(line)) regions.push(stripComments(line));
  }
  return regions;
}

// Lookbehind: "all-projects invariant checks" must not read as `projects invariant`.
const CLI_REF_RE = /(?<![-\w])projects\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/g;

/**
 * Doc-currency check (pure function over a document's text): flag `projects`
 * command references that the CLI surface does not know, and references to
 * retired `_project/` primitive directories.
 */
export function checkDocCurrency(text: string): DocCurrencyFinding[] {
  const findings: DocCurrencyFinding[] = [];
  for (const region of codeRegions(text)) {
    for (let m = CLI_REF_RE.exec(region); m !== null; m = CLI_REF_RE.exec(region)) {
      const cmd = m[1] as string;
      const sub = m[2];
      if (!(cmd in CLI_SURFACE)) {
        findings.push({
          snippet: `projects ${cmd}`,
          reason: `unknown command "${cmd}" — not in the CLI surface`,
        });
        continue;
      }
      const subs = CLI_SURFACE[cmd];
      if (subs !== null && subs !== undefined && sub !== undefined && !subs.has(sub)) {
        findings.push({
          snippet: `projects ${cmd} ${sub}`,
          reason: `unknown ${cmd} subcommand "${sub}"`,
        });
      }
    }
  }
  for (const dir of RETIRED_PRIMITIVE_DIRS) {
    const re = new RegExp(`_project/${dir}/`, "g");
    if (re.test(text)) {
      findings.push({
        snippet: `_project/${dir}/`,
        reason: `retired primitive directory "${dir}/" referenced (PRD §4.3 vocabulary)`,
      });
    }
  }
  return findings;
}
