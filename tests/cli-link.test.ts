/**
 * CLI end-to-end tests for the project-graph verbs: link add/rm/list, tree,
 * new --parent, home list --owner. Spawns the compiled cli.js against temp
 * workspaces (machine store injected via OPENWORKSPACE_STORE_DIR).
 */

import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { readOwns } from "../src/lib/workspace.js";
import { makeTmpDir, rmrf } from "./helpers.js";

const CLI = path.resolve(__dirname, "..", "src", "cli.js");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd: string, storeDir: string): RunResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, OPENWORKSPACE_STORE_DIR: storeDir, OW_ACTOR: "cli-test" },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

interface Fixture {
  root: string;
  storeDir: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const root = makeTmpDir("ow-link-ws-");
  const storeDir = makeTmpDir("ow-link-store-");
  const init = run(["home", "init"], root, storeDir);
  assert.equal(init.status, 0, init.stderr);
  return {
    root,
    storeDir,
    cleanup: () => {
      rmrf(root);
      rmrf(storeDir);
    },
  };
}

test("cli link add: writes the edge to the OWNER's project.toml", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  assert.equal(run(["new", "Parent"], fx.root, fx.storeDir).status, 0);
  assert.equal(run(["new", "Child"], fx.root, fx.storeDir).status, 0);

  const add = run(["link", "add", "Child", "--project", "Parent"], fx.root, fx.storeDir);
  assert.equal(add.status, 0, add.stderr);

  const owns = readOwns(path.join(fx.root, "Parent")).owns;
  assert.equal(owns.length, 1);
  assert.equal(owns[0]?.ref, "Child");
  assert.equal(owns[0]?.kind, "subproject");
  // the child carries NO owns edge (edge is parent-canonical)
  assert.equal(readOwns(path.join(fx.root, "Child")).owns.length, 0);
});

test("cli link add: kind/lifecycle validation; bad values fail with exit 1", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  assert.equal(run(["new", "Parent"], fx.root, fx.storeDir).status, 0);

  const badKind = run(["link", "add", "X", "--project", "Parent", "--kind", "nope"], fx.root, fx.storeDir);
  assert.equal(badKind.status, 1);
  assert.match(badKind.stderr, /bad --kind/);

  const badLc = run(
    ["link", "add", "/tmp/x", "--project", "Parent", "--kind", "code", "--lifecycle", "weird"],
    fx.root,
    fx.storeDir,
  );
  assert.equal(badLc.status, 1);
  assert.match(badLc.stderr, /bad --lifecycle/);
});

test("cli link add: duplicate ref → conflict; self-link → config error", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  assert.equal(run(["new", "Parent"], fx.root, fx.storeDir).status, 0);
  assert.equal(run(["new", "Child"], fx.root, fx.storeDir).status, 0);
  assert.equal(run(["link", "add", "Child", "--project", "Parent"], fx.root, fx.storeDir).status, 0);

  const dup = run(["link", "add", "Child", "--project", "Parent"], fx.root, fx.storeDir);
  assert.equal(dup.status, 1);
  assert.match(dup.stderr, /already exists/);

  const self = run(["link", "add", "Parent", "--project", "Parent"], fx.root, fx.storeDir);
  assert.equal(self.status, 1);
  assert.match(self.stderr, /self-link/);
});

test("cli link add: refuses a cycle-creating edge", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  assert.equal(run(["new", "A"], fx.root, fx.storeDir).status, 0);
  assert.equal(run(["new", "B"], fx.root, fx.storeDir).status, 0);
  assert.equal(run(["link", "add", "B", "--project", "A"], fx.root, fx.storeDir).status, 0);

  const cycle = run(["link", "add", "A", "--project", "B"], fx.root, fx.storeDir);
  assert.equal(cycle.status, 1);
  assert.match(cycle.stderr, /cycle/);
});

