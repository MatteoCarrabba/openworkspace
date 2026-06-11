import * as assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { ConfigError, LockError } from "../src/lib/errors.js";
import {
  formatId,
  idFromFilename,
  mintId,
  nextChild,
  nextTopLevel,
  parseId,
  withMintLock,
} from "../src/lib/ids.js";
import { makeTmpDir, makeTmpStore, rmrf } from "./helpers.js";

const execFileAsync = promisify(execFile);

function touchTask(dir: string, id: string, slug = "slug"): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id} - ${slug}.md`), `---\nid: ${id}\n---\n`);
}

test("parseId / formatId / idFromFilename", () => {
  assert.deepEqual(parseId("task-36"), { prefix: "task", parts: [36], machineSuffix: null });
  assert.deepEqual(parseId("task-36.7"), { prefix: "task", parts: [36, 7], machineSuffix: null });
  assert.deepEqual(parseId("task-7-mini"), { prefix: "task", parts: [7], machineSuffix: "mini" });
  assert.deepEqual(parseId("decision-3"), { prefix: "decision", parts: [3], machineSuffix: null });
  assert.equal(parseId("reminder-9"), null);
  assert.equal(parseId("task-"), null);

  assert.equal(formatId("task", [36, 7]), "task-36.7");
  assert.equal(formatId("task", [7], "mini"), "task-7-mini");

  assert.deepEqual(idFromFilename("task-18.2 - Decide-things.md"), {
    prefix: "task",
    parts: [18, 2],
    machineSuffix: null,
  });
  assert.equal(idFromFilename("README.md"), null);
});

test("nextTopLevel: max over provided tree paths, dotted IDs count via their first component", (t) => {
  const a = makeTmpDir();
  const b = makeTmpDir();
  t.after(() => {
    rmrf(a);
    rmrf(b);
  });
  touchTask(a, "task-3");
  touchTask(a, "task-18.2"); // implies task-18 exists conceptually
  touchTask(b, "task-12");
  touchTask(b, "decision-40"); // different prefix, must not affect tasks
  assert.equal(nextTopLevel([a, b], "task"), 19);
  assert.equal(nextTopLevel([a, b], "decision"), 41);
  assert.equal(nextTopLevel([a, b, path.join(a, "missing-dir")], "task"), 19, "missing dirs contribute nothing");
  assert.equal(nextTopLevel([path.join(a, "missing-dir")], "task"), 1);
});

test("nextChild mints dotted subtask numbers under the parent only", (t) => {
  const dir = makeTmpDir();
  t.after(() => rmrf(dir));
  touchTask(dir, "task-36");
  touchTask(dir, "task-36.1");
  touchTask(dir, "task-36.5");
  touchTask(dir, "task-36.5.2"); // grandchild, not a direct child
  touchTask(dir, "task-37.9"); // different parent
  assert.equal(nextChild([dir], "task-36"), 6);
  assert.equal(nextChild([dir], "task-36.5"), 3);
  assert.equal(nextChild([dir], "task-99"), 1);
  assert.throws(() => nextChild([dir], "garbage"), ConfigError);
});

test("mintId mints sequentially and the claim makes it visible to the next probe", (t) => {
  const dir = makeTmpDir();
  const { store, cleanup } = makeTmpStore();
  t.after(() => {
    rmrf(dir);
    cleanup();
  });
  const claim = (id: string) => touchTask(dir, id);
  const id1 = mintId(store, "uid-x", { prefix: "task", treePaths: [dir], claim });
  const id2 = mintId(store, "uid-x", { prefix: "task", treePaths: [dir], claim });
  assert.equal(id1, "task-1");
  assert.equal(id2, "task-2");
  const child = mintId(store, "uid-x", { prefix: "task", treePaths: [dir], parentId: "task-2", claim });
  assert.equal(child, "task-2.1");
  const suffixed = mintId(store, "uid-x", {
    prefix: "task",
    treePaths: [dir],
    machineSuffix: "mini",
    claim,
  });
  assert.equal(suffixed, "task-3-mini");
  // the suffixed id still advances the sequence
  assert.equal(mintId(store, "uid-x", { prefix: "task", treePaths: [dir], claim }), "task-4");
});

test("max-probe across worktree + canonical trees prevents branch-divergent reissue", (t) => {
  const worktreeTasks = makeTmpDir();
  const canonicalTasks = makeTmpDir();
  const { store, cleanup } = makeTmpStore();
  t.after(() => {
    rmrf(worktreeTasks);
    rmrf(canonicalTasks);
    cleanup();
  });
  touchTask(worktreeTasks, "task-4"); // stale branch snapshot
  touchTask(canonicalTasks, "task-9"); // canonical has moved on
  const id = mintId(store, "uid-y", {
    prefix: "task",
    treePaths: [worktreeTasks, canonicalTasks],
    claim: (mintedId) => touchTask(worktreeTasks, mintedId),
  });
  assert.equal(id, "task-10");
});

test("withMintLock: serializes, releases on throw, and steals stale locks", (t) => {
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  const result = withMintLock(store, "uid-z", () => "ran");
  assert.equal(result, "ran");
  assert.throws(
    () =>
      withMintLock(store, "uid-z", () => {
        throw new Error("boom");
      }),
    /boom/,
  );
  // lock released after the throw → an immediate re-acquire succeeds
  assert.equal(withMintLock(store, "uid-z", () => "again"), "again");

  // a crashed holder's lock (old mtime) is stolen
  const lockDir = path.join(store.dir, "mint-locks", "uid-z.lock");
  fs.mkdirSync(lockDir);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockDir, old, old);
  assert.equal(
    withMintLock(store, "uid-z", () => "stolen", { staleMs: 30_000, timeoutMs: 1_000 }),
    "stolen",
  );

  // a fresh foreign lock times out with LockError
  fs.mkdirSync(lockDir);
  assert.throws(
    () => withMintLock(store, "uid-z", () => "nope", { timeoutMs: 150, staleMs: 60_000 }),
    LockError,
  );
  fs.rmdirSync(lockDir);
});

test("concurrent mint stress: two parallel processes never collide", async (t) => {
  const tasksDir = makeTmpDir("openworkspace-mint-stress-");
  const { store, cleanup } = makeTmpStore();
  t.after(() => {
    rmrf(tasksDir);
    cleanup();
  });

  const idsModule = path.resolve(__dirname, "..", "src", "lib", "ids.js");
  const machineModule = path.resolve(__dirname, "..", "src", "lib", "machine.js");
  const script = `
    const fs = require("node:fs");
    const path = require("node:path");
    const { mintId } = require(${JSON.stringify(idsModule)});
    const { openMachineStore } = require(${JSON.stringify(machineModule)});
    const [storeDir, tasksDir, who] = process.argv.slice(1);
    const store = openMachineStore(storeDir);
    for (let i = 0; i < 25; i++) {
      mintId(store, "uid-stress", {
        prefix: "task",
        treePaths: [tasksDir],
        claim: (id) => {
          const file = path.join(tasksDir, id + " - from-" + who + ".md");
          fs.writeFileSync(file, "---\\nid: " + id + "\\n---\\n", { flag: "wx" });
        },
      });
    }
  `;
  await Promise.all([
    execFileAsync(process.execPath, ["-e", script, "--", store.dir, tasksDir, "a"]),
    execFileAsync(process.execPath, ["-e", script, "--", store.dir, tasksDir, "b"]),
  ]);

  const files = fs.readdirSync(tasksDir);
  assert.equal(files.length, 50, "every mint produced exactly one file (wx would have thrown on collision)");
  const ids = files.map((f) => f.split(" ")[0]).sort();
  assert.equal(new Set(ids).size, 50, "all 50 minted IDs are unique");
  const numbers = ids.map((id) => Number.parseInt((id as string).slice("task-".length), 10)).sort((x, y) => x - y);
  assert.deepEqual(numbers, Array.from({ length: 50 }, (_, i) => i + 1), "sequence is dense 1..50");
});

// ---------------------------------------------------------------------------
// Regressions: the stale-lock steal race and machine-suffix composition
// ---------------------------------------------------------------------------

test("regression: dotted children compose the parent's FULL identity (machine suffix included)", (t) => {
  const tasksDir = makeTmpDir();
  const { store, cleanup } = makeTmpStore();
  t.after(() => {
    rmrf(tasksDir);
    cleanup();
  });

  // a Mini-synced suffixed task: its child must inherit -mini, never orphan
  // under a (nonexistent or WRONG) plain task-7
  touchTask(tasksDir, "task-7-mini");
  const child = mintId(store, "uid-sfx", {
    prefix: "task",
    treePaths: [tasksDir],
    parentId: "task-7-mini",
    claim: (id) => touchTask(tasksDir, id),
  });
  assert.equal(child, "task-7.1-mini");

  // a suffixed MINTING MACHINE adds its own suffix under a plain parent...
  touchTask(tasksDir, "task-1");
  const miniChild = mintId(store, "uid-sfx", {
    prefix: "task",
    treePaths: [tasksDir],
    parentId: "task-1",
    machineSuffix: "mini",
    claim: (id) => touchTask(tasksDir, id),
  });
  assert.equal(miniChild, "task-1.1-mini");

  // ...but never double-suffixes a suffixed parent
  const deeper = mintId(store, "uid-sfx", {
    prefix: "task",
    treePaths: [tasksDir],
    parentId: "task-7-mini",
    machineSuffix: "mini",
    claim: (id) => touchTask(tasksDir, id),
  });
  assert.equal(deeper, "task-7.2-mini");
});

test("regression: stale-lock steal under contention — exactly one stealer wins, no duplicate IDs", async (t) => {
  // The crashed-holder + fan-out scenario: a stale lock dir is already in the
  // store when SIX minters arrive at once. The old rmdir-based steal let a
  // slow second stealer remove the first stealer's freshly re-acquired lock
  // (two concurrent holders → duplicate IDs); the rename-based steal admits
  // exactly one.
  const tasksDir = makeTmpDir("openworkspace-steal-stress-");
  const { store, cleanup } = makeTmpStore();
  t.after(() => {
    rmrf(tasksDir);
    cleanup();
  });

  const lockDir = path.join(store.dir, "mint-locks", "uid-steal.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(lockDir, old, old); // a crashed holder, well past staleMs

  const idsModule = path.resolve(__dirname, "..", "src", "lib", "ids.js");
  const machineModule = path.resolve(__dirname, "..", "src", "lib", "machine.js");
  const script = `
    const fs = require("node:fs");
    const path = require("node:path");
    const { mintId } = require(${JSON.stringify(idsModule)});
    const { openMachineStore } = require(${JSON.stringify(machineModule)});
    const [storeDir, tasksDir, who] = process.argv.slice(1);
    const store = openMachineStore(storeDir);
    for (let i = 0; i < 8; i++) {
      mintId(store, "uid-steal", {
        prefix: "task",
        treePaths: [tasksDir],
        lock: { staleMs: 30_000, timeoutMs: 20_000 },
        claim: (id) => {
          const file = path.join(tasksDir, id + " - race-" + who + ".md");
          fs.writeFileSync(file, "---\\nid: " + id + "\\n---\\n", { flag: "wx" });
        },
      });
    }
  `;
  await Promise.all(
    ["a", "b", "c", "d", "e", "f"].map((who) =>
      execFileAsync(process.execPath, ["-e", script, "--", store.dir, tasksDir, who]),
    ),
  );

  const files = fs.readdirSync(tasksDir);
  assert.equal(files.length, 48, "every mint produced exactly one file");
  const ids = files.map((f) => f.split(" ")[0]);
  assert.equal(new Set(ids).size, 48, "no duplicate IDs minted across 6 contenders");
  const numbers = ids.map((id) => Number.parseInt((id as string).slice("task-".length), 10)).sort((x, y) => x - y);
  assert.deepEqual(numbers, Array.from({ length: 48 }, (_, i) => i + 1), "sequence dense 1..48");
});
