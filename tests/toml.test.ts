import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { ParseError } from "../src/lib/errors.js";
import { parseToml, readToml, readTomlIfExists, stringifyToml, writeToml } from "../src/lib/toml.js";
import { fixturePath, makeTmpDir, rmrf } from "./helpers.js";

test("parses the real legacy dirchannel config.toml (forgiving read of foreign keys)", () => {
  const raw = readToml(fixturePath("dirchannel", "config.toml"));
  const meta = raw["meta"] as Record<string, unknown>;
  assert.equal(meta["directory_name"], "Personal OS");
  assert.ok(Array.isArray(raw["channels"]));
  const channels = raw["channels"] as Array<Record<string, unknown>>;
  assert.ok(channels.some((c) => c["name"] === "general"));
  // unknown sections simply pass through as data
  assert.ok(raw["bridges"] !== undefined);
});

test("parse error carries the source path and throws ParseError", () => {
  assert.throws(() => parseToml("key = ", "/tmp/bad.toml"), ParseError);
  try {
    parseToml("key = ", "/tmp/bad.toml");
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok((err as Error).message.includes("/tmp/bad.toml"));
  }
});

test("readTomlIfExists: missing file means all defaults ({})", (t) => {
  const dir = makeTmpDir();
  t.after(() => rmrf(dir));
  assert.deepEqual(readTomlIfExists(path.join(dir, "absent.toml")), {});
});

test("write → read round-trips data for documents the tool owns", (t) => {
  const dir = makeTmpDir();
  t.after(() => rmrf(dir));
  const file = path.join(dir, "machine.toml");
  const doc = {
    machine_id: "mini",
    heartbeat: "2026-06-10T12:00:00Z",
    activations: { "daily-brief": { project_uid: "abc-123", applied: true } },
  };
  writeToml(file, doc);
  const back = readToml(file);
  assert.equal(back["machine_id"], "mini");
  const activations = back["activations"] as Record<string, Record<string, unknown>>;
  assert.equal(activations["daily-brief"]?.["applied"], true);
  assert.ok(fs.readFileSync(file, "utf8").endsWith("\n"), "owned documents end with a newline");
});

test("stringifyToml output is valid TOML and stable across a round-trip", () => {
  const doc = { a: 1, nested: { flag: true, list: ["x", "y"] } };
  const once = stringifyToml(doc);
  const twice = stringifyToml(parseToml(once));
  assert.equal(once, twice);
});
