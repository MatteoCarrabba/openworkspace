/**
 * Project-graph unit tests: readOwns / writeOwns (schema), classifyRef /
 * resolveOwnRef / buildOwnershipGraph / detectCycle (ref resolution + graph).
 * Everything runs against temp dirs via makeTmpWorkspace.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import {
  OwnEdge,
  readDeclaredLifecycle,
  readOwns,
  writeOwns,
} from "../src/lib/workspace.js";
import {
  buildOwnershipGraph,
  classifyRef,
  detectCycle,
  resolveOwnRef,
} from "../src/lib/owns.js";
import { makeTmpWorkspace } from "./helpers.js";

function writeProjectToml(root: string, body: string): void {
  fs.mkdirSync(path.join(root, "_project"), { recursive: true });
  fs.writeFileSync(path.join(root, "_project", "project.toml"), body);
}

// ---------------------------------------------------------------------------
// readOwns
// ---------------------------------------------------------------------------

test("readOwns: parses a valid 3-entry array (subproject/code/remote) with name + lifecycle", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const p = tw.addProject("Parent");
  writeProjectToml(
    p.root,
    [
      `[[owns]]`,
      `ref = "Child"`,
      `kind = "subproject"`,
      ``,
      `[[owns]]`,
      `ref = "/abs/firmware"`,
      `kind = "code"`,
      `name = "firmware"`,
      `lifecycle = "dormant"`,
      ``,
      `[[owns]]`,
      `ref = "https://github.com/x/y.git"`,
      `kind = "remote"`,
      ``,
    ].join("\n"),
  );
  const res = readOwns(p.root);
  assert.equal(res.problems.length, 0);
  assert.equal(res.owns.length, 3);
  assert.deepEqual(res.owns[0], { ref: "Child", kind: "subproject", name: null, lifecycle: null });
  assert.deepEqual(res.owns[1], {
    ref: "/abs/firmware",
    kind: "code",
    name: "firmware",
    lifecycle: "dormant",
  });
  assert.deepEqual(res.owns[2], {
    ref: "https://github.com/x/y.git",
    kind: "remote",
    name: null,
    lifecycle: null,
  });
});

test("readOwns: no owns key → empty result, no problems", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const p = tw.addProject("Parent");
  writeProjectToml(p.root, `lifecycle = "active"\n`);
  const res = readOwns(p.root);
  assert.deepEqual(res, { owns: [], problems: [] });
});

test("readOwns: absent project.toml → empty result, no problems", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const p = tw.addProject("Parent");
  const res = readOwns(p.root);
  assert.deepEqual(res, { owns: [], problems: [] });
});

test("readOwns: collects problems for bad kind / missing ref / non-table / bad lifecycle, keeps valid", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const p = tw.addProject("Parent");
  writeProjectToml(
    p.root,
    [
      `[[owns]]`,
      `ref = "Good"`,
      `kind = "subproject"`,
      ``,
      `[[owns]]`,
      `ref = "BadKind"`,
      `kind = "nonsense"`,
      ``,
      `[[owns]]`,
      `kind = "code"`, // missing ref
      ``,
      `[[owns]]`,
      `ref = "BadLifecycle"`,
      `kind = "subproject"`,
      `lifecycle = "weird"`,
      ``,
    ].join("\n"),
  );
  const res = readOwns(p.root);
  // Good + BadLifecycle survive (bad lifecycle is non-fatal → lifecycle null + problem)
  assert.equal(res.owns.length, 2);
  assert.equal(res.owns[0]?.ref, "Good");
  assert.equal(res.owns[1]?.ref, "BadLifecycle");
  assert.equal(res.owns[1]?.lifecycle, null);
  assert.ok(res.problems.some((p) => /bad kind/.test(p)));
  assert.ok(res.problems.some((p) => /missing string ref/.test(p)));
  assert.ok(res.problems.some((p) => /bad lifecycle/.test(p)));
});

test("readOwns: owns that is not an array → a problem, no throw", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const p = tw.addProject("Parent");
  writeProjectToml(p.root, `owns = "not-an-array"\n`);
  const res = readOwns(p.root);
  assert.equal(res.owns.length, 0);
  assert.ok(res.problems.some((p) => /array of tables/.test(p)));
});

// ---------------------------------------------------------------------------
// writeOwns
// ---------------------------------------------------------------------------

test("writeOwns: round-trips (write → readOwns equals input)", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const p = tw.addProject("Parent");
  const edges: OwnEdge[] = [
    { ref: "Child", kind: "subproject", name: null, lifecycle: null },
    { ref: "~/code/fw", kind: "code", name: "fw", lifecycle: "archived" },
    { ref: "git@host:org/repo.git", kind: "remote", name: null, lifecycle: null },
  ];
  writeOwns(p.root, edges);
  const res = readOwns(p.root);
  assert.equal(res.problems.length, 0);
  assert.deepEqual(res.owns, edges);
});

test("writeOwns: preserves a pre-existing lifecycle key", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const p = tw.addProject("Parent");
  writeProjectToml(p.root, `lifecycle = "dormant"\nlifecycle_set = "2026-01-01"\n`);
  writeOwns(p.root, [{ ref: "Child", kind: "subproject", name: null, lifecycle: null }]);
  // lifecycle survives the owns write
  assert.equal(readDeclaredLifecycle(p.root).lifecycle, "dormant");
  assert.equal(readOwns(p.root).owns.length, 1);
});

test("writeOwns([]): deletes the owns key; empties → unlinks the file", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const p = tw.addProject("Parent");
  const tomlPath = path.join(p.root, "_project", "project.toml");

  // case 1: lifecycle present → owns deleted, file remains
  writeProjectToml(p.root, `lifecycle = "dormant"\n`);
  writeOwns(p.root, [{ ref: "Child", kind: "subproject", name: null, lifecycle: null }]);
  writeOwns(p.root, []);
  assert.equal(readOwns(p.root).owns.length, 0);
  assert.equal(readDeclaredLifecycle(p.root).lifecycle, "dormant");
  assert.ok(fs.existsSync(tomlPath));

  // case 2: only owns present → emptying unlinks the file
  const p2 = tw.addProject("Lonely");
  const toml2 = path.join(p2.root, "_project", "project.toml");
  writeOwns(p2.root, [{ ref: "X", kind: "subproject", name: null, lifecycle: null }]);
  assert.ok(fs.existsSync(toml2));
  writeOwns(p2.root, []);
  assert.ok(!fs.existsSync(toml2));
});

// ---------------------------------------------------------------------------
// classifyRef
// ---------------------------------------------------------------------------

test("classifyRef: ws-relative / absolute / remote", () => {
  assert.equal(classifyRef("Briefing"), "ws-relative");
  assert.equal(classifyRef("nested/dir"), "ws-relative");
  assert.equal(classifyRef("/abs/path"), "absolute");
  assert.equal(classifyRef("~/code/x"), "absolute");
  assert.equal(classifyRef("https://github.com/x/y.git"), "remote");
  assert.equal(classifyRef("ssh://git@host/x"), "remote");
  assert.equal(classifyRef("git@host:org/repo.git"), "remote");
});

// ---------------------------------------------------------------------------
// resolveOwnRef
// ---------------------------------------------------------------------------

test("resolveOwnRef: ws-relative to a real project → ok + uid + lifecycle", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const child = tw.addProject("Child");
  const r = resolveOwnRef(tw.ws, {
    ref: "Child",
    kind: "subproject",
    name: null,
    lifecycle: null,
  });
  assert.equal(r.status, "ok");
  assert.equal(r.uid, child.uid);
  assert.equal(r.shape, "ws-relative");
  assert.equal(r.lifecycle, "active");
  assert.equal(path.resolve(r.localPath ?? ""), path.resolve(child.root));
});

test("resolveOwnRef: ws-relative to a bare dir with kind:code → not-a-project (healthy), edge lifecycle", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  fs.mkdirSync(path.join(tw.root, "bare-repo"));
  const r = resolveOwnRef(tw.ws, {
    ref: "bare-repo",
    kind: "code",
    name: null,
    lifecycle: "dormant",
  });
  assert.equal(r.status, "not-a-project");
  assert.equal(r.uid, null);
  assert.equal(r.lifecycle, "dormant");
});

test("resolveOwnRef: missing path → missing", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const r = resolveOwnRef(tw.ws, {
    ref: "does-not-exist",
    kind: "subproject",
    name: null,
    lifecycle: null,
  });
  assert.equal(r.status, "missing");
  assert.equal(r.uid, null);
});

test("resolveOwnRef: remote URL → remote, no FS access, edge lifecycle preserved", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const r = resolveOwnRef(tw.ws, {
    ref: "https://github.com/x/y.git",
    kind: "remote",
    name: null,
    lifecycle: "archived",
  });
  assert.equal(r.status, "remote");
  assert.equal(r.localPath, null);
  assert.equal(r.uid, null);
  assert.equal(r.lifecycle, "archived");
});

test("resolveOwnRef: kind:remote with a path-shaped ref is still treated as remote", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const r = resolveOwnRef(tw.ws, {
    ref: "some/local/looking/path",
    kind: "remote",
    name: null,
    lifecycle: null,
  });
  assert.equal(r.status, "remote");
  assert.equal(r.localPath, null);
});

// ---------------------------------------------------------------------------
// buildOwnershipGraph
// ---------------------------------------------------------------------------

test("buildOwnershipGraph: two owners pointing at the same child → ownersByChildKey length 2", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const child = tw.addProject("Child");
  const a = tw.addProject("OwnerA");
  const b = tw.addProject("OwnerB");
  writeOwns(a.root, [{ ref: "Child", kind: "subproject", name: null, lifecycle: null }]);
  writeOwns(b.root, [{ ref: "Child", kind: "subproject", name: null, lifecycle: null }]);

  const graph = buildOwnershipGraph(tw.ws);
  const owners = graph.ownersByChildKey.get(child.uid);
  assert.ok(owners !== undefined);
  assert.equal(owners?.length, 2);
  assert.ok(owners?.includes("OwnerA"));
  assert.ok(owners?.includes("OwnerB"));
});

test("buildOwnershipGraph: malformed edge problems prefixed with owner relPath", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const p = tw.addProject("Parent");
  writeProjectToml(p.root, `[[owns]]\nref = "X"\nkind = "bogus"\n`);
  const graph = buildOwnershipGraph(tw.ws);
  assert.ok(graph.problems.some((p) => /^Parent: /.test(p) && /bad kind/.test(p)));
});

// ---------------------------------------------------------------------------
// detectCycle (pure unit)
// ---------------------------------------------------------------------------

test("detectCycle: A→B→C→A returns a cycle; a DAG returns none", () => {
  const cyclic = new Map<string, string[]>([
    ["A", ["B"]],
    ["B", ["C"]],
    ["C", ["A"]],
  ]);
  const cycle = detectCycle(cyclic);
  assert.ok(cycle !== null);
  assert.equal(cycle?.[0], cycle?.[cycle.length - 1]); // closes the loop

  const dag = new Map<string, string[]>([
    ["A", ["B", "C"]],
    ["B", ["C"]],
    ["C", []],
  ]);
  assert.equal(detectCycle(dag), null);
});
