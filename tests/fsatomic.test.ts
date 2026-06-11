import * as assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import { ConflictError } from "../src/lib/errors.js";
import {
  appendSafe,
  cleanStaleTempFiles,
  createExclusive,
  ensureDir,
  readTextIfExists,
  writeFileAtomic,
} from "../src/lib/fsatomic.js";
import { makeTmpDir, rmrf } from "./helpers.js";

test("writeFileAtomic creates a file, parent dirs included", (t) => {
  const dir = makeTmpDir();
  t.after(() => rmrf(dir));
  const target = path.join(dir, "a", "b", "rec.md");
  writeFileAtomic(target, "hello\n");
  assert.equal(fs.readFileSync(target, "utf8"), "hello\n");
});

test("writeFileAtomic replaces existing content whole", (t) => {
  const dir = makeTmpDir();
  t.after(() => rmrf(dir));
  const target = path.join(dir, "rec.md");
  writeFileAtomic(target, "old content longer than new\n");
  writeFileAtomic(target, "new\n");
  assert.equal(fs.readFileSync(target, "utf8"), "new\n");
});

test("writeFileAtomic leaves no temp files behind", (t) => {
  const dir = makeTmpDir();
  t.after(() => rmrf(dir));
  writeFileAtomic(path.join(dir, "rec.md"), "x");
  writeFileAtomic(path.join(dir, "rec.md"), "y");
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes("ow-tmp"));
  assert.deepEqual(leftovers, []);
});

test("writeFileAtomic under simulated partial state: stale temp from a crashed writer does not interfere", (t) => {
  const dir = makeTmpDir();
  t.after(() => rmrf(dir));
  const target = path.join(dir, "rec.md");
  // Simulate a writer that died mid-write: its temp file is still on disk.
  const staleTmp = path.join(dir, ".rec.md.ow-tmp-99999-deadbeef");
  fs.writeFileSync(staleTmp, "torn partial conte");
  writeFileAtomic(target, "good\n");
  assert.equal(fs.readFileSync(target, "utf8"), "good\n");
  assert.ok(fs.existsSync(staleTmp), "foreign temp file is not touched by a write");
  // The cleaner removes it once stale.
  const removed = cleanStaleTempFiles(dir, 0);
  assert.deepEqual(removed, [staleTmp]);
  assert.ok(!fs.existsSync(staleTmp));
  assert.equal(fs.readFileSync(target, "utf8"), "good\n");
});

test("cleanStaleTempFiles ignores fresh temps and non-matching names", (t) => {
  const dir = makeTmpDir();
  t.after(() => rmrf(dir));
  const fresh = path.join(dir, ".rec.md.ow-tmp-1234-cafebabe");
  fs.writeFileSync(fresh, "in flight");
  fs.writeFileSync(path.join(dir, "normal.md"), "keep");
  const removed = cleanStaleTempFiles(dir, 60_000);
  assert.deepEqual(removed, []);
  assert.ok(fs.existsSync(fresh));
});

test("readers never observe a torn write under repeated rewrites", (t) => {
  const dir = makeTmpDir();
  t.after(() => rmrf(dir));
  const target = path.join(dir, "rec.md");
  const contentA = "A".repeat(64 * 1024) + "\n";
  const contentB = "B".repeat(64 * 1024) + "\n";
  writeFileAtomic(target, contentA);
  for (let i = 0; i < 50; i++) {
    writeFileAtomic(target, i % 2 === 0 ? contentB : contentA);
    const seen = fs.readFileSync(target, "utf8");
    assert.ok(seen === contentA || seen === contentB, "read must be one whole write");
  }
});

test("createExclusive succeeds once, then throws ConflictError", (t) => {
  const dir = makeTmpDir();
  t.after(() => rmrf(dir));
  const target = path.join(dir, "msgs", "20260610T000000Z--a--x1y2.md");
  createExclusive(target, "first");
  assert.throws(() => createExclusive(target, "second"), ConflictError);
  assert.equal(fs.readFileSync(target, "utf8"), "first");
});

test("appendSafe creates then appends", (t) => {
  const dir = makeTmpDir();
  t.after(() => rmrf(dir));
  const target = path.join(dir, "logs", "run.log");
  appendSafe(target, "line1\n");
  appendSafe(target, "line2\n");
  assert.equal(fs.readFileSync(target, "utf8"), "line1\nline2\n");
});

test("ensureDir is idempotent; readTextIfExists distinguishes missing from present", (t) => {
  const dir = makeTmpDir();
  t.after(() => rmrf(dir));
  const sub = path.join(dir, "x", "y");
  ensureDir(sub);
  ensureDir(sub);
  assert.ok(fs.statSync(sub).isDirectory());
  assert.equal(readTextIfExists(path.join(sub, "nope.md")), null);
  fs.writeFileSync(path.join(sub, "yep.md"), "");
  assert.equal(readTextIfExists(path.join(sub, "yep.md")), "");
});

test("regression: createExclusive is temp+link — no temp residue, whole bytes, exclusive under concurrency", async (t) => {
  const dir = makeTmpDir();
  t.after(() => rmrf(dir));

  // success: final bytes whole, no .ow-tmp residue (a crash mid-write could
  // only ever leave a temp file, which cleanStaleTempFiles reaps)
  const target = path.join(dir, "msg.md");
  createExclusive(target, "---\nfrom: a\n---\nbody\n");
  assert.equal(fs.readFileSync(target, "utf8"), "---\nfrom: a\n---\nbody\n");
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes("ow-tmp")), []);

  // collision failure: also no residue
  assert.throws(() => createExclusive(target, "other"), ConflictError);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes("ow-tmp")), []);
  assert.equal(fs.readFileSync(target, "utf8"), "---\nfrom: a\n---\nbody\n", "loser never tore the winner");

  // concurrency: many processes race the SAME final name — exactly one wins,
  // and the surviving bytes are exactly one writer's payload, never a mix
  const fsatomicModule = path.resolve(__dirname, "..", "src", "lib", "fsatomic.js");
  const race = path.join(dir, "race.md");
  const script = `
    const { createExclusive } = require(${JSON.stringify(fsatomicModule)});
    const [target, who] = process.argv.slice(1);
    try {
      createExclusive(target, ("payload-" + who + "-").repeat(2000));
      console.log("won");
    } catch {
      console.log("lost");
    }
  `;
  const outcomes = await Promise.all(
    ["a", "b", "c", "d"].map((who) =>
      execFileAsync(process.execPath, ["-e", script, "--", race, who]).then((r) => r.stdout.trim()),
    ),
  );
  assert.equal(outcomes.filter((o) => o === "won").length, 1, `exactly one winner: ${outcomes.join(",")}`);
  const survivor = fs.readFileSync(race, "utf8");
  const m = /^payload-([a-d])-/.exec(survivor);
  assert.ok(m !== null, "survivor carries a single writer's payload");
  assert.equal(survivor, `payload-${m?.[1]}-`.repeat(2000), "bytes are whole — never torn or interleaved");
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes("ow-tmp")), []);
});