test("cli link rm: removes the edge; rm of absent ref → not found", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  assert.equal(run(["new", "Parent"], fx.root, fx.storeDir).status, 0);
  assert.equal(run(["new", "Child"], fx.root, fx.storeDir).status, 0);
  assert.equal(run(["link", "add", "Child", "--project", "Parent"], fx.root, fx.storeDir).status, 0);

  const rm = run(["link", "rm", "Child", "--project", "Parent"], fx.root, fx.storeDir);
  assert.equal(rm.status, 0, rm.stderr);
  assert.equal(readOwns(path.join(fx.root, "Parent")).owns.length, 0);

  const rmAbsent = run(["link", "rm", "Nope", "--project", "Parent"], fx.root, fx.storeDir);
  assert.equal(rmAbsent.status, 1);
  assert.match(rmAbsent.stderr, /no owns edge/);
});

test("cli link list: shows resolved status for subproject/code/remote (json)", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  assert.equal(run(["new", "Parent"], fx.root, fx.storeDir).status, 0);
  assert.equal(run(["new", "Child"], fx.root, fx.storeDir).status, 0);
  const bare = path.join(fx.root, "bare");
  fs.mkdirSync(bare);
  assert.equal(run(["link", "add", "Child", "--project", "Parent"], fx.root, fx.storeDir).status, 0);
  assert.equal(
    run(["link", "add", "bare", "--project", "Parent", "--kind", "code"], fx.root, fx.storeDir).status,
    0,
  );
  assert.equal(
    run(["link", "add", "https://x/y.git", "--project", "Parent", "--kind", "remote"], fx.root, fx.storeDir)
      .status,
    0,
  );

  const list = run(["link", "list", "--project", "Parent", "--json"], fx.root, fx.storeDir);
  assert.equal(list.status, 0, list.stderr);
  const parsed = JSON.parse(list.stdout) as Array<{ status: string; edge: { kind: string } }>;
  assert.equal(parsed.length, 3);
  const byKind = Object.fromEntries(parsed.map((r) => [r.edge.kind, r.status]));
  assert.equal(byKind["subproject"], "ok");
  assert.equal(byKind["code"], "not-a-project");
  assert.equal(byKind["remote"], "remote");
});

test("cli new --parent: creates the child and appends a ws-relative edge to the parent", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  assert.equal(run(["new", "Parent"], fx.root, fx.storeDir).status, 0);

  const out = run(["new", "Child", "--parent", "Parent", "--json"], fx.root, fx.storeDir);
  assert.equal(out.status, 0, out.stderr);
  const parsed = JSON.parse(out.stdout) as { parent: string };
  // resolveProject may realpath (/private/var vs /var on macOS) — compare basename.
  assert.equal(path.basename(parsed.parent), "Parent");

  const owns = readOwns(path.join(fx.root, "Parent")).owns;
  assert.equal(owns.length, 1);
  assert.equal(owns[0]?.ref, "Child");

  // and the edge resolves to the child via link list
  const list = run(["link", "list", "--project", "Parent", "--json"], fx.root, fx.storeDir);
  const lparsed = JSON.parse(list.stdout) as Array<{ status: string; uid: string | null }>;
  assert.equal(lparsed[0]?.status, "ok");
});

test("cli new --parent --kind code links an existing-style code child", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  assert.equal(run(["new", "Parent"], fx.root, fx.storeDir).status, 0);
  // a child created in-tree but declared as kind code
  assert.equal(run(["new", "Tool", "--parent", "Parent", "--kind", "code"], fx.root, fx.storeDir).status, 0);
  const owns = readOwns(path.join(fx.root, "Parent")).owns;
  assert.equal(owns[0]?.kind, "code");
});

test("cli home list --owner: returns only that parent's subproject children", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  assert.equal(run(["new", "Parent"], fx.root, fx.storeDir).status, 0);
  assert.equal(run(["new", "Child"], fx.root, fx.storeDir).status, 0);
  assert.equal(run(["new", "Other"], fx.root, fx.storeDir).status, 0);
  assert.equal(run(["link", "add", "Child", "--project", "Parent"], fx.root, fx.storeDir).status, 0);

  const list = run(["home", "list", "--owner", "Parent", "--json"], fx.root, fx.storeDir);
  assert.equal(list.status, 0, list.stderr);
  const parsed = JSON.parse(list.stdout) as Array<{ relPath: string }>;
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.relPath, "Child");
});

