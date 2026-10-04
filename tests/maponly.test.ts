/**
 * Map-only projects (OpenWorkspace decision-3, amending decision-2): a
 * project with no native store keeps NO `_project/` folder — its identity and
 * information map live in a machine-readable TOML block inside the README.md /
 * AGENTS.md "Where information lives" section, which is the source of truth.
 * `_project/` appears only when a native store is enabled.
 */

import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { scanWorkspace } from "../src/dashboard/server.js";
import { doctorProject, doctorWorkspace } from "../src/doctor.js";
import { PLAN_STUB, convertToMapOnly, ensureProjectFolder, initProject, initWorkspace, planToMapOnly } from "../src/init.js";
import { MAP_BEGIN, MAP_BEGIN_MAP_ONLY, checkMapDocs, readInfoMap, renderMapDocs, writeMapEntry } from "../src/lib/infomap.js";
import { findMapBlock, parseMapOnlyText, readMapOnlyDoc } from "../src/lib/projectdoc.js";
import {
  discoverProjects,
  findProjectRoot,
  openWorkspace,
  readDeclaredLifecycle,
  readOwns,
  readProjectUid,
  writeDeclaredLifecycle,
  writeOwns,
} from "../src/lib/workspace.js";
import * as decisions from "../src/primitives/decisions.js";
import * as tasks from "../src/primitives/tasks.js";
import { makeTmpDir, makeTmpStore, rmrf } from "./helpers.js";

const CLI = path.resolve(__dirname, "..", "src", "cli.js");

function run(args: string[], cwd: string, storeDir: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, OPENWORKSPACE_STORE_DIR: storeDir, OW_ACTOR: "map-only-test" },
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function cliFixture(t: { after: (fn: () => void) => void }): { root: string; storeDir: string } {
  const root = makeTmpDir("ow-maponly-ws-");
  const storeDir = makeTmpDir("ow-maponly-store-");
  t.after(() => {
    rmrf(root);
    rmrf(storeDir);
  });
  assert.equal(run(["home", "init"], root, storeDir).status, 0);
  return { root, storeDir };
}

const read = (p: string): string => fs.readFileSync(p, "utf8");

/** Declare every core primitive with a non-native home (a doctor-clean map-only project). */
function declareAllExternal(dir: string): void {
  writeMapEntry(dir, "tasks", { kind: "external", system: "Teamwork", locator: "unknown" });
  writeMapEntry(dir, "decisions", { kind: "external", system: "MBI wiki", url: "https://docs.example.com/parties/acme" });
  writeMapEntry(dir, "wiki", { kind: "external", system: "MBI wiki", url: "https://docs.example.com/parties/acme" });
  writeMapEntry(dir, "plans", { kind: "none" });
  writeMapEntry(dir, "forum", { kind: "none" });
  renderMapDocs(dir);
}

// ---------------------------------------------------------------------------
// init + identity + discovery

test("map-only: init without a native store writes no _project/ — the uid + map live in README/AGENTS", (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));
  initWorkspace(tmp);
  const dir = path.join(tmp, "Acme");
  const { uid, rendered, form } = initProject(dir, {
    homes: { tasks: { kind: "external", system: "Teamwork", locator: "unknown" } },
  });
  assert.equal(form, "map-only");
  assert.deepEqual(rendered, ["README.md", "AGENTS.md"]);
  assert.ok(!fs.existsSync(path.join(dir, "_project")), "no _project/ folder");

  for (const doc of ["README.md", "AGENTS.md"]) {
    const text = read(path.join(dir, doc));
    assert.ok(text.includes(MAP_BEGIN_MAP_ONLY), doc);
    assert.match(text, new RegExp(`^uid = "${uid}"$`, "m"));
    assert.match(text, /^format = "openworkspace-map\/1"$/m);
    assert.match(text, /- \*\*Tasks & backlog:\*\* Teamwork — `unknown`/);
  }
  // identity, walk-up, discovery
  assert.equal(readProjectUid(dir), uid);
  fs.mkdirSync(path.join(dir, "data", "raw"), { recursive: true });
  assert.deepEqual(findProjectRoot(path.join(dir, "data", "raw")), { root: dir, uid });
  const found = discoverProjects(openWorkspace(tmp));
  assert.deepEqual(found.map((p) => [p.relPath, p.uid, p.form]), [["Acme", uid, "map-only"]]);

  // the map reads back from the block (source: README.md)
  const map = readInfoMap(dir);
  assert.equal(map.form, "map-only");
  assert.equal(map.source, "README.md");
  assert.equal(map.declared, true);
  assert.deepEqual(map.entries.map((e) => [e.key, e.kind]), [
    ["tasks", "external"],
    ["decisions", "undeclared"],
    ["wiki", "undeclared"],
    ["plans", "undeclared"],
    ["forum", "undeclared"],
  ]);
  assert.ok(checkMapDocs(dir).every((d) => d.state === "ok"));

  // doctor asks for the undeclared homes and nothing else (no _project/ checks)
  assert.deepEqual(
    doctorProject(dir).map((i) => [i.severity, i.file, i.message.replace(/:.*$/, "")]),
    [
      ["warn", "README.md", "Decisions"],
      ["warn", "README.md", "Knowledge (wiki)"],
      ["warn", "README.md", "Plans"],
      ["warn", "README.md", "Coordination (forum)"],
    ],
  );
  // re-init refuses
  assert.throws(() => initProject(dir), /already a project/);
  // existing README text is preserved; the block is appended
  const other = path.join(tmp, "Other");
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, "README.md"), "# Other\n\nHand-written intro.\n");
  initProject(other);
  assert.ok(read(path.join(other, "README.md")).startsWith("# Other\n\nHand-written intro.\n\n" + MAP_BEGIN_MAP_ONLY));
});

