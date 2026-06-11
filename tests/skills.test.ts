/**
 * `projects skills sync` tests (src/skills.ts).
 *
 * Every test runs against a temp workspace under os.tmpdir(); the runtime
 * skill dirs (`.claude` / `.codex`) and README are ALSO temp paths inside that
 * workspace — the real ~/.claude, ~/.codex, and the live Documents README are
 * never touched.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import {
  README_BEGIN,
  README_END,
  SkillsEnv,
  SkillsFs,
  applyReadmeSection,
  applySkillsSync,
  defaultSourceRoots,
  discoverSkills,
  parseSkillFrontmatter,
  planSkillsSync,
} from "../src/skills.js";
import { makeTmpWorkspace, TmpWorkspace } from "./helpers.js";

// --- A node:fs-backed SkillsFs (the same surface cli.ts builds). ---
const realFs: SkillsFs = {
  existsSync: fs.existsSync,
  readdirSync: (p, opts) => fs.readdirSync(p, opts),
  readFileSync: (p, enc) => fs.readFileSync(p, enc),
  lstatSync: fs.lstatSync,
  readlinkSync: fs.readlinkSync,
  symlinkSync: fs.symlinkSync,
  unlinkSync: fs.unlinkSync,
  mkdirSync: (p, opts) => {
    fs.mkdirSync(p, opts);
  },
};

interface Harness {
  tw: TmpWorkspace;
  env: SkillsEnv;
  claudeDir: string;
  codexDir: string;
  readmePath: string;
  agentsDir: string;
}

/** Write a skill dir `<root>/<name>/SKILL.md` with frontmatter. */
function writeSkill(root: string, name: string, description: string, declaredName?: string): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const fm = [`---`, `name: ${declaredName ?? name}`, `description: ${description}`, `---`, ``, `# ${name}`, ``].join("\n");
  fs.writeFileSync(path.join(dir, "SKILL.md"), fm);
}

/** Build a harness with two mock projects (each with a Skills/ dir). */
function makeHarness(): Harness {
  const tw = makeTmpWorkspace();
  // Two projects with Skills/ dirs; one project name has a space + colon-ish
  // char to exercise path-with-spaces handling.
  const p1 = tw.addProject("Alpha Project");
  const p2 = tw.addProject("Inbox:Outbox Proj");
  fs.mkdirSync(path.join(p1.root, "Skills"), { recursive: true });
  fs.mkdirSync(path.join(p2.root, "Skills"), { recursive: true });
  writeSkill(path.join(p1.root, "Skills"), "alpha-one", "does alpha one things");
  writeSkill(path.join(p2.root, "Skills"), "beta-two", "does beta two things");

  const claudeDir = path.join(tw.root, ".home", ".claude", "skills");
  const codexDir = path.join(tw.root, ".home", ".codex", "skills");
  const readmePath = path.join(tw.root, "README.md");
  const agentsDir = path.join(tw.root, ".agents", "skills");

  const env: SkillsEnv = {
    ws: tw.ws,
    fs: realFs,
    claudeSkillsDir: claudeDir,
    codexSkillsDir: codexDir,
    sourceRoots: defaultSourceRoots({ ws: tw.ws, fs: realFs }),
    readmePath,
  };
  return { tw, env, claudeDir, codexDir, readmePath, agentsDir };
}

/** Resolve a symlink's target to an absolute path (link may store relative). */
function linkAbs(link: string): string {
  const target = fs.readlinkSync(link);
  return path.resolve(path.dirname(link), target);
}

// ---------------------------------------------------------------------------

test("parseSkillFrontmatter: inline, quoted, and block scalars", () => {
  assert.deepEqual(parseSkillFrontmatter("---\nname: foo\ndescription: bar baz\n---\nbody"), {
    name: "foo",
    description: "bar baz",
  });
  assert.deepEqual(parseSkillFrontmatter('---\nname: "foo"\ndescription: \'q\'\n---\n'), {
    name: "foo",
    description: "q",
  });
  const block = ["---", "name: foo", "description: >-", "  line one", "  line two", "---", ""].join("\n");
  assert.deepEqual(parseSkillFrontmatter(block), { name: "foo", description: "line one line two" });
  assert.deepEqual(parseSkillFrontmatter("no frontmatter here"), { name: null, description: null });
});

test("defaultSourceRoots discovers each project's Skills/ dir", () => {
  const h = makeHarness();
  try {
    const roots = defaultSourceRoots({ ws: h.env.ws, fs: realFs });
    assert.ok(roots.some((r) => r.endsWith(path.join("Alpha Project", "Skills"))));
    assert.ok(roots.some((r) => r.endsWith(path.join("Inbox:Outbox Proj", "Skills"))));
  } finally {
    h.tw.cleanup();
  }
});