test("cli tree: renders parent→child indentation; tags a cycle and terminates", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  assert.equal(run(["new", "Parent"], fx.root, fx.storeDir).status, 0);
  assert.equal(run(["new", "Child"], fx.root, fx.storeDir).status, 0);
  assert.equal(run(["link", "add", "Child", "--project", "Parent"], fx.root, fx.storeDir).status, 0);

  const tree = run(["tree", "--project", "Parent"], fx.root, fx.storeDir);
  assert.equal(tree.status, 0, tree.stderr);
  assert.match(tree.stdout, /Parent \(active\)/);
  assert.match(tree.stdout, /\n {2}Child \(active\)/);

  // Force a cycle by hand-editing the children's owns (bypass the add-time guard),
  // then assert tree still terminates and tags the cycle.
  fs.writeFileSync(
    path.join(fx.root, "Child", "_project", "project.toml"),
    `[[owns]]\nref = "Parent"\nkind = "subproject"\n`,
  );
  const cycleTree = run(["tree", "--project", "Parent"], fx.root, fx.storeDir);
  assert.equal(cycleTree.status, 0, cycleTree.stderr);
  assert.match(cycleTree.stdout, /\(cycle\)/);
});

test("cli home list --owner: a child reachable via two refs is de-duped (appears once in aggregation)", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  assert.equal(run(["new", "Parent"], fx.root, fx.storeDir).status, 0);
  assert.equal(run(["new", "Child"], fx.root, fx.storeDir).status, 0);
  // Two DISTINCT refs that resolve to the SAME child (relative + absolute path).
  assert.equal(run(["link", "add", "Child", "--project", "Parent"], fx.root, fx.storeDir).status, 0);
  assert.equal(
    run(["link", "add", path.join(fx.root, "Child"), "--project", "Parent", "--kind", "subproject"], fx.root, fx.storeDir)
      .status,
    0,
  );

  const list = run(["home", "list", "--owner", "Parent", "--json"], fx.root, fx.storeDir);
  assert.equal(list.status, 0, list.stderr);
  const parsed = JSON.parse(list.stdout) as Array<{ relPath: string }>;
  // De-duped by resolved identity: Child appears exactly once, not twice.
  assert.equal(parsed.length, 1, list.stdout);
  assert.equal(parsed[0]?.relPath, "Child");
});

test("cli tree (default, no --project): renders a whole-graph cycle (no acyclic root) tagged + terminating", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  assert.equal(run(["new", "Foo"], fx.root, fx.storeDir).status, 0);
  assert.equal(run(["new", "Bar"], fx.root, fx.storeDir).status, 0);
  // Foo owns Bar; Bar owns Foo — a 2-cycle where EVERY node is someone's child,
  // so the old roots-only computation dropped the whole SCC. Hand-edit Bar's
  // owns to bypass the add-time cycle guard.
  assert.equal(run(["link", "add", "Bar", "--project", "Foo"], fx.root, fx.storeDir).status, 0);
  fs.writeFileSync(
    path.join(fx.root, "Bar", "_project", "project.toml"),
    `[[owns]]\nref = "Foo"\nkind = "subproject"\n`,
  );

  const tree = run(["tree"], fx.root, fx.storeDir);
  assert.equal(tree.status, 0, tree.stderr);
  // Both cycle members must still appear (not silently dropped) ...
  assert.match(tree.stdout, /Foo/);
  assert.match(tree.stdout, /Bar/);
  // ... and the cycle must be tagged (proves termination).
  assert.match(tree.stdout, /\(cycle\)/);
});

test("cli tree (default): a self-loop (X owns X) renders once, tagged (cycle)", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  assert.equal(run(["new", "Solo"], fx.root, fx.storeDir).status, 0);
  // Hand-edit a self-owning edge (the add-time self-link guard would refuse it).
  fs.writeFileSync(
    path.join(fx.root, "Solo", "_project", "project.toml"),
    `[[owns]]\nref = "Solo"\nkind = "subproject"\n`,
  );

  const tree = run(["tree"], fx.root, fx.storeDir);
  assert.equal(tree.status, 0, tree.stderr);
  // "Solo" appears: once as the rendered root, once as the cycle back-edge.
  const occurrences = tree.stdout.split("\n").filter((l) => /Solo/.test(l));
  assert.equal(occurrences.length, 2, tree.stdout);
  assert.match(tree.stdout, /Solo \(cycle\)/);
});

