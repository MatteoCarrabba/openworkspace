import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import {
  STORE_DIR_ENV,
  activationRecordPath,
  activationsDir,
  defaultStoreDir,
  dropUidCacheEntry,
  machineId,
  mintLocksDir,
  openMachineStore,
  readKnownWorkspaces,
  readRunnerNode,
  readUidCache,
  registerWorkspace,
  writeRunnerNode,
  writeUidCacheEntry,
} from "../src/lib/machine.js";
import { ConfigError } from "../src/lib/errors.js";
import { makeTmpDir, makeTmpStore, rmrf } from "./helpers.js";

test("store dir is injectable: explicit path and env override; default only as last resort", (t) => {
  const dir = makeTmpDir();
  t.after(() => rmrf(dir));
  assert.equal(defaultStoreDir({ [STORE_DIR_ENV]: dir }), path.resolve(dir));
  const fallback = defaultStoreDir({});
  assert.ok(fallback.endsWith(path.join("Library", "Application Support", "OpenWorkspace")));

  const store = openMachineStore(undefined, { [STORE_DIR_ENV]: dir });
  assert.equal(store.dir, path.resolve(dir));
  assert.ok(fs.statSync(mintLocksDir(store)).isDirectory());
  assert.ok(fs.statSync(activationsDir(store)).isDirectory());
});

test("machineId mints once, then is stable across reads", (t) => {
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  const first = machineId(store);
  assert.match(first, /^[a-z0-9][a-z0-9-]*$/);
  assert.equal(machineId(store), first);
  // survives a fresh open of the same dir
  const reopened = openMachineStore(store.dir);
  assert.equal(machineId(reopened), first);
});

test("machineId respects a hand-placed id (e.g. 'mini')", (t) => {
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  fs.writeFileSync(path.join(store.dir, "machine-id"), "mini\n");
  assert.equal(machineId(store), "mini");
});

test("UID cache: read/write/drop round-trip; corrupt cache reads as empty (rebuildable)", (t) => {
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  assert.deepEqual(readUidCache(store), {});
  writeUidCacheEntry(store, "uid-a", "/tmp/somewhere/Project A");
  writeUidCacheEntry(store, "uid-b", "/tmp/elsewhere/Project B");
  assert.deepEqual(readUidCache(store), {
    "uid-a": "/tmp/somewhere/Project A",
    "uid-b": "/tmp/elsewhere/Project B",
  });
  dropUidCacheEntry(store, "uid-a");
  assert.deepEqual(readUidCache(store), { "uid-b": "/tmp/elsewhere/Project B" });

  fs.writeFileSync(path.join(store.dir, "uid-cache.json"), "{not json");
  assert.deepEqual(readUidCache(store), {});
});

test("known workspaces: registration is idempotent and path-normalized", (t) => {
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  const wsDir = makeTmpDir();
  t.after(() => rmrf(wsDir));
  assert.deepEqual(readKnownWorkspaces(store), []);
  registerWorkspace(store, wsDir);
  registerWorkspace(store, wsDir + path.sep); // same dir, unnormalized
  assert.deepEqual(readKnownWorkspaces(store), [path.resolve(wsDir)]);
});

test("runner-node (decision-1): set/read/clear round-trip; the path is normalized and persisted", (t) => {
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  const binDir = makeTmpDir("ow-runner-node-");
  t.after(() => rmrf(binDir));
  const nodeBin = path.join(binDir, "node");
  fs.writeFileSync(nodeBin, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(nodeBin, 0o755);

  assert.equal(readRunnerNode(store), null); // unset = the fallback posture
  writeRunnerNode(store, nodeBin);
  assert.equal(readRunnerNode(store), nodeBin);
  // survives a fresh open of the same dir (a machine-local FILE, like mint-suffix)
  assert.equal(readRunnerNode(openMachineStore(store.dir)), nodeBin);
  // clear is idempotent
  writeRunnerNode(store, null);
  assert.equal(readRunnerNode(store), null);
  writeRunnerNode(store, null);
  assert.equal(readRunnerNode(store), null);
});

test("runner-node: setting validates existence, file-ness, and executability", (t) => {
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  const dir = makeTmpDir("ow-runner-node-");
  t.after(() => rmrf(dir));

  assert.throws(() => writeRunnerNode(store, path.join(dir, "missing")), (err: unknown) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /does not exist/);
    return true;
  });
  assert.throws(() => writeRunnerNode(store, dir), /not a regular file/); // a directory
  const notExec = path.join(dir, "node");
  fs.writeFileSync(notExec, "not a binary\n");
  fs.chmodSync(notExec, 0o644);
  assert.throws(() => writeRunnerNode(store, notExec), /not executable/);
  // nothing was persisted by any failed set
  assert.equal(readRunnerNode(store), null);
});

test("activation record paths are partitioned per project-UID + name", (t) => {
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  const p = activationRecordPath(store, "uid-1", "daily-brief");
  assert.equal(path.dirname(p), activationsDir(store));
  assert.equal(path.basename(p), "uid-1--daily-brief.toml");
});