test("discoverSkills finds skills across mock project Skills/ dirs", () => {
  const h = makeHarness();
  try {
    const { skills } = discoverSkills(h.env);
    const names = skills.map((s) => s.name).sort();
    assert.deepEqual(names, ["alpha-one", "beta-two"]);
    const alpha = skills.find((s) => s.name === "alpha-one");
    assert.equal(alpha?.description, "does alpha one things");
  } finally {
    h.tw.cleanup();
  }
});

test("apply builds .agents/skills symlinks pointing at canonical sources", () => {
  const h = makeHarness();
  try {
    const plan = planSkillsSync(h.env);
    applySkillsSync(h.env, plan);

    const aLink = path.join(h.agentsDir, "alpha-one");
    const bLink = path.join(h.agentsDir, "beta-two");
    assert.ok(fs.lstatSync(aLink).isSymbolicLink());
    assert.ok(fs.lstatSync(bLink).isSymbolicLink());
    assert.equal(linkAbs(aLink), path.join(h.tw.root, "Alpha Project", "Skills", "alpha-one"));
    assert.equal(linkAbs(bLink), path.join(h.tw.root, "Inbox:Outbox Proj", "Skills", "beta-two"));
    // Link resolves to a real SKILL.md (proves spaces/colon paths work).
    assert.ok(fs.existsSync(path.join(aLink, "SKILL.md")));
  } finally {
    h.tw.cleanup();
  }
});

test("apply creates .claude and .codex links into .agents/skills", () => {
  const h = makeHarness();
  try {
    applySkillsSync(h.env, planSkillsSync(h.env));
    for (const runtime of [h.claudeDir, h.codexDir]) {
      const link = path.join(runtime, "alpha-one");
      assert.ok(fs.lstatSync(link).isSymbolicLink());
      // runtime link points at the AGGREGATE, not the source.
      assert.equal(linkAbs(link), path.join(h.agentsDir, "alpha-one"));
      // and the aggregate resolves through to the real skill.
      assert.ok(fs.existsSync(path.join(link, "SKILL.md")));
    }
  } finally {
    h.tw.cleanup();
  }
});

test("idempotent re-run: second sync makes no changes", () => {
  const h = makeHarness();
  try {
    applySkillsSync(h.env, planSkillsSync(h.env));
    const plan2 = planSkillsSync(h.env);
    const nonOk = plan2.actions.filter((a) => a.kind !== "ok");
    assert.deepEqual(nonOk, [], "all actions should be ok on re-plan");
    const res2 = applySkillsSync(h.env, plan2);
    assert.equal(res2.applied.length, 0);
    assert.equal(res2.readmeWritten, false);
  } finally {
    h.tw.cleanup();
  }
});

test("prunes a removed skill's links across all layers", () => {
  const h = makeHarness();
  try {
    applySkillsSync(h.env, planSkillsSync(h.env));
    assert.ok(fs.existsSync(path.join(h.agentsDir, "beta-two")));

    // Remove the beta-two source.
    fs.rmSync(path.join(h.tw.root, "Inbox:Outbox Proj", "Skills", "beta-two"), { recursive: true });

    const plan = planSkillsSync(h.env);
    const prunes = plan.actions.filter((a) => a.kind === "prune").map((a) => path.basename(a.link));
    assert.ok(prunes.includes("beta-two"));
    applySkillsSync(h.env, plan);

    assert.equal(fs.existsSync(path.join(h.agentsDir, "beta-two")), false);
    assert.equal(fs.existsSync(path.join(h.claudeDir, "beta-two")), false);
    assert.equal(fs.existsSync(path.join(h.codexDir, "beta-two")), false);
    // alpha-one survives.
    assert.ok(fs.lstatSync(path.join(h.agentsDir, "alpha-one")).isSymbolicLink());
  } finally {
    h.tw.cleanup();
  }
});

test("repoints a moved source on re-sync (update, not stale)", () => {
  const h = makeHarness();
  try {
    applySkillsSync(h.env, planSkillsSync(h.env));
    // Move alpha-one's owning project's skill to a new project.
    const p3 = h.tw.addProject("Gamma Project");
    fs.mkdirSync(path.join(p3.root, "Skills"), { recursive: true });
    fs.rmSync(path.join(h.tw.root, "Alpha Project", "Skills", "alpha-one"), { recursive: true });
    writeSkill(path.join(p3.root, "Skills"), "alpha-one", "does alpha one things");

    // Rebuild env (source roots are a live default scan).
    const env2: SkillsEnv = { ...h.env, sourceRoots: defaultSourceRoots({ ws: h.env.ws, fs: realFs }) };
    const plan = planSkillsSync(env2);
    const update = plan.actions.find((a) => a.layer === "agents" && path.basename(a.link) === "alpha-one");
    assert.equal(update?.kind, "update");
    applySkillsSync(env2, plan);
    assert.equal(
      linkAbs(path.join(h.agentsDir, "alpha-one")),
      path.join(p3.root, "Skills", "alpha-one"),
    );
  } finally {
    h.tw.cleanup();
  }
});