test("map-only: a native store, --folder or --no-docs gives the _project/ folder form (unchanged)", (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));
  assert.equal(initProject(path.join(tmp, "A"), { native: ["tasks"] }).form, "folder");
  assert.equal(initProject(path.join(tmp, "B"), { folder: true }).form, "folder");
  assert.equal(initProject(path.join(tmp, "C"), { renderDocs: false }).form, "folder");
  for (const n of ["A", "B", "C"]) assert.ok(fs.existsSync(path.join(tmp, n, "_project", "id")), n);
  // a folder project's rendered block keeps decision-2's exact marker and no TOML
  const readme = read(path.join(tmp, "A", "README.md"));
  assert.ok(readme.includes(MAP_BEGIN));
  assert.ok(!readme.includes("```toml"));
});

test("map-only: discovery has no false positives for docs that merely describe the block", (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));
  initWorkspace(tmp);
  const real = path.join(tmp, "Real");
  const { uid } = initProject(real);
  const block = read(path.join(real, "README.md"));
  const blockOnly = block.slice(block.indexOf(MAP_BEGIN_MAP_ONLY));

  // 1. the whole block quoted inside a fenced code block (a format doc)
  const docs = path.join(tmp, "Docs");
  fs.mkdirSync(docs);
  fs.writeFileSync(path.join(docs, "README.md"), "# Format\n\n````markdown\n" + blockOnly + "````\n");
  // 2. a README that shows the markers inline / indented, never at column 0
  const inline = path.join(tmp, "Inline");
  fs.mkdirSync(inline);
  fs.writeFileSync(path.join(inline, "README.md"), "Use `" + MAP_BEGIN_MAP_ONLY + "`.\n\n    " + blockOnly.replace(/\n/g, "\n    "));
  // 3. a real-looking block with a placeholder uid
  const placeholder = path.join(tmp, "Placeholder");
  fs.mkdirSync(placeholder);
  fs.writeFileSync(path.join(placeholder, "README.md"), blockOnly.replace(uid, "<uuid>"));
  // 4. a folder-flavored block (a copied render) without _project/
  const copied = path.join(tmp, "Copied");
  fs.mkdirSync(copied);
  fs.writeFileSync(path.join(copied, "README.md"), blockOnly.replace(MAP_BEGIN_MAP_ONLY, MAP_BEGIN));
  // 5. the block in some other file name
  const elsewhere = path.join(tmp, "Elsewhere");
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, "NOTES.md"), blockOnly.replace(uid, "11111111-2222-3333-4444-555555555555"));

  for (const d of [docs, inline, placeholder, copied, elsewhere]) {
    assert.equal(readProjectUid(d), null, path.basename(d));
  }
  assert.deepEqual(discoverProjects(openWorkspace(tmp)).map((p) => p.relPath), ["Real"]);

  // the block parser itself honours fences
  assert.equal(findMapBlock("```\n" + blockOnly + "```\n"), null);
  assert.notEqual(parseMapOnlyText(blockOnly, "README.md"), null);
});