test("cli tree: a child owned by two parents expands once; the second is a back-reference (no re-expansion)", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  assert.equal(run(["new", "OwnerA"], fx.root, fx.storeDir).status, 0);
  assert.equal(run(["new", "OwnerB"], fx.root, fx.storeDir).status, 0);
  assert.equal(run(["new", "Shared"], fx.root, fx.storeDir).status, 0);
  assert.equal(run(["new", "Grandchild"], fx.root, fx.storeDir).status, 0);
  // Shared owns Grandchild; both OwnerA and OwnerB own Shared.
  assert.equal(run(["link", "add", "Grandchild", "--project", "Shared"], fx.root, fx.storeDir).status, 0);
  assert.equal(run(["link", "add", "Shared", "--project", "OwnerA"], fx.root, fx.storeDir).status, 0);
  assert.equal(run(["link", "add", "Shared", "--project", "OwnerB"], fx.root, fx.storeDir).status, 0);

  const tree = run(["tree"], fx.root, fx.storeDir);
  assert.equal(tree.status, 0, tree.stderr);
  const lines = tree.stdout.split("\n");
  // Shared appears under both owners (twice) but Grandchild is expanded only ONCE
  // (under the first owner); the second Shared is a back-reference (↗) and does
  // NOT re-print Grandchild.
  assert.equal(lines.filter((l) => /Shared/.test(l)).length, 2, tree.stdout);
  assert.equal(lines.filter((l) => /Grandchild/.test(l)).length, 1, tree.stdout);
  assert.match(tree.stdout, /Shared ↗/);
  assert.match(tree.stdout, /also owned by/);
});

test("cli tree: a code child shared by two parents prints once + back-reference (legal sharing)", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  assert.equal(run(["new", "OwnerA"], fx.root, fx.storeDir).status, 0);
  assert.equal(run(["new", "OwnerB"], fx.root, fx.storeDir).status, 0);
  const bare = path.join(fx.root, "shared-repo");
  fs.mkdirSync(bare);
  assert.equal(
    run(["link", "add", "shared-repo", "--project", "OwnerA", "--kind", "code"], fx.root, fx.storeDir).status,
    0,
  );
  assert.equal(
    run(["link", "add", "shared-repo", "--project", "OwnerB", "--kind", "code"], fx.root, fx.storeDir).status,
    0,
  );

  const tree = run(["tree"], fx.root, fx.storeDir);
  assert.equal(tree.status, 0, tree.stderr);
  const lines = tree.stdout.split("\n");
  // The code leaf line: one full "(not-a-project)" entry + one "↗ (also owned)".
  const sharedLines = lines.filter((l) => /shared-repo \[code\]/.test(l));
  assert.equal(sharedLines.length, 2, tree.stdout);
  assert.equal(sharedLines.filter((l) => /↗/.test(l)).length, 1, tree.stdout);
});

test("cli link add: self-link is refused OUTSIDE a workspace (best-effort path guard)", (t) => {
  // A standalone project with NO enclosing .openworkspace/ workspace.
  const dir = makeTmpDir("ow-standalone-");
  const storeDir = makeTmpDir("ow-standalone-store-");
  t.after(() => {
    rmrf(dir);
    rmrf(storeDir);
  });
  const proj = path.join(dir, "Solo");
  // `new` without a workspace: init the project directly via init then link.
  assert.equal(run(["init", proj], dir, storeDir).status, 0, "init standalone project");

  // Self-link by absolute path: child resolves to the owner itself.
  const self = run(["link", "add", proj, "--project", proj, "--kind", "subproject"], dir, storeDir);
  assert.equal(self.status, 1, self.stdout);
  assert.match(self.stderr, /self-link/);

  // Self-link by "." (resolves against owner root) is also refused.
  const selfDot = run(["link", "add", ".", "--project", proj, "--kind", "subproject"], dir, storeDir);
  assert.equal(selfDot.status, 1, selfDot.stdout);
  assert.match(selfDot.stderr, /self-link/);
});

test("cli link: unknown subcommand fails with config error", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  assert.equal(run(["new", "Parent"], fx.root, fx.storeDir).status, 0);
  const bad = run(["link", "frobnicate", "--project", "Parent"], fx.root, fx.storeDir);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown link subcommand/);
});