test("updates the marked README section idempotently", () => {
  const h = makeHarness();
  try {
    fs.writeFileSync(h.readmePath, "# Workspace\n\nHello.\n");
    const plan = planSkillsSync(h.env);
    assert.equal(plan.readme?.changed, true);
    applySkillsSync(h.env, plan);

    const after = fs.readFileSync(h.readmePath, "utf8");
    assert.ok(after.includes(README_BEGIN));
    assert.ok(after.includes(README_END));
    assert.ok(after.includes("**alpha-one** — does alpha one things"));
    assert.ok(after.includes("**beta-two** — does beta two things"));
    assert.ok(after.startsWith("# Workspace"), "preamble preserved");

    // Re-running reproduces identical bytes.
    const plan2 = planSkillsSync(h.env);
    assert.equal(plan2.readme?.changed, false);
    const res2 = applySkillsSync(h.env, plan2);
    assert.equal(res2.readmeWritten, false);
    assert.equal(fs.readFileSync(h.readmePath, "utf8"), after);
  } finally {
    h.tw.cleanup();
  }
});

test("applyReadmeSection replaces an existing block (no duplication)", () => {
  const initial = [
    "# Title",
    "",
    README_BEGIN,
    "### Installed agent skills",
    "",
    "- **old-skill** — gone now",
    README_END,
    "",
    "## After",
    "",
  ].join("\n");
  const next = applyReadmeSection(initial, [
    { name: "new-skill", description: "fresh", source: "/x" },
  ]);
  assert.equal((next.match(new RegExp(README_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length, 1);
  assert.ok(next.includes("**new-skill** — fresh"));
  assert.ok(!next.includes("old-skill"));
  assert.ok(next.includes("## After"), "content after the block is preserved");
});

test("dry-run writes nothing", () => {
  const h = makeHarness();
  try {
    fs.writeFileSync(h.readmePath, "# Workspace\n");
    const before = fs.readFileSync(h.readmePath, "utf8");
    const plan = planSkillsSync(h.env);
    // Planning alone must not have created the aggregate dir or any links.
    assert.equal(fs.existsSync(h.agentsDir), false);
    assert.equal(fs.existsSync(h.claudeDir), false);
    assert.equal(fs.existsSync(h.codexDir), false);
    assert.equal(fs.readFileSync(h.readmePath, "utf8"), before);
    // The plan itself describes work to do.
    assert.ok(plan.actions.some((a) => a.kind === "create"));
  } finally {
    h.tw.cleanup();
  }
});

test("refuses to clobber a non-symlink occupant at a runtime link path", () => {
  const h = makeHarness();
  try {
    // A real directory squats where the claude link would go.
    fs.mkdirSync(path.join(h.claudeDir, "alpha-one"), { recursive: true });
    fs.writeFileSync(path.join(h.claudeDir, "alpha-one", "keep.txt"), "mine\n");

    const res = applySkillsSync(h.env, planSkillsSync(h.env));
    assert.ok(res.refusals.some((r) => r.reason.includes("non-symlink")));
    // The real dir survives untouched.
    assert.ok(fs.existsSync(path.join(h.claudeDir, "alpha-one", "keep.txt")));
    // But the aggregate + codex link still got built.
    assert.ok(fs.lstatSync(path.join(h.agentsDir, "alpha-one")).isSymbolicLink());
    assert.ok(fs.lstatSync(path.join(h.codexDir, "alpha-one")).isSymbolicLink());
  } finally {
    h.tw.cleanup();
  }
});

test("name collision across source roots: first root wins, loser recorded", () => {
  const h = makeHarness();
  try {
    // Add a second skill that DECLARES the same name as alpha-one in another root.
    const p2Skills = path.join(h.tw.root, "Inbox:Outbox Proj", "Skills");
    writeSkill(p2Skills, "dupe-dir", "shadowed copy", "alpha-one");
    const env2: SkillsEnv = { ...h.env, sourceRoots: defaultSourceRoots({ ws: h.env.ws, fs: realFs }) };
    const { skills, collisions } = discoverSkills(env2);
    // Only one alpha-one survives.
    assert.equal(skills.filter((s) => s.name === "alpha-one").length, 1);
    assert.ok(collisions.has("alpha-one"));
  } finally {
    h.tw.cleanup();
  }
});
