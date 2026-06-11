/**
 * decision-2 — the machine-local lifecycle intent-log (the non-git
 * tiebreaker substrate). Lives in the temp store, NEVER the real ~/Library.
 */

import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";

import { appendSafe } from "../src/lib/fsatomic.js";
import {
  appendLifecycleIntent,
  lastLifecycleIntent,
  readLifecycleIntents,
} from "../src/lib/machine.js";
import { makeTmpStore } from "./helpers.js";

test("intent-log: append + read round-trips, oldest → newest", (t) => {
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  appendLifecycleIntent(store, { uid: "u1", to: "dormant", at: "2026-06-11T10:00:00Z", machine: "mbp" });
  appendLifecycleIntent(store, { uid: "u2", to: "archived", at: "2026-06-11T11:00:00Z", machine: "mbp" });
  const all = readLifecycleIntents(store);
  assert.equal(all.length, 2);
  assert.deepEqual(all[0], { uid: "u1", to: "dormant", at: "2026-06-11T10:00:00Z", machine: "mbp" });
  assert.equal(all[1]?.uid, "u2");
});

test("intent-log: lastLifecycleIntent returns the most-recent line for a uid", (t) => {
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  appendLifecycleIntent(store, { uid: "u1", to: "dormant", at: "2026-06-11T10:00:00Z", machine: "mbp" });
  appendLifecycleIntent(store, { uid: "u1", to: "active", at: "2026-06-11T12:00:00Z", machine: "mbp" });
  assert.equal(lastLifecycleIntent(store, "u1")?.to, "active");
  assert.equal(lastLifecycleIntent(store, "never-seen"), null);
});

test("intent-log: corrupt lines are skipped, not fatal (best-effort evidence)", (t) => {
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  appendLifecycleIntent(store, { uid: "u1", to: "dormant", at: "2026-06-11T10:00:00Z", machine: "mbp" });
  // simulate a torn / non-JSON line landing in the log
  appendSafe(path.join(store.dir, "lifecycle-intents.jsonl"), "{not json\n");
  appendLifecycleIntent(store, { uid: "u2", to: "archived", at: "2026-06-11T11:00:00Z", machine: "mbp" });
  const all = readLifecycleIntents(store);
  assert.equal(all.length, 2, "the corrupt line is dropped; the two valid lines survive");
});
