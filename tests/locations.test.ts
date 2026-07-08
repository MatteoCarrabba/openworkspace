import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import {
  configuredWorkspaceRoot,
  defaultConfigDir,
  loadLocationStores,
  locationsFilePath,
} from "../src/lib/locations.js";
import { makeTmpDir, rmrf } from "./helpers.js";

/** A temp dir standing in for ~/.config/openworkspace, via the env override. */
function makeConfigEnv(locationsToml?: string): { env: NodeJS.ProcessEnv; dir: string; cleanup: () => void } {
  const dir = makeTmpDir("ow-config-dir-");
  if (locationsToml !== undefined) {
    fs.writeFileSync(path.join(dir, "locations.toml"), locationsToml);
  }
  return { env: { OPENWORKSPACE_CONFIG_DIR: dir }, dir, cleanup: () => rmrf(dir) };
}

test("locations: no config dir override defaults under ~/.config/openworkspace", () => {
  const dir = defaultConfigDir({});
  assert.ok(dir.endsWith(path.join(".config", "openworkspace")));
});

test("locations: OPENWORKSPACE_CONFIG_DIR override is honored and resolved absolute", () => {
  const env = { OPENWORKSPACE_CONFIG_DIR: "relative/dir" };
  assert.equal(defaultConfigDir(env), path.resolve("relative/dir"));
  assert.equal(locationsFilePath(env), path.join(path.resolve("relative/dir"), "locations.toml"));
});

test("locations: absent file means no stores (forgiving, like loadWorkspaceConfig)", (t) => {
  const cfg = makeConfigEnv(); // no file written
  t.after(cfg.cleanup);
  assert.deepEqual(loadLocationStores(cfg.env), []);
  assert.equal(configuredWorkspaceRoot(cfg.env), null);
});

test("locations: malformed TOML reads as absent — never throws", (t) => {
  const cfg = makeConfigEnv("this is not [ valid toml =====");
  t.after(cfg.cleanup);
  assert.deepEqual(loadLocationStores(cfg.env), []);
  assert.equal(configuredWorkspaceRoot(cfg.env), null);
});

test("locations: a well-formed one-entry file parses to a single localfs store", (t) => {
  const wsRoot = makeTmpDir("ow-ws-root-");
  t.after(() => rmrf(wsRoot));
  const cfg = makeConfigEnv(
    ['[[stores]]', `name = "personal"`, `driver = "localfs"`, `path = "${wsRoot.replace(/\\/g, "\\\\")}"`, ""].join(
      "\n",
    ),
  );
  t.after(cfg.cleanup);
  const stores = loadLocationStores(cfg.env);
  assert.deepEqual(stores, [{ name: "personal", driver: "localfs", path: wsRoot }]);
  assert.equal(configuredWorkspaceRoot(cfg.env), wsRoot);
});

test("locations: invalid entries are dropped, not fatal — unknown driver, relative path, missing name", (t) => {
  const cfg = makeConfigEnv(
    [
      "[[stores]]",
      'name = "bad-driver"',
      'driver = "s3"',
      'path = "/tmp/whatever"',
      "",
      "[[stores]]",
      'name = "relative-path"',
      'driver = "localfs"',
      'path = "not/absolute"',
      "",
      "[[stores]]",
      'driver = "localfs"',
      'path = "/tmp/no-name"',
      "",
      "[[stores]]",
      'name = "good"',
      'driver = "localfs"',
      'path = "/tmp/good-store"',
      "",
    ].join("\n"),
  );
  t.after(cfg.cleanup);
  const stores = loadLocationStores(cfg.env);
  assert.deepEqual(stores, [{ name: "good", driver: "localfs", path: "/tmp/good-store" }]);
  assert.equal(configuredWorkspaceRoot(cfg.env), "/tmp/good-store");
});

test("locations: first localfs store wins when several are configured", (t) => {
  const cfg = makeConfigEnv(
    [
      "[[stores]]",
      'name = "first"',
      'driver = "localfs"',
      'path = "/tmp/first-store"',
      "",
      "[[stores]]",
      'name = "second"',
      'driver = "localfs"',
      'path = "/tmp/second-store"',
      "",
    ].join("\n"),
  );
  t.after(cfg.cleanup);
  assert.equal(configuredWorkspaceRoot(cfg.env), "/tmp/first-store");
});