test("map-only: AGENTS.md alone can carry the source block; a CLAUDE.md symlink is written through", (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));
  const dir = path.join(tmp, "Agentsy");
  initProject(dir);
  const uid = readProjectUid(dir);
  fs.unlinkSync(path.join(dir, "README.md"));
  fs.symlinkSync("AGENTS.md", path.join(dir, "CLAUDE.md"));
  assert.equal(readProjectUid(dir), uid);
  assert.equal(readInfoMap(dir).source, "AGENTS.md");

  writeMapEntry(dir, "forum", { kind: "none" });
  const map = readInfoMap(dir);
  assert.equal(map.form, "map-only");
  // a render_to naming the CLAUDE.md symlink too: AGENTS.md is written once, through the link
  map.renderTo = ["README.md", "AGENTS.md", "CLAUDE.md"];
  const results = renderMapDocs(dir, { map });
  assert.deepEqual(results.map((r) => r.file), ["README.md", "AGENTS.md"]);
  assert.ok(fs.lstatSync(path.join(dir, "CLAUDE.md")).isSymbolicLink(), "symlink kept");
  assert.equal(read(path.join(dir, "CLAUDE.md")), read(path.join(dir, "AGENTS.md")));
  // README.md now carries the block again and becomes the source (same uid)
  assert.equal(readMapOnlyDoc(dir)?.file, "README.md");
  assert.equal(readProjectUid(dir), uid);
});

// ---------------------------------------------------------------------------
// writes keep one source of truth

test("map-only: map/lifecycle/owns writes go to the block and keep README + AGENTS in step", (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));
  const dir = path.join(tmp, "Acme");
  initProject(dir);
  declareAllExternal(dir);
  writeMapEntry(dir, "credentials", { kind: "external", system: "1Password", locator: "vault Acme" });
  renderMapDocs(dir);
  writeDeclaredLifecycle(dir, "dormant", "2026-10-03T00:00:00Z");
  writeOwns(dir, [{ ref: "Code/acme-repo", kind: "code", name: null, lifecycle: null }]);

  assert.ok(!fs.existsSync(path.join(dir, "_project")));
  assert.equal(readDeclaredLifecycle(dir).lifecycle, "dormant");
  assert.equal(readOwns(dir).owns[0]?.ref, "Code/acme-repo");
  const readme = read(path.join(dir, "README.md"));
  const agents = read(path.join(dir, "AGENTS.md"));
  assert.equal(findMapBlock(readme)?.body, findMapBlock(agents)?.body, "copies stay identical");
  assert.match(readme, /^lifecycle = "dormant"$/m);
  assert.deepEqual(checkMapDocs(dir).map((d) => d.state), ["ok", "ok"]);
  assert.deepEqual(doctorProject(dir).map((i) => i.message), []);

  // hand-editing the TOML then rendering propagates it (README is the source)
  fs.writeFileSync(path.join(dir, "README.md"), readme.replace('locator = "unknown"', 'locator = "Acme onboarding"'));
  assert.equal(checkMapDocs(dir).find((d) => d.file === "AGENTS.md")?.state, "stale");
  renderMapDocs(dir);
  assert.match(read(path.join(dir, "AGENTS.md")), /Teamwork — `Acme onboarding`/);
  assert.deepEqual(doctorProject(dir).map((i) => i.message), []);
});

test("map-only: an unparseable TOML block keeps the project discoverable and is a doctor error", (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));
  const dir = path.join(tmp, "Broken");
  const { uid } = initProject(dir);
  const readme = read(path.join(dir, "README.md"));
  fs.writeFileSync(path.join(dir, "README.md"), readme.replace("[map]", "[map\ntasks = ="));
  assert.equal(readProjectUid(dir), uid);
  const errs = doctorProject(dir).filter((i) => i.severity === "error");
  assert.equal(errs.length, 1);
  assert.match(errs[0]?.message ?? "", /unparseable map TOML in README\.md/);
  assert.throws(() => renderMapDocs(dir), /unparseable map TOML/);
  assert.throws(() => writeMapEntry(dir, "forum", { kind: "none" }), /unparseable map TOML/);
});

// ---------------------------------------------------------------------------
// the folder appears with the first native store

