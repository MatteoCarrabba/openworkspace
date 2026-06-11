/**
 * decision-2 — lifecycle metadata-as-truth: the read/write helpers and the
 * effectiveLifecycle (metadata-with-location-fallback) behavior. These are the
 * additive workspace.ts surfaces; reconcile.test.ts exercises the healer.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import {
  discoverProjects,
  effectiveLifecycle,
  locationOfDeclared,
  readDeclaredLifecycle,
  writeDeclaredLifecycle,
} from "../src/lib/workspace.js";
import { makeTmpWorkspace } from "./helpers.js";

test("readDeclaredLifecycle: absent file / absent key → null (location fallback)", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const p = tw.addProject("Plain");
  const r = readDeclaredLifecycle(p.root);
  assert.equal(r.lifecycle, null);
  assert.equal(r.setAt, null);
  assert.equal(r.problem, null);
});

test("writeDeclaredLifecycle round-trips dormant + the lifecycle_set audit stamp", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const p = tw.addProject("Sleeper");
  writeDeclaredLifecycle(p.root, "dormant", "2026-06-11T14:02:00Z");
  const r = readDeclaredLifecycle(p.root);
  assert.equal(r.lifecycle, "dormant");
  assert.equal(r.setAt, "2026-06-11T14:02:00Z");
  assert.equal(r.problem, null);
});

test("writeDeclaredLifecycle PRESERVES other project.toml keys (P12 lossless)", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const p = tw.addProject("Mixed");
  fs.writeFileSync(
    path.join(p.root, "_project", "project.toml"),
    'created = "2026-04-02"\nowner = "matteo"\n',
  );
  writeDeclaredLifecycle(p.root, "archived", "2026-06-11T00:00:00Z");
  const text = fs.readFileSync(path.join(p.root, "_project", "project.toml"), "utf8");
  assert.match(text, /created = "2026-04-02"/);
  assert.match(text, /owner = "matteo"/);
  assert.match(text, /lifecycle = "archived"/);
});

test("writing active SHEDS the lifecycle key (absent ⇒ active, P17)", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const p = tw.addProject("Returning");
  fs.writeFileSync(
    path.join(p.root, "_project", "project.toml"),
    'created = "2026-04-02"\nlifecycle = "dormant"\nlifecycle_set = "2026-06-11T00:00:00Z"\n',
  );
  writeDeclaredLifecycle(p.root, "active", null);
  const text = fs.readFileSync(path.join(p.root, "_project", "project.toml"), "utf8");
  assert.doesNotMatch(text, /lifecycle/);
  assert.match(text, /created = "2026-04-02"/, "unrelated keys survive shedding the lifecycle key");
});

test("writing active on a project.toml with ONLY a lifecycle key deletes the empty file", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const p = tw.addProject("OnlyLifecycle");
  fs.writeFileSync(path.join(p.root, "_project", "project.toml"), 'lifecycle = "dormant"\n');
  writeDeclaredLifecycle(p.root, "active", null);
  assert.equal(
    fs.existsSync(path.join(p.root, "_project", "project.toml")),
    false,
    "an otherwise-empty project.toml is removed entirely",
  );
});

test("readDeclaredLifecycle: an unknown enum value → null + a doctor-surfaceable problem", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const p = tw.addProject("Bad");
  fs.writeFileSync(path.join(p.root, "_project", "project.toml"), 'lifecycle = "hibernating"\n');
  const r = readDeclaredLifecycle(p.root);
  assert.equal(r.lifecycle, null);
  assert.match(r.problem ?? "", /unknown lifecycle "hibernating"/);
});

test("effectiveLifecycle: declared metadata WINS over location", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  // a project sitting at the TOP LEVEL but DECLARING dormant: metadata wins.
  const p = tw.addProject("Misplaced");
  writeDeclaredLifecycle(p.root, "dormant", "2026-06-11T00:00:00Z");
  assert.equal(effectiveLifecycle(tw.ws, p.root), "dormant");
  // the effective state maps back to a top-level location (dormant ≠ active),
  // which is exactly the drift reconcile would heal.
  assert.equal(locationOfDeclared(effectiveLifecycle(tw.ws, p.root)), "dormant");
});

test("effectiveLifecycle: falls back to LOCATION when nothing is declared", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const shelved = tw.addProject(path.join("Dormant Projects", "Old"));
  assert.equal(effectiveLifecycle(tw.ws, shelved.root), "dormant");
});

test("'ongoing' is no longer a lifecycle value (dropped 2026-06-11) → rejected as unknown", (t) => {
  // Matteo collapsed the vocabulary to active|dormant|archived; a formerly
  // "ongoing" project (e.g. Health and Fitness) is just active. A stale
  // `lifecycle = "ongoing"` reads as null + a doctor-surfaceable problem, so
  // effectiveLifecycle falls back to location (top-level ⇒ active).
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const p = tw.addProject("Health and Fitness");
  fs.writeFileSync(path.join(p.root, "_project", "project.toml"), 'lifecycle = "ongoing"\n');
  const r = readDeclaredLifecycle(p.root);
  assert.equal(r.lifecycle, null);
  assert.match(r.problem ?? "", /unknown lifecycle "ongoing"/);
  assert.equal(effectiveLifecycle(tw.ws, p.root), "active");
});

test("discoverProjects populates declaredLifecycle + effectiveLifecycle additively", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const declared = tw.addProject("Declared");
  writeDeclaredLifecycle(declared.root, "dormant", "2026-06-11T00:00:00Z");
  const plain = tw.addProject("Plain");

  const all = discoverProjects(tw.ws, { all: true });
  const d = all.find((x) => x.uid === declared.uid);
  const pl = all.find((x) => x.uid === plain.uid);
  assert.ok(d !== undefined && pl !== undefined);
  // declared one: location view = active, metadata = dormant (drift present)
  assert.equal(d.lifecycle, "active");
  assert.equal(d.declaredLifecycle, "dormant");
  assert.equal(d.effectiveLifecycle, "dormant");
  assert.equal(d.lifecycleSetAt, "2026-06-11T00:00:00Z");
  // plain one: no declaration, effective = location
  assert.equal(pl.declaredLifecycle, null);
  assert.equal(pl.effectiveLifecycle, "active");
});