test("map-only: the first native write creates _project/ — the map moves there verbatim, same uid", (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));
  const store = makeTmpStore();
  t.after(store.cleanup);
  const dir = path.join(tmp, "Grows");
  const { uid } = initProject(dir, { homes: { wiki: { kind: "external", system: "Notion", url: "https://notion.so/acme" } } });
  writeDeclaredLifecycle(dir, "dormant", null);

  const task = tasks.createTask(dir, store.store, { title: "First native task" });
  assert.equal(task.id, "task-1");
  assert.equal(read(path.join(dir, "_project", "id")), uid + "\n");
  const toml = read(path.join(dir, "_project", "project.toml"));
  assert.match(toml, /lifecycle = "dormant"/);
  assert.match(toml, /\[map\.wiki\]/);
  assert.doesNotMatch(toml, /format|uid/);
  // docs re-rendered in the folder flavor; one source of truth again
  for (const doc of ["README.md", "AGENTS.md"]) {
    const text = read(path.join(dir, doc));
    assert.ok(text.includes(MAP_BEGIN) && !text.includes(MAP_BEGIN_MAP_ONLY), doc);
    assert.ok(!text.includes("```toml"), doc);
  }
  assert.equal(readInfoMap(dir).form, "folder");
  assert.equal(readDeclaredLifecycle(dir).lifecycle, "dormant");
  // The undeclared tasks store now exists, so (exactly as decision-2 does for
  // folder projects) tasks reads as inferred-native and the docs ask for a
  // re-render; declaring it brings everything back in step.
  assert.equal(readInfoMap(dir).entries[0]?.source, "inferred");
  writeMapEntry(dir, "tasks", { kind: "native" });
  renderMapDocs(dir);
  assert.deepEqual(checkMapDocs(dir).map((d) => d.state), ["ok", "ok"]);
  // idempotent
  assert.equal(ensureProjectFolder(dir).converted, false);

  // decisions on another map-only project: same promotion
  const d2 = path.join(tmp, "Decides");
  initProject(d2);
  decisions.newDecision(d2, store.store, { title: "Pick" });
  assert.ok(fs.existsSync(path.join(d2, "_project", "id")));
});

// ---------------------------------------------------------------------------
// converting a retired folder project down to map-only (and back)

test("map-only: map adopt --map-only converts a folder project whose stores are retired; blockers otherwise", (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));
  initWorkspace(tmp);
  const dir = path.join(tmp, "Retired");
  const { uid } = initProject(dir, { folder: true });
  declareAllExternal(dir);
  // old empty skeleton stores are fine (removed)
  fs.mkdirSync(path.join(dir, "_project", "plans"), { recursive: true });
  fs.writeFileSync(path.join(dir, "_project", "plans", "current.md"), PLAN_STUB);
  fs.mkdirSync(path.join(dir, "_project", "tasks", "archive"), { recursive: true });
  fs.writeFileSync(path.join(dir, "_project", "tasks", "archive", "task-1 - old.md"), "---\nid: task-1\n---\n");

  let plan = planToMapOnly(dir);
  assert.equal(plan.eligible, false);
  assert.match(plan.blockers.join("\n"), /_project\/tasks\/ still holds content/);
  assert.ok(fs.existsSync(path.join(dir, "_project", "id")));

  fs.rmSync(path.join(dir, "_project", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(dir, "_project", "notes.txt"), "keep me");
  assert.match(planToMapOnly(dir).blockers.join("\n"), /_project\/notes\.txt is left in the folder/);
  fs.unlinkSync(path.join(dir, "_project", "notes.txt"));

  plan = planToMapOnly(dir);
  assert.equal(plan.eligible, true, plan.blockers.join("; "));
  const result = convertToMapOnly(dir);
  assert.equal(result.converted, true);
  assert.ok(!fs.existsSync(path.join(dir, "_project")));
  assert.equal(readProjectUid(dir), uid);
  assert.equal(readInfoMap(dir).form, "map-only");
  assert.deepEqual(doctorProject(dir).map((i) => i.message), []);
  assert.deepEqual(discoverProjects(openWorkspace(tmp)).map((p) => [p.uid, p.form]), [[uid, "map-only"]]);

  // declared-native blocks the conversion
  const nat = path.join(tmp, "Native");
  initProject(nat, { native: ["wiki"] });
  assert.match(planToMapOnly(nat).blockers.join("\n"), /wiki is declared native/);
  // a legacy project (no [map]) must declare homes first
  const legacy = path.join(tmp, "Legacy");
  fs.mkdirSync(path.join(legacy, "_project"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "_project", "id"), "legacy-0001\n");
  assert.match(planToMapOnly(legacy).blockers.join("\n"), /no \[map\] declared/);
});

test("cli: map adopt --map-only / --folder round-trip, task create redirects or promotes, home list + doctor", (t) => {
  const { root, storeDir } = cliFixture(t);
  assert.equal(run(["new", "Folder", "--folder", "--home", "tasks=https://acme.teamwork.com/app/projects/1"], root, storeDir).status, 0);
  const proj = path.join(root, "Folder");
  for (const [k, v] of [["decisions", "none"], ["wiki", "none"], ["plans", "none"], ["forum", "none"]]) {
    assert.equal(run(["map", "set", k as string, v as string], proj, storeDir).status, 0);
  }
  const uid = readProjectUid(proj);

  const dry = run(["map", "adopt", "--map-only"], proj, storeDir);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /would remove _project\//);
  assert.ok(fs.existsSync(path.join(proj, "_project")));
  const hint = run(["map", "adopt"], proj, storeDir);
  assert.match(hint.stdout, /projects map adopt --map-only --apply/);

  const apply = run(["map", "adopt", "--map-only", "--apply"], proj, storeDir);
  assert.equal(apply.status, 0, apply.stderr);
  assert.ok(!fs.existsSync(path.join(proj, "_project")));
  assert.equal(readProjectUid(proj), uid);

  // task create: tasks are external → exit 3, nothing written, no folder
  const redirected = run(["task", "create", "Nope"], proj, storeDir);
  assert.equal(redirected.status, 3);
  assert.match(redirected.stderr + redirected.stdout, /README\.md information-map block/);
  assert.ok(!fs.existsSync(path.join(proj, "_project")));
  // forum presence never conjures a folder
  const ann = run(["forum", "announce", "--doing", "x"], proj, storeDir);
  assert.equal(ann.status, 0, ann.stderr);
  assert.ok(!fs.existsSync(path.join(proj, "_project")));

  // home list tags it; home doctor has no findings for it
  const list = run(["home", "list"], root, storeDir);
  assert.match(list.stdout, /Folder {2}\(active, map-only\)/);
  const show = run(["show"], proj, storeDir);
  assert.match(show.stdout, /form: {6}map-only/);
  assert.match(show.stdout, /map-only: declared in the README\.md information-map block/);
  const doc = run(["home", "doctor", "--json"], root, storeDir);
  const rep = JSON.parse(doc.stdout) as { issues: Array<{ project: string | null; message: string }> };
  assert.deepEqual(rep.issues.filter((i) => i.project === "Folder"), []);

  // --folder: back to a _project/ folder with the same uid
  const back = run(["map", "adopt", "--folder", "--apply"], proj, storeDir);
  assert.equal(back.status, 0, back.stderr);
  assert.equal(read(path.join(proj, "_project", "id")), uid + "\n");
  assert.match(read(path.join(proj, "_project", "project.toml")), /teamwork/);

  // a default `new` is map-only; an undeclared task create promotes it with a note
  assert.equal(run(["new", "Fresh"], root, storeDir).status, 0);
  const fresh = path.join(root, "Fresh");
  assert.ok(!fs.existsSync(path.join(fresh, "_project")));
  const created = run(["task", "create", "Go"], fresh, storeDir);
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stderr, /was map-only; created _project\//);
  assert.ok(fs.existsSync(path.join(fresh, "_project", "tasks")));

  // map set <prim> native on a map-only project creates the folder first
  assert.equal(run(["new", "Wiki"], root, storeDir).status, 0);
  const wiki = path.join(root, "Wiki");
  const setNative = run(["map", "set", "wiki", "native"], wiki, storeDir);
  assert.equal(setNative.status, 0, setNative.stderr);
  assert.match(setNative.stdout, /created _project\//);
  assert.match(read(path.join(wiki, "_project", "project.toml")), /wiki = "native"/);
});

test("map-only: the dashboard scan and workspace doctor handle map-only projects", (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));
  initWorkspace(tmp);
  const dir = path.join(tmp, "Acme");
  initProject(dir);
  declareAllExternal(dir);
  initProject(path.join(tmp, "Folder"), { native: ["tasks"] });

  const scan = scanWorkspace(openWorkspace(tmp));
  const acme = scan.projects.find((p) => p.name === "Acme");
  assert.ok(acme);
  assert.equal(acme.form, "map-only");
  assert.equal(acme.map?.find((e) => e.key === "tasks")?.system, "Teamwork");
  assert.equal(acme.tasks.length, 0);
  assert.equal(scan.projects.find((p) => p.name === "Folder")?.form, "folder");

  const rep = doctorWorkspace(openWorkspace(tmp));
  assert.deepEqual(rep.issues.filter((i) => i.project === "Acme"), []);

  // a stray _project/ (no id) in a map-only project is flagged, not mistaken for a folder
  fs.mkdirSync(path.join(dir, "_project", "tasks"), { recursive: true });
  const stray = doctorProject(dir);
  assert.ok(stray.some((i) => i.severity === "warn" && /stray _project\/ folder/.test(i.message)));
});
